import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { schema } from '@/db/client';
import { addMember, call, makeCompany, makeRole, newDb, resetRateLimits, signup, type Client } from './helpers';

let db: Db; let owner: Client; let cid: string;
const P = (p: string, id = cid) => `/companies/${id}${p}`;
beforeAll(async () => { process.env.EXPOSE_DEV_LINKS = '1'; db = await newDb(); });
beforeEach(async () => { resetRateLimits(); owner = await signup(db, 'Founder'); cid = await makeCompany(db, owner); });

describe('tenant isolation', () => {
  it('another company\'s user cannot read or write anything in this company (404, not 403)', async () => {
    const role = await makeRole(db, owner, cid, { name: 'COO' });
    const intruder = await signup(db, 'Intruder'); await makeCompany(db, intruder);
    const probes: [string, string, unknown?][] = [
      ['GET', ''], ['PATCH', '', { name: 'pwned' }], ['GET', '/dashboard'], ['GET', '/roles'], ['GET', `/roles/${role.id}`], ['GET', '/org-tree'],
      ['GET', '/members'], ['GET', '/audit'], ['GET', '/departments'], ['POST', '/roles', { name: 'x', roleType: 'vacant' }],
      ['DELETE', `/roles/${role.id}`, {}], ['PUT', `/roles/${role.id}/permissions`, { grants: [{ key: 'roles.view' }] }],
    ];
    for (const [m, p, b] of probes) expect((await call(db, m, P(p), b, intruder)).status, `${m} ${p}`).toBe(404);
    expect((await call(db, 'GET', P(''), undefined, null)).status).toBe(401);
    expect((await call(db, 'GET', '/companies/not-a-uuid/roles', undefined, intruder)).status).toBe(404);
  });

  it('ids from another tenant cannot be referenced from this one', async () => {
    const other = await signup(db, 'Other'); const oc = await makeCompany(db, other);
    const foreignRole = await makeRole(db, other, oc, { name: 'Foreign CTO' });
    const foreignDept = (await call(db, 'POST', P('/departments', oc), { name: 'Foreign Dept' }, other)).body.department;
    const mine = await makeRole(db, owner, cid, { name: 'Mine' });
    expect((await call(db, 'POST', P('/roles'), { name: 'x', roleType: 'vacant', reportsToRoleId: foreignRole.id }, owner)).status).toBe(404);
    expect((await call(db, 'POST', P('/roles'), { name: 'x', roleType: 'vacant', departmentId: foreignDept.id }, owner)).status).toBe(400);
    expect((await call(db, 'PUT', P(`/roles/${mine.id}/move`), { reportsToRoleId: foreignRole.id }, owner)).status).toBe(404);
    expect((await call(db, 'GET', P(`/roles/${foreignRole.id}`), undefined, owner)).status).toBe(404);
    expect((await call(db, 'PATCH', P(`/roles/${foreignRole.id}`), { name: 'hijack' }, owner)).status).toBe(404);
    expect((await call(db, 'POST', P(`/roles/${mine.id}/responsibilities`), { title: 't', ownerRoleId: foreignRole.id }, owner)).status).toBe(404);
    expect((await call(db, 'GET', P(`/roles`, oc), undefined, other)).body.roles.map((r: any) => r.name)).toEqual(['Foreign CTO']);
  });

  it('the database itself refuses cross-tenant references (composite foreign keys)', async () => {
    const other = await signup(db); const oc = await makeCompany(db, other);
    const foreign = await makeRole(db, other, oc, { name: 'F' });
    await expect(db.insert(schema.roles).values({ companyId: cid, name: 'Leak', reportsToRoleId: foreign.id, roleType: 'vacant' })).rejects.toThrow();
    const mine = await makeRole(db, owner, cid, { name: 'M' });
    await expect(db.insert(schema.roleResponsibilities).values({ companyId: oc, roleId: mine.id, title: 'leak' })).rejects.toThrow();
  });

  it('a user can be founder of one company and an employee of another with different powers (Scenario: multi-company)', async () => {
    const other = await signup(db, 'Other Founder'); const oc = await makeCompany(db, other);
    const { user } = await addMember(db, other, oc, 'member'); // user is an employee in `oc`
    const mineCid = await makeCompany(db, user);                 // and founder of their own company
    expect((await call(db, 'GET', P('', mineCid), undefined, user)).body.me.accessLevel).toBe('owner');
    expect((await call(db, 'GET', P('', oc), undefined, user)).body.me.accessLevel).toBe('member');
    expect((await call(db, 'POST', P('/roles', mineCid), { name: 'CTO', roleType: 'vacant' }, user)).status).toBe(201);
    expect((await call(db, 'POST', P('/roles', oc), { name: 'CTO', roleType: 'vacant' }, user)).status).toBe(403);
  });
});

