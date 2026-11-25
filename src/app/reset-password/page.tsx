'use client';
import { Suspense, useState } from 'react';
import { api, act } from '@/lib/client';
import { AuthShell, Field } from '@/components/ui';

function Form() {
  const [password, setPassword] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const token = new URLSearchParams(location.search).get('token') ?? '';
    if (await act(() => api('POST', '/auth/reset-password', { token, password }), 'Password updated. Please sign in.')) location.href = '/login';
  }
  return (<AuthShell title="Choose a new password"><form onSubmit={submit} className="space-y-4"><Field label="New password" id="p" hint="At least 8 characters, with a letter and a number."><input id="p" className="input" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field><button className="btn-primary w-full">Update password</button></form></AuthShell>);
}
export default function Page() { return <Suspense><Form /></Suspense>; }
