import { schema, type Db } from '@/db/client';

const SECRET = /pass|token|secret|key$|authorization|cookie/i;
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) ? '[redacted]' : redact(x)]));
  return v;
}
export async function audit(db: Db, companyId: string, actorUserId: string | null, action: string, resourceType: string, resourceId?: string | null, metadata: Record<string, unknown> = {}) {
  await db.insert(schema.auditLogs).values({ companyId, actorUserId, action, resourceType, resourceId: resourceId ?? null, metadata: redact(metadata) as Record<string, unknown> });
}
