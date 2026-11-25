import { CompanyShell } from '@/components/company';
export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  return <CompanyShell id={companyId}>{children}</CompanyShell>;
}
