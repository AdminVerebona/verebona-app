/**
 * NATURE d'un document dans l'Assistant — passage 114AB (Trello #753,
 * CDC T2 §14.3 W12, §14.4 « Documents ») : module PUR.
 *
 * La « nature » d'un document, en V2, ce sont DEUX valeurs du référentiel
 * (`lib/referential/v2`) : sa **Rubrique** (le domaine : « Assurances et
 * sinistres ») et son **Type** (la nature du papier : « Facture »). Ce module
 * ne lit rien, n'écrit rien et n'énumère aucune valeur : il traduit ce que
 * l'utilisateur écrit en une valeur du référentiel, et rend les listes à lui
 * proposer quand sa demande ne désigne rien.
 *
 * Les règles de classement (Rubrique déduite d'un Type, Type vidé quand il ne
 * relève pas de la Rubrique, protection d'une valeur de l'utilisateur) ne sont
 * PAS reprises ici : l'aperçu les applique en appelant la fonction pure
 * existante `applyClassificationChange` — celle-là même que la façade
 * d'écriture appelle. Ce qui est annoncé est donc exactement ce qui sera écrit.
 */
import {
  DOCUMENT_TYPES, RUBRICS, documentTypeDisplayLabel, getRubric,
  type DocumentTypeDefinition, type RubricCode, type RubricDefinition,
} from '@/lib/referential/v2';
import { plain } from '../core/routing-text';

/** Niveau visé par la demande : la Rubrique, ou le Type. */
export type ClassificationLevel = 'rubric' | 'type';

/** Libellés repris de la V2 et du tiroir du document (rien de nouveau à valider). */
export const CLASSIFICATION_LABELS: Readonly<Record<ClassificationLevel, { label: string; article: string }>> = {
  rubric: { label: 'Rubrique', article: 'la rubrique' },
  type: { label: 'Type', article: 'le type' },
};

const mots = (s: string): string[] => plain(s).split(/[^a-z0-9]+/).filter(Boolean);
const aplati = (s: string): string => mots(s).join(' ');

/** Rubriques du référentiel, dans l'ordre d'affichage (la Rubrique de dernier recours en dernier). */
export function rubricChoices(): RubricDefinition[] {
  return [...RUBRICS].sort((a, b) => Number(a.fallback ?? false) - Number(b.fallback ?? false) || a.displayOrder - b.displayOrder);
}

/** Types proposés pour une Rubrique (y compris les Types réutilisables qui y sont déclarés), par libellé. */
export function typeChoicesForRubric(rubric: RubricCode | null): DocumentTypeDefinition[] {
  const dans = (t: DocumentTypeDefinition): boolean =>
    rubric === null || t.rubric === rubric || (t.alsoIn ?? []).includes(rubric);
  return DOCUMENT_TYPES.filter(dans).slice().sort((a, b) => a.label.localeCompare(b.label, 'fr'));
}

/**
 * Valeur du référentiel désignée par le texte de l'utilisateur (pure).
 *
 *   `found`     : une seule valeur répond — son code ;
 *   `ambiguous` : plusieurs (le libellé « Autre » existe dans chaque Rubrique) ;
 *   `unknown`   : aucune — la question liste les valeurs possibles.
 *
 * Jamais un rapprochement approximatif : le libellé entier d'abord, puis, à
 * défaut, les libellés dont TOUS les mots demandés font partie.
 */
export type ReferentialMatch<T> =
  | { kind: 'found'; value: T }
  | { kind: 'ambiguous'; values: T[] }
  | { kind: 'unknown' };

function match<T>(candidats: readonly T[], libelle: (v: T) => string, texte: string): ReferentialMatch<T> {
  const demande = aplati(texte);
  if (!demande) return { kind: 'unknown' };
  const exacts = candidats.filter((c) => aplati(libelle(c)) === demande);
  if (exacts.length === 1) return { kind: 'found', value: exacts[0] };
  if (exacts.length > 1) return { kind: 'ambiguous', values: exacts };
  const demandes = mots(texte);
  const partiels = candidats.filter((c) => {
    const l = mots(libelle(c));
    return demandes.every((w) => l.includes(w));
  });
  if (partiels.length === 1) return { kind: 'found', value: partiels[0] };
  if (partiels.length > 1) return { kind: 'ambiguous', values: partiels };
  return { kind: 'unknown' };
}

/** Rubrique désignée par le texte (pure, testée). */
export function matchRubric(texte: string): ReferentialMatch<RubricDefinition> {
  return match(rubricChoices(), (r) => r.label, texte);
}

/**
 * Type désigné par le texte, cherché d'abord parmi les Types de la Rubrique en
 * place (le « Autre » visé est alors le sien), puis dans tout le référentiel.
 */
export function matchDocumentType(texte: string, rubric: RubricCode | null): ReferentialMatch<DocumentTypeDefinition> {
  if (rubric) {
    const dansLaRubrique = match(typeChoicesForRubric(rubric), (t) => t.label, texte);
    if (dansLaRubrique.kind !== 'unknown') return dansLaRubrique;
  }
  return match(typeChoicesForRubric(null), (t) => t.label, texte);
}

/** « Propriété et gestion, Équipements et mobilier, … » — pour demander une Rubrique. */
export const rubricList = (): string => rubricChoices().map((r) => r.label).join(', ');

/** « Facture, Devis, … » — pour demander un Type (ceux de la Rubrique en place quand elle est connue). */
export const typeList = (rubric: RubricCode | null, max = 12): string => {
  const tous = typeChoicesForRubric(rubric);
  const noms = [...new Set(tous.map((t) => t.label))];
  return noms.length > max ? `${noms.slice(0, max).join(', ')}…` : noms.join(', ');
};

/** Libellé affiché d'une Rubrique enregistrée, ou « Sans rubrique » (jamais le code). */
export const rubricLabelOf = (code: string | null): string => (code ? getRubric(code)?.label ?? 'Sans rubrique' : 'Sans rubrique');

/** Libellé affiché d'un Type enregistré, ou « non précisé » (jamais le code). */
export const typeLabelOf = (code: string | null): string => (code ? documentTypeDisplayLabel(code) : 'non précisé');

/** Plusieurs valeurs répondent : « « Autre » (Assurances et sinistres), « Autre » (Médias) ». */
export const ambiguousList = (valeurs: ReadonlyArray<{ label: string; rubric?: RubricCode }>): string =>
  valeurs.slice(0, 5).map((v) => (v.rubric ? `« ${v.label} » (${rubricLabelOf(v.rubric)})` : `« ${v.label} »`)).join(', ');
