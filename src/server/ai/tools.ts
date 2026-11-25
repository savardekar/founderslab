import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { audit } from '../audit';
import type { ToolDef } from './provider';
import { insertTask } from '../services/tasks';
import { agentScope, readForAgent, retrieveForAgent } from '../services/knowledge';
import { decisionsForAgent, proposeFromAgent } from '../services/decisions';

const S = schema;
export type ToolKind = 'read' | 'write' | 'external';
export type ToolSpec = {
  key: string; label: string; description: string; kind: ToolKind;
  /** false = the integration does not exist yet; the tool cannot be enabled or executed */
  connected: boolean;
  /** routine = eligible for Level-4 auto-execution when explicitly pre-authorised */
  routine: boolean;
  inputSchema: Record<string, unknown>;
};

export const TOOLS: ToolSpec[] = [
  { key: 'org_read', label: 'Read organization info', kind: 'read', connected: true, routine: true,
    description: 'Read roles, responsibilities and rules the AI employee is allowed to see (limited by its knowledge scope).',
    inputSchema: { type: 'object', properties: { roleId: { type: 'string', description: 'Optional role id; omit for all roles in scope' } } } },
  { key: 'org_add_responsibility', label: 'Add a responsibility to its own role', kind: 'write', connected: true, routine: true,
    description: 'Add a responsibility to a role this AI employee is assigned to. Subject to the autonomy level and approval rules.',
    inputSchema: { type: 'object', required: ['roleId', 'title'], properties: { roleId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, expectedOutcome: { type: 'string' } } } },
  { key: 'tasks_read', label: 'Read tasks', kind: 'read', connected: true, routine: true,
    description: 'Read tasks owned by this AI employee or belonging to roles within its knowledge scope.', inputSchema: { type: 'object', properties: { status: { type: 'string', description: 'Optional status filter, e.g. in_progress' } } } },
  { key: 'tasks_create', label: 'Create a task for itself', kind: 'write', connected: true, routine: true,
    description: 'Create a task owned by this AI employee (optionally linked to one of its roles). Subject to the autonomy level and approval rules.', inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, description: { type: 'string' }, roleId: { type: 'string' }, dueDate: { type: 'string', description: 'YYYY-MM-DD' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] } } } },
  { key: 'knowledge_search', label: 'Search company knowledge', kind: 'read', connected: true, routine: true,
    description: 'Search company documents (SOPs, policies, plans, notes). Only documents inside your knowledge scope or explicitly shared with you are searched. Cite results by their ref.', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'number', description: 'Max results (default 5)' } } } },
  { key: 'knowledge_read', label: 'Read a company document', kind: 'read', connected: true, routine: true,
    description: 'Read one document by id (from a search result), if you are allowed to.', inputSchema: { type: 'object', required: ['documentId'], properties: { documentId: { type: 'string' } } } },
  { key: 'decisions_read', label: 'Read company decisions', kind: 'read', connected: true, routine: true,
    description: 'Read approved company decisions relevant to your roles. You must follow them.', inputSchema: { type: 'object', properties: {} } },
  { key: 'decisions_propose', label: 'Propose a decision', kind: 'write', connected: true, routine: true,
    description: 'Propose a company decision for a human to approve. You can never approve, change or replace an approved decision.', inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, description: { type: 'string' }, reason: { type: 'string' }, expectedOutcome: { type: 'string' }, relatedRoleId: { type: 'string' } } } },
  { key: 'email_send', label: 'Send email', kind: 'external', connected: false, routine: false, description: 'Send an email to someone outside the company.', inputSchema: { type: 'object' } },
  { key: 'social_publish', label: 'Publish content', kind: 'external', connected: false, routine: false, description: 'Publish content to an external channel.', inputSchema: { type: 'object' } },
  { key: 'payments_spend', label: 'Spend money', kind: 'external', connected: false, routine: false, description: 'Make a payment or purchase.', inputSchema: { type: 'object' } },
  { key: 'web_search', label: 'Search the web', kind: 'external', connected: false, routine: false, description: 'Search the public internet.', inputSchema: { type: 'object' } },
];
export const TOOL_BY_KEY = Object.fromEntries(TOOLS.map((t) => [t.key, t]));
export const toolDefs = (keys: string[]): ToolDef[] => keys.map((k) => TOOL_BY_KEY[k]).filter((t) => t && t.connected).map((t) => ({ name: t.key, description: t.description, inputSchema: t.inputSchema }));

