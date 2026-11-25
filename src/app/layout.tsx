import './globals.css';
import type { Metadata } from 'next';
import { Toasts } from '@/components/ui';

export const metadata: Metadata = { title: 'FoundersLab — build your startup with AI, scale with people', description: 'Startup Operating System' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body>{children}<Toasts /></body></html>);
}
