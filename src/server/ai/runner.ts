import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '@/db/client';
import { AUTONOMY } from '@/lib/constants';
import { HttpError, conflict, forbidden, notFound } from '@/lib/errors';
import { audit } from '../audit';
import type { Ctx } from '../authz';
import { rateLimit } from '../security';
import { costUsd, getProvider, type AiProvider, type ChatMessage } from './provider';
import { TOOL_BY_KEY, agentRoleIds, decideTool, runTool, toolDefs } from './tools';
import { decisionsForAgent } from '../services/decisions';

const S = schema;
export const MAX_STEPS = 5;
const Output = z.object({ summary: z.string().max(4000), proposals: z.array(z.object({ kind: z.enum(['suggestion', 'draft']), title: z.string().min(1).max(200), body: z.string().max(8000) })).max(10) });

export async function monthUsage(db: Db, companyId: string, agentId: string) {
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const rows = await db.select({ i: S.aiUsageRecords.inputTokens, o: S.aiUsageRecords.outputTokens, c: S.aiUsageRecords.costUsd }).from(S.aiUsageRecords)
    .where(and(eq(S.aiUsageRecords.companyId, companyId), eq(S.aiUsageRecords.agentId, agentId), gte(S.aiUsageRecords.createdAt, start)));
  return { tokens: rows.reduce((a, r) => a + r.i + r.o, 0), costUsd: rows.reduce((a, r) => a + Number(r.c ?? 0), 0), costComplete: rows.every((r) => r.c != null), calls: rows.length };
}

function extractJson(text: string) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

async function buildSystem(db: Db, a: { id: string; name: string; companyId: string }, cfg: typeof S.agentConfigurations.$inferSelect) {
  const [co] = await db.select().from(S.companies).where(eq(S.companies.id, a.companyId));
  const roleIds = await agentRoleIds(db, a);
  const roles = roleIds.length ? await db.select().from(S.roles).where(and(eq(S.roles.companyId, a.companyId), isNull(S.roles.archivedAt))) : [];
  const mine = roles.filter((r) => roleIds.includes(r.id));
  const resp = await db.select({ title: S.roleResponsibilities.title, outcome: S.roleResponsibilities.expectedOutcome, roleId: S.roleResponsibilities.roleId }).from(S.agentResponsibilities)
    .innerJoin(S.roleResponsibilities, eq(S.roleResponsibilities.id, S.agentResponsibilities.responsibilityId))
    .where(and(eq(S.agentResponsibilities.companyId, a.companyId), eq(S.agentResponsibilities.agentId, a.id), isNull(S.roleResponsibilities.archivedAt)));
  const rules = roleIds.length ? await db.select().from(S.roleRules).where(and(eq(S.roleRules.companyId, a.companyId), isNull(S.roleRules.archivedAt))) : [];
  const myRules = rules.filter((r) => roleIds.includes(r.roleId));
  const decs = cfg.knowledgeScope === 'none' ? [] : await decisionsForAgent(db, a.companyId, roleIds);
  return [
    `You are ${a.name}, an AI employee at ${co.name}${mine.length ? `, working as ${mine.map((r) => r.name).join(' and ')}` : ''}.`,
    `Company stage: ${co.stage}. Objectives: ${(co.objectives ?? []).join('; ') || 'not set'}.`,
    `Your responsibilities (do work only within these):\n${resp.length ? resp.map((r) => `- ${r.title}${r.outcome ? ` → ${r.outcome}` : ''}`).join('\n') : '- none assigned yet'}`,
    myRules.length ? `Rules for your role (hard constraints):\n${myRules.map((r) => `- ${r.kind === 'allow' ? 'You may' : r.kind === 'deny' ? 'You must NOT' : 'Needs human approval:'} ${r.text}`).join('\n')}` : '',
    `Autonomy: ${AUTONOMY[cfg.autonomyLevel as 1 | 2 | 3 | 4].label}. You can never take external actions (email, publishing, payments). The platform enforces approval; do not try to bypass it.`,
    decs.length ? `Approved company decisions (binding — never contradict or change them; you may only PROPOSE new decisions for a human to approve):\n${decs.map((d) => `- ${d.title}${d.reason ? ` — because ${d.reason}` : ''} [decision:${d.id}]`).join('\n')}` : '',
    'Company documents: use knowledge_search / knowledge_read to find information, quote only what the results contain, and cite each source by its ref (for example [doc:...@v1#0]). If nothing relevant is returned, say so instead of guessing.',
    cfg.instructions ? `Instructions from your administrator:\n${cfg.instructions}` : '',
    `When finished, reply with ONLY JSON: {"summary": string, "proposals": [{"kind": "suggestion" | "draft", "title": string, "body": string}]}. Do not invent company data; use tools to read it.`,
  ].filter(Boolean).join('\n\n');
}

