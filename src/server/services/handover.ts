import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { OPEN_STATUSES } from '@/lib/constants';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { audit } from '../audit';
import type { Ctx } from '../authz';
import { assignTx, endAssignmentsTx, setOwnerTx } from './assignments';
import { computeKpi } from './kpis';
import { generateOnboardingChecklist } from './onboarding';
import { resolveWindow, today, addDays } from './metrics';
import { notify, ownerUserIds } from './notifications';
import { projectHealth } from './projects';
import type { Report } from './reports';
import { kpiAllowed, loadOps, reportScope, type Ops } from './scope';

const S = schema;
export type Target = { membershipId?: string | null; agentId?: string | null; manager?: boolean };
type Resolved = { kind: 'human'; membershipId: string; name: string } | { kind: 'ai'; agentId: string; name: string };
type Subject = { membershipId?: string | null; agentId?: string | null };
const EXCLUDED = ['Personal profile data (email, phone, bio) and employment details', 'Credentials, passwords, sessions and tokens', 'Salary and other financial or HR records'];
const open = new Set<string>(OPEN_STATUSES);
const aiEligibleTask = (t: { requiresApproval: boolean; status: string }) => !t.requiresApproval && t.status !== 'awaiting_approval';
const isoDate = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString().slice(0, 10));

// ───────────── the handover report ─────────────
export async function buildHandoverReport(ctx: Ctx, subject: Subject, ops?: Ops) {
  const o = ops ?? (await loadOps(ctx.db, ctx.companyId)); const sc = await reportScope(ctx, o); const now = new Date(); const t0 = today(now);
  const isAi = !!subject.agentId; const w = resolveWindow('monthly', null, null, null, now);
  const mine = o.assigns.filter((a) => (isAi ? a.agentId === subject.agentId : a.membershipId === subject.membershipId));
  const roleIds = new Set(mine.map((a) => a.roleId)); const myTasks = o.tasks.filter((t) => (isAi ? t.ownerAgentId === subject.agentId : t.ownerMembershipId === subject.membershipId));
  const name = isAi ? o.agents.find((a) => a.id === subject.agentId)?.name ?? '' : o.members.find((m) => m.id === subject.membershipId)?.name ?? '';
  const person = isAi ? null : o.members.find((m) => m.id === subject.membershipId);
  const rn = new Map(o.roles.map((r) => [r.id, r.name])); const tn = new Map(o.tasks.map((t) => [t.id, t]));
  const [docs, decs, recurring, deps] = await Promise.all([
    ctx.db.select().from(S.knowledgeDocuments).where(and(eq(S.knowledgeDocuments.companyId, ctx.companyId), isNull(S.knowledgeDocuments.archivedAt))),
    ctx.db.select().from(S.decisions).where(and(eq(S.decisions.companyId, ctx.companyId), isNull(S.decisions.archivedAt))),
    ctx.db.select().from(S.recurringTasks).where(and(eq(S.recurringTasks.companyId, ctx.companyId), eq(S.recurringTasks.active, true))),
    ctx.db.select().from(S.taskDependencies).where(eq(S.taskDependencies.companyId, ctx.companyId)),
  ]);
  const myProjects = o.projects.filter((p) => (isAi ? o.projectMembers.some((m) => m.projectId === p.id && m.agentId === subject.agentId) : p.ownerMembershipId === subject.membershipId || o.projectMembers.some((m) => m.projectId === p.id && m.membershipId === subject.membershipId)));
  const docOf = (respId: string) => docs.find((d) => d.status === 'published' && d.responsibilityId === respId);   // documented only when a published document is linked to the responsibility
  const gaps: { kind: 'gap_responsibility' | 'gap_project'; refId: string; title: string; detail: string; roleId: string | null }[] = [];
  const roles = [...roleIds].map((rid) => { const r = o.roles.find((x) => x.id === rid)!; const resp = o.resp.filter((x) => x.roleId === rid);
    resp.forEach((x) => { if (!docOf(x.id)) gaps.push({ kind: 'gap_responsibility', refId: x.id, title: `${r.name}: "${x.title}" has no SOP or workflow document`, detail: 'Write the procedure so the next owner does not depend on memory.', roleId: rid }); });
    return { roleId: rid, name: r.name, department: o.depts.find((d) => d.id === r.departmentId)?.name ?? null, mode: r.roleType, isOwner: mine.find((a) => a.roleId === rid)?.isPrimary ?? false, reportsTo: r.reportsToRoleId ? rn.get(r.reportsToRoleId) ?? null : null, hasApprovalAuthority: r.hasApprovalAuthority, approvalLimit: r.approvalLimit == null ? null : Number(r.approvalLimit),
      responsibilities: resp.map((x) => ({ id: x.id, title: x.title, expectedOutcome: x.expectedOutcome, priority: x.priority, frequency: x.frequency, requiresApproval: x.requiresApproval, documented: !!docOf(x.id) })),
      kpis: o.kpis.filter((k) => k.roleId === rid && kpiAllowed(sc, k)).map((k) => { const c = computeKpi(o, k, resolveWindow(k.period === 'none' ? 'monthly' : k.period, null, null, null, now), now); return { name: k.name, target: c.target, unit: k.unit, actual: c.actual, status: c.status }; }), restrictedKpis: o.kpis.filter((k) => k.roleId === rid && !kpiAllowed(sc, k)).length }; });
  void w;
  const taskRow = (t: Ops['tasks'][number]) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, dueDate: t.dueDate, roleId: t.roleId, role: t.roleId ? rn.get(t.roleId) ?? null : null, projectId: t.projectId, requiresApproval: t.requiresApproval, deliverablesOpen: (t.deliverables ?? []).filter((d) => !d.done).map((d) => d.title), waitingOn: deps.filter((d) => d.taskId === t.id).map((d) => tn.get(d.dependsOnTaskId)).filter((x) => x && x.status !== 'completed').map((x) => x!.title) });
  const openT = myTasks.filter((t) => open.has(t.status));
  const current = openT.filter((t) => ['in_progress', 'blocked', 'in_review', 'awaiting_approval'].includes(t.status)).map(taskRow), pending = openT.filter((t) => ['todo', 'backlog'].includes(t.status)).map(taskRow);
  const approvals = [...openT.filter((t) => t.status === 'awaiting_approval').map((t) => ({ kind: 'waiting_for_approval', taskId: t.id, title: t.title })), ...(isAi ? [] : o.tasks.filter((t) => t.status === 'awaiting_approval' && t.roleId && roleIds.has(t.roleId) && o.roles.find((r) => r.id === t.roleId)?.hasApprovalAuthority && t.ownerMembershipId !== subject.membershipId).map((t) => ({ kind: 'to_approve', taskId: t.id, title: t.title })))];
  const ownedProjects = myProjects.map((p) => { const pt = o.tasks.filter((t) => t.projectId === p.id && t.status !== 'cancelled'); const h = projectHealth(p, { total: pt.length, done: pt.filter((t) => t.status === 'completed').length, open: pt.filter((t) => t.status !== 'completed').length, overdue: pt.filter((t) => t.status !== 'completed' && t.dueDate && t.dueDate < t0).length }, now);
    if (!isAi && p.ownerMembershipId === subject.membershipId && !docs.some((d) => d.projectId === p.id && d.docType === 'project_doc' && d.status === 'published')) gaps.push({ kind: 'gap_project', refId: p.id, title: `Project "${p.name}" has no project documentation`, detail: 'Document goals, status and how to run it.', roleId: null });
    return { id: p.id, name: p.name, status: p.status, health: h.health, progress: h.progress == null ? null : Math.round(h.progress * 100), deadline: p.deadline, isOwner: p.ownerMembershipId === subject.membershipId, deliverablesOpen: p.deliverables.filter((d) => !d.done).map((d) => d.title) }; });
  const sops = docs.filter((d) => d.status === 'published' && ((!isAi && d.ownerMembershipId === subject.membershipId) || (d.roleId && roleIds.has(d.roleId)) || (d.responsibilityId && o.resp.some((x) => x.id === d.responsibilityId && roleIds.has(x.roleId)))) && ['sop', 'policy', 'workflow', 'project_doc', 'role_description'].includes(d.docType)).map((d) => ({ id: d.id, title: d.title, docType: d.docType, version: d.currentVersion, authoredByThem: !isAi && d.ownerMembershipId === subject.membershipId }));
  const projIds = new Set(myProjects.map((p) => p.id));
  const decisions = decs.filter((d) => ['approved', 'proposed'].includes(d.status) && ((d.relatedRoleId && roleIds.has(d.relatedRoleId)) || (d.relatedProjectId && projIds.has(d.relatedProjectId)) || (!isAi && d.decisionMakerMembershipId === subject.membershipId))).map((d) => ({ id: d.id, title: d.title, status: d.status, decidedOn: d.decidedOn, reason: d.reason, confidential: d.confidential }));
  const deadlines = [...openT.filter((t) => t.dueDate && t.dueDate <= addDays(t0, 30)).map((t) => ({ type: 'task', title: t.title, dueDate: t.dueDate!, overdue: t.dueDate! < t0 })), ...ownedProjects.filter((p) => p.deadline && p.deadline <= addDays(t0, 60) && !['completed', 'cancelled'].includes(p.status)).map((p) => ({ type: 'project', title: p.name, dueDate: p.deadline!, overdue: p.deadline! < t0 }))].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const mineIds = new Set(openT.map((t) => t.id));
  const dependencies = deps.filter((d) => mineIds.has(d.taskId) || mineIds.has(d.dependsOnTaskId)).map((d) => { const a = tn.get(d.taskId)!, b = tn.get(d.dependsOnTaskId)!; return { task: a.title, dependsOn: b.title, direction: mineIds.has(d.taskId) ? 'blocked_by' : 'blocks', otherStatus: (mineIds.has(d.taskId) ? b : a).status }; });
  const deliverables = [...openT.flatMap((t) => (t.deliverables ?? []).filter((d) => !d.done).map((d) => ({ source: 'task', parent: t.title, title: d.title }))), ...ownedProjects.flatMap((p) => p.deliverablesOpen.map((d) => ({ source: 'project', parent: p.name, title: d })))];
  const direct = isAi ? 0 : (await ctx.db.select({ n: sql<number>`count(*)` }).from(S.membershipPermissions).where(and(eq(S.membershipPermissions.companyId, ctx.companyId), eq(S.membershipPermissions.membershipId, subject.membershipId!))))[0].n;
  const rolePerms = roleIds.size ? (await ctx.db.select({ n: sql<number>`count(distinct ${S.rolePermissions.permissionKey})` }).from(S.rolePermissions).where(and(eq(S.rolePermissions.companyId, ctx.companyId), inArray(S.rolePermissions.roleId, [...roleIds]))))[0].n : 0;
  const rec = recurring.filter((r) => (isAi ? r.ownerAgentId === subject.agentId : r.ownerMembershipId === subject.membershipId));
  const emp = person ? (await ctx.db.select().from(S.employees).where(and(eq(S.employees.companyId, ctx.companyId), eq(S.employees.membershipId, person.id))))[0] : null;
  return {
    generatedAt: now.toISOString(), generatedBy: ctx.user.name,
    subject: { kind: isAi ? 'ai' : 'human', id: (isAi ? subject.agentId : subject.membershipId) as string, name, jobTitle: person?.jobTitle ?? null, department: person?.departmentId ? o.depts.find((d) => d.id === person.departmentId)?.name ?? null : null, manager: person?.managerId ? o.members.find((m) => m.id === person.managerId)?.name ?? null : null, since: emp?.startDate ? isoDate(emp.startDate) : null },
    roles, tasks: { current, pending }, deadlines, dependencies, projects: ownedProjects, approvals, sops, decisions, deliverables, recurring: rec.map((r) => ({ id: r.id, title: r.title, cadence: r.cadence, nextRunOn: r.nextRunOn })),
    knowledgeGaps: gaps, access: { accessLevel: isAi ? 'ai employee' : (await ctx.db.select({ a: S.companyMemberships.accessLevel }).from(S.companyMemberships).where(eq(S.companyMemberships.id, subject.membershipId!)))[0]?.a, directPermissions: Number(direct), rolePermissionKeys: Number(rolePerms) },
    excluded: EXCLUDED, counts: { roles: roles.length, openTasks: openT.length, projects: ownedProjects.length, gaps: gaps.length, approvals: approvals.length },
  };
}
export type HandoverReportData = Awaited<ReturnType<typeof buildHandoverReport>>;

