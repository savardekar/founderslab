import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { KNOWLEDGE_SCOPES } from '@/lib/constants';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { audit } from '../audit';
import type { Ctx } from '../authz';
import { TOOLS, TOOL_BY_KEY, agentRoleIds, runTool } from '../ai/tools';
import { getProvider, listProviders } from '../ai/provider';
import { monthUsage } from '../ai/runner';
import { endAssignmentsTx } from './assignments';

const S = schema;
type Cfg = { provider: string; model: string; instructions: string; autonomyLevel: number; knowledgeScope: string; monthlyTokenLimit: number | null; monthlyBudgetUsd: number | null };

async function load(ctx: Ctx, id: string) {
  const [a] = await ctx.db.select().from(S.aiAgents).where(and(eq(S.aiAgents.companyId, ctx.companyId), eq(S.aiAgents.id, id), isNull(S.aiAgents.archivedAt))).limit(1);
  if (!a) throw notFound('AI employee not found');
  const roleIds = await agentRoleIds(ctx.db, a);
  const roles = roleIds.length ? await ctx.db.select({ id: S.roles.id, d: S.roles.departmentId }).from(S.roles).where(and(eq(S.roles.companyId, ctx.companyId), inArray(S.roles.id, roleIds))) : [];
  return { a, roles };
}
/** Permission on an agent: company-wide grant, or a role/department-scoped grant on any role the agent holds. */
function can(ctx: Ctx, key: string, roles: { id: string; d: string | null }[]) { return ctx.can(key) || roles.some((r) => ctx.can(key, { roleId: r.id, departmentId: r.d })); }
function need(ctx: Ctx, key: string, roles: { id: string; d: string | null }[]) { if (!can(ctx, key, roles)) throw forbidden(); }

export function aiMeta() {
  return { providers: listProviders(), tools: TOOLS.map((t) => ({ key: t.key, label: t.label, description: t.description, kind: t.kind, connected: t.connected, routine: t.routine })), knowledgeScopes: KNOWLEDGE_SCOPES };
}

async function validateManager(ctx: Ctx, id: string | null | undefined) {
  if (!id) return;
  const [m] = await ctx.db.select({ id: S.companyMemberships.id }).from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, ctx.companyId), eq(S.companyMemberships.id, id), eq(S.companyMemberships.status, 'active')));
  if (!m) throw badRequest('The accountable manager must be an active employee');
}
async function validateDept(ctx: Ctx, id: string | null | undefined) {
  if (!id) return;
  const [d] = await ctx.db.select({ id: S.departments.id }).from(S.departments).where(and(eq(S.departments.companyId, ctx.companyId), eq(S.departments.id, id), isNull(S.departments.archivedAt)));
  if (!d) throw badRequest('Department not found');
}
function checkConfig(ctx: Ctx, roles: { id: string; d: string | null }[], c: Partial<Cfg>, prev?: Cfg) {
  if (c.provider !== undefined && !getProvider(c.provider)) throw badRequest(`Unknown AI provider "${c.provider}"`);
  if (c.autonomyLevel !== undefined && c.autonomyLevel !== prev?.autonomyLevel && c.autonomyLevel >= 3 && !can(ctx, 'agents.approve', roles) && !ctx.can('agents.approve'))
    throw forbidden('Autonomy Level 3 or 4 needs the permission to approve AI work (agents.approve)');
}

