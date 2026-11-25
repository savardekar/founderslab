import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { KNOWLEDGE_TYPES, type KnowledgeType } from '@/lib/constants';
import { badRequest, forbidden, notFound } from '@/lib/errors';
import { audit } from '../audit';
import type { Ctx } from '../authz';
import { chunkText, cosine, getEmbedder, tokenize } from '../ai/embeddings';
import { KNOWLEDGE_FILE_TYPES, extractText } from './extract';

const S = schema;
type Doc = typeof S.knowledgeDocuments.$inferSelect;
type Acl = { scopeType: string; scopeId: string };
const MAX_FILE = 2 * 1024 * 1024;
export type DocInput = { title: string; docType?: KnowledgeType; tags?: string[]; visibility?: 'company' | 'department' | 'role' | 'restricted'; confidential?: boolean; departmentId?: string | null; roleId?: string | null; projectId?: string | null; responsibilityId?: string | null; status?: 'draft' | 'published'; reviewDate?: string | null; body?: string; file?: { fileName: string; contentType: string; dataBase64: string } | null; changeNote?: string | null; access?: Acl[] };

// ───────────── who may read what ─────────────
async function viewer(ctx: Ctx) {
  const [e] = await ctx.db.select({ d: S.employees.departmentId }).from(S.employees).where(and(eq(S.employees.companyId, ctx.companyId), eq(S.employees.membershipId, ctx.membership.id)));
  const roles = await ctx.db.select({ id: S.roles.id, d: S.roles.departmentId }).from(S.roles).where(eq(S.roles.companyId, ctx.companyId));
  const depts = new Set(ctx.myDepartmentIds); if (e?.d) depts.add(e.d);
  return { roles: ctx.myRoleIds, depts, roleDept: new Map(roles.map((r) => [r.id, r.d])), mid: ctx.membership.id };
}
type V = Awaited<ReturnType<typeof viewer>>;

/** Human read access. Scope alone never opens confidential/restricted documents; an owner, author, knowledge administrator or explicit grant does. */
export function humanCanRead(ctx: Ctx, d: Doc, acl: Acl[], v: V): boolean {
  if (ctx.isOwner || d.ownerMembershipId === v.mid || ctx.can('knowledge.configure')) return true;
  if (d.status === 'draft') return false;
  if (acl.some((g) => (g.scopeType === 'member' && g.scopeId === v.mid) || (g.scopeType === 'role' && v.roles.has(g.scopeId)) || (g.scopeType === 'department' && v.depts.has(g.scopeId)))) return true;
  if (d.confidential || d.visibility === 'restricted') return false;
  if (d.visibility === 'company') return true;
  if (d.visibility === 'department') return !!d.departmentId && (v.depts.has(d.departmentId) || ctx.can('knowledge.view', { departmentId: d.departmentId }));
  return !!d.roleId && (v.roles.has(d.roleId) || ctx.can('knowledge.view', { roleId: d.roleId, departmentId: v.roleDept.get(d.roleId) ?? null }));
}
export type AgentScope = { id: string; scope: string; roles: Set<string>; depts: Set<string> };
/** AI read access: the agent's knowledge scope, plus explicit grants. Confidential and restricted documents are only ever reachable by an explicit grant; drafts never. */
export function agentCanRead(d: Doc, acl: Acl[], a: AgentScope): boolean {
  if (d.status === 'draft' || a.scope === 'none') return false;
  if (acl.some((g) => (g.scopeType === 'agent' && g.scopeId === a.id) || (g.scopeType === 'role' && a.roles.has(g.scopeId)) || (g.scopeType === 'department' && a.depts.has(g.scopeId)))) return true;
  if (d.confidential || d.visibility === 'restricted') return false;
  if (a.scope === 'company') return true;
  if (d.visibility === 'role') return !!d.roleId && a.roles.has(d.roleId);
  if (a.scope === 'role') return false;
  if (d.visibility === 'company') return true;
  return !!d.departmentId && a.depts.has(d.departmentId);
}

async function aclMap(db: Db, companyId: string, ids?: string[]) {
  const rows = await db.select().from(S.knowledgeAccess).where(and(eq(S.knowledgeAccess.companyId, companyId), isNull(S.knowledgeAccess.revokedAt), ids?.length ? inArray(S.knowledgeAccess.documentId, ids) : undefined));
  const m = new Map<string, Acl[]>(); rows.forEach((r) => m.set(r.documentId, [...(m.get(r.documentId) ?? []), { scopeType: r.scopeType, scopeId: r.scopeId }])); return m;
}
const target = (d: Pick<Doc, 'departmentId' | 'roleId'>) => ({ departmentId: d.departmentId, roleId: d.roleId });
const isManager = (ctx: Ctx, d: Doc) => ctx.isOwner || d.ownerMembershipId === ctx.membership.id || ctx.can('knowledge.configure');
const canEdit = (ctx: Ctx, d: Doc) => d.ownerMembershipId === ctx.membership.id || ctx.can('knowledge.edit', target(d));