/** Handover → the standard Report shape so it can be exported to CSV / PDF with the same safe renderers. */
export function handoverToReport(h: { reason: string; subjectName: string; createdAt: Date; effectiveDate: string | null }, r: HandoverReportData, generatedBy: string): Report {
  const T = (title: string, columns: string[], rows: (string | number | null)[][]) => ({ title, columns, rows });
  return { type: 'risk', title: `Handover Report — ${h.subjectName}`, subtitle: h.reason.replace(/_/g, ' '), period: 'custom', from: isoDate(h.createdAt), to: h.effectiveDate ?? isoDate(h.createdAt), generatedAt: r.generatedAt, generatedBy, scopeNote: 'Operational handover. No personal data or credentials are included.', definitions: r.excluded.map((x) => `Not included: ${x}`), restricted: [], exportTargets: [], selfOnly: false,
    summary: [{ label: 'Subject', value: `${r.subject.name} (${r.subject.kind === 'ai' ? 'AI employee' : 'person'})` }, { label: 'Roles', value: r.counts.roles }, { label: 'Open tasks', value: r.counts.openTasks }, { label: 'Projects', value: r.counts.projects }, { label: 'Pending approvals', value: r.counts.approvals }, { label: 'Knowledge gaps', value: r.counts.gaps }],
    tables: [T('Roles & responsibilities', ['Role', 'Department', 'Owner', 'Responsibility', 'Priority', 'Frequency', 'Documented'], r.roles.flatMap((x) => x.responsibilities.length ? x.responsibilities.map((y) => [x.name, x.department, x.isOwner ? 'yes' : 'no', y.title, y.priority, y.frequency, y.documented ? 'yes' : 'NO']) : [[x.name, x.department, x.isOwner ? 'yes' : 'no', '—', null, null, null]])),
      T('KPI targets', ['Role', 'KPI', 'Target', 'Actual', 'Status'], r.roles.flatMap((x) => x.kpis.map((k) => [x.name, k.name, k.target == null ? '—' : `${k.target} ${k.unit ?? ''}`.trim(), k.actual == null ? '—' : `${k.actual} ${k.unit ?? ''}`.trim(), k.status.replace('_', ' ')]))),
      T('Current tasks', ['Task', 'Status', 'Priority', 'Due', 'Role', 'Waiting on', 'Open deliverables'], r.tasks.current.map((t) => [t.title, t.status, t.priority, t.dueDate, t.role, t.waitingOn.join('; '), t.deliverablesOpen.join('; ')])),
      T('Pending tasks', ['Task', 'Status', 'Priority', 'Due', 'Role'], r.tasks.pending.map((t) => [t.title, t.status, t.priority, t.dueDate, t.role])),
      T('Deadlines', ['Type', 'Item', 'Due', 'Overdue'], r.deadlines.map((d) => [d.type, d.title, d.dueDate, d.overdue ? 'yes' : ''])),
      T('Dependencies', ['Task', 'Depends on', 'Direction', 'Other status'], r.dependencies.map((d) => [d.task, d.dependsOn, d.direction.replace('_', ' '), d.otherStatus])),
      T('Projects', ['Project', 'Status', 'Health', 'Progress %', 'Deadline', 'Owner'], r.projects.map((p) => [p.name, p.status, p.health.replace('_', ' '), p.progress, p.deadline, p.isOwner ? 'yes' : 'no'])),
      T('Pending approvals', ['Type', 'Task'], r.approvals.map((a) => [a.kind.replace(/_/g, ' '), a.title])),
      T('SOPs & documents', ['Document', 'Type', 'Version', 'Authored by them'], r.sops.map((d) => [d.title, d.docType, d.version, d.authoredByThem ? 'yes' : 'no'])),
      T('Relevant decisions', ['Decision', 'Status', 'Decided', 'Reason'], r.decisions.map((d) => [d.title, d.status, d.decidedOn, d.confidential ? '(confidential)' : d.reason])),
      T('Open deliverables', ['From', 'Source', 'Deliverable'], r.deliverables.map((d) => [d.parent, d.source, d.title])),
      T('Knowledge gaps', ['Gap', 'What to do'], r.knowledgeGaps.map((g) => [g.title, g.detail]))] };
}

