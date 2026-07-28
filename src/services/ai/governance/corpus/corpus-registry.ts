/**
 * Corpus de référence — CDC §11.1.
 *
 * Treize catégories de documents ANONYMISÉS, servant à vérifier qu'une
 * modification de prompt ne dégrade rien.
 *
 * ⚠️ CE CORPUS EST UN LIVRABLE À CONSTITUER (question 2 du document
 * `03-QUESTIONS-RESPONSABLE-METIER.md` — « le recetteur s'en chargera »).
 * Le registre déclare les treize catégories attendues et signale celles qui
 * n'ont pas encore de cas : tant qu'une catégorie est vide, le contrôle du
 * corpus de référence ne peut pas être considéré comme probant.
 */

/** Les treize catégories du §11.1. */
export const CORPUS_CATEGORIES = [
  'acte_immobilier',
  'dpe',
  'facture_multibiens',
  'carte_grise',
  'contrat_loa_lld',
  'avis_echeance',
  'rapport_entretien',
  'garantie',
  'facture_equipement',
  'document_contradictoire',
  'multi_fichiers_meme_document',
  'page_web',
  'document_sans_information',
] as const;

export type CorpusCategory = (typeof CORPUS_CATEGORIES)[number];

export interface CorpusCase {
  caseId: string;
  category: CorpusCategory;
  /** Chemin du fichier anonymisé, relatif au dossier `fixtures`. */
  fixturePath: string;
  /** Résultat attendu, servant de référence de non-régression. */
  expected: {
    documentType?: string;
    fields?: Record<string, unknown>;
    /** Biens auxquels le document doit se rattacher — sert au contrôle de contamination. */
    assetRefs?: string[];
  };
}

export interface CorpusCaseResult {
  caseId: string;
  category: CorpusCategory;
  schemaValid: boolean;
  expectedMatch: boolean;
  documentTypeCorrect: boolean | null;
  /** true si une information a été rattachée à un bien étranger au cas. */
  crossAssetLeak: boolean;
  usedFallback: boolean;
  costMicros: number;
  durationMs: number;
}

export interface CorpusRunResult {
  promptCode: string;
  version: string;
  cases: CorpusCaseResult[];
  criticalFieldsCorrect: number;
  avgCostMicros: number;
  avgDurationMs: number;
}

const cases: CorpusCase[] = [];

export function registerCorpusCase(c: CorpusCase): void {
  cases.push(c);
}

export function listCorpusCases(category?: CorpusCategory): CorpusCase[] {
  return category ? cases.filter((c) => c.category === category) : [...cases];
}

/** Catégories déclarées mais dépourvues de cas — le corpus n'est pas probant. */
export function listEmptyCategories(): CorpusCategory[] {
  return CORPUS_CATEGORIES.filter((cat) => !cases.some((c) => c.category === cat));
}

/**
 * Le corpus est-il exploitable pour une validation ?
 *
 * Répondre `false` n'empêche pas de tester : cela empêche de PRÉTENDRE que la
 * non-régression est vérifiée. Le critère d'acceptation n°22 exige un corpus
 * couvrant, pas seulement l'existence d'un mécanisme de test.
 */
export function isCorpusComplete(): { complete: boolean; missing: CorpusCategory[] } {
  const missing = listEmptyCategories();
  return { complete: missing.length === 0, missing };
}

export function computeRunSummary(
  promptCode: string,
  version: string,
  results: CorpusCaseResult[],
  criticalFieldsCorrect: number,
): CorpusRunResult {
  const n = results.length || 1;
  return {
    promptCode, version, cases: results, criticalFieldsCorrect,
    avgCostMicros: Math.round(results.reduce((s, r) => s + r.costMicros, 0) / n),
    avgDurationMs: Math.round(results.reduce((s, r) => s + r.durationMs, 0) / n),
  };
}