async function loadDoc(ctx: Ctx, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Document not found');
  const [d] = await ctx.db.select().from(S.knowledgeDocuments).where(and(eq(S.knowledgeDocuments.companyId, ctx.companyId), eq(S.knowledgeDocuments.id, id), isNull(S.knowledgeDocuments.archivedAt)));
  if (!d) throw notFound('Document not found');
  const acl = (await aclMap(ctx.db, ctx.companyId, [id])).get(id) ?? []; const v = await viewer(ctx);
  if (!humanCanRead(ctx, d, acl, v)) throw notFound('Document not found'); // existence is not revealed
  return { d, acl, v };
}

// ───────────── writing ─────────────
async function checkRefs(ctx: Ctx, i: Partial<DocInput>, vis?: string) {
  const one = async (t: any, col: any, val: string | null | undefined, msg: string, extra?: any) => { if (!val) return; const [r] = await ctx.db.select({ id: col }).from(t).where(and(eq((t as any).companyId, ctx.companyId), eq(col, val), extra)); if (!r) throw badRequest(msg); };
  await one(S.departments, S.departments.id, i.departmentId, 'Department not found', isNull(S.departments.archivedAt));
  await one(S.roles, S.roles.id, i.roleId, 'Role not found', isNull(S.roles.archivedAt));
  await one(S.projects, S.projects.id, i.projectId, 'Project not found', isNull(S.projects.archivedAt));
  await one(S.roleResponsibilities, S.roleResponsibilities.id, i.responsibilityId, 'Responsibility not found', isNull(S.roleResponsibilities.archivedAt));
  if (vis === 'department' && !i.departmentId) throw badRequest('Choose the department this document belongs to');
  if (vis === 'role' && !i.roleId) throw badRequest('Choose the role this document belongs to');
}
const normTags = (t?: string[]) => [...new Set((t ?? []).map((x) => x.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean))].slice(0, 20).map((x) => x.slice(0, 40));

async function readFile(f: NonNullable<DocInput['file']>) {
  const name = f.fileName.replace(/[\\/\0\r\n"]/g, '_').replace(/^\.+/, '').trim().slice(0, 150) || 'file';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (!KNOWLEDGE_FILE_TYPES[ext]?.includes(f.contentType.toLowerCase())) throw badRequest('This file type is not allowed. Allowed: txt, md, csv, pdf, docx, xlsx, pptx, png, jpg');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(f.dataBase64)) throw badRequest('Invalid file data');
  const buf = Buffer.from(f.dataBase64, 'base64');
  if (!buf.length || buf.length > MAX_FILE) throw badRequest(`Files must be between 1 byte and ${MAX_FILE / 1024 / 1024} MB`);
  const t = await extractText(name, buf);
  return { name, type: f.contentType.toLowerCase(), size: buf.length, sha: createHash('sha256').update(buf).digest('hex'), data: f.dataBase64, text: t.text, extracted: t.ok };
}

/** (Re)builds the search index for a document's current version. Old versions stay readable but are not searched. */
export async function indexDocument(db: Db, companyId: string, documentId: string, versionId: string, title: string, tags: string[], body: string) {
  const emb = getEmbedder(); const chunks = chunkText(body);
  await db.delete(S.knowledgeChunks).where(and(eq(S.knowledgeChunks.companyId, companyId), eq(S.knowledgeChunks.documentId, documentId)));
  if (!chunks.length) return 0;
  const vecs = await emb.embed(chunks.map((c) => `${title}\n${tags.join(' ')}\n${c.heading ?? ''}\n${c.content}`));
  await db.insert(S.knowledgeChunks).values(chunks.map((c, i) => ({ companyId, documentId, versionId, chunkIndex: i, heading: c.heading, content: c.content, embedding: vecs[i], embeddingModel: emb.model })));
  return chunks.length;
}

export async function createDocument(ctx: Ctx, i: DocInput) {
  const vis = i.visibility ?? 'company'; const tg = { departmentId: i.departmentId ?? null, roleId: i.roleId ?? null };
  ctx.require('knowledge.create', tg);
  await checkRefs(ctx, i, vis);
  const file = i.file ? await readFile(i.file) : null;
  const body = [i.body?.trim(), file?.text].filter(Boolean).join('\n\n');
  if (!body && !file) throw badRequest('Write some content or upload a file');
  for (const g of i.access ?? []) await checkGrant(ctx, g);
  const tags = normTags(i.tags);
  return ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const [d] = await db.insert(S.knowledgeDocuments).values({ companyId: ctx.companyId, title: i.title, docType: i.docType ?? 'other', tags, visibility: vis, confidential: !!i.confidential, departmentId: i.departmentId ?? null, roleId: i.roleId ?? null, projectId: i.projectId ?? null, responsibilityId: i.responsibilityId ?? null, ownerMembershipId: ctx.membership.id, status: i.status ?? 'published', reviewDate: i.reviewDate ?? null, createdBy: ctx.user.id }).returning();
    const [v] = await db.insert(S.knowledgeVersions).values({ companyId: ctx.companyId, documentId: d.id, version: 1, title: i.title, body, changeNote: i.changeNote ?? 'Initial version', fileName: file?.name ?? null, contentType: file?.type ?? null, sizeBytes: file?.size ?? null, sha256: file?.sha ?? null, dataBase64: file?.data ?? null, textExtracted: file ? file.extracted : true, createdBy: ctx.user.id }).returning();
    await indexDocument(db, ctx.companyId, d.id, v.id, i.title, tags, body);
    if (i.access?.length) await db.insert(S.knowledgeAccess).values(i.access.map((g) => ({ companyId: ctx.companyId, documentId: d.id, scopeType: g.scopeType, scopeId: g.scopeId, grantedBy: ctx.user.id })));
    await audit(db, ctx.companyId, ctx.user.id, 'knowledge.created', 'document', d.id, { name: i.title, docType: d.docType, visibility: vis, confidential: d.confidential, searchable: file ? file.extracted : true });
    return { ...d, textExtracted: file ? file.extracted : true };
  });
}

