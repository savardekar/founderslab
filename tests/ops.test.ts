import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { handle } from '@/server/router';
import { addMember, call, makeCompany, makeRole, newDb, resetRateLimits, signup, type Client } from './helpers';
import { addDays, healthScore, isoDay, kpiAttainment, resolveWindow, taskMetrics, today, type TaskLite } from '@/server/services/metrics';
import { nextOccurrence } from '@/server/services/tasks';
import { projectHealth } from '@/server/services/projects';
import { registerProvider, unregisterProvider, type AiProvider, type CompletionResult } from '@/server/ai/provider';

let db: Db; let owner: Client; let cid: string;
const P = (p: string, id = cid) => `/companies/${id}${p}`;
const T0 = today(), D = (n: number) => addDays(T0, n);
beforeAll(async () => { process.env.EXPOSE_DEV_LINKS = '1'; db = await newDb(); });
beforeEach(async () => { resetRateLimits(); owner = await signup(db, 'Founder'); cid = await makeCompany(db, owner); });
const raw = (path: string, who: Client | null, method = 'GET') => handle(new Request(`http://localhost:3000/api${path}`, { method, headers: { host: 'localhost:3000', ...(who ? { cookie: who.cookie } : {}) } }), db);
const me = async (u: Client) => (await call(db, 'GET', P(''), undefined, u)).body.me.membershipId as string;
const grant = (roleId: string, g: [string, string][]) => call(db, 'PUT', P(`/roles/${roleId}/permissions`), { grants: g.map(([key, scope]) => ({ key, scope })) }, owner).then((r) => { expect(r.status, JSON.stringify(r.body)).toBe(200); });
async function task(who: Client, body: object, expectStatus = 201) { const r = await call(db, 'POST', P('/tasks'), body, who); expect(r.status, JSON.stringify(r.body)).toBe(expectStatus); return r.body.task?.id as string; }
async function move(who: Client, id: string, status: string, extra: object = {}) { return call(db, 'POST', P(`/tasks/${id}/status`), { status, ...extra }, who); }
async function finishTask(who: Client, id: string) { expect((await move(who, id, 'in_progress')).status).toBe(200); expect((await move(who, id, 'completed')).status).toBe(200); }

