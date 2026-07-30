/**
 * Comparaison corpus attendu / observé — CDC §11.1, critère d'acceptation n°22.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE MODULE NE FAIT AUCUN APPEL, ET C'EST TOUT L'INTÉRÊT
 *
 * Il prend un résultat attendu et un résultat observé, et rend un verdict.
 * Rien d'autre. Ni modèle, ni base, ni réseau.
 *
 * C'est ce qui permet de vérifier le JUGE avant de l'employer. Un harnais de
 * non-régression dont la comparaison est fausse est pire qu'aucun harnais : il
 * valide des régressions, ou il crie au loup sur des différences sans
 * conséquence — et dans les deux cas, on cesse rapidement de le lire.
 *
 * ── LA TOLÉRANCE EST UNE DÉCISION MÉTIER ──────────────────────────────────
 *
 * Comparer « 78.4 » à « 78,40 m² » par égalité stricte ferait échouer un
 * résultat correct. Comparer « 245000 » à « 254000 » par similarité laisserait
 * passer une inversion de chiffres à neuf mille euros.
 *
 * Chaque type de champ a donc sa règle, écrite ici une fois : les montants et
 * surfaces se comparent numériquement à la tolérance près, les dates au jour,
 * les identifiants — plaque, VIN, numéro de contrat — au caractère près, car
 * une plaque approximative ne désigne aucun véhicule.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CorpusCase, CorpusCaseResult } from './corpus-registry';

/** Ce qu'un moteur d'analyse rend pour un document, réduit au comparable. */
export interface ObservedResult {
  documentType?: string | null;
  fields?: Record<string, unknown>;
  assetRefs?: string[];
  /** Le schéma de sortie a-t-il été respecté ? */
  schemaValid: boolean;
  usedFallback?: boolean;
  costMicros?: number;
  durationMs?: number;
}

/** Champs comparés au caractère près : une valeur approximative ne désigne rien. */
const EXACT_FIELDS = new Set([
  'immatriculation', 'vin', 'numeroSerie', 'numeroContrat', 'numeroAdeme',
  'classeEnergie', 'classeGES', 'regroupementAttendu', 'fluideFrigorigene',
  'marque', 'adresse',
]);

/** Tolérance relative sur les valeurs numériques. */
const NUMERIC_TOLERANCE = 0.005; // 0,5 %

/**
 * Normalise une valeur numérique française.
 *
 * « 78,40 m² », « 1 228,00 € », « 245000 » désignent tous un nombre. Les
 * espaces insécables des montants français et la virgule décimale sont les
 * deux causes d'échec les plus fréquentes d'une comparaison naïve.
 */
export function parseFrenchNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  const cleaned = value
    .replace(/[\u00A0\u202F\s]/g, '')   // espaces, y compris insécables
    .replace(/[€%]|m²|km|kWh|kg/gi, '')
    .replace(',', '.');

  const match = cleaned.match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/** Normalise une date vers `AAAA-MM-JJ`, quelle que soit sa forme d'origine. */
export function normalizeDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'string') return null;

  const iso = value.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const fr = value.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (fr) return `${fr[3]}-${fr[2]}-${fr[1]}`;

  return null;
}

/** Normalise une chaîne pour comparaison : casse, accents, ponctuation. */
export function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export type FieldVerdict = 'match' | 'mismatch' | 'missing' | 'unexpected';

export interface FieldComparison {
  field: string;
  verdict: FieldVerdict;
  expected: unknown;
  observed: unknown;
}

/**
 * Compare un champ attendu à son observation.
 *
 * `null` attendu signifie « ce champ ne doit PAS être renseigné » — le cas de
 * la valeur de rachat d'une LLD. L'observer renseigné est une hallucination,
 * pas une simple différence.
 */
export function compareField(
  field: string,
  expected: unknown,
  observed: unknown,
): FieldVerdict {
  const observedAbsent = observed === undefined || observed === null || observed === '';

  if (expected === null) return observedAbsent ? 'match' : 'unexpected';
  if (observedAbsent) return 'missing';

  if (typeof expected === 'boolean') {
    return expected === Boolean(observed) ? 'match' : 'mismatch';
  }

  if (EXACT_FIELDS.has(field)) {
    return normalizeText(expected) === normalizeText(observed) ? 'match' : 'mismatch';
  }

  if (field.toLowerCase().includes('date') || field.toLowerCase().includes('echeance')) {
    const a = normalizeDate(expected);
    const b = normalizeDate(observed);
    return a !== null && a === b ? 'match' : 'mismatch';
  }

  if (typeof expected === 'number') {
    const value = parseFrenchNumber(observed);
    if (value === null) return 'mismatch';
    // Tolérance relative, avec un plancher absolu pour les petites valeurs :
    // sans lui, 0,64 et 0,65 seraient jugés différents à 1,5 %.
    const tolerance = Math.max(Math.abs(expected) * NUMERIC_TOLERANCE, 0.01);
    return Math.abs(value - expected) <= tolerance ? 'match' : 'mismatch';
  }

  return normalizeText(expected) === normalizeText(observed) ? 'match' : 'mismatch';
}

export interface CaseComparison extends CorpusCaseResult {
  fields: FieldComparison[];
  /** Biens rattachés à tort — la fuite d'information entre biens. */
  leakedAssets: string[];
  /** Biens attendus mais non rattachés. */
  missedAssets: string[];
}

