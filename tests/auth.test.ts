import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { call, newDb, resetRateLimits, signup } from './helpers';

let db: Db;
beforeAll(async () => { process.env.EXPOSE_DEV_LINKS = '1'; db = await newDb(); });
beforeEach(() => resetRateLimits());

describe('authentication', () => {
  it('registers, reads profile, updates profile, logs out (session invalidated server-side)', async () => {
    const u = await signup(db, 'Asha');
    expect((await call(db, 'GET', '/auth/me', undefined, u)).body.user.name).toBe('Asha');
    expect((await call(db, 'PATCH', '/auth/me', { name: 'Asha K' }, u)).body.user.name).toBe('Asha K');
    await call(db, 'POST', '/auth/logout', {}, u);
    expect((await call(db, 'GET', '/auth/me', undefined, u)).body.user).toBeNull();
    expect((await call(db, 'GET', '/companies', undefined, u)).status).toBe(401);
  });

  it('rejects weak passwords, duplicate emails and bad input', async () => {
    const email = 'dup@example.com';
    expect((await call(db, 'POST', '/auth/register', { name: 'A', email, password: 'short1' })).status).toBe(400);
    expect((await call(db, 'POST', '/auth/register', { name: 'A', email, password: 'allletters' })).status).toBe(400);
    expect((await call(db, 'POST', '/auth/register', { name: 'A', email: 'nope', password: 'Passw0rd!x' })).status).toBe(400);
    expect((await call(db, 'POST', '/auth/register', { name: 'A', email, password: 'Passw0rd!x' })).status).toBe(201);
    expect((await call(db, 'POST', '/auth/register', { name: 'B', email: 'DUP@example.com', password: 'Passw0rd!x' })).status).toBe(409);
  });

  it('login succeeds/fails correctly and stores only a hash', async () => {
    const u = await signup(db);
    expect((await call(db, 'POST', '/auth/login', { email: u.email, password: 'wrong-password1' })).status).toBe(401);
    expect((await call(db, 'POST', '/auth/login', { email: 'ghost@example.com', password: 'whatever12' })).status).toBe(401);
    const ok = await call(db, 'POST', '/auth/login', { email: u.email, password: 'Passw0rd!x' });
    expect(ok.status).toBe(200);
    const sc = ok.res.headers.get('set-cookie')!;
    expect(sc).toMatch(/HttpOnly/); expect(sc).toMatch(/SameSite=Lax/);
    const raw = await db.execute(`select password_hash from users where email = '${u.email}'` as any) as any;
    expect((raw.rows ?? raw)[0].password_hash).toMatch(/^scrypt\$/);
  });

  it('rate-limits repeated failed logins', async () => {
    const u = await signup(db);
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await call(db, 'POST', '/auth/login', { email: u.email, password: 'bad-password1' })).status;
    expect(last).toBe(429);
  });

  it('password reset: token works once, invalidates sessions, unknown email reveals nothing', async () => {
    const u = await signup(db);
    const unknown = await call(db, 'POST', '/auth/forgot-password', { email: 'nobody@example.com' });
    expect(unknown.status).toBe(200); expect(unknown.body.devLink).toBeUndefined();
    const f = await call(db, 'POST', '/auth/forgot-password', { email: u.email });
    const token = new URL(f.body.devLink).searchParams.get('token');
    expect((await call(db, 'POST', '/auth/reset-password', { token, password: 'NewPassw0rd!' })).status).toBe(200);
    expect((await call(db, 'POST', '/auth/reset-password', { token, password: 'Another1Pass!' })).status).toBe(400);
    expect((await call(db, 'GET', '/auth/me', undefined, u)).body.user).toBeNull();
    expect((await call(db, 'POST', '/auth/login', { email: u.email, password: 'NewPassw0rd!' })).status).toBe(200);
  });

  it('change password requires the current password', async () => {
    const u = await signup(db);
    expect((await call(db, 'POST', '/auth/change-password', { currentPassword: 'nope-nope1', newPassword: 'Better1Pass!' }, u)).status).toBe(400);
    expect((await call(db, 'POST', '/auth/change-password', { currentPassword: 'Passw0rd!x', newPassword: 'Better1Pass!' }, u)).status).toBe(200);
  });

  it('blocks cross-origin state-changing requests (CSRF)', async () => {
    const u = await signup(db);
    const r = await call(db, 'POST', '/companies', { name: 'X', stage: 'idea', workforceMode: 'ai', objectives: [] }, u, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
  });
});