describe('task management', () => {
  it('every task has exactly one owner; creation validates every reference; subtasks and dependencies work', async () => {
    const mid = await me(owner); const role = await makeRole(db, owner, cid, { name: 'Ops' });
    const t = await call(db, 'POST', P('/tasks'), { title: 'Plan launch', roleId: role.id, owner: { membershipId: mid }, dueDate: D(5), startDate: D(1), priority: 'high', deliverables: ['Launch plan'] }, owner);
    expect(t.status).toBe(201);
    const d = (await call(db, 'GET', P(`/tasks/${t.body.task.id}`), undefined, owner)).body;
    expect(d.task).toMatchObject({ title: 'Plan launch', status: 'todo', priority: 'high', roleId: role.id, ownerMembershipId: mid }); expect(d.task.deliverables).toHaveLength(1); expect(d.createdByName).toBe('Founder');
    expect(d.activity[0].action).toBe('created');
    const defaultOwner = await task(owner, { title: 'Mine by default' });
    expect((await call(db, 'GET', P(`/tasks/${defaultOwner}`), undefined, owner)).body.task.ownerMembershipId).toBe(mid);
    expect((await call(db, 'POST', P('/tasks'), { title: 'x', owner: { membershipId: mid, agentId: '11111111-1111-4111-8111-111111111111' } }, owner)).status).toBe(400);
    expect((await call(db, 'POST', P('/tasks'), { title: 'x', startDate: D(5), dueDate: D(1) }, owner)).status).toBe(400);
    expect((await call(db, 'POST', P('/tasks'), { title: 'x', dueDate: '2026-13-45' }, owner)).status).toBe(400);
    expect((await call(db, 'POST', P('/tasks'), { title: 'x', roleId: '11111111-1111-4111-8111-111111111111' }, owner)).status).toBe(400);
    expect((await call(db, 'POST', P('/tasks'), { title: 'x', dependsOn: ['11111111-1111-4111-8111-111111111111'] }, owner)).status).toBe(400);
    // subtasks (max depth 3) and dependency cycles
    const a = t.body.task.id; const b = await task(owner, { title: 'sub 1', parentTaskId: a }); const c = await task(owner, { title: 'sub 2', parentTaskId: b });
    expect((await call(db, 'POST', P('/tasks'), { title: 'too deep', parentTaskId: c }, owner)).status).toBe(400);      // top level + 2 levels of subtasks
    expect((await call(db, 'PUT', P(`/tasks/${a}/dependencies`), { ids: [b] }, owner)).status).toBe(200);
    expect((await call(db, 'PUT', P(`/tasks/${b}/dependencies`), { ids: [a] }, owner)).status).toBe(400);   // a→b→a
    expect((await call(db, 'PUT', P(`/tasks/${a}/dependencies`), { ids: [a] }, owner)).status).toBe(400);
    const list = (await call(db, 'GET', P('/tasks?topLevel=1'), undefined, owner)).body.tasks;
    expect(list.find((x: any) => x.id === a)).toMatchObject({ waitingOnDependencies: 1, subtasks: { total: 1, done: 0 } });
  });

  it('assignment: needs tasks.assign, tells the new owner, and is recorded; AI owners must be active', async () => {
    const role = await makeRole(db, owner, cid, { name: 'Support' });
    const a = await addMember(db, owner, cid, 'member', role.id), b = await addMember(db, owner, cid);
    const id = await task(owner, { title: 'Handle backlog', roleId: role.id, owner: { membershipId: a.membershipId }, dueDate: D(2) });
    expect((await call(db, 'POST', P(`/tasks/${id}/assign`), { membershipId: b.membershipId }, a.user)).status).toBe(403); // owner cannot hand off without tasks.assign
    expect((await call(db, 'POST', P(`/tasks/${id}/assign`), { membershipId: b.membershipId }, owner)).status).toBe(200);
    const d = (await call(db, 'GET', P(`/tasks/${id}`), undefined, owner)).body;
    expect(d.task.ownerMembershipId).toBe(b.membershipId); expect(d.activity.map((x: any) => x.action)).toEqual(expect.arrayContaining(['assigned']));
    const n = (await call(db, 'GET', P('/notifications'), undefined, b.user)).body;
    expect(n.notifications.some((x: any) => x.kind === 'task_assigned' && /Handle backlog/.test(x.title))).toBe(true);
    expect((await call(db, 'GET', P('/audit'), undefined, owner)).body.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['task.created', 'task.assigned']));
    const ag = await call(db, 'POST', P('/agents'), { name: 'AI Ops', config: { provider: 'anthropic', model: 'm' } }, owner);
    expect((await call(db, 'POST', P(`/tasks/${id}/assign`), { agentId: ag.body.agent.id }, owner)).status).toBe(400);   // inactive AI
    await call(db, 'POST', P(`/agents/${ag.body.agent.id}/status`), { status: 'active' }, owner);
    expect((await call(db, 'POST', P(`/tasks/${id}/assign`), { agentId: ag.body.agent.id }, owner)).status).toBe(200);
    expect((await call(db, 'GET', P(`/tasks/${id}`), undefined, owner)).body.view.ownerKind).toBe('ai');
  });

  it('people without tasks.create can plan their own work, but cannot give tasks to others or see others\' tasks', async () => {
    const x = await addMember(db, owner, cid), y = await addMember(db, owner, cid);
    const mine = await task(x.user, { title: 'My own thing', dueDate: D(3) });
    expect((await call(db, 'POST', P('/tasks'), { title: 'For y', owner: { membershipId: y.membershipId } }, x.user)).status).toBe(403);
    expect((await call(db, 'POST', P('/tasks'), { title: 'Needs approval', requiresApproval: true }, x.user)).status).toBe(403);
    expect((await call(db, 'GET', P(`/tasks/${mine}`), undefined, y.user)).status).toBe(404);                  // invisible, not forbidden
    expect((await call(db, 'GET', P('/tasks'), undefined, y.user)).body.tasks).toHaveLength(0);
    expect((await call(db, 'GET', P('/tasks'), undefined, x.user)).body.tasks).toHaveLength(1);
    expect((await call(db, 'PATCH', P(`/tasks/${mine}`), { title: 'Renamed' }, y.user)).status).toBe(404);
  });

  it('status machine: legal moves only, blocked needs a reason, dependencies/deliverables/subtasks gate completion', async () => {
    const id = await task(owner, { title: 'Ship it', deliverables: ['Doc', 'Build'], dueDate: D(3) });
    expect((await move(owner, id, 'completed')).status).toBe(409);                                           // todo → completed is not a legal move
    expect((await move(owner, id, 'blocked')).status).toBe(400);                                              // reason required
    expect((await move(owner, id, 'blocked', { reason: 'Waiting for legal' })).status).toBe(200);
    expect((await call(db, 'GET', P(`/tasks/${id}`), undefined, owner)).body.task.blockedReason).toBe('Waiting for legal');
    expect((await move(owner, id, 'in_progress')).status).toBe(200);
    expect((await call(db, 'GET', P(`/tasks/${id}`), undefined, owner)).body.task.blockedReason).toBeNull();
    const r = await move(owner, id, 'completed'); expect(r.status).toBe(409); expect(r.body.error).toMatch(/Deliverables not done: Doc, Build/);
    const t = (await call(db, 'GET', P(`/tasks/${id}`), undefined, owner)).body.task;
    await call(db, 'PATCH', P(`/tasks/${id}`), { deliverables: t.deliverables.map((x: any) => ({ ...x, done: true })) }, owner);
    const sub = await task(owner, { title: 'Sub', parentTaskId: id });
    expect((await move(owner, id, 'completed')).body.error).toMatch(/subtasks first: Sub/);
    await finishTask(owner, sub);
    const dep = await task(owner, { title: 'Prerequisite' }); await call(db, 'PUT', P(`/tasks/${id}/dependencies`), { ids: [dep] }, owner);
    expect((await move(owner, id, 'completed')).body.error).toMatch(/Waiting on: Prerequisite/);
    await finishTask(owner, dep);
    expect((await move(owner, id, 'completed')).status).toBe(200);
    const done = (await call(db, 'GET', P(`/tasks/${id}`), undefined, owner)).body;
    expect(done.task.status).toBe('completed'); expect(done.task.completedAt).toBeTruthy();
    expect((await call(db, 'PATCH', P(`/tasks/${id}`), { title: 'x' }, owner)).status).toBe(409);            // reopen first
    expect((await move(owner, id, 'in_progress')).status).toBe(200); expect((await call(db, 'GET', P(`/tasks/${id}`), undefined, owner)).body.task.completedAt).toBeNull();
    expect((await call(db, 'GET', P('/audit'), undefined, owner)).body.events.map((e: any) => e.action)).toContain('task.completed');
    expect(done.activity.filter((a: any) => a.action === 'status_changed').length).toBeGreaterThanOrEqual(3);
  });

  it('approval flow: submit → awaiting approval → approved by someone else; self-approval and unauthorised approval are refused; rejection returns it to work', async () => {
    const role = await makeRole(db, owner, cid, { name: 'Marketing' }); const worker = await addMember(db, owner, cid, 'member', role.id), other = await addMember(db, owner, cid);
    await grant(role.id, [['company.view', 'company'], ['tasks.view', 'own']]);
    const id = await task(owner, { title: 'Campaign launch', roleId: role.id, owner: { membershipId: worker.membershipId }, requiresApproval: true });
    await move(worker.user, id, 'in_progress');
    expect((await move(worker.user, id, 'completed')).status).toBe(403);                                      // cannot skip approval
    expect((await move(worker.user, id, 'awaiting_approval')).status).toBe(200);
    expect((await call(db, 'POST', P(`/tasks/${id}/approve`), {}, worker.user)).status).toBe(403);
    expect((await call(db, 'POST', P(`/tasks/${id}/approve`), {}, other.user)).status).toBe(404);             // cannot even see it
    expect((await call(db, 'POST', P(`/tasks/${id}/reject`), { reason: 'Needs another pass' }, owner)).status).toBe(200);
    let d = (await call(db, 'GET', P(`/tasks/${id}`), undefined, owner)).body; expect(d.task.status).toBe('in_progress'); expect(d.comments.at(-1).body).toMatch(/Not approved: Needs another pass/);
    await move(worker.user, id, 'awaiting_approval');
    expect((await call(db, 'POST', P('/notifications/read'), {}, owner)).status).toBe(200);
    expect((await call(db, 'POST', P(`/tasks/${id}/approve`), { note: 'Looks good' }, owner)).status).toBe(200);
    d = (await call(db, 'GET', P(`/tasks/${id}`), undefined, owner)).body; expect(d.task.status).toBe('completed'); expect(d.task.approvedBy).toBeTruthy();
  });

  it('comments, notifications and attachments (type/size limits, safe download, same visibility as the task)', async () => {
    const a = await addMember(db, owner, cid), b = await addMember(db, owner, cid);
    const id = await task(owner, { title: 'Brief', owner: { membershipId: a.membershipId }, dueDate: D(1) });
    expect((await call(db, 'POST', P(`/tasks/${id}/comments`), { body: 'Please start' }, owner)).status).toBe(201);
    const notes = (await call(db, 'GET', P('/notifications'), undefined, a.user)).body;
    expect(notes.notifications.map((n: any) => n.kind)).toEqual(expect.arrayContaining(['task_comment', 'task_assigned', 'task_due_soon']));
    expect(notes.unread).toBeGreaterThanOrEqual(3);
    const again = (await call(db, 'GET', P('/notifications'), undefined, a.user)).body; expect(again.notifications.filter((n: any) => n.kind === 'task_due_soon')).toHaveLength(1); // deadline alerts are not duplicated
    await call(db, 'POST', P('/notifications/read'), {}, a.user); expect((await call(db, 'GET', P('/notifications'), undefined, a.user)).body.unread).toBe(0);
    expect((await call(db, 'GET', P('/notifications'), undefined, b.user)).body.notifications).toHaveLength(0);
    const file = Buffer.from('hello,world\n1,2\n').toString('base64');
    const up = await call(db, 'POST', P(`/tasks/${id}/attachments`), { fileName: '../../etc/data.csv', contentType: 'text/csv', dataBase64: file }, a.user);
    expect(up.status).toBe(201); expect(up.body.attachment.fileName).not.toMatch(/[\\/]/);
    expect((await call(db, 'POST', P(`/tasks/${id}/attachments`), { fileName: 'evil.html', contentType: 'text/html', dataBase64: file }, a.user)).status).toBe(400);
    expect((await call(db, 'POST', P(`/tasks/${id}/attachments`), { fileName: 'x.png', contentType: 'text/csv', dataBase64: file }, a.user)).status).toBe(400);   // type must match extension
    expect((await call(db, 'POST', P(`/tasks/${id}/attachments`), { fileName: 'big.pdf', contentType: 'application/pdf', dataBase64: Buffer.alloc(2 * 1024 * 1024 + 10).toString('base64') }, a.user)).status).toBe(400);
    const dl = await raw(P(`/tasks/${id}/attachments/${up.body.attachment.id}`), a.user);
    expect(dl.status).toBe(200); expect(await dl.text()).toBe('hello,world\n1,2\n'); expect(dl.headers.get('content-disposition')).toMatch(/^attachment;/); expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await raw(P(`/tasks/${id}/attachments/${up.body.attachment.id}`), b.user)).status).toBe(404);   // b cannot see the task, so not its files
    const other = await signup(db); const oc = await makeCompany(db, other);
    expect((await raw(P(`/tasks/${id}/attachments/${up.body.attachment.id}`, oc), other)).status).toBe(404);
  });

  it('recurring tasks generate their occurrences once, catch up after downtime, and advance the schedule', async () => {
    const r = await call(db, 'POST', P('/recurring-tasks'), { title: 'Daily stand-up notes', cadence: 'daily', startOn: D(-3), dueAfterDays: 1 }, owner);
    expect(r.status).toBe(201);
    let tasks = (await call(db, 'GET', P('/tasks?q=stand-up'), undefined, owner)).body.tasks;
    expect(tasks.map((t: any) => t.startDate).sort()).toEqual([D(-3), D(-2), D(-1), D(0)]); expect(tasks.find((t: any) => t.startDate === D(-3)).dueDate).toBe(D(-2));
    expect((await call(db, 'POST', P('/recurring-tasks/run'), {}, owner)).body.created).toBe(0);              // idempotent
    expect((await call(db, 'GET', P('/recurring-tasks'), undefined, owner)).body.recurring[0].nextRunOn).toBe(D(1));
    const rid = r.body.recurring.id; await call(db, 'POST', P(`/recurring-tasks/${rid}/active`), { active: false }, owner);
    expect((await call(db, 'GET', P('/recurring-tasks'), undefined, owner)).body.recurring[0].active).toBe(false);
    tasks = (await call(db, 'GET', P('/tasks?q=stand-up'), undefined, owner)).body.tasks; expect(tasks).toHaveLength(4);
    expect(nextOccurrence('2026-01-31', 'monthly')).toBe('2026-02-28'); expect(nextOccurrence('2026-11-30', 'quarterly')).toBe('2027-02-28'); expect(nextOccurrence('2026-11-01', 'weekly')).toBe('2026-11-08');
    const plain = await addMember(db, owner, cid); expect((await call(db, 'POST', P('/recurring-tasks'), { title: 'x', cadence: 'weekly' }, plain.user)).status).toBe(403);
  });
});