describe('permissions are enforced by the backend', () => {
  it('a plain member can read the company but nothing sensitive or mutating; sees only their own roles', async () => {
    const role = await makeRole(db, owner, cid, { name: 'Support Agent', templateKey: 'cmo' });
    await call(db, 'PUT', P(`/roles/${role.id}/permissions`), { grants: [{ key: 'company.view', scope: 'company' }] }, owner);
    const { user, membershipId } = await addMember(db, owner, cid, 'member', role.id);
    expect((await call(db, 'GET', P(''), undefined, user)).status).toBe(200);
    for (const [m, p, b] of [['GET', '/roles'], ['GET', '/members'], ['GET', '/audit'], ['GET', '/org-tree'], ['GET', '/departments'], ['POST', '/roles', { name: 'x', roleType: 'vacant' }], ['PATCH', '', { name: 'x' }], ['DELETE', `/members/${membershipId}`], ['POST', '/invites', { email: 'a@b.co' }]] as any[])
      expect((await call(db, m, P(p), b, user)).status, `${m} ${p}`).toBe(403);
    const mine = await call(db, 'GET', P('/my-roles'), undefined, user);
    expect(mine.body.roles[0].name).toBe('Support Agent');
    expect(mine.body.roles[0].responsibilities.length).toBeGreaterThan(0);
    const dash = (await call(db, 'GET', P('/dashboard'), undefined, user)).body;
    expect(dash.members).toBeUndefined(); expect(dash.roles).toBeUndefined(); expect(dash.recentActivity).toBeUndefined();
  });

  it('permissions come from the assigned ROLE, not from hierarchy: a manager does not inherit access', async () => {
    const mgr = await makeRole(db, owner, cid, { name: 'Marketing Manager' });
    await call(db, 'PUT', P(`/roles/${mgr.id}/permissions`), { grants: [{ key: 'company.view', scope: 'company' }] }, owner);
    await makeRole(db, owner, cid, { name: 'Content Exec', reportsToRoleId: mgr.id });
    const { user } = await addMember(db, owner, cid, 'member', mgr.id);
    expect((await call(db, 'GET', P('/roles'), undefined, user)).status).toBe(403); // is a manager of someone, still no roles.view
    await call(db, 'PUT', P(`/roles/${mgr.id}/permissions`), { grants: [{ key: 'company.view', scope: 'company' }, { key: 'roles.view', scope: 'company' }] }, owner);
    expect((await call(db, 'GET', P('/roles'), undefined, user)).status).toBe(200);   // change takes effect immediately
    expect((await call(db, 'PATCH', P(`/roles/${mgr.id}`), { name: 'x' }, user)).status).toBe(403); // view != edit
  });

  it('department- and own-scoped grants only reach the right roles', async () => {
    const d1 = (await call(db, 'POST', P('/departments'), { name: 'Marketing' }, owner)).body.department;
    const d2 = (await call(db, 'POST', P('/departments'), { name: 'Finance' }, owner)).body.department;
    const head = await makeRole(db, owner, cid, { name: 'CMO', departmentId: d1.id });
    const mm = await makeRole(db, owner, cid, { name: 'Marketing Manager', departmentId: d1.id });
    const cfo = await makeRole(db, owner, cid, { name: 'CFO', departmentId: d2.id });
    await call(db, 'PUT', P(`/roles/${head.id}/permissions`), { grants: [{ key: 'company.view', scope: 'company' }, { key: 'roles.view', scope: 'department' }, { key: 'roles.edit', scope: 'department' }] }, owner);
    const { user } = await addMember(db, owner, cid, 'member', head.id);
    const list = (await call(db, 'GET', P('/roles'), undefined, user)).body.roles.map((r: any) => r.name).sort();
    expect(list).toEqual(['CMO', 'Marketing Manager']);
    expect((await call(db, 'GET', P(`/roles/${cfo.id}`), undefined, user)).status).toBe(403);
    expect((await call(db, 'PATCH', P(`/roles/${mm.id}`), { description: 'ok' }, user)).status).toBe(200);
    expect((await call(db, 'PATCH', P(`/roles/${cfo.id}`), { description: 'no' }, user)).status).toBe(403);
    const tree = (await call(db, 'GET', P('/org-tree'), undefined, user)).body.roots.map((r: any) => r.name).sort();
    expect(tree).toEqual(['CMO', 'Marketing Manager']);
  });

  it('admins get a limited default set: cannot configure permissions, invite admins, or touch finance', async () => {
    const { user: admin, membershipId } = await addMember(db, owner, cid, 'admin');
    expect((await call(db, 'POST', P('/roles'), { name: 'Ops', roleType: 'vacant' }, admin)).status).toBe(201);
    expect((await call(db, 'POST', P('/departments'), { name: 'Ops Dept' }, admin)).status).toBe(201);
    const r = await makeRole(db, owner, cid, { name: 'CFO' });
    expect((await call(db, 'PUT', P(`/roles/${r.id}/permissions`), { grants: [{ key: 'finance.view' }] }, admin)).status).toBe(403);
    expect((await call(db, 'POST', P('/invites'), { email: 'x@example.com', accessLevel: 'admin' }, admin)).status).toBe(403);
    expect((await call(db, 'PATCH', P(`/members/${membershipId}`), { accessLevel: 'member' }, admin)).status).toBe(403);
    expect((await call(db, 'GET', P('/members'), undefined, admin)).status).toBe(200);
    // owner customises: grant permissions.configure + a subset
    expect((await call(db, 'PUT', P(`/members/${membershipId}/permissions`), { keys: ['company.view', 'permissions.view', 'permissions.configure', 'roles.view'] }, owner)).status).toBe(200);
    expect((await call(db, 'PUT', P(`/roles/${r.id}/permissions`), { grants: [{ key: 'roles.view' }] }, admin)).status).toBe(200);
    expect((await call(db, 'POST', P('/roles'), { name: 'No longer', roleType: 'vacant' }, admin)).status).toBe(403); // roles.create was removed
  });

  it('no privilege escalation: you cannot grant permissions you do not hold', async () => {
    const { user: admin, membershipId } = await addMember(db, owner, cid, 'admin');
    await call(db, 'PUT', P(`/members/${membershipId}/permissions`), { keys: ['company.view', 'roles.view', 'roles.create', 'permissions.view', 'permissions.configure'] }, owner);
    const r = await makeRole(db, owner, cid, { name: 'Target' });
    const up = await call(db, 'PUT', P(`/roles/${r.id}/permissions`), { grants: [{ key: 'roles.view' }, { key: 'finance.export' }, { key: 'members.delete' }] }, admin);
    expect(up.status).toBe(403); expect(up.body.error).toMatch(/finance\.export/);
    const created = await call(db, 'POST', P('/roles'), { name: 'Sneaky', roleType: 'vacant', permissions: [{ key: 'finance.view' }] }, admin);
    expect(created.status).toBe(403);
    const tpl = await call(db, 'POST', P('/roles'), { name: 'CFO2', roleType: 'vacant', templateKey: 'cfo' }, admin); // template defaults are clipped, not blocked
    expect(tpl.status).toBe(201);
    const perms = (await call(db, 'GET', P(`/roles/${tpl.body.role.id}/permissions`), undefined, admin)).body.grants.map((g: any) => g.key);
    expect(perms).not.toContain('finance.view'); expect(perms).toContain('company.view');
    expect((await call(db, 'PUT', P(`/members/${membershipId}/permissions`), { keys: ['roles.view'] }, admin)).status).toBe(403); // cannot edit self
  });

  it('only the owner may change access levels; the owner cannot be removed or edited', async () => {
    const { membershipId } = await addMember(db, owner, cid, 'member');
    expect((await call(db, 'PATCH', P(`/members/${membershipId}`), { accessLevel: 'admin' }, owner)).status).toBe(200);
    const me = (await call(db, 'GET', P(''), undefined, owner)).body.me.membershipId;
    expect((await call(db, 'DELETE', P(`/members/${me}`), undefined, owner)).status).toBe(403);
    expect((await call(db, 'PUT', P(`/members/${me}/permissions`), { keys: [] }, owner)).status).toBe(400);
  });
});