// ───────────── targets, authorisation, transfers ─────────────
async function managerOf(db: Db, companyId: string, subject: Subject) {
  if (subject.agentId) { const [a] = await db.select({ m: S.aiAgents.managerMembershipId }).from(S.aiAgents).where(eq(S.aiAgents.id, subject.agentId)); if (a?.m) return a.m; }
  else if (subject.membershipId) { const [e] = await db.select({ m: S.employees.managerMembershipId }).from(S.employees).where(and(eq(S.employees.companyId, companyId), eq(S.employees.membershipId, subject.membershipId))); if (e?.m) return e.m; }
  const [o] = await db.select({ id: S.companyMemberships.id }).from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, companyId), eq(S.companyMemberships.accessLevel, 'owner'), eq(S.companyMemberships.status, 'active'))); return o?.id ?? null;
}
async function resolveTarget(db: Db, companyId: string, t: Target, subject: Subject): Promise<Resolved> {
  if (Number(!!t.manager) + Number(!!t.membershipId) + Number(!!t.agentId) !== 1) throw badRequest('Choose exactly one new owner: a person, an AI employee, or the manager');
  let mid = t.membershipId ?? null;
  if (t.manager) { mid = await managerOf(db, companyId, subject); if (!mid) throw badRequest('No manager could be determined'); }
  if (mid) {
    if (mid === subject.membershipId) throw badRequest('The new owner cannot be the person who is leaving');
    const [m] = await db.select({ n: S.users.name }).from(S.companyMemberships).innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId)).where(and(eq(S.companyMemberships.companyId, companyId), eq(S.companyMemberships.id, mid), eq(S.companyMemberships.status, 'active')));
    if (!m) throw badRequest('The new owner must be an active employee'); return { kind: 'human', membershipId: mid, name: m.n };
  }
  const [a] = await db.select({ n: S.aiAgents.name, s: S.aiAgents.status }).from(S.aiAgents).where(and(eq(S.aiAgents.companyId, companyId), eq(S.aiAgents.id, t.agentId!), isNull(S.aiAgents.archivedAt)));
  if (!a) throw badRequest('AI employee not found'); if (a.s !== 'active') throw badRequest('The AI employee must be active to take over work');
  if (t.agentId === subject.agentId) throw badRequest('The new owner cannot be the AI employee being replaced');
  return { kind: 'ai', agentId: t.agentId!, name: a.n };
}
const ownerCols = (r: Resolved) => (r.kind === 'human' ? { ownerMembershipId: r.membershipId, ownerAgentId: null } : { ownerMembershipId: null, ownerAgentId: r.agentId });
const toCols = (r: Resolved) => (r.kind === 'human' ? { toMembershipId: r.membershipId, toAgentId: null } : { toMembershipId: null, toAgentId: r.agentId });
function needs(ctx: Ctx, keys: string[]) { for (const k of keys) if (!ctx.can(k)) throw forbidden(`This needs the ${k} permission`); }
/** Newly responsible people get a refreshed onboarding checklist. Runs after commit; never blocks the transition. */
async function refreshOnboarding(ctx: Ctx, targets: (Resolved | null | undefined)[]) { for (const t of targets) if (t?.kind === 'human') { try { await generateOnboardingChecklist(ctx.db, ctx.companyId, t.membershipId); } catch { /* non-critical */ } } }

/** Gives `to` the role. AI employees only receive responsibilities that do not need approval; human owners are never replaced silently. */
async function moveRole(tx: Db, ctx: Ctx, ho: string, roleId: string, to: Resolved, opts: { wasOwner: boolean; approverName?: string | null }) {
  const [role] = await tx.select().from(S.roles).where(and(eq(S.roles.companyId, ctx.companyId), eq(S.roles.id, roleId), isNull(S.roles.archivedAt)));
  if (!role) throw notFound('Role not found');
  const target = to.kind === 'human' ? { membershipId: to.membershipId } : { agentId: to.agentId };
  try { await assignTx(tx, ctx.companyId, roleId, target, ctx.user.id); } catch (e) { if (!/Already assigned/.test((e as Error).message)) throw e; }
  const [a] = await tx.select().from(S.roleAssignments).where(and(eq(S.roleAssignments.companyId, ctx.companyId), eq(S.roleAssignments.roleId, roleId), isNull(S.roleAssignments.endedAt), to.kind === 'human' ? eq(S.roleAssignments.membershipId, to.membershipId) : eq(S.roleAssignments.agentId, to.agentId)));
  const [owner] = await tx.select({ id: S.roleAssignments.id }).from(S.roleAssignments).where(and(eq(S.roleAssignments.companyId, ctx.companyId), eq(S.roleAssignments.roleId, roleId), isNull(S.roleAssignments.endedAt), eq(S.roleAssignments.isPrimary, true)));
  const changes: string[] = [];
  if (opts.wasOwner || !owner) await setOwnerTx(tx, ctx.companyId, roleId, a.id);
  if (to.kind === 'human') { const [n] = await tx.select({ n: sql<number>`count(*)` }).from(S.rolePermissions).where(and(eq(S.rolePermissions.companyId, ctx.companyId), eq(S.rolePermissions.roleId, roleId))); changes.push(`${to.name} now receives this role's ${Number(n.n)} permission(s)`); }
  else {
    const resp = await tx.select().from(S.roleResponsibilities).where(and(eq(S.roleResponsibilities.companyId, ctx.companyId), eq(S.roleResponsibilities.roleId, roleId), isNull(S.roleResponsibilities.archivedAt)));
    const held = resp.filter((r) => r.requiresApproval);
    for (const r of held) await tx.delete(S.agentResponsibilities).where(and(eq(S.agentResponsibilities.agentId, to.agentId), eq(S.agentResponsibilities.responsibilityId, r.id)));
    changes.push(`${to.name} (AI) took the role but only ${resp.length - held.length} of ${resp.length} responsibilities; ${held.length} that need approval stay with a human`);
    if (role.hasApprovalAuthority) changes.push(`Approval authority cannot pass to AI: it stays with ${opts.approverName ?? 'a human (not yet assigned)'}`);
    changes.push('AI employees get no user permissions; they act only through approved tools and need human approval for sensitive actions');
  }
  await tx.update(S.roleTransitions).set({ ...(to.kind === 'human' ? { toKind: 'human', toMembershipId: to.membershipId, toAgentId: null } : { toKind: 'ai', toAgentId: to.agentId, toMembershipId: null }), status: 'completed', completedAt: new Date(), accessChanges: sql`${S.roleTransitions.accessChanges} || ${JSON.stringify(changes)}::jsonb` }).where(and(eq(S.roleTransitions.companyId, ctx.companyId), eq(S.roleTransitions.handoverId, ho), eq(S.roleTransitions.roleId, roleId)));
  await audit(tx, ctx.companyId, ctx.user.id, 'role.ownership_transferred', 'role', roleId, { name: role.name, to: to.kind === 'human' ? { membershipId: to.membershipId } : { agentId: to.agentId }, handoverId: ho });
  return { role, changes };
}