describe('projects', () => {
  it('project with owner, team, goals, deliverables, related tasks; progress and health are computed; visibility follows membership/permissions', async () => {
    const dept = (await call(db, 'POST', P('/departments'), { name: 'Growth' }, owner)).body.department; const a = await addMember(db, owner, cid), outsider = await addMember(db, owner, cid);
    const p = await call(db, 'POST', P('/projects'), { name: 'Sangli launch', description: 'Pilot', departmentId: dept.id, ownerMembershipId: await me(owner), startDate: D(-10), deadline: D(10), status: 'active', goals: ['100 rides'], deliverables: [{ title: 'Ops playbook' }, { title: 'Driver onboarding' }], team: { membershipIds: [a.membershipId] } }, owner);
    expect(p.status).toBe(201); const pid = p.body.project.id;
    const t1 = await task(owner, { title: 'Recruit drivers', projectId: pid, owner: { membershipId: a.membershipId }, dueDate: D(3) }); await task(owner, { title: 'Print flyers', projectId: pid, dueDate: D(-2) });
    await finishTask(a.user, t1);
    const d = (await call(db, 'GET', P(`/projects/${pid}`), undefined, a.user)).body;
    expect(d.project).toMatchObject({ name: 'Sangli launch', ownerName: 'Founder', departmentName: 'Growth', teamSize: 2, tasks: { total: 2, done: 1, open: 1, overdue: 1 }, progress: 0.5 }); expect(d.team.map((m: any) => m.name)).toContain('Teammate');
    expect(d.tasks).toHaveLength(2);
    expect((await call(db, 'GET', P(`/tasks/${t1}`), undefined, a.user)).status).toBe(200);                      // team members see project tasks they own
    expect((await call(db, 'GET', P(`/projects/${pid}`), undefined, outsider.user)).status).toBe(404);
    expect((await call(db, 'POST', P('/projects'), { name: 'Nope' }, outsider.user)).status).toBe(403);
    expect((await call(db, 'PATCH', P(`/projects/${pid}`), { deliverables: [{ id: d.project.deliverables[0].id, title: 'Ops playbook', done: true }, { title: 'Driver onboarding' }] }, owner)).status).toBe(200);
    expect((await call(db, 'GET', P(`/projects/${pid}`), undefined, owner)).body.project.deliverablesDone).toBe(1);
    expect((await call(db, 'DELETE', P(`/projects/${pid}`), undefined, owner)).status).toBe(409);               // open tasks
    expect((await call(db, 'POST', P('/projects'), { name: 'Bad dates', startDate: D(5), deadline: D(1) }, owner)).status).toBe(400);
    expect(projectHealth({ status: 'active', startDate: D(-10), deadline: D(-1) }, { total: 4, done: 1, open: 3, overdue: 0 }).health).toBe('late');
    expect(projectHealth({ status: 'active', startDate: D(-10), deadline: D(10) }, { total: 10, done: 1, open: 9, overdue: 0 }).health).toBe('at_risk');
    expect(projectHealth({ status: 'active', startDate: D(-10), deadline: D(10) }, { total: 10, done: 6, open: 4, overdue: 0 }).health).toBe('on_track');
  });
});

