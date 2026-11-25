import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { schema } from '@/db/client';
import { addMember, call, makeCompany, makeRole, newDb, resetRateLimits, signup, type Client } from './helpers';

let db: Db; let owner: Client; let cid: string;
const P = (p: string, id = cid) => `/companies/${id}${p}`;
beforeAll(async () => { process.env.EXPOSE_DEV_LINKS = '1'; db = await newDb(); });
beforeEach(async () => { resetRateLimits(); owner = await signup(db, 'Founder'); cid = await makeCompany(db, owner); });
const rows = async (q: string) => { const r: any = await db.execute(q as any); return r.rows ?? r; };

describe('human employee management', () => {
  it('invitation carries department, manager, title and several roles; accepting creates the profile and onboarding checklist', async () => {
    const dept = (await call(db, 'POST', P('/departments'), { name: 'Marketing' }, owner)).body.department;
    const r1 = await makeRole(db, owner, cid, { name: 'Marketing Manager', departmentId: dept.id });
    const r2 = await makeRole(db, owner, cid, { name: 'Content Lead', departmentId: dept.id });
    const ownerMid = (await call(db, 'GET', P(''), undefined, owner)).body.me.membershipId;
    const u = await signup(db, 'Riya');
    const inv = await call(db, 'POST', P('/invites'), { email: u.email, roleIds: [r1.id, r2.id], departmentId: dept.id, managerMembershipId: ownerMid, jobTitle: 'Marketing lead' }, owner);
    expect(inv.status).toBe(201);
    expect((await call(db, 'POST', '/invites/accept', { token: new URL(inv.body.devLink).searchParams.get('token') }, u)).status).toBe(200);
    const list = (await call(db, 'GET', P('/employees'), undefined, owner)).body.employees;
    const e = list.find((x: any) => x.userId === u.id);
    expect(e).toMatchObject({ name: 'Riya', jobTitle: 'Marketing lead', departmentName: 'Marketing', managerName: 'Founder', status: 'active' });
    expect(e.roles.map((r: any) => r.roleName).sort()).toEqual(['Content Lead', 'Marketing Manager']);
    const mine = (await call(db, 'GET', P('/me/profile'), undefined, u)).body;
    const ids = mine.onboarding.map((i: any) => i.id); expect(ids).toEqual(expect.arrayContaining(['profile', 'objectives', 'manager', `role:${r1.id}:responsibilities`, `role:${r2.id}:responsibilities`]));   // Phase 4: role-specific checklist
    const done = await call(db, 'POST', P('/me/onboarding/profile'), { done: true }, u);
    expect(done.body.onboarding.find((i: any) => i.id === 'profile').done).toBe(true);
    expect((await call(db, 'PATCH', P('/me/profile'), { phone: '+91 99999 00000', bio: 'Hi' }, u)).body.profile.phone).toBe('+91 99999 00000');
    expect((await call(db, 'POST', P('/me/onboarding/nope'), { done: true }, u)).status).toBe(404);
  });

  it('rejects invalid presets (foreign department, inactive manager) and unauthorised invites', async () => {
    const other = await signup(db); const oc = await makeCompany(db, other);
    const fd = (await call(db, 'POST', P('/departments', oc), { name: 'Foreign' }, other)).body.department;
    expect((await call(db, 'POST', P('/invites'), { email: 'x@example.com', departmentId: fd.id }, owner)).status).toBe(400);
    expect((await call(db, 'POST', P('/invites'), { email: 'x@example.com', managerMembershipId: '11111111-1111-4111-8111-111111111111' }, owner)).status).toBe(400);
    const { user } = await addMember(db, owner, cid, 'member');
    expect((await call(db, 'POST', P('/invites'), { email: 'y@example.com' }, user)).status).toBe(403);
  });

  it('several employees can share a department; profile edits need members.edit; manager loops are refused', async () => {
    const dept = (await call(db, 'POST', P('/departments'), { name: 'Sales' }, owner)).body.department;
    const a = await addMember(db, owner, cid), b = await addMember(db, owner, cid), c = await addMember(db, owner, cid);
    for (const m of [a, b, c]) expect((await call(db, 'PATCH', P(`/employees/${m.membershipId}`), { departmentId: dept.id, jobTitle: 'Rep' }, owner)).status).toBe(200);
    const dir = (await call(db, 'GET', P('/workforce/directory'), undefined, owner)).body;
    expect(dir.people.filter((p: any) => p.departmentName === 'Sales')).toHaveLength(3);
    expect((await call(db, 'PATCH', P(`/employees/${a.membershipId}`), { managerMembershipId: b.membershipId }, owner)).status).toBe(200);
    expect((await call(db, 'PATCH', P(`/employees/${b.membershipId}`), { managerMembershipId: a.membershipId }, owner)).status).toBe(400); // loop
    expect((await call(db, 'PATCH', P(`/employees/${a.membershipId}`), { managerMembershipId: a.membershipId }, owner)).status).toBe(400);
    expect((await call(db, 'PATCH', P(`/employees/${a.membershipId}`), { jobTitle: 'Boss' }, b.user)).status).toBe(403);
    expect((await call(db, 'GET', P(`/employees/${a.membershipId}`), undefined, owner)).body.directReports).toEqual([]);
    expect((await call(db, 'GET', P(`/employees/${b.membershipId}`), undefined, owner)).body.directReports.map((d: any) => d.name)).toEqual(['Teammate']);
  });

  it('per-person permissions can be assigned to a plain member', async () => {
    const m = await addMember(db, owner, cid);
    expect((await call(db, 'GET', P('/roles'), undefined, m.user)).status).toBe(403);
    expect((await call(db, 'PUT', P(`/members/${m.membershipId}/permissions`), { keys: ['company.view', 'roles.view'] }, owner)).status).toBe(200);
    expect((await call(db, 'GET', P('/roles'), undefined, m.user)).status).toBe(200);
  });

  it('deactivation cuts access immediately, vacates roles, promotes a new owner; reactivation restores access only', async () => {
    const role = await makeRole(db, owner, cid, { name: 'Ops Manager' });
    const a = await addMember(db, owner, cid, 'member', role.id), b = await addMember(db, owner, cid, 'member', role.id);
    let d = (await call(db, 'GET', P(`/roles/${role.id}`), undefined, owner)).body;
    expect(d.assignees.find((x: any) => x.isOwner).membershipId).toBe(a.membershipId); // first assignee owns the role
    const off = await call(db, 'POST', P(`/employees/${a.membershipId}/deactivate`), {}, owner);
    expect(off.body.rolesVacated).toBe(1);
    expect((await call(db, 'GET', P(''), undefined, a.user)).status).toBe(404);
    expect((await call(db, 'GET', '/companies', undefined, a.user)).body.companies).toHaveLength(0);
    d = (await call(db, 'GET', P(`/roles/${role.id}`), undefined, owner)).body;
    expect(d.role.roleType).toBe('human'); expect(d.assignees).toHaveLength(1);
    expect(d.assignees[0]).toMatchObject({ membershipId: b.membershipId, isOwner: true }); // ownership passed on
    const emp = (await call(db, 'GET', P('/employees'), undefined, owner)).body.employees.find((x: any) => x.membershipId === a.membershipId);
    expect(emp.status).toBe('inactive');
    expect((await call(db, 'PATCH', P(`/employees/${a.membershipId}`), { jobTitle: 'x' }, owner)).status).toBe(400);
    expect((await call(db, 'POST', P(`/employees/${a.membershipId}/deactivate`), {}, owner)).status).toBe(400);
    expect((await call(db, 'POST', P(`/employees/${a.membershipId}/reactivate`), {}, owner)).status).toBe(200);
    expect((await call(db, 'GET', P(''), undefined, a.user)).status).toBe(200);
    expect((await call(db, 'GET', P('/my-roles'), undefined, a.user)).body.roles).toHaveLength(0); // assignments are not silently restored
    const ended = await rows(`select count(*)::int n from role_assignments where membership_id = '${a.membershipId}' and ended_at is not null`);
    expect(ended[0].n).toBe(1);                                                                   // history kept
  });

  it('only authorised people can deactivate; the owner and yourself cannot be deactivated', async () => {
    const a = await addMember(db, owner, cid), b = await addMember(db, owner, cid, 'admin');
    expect((await call(db, 'POST', P(`/employees/${a.membershipId}/deactivate`), {}, b.user)).status).toBe(403); // admin preset lacks members.delete
    expect((await call(db, 'POST', P(`/employees/${b.membershipId}/deactivate`), {}, a.user)).status).toBe(403);
    const ownerMid = (await call(db, 'GET', P(''), undefined, owner)).body.me.membershipId;
    expect((await call(db, 'POST', P(`/employees/${ownerMid}/deactivate`), {}, owner)).status).toBe(403);
  });
});

