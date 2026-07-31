/** Barrel des registres versionnés de l'assistant. */
export * from './intent-registry';
export * from './action-registry';
export * from './capability-registry';
export * from './model-registry';
export * from './prompt-registry';
export * from './pricing-catalog';
export * from './retrieval-adapter-registry';

export * from './retrieval-adapters';

import { ADAPTATEURS } from './retrieval-adapters';
import { registerRetrievalAdapter, getEnabledAdapters } from './retrieval-adapter-registry';

/**
 * Enregistre les adaptateurs de récupération.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SANS CET APPEL, L'ASSISTANT NE TROUVE QUE DES NOMS DE BIENS
 *
 * `getEnabledAdapters()` lisait un tableau que personne n'alimentait.
 * `retrieve()` retombait sur son repli minimal — une recherche par nom de
 * bien — et l'assistant ne pouvait trouver ni document, ni échéance, ni
 * équipement.
 *
 * Le code des adaptateurs existait ; il manquait cette ligne.
 *
 * Idempotent : appelé deux fois, il n'enregistre rien en double. Un
 * rechargement de module en développement le déclencherait sinon à chaque
 * fois, et chaque recherche rendrait des doublons.
 * ══════════════════════════════════════════════════════════════════════════
 */
export function registerAllRetrievalAdapters(): void {
  if (getEnabledAdapters().length > 0) return;
  for (const a of ADAPTATEURS) registerRetrievalAdapter(a);
}
