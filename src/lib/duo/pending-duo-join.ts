/**
 * Rattachement à un Premium Duo par invitation — parcours de l'invité.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'INVITÉ NE POUVAIT PAS REJOINDRE LE DUO
 *
 *   1. `/duo/join/[token]` interrogeait `GET /api/duo/join` SANS le jeton :
 *      la route répondait 400 MISSING_TOKEN et la page affichait « Lien
 *      invalide » à tous les invités.
 *   2. Un invité sans compte partait vers l'inscription, puis la
 *      vérification de l'e-mail… et le jeton était perdu : rien ne le
 *      rattachait au Duo ensuite. Il devait retrouver l'e-mail d'invitation
 *      et recliquer le lien, une fois connecté.
 *
 * Désormais le jeton est mémorisé (stockage local, le temps du parcours)
 * avant l'inscription ou la connexion, et consommé automatiquement dès que
 * l'invité est connecté : au retour sur `/duo/join/[token]` (connexion avec
 * `returnUrl`) ou sur l'accueil (fin d'inscription). Le jeton est retiré dès
 * la première tentative, réussie ou non, pour ne jamais boucler.
 * ══════════════════════════════════════════════════════════════════════════
 */

export const PENDING_DUO_TOKEN_KEY = 'pending_duo_join_token';

export type DuoJoinResult =
  | { ok: true }
  | { ok: false; error: string; message?: string };

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // navigation privée, stockage bloqué
  }
}

/** Mémorise l'invitation avant l'inscription ou la connexion. */
export function rememberPendingDuoJoin(token: string): void {
  try { storage()?.setItem(PENDING_DUO_TOKEN_KEY, token); } catch { /* stockage indisponible */ }
}

/** Invitation en attente, sans la retirer. */
export function peekPendingDuoJoin(): string | null {
  try { return storage()?.getItem(PENDING_DUO_TOKEN_KEY) ?? null; } catch { return null; }
}

/** Retire et renvoie l'invitation en attente (usage unique). */
export function takePendingDuoJoin(): string | null {
  const token = peekPendingDuoJoin();
  if (token) {
    try { storage()?.removeItem(PENDING_DUO_TOKEN_KEY); } catch { /* stockage indisponible */ }
  }
  return token;
}

/** `POST /api/duo/join` — l'invité doit être connecté. */
export async function joinDuo(token: string): Promise<DuoJoinResult> {
  try {
    const res = await fetch('/api/duo/join', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true };
    return { ok: false, error: data.error ?? 'UNKNOWN', message: data.message };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

/** Message français pour un refus de rattachement. */
export function duoJoinErrorMessage(error: string): string {
  switch (error) {
    case 'ALREADY_IN_DUO': return 'Vous êtes déjà rattaché à une autre offre Premium Duo.';
    case 'EXPIRED_TOKEN': return 'Ce lien d’invitation a expiré. Demandez au titulaire d’en générer un nouveau.';
    case 'INVALID_TOKEN': return 'Ce lien d’invitation est invalide ou a déjà été utilisé.';
    case 'SUBSCRIPTION_INACTIVE': return 'L’abonnement Premium Duo associé à cette invitation n’est plus actif.';
    case 'SLOT_ALREADY_TAKEN': return 'Cet espace Premium Duo compte déjà deux membres.';
    case 'CANNOT_JOIN_OWN_DUO': return 'Vous êtes le titulaire de cet espace Premium Duo.';
    case 'INVITE_EMAIL_MISMATCH': return 'Cette invitation a été envoyée à une autre adresse e-mail. Connectez-vous avec l’adresse invitée.';
    default: return 'Le rattachement au Premium Duo a échoué. Veuillez réessayer depuis le lien d’invitation.';
  }
}
