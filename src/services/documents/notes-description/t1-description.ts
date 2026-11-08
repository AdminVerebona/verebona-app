/**
 * Description T1 d'un document : écriture, provenance et constat — lot 113Z
 * (Trello #723, §3.B). Module PUR (aucun accès base).
 *
 * Chaîne contrôlée : sortie T1 (`document.description`) → validation tolérante
 * → extraction (`document_extractions.description`) → `asset_files.description`.
 * Chaque analyse pose UN constat (`asset_files.description_t1_status`) :
 *   PRODUCED              T1 a produit une description, écrite (provenance T1) ;
 *   ABSENT                T1 n'en a pas produit (source insuffisante, abstention) ;
 *   REMOVED_AT_VALIDATION produite mais retirée par la validation du contrat ;
 *   PERSIST_FAILED        produite mais l'écriture a échoué ;
 *   KEPT_UNKNOWN_ORIGIN   produite, mais la description en place est d'origine
 *                         INCONNUE (saisie historique possible) : conservée
 *                         telle quelle, la sortie T1 reste dans l'extraction ;
 *   KEPT_USER_LOCKED      produite, mais la description est marquée corrigée
 *                         par l'utilisateur (`user_edited_fields.description`) ;
 *   RECOVERED             reprise de l'historique depuis l'extraction persistée
 *                         (contrôle COH-DOC-DESCRIPTION-T1, sans IA).
 * Jamais d'effacement : une analyse sans description ne vide pas la colonne.
 * La note de l'utilisateur (`notes`) n'est jamais concernée.
 */
import { normalizeNotesText, type DescriptionT1Status } from '@/lib/documents/notes-description';

export interface T1DescriptionInput {
  /** Description produite par T1 (après validation), null si absente. */
  produced: string | null | undefined;
  /** La validation a retiré une description produite (chemin `document.description`). */
  removedAtValidation?: boolean;
  /** `asset_files.description` actuelle. */
  current: string | null | undefined;
  /** `asset_files.description_source` actuelle ('T1' = établie). */
  currentSource: string | null | undefined;
  /** `document_extractions.description` AVANT cette analyse (sortie T1 persistée précédente). */
  previousExtraction: string | null | undefined;
  /** `user_edited_fields.description === true`. */
  userLocked: boolean;
}

export interface T1DescriptionDecision {
  write: boolean;
  status: DescriptionT1Status;
  /** Provenance T1 établie à poser (écriture, ou égalité prouvée avec une sortie T1). */
  setSourceT1: boolean;
}

const egal = (a: string | null | undefined, b: string | null | undefined) => {
  const x = normalizeNotesText(a), y = normalizeNotesText(b);
  return x.length > 0 && x === y;
};

/** Décision d'écriture de la description T1 (pure). */
export function decideT1Description(p: T1DescriptionInput): T1DescriptionDecision {
  const produite = normalizeNotesText(p.produced);
  if (!produite) {
    return { write: false, status: p.removedAtValidation ? 'REMOVED_AT_VALIDATION' : 'ABSENT', setSourceT1: false };
  }
  if (p.userLocked) return { write: false, status: 'KEPT_USER_LOCKED', setSourceT1: false };
  const actuelle = normalizeNotesText(p.current);
  if (!actuelle || p.currentSource === 'T1') return { write: true, status: 'PRODUCED', setSourceT1: true };
  // Description en place identique à une sortie T1 persistée (précédente ou
  // actuelle) : sa provenance T1 est PROUVÉE, elle peut être mise à jour.
  if (egal(actuelle, p.previousExtraction) || egal(actuelle, produite)) return { write: true, status: 'PRODUCED', setSourceT1: true };
  return { write: false, status: 'KEPT_UNKNOWN_ORIGIN', setSourceT1: false };
}

/**
 * La validation de la sortie T1 a-t-elle retiré la description ? Lue dans les
 * éléments non résolus de la couche source (originaux REMOVED / FIELD_PRUNED
 * du chemin `document.description`). Pure.
 */
export function descriptionRemovedAtValidation(
  unresolved: ReadonlyArray<{ rawKey?: string | null; detail?: string | null; status?: string | null; originalPayload?: unknown }> | null | undefined,
): boolean {
  return (unresolved ?? []).some((u) => {
    if (u.status === 'RETAINED') return false; // valeur réduite, conservée
    const chemin = [u.rawKey, u.detail, (u.originalPayload as { path?: unknown } | null)?.path]
      .filter((x): x is string => typeof x === 'string').join(' ');
    return /(^|[^\w])document\.description\b/.test(chemin);
  });
}

/** Reprise de l'historique (sans IA) : description vide, extraction T1 disponible, non verrouillée. Pure. */
export function recoverableFromExtraction(p: { current: string | null | undefined; extraction: string | null | undefined; userLocked: boolean }): boolean {
  return !p.userLocked && !normalizeNotesText(p.current) && !!normalizeNotesText(p.extraction);
}