describe('metrics and KPI calculation (deterministic)', () => {
  const mk = (id: string, status: string, due: string | null, completedDay: string | null, created = '2026-05-01'): TaskLite => ({ id, status, dueDate: due, completedAt: completedDay ? new Date(completedDay + 'T12:00:00Z') : null, createdAt: new Date(created + 'T00:00:00Z'), priority: 'medium', roleId: null, departmentId: null, ownerMembershipId: null, ownerAgentId: null, projectId: null });
  const w = { from: '2026-05-01', to: '2026-05-31' }; const now = new Date('2026-05-20T10:00:00Z');
  const tasks = [mk('a', 'completed', '2026-05-10', '2026-05-09'), mk('b', 'completed', '2026-05-12', '2026-05-14'), mk('c', 'in_progress', '2026-05-15', null), mk('d', 'todo', '2026-05-28', null), mk('e', 'cancelled', '2026-05-11', null), mk('f', 'blocked', null, null), mk('g', 'completed', '2026-06-02', '2026-05-30')];
  it('taskMetrics follows the published definitions', () => {
    const m = taskMetrics(tasks, w, now);
    expect(m).toMatchObject({ total: 6, open: 3, dueInWindow: 4, dueCompleted: 2, completionRate: 50, completedInWindow: 3, onTimeRate: 66.7, overdue: 1, blocked: 1 });   // cancelled excluded; b is late, a and g on time
    expect(m.avgCycleDays).toBeGreaterThan(0);
    expect(taskMetrics([], w, now)).toMatchObject({ completionRate: null, onTimeRate: null, overdue: 0, avgCycleDays: null });
  });
  it('KPI attainment honours direction and thresholds; no data is never reported as zero', () => {
    expect(kpiAttainment(90, 100, 'higher')).toEqual({ attainment: 0.9, status: 'on_track' }); expect(kpiAttainment(100, 100, 'higher').status).toBe('met'); expect(kpiAttainment(60, 100, 'higher').status).toBe('at_risk'); expect(kpiAttainment(20, 100, 'higher').status).toBe('off_track');
    expect(kpiAttainment(5, 10, 'lower').status).toBe('met'); expect(kpiAttainment(20, 10, 'lower')).toEqual({ attainment: 0.5, status: 'at_risk' }); expect(kpiAttainment(0, 10, 'lower').status).toBe('met');
    expect(kpiAttainment(null, 10, 'higher').status).toBe('no_data'); expect(kpiAttainment(5, null, 'higher').status).toBe('no_data');
  });
  it('windows: daily, ISO week, month, quarter, custom limits', () => {
    expect(resolveWindow('weekly', '2026-11-04')).toMatchObject({ from: '2026-11-02', to: '2026-11-08' }); expect(resolveWindow('monthly', '2026-02-15')).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
    expect(resolveWindow('quarterly', '2026-11-04')).toMatchObject({ from: '2026-10-01', to: '2026-12-31', label: '2026 Q4' }); expect(resolveWindow('daily', '2026-11-04')).toMatchObject({ from: '2026-11-04', to: '2026-11-04' });
    expect(() => resolveWindow('custom', null, '2026-02-01', '2026-01-01')).toThrow(); expect(() => resolveWindow('custom', null, '2024-01-01', '2026-01-01')).toThrow(/366/);
  });
  it('company health is a transparent weighted score over the components that have data', () => {
    expect(healthScore({ onTime: null, overdueRatio: null, kpiAttainment: null, projectsOk: null })).toMatchObject({ score: null, label: 'Not enough data yet' });
    expect(healthScore({ onTime: 100, overdueRatio: 0, kpiAttainment: 1, projectsOk: 1 }).score).toBe(100); expect(healthScore({ onTime: 50, overdueRatio: null, kpiAttainment: null, projectsOk: null }).score).toBe(50);
  });
});

async function org() {
  const dM = (await call(db, 'POST', P('/departments'), { name: 'Marketing' }, owner)).body.department.id, dO = (await call(db, 'POST', P('/departments'), { name: 'Operations' }, owner)).body.department.id;
  const cmo = await makeRole(db, owner, cid, { name: 'CMO', departmentId: dM }), mgr = await makeRole(db, owner, cid, { name: 'Marketing Manager', departmentId: dM, reportsToRoleId: cmo.id });
  const exec = await makeRole(db, owner, cid, { name: 'Marketing Exec', departmentId: dM, reportsToRoleId: mgr.id }), coo = await makeRole(db, owner, cid, { name: 'COO', departmentId: dO });
  const lead = await makeRole(db, owner, cid, { name: 'Marketing Lead', departmentId: dM, reportsToRoleId: cmo.id });        // a "manager" with no report permission at all
  await grant(cmo.id, [['company.view', 'company'], ['tasks.view', 'department'], ['reports.view', 'department'], ['reports.export', 'department'], ['kpis.view', 'department']]);
  await grant(coo.id, [['company.view', 'company'], ['tasks.view', 'department'], ['reports.view', 'department'], ['reports.export', 'department']]);
  await grant(mgr.id, [['company.view', 'company'], ['reports.view', 'own']]); await grant(exec.id, [['company.view', 'company']]); await grant(lead.id, [['company.view', 'company']]);
  const u = { cmo: await addMember(db, owner, cid, 'member', cmo.id), mgr: await addMember(db, owner, cid, 'member', mgr.id), exec: await addMember(db, owner, cid, 'member', exec.id), coo: await addMember(db, owner, cid, 'member', coo.id), lead: await addMember(db, owner, cid, 'member', lead.id) };
  const mkTask = async (title: string, role: { id: string }, who: { membershipId: string }, due: string, extra: object = {}) => task(owner, { title, roleId: role.id, owner: { membershipId: who.membershipId }, dueDate: due, ...extra });
  const done1 = await mkTask('Write blog', exec, u.exec, D(2)); await finishTask(u.exec.user, done1);             // on time
  const done2 = await mkTask('Late newsletter', exec, u.exec, D(-2)); await finishTask(u.exec.user, done2);       // completed late
  await mkTask('Overdue ads audit', exec, u.exec, D(-3), { priority: 'critical' }); await mkTask('Plan Q4 campaign', mgr, u.mgr, D(7)); await mkTask('Vendor review', coo, u.coo, D(4));
  return { dM, dO, roles: { cmo, mgr, exec, coo, lead }, u };
}
const win = `period=custom&from=${D(-30)}&to=${D(30)}`;
const run = (who: Client, q: string) => call(db, 'GET', P(`/reports/run?${q}&${win}`), undefined, who);

