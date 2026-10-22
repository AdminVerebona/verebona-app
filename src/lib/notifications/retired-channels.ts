/**
 * Canaux SUPPRIMÉS — lot 79C (ticket « E-mails et notifications — supprimer
 * les communications inutiles et fiabiliser les règles d'envoi »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN DÉFAUT À `false` NE SUFFIT PAS
 *
 * Une préférence déjà enregistrée (catégorie « Documents » : e-mail activé),
 * une ligne d'outbox créée avant le déploiement, une reprise, une réémission
 * BO ou une activation BO du canal pouvaient réactiver un envoi supprimé.
 *
 * Le canal supprimé est donc coupé AU MOMENT DE L'ENVOI, après préférences,
 * restriction de réémission et AVANT l'activation BO — et même si la ligne
 * d'outbox porte encore un drapeau « obligatoire » d'une version antérieure.
 * Chaque coupure laisse une livraison `skipped_unavailable` de code
 * `channel_retired` : distincte d'un envoi réussi, jamais comptée « envoyé ».
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CatalogEntry } from './catalog';

export const CHANNEL_RETIRED_ERROR_CODE = 'channel_retired';

export type RetirableChannel = 'email' | 'push';

export interface RetiredChannelsResult<T> {
  channels: T;
  /** Canaux qui auraient été servis et que la suppression a coupés. */
  retired: RetirableChannel[];
}

/** Le canal est-il supprimé pour cet événement ? */
export function isChannelRetired(entry: Pick<CatalogEntry, 'retiredChannels'> | undefined, channel: RetirableChannel): boolean {
  return !!entry?.retiredChannels?.[channel];
}

/** Coupe les canaux supprimés (pure). */
export function applyRetiredChannels<T extends { email: boolean; push: boolean }>(
  channels: T,
  entry: Pick<CatalogEntry, 'retiredChannels'>,
): RetiredChannelsResult<T> {
  const out = { ...channels };
  const retired: RetirableChannel[] = [];
  for (const c of ['email', 'push'] as const) {
    if (out[c] && isChannelRetired(entry, c)) {
      (out as { email: boolean; push: boolean })[c] = false;
      retired.push(c);
    }
  }
  return { channels: out, retired };
}
