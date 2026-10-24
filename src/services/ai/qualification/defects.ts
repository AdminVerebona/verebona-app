/**
 * Défauts métier relevés sur une sortie de qualification — lot 86A (CDC
 * Pilotage IA V2 P5 : QUAL-02, QUAL-09, R32 ; décision PO n° 14). PUR.
 *
 * Deux sources d'écarts, toutes deux DÉTERMINISTES (aucune IA ne juge la
 * sortie d'une IA — QUAL-09, R49) :
 *   · les contrôles serveur du corpus des prompts maîtres
 *     (`governance/master-corpus/evaluators.ts`), qui rejouent la traduction
 *     et la validation serveur réelles de la branche contre l'attendu ;
 *   · le comparateur champ par champ des cas de référence T1
 *     (`governance/corpus/corpus-comparator.ts`) : manquant = omission,
 *     différent = valeur incorrecte, présent alors qu'attendu absent =
 *     invention (date = date sans preuve), bien étranger = rattachement erroné.
 *
 * Le CLASSEMENT par catégorie d'un écart d'évaluateur est INDICATIF (affichage
 * et export) : les évaluateurs rendent aujourd'hui des messages libres — la
 * demande à l'équipe IA `l86/demandes-ia/86A-contrats-qualite-operations.md`
 * leur demande une catégorie structurée. Quelle que soit sa catégorie, TOUT
 * écart est une erreur métier confirmée et le seuil est 0 : le classement ne
 * change jamais un verdict.
 */
import type { CaseComparison } from '../governance/corpus/corpus-comparator';
import type { DefectCategory } from './thresholds';

export interface Defect {
  category: DefectCategory;
  /** Message d'origine (évaluateur, comparateur, validation). */
  message: string;
  /** Champ concerné quand il est connu. */
  field?: string | null;
}

/** Ordre de test : la première règle qui correspond l'emporte. */
const RULES: ReadonlyArray<[RegExp, DefectCategory]> = [
  [/(date|échéance|echeance)[^;]*(sans preuve|inventée|non étayée)|sans preuve[^;]*(date|échéance)/i, 'DATE_WITHOUT_PROOF'],
  [/invent|inattendu|non étay|non sourc|sans preuve|hallucin|non attendu/i, 'INVENTION'],
  [/manquant|absent|oubli|omis|omission|non couvert|aucun .* retenu|attendu .* non/i, 'OMISSION'],
  [/rattach|attribu|mauvais bien|fuite|mélange|melange|autre (bien|compte|équipement)/i, 'ATTRIBUTION'],
  [/écras|ecras|modifi[ée] sans|modification injustifi|changement non justifi/i, 'UNJUSTIFIED_CHANGE'],
  [/≠|différent|incorrect|erron|inexact|au lieu de|devrait/i, 'INCORRECT_VALUE'],
];

/** Classe un message d'écart d'évaluateur (indicatif, voir l'en-tête). */
export function classifyEvaluatorMessage(message: string): DefectCategory {
  for (const [re, cat] of RULES) if (re.test(message)) return cat;
  return 'BUSINESS_CHECK';
}

/** Écarts d'un évaluateur du corpus → défauts. */
export function defectsFromEvaluator(errors: readonly string[]): Defect[] {
  return errors.map((message) => ({ category: classifyEvaluatorMessage(message), message }));
}

/** Sortie rejetée par la validation discriminée (schéma, branche) → défaut SCHEMA. */
export function schemaDefect(message: string): Defect {
  return { category: 'SCHEMA', message };
}

/** Comparaison d'un cas de référence T1 → défauts (champ par champ, rattachements, type). */
export function defectsFromComparison(cmp: Pick<CaseComparison, 'fields' | 'leakedAssets' | 'missedAssets' | 'documentTypeCorrect' | 'schemaValid'>): Defect[] {
  const out: Defect[] = [];
  if (!cmp.schemaValid) out.push(schemaDefect('sortie non conforme au schéma'));
  for (const f of cmp.fields) {
    if (f.verdict === 'match') continue;
    const estDate = /date|echeance|échéance/i.test(f.field);
    if (f.verdict === 'missing') out.push({ category: 'OMISSION', field: f.field, message: `${f.field} : attendu ${JSON.stringify(f.expected)}, absent` });
    else if (f.verdict === 'unexpected') {
      out.push({ category: estDate ? 'DATE_WITHOUT_PROOF' : 'INVENTION', field: f.field, message: `${f.field} : renseigné (${JSON.stringify(f.observed)}) alors qu'aucune valeur n'est attendue` });
    } else out.push({ category: 'INCORRECT_VALUE', field: f.field, message: `${f.field} : ${JSON.stringify(f.observed)} ≠ attendu ${JSON.stringify(f.expected)}` });
  }
  for (const a of cmp.leakedAssets) out.push({ category: 'ATTRIBUTION', message: `rattachement à un bien étranger au document : ${a}` });
  for (const a of cmp.missedAssets) out.push({ category: 'OMISSION', message: `bien attendu non rattaché : ${a}` });
  if (cmp.documentTypeCorrect === false) out.push({ category: 'INCORRECT_VALUE', field: 'documentType', message: 'type de document incorrect' });
  return out;
}

/** Comptage par catégorie (toutes présentes, 0 par défaut). */
export function countDefects(defects: readonly Defect[]): Record<DefectCategory, number> {
  const out = { INVENTION: 0, OMISSION: 0, INCORRECT_VALUE: 0, ATTRIBUTION: 0, DATE_WITHOUT_PROOF: 0, UNJUSTIFIED_CHANGE: 0, SCHEMA: 0, BUSINESS_CHECK: 0 } as Record<DefectCategory, number>;
  for (const d of defects) out[d.category] += 1;
  return out;
}
