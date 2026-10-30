/**
 * Canaux SUPPRIMÉS — lot 79C (ticket « E-mails et notifications — supprimer
 * les communications inutiles et fiabiliser les règles d'envoi »), étendu à
 * la CLOCHE au lot 101B (ticket « Notifications de sécurité — supprimer les
 * affichages in-app redondants avec les e-mails »).
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
 * d'outbox porte encore un drapeau « obligatoire » d'une version antérieure
 * (`mandatory_bell` des événements de sécurité mis en file avant le lot 101B).
 * Chaque coupure laisse une livraison `skipped_unavailable` de code
 * `channel_retired` : distincte d'un envoi réussi, jamais comptée « envoyé »,
 * jamais comptée « échec » (supervision, §18.4).
 *
 * CLOCHE SUPPRIMÉE (lot 101B) : aucune ligne `notifications` n'est créée,
 * donc rien à afficher (cloche, pastille, toast d'arrivée). Les lignes de
 * cloche DÉJÀ persistées pour ces types restent en base (preuve d'audit,
 * purge normale à 12 mois) mais ne sont plus servies au client
 * (`bellRetiredTypes`, lu par `GET /api/notifications`) : même règle, même
 * source (le catalogue), aucun masquage dans les composants.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CatalogEntry } from './catalog';

export const CHANNEL_RETIRED_ERROR_CODE = 'channel_retired';

type RetirableChannel = 'bell' | 'email' | 'push';

const RETIRABLE_CHANNELS: readonly RetirableChannel[] = ['bell', 'email', 'push'];

interface RetiredChannelsResult<T> {
  channels: T;
  /** Canaux qui auraient été servis et que la suppression a coupés. */
  retired: RetirableChannel[];
}

/** Le canal est-il supprimé pour cet événement ? */
export function isChannelRetired(entry: Pick<CatalogEntry, 'retiredChannels'> | undefined, channel: RetirableChannel): boolean {
  return !!entry?.retiredChannels?.[channel];
}

/** Coupe les canaux supprimés (pure). */
export function applyRetiredChannels<T extends { bell: boolean; email: boolean; push: boolean }>(
  channels: T,
  entry: Pick<CatalogEntry, 'retiredChannels'>,
): RetiredChannelsResult<T> {
  const out = { ...channels };
  const retired: RetirableChannel[] = [];
  for (const c of RETIRABLE_CHANNELS) {
    if (out[c] && isChannelRetired(entry, c)) {
      (out as { bell: boolean; email: boolean; push: boolean })[c] = false;
      retired.push(c);
    }
  }
  return { channels: out, retired };
}

/**
 * Lot 101B : types d'événements dont la CLOCHE est supprimée (pure). Leurs
 * lignes de cloche historiques ne sont plus servies au client.
 */
export function bellRetiredTypes(catalog: Readonly<Record<string, Pick<CatalogEntry, 'retiredChannels'> | undefined>>): string[] {
  return Object.entries(catalog)
    .filter(([, entry]) => isChannelRetired(entry, 'bell'))
    .map(([type]) => type)
    .sort();
}
