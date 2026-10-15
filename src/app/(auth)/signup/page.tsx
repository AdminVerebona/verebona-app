import { getSignupMode } from '@/lib/prelaunch';
import {
  describeSignupInvitation,
  resolveSignupInvitation,
  type InvitationError,
  type SignupInvitationContext,
} from '@/lib/prelaunch-invitations';
import { SignupForm, type SignupFormInvitation } from './SignupForm';
import { SignupClosed } from './SignupClosed';
import { SignupInvitationInvalid } from './SignupInvitationInvalid';

// Le mode est lu à l'exécution (SIGNUP_MODE) : jamais figé au build.
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim() ? v.trim() : null;
}

/** Contexte d'invitation transmis au formulaire (rien de secret). */
function toFormInvitation(ctx: SignupInvitationContext | null): SignupFormInvitation | null {
  if (!ctx || ctx.state !== 'valid') return null;
  if (ctx.kind === 'duo') return { kind: 'duo', ownerName: ctx.ownerName, inviteEmail: ctx.inviteEmail };
  if (ctx.kind === 'account') return { kind: 'account' };
  return null;
}

async function describeSafe(token: string): Promise<SignupInvitationContext | null> {
  try {
    return await describeSignupInvitation(token);
  } catch (error) {
    // Base indisponible : le formulaire reste accessible, POST /api/users
    // refusera la création si l'invitation n'est pas valide.
    console.error('[signup] lecture de l\'invitation impossible :', error);
    return null;
  }
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
 *
 * Lot 57A (ticket P2 « Premium Duo : supprimer le parrainage du formulaire
 * d'inscription des invités ») : le contexte d'invitation est établi ICI,
 * côté serveur, à partir du jeton — jamais d'un simple paramètre d'URL.
 *   · invitation Premium Duo valide → formulaire « invité Duo » (aucun
 *     parrainage, texte et bouton dédiés) ;
 *   · invitation expirée, déjà utilisée ou inconnue → message explicite et
 *     actions de sortie, au lieu d'un basculement silencieux vers
 *     l'inscription classique ;
 *   · sans invitation → inscription classique, parrainage facultatif.
 */
export default async function SignupPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const inviteToken = first(params.inviteToken);

  if (getSignupMode() === 'full') {
    if (!inviteToken) return <SignupForm />;
    const ctx = await describeSafe(inviteToken);
    if (!ctx) return <SignupForm />;
    if (ctx.state === 'valid') return <SignupForm invitation={toFormInvitation(ctx)} />;
    return <SignupInvitationInvalid context={ctx} allowClassicSignup />;
  }

  // Le jeton d'une transmission de bien vaut invitation (voir
  // `lib/prelaunch-invitations.ts`) : le destinataire sans compte doit
  // pouvoir s'inscrire pour recevoir le bien.
  const token = inviteToken ?? first(params.transmissionToken);
  if (!token) return <SignupClosed />;

  // Invitation Premium Duo expirée / utilisée / inactive : message dédié.
  // (Lue AVANT `resolveSignupInvitation`, qui, sans adresse saisie, rendait
  // « autre adresse » — tenu pour valide — avant même l'expiration.)
  const ctx = inviteToken ? await describeSafe(token) : null;
  if (ctx && ctx.kind === 'duo' && ctx.state !== 'valid') return <SignupInvitationInvalid context={ctx} allowClassicSignup={false} />;

  let invitationError: InvitationError | null = null;
  try {
    const invitation = await resolveSignupInvitation(token, '');
    if (invitation.valid || invitation.code === 'INVITE_EMAIL_MISMATCH') {
      return <SignupForm invitation={toFormInvitation(ctx)} />;
    }
    invitationError = invitation.code;
  } catch (error) {
    // Base indisponible : le formulaire reste accessible, POST /api/users
    // refusera la création si l'invitation n'est pas valide.
    console.error('[signup] vérification de l\'invitation impossible :', error);
    return <SignupForm />;
  }
  return <SignupClosed invitationError={invitationError} />;
}
