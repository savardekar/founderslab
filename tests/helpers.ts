import { createTestDb, type Db } from '@/db/client';
import { handle } from '@/server/router';
import { resetRateLimits } from '@/server/security';

export type Client = { cookie: string; email: string; id: string };
export const newDb = () => createTestDb();
export { resetRateLimits };

export async function call(db: Db, method: string, path: string, body?: unknown, who?: Client | null, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { 'content-type': 'application/json', host: 'localhost:3000', ...headers };
  if (who) h.cookie = who.cookie;
  const res = await handle(new Request(`http://localhost:3000/api${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), db);
  const json: any = await res.json();
  return { status: res.status, body: json, res };
}

let n = 0;
export async function signup(db: Db, name = 'User'): Promise<Client> {
  const email = `u${++n}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const { res, body } = await call(db, 'POST', '/auth/register', { name, email, password: 'Passw0rd!x' });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  return { cookie, email, id: body.user.id };
}

export const companyInput = (name = 'Acme Labs', extra: object = {}) => ({
  name, stage: 'seed', workforceMode: 'hybrid', objectives: ['Reach first 10 customers'], ...extra,
});
export async function makeCompany(db: Db, owner: Client, extra: object = {}) {
  const r = await call(db, 'POST', '/companies', companyInput('Acme ' + Math.random().toString(36).slice(2, 6), extra), owner);
  if (r.status !== 201) throw new Error('company create failed ' + JSON.stringify(r.body));
  return r.body.company.id as string;
}
export async function makeRole(db: Db, who: Client, cid: string, body: object) {
  const r = await call(db, 'POST', `/companies/${cid}/roles`, { roleType: 'vacant', ...body }, who);
  if (r.status !== 201) throw new Error('role create failed ' + JSON.stringify(r.body));
  return r.body.role as { id: string; name: string };
}
/** Invite + accept; returns the new member client and membershipId. */
export async function addMember(db: Db, owner: Client, cid: string, accessLevel: 'admin' | 'member' = 'member', roleId?: string) {
  const u = await signup(db, 'Teammate');
  const inv = await call(db, 'POST', `/companies/${cid}/invites`, { email: u.email, accessLevel, roleId: roleId ?? null }, owner);
  if (inv.status !== 201) throw new Error('invite failed ' + JSON.stringify(inv.body));
  const token = new URL(inv.body.devLink).searchParams.get('token');
  const acc = await call(db, 'POST', '/invites/accept', { token }, u);
  if (acc.status !== 200) throw new Error('accept failed ' + JSON.stringify(acc.body));
  const members = await call(db, 'GET', `/companies/${cid}/members`, undefined, owner);
  const membershipId = members.body.members.find((m: any) => m.userId === u.id).membershipId as string;
  return { user: u, membershipId };
}