export async function listAgents(ctx: Ctx) {
  if (!ctx.hasAny('agents.view')) throw forbidden();
  const agents = await ctx.db.select().from(S.aiAgents).where(and(eq(S.aiAgents.companyId, ctx.companyId), isNull(S.aiAgents.archivedAt))).orderBy(asc(S.aiAgents.name));
  const [cfgs, asg, mgrs, depts, pend] = await Promise.all([
    ctx.db.select().from(S.agentConfigurations).where(eq(S.agentConfigurations.companyId, ctx.companyId)),
    ctx.db.select({ agentId: S.roleAssignments.agentId, roleId: S.roles.id, roleName: S.roles.name, d: S.roles.departmentId, isOwner: S.roleAssignments.isPrimary }).from(S.roleAssignments).innerJoin(S.roles, and(eq(S.roles.companyId, S.roleAssignments.companyId), eq(S.roles.id, S.roleAssignments.roleId))).where(and(eq(S.roleAssignments.companyId, ctx.companyId), isNull(S.roleAssignments.endedAt), isNull(S.roles.archivedAt), sql`${S.roleAssignments.agentId} is not null`)),
    ctx.db.select({ id: S.companyMemberships.id, name: S.users.name }).from(S.companyMemberships).innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId)).where(eq(S.companyMemberships.companyId, ctx.companyId)),
    ctx.db.select({ id: S.departments.id, name: S.departments.name }).from(S.departments).where(eq(S.departments.companyId, ctx.companyId)),
    ctx.db.select({ agentId: S.aiWorkItems.agentId, n: sql<number>`count(*)` }).from(S.aiWorkItems).where(and(eq(S.aiWorkItems.companyId, ctx.companyId), eq(S.aiWorkItems.status, 'pending_review'))).groupBy(S.aiWorkItems.agentId),
  ]);
  const mn = new Map(mgrs.map((m) => [m.id, m.name])), dn = new Map(depts.map((d) => [d.id, d.name]));
  return agents.map((a) => {
    const roles = asg.filter((r) => r.agentId === a.id).map((r) => ({ id: r.roleId, d: r.d, name: r.roleName, isOwner: r.isOwner }));
    const cfg = cfgs.find((c) => c.agentId === a.id);
    return { a, roles, cfg, ok: can(ctx, 'agents.view', roles.map((r) => ({ id: r.id, d: r.d }))), out: {
      id: a.id, name: a.name, description: a.description, status: a.status, departmentId: a.departmentId, departmentName: a.departmentId ? dn.get(a.departmentId) ?? null : (roles[0]?.d ? dn.get(roles[0].d) ?? null : null),
      managerMembershipId: a.managerMembershipId, managerName: a.managerMembershipId ? mn.get(a.managerMembershipId) ?? null : null,
      roles: roles.map((r) => ({ id: r.id, name: r.name, isOwner: r.isOwner })), provider: cfg?.provider, model: cfg?.model, autonomyLevel: cfg?.autonomyLevel ?? 1, pendingReview: Number(pend.find((p) => p.agentId === a.id)?.n ?? 0) } };
  }).filter((x) => x.ok).map((x) => x.out);
}

export async function createAgent(ctx: Ctx, input: { name: string; description?: string | null; departmentId?: string | null; managerMembershipId?: string | null; roleId?: string | null; config: Partial<Cfg> & { provider: string; model: string } }) {
  ctx.require('agents.create');
  await validateDept(ctx, input.departmentId);
  const manager = input.managerMembershipId ?? ctx.membership.id;
  await validateManager(ctx, manager);
  checkConfig(ctx, [], input.config);
  const c = input.config;
  if (input.roleId) ctx.require('agents.assign');
  const out = await ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db;
    const [a] = await tx.insert(S.aiAgents).values({ companyId: ctx.companyId, name: input.name, description: input.description ?? null, departmentId: input.departmentId ?? null, managerMembershipId: manager, createdBy: ctx.user.id }).returning();
    await tx.insert(S.agentConfigurations).values({ agentId: a.id, companyId: ctx.companyId, provider: c.provider, model: c.model, instructions: c.instructions ?? '', autonomyLevel: c.autonomyLevel ?? 1, knowledgeScope: c.knowledgeScope ?? 'role', monthlyTokenLimit: c.monthlyTokenLimit ?? null, monthlyBudgetUsd: c.monthlyBudgetUsd == null ? null : String(c.monthlyBudgetUsd), updatedBy: ctx.user.id });
    await tx.insert(S.agentToolPermissions).values([{ companyId: ctx.companyId, agentId: a.id, toolKey: 'org_read', enabled: true, requiresApproval: false }, { companyId: ctx.companyId, agentId: a.id, toolKey: 'org_add_responsibility', enabled: true, requiresApproval: true }, { companyId: ctx.companyId, agentId: a.id, toolKey: 'tasks_read', enabled: true, requiresApproval: false }, { companyId: ctx.companyId, agentId: a.id, toolKey: 'tasks_create', enabled: true, requiresApproval: true }, { companyId: ctx.companyId, agentId: a.id, toolKey: 'knowledge_search', enabled: true, requiresApproval: false }, { companyId: ctx.companyId, agentId: a.id, toolKey: 'knowledge_read', enabled: true, requiresApproval: false }, { companyId: ctx.companyId, agentId: a.id, toolKey: 'decisions_read', enabled: true, requiresApproval: false }, { companyId: ctx.companyId, agentId: a.id, toolKey: 'decisions_propose', enabled: true, requiresApproval: true }]);
    await audit(tx, ctx.companyId, ctx.user.id, 'agent.created', 'agent', a.id, { name: a.name, provider: c.provider, model: c.model, autonomyLevel: c.autonomyLevel ?? 1 });
    return a;
  });
  if (input.roleId) { const { assignToRole } = await import('./members'); await assignToRole(ctx, input.roleId, { agentId: out.id }); }
  return out;
}

