import { getSignupMode } from '@/lib/prelaunch';
import { resolveSignupInvitation, type InvitationError } from '@/lib/prelaunch-invitations';
import { SignupForm } from './SignupForm';
import { SignupClosed } from './SignupClosed';

// Le mode est lu à l'exécution (SIGNUP_MODE) : jamais figé au build.
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim() ? v.trim() : null;
}

/**
 * /signup — CDC pré-lancement.
 *
 * SIGNUP_MODE=full (défaut) : formulaire d'inscription habituel.
 * SIGNUP_MODE=prelaunch      : « Verebona ouvre bientôt », sauf lien
 *   d'invitation valide (compte partagé, Premium Duo ou transmission d'un
 *   bien), qui affiche le
 *   formulaire. L'email n'est pas connu ici : sa correspondance avec
 *   l'invitation est vérifiée par POST /api/users, qui reste la seule garde.
 */
export default async function SignupPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (getSignupMode() === 'full') return <SignupForm />;

  // Le jeton d'une transmission de bien vaut invitation (voir
  // `lib/prelaunch-invitations.ts`) : le destinataire sans compte doit
  // pouvoir s'inscrire pour recevoir le bien.
  const params = await searchParams;
  const token = first(params.inviteToken) ?? first(params.transmissionToken);
  if (!token) return <SignupClosed />;

  let invitationError: InvitationError | null = null;
  try {
    const invitation = await resolveSignupInvitation(token, '');
    if (invitation.valid || invitation.code === 'INVITE_EMAIL_MISMATCH') return <SignupForm />;
    invitationError = invitation.code;
  } catch (error) {
    // Base indisponible : le formulaire reste accessible, POST /api/users
    // refusera la création si l'invitation n'est pas valide.
    console.error('[signup] vérification de l\'invitation impossible :', error);
    return <SignupForm />;
  }
  return <SignupClosed invitationError={invitationError} />;
}