async function markItem(tx: Db, ctx: Ctx, ho: string, f: { id?: string; kind?: string; refId?: string }, to: Resolved | null, status: 'assigned' | 'done', note?: string) {
  const conds = [eq(S.handoverItems.companyId, ctx.companyId), eq(S.handoverItems.handoverId, ho), eq(S.handoverItems.status, 'pending')]; if (f.id) conds.push(eq(S.handoverItems.id, f.id)); if (f.kind) conds.push(eq(S.handoverItems.kind, f.kind)); if (f.refId) conds.push(eq(S.handoverItems.refId, f.refId));
  await tx.update(S.handoverItems).set({ status, ...(to ? toCols(to) : {}), note: note ?? null, resolvedBy: ctx.user.id, resolvedAt: new Date() }).where(and(...conds));
}
async function notifyTarget(tx: Db, ctx: Ctx, to: Resolved, title: string, link: string, key: string) {
  let uid: string | undefined;
  if (to.kind === 'human') uid = (await tx.select({ u: S.companyMemberships.userId }).from(S.companyMemberships).where(eq(S.companyMemberships.id, to.membershipId)))[0]?.u;
  else { const [a] = await tx.select({ m: S.aiAgents.managerMembershipId }).from(S.aiAgents).where(eq(S.aiAgents.id, to.agentId)); if (a?.m) uid = (await tx.select({ u: S.companyMemberships.userId }).from(S.companyMemberships).where(eq(S.companyMemberships.id, a.m)))[0]?.u; }
  await notify(tx, ctx.companyId, [uid], { kind: 'handover', title, link, dedupeKey: key });
}

/** Moves the subject's open tasks (and recurring templates). `pick` decides each task's new owner; AI only receives tasks that need no approval. */
async function moveTasks(tx: Db, ctx: Ctx, ho: string, from: Subject, pick: (t: { roleId: string | null; requiresApproval: boolean; status: string }) => Resolved | null) {
  const tasks = await tx.select().from(S.tasks).where(and(eq(S.tasks.companyId, ctx.companyId), isNull(S.tasks.archivedAt), inArray(S.tasks.status, OPEN_STATUSES), from.agentId ? eq(S.tasks.ownerAgentId, from.agentId) : eq(S.tasks.ownerMembershipId, from.membershipId!)));
  let moved = 0, kept = 0;
  for (const t of tasks) {
    const to = pick(t); if (!to || (to.kind === 'ai' && !aiEligibleTask(t))) { kept++; continue; }
    await tx.update(S.tasks).set({ ...ownerCols(to), updatedAt: new Date() }).where(eq(S.tasks.id, t.id));
    await tx.insert(S.taskActivity).values({ companyId: ctx.companyId, taskId: t.id, actorUserId: ctx.user.id, action: 'handover_reassigned', metadata: { handoverId: ho, to: to.kind === 'human' ? { membershipId: to.membershipId } : { agentId: to.agentId } } });
    await markItem(tx, ctx, ho, { kind: 'task', refId: t.id }, to, 'assigned'); await notifyTarget(tx, ctx, to, `Task handed over to you: ${t.title}`, `/c/${ctx.companyId}/tasks?task=${t.id}`, `ho-task:${t.id}:${ho}`); moved++;
  }
  const rec = await tx.select().from(S.recurringTasks).where(and(eq(S.recurringTasks.companyId, ctx.companyId), eq(S.recurringTasks.active, true), from.agentId ? eq(S.recurringTasks.ownerAgentId, from.agentId) : eq(S.recurringTasks.ownerMembershipId, from.membershipId!)));
  for (const r of rec) { const to = pick({ roleId: r.roleId, requiresApproval: r.requiresApproval, status: 'todo' }); if (!to || (to.kind === 'ai' && r.requiresApproval)) continue; await tx.update(S.recurringTasks).set(ownerCols(to)).where(eq(S.recurringTasks.id, r.id)); await markItem(tx, ctx, ho, { kind: 'recurring', refId: r.id }, to, 'assigned'); }
  return { moved, kept };
}

// ───────────── creating handovers ─────────────
async function createHandover(tx: Db, ctx: Ctx, reason: string, subject: Subject, name: string, report: HandoverReportData, o: { effectiveDate?: string | null; notes?: string | null }) {
  const [h] = await tx.insert(S.handovers).values({ companyId: ctx.companyId, reason, subjectKind: subject.agentId ? 'ai' : 'human', subjectName: name, fromMembershipId: subject.membershipId ?? null, fromAgentId: subject.agentId ?? null, effectiveDate: o.effectiveDate ?? today(), notes: o.notes ?? null, report: report as unknown as Record<string, unknown>, createdBy: ctx.user.id }).returning();
  const items: (typeof S.handoverItems.$inferInsert)[] = [];
  const add = (kind: string, refId: string | null, title: string, detail: string | null, roleId: string | null) => items.push({ companyId: ctx.companyId, handoverId: h.id, kind, refId, title, detail, roleId });
  report.roles.forEach((r) => add('role', r.roleId, `Role: ${r.name}`, r.isOwner ? 'They were the owner of this role.' : null, r.roleId));
  [...report.tasks.current, ...report.tasks.pending].forEach((t) => add('task', t.id, `Task: ${t.title}`, `${t.status}${t.dueDate ? ` · due ${t.dueDate}` : ''}`, t.roleId));
  report.approvals.forEach((a) => add('approval', a.taskId, `Approval: ${a.title}`, a.kind.replace(/_/g, ' '), null));
  report.projects.filter((p) => p.isOwner).forEach((p) => add('project', p.id, `Project: ${p.name}`, `${p.status} · ${p.health.replace('_', ' ')}`, null));
  report.sops.filter((d) => d.authoredByThem).forEach((d) => add('document', d.id, `Document: ${d.title}`, d.docType, null));
  report.recurring.forEach((r) => add('recurring', r.id, `Recurring task: ${r.title}`, r.cadence, null));
  report.knowledgeGaps.forEach((g) => add(g.kind, g.refId, g.title, g.detail, g.roleId));
  if (items.length) await tx.insert(S.handoverItems).values(items);
  for (const r of report.roles) await tx.insert(S.roleTransitions).values({ companyId: ctx.companyId, handoverId: h.id, roleId: r.roleId, fromKind: subject.agentId ? 'ai' : 'human', fromMembershipId: subject.membershipId ?? null, fromAgentId: subject.agentId ?? null, accessChanges: [] });
  return h;
}