export async function updateDocument(ctx: Ctx, id: string, p: Partial<DocInput>) {
  const { d } = await loadDoc(ctx, id);
  if (!canEdit(ctx, d)) throw forbidden();
  if (p.departmentId !== undefined || p.roleId !== undefined) { if (!isManager(ctx, d)) throw forbidden('Only the owner, the author or a knowledge administrator can move a document'); }
  const next = { departmentId: p.departmentId !== undefined ? p.departmentId : d.departmentId, roleId: p.roleId !== undefined ? p.roleId : d.roleId };
  await checkRefs(ctx, { ...p, ...next }, d.visibility);
  const file = p.file ? await readFile(p.file) : null; const newBody = p.body !== undefined || file ? [p.body?.trim(), file?.text].filter(Boolean).join('\n\n') : null;
  const tags = p.tags ? normTags(p.tags) : d.tags; const title = p.title ?? d.title;
  return ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Db; const set: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ['title', 'docType', 'projectId', 'responsibilityId', 'reviewDate'] as const) if (p[k] !== undefined) set[k] = p[k];
    if (p.tags) set.tags = tags; if (p.departmentId !== undefined) set.departmentId = p.departmentId; if (p.roleId !== undefined) set.roleId = p.roleId;
    let version = d.currentVersion;
    if (newBody !== null || p.title !== undefined) {
      const [cur] = await db.select().from(S.knowledgeVersions).where(and(eq(S.knowledgeVersions.documentId, id), eq(S.knowledgeVersions.version, d.currentVersion)));
      const body = newBody ?? cur.body; if (newBody !== null && !body && !file) throw badRequest('A document cannot be empty');
      if (newBody !== null || body !== cur.body || title !== cur.title) {
        version = d.currentVersion + 1;
        const [v] = await db.insert(S.knowledgeVersions).values({ companyId: ctx.companyId, documentId: id, version, title, body, changeNote: p.changeNote ?? null, fileName: file ? file.name : cur.fileName, contentType: file ? file.type : cur.contentType, sizeBytes: file ? file.size : cur.sizeBytes, sha256: file ? file.sha : cur.sha256, dataBase64: file ? file.data : cur.dataBase64, textExtracted: file ? file.extracted : cur.textExtracted, createdBy: ctx.user.id }).returning();
        set.currentVersion = version; await indexDocument(db, ctx.companyId, id, v.id, title, tags, body);
      }
    } else if (p.tags) { const [c] = await db.select().from(S.knowledgeVersions).where(and(eq(S.knowledgeVersions.documentId, id), eq(S.knowledgeVersions.version, d.currentVersion))); await indexDocument(db, ctx.companyId, id, c.id, title, tags, c.body); }
    await db.update(S.knowledgeDocuments).set(set).where(and(eq(S.knowledgeDocuments.companyId, ctx.companyId), eq(S.knowledgeDocuments.id, id)));
    await audit(db, ctx.companyId, ctx.user.id, 'knowledge.updated', 'document', id, { name: d.title, newVersion: version !== d.currentVersion ? version : null, fields: Object.keys(p).filter((k) => k !== 'body' && k !== 'file') });
    return { version };
  });
}

