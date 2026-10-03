import type { Metadata } from 'next';
import { SetPasswordView } from '../../components/account/PasswordViews';

// The token is in the URL: never indexed, and no referrer leaves this page.
export const metadata: Metadata = { title: 'Set your password', robots: { index: false, follow: false }, referrer: 'no-referrer' };
type Props = { searchParams: Promise<{ token?: string | string[] }> };

export default async function SetPasswordPage({ searchParams }: Props) {
  const { token } = await searchParams;
  return <SetPasswordView token={typeof token === 'string' && token ? token : null} />;
}
