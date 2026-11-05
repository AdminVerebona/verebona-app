/**
 * Lot 111E — harnais navigateur : VRAIS formulaires d'authentification
 * (connexion, inscription, réinitialisation, activation) montés dans Chromium, pour
 * simuler un remplissage automatique puis l'envoi.
 */
import { createRoot, type Root } from 'react-dom/client';
import LoginPage from '@/app/(auth)/login/page';
import ResetPasswordPage from '@/app/(auth)/reset-password/page';
import ActivatePage from '@/app/(auth)/verify-email/activer/page';
import { SignupForm } from '@/app/(auth)/signup/SignupForm';

function SignupPage() { return <SignupForm />; }

let root: Root | null = null;
const PAGES = { login: LoginPage, reset: ResetPasswordPage, activate: ActivatePage, signup: SignupPage } as const;

(window as unknown as { __mount: (p: keyof typeof PAGES) => void }).__mount = (p) => {
  root?.unmount();
  root = createRoot(document.getElementById('root')!);
  const Page = PAGES[p];
  root.render(<Page />);
};