async function assertLeaver(ctx: Ctx, membershipId: string) {
  const [m] = await ctx.db.select().from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, ctx.companyId), eq(S.companyMemberships.id, membershipId)));
  if (!m || m.status === 'removed') throw notFound('Employee not found'); if (m.accessLevel === 'owner') throw forbidden('The owner cannot be offboarded'); if (m.id === ctx.membership.id) throw badRequest('You cannot offboard yourself'); return m;
}
export async function exitPreview(ctx: Ctx, membershipId: string) {
  needs(ctx, ['members.delete', 'handover.create']);
  await assertLeaver(ctx, membershipId);
  return buildHandoverReport(ctx, { membershipId });
}

export type ExitInput = { effectiveDate?: string | null; notes?: string | null; roleAssignments?: { roleId: string; to: Target }[]; defaultTo?: Target | null; taskPolicy?: 'with_role' | 'default' | 'none'; approverMembershipId?: string | null };
/** Offboards a person: report → access revoked → records preserved → work handed over as far as the plan goes; the rest stays visible as pending handover items. */
export async function executeExit(ctx: Ctx, membershipId: string, inp: ExitInput) {
  needs(ctx, ['members.delete', 'handover.create']); const m = await assertLeaver(ctx, membershipId); const subject = { membershipId }; const policy = inp.taskPolicy ?? 'with_role';
  const [u] = await ctx.db.select({ n: S.users.name }).from(S.users).where(eq(S.users.id, m.userId));
  // resolve every target BEFORE changing anything, so a bad choice fails cleanly
  const byRole = new Map<string, Resolved>(); for (const ra of inp.roleAssignments ?? []) byRole.set(ra.roleId, await resolveTarget(ctx.db, ctx.companyId, ra.to, subject));
  const fallback = inp.defaultTo ? await resolveTarget(ctx.db, ctx.companyId, inp.defaultTo, subject) : null;
  const approver = inp.approverMembershipId ? await resolveTarget(ctx.db, ctx.companyId, { membershipId: inp.approverMembershipId }, subject) : null;
  const all = [...byRole.values(), ...(fallback ? [fallback] : [])];
  if (all.length) needs(ctx, ['roles.assign', 'tasks.assign']); if (all.some((x) => x.kind === 'ai')) needs(ctx, ['agents.assign']);
  const report = await buildHandoverReport(ctx, subject);   // built before the transaction: the embedded database serialises queries, so nothing outside the transaction may run inside it
  const out = await ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db;
    const ho = await createHandover(tx, ctx, 'employee_exit', subject, u.n, report, inp);
    const owned = new Set(report.roles.filter((r) => r.isOwner).map((r) => r.roleId));
    // 1 · revoke access, keep every record
    await endAssignmentsTx(tx, ctx.companyId, { membershipId });
    await tx.delete(S.membershipPermissions).where(and(eq(S.membershipPermissions.companyId, ctx.companyId), eq(S.membershipPermissions.membershipId, membershipId)));
    await tx.update(S.companyMemberships).set({ status: 'removed', removedAt: new Date() }).where(eq(S.companyMemberships.id, membershipId));
    await tx.update(S.employees).set({ status: 'inactive', deactivatedAt: new Date(), deactivatedBy: ctx.user.id, updatedAt: new Date() }).where(and(eq(S.employees.companyId, ctx.companyId), eq(S.employees.membershipId, membershipId)));
    await tx.update(S.reportGrants).set({ revokedAt: new Date() }).where(and(eq(S.reportGrants.companyId, ctx.companyId), eq(S.reportGrants.membershipId, membershipId), isNull(S.reportGrants.revokedAt)));
    await tx.update(S.knowledgeAccess).set({ revokedAt: new Date() }).where(and(eq(S.knowledgeAccess.companyId, ctx.companyId), eq(S.knowledgeAccess.scopeType, 'member'), eq(S.knowledgeAccess.scopeId, membershipId), isNull(S.knowledgeAccess.revokedAt)));
    const access = ['Account deactivated and sign-in revoked', `Access level (${report.access.accessLevel}), ${report.access.directPermissions} direct permission(s) and role permissions removed`, 'Custom report access and document grants revoked', 'Work records, comments, documents and decisions are kept'];
    await tx.update(S.roleTransitions).set({ accessChanges: access }).where(and(eq(S.roleTransitions.companyId, ctx.companyId), eq(S.roleTransitions.handoverId, ho.id)));
    // 2 · roles
    for (const r of report.roles) { const to = byRole.get(r.roleId) ?? fallback; if (to) { await moveRole(tx, ctx, ho.id, r.roleId, to, { wasOwner: owned.has(r.roleId), approverName: approver?.name }); await markItem(tx, ctx, ho.id, { kind: 'role', refId: r.roleId }, to, 'assigned'); await notifyTarget(tx, ctx, to, `You now hold the role ${r.name}`, `/c/${ctx.companyId}/roles/${r.roleId}`, `ho-role:${r.roleId}:${ho.id}`); } }
    // 3 · tasks and recurring work
    if (policy !== 'none') await moveTasks(tx, ctx, ho.id, subject, (task) => { const viaRole = policy === 'with_role' && task.roleId ? byRole.get(task.roleId) ?? null : null; const c = viaRole ?? fallback; return c && c.kind === 'ai' && !aiEligibleTask(task) ? approver ?? (fallback && fallback.kind === 'human' ? fallback : null) : c; });
    // 4 · approvals, projects, documents (people only; an approver alone does not receive projects or documents)
    const humanFallback = fallback?.kind === 'human' ? fallback : null; const lead = approver ?? humanFallback;
    if (lead) await markItem(tx, ctx, ho.id, { kind: 'approval' }, lead, 'assigned', 'Approvals route to this person');
    if (humanFallback) {
      if (ctx.can('projects.assign')) { await tx.update(S.projects).set({ ownerMembershipId: humanFallback.membershipId, updatedAt: new Date() }).where(and(eq(S.projects.companyId, ctx.companyId), eq(S.projects.ownerMembershipId, membershipId), isNull(S.projects.archivedAt))); await markItem(tx, ctx, ho.id, { kind: 'project' }, humanFallback, 'assigned'); }
      await tx.update(S.knowledgeDocuments).set({ ownerMembershipId: humanFallback.membershipId }).where(and(eq(S.knowledgeDocuments.companyId, ctx.companyId), eq(S.knowledgeDocuments.ownerMembershipId, membershipId), isNull(S.knowledgeDocuments.archivedAt))); await markItem(tx, ctx, ho.id, { kind: 'document' }, humanFallback, 'assigned');
    }
    await audit(tx, ctx.companyId, ctx.user.id, 'employee.exit', 'employee', membershipId, { name: u.n, handoverId: ho.id, roles: report.counts.roles, openTasks: report.counts.openTasks });
    await audit(tx, ctx.companyId, ctx.user.id, 'handover.started', 'handover', ho.id, { subject: u.n, reason: 'employee_exit' });
    await notify(tx, ctx.companyId, await ownerUserIds(tx, ctx.companyId), { kind: 'handover', title: `Handover started for ${u.n}`, link: `/c/${ctx.companyId}/transitions`, dedupeKey: `ho:${ho.id}` });
    return { handoverId: ho.id, ...(await refreshHandover(tx, ctx.companyId, ho.id)) };
  });
  await refreshOnboarding(ctx, [...byRole.values(), fallback, approver]);
  return out;
}