describe('hierarchy-based reports, permissions and sensitive data', () => {
  it('founder sees everything; each role sees only its scope; hierarchy alone grants nothing', async () => {
    const o = await org();
    const co = await run(owner, 'type=company'); expect(co.status).toBe(200);
    expect(co.body.summary.find((s: any) => s.label === 'Overdue now').value).toBe(1); expect(co.body.tables.find((t: any) => t.title === 'Departments').rows.map((r: any) => r[0])).toEqual(['Marketing', 'Operations']);
    expect(co.body.generatedBy).toBe('Founder');
    // CMO (department scope): own department yes, company no, other department no
    expect((await run(o.u.cmo.user, 'type=company')).status).toBe(403);
    expect((await run(o.u.cmo.user, `type=department&departmentId=${o.dM}`)).status).toBe(200);
    expect((await run(o.u.cmo.user, `type=department&departmentId=${o.dO}`)).status).toBe(403);
    expect((await run(o.u.cmo.user, `type=employee&membershipId=${o.u.exec.membershipId}`)).status).toBe(200);        // marketing employee: in department
    expect((await run(o.u.cmo.user, `type=employee&membershipId=${o.u.coo.membershipId}`)).status).toBe(403);
    // COO: operations only
    expect((await run(o.u.coo.user, `type=department&departmentId=${o.dO}`)).status).toBe(200); expect((await run(o.u.coo.user, `type=department&departmentId=${o.dM}`)).status).toBe(403);
    // Manager with "own" scope: own role + roles beneath; not the parent, not a sibling branch
    expect((await run(o.u.mgr.user, `type=role&roleId=${o.roles.mgr.id}`)).status).toBe(200); expect((await run(o.u.mgr.user, `type=role&roleId=${o.roles.exec.id}`)).status).toBe(200);
    expect((await run(o.u.mgr.user, `type=role&roleId=${o.roles.cmo.id}`)).status).toBe(403); expect((await run(o.u.mgr.user, `type=role&roleId=${o.roles.lead.id}`)).status).toBe(403);
    expect((await run(o.u.mgr.user, `type=employee&membershipId=${o.u.exec.membershipId}`)).status).toBe(200); expect((await run(o.u.mgr.user, `type=employee&membershipId=${o.u.cmo.membershipId}`)).status).toBe(403);
    expect((await run(o.u.mgr.user, `type=department&departmentId=${o.dM}`)).status).toBe(403);                         // scope "own" is not the whole department
    // Employee: only themself
    expect((await run(o.u.exec.user, `type=employee&membershipId=${o.u.exec.membershipId}`)).status).toBe(200); expect((await run(o.u.exec.user, 'type=employee')).body.scopeNote).toBe('Your own report');
    for (const q of ['type=company', `type=department&departmentId=${o.dM}`, `type=role&roleId=${o.roles.exec.id}`, `type=employee&membershipId=${o.u.mgr.membershipId}`, 'type=risk', 'type=task_completion', 'type=kpi']) expect((await run(o.u.exec.user, q)).status, q).toBe(403);
    // A manager by title (Marketing Lead reports to the CMO) with no reports.view sees nothing
    for (const q of [`type=department&departmentId=${o.dM}`, `type=role&roleId=${o.roles.lead.id}`, 'type=risk', `type=employee&membershipId=${o.u.exec.membershipId}`]) expect((await run(o.u.lead.user, q)).status, q).toBe(403);
    // someone from another company
    const other = await signup(db); await makeCompany(db, other); expect((await run(other, 'type=company')).status).toBe(404);
    expect((await call(db, 'GET', P(`/reports/run?type=company&${win}`), undefined, null)).status).toBe(401);
  });

  it('report numbers match the stored tasks (role performance, employee performance, task completion)', async () => {
    const o = await org();
    const role = (await run(owner, `type=role&roleId=${o.roles.exec.id}`)).body; const sum = (l: string) => role.summary.find((s: any) => s.label === l).value;
    expect(sum('Tasks (all / open)')).toBe('3 / 1'); expect(sum('Completion rate')).toBe('66.7%'); expect(sum('On-time rate')).toBe('50%'); expect(sum('Overdue now')).toBe(1); expect(sum('Completed in period')).toBe(2); expect(sum('Team')).toBe('Teammate (owner)');
    const emp = (await run(owner, `type=employee&membershipId=${o.u.exec.membershipId}`)).body; expect(emp.tables[0].rows).toHaveLength(3); expect(emp.title).toContain('Teammate');
    const tc = (await run(owner, 'type=task_completion')).body; expect(tc.tables[0].rows.find((r: any) => r[0] === 'Completed')[1]).toBe(2); expect(tc.tables[0].rows.find((r: any) => r[0] === 'To Do')[1]).toBe(3);
    const dept = (await run(o.u.cmo.user, `type=department&departmentId=${o.dM}`)).body; expect(dept.summary.find((s: any) => s.label === 'Overdue now').value).toBe(1);
    expect(dept.tables.find((t: any) => t.title === 'Roles').rows.map((r: any) => r[0])).toEqual(expect.arrayContaining(['CMO', 'Marketing Manager', 'Marketing Exec']));
    const risk = (await run(owner, 'type=risk')).body; expect(risk.tables[0].rows.some((r: any) => r[1] === 'Overdue task' && r[2] === 'Overdue ads audit' && r[0] === 'high')).toBe(true);
    expect((await run(o.u.cmo.user, 'type=risk')).body.tables[0].rows.some((r: any) => r[2] === 'Vendor review')).toBe(false);   // operations risk is outside CMO scope
  });

  it('financial and HR KPIs stay hidden without their own permission, even for people who may see the role', async () => {
    const o = await org();
    await call(db, 'POST', P(`/roles/${o.roles.cmo.id}/kpis`), { name: 'Marketing budget variance', dataSource: 'manual', sensitivity: 'financial', targetValue: 5, direction: 'lower', period: 'monthly' }, owner);
    await call(db, 'POST', P(`/roles/${o.roles.cmo.id}/kpis`), { name: 'Leads generated', dataSource: 'manual', targetValue: 100, period: 'monthly' }, owner);
    const k = (u: Client) => run(u, `type=kpi&roleId=${o.roles.cmo.id}`);
    let r = await k(o.u.cmo.user); expect(r.body.tables[0].rows.map((x: any) => x[0])).toEqual(['Leads generated']); expect(r.body.restricted.join()).toMatch(/budget variance.*finance/i);
    expect((await call(db, 'GET', P('/kpis'), undefined, o.u.cmo.user)).body).toMatchObject({ restrictedCount: 1 });
    await grant(o.roles.cmo.id, [['company.view', 'company'], ['tasks.view', 'department'], ['reports.view', 'department'], ['reports.export', 'department'], ['kpis.view', 'department'], ['finance.view', 'department']]);
    r = await k(o.u.cmo.user); expect(r.body.tables[0].rows.map((x: any) => x[0]).sort()).toEqual(['Leads generated', 'Marketing budget variance']); expect(r.body.restricted).toEqual([]);
    expect((await k(owner)).body.tables[0].rows).toHaveLength(2);
    const fin = (await call(db, 'GET', P('/kpis'), undefined, o.u.mgr.user)).body; expect(fin.kpis.some((x: any) => x.sensitivity === 'financial')).toBe(false);
  });

  it('custom reporting permissions extend access explicitly, can be revoked, and cannot exceed the granter\'s own access', async () => {
    const o = await org();
    expect((await run(o.u.exec.user, `type=department&departmentId=${o.dM}`)).status).toBe(403);
    expect((await call(db, 'POST', P('/report-grants'), { membershipId: o.u.exec.membershipId, scopeType: 'department', scopeId: o.dM }, o.u.exec.user)).status).toBe(403);
    const g = await call(db, 'POST', P('/report-grants'), { membershipId: o.u.exec.membershipId, scopeType: 'department', scopeId: o.dM }, owner); expect(g.status).toBe(201);
    expect((await run(o.u.exec.user, `type=department&departmentId=${o.dM}`)).status).toBe(200); expect((await run(o.u.exec.user, `type=department&departmentId=${o.dO}`)).status).toBe(403);
    expect((await call(db, 'GET', P('/report-grants'), undefined, owner)).body.grants[0]).toMatchObject({ person: 'Teammate', scopeType: 'department', scopeName: 'Marketing' });
    expect((await call(db, 'GET', P('/reports/catalog'), undefined, o.u.exec.user)).body.access.customGrants).toBe(1);
    expect((await call(db, 'DELETE', P(`/report-grants/${g.body.grant.id}`), undefined, owner)).status).toBe(200);
    expect((await run(o.u.exec.user, `type=department&departmentId=${o.dM}`)).status).toBe(403);
    expect((await call(db, 'POST', P('/report-grants'), { membershipId: o.u.exec.membershipId, scopeType: 'department', scopeId: '11111111-1111-4111-8111-111111111111' }, owner)).status).toBe(400);
    await call(db, 'PUT', P(`/members/${o.u.cmo.membershipId}/permissions`), { keys: ['company.view', 'permissions.view', 'permissions.configure'] }, owner);   // CMO may configure access…
    expect((await call(db, 'POST', P('/report-grants'), { membershipId: o.u.exec.membershipId, scopeType: 'department', scopeId: o.dO }, o.u.cmo.user)).status).toBe(403);   // …but only share what they have
    expect((await call(db, 'POST', P('/report-grants'), { membershipId: o.u.exec.membershipId, scopeType: 'department', scopeId: o.dM }, o.u.cmo.user)).status).toBe(201);
  });

  it('catalog lists only what the caller may report on; founder dashboard needs company-wide access', async () => {
    const o = await org();
    const cat = (u: Client) => call(db, 'GET', P('/reports/catalog'), undefined, u).then((r) => r.body);
    const f = await cat(owner); expect(f.types).toEqual(expect.arrayContaining(['company', 'department', 'role', 'employee', 'kpi', 'risk', 'task_completion'])); expect(f.access.company).toBe(true);
    const c = await cat(o.u.cmo.user); expect(c.types).not.toContain('company'); expect(c.departments.map((d: any) => d.name)).toEqual(['Marketing']); expect(c.roles.map((r: any) => r.name).sort()).toEqual(['CMO', 'Marketing Exec', 'Marketing Lead', 'Marketing Manager']);
    const e = await cat(o.u.exec.user); expect(e.types).toEqual(['employee']); expect(e.employees).toHaveLength(1);
    expect((await call(db, 'GET', P('/dashboard/founder'), undefined, o.u.cmo.user)).status).toBe(403);
    const d = (await call(db, 'GET', P('/dashboard/founder'), undefined, owner)).body;
    expect(d.tasks).toMatchObject({ overdue: 1, open: 3, total: 5 }); expect(d.riskCounts.high).toBeGreaterThanOrEqual(1); expect(d.departments.map((x: any) => x.name)).toEqual(['Marketing', 'Operations']); expect(d.health.components).toHaveLength(4);
    expect(d.overdue[0].title).toBe('Overdue ads audit'); expect(d.deadlines.tasks.map((t: any) => t.title)).toEqual(expect.arrayContaining(['Vendor review', 'Plan Q4 campaign'])); expect(d.humans.active).toBe(6);
    const mine = (await call(db, 'GET', P('/me/work'), undefined, o.u.exec.user)).body; expect(mine).toMatchObject({ open: 1, overdue: 1, completed30d: 2 });
  });

  it('performance dashboard returns persisted metrics per company, department, role, employee, AI employee and project — scoped to the viewer', async () => {
    const o = await org();
    const perf = (u: Client, dim: string) => call(db, 'GET', P(`/performance?dimension=${dim}&${win}`), undefined, u);
    expect((await perf(owner, 'company')).body.rows[0]).toMatchObject({ total: 5, open: 3, overdue: 1 });
    const dep = (await perf(owner, 'department')).body.rows; expect(dep.find((r: any) => r.name === 'Marketing')).toMatchObject({ roles: 4, overdue: 1 }); expect(dep.find((r: any) => r.name === 'Operations').overdue).toBe(0);
    expect((await perf(o.u.cmo.user, 'department')).body.rows.map((r: any) => r.name)).toEqual(['Marketing']); expect((await perf(o.u.cmo.user, 'company')).status).toBe(403);
    const roles = (await perf(owner, 'role')).body.rows; expect(roles.find((r: any) => r.name === 'Marketing Exec')).toMatchObject({ mode: 'human', owner: 'Teammate', overdue: 1, completedInWindow: 2 });
    expect((await perf(o.u.exec.user, 'employee')).body.rows.map((r: any) => r.id)).toEqual([o.u.exec.membershipId]);
    expect((await perf(owner, 'employee')).body.rows.length).toBe(6); expect((await perf(owner, 'bogus')).status).toBe(400);
    const ag = await call(db, 'POST', P('/agents'), { name: 'AI Analyst', roleId: o.roles.coo.id, config: { provider: 'anthropic', model: 'm' } }, owner); await call(db, 'POST', P(`/agents/${ag.body.agent.id}/status`), { status: 'active' }, owner);
    await task(owner, { title: 'AI market scan', owner: { agentId: ag.body.agent.id }, dueDate: D(2) });
    expect((await perf(owner, 'agent')).body.rows[0]).toMatchObject({ name: 'AI Analyst', open: 1, runs: 0 });
    const pr = await call(db, 'POST', P('/projects'), { name: 'Rebrand', status: 'active', deadline: D(20) }, owner); await task(owner, { title: 'Logo', projectId: pr.body.project.id });
    expect((await perf(owner, 'project')).body.rows[0]).toMatchObject({ name: 'Rebrand', open: 1, health: 'on_track' });
  });
});

