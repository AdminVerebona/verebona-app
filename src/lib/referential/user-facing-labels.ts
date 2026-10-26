/**
 * Libellés de référentiel AFFICHÉS à l'utilisateur — jamais un code technique
 * (lot 87D, ticket PO « Supprimer type en anglais / technique sur les
 * documents » : pastille « BUILDING_PERMIT » dans l'en-tête du tiroir).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE UNIQUE
 *
 * Un code de type, de rubrique, de catégorie, de nature ou de rôle (anglais
 * « BUILDING_PERMIT » ou interne « PERMIS_CONSTRUIRE ») n'est JAMAIS rendu à
 * l'utilisateur : il est remplacé par le libellé français du référentiel
 * (Type V2 ENREGISTRÉ — `documentTypeDisplayLabel`, lot 86E), ou MASQUÉ
 * (null) quand aucun libellé n'existe. Le BO peut continuer à montrer les
 * codes. Test statique : `src/__tests__/l87d-codes-techniques-audit.test.ts`.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Module pur (aucun accès base) : importable par les composants.
 */
import { getDocumentType, getRubric } from './v2';

/**
 * Forme d'un code technique : MAJUSCULES_SOULIGNÉES (« BUILDING_PERMIT »,
 * « PERMIS_CONSTRUIRE », « DATA_CONTRACT_END »), ou mot en capitales suivi
 * de chiffres / tirets internes (« DOC-INTERVENTION »).
 */
const TECHNICAL_CODE_RE = /\b[A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)+\b/;

/** Le texte est-il (ou contient-il) un code technique ? Les sigles simples (« DPE », « EDF ») n'en sont pas. */
export function containsTechnicalCode(text: string | null | undefined): boolean {
  if (!text) return false;
  // Les références métier (n° de facture, de contrat : « FA-2026-03 ») portent des chiffres — elles ne sont pas des codes.
  const m = String(text).match(new RegExp(TECHNICAL_CODE_RE.source, 'g')) ?? [];
  return m.some((tok) => /_/.test(tok) || !/\d/.test(tok));
}

/** Libellé français du Type V2 enregistré, ou null (masqué) — jamais le code. */
export function documentTypeLabelOrNull(typeCode: string | null | undefined): string | null {
  return getDocumentType(typeCode)?.label ?? null;
}

/** Libellé français d'une Rubrique, ou null (masquée) — jamais le code. */
export function rubricLabelOrNull(rubricCode: string | null | undefined): string | null {
  return getRubric(rubricCode)?.label ?? null;
}

/**
 * Dernier rempart d'un libellé déjà calculé : rendu tel quel s'il n'est pas un
 * code technique, sinon `fallback` (null par défaut : masqué).
 */
export function userFacingLabel(label: string | null | undefined, fallback: string | null = null): string | null {
  const t = typeof label === 'string' ? label.trim() : '';
  if (!t) return fallback;
  return containsTechnicalCode(t) ? fallback : t;
}
