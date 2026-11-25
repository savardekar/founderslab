import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { OPEN_STATUSES } from '@/lib/constants';
import { forbidden, notFound } from '@/lib/errors';
import { loadCtx, type Ctx } from '../authz';
import { computeKpi } from './kpis';
import { listDocuments } from './knowledge';
import { resolveWindow, today } from './metrics';
import { kpiAllowed, loadOps, reportScope } from './scope';

const S = schema;
type Item = { id: string; title: string; done: boolean; kind?: string; link?: string };

async function loadTarget(db: Db, companyId: string, membershipId: string) {
  const [m] = await db.select({ m: S.companyMemberships, u: S.users }).from(S.companyMemberships).innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId)).where(and(eq(S.companyMemberships.companyId, companyId), eq(S.companyMemberships.id, membershipId)));
  if (!m || m.m.status === 'removed') throw notFound('Employee not found');
  const ctxT = m.m.status === 'active' ? await loadCtx(db, { id: m.u.id, email: m.u.email, name: m.u.name }, companyId) : null;
  return { m: m.m, u: m.u, ctxT };
}

/** Everything a new (or newly assigned) employee needs: role, responsibilities, KPI targets, the knowledge THEY may read, open tasks, access. */
async function build(db: Db, companyId: string, membershipId: string) {
  const { m, u, ctxT } = await loadTarget(db, companyId, membershipId);
  const ops = await loadOps(db, companyId); const [emp] = await db.select().from(S.employees).where(and(eq(S.employees.companyId, companyId), eq(S.employees.membershipId, membershipId)));
  const roleIds = ops.assigns.filter((a) => a.membershipId === membershipId).map((a) => a.roleId); const roles = roleIds.map((id) => ops.roles.find((r) => r.id === id)!).filter(Boolean);
  const sc = ctxT ? await reportScope(ctxT, ops) : null; const w = resolveWindow('monthly');
  const roleRows = roles.map((r) => ({ id: r.id, name: r.name, description: r.description, department: ops.depts.find((d) => d.id === r.departmentId)?.name ?? null, isOwner: ops.assigns.some((a) => a.roleId === r.id && a.membershipId === membershipId && a.isPrimary), reportsTo: r.reportsToRoleId ? ops.roles.find((x) => x.id === r.reportsToRoleId)?.name ?? null : null,
    responsibilities: ops.resp.filter((x) => x.roleId === r.id).map((x) => ({ id: x.id, title: x.title, description: x.description, expectedOutcome: x.expectedOutcome, priority: x.priority, frequency: x.frequency, requiresApproval: x.requiresApproval })),
    rules: [] as { kind: string; text: string }[], kpis: ops.kpis.filter((k) => k.roleId === r.id && sc && kpiAllowed(sc, k)).map((k) => { const c = computeKpi(ops, k, w); return { id: k.id, name: k.name, target: c.target, unit: k.unit, direction: k.direction, period: k.period, reportingFrequency: k.reportingFrequency, actual: c.actual, status: c.status }; }) }));
  if (roleIds.length) { const rules = await db.select().from(S.roleRules).where(and(eq(S.roleRules.companyId, companyId), inArray(S.roleRules.roleId, roleIds), isNull(S.roleRules.archivedAt))); roleRows.forEach((r) => (r.rules = rules.filter((x) => x.roleId === r.id).map((x) => ({ kind: x.kind, text: x.text })))); }
  const respIds = new Set(roleRows.flatMap((r) => r.responsibilities.map((x) => x.id))); const deptId = emp?.departmentId ?? null;
  const docs = ctxT ? (await listDocuments(ctxT, { status: 'published' })) : [];
  const ranked = docs.map((d) => ({ d, why: d.roleId && roleIds.includes(d.roleId) ? 'For your role' : d.responsibilityId && respIds.has(d.responsibilityId) ? 'Covers one of your responsibilities' : d.departmentId && d.departmentId === deptId ? 'Your department' : ['policy', 'goals', 'business_plan', 'strategy', 'sop'].includes(d.docType) && !d.roleId && !d.departmentId ? 'Company essentials' : null, rank: d.roleId && roleIds.includes(d.roleId) ? 0 : d.responsibilityId && respIds.has(d.responsibilityId) ? 1 : d.departmentId && d.departmentId === deptId ? 2 : 3 })).filter((x) => x.why).sort((a, b) => a.rank - b.rank).slice(0, 12).map((x) => ({ id: x.d.id, title: x.d.title, docType: x.d.docType, version: x.d.version, why: x.why! }));
  const tasks = ops.tasks.filter((t) => t.ownerMembershipId === membershipId && (OPEN_STATUSES as string[]).includes(t.status));
  const handed = tasks.length ? new Set((await db.select({ t: S.taskActivity.taskId }).from(S.taskActivity).where(and(eq(S.taskActivity.companyId, companyId), inArray(S.taskActivity.taskId, tasks.map((t) => t.id)), eq(S.taskActivity.action, 'handover_reassigned')))).map((x) => x.t)) : new Set<string>();
  const direct = await db.select({ k: S.membershipPermissions.permissionKey }).from(S.membershipPermissions).where(and(eq(S.membershipPermissions.companyId, companyId), eq(S.membershipPermissions.membershipId, membershipId)));
  const rp = roleIds.length ? await db.select({ r: S.rolePermissions.roleId, k: S.rolePermissions.permissionKey, s: S.rolePermissions.scope }).from(S.rolePermissions).where(and(eq(S.rolePermissions.companyId, companyId), inArray(S.rolePermissions.roleId, roleIds))) : [];
  const mgr = emp?.managerMembershipId ? ops.members.find((x) => x.id === emp.managerMembershipId)?.name ?? null : null;
  return {
    employee: { membershipId, name: u.name, jobTitle: m.jobTitle, status: emp?.status ?? 'active', startDate: emp?.startDate ?? null }, department: deptId ? ops.depts.find((d) => d.id === deptId)?.name ?? null : null, manager: mgr,
    roles: roleRows, knowledge: ranked, tasks: tasks.sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')).map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, dueDate: t.dueDate, handedOver: handed.has(t.id), overdue: !!t.dueDate && t.dueDate < today() })),
    access: { accessLevel: m.accessLevel, directPermissions: direct.map((d) => d.k).sort(), byRole: roleRows.map((r) => ({ role: r.name, permissions: rp.filter((x) => x.r === r.id).map((x) => `${x.k}${x.s !== 'company' ? ` (${x.s})` : ''}`).sort() })), note: 'Permissions come from your access level, your roles and any direct grants. Reporting lines never grant access.' },
    checklist: (emp?.onboarding ?? []) as Item[],
  };
}

