'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, act, useApi } from '@/lib/client';
import { Field, Loading } from '@/components/ui';

export default function Page() {
  const me = useApi('/auth/me'); const [name, setName] = useState(''); const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  useEffect(() => { if (me.data?.user) setName(me.data.user.name); }, [me.data]);
  if (me.loading) return <Loading />;
  if (!me.data?.user) { if (typeof window !== 'undefined') location.href = '/login'; return null; }
  return (
    <main className="mx-auto max-w-xl space-y-6 p-6">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-semibold">Profile & security</h1><Link href="/" className="btn-secondary">Back</Link></div>
      <form className="card space-y-4 p-6" onSubmit={async (e) => { e.preventDefault(); await act(() => api('PATCH', '/auth/me', { name }), 'Profile saved'); }}>
        <Field label="Email"><input className="input" disabled value={me.data.user.email} /></Field>
        <Field label="Full name" id="n"><input id="n" className="input" required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <button className="btn-primary">Save profile</button>
      </form>
      <form className="card space-y-4 p-6" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api('POST', '/auth/change-password', pw), 'Password changed. Other sessions were signed out.')) setPw({ currentPassword: '', newPassword: '' }); }}>
        <h2 className="font-semibold">Change password</h2>
        <Field label="Current password" id="c"><input id="c" className="input" type="password" required value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} autoComplete="current-password" /></Field>
        <Field label="New password" id="np" hint="At least 8 characters, with a letter and a number."><input id="np" className="input" type="password" required minLength={8} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} autoComplete="new-password" /></Field>
        <button className="btn-primary">Change password</button>
      </form>
    </main>
  );
}