/**
 * Compare un cas complet.
 *
 * ── LE CONTRÔLE DE CONTAMINATION EST ASYMÉTRIQUE ──────────────────────────
 *
 * Un bien attendu mais manquant est une extraction incomplète : gênant.
 * Un bien NON attendu mais présent est une fuite : une information d'un bien
 * s'est retrouvée sur un autre. Le second est bien plus grave — c'est ce que
 * le §4.4 et la question métier n° 6 cherchent à éviter — d'où deux compteurs
 * distincts, et `crossAssetLeak` qui ne porte que sur le second.
 */
export function compareCase(
  corpusCase: CorpusCase,
  observed: ObservedResult,
): CaseComparison {
  const expectedFields = corpusCase.expected.fields ?? {};
  const observedFields = observed.fields ?? {};

  const fields: FieldComparison[] = Object.entries(expectedFields).map(([field, expected]) => ({
    field,
    verdict: compareField(field, expected, observedFields[field]),
    expected,
    observed: observedFields[field] ?? null,
  }));

  const expectedAssets = new Set(corpusCase.expected.assetRefs ?? []);
  const observedAssets = new Set(observed.assetRefs ?? []);

  const leakedAssets = [...observedAssets].filter((a) => !expectedAssets.has(a));
  const missedAssets = [...expectedAssets].filter((a) => !observedAssets.has(a));

  // Un type attendu `undefined` signifie « aucun type ne doit être proposé ».
  // C'est le cas des documents vides : proposer un type y est une invention.
  const documentTypeCorrect =
    corpusCase.expected.documentType === undefined
      ? observed.documentType === undefined || observed.documentType === null
      : normalizeText(corpusCase.expected.documentType) === normalizeText(observed.documentType);

  const allFieldsMatch = fields.every((f) => f.verdict === 'match');

  return {
    caseId: corpusCase.caseId,
    category: corpusCase.category,
    schemaValid: observed.schemaValid,
    expectedMatch: allFieldsMatch && documentTypeCorrect && leakedAssets.length === 0,
    documentTypeCorrect,
    crossAssetLeak: leakedAssets.length > 0,
    usedFallback: observed.usedFallback ?? false,
    costMicros: observed.costMicros ?? 0,
    durationMs: observed.durationMs ?? 0,
    fields,
    leakedAssets,
    missedAssets,
  };
}

export interface CorpusSummary {
  total: number;
  passed: number;
  schemaFailures: number;
  typeErrors: number;
  leaks: number;
  fallbacks: number;
  fieldsCompared: number;
  fieldsCorrect: number;
  totalCostMicros: number;
  avgDurationMs: number;
  byCategory: Array<{ category: string; total: number; passed: number }>;
}

export function summarize(results: CaseComparison[]): CorpusSummary {
  const byCategory = new Map<string, { total: number; passed: number }>();
  let fieldsCompared = 0;
  let fieldsCorrect = 0;

  for (const r of results) {
    const entry = byCategory.get(r.category) ?? { total: 0, passed: 0 };
    entry.total += 1;
    if (r.expectedMatch) entry.passed += 1;
    byCategory.set(r.category, entry);

    fieldsCompared += r.fields.length;
    fieldsCorrect += r.fields.filter((f) => f.verdict === 'match').length;
  }

  return {
    total: results.length,
    passed: results.filter((r) => r.expectedMatch).length,
    schemaFailures: results.filter((r) => !r.schemaValid).length,
    typeErrors: results.filter((r) => r.documentTypeCorrect === false).length,
    leaks: results.filter((r) => r.crossAssetLeak).length,
    fallbacks: results.filter((r) => r.usedFallback).length,
    fieldsCompared,
    fieldsCorrect,
    totalCostMicros: results.reduce((s, r) => s + r.costMicros, 0),
    avgDurationMs: results.length
      ? Math.round(results.reduce((s, r) => s + r.durationMs, 0) / results.length)
      : 0,
    byCategory: [...byCategory.entries()].map(([category, v]) => ({ category, ...v })),
  };
}

/**
 * Compare deux exécutions — c'est la fonction qui répond à la seule question
 * qui compte avant une bascule : est-ce que ça s'améliore ou se dégrade ?
 */
export interface Regression {
  caseId: string;
  kind: 'lost' | 'gained' | 'new_leak' | 'leak_fixed';
  detail: string;
}

export function detectRegressions(
  before: CaseComparison[],
  after: CaseComparison[],
): Regression[] {
  const beforeById = new Map(before.map((r) => [r.caseId, r]));
  const regressions: Regression[] = [];

  for (const now of after) {
    const then = beforeById.get(now.caseId);
    if (!then) continue;

    if (then.expectedMatch && !now.expectedMatch) {
      regressions.push({
        caseId: now.caseId,
        kind: 'lost',
        detail: `Cas conforme avant, non conforme après (${
          now.fields.filter((f) => f.verdict !== 'match').map((f) => f.field).join(', ') || 'type'
        }).`,
      });
    } else if (!then.expectedMatch && now.expectedMatch) {
      regressions.push({ caseId: now.caseId, kind: 'gained', detail: 'Cas devenu conforme.' });
    }

    if (!then.crossAssetLeak && now.crossAssetLeak) {
      regressions.push({
        caseId: now.caseId,
        kind: 'new_leak',
        detail: `Fuite vers ${now.leakedAssets.join(', ')}.`,
      });
    } else if (then.crossAssetLeak && !now.crossAssetLeak) {
      regressions.push({ caseId: now.caseId, kind: 'leak_fixed', detail: 'Fuite corrigée.' });
    }
  }

  return regressions;
}
