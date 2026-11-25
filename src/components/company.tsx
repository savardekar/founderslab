'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, useApi } from '@/lib/client';
import { NAV } from '@/lib/nav';
import { ErrorBox, Loading, fmtDate } from './ui';

type Ctx = { id: string; company: any; me: { membershipId: string; accessLevel: 'owner' | 'admin' | 'member'; userId: string }; can: (k: string) => boolean; reload: () => void; user: { name: string; email: string } };
const C = createContext<Ctx | null>(null);
export const useCompany = () => { const c = useContext(C); if (!c) throw new Error('no company ctx'); return c; };

function Bell({ cid }: { cid: string }) {
  const n = useApi(`/companies/${cid}/notifications`); const [open, setOpen] = useState(false);
  useEffect(() => { const t = setInterval(() => n.reload(), 60_000); return () => clearInterval(t); }, [n.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const unread = n.data?.unread ?? 0;
  return (
    <div className="relative">
      <button className="btn-ghost relative" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => { setOpen(!open); n.reload(); }}>🔔{unread > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">{unread > 9 ? '9+' : unread}</span>}</button>
      {open && <div className="card absolute right-0 z-30 mt-1 w-80 max-w-[90vw]"><div className="flex items-center justify-between border-b border-slate-100 p-3"><b className="text-sm">Notifications</b><button className="text-xs text-brand-700 hover:underline" onClick={async () => { await api('POST', `/companies/${cid}/notifications/read`, {}); n.reload(); }}>Mark all read</button></div>
        <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">{(n.data?.notifications ?? []).length === 0 ? <li className="p-4 text-sm text-slate-500">You're all caught up.</li> : n.data.notifications.map((x: any) => <li key={x.id}><a href={x.link ?? '#'} onClick={async () => { await api('POST', `/companies/${cid}/notifications/read`, { id: x.id }); }} className={`block p-3 text-sm hover:bg-slate-50 ${x.readAt ? 'text-slate-500' : 'font-medium'}`}>{x.title}{x.body && <span className="block text-xs font-normal text-slate-500">{x.body}</span>}<span className="block text-[11px] font-normal text-slate-400">{fmtDate(x.createdAt)}</span></a></li>)}</ul></div>}
    </div>
  );
}

export function CompanyShell({ id, children }: { id: string; children: ReactNode }) {
  const co = useApi(`/companies/${id}`);
  const list = useApi('/companies');
  const meUser = useApi('/auth/me');
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  useEffect(() => { setOpen(false); }, [path]);
  const perms = useMemo(() => new Set<string>(co.data?.permissions ?? []), [co.data]);
  if (co.loading || meUser.loading) return <Loading />;
  if (co.error) return <div className="mx-auto max-w-lg p-8"><ErrorBox error={co.error} /><Link className="btn-secondary mt-4" href="/">Go to my companies</Link></div>;
  if (!co.data || !meUser.data?.user) return <Loading />;
  const value: Ctx = { id, company: co.data.company, me: co.data.me, can: (k) => co.data.me.accessLevel === 'owner' || perms.has(k), reload: co.reload, user: meUser.data.user };
  const items = NAV.filter((n) => n.enabled && (!n.needs || value.can(n.needs)));
  const nav = (
    <nav className="flex flex-col gap-1 p-3" aria-label="Main">
      {items.map((n) => { const href = `/c/${id}/${n.href}`; const active = path.startsWith(href); return (
        <Link key={n.id} href={href} className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100'}`}><span className="w-4 text-center" aria-hidden>{n.icon}</span>{n.label}</Link>); })}
    </nav>
  );
  return (
    <C.Provider value={value}>
      <div className="min-h-screen lg:flex">
        <aside className={`fixed inset-y-0 left-0 z-40 w-64 transform border-r border-slate-200 bg-white transition lg:static lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
          <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-4"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 font-bold text-white">F</div><span className="font-semibold">FoundersLab</span></div>
          <div className="border-b border-slate-200 p-3">
            <label className="sr-only" htmlFor="switch">Switch company</label>
            <select id="switch" className="input" value={id} onChange={(e) => { if (e.target.value === '__new') location.href = '/onboarding'; else location.href = `/c/${e.target.value}/dashboard`; }}>
              {(list.data?.companies ?? [{ id, name: value.company.name }]).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="__new">＋ New company…</option>
            </select>
          </div>
          {nav}
        </aside>
        {open && <div className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" onClick={() => setOpen(false)} />}
        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-slate-200 bg-white/90 px-4 backdrop-blur">
            <button className="btn-ghost lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">☰</button>
            <p className="hidden text-sm text-slate-500 lg:block">{value.company.name}</p>
            <div className="flex items-center gap-1"><Bell cid={id} /><div className="relative">
              <button className="btn-ghost" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}><span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">{value.user.name[0]?.toUpperCase()}</span><span className="hidden sm:inline">{value.user.name}</span></button>
              {menu && <div role="menu" className="card absolute right-0 mt-1 w-48 p-1 text-sm"><Link role="menuitem" className="block rounded-md px-3 py-2 hover:bg-slate-100" href="/profile">Profile & security</Link><button role="menuitem" className="block w-full rounded-md px-3 py-2 text-left hover:bg-slate-100" onClick={async () => { await api('POST', '/auth/logout', {}); location.href = '/login'; }}>Sign out</button></div>}
            </div></div>
          </header>
          <main className="mx-auto max-w-6xl p-4 sm:p-6">{children}</main>
        </div>
      </div>
    </C.Provider>
  );
}
