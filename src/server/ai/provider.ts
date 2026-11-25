/**
 * Provider-independent AI service layer. The rest of the app only knows `AiProvider`.
 * Credentials come from environment variables at call time and are never stored in the database, logs or config rows.
 *
 *   ANTHROPIC_API_KEY                      → provider "anthropic"
 *   OPENAI_API_KEY [+ OPENAI_BASE_URL]     → provider "openai" (any OpenAI-compatible chat-completions endpoint)
 *   AI_MODEL_PRICING_JSON                  → optional {"<model>":{"inputPerMTok":n,"outputPerMTok":n}} (USD) for cost tracking
 *
 * NOTE: the two built-in adapters follow each vendor's public HTTP API but have only been exercised against recorded
 * request/response fixtures in tests, not against the live services (no API keys were available when they were written).
 */
export type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; args: Record<string, unknown> };
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };
export type CompletionRequest = { model: string; system: string; messages: ChatMessage[]; tools?: ToolDef[]; maxTokens?: number; temperature?: number };
export type CompletionResult = { text: string; toolCalls: ToolCall[]; usage: { inputTokens: number; outputTokens: number }; stopReason?: string };
export interface AiProvider {
  id: string; label: string; setupHint: string;
  isConfigured(): boolean;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
type FetchLike = typeof fetch;

const providers = new Map<string, AiProvider>();
export const registerProvider = (p: AiProvider) => { providers.set(p.id, p); };
export const unregisterProvider = (id: string) => { providers.delete(id); };
export const getProvider = (id: string) => providers.get(id);
export const listProviders = () => [...providers.values()].map((p) => ({ id: p.id, label: p.label, configured: p.isConfigured(), setupHint: p.setupHint }));

async function post(f: FetchLike, url: string, headers: Record<string, string>, body: unknown) {
  const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) throw new Error(`Provider error ${res.status}: ${(json?.error?.message ?? text).toString().slice(0, 300)}`);
  return json;
}

export function anthropicProvider(f: FetchLike = fetch, env: Record<string, string | undefined> = process.env): AiProvider {
  return {
    id: 'anthropic', label: 'Anthropic (Claude)', setupHint: 'Set ANTHROPIC_API_KEY on the server.',
    isConfigured: () => !!env.ANTHROPIC_API_KEY,
    async complete(req) {
      const messages: any[] = [];
      for (const m of req.messages) {
        if (m.role === 'user') messages.push({ role: 'user', content: m.content });
        else if (m.role === 'assistant') messages.push({ role: 'assistant', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.toolCalls ?? []).map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.args }))] });
        else {
          const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
          const last = messages[messages.length - 1];
          if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block); else messages.push({ role: 'user', content: [block] });
        }
      }
      const body: any = { model: req.model, max_tokens: req.maxTokens ?? 2000, system: req.system, messages };
      if (req.temperature != null) body.temperature = req.temperature;
      if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
      const j = await post(f, (env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com') + '/v1/messages', { 'x-api-key': env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' }, body);
      const blocks: any[] = j.content ?? [];
      return {
        text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
        toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} })),
        usage: { inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 }, stopReason: j.stop_reason,
      };
    },
  };
}

export function openaiCompatibleProvider(f: FetchLike = fetch, env: Record<string, string | undefined> = process.env): AiProvider {
  return {
    id: 'openai', label: 'OpenAI-compatible', setupHint: 'Set OPENAI_API_KEY (and OPENAI_BASE_URL for a compatible vendor) on the server.',
    isConfigured: () => !!env.OPENAI_API_KEY,
    async complete(req) {
      const messages: any[] = [{ role: 'system', content: req.system }];
      for (const m of req.messages) {
        if (m.role === 'user') messages.push({ role: 'user', content: m.content });
        else if (m.role === 'assistant') messages.push({ role: 'assistant', content: m.content || null, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}) });
        else messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      }
      const body: any = { model: req.model, messages, max_tokens: req.maxTokens ?? 2000 };
      if (req.temperature != null) body.temperature = req.temperature;
      if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
      const j = await post(f, (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions', { authorization: `Bearer ${env.OPENAI_API_KEY ?? ''}` }, body);
      const msg = j.choices?.[0]?.message ?? {};
      return {
        text: msg.content ?? '',
        toolCalls: (msg.tool_calls ?? []).map((t: any) => { let args = {}; try { args = JSON.parse(t.function.arguments || '{}'); } catch { /* model produced invalid JSON */ } return { id: t.id, name: t.function.name, args }; }),
        usage: { inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0 }, stopReason: j.choices?.[0]?.finish_reason,
      };
    },
  };
}
registerProvider(anthropicProvider());
registerProvider(openaiCompatibleProvider());

/** USD cost of a call, or null when no price is configured for the model (we never guess prices). */
export function costUsd(model: string, usage: { inputTokens: number; outputTokens: number }, env: Record<string, string | undefined> = process.env): number | null {
  try {
    const p = JSON.parse(env.AI_MODEL_PRICING_JSON ?? '{}')[model];
    if (!p || typeof p.inputPerMTok !== 'number' || typeof p.outputPerMTok !== 'number') return null;
    return (usage.inputTokens * p.inputPerMTok + usage.outputTokens * p.outputPerMTok) / 1_000_000;
  } catch { return null; }
}
