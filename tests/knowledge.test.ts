import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import type { Db } from '@/db/client';
import { schema } from '@/db/client';
import { handle } from '@/server/router';
import { addMember, call, makeCompany, makeRole, newDb, resetRateLimits, signup, type Client } from './helpers';
import { chunkText, localHashEmbedder, openaiEmbedder, setEmbedder, cosine, type Embedder } from '@/server/ai/embeddings';
import { registerProvider, unregisterProvider, type AiProvider, type CompletionResult } from '@/server/ai/provider';

let db: Db; let owner: Client; let cid: string;
const P = (p: string, id = cid) => `/companies/${id}${p}`;
beforeAll(async () => { process.env.EXPOSE_DEV_LINKS = '1'; db = await newDb(); });
beforeEach(async () => { resetRateLimits(); setEmbedder(null); owner = await signup(db, 'Founder'); cid = await makeCompany(db, owner); });
afterEach(() => { setEmbedder(null); unregisterProvider('scripted'); });
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const raw = (path: string, who: Client | null) => handle(new Request(`http://localhost:3000/api${path}`, { headers: { host: 'localhost:3000', ...(who ? { cookie: who.cookie } : {}) } }), db);
async function mkDoc(who: Client, body: object, status = 201) { const r = await call(db, 'POST', P('/knowledge'), { title: 'Doc', body: 'Some text', ...body }, who); expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body.document?.id as string; }
const search = async (who: Client, q: string, extra = '') => (await call(db, 'GET', P(`/knowledge/search?q=${encodeURIComponent(q)}${extra}`), undefined, who)).body;
const titles = (b: any) => b.results.map((r: any) => r.title);
const grantRole = (roleId: string, g: [string, string][]) => call(db, 'PUT', P(`/roles/${roleId}/permissions`), { grants: g.map(([key, scope]) => ({ key, scope })) }, owner).then((r) => expect(r.status).toBe(200));

