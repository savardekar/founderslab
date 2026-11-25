import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import type { Ctx } from '../authz';
import { addDays, today } from './metrics';

const S = schema;
type N = { kind: string; title: string; body?: string | null; link?: string | null; dedupeKey?: string | null };

export async function notify(db: Db, companyId: string, userIds: (string | null | undefined)[], n: N) {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!ids.length) return;
  await db.insert(S.notifications).values(ids.map((userId) => ({ companyId, userId, kind: n.kind, title: n.title.slice(0, 200), body: n.body?.slice(0, 500) ?? null, link: n.link ?? null, dedupeKey: n.dedupeKey ?? null }))).onConflictDoNothing();
}

/** Who should hear about a task: a person's user, or the accountable manager of an AI employee. */
export async function recipientsFor(db: Db, companyId: string, o: { membershipId?: string | null; agentId?: string | null }): Promise<string[]> {
  let mid = o.membershipId ?? null;
  if (!mid && o.agentId) { const [a] = await db.select({ m: S.aiAgents.managerMembershipId }).from(S.aiAgents).where(and(eq(S.aiAgents.companyId, companyId), eq(S.aiAgents.id, o.agentId))); mid = a?.m ?? null; }
  if (!mid) return [];
  const [m] = await db.select({ u: S.companyMemberships.userId }).from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, companyId), eq(S.companyMemberships.id, mid)));
  return m ? [m.u] : [];
}
export async function ownerUserIds(db: Db, companyId: string) {
  const r = await db.select({ u: S.companyMemberships.userId }).from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, companyId), eq(S.companyMemberships.accessLevel, 'owner'), eq(S.companyMemberships.status, 'active')));
  return r.map((x) => x.u);
}

/** Idempotent: creates "due soon" (≤2 days) and "overdue" notifications for the caller's own open tasks. */
export async function syncDeadlineNotifications(ctx: Ctx, now = new Date()) {
  const t0 = today(now), soon = addDays(t0, 2);
  const mine = await ctx.db.select({ id: S.tasks.id, title: S.tasks.title, due: S.tasks.dueDate }).from(S.tasks)
    .where(and(eq(S.tasks.companyId, ctx.companyId), eq(S.tasks.ownerMembershipId, ctx.membership.id), isNull(S.tasks.archivedAt), inArray(S.tasks.status, ['todo', 'in_progress', 'blocked', 'in_review', 'awaiting_approval']), sql`${S.tasks.dueDate} is not null and ${S.tasks.dueDate} <= ${soon}`));
  for (const t of mine) {
    const overdue = t.due! < t0;
    await notify(ctx.db, ctx.companyId, [ctx.user.id], { kind: overdue ? 'task_overdue' : 'task_due_soon', title: overdue ? `Overdue: ${t.title}` : `Due ${t.due === t0 ? 'today' : 'soon'}: ${t.title}`, body: `Due ${t.due}`, link: `/c/${ctx.companyId}/tasks?task=${t.id}`, dedupeKey: `${overdue ? 'overdue' : 'soon'}:${t.id}:${t.due}` });
  }
}

export async function listNotifications(ctx: Ctx, unreadOnly = false) {
  await syncDeadlineNotifications(ctx);
  const rows = await ctx.db.select().from(S.notifications).where(and(eq(S.notifications.companyId, ctx.companyId), eq(S.notifications.userId, ctx.user.id), unreadOnly ? isNull(S.notifications.readAt) : undefined)).orderBy(desc(S.notifications.createdAt)).limit(50);
  const [u] = await ctx.db.select({ n: sql<number>`count(*)` }).from(S.notifications).where(and(eq(S.notifications.companyId, ctx.companyId), eq(S.notifications.userId, ctx.user.id), isNull(S.notifications.readAt)));
  return { notifications: rows, unread: Number(u.n) };
}
export async function markRead(ctx: Ctx, id?: string) {
  await ctx.db.update(S.notifications).set({ readAt: new Date() }).where(and(eq(S.notifications.companyId, ctx.companyId), eq(S.notifications.userId, ctx.user.id), isNull(S.notifications.readAt), id ? eq(S.notifications.id, id) : undefined));
}
