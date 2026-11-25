import { and, eq, gt, isNull } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { badRequest, conflict, unauthorized } from '@/lib/errors';
import { assertStrongPassword, hashPassword, newToken, rateLimit, sha256, verifyPassword } from '../security';
import { appUrl, exposeDevLinks, sendMail } from '../mailer';

export const SESSION_COOKIE = 'fl_session';
const SESSION_DAYS = 30;
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==';
const publicUser = (u: typeof schema.users.$inferSelect) => ({ id: u.id, email: u.email, name: u.name });

export async function register(db: Db, input: { name: string; email: string; password: string }, ua?: string) {
  assertStrongPassword(input.password);
  const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, input.email)).limit(1);
  if (exists) throw conflict('An account with this email already exists');
  const [u] = await db.insert(schema.users).values({ name: input.name, email: input.email, passwordHash: await hashPassword(input.password), lastLoginAt: new Date() }).returning();
  return { user: publicUser(u), token: await createSession(db, u.id, ua) };
}

export async function login(db: Db, input: { email: string; password: string }, ip: string, ua?: string) {
  rateLimit(`login:ip:${ip}`, 30, 15 * 60_000);
  rateLimit(`login:email:${input.email}`, 8, 15 * 60_000);
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, input.email)).limit(1);
  const ok = await verifyPassword(input.password, u?.passwordHash ?? DUMMY_HASH); // constant work even for unknown emails
  if (!u || !ok || u.disabledAt) throw unauthorized('Incorrect email or password');
  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, u.id));
  return { user: publicUser(u), token: await createSession(db, u.id, ua) };
}

export async function createSession(db: Db, userId: string, ua?: string) {
  const token = newToken();
  await db.insert(schema.sessions).values({ userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + SESSION_DAYS * 864e5), userAgent: ua?.slice(0, 300) });
  return token;
}
export async function sessionUser(db: Db, token?: string | null) {
  if (!token) return null;
  const [row] = await db.select({ u: schema.users }).from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.tokenHash, sha256(token)), gt(schema.sessions.expiresAt, new Date()), isNull(schema.users.disabledAt))).limit(1);
  return row ? publicUser(row.u) : null;
}
export async function logout(db: Db, token?: string | null) {
  if (token) await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha256(token)));
}

export async function updateProfile(db: Db, userId: string, input: { name: string }) {
  const [u] = await db.update(schema.users).set({ name: input.name, updatedAt: new Date() }).where(eq(schema.users.id, userId)).returning();
  return publicUser(u);
}

export async function changePassword(db: Db, userId: string, currentToken: string | null, input: { currentPassword: string; newPassword: string }) {
  rateLimit(`chpw:${userId}`, 5, 15 * 60_000);
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!u || !(await verifyPassword(input.currentPassword, u.passwordHash))) throw badRequest('Current password is incorrect');
  assertStrongPassword(input.newPassword);
  await db.update(schema.users).set({ passwordHash: await hashPassword(input.newPassword), updatedAt: new Date() }).where(eq(schema.users.id, userId));
  // sign out every other session
  const all = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId));
  for (const s of all) if (!currentToken || s.tokenHash !== sha256(currentToken)) await db.delete(schema.sessions).where(eq(schema.sessions.id, s.id));
}

export async function forgotPassword(db: Db, email: string, ip: string) {
  rateLimit(`forgot:ip:${ip}`, 10, 60 * 60_000);
  rateLimit(`forgot:email:${email}`, 3, 60 * 60_000);
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (!u) return {}; // never reveal whether the account exists
  const token = newToken();
  await db.insert(schema.passwordResetTokens).values({ userId: u.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000) });
  const link = `${appUrl()}/reset-password?token=${token}`;
  await sendMail({ to: email, subject: 'Reset your FoundersLab password', text: `Use this link within 1 hour to reset your password:\n${link}` });
  return exposeDevLinks() ? { devLink: link } : {};
}

export async function resetPassword(db: Db, input: { token: string; password: string }) {
  assertStrongPassword(input.password);
  const [t] = await db.select().from(schema.passwordResetTokens)
    .where(and(eq(schema.passwordResetTokens.tokenHash, sha256(input.token)), isNull(schema.passwordResetTokens.usedAt), gt(schema.passwordResetTokens.expiresAt, new Date()))).limit(1);
  if (!t) throw badRequest('This reset link is invalid or has expired');
  await db.update(schema.passwordResetTokens).set({ usedAt: new Date() }).where(eq(schema.passwordResetTokens.id, t.id));
  await db.update(schema.users).set({ passwordHash: await hashPassword(input.password), updatedAt: new Date() }).where(eq(schema.users.id, t.userId));
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, t.userId)); // invalidate all sessions
}