export type RunDeps = { provider?: AiProvider };

export async function runAgent(ctx: Ctx, agentId: string, input: string, deps: RunDeps = {}) {
  const db = ctx.db;
  const [agent] = await db.select().from(S.aiAgents).where(and(eq(S.aiAgents.companyId, ctx.companyId), eq(S.aiAgents.id, agentId), isNull(S.aiAgents.archivedAt))).limit(1);
  if (!agent) throw notFound('AI employee not found');
  const roleIds = await agentRoleIds(db, agent);
  const [rolesRows] = [await db.select({ id: S.roles.id, d: S.roles.departmentId }).from(S.roles).where(and(eq(S.roles.companyId, ctx.companyId)))];
  const allowed = ctx.can('agents.edit') || roleIds.some((id) => ctx.can('agents.edit', { roleId: id, departmentId: rolesRows.find((r) => r.id === id)?.d ?? null }));
  if (!allowed) throw forbidden();
  if (agent.status !== 'active') throw conflict('This AI employee is inactive. Activate it first.');
  const [cfg] = await db.select().from(S.agentConfigurations).where(and(eq(S.agentConfigurations.companyId, ctx.companyId), eq(S.agentConfigurations.agentId, agentId)));
  if (!cfg) throw conflict('This AI employee has no configuration');
  rateLimit(`airun:${agentId}`, 30, 60 * 60_000);
  const text = input.trim().slice(0, 8000);

  const [run] = await db.insert(S.aiRuns).values({ companyId: ctx.companyId, agentId, triggeredBy: ctx.user.id, input: text, provider: cfg.provider, model: cfg.model, autonomyLevel: cfg.autonomyLevel }).returning();
  const finish = async (status: 'succeeded' | 'failed' | 'blocked', patch: Partial<typeof S.aiRuns.$inferInsert> = {}) => {
    const [u] = await db.update(S.aiRuns).set({ status, finishedAt: new Date(), ...patch }).where(eq(S.aiRuns.id, run.id)).returning();
    await audit(db, ctx.companyId, ctx.user.id, `ai.run_${status}`, 'agent', agentId, { runId: run.id, model: cfg.model, error: patch.error ?? null });
    return u;
  };
  const provider = deps.provider ?? getProvider(cfg.provider);
  if (!provider) return { run: await finish('blocked', { error: `Unknown AI provider "${cfg.provider}"` }), workItems: [] };
  if (!provider.isConfigured()) return { run: await finish('blocked', { error: `Provider "${provider.label}" is not configured on the server. ${provider.setupHint}` }), workItems: [] };

  const used = await monthUsage(db, ctx.companyId, agentId);
  if (cfg.monthlyTokenLimit != null && used.tokens >= cfg.monthlyTokenLimit) return { run: await finish('blocked', { error: `Monthly token limit reached (${used.tokens}/${cfg.monthlyTokenLimit}).` }), workItems: [] };
  if (cfg.monthlyBudgetUsd != null && used.costComplete && used.costUsd >= Number(cfg.monthlyBudgetUsd)) return { run: await finish('blocked', { error: `Monthly budget reached ($${used.costUsd.toFixed(2)} of $${cfg.monthlyBudgetUsd}).` }), workItems: [] };

  const perms = await db.select().from(S.agentToolPermissions).where(and(eq(S.agentToolPermissions.companyId, ctx.companyId), eq(S.agentToolPermissions.agentId, agentId)));
  const permBy = new Map(perms.map((p) => [p.toolKey, p]));
  const enabledKeys = perms.filter((p) => p.enabled && TOOL_BY_KEY[p.toolKey]?.connected && TOOL_BY_KEY[p.toolKey].kind !== 'external').map((p) => p.toolKey);
  const system = await buildSystem(db, agent, cfg);
  const messages: ChatMessage[] = [{ role: 'user', content: text }];
  const steps: Record<string, unknown>[] = []; const items: (typeof S.aiWorkItems.$inferSelect)[] = [];
  let inTok = 0, outTok = 0; const primaryRole = roleIds[0] ?? null;
  const newItem = async (v: Omit<typeof S.aiWorkItems.$inferInsert, 'companyId' | 'agentId' | 'runId' | 'roleId'>) => { const [w] = await db.insert(S.aiWorkItems).values({ companyId: ctx.companyId, agentId, runId: run.id, roleId: primaryRole, ...v }).returning(); items.push(w); return w; };

  try {
    let final: z.infer<typeof Output> | null = null; let retried = false;
    for (let step = 0; step < MAX_STEPS + 2 && !final; step++) {
      if (cfg.monthlyTokenLimit != null && used.tokens + inTok + outTok >= cfg.monthlyTokenLimit) return { run: await finish('blocked', { error: 'Monthly token limit reached during the run.', steps, inputTokens: inTok, outputTokens: outTok }), workItems: items };
      const res = await provider.complete({ model: cfg.model, system, messages, tools: step < MAX_STEPS ? toolDefs(enabledKeys) : [], maxTokens: 2000 });
      inTok += res.usage.inputTokens; outTok += res.usage.outputTokens;
      await db.insert(S.aiUsageRecords).values({ companyId: ctx.companyId, agentId, runId: run.id, provider: cfg.provider, model: cfg.model, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: costUsd(cfg.model, res.usage)?.toFixed(6) ?? null });
      if (res.toolCalls.length) {
        messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
        for (const call of res.toolCalls) {
          const tool = TOOL_BY_KEY[call.name]; const perm = permBy.get(call.name);
          const decision = decideTool(cfg.autonomyLevel, tool, perm);
          let result: string;
          try {
            if (decision === 'deny') result = 'DENIED: this tool is not permitted for you.';
            else if (decision === 'execute') {
              result = await runTool(db, agent, cfg.knowledgeScope, call.name, call.args, { runId: run.id });
              if (tool.kind === 'write') await newItem({ kind: 'action', title: `${tool.label}`, body: JSON.stringify(call.args, null, 2), toolKey: call.name, toolArgs: call.args, status: 'executed', result });
            } else {
              if ((call.name === 'org_add_responsibility' || (call.name === 'tasks_create' && call.args.roleId)) && !roleIds.includes(String(call.args.roleId))) throw new Error('You can only change roles you are assigned to');
              const kind = decision === 'record_suggestion' ? 'suggestion' : decision === 'record_draft' ? 'draft' : 'action';
              await newItem({ kind, title: `${tool.label}: ${String(call.args.title ?? '').slice(0, 120)}`.trim(), body: JSON.stringify(call.args, null, 2), toolKey: call.name, toolArgs: call.args });
              result = kind === 'action' ? 'QUEUED: a human must approve this before it runs. It has NOT been executed.' : `RECORDED as a ${kind} for human review. It has NOT been executed.`;
            }
          } catch (e) { result = `ERROR: ${(e as Error).message}`; }
          const sources = [...new Set(result.match(/(?:doc:[0-9a-f-]{36}@v\d+(?:#\d+)?|decision:[0-9a-f-]{36})/g) ?? [])];
          steps.push({ step, tool: call.name, args: call.args, decision, result: result.slice(0, 500), ...(sources.length ? { sources } : {}) });
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result });
        }
        continue;
      }
      const parsed = Output.safeParse(extractJson(res.text));
      if (parsed.success) { final = parsed.data; break; }
      if (retried) throw new Error('The model did not return valid structured output');
      retried = true; messages.push({ role: 'assistant', content: res.text }, { role: 'user', content: 'Your reply was not valid JSON for the required schema. Reply again with ONLY the JSON object.' });
    }
    if (!final) throw new Error('The model did not finish within the step limit');
    for (const p of final.proposals) await newItem({ kind: cfg.autonomyLevel <= 1 ? 'suggestion' : p.kind, title: p.title, body: p.body });
    return { run: await finish('succeeded', { output: final, steps, inputTokens: inTok, outputTokens: outTok }), workItems: items };
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : (e as Error).message;
    return { run: await finish('failed', { error: msg.slice(0, 500), steps, inputTokens: inTok, outputTokens: outTok }), workItems: items };
  }
}
void sql;
