import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { schema } from '@/db/client';
import { handle } from '@/server/router';
import { addMember, call, makeCompany, makeRole, newDb, resetRateLimits, signup, type Client } from './helpers';
import { addDays, today } from '@/server/services/metrics';
import { registerProvider, unregisterProvider, type AiProvider, type CompletionResult } from '@/server/ai/provider';

let db: Db; let owner: Client; let cid: string;
const P = (p: string, id = cid) => `/companies/${id}${p}`;
const D = (n: number) => addDays(today(), n);
beforeAll(async () => { process.env.EXPOSE_DEV_LINKS = '1'; db = await newDb(); });
beforeEach(async () => { resetRateLimits(); owner = await signup(db, 'Founder'); cid = await makeCompany(db, owner); });
afterEach(() => unregisterProvider('scripted'));
const raw = (path: string, who: Client | null) => handle(new Request(`http://localhost:3000/api${path}`, { headers: { host: 'localhost:3000', ...(who ? { cookie: who.cookie } : {}) } }), db);
const grant = (roleId: string, g: [string, string][]) => call(db, 'PUT', P(`/roles/${roleId}/permissions`), { grants: g.map(([key, scope]) => ({ key, scope })) }, owner).then((r) => expect(r.status, JSON.stringify(r.body)).toBe(200));
async function mkTask(who: Client, body: object) { const r = await call(db, 'POST', P('/tasks'), body, who); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body.task.id as string; }
const move = (who: Client, id: string, status: string, extra: object = {}) => call(db, 'POST', P(`/tasks/${id}/status`), { status, ...extra }, who);
async function mkDoc(who: Client, body: object) { const r = await call(db, 'POST', P('/knowledge'), { title: 'Doc', body: 'Some text', ...body }, who); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body.document.id as string; }
const roleDetail = async (rid: string) => (await call(db, 'GET', P(`/roles/${rid}`), undefined, owner)).body;
const count = async (table: string) => { const r: any = await db.execute(`select count(*)::int n from ${table} where company_id = '${cid}'` as any); return (r.rows ?? r)[0].n as number; };

/** A realistic departing employee: CMO with open work, a project, documents, a decision, KPI history. */
async function team() {
  const dept = (await call(db, 'POST', P('/departments'), { name: 'Marketing' }, owner)).body.department.id;
  const cmo = await makeRole(db, owner, cid, { name: 'CMO', templateKey: 'cmo', departmentId: dept, hasApprovalAuthority: true });
  await grant(cmo.id, [['company.view', 'company'], ['tasks.view', 'company'], ['tasks.create', 'company'], ['knowledge.create', 'company'], ['decisions.create', 'company'], ['kpis.view', 'company'], ['kpis.edit', 'company']]);
  const leaver = await addMember(db, owner, cid, 'member', cmo.id), succ = await addMember(db, owner, cid), mgr = await addMember(db, owner, cid);
  await call(db, 'PATCH', P(`/employees/${leaver.membershipId}`), { departmentId: dept, managerMembershipId: mgr.membershipId, jobTitle: 'Head of Marketing' }, owner);
  await call(db, 'PATCH', P('/me/profile'), { phone: '+91 99887 76655', bio: 'Private bio text' }, leaver.user);
  const resp = (await roleDetail(cmo.id)).responsibilities as any[];
  const t1 = await mkTask(owner, { title: 'Launch spring campaign', roleId: cmo.id, owner: { membershipId: leaver.membershipId }, dueDate: D(5), deliverables: ['Creative brief'], responsibilityId: resp[0].id });
  await move(leaver.user, t1, 'in_progress');
  const t2 = await mkTask(owner, { title: 'Draft Q4 content calendar', roleId: cmo.id, owner: { membershipId: leaver.membershipId }, dueDate: D(12) });
  const t3 = await mkTask(owner, { title: 'Approve agency contract', roleId: cmo.id, owner: { membershipId: leaver.membershipId }, requiresApproval: true, dueDate: D(2) });
  await move(leaver.user, t3, 'in_progress'); await move(leaver.user, t3, 'awaiting_approval');
  const t4 = await mkTask(owner, { title: 'Publish January report', roleId: cmo.id, owner: { membershipId: leaver.membershipId }, dueDate: D(-20) });
  await move(leaver.user, t4, 'in_progress'); await move(leaver.user, t4, 'completed');
  const t5 = await mkTask(owner, { title: 'Waiting on design assets', roleId: cmo.id, owner: { membershipId: leaver.membershipId }, dueDate: D(8) });
  await call(db, 'PUT', P(`/tasks/${t5}/dependencies`), { ids: [t1] }, owner); await move(leaver.user, t5, 'blocked', { reason: 'Designer on leave' });
  await call(db, 'POST', P(`/tasks/${t4}/comments`), { body: 'Report published, 12% more leads' }, leaver.user);
  const proj = (await call(db, 'POST', P('/projects'), { name: 'Brand refresh', status: 'active', ownerMembershipId: leaver.membershipId, departmentId: dept, deadline: D(40), deliverables: [{ title: 'Brand book' }] }, owner)).body.project.id;
  const sop = await mkDoc(leaver.user, { title: 'Campaign launch SOP', docType: 'sop', responsibilityId: resp[0].id, roleId: cmo.id, visibility: 'role', departmentId: dept, body: 'Step 1: brief. Step 2: approve.' });
  const kpi = (await call(db, 'POST', P(`/roles/${cmo.id}/kpis`), { name: 'Leads generated', dataSource: 'manual', targetValue: 500, period: 'monthly' }, owner)).body.kpi.id;
  await call(db, 'POST', P(`/kpis/${kpi}/values`), { periodStart: D(-30), periodEnd: D(30), value: 420, note: 'CRM' }, leaver.user);
  const dec = (await call(db, 'POST', P('/decisions'), { title: 'Focus on LinkedIn over Instagram', description: 'Shift budget', reason: 'B2B buyers', relatedRoleId: cmo.id, approve: true, decisionMakerMembershipId: leaver.membershipId }, owner)).body.decision.id;
  const rec = (await call(db, 'POST', P('/recurring-tasks'), { title: 'Weekly campaign review', cadence: 'weekly', roleId: cmo.id, owner: { membershipId: leaver.membershipId }, startOn: D(3) }, owner)).body.recurring.id;
  return { dept, cmo, leaver, succ, mgr, resp, t: { t1, t2, t3, t4, t5 }, proj, sop, kpi, dec, rec };
}
const taskOwner = async (id: string) => (await call(db, 'GET', P(`/tasks/${id}`), undefined, owner)).body.view as { ownerName: string; ownerKind: string };