export async function onboardingPackage(ctx: Ctx, membershipId: string) {
  if (membershipId !== ctx.membership.id && !ctx.can('members.view')) throw forbidden();
  const p = await build(ctx.db, ctx.companyId, membershipId); const done = p.checklist.filter((i) => i.done).length;
  return { ...p, progress: { done, total: p.checklist.length, percent: p.checklist.length ? Math.round((done / p.checklist.length) * 100) : 100 } };
}

/** Rebuilds the checklist from the person's current roles, knowledge, KPIs and tasks, keeping everything they already ticked. */
export async function generateOnboardingChecklist(db: Db, companyId: string, membershipId: string) {
  const p = await build(db, companyId, membershipId); const base = `/c/${companyId}`;
  const items: Item[] = [{ id: 'profile', title: 'Complete your profile', done: false, kind: 'profile', link: '/profile' }, { id: 'objectives', title: 'Read the company objectives', done: false, kind: 'company', link: `${base}/dashboard` }];
  if (p.manager) items.push({ id: 'manager', title: `Meet your manager, ${p.manager}`, done: false, kind: 'people' });
  for (const r of p.roles) { items.push({ id: `role:${r.id}:responsibilities`, title: `Review your responsibilities as ${r.name}`, done: false, kind: 'role', link: `${base}/dashboard` }); if (r.kpis.length) items.push({ id: `role:${r.id}:kpis`, title: `Review the KPI targets for ${r.name}`, done: false, kind: 'kpi', link: `${base}/performance` }); }
  for (const d of p.knowledge.slice(0, 6)) items.push({ id: `doc:${d.id}`, title: `Read: ${d.title}`, done: false, kind: 'knowledge', link: `${base}/knowledge?doc=${d.id}` });
  if (p.tasks.length) items.push({ id: 'tasks', title: `Review your ${p.tasks.length} open task(s)${p.tasks.some((t) => t.handedOver) ? ' (some were handed over to you)' : ''}`, done: false, kind: 'tasks', link: `${base}/tasks` });
  const [emp] = await db.select().from(S.employees).where(and(eq(S.employees.companyId, companyId), eq(S.employees.membershipId, membershipId)));
  const had = new Map((emp?.onboarding ?? []).map((i) => [i.id, i])); const merged = items.map((i) => ({ ...i, done: had.get(i.id)?.done ?? false }));
  for (const old of emp?.onboarding ?? []) if (old.done && !merged.some((i) => i.id === old.id)) merged.push(old);   // never lose completed steps
  await db.update(S.employees).set({ onboarding: merged, updatedAt: new Date() }).where(and(eq(S.employees.companyId, companyId), eq(S.employees.membershipId, membershipId)));
  return merged;
}
export async function regenerateOnboarding(ctx: Ctx, membershipId: string) {
  ctx.require('members.edit'); await generateOnboardingChecklist(ctx.db, ctx.companyId, membershipId); return onboardingPackage(ctx, membershipId);
}
/** When work is assigned to someone who has not finished onboarding, their checklist picks it up. */
export async function touchOnboarding(db: Db, companyId: string, membershipId: string | null | undefined) {
  if (!membershipId) return;
  try { const [e] = await db.select({ o: S.employees.onboarding }).from(S.employees).where(and(eq(S.employees.companyId, companyId), eq(S.employees.membershipId, membershipId))); if (e && e.o.some((i) => !i.done)) await generateOnboardingChecklist(db, companyId, membershipId); } catch { /* non-critical */ }
}
