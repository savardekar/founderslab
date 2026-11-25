import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@/db/client';
import { addMember, call, makeCompany, makeRole, newDb, resetRateLimits, signup, type Client } from './helpers';
import { anthropicProvider, costUsd, openaiCompatibleProvider, registerProvider, unregisterProvider, type AiProvider, type CompletionRequest, type CompletionResult } from '@/server/ai/provider';
import { TOOLS, TOOL_BY_KEY, decideTool } from '@/server/ai/tools';

let db: Db; let owner: Client; let cid: string;
const P = (p: string, id = cid) => `/companies/${id}${p}`;
beforeAll(async () => { process.env.EXPOSE_DEV_LINKS = '1'; db = await newDb(); });
beforeEach(async () => { resetRateLimits(); owner = await signup(db, 'Founder'); cid = await makeCompany(db, owner); });
afterEach(() => unregisterProvider('scripted'));

/** TEST DOUBLE: a scripted model. It exists only inside tests to exercise the orchestration; it is never registered by the app. */
function scripted(replies: Array<Partial<CompletionResult> | ((r: CompletionRequest) => Partial<CompletionResult>)>) {
  const seen: CompletionRequest[] = []; let i = 0;
  const p: AiProvider = { id: 'scripted', label: 'Scripted test model', setupHint: '', isConfigured: () => true,
    async complete(req) { seen.push(JSON.parse(JSON.stringify(req))); const r = replies[Math.min(i++, replies.length - 1)]; const x = typeof r === 'function' ? r(req) : r; return { text: '', toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 }, ...x }; } };
  registerProvider(p); return seen;
}
const final = (proposals: any[] = [{ kind: 'draft', title: 'Q4 plan', body: 'Draft body' }]) => ({ text: JSON.stringify({ summary: 'Done', proposals }) });
const tool = (name: string, args: object, id = 't1') => ({ toolCalls: [{ id, name, args: args as Record<string, unknown> }] });

async function setup(autonomy: number, opts: { tools?: any[]; scope?: string; limit?: number | null; activate?: boolean } = {}) {
  scripted([final([])]); // the provider must exist before an agent can be configured with it
  const role = await makeRole(db, owner, cid, { name: 'CMO', templateKey: 'cmo' });
  const r = await call(db, 'POST', P('/agents'), { name: 'AI CMO', roleId: role.id, config: { provider: 'scripted', model: 'test-model', autonomyLevel: autonomy, knowledgeScope: opts.scope ?? 'role', monthlyTokenLimit: opts.limit ?? null, instructions: 'Be concise.' } }, owner);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.agent.id as string;
  if (opts.tools) expect((await call(db, 'PUT', P(`/agents/${id}/tools`), { tools: opts.tools }, owner)).status).toBe(200);
  if (opts.activate !== false) expect((await call(db, 'POST', P(`/agents/${id}/status`), { status: 'active' }, owner)).status).toBe(200);
  return { id, role };
}
const run = (id: string, input = 'Plan next quarter') => call(db, 'POST', P(`/agents/${id}/run`), { input }, owner);
const respTitles = async (roleId: string) => (await call(db, 'GET', P(`/roles/${roleId}`), undefined, owner)).body.responsibilities.map((r: any) => r.title);