export async function getAgent(ctx: Ctx, id: string) {
  const { a, roles } = await load(ctx, id);
  need(ctx, 'agents.view', roles);
  const [cfg] = await ctx.db.select().from(S.agentConfigurations).where(and(eq(S.agentConfigurations.companyId, ctx.companyId), eq(S.agentConfigurations.agentId, id)));
  const [perms, picked, asg, runs, usage, pend, mgr, dept] = await Promise.all([
    ctx.db.select().from(S.agentToolPermissions).where(and(eq(S.agentToolPermissions.companyId, ctx.companyId), eq(S.agentToolPermissions.agentId, id))),
    ctx.db.select({ id: S.agentResponsibilities.responsibilityId }).from(S.agentResponsibilities).where(and(eq(S.agentResponsibilities.companyId, ctx.companyId), eq(S.agentResponsibilities.agentId, id))),
    ctx.db.select({ assignmentId: S.roleAssignments.id, roleId: S.roles.id, roleName: S.roles.name, isOwner: S.roleAssignments.isPrimary, roleType: S.roles.roleType }).from(S.roleAssignments).innerJoin(S.roles, and(eq(S.roles.companyId, S.roleAssignments.companyId), eq(S.roles.id, S.roleAssignments.roleId))).where(and(eq(S.roleAssignments.companyId, ctx.companyId), eq(S.roleAssignments.agentId, id), isNull(S.roleAssignments.endedAt), isNull(S.roles.archivedAt))),
    ctx.db.select().from(S.aiRuns).where(and(eq(S.aiRuns.companyId, ctx.companyId), eq(S.aiRuns.agentId, id))).orderBy(desc(S.aiRuns.startedAt)).limit(15),
    monthUsage(ctx.db, ctx.companyId, id),
    ctx.db.select({ n: sql<number>`count(*)` }).from(S.aiWorkItems).where(and(eq(S.aiWorkItems.companyId, ctx.companyId), eq(S.aiWorkItems.agentId, id), eq(S.aiWorkItems.status, 'pending_review'))),
    a.managerMembershipId ? ctx.db.select({ name: S.users.name }).from(S.companyMemberships).innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId)).where(and(eq(S.companyMemberships.companyId, ctx.companyId), eq(S.companyMemberships.id, a.managerMembershipId))) : Promise.resolve([]),
    a.departmentId ? ctx.db.select({ name: S.departments.name }).from(S.departments).where(and(eq(S.departments.companyId, ctx.companyId), eq(S.departments.id, a.departmentId))) : Promise.resolve([]),
  ]);
  const roleIds = asg.map((r) => r.roleId);
  const available = roleIds.length ? await ctx.db.select({ id: S.roleResponsibilities.id, title: S.roleResponsibilities.title, roleId: S.roleResponsibilities.roleId, roleName: S.roles.name }).from(S.roleResponsibilities).innerJoin(S.roles, and(eq(S.roles.companyId, S.roleResponsibilities.companyId), eq(S.roles.id, S.roleResponsibilities.roleId))).where(and(eq(S.roleResponsibilities.companyId, ctx.companyId), inArray(S.roleResponsibilities.roleId, roleIds), isNull(S.roleResponsibilities.archivedAt))) : [];
  const meta = aiMeta(); const prov = meta.providers.find((p) => p.id === cfg?.provider);
  const canConfigure = can(ctx, 'agents.configure', roles);
  return {
    agent: { id: a.id, name: a.name, description: a.description, status: a.status, departmentId: a.departmentId, departmentName: dept[0]?.name ?? null, managerMembershipId: a.managerMembershipId, managerName: mgr[0]?.name ?? null, createdAt: a.createdAt },
    // instructions are configuration: visible to those who may configure, otherwise withheld
    config: cfg ? { provider: cfg.provider, model: cfg.model, autonomyLevel: cfg.autonomyLevel, knowledgeScope: cfg.knowledgeScope, monthlyTokenLimit: cfg.monthlyTokenLimit, monthlyBudgetUsd: cfg.monthlyBudgetUsd == null ? null : Number(cfg.monthlyBudgetUsd), version: cfg.version, instructions: canConfigure ? cfg.instructions : null } : null,
    providerConfigured: !!prov?.configured, providerHint: prov?.setupHint ?? null,
    tools: meta.tools.map((t) => { const p = perms.find((x) => x.toolKey === t.key); return { ...t, enabled: !!p?.enabled, requiresApproval: p ? p.requiresApproval : true }; }),
    assignments: asg, responsibilities: { available, selected: picked.map((p) => p.id) },
    runs: runs.map((r) => ({ id: r.id, status: r.status, input: r.input, error: r.error, model: r.model, autonomyLevel: r.autonomyLevel, inputTokens: r.inputTokens, outputTokens: r.outputTokens, startedAt: r.startedAt, finishedAt: r.finishedAt, summary: (r.output as any)?.summary ?? null, steps: r.steps })),
    usage: { ...usage, tokenLimit: cfg?.monthlyTokenLimit ?? null, budgetUsd: cfg?.monthlyBudgetUsd == null ? null : Number(cfg.monthlyBudgetUsd) },
    pendingReview: Number(pend[0].n),
    can: { edit: can(ctx, 'agents.edit', roles), configure: canConfigure, approve: can(ctx, 'agents.approve', roles), assign: can(ctx, 'agents.assign', roles), delete: can(ctx, 'agents.delete', roles) },
  };
}