describe('employees: invite, assign, remove', () => {
  it('invite is bound to the invited email; token cannot be reused', async () => {
    const inv = await call(db, 'POST', P('/invites'), { email: 'new.hire@example.com' }, owner);
    const token = new URL(inv.body.devLink).searchParams.get('token');
    const wrong = await signup(db);
    expect((await call(db, 'POST', '/invites/accept', { token }, wrong)).status).toBe(403);
    const { res } = await call(db, 'POST', '/auth/register', { name: 'New Hire', email: 'new.hire@example.com', password: 'Passw0rd!x' });
    const hire = { cookie: res.headers.get('set-cookie')!.split(';')[0], email: 'new.hire@example.com', id: '' };
    expect((await call(db, 'POST', '/invites/accept', { token }, hire)).status).toBe(200);
    expect((await call(db, 'POST', '/invites/accept', { token }, hire)).status).toBe(400);
  });

  it('assigning a person flips a vacant role to human; removing the person revokes access at once and re-vacates the role (Scenario D, phase-1 part)', async () => {
    const mm = await makeRole(db, owner, cid, { name: 'Marketing Manager', templateKey: 'marketing_manager' });
    const { user, membershipId } = await addMember(db, owner, cid, 'member', mm.id);
    let d = (await call(db, 'GET', P(`/roles/${mm.id}`), undefined, owner)).body;
    expect(d.role.roleType).toBe('human'); expect(d.assignees).toHaveLength(1);
    expect((await call(db, 'GET', P('/my-roles'), undefined, user)).body.roles).toHaveLength(1);

    const rm = await call(db, 'DELETE', P(`/members/${membershipId}`), undefined, owner);
    expect(rm.body.rolesVacated).toBe(1);
    expect((await call(db, 'GET', P(''), undefined, user)).status).toBe(404);          // immediate loss of access
    d = (await call(db, 'GET', P(`/roles/${mm.id}`), undefined, owner)).body;
    expect(d.role.roleType).toBe('vacant'); expect(d.assignees).toHaveLength(0);
    expect(d.responsibilities.length).toBeGreaterThan(0);                              // role knowledge stays
    const hist = await db.execute(`select ended_at from role_assignments where membership_id = '${membershipId}'` as any) as any;
    expect((hist.rows ?? hist)[0].ended_at).not.toBeNull();                            // assignment history preserved

    // a replacement joins the same role and continues
    const next = await addMember(db, owner, cid, 'member', mm.id);
    expect((await call(db, 'GET', P('/my-roles'), undefined, next.user)).body.roles[0].responsibilities.length).toBeGreaterThan(0);
  });

  it('a person assigned to a role that was typed AI (with no AI employee yet) makes it a human-mode role (mode follows who is assigned)', async () => {
    const r = await makeRole(db, owner, cid, { name: 'AI CMO', roleType: 'ai' });
    const { membershipId } = await addMember(db, owner, cid, 'member');
    expect((await call(db, 'POST', P(`/roles/${r.id}/assignments`), { membershipId }, owner)).status).toBe(201);
    expect((await call(db, 'GET', P(`/roles/${r.id}`), undefined, owner)).body.role.roleType).toBe('human');
  });

  it('audit log records who did what and never stores secrets', async () => {
    await makeRole(db, owner, cid, { name: 'Audited' });
    await call(db, 'POST', P('/invites'), { email: 'a@example.com' }, owner);
    const ev = (await call(db, 'GET', P('/audit'), undefined, owner)).body.events;
    expect(ev.some((e: any) => e.action === 'role.created' && e.actor === 'Founder')).toBe(true);
    expect(JSON.stringify(ev)).not.toMatch(/token|password|scrypt/i);
  });
});