/** AI-to-human: the human becomes the owner; the AI may stay as an assistant with reduced autonomy. Configuration, history, KPIs and knowledge access are preserved. */
export async function aiToHuman(ctx: Ctx, inp: { agentId: string; toMembershipId: string; roleIds?: string[]; keepAsAssistant?: boolean; assistantAutonomy?: number; transferTasks?: boolean; effectiveDate?: string | null; notes?: string | null }) {
  needs(ctx, ['handover.create', 'agents.assign', 'roles.assign']); const keep = inp.keepAsAssistant ?? true; if (inp.transferTasks ?? true) needs(ctx, ['tasks.assign']); if (keep) needs(ctx, ['agents.configure']);
  const [ag] = await ctx.db.select().from(S.aiAgents).where(and(eq(S.aiAgents.companyId, ctx.companyId), eq(S.aiAgents.id, inp.agentId), isNull(S.aiAgents.archivedAt))); if (!ag) throw notFound('AI employee not found');
  const to = await resolveTarget(ctx.db, ctx.companyId, { membershipId: inp.toMembershipId }, { agentId: inp.agentId }); if (to.kind !== 'human') throw badRequest('Choose a person');
  const subject = { agentId: inp.agentId };
  const report = await buildHandoverReport(ctx, subject);
  const out = await ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db;
    const roles = report.roles.filter((r) => !inp.roleIds || inp.roleIds.includes(r.roleId)); if (!roles.length) throw badRequest('This AI employee holds no role to hand over');
    report.roles = roles; const ho = await createHandover(tx, ctx, 'ai_to_human', subject, ag.name, report, inp);
    const level = Math.max(1, Math.min(4, inp.assistantAutonomy ?? 2));
    for (const r of roles) {
      await moveRole(tx, ctx, ho.id, r.roleId, to, { wasOwner: true });
      const extra: string[] = [];
      if (!keep) { await endAssignmentsTx(tx, ctx.companyId, { agentId: inp.agentId, roleId: r.roleId }); extra.push(`${ag.name} (AI) was removed from the role`); } else extra.push(`${ag.name} (AI) stays as an assistant to ${to.name}`);
      await tx.update(S.roleTransitions).set({ ...(keep ? { assistantAgentId: inp.agentId } : {}), accessChanges: sql`${S.roleTransitions.accessChanges} || ${JSON.stringify(extra)}::jsonb` }).where(and(eq(S.roleTransitions.handoverId, ho.id), eq(S.roleTransitions.roleId, r.roleId)));
      await markItem(tx, ctx, ho.id, { kind: 'role', refId: r.roleId }, to, 'done');
    }
    if (keep) {
      const [cfg] = await tx.select().from(S.agentConfigurations).where(eq(S.agentConfigurations.agentId, inp.agentId)); const newLevel = Math.min(cfg.autonomyLevel, level);
      await tx.update(S.agentConfigurations).set({ autonomyLevel: newLevel, version: cfg.version + 1, updatedBy: ctx.user.id, updatedAt: new Date() }).where(eq(S.agentConfigurations.agentId, inp.agentId));
      await tx.update(S.aiAgents).set({ managerMembershipId: to.membershipId, updatedAt: new Date() }).where(eq(S.aiAgents.id, inp.agentId));
      await tx.update(S.roleTransitions).set({ accessChanges: sql`${S.roleTransitions.accessChanges} || ${JSON.stringify([`AI autonomy is now Level ${newLevel} and its accountable manager is ${to.name}`])}::jsonb` }).where(eq(S.roleTransitions.handoverId, ho.id));
    }
    const roleSet = new Set(roles.map((r) => r.roleId));
    if (inp.transferTasks ?? true) await moveTasks(tx, ctx, ho.id, subject, (task) => (!task.roleId || roleSet.has(task.roleId) ? to : null));
    // knowledge the AI was explicitly given stays available to the person who now owns the work
    const grants = await tx.select().from(S.knowledgeAccess).where(and(eq(S.knowledgeAccess.companyId, ctx.companyId), eq(S.knowledgeAccess.scopeType, 'agent'), eq(S.knowledgeAccess.scopeId, inp.agentId), isNull(S.knowledgeAccess.revokedAt)));
    for (const g of grants) await tx.insert(S.knowledgeAccess).values({ companyId: ctx.companyId, documentId: g.documentId, scopeType: 'member', scopeId: to.membershipId, grantedBy: ctx.user.id }).onConflictDoNothing();
    await audit(tx, ctx.companyId, ctx.user.id, 'transition.ai_to_human', 'agent', inp.agentId, { name: ag.name, to: to.name, keepAsAssistant: keep, handoverId: ho.id, roles: roles.length });
    await notifyTarget(tx, ctx, to, `${ag.name} handed work over to you`, `/c/${ctx.companyId}/transitions`, `ho:${ho.id}`);
    return { handoverId: ho.id, ...(await refreshHandover(tx, ctx.companyId, ho.id)) };
  });
  await refreshOnboarding(ctx, [to]);
  return out;
}

/** Moves ownership of one role (person ↔ person, AI → person, person → AI), with an optional hand-off of the previous owner's open tasks for that role. */
export async function transferRole(ctx: Ctx, roleId: string, inp: { to: Target; previous?: 'remove' | 'keep'; transferTasks?: boolean; approverMembershipId?: string | null; notes?: string | null }) {
  needs(ctx, ['handover.create', 'roles.assign']); const [role] = await ctx.db.select().from(S.roles).where(and(eq(S.roles.companyId, ctx.companyId), eq(S.roles.id, roleId), isNull(S.roles.archivedAt))); if (!role) throw notFound('Role not found');
  const cur = (await ctx.db.select().from(S.roleAssignments).where(and(eq(S.roleAssignments.companyId, ctx.companyId), eq(S.roleAssignments.roleId, roleId), isNull(S.roleAssignments.endedAt), eq(S.roleAssignments.isPrimary, true))))[0] ?? null;
  const from: Subject = cur ? { membershipId: cur.membershipId, agentId: cur.agentId } : {};
  const to = await resolveTarget(ctx.db, ctx.companyId, inp.to, from); if (to.kind === 'ai') needs(ctx, ['agents.assign']); if (inp.transferTasks ?? true) needs(ctx, ['tasks.assign']);
  const approver = inp.approverMembershipId ? await resolveTarget(ctx.db, ctx.companyId, { membershipId: inp.approverMembershipId }, from) : null;
  const fromName = cur ? (cur.membershipId ? (await ctx.db.select({ n: S.users.name }).from(S.companyMemberships).innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId)).where(eq(S.companyMemberships.id, cur.membershipId)))[0]?.n : (await ctx.db.select({ n: S.aiAgents.name }).from(S.aiAgents).where(eq(S.aiAgents.id, cur.agentId!)))[0]?.n) ?? '' : 'Vacant role';
  const report: HandoverReportData = cur ? await buildHandoverReport(ctx, from) : ({ ...(await buildHandoverReport(ctx, { membershipId: ctx.membership.id })), roles: [], tasks: { current: [], pending: [] }, knowledgeGaps: [], approvals: [], projects: [], sops: [], recurring: [], deadlines: [], dependencies: [], deliverables: [], decisions: [], counts: { roles: 1, openTasks: 0, projects: 0, gaps: 0, approvals: 0 }, subject: { kind: 'human', id: '', name: fromName, jobTitle: null, department: null, manager: null, since: null } } as HandoverReportData);
  if (cur) report.roles = report.roles.filter((r) => r.roleId === roleId);
  const out = await ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db;
    const ho = await createHandover(tx, ctx, 'role_reassignment', from, fromName, report, { notes: inp.notes });
    if (!cur) await tx.insert(S.roleTransitions).values({ companyId: ctx.companyId, handoverId: ho.id, roleId, fromKind: 'none', accessChanges: [] });
    await moveRole(tx, ctx, ho.id, roleId, to, { wasOwner: true, approverName: approver?.name });
    const extra: string[] = [];
    if (cur && (inp.previous ?? 'remove') === 'remove') { await endAssignmentsTx(tx, ctx.companyId, { assignmentId: cur.id }); extra.push(`${fromName} was removed from the role`); await setOwnerTx(tx, ctx.companyId, roleId, (await tx.select().from(S.roleAssignments).where(and(eq(S.roleAssignments.roleId, roleId), isNull(S.roleAssignments.endedAt), to.kind === 'human' ? eq(S.roleAssignments.membershipId, to.membershipId) : eq(S.roleAssignments.agentId, to.agentId))))[0].id); }
    else if (cur) extra.push(`${fromName} stays on the role as a team member`);
    if (extra.length) await tx.update(S.roleTransitions).set({ accessChanges: sql`${S.roleTransitions.accessChanges} || ${JSON.stringify(extra)}::jsonb` }).where(and(eq(S.roleTransitions.handoverId, ho.id), eq(S.roleTransitions.roleId, roleId)));
    if (cur && (inp.transferTasks ?? true)) await moveTasks(tx, ctx, ho.id, from, (task) => (task.roleId === roleId ? (to.kind === 'ai' && !aiEligibleTask(task) ? approver : to) : null));
    await markItem(tx, ctx, ho.id, { kind: 'role', refId: roleId }, to, 'assigned');
    await audit(tx, ctx.companyId, ctx.user.id, 'handover.started', 'handover', ho.id, { subject: fromName, reason: 'role_reassignment' });
    await notifyTarget(tx, ctx, to, `You now own the role ${role.name}`, `/c/${ctx.companyId}/roles/${roleId}`, `ho:${ho.id}`);
    return { handoverId: ho.id, ...(await refreshHandover(tx, ctx.companyId, ho.id)) };
  });
  await refreshOnboarding(ctx, [to]);
  return out;
}