describe('AI employee management', () => {
  it('creates an AI employee with profile, config, tools, manager, role and responsibilities; lists it; shows its profile', async () => {
    const dep = (await call(db, 'POST', P('/departments'), { name: 'Marketing' }, owner)).body.department;
    const role = await makeRole(db, owner, cid, { name: 'CMO', templateKey: 'cmo', departmentId: dep.id });
    const res = await call(db, 'POST', P('/agents'), { name: 'AI CMO', description: 'Research and drafts', departmentId: dep.id, roleId: role.id, config: { provider: 'anthropic', model: 'some-model', instructions: 'Research competitors weekly.', autonomyLevel: 2, knowledgeScope: 'department', monthlyTokenLimit: 500000, monthlyBudgetUsd: 25 } }, owner);
    expect(res.status).toBe(201);
    const id = res.body.agent.id;
    const prof = (await call(db, 'GET', P(`/agents/${id}`), undefined, owner)).body;
    expect(prof.agent).toMatchObject({ name: 'AI CMO', status: 'inactive', departmentName: 'Marketing', managerName: 'Founder' });
    expect(prof.config).toMatchObject({ provider: 'anthropic', model: 'some-model', autonomyLevel: 2, knowledgeScope: 'department', monthlyTokenLimit: 500000, monthlyBudgetUsd: 25, instructions: 'Research competitors weekly.' });
    expect(prof.assignments.map((a: any) => a.roleName)).toEqual(['CMO']); expect(prof.assignments[0].isOwner).toBe(true);
    expect(prof.responsibilities.selected).toHaveLength(prof.responsibilities.available.length); expect(prof.responsibilities.available.length).toBe(5);
    expect(prof.tools.find((t: any) => t.key === 'org_read').enabled).toBe(true);
    expect(prof.tools.find((t: any) => t.key === 'email_send')).toMatchObject({ enabled: false, connected: false });
    expect(prof.providerConfigured).toBe(false);                      // no ANTHROPIC_API_KEY in the test environment: reported honestly
    const list = (await call(db, 'GET', P('/agents'), undefined, owner)).body.agents;
    expect(list).toHaveLength(1); expect(list[0].roles[0].name).toBe('CMO');
    const hist = (await call(db, 'GET', P('/audit'), undefined, owner)).body.events.map((e: any) => e.action);
    expect(hist).toEqual(expect.arrayContaining(['agent.created', 'role.ai_assigned']));
  });

  it('validates input and enforces permissions on create / configure / activate / delete', async () => {
    expect((await call(db, 'POST', P('/agents'), { name: 'X', config: { provider: 'nope', model: 'm' } }, owner)).status).toBe(400);
    expect((await call(db, 'POST', P('/agents'), { name: 'X', config: { provider: 'anthropic', model: 'm', autonomyLevel: 9 } }, owner)).status).toBe(400);
    expect((await call(db, 'POST', P('/agents'), { name: 'X', managerMembershipId: '11111111-1111-4111-8111-111111111111', config: { provider: 'anthropic', model: 'm' } }, owner)).status).toBe(400);
    const plain = await addMember(db, owner, cid);
    expect((await call(db, 'POST', P('/agents'), { name: 'X', config: { provider: 'anthropic', model: 'm' } }, plain.user)).status).toBe(403);
    expect((await call(db, 'GET', P('/agents'), undefined, plain.user)).status).toBe(403);
    const admin = await addMember(db, owner, cid, 'admin');                           // preset: view/create/edit/assign — not configure/approve/delete
    const created = await call(db, 'POST', P('/agents'), { name: 'Admin made', config: { provider: 'anthropic', model: 'm' } }, admin.user);
    expect(created.status).toBe(201);
    const id = created.body.agent.id;
    expect((await call(db, 'PUT', P(`/agents/${id}/config`), { instructions: 'x' }, admin.user)).status).toBe(403);
    expect((await call(db, 'PUT', P(`/agents/${id}/tools`), { tools: [] }, admin.user)).status).toBe(403);
    expect((await call(db, 'POST', P('/agents'), { name: 'Y', config: { provider: 'anthropic', model: 'm', autonomyLevel: 3 } }, admin.user)).status).toBe(403); // L3/L4 need agents.approve
    expect((await call(db, 'DELETE', P(`/agents/${id}`), undefined, admin.user)).status).toBe(403);
    expect((await call(db, 'POST', P(`/agents/${id}/status`), { status: 'active' }, admin.user)).status).toBe(200);
    expect((await call(db, 'POST', P(`/agents/${id}/status`), { status: 'inactive' }, admin.user)).status).toBe(200);
    expect((await call(db, 'PUT', P(`/agents/${id}/config`), { autonomyLevel: 4 }, owner)).status).toBe(200);
    expect((await call(db, 'DELETE', P(`/agents/${id}`), undefined, owner)).status).toBe(200);
    expect((await call(db, 'GET', P(`/agents/${id}`), undefined, owner)).status).toBe(404);
  });

  it('config changes are versioned and audited without leaking instructions; instructions are hidden from non-configurers', async () => {
    const { id } = await setup(1);
    await call(db, 'PUT', P(`/agents/${id}/config`), { instructions: 'SECRET PLAYBOOK', model: 'm2' }, owner);
    expect((await call(db, 'GET', P(`/agents/${id}`), undefined, owner)).body.config.version).toBe(2);
    const ev = JSON.stringify((await call(db, 'GET', P('/audit'), undefined, owner)).body.events);
    expect(ev).toMatch(/agent\.configured/); expect(ev).not.toMatch(/SECRET PLAYBOOK/);
    const viewer = await addMember(db, owner, cid, 'admin');
    expect((await call(db, 'GET', P(`/agents/${id}`), undefined, viewer.user)).body.config.instructions).toBeNull();
  });

  it('external tools cannot be enabled; unattended execution needs a routine tool and agents.approve', async () => {
    const { id } = await setup(1, { activate: false });
    for (const k of ['email_send', 'social_publish', 'payments_spend', 'web_search'])
      expect((await call(db, 'PUT', P(`/agents/${id}/tools`), { tools: [{ toolKey: k, enabled: true, requiresApproval: true }] }, owner)).status, k).toBe(400);
    expect((await call(db, 'PUT', P(`/agents/${id}/tools`), { tools: [{ toolKey: 'nope', enabled: true, requiresApproval: true }] }, owner)).status).toBe(400);
    const adminWithConfigure = await addMember(db, owner, cid, 'admin');
    await call(db, 'PUT', P(`/members/${adminWithConfigure.membershipId}/permissions`), { keys: ['company.view', 'agents.view', 'agents.configure', 'agents.edit'] }, owner);
    expect((await call(db, 'PUT', P(`/agents/${id}/tools`), { tools: [{ toolKey: 'org_add_responsibility', enabled: true, requiresApproval: false }] }, adminWithConfigure.user)).status).toBe(403);
    expect((await call(db, 'PUT', P(`/agents/${id}/tools`), { tools: [{ toolKey: 'org_add_responsibility', enabled: true, requiresApproval: false }] }, owner)).status).toBe(200);
  });

  it('the AI performs only the responsibilities picked for it, and only from roles it holds', async () => {
    const { id, role } = await setup(1);
    const prof = (await call(db, 'GET', P(`/agents/${id}`), undefined, owner)).body;
    const pick = prof.responsibilities.available.slice(0, 2).map((r: any) => r.id);
    expect((await call(db, 'PUT', P(`/agents/${id}/responsibilities`), { ids: pick }, owner)).status).toBe(200);
    const other = await makeRole(db, owner, cid, { name: 'COO', templateKey: 'coo' });
    const foreign = (await call(db, 'GET', P(`/roles/${other.id}`), undefined, owner)).body.responsibilities[0].id;
    expect((await call(db, 'PUT', P(`/agents/${id}/responsibilities`), { ids: [foreign] }, owner)).status).toBe(400);
    const seen = scripted([final()]);
    await run(id);
    const sys = seen[0].system;
    expect(sys).toContain(prof.responsibilities.available[0].title); expect(sys).toContain(prof.responsibilities.available[1].title);
    expect(sys).not.toContain(prof.responsibilities.available[3].title);              // the human keeps the others (hybrid example)
    expect(sys).toContain('Be concise.'); expect(sys).toMatch(/You must NOT access confidential financial records|Cannot access confidential|must NOT/i);
    void role;
  });
});

