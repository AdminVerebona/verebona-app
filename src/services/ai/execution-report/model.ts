/**
 * Rapport d'exécution T1 / T3 — lot 58C (ticket « [P1] BO — Reporting
 * exhaustif des exécutions T1 et T3 »). Partie PURE (aucun accès base).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PRINCIPES
 *
 *  · Fondé sur les écritures CONFIRMÉES : une ligne `WRITTEN` vient d'une
 *    relecture en base (ou d'un RETURNING / du résultat de la primitive
 *    d'écriture), jamais de la seule réponse du modèle ni d'une intention.
 *    Une décision d'écriture non confirmée est `DECIDED_NOT_CONFIRMED`.
 *  · Instantané immuable : écrit à la fin de l'exécution, jamais mis à jour.
 *    Une réanalyse écrit un nouveau rapport ; l'ancien reste consultable.
 *  · Volume maîtrisé : la valeur écrite est copiée quand elle est courte ;
 *    un contenu long (texte intégral, contenu d'unité, JSON volumineux) est
 *    RÉFÉRENCÉ (table, enregistrement, colonne, SHA-256, longueur) et relu en
 *    direct tant que l'enregistrement porte la même empreinte — sinon « non
 *    tracé », jamais une valeur supposée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';

/** Résultat RÉEL d'une écriture, tel que constaté en base. */
export type WriteResult =
  /** Écriture confirmée (relecture / RETURNING / journal transactionnel). */
  | 'WRITTEN'
  /** Donnée produite par l'analyse mais absente de la base (motif obligatoire). */
  | 'NOT_PERSISTED'
  /** Écriture tentée, en erreur (motif obligatoire). */
  | 'FAILED'
  /** Examiné, volontairement non écrit (motif normalisé obligatoire). */
  | 'NOT_WRITTEN'
  /** Décision d'écriture prise, écriture non confirmée en base. */
  | 'DECIDED_NOT_CONFIRMED'
  /** Donnée pertinente non examinée par ce passage (motif obligatoire). */
  | 'NOT_EXAMINED'
  /** Valeur en place relue, sans pouvoir l'attribuer à ce passage (jamais présentée comme écrite). */
  | 'OBSERVED';

export const WRITE_RESULT_LABEL: Record<WriteResult, string> = {
  WRITTEN: 'Écrit (confirmé en base)',
  NOT_PERSISTED: 'Non enregistré',
  FAILED: 'Écriture en échec',
  NOT_WRITTEN: 'Examiné, non modifié',
  DECIDED_NOT_CONFIRMED: 'Décidé, écriture non confirmée',
  NOT_EXAMINED: 'Non examiné',
  OBSERVED: 'Valeur en place relue',
};

/** Statut métier d'un rapport (constaté en base). */
export type ReportStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'NO_CHANGE';

export interface ReportStep {
  step: string;
  status: 'OK' | 'FAILED' | 'SKIPPED';
  error?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface ReportEntry {
  section: string;
  tableName?: string | null;
  recordId?: string | number | null;
  columnPath?: string | null;
  fieldKey?: string | null;
  label?: string | null;
  entityType?: string | null;
  entityId?: number | null;
  oldValue?: unknown;
  value?: unknown;
  valueType?: string | null;
  /** Contenu long référencé (valeur non recopiée). */
  ref?: { sha256: string; chars: number } | null;
  recordStatus?: string | null;
  writeResult: WriteResult;
  reasonCode?: string | null;
  reason?: string | null;
  links?: Record<string, unknown> | null;
}

export interface ReportHeader {
  accountId: number;
  /** Lot 60 : T6 (décision d'interpellation de l'accueil, migration 0432). */
  treatment: 'T1' | 'T3' | 'T6';
  /** Lot 61 : DOCUMENT_NAMING — harmonisation documentaire du passage T3 du compte. */
  scope: 'DOCUMENT' | 'ASSET' | 'EQUIPMENT' | 'ROOM' | 'HOME' | 'DOCUMENT_NAMING';
  jobId?: number | null;
  jobAttempt?: number | null;
  traceIds?: string[];
  fileId?: number | null;
  assetId?: number | null;
  targetType?: string | null;
  targetId?: number | null;
  analysisRunId?: number | null;
  extractionId?: number | null;
  reconciliationRunId?: number | null;
  accountRunId?: number | null;
  triggerCode?: string | null;
  originT1ReportId?: number | null;
  status: ReportStatus;
  counters: Record<string, number>;
  steps: ReportStep[];
  sources?: Record<string, unknown>;
  startedAt?: Date | null;
}

/** Au-delà, une chaîne est référencée et non recopiée. */
export const INLINE_TEXT_MAX = 2_000;
/** Au-delà, un JSON est référencé et non recopié. */
export const INLINE_JSON_MAX = 8_000;

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Sérialisation stable d'une valeur relue en base (empreinte de référence). */
export function serializeForHash(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v ?? null);
}

