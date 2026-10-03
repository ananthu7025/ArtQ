import type { Metadata } from 'next';
import { VerifyView } from '../../../components/account/SignupView';
import { safeNext } from '../../../lib/safe-next';

export const metadata: Metadata = { title: 'Confirm your email', robots: { index: false, follow: false } };
type Props = { searchParams: Promise<{ next?: string | string[] }> };

export default async function VerifyPage({ searchParams }: Props) {
  const { next } = await searchParams;
  return <VerifyView next={safeNext(typeof next === 'string' ? next : null)} />;
}