export async function setDocumentSecurity(ctx: Ctx, id: string, p: { visibility?: Doc['visibility']; confidential?: boolean; departmentId?: string | null; roleId?: string | null }) {
  const { d } = await loadDoc(ctx, id);
  if (!isManager(ctx, d)) throw forbidden('Only the owner, the author or a knowledge administrator can change who can read a document');
  const vis = p.visibility ?? d.visibility; const departmentId = p.departmentId !== undefined ? p.departmentId : d.departmentId, roleId = p.roleId !== undefined ? p.roleId : d.roleId;
  await checkRefs(ctx, { departmentId, roleId }, vis);
  await ctx.db.update(S.knowledgeDocuments).set({ visibility: vis, confidential: p.confidential ?? d.confidential, departmentId, roleId, updatedAt: new Date() }).where(and(eq(S.knowledgeDocuments.companyId, ctx.companyId), eq(S.knowledgeDocuments.id, id)));
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'knowledge.security_changed', 'document', id, { name: d.title, from: { visibility: d.visibility, confidential: d.confidential }, to: { visibility: vis, confidential: p.confidential ?? d.confidential } });
}

export async function publishDocument(ctx: Ctx, id: string) {
  const { d } = await loadDoc(ctx, id); if (!canEdit(ctx, d)) throw forbidden();
  if (d.status === 'published') throw badRequest('Already published');
  await ctx.db.update(S.knowledgeDocuments).set({ status: 'published', updatedAt: new Date() }).where(and(eq(S.knowledgeDocuments.companyId, ctx.companyId), eq(S.knowledgeDocuments.id, id)));
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'knowledge.published', 'document', id, { name: d.title });
}
export async function restoreVersion(ctx: Ctx, id: string, version: number) {
  const { d } = await loadDoc(ctx, id); if (!canEdit(ctx, d)) throw forbidden();
  const [old] = await ctx.db.select().from(S.knowledgeVersions).where(and(eq(S.knowledgeVersions.documentId, id), eq(S.knowledgeVersions.version, version)));
  if (!old) throw notFound('Version not found');
  return ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Db; const next = d.currentVersion + 1;
    const [v] = await db.insert(S.knowledgeVersions).values({ companyId: ctx.companyId, documentId: id, version: next, title: old.title, body: old.body, changeNote: `Restored from version ${version}`, fileName: old.fileName, contentType: old.contentType, sizeBytes: old.sizeBytes, sha256: old.sha256, dataBase64: old.dataBase64, textExtracted: old.textExtracted, createdBy: ctx.user.id }).returning();
    await db.update(S.knowledgeDocuments).set({ currentVersion: next, title: old.title, updatedAt: new Date() }).where(and(eq(S.knowledgeDocuments.companyId, ctx.companyId), eq(S.knowledgeDocuments.id, id)));
    await indexDocument(db, ctx.companyId, id, v.id, old.title, d.tags, old.body);
    await audit(db, ctx.companyId, ctx.user.id, 'knowledge.version_restored', 'document', id, { name: d.title, from: version, to: next });
    return { version: next };
  });
}
/** Archiving removes the document from search and from AI retrieval immediately; every version is kept. */
export async function archiveDocument(ctx: Ctx, id: string) {
  const { d } = await loadDoc(ctx, id);
  if (!(ctx.can('knowledge.delete', target(d)) || ctx.isOwner || (d.ownerMembershipId === ctx.membership.id && d.status === 'draft'))) throw forbidden();
  await ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    await db.update(S.knowledgeDocuments).set({ archivedAt: new Date() }).where(and(eq(S.knowledgeDocuments.companyId, ctx.companyId), eq(S.knowledgeDocuments.id, id)));
    await db.delete(S.knowledgeChunks).where(and(eq(S.knowledgeChunks.companyId, ctx.companyId), eq(S.knowledgeChunks.documentId, id)));
    await audit(db, ctx.companyId, ctx.user.id, 'knowledge.archived', 'document', id, { name: d.title });
  });
}