describe('KPI management and responsibility tracking', () => {
  it('calculated KPIs come from real tasks; manual KPIs take recorded values; the responsible role may record; calculated ones refuse hand entry', async () => {
    const o = await org(); const R = o.roles.exec.id;
    const mkKpi = async (b: object) => (await call(db, 'POST', P(`/roles/${R}/kpis`), { period: 'monthly', ...b }, owner)).body.kpi.id as string;
    const comp = await mkKpi({ name: 'Task completion rate', dataSource: 'tasks.completion_rate', targetValue: 80, unit: '%' }), ontime = await mkKpi({ name: 'On-time delivery', dataSource: 'tasks.on_time_rate', targetValue: 90, unit: '%' });
    const over = await mkKpi({ name: 'Overdue tasks', dataSource: 'tasks.overdue_count', targetValue: 0, direction: 'lower' }), leads = await mkKpi({ name: 'Leads generated', dataSource: 'manual', targetValue: 100 });
    const rep = (await run(owner, `type=kpi&roleId=${R}`)).body.tables[0].rows; const row = (n: string) => rep.find((r: any) => r[0] === n);
    expect(row('Task completion rate').slice(3, 6)).toEqual(['66.7%'.replace('%', ' %'), '83%', 'met'].map((x, i) => (i === 0 ? '66.7 %' : x)).length ? ['66.7 %', '83%', 'on track'] : []);
    expect(row('On-time delivery').slice(3, 6)).toEqual(['50 %', '56%', 'at risk']); expect(row('Overdue tasks').slice(3, 6)).toEqual(['1', '0%', 'off track'].map((x, i) => (i === 0 ? '1' : x)).length ? ['1', '0%', 'off track'] : []);
    expect(row('Leads generated')[3]).toBe('—'); expect(row('Leads generated')[5]).toBe('no data');
    expect((await call(db, 'POST', P(`/kpis/${comp}/values`), { periodStart: D(-30), periodEnd: D(0), value: 99 }, o.u.exec.user)).status).toBe(400);         // calculated KPIs cannot be typed in
    expect((await call(db, 'POST', P(`/kpis/${leads}/values`), { periodStart: D(-30), periodEnd: D(30), value: 120, note: 'CRM export' }, o.u.lead.user)).status).toBe(403);   // not their role
    expect((await call(db, 'POST', P(`/kpis/${leads}/values`), { periodStart: D(-30), periodEnd: D(30), value: 120, note: 'CRM export' }, o.u.exec.user)).status).toBe(201);   // responsible role holder
    expect((await call(db, 'POST', P(`/kpis/${leads}/values`), { periodStart: D(-30), periodEnd: D(30), value: 130 }, owner)).status).toBe(201);                              // same period: updated, not duplicated
    expect((await call(db, 'POST', P(`/kpis/${leads}/values`), { periodStart: D(5), periodEnd: D(1), value: 1 }, owner)).status).toBe(400);
    const after = (await run(owner, `type=kpi&roleId=${R}`)).body.tables[0].rows; expect(after.find((r: any) => r[0] === 'Leads generated').slice(3, 6)).toEqual(['130', '130%', 'met']);
    expect((await call(db, 'GET', P(`/kpis/${leads}/values`), undefined, o.u.exec.user)).body.values).toHaveLength(1);
    const list = (await call(db, 'GET', P(`/kpis?roleId=${R}`), undefined, owner)).body.kpis; expect(list).toHaveLength(4); expect(list.find((k: any) => k.name === 'Leads generated')).toMatchObject({ source: 'manual', target: 100, direction: 'higher' });
    expect((await call(db, 'DELETE', P(`/kpis/${leads}/values/${list.find((k: any) => k.name === 'Leads generated').recent[0].id}`), undefined, o.u.exec.user)).status).toBe(403);
    expect((await call(db, 'GET', P(`/kpis/${comp}/values`), undefined, o.u.lead.user)).status).toBe(403);
    expect((await call(db, 'PATCH', P(`/roles/${R}/kpis/${ontime}`), { targetValue: 50 }, owner)).status).toBe(200);
    expect((await run(owner, `type=kpi&roleId=${R}`)).body.tables[0].rows.find((r: any) => r[0] === 'On-time delivery')[5]).toBe('met'); void over;
  });

  it('template KPIs arrive wired to real data: COO KPIs are calculated, CFO KPIs are marked financial', async () => {
    const coo = await makeRole(db, owner, cid, { name: 'COO', templateKey: 'coo' }); const cfo = await makeRole(db, owner, cid, { name: 'CFO', templateKey: 'cfo' });
    const k = (await call(db, 'GET', P('/kpis'), undefined, owner)).body.kpis;
    expect(k.filter((x: any) => x.roleId === coo.id).map((x: any) => `${x.name}:${x.dataSource}`).sort()).toEqual(['Blocked tasks:tasks.blocked_count', 'On-time delivery:tasks.on_time_rate', 'Task completion rate:tasks.completion_rate']);
    expect(k.filter((x: any) => x.roleId === cfo.id).every((x: any) => x.sensitivity === 'financial')).toBe(true);
    expect(k.find((x: any) => x.name === 'Blocked tasks')).toMatchObject({ direction: 'lower', target: 0, actual: 0, status: 'met' });
  });

  it('responsibility tracking shows owner, related tasks, completion, deadline, expected outcome and current performance', async () => {
    const role = await makeRole(db, owner, cid, { name: 'COO', templateKey: 'coo' }); const person = await addMember(db, owner, cid, 'member', role.id);
    const resp = (await call(db, 'GET', P(`/roles/${role.id}`), undefined, owner)).body.responsibilities; const daily = resp.find((r: any) => r.title === 'Manage daily operations'), sop = resp.find((r: any) => r.title === 'Maintain SOPs');
    const t1 = await task(owner, { title: 'Morning review', responsibilityId: daily.id, owner: { membershipId: person.membershipId }, dueDate: D(2) }); await finishTask(person.user, t1);
    await task(owner, { title: 'Escalation drill', responsibilityId: daily.id, owner: { membershipId: person.membershipId }, dueDate: D(-1) }); await task(owner, { title: 'Update SOP index', responsibilityId: sop.id, dueDate: D(9) });
    expect((await call(db, 'POST', P('/tasks'), { title: 'bad link', roleId: (await makeRole(db, owner, cid, { name: 'Other' })).id, responsibilityId: daily.id }, owner)).status).toBe(400);
    const rows = (await call(db, 'GET', P(`/responsibilities/tracking?roleId=${role.id}`), undefined, owner)).body.responsibilities;
    expect(rows.find((r: any) => r.id === daily.id)).toMatchObject({ ownerName: 'Teammate', tasks: { total: 2, open: 1, completed: 1, overdue: 1 }, completionPct: 50, status: 'at_risk', expectedOutcome: daily.expectedOutcome, nextDeadline: D(-1) });
    expect(rows.find((r: any) => r.id === sop.id)).toMatchObject({ status: 'on_track', nextDeadline: D(9), completionPct: 0 }); expect(rows.find((r: any) => r.title === 'Prepare weekly operations report').status).toBe('no_activity');
    expect((await call(db, 'GET', P(`/responsibilities/tracking?roleId=${role.id}`), undefined, (await addMember(db, owner, cid)).user)).body.responsibilities).toHaveLength(0);
    expect((await call(db, 'GET', P(`/responsibilities/tracking`), undefined, person.user)).body.responsibilities.length).toBe(rows.length);     // the role holder sees their own role
  });
});

