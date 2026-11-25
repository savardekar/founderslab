import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/db/client';
import { SESSION_COOKIE, sessionUser } from '@/server/services/auth';
import { listMyCompanies } from '@/server/services/companies';

export const dynamic = 'force-dynamic';
export default async function Home() {
  const db = await getDb();
  const user = await sessionUser(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) redirect('/login');
  const cs = await listMyCompanies(db, user.id);
  redirect(cs.length ? `/c/${cs[0].id}/dashboard` : '/onboarding');
}