describe('decision log', () => {
  it('proposals are reviewed by someone else; approved decisions are preserved: no edits, no deletes — only review notes and supersession', async () => {
    const role = await makeRole(db, owner, cid, { name: 'Strategy lead' }); await grant(role.id, [['company.view', 'company'], ['decisions.create', 'company'], ['decisions.approve', 'company'], ['decisions.view', 'company']]);
    const author = await addMember(db, owner, cid, 'member', role.id), other = await addMember(db, owner, cid), proj = (await call(db, 'POST', P('/projects'), { name: 'Pune expansion' }, owner)).body.project.id;
    const mk = await call(db, 'POST', P('/decisions'), { title: 'Launch in Sangli before Pune', description: 'Pilot city first', reason: 'Limited budget and better operational control', alternatives: [{ option: 'Launch in both cities', reason: 'Too expensive' }, { option: 'Launch in Pune first' }], expectedOutcome: '100 rides/day in 3 months', relatedProjectId: proj, relatedRoleId: role.id, reviewDate: D(90) }, author.user);
    expect(mk.status).toBe(201); expect(mk.body.decision.status).toBe('proposed'); const id = mk.body.decision.id;
    let d = (await call(db, 'GET', P(`/decisions/${id}`), undefined, owner)).body;
    expect(d).toMatchObject({ title: 'Launch in Sangli before Pune', status: 'proposed', reason: 'Limited budget and better operational control', expectedOutcome: '100 rides/day in 3 months', relatedProject: 'Pune expansion', relatedRole: 'Strategy lead', reviewDate: D(90), proposedBy: 'person' }); expect(d.alternatives).toHaveLength(2);
    expect((await call(db, 'GET', P(`/decisions/${id}`), undefined, other.user)).status).toBe(404);                                  // a proposal is not public
    expect((await call(db, 'POST', P(`/decisions/${id}/approve`), {}, author.user)).status).toBe(403);                                  // no self-approval
    expect((await call(db, 'PATCH', P(`/decisions/${id}`), { reason: 'Refined reason' }, author.user)).status).toBe(200);              // proposals can still be edited
    expect((await call(db, 'POST', P(`/decisions/${id}/approve`), { decisionMakerMembershipId: author.membershipId }, owner)).status).toBe(200);
    d = (await call(db, 'GET', P(`/decisions/${id}`), undefined, other.user)).body; expect(d).toMatchObject({ status: 'approved', decisionMaker: 'Teammate', decidedOn: today(), reason: 'Refined reason' });   // approved decisions are visible to every employee
    expect((await call(db, 'PATCH', P(`/decisions/${id}`), { reason: 'Rewritten history' }, owner)).status).toBe(409);
    expect((await call(db, 'DELETE', P(`/decisions/${id}`), undefined, owner)).status).toBe(409);
    expect((await call(db, 'POST', P(`/decisions/${id}/approve`), {}, owner)).status).toBe(409);
    await call(db, 'POST', P(`/decisions/${id}/review`), { outcomeNotes: 'Month 1: 40 rides/day' }, owner); await call(db, 'POST', P(`/decisions/${id}/review`), { outcomeNotes: 'Month 2: 75 rides/day', reviewDate: D(30) }, owner);
    d = (await call(db, 'GET', P(`/decisions/${id}`), undefined, owner)).body; expect(d.outcomeNotes).toMatch(/Month 1: 40[\s\S]*Month 2: 75/); expect(d.reason).toBe('Refined reason'); expect(d.reviewDate).toBe(D(30));   // notes are append-only
    expect((await call(db, 'POST', P(`/decisions/${id}/review`), { outcomeNotes: 'x' }, other.user)).status).toBe(403);
    expect((await call(db, 'GET', P('/audit'), undefined, owner)).body.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['decision.proposed', 'decision.approved', 'decision.reviewed']));
  });

  it('a decision is replaced only by a new, separately approved decision; the old one is kept as superseded; rejected proposals stay on record', async () => {
    const a = (await call(db, 'POST', P('/decisions'), { title: 'Use vendor A', reason: 'cheapest', approve: true }, owner)).body.decision.id;
    const sup = await call(db, 'POST', P(`/decisions/${a}/supersede`), { title: 'Use vendor B', reason: 'A raised prices' }, owner); expect(sup.status).toBe(201); const b = sup.body.decision.id;
    let list = (await call(db, 'GET', P('/decisions'), undefined, owner)).body.decisions; expect(list.find((x: any) => x.id === a).status).toBe('approved'); expect(list.find((x: any) => x.id === b)).toMatchObject({ status: 'proposed', supersedesId: a });   // nothing changes until a human approves
    await call(db, 'POST', P(`/decisions/${b}/approve`), {}, owner); list = (await call(db, 'GET', P('/decisions'), undefined, owner)).body.decisions;
    expect(list.find((x: any) => x.id === a)).toMatchObject({ status: 'superseded', title: 'Use vendor A', reason: 'cheapest' }); expect(list.find((x: any) => x.id === b).status).toBe('approved');
    expect((await call(db, 'POST', P(`/decisions/${a}/supersede`), { title: 'again' }, owner)).status).toBe(409);
    const c = (await call(db, 'POST', P('/decisions'), { title: 'Skip insurance', reason: 'cost' }, owner)).body.decision.id; expect((await call(db, 'POST', P(`/decisions/${c}/reject`), { note: 'Too risky' }, owner)).status).toBe(200);
    expect((await call(db, 'GET', P(`/decisions/${c}`), undefined, owner)).body).toMatchObject({ status: 'rejected', outcomeNotes: 'Too risky' }); expect((await call(db, 'GET', P('/decisions?status=superseded'), undefined, owner)).body.decisions).toHaveLength(1);
    expect((await call(db, 'POST', P('/decisions'), { title: 'x', relatedRoleId: '11111111-1111-4111-8111-111111111111' }, owner)).status).toBe(400);
  });

  it('confidential decisions are visible only to their makers, creators and decision viewers; permissions gate creation and approval', async () => {
    const plain = await addMember(db, owner, cid); const id = (await call(db, 'POST', P('/decisions'), { title: 'Acquire competitor', approve: true, confidential: true }, owner)).body.decision.id; const open = (await call(db, 'POST', P('/decisions'), { title: 'Open decision', approve: true }, owner)).body.decision.id;
    expect((await call(db, 'GET', P(`/decisions/${id}`), undefined, plain.user)).status).toBe(404); expect((await call(db, 'GET', P(`/decisions/${open}`), undefined, plain.user)).status).toBe(200); expect((await call(db, 'GET', P('/decisions'), undefined, plain.user)).body.decisions.map((d: any) => d.title)).toEqual(['Open decision']);
    expect((await call(db, 'POST', P('/decisions'), { title: 'x' }, plain.user)).status).toBe(403);
    const r = await makeRole(db, owner, cid, { name: 'Proposer' }); await grant(r.id, [['company.view', 'company'], ['decisions.create', 'company']]); const p = await addMember(db, owner, cid, 'member', r.id);
    expect((await call(db, 'POST', P('/decisions'), { title: 'Wants it approved at once', approve: true }, p.user)).status).toBe(403);
    const pid = (await call(db, 'POST', P('/decisions'), { title: 'Hire a CFO' }, p.user)).body.decision.id; expect((await call(db, 'POST', P(`/decisions/${pid}/approve`), {}, plain.user)).status).toBe(404);
  });

  describe('AI employees and decisions', () => {
    const scripted = (replies: Partial<CompletionResult>[]) => { const seen: any[] = []; let i = 0; const pr: AiProvider = { id: 'scripted', label: 'Scripted', setupHint: '', isConfigured: () => true, async complete(req) { seen.push(JSON.parse(JSON.stringify(req))); const r = replies[Math.min(i++, replies.length - 1)]; return { text: '', toolCalls: [], usage: { inputTokens: 5, outputTokens: 5 }, ...r }; } }; registerProvider(pr); return seen; };
    const final = { text: JSON.stringify({ summary: 'ok', proposals: [] }) }; const t = (name: string, args: object) => ({ toolCalls: [{ id: 'c', name, args: args as Record<string, unknown> }] });
    it('AI employees follow approved decisions, can only PROPOSE new ones (never approve, edit or replace), and cannot see confidential ones', async () => {
      scripted([final]); const role = await makeRole(db, owner, cid, { name: 'Marketing' }); const other = await makeRole(db, owner, cid, { name: 'Elsewhere' });
      await call(db, 'POST', P('/decisions'), { title: 'Focus on LinkedIn', reason: 'B2B buyers', relatedRoleId: role.id, approve: true }, owner); await call(db, 'POST', P('/decisions'), { title: 'Company-wide: no cold calls', approve: true }, owner);
      await call(db, 'POST', P('/decisions'), { title: 'Secret acquisition', approve: true, confidential: true }, owner); await call(db, 'POST', P('/decisions'), { title: 'Other team thing', relatedRoleId: other.id, approve: true }, owner); await call(db, 'POST', P('/decisions'), { title: 'Not yet approved idea' }, owner);
      const ag = await call(db, 'POST', P('/agents'), { name: 'AI Marketer', roleId: role.id, config: { provider: 'scripted', model: 'm', autonomyLevel: 4, knowledgeScope: 'role' } }, owner); const id = ag.body.agent.id;
      await call(db, 'PUT', P(`/agents/${id}/tools`), { tools: [{ toolKey: 'decisions_read', enabled: true, requiresApproval: false }, { toolKey: 'decisions_propose', enabled: true, requiresApproval: false }] }, owner); await call(db, 'POST', P(`/agents/${id}/status`), { status: 'active' }, owner);
      const seen = scripted([t('decisions_propose', { title: 'Switch to weekly newsletters', reason: 'Higher open rates', relatedRoleId: role.id }), final]); const r = await call(db, 'POST', P(`/agents/${id}/run`), { input: 'plan' }, owner);
      const sys = seen[0].system as string; expect(sys).toContain('Focus on LinkedIn'); expect(sys).toContain('Company-wide: no cold calls'); for (const hidden of ['Secret acquisition', 'Other team thing', 'Not yet approved idea']) expect(sys).not.toContain(hidden);
      expect(r.body.workItems[0]).toMatchObject({ kind: 'action', status: 'executed' });
      const list = (await call(db, 'GET', P('/decisions'), undefined, owner)).body.decisions; const prop = list.find((d: any) => d.title === 'Switch to weekly newsletters'); expect(prop).toMatchObject({ status: 'proposed', proposedBy: '◉ AI Marketer', relatedRole: 'Marketing' }); expect(prop.can.approve).toBe(true);   // even at Level 4 a proposal stays a proposal
      expect((await call(db, 'GET', P('/notifications'), undefined, owner)).body.notifications.some((n: any) => /AI proposed a decision/.test(n.title))).toBe(true);
      scripted([t('decisions_propose', { title: 'Sneaky', relatedRoleId: other.id }), final]); expect((await call(db, 'POST', P(`/agents/${id}/run`), { input: 'x' }, owner)).body.run.steps[0].result).toMatch(/only relate a decision to a role you are assigned/);
      const seen2 = scripted([t('decisions_read', {}), final]); await call(db, 'POST', P(`/agents/${id}/run`), { input: 'read' }, owner); const read = JSON.parse((seen2[1].messages.at(-1) as any).content); expect(read.map((x: any) => x.title).sort()).toEqual(['Company-wide: no cold calls', 'Focus on LinkedIn']);
      expect((await call(db, 'POST', P(`/decisions/${prop.id}/approve`), {}, owner)).status).toBe(200);                         // only a human approves
    });
  });
});