export async function updateAgent(ctx: Ctx, id: string, p: { name?: string; description?: string | null; departmentId?: string | null; managerMembershipId?: string | null }) {
  const { a, roles } = await load(ctx, id); need(ctx, 'agents.edit', roles);
  await validateDept(ctx, p.departmentId); if (p.managerMembershipId) await validateManager(ctx, p.managerMembershipId);
  if (p.managerMembershipId === null) throw badRequest('An AI employee must have an accountable manager');
  await ctx.db.update(S.aiAgents).set({ ...p, updatedAt: new Date() }).where(and(eq(S.aiAgents.companyId, ctx.companyId), eq(S.aiAgents.id, a.id)));
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'agent.updated', 'agent', id, { name: a.name, changes: p });
}

export async function setAgentStatus(ctx: Ctx, id: string, status: 'active' | 'inactive') {
  const { a, roles } = await load(ctx, id); need(ctx, 'agents.edit', roles);
  if (status === 'active') {
    const [cfg] = await ctx.db.select().from(S.agentConfigurations).where(eq(S.agentConfigurations.agentId, id));
    if (!cfg?.model.trim() || !getProvider(cfg.provider)) throw badRequest('Choose a provider and model before activating');
    if (!a.managerMembershipId) throw badRequest('Assign an accountable manager before activating');
  }
  await ctx.db.update(S.aiAgents).set({ status, updatedAt: new Date() }).where(and(eq(S.aiAgents.companyId, ctx.companyId), eq(S.aiAgents.id, id)));
  await audit(ctx.db, ctx.companyId, ctx.user.id, status === 'active' ? 'agent.activated' : 'agent.deactivated', 'agent', id, { name: a.name });
}

