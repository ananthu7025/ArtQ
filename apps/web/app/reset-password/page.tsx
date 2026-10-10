import type { Metadata } from 'next';
import { ResetView } from '../../components/account/PasswordViews';

// The token is in the URL: never indexed, and no referrer leaves this page.
export const metadata: Metadata = { title: 'Choose a new password', robots: { index: false, follow: false }, referrer: 'no-referrer' };
type Props = { searchParams: Promise<{ token?: string | string[] }> };

export default async function ResetPasswordPage({ searchParams }: Props) {
  const { token } = await searchParams;
  return <ResetView token={typeof token === 'string' && token ? token : null} />;
}
