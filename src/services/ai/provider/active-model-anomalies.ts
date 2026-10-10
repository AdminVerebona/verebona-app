/**
 * Modèles ACTIFS devenus inutilisables — lot 35B, ticket « Catalogue IA
 * dynamique Google » (« Dépréciation / disparition automatique »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NE JAMAIS REMPLACER UN MODÈLE ACTIF
 *
 * Quand un modèle employé par la configuration EFFECTIVE (principal ou
 * repli) disparaît du catalogue de la clé active, devient non opérationnel,
 * échoue à sa qualification ou est déclaré retiré :
 *   · rien n'est modifié dans la configuration (aucune bascule automatique,
 *     encore moins vers un nouveau modèle) ;
 *   · la passerelle continue d'appliquer la chaîne de repli si le principal
 *     échoue (comportement existant) ;
 *   · une ALERTE D'EXPLOITATION est levée (`ai_alerts`, une par modèle, rang
 *     et jour) ;
 *   · l'anomalie est rendue visible en tête de Configuration IA.
 *
 * `detectActiveModelAnomalies` est PURE (chaînes et contexte injectés).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { Treatment } from '../config/treatments';
import { evaluateModelForTreatment, type UnusableReason, type UsableModelsContext } from '../registry/usable-models';

export type ChainRank = 'primaryModel' | 'fallback1' | 'fallback2';

export interface ActiveChainEntry {
  treatment: Treatment;
  rank: ChainRank;
  model: string;
  /** `version` : version de configuration effective ; `code` : référentiel. */
  source: 'version' | 'code';
}

export interface ActiveModelAnomaly extends ActiveChainEntry {
  reasons: UnusableReason[];
  reasonText: string;
  /** Un repli utilisable existe-t-il plus bas dans la chaîne ? */
  fallbackAvailable: boolean;
}

/**
 * Motifs qui traduisent une PERTE du modèle (et non une préférence de
 * sélection) : seuls ceux-là font une anomalie d'exploitation. « Déprécié »
 * sans date atteinte n'en est pas une (le modèle répond encore — signalé au
 * registre des modèles et par l'alerte de dépréciation existante) ; s'il
 * cesse de répondre, la sonde le rend NOT_OPERATIONAL.
 */
const PERTE: ReadonlySet<UnusableReason> = new Set<UnusableReason>([
  'NOT_LISTED', 'PROVIDER_UNAVAILABLE', 'NO_GENERATE_CONTENT', 'NOT_OPERATIONAL', 'NOT_QUALIFIED',
  'CAPABILITY_MISSING', 'RETIRED', 'FORBIDDEN', 'EXPERIMENTAL',
]);

export const RANK_LABELS: Readonly<Record<ChainRank, string>> = {
  primaryModel: 'principal', fallback1: 'repli 1', fallback2: 'repli 2',
};

/** Anomalies des chaînes actives (pure). */
export function detectActiveModelAnomalies(chains: readonly ActiveChainEntry[], ctx: UsableModelsContext): ActiveModelAnomaly[] {
  const out: ActiveModelAnomaly[] = [];
  const ordre: ChainRank[] = ['primaryModel', 'fallback1', 'fallback2'];
  for (const c of chains) {
    const e = evaluateModelForTreatment(c.treatment, c.model, ctx);
    const pertes = e.reasons.filter((r) => PERTE.has(r));
    if (pertes.length === 0) continue;
    const suivants = chains.filter((x) => x.treatment === c.treatment && ordre.indexOf(x.rank) > ordre.indexOf(c.rank));
    out.push({
      ...c,
      reasons: e.reasons,
      reasonText: e.reasonText,
      fallbackAvailable: suivants.some((x) => evaluateModelForTreatment(x.treatment, x.model, ctx).usable),
    });
  }
  return out;
}

/** Chaînes de la configuration EFFECTIVE (version active, sinon référentiel). Lecture seule. */
export async function loadActiveChains(): Promise<ActiveChainEntry[]> {
  const [{ TREATMENTS, TREATMENT_DEFINITIONS }, { resolveTreatmentConfig }, { listOperationsByUseCase }] = await Promise.all([
    import('../config/treatments'),
    import('../config/config-resolver'),
    import('../registry/operations'),
  ]);
  const out: ActiveChainEntry[] = [];
  for (const t of TREATMENTS) {
    const entry = await resolveTreatmentConfig(t).catch(() => null);
    if (entry?.primaryModel) {
      for (const rank of ['primaryModel', 'fallback1', 'fallback2'] as const) {
        const model = entry[rank];
        if (model) out.push({ treatment: t, rank, model, source: 'version' });
      }
      continue;
    }
    const op = listOperationsByUseCase(TREATMENT_DEFINITIONS[t].useCaseCode).find((o) => o.provider !== 'none' && o.active);
    if (!op) continue;
    const chaine = [op.primaryModel, ...op.fallbackModels].slice(0, 3);
    chaine.forEach((model, i) => {
      if (model) out.push({ treatment: t, rank: (['primaryModel', 'fallback1', 'fallback2'] as const)[i], model, source: 'code' });
    });
  }
  return out;
}

/** Message d'exploitation d'une anomalie (alerte et BO). */
export function anomalyMessage(a: ActiveModelAnomaly): string {
  return `${a.treatment} : le modèle ${RANK_LABELS[a.rank]} « ${a.model} » n’est plus utilisable (${a.reasonText}). `
    + (a.rank === 'primaryModel'
      ? (a.fallbackAvailable ? 'La chaîne de repli prend le relais. ' : 'Aucun repli utilisable : le traitement risque d’échouer. ')
      : '')
    + 'Aucun remplacement automatique : choisissez un autre modèle dans une nouvelle version de configuration.';
}

/** Lève l'alerte d'exploitation existante (`ai_alerts`), une par modèle, rang et jour. */
export async function raiseActiveModelAlerts(anomalies: readonly ActiveModelAnomaly[], now: Date = new Date()): Promise<number> {
  if (anomalies.length === 0) return 0;
  const { raiseAlert } = await import('../alerts/alerts.repository');
  let n = 0;
  for (const a of anomalies) {
    const ok = await raiseAlert({
      kind: 'anomaly',
      code: 'ai_active_model_unavailable',
      treatment: a.treatment,
      severity: a.rank === 'primaryModel' && !a.fallbackAvailable ? 'critical' : 'warning',
      message: anomalyMessage(a),
      details: { model: a.model, rank: a.rank, reasons: a.reasons, source: a.source, fallbackAvailable: a.fallbackAvailable },
      drilldownHref: '/admin/ai-config',
      dedupeKey: `ai:active-model:${a.treatment}:${a.rank}:${a.model}:${now.toISOString().slice(0, 10)}`,
    }).catch(() => false);
    if (ok) n++;
  }
  return n;
}
