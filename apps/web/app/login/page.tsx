import type { Metadata } from 'next';
import { LoginView } from '../../components/account/LoginView';
import { safeNext } from '../../lib/safe-next';

export const metadata: Metadata = { title: 'Log in', robots: { index: false, follow: true } };
type Props = { searchParams: Promise<{ next?: string | string[] }> };

export default async function LoginPage({ searchParams }: Props) {
  const { next } = await searchParams;
  return <LoginView next={safeNext(typeof next === 'string' ? next : null)} />;
}