export async function archiveAgent(ctx: Ctx, id: string) {
  const { a, roles } = await load(ctx, id); need(ctx, 'agents.delete', roles);
  await ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db;
    await endAssignmentsTx(tx, ctx.companyId, { agentId: id });
    await tx.update(S.aiAgents).set({ archivedAt: new Date(), status: 'inactive' }).where(and(eq(S.aiAgents.companyId, ctx.companyId), eq(S.aiAgents.id, id)));
    await audit(tx, ctx.companyId, ctx.user.id, 'agent.deleted', 'agent', id, { name: a.name });
  });
}

export async function setAgentConfig(ctx: Ctx, id: string, c: Partial<Cfg>) {
  const { a, roles } = await load(ctx, id); need(ctx, 'agents.configure', roles);
  const [prev] = await ctx.db.select().from(S.agentConfigurations).where(eq(S.agentConfigurations.agentId, id));
  checkConfig(ctx, roles, c, prev ? { ...prev, monthlyBudgetUsd: prev.monthlyBudgetUsd == null ? null : Number(prev.monthlyBudgetUsd) } : undefined);
  const set: Record<string, unknown> = { version: (prev?.version ?? 0) + 1, updatedBy: ctx.user.id, updatedAt: new Date() };
  for (const k of ['provider', 'model', 'instructions', 'autonomyLevel', 'knowledgeScope', 'monthlyTokenLimit'] as const) if (c[k] !== undefined) set[k] = c[k];
  if (c.monthlyBudgetUsd !== undefined) set.monthlyBudgetUsd = c.monthlyBudgetUsd == null ? null : String(c.monthlyBudgetUsd);
  await ctx.db.update(S.agentConfigurations).set(set).where(eq(S.agentConfigurations.agentId, id));
  const { instructions, ...safe } = c;
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'agent.configured', 'agent', id, { name: a.name, ...safe, instructionsChanged: instructions !== undefined, version: set.version });
}

export async function setAgentTools(ctx: Ctx, id: string, tools: { toolKey: string; enabled: boolean; requiresApproval: boolean }[]) {
  const { a, roles } = await load(ctx, id); need(ctx, 'agents.configure', roles);
  for (const t of tools) {
    const spec = TOOL_BY_KEY[t.toolKey];
    if (!spec) throw badRequest(`Unknown tool ${t.toolKey}`);
    if (t.enabled && (!spec.connected || spec.kind === 'external')) throw badRequest(`"${spec.label}" cannot be enabled: no external integration is connected, and AI employees may not take external actions yet.`);
    if (t.enabled && spec.kind === 'write' && !t.requiresApproval && !(spec.routine && can(ctx, 'agents.approve', roles))) throw forbidden('Letting a tool run without approval needs a routine tool and the agents.approve permission');
  }
  await ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db;
    await tx.delete(S.agentToolPermissions).where(and(eq(S.agentToolPermissions.companyId, ctx.companyId), eq(S.agentToolPermissions.agentId, id)));
    if (tools.length) await tx.insert(S.agentToolPermissions).values(tools.map((x) => ({ companyId: ctx.companyId, agentId: id, ...x })));
    await audit(tx, ctx.companyId, ctx.user.id, 'agent.tools_changed', 'agent', id, { name: a.name, tools: tools.filter((x) => x.enabled).map((x) => `${x.toolKey}${x.requiresApproval ? '' : ' (auto)'}`) });
  });
}

