/**
 * Embedding layer for knowledge search. Provider-independent, credentials from the environment only.
 *
 *   EMBEDDINGS_PROVIDER=openai + OPENAI_API_KEY + EMBEDDING_MODEL [+ OPENAI_BASE_URL]  → neural embeddings (true semantic search)
 *   otherwise                                                                         → "local-hash": deterministic hashed word / bigram / character-trigram
 *                                                                                       vectors. These are LEXICAL, not semantic: they tolerate typos, plurals and
 *                                                                                       word order, but do not know that "refund" ≈ "money back". Search always combines
 *                                                                                       them with keyword (BM25-style) scoring.
 * Each chunk records the model that embedded it; vectors from different models are never compared.
 */
export interface Embedder { id: string; model: string; semantic: boolean; label: string; embed(texts: string[]): Promise<number[][]> }

export const tokenize = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 || /\p{N}/u.test(t));
const fnv = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };

export function localHashEmbedder(dims = 384): Embedder {
  const vec = (text: string) => {
    const counts = new Map<string, number>(); const bump = (f: string, w: number) => counts.set(f, (counts.get(f) ?? 0) + w);
    const toks = tokenize(text).slice(0, 4000);
    toks.forEach((t, i) => { bump('w:' + t, 1); if (i > 0) bump('b:' + toks[i - 1] + ' ' + t, 0.6); if (t.length >= 4) for (let k = 0; k + 3 <= t.length; k++) bump('c:' + t.slice(k, k + 3), 0.25); });
    const v = new Float64Array(dims);
    for (const [f, c] of counts) { const h = fnv(f); v[h % dims] += ((h >>> 16) & 1 ? 1 : -1) * (1 + Math.log(c)); }
    let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
    return Array.from(v, (x) => Math.round((x / n) * 1e4) / 1e4);
  };
  return { id: 'local-hash', model: `local-hash-${dims}`, semantic: false, label: 'Local hashed vectors + keyword (lexical, not neural)', embed: async (texts) => texts.map(vec) };
}

export function openaiEmbedder(f: typeof fetch = fetch, env: Record<string, string | undefined> = process.env): Embedder {
  const model = env.EMBEDDING_MODEL ?? '';
  return {
    id: 'openai', model, semantic: true, label: `Neural embeddings (${model})`,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 64) {
        const res = await f((env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '') + '/embeddings', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY ?? ''}` }, body: JSON.stringify({ model, input: texts.slice(i, i + 64).map((t) => t.slice(0, 8000)) }), signal: AbortSignal.timeout(60_000) });
        const j: any = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`Embedding provider error ${res.status}: ${String(j?.error?.message ?? '').slice(0, 200)}`);
        out.push(...[...(j.data ?? [])].sort((a: any, b: any) => a.index - b.index).map((d: any) => (d.embedding as number[]).map((x) => Math.round(x * 1e5) / 1e5)));
      }
      return out;
    },
  };
}

let override: Embedder | null = null;
export const setEmbedder = (e: Embedder | null) => { override = e; };
export function getEmbedder(env: Record<string, string | undefined> = process.env): Embedder {
  if (override) return override;
  if (env.EMBEDDINGS_PROVIDER === 'openai' && env.OPENAI_API_KEY && env.EMBEDDING_MODEL) return openaiEmbedder(fetch, env);
  return localHashEmbedder();
}
export const cosine = (a: number[], b: number[]) => { if (a.length !== b.length) return 0; let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };

/** Splits text on paragraph boundaries into ~900-character chunks with a short overlap; a heading starts a new chunk and is kept as context. */
export function chunkText(body: string, maxChars = 900, overlap = 120): { heading: string | null; content: string }[] {
  const paras = body.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: { heading: string | null; content: string }[] = []; let heading: string | null = null; let buf = ''; let bufHeading: string | null = null;
  const flush = (carry: boolean) => { if (buf.trim()) out.push({ heading: bufHeading, content: buf.trim() }); const tail = buf.slice(-overlap); buf = carry && out.length && tail.length === overlap ? tail + '\n' : ''; bufHeading = heading; };
  for (let p of paras) {
    const h = /^#{1,4}\s+(.*)$/.exec(p.split('\n')[0]);
    if (h) { if (buf.trim()) flush(false); heading = h[1].trim().slice(0, 120); bufHeading = heading; buf = ''; }
    while (p.length > maxChars) { const cut = Math.max(p.lastIndexOf('. ', maxChars), p.lastIndexOf(' ', maxChars), maxChars / 2); if (!buf) bufHeading = heading; buf += p.slice(0, cut + 1); flush(true); p = p.slice(cut + 1).trim(); }
    if (!buf) bufHeading = heading;
    if ((buf + p).length > maxChars && buf.trim()) flush(true);
    buf += (buf && !buf.endsWith('\n') ? '\n\n' : '') + p;
  }
  if (buf.trim()) out.push({ heading: bufHeading, content: buf.trim() });
  return out.slice(0, 200);
}