async function checkGrant(ctx: Ctx, g: Acl) {
  const ok = { member: async () => (await ctx.db.select({ id: S.companyMemberships.id }).from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, ctx.companyId), eq(S.companyMemberships.id, g.scopeId), eq(S.companyMemberships.status, 'active')))).length, role: async () => (await ctx.db.select({ id: S.roles.id }).from(S.roles).where(and(eq(S.roles.companyId, ctx.companyId), eq(S.roles.id, g.scopeId), isNull(S.roles.archivedAt)))).length, department: async () => (await ctx.db.select({ id: S.departments.id }).from(S.departments).where(and(eq(S.departments.companyId, ctx.companyId), eq(S.departments.id, g.scopeId), isNull(S.departments.archivedAt)))).length, agent: async () => (await ctx.db.select({ id: S.aiAgents.id }).from(S.aiAgents).where(and(eq(S.aiAgents.companyId, ctx.companyId), eq(S.aiAgents.id, g.scopeId), isNull(S.aiAgents.archivedAt)))).length }[g.scopeType as 'member'];
  if (!ok || !(await ok())) throw badRequest(`Access target not found: ${g.scopeType}`);
}
export async function setAccess(ctx: Ctx, id: string, grants: Acl[]) {
  const { d, acl } = await loadDoc(ctx, id);
  if (!(isManager(ctx, d) || ctx.can('knowledge.assign', target(d)))) throw forbidden();
  const uniq = [...new Map(grants.map((g) => [`${g.scopeType}:${g.scopeId}`, g])).values()]; for (const g of uniq) await checkGrant(ctx, g);
  const key = (g: Acl) => `${g.scopeType}:${g.scopeId}`; const had = new Set(acl.map(key)), want = new Set(uniq.map(key));
  await ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    await db.update(S.knowledgeAccess).set({ revokedAt: new Date() }).where(and(eq(S.knowledgeAccess.companyId, ctx.companyId), eq(S.knowledgeAccess.documentId, id), isNull(S.knowledgeAccess.revokedAt)));
    if (uniq.length) await db.insert(S.knowledgeAccess).values(uniq.map((g) => ({ companyId: ctx.companyId, documentId: id, scopeType: g.scopeType, scopeId: g.scopeId, grantedBy: ctx.user.id })));
    await audit(db, ctx.companyId, ctx.user.id, 'knowledge.access_changed', 'document', id, { name: d.title, granted: uniq.filter((g) => !had.has(key(g))).map(key), revoked: [...had].filter((k) => !want.has(k)) });
  });
}

// ───────────── reading ─────────────
const dto = (ctx: Ctx, d: Doc, names: { dept: Map<string, string>; role: Map<string, string>; proj: Map<string, string>; owner: Map<string, string> }) => ({ id: d.id, title: d.title, docType: d.docType, tags: d.tags, visibility: d.visibility, confidential: d.confidential, status: d.status, version: d.currentVersion, departmentId: d.departmentId, departmentName: d.departmentId ? names.dept.get(d.departmentId) ?? null : null, roleId: d.roleId, roleName: d.roleId ? names.role.get(d.roleId) ?? null : null, projectId: d.projectId, projectName: d.projectId ? names.proj.get(d.projectId) ?? null : null, responsibilityId: d.responsibilityId, ownerMembershipId: d.ownerMembershipId, ownerName: names.owner.get(d.ownerMembershipId) ?? '', reviewDate: d.reviewDate, updatedAt: d.updatedAt, createdAt: d.createdAt, canEdit: canEdit(ctx, d) });
async function nameMaps(ctx: Ctx) {
  const [dp, rl, pj, ow] = await Promise.all([ctx.db.select({ id: S.departments.id, n: S.departments.name }).from(S.departments).where(eq(S.departments.companyId, ctx.companyId)), ctx.db.select({ id: S.roles.id, n: S.roles.name }).from(S.roles).where(eq(S.roles.companyId, ctx.companyId)), ctx.db.select({ id: S.projects.id, n: S.projects.name }).from(S.projects).where(eq(S.projects.companyId, ctx.companyId)), ctx.db.select({ id: S.companyMemberships.id, n: S.users.name }).from(S.companyMemberships).innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId)).where(eq(S.companyMemberships.companyId, ctx.companyId))]);
  const m = (a: { id: string; n: string }[]) => new Map(a.map((x) => [x.id, x.n]));
  return { dept: m(dp), role: m(rl), proj: m(pj), owner: m(ow) };
}