export async function setAgentResponsibilities(ctx: Ctx, id: string, ids: string[]) {
  const { a, roles } = await load(ctx, id); need(ctx, 'agents.configure', roles);
  const roleIds = roles.map((r) => r.id);
  const ok = ids.length ? await ctx.db.select({ id: S.roleResponsibilities.id }).from(S.roleResponsibilities).where(and(eq(S.roleResponsibilities.companyId, ctx.companyId), inArray(S.roleResponsibilities.id, ids), inArray(S.roleResponsibilities.roleId, roleIds.length ? roleIds : ['00000000-0000-0000-0000-000000000000']), isNull(S.roleResponsibilities.archivedAt))) : [];
  if (ok.length !== new Set(ids).size) throw badRequest('Responsibilities must belong to roles this AI employee is assigned to');
  await ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db;
    await tx.delete(S.agentResponsibilities).where(and(eq(S.agentResponsibilities.companyId, ctx.companyId), eq(S.agentResponsibilities.agentId, id)));
    if (ok.length) await tx.insert(S.agentResponsibilities).values(ok.map((r) => ({ companyId: ctx.companyId, agentId: id, responsibilityId: r.id })));
    await audit(tx, ctx.companyId, ctx.user.id, 'agent.responsibilities_changed', 'agent', id, { name: a.name, count: ok.length });
  });
}

// ───────────── review queue ─────────────
export async function listWorkItems(ctx: Ctx, f: { status?: string; agentId?: string } = {}) {
  if (!ctx.hasAny('agents.view')) throw forbidden();
  const rows = await ctx.db.select({ w: S.aiWorkItems, agent: S.aiAgents.name }).from(S.aiWorkItems).innerJoin(S.aiAgents, and(eq(S.aiAgents.companyId, S.aiWorkItems.companyId), eq(S.aiAgents.id, S.aiWorkItems.agentId)))
    .where(and(eq(S.aiWorkItems.companyId, ctx.companyId), f.agentId ? eq(S.aiWorkItems.agentId, f.agentId) : undefined, f.status ? eq(S.aiWorkItems.status, f.status as any) : undefined)).orderBy(desc(S.aiWorkItems.createdAt)).limit(100);
  const out = [];
  const cache = new Map<string, { id: string; d: string | null }[]>();
  for (const { w, agent } of rows) {
    if (!cache.has(w.agentId)) cache.set(w.agentId, (await load(ctx, w.agentId).catch(() => ({ roles: [] as { id: string; d: string | null }[] }))).roles);
    const roles = cache.get(w.agentId)!;
    if (can(ctx, 'agents.view', roles)) out.push({ ...w, agentName: agent, canReview: can(ctx, 'agents.approve', roles) });
  }
  return out;
}

export async function reviewWorkItem(ctx: Ctx, itemId: string, decision: 'approve' | 'reject', note?: string | null) {
  const [w] = await ctx.db.select().from(S.aiWorkItems).where(and(eq(S.aiWorkItems.companyId, ctx.companyId), eq(S.aiWorkItems.id, itemId))).limit(1);
  if (!w) throw notFound('Item not found');
  const { a, roles } = await load(ctx, w.agentId);
  need(ctx, 'agents.approve', roles);
  if (w.status !== 'pending_review') throw conflict('This item has already been reviewed');
  let status: 'approved' | 'rejected' | 'executed' | 'failed' = decision === 'approve' ? 'approved' : 'rejected'; let result: string | null = null;
  if (decision === 'approve' && w.kind === 'action' && w.toolKey) {
    const [cfg] = await ctx.db.select().from(S.agentConfigurations).where(eq(S.agentConfigurations.agentId, a.id));
    const spec = TOOL_BY_KEY[w.toolKey];
    if (!spec?.connected || spec.kind === 'external') { status = 'failed'; result = 'This tool is not available'; }
    else try { result = await runTool(ctx.db, a, cfg?.knowledgeScope ?? 'role', w.toolKey, w.toolArgs ?? {}); status = 'executed'; } catch (e) { status = 'failed'; result = (e as Error).message; }
  }
  await ctx.db.update(S.aiWorkItems).set({ status, result, reviewedBy: ctx.user.id, reviewNote: note ?? null, reviewedAt: new Date() }).where(eq(S.aiWorkItems.id, itemId));
  await audit(ctx.db, ctx.companyId, ctx.user.id, `ai_item.${status}`, 'agent', a.id, { itemId, kind: w.kind, title: w.title, toolKey: w.toolKey });
  return { status, result };
}
