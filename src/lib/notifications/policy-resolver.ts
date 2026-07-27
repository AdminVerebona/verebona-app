/**
 * NotificationPolicyResolver (CDC §11.1 / §5 / §6).
 *
 * Combine, pour un utilisateur et une entrée de catalogue :
 *   1. les règles obligatoires (§2.11) — email/cloche verrouillés ;
 *   2. les valeurs par défaut du catalogue (§6) ;
 *   3. les préférences individuelles de l'utilisateur.
 *
 * Règles de la cloche (§5.1) : non configurable en V1, toujours présente sauf
 * pour « À traiter » et les actualités (`neverBell`).
 * Le push est TOUJOURS facultatif (§5.2) ; la disponibilité réelle d'un
 * appareil est vérifiée plus tard par le WebPushChannel, pas ici.
 */

import type { CatalogEntry } from './catalog';
import { getPreference } from './preferences';
import { hasActiveNewsConsent } from './news-consent';

export interface ResolvedChannels {
  bell: boolean;
  push: boolean;
  email: boolean;
}

export async function resolveChannels(userId: number, entry: CatalogEntry): Promise<ResolvedChannels> {
  // Cloche : jamais pour neverBell ; sinon toujours présente en V1.
  const bell = !entry.neverBell;

  // Actualités : jamais envoyées sans consentement actif et distinct (§19.5).
  // L'autorisation push ne vaut pas consentement marketing.
  if (entry.category === 'news') {
    const consented = await hasActiveNewsConsent(userId);
    if (!consented) return { bell, push: false, email: false };
    const pushPref = await getPreference(userId, 'news', 'immediate', 'push');
    const emailPref = await getPreference(userId, 'news', 'immediate', 'email');
    // Une fois consenti, l'email est le canal par défaut ; le push reste opt-in.
    return { bell, push: pushPref ?? false, email: emailPref ?? true };
  }

  // Email : obligatoire → verrouillé ON ; sinon préférence, défaut du catalogue.
  let email: boolean;
  if (entry.mandatoryEmail) {
    email = true;
  } else {
    const pref = await getPreference(userId, entry.category, entry.deliveryMode, 'email');
    email = pref ?? entry.defaults.email;
  }

  // Push : toujours facultatif (jamais forcé, même pour un événement obligatoire).
  const pushPref = await getPreference(userId, entry.category, entry.deliveryMode, 'push');
  const push = pushPref ?? entry.defaults.push;

  return { bell, push, email };
}
