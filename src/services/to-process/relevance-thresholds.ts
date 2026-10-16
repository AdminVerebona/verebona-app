/**
 * Seuils de la pertinence « À traiter » — lot 63 (décision PO du 16/10,
 * point 2) : les constantes du lot 61 (agent 61D) deviennent RÉGLABLES dans
 * BO › Configuration IA › Réglages (`assistant-settings`, même mécanisme que
 * `t6_interpellation_threshold_days` du lot 60 : BO > environnement > défaut,
 * journal, prise en compte sur toutes les instances en quelques secondes).
 *
 * Valeurs par défaut = valeurs du lot 61 (comportement inchangé tant que le
 * BO n'est pas modifié) :
 *   · horizon de report d'une échéance future .............. 120 jours ;
 *   · document « historique » (toutes ses dates fiables) .... 5 ans ;
 *   · réévaluation d'une décision incertaine ................ 30 jours ;
 *   · réévaluation d'un document sans date .................. 90 jours ;
 *   · réévaluation d'une date suggérée par le seul titre ... 180 jours.
 *
 * ── INVALIDATION (signature de pertinence) ────────────────────────────────
 * Un réglage MODIFIÉ entre dans la référence de configuration de la décision
 * (`config_ref` de `document_rule_evaluations`) : les décisions NO_ACTION /
 * DEFER mémorisées sont reprises au balayage suivant. Seuls les délais de
 * réévaluation (`DEFER_*`) influencent une décision rendue par T4 : eux
 * seuls entrent dans la signature de la décision IA mémorisée — changer
 * l'horizon ou le seuil « historique » ne rappelle donc jamais T4 pour une
 * décision qu'il a déjà rendue (aucun coût inutile). Aux valeurs par défaut,
 * références et signatures sont IDENTIQUES à celles du lot 61 (aucune
 * réévaluation massive au déploiement).
 *
 * ── TRAÇAGE ──────────────────────────────────────────────────────────────
 * Les valeurs utilisées sont écrites dans le contrat de décision
 * (`decision_contract.thresholds`) de chaque évaluation, affiché par le
 * diagnostic BO (File IA › T3 › diagnostic des actions ouvertes).
 */

export interface ToProcessThresholds {
  /** Horizon au-delà duquel une échéance future n'appelle pas encore de question (jours). */
  futureHorizonDays: number;
  /** Document dont toutes les dates fiables ont plus de N années : historique. */
  historicalYears: number;
  /** Réévaluation d'une décision incertaine (jours). */
  deferUncertainDays: number;
  /** Réévaluation d'un document sans date (jours). */
  deferUndatedDays: number;
  /** Réévaluation d'une date suggérée par le seul titre (jours). */
  deferTitleOnlyDays: number;
}

/** Valeurs du lot 61 — défaut du code. */
export const DEFAULT_TO_PROCESS_THRESHOLDS: Readonly<ToProcessThresholds> = Object.freeze({
  futureHorizonDays: 120,
  historicalYears: 5,
  deferUncertainDays: 30,
  deferUndatedDays: 90,
  deferTitleOnlyDays: 180,
});

/** Réglage BO de chaque seuil (clé, variable d'environnement de repli, bornes). */
export const TO_PROCESS_THRESHOLD_SETTINGS: Readonly<Record<keyof ToProcessThresholds, { key: string; env: string; min: number; max: number }>> = {
  futureHorizonDays: { key: 'to_process_future_horizon_days', env: 'TO_PROCESS_FUTURE_HORIZON_DAYS', min: 7, max: 730 },
  historicalYears: { key: 'to_process_historical_years', env: 'TO_PROCESS_HISTORICAL_YEARS', min: 1, max: 30 },
  deferUncertainDays: { key: 'to_process_defer_uncertain_days', env: 'TO_PROCESS_DEFER_UNCERTAIN_DAYS', min: 7, max: 365 },
  deferUndatedDays: { key: 'to_process_defer_undated_days', env: 'TO_PROCESS_DEFER_UNDATED_DAYS', min: 7, max: 730 },
  deferTitleOnlyDays: { key: 'to_process_defer_title_only_days', env: 'TO_PROCESS_DEFER_TITLE_ONLY_DAYS', min: 7, max: 730 },
};

const CLES = Object.keys(DEFAULT_TO_PROCESS_THRESHOLDS) as Array<keyof ToProcessThresholds>;

/** Valeur admise (entier dans les bornes) — sinon le défaut (pure). */
export function sanitizeThresholds(raw: Partial<Record<keyof ToProcessThresholds, unknown>> | null | undefined): ToProcessThresholds {
  const out = { ...DEFAULT_TO_PROCESS_THRESHOLDS };
  for (const k of CLES) {
    const v = Number(raw?.[k]);
    const b = TO_PROCESS_THRESHOLD_SETTINGS[k];
    if (Number.isInteger(v) && v >= b.min && v <= b.max) out[k] = v;
  }
  return out;
}

const modifies = (t: ToProcessThresholds, cles: ReadonlyArray<keyof ToProcessThresholds>) =>
  cles.filter((k) => t[k] !== DEFAULT_TO_PROCESS_THRESHOLDS[k]);

const ABREV: Record<keyof ToProcessThresholds, string> = {
  futureHorizonDays: 'h', historicalYears: 'a', deferUncertainDays: 'i', deferUndatedDays: 'u', deferTitleOnlyDays: 't',
};

/**
 * Référence des seuils MODIFIÉS (pure) — `null` aux valeurs par défaut, sinon
 * `seuils:h=150,i=45` (clés abrégées, ordre stable). Entre dans `config_ref`.
 */
export function thresholdsRef(t: ToProcessThresholds | null | undefined): string | null {
  if (!t) return null;
  const m = modifies(t, CLES);
  return m.length ? `seuils:${m.map((k) => `${ABREV[k]}=${t[k]}`).join(',')}` : null;
}

/** Seuils qui influencent une décision rendue par T4 (délais de réévaluation). */
const SEUILS_DECISION_IA: ReadonlyArray<keyof ToProcessThresholds> = ['deferUncertainDays', 'deferUndatedDays', 'deferTitleOnlyDays'];

/** Référence des délais de réévaluation modifiés (signature de la décision IA mémorisée) — `null` par défaut. */
export function deferThresholdsRef(t: ToProcessThresholds | null | undefined): string | null {
  if (!t) return null;
  const m = modifies(t, SEUILS_DECISION_IA);
  return m.length ? `seuils:${m.map((k) => `${ABREV[k]}=${t[k]}`).join(',')}` : null;
}

/** Référence de configuration complète (IA + seuils modifiés), écrite dans `config_ref`. */
export function composeConfigRef(aiRef: string, t: ToProcessThresholds | null | undefined): string {
  const s = thresholdsRef(t);
  return s ? `${aiRef}|${s}` : aiRef;
}

/**
 * Seuils effectifs (BO > environnement > défaut). Ne lève jamais : réglages
 * illisibles → valeurs par défaut (comportement du lot 61).
 */
export async function loadToProcessThresholds(): Promise<ToProcessThresholds> {
  try {
    const m = await import('@/services/verebona-assistant/config/assistant-settings');
    await m.refreshAssistantSettings();
    return sanitizeThresholds(Object.fromEntries(CLES.map((k) => [k, m.effectiveSetting(TO_PROCESS_THRESHOLD_SETTINGS[k].key)])));
  } catch (e) {
    console.warn('[to-process] seuils « À traiter » illisibles — valeurs par défaut :', (e as Error).message);
    return { ...DEFAULT_TO_PROCESS_THRESHOLDS };
  }
}