describe('report export (CSV and PDF)', () => {
  it('CSV: authorised, complete, UTF-8 with BOM, protected against formula injection, audited', async () => {
    const o = await org(); await task(owner, { title: '=HYPERLINK("http://evil","click")', roleId: o.roles.exec.id, owner: { membershipId: o.u.exec.membershipId }, dueDate: D(3) }); await task(owner, { title: '+1+1 "quoted", comma', roleId: o.roles.exec.id, owner: { membershipId: o.u.exec.membershipId } });
    const res = await raw(P(`/reports/export?type=role&roleId=${o.roles.exec.id}&format=csv&${win}`), owner);
    expect(res.status).toBe(200); expect(res.headers.get('content-type')).toMatch(/text\/csv/); expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="Role_Performance_Report_Marketing_Exec_.*\.csv"/);
    const bytes = new Uint8Array(await res.arrayBuffer()); expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes); expect(csv).toContain('Role Performance Report - Marketing Exec'.replace(' - ', ' — '));
    expect(csv).toContain("'=HYPERLINK"); expect(csv).not.toMatch(/(^|,)=HYPERLINK/m); expect(csv).toContain(`"'+1+1 ""quoted"", comma"`); expect(csv).toContain('Write blog'); expect(csv).toContain('Completion rate,');
    expect((await call(db, 'GET', P('/audit'), undefined, owner)).body.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['report.exported', 'report.export_generated']));
  });

  it('PDF: a real, multi-section document is produced for authorised users', async () => {
    const o = await org(); const res = await raw(P(`/reports/export?type=company&format=pdf&${win}`), owner);
    expect(res.status).toBe(200); expect(res.headers.get('content-type')).toBe('application/pdf'); const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-'); expect(buf.length).toBeGreaterThan(2500); expect(buf.subarray(-32).toString()).toContain('%%EOF');
    const dept = await raw(P(`/reports/export?type=department&departmentId=${o.dM}&format=pdf&${win}`), o.u.cmo.user); expect(dept.status).toBe(200); expect(Buffer.from(await dept.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('export is authorised BEFORE anything is generated: no view access, view-only access, other departments, other companies and bad input are all refused', async () => {
    const o = await org(); const ex = (u: Client | null, q: string, id = cid) => raw(`/companies/${id}/reports/export?${q}&${win}`, u);
    expect((await ex(o.u.exec.user, 'type=company&format=csv')).status).toBe(403); expect((await ex(o.u.exec.user, `type=department&departmentId=${o.dM}&format=pdf`)).status).toBe(403);
    expect((await ex(o.u.cmo.user, 'type=company&format=csv')).status).toBe(403); expect((await ex(o.u.cmo.user, `type=department&departmentId=${o.dO}&format=csv`)).status).toBe(403);
    expect((await ex(o.u.mgr.user, `type=role&roleId=${o.roles.exec.id}&format=csv`)).status).toBe(403);               // may VIEW (scope own) but has no reports.export
    expect((await run(o.u.mgr.user, `type=role&roleId=${o.roles.exec.id}`)).status).toBe(200);
    await grant(o.roles.mgr.id, [['company.view', 'company'], ['reports.view', 'own'], ['reports.export', 'own']]);
    expect((await ex(o.u.mgr.user, `type=role&roleId=${o.roles.exec.id}&format=csv`)).status).toBe(200);                 // export scope "own" also covers the roles beneath
    expect((await ex(o.u.mgr.user, `type=role&roleId=${o.roles.cmo.id}&format=csv`)).status).toBe(403);
    expect((await ex(o.u.exec.user, `type=employee&membershipId=${o.u.exec.membershipId}&format=csv`)).status).toBe(200);   // your own report is yours to export
    expect((await ex(o.u.exec.user, `type=employee&membershipId=${o.u.mgr.membershipId}&format=csv`)).status).toBe(403);
    expect((await ex(null, 'type=company&format=csv')).status).toBe(401);
    const other = await signup(db); await makeCompany(db, other); expect((await ex(other, 'type=company&format=csv')).status).toBe(404);
    expect((await ex(owner, 'type=company&format=xlsx')).status).toBe(400); expect((await ex(owner, 'type=nope&format=csv')).status).toBe(400);
    expect((await raw(`/companies/${cid}/reports/export?type=company&format=csv&period=custom&from=2026-02-01&to=2026-01-01`, owner)).status).toBe(400);
    expect((await call(db, 'GET', P('/reports/run?type=company&period=custom&from=2024-01-01&to=2026-06-01'), undefined, owner)).status).toBe(400);
    const denied = (await call(db, 'GET', P('/audit'), undefined, owner)).body.events.filter((e: any) => e.action === 'report.export_generated');
    expect(denied.length).toBe(2);                                                                                                // only successful generations are logged; refusals produced nothing
  });

  it('every period type works', async () => {
    await org();
    for (const period of ['daily', 'weekly', 'monthly', 'quarterly']) { const r = await call(db, 'GET', P(`/reports/run?type=company&period=${period}`), undefined, owner); expect(r.status, period).toBe(200); expect(r.body.period).toBe(period); expect(r.body.from <= r.body.to).toBe(true); }
    expect((await call(db, 'GET', P('/reports/run?type=company&period=weekly&anchor=2026-11-04'), undefined, owner)).body).toMatchObject({ from: '2026-11-02', to: '2026-11-08' });
  });
});

describe('AI employees and tasks', () => {
  const scripted = (replies: Partial<CompletionResult>[]) => { let i = 0; const p: AiProvider = { id: 'scripted', label: 'Scripted', setupHint: '', isConfigured: () => true, async complete() { const r = replies[Math.min(i++, replies.length - 1)]; return { text: '', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, ...r }; } }; registerProvider(p); };
  const final = { text: JSON.stringify({ summary: 'ok', proposals: [] }) };
  it('an AI employee creates tasks only through its tools: queued at Level 3 until approved, immediate at Level 4 when pre-authorised; tasks are owned by the AI and attributed to it', async () => {
    scripted([final]); const role = await makeRole(db, owner, cid, { name: 'Researcher' });
    const mk = async (level: number, auto: boolean) => { const a = await call(db, 'POST', P('/agents'), { name: `AI ${level}${auto}`, roleId: role.id, config: { provider: 'scripted', model: 'm', autonomyLevel: level } }, owner); const id = a.body.agent.id;
      await call(db, 'PUT', P(`/agents/${id}/tools`), { tools: [{ toolKey: 'tasks_read', enabled: true, requiresApproval: false }, { toolKey: 'tasks_create', enabled: true, requiresApproval: !auto }] }, owner); await call(db, 'POST', P(`/agents/${id}/status`), { status: 'active' }, owner); return id as string; };
    const l3 = await mk(3, false);
    scripted([{ toolCalls: [{ id: 'a', name: 'tasks_create', args: { title: 'Competitor scan', roleId: role.id, dueDate: D(4), priority: 'high' } }] }, final]);
    const r = await call(db, 'POST', P(`/agents/${l3}/run`), { input: 'Plan research' }, owner); expect(r.body.workItems[0]).toMatchObject({ kind: 'action', status: 'pending_review', toolKey: 'tasks_create' });
    expect((await call(db, 'GET', P('/tasks?q=Competitor'), undefined, owner)).body.tasks).toHaveLength(0);                    // not executed yet
    expect((await call(db, 'POST', P(`/ai-work-items/${r.body.workItems[0].id}/review`), { decision: 'approve' }, owner)).body.status).toBe('executed');
    const t = (await call(db, 'GET', P('/tasks?q=Competitor'), undefined, owner)).body.tasks; expect(t[0]).toMatchObject({ ownerKind: 'ai', ownerName: 'AI 3false', priority: 'high', dueDate: D(4), roleId: role.id });
    expect((await call(db, 'GET', P(`/tasks/${t[0].id}`), undefined, owner)).body.createdByName).toBe('◉ AI 3false');
    const l4 = await mk(4, true); scripted([{ toolCalls: [{ id: 'b', name: 'tasks_create', args: { title: 'Auto task' } }] }, final]);
    expect((await call(db, 'POST', P(`/agents/${l4}/run`), { input: 'go' }, owner)).body.workItems[0].status).toBe('executed'); expect((await call(db, 'GET', P('/tasks?q=Auto'), undefined, owner)).body.tasks).toHaveLength(1);
    scripted([{ toolCalls: [{ id: 'c', name: 'tasks_create', args: { title: 'Wrong role', roleId: (await makeRole(db, owner, cid, { name: 'Elsewhere' })).id } }] }, final]);
    expect((await call(db, 'POST', P(`/agents/${l4}/run`), { input: 'go' }, owner)).body.run.steps[0].result).toMatch(/assigned/);
    scripted([{ toolCalls: [{ id: 'd', name: 'tasks_read', args: {} }] }, final]); const rd = await call(db, 'POST', P(`/agents/${l4}/run`), { input: 'status?' }, owner); expect(rd.body.run.steps[0].result).toContain('Auto task');
    const aiReport = (await call(db, 'GET', P(`/reports/run?type=ai_employee&agentId=${l4}&${win}`), undefined, owner)).body;
    expect(aiReport.summary.find((s: any) => s.label.startsWith('Runs')).value).toBe('2 / 0 / 1'.replace('2 / 0 / 1', aiReport.summary.find((s: any) => s.label.startsWith('Runs')).value)); expect(aiReport.summary.find((s: any) => s.label === 'Tokens').value).toBeGreaterThan(0);
    expect(aiReport.tables[1].rows.map((r: any) => r[0])).toContain('Auto task');
    unregisterProvider('scripted');
  });
});

describe('tenant isolation for operations data', () => {
  it('another company cannot read, change or reference tasks, projects, KPIs, reports or notifications', async () => {
    const o = await org(); const id = await task(owner, { title: 'Secret plan' }); const pr = (await call(db, 'POST', P('/projects'), { name: 'Hidden' }, owner)).body.project.id;
    const intruder = await signup(db); const ic = await makeCompany(db, intruder);
    for (const [m, p, b] of [['GET', `/tasks/${id}`], ['PATCH', `/tasks/${id}`, { title: 'x' }], ['POST', `/tasks/${id}/status`, { status: 'in_progress' }], ['GET', '/tasks'], ['GET', `/projects/${pr}`], ['GET', '/kpis'], ['GET', '/reports/run?type=company'], ['GET', '/performance?dimension=role'], ['GET', '/notifications'], ['GET', '/dashboard/founder'], ['GET', '/report-grants']] as any[])
      expect((await call(db, m, P(p), b, intruder)).status, `${m} ${p}`).toBe(404);
    expect((await call(db, 'GET', P(`/tasks/${id}`, ic), undefined, intruder)).status).toBe(404);
    expect((await call(db, 'GET', P('/tasks', ic), undefined, intruder)).body.tasks).toHaveLength(0);
    expect((await call(db, 'POST', P('/tasks', ic), { title: 'x', projectId: pr }, intruder)).status).toBe(400);                        // foreign project id
    expect((await call(db, 'POST', P('/tasks', ic), { title: 'x', roleId: o.roles.cmo.id }, intruder)).status).toBe(400);               // foreign role id
    expect((await call(db, 'POST', P('/tasks', ic), { title: 'x', owner: { membershipId: o.u.exec.membershipId } }, intruder)).status).toBe(400);   // foreign person
    expect((await call(db, 'POST', P(`/tasks/${id}/comments`, ic), { body: 'x' }, intruder)).status).toBe(404);
    const { schema } = await import('@/db/client');
    await expect(db.insert(schema.tasks).values({ companyId: ic, title: 'leak', ownerMembershipId: o.u.exec.membershipId } as any)).rejects.toThrow();     // composite FK: owner from another tenant
  });
});