/**
 * Valeur courte recopiée, valeur longue référencée (pure). La même
 * sérialisation sert à la relecture en direct (`resolveRef`).
 */
export function valueOrRef(v: unknown): { value: unknown; ref: { sha256: string; chars: number } | null } {
  if (v === null || v === undefined) return { value: null, ref: null };
  const s = serializeForHash(v);
  const max = typeof v === 'string' ? INLINE_TEXT_MAX : INLINE_JSON_MAX;
  if (s.length <= max) return { value: v, ref: null };
  return { value: null, ref: { sha256: sha256(s), chars: s.length } };
}

/** Type de donnée affiché (pur). */
export function valueTypeOf(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  return typeof v;
}

// ── T1 : motifs de non-projection d'un fait sur une fiche ───────────────────

export const T1_PROJECTION_REASON: Record<string, string> = {
  GENERIC_KNOWLEDGE: 'Fait générique (sans clé canonique) : conservé dans document_facts, aucun champ de fiche alimenté',
  UNKNOWN_CANONICAL_KEY: 'Clé annoncée canonique absente du registre : aucun champ alimenté',
  INPUT_ONLY_FIELD: 'Champ de saisie seule : jamais alimenté par un document',
  NON_ENTITY_TARGET: 'Cible document / fournisseur / générique : pas un champ de bien',
  UNATTACHED: 'Aucun bien cible vérifié : preuve non projetée sur une fiche (fait conservé)',
  TARGET_NOT_FOUND: 'Cible annoncée introuvable dans le compte',
  NO_EVIDENCE: 'Ni extrait littéral ni preuve visuelle : non projeté',
  SCHEMA_NOT_READY: 'Migration manquante pour cette cible',
  WRITE_FAILED: 'Écriture de la preuve en échec',
  CAPABILITY_FORBIDDEN: 'Cible pièce / équipement hors capacités du compte',
};

// ── T3 : motif NORMALISÉ d'un champ examiné non modifié ─────────────────────

export type T3NotWrittenReason =
  | 'NO_EXPLOITABLE_INFO'
  | 'EXTRACTED_NOT_RETAINED'
  | 'SAME_VALUE'
  | 'SOURCE_CONFLICT'
  | 'USER_VALUE_PROTECTED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'WRITE_REFUSED_OR_FAILED';

export const T3_NOT_WRITTEN_LABEL: Record<T3NotWrittenReason, string> = {
  NO_EXPLOITABLE_INFO: 'Aucune information exploitable trouvée',
  EXTRACTED_NOT_RETAINED: 'Information extraite mais non retenue',
  SAME_VALUE: 'Valeur identique déjà présente',
  SOURCE_CONFLICT: 'Conflit entre plusieurs sources',
  USER_VALUE_PROTECTED: 'Valeur utilisateur protégée',
  INSUFFICIENT_EVIDENCE: 'Preuve insuffisante',
  WRITE_REFUSED_OR_FAILED: 'Écriture refusée ou échouée',
};

/** Motif de décision (catalogue `reason-codes`) → motif normalisé du rapport (pur). */
const REASON_TO_NORMALIZED: Record<string, T3NotWrittenReason> = {
  NO_EVIDENCE: 'NO_EXPLOITABLE_INFO',
  UNNORMALIZABLE_VALUE: 'EXTRACTED_NOT_RETAINED',
  WEAKER_EVIDENCE: 'EXTRACTED_NOT_RETAINED',
  ALREADY_DECIDED: 'EXTRACTED_NOT_RETAINED',
  IDENTICAL_VALUE: 'SAME_VALUE',
  AUTO_VALUE_CONFIRMED: 'SAME_VALUE',
  MANUAL_VALUE_CONFIRMED: 'SAME_VALUE',
  EQUAL_AUTHORITY_DIVERGENCE: 'SOURCE_CONFLICT',
  NO_AUTHORITY_RULE: 'SOURCE_CONFLICT',
  AMBIGUOUS_EVIDENCE: 'SOURCE_CONFLICT',
  PROBABLE_LINK: 'SOURCE_CONFLICT',
  MANUAL_VALUE_CONTRADICTED: 'USER_VALUE_PROTECTED',
  MANUAL_LINK_CONTRADICTED: 'USER_VALUE_PROTECTED',
  CRITICAL_FIELD_INSUFFICIENT_PROOF: 'INSUFFICIENT_EVIDENCE',
  // Lot 76J (T3 complétude).
  CONFIRMED_AGENDA_CONTRADICTION: 'SOURCE_CONFLICT',
  FREE_TEXT_PROTECTED: 'USER_VALUE_PROTECTED',
  // Lot 81A : proposition équivalente à la valeur en place — aucun arbitrage.
  EQUIVALENT_VALUES: 'SAME_VALUE',
};