describe('employee onboarding', () => {
  it('gives a new employee their role, responsibilities, rules, KPI targets, the knowledge THEY may read, inherited tasks, access summary and a checklist', async () => {
    const dM = (await call(db, 'POST', P('/departments'), { name: 'Marketing' }, owner)).body.department.id, dF = (await call(db, 'POST', P('/departments'), { name: 'Finance' }, owner)).body.department.id;
    const role = await makeRole(db, owner, cid, { name: 'Marketing Manager', templateKey: 'marketing_manager', departmentId: dM }); const mgr = await addMember(db, owner, cid);
    await call(db, 'POST', P(`/roles/${role.id}/kpis`), { name: 'Budget variance', dataSource: 'manual', sensitivity: 'financial', targetValue: 5 }, owner);
    await mkDoc(owner, { title: 'Code of conduct', docType: 'policy', body: 'conduct' }); await mkDoc(owner, { title: 'Marketing manager handbook', docType: 'role_description', visibility: 'role', roleId: role.id, departmentId: dM, body: 'handbook' }); await mkDoc(owner, { title: 'Marketing tools guide', visibility: 'department', departmentId: dM, body: 'tools' }); await mkDoc(owner, { title: 'Finance close SOP', docType: 'sop', visibility: 'department', departmentId: dF, body: 'close' }); await mkDoc(owner, { title: 'Salary bands', visibility: 'role', roleId: role.id, departmentId: dM, confidential: true, body: 'bands' });
    const u = await signup(db, 'Nina'); const inv = await call(db, 'POST', P('/invites'), { email: u.email, roleIds: [role.id], departmentId: dM, managerMembershipId: mgr.membershipId, jobTitle: 'Marketing Manager' }, owner);
    await call(db, 'POST', '/invites/accept', { token: new URL(inv.body.devLink).searchParams.get('token') }, u);
    const mid = (await call(db, 'GET', P('/employees'), undefined, owner)).body.employees.find((e: any) => e.userId === u.id).membershipId;
    const t = await mkTask(owner, { title: 'Review Q4 plan', roleId: role.id, owner: { membershipId: mid }, dueDate: D(4) });
    const pkg = (await call(db, 'GET', P('/me/onboarding'), undefined, u)).body;
    expect(pkg).toMatchObject({ employee: { name: 'Nina', jobTitle: 'Marketing Manager' }, department: 'Marketing', manager: 'Teammate' });
    expect(pkg.roles[0]).toMatchObject({ name: 'Marketing Manager', reportsTo: null, isOwner: true }); expect(pkg.roles[0].responsibilities.map((r: any) => r.title)).toContain('Plan and run campaigns'); expect(pkg.roles[0].rules.length).toBeGreaterThan(0);
    expect(pkg.roles[0].kpis.map((k: any) => k.name)).toEqual(expect.arrayContaining(['Campaign ROI', 'Leads generated'])); expect(pkg.roles[0].kpis.map((k: any) => k.name)).not.toContain('Budget variance');   // financial KPI stays hidden without finance access
    const k = pkg.knowledge.map((d: any) => d.title); expect(k).toEqual(expect.arrayContaining(['Marketing manager handbook', 'Marketing tools guide', 'Code of conduct'])); expect(k).not.toContain('Finance close SOP'); expect(k).not.toContain('Salary bands');
    expect(pkg.knowledge[0]).toMatchObject({ title: 'Marketing manager handbook', why: 'For your role' });
    expect(pkg.tasks.map((x: any) => x.id)).toContain(t); expect(pkg.access.accessLevel).toBe('member'); expect(pkg.access.byRole[0].permissions.length).toBeGreaterThan(0); expect(pkg.access.note).toMatch(/Reporting lines never grant access/);
    const ids = pkg.checklist.map((i: any) => i.id); expect(ids).toEqual(expect.arrayContaining(['profile', 'objectives', 'manager', `role:${role.id}:responsibilities`, `role:${role.id}:kpis`, 'tasks'])); expect(ids.filter((x: string) => x.startsWith('doc:')).length).toBeGreaterThanOrEqual(3);
    expect(pkg.progress.percent).toBe(0);
    await call(db, 'POST', P('/me/onboarding/profile'), { done: true }, u); await call(db, 'POST', P('/me/onboarding/objectives'), { done: true }, u);
    // a second role: the checklist grows, completed steps stay completed
    const second = await makeRole(db, owner, cid, { name: 'Content Lead', templateKey: 'marketing_manager', departmentId: dM }); await call(db, 'POST', P(`/roles/${second.id}/assignments`), { membershipId: mid }, owner);
    const after = (await call(db, 'GET', P('/me/onboarding'), undefined, u)).body; expect(after.checklist.find((i: any) => i.id === 'profile').done).toBe(true); expect(after.checklist.some((i: any) => i.id === `role:${second.id}:responsibilities`)).toBe(true); expect(after.progress.percent).toBeGreaterThan(0);
    // who may look
    expect((await call(db, 'GET', P(`/employees/${mid}/onboarding`), undefined, mgr.user)).status).toBe(403); expect((await call(db, 'GET', P(`/employees/${mid}/onboarding`), undefined, owner)).status).toBe(200);
    expect((await call(db, 'POST', P(`/employees/${mid}/onboarding/regenerate`), {}, u)).status).toBe(403); expect((await call(db, 'POST', P(`/employees/${mid}/onboarding/regenerate`), {}, owner)).status).toBe(200);
  });
});

