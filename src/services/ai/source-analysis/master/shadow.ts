/**
 * Mode observation du master T1 — CDC 15 §29 (étape 12), plan § Déploiement,
 * D-18.
 *
 * Le pipeline historique produit et persiste le résultat ; le master est
 * exécuté EN PLUS, avec `shadow: true` (trace écrite, non facturée comme
 * usage, rien appliqué), puis une comparaison résumée est journalisée.
 *
 *   · jamais bloquant : lancé sans être attendu par le pipeline ;
 *   · jamais d'erreur propagée : tout échec est journalisé puis oublié ;
 *   · rien persisté : ni run, ni preuve, ni fait, ni proposition ;
 *   · aucune valeur dans le journal : clés, compteurs et codes seulement
 *     (une immatriculation ou un IBAN n'ont rien à faire dans les logs).
 *
 * ⚠️ Coût : un second appel modèle complet par document observé. D-18 :
 * PRÉPRODUCTION SEULEMENT, sur échantillon (`AI_T1_SHADOW_SAMPLE_RATE`).
 */
import { resolveAlias } from '@/services/canonical/registry';
import { analyseGroupWithMaster, type MasterGroupAnalysis } from './analyse-group-master';
import { emptyTrace } from '../trace';
import type { AnalysisContext, SourceAnalysisResult, SourceInput } from '../types';

export interface T1ShadowComparison {
  leadSourceId: number;
  documentType: { legacy: string | null; master: string | null };
  rubric: { legacy: string | null; master: string | null };
  /** Clés canoniques présentes des deux côtés avec la même valeur. */
  agreeing: string[];
  /** Clés canoniques présentes des deux côtés avec des valeurs différentes (valeurs NON journalisées). */
  valueMismatches: string[];
  /** Clés (canonicalisées) produites par le seul chemin historique. */
  onlyLegacy: string[];
  /** Clés canoniques produites par le seul master. */
  onlyMaster: string[];
  /** Clés historiques sans équivalent canonique (alias libres, T1-01). */
  legacyUnmapped: number;
  masterGeneric: number;
  masterRules: string[];
  masterPurpose: string;
  multiAsset: boolean;
  agenda: { legacy: number; master: number };
}

function norm(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim().toLowerCase();
}

/** Comparaison PURE d'un résultat historique et d'une analyse master projetée. */
export function compareT1Results(legacy: SourceAnalysisResult, master: MasterGroupAnalysis): T1ShadowComparison {
  const legacyByKey = new Map<string, unknown>();
  let legacyUnmapped = 0;
  for (const f of legacy.extractedFields) {
    const key = resolveAlias(f.fieldKey);
    if (!key) { legacyUnmapped++; continue; }
    if (!legacyByKey.has(key)) legacyByKey.set(key, f.normalizedValue ?? f.value);
  }
  const masterByKey = new Map<string, unknown>();
  for (const f of master.facts) {
    if (f.canonicalKey && !masterByKey.has(f.canonicalKey)) masterByKey.set(f.canonicalKey, f.value);
  }

  const agreeing: string[] = [];
  const valueMismatches: string[] = [];
  for (const [k, v] of legacyByKey) {
    if (!masterByKey.has(k)) continue;
    (norm(v) === norm(masterByKey.get(k)) ? agreeing : valueMismatches).push(k);
  }

  return {
    leadSourceId: legacy.sourceGroup.leadSourceId,
    documentType: { legacy: legacy.document.type?.value ?? null, master: master.result.document.type?.value ?? null },
    rubric: {
      legacy: legacy.document.rubric?.documentTypeCode ?? legacy.document.rubric?.rubricCode ?? null,
      master: master.result.document.rubric?.documentTypeCode ?? master.result.document.rubric?.rubricCode ?? null,
    },
    agreeing,
    valueMismatches,
    onlyLegacy: [...legacyByKey.keys()].filter((k) => !masterByKey.has(k)),
    onlyMaster: [...masterByKey.keys()].filter((k) => !legacyByKey.has(k)),
    legacyUnmapped,
    masterGeneric: master.facts.filter((f) => f.canonicalKey === null).length,
    masterRules: master.projection.appliedRules,
    masterPurpose: master.projection.purpose,
    multiAsset: master.projection.multiAsset,
    agenda: { legacy: legacy.agendaCandidates.length, master: master.result.agendaCandidates.length },
  };
}

const enCours = new Set<Promise<void>>();

/** Variable d'environnement du plafond d'observations simultanées. */
export const T1_SHADOW_MAX_CONCURRENCY_ENV = 'AI_T1_SHADOW_MAX_CONCURRENCY';
export const DEFAULT_T1_SHADOW_MAX_CONCURRENCY = 2;

/** Plafond d'observations simultanées (entier ≥ 0 ; illisible → défaut). */
export function t1ShadowMaxConcurrency(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env[T1_SHADOW_MAX_CONCURRENCY_ENV]?.trim());
  return Number.isInteger(n) && n >= 0 && env[T1_SHADOW_MAX_CONCURRENCY_ENV]?.trim() ? n : DEFAULT_T1_SHADOW_MAX_CONCURRENCY;
}

/**
 * Lance l'observation d'un groupe sans l'attendre. Ne lève jamais.
 * Sémaphore : au-delà de `AI_T1_SHADOW_MAX_CONCURRENCY` observations en
 * cours, l'échantillon est SAUTÉ (jamais mis en attente : l'observation ne
 * doit ni s'accumuler ni retarder le traitement réel). Rend `false` alors.
 * `onComparison` (tests, indicateurs) reçoit la comparaison.
 */
export function scheduleT1Shadow(p: {
  input: SourceInput;
  groupIndices: number[];
  ctx: AnalysisContext;
  legacy: SourceAnalysisResult;
  onComparison?: (c: T1ShadowComparison) => void;
}): boolean {
  if (enCours.size >= t1ShadowMaxConcurrency()) {
    console.info(`[t1-shadow] observation sautée pour la source ${p.legacy.sourceGroup.leadSourceId} : ${enCours.size} en cours (plafond atteint).`);
    return false;
  }
  const run = (async () => {
    try {
      const master = await analyseGroupWithMaster(p.input, p.groupIndices, p.ctx, emptyTrace(), { shadow: true });
      const comparison = compareT1Results(p.legacy, master);
      console.info('[t1-shadow] comparaison', JSON.stringify(comparison));
      p.onComparison?.(comparison);
    } catch (e) {
      console.warn(`[t1-shadow] observation impossible pour la source ${p.legacy.sourceGroup.leadSourceId} (non bloquant) :`, (e as Error).message);
    }
  })();
  enCours.add(run);
  void run.finally(() => enCours.delete(run));
  return true;
}

/**
 * Attend les observations en cours (tests, arrêt propre d'un worker). Le
 * worker de file n'expose aujourd'hui aucun point d'arrêt : à y brancher dès
 * qu'il en aura un.
 */
export async function settleT1Shadows(): Promise<void> {
  await Promise.allSettled([...enCours]);
}
