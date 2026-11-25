'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { AuthShell, Spinner } from '@/components/ui';

export default function Page() {
  const [state, setState] = useState<{ error?: string; needLogin?: boolean }>({});
  useEffect(() => {
    (async () => {
      const token = new URLSearchParams(location.search).get('token') ?? '';
      const me = await api('GET', '/auth/me');
      if (!me.user) return setState({ needLogin: true });
      try { const r = await api('POST', '/invites/accept', { token }); location.href = `/c/${r.companyId}/dashboard`; } catch (e) { setState({ error: (e as Error).message }); }
    })();
  }, []);
  const next = typeof window !== 'undefined' ? encodeURIComponent('/accept-invite' + location.search) : '';
  return (
    <AuthShell title="Join your company">
      {state.error ? <p className="text-sm text-red-700">{state.error}</p> : state.needLogin ? (
        <div className="space-y-3 text-sm"><p>Sign in (or create an account) using the email address that received the invitation to join.</p><div className="flex gap-2"><Link className="btn-primary flex-1" href={`/login?next=${next}`}>Sign in</Link><Link className="btn-secondary flex-1" href={`/register?next=${next}`}>Create account</Link></div></div>
      ) : <div className="flex justify-center"><Spinner /></div>}
    </AuthShell>
  );
}