describe('employee exit and handover', () => {
  it('preview shows the full handover report without changing anything and without personal data; exit needs members.delete + handover.create', async () => {
    const o = await team(); const prev = await call(db, 'GET', P(`/employees/${o.leaver.membershipId}/exit-preview`), undefined, owner); expect(prev.status).toBe(200); const r = prev.body;
    expect(r.subject).toMatchObject({ kind: 'human', name: 'Teammate', jobTitle: 'Head of Marketing', department: 'Marketing', manager: 'Teammate' });
    expect(r.roles[0]).toMatchObject({ name: 'CMO', isOwner: true, hasApprovalAuthority: true }); expect(r.roles[0].responsibilities).toHaveLength(5); expect(r.roles[0].responsibilities.find((x: any) => x.id === o.resp[0].id).documented).toBe(true);
    expect(r.roles[0].kpis.find((k: any) => k.name === 'Leads generated')).toMatchObject({ target: 500, actual: 420 });
    expect(r.tasks.current.map((t: any) => t.title).sort()).toEqual(['Approve agency contract', 'Launch spring campaign', 'Waiting on design assets']); expect(r.tasks.pending.map((t: any) => t.title)).toEqual(['Draft Q4 content calendar']);
    expect(r.tasks.current.find((t: any) => t.title === 'Launch spring campaign').deliverablesOpen).toEqual(['Creative brief']); expect(r.tasks.current.find((t: any) => t.title === 'Waiting on design assets').waitingOn).toEqual(['Launch spring campaign']);
    expect(r.approvals.map((a: any) => a.title)).toContain('Approve agency contract'); expect(r.projects[0]).toMatchObject({ name: 'Brand refresh', isOwner: true, deliverablesOpen: ['Brand book'] }); expect(r.sops.map((s: any) => s.title)).toContain('Campaign launch SOP'); expect(r.decisions.map((d: any) => d.title)).toContain('Focus on LinkedIn over Instagram');
    expect(r.deliverables.map((d: any) => d.title)).toEqual(expect.arrayContaining(['Creative brief', 'Brand book'])); expect(r.deadlines[0].dueDate <= r.deadlines.at(-1).dueDate).toBe(true); expect(r.dependencies[0]).toMatchObject({ task: 'Waiting on design assets', dependsOn: 'Launch spring campaign', direction: 'blocked_by' });
    expect(r.knowledgeGaps.map((g: any) => g.kind).sort()).toEqual(['gap_project', 'gap_responsibility', 'gap_responsibility', 'gap_responsibility', 'gap_responsibility']); expect(r.recurring[0].title).toBe('Weekly campaign review');
    const { excluded: _doc, ...rest } = r; const json = JSON.stringify(rest); for (const secret of [o.leaver.user.email, '99887 76655', 'Private bio', 'password', 'token']) expect(json.toLowerCase()).not.toContain(secret.toLowerCase());     // no personal data, no credentials
    expect(r.excluded.join(' ')).toMatch(/Credentials/);
    expect((await call(db, 'GET', P(''), undefined, o.leaver.user)).status).toBe(200); expect((await call(db, 'GET', P('/handovers/11111111-1111-4111-8111-111111111111'), undefined, owner)).status).toBe(404);   // nothing changed yet
    const admin = await addMember(db, owner, cid, 'admin'); expect((await call(db, 'GET', P(`/employees/${o.leaver.membershipId}/exit-preview`), undefined, admin.user)).status).toBe(403); expect((await call(db, 'POST', P(`/employees/${o.leaver.membershipId}/exit`), {}, admin.user)).status).toBe(403);
    expect((await call(db, 'POST', P(`/employees/${o.leaver.membershipId}/exit`), {}, o.succ.user)).status).toBe(403);
    const ownerMid = (await call(db, 'GET', P(''), undefined, owner)).body.me.membershipId; expect((await call(db, 'POST', P(`/employees/${ownerMid}/exit`), {}, owner)).status).toBe(403);
  });

  it('exit to another person: access is revoked at once, work moves with the role, history stays, documentation gaps stay open until written', async () => {
    const o = await team(); const before = { tasks: await count('tasks'), comments: await count('task_comments'), activity: await count('task_activity'), versions: await count('knowledge_versions'), decisions: await count('decisions'), kpiValues: await count('kpi_values'), audit: await count('audit_logs') };
    const cfgBefore = await roleDetail(o.cmo.id);
    const ex = await call(db, 'POST', P(`/employees/${o.leaver.membershipId}/exit`), { roleAssignments: [{ roleId: o.cmo.id, to: { membershipId: o.succ.membershipId } }], defaultTo: { membershipId: o.succ.membershipId }, notes: 'Moving abroad' }, owner);
    expect(ex.status, JSON.stringify(ex.body)).toBe(201); expect(ex.body, JSON.stringify(ex.body)).toMatchObject({ status: 'in_progress', pending: 5 });                                         // only the 5 documentation gaps remain
    expect((await call(db, 'GET', P(''), undefined, o.leaver.user)).status).toBe(404); expect((await call(db, 'GET', '/companies', undefined, o.leaver.user)).body.companies).toHaveLength(0); expect((await call(db, 'GET', P('/tasks'), undefined, o.leaver.user)).status).toBe(404);
    const cmo = await roleDetail(o.cmo.id); expect(cmo.role.roleType).toBe('human'); expect(cmo.assignees).toHaveLength(1); expect(cmo.assignees[0]).toMatchObject({ membershipId: o.succ.membershipId, isOwner: true });
    expect(cmo.responsibilities.map((r: any) => r.title)).toEqual(cfgBefore.responsibilities.map((r: any) => r.title)); expect(cmo.kpis.map((k: any) => k.name)).toEqual(cfgBefore.kpis.map((k: any) => k.name)); expect(cmo.role.name).toBe('CMO'); expect(cmo.permissions.length).toBe(cfgBefore.permissions.length);   // the role is untouched
    for (const id of [o.t.t1, o.t.t2, o.t.t3, o.t.t5]) expect((await taskOwner(id)).ownerName, id).toBe('Teammate');                                                    // open work moved (incl. the one awaiting approval)
    const done = await call(db, 'GET', P(`/tasks/${o.t.t4}`), undefined, owner); const hist = (await db.select().from(schema.tasks)).find((t) => t.id === o.t.t4)!; expect(hist.ownerMembershipId).toBe(o.leaver.membershipId); expect(done.body.comments[0].body).toMatch(/12% more leads/);   // completed work keeps its original owner
    expect((await call(db, 'GET', P(`/tasks/${o.t.t1}`), undefined, owner)).body.activity.map((a: any) => a.action)).toContain('handover_reassigned');
    const proj = (await call(db, 'GET', P(`/projects/${o.proj}`), undefined, owner)).body.project; expect(proj.ownerMembershipId).toBe(o.succ.membershipId); expect((await call(db, 'GET', P(`/knowledge/${o.sop}`), undefined, owner)).body.document.ownerMembershipId).toBe(o.succ.membershipId);
    expect((await db.select().from(schema.recurringTasks)).find((r) => r.id === o.rec)!.ownerMembershipId).toBe(o.succ.membershipId);
    const dec = (await call(db, 'GET', P(`/decisions/${o.dec}`), undefined, owner)).body; expect(dec).toMatchObject({ status: 'approved', decisionMaker: 'Teammate' });                          // decisions keep their maker
    const ho = (await call(db, 'GET', P(`/handovers/${ex.body.handoverId}`), undefined, owner)).body; expect(ho).toMatchObject({ reason: 'employee_exit', status: 'in_progress', subjectName: 'Teammate', notes: 'Moving abroad' }); expect(ho.report.roles).toHaveLength(1);
    const st = (k: string) => ho.items.filter((i: any) => i.kind === k).map((i: any) => i.status); expect(st('role')).toEqual(['assigned']); expect(st('task').every((s: string) => s === 'assigned')).toBe(true); expect(st('project')).toEqual(['assigned']); expect(st('document')).toEqual(['assigned']); expect(st('approval')).toEqual(['assigned']); expect(st('gap_responsibility')).toEqual(['pending', 'pending', 'pending', 'pending']); expect(st('gap_project')).toEqual(['pending']);
    expect(ho.roles[0], JSON.stringify(ho.roles[0])).toMatchObject({ role: 'CMO', previousOwner: { name: 'Teammate' }, newOwner: { name: 'Teammate' }, currentOwner: { name: 'Teammate' }, status: 'completed', knowledgeGaps: 4 }); expect(ho.knowledgeGaps).toBe(5); expect(ho.accessChanges.join(' ')).toMatch(/sign-in revoked/);
    // history is preserved
    expect(await count('tasks')).toBe(before.tasks); expect(await count('task_comments')).toBe(before.comments); expect(await count('task_activity')).toBeGreaterThanOrEqual(before.activity); expect(await count('knowledge_versions')).toBe(before.versions); expect(await count('decisions')).toBe(before.decisions); expect(await count('kpi_values')).toBe(before.kpiValues); expect(await count('audit_logs')).toBeGreaterThan(before.audit);
    const mem: any = await db.execute(`select status, removed_at from company_memberships where id = '${o.leaver.membershipId}'` as any); expect((mem.rows ?? mem)[0]).toMatchObject({ status: 'removed' });
    const asg: any = await db.execute(`select count(*)::int n, count(ended_at)::int e from role_assignments where membership_id = '${o.leaver.membershipId}'` as any); expect((asg.rows ?? asg)[0]).toEqual({ n: 1, e: 1 });                          // assignment ended, not deleted
    expect((await call(db, 'GET', P('/audit'), undefined, owner)).body.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['employee.exit', 'handover.started', 'role.ownership_transferred']));
    // onboarding of the successor reflects what they inherited
    const pkg = (await call(db, 'GET', P('/me/onboarding'), undefined, o.succ.user)).body; expect(pkg.roles[0].name).toBe('CMO'); expect(pkg.tasks.filter((t: any) => t.handedOver)).toHaveLength(4); expect(pkg.checklist.some((i: any) => i.id === 'tasks' && /handed over/.test(i.title))).toBe(true);
    // gaps close as the documents get written; then the handover completes by itself
    const open = ho.items.filter((i: any) => i.status === 'pending'); expect(open).toHaveLength(5);
    for (const g of open) await mkDoc(o.succ.user, g.kind === 'gap_project' ? { title: 'Brand refresh doc', docType: 'project_doc', projectId: g.refId, body: 'How the project runs' } : { title: `SOP ${g.refId.slice(0, 4)}`, docType: 'sop', responsibilityId: g.refId, body: 'Procedure' });   // the successor may write them: knowledge.create comes with the role
    const fin = (await call(db, 'GET', P(`/handovers/${ex.body.handoverId}`), undefined, owner)).body; expect(fin.status).toBe('completed'); expect(fin.progress).toBe(100); expect(fin.roles[0].knowledgeGaps).toBe(0); expect(fin.knowledgeGaps).toBe(0);
  });

  it('exit to the manager, or leaving work unassigned: pending items stay visible and can be assigned later (item or bulk), skipped with a reason, or resolved', async () => {
    const o = await team();
    const ex = await call(db, 'POST', P(`/employees/${o.leaver.membershipId}/exit`), { roleAssignments: [], taskPolicy: 'none' }, owner); const id = ex.body.handoverId;
    expect(ex.body.status).toBe('in_progress'); let ho = (await call(db, 'GET', P(`/handovers/${id}`), undefined, owner)).body;
    expect((await roleDetail(o.cmo.id)).role.roleType).toBe('vacant'); expect(ho.roles[0]).toMatchObject({ status: 'pending', newOwner: null, currentOwner: null, previousOwner: { name: 'Teammate' } }); expect((await taskOwner(o.t.t1)).ownerName).toBe('Teammate'); // the leaver still shows as owner of tasks until reassigned
    const hasPending = (k: string) => ho.items.filter((i: any) => i.kind === k && i.status === 'pending').length; expect(hasPending('role')).toBe(1); expect(hasPending('task')).toBe(4); expect(ho.pendingByKind.role).toBe(1);
    const roleItem = ho.items.find((i: any) => i.kind === 'role');
    expect((await call(db, 'POST', P(`/handovers/${id}/assign`), { itemId: roleItem.id, to: { manager: true } }, o.succ.user)).status).toBe(403);
    const asg = await call(db, 'POST', P(`/handovers/${id}/assign`), { itemId: roleItem.id, to: { manager: true } }, owner); expect(asg.status, JSON.stringify(asg.body)).toBe(200);   // "manager" = the leaver's manager
    expect((await roleDetail(o.cmo.id)).assignees[0]).toMatchObject({ membershipId: o.mgr.membershipId, isOwner: true });
    const mgrTasks = await call(db, 'GET', P('/tasks?mine=1'), undefined, o.mgr.user); expect(mgrTasks.body.tasks.map((t: any) => t.title).sort()).toEqual(['Approve agency contract', 'Draft Q4 content calendar', 'Launch spring campaign', 'Waiting on design assets']);
    const gap = ho.items.find((i: any) => i.kind === 'gap_responsibility'); expect((await call(db, 'POST', P(`/handovers/${id}/items/${gap.id}/resolve`), { status: 'done' }, owner)).status).toBe(409); expect((await call(db, 'POST', P(`/handovers/${id}/items/${gap.id}/resolve`), { status: 'skipped' }, owner)).status).toBe(400);
    expect((await call(db, 'POST', P(`/handovers/${id}/assign`), { itemId: gap.id, to: { manager: true } }, owner)).status).toBe(400);
    ho = (await call(db, 'GET', P(`/handovers/${id}`), undefined, owner)).body; for (const g of ho.items.filter((i: any) => i.kind.startsWith('gap_') && i.status === 'pending')) expect((await call(db, 'POST', P(`/handovers/${id}/items/${g.id}/resolve`), { status: 'skipped', note: 'Covered in onboarding' }, owner)).status).toBe(200);
    expect((await call(db, 'POST', P(`/handovers/${id}/assign`), { kind: 'project', to: { membershipId: o.succ.membershipId } }, owner)).body.assigned).toBe(1);
    await call(db, 'POST', P(`/handovers/${id}/assign`), { kind: 'document', to: { membershipId: o.succ.membershipId } }, owner); await call(db, 'POST', P(`/handovers/${id}/assign`), { kind: 'approval', to: { membershipId: o.mgr.membershipId } }, owner); await call(db, 'POST', P(`/handovers/${id}/assign`), { kind: 'recurring', to: { membershipId: o.succ.membershipId } }, owner);
    const fin = (await call(db, 'GET', P(`/handovers/${id}`), undefined, owner)).body; expect(fin).toMatchObject({ status: 'completed', progress: 100 }); expect(fin.items.filter((i: any) => i.status === 'pending')).toEqual([]);   // completes by itself once nothing is pending
    expect((await call(db, 'POST', P(`/handovers/${id}/assign`), { to: { membershipId: o.succ.membershipId } }, owner)).status).toBe(409);     // already completed
  });

  it('exit needs the permissions of every transfer it performs, and a refusal changes nothing', async () => {
    const o = await team(); const r = await makeRole(db, owner, cid, { name: 'HR admin' }); await grant(r.id, [['company.view', 'company'], ['members.delete', 'company'], ['handover.create', 'company'], ['handover.view', 'company']]); const hr = await addMember(db, owner, cid, 'member', r.id);
    const blocked = await call(db, 'POST', P(`/employees/${o.leaver.membershipId}/exit`), { roleAssignments: [{ roleId: o.cmo.id, to: { membershipId: o.succ.membershipId } }] }, hr.user); expect(blocked.status).toBe(403); expect(blocked.body.error).toMatch(/roles\.assign|tasks\.assign/);
    expect((await call(db, 'GET', P(''), undefined, o.leaver.user)).status).toBe(200); expect((await roleDetail(o.cmo.id)).assignees[0].membershipId).toBe(o.leaver.membershipId); expect(await count('handovers')).toBe(0);
    expect((await call(db, 'POST', P(`/employees/${o.leaver.membershipId}/exit`), { roleAssignments: [{ roleId: o.cmo.id, to: { membershipId: o.leaver.membershipId } }] }, owner)).status).toBe(400);   // cannot hand over to yourself
    expect((await call(db, 'POST', P(`/employees/${o.leaver.membershipId}/exit`), { roleAssignments: [{ roleId: o.cmo.id, to: { membershipId: '11111111-1111-4111-8111-111111111111' } }] }, owner)).status).toBe(400);
    expect((await call(db, 'POST', P(`/employees/${o.leaver.membershipId}/exit`), { roleAssignments: [{ roleId: o.cmo.id, to: { membershipId: o.succ.membershipId, manager: true } }] }, owner)).status).toBe(400);
    const own = await call(db, 'POST', P(`/employees/${o.leaver.membershipId}/exit`), { roleAssignments: [], taskPolicy: 'none' }, hr.user); expect(own.status).toBe(201);          // exit alone only needs members.delete + handover.create
    expect((await call(db, 'GET', P(''), undefined, o.leaver.user)).status).toBe(404);
    expect((await call(db, 'GET', P(`/employees/${o.leaver.membershipId}/exit-preview`), undefined, owner)).status).toBe(404);                                                         // cannot be offboarded twice
  });

  it('handover reports export to CSV and PDF for people with handover.view; no personal data or credentials appear', async () => {
    const o = await team(); const ex = await call(db, 'POST', P(`/employees/${o.leaver.membershipId}/exit`), { roleAssignments: [{ roleId: o.cmo.id, to: { membershipId: o.succ.membershipId } }], defaultTo: { membershipId: o.succ.membershipId } }, owner); const id = ex.body.handoverId;
    const csv = await raw(P(`/handovers/${id}/export?format=csv`), owner); expect(csv.status).toBe(200); const text = new TextDecoder().decode(await csv.arrayBuffer()); for (const s of ['Handover Report — Teammate', 'Roles & responsibilities', 'Launch spring campaign', 'Knowledge gaps', 'Campaign launch SOP', 'Leads generated']) expect(text).toContain(s);
    for (const secret of [o.leaver.user.email, '99887 76655', 'Private bio']) expect(text).not.toContain(secret);
    const pdf = await raw(P(`/handovers/${id}/export?format=pdf`), owner); expect(pdf.status).toBe(200); expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');
    expect((await raw(P(`/handovers/${id}/export?format=xlsx`), owner)).status).toBe(400); expect((await raw(P(`/handovers/${id}/export?format=csv`), o.mgr.user)).status).toBe(403); expect((await raw(P(`/handovers/${id}/export?format=csv`), null)).status).toBe(401);
    const other = await signup(db); await makeCompany(db, other); expect((await raw(P(`/handovers/${id}/export?format=csv`), other)).status).toBe(404); expect((await call(db, 'GET', P(`/handovers/${id}`), undefined, other)).status).toBe(404);
  });
});