// ───────────── working the handover ─────────────
/** Re-evaluates automatic items (documentation gaps) and completes the handover when nothing is pending. */
export async function refreshHandover(db: Db, companyId: string, id: string) {
  const gaps = await db.select().from(S.handoverItems).where(and(eq(S.handoverItems.companyId, companyId), eq(S.handoverItems.handoverId, id), eq(S.handoverItems.status, 'pending'), inArray(S.handoverItems.kind, ['gap_responsibility', 'gap_project'])));
  if (gaps.length) {
    const docs = await db.select().from(S.knowledgeDocuments).where(and(eq(S.knowledgeDocuments.companyId, companyId), isNull(S.knowledgeDocuments.archivedAt), eq(S.knowledgeDocuments.status, 'published')));
    for (const g of gaps) { const ok = g.kind === 'gap_responsibility' ? docs.some((d) => d.responsibilityId === g.refId) : docs.some((d) => d.projectId === g.refId && d.docType === 'project_doc'); if (ok) await db.update(S.handoverItems).set({ status: 'done', note: 'Documented', resolvedAt: new Date() }).where(eq(S.handoverItems.id, g.id)); }
  }
  const items = await db.select().from(S.handoverItems).where(and(eq(S.handoverItems.companyId, companyId), eq(S.handoverItems.handoverId, id)));
  const pending = items.filter((i) => i.status === 'pending').length;
  const [h] = await db.select().from(S.handovers).where(eq(S.handovers.id, id));
  if (h.status === 'in_progress' && pending === 0) { await db.update(S.handovers).set({ status: 'completed', completedAt: new Date() }).where(eq(S.handovers.id, id)); await db.update(S.roleTransitions).set({ status: 'completed', completedAt: new Date() }).where(and(eq(S.roleTransitions.handoverId, id), eq(S.roleTransitions.status, 'pending'))); }
  return { status: pending === 0 ? 'completed' : h.status, pending, total: items.length };
}

export async function assignItem(ctx: Ctx, handoverId: string, itemId: string | null, to: Target, opts: { kind?: string; includeTasks?: boolean; approverMembershipId?: string | null } = {}) {
  needs(ctx, ['handover.edit']); const [h] = await ctx.db.select().from(S.handovers).where(and(eq(S.handovers.companyId, ctx.companyId), eq(S.handovers.id, handoverId))); if (!h) throw notFound('Handover not found'); if (h.status !== 'in_progress') throw conflict('This handover is already completed');
  const subject = { membershipId: h.fromMembershipId, agentId: h.fromAgentId }; const target = await resolveTarget(ctx.db, ctx.companyId, to, subject); const approver = opts.approverMembershipId ? await resolveTarget(ctx.db, ctx.companyId, { membershipId: opts.approverMembershipId }, subject) : null;
  const found = await ctx.db.select().from(S.handoverItems).where(and(eq(S.handoverItems.companyId, ctx.companyId), eq(S.handoverItems.handoverId, handoverId), eq(S.handoverItems.status, 'pending'), itemId ? eq(S.handoverItems.id, itemId) : opts.kind ? eq(S.handoverItems.kind, opts.kind) : undefined));
  if (itemId && !found.length) throw notFound('Pending item not found'); if (itemId && found[0].kind.startsWith('gap_')) throw badRequest('Documentation gaps are resolved by writing the document');
  const items = found.filter((i) => !i.kind.startsWith('gap_'));
  if (target.kind === 'ai') needs(ctx, ['agents.assign']);
  const res = await ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db; const done: string[] = []; const skipped: string[] = [];
    for (const it of items) {
      if (it.kind === 'role') { needs(ctx, ['roles.assign']); const wasOwner = (h.report as any)?.roles?.find((r: any) => r.roleId === it.refId)?.isOwner;
        await moveRole(tx, ctx, handoverId, it.refId!, target, { wasOwner: !!wasOwner, approverName: approver?.name }); await markItem(tx, ctx, handoverId, { id: it.id }, target, 'assigned');
        if (opts.includeTasks ?? true) { needs(ctx, ['tasks.assign']); const rid = it.refId; await moveTasks(tx, ctx, handoverId, subject, (task) => (task.roleId === rid ? (target.kind === 'ai' && !aiEligibleTask(task) ? approver : target) : null)); }
      } else if (it.kind === 'task') { needs(ctx, ['tasks.assign']); const [task] = await tx.select().from(S.tasks).where(eq(S.tasks.id, it.refId!)); if (target.kind === 'ai' && !aiEligibleTask(task)) { skipped.push(it.title); continue; } await tx.update(S.tasks).set({ ...ownerCols(target), updatedAt: new Date() }).where(eq(S.tasks.id, it.refId!)); await tx.insert(S.taskActivity).values({ companyId: ctx.companyId, taskId: it.refId!, actorUserId: ctx.user.id, action: 'handover_reassigned', metadata: { handoverId } }); await markItem(tx, ctx, handoverId, { id: it.id }, target, 'assigned'); await notifyTarget(tx, ctx, target, `Task handed over to you: ${task.title}`, `/c/${ctx.companyId}/tasks?task=${task.id}`, `ho-task:${task.id}:${handoverId}`); }
      else if (it.kind === 'recurring') { needs(ctx, ['tasks.assign']); await tx.update(S.recurringTasks).set(ownerCols(target)).where(eq(S.recurringTasks.id, it.refId!)); await markItem(tx, ctx, handoverId, { id: it.id }, target, 'assigned'); }
      else if (it.kind === 'project' || it.kind === 'document') { if (target.kind !== 'human') { skipped.push(it.title); continue; } if (it.kind === 'project') { needs(ctx, ['projects.assign']); await tx.update(S.projects).set({ ownerMembershipId: target.membershipId, updatedAt: new Date() }).where(eq(S.projects.id, it.refId!)); } else await tx.update(S.knowledgeDocuments).set({ ownerMembershipId: target.membershipId }).where(eq(S.knowledgeDocuments.id, it.refId!)); await markItem(tx, ctx, handoverId, { id: it.id }, target, 'assigned'); }
      else if (it.kind === 'approval') { await markItem(tx, ctx, handoverId, { id: it.id }, target, 'assigned', 'Approvals route to this owner'); }
      done.push(it.title);
    }
    await audit(tx, ctx.companyId, ctx.user.id, 'handover.item_assigned', 'handover', handoverId, { count: done.length, skipped: skipped.length, to: target.name });
    const state = await refreshHandover(tx, ctx.companyId, handoverId);
    return { assigned: done.length, skipped, ...state };
  });
  await refreshOnboarding(ctx, [target]);
  return res;
}
export async function resolveItem(ctx: Ctx, handoverId: string, itemId: string, p: { status: 'done' | 'skipped'; note?: string | null }) {
  needs(ctx, ['handover.edit']); const [it] = await ctx.db.select().from(S.handoverItems).where(and(eq(S.handoverItems.companyId, ctx.companyId), eq(S.handoverItems.handoverId, handoverId), eq(S.handoverItems.id, itemId))); if (!it) throw notFound('Item not found'); if (it.status !== 'pending') throw conflict('Already resolved');
  if (p.status === 'skipped' && !p.note?.trim()) throw badRequest('Say why this item is being skipped');
  if (p.status === 'done' && it.kind.startsWith('gap_')) { const st = await refreshHandover(ctx.db, ctx.companyId, handoverId); const [again] = await ctx.db.select().from(S.handoverItems).where(eq(S.handoverItems.id, itemId)); if (again.status === 'pending') throw conflict('Write and publish the document first (or skip this item with a reason)'); return st; }
  await ctx.db.update(S.handoverItems).set({ status: p.status, note: p.note ?? null, resolvedBy: ctx.user.id, resolvedAt: new Date() }).where(eq(S.handoverItems.id, itemId));
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'handover.item_resolved', 'handover', handoverId, { item: it.title, status: p.status });
  return refreshHandover(ctx.db, ctx.companyId, handoverId);
}

