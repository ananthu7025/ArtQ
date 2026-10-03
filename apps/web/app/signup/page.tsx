import type { Metadata } from 'next';
import { SignupView } from '../../components/account/SignupView';
import { safeNext } from '../../lib/safe-next';

export const metadata: Metadata = { title: 'Create an account', robots: { index: false, follow: true } };
type Props = { searchParams: Promise<{ next?: string | string[] }> };

export default async function SignupPage({ searchParams }: Props) {
  const { next } = await searchParams;
  return <SignupView next={safeNext(typeof next === 'string' ? next : null)} />;
}