describe('human-to-AI transition (the employee leaves, an AI employee takes over what it is authorised to)', () => {
  const scripted = () => registerProvider({ id: 'scripted', label: 'Scripted', setupHint: '', isConfigured: () => true, async complete() { return { text: JSON.stringify({ summary: 'ok', proposals: [] }), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }; } } as AiProvider);
  const agent = async (active = true) => { scripted(); const a = await call(db, 'POST', P('/agents'), { name: 'AI CMO', config: { provider: 'scripted', model: 'm', autonomyLevel: 3 } }, owner); if (active) await call(db, 'POST', P(`/agents/${a.body.agent.id}/status`), { status: 'active' }, owner); return a.body.agent.id as string; };
  it('only responsibilities that need no approval move to the AI; approval-bound work, approval authority, projects and documents stay with people; the AI gets no permissions; every step is audited', async () => {
    const o = await team(); const ai = await agent(); const inactive = await agent(false);
    expect((await call(db, 'POST', P(`/employees/${o.leaver.membershipId}/exit`), { roleAssignments: [{ roleId: o.cmo.id, to: { agentId: inactive } }] }, owner)).status).toBe(400);   // must be active
    expect((await call(db, 'GET', P(''), undefined, o.leaver.user)).status).toBe(200);
    const ex = await call(db, 'POST', P(`/employees/${o.leaver.membershipId}/exit`), { roleAssignments: [{ roleId: o.cmo.id, to: { agentId: ai } }], defaultTo: { agentId: ai }, approverMembershipId: o.mgr.membershipId }, owner); expect(ex.status, JSON.stringify(ex.body)).toBe(201); const id = ex.body.handoverId;
    const cmo = await roleDetail(o.cmo.id); expect(cmo.role.roleType).toBe('ai'); expect(cmo.assignees[0]).toMatchObject({ kind: 'ai', isOwner: true });
    const prof = (await call(db, 'GET', P(`/agents/${ai}`), undefined, owner)).body; const sel = new Set(prof.responsibilities.selected); const needsApproval = cmo.responsibilities.filter((r: any) => r.requiresApproval), free = cmo.responsibilities.filter((r: any) => !r.requiresApproval);
    expect(needsApproval.length).toBeGreaterThan(0); for (const r of free) expect(sel.has(r.id)).toBe(true); for (const r of needsApproval) expect(sel.has(r.id)).toBe(false);     // sensitive responsibilities stay with humans
    expect((await taskOwner(o.t.t1)).ownerKind).toBe('ai'); expect((await taskOwner(o.t.t2)).ownerKind).toBe('ai'); expect((await taskOwner(o.t.t5)).ownerKind).toBe('ai');
    expect(await taskOwner(o.t.t3)).toMatchObject({ ownerKind: 'human', ownerName: 'Teammate' });                                                                                    // needs approval → goes to the approver, not the AI
    const proj = (await call(db, 'GET', P(`/projects/${o.proj}`), undefined, owner)).body.project; expect(proj.ownerMembershipId).toBe(o.leaver.membershipId);                       // AI cannot own projects → still pending
    const ho = (await call(db, 'GET', P(`/handovers/${id}`), undefined, owner)).body; const pend = ho.items.filter((i: any) => i.status === 'pending').map((i: any) => i.kind); expect(pend).toEqual(expect.arrayContaining(['project', 'document']));
    expect(ho.roles[0].accessChanges.join(' ')).toMatch(/Approval authority cannot pass to AI: it stays with Teammate/); expect(ho.roles[0].accessChanges.join(' ')).toMatch(/AI employees get no user permissions/); expect(ho.roles[0].newOwner.name).toBe('◉ AI CMO');
    expect((await call(db, 'POST', P(`/handovers/${id}/assign`), { kind: 'project', to: { agentId: ai } }, owner)).body).toMatchObject({ assigned: 0 }); expect((await call(db, 'POST', P(`/handovers/${id}/assign`), { kind: 'project', to: { membershipId: o.succ.membershipId } }, owner)).body.assigned).toBe(1);
    await call(db, 'POST', P(`/handovers/${id}/assign`), { kind: 'document', to: { membershipId: o.succ.membershipId } }, owner);
    expect((await call(db, 'GET', P('/me/onboarding'), undefined, o.succ.user)).status).toBe(200);
    const users = await db.select().from(schema.users); expect(users.some((u) => /AI CMO/.test(u.name))).toBe(false);                                                               // AI has no account or credentials
    expect((await call(db, 'GET', P('/audit'), undefined, owner)).body.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['employee.exit', 'handover.started', 'role.ownership_transferred', 'handover.item_assigned']));
    expect((await call(db, 'POST', P(`/handovers/${id}/assign`), { kind: 'task', to: { agentId: ai } }, o.succ.user)).status).toBe(403);
  });
  it('a later hand-off of approval-bound tasks to an AI reports them as skipped instead of moving them', async () => {
    const o = await team(); const ai = await agent(); const ex = await call(db, 'POST', P(`/employees/${o.leaver.membershipId}/exit`), { taskPolicy: 'none' }, owner); const id = ex.body.handoverId;
    const r = await call(db, 'POST', P(`/handovers/${id}/assign`), { kind: 'task', to: { agentId: ai } }, owner); expect(r.body.skipped).toEqual(['Task: Approve agency contract']); expect(r.body.assigned).toBe(3);
    expect((await taskOwner(o.t.t3)).ownerKind).toBe('human'); expect((await taskOwner(o.t.t1)).ownerKind).toBe('ai');
  });
});

