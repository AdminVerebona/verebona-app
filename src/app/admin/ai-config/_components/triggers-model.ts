/**
 * Modèle d'affichage des déclencheurs d'un traitement (BO IA, ticket T4).
 *
 * Principe : tout déclencheur ENREGISTRÉ est visible et corrigeable. L'écran
 * partait du seul catalogue applicable au traitement ; une entrée héritée hors
 * de ce catalogue (ex. `schedule_hourly` sur T4) restait en base, bloquait la
 * validation, et n'apparaissait nulle part.
 *
 * Trois opérations distinctes, jamais confondues :
 *   · sélectionner  → ajoute l'entrée (active) ;
 *   · désactiver    → conserve l'entrée avec `active: false` ;
 *   · retirer / supprimer → enlève complètement l'entrée.
 */
export type TriggerKind = 'event' | 'schedule';
export interface TriggerSetting { kind: TriggerKind; code: string; active: boolean }
export interface ApplicableTrigger { code: string; label: string; kind: TriggerKind; help?: string | null }
export interface CatalogTrigger {
  code: string; label: string; kind: TriggerKind; treatments: string[] | null; retired: boolean;
}

export interface AvailableRow { def: ApplicableTrigger; setting: TriggerSetting | null }
export interface IncompatibleRow { setting: TriggerSetting; label: string; reason: string }

export function splitTriggers(p: {
  treatment: string;
  batch: boolean;
  saved: TriggerSetting[];
  applicable: ApplicableTrigger[];
  catalog: CatalogTrigger[] | undefined;
}): { available: AvailableRow[]; incompatible: IncompatibleRow[] } {
  const applicables = new Set(p.applicable.map((d) => d.code));
  const available = p.batch
    ? p.applicable.map((def) => ({ def, setting: p.saved.find((s) => s.code === def.code) ?? null }))
    : [];
  const incompatible: IncompatibleRow[] = [];
  for (const s of p.saved) {
    if (p.batch && applicables.has(s.code)) continue;
    const def = p.catalog?.find((d) => d.code === s.code);
    const label = def?.label ?? s.code;
    let reason: string;
    if (!p.batch) reason = `Ce traitement répond en direct : ce déclencheur est enregistré dans cette configuration mais ne s’applique pas à ${p.treatment}.`;
    else if (!def) reason = 'Ce déclencheur est enregistré dans cette configuration mais n’existe plus dans le catalogue.';
    else if (def.retired) reason = 'Ce déclencheur est retiré : il est enregistré dans cette configuration mais n’a plus aucun effet.';
    else reason = `Ce déclencheur est enregistré dans cette configuration mais ne s’applique pas à ${p.treatment}.`;
    incompatible.push({ setting: s, label, reason });
  }
  return { available, incompatible };
}

/** Sélectionner : ajoute une entrée valide et active (sans doublon). */
export function selectTrigger(list: TriggerSetting[], def: ApplicableTrigger): TriggerSetting[] {
  if (list.some((s) => s.code === def.code)) return list;
  return [...list, { kind: def.kind, code: def.code, active: true }];
}

/** Activer / désactiver : l'entrée est conservée. */
export function setTriggerActive(list: TriggerSetting[], code: string, active: boolean): TriggerSetting[] {
  return list.map((s) => (s.code === code ? { ...s, active } : s));
}

/** Retirer / supprimer : l'entrée disparaît de la configuration. */
export function removeTrigger(list: TriggerSetting[], code: string): TriggerSetting[] {
  return list.filter((s) => s.code !== code);
}

/** Phrase expliquant une liste vide (= défauts du code, pas « aucune exécution »). */
export function emptyListExplanation(defaults: string[], catalog: CatalogTrigger[] | undefined): string {
  if (defaults.length === 0) {
    return 'Aucun déclencheur renseigné : ce traitement ne part qu’à la demande.';
  }
  const libelles = defaults.map((c) => catalog?.find((d) => d.code === c)?.label ?? c);
  return 'Aucun déclencheur renseigné : les déclencheurs par défaut du code s’appliquent ('
    + `${libelles.join(', ')}). Une liste vide ne désactive pas les exécutions automatiques : `
    + 'pour couper un déclencheur, sélectionnez-le puis désactivez-le.';
}
