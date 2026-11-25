import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@/db/client';
import { conflict, notFound } from '@/lib/errors';
import { audit } from '../audit';
import type { Ctx } from '../authz';

const S = schema;
const dup = (e: any) => /dept_name_uq|duplicate key/i.test(String(e?.message ?? '') + String(e?.cause?.message ?? ''));

export async function listDepartments(ctx: Ctx) {
  ctx.require('departments.view');
  const rows = await ctx.db.select().from(S.departments).where(and(eq(S.departments.companyId, ctx.companyId), isNull(S.departments.archivedAt))).orderBy(asc(S.departments.position), asc(S.departments.name));
  const counts = await ctx.db.select({ d: S.roles.departmentId, n: sql<number>`count(*)` }).from(S.roles).where(and(eq(S.roles.companyId, ctx.companyId), isNull(S.roles.archivedAt))).groupBy(S.roles.departmentId);
  const c = new Map(counts.map((x) => [x.d, Number(x.n)]));
  return rows.map((d) => ({ id: d.id, name: d.name, description: d.description, roleCount: c.get(d.id) ?? 0 }));
}
export async function createDepartment(ctx: Ctx, input: { name: string; description?: string | null }) {
  ctx.require('departments.create');
  try {
    const [d] = await ctx.db.insert(S.departments).values({ companyId: ctx.companyId, name: input.name, description: input.description ?? null }).returning();
    await audit(ctx.db, ctx.companyId, ctx.user.id, 'department.created', 'department', d.id, { name: d.name });
    return d;
  } catch (e) { if (dup(e)) throw conflict('A department with this name already exists'); throw e; }
}
export async function updateDepartment(ctx: Ctx, id: string, input: { name: string; description?: string | null }) {
  ctx.require('departments.edit');
  try {
    const [d] = await ctx.db.update(S.departments).set({ name: input.name, description: input.description ?? null, updatedAt: new Date() }).where(and(eq(S.departments.companyId, ctx.companyId), eq(S.departments.id, id), isNull(S.departments.archivedAt))).returning();
    if (!d) throw notFound('Department not found');
    await audit(ctx.db, ctx.companyId, ctx.user.id, 'department.updated', 'department', id, input);
    return d;
  } catch (e) { if (dup(e)) throw conflict('A department with this name already exists'); throw e; }
}
/** Archive a department. Its roles are kept and become "unassigned to a department". */
export async function deleteDepartment(ctx: Ctx, id: string) {
  ctx.require('departments.delete');
  const r = await ctx.db.transaction(async (tx) => {
    const [d] = await tx.update(S.departments).set({ archivedAt: new Date() }).where(and(eq(S.departments.companyId, ctx.companyId), eq(S.departments.id, id), isNull(S.departments.archivedAt))).returning();
    if (!d) throw notFound('Department not found');
    const moved = await tx.update(S.roles).set({ departmentId: null }).where(and(eq(S.roles.companyId, ctx.companyId), eq(S.roles.departmentId, id))).returning({ id: S.roles.id });
    await audit(tx as any, ctx.companyId, ctx.user.id, 'department.deleted', 'department', id, { name: d.name, rolesUnassigned: moved.map((m) => m.id) });
    return { rolesUnassigned: moved.length };
  });
  return r;
}