describe('AI-to-human transition', () => {
  const scripted = () => registerProvider({ id: 'scripted', label: 'Scripted', setupHint: '', isConfigured: () => true, async complete() { return { text: JSON.stringify({ summary: 'ok', proposals: [] }), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }; } } as AiProvider);
  async function aiSetup() {
    scripted(); const dept = (await call(db, 'POST', P('/departments'), { name: 'Marketing' }, owner)).body.department.id; const cmo = await makeRole(db, owner, cid, { name: 'CMO', templateKey: 'cmo', departmentId: dept });
    const a = await call(db, 'POST', P('/agents'), { name: 'AI CMO', roleId: cmo.id, config: { provider: 'scripted', model: 'm', autonomyLevel: 4, knowledgeScope: 'role', instructions: 'Be concise' } }, owner); const ai = a.body.agent.id as string; await call(db, 'POST', P(`/agents/${ai}/status`), { status: 'active' }, owner);
    const human = await addMember(db, owner, cid), outsider = await addMember(db, owner, cid);
    const open1 = await mkTask(owner, { title: 'Competitor research', roleId: cmo.id, owner: { agentId: ai }, dueDate: D(4) }), open2 = await mkTask(owner, { title: 'Campaign analysis', roleId: cmo.id, owner: { agentId: ai }, dueDate: D(9) });
    const done = await mkTask(owner, { title: 'Weekly report (done)', roleId: cmo.id, owner: { agentId: ai } }); await db.update(schema.tasks).set({ status: 'completed', completedAt: new Date() }).where(eq(schema.tasks.id, done));
    const conf = await mkDoc(owner, { title: 'Brand strategy', visibility: 'restricted', confidential: true, body: 'strategy' }); await call(db, 'PUT', P(`/knowledge/${conf}/access`), { grants: [{ scopeType: 'agent', scopeId: ai }] }, owner);
    const rec = (await call(db, 'POST', P('/recurring-tasks'), { title: 'AI weekly digest', cadence: 'weekly', owner: { agentId: ai }, startOn: D(3) }, owner)).body.recurring.id;
    return { dept, cmo, ai, human, outsider, open1, open2, done, conf, rec };
  }
  it('the human becomes owner, the AI stays as an assistant with reduced autonomy; configuration, history, KPIs and knowledge access are preserved', async () => {
    const o = await aiSetup(); const before = await roleDetail(o.cmo.id); const cfgV = (await call(db, 'GET', P(`/agents/${o.ai}`), undefined, owner)).body.config.version;
    const r = await call(db, 'POST', P('/transitions/ai-to-human'), { agentId: o.ai, toMembershipId: o.human.membershipId, keepAsAssistant: true, assistantAutonomy: 2 }, owner); expect(r.status, JSON.stringify(r.body)).toBe(201); expect(r.body).toMatchObject({ status: 'in_progress', pending: 5 });   // the five undocumented responsibilities are flagged for the new owner
    const after = await roleDetail(o.cmo.id); expect(after.role.roleType).toBe('hybrid'); expect(after.assignees.map((a: any) => `${a.kind}:${a.isOwner}`).sort()).toEqual(['ai:false', 'human:true']);
    expect(after.responsibilities.map((x: any) => x.title)).toEqual(before.responsibilities.map((x: any) => x.title)); expect(after.kpis.map((k: any) => k.name)).toEqual(before.kpis.map((k: any) => k.name)); expect(after.rules.length).toBe(before.rules.length); expect(after.permissions.length).toBe(before.permissions.length);
    const prof = (await call(db, 'GET', P(`/agents/${o.ai}`), undefined, owner)).body; expect(prof.config.autonomyLevel).toBe(2); expect(prof.config.version).toBe(cfgV + 1); expect(prof.config.instructions).toBe('Be concise'); expect(prof.agent.managerName).toBe('Teammate'); expect(prof.assignments).toHaveLength(1); expect(prof.assignments[0].isOwner).toBe(false);
    expect((await taskOwner(o.open1)).ownerName).toBe('Teammate'); expect((await taskOwner(o.open2)).ownerKind).toBe('human'); const hist = (await db.select().from(schema.tasks)).find((t) => t.id === o.done)!; expect(hist.ownerAgentId).toBe(o.ai); expect(hist.status).toBe('completed');   // task history stays with the AI
    expect((await db.select().from(schema.recurringTasks)).find((x) => x.id === o.rec)!.ownerMembershipId).toBe(o.human.membershipId);
    expect((await call(db, 'GET', P(`/knowledge/${o.conf}`), undefined, o.human.user)).status).toBe(200); expect((await call(db, 'GET', P(`/knowledge/${o.conf}`), undefined, o.outsider.user)).status).toBe(404);   // the human inherits the AI's document grants
    expect((await call(db, 'GET', P('/my-roles'), undefined, o.human.user)).body.roles[0].name).toBe('CMO');
    const ho = (await call(db, 'GET', P(`/handovers/${r.body.handoverId}`), undefined, owner)).body; expect(ho).toMatchObject({ reason: 'ai_to_human', subjectKind: 'ai', subjectName: 'AI CMO', status: 'in_progress' }); expect(ho.knowledgeGaps).toBe(5); const rt = ho.roles[0]; expect(rt).toMatchObject({ role: 'CMO', previousOwner: { name: '◉ AI CMO' }, newOwner: { name: 'Teammate' }, assistant: { name: '◉ AI CMO' }, status: 'completed' });
    expect(rt.accessChanges.join(' ')).toMatch(/stays as an assistant/); expect(ho.accessChanges.join(' ')).toMatch(/autonomy is now Level 2/); expect(ho.report.subject.kind).toBe('ai');
    expect((await call(db, 'GET', P('/notifications'), undefined, o.human.user)).body.notifications.some((n: any) => /handed work over to you|You now hold|Task handed over/.test(n.title))).toBe(true);
    expect((await call(db, 'GET', P('/audit'), undefined, owner)).body.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['transition.ai_to_human', 'role.ownership_transferred']));
    const pkg = (await call(db, 'GET', P('/me/onboarding'), undefined, o.human.user)).body; expect(pkg.roles[0].name).toBe('CMO'); expect(pkg.tasks.map((t: any) => t.title)).toEqual(expect.arrayContaining(['Competitor research', 'Campaign analysis']));
  });
  it('without the assistant option the AI leaves the role; autonomy is only ever lowered; permissions and targets are enforced', async () => {
    const o = await aiSetup(); const plain = await addMember(db, owner, cid);
    expect((await call(db, 'POST', P('/transitions/ai-to-human'), { agentId: o.ai, toMembershipId: o.human.membershipId }, plain.user)).status).toBe(403);
    expect((await call(db, 'POST', P('/transitions/ai-to-human'), { agentId: o.ai, toMembershipId: '11111111-1111-4111-8111-111111111111' }, owner)).status).toBe(400);
    expect((await call(db, 'POST', P('/transitions/ai-to-human'), { agentId: '11111111-1111-4111-8111-111111111111', toMembershipId: o.human.membershipId }, owner)).status).toBe(404);
    const r = await call(db, 'POST', P('/transitions/ai-to-human'), { agentId: o.ai, toMembershipId: o.human.membershipId, keepAsAssistant: false }, owner); expect(r.status).toBe(201);
    const role = await roleDetail(o.cmo.id); expect(role.role.roleType).toBe('human'); expect(role.assignees).toHaveLength(1); expect(role.assignees[0].kind).toBe('human');
    const prof = (await call(db, 'GET', P(`/agents/${o.ai}`), undefined, owner)).body; expect(prof.assignments).toHaveLength(0); expect(prof.config.autonomyLevel).toBe(4); expect(prof.usage).toBeDefined();   // the agent and its history still exist
    expect((await call(db, 'POST', P('/transitions/ai-to-human'), { agentId: o.ai, toMembershipId: o.human.membershipId }, owner)).status).toBe(400);              // holds no role any more
    // an assistant already below the requested level is not raised
    scripted(); const low = await call(db, 'POST', P('/agents'), { name: 'AI Low', roleId: (await makeRole(db, owner, cid, { name: 'Ops' })).id, config: { provider: 'scripted', model: 'm', autonomyLevel: 1 } }, owner); const lr = await call(db, 'POST', P('/transitions/ai-to-human'), { agentId: low.body.agent.id, toMembershipId: o.outsider.membershipId, assistantAutonomy: 3 }, owner); expect(lr.status).toBe(201);
    expect((await call(db, 'GET', P(`/agents/${low.body.agent.id}`), undefined, owner)).body.config.autonomyLevel).toBe(1);
  });
});