/** Provenance T1 prouvable a posteriori : description identique à l'extraction T1 persistée. Pure. */
export function provenanceProvable(p: { current: string | null | undefined; currentSource: string | null | undefined; extraction: string | null | undefined }): boolean {
  // Égalité stricte (bords retirés) : même règle que la réparation SQL (`btrim`).
  const c = typeof p.current === 'string' ? p.current.trim() : '';
  return p.currentSource !== 'T1' && c.length > 0 && c === (typeof p.extraction === 'string' ? p.extraction.trim() : '');
}

// ── Diagnostic de la chaîne (BO, recette #723 §4) ─────────────────────────

export type DescriptionChainVerdict =
  | 'NO_ANALYSIS' | 'NOT_GENERATED' | 'REMOVED_AT_VALIDATION' | 'PERSIST_FAILED'
  | 'KEPT_UNKNOWN_ORIGIN' | 'KEPT_USER_LOCKED' | 'OVERWRITTEN_AFTER_T1' | 'MISSING_UNDETERMINED' | 'CONSISTENT';

export interface DescriptionChainInput {
  /** Un run T1 de référence existe. */
  runExists: boolean;
  /** `document.description.value` de la sortie T1 de référence (run). */
  runDescription: string | null;
  /** Élément non résolu « document.description » (retrait à la validation). */
  removedAtValidation: boolean;
  extraction: string | null;
  current: string | null;
  t1Status: string | null;
  userLocked: boolean;
}

/** Libellés BO des verdicts (diagnostic technique, back-office seulement). */
export const DESCRIPTION_CHAIN_LABELS: Readonly<Record<DescriptionChainVerdict, string>> = {
  NO_ANALYSIS: 'Aucune analyse T1 de référence : aucune description ne peut venir de T1.',
  NOT_GENERATED: 'T1 n’a produit aucune description (absence de génération).',
  REMOVED_AT_VALIDATION: 'T1 a produit une description, retirée par la validation du contrat (filtrage / normalisation).',
  PERSIST_FAILED: 'T1 a produit une description qui n’a pas été enregistrée (défaut de persistance).',
  KEPT_UNKNOWN_ORIGIN: 'Description en place d’origine inconnue, conservée : la description T1 est restée dans l’extraction.',
  KEPT_USER_LOCKED: 'Description marquée corrigée par l’utilisateur : T1 ne l’a pas remplacée.',
  OVERWRITTEN_AFTER_T1: 'Description enregistrée puis remplacée ou vidée après l’analyse T1 (écriture postérieure).',
  MISSING_UNDETERMINED: 'T1 a produit une description, absente en base ; aucune trace antérieure au lot 113Z ne permet de distinguer un défaut de persistance d’un effacement postérieur (cause non prouvée).',
  CONSISTENT: 'Description enregistrée identique à la sortie T1 (chaîne cohérente).',
};

/** Cause PROUVÉE par les données persistées (pure) — jamais une supposition. */
export function diagnoseDescriptionChain(p: DescriptionChainInput): DescriptionChainVerdict {
  // Dernier constat = échec d'écriture : la transaction de l'analyse a été
  // annulée (run compris) — la trace hors transaction en est la preuve.
  if (p.t1Status === 'PERSIST_FAILED') return 'PERSIST_FAILED';
  if (!p.runExists) return 'NO_ANALYSIS';
  const run = normalizeNotesText(p.runDescription);
  const cur = normalizeNotesText(p.current);
  const ext = normalizeNotesText(p.extraction);
  if (!run) {
    if (p.removedAtValidation || p.t1Status === 'REMOVED_AT_VALIDATION') return 'REMOVED_AT_VALIDATION';
    return 'NOT_GENERATED';
  }
  if (cur && (cur === run || cur === ext)) return 'CONSISTENT';
  if (p.userLocked || p.t1Status === 'KEPT_USER_LOCKED') return 'KEPT_USER_LOCKED';
  if (p.t1Status === 'KEPT_UNKNOWN_ORIGIN') return 'KEPT_UNKNOWN_ORIGIN';
  if (!cur) {
    if (p.t1Status === 'PERSIST_FAILED') return 'PERSIST_FAILED';
    if (p.t1Status === 'PRODUCED' || p.t1Status === 'RECOVERED') return 'OVERWRITTEN_AFTER_T1';
    return 'MISSING_UNDETERMINED';
  }
  return 'OVERWRITTEN_AFTER_T1';
}

/** `document.description.value` d'une sortie T1 persistée (`raw_response_json`), null sinon. Pure. */
export function runDescriptionOf(raw: unknown): string | null {
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return null; } }
  const v = (o as { document?: { description?: { value?: unknown } } } | null)?.document?.description?.value;
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * Marqueur du bloc FACULTATIF de l'étape 27 du guide des prompts (description
 * courte, factuelle, spécifique). Aucun code ne le lit : le code reste correct
 * sans ce bloc (description facultative, abstention tracée).
 */
export const T1_DOCUMENT_DESCRIPTION_CONTRACT = 't1-document-description-v1';
