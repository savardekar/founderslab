'use client';
import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && typeof window !== 'undefined' && !/^\/(login|register|forgot|reset|accept)/.test(location.pathname)) { location.href = '/login?next=' + encodeURIComponent(location.pathname); }
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'Request failed');
  return data as T;
}

export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const load = useCallback(async () => {
    if (!path) return;
    try { setError(null); setData(await api<T>('GET', path)); } catch (e) { setError(e as ApiError); } finally { setLoading(false); }
  }, [path]);
  useEffect(() => { setLoading(!!path); load(); }, [load, path]);
  return { data, error, loading, reload: load, setData };
}

/** Run an async action with toast error handling. */
export async function act<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  const { toast } = await import('@/components/ui');
  try { const r = await fn(); if (success) toast(success, 'ok'); return r; } catch (e) { toast((e as Error).message, 'error'); return undefined; }
}