describe('role ownership transfer and the transition dashboard', () => {
  it('moves a role between people (previous owner removed or kept), hands over only that role\'s tasks, and records it', async () => {
    const o = await team(); const r = await call(db, 'POST', P(`/roles/${o.cmo.id}/transfer`), { to: { membershipId: o.succ.membershipId }, previous: 'remove', notes: 'Promotion' }, owner); expect(r.status, JSON.stringify(r.body)).toBe(201);
    let cmo = await roleDetail(o.cmo.id); expect(cmo.assignees).toHaveLength(1); expect(cmo.assignees[0]).toMatchObject({ membershipId: o.succ.membershipId, isOwner: true });
    expect((await taskOwner(o.t.t1)).ownerName).toBe('Teammate'); const t1 = (await db.select().from(schema.tasks)).find((t) => t.id === o.t.t1)!; expect(t1.ownerMembershipId).toBe(o.succ.membershipId);
    expect((await call(db, 'GET', P(''), undefined, o.leaver.user)).status).toBe(200);                                                                   // a role change is not an exit: the person keeps their account
    expect((await call(db, 'GET', P(`/handovers/${r.body.handoverId}`), undefined, owner)).body).toMatchObject({ reason: 'role_reassignment', notes: 'Promotion' });
    const back = await call(db, 'POST', P(`/roles/${o.cmo.id}/transfer`), { to: { membershipId: o.leaver.membershipId }, previous: 'keep', transferTasks: false }, owner); expect(back.status).toBe(201);
    cmo = await roleDetail(o.cmo.id); expect(cmo.assignees.map((a: any) => a.isOwner).sort()).toEqual([false, true]); expect(cmo.assignees.find((a: any) => a.isOwner).membershipId).toBe(o.leaver.membershipId);
    expect((await call(db, 'POST', P(`/roles/${o.cmo.id}/transfer`), { to: { membershipId: o.succ.membershipId } }, o.mgr.user)).status).toBe(403); expect((await call(db, 'POST', P(`/roles/${o.cmo.id}/transfer`), { to: {} }, owner)).status).toBe(400);
    const vacant = await makeRole(db, owner, cid, { name: 'Vacant lead' }); const v = await call(db, 'POST', P(`/roles/${vacant.id}/transfer`), { to: { membershipId: o.mgr.membershipId } }, owner); expect(v.status).toBe(201); expect((await call(db, 'GET', P(`/handovers/${v.body.handoverId}`), undefined, owner)).body).toMatchObject({ subjectName: 'Vacant role' }); expect((await roleDetail(vacant.id)).assignees[0].membershipId).toBe(o.mgr.membershipId);
  });

  it('the dashboard shows current / previous / new owner, status, pending items, knowledge gaps, access changes and progress per transition', async () => {
    const o = await team(); const ex = await call(db, 'POST', P(`/employees/${o.leaver.membershipId}/exit`), { taskPolicy: 'none' }, owner); const id = ex.body.handoverId;
    let list = (await call(db, 'GET', P('/transitions'), undefined, owner)).body.transitions; const t = list.find((x: any) => x.id === id);
    expect(t).toMatchObject({ reason: 'employee_exit', status: 'in_progress', subjectName: 'Teammate', knowledgeGaps: 5 }); expect(t.progress).toBeLessThan(100); expect(t.items.pending).toBeGreaterThan(8); expect(t.pendingByKind).toMatchObject({ role: 1, gap_responsibility: 4, gap_project: 1 });
    expect(t.roles[0], JSON.stringify(t.roles[0])).toMatchObject({ role: 'CMO', status: 'pending', previousOwner: { name: 'Teammate', kind: 'human' }, newOwner: null, currentOwner: null, knowledgeGaps: 4 }); expect(t.roles[0].pendingItems).toBeGreaterThanOrEqual(5); expect(t.accessChanges.length).toBeGreaterThan(2);
    await call(db, 'POST', P(`/roles/${o.cmo.id}/transfer`), { to: { membershipId: o.succ.membershipId }, previous: 'keep' }, owner);
    expect((await call(db, 'GET', P('/transitions?status=in_progress'), undefined, owner)).body.transitions.map((x: any) => x.id)).toContain(id); expect((await call(db, 'GET', P('/transitions?status=completed'), undefined, owner)).body.transitions.map((x: any) => x.reason)).toContain('role_reassignment');
    for (const kind of ['role', 'task', 'approval', 'project', 'document', 'recurring']) await call(db, 'POST', P(`/handovers/${id}/assign`), { kind, to: { membershipId: o.succ.membershipId } }, owner);
    const h = (await call(db, 'GET', P(`/handovers/${id}`), undefined, owner)).body; for (const g of h.items.filter((i: any) => i.status === 'pending')) await call(db, 'POST', P(`/handovers/${id}/items/${g.id}/resolve`), { status: 'skipped', note: 'n/a' }, owner);
    list = (await call(db, 'GET', P('/transitions'), undefined, owner)).body.transitions; expect(list.find((x: any) => x.id === id)).toMatchObject({ status: 'completed', progress: 100, knowledgeGaps: 0 });
    const plain = await addMember(db, owner, cid); expect((await call(db, 'GET', P('/transitions'), undefined, plain.user)).status).toBe(403);
    const other = await signup(db); await makeCompany(db, other); expect((await call(db, 'GET', P('/transitions'), undefined, other)).status).toBe(404);
  });

  it('tenant isolation: another company can neither see nor start handovers, nor hand work to people here', async () => {
    const o = await team(); const other = await signup(db); const oc = await makeCompany(db, other); const foreign = await addMember(db, other, oc);
    for (const [m, p, b] of [['GET', `/employees/${o.leaver.membershipId}/exit-preview`], ['POST', `/employees/${o.leaver.membershipId}/exit`, {}], ['POST', `/roles/${o.cmo.id}/transfer`, { to: { membershipId: o.succ.membershipId } }], ['POST', '/transitions/ai-to-human', { agentId: o.cmo.id, toMembershipId: o.succ.membershipId }], ['GET', '/transitions']] as any[]) expect((await call(db, m, P(p), b, other)).status, `${m} ${p}`).toBe(404);
    expect((await call(db, 'POST', P(`/roles/${o.cmo.id}/transfer`), { to: { membershipId: foreign.membershipId } }, owner)).status).toBe(400); expect((await call(db, 'POST', P(`/employees/${o.leaver.membershipId}/exit`), { roleAssignments: [{ roleId: o.cmo.id, to: { membershipId: foreign.membershipId } }] }, owner)).status).toBe(400);
    expect((await call(db, 'GET', P('/transitions', oc), undefined, other)).body.transitions).toEqual([]);
  });
});