describe('AI execution: autonomy, safety, budgets, history (scripted model — a test double, not live AI)', () => {
  it('Level 1: reads are allowed, a write attempt becomes a SUGGESTION and is not executed; proposals are suggestions', async () => {
    const { id, role } = await setup(1);
    scripted([tool('org_add_responsibility', { roleId: role.id, title: 'Weekly competitor scan' }), final([{ kind: 'draft', title: 'Idea', body: 'b' }])]);
    const r = await run(id); expect(r.status).toBe(200);
    expect(r.body.run.status).toBe('succeeded');
    expect(r.body.workItems.map((w: any) => w.kind).sort()).toEqual(['suggestion', 'suggestion']);
    expect(await respTitles(role.id)).not.toContain('Weekly competitor scan');
  });

  it('Level 2: write attempts and proposals become DRAFTS for review; nothing is applied, even on approval', async () => {
    const { id, role } = await setup(2);
    scripted([tool('org_add_responsibility', { roleId: role.id, title: 'Weekly competitor scan' }), final()]);
    const r = await run(id);
    expect(r.body.workItems.map((w: any) => w.kind).sort()).toEqual(['draft', 'draft']);
    const item = r.body.workItems[0];
    expect((await call(db, 'POST', P(`/ai-work-items/${item.id}/review`), { decision: 'approve' }, owner)).body.status).toBe('approved');
    expect(await respTitles(role.id)).not.toContain('Weekly competitor scan');
  });

  it('Level 3: actions are QUEUED and execute only after a human approves; rejection executes nothing', async () => {
    const { id, role } = await setup(3);
    scripted([tool('org_add_responsibility', { roleId: role.id, title: 'Approved scan' }, 'a'), tool('org_add_responsibility', { roleId: role.id, title: 'Rejected scan' }, 'b'), final([])]);
    const r = await run(id);
    const [a, b] = r.body.workItems.filter((w: any) => w.kind === 'action');
    expect(a.status).toBe('pending_review'); expect(await respTitles(role.id)).not.toContain('Approved scan');
    const ok = await call(db, 'POST', P(`/ai-work-items/${a.id}/review`), { decision: 'approve' }, owner);
    expect(ok.body.status).toBe('executed'); expect(await respTitles(role.id)).toContain('Approved scan');
    expect((await call(db, 'POST', P(`/ai-work-items/${b.id}/review`), { decision: 'reject', note: 'No' }, owner)).body.status).toBe('rejected');
    expect(await respTitles(role.id)).not.toContain('Rejected scan');
    expect((await call(db, 'POST', P(`/ai-work-items/${a.id}/review`), { decision: 'approve' }, owner)).status).toBe(409); // cannot review twice
    const plain = await addMember(db, owner, cid);
    expect((await call(db, 'POST', P(`/ai-work-items/${b.id}/review`), { decision: 'approve' }, plain.user)).status).toBe(403);
    const audit = (await call(db, 'GET', P('/audit'), undefined, owner)).body.events.map((e: any) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['ai.responsibility_added', 'ai_item.executed', 'ai_item.rejected']));
  });

  it('Level 4: pre-authorised routine tools run automatically; others still queue for approval', async () => {
    const auto = [{ toolKey: 'org_read', enabled: true, requiresApproval: false }, { toolKey: 'org_add_responsibility', enabled: true, requiresApproval: false }];
    const { id, role } = await setup(4, { tools: auto });
    scripted([tool('org_add_responsibility', { roleId: role.id, title: 'Auto scan' }), final([])]);
    const r = await run(id);
    expect(r.body.workItems[0]).toMatchObject({ kind: 'action', status: 'executed' });
    expect(await respTitles(role.id)).toContain('Auto scan');
    // same level, but the admin did not pre-authorise the tool: it queues
    const second = await setup(4, { tools: [{ toolKey: 'org_read', enabled: true, requiresApproval: false }, { toolKey: 'org_add_responsibility', enabled: true, requiresApproval: true }] });
    scripted([tool('org_add_responsibility', { roleId: second.role.id, title: 'Needs approval' }), final([])]);
    const r2 = await run(second.id);
    expect(r2.body.workItems[0].status).toBe('pending_review'); expect(await respTitles(second.role.id)).not.toContain('Needs approval');
  });

  it('an AI can never change a role it is not assigned to', async () => {
    const { id } = await setup(4, { tools: [{ toolKey: 'org_add_responsibility', enabled: true, requiresApproval: false }] });
    const other = await makeRole(db, owner, cid, { name: 'CFO' });
    scripted([tool('org_add_responsibility', { roleId: other.id, title: 'Sneaky' }), final([])]);
    const r = await run(id);
    expect(r.body.run.steps[0].result).toMatch(/assigned/); expect(await respTitles(other.id)).not.toContain('Sneaky');
  });

  it('external actions are denied at every autonomy level, even if the model asks and the DB were tampered with', async () => {
    for (const level of [1, 2, 3, 4]) {
      const { id } = await setup(level);
      await db.execute(`insert into agent_tool_permissions(company_id, agent_id, tool_key, enabled, requires_approval) values ('${cid}','${id}','email_send', true, false)` as any); // bypass the API on purpose
      scripted([tool('email_send', { to: 'ceo@competitor.com' }), final([])]);
      const r = await run(id);
      expect(r.body.run.steps[0]).toMatchObject({ tool: 'email_send', decision: 'deny' });
      expect(r.body.workItems).toHaveLength(0);
    }
    expect(['deny']).toEqual([1, 2, 3, 4].map((l) => decideTool(l, TOOL_BY_KEY.email_send, { enabled: true, requiresApproval: false })).filter((v, i, a) => a.indexOf(v) === i));
  });

  it('knowledge scope limits what org_read returns', async () => {
    const { id, role } = await setup(1, { scope: 'role' });
    await makeRole(db, owner, cid, { name: 'Secret Role', description: 'TOP SECRET', templateKey: 'cfo' });
    const seen = scripted([tool('org_read', {}), final([])]);
    await run(id);
    const out = (seen[1].messages.at(-1) as any).content as string;
    expect(out).toContain('CMO'); expect(out).not.toContain('Secret Role');
    await call(db, 'PUT', P(`/agents/${id}/config`), { knowledgeScope: 'company' }, owner);
    const seen2 = scripted([tool('org_read', {}), final([])]); await run(id);
    expect((seen2[1].messages.at(-1) as any).content).toContain('Secret Role');
    await call(db, 'PUT', P(`/agents/${id}/config`), { knowledgeScope: 'none' }, owner);
    const seen3 = scripted([tool('org_read', {}), final([])]); await run(id);
    expect((seen3[1].messages.at(-1) as any).content).toMatch(/disabled/);
    void role;
  });

  it('records execution history and usage; the token limit blocks further runs', async () => {
    const { id } = await setup(1, { limit: 400 });
    scripted([final([])]);
    const r1 = await run(id); expect(r1.body.run).toMatchObject({ status: 'succeeded', inputTokens: 100, outputTokens: 50 });
    for (let i = 0; i < 2; i++) await run(id);
    const blocked = await run(id);
    expect(blocked.body.run.status).toBe('blocked'); expect(blocked.body.run.error).toMatch(/token limit/i);
    const prof = (await call(db, 'GET', P(`/agents/${id}`), undefined, owner)).body;
    expect(prof.usage).toMatchObject({ tokens: 450, tokenLimit: 400, calls: 3 });
    expect(prof.runs[0].status).toBe('blocked'); expect(prof.runs.some((r: any) => r.status === 'succeeded' && r.summary === 'Done')).toBe(true);
    expect((await call(db, 'GET', P('/audit'), undefined, owner)).body.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['ai.run_succeeded', 'ai.run_blocked']));
  });

  it('structured output: invalid JSON gets one retry, then the run fails honestly', async () => {
    const { id } = await setup(2);
    scripted([{ text: 'Sure! Here you go' }, final()]);
    expect((await run(id)).body.run.status).toBe('succeeded');
    scripted([{ text: 'nope' }, { text: 'still nope' }]);
    const bad = await run(id); expect(bad.body.run).toMatchObject({ status: 'failed' }); expect(bad.body.run.error).toMatch(/structured output/);
  });

  it('with no provider credentials the run is BLOCKED with a setup hint — nothing is faked', async () => {
    const role = await makeRole(db, owner, cid, { name: 'CMO' });
    const created = await call(db, 'POST', P('/agents'), { name: 'AI', roleId: role.id, config: { provider: 'anthropic', model: 'm' } }, owner);
    const id = created.body.agent.id;
    await call(db, 'POST', P(`/agents/${id}/status`), { status: 'active' }, owner);
    const r = await run(id);
    expect(r.status).toBe(200); expect(r.body.run.status).toBe('blocked'); expect(r.body.run.error).toMatch(/ANTHROPIC_API_KEY/);
    expect(r.body.workItems).toHaveLength(0);
  });

  it('inactive agents cannot run; running needs permission, but a human sharing the role may run their AI colleague', async () => {
    const { id, role } = await setup(1, { activate: false });
    scripted([final([])]);
    expect((await run(id)).status).toBe(409);
    await call(db, 'POST', P(`/agents/${id}/status`), { status: 'active' }, owner);
    const plain = await addMember(db, owner, cid);
    expect((await call(db, 'POST', P(`/agents/${id}/run`), { input: 'hi' }, plain.user)).status).toBe(403);
    // human CMO holds the same role; their role grants agents.view/edit scoped to "own role only"
    await call(db, 'PUT', P(`/roles/${role.id}/permissions`), { grants: [{ key: 'company.view', scope: 'company' }, { key: 'agents.view', scope: 'own' }, { key: 'agents.edit', scope: 'own' }] }, owner);
    await call(db, 'POST', P(`/roles/${role.id}/assignments`), { membershipId: plain.membershipId }, owner);
    expect((await call(db, 'POST', P(`/agents/${id}/run`), { input: 'hi' }, plain.user)).status).toBe(200);
    const stranger = await addMember(db, owner, cid);
    expect((await call(db, 'POST', P(`/agents/${id}/run`), { input: 'hi' }, stranger.user)).status).toBe(403);
    expect((await call(db, 'GET', P(`/agents/${id}`), undefined, stranger.user)).status).toBe(403);
  });

  it('tenant isolation: another company cannot see, configure, run or review this AI employee', async () => {
    const { id } = await setup(3);
    scripted([final([{ kind: 'draft', title: 't', body: 'b' }])]);
    const item = (await run(id)).body.workItems[0];
    const intruder = await signup(db); await makeCompany(db, intruder);
    for (const [m, p, b] of [['GET', `/agents/${id}`], ['PUT', `/agents/${id}/config`, { model: 'x' }], ['POST', `/agents/${id}/run`, { input: 'x' }], ['DELETE', `/agents/${id}`], ['POST', `/ai-work-items/${item.id}/review`, { decision: 'approve' }], ['GET', '/agents'], ['GET', '/workforce']] as any[])
      expect((await call(db, m, P(p), b, intruder)).status, `${m} ${p}`).toBe(404);
    const oc = await makeCompany(db, intruder);
    expect((await call(db, 'GET', P(`/agents/${id}`, oc), undefined, intruder)).status).toBe(404); // own company, foreign id
    expect((await call(db, 'GET', P('/ai-work-items', oc), undefined, intruder)).body.items).toHaveLength(0);
  });
});

