/**
 * Refus d'ecriture par les droits du compte — affichage unifie (CDC §8.3).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE
 *
 * Le serveur refusait deja certaines ecritures, mais le client n'en disait
 * rien. `AssetFormDialog` appelait `onLimitReached?.()` — une prop qu'AUCUN
 * appelant ne fournissait : le refus se terminait par un `return` silencieux.
 * L'utilisateur voyait sa demande ne rien produire, sans message ni chemin
 * de sortie.
 *
 * Un refus doit toujours dire deux choses : POURQUOI, et QUOI FAIRE. C'est
 * ce que garantit `notifyWriteBlocked` — un message issu du serveur, jamais
 * reecrit cote client, et une action vers la page des offres.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { toast } from 'sonner';

/** Page de souscription — cible unique des CTA de deblocage. */
export const OFFERS_PATH = '/mon-compte/offres';

/**
 * Codes de refus lies aux droits du compte, renvoyes par
 * `entitlements.service` (champ `reason`) ou par le controle historique
 * de quota des biens.
 */
export const WRITE_BLOCKED_CODES = [
  'TRIAL_EXPIRED',
  'SUBSCRIPTION_REQUIRED',
  'ASSET_QUOTA_REACHED',
  'DOCUMENT_QUOTA_REACHED',
  'USER_QUOTA_REACHED',
  'PREMIUM_REQUIRED',
  // Controle historique conserve le temps de la transition (cf. api/assets).
  'ASSET_LIMIT_REACHED',
] as const;

export type WriteBlockedCode = (typeof WRITE_BLOCKED_CODES)[number];

export interface WriteBlockedInfo {
  code: string;
  message: string;
  /** Quota concerne, lorsque le refus vient d'une limite chiffree. */
  limit?: number;
}

export function isWriteBlockedCode(code: unknown): code is WriteBlockedCode {
  return typeof code === 'string' && (WRITE_BLOCKED_CODES as readonly string[]).includes(code);
}

/**
 * Extrait un refus de droits d'une reponse d'erreur d'API.
 * Rend `null` si l'echec a une autre cause — une panne reseau ne doit pas
 * etre presentee comme une invitation a souscrire.
 */
export function parseWriteBlocked(body: unknown): WriteBlockedInfo | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const code = (b.code ?? b.error) as unknown;
  if (!isWriteBlockedCode(code)) return null;
  return {
    code,
    message:
      typeof b.message === 'string' && b.message.trim().length > 0
        ? b.message
        : defaultMessage(code),
    limit: typeof b.limit === 'number' ? b.limit : undefined,
  };
}

/** Repli lorsque le serveur n'a pas fourni de libelle. */
function defaultMessage(code: WriteBlockedCode): string {
  switch (code) {
    case 'TRIAL_EXPIRED':
      return "Votre essai gratuit est terminé. Vos données sont conservées : choisissez une offre pour reprendre l'ajout et la modification.";
    case 'SUBSCRIPTION_REQUIRED':
      return 'Un abonnement actif est nécessaire pour effectuer cette action.';
    case 'PREMIUM_REQUIRED':
      return 'Cette fonctionnalité est disponible avec Premium et Premium Duo.';
    default:
      return 'Vous avez atteint la limite de votre offre.';
  }
}

/** Titre court, pour un en-tete de fenetre. */
export function writeBlockedTitle(code: string): string {
  switch (code) {
    case 'TRIAL_EXPIRED':
      return 'Essai gratuit terminé';
    case 'SUBSCRIPTION_REQUIRED':
      return 'Abonnement nécessaire';
    case 'PREMIUM_REQUIRED':
      return 'Fonctionnalité Premium';
    default:
      return 'Limite atteinte';
  }
}

/**
 * Affiche le refus avec son action de deblocage.
 *
 * Utilise lorsque l'appelant n'a pas de fenetre dediee a proposer — le
 * message reste visible et actionnable, ce qui vaut toujours mieux qu'un
 * echec muet.
 */
export function notifyWriteBlocked(info: WriteBlockedInfo): void {
  toast.error(info.message, {
    duration: 8000,
    action: {
      label: 'Choisir une offre',
      onClick: () => {
        if (typeof window !== 'undefined') window.location.href = OFFERS_PATH;
      },
    },
  });
}
