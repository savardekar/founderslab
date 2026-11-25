import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { call, makeCompany, makeRole, newDb, resetRateLimits, signup, type Client } from './helpers';

let db: Db; let owner: Client; let cid: string;
const P = (p: string) => `/companies/${cid}${p}`;
beforeAll(async () => { process.env.EXPOSE_DEV_LINKS = '1'; db = await newDb(); });
beforeEach(async () => { resetRateLimits(); owner = await signup(db, 'Founder'); cid = await makeCompany(db, owner); });

describe('company workspace', () => {
  it('creator becomes the owner; can edit company info; validates input', async () => {
    const me = await call(db, 'GET', P(''), undefined, owner);
    expect(me.body.me.accessLevel).toBe('owner');
    expect(me.body.permissions.length).toBeGreaterThan(50);
    const up = await call(db, 'PATCH', P(''), { name: 'Renamed', industry: 'SaaS', website: 'https://example.com', stage: 'early_revenue', objectives: ['A', 'B'] }, owner);
    expect(up.body.company).toMatchObject({ name: 'Renamed', industry: 'SaaS', stage: 'early_revenue' });
    expect((await call(db, 'PATCH', P(''), { website: 'javascript:alert(1)' }, owner)).status).toBe(400);
    expect((await call(db, 'POST', '/companies', { name: '', stage: 'seed', workforceMode: 'ai', objectives: [] }, owner)).status).toBe(400);
  });

  it('a user can own several companies and list them', async () => {
    await makeCompany(db, owner);
    const list = await call(db, 'GET', '/companies', undefined, owner);
    expect(list.body.companies.length).toBe(2);
  });

  it('org template creates departments + a nested hierarchy; unticked nodes are skipped and children re-parented', async () => {
    const o = await signup(db);
    const c = await call(db, 'POST', '/companies', { name: 'T', stage: 'seed', workforceMode: 'ai', objectives: [], orgTemplate: 'ecommerce', includeNodeKeys: ['coo', 'vendor', 'cmo', 'mm', 'cfo'] }, o);
    expect(c.status).toBe(201);
    const tree = (await call(db, 'GET', `/companies/${c.body.company.id}/org-tree`, undefined, o)).body.roots;
    const names = (n: any): any => ({ n: n.name, c: n.children.map(names) });
    expect(tree.map(names)).toEqual(expect.arrayContaining([{ n: 'COO', c: [{ n: 'Vendor Manager', c: [] }] }, { n: 'CMO', c: [{ n: 'Marketing Manager', c: [] }] }, { n: 'CFO', c: [] }]));
    expect(tree[0].roleType).toBe('ai');
    const detail = await call(db, 'GET', `/companies/${c.body.company.id}/roles/${tree.find((t: any) => t.name === 'COO').id}`, undefined, o);
    expect(detail.body.responsibilities.map((r: any) => r.title)).toContain('Manage daily operations');
    expect(detail.body.permissions.length).toBeGreaterThan(3);
  });
});