export type ToolDecision = 'execute' | 'queue_action' | 'record_suggestion' | 'record_draft' | 'deny';
/**
 * The autonomy policy. Pure function so it can be tested exhaustively.
 *  L1 suggest only · L2 draft for review · L3 execute only after human approval · L4 auto-execute pre-authorised routine tools.
 * External tools are always denied: no external action exists in this phase.
 */
export function decideTool(autonomy: number, tool: ToolSpec | undefined, perm: { enabled: boolean; requiresApproval: boolean } | undefined): ToolDecision {
  if (!tool || !perm?.enabled || !tool.connected || tool.kind === 'external') return 'deny';
  if (tool.kind === 'read') return 'execute';
  if (autonomy <= 1) return 'record_suggestion';
  if (autonomy === 2) return 'record_draft';
  if (autonomy === 3) return 'queue_action';
  return tool.routine && !perm.requiresApproval ? 'execute' : 'queue_action';
}

type Agent = { id: string; companyId: string };
export async function agentRoleIds(db: Db, a: Agent): Promise<string[]> {
  const rows = await db.select({ id: S.roleAssignments.roleId }).from(S.roleAssignments)
    .innerJoin(S.roles, and(eq(S.roles.companyId, S.roleAssignments.companyId), eq(S.roles.id, S.roleAssignments.roleId)))
    .where(and(eq(S.roleAssignments.companyId, a.companyId), eq(S.roleAssignments.agentId, a.id), isNull(S.roleAssignments.endedAt), isNull(S.roles.archivedAt)));
  return rows.map((r) => r.id);
}

/** Roles visible to the agent under its knowledge scope. */
async function rolesInScope(db: Db, a: Agent, scope: string) {
  if (scope === 'none') return [];
  const mine = await agentRoleIds(db, a);
  const all = await db.select().from(S.roles).where(and(eq(S.roles.companyId, a.companyId), isNull(S.roles.archivedAt))).orderBy(asc(S.roles.position));
  if (scope === 'company') return all;
  if (scope === 'department') { const d = new Set(all.filter((r) => mine.includes(r.id) && r.departmentId).map((r) => r.departmentId)); return all.filter((r) => mine.includes(r.id) || (r.departmentId && d.has(r.departmentId))); }
  return all.filter((r) => mine.includes(r.id));
}