describe('role assignment, ownership and operating modes', () => {
  async function agent(body: object = {}) {
    const r = await call(db, 'POST', P('/agents'), { name: 'AI CMO', config: { provider: 'anthropic', model: 'any-model', autonomyLevel: 1 }, ...body }, owner);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.agent.id as string;
  }
  const mode = async (rid: string) => (await call(db, 'GET', P(`/roles/${rid}`), undefined, owner)).body.role.roleType;

  it('AI mode → hybrid mode → human mode → vacant, driven by who is assigned', async () => {
    const cmo = await makeRole(db, owner, cid, { name: 'CMO', templateKey: 'cmo' });
    expect(await mode(cmo.id)).toBe('vacant');
    const ai = await agent();
    const a1 = await call(db, 'POST', P(`/roles/${cmo.id}/assignments`), { agentId: ai }, owner);
    expect(a1.status).toBe(201); expect(await mode(cmo.id)).toBe('ai');
    const human = await addMember(db, owner, cid);
    const a2 = await call(db, 'POST', P(`/roles/${cmo.id}/assignments`), { membershipId: human.membershipId }, owner);
    expect(await mode(cmo.id)).toBe('hybrid');
    let d = (await call(db, 'GET', P(`/roles/${cmo.id}`), undefined, owner)).body;
    expect(d.assignees.map((x: any) => x.kind).sort()).toEqual(['ai', 'human']);
    expect(d.assignees.find((x: any) => x.isOwner).kind).toBe('ai');                       // first assigned owns it
    // hand ownership to the human, then retire the AI: the human CMO keeps everything
    expect((await call(db, 'POST', P(`/roles/${cmo.id}/owner`), { assignmentId: a2.body.assignment.id }, owner)).status).toBe(200);
    expect((await call(db, 'DELETE', P(`/roles/${cmo.id}/assignments/${a1.body.assignment.id}`), undefined, owner)).status).toBe(200);
    d = (await call(db, 'GET', P(`/roles/${cmo.id}`), undefined, owner)).body;
    expect(d.role.roleType).toBe('human'); expect(d.assignees).toHaveLength(1); expect(d.assignees[0].isOwner).toBe(true);
    expect(d.responsibilities.length).toBeGreaterThan(3);                                  // role content untouched by the transition
    await call(db, 'DELETE', P(`/roles/${cmo.id}/assignments/${a2.body.assignment.id}`), undefined, owner);
    expect(await mode(cmo.id)).toBe('vacant');
  });

  it('several team members can share a role; removing the owner promotes the longest-serving person', async () => {
    const r = await makeRole(db, owner, cid, { name: 'Support' });
    const m = [await addMember(db, owner, cid), await addMember(db, owner, cid), await addMember(db, owner, cid)];
    const asg: any[] = [];
    for (const x of m) asg.push((await call(db, 'POST', P(`/roles/${r.id}/assignments`), { membershipId: x.membershipId }, owner)).body.assignment);
    expect((await call(db, 'POST', P(`/roles/${r.id}/assignments`), { membershipId: m[0].membershipId }, owner)).status).toBe(409);
    await call(db, 'DELETE', P(`/roles/${r.id}/assignments/${asg[0].id}`), undefined, owner);
    const d = (await call(db, 'GET', P(`/roles/${r.id}`), undefined, owner)).body;
    expect(d.assignees).toHaveLength(2);
    expect(d.assignees.filter((x: any) => x.isOwner)).toHaveLength(1);
    expect(d.assignees.find((x: any) => x.isOwner).membershipId).toBe(m[1].membershipId);
  });

  it('the role type cannot be set to something that contradicts its assignees', async () => {
    const r = await makeRole(db, owner, cid, { name: 'Ops' });
    await call(db, 'POST', P(`/roles/${r.id}/assignments`), { agentId: await agent() }, owner);
    expect((await call(db, 'PATCH', P(`/roles/${r.id}`), { roleType: 'human' }, owner)).status).toBe(409);
    expect((await call(db, 'PATCH', P(`/roles/${r.id}`), { roleType: 'hybrid' }, owner)).status).toBe(200);
  });

  it('assigning requires the right permission; foreign agents and members cannot be assigned', async () => {
    const r = await makeRole(db, owner, cid, { name: 'Ops' });
    const plain = await addMember(db, owner, cid);
    expect((await call(db, 'POST', P(`/roles/${r.id}/assignments`), { agentId: await agent() }, plain.user)).status).toBe(403);
    const other = await signup(db); const oc = await makeCompany(db, other);
    const foreignAgent = (await call(db, 'POST', P('/agents', oc), { name: 'X', config: { provider: 'anthropic', model: 'm' } }, other)).body.agent.id;
    expect((await call(db, 'POST', P(`/roles/${r.id}/assignments`), { agentId: foreignAgent }, owner)).status).toBe(404);
    const fm = (await call(db, 'GET', P('/members', oc), undefined, other)).body.members[0].membershipId;
    expect((await call(db, 'POST', P(`/roles/${r.id}/assignments`), { membershipId: fm }, owner)).status).toBe(404);
    expect((await call(db, 'POST', P(`/roles/${r.id}/assignments`), {}, owner)).status).toBe(400);
  });

  it('workforce dashboard and directory show roles, owners, managers, departments, responsibilities and statuses', async () => {
    const dep = (await call(db, 'POST', P('/departments'), { name: 'Marketing' }, owner)).body.department;
    const cmo = await makeRole(db, owner, cid, { name: 'CMO', templateKey: 'cmo', departmentId: dep.id });
    await makeRole(db, owner, cid, { name: 'COO', templateKey: 'coo', reportsToRoleId: cmo.id });
    await call(db, 'POST', P(`/roles/${cmo.id}/assignments`), { agentId: await agent() }, owner);
    const wf = (await call(db, 'GET', P('/workforce'), undefined, owner)).body;
    expect(wf.counts).toMatchObject({ ai: 1, vacant: 1, total: 2 });
    const row = wf.roles.find((r: any) => r.name === 'CMO');
    expect(row).toMatchObject({ departmentName: 'Marketing', mode: 'ai' }); expect(row.owner.name).toBe('AI CMO'); expect(row.responsibilities.length).toBeGreaterThan(3);
    expect(wf.roles.find((r: any) => r.name === 'COO').reportsToName).toBe('CMO');
    const dir = (await call(db, 'GET', P('/workforce/directory'), undefined, owner)).body;
    expect(dir.people.map((p: any) => `${p.kind}:${p.name}`).sort()).toEqual(['ai:AI CMO', 'human:Founder']);
    expect(dir.counts).toMatchObject({ humans: 1, ai: 0, inactiveAi: 1 }); // the AI is not activated yet
    const plain = await addMember(db, owner, cid);
    expect((await call(db, 'GET', P('/workforce'), undefined, plain.user)).status).toBe(403);
    expect((await call(db, 'GET', P('/workforce/directory'), undefined, plain.user)).status).toBe(403);
  });
});