export type DocFilters = { docType?: string; tag?: string; departmentId?: string; roleId?: string; projectId?: string; status?: string; mine?: boolean; needsReview?: boolean };
async function permitted(ctx: Ctx, f: DocFilters = {}) {
  const docs = await ctx.db.select().from(S.knowledgeDocuments).where(and(eq(S.knowledgeDocuments.companyId, ctx.companyId), isNull(S.knowledgeDocuments.archivedAt),
    f.docType ? eq(S.knowledgeDocuments.docType, f.docType as KnowledgeType) : undefined, f.departmentId ? eq(S.knowledgeDocuments.departmentId, f.departmentId) : undefined, f.roleId ? eq(S.knowledgeDocuments.roleId, f.roleId) : undefined, f.projectId ? eq(S.knowledgeDocuments.projectId, f.projectId) : undefined, f.status ? eq(S.knowledgeDocuments.status, f.status) : undefined,
    f.mine ? eq(S.knowledgeDocuments.ownerMembershipId, ctx.membership.id) : undefined, f.needsReview ? sql`${S.knowledgeDocuments.reviewDate} <= current_date` : undefined)).orderBy(desc(S.knowledgeDocuments.updatedAt));
  const acl = await aclMap(ctx.db, ctx.companyId); const v = await viewer(ctx);
  return docs.filter((d) => (!f.tag || d.tags.includes(f.tag.toLowerCase())) && humanCanRead(ctx, d, acl.get(d.id) ?? [], v));
}

export async function listDocuments(ctx: Ctx, f: DocFilters & { q?: string } = {}) {
  const docs = await permitted(ctx, f); const names = await nameMaps(ctx); const q = f.q?.trim().toLowerCase();
  return docs.filter((d) => !q || d.title.toLowerCase().includes(q) || d.tags.some((t) => t.includes(q))).map((d) => dto(ctx, d, names));
}