describe('hierarchy builder', () => {
  it('creates nested custom roles, moves, prevents loops, deletes with report reassignment, duplicates, keeps history', async () => {
    const dep = (await call(db, 'POST', P('/departments'), { name: 'Operations' }, owner)).body.department;
    const coo = await makeRole(db, owner, cid, { name: 'COO', departmentId: dep.id });
    const opsMgr = await makeRole(db, owner, cid, { name: 'Operations Manager', departmentId: dep.id, reportsToRoleId: coo.id });
    const opsExec = await makeRole(db, owner, cid, { name: 'Operations Executive', reportsToRoleId: opsMgr.id });
    const cmo = await makeRole(db, owner, cid, { name: 'CMO' });

    // Scenario F: change the manager of Operations Manager
    const mv = await call(db, 'PUT', P(`/roles/${opsMgr.id}/move`), { reportsToRoleId: cmo.id }, owner);
    expect(mv.status).toBe(200);
    let tree = (await call(db, 'GET', P('/org-tree'), undefined, owner)).body.roots;
    expect(tree.find((r: any) => r.name === 'CMO').children[0].children[0].name).toBe('Operations Executive');
    expect(tree.find((r: any) => r.name === 'COO').children).toHaveLength(0);

    // loop prevention
    expect((await call(db, 'PUT', P(`/roles/${cmo.id}/move`), { reportsToRoleId: opsExec.id }, owner)).status).toBe(400);
    expect((await call(db, 'PUT', P(`/roles/${cmo.id}/move`), { reportsToRoleId: cmo.id }, owner)).status).toBe(400);

    // promote to top level
    await call(db, 'PUT', P(`/roles/${opsMgr.id}/move`), { reportsToRoleId: null, position: 0 }, owner);
    tree = (await call(db, 'GET', P('/org-tree'), undefined, owner)).body.roots;
    expect(tree[0].name).toBe('Operations Manager');

    // duplicate copies content, not people
    const dup = await call(db, 'POST', P(`/roles/${coo.id}/duplicate`), {}, owner);
    expect(dup.status).toBe(201);
    expect(dup.body.role.name).toBe('COO (copy)');

    // delete = archive; reports move up; history in audit
    const del = await call(db, 'DELETE', P(`/roles/${opsMgr.id}`), {}, owner);
    expect(del.body.movedReports).toBe(1);
    expect((await call(db, 'GET', P(`/roles/${opsMgr.id}`), undefined, owner)).status).toBe(404);
    const flat = (await call(db, 'GET', P('/roles'), undefined, owner)).body.roles;
    expect(flat.find((r: any) => r.id === opsExec.id).reportsToRoleId).toBeNull();
    const audit = (await call(db, 'GET', P('/audit'), undefined, owner)).body.events.map((e: any) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['role.created', 'role.manager_changed', 'role.deleted', 'role.duplicated']));
    const row = await db.execute(`select archived_at from roles where id = '${opsMgr.id}'` as any) as any;
    expect((row.rows ?? row)[0].archived_at).not.toBeNull(); // record still exists
  });

  it('rejects a department or parent that does not exist and duplicate department names', async () => {
    expect((await call(db, 'POST', P('/roles'), { name: 'X', roleType: 'vacant', departmentId: '11111111-1111-4111-8111-111111111111' }, owner)).status).toBe(400);
    expect((await call(db, 'POST', P('/roles'), { name: 'X', roleType: 'vacant', reportsToRoleId: '11111111-1111-4111-8111-111111111111' }, owner)).status).toBe(404);
    await call(db, 'POST', P('/departments'), { name: 'Sales' }, owner);
    expect((await call(db, 'POST', P('/departments'), { name: 'sales' }, owner)).status).toBe(409);
  });

  it('deleting a department keeps its roles', async () => {
    const dep = (await call(db, 'POST', P('/departments'), { name: 'Temp' }, owner)).body.department;
    const r = await makeRole(db, owner, cid, { name: 'Temp Lead', departmentId: dep.id });
    expect((await call(db, 'DELETE', P(`/departments/${dep.id}`), undefined, owner)).body.rolesUnassigned).toBe(1);
    expect((await call(db, 'GET', P(`/roles/${r.id}`), undefined, owner)).body.department).toBeNull();
  });
});