// ───────────── dashboard ─────────────
async function ownerName(db: Db, a: { membershipId: string | null; agentId: string | null } | null) {
  if (!a) return null; if (a.membershipId) { const [r] = await db.select({ n: S.users.name }).from(S.companyMemberships).innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId)).where(eq(S.companyMemberships.id, a.membershipId)); return r ? { kind: 'human', name: r.n } : null; }
  if (!a.agentId) return null; const [r] = await db.select({ n: S.aiAgents.name }).from(S.aiAgents).where(eq(S.aiAgents.id, a.agentId)); return r ? { kind: 'ai', name: `◉ ${r.n}` } : null;
}
export async function listTransitions(ctx: Ctx, status?: string) {
  needs(ctx, ['handover.view']);
  const hs = await ctx.db.select().from(S.handovers).where(and(eq(S.handovers.companyId, ctx.companyId), status ? eq(S.handovers.status, status as 'in_progress') : undefined)).orderBy(sql`${S.handovers.createdAt} desc`).limit(100);
  const out = [];
  for (const h of hs) { if (h.status === 'in_progress') await refreshHandover(ctx.db, ctx.companyId, h.id); out.push(await summarize(ctx, h.id)); }
  return out;
}
async function summarize(ctx: Ctx, id: string) {
  const [h] = await ctx.db.select().from(S.handovers).where(and(eq(S.handovers.companyId, ctx.companyId), eq(S.handovers.id, id)));
  const [items, trs, assigns, roles] = await Promise.all([ctx.db.select().from(S.handoverItems).where(eq(S.handoverItems.handoverId, id)), ctx.db.select().from(S.roleTransitions).where(eq(S.roleTransitions.handoverId, id)), ctx.db.select().from(S.roleAssignments).where(and(eq(S.roleAssignments.companyId, ctx.companyId), isNull(S.roleAssignments.endedAt))), ctx.db.select({ id: S.roles.id, n: S.roles.name }).from(S.roles).where(eq(S.roles.companyId, ctx.companyId))]);
  const rn = new Map(roles.map((r) => [r.id, r.n])); const pend = items.filter((i) => i.status === 'pending');
  const rts = [];
  for (const t of trs) { const cur = assigns.find((a) => a.roleId === t.roleId && a.isPrimary) ?? null; const rp = pend.filter((i) => i.roleId === t.roleId);
    rts.push({ roleId: t.roleId, role: rn.get(t.roleId) ?? '', status: t.status, previousOwner: t.fromKind === 'none' ? null : await ownerName(ctx.db, { membershipId: t.fromMembershipId, agentId: t.fromAgentId }), newOwner: await ownerName(ctx.db, { membershipId: t.toMembershipId, agentId: t.toAgentId }), currentOwner: await ownerName(ctx.db, cur ? { membershipId: cur.membershipId, agentId: cur.agentId } : null), assistant: t.assistantAgentId ? await ownerName(ctx.db, { membershipId: null, agentId: t.assistantAgentId }) : null, pendingItems: rp.length, knowledgeGaps: rp.filter((i) => i.kind.startsWith('gap_')).length, accessChanges: t.accessChanges }); }
  const done = items.length - pend.length;
  return { id: h.id, reason: h.reason, subjectKind: h.subjectKind, subjectName: h.subjectName, status: h.status, effectiveDate: h.effectiveDate, createdAt: h.createdAt, completedAt: h.completedAt, notes: h.notes, progress: items.length ? Math.round((done / items.length) * 100) : 100, items: { total: items.length, pending: pend.length, assigned: items.filter((i) => i.status === 'assigned').length, done: items.filter((i) => i.status === 'done').length, skipped: items.filter((i) => i.status === 'skipped').length }, pendingByKind: pend.reduce<Record<string, number>>((m, i) => ({ ...m, [i.kind]: (m[i.kind] ?? 0) + 1 }), {}), knowledgeGaps: pend.filter((i) => i.kind.startsWith('gap_')).length, roles: rts, accessChanges: [...new Set(trs.flatMap((t) => t.accessChanges))] };
}
export async function getHandover(ctx: Ctx, id: string) {
  needs(ctx, ['handover.view']); const [h] = await ctx.db.select().from(S.handovers).where(and(eq(S.handovers.companyId, ctx.companyId), eq(S.handovers.id, id))); if (!h) throw notFound('Handover not found');
  if (h.status === 'in_progress') await refreshHandover(ctx.db, ctx.companyId, id);
  const items = await ctx.db.select().from(S.handoverItems).where(eq(S.handoverItems.handoverId, id)).orderBy(S.handoverItems.kind);
  const names = new Map<string, string>(); for (const i of items) { const k = i.toMembershipId ?? i.toAgentId; if (k && !names.has(k)) { const n = await ownerName(ctx.db, { membershipId: i.toMembershipId, agentId: i.toAgentId }); if (n) names.set(k, n.name); } }
  return { ...(await summarize(ctx, id)), report: h.report, items: items.map((i) => ({ id: i.id, kind: i.kind, refId: i.refId, roleId: i.roleId, title: i.title, detail: i.detail, status: i.status, note: i.note, assignedTo: names.get((i.toMembershipId ?? i.toAgentId) as string) ?? null, resolvedAt: i.resolvedAt })), canEdit: ctx.can('handover.edit') };
}
export async function exportHandover(ctx: Ctx, id: string) {
  needs(ctx, ['handover.view']); const [h] = await ctx.db.select().from(S.handovers).where(and(eq(S.handovers.companyId, ctx.companyId), eq(S.handovers.id, id))); if (!h) throw notFound('Handover not found');
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'handover.exported', 'handover', id, { subject: h.subjectName });
  return handoverToReport(h, h.report as unknown as HandoverReportData, ctx.user.name);
}