describe('provider abstraction', () => {
  const fakeFetch = (reply: any, status = 200, sink: any[] = []) => (async (url: any, init: any) => { sink.push({ url: String(url), init, body: JSON.parse(init.body) }); return new Response(JSON.stringify(reply), { status }); }) as typeof fetch;
  const req: CompletionRequest = { model: 'm1', system: 'SYS', maxTokens: 500, tools: [{ name: 'org_read', description: 'd', inputSchema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'org_read', args: { a: 1 } }, { id: 'c2', name: 'org_read', args: {} }] }, { role: 'tool', toolCallId: 'c1', name: 'org_read', content: 'r1' }, { role: 'tool', toolCallId: 'c2', name: 'org_read', content: 'r2' }] };

  it('Anthropic adapter builds the Messages API request from env credentials and parses text, tool use and usage', async () => {
    const sink: any[] = [];
    const p = anthropicProvider(fakeFetch({ content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'x', name: 'org_read', input: { q: 1 } }], usage: { input_tokens: 11, output_tokens: 7 }, stop_reason: 'tool_use' }, 200, sink), { ANTHROPIC_API_KEY: 'sk-test' });
    expect(p.isConfigured()).toBe(true); expect(anthropicProvider(fakeFetch({}), {}).isConfigured()).toBe(false);
    const out = await p.complete(req);
    expect(sink[0].url).toBe('https://api.anthropic.com/v1/messages'); expect(sink[0].init.headers['x-api-key']).toBe('sk-test');
    expect(sink[0].body).toMatchObject({ model: 'm1', system: 'SYS', max_tokens: 500 }); expect(sink[0].body.tools[0].input_schema).toEqual({ type: 'object' });
    const msgs = sink[0].body.messages; expect(msgs[1].content[0]).toMatchObject({ type: 'tool_use', id: 'c1', input: { a: 1 } });
    expect(msgs[2].content.map((b: any) => b.tool_use_id)).toEqual(['c1', 'c2']);          // consecutive tool results merged into one user turn
    expect(out).toMatchObject({ text: 'ok', toolCalls: [{ id: 'x', name: 'org_read', args: { q: 1 } }], usage: { inputTokens: 11, outputTokens: 7 } });
  });
  it('OpenAI-compatible adapter honours OPENAI_BASE_URL and maps tool calls', async () => {
    const sink: any[] = [];
    const p = openaiCompatibleProvider(fakeFetch({ choices: [{ message: { content: null, tool_calls: [{ id: 'z', function: { name: 'org_read', arguments: '{"k":2}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }, 200, sink), { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://llm.example/v1/' });
    const out = await p.complete(req);
    expect(sink[0].url).toBe('https://llm.example/v1/chat/completions'); expect(sink[0].init.headers.authorization).toBe('Bearer k');
    expect(sink[0].body.messages[0]).toEqual({ role: 'system', content: 'SYS' }); expect(sink[0].body.messages.filter((m: any) => m.role === 'tool')).toHaveLength(2);
    expect(out.toolCalls).toEqual([{ id: 'z', name: 'org_read', args: { k: 2 } }]); expect(out.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  });
  it('provider errors surface as errors; credentials never appear in the thrown message', async () => {
    const p = anthropicProvider(fakeFetch({ error: { message: 'invalid x-api-key' } }, 401), { ANTHROPIC_API_KEY: 'sk-SECRET' });
    await expect(p.complete(req)).rejects.toThrow(/401/); await p.complete(req).catch((e) => expect(String(e.message)).not.toContain('sk-SECRET'));
  });
  it('cost is computed only from configured prices, never guessed', () => {
    expect(costUsd('m', { inputTokens: 1_000_000, outputTokens: 500_000 }, {})).toBeNull();
    expect(costUsd('m', { inputTokens: 1_000_000, outputTokens: 500_000 }, { AI_MODEL_PRICING_JSON: '{"m":{"inputPerMTok":2,"outputPerMTok":10}}' })).toBeCloseTo(7);
  });
  it('autonomy policy table', () => {
    const w = TOOL_BY_KEY.org_add_responsibility, r = TOOL_BY_KEY.org_read; const on = { enabled: true, requiresApproval: true }, auto = { enabled: true, requiresApproval: false };
    expect([1, 2, 3, 4].map((l) => decideTool(l, w, on))).toEqual(['record_suggestion', 'record_draft', 'queue_action', 'queue_action']);
    expect(decideTool(4, w, auto)).toBe('execute'); expect(decideTool(3, w, auto)).toBe('queue_action');
    expect(decideTool(1, r, on)).toBe('execute'); expect(decideTool(4, w, { enabled: false, requiresApproval: false })).toBe('deny'); expect(decideTool(4, w, undefined)).toBe('deny');
    for (const t of TOOLS.filter((t) => t.kind === 'external')) expect([1, 2, 3, 4].map((l) => decideTool(l, t, auto))).toEqual(['deny', 'deny', 'deny', 'deny']);
  });
});