describe('responsibilities, rules, KPIs', () => {
  it('seeds template responsibilities and supports add/edit/reorder/reassign/delete without losing history', async () => {
    const coo = await makeRole(db, owner, cid, { name: 'COO', templateKey: 'coo', roleType: 'ai' });
    const cmo = await makeRole(db, owner, cid, { name: 'CMO' });
    let d = (await call(db, 'GET', P(`/roles/${coo.id}`), undefined, owner)).body;
    expect(d.responsibilities.length).toBe(6);
    expect(d.rules.some((r: any) => r.kind === 'deny')).toBe(true);
    expect(d.kpis.length).toBe(3);

    const add = await call(db, 'POST', P(`/roles/${coo.id}/responsibilities`), { title: 'Run vendor reviews', description: 'Quarterly', expectedOutcome: 'Reviews done', priority: 'high', frequency: 'quarterly' }, owner);
    expect(add.status).toBe(201);
    const id = add.body.responsibility.id;
    await call(db, 'PATCH', P(`/responsibilities/${id}`), { title: 'Run vendor reviews v2', requiresApproval: true }, owner);

    const ids = d.responsibilities.map((r: any) => r.id).reverse();
    expect((await call(db, 'PUT', P(`/roles/${coo.id}/responsibilities/order`), { ids }, owner)).status).toBe(400); // must include the new one
    const all = [id, ...ids];
    expect((await call(db, 'PUT', P(`/roles/${coo.id}/responsibilities/order`), { ids: all }, owner)).status).toBe(200);
    d = (await call(db, 'GET', P(`/roles/${coo.id}`), undefined, owner)).body;
    expect(d.responsibilities[0].id).toBe(id);
    expect(d.responsibilities[0].title).toBe('Run vendor reviews v2');

    // assign to another role
    await call(db, 'PATCH', P(`/responsibilities/${id}`), { ownerRoleId: cmo.id }, owner);
    const cmoD = (await call(db, 'GET', P(`/roles/${cmo.id}`), undefined, owner)).body;
    expect(cmoD.responsibilitiesOwnedFromOtherRoles.map((r: any) => r.id)).toContain(id);

    // deleting the role that now owns it hands it back, nothing silently disappears
    await call(db, 'DELETE', P(`/roles/${cmo.id}`), {}, owner);
    d = (await call(db, 'GET', P(`/roles/${coo.id}`), undefined, owner)).body;
    expect(d.responsibilities.find((r: any) => r.id === id).ownerRoleId).toBeNull();

    await call(db, 'DELETE', P(`/responsibilities/${id}`), undefined, owner);
    d = (await call(db, 'GET', P(`/roles/${coo.id}`), undefined, owner)).body;
    expect(d.responsibilities.find((r: any) => r.id === id)).toBeUndefined();
    const row = await db.execute(`select archived_at from role_responsibilities where id = '${id}'` as any) as any;
    expect((row.rows ?? row)[0].archived_at).not.toBeNull();
  });

  it('manages rules and KPIs', async () => {
    const r = await makeRole(db, owner, cid, { name: 'Analyst' });
    const rule = await call(db, 'POST', P(`/roles/${r.id}/rules`), { kind: 'deny', text: 'Cannot export customer data' }, owner);
    const kpi = await call(db, 'POST', P(`/roles/${r.id}/kpis`), { name: 'Reports delivered', target: '4', unit: 'count', period: 'monthly' }, owner);
    expect(rule.status).toBe(201); expect(kpi.status).toBe(201);
    await call(db, 'PATCH', P(`/roles/${r.id}/kpis/${kpi.body.kpi.id}`), { target: '6' }, owner);
    const d = (await call(db, 'GET', P(`/roles/${r.id}`), undefined, owner)).body;
    expect(d.kpis[0].target).toBe('6'); expect(d.rules[0].text).toMatch(/export/);
    await call(db, 'DELETE', P(`/roles/${r.id}/rules/${rule.body.rule.id}`), undefined, owner);
    expect((await call(db, 'GET', P(`/roles/${r.id}`), undefined, owner)).body.rules).toHaveLength(0);
  });

  it('role creation wizard payload is created atomically with all parts', async () => {
    const res = await call(db, 'POST', P('/roles'), {
      name: 'Customer Support Manager', roleType: 'hybrid', reportingFrequency: 'weekly', hasApprovalAuthority: true, approvalLimit: 5000,
      responsibilities: [{ title: 'Resolve tickets', priority: 'high', frequency: 'daily', requiresApproval: false }],
      rules: [{ kind: 'allow', text: 'Can issue refunds up to limit' }], kpis: [{ name: 'First response time', unit: 'hours', period: 'weekly' }],
      permissions: [{ key: 'tasks.view', scope: 'company' }, { key: 'roles.view', scope: 'own' }],
    }, owner);
    expect(res.status).toBe(201);
    const d = (await call(db, 'GET', P(`/roles/${res.body.role.id}`), undefined, owner)).body;
    expect(d.role.approvalLimit).toBe(5000);
    expect(d.permissions).toHaveLength(2);
    expect((await call(db, 'POST', P('/roles'), { name: 'Bad', roleType: 'vacant', permissions: [{ key: 'nope.nope' }] }, owner)).status).toBe(400);
  });
});
