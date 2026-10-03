import type { Metadata } from 'next';
import { ForgotView } from '../../components/account/PasswordViews';

export const metadata: Metadata = { title: 'Forgot password', robots: { index: false, follow: true } };

export default function ForgotPasswordPage() {
  return <ForgotView />;
}