describe('documents, files and versioning', () => {
  it('stores documents with type, tags and versions; every edit appends a version; old versions stay readable; restore appends too', async () => {
    const id = await mkDoc(owner, { title: 'Refund SOP', docType: 'sop', tags: ['Support', 'Refunds ', 'support'], body: '# Refunds\n\nRefund within 14 days.' });
    let d = (await call(db, 'GET', P(`/knowledge/${id}`), undefined, owner)).body;
    expect(d.document).toMatchObject({ title: 'Refund SOP', docType: 'sop', version: 1, tags: ['support', 'refunds'], status: 'published', ownerName: 'Founder' }); expect(d.versions).toHaveLength(1);
    expect((await call(db, 'PATCH', P(`/knowledge/${id}`), { body: '# Refunds\n\nRefund within 30 days.', changeNote: 'Extended window' }, owner)).body.version).toBe(2);
    expect((await call(db, 'PATCH', P(`/knowledge/${id}`), { tags: ['support', 'refunds', 'policy'] }, owner)).body.version).toBe(2);       // metadata only: no new version
    d = (await call(db, 'GET', P(`/knowledge/${id}`), undefined, owner)).body; expect(d.document.version).toBe(2); expect(d.body).toContain('30 days'); expect(d.versions.map((v: any) => v.version)).toEqual([2, 1]); expect(d.versions[0].changeNote).toBe('Extended window');
    expect((await call(db, 'GET', P(`/knowledge/${id}/versions/1`), undefined, owner)).body.body).toContain('14 days');
    expect((await call(db, 'POST', P(`/knowledge/${id}/restore`), { version: 1 }, owner)).body.version).toBe(3);
    d = (await call(db, 'GET', P(`/knowledge/${id}`), undefined, owner)).body; expect(d.body).toContain('14 days'); expect(d.versions).toHaveLength(3); expect(d.versions[0].changeNote).toMatch(/Restored from version 1/);
    expect((await call(db, 'GET', P(`/knowledge/${id}/versions/2`), undefined, owner)).body.body).toContain('30 days');                            // nothing was overwritten
    expect((await call(db, 'POST', P(`/knowledge/${id}/restore`), { version: 99 }, owner)).status).toBe(404);
  });

  it('uploads: text, Word and PDF content becomes searchable; images are stored but flagged not searchable; type, size and name are validated', async () => {
    const z = new JSZip(); z.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Quarterly onboarding playbook for warehouse partners</w:t></w:r></w:p></w:body></w:document>'); const docx = await z.generateAsync({ type: 'nodebuffer' });
    const pdf = await new Promise<Buffer>((res) => { const d = new PDFDocument(); const c: Buffer[] = []; d.on('data', (x: Buffer) => c.push(x)); d.on('end', () => res(Buffer.concat(c))); d.text('Escalation policy: critical incidents go to the on-call engineer within ten minutes.'); d.end(); });
    const mk = (fileName: string, contentType: string, data: Buffer | string) => call(db, 'POST', P('/knowledge'), { title: fileName, body: '', file: { fileName, contentType, dataBase64: b64(data) } }, owner);
    const t = await mk('notes.txt', 'text/plain', 'Vendor payment terms are net thirty days'); expect(t.status).toBe(201); expect(t.body.document.searchable).toBe(true);
    const w = await mk('playbook.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx); expect(w.body.document.searchable).toBe(true);
    const p = await mk('escalation.pdf', 'application/pdf', pdf); expect(p.body.document.searchable).toBe(true);
    const img = await mk('photo.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])); expect(img.status).toBe(201); expect(img.body.document.searchable).toBe(false);
    expect(titles(await search(owner, 'warehouse partners playbook'))).toContain('playbook.docx'); expect(titles(await search(owner, 'critical incidents on-call'))).toContain('escalation.pdf'); expect(titles(await search(owner, 'payment terms net thirty'))).toContain('notes.txt');
    const dl = await raw(P(`/knowledge/${t.body.document.id}/file`), owner); expect(dl.status).toBe(200); expect(await dl.text()).toBe('Vendor payment terms are net thirty days'); expect(dl.headers.get('content-disposition')).toMatch(/^attachment/); expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await mk('evil.html', 'text/html', '<script>alert(1)</script>')).status).toBe(400); expect((await mk('x.pdf', 'text/plain', 'x')).status).toBe(400); expect((await mk('big.pdf', 'application/pdf', Buffer.alloc(2 * 1024 * 1024 + 5))).status).toBe(400);
    expect((await call(db, 'POST', P('/knowledge'), { title: 'Empty' }, owner)).status).toBe(400);
    expect((await mk('../../etc/passwd.txt', 'text/plain', 'x')).status).toBe(201);
    const files = (await db.select().from(schema.knowledgeVersions)); expect(files.every((f) => !/[\\/]/.test(f.fileName ?? ''))).toBe(true);
  });

  it('chunker splits long text on paragraphs and keeps headings', () => {
    const text = '# Alpha\n\n' + Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ` + 'word '.repeat(60)).join('\n\n') + '\n\n## Beta\n\nShort closing section.';
    const c = chunkText(text); expect(c.length).toBeGreaterThan(3); expect(c.every((x) => x.content.length <= 1100)).toBe(true); expect(c[0].heading).toBe('Alpha'); expect(c.at(-1)!.heading).toBe('Beta'); expect(chunkText('')).toEqual([]);
  });
});

describe('who can read what (human access)', () => {
  async function org() {
    const dM = (await call(db, 'POST', P('/departments'), { name: 'Marketing' }, owner)).body.department.id, dF = (await call(db, 'POST', P('/departments'), { name: 'Finance' }, owner)).body.department.id;
    const cmo = await makeRole(db, owner, cid, { name: 'CMO', departmentId: dM }), cfo = await makeRole(db, owner, cid, { name: 'CFO', departmentId: dF }), exec = await makeRole(db, owner, cid, { name: 'Marketing Exec', departmentId: dM });
    for (const r of [cmo, cfo, exec]) await grantRole(r.id, [['company.view', 'company'], ['knowledge.create', 'department']]);
    await grantRole(exec.id, [['company.view', 'company']]);
    const u = { cmo: await addMember(db, owner, cid, 'member', cmo.id), cfo: await addMember(db, owner, cid, 'member', cfo.id), exec: await addMember(db, owner, cid, 'member', exec.id), nobody: await addMember(db, owner, cid) };
    return { dM, dF, cmo, cfo, exec, u };
  }
  it('company / department / role / restricted / confidential / draft visibility, with 404 instead of 403 so titles never leak', async () => {
    const o = await org();
    const pub = await mkDoc(owner, { title: 'Company handbook', visibility: 'company', body: 'handbook zebra' });
    const dept = await mkDoc(owner, { title: 'Marketing playbook', visibility: 'department', departmentId: o.dM, body: 'playbook walrus' });
    const role = await mkDoc(owner, { title: 'CFO close checklist', visibility: 'role', roleId: o.cfo.id, departmentId: o.dF, body: 'checklist giraffe' });
    const conf = await mkDoc(owner, { title: 'Acquisition memo', visibility: 'company', confidential: true, body: 'acquisition narwhal' });
    const restr = await mkDoc(owner, { title: 'Board minutes', visibility: 'restricted', body: 'minutes pangolin' });
    const draft = await mkDoc(owner, { title: 'Unfinished plan', status: 'draft', body: 'unfinished okapi' });
    const can = async (u: Client, id: string) => (await call(db, 'GET', P(`/knowledge/${id}`), undefined, u)).status === 200;
    const matrix = async (u: Client) => ({ pub: await can(u, pub), dept: await can(u, dept), role: await can(u, role), conf: await can(u, conf), restr: await can(u, restr), draft: await can(u, draft) });
    expect(await matrix(owner)).toEqual({ pub: true, dept: true, role: true, conf: true, restr: true, draft: true });
    expect(await matrix(o.u.exec.user)).toEqual({ pub: true, dept: true, role: false, conf: false, restr: false, draft: false });        // holds a Marketing role → Marketing documents, nothing confidential
    await call(db, 'PATCH', P(`/employees/${o.u.cmo.membershipId}`), { departmentId: o.dM }, owner);
    expect(await matrix(o.u.cmo.user)).toMatchObject({ pub: true, dept: true, role: false, conf: false, restr: false });
    expect(await matrix(o.u.cfo.user)).toMatchObject({ pub: true, dept: false, role: true, conf: false });                                  // holder of the CFO role
    expect(await matrix(o.u.nobody.user)).toMatchObject({ pub: true, dept: false, role: false });
    const list = (u: Client) => call(db, 'GET', P('/knowledge'), undefined, u).then((r) => r.body.documents.map((d: any) => d.title).sort());
    expect(await list(o.u.exec.user)).toEqual(['Company handbook', 'Marketing playbook']); expect(await list(o.u.nobody.user)).toEqual(['Company handbook']); expect(await list(o.u.cfo.user)).toEqual(['CFO close checklist', 'Company handbook']);
    // search never reveals what a person may not read
    expect(titles(await search(o.u.exec.user, 'acquisition narwhal'))).toEqual([]); expect(titles(await search(o.u.exec.user, 'handbook zebra'))).toEqual(['Company handbook']); expect(titles(await search(o.u.nobody.user, 'playbook walrus'))).toEqual([]); expect(titles(await search(o.u.cfo.user, 'checklist giraffe'))).toEqual(['CFO close checklist']);
    expect(titles(await search(owner, 'minutes pangolin'))).toEqual(['Board minutes']);
  });

  it('explicit grants (person, role, department) open restricted/confidential documents; revoking closes them; the author always keeps access', async () => {
    const o = await org(); const memo = await mkDoc(o.u.cmo.user, { title: 'CMO strategy', visibility: 'restricted', confidential: true, body: 'strategy axolotl', departmentId: o.dM }, 201);
    const see = async (u: Client) => (await call(db, 'GET', P(`/knowledge/${memo}`), undefined, u)).status;
    expect(await see(o.u.cmo.user)).toBe(200); expect(await see(o.u.exec.user)).toBe(404); expect(await see(o.u.cfo.user)).toBe(404); expect(await see(owner)).toBe(200);
    expect((await call(db, 'PUT', P(`/knowledge/${memo}/access`), { grants: [{ scopeType: 'member', scopeId: o.u.exec.membershipId }] }, o.u.exec.user)).status).toBe(404);   // cannot manage what you cannot see
    expect((await call(db, 'PUT', P(`/knowledge/${memo}/access`), { grants: [{ scopeType: 'member', scopeId: o.u.exec.membershipId }, { scopeType: 'role', scopeId: o.cfo.id }] }, o.u.cmo.user)).status).toBe(200);
    expect(await see(o.u.exec.user)).toBe(200); expect(await see(o.u.cfo.user)).toBe(200); expect(await see(o.u.nobody.user)).toBe(404);
    expect((await call(db, 'GET', P(`/knowledge/${memo}`), undefined, o.u.cmo.user)).body.access.map((a: any) => a.name).sort()).toEqual(['CFO', 'Teammate']);
    expect((await call(db, 'GET', P(`/knowledge/${memo}`), undefined, o.u.exec.user)).body.access).toEqual([]);                          // the access list itself is only for those who manage the document
    await call(db, 'PUT', P(`/knowledge/${memo}/access`), { grants: [{ scopeType: 'department', scopeId: o.dF }] }, o.u.cmo.user);
    expect(await see(o.u.exec.user)).toBe(404); expect(await see(o.u.cfo.user)).toBe(200);                                               // CFO is in Finance
    expect((await call(db, 'PUT', P(`/knowledge/${memo}/access`), { grants: [{ scopeType: 'member', scopeId: '11111111-1111-4111-8111-111111111111' }] }, o.u.cmo.user)).status).toBe(400);
    expect((await call(db, 'GET', P('/audit'), undefined, owner)).body.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['knowledge.created', 'knowledge.access_changed']));
    const reads = (await call(db, 'GET', P(`/knowledge/${memo}`), undefined, o.u.cmo.user)).body.readLog; expect(reads.some((r: any) => r.via === 'view')).toBe(true);   // reads of confidential documents are recorded
  });

  it('permission model: creating needs knowledge.create, editing needs authorship or knowledge.edit, changing visibility needs ownership/authorship/knowledge.configure', async () => {
    const o = await org(); expect((await call(db, 'POST', P('/knowledge'), { title: 'x', body: 'y' }, o.u.nobody.user)).status).toBe(403);
    expect((await call(db, 'POST', P('/knowledge'), { title: 'x', body: 'y', visibility: 'department', departmentId: o.dF }, o.u.cmo.user)).status).toBe(403);   // department-scoped create: Marketing cannot file into Finance
    const d = await mkDoc(o.u.cmo.user, { title: 'Marketing note', visibility: 'department', departmentId: o.dM, body: 'note' });
    await call(db, 'PATCH', P(`/employees/${o.u.exec.membershipId}`), { departmentId: o.dM }, owner);
    expect((await call(db, 'PATCH', P(`/knowledge/${d}`), { body: 'edited by exec' }, o.u.exec.user)).status).toBe(403);                  // can read, cannot edit
    await grantRole(o.exec.id, [['company.view', 'company'], ['knowledge.edit', 'department']]);
    expect((await call(db, 'PATCH', P(`/knowledge/${d}`), { body: 'edited by exec' }, o.u.exec.user)).status).toBe(200);
    expect((await call(db, 'PUT', P(`/knowledge/${d}/security`), { visibility: 'company' }, o.u.exec.user)).status).toBe(403);             // an editor cannot widen who reads it
    expect((await call(db, 'PUT', P(`/knowledge/${d}/security`), { visibility: 'company' }, o.u.cmo.user)).status).toBe(200);
    expect((await call(db, 'GET', P(`/knowledge/${d}`), undefined, o.u.nobody.user)).status).toBe(200);
    expect((await call(db, 'DELETE', P(`/knowledge/${d}`), undefined, o.u.exec.user)).status).toBe(403);
    expect((await call(db, 'DELETE', P(`/knowledge/${d}`), undefined, owner)).status).toBe(200); expect((await call(db, 'GET', P(`/knowledge/${d}`), undefined, o.u.cmo.user)).status).toBe(404);
    expect(titles(await search(owner, 'note'))).toEqual([]);                                                                              // archived documents leave the index at once
    const versions = await db.select().from(schema.knowledgeVersions); expect(versions.filter((v) => v.documentId === d)).toHaveLength(2);       // …but their history is kept
  });

  it('a knowledge.view grant opens department/role documents but never confidential ones; knowledge.configure administrators read everything', async () => {
    const o = await org(); const dept = await mkDoc(owner, { title: 'Marketing budget guide', visibility: 'department', departmentId: o.dM, body: 'guide' }); const conf = await mkDoc(owner, { title: 'Marketing salary bands', visibility: 'department', departmentId: o.dM, confidential: true, body: 'bands' });
    expect((await call(db, 'GET', P(`/knowledge/${dept}`), undefined, o.u.nobody.user)).status).toBe(404);
    const viewer = await makeRole(db, owner, cid, { name: 'Auditor' }); await grantRole(viewer.id, [['company.view', 'company'], ['knowledge.view', 'company']]); const aud = await addMember(db, owner, cid, 'member', viewer.id);
    expect((await call(db, 'GET', P(`/knowledge/${dept}`), undefined, aud.user)).status).toBe(200); expect((await call(db, 'GET', P(`/knowledge/${conf}`), undefined, aud.user)).status).toBe(404);   // company-wide view: department documents yes, confidential no
    await grantRole(viewer.id, [['company.view', 'company'], ['knowledge.view', 'company'], ['knowledge.configure', 'company']]);
    expect((await call(db, 'GET', P(`/knowledge/${dept}`), undefined, aud.user)).status).toBe(200); expect((await call(db, 'GET', P(`/knowledge/${conf}`), undefined, aud.user)).status).toBe(200);
    await grantRole(o.cmo.id, [['company.view', 'company'], ['knowledge.view', 'department']]); await call(db, 'PATCH', P(`/employees/${o.u.cfo.membershipId}`), { departmentId: o.dF }, owner);
    expect((await call(db, 'GET', P(`/knowledge/${dept}`), undefined, o.u.cmo.user)).status).toBe(200); expect((await call(db, 'GET', P(`/knowledge/${conf}`), undefined, o.u.cmo.user)).status).toBe(404);
  });

  it('tenant isolation: another company cannot read, search or reference these documents', async () => {
    const id = await mkDoc(owner, { title: 'Our secret roadmap', body: 'roadmap ocelot' }); const other = await signup(db); const oc = await makeCompany(db, other);
    for (const [m, p, b] of [['GET', `/knowledge/${id}`], ['PATCH', `/knowledge/${id}`, { title: 'x' }], ['DELETE', `/knowledge/${id}`], ['GET', '/knowledge'], ['GET', '/knowledge/search?q=roadmap'], ['PUT', `/knowledge/${id}/access`, { grants: [] }]] as any[]) expect((await call(db, m, P(p), b, other)).status, `${m} ${p}`).toBe(404);
    expect((await call(db, 'GET', P(`/knowledge/${id}`, oc), undefined, other)).status).toBe(404); expect((await call(db, 'GET', P('/knowledge/search?q=roadmap', oc), undefined, other)).body.results).toEqual([]);
    const foreignRole = await makeRole(db, other, oc, { name: 'Other role' }); expect((await call(db, 'POST', P('/knowledge'), { title: 'x', body: 'y', visibility: 'role', roleId: foreignRole.id }, owner)).status).toBe(400);
    expect((await call(db, 'PUT', P(`/knowledge/${id}/access`), { grants: [{ scopeType: 'role', scopeId: foreignRole.id }] }, owner)).status).toBe(400);
  });
});

describe('search', () => {
  it('ranks by relevance over only the current version, supports filters, returns citations, and tolerates plurals', async () => {
    const a = await mkDoc(owner, { title: 'Refund policy', docType: 'policy', tags: ['support'], body: '# Refunds\n\nCustomers may request a refund within 14 days of purchase. Refunds are paid to the original payment method.' });
    await mkDoc(owner, { title: 'Hiring process', docType: 'sop', tags: ['people'], body: 'Interview candidates in three rounds. Always check references before sending an offer.' });
    await mkDoc(owner, { title: 'Office plants', docType: 'other', body: 'Water the ficus on Mondays and the cactus every second week.' });
    let r = await search(owner, 'how long do customers have to request a refund'); expect(titles(r)[0]).toBe('Refund policy'); expect(r.results[0]).toMatchObject({ docType: 'policy', version: 1, chunk: 0, ref: `doc:${a}@v1#0` }); expect(r.results[0].snippet).toContain('14 days'); expect(r.method).toMatch(/Local hashed vectors/); expect(r.searched).toBe(3);
    expect(titles(await search(owner, 'refunds'))).toContain('Refund policy');                                                           // plural form matches
    expect(titles(await search(owner, 'candidates references offer'))[0]).toBe('Hiring process');
    expect(titles(await search(owner, 'refund', '&docType=sop'))).toEqual([]); expect(titles(await search(owner, 'refund', '&tag=support'))).toEqual(['Refund policy']);
    expect(titles(await search(owner, 'quantum spaceship xylophone'))).toEqual([]);                                                       // nothing relevant: no results rather than noise
    await call(db, 'PATCH', P(`/knowledge/${a}`), { body: 'Refunds were replaced by store credit only.' }, owner);
    expect(titles(await search(owner, '14 days payment method'))).toEqual([]); r = await search(owner, 'store credit'); expect(r.results[0]).toMatchObject({ title: 'Refund policy', version: 2, ref: `doc:${a}@v2#0` });
    expect((await call(db, 'GET', P('/knowledge/search?q='), undefined, owner)).status).toBe(400);
    expect((await call(db, 'GET', P('/knowledge?q=hiring'), undefined, owner)).body.documents.map((d: any) => d.title)).toEqual(['Hiring process']);
  });

  it('embedding providers are pluggable: the model is recorded per chunk, reindex re-embeds, and vectors from different models are never compared', async () => {
    const id = await mkDoc(owner, { title: 'Escalation SOP', body: 'Escalate P1 incidents to the on-call engineer immediately.' });
    const chunkModel = async () => (await db.select().from(schema.knowledgeChunks)).find((c) => c.documentId === id)!.embeddingModel; expect(await chunkModel()).toMatch(/^local-hash-/);
    const fake: Embedder = { id: 'fake', model: 'fake-v1', semantic: true, label: 'Fake neural', embed: async (t) => t.map((x) => [x.toLowerCase().includes('incident') ? 1 : 0, x.toLowerCase().includes('escalate') ? 1 : 0, 0.1]) };
    setEmbedder(fake);
    expect(titles(await search(owner, 'incidents'))).toEqual(['Escalation SOP']);                                                         // old chunk model differs → keyword scoring only, still correct
    const re = await call(db, 'POST', P('/knowledge/reindex'), {}, owner); expect(re.body.model).toBe('fake-v1'); expect(re.body.documents).toBe(1); expect(await chunkModel()).toBe('fake-v1');
    const r = await search(owner, 'incident escalate'); expect(r.method).toBe('Fake neural'); expect(r.results[0].documentId).toBe(id);
    const plain = await addMember(db, owner, cid); expect((await call(db, 'POST', P('/knowledge/reindex'), {}, plain.user)).status).toBe(403);
    expect((await call(db, 'GET', P('/knowledge/meta'), undefined, owner)).body.embedding).toMatchObject({ provider: 'fake', semantic: true });
  });

  it('local vectors are deterministic and normalised; the OpenAI-compatible embedder builds the right request and never leaks the key', async () => {
    const e = localHashEmbedder(); const [a, b, c] = await e.embed(['refund within fourteen days', 'refunds within fourteen days', 'water the cactus on monday']);
    expect(Math.hypot(...a)).toBeCloseTo(1, 3); expect(cosine(a, b)).toBeGreaterThan(cosine(a, c) + 0.3); expect((await e.embed(['refund within fourteen days']))[0]).toEqual(a);
    const sink: any[] = []; const f = (async (url: any, init: any) => { sink.push({ url: String(url), init, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }), { status: 200 }); }) as typeof fetch;
    const o = openaiEmbedder(f, { OPENAI_API_KEY: 'sk-SECRET', EMBEDDING_MODEL: 'embed-x', OPENAI_BASE_URL: 'https://llm.example/v1/' });
    expect(await o.embed(['a', 'b'])).toEqual([[1, 0], [0, 1]]); expect(sink[0].url).toBe('https://llm.example/v1/embeddings'); expect(sink[0].init.headers.authorization).toBe('Bearer sk-SECRET'); expect(sink[0].body).toMatchObject({ model: 'embed-x', input: ['a', 'b'] });
    const bad = openaiEmbedder((async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 401 })) as typeof fetch, { OPENAI_API_KEY: 'sk-SECRET', EMBEDDING_MODEL: 'm' }); await expect(bad.embed(['x'])).rejects.toThrow(/401/); await bad.embed(['x']).catch((x) => expect(String(x.message)).not.toContain('sk-SECRET'));
  });
});

