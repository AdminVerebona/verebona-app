/**
 * Prompts maîtres ACTIFS lus à l'exécution — ticket BO-IA-PROMPTS-01 (AC15).
 *
 * Source du texte d'un prompt maître (T1–T4, T6), par ordre de priorité :
 *   1. la version ACTIVE administrée depuis le BO (« Prompts maîtres ») ;
 *   2. à défaut, le texte porté par la version de configuration effective
 *      (D-03, historique) ;
 *   3. à défaut, le fichier `tN_master_v1.txt` du dépôt.
 *
 * Lecture faite par `config-resolver` en même temps que la version de
 * configuration effective, dans le MÊME cache et sous la MÊME clé de version
 * partagée (`ai-config`, CFG-01) : une activation incrémente la clé, chaque
 * conteneur recharge à l'appel suivant (≤ 1 s, mémoire du compteur), celui
 * qui active immédiatement. Le TTL de 30 s n'est que le filet.
 *
 * Table absente (migration 0254 non appliquée) : aucune version, la
 * configuration puis le dépôt s'appliquent — jamais d'échec d'appel.
 */
import type { Treatment } from '../config/treatments';
import type { MasterExecutionConfig } from './structured-context';

export interface ActiveMasterPrompt {
  id: number;
  treatment: Treatment;
  versionNumber: number;
  content: string;
  /** Lot 34D (0290) — configuration d'exécution explicite de la version (T4) ; `null` : LEGACY_TEMPLATE. */
  execution?: MasterExecutionConfig | null;
}

let override: Map<string, ActiveMasterPrompt> | null = null;

/** Réservé aux tests : versions actives sans base (`null` : lecture réelle). */
export function __setActiveMasterPromptsForTests(list: ActiveMasterPrompt[] | null): void {
  override = list ? new Map(list.map((p) => [p.treatment, p])) : null;
}

/** Versions actives posées par un test, sinon `null`. */
export function activeMasterPromptsTestOverride(): Map<string, ActiveMasterPrompt> | null {
  return override;
}

/**
 * Versions actives de l'environnement, par traitement. Table absente :
 * vide. Toute autre erreur est levée (l'appelant garde alors sa dernière
 * lecture plutôt que de retomber en silence sur un ancien texte).
 */
export async function loadActiveMasterPrompts(environment: string): Promise<Map<string, ActiveMasterPrompt>> {
  if (override) return override;
  const { listActivePromptVersions } = await import('./master-prompt.repository');
  try {
    const actives = await listActivePromptVersions(environment);
    return new Map(actives.map((v) => [v.treatment, {
      id: v.id, treatment: v.treatment as Treatment, versionNumber: v.versionNumber, content: v.content, execution: v.execution,
    }]));
  } catch (e) {
    if ((e as { code?: string }).code === '42P01') return new Map();
    throw e;
  }
}
