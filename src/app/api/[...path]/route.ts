import { handle } from '@/server/router';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const h = (req: Request) => handle(req);
export { h as GET, h as POST, h as PUT, h as PATCH, h as DELETE };