describe('AI employees retrieve only what they are authorised to', () => {
  const scripted = (replies: Partial<CompletionResult>[]) => { const seen: any[] = []; let i = 0; const p: AiProvider = { id: 'scripted', label: 'Scripted', setupHint: '', isConfigured: () => true, async complete(req) { seen.push(JSON.parse(JSON.stringify(req))); const r = replies[Math.min(i++, replies.length - 1)]; return { text: '', toolCalls: [], usage: { inputTokens: 5, outputTokens: 5 }, ...r }; } }; registerProvider(p); return seen; };
  const final = { text: JSON.stringify({ summary: 'ok', proposals: [] }) };
  const call1 = (name: string, args: object) => ({ toolCalls: [{ id: 'c1', name, args: args as Record<string, unknown> }] });
  async function setup() {
    scripted([final]);
    const dM = (await call(db, 'POST', P('/departments'), { name: 'Marketing' }, owner)).body.department.id, dF = (await call(db, 'POST', P('/departments'), { name: 'Finance' }, owner)).body.department.id;
    const cmo = await makeRole(db, owner, cid, { name: 'CMO', departmentId: dM }), cfo = await makeRole(db, owner, cid, { name: 'CFO', departmentId: dF });
    const docs = {
      company: await mkDoc(owner, { title: 'Company handbook', visibility: 'company', body: 'handbook onboarding quokka' }),
      mkt: await mkDoc(owner, { title: 'Marketing brand guide', visibility: 'department', departmentId: dM, body: 'brand guide quokka colours' }),
      cmoRole: await mkDoc(owner, { title: 'CMO weekly routine', visibility: 'role', roleId: cmo.id, departmentId: dM, body: 'weekly routine quokka report' }),
      cfoRole: await mkDoc(owner, { title: 'CFO month-end close', visibility: 'role', roleId: cfo.id, departmentId: dF, body: 'month end close quokka ledger' }),
      conf: await mkDoc(owner, { title: 'Marketing salary bands', visibility: 'department', departmentId: dM, confidential: true, body: 'salary bands quokka confidential' }),
      restr: await mkDoc(owner, { title: 'Board minutes', visibility: 'restricted', body: 'board minutes quokka restricted' }),
      draft: await mkDoc(owner, { title: 'Draft pricing', status: 'draft', body: 'draft pricing quokka' }),
      gone: await mkDoc(owner, { title: 'Archived policy', body: 'archived policy quokka' }),
    };
    await call(db, 'DELETE', P(`/knowledge/${docs.gone}`), undefined, owner);
    const mk = async (scope: string) => { const a = await call(db, 'POST', P('/agents'), { name: `AI ${scope}`, roleId: cmo.id, config: { provider: 'scripted', model: 'm', autonomyLevel: 1, knowledgeScope: scope } }, owner); await call(db, 'POST', P(`/agents/${a.body.agent.id}/status`), { status: 'active' }, owner); return a.body.agent.id as string; };
    return { docs, cmo, cfo, dM, dF, mk };
  }
  const retrieved = async (agentId: string, q = 'quokka') => { scripted([call1('knowledge_search', { query: q, limit: 8 }), final]); const r = await call(db, 'POST', P(`/agents/${agentId}/run`), { input: 'find things' }, owner); expect(r.body.run.status, JSON.stringify(r.body.run)).toBe('succeeded'); const step = r.body.run.steps[0]; return { titles: (step.result.startsWith('{') ? JSON.parse(step.result).results : []).map((x: any) => x.title) as string[], step, run: r.body.run }; };
  const full = async (agentId: string) => { const seen = scripted([call1('knowledge_search', { query: 'quokka', limit: 8 }), final]); await call(db, 'POST', P(`/agents/${agentId}/run`), { input: 'find things' }, owner); return JSON.parse((seen[1].messages.at(-1) as any).content); };

  it('scope none / role / department / company decide what is searchable; confidential, restricted, draft and archived documents are never returned by scope alone', async () => {
    const s = await setup(); const sorted = async (id: string) => (await full(id)).results.map((x: any) => x.title).sort();
    scripted([call1('knowledge_search', { query: 'quokka' }), final]);
    expect((await retrieved(await s.mk('none'))).step.result).toMatch(/disabled/);
    expect(await sorted(await s.mk('role'))).toEqual(['CMO weekly routine']);                                                                  // its own role's documents only
    expect(await sorted(await s.mk('department'))).toEqual(['CMO weekly routine', 'Company handbook', 'Marketing brand guide']);
    expect(await sorted(await s.mk('company'))).toEqual(['CFO month-end close', 'CMO weekly routine', 'Company handbook', 'Marketing brand guide']);
    for (const bad of ['Marketing salary bands', 'Board minutes', 'Draft pricing', 'Archived policy']) for (const scope of ['role', 'department', 'company']) expect(await sorted(await s.mk(scope))).not.toContain(bad);
  });

  it('explicit grants to the agent, its role or its department are the only way into confidential documents; reads outside scope look exactly like missing documents', async () => {
    const s = await setup(); const a = await s.mk('role'); const found = async () => (await full(a)).results.map((x: any) => x.title).sort();
    expect(await found()).toEqual(['CMO weekly routine']);
    expect((await call(db, 'PUT', P(`/knowledge/${s.docs.conf}/access`), { grants: [{ scopeType: 'agent', scopeId: a }] }, owner)).status).toBe(200);
    expect(await found()).toEqual(['CMO weekly routine', 'Marketing salary bands']);
    await call(db, 'PUT', P(`/knowledge/${s.docs.restr}/access`), { grants: [{ scopeType: 'role', scopeId: s.cmo.id }] }, owner); expect(await found()).toEqual(['Board minutes', 'CMO weekly routine', 'Marketing salary bands']);
    await call(db, 'PUT', P(`/knowledge/${s.docs.conf}/access`), { grants: [] }, owner); expect(await found()).toEqual(['Board minutes', 'CMO weekly routine']);   // revoking takes effect on the next retrieval
    scripted([call1('knowledge_read', { documentId: s.docs.cfoRole }), final]); const denied = await call(db, 'POST', P(`/agents/${a}/run`), { input: 'read' }, owner);
    scripted([call1('knowledge_read', { documentId: '11111111-1111-4111-8111-111111111111' }), final]); const missing = await call(db, 'POST', P(`/agents/${a}/run`), { input: 'read' }, owner);
    expect(denied.body.run.steps[0].result).toBe('Document not found or outside your knowledge scope.'); expect(denied.body.run.steps[0].result).toBe(missing.body.run.steps[0].result);
    const seen = scripted([call1('knowledge_read', { documentId: s.docs.cmoRole }), final]); await call(db, 'POST', P(`/agents/${a}/run`), { input: 'read' }, owner); expect(JSON.parse((seen[1].messages.at(-1) as any).content)).toMatchObject({ title: 'CMO weekly routine', version: 1, ref: `doc:${s.docs.cmoRole}@v1` });
  });

  it('every retrieval is logged with its sources and run; the run history shows which documents were used; the document shows who read it', async () => {
    const s = await setup(); const a = await s.mk('department'); const r = await retrieved(a, 'brand guide colours');
    expect(r.titles[0]).toBe('Marketing brand guide'); expect(r.step.sources[0]).toBe(`doc:${s.docs.mkt}@v1#0`); expect(r.step.decision).toBe('execute');
    const log = await db.select().from(schema.knowledgeAccessLog); const mine = log.filter((l) => l.actorAgentId === a); expect(mine.length).toBeGreaterThan(0); expect(mine.every((l) => l.via === 'ai_search' && l.runId === r.run.id && l.query === 'brand guide colours')).toBe(true);
    expect(mine.some((l) => l.documentId === s.docs.mkt)).toBe(true); expect(mine.some((l) => l.documentId === s.docs.conf)).toBe(false);
    const doc = (await call(db, 'GET', P(`/knowledge/${s.docs.mkt}`), undefined, owner)).body; expect(doc.readLog.some((x: any) => x.agent === 'AI department' && x.via === 'ai_search')).toBe(true);
    const none = await retrieved(a, 'xylophone zeppelin'); expect(none.step.result).toMatch(/No documents in your knowledge scope matched/); expect(none.step.result).toMatch(/Do not guess/);
  });

  it('another company\'s documents are never retrievable, even with identical keywords', async () => {
    const s = await setup(); const a = await s.mk('company'); const other = await signup(db); const oc = await makeCompany(db, other);
    await call(db, 'POST', P('/knowledge', oc), { title: 'Rival secret', body: 'quokka rival secret plan', visibility: 'company' }, other);
    expect((await full(a)).results.map((x: any) => x.title)).not.toContain('Rival secret');
  });
});