describe('Phase 1 → Phase 2 database upgrade', () => {
  it('upgrades a database that already holds Phase 1 data without losing it', async () => {
    const fs = await import('node:fs'); const path = await import('node:path');
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    const files = fs.readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();
    const run = async (f: string) => { for (const st of fs.readFileSync(path.join('drizzle', f), 'utf8').split('--> statement-breakpoint')) if (st.trim()) await pg.exec(st); };
    await run(files[0]);
    await pg.exec(`insert into users(id,email,name,password_hash) values ('00000000-0000-4000-8000-000000000001','a@x.co','A','h'),('00000000-0000-4000-8000-000000000002','b@x.co','B','h');
      insert into companies(id,name,created_by) values ('10000000-0000-4000-8000-000000000001','Old Co','00000000-0000-4000-8000-000000000001');
      insert into company_memberships(id,company_id,user_id,access_level) values ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','owner'),('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','member');
      insert into roles(id,company_id,name,role_type) values ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Ops','human');
      insert into role_assignments(company_id,role_id,membership_id) values ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001'),('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002');`);
    await pg.exec(`insert into permissions(key,resource,action,description) values ('reports.view','reports','view','x'),('tasks.view','tasks','view','x');
      insert into roles(id,company_id,name,role_type,template_key) values ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','CMO','human','cmo'),('30000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','Mgr','human','marketing_manager');
      insert into role_permissions(company_id,role_id,permission_key,scope) values ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','reports.view','company'),('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000003','reports.view','company'),('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000003','tasks.view','company');
      insert into role_kpis(company_id,role_id,name,target,period) values ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','Leads','90','weekly'),('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','Brand','high','monthly');`);
    for (const f of files.slice(1)) await run(f);
    const kp = await pg.query<any>(`select name, target_value::float8 tv, reporting_frequency rf from role_kpis order by name`);
    expect(kp.rows).toEqual([{ name: 'Brand', tv: null, rf: 'monthly' }, { name: 'Leads', tv: 90, rf: 'weekly' }]);   // numeric targets back-filled, text targets left alone
    const sc = await pg.query<any>(`select role_id, permission_key, scope from role_permissions order by role_id, permission_key`);
    expect(sc.rows.map((r: any) => `${r.role_id.slice(-1)}:${r.permission_key}:${r.scope}`)).toEqual(['2:reports.view:department', '3:reports.view:own', '3:tasks.view:department']);   // template roles move to least-privilege scopes
    const owners = await pg.query<any>(`select membership_id, is_primary from role_assignments order by started_at, id`);
    expect(owners.rows.filter((r) => r.is_primary)).toHaveLength(1);                       // exactly one owner after the upgrade
    expect((await pg.query<any>('select count(*)::int n from employees')).rows[0].n).toBe(2); // employee profiles back-filled
    expect((await pg.query<any>('select count(*)::int n from roles')).rows[0].n).toBe(3);
    for (const t of ['knowledge_documents', 'knowledge_versions', 'knowledge_chunks', 'knowledge_access', 'decisions', 'handovers', 'handover_items', 'role_transitions', 'tasks', 'notifications']) expect((await pg.query<any>(`select count(*)::int n from ${t}`)).rows[0].n, t).toBe(0);   // later phases' tables exist and start empty
  });
});
void schema;