export async function getDocument(ctx: Ctx, id: string) {
  const { d, acl } = await loadDoc(ctx, id); const names = await nameMaps(ctx);
  const [cur] = await ctx.db.select().from(S.knowledgeVersions).where(and(eq(S.knowledgeVersions.documentId, id), eq(S.knowledgeVersions.version, d.currentVersion)));
  const versions = await ctx.db.select({ version: S.knowledgeVersions.version, title: S.knowledgeVersions.title, changeNote: S.knowledgeVersions.changeNote, createdAt: S.knowledgeVersions.createdAt, by: S.users.name, fileName: S.knowledgeVersions.fileName }).from(S.knowledgeVersions).leftJoin(S.users, eq(S.users.id, S.knowledgeVersions.createdBy)).where(eq(S.knowledgeVersions.documentId, id)).orderBy(desc(S.knowledgeVersions.version));
  const manage = isManager(ctx, d) || ctx.can('knowledge.assign', target(d));
  if ((d.confidential || d.visibility === 'restricted') && d.ownerMembershipId !== ctx.membership.id) await ctx.db.insert(S.knowledgeAccessLog).values({ companyId: ctx.companyId, documentId: id, version: d.currentVersion, actorUserId: ctx.user.id, via: 'view' });
  let access: any[] = [];
  if (manage) { const [mem, rol, dep, ag] = await Promise.all([ctx.db.select({ id: S.companyMemberships.id, n: S.users.name }).from(S.companyMemberships).innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId)).where(eq(S.companyMemberships.companyId, ctx.companyId)), ctx.db.select({ id: S.roles.id, n: S.roles.name }).from(S.roles).where(eq(S.roles.companyId, ctx.companyId)), ctx.db.select({ id: S.departments.id, n: S.departments.name }).from(S.departments).where(eq(S.departments.companyId, ctx.companyId)), ctx.db.select({ id: S.aiAgents.id, n: S.aiAgents.name }).from(S.aiAgents).where(eq(S.aiAgents.companyId, ctx.companyId))]);
    const nm = { member: new Map(mem.map((x) => [x.id, x.n])), role: new Map(rol.map((x) => [x.id, x.n])), department: new Map(dep.map((x) => [x.id, x.n])), agent: new Map(ag.map((x) => [x.id, x.n])) } as Record<string, Map<string, string>>;
    access = acl.map((g) => ({ ...g, name: nm[g.scopeType]?.get(g.scopeId) ?? '(removed)' })); }
  const aiReads = manage ? await ctx.db.select({ via: S.knowledgeAccessLog.via, at: S.knowledgeAccessLog.createdAt, agent: S.aiAgents.name, user: S.users.name }).from(S.knowledgeAccessLog).leftJoin(S.aiAgents, and(eq(S.aiAgents.companyId, S.knowledgeAccessLog.companyId), eq(S.aiAgents.id, S.knowledgeAccessLog.actorAgentId))).leftJoin(S.users, eq(S.users.id, S.knowledgeAccessLog.actorUserId)).where(and(eq(S.knowledgeAccessLog.companyId, ctx.companyId), eq(S.knowledgeAccessLog.documentId, id))).orderBy(desc(S.knowledgeAccessLog.createdAt)).limit(20) : [];
  return { document: dto(ctx, d, names), body: cur?.body ?? '', file: cur?.fileName ? { fileName: cur.fileName, contentType: cur.contentType, sizeBytes: cur.sizeBytes, textExtracted: cur.textExtracted } : null, versions, access, readLog: aiReads, can: { edit: canEdit(ctx, d), manage, delete: ctx.can('knowledge.delete', target(d)) || ctx.isOwner } };
}
export async function getVersion(ctx: Ctx, id: string, version: number) {
  const { d } = await loadDoc(ctx, id);
  const [v] = await ctx.db.select().from(S.knowledgeVersions).where(and(eq(S.knowledgeVersions.documentId, id), eq(S.knowledgeVersions.version, version)));
  if (!v) throw notFound('Version not found');
  return { version: v.version, title: v.title, body: v.body, changeNote: v.changeNote, createdAt: v.createdAt, current: v.version === d.currentVersion };
}
export async function downloadFile(ctx: Ctx, id: string, version?: number) {
  const { d } = await loadDoc(ctx, id);
  const [v] = await ctx.db.select().from(S.knowledgeVersions).where(and(eq(S.knowledgeVersions.documentId, id), eq(S.knowledgeVersions.version, version ?? d.currentVersion)));
  if (!v?.dataBase64) throw notFound('This version has no attached file');
  if (d.confidential || d.visibility === 'restricted') await ctx.db.insert(S.knowledgeAccessLog).values({ companyId: ctx.companyId, documentId: id, version: v.version, actorUserId: ctx.user.id, via: 'download' });
  return new Response(new Uint8Array(Buffer.from(v.dataBase64, 'base64')), { headers: { 'content-type': v.contentType ?? 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(v.fileName ?? 'file')}`, 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'", 'cache-control': 'private, no-store' } });
}

// ───────────── search & retrieval ─────────────
export type Hit = { documentId: string; title: string; docType: string; version: number; chunk: number; ref: string; heading: string | null; snippet: string; score: number; tags: string[]; confidential: boolean; visibility: string; updatedAt: Date };

/** Hybrid ranking over ONLY the documents the caller is already allowed to read: BM25-style keyword score + vector similarity. */
async function rank(db: Db, companyId: string, docs: Doc[], q: string, limit: number): Promise<{ hits: Hit[]; method: string }> {
  const emb = getEmbedder(); const qt = [...new Set(tokenize(q))]; const byId = new Map(docs.map((d) => [d.id, d])); const ids = [...byId.keys()];
  if (!ids.length || !qt.length) return { hits: [], method: emb.label };
  const chunks: (typeof S.knowledgeChunks.$inferSelect)[] = [];
  for (let i = 0; i < ids.length; i += 400) chunks.push(...(await db.select().from(S.knowledgeChunks).where(and(eq(S.knowledgeChunks.companyId, companyId), inArray(S.knowledgeChunks.documentId, ids.slice(i, i + 400))))));
  if (!chunks.length) return { hits: [], method: emb.label };
  const [qv] = await emb.embed([q]);
  const toks = chunks.map((c) => { const d = byId.get(c.documentId)!; return tokenize(`${d.title} ${d.tags.join(' ')} ${c.heading ?? ''} ${c.content}`); });
  const avg = toks.reduce((s, t) => s + t.length, 0) / toks.length || 1; const df = new Map<string, number>(); for (const t of qt) df.set(t, toks.filter((x) => x.includes(t)).length);
  const kw = toks.map((t) => { let s = 0; for (const w of qt) { const n = df.get(w)!; if (!n) continue; const tf = t.filter((x) => x === w).length; if (!tf) continue; s += Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5)) * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (t.length / avg)))); } return s; });
  const maxKw = Math.max(...kw, 0) || 1;
  const scored = chunks.map((c, i) => { const vec = c.embeddingModel === emb.model ? cosine(qv, c.embedding) : null; const k = kw[i] / maxKw; const score = vec == null ? k : 0.6 * Math.max(0, vec) + 0.4 * k; return { c, score, k, vec }; }).filter((x) => x.k > 0 || (x.vec ?? 0) >= 0.3).filter((x) => x.score >= 0.12).sort((a, b) => b.score - a.score);
  const seen = new Set<string>(); const hits: Hit[] = [];
  for (const x of scored) { if (seen.has(x.c.documentId)) continue; seen.add(x.c.documentId); const d = byId.get(x.c.documentId)!; hits.push({ documentId: d.id, title: d.title, docType: d.docType, version: d.currentVersion, chunk: x.c.chunkIndex, ref: `doc:${d.id}@v${d.currentVersion}#${x.c.chunkIndex}`, heading: x.c.heading, snippet: x.c.content.slice(0, 360), score: Math.round(x.score * 1000) / 1000, tags: d.tags, confidential: d.confidential, visibility: d.visibility, updatedAt: d.updatedAt }); if (hits.length >= limit) break; }
  return { hits, method: emb.label };
}

export async function searchDocuments(ctx: Ctx, q: string, f: DocFilters = {}, limit = 10) {
  const docs = await permitted(ctx, f);
  const r = await rank(ctx.db, ctx.companyId, docs, q, Math.min(limit, 25));
  return { query: q, method: r.method, results: r.hits, searched: docs.length };
}

export async function agentScope(db: Db, companyId: string, agentId: string, scope: string): Promise<AgentScope> {
  const a = await db.select({ roleId: S.roleAssignments.roleId, d: S.roles.departmentId }).from(S.roleAssignments).innerJoin(S.roles, and(eq(S.roles.companyId, S.roleAssignments.companyId), eq(S.roles.id, S.roleAssignments.roleId))).where(and(eq(S.roleAssignments.companyId, companyId), eq(S.roleAssignments.agentId, agentId), isNull(S.roleAssignments.endedAt), isNull(S.roles.archivedAt)));
  const [ag] = await db.select({ d: S.aiAgents.departmentId }).from(S.aiAgents).where(and(eq(S.aiAgents.companyId, companyId), eq(S.aiAgents.id, agentId)));
  return { id: agentId, scope, roles: new Set(a.map((x) => x.roleId)), depts: new Set([...a.map((x) => x.d), ag?.d].filter((x): x is string => !!x)) };
}
async function permittedForAgent(db: Db, companyId: string, a: AgentScope) {
  if (a.scope === 'none') return [];
  const docs = await db.select().from(S.knowledgeDocuments).where(and(eq(S.knowledgeDocuments.companyId, companyId), isNull(S.knowledgeDocuments.archivedAt), eq(S.knowledgeDocuments.status, 'published')));
  const acl = await aclMap(db, companyId);
  return docs.filter((d) => agentCanRead(d, acl.get(d.id) ?? [], a));
}
/** Retrieval used by AI employees. Nothing outside the agent's scope or explicit grants is ever loaded, ranked or returned; every returned document is logged. */
export async function retrieveForAgent(db: Db, companyId: string, a: AgentScope, q: string, limit = 5, runId?: string | null) {
  const docs = await permittedForAgent(db, companyId, a); const r = await rank(db, companyId, docs, q, Math.min(limit, 8));
  if (r.hits.length) await db.insert(S.knowledgeAccessLog).values(r.hits.map((h) => ({ companyId, documentId: h.documentId, version: h.version, actorAgentId: a.id, runId: runId ?? null, via: 'ai_search', query: q.slice(0, 300) })));
  return { ...r, searched: docs.length };
}
export async function readForAgent(db: Db, companyId: string, a: AgentScope, docId: string, runId?: string | null) {
  const docs = await permittedForAgent(db, companyId, a); const d = docs.find((x) => x.id === docId);
  if (!d) return null; // not found and not permitted look identical
  const [v] = await db.select().from(S.knowledgeVersions).where(and(eq(S.knowledgeVersions.documentId, d.id), eq(S.knowledgeVersions.version, d.currentVersion)));
  await db.insert(S.knowledgeAccessLog).values({ companyId, documentId: d.id, version: d.currentVersion, actorAgentId: a.id, runId: runId ?? null, via: 'ai_read' });
  return { ref: `doc:${d.id}@v${d.currentVersion}`, title: d.title, docType: d.docType, version: d.currentVersion, body: (v?.body ?? '').slice(0, 6000), truncated: (v?.body ?? '').length > 6000 };
}

export async function reindexAll(ctx: Ctx) {
  ctx.require('knowledge.configure');
  const docs = await ctx.db.select().from(S.knowledgeDocuments).where(and(eq(S.knowledgeDocuments.companyId, ctx.companyId), isNull(S.knowledgeDocuments.archivedAt)));
  let n = 0;
  for (const d of docs) { const [v] = await ctx.db.select().from(S.knowledgeVersions).where(and(eq(S.knowledgeVersions.documentId, d.id), eq(S.knowledgeVersions.version, d.currentVersion))); if (v) n += await indexDocument(ctx.db, ctx.companyId, d.id, v.id, d.title, d.tags, v.body); }
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'knowledge.reindexed', 'document', null, { documents: docs.length, chunks: n, model: getEmbedder().model });
  return { documents: docs.length, chunks: n, model: getEmbedder().model };
}
export function knowledgeMeta() { const e = getEmbedder(); return { types: KNOWLEDGE_TYPES, embedding: { provider: e.id, model: e.model, semantic: e.semantic, label: e.label }, maxFileMB: MAX_FILE / 1024 / 1024, fileTypes: Object.keys(KNOWLEDGE_FILE_TYPES) }; }