export async function runTool(db: Db, a: Agent, scope: string, key: string, args: Record<string, any>, extra: { runId?: string | null } = {}): Promise<string> {
  if (key === 'org_read') {
    const roles = await rolesInScope(db, a, scope);
    if (scope === 'none') return 'Access to company information is disabled for this AI employee.';
    const pick = args.roleId ? roles.filter((r) => r.id === args.roleId) : roles;
    if (args.roleId && !pick.length) return 'That role is outside your knowledge scope or does not exist.';
    const ids = pick.map((r) => r.id);
    const resp = ids.length ? await db.select().from(S.roleResponsibilities).where(and(eq(S.roleResponsibilities.companyId, a.companyId), inArray(S.roleResponsibilities.roleId, ids), isNull(S.roleResponsibilities.archivedAt))) : [];
    const rules = ids.length ? await db.select().from(S.roleRules).where(and(eq(S.roleRules.companyId, a.companyId), inArray(S.roleRules.roleId, ids), isNull(S.roleRules.archivedAt))) : [];
    const name = new Map(roles.map((r) => [r.id, r.name]));
    return JSON.stringify(pick.map((r) => ({ id: r.id, name: r.name, description: r.description, reportsTo: r.reportsToRoleId ? name.get(r.reportsToRoleId) ?? null : null,
      responsibilities: resp.filter((x) => x.roleId === r.id).map((x) => ({ title: x.title, expectedOutcome: x.expectedOutcome, priority: x.priority })),
      rules: rules.filter((x) => x.roleId === r.id).map((x) => `${x.kind}: ${x.text}`) })));
  }
  if (key === 'org_add_responsibility') {
    if (typeof args.roleId !== 'string' || typeof args.title !== 'string' || !args.title.trim()) throw new Error('roleId and title are required');
    if (!(await agentRoleIds(db, a)).includes(args.roleId)) throw new Error('You can only change roles you are assigned to');
    const existing = await db.select({ p: S.roleResponsibilities.position }).from(S.roleResponsibilities).where(and(eq(S.roleResponsibilities.companyId, a.companyId), eq(S.roleResponsibilities.roleId, args.roleId)));
    const m = existing.reduce((x, r) => Math.max(x, r.p), -1) + 1;
    const [row] = await db.insert(S.roleResponsibilities).values({ companyId: a.companyId, roleId: args.roleId, title: args.title.slice(0, 200), description: args.description?.toString().slice(0, 2000) ?? null, expectedOutcome: args.expectedOutcome?.toString().slice(0, 1000) ?? null, position: m }).returning();
    await audit(db, a.companyId, null, 'ai.responsibility_added', 'responsibility', row.id, { agentId: a.id, roleId: args.roleId, title: row.title });
    return `Added responsibility "${row.title}".`;
  }
  if (key === 'tasks_read') {
    if (scope === 'none') return 'Access to company information is disabled for this AI employee.';
    const roles = new Set((await rolesInScope(db, a, scope)).map((r) => r.id));
    const rows = await db.select().from(S.tasks).where(and(eq(S.tasks.companyId, a.companyId), isNull(S.tasks.archivedAt), args.status ? eq(S.tasks.status, String(args.status) as any) : undefined)).orderBy(asc(S.tasks.dueDate)).limit(300);
    return JSON.stringify(rows.filter((t) => t.ownerAgentId === a.id || (t.roleId && roles.has(t.roleId))).slice(0, 50).map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, dueDate: t.dueDate, roleId: t.roleId, ownedByYou: t.ownerAgentId === a.id })));
  }
  if (key === 'tasks_create') {
    if (typeof args.title !== 'string' || !args.title.trim()) throw new Error('title is required');
    if (args.roleId && !(await agentRoleIds(db, a)).includes(String(args.roleId))) throw new Error('You can only create tasks for roles you are assigned to');
    const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
    const pr = ['low', 'medium', 'high', 'critical'].includes(String(args.priority)) ? (args.priority as 'low' | 'medium' | 'high' | 'critical') : 'medium';
    const t = await insertTask(db, a.companyId, { agentId: a.id }, { title: args.title.trim().slice(0, 200), description: args.description ? String(args.description).slice(0, 5000) : null, roleId: args.roleId ? String(args.roleId) : null, owner: { agentId: a.id }, priority: pr, dueDate: date(args.dueDate) });
    await audit(db, a.companyId, null, 'ai.task_created', 'task', t.id, { agentId: a.id, title: t.title });
    return `Created task "${t.title}" (${t.id}).`;
  }
  if (key === 'knowledge_search') {
    if (scope === 'none') return 'Access to company information is disabled for this AI employee.';
    if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('query is required');
    const r = await retrieveForAgent(db, a.companyId, await agentScope(db, a.companyId, a.id, scope), args.query.slice(0, 500), Math.min(Number(args.limit) || 5, 8), extra.runId);
    if (!r.hits.length) return `No documents in your knowledge scope matched "${args.query.slice(0, 80)}". (${r.searched} document(s) searched.) Do not guess; say the information is not available.`;
    return JSON.stringify({ method: r.method, results: r.hits.map((h) => ({ ref: h.ref, documentId: h.documentId, title: h.title, type: h.docType, version: h.version, heading: h.heading, excerpt: h.snippet, score: h.score })) });
  }
  if (key === 'knowledge_read') {
    if (scope === 'none') return 'Access to company information is disabled for this AI employee.';
    const r = await readForAgent(db, a.companyId, await agentScope(db, a.companyId, a.id, scope), String(args.documentId ?? ''), extra.runId);
    return r ? JSON.stringify(r) : 'Document not found or outside your knowledge scope.';
  }
  if (key === 'decisions_read') {
    if (scope === 'none') return 'Access to company information is disabled for this AI employee.';
    const rows = await decisionsForAgent(db, a.companyId, await agentRoleIds(db, a));
    return JSON.stringify(rows.map((d) => ({ ref: `decision:${d.id}`, title: d.title, decidedOn: d.decidedOn, reason: d.reason, expectedOutcome: d.expectedOutcome, description: d.description.slice(0, 600) })));
  }
  if (key === 'decisions_propose') {
    if (typeof args.title !== 'string' || !args.title.trim()) throw new Error('title is required');
    const d = await proposeFromAgent(db, a.companyId, a, await agentRoleIds(db, a), { title: args.title.trim(), description: args.description, reason: args.reason, expectedOutcome: args.expectedOutcome, relatedRoleId: args.relatedRoleId ? String(args.relatedRoleId) : undefined });
    return `Proposed decision "${d.title}" (${d.id}). It is NOT in effect until a human approves it.`;
  }
  throw new Error(`Tool ${key} is not available`);
}
