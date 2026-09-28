/**
 * Hors ligne — CDC §30.6.
 *
 * « L'utilisateur peut consulter les messages déjà chargés, mais un nouveau
 * message affiche un état hors ligne sans être perdu. »
 *
 *   · hors ligne (`navigator.onLine === false`, évènement `offline`) : l'envoi
 *     est désactivé et un message l'explique ; le texte saisi reste dans le
 *     champ ;
 *   · une question partie juste avant la coupure (échec réseau alors que le
 *     navigateur se déclare hors ligne) n'est pas perdue : elle reste dans le
 *     fil, marquée « en attente de connexion », et part AUTOMATIQUEMENT au
 *     retour du réseau (évènement `online`), avec son identifiant de requête
 *     D'ORIGINE — jamais traitée deux fois ;
 *   · l'historique déjà affiché reste consultable.
 *
 * Module pur (aucune dépendance au DOM) : la file est testée sans navigateur.
 */

export const OFFLINE_NOTICE = 'Vous êtes hors ligne. Votre message sera envoyé au retour de la connexion.';
export const OFFLINE_PENDING_LABEL = 'En attente de connexion…';

/** Le navigateur se déclare-t-il en ligne ? (sans `navigator` : oui). */
export function isBrowserOnline(nav: { onLine?: boolean } | undefined = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  return nav?.onLine !== false;
}

/** État du champ de saisie selon la connexion. */
export function composerState(online: boolean, isLoading: boolean, text: string): { canSend: boolean; notice: string | null } {
  if (!online) return { canSend: false, notice: OFFLINE_NOTICE };
  return { canSend: !isLoading && text.trim().length > 0, notice: null };
}

export interface QueuedQuestion {
  /** Identifiant du message utilisateur affiché « en attente ». */
  messageId: string;
  text: string;
  context?: Record<string, string>;
  /**
   * Identifiant de requête d'ORIGINE, réutilisé au renvoi : si la question
   * était partie avant la coupure, le serveur la reconnaît (idempotence
   * §31.9) et rend la réponse déjà produite au lieu de la traiter deux fois.
   */
  clientRequestId: string;
}

/** File des questions en attente de connexion (ordre d'envoi conservé, sans doublon). */
export class OfflineQueue {
  private items: QueuedQuestion[] = [];

  enqueue(q: QueuedQuestion): void {
    if (this.items.some((x) => x.messageId === q.messageId)) return;
    this.items.push(q);
  }

  get size(): number {
    return this.items.length;
  }

  has(messageId: string): boolean {
    return this.items.some((x) => x.messageId === messageId);
  }

  /** Vide la file et rend son contenu, dans l'ordre. */
  drain(): QueuedQuestion[] {
    const out = this.items;
    this.items = [];
    return out;
  }
}