/** Résultat de la primitive d'écriture → motif normalisé quand rien n'est écrit (pur). */
const OUTCOME_TO_NORMALIZED: Record<string, T3NotWrittenReason> = {
  unchanged: 'SAME_VALUE',
  protected: 'USER_VALUE_PROTECTED',
  conflict: 'WRITE_REFUSED_OR_FAILED',
  invalid: 'WRITE_REFUSED_OR_FAILED',
  skipped: 'WRITE_REFUSED_OR_FAILED',
};

/**
 * Motif normalisé d'un champ examiné NON modifié (pur). `outcome` : résultat
 * de l'écriture quand une décision d'écriture a été prise.
 */
export function normalizeT3Reason(p: {
  action: string; reasonCode: string; outcome?: string | null; error?: string | null; candidateCount: number;
}): T3NotWrittenReason {
  if (p.error) return 'WRITE_REFUSED_OR_FAILED';
  if (p.action === 'apply' || p.action === 'update') return OUTCOME_TO_NORMALIZED[p.outcome ?? 'skipped'] ?? 'WRITE_REFUSED_OR_FAILED';
  if (p.action === 'create_conflict') return REASON_TO_NORMALIZED[p.reasonCode] ?? 'SOURCE_CONFLICT';
  if (p.action === 'request_ai_review') return 'INSUFFICIENT_EVIDENCE';
  const mapped = REASON_TO_NORMALIZED[p.reasonCode];
  if (mapped) return mapped;
  return p.candidateCount === 0 ? 'NO_EXPLOITABLE_INFO' : 'EXTRACTED_NOT_RETAINED';
}

/** Statut d'un rapport à partir de ses lignes et de ses étapes (pur). */
export function reportStatus(p: { failed: boolean; entries: Pick<ReportEntry, 'writeResult'>[]; steps: ReportStep[]; treatment: 'T1' | 'T3' }): ReportStatus {
  if (p.failed) return 'FAILED';
  const anomalie = p.steps.some((s) => s.status === 'FAILED')
    || p.entries.some((e) => e.writeResult === 'FAILED' || e.writeResult === 'NOT_PERSISTED' || e.writeResult === 'DECIDED_NOT_CONFIRMED');
  if (anomalie) return 'PARTIAL';
  if (p.treatment === 'T3' && !p.entries.some((e) => e.writeResult === 'WRITTEN')) return 'NO_CHANGE';
  return 'SUCCESS';
}

/**
 * Empreinte des lignes (pure) : deux passages T3 strictement identiques (même
 * examen, mêmes décisions, aucune écriture) partagent les lignes du premier —
 * le second rapport ne recopie rien (volume des balayages planifiés).
 */
export function entriesFingerprint(entries: ReportEntry[]): string {
  return sha256(JSON.stringify(entries));
}

/** Clés de multiensemble pour rapprocher déclaré ↔ persisté (pure). */
export function factMatchKey(f: { factKey: string | null; valueText: string | null; valueNumber: number | string | null }): string {
  const v = f.valueText ?? (f.valueNumber == null ? '' : String(Number(f.valueNumber)));
  return `${f.factKey ?? ''}|${v}`;
}

/**
 * Faits déclarés (réponse IA structurée par le code) absents de la base
 * (pur) : rapprochement en multiensemble par clé et valeur.
 */
export function unmatchedDeclared<T>(declared: T[], persistedKeys: string[], keyOf: (d: T) => string): T[] {
  const restant = new Map<string, number>();
  for (const k of persistedKeys) restant.set(k, (restant.get(k) ?? 0) + 1);
  const out: T[] = [];
  for (const d of declared) {
    const k = keyOf(d);
    const n = restant.get(k) ?? 0;
    if (n > 0) restant.set(k, n - 1);
    else out.push(d);
  }
  return out;
}

/** Message d'erreur borné, sans pile ni secret (pur). */
export function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/postgres(ql)?:\/\/[^\s]+/gi, '[url masquée]').slice(0, 500);
}
