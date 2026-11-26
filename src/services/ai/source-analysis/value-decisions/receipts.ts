/**
 * Carte #854 (P1-02 de #835, R3 / R4) — JOURNAL DES RÉCEPTIONS DE DÉCISIONS
 * DE VALEUR d'une réparation différée (`document_value_decision_receipts`,
 * migration 2012).
 *
 * Chaque décision REÇUE d'un appel T1 (y compris mal formée, hors zone ou
 * produite sous un contrat absent) a une ligne, d'identité stable
 * (`receipt_key` = passe + appel + rang), écrite AVANT la validation
 * (manifeste, `PENDING`) puis finalisée dans la MÊME transaction que les
 * décisions (issue, motif, lien à la ligne persistée), et enfin marquée
 * `CONFIRMED` / `MISSING` / `DIVERGENT` / `UNCONFIRMED` après relecture
 * EXACTE. Un manifeste resté `PENDING` (crash), une issue technique
 * réessayable (`NOT_EVALUATED`) ou une écriture non confirmée est repris par
 * la passe suivante SANS nouvel appel IA (`payload` : décision et faits cités),
 * dans la limite de `RECEIPT_RECOVERY_MAX` reprises (jamais de boucle).
 *
 * Aucun prompt, aucune donnée d'un autre compte ; la valeur et le motif sont
 * bornés comme dans `document_value_decisions`.
 */
import { createHash } from 'crypto';

type Sql = { unsafe: (q: string, p?: never[]) => Promise<unknown> };

/** Reprises sans IA d'une réception au plus (au-delà : `RECOVERY_EXHAUSTED`, état final explicite). */
export const RECEIPT_RECOVERY_MAX = 3;

export type ReceiptOutcome = 'PENDING' | 'VALID' | 'INVALID' | 'REJECTED' | 'NOT_EVALUATED';
export type ReceiptWriteState = 'PENDING' | 'NEW' | 'ALREADY_PRESENT' | 'CONFIRMED' | 'MISSING' | 'DIVERGENT' | 'UNCONFIRMED' | 'NOT_APPLICABLE';

/** Identité stable de réception (pure). */
export function receiptKeyOf(passId: string, callIndex: number, ordinal: number): string {
  return createHash('sha256').update(`${passId}|${callIndex}|${ordinal}`).digest('hex').slice(0, 32);
}

/** Ligne du manifeste (écrite avant toute validation). */
export interface ReceiptManifestRow {
  receiptKey: string;
  callIndex: number;
  callRef: string | null;
  ordinal: number;
  contractState: string;
  contractVersion: string | null;
  promptVersion: string | null;
  promptFingerprint: string | null;
  configVersionId: number | null;
  decisionType: string | null;
  sourceUnitId: string | null;
  payload: Record<string, unknown>;
}

/** Issue finale d'une réception. */
export interface ReceiptOutcomeRow {
  receiptKey: string;
  outcome: ReceiptOutcome;
  reason: string | null;
  retryable: boolean;
  decisionFp: string | null;
  decisionId: number | null;
  writeState: ReceiptWriteState;
  sourceUnitId?: string | null;
}

let pret: { ok: boolean; at: number } | null = null;

/** Table 2012 présente ? (cache 5 min si absente ; ne lève jamais). */
export async function receiptsTableReady(sql: Sql): Promise<boolean> {
  if (pret && (pret.ok || Date.now() - pret.at < 300_000)) return pret.ok;
  let ok = false;
  try {
    const r = (await sql.unsafe(`SELECT to_regclass('document_value_decision_receipts') IS NOT NULL AS ok`)) as Array<{ ok: boolean }>;
    ok = r[0]?.ok === true;
  } catch {
    ok = false;
  }
  pret = { ok, at: Date.now() };
  return ok;
}

/** Réservé aux tests. */
export function __resetReceiptsTableProbeForTests(): void { pret = null; }

/** Manifeste de la passe (idempotent : une réception déjà connue n'est jamais réécrite). Rend le nombre de lignes nouvelles. */
export async function writeReceiptManifest(sql: Sql, c: { accountId: number; fileId: number; extractionId: number | null; passId: string; passOrigin: string }, rows: readonly ReceiptManifestRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const r = (await sql.unsafe(
    `INSERT INTO document_value_decision_receipts (
       account_id, file_id, extraction_id, pass_id, pass_origin, call_index, call_ref, ordinal, receipt_key, contract_state,
       contract_version, prompt_version, prompt_fingerprint, config_version_id, decision_type, source_unit_id, payload
     )
     SELECT $1, $2, $3, $4, $5, d."callIndex", d."callRef", d.ordinal, d."receiptKey", d."contractState", d."contractVersion",
            d."promptVersion", d."promptFingerprint", d."configVersionId", d."decisionType", d."sourceUnitId", coalesce(d.payload, '{}'::jsonb)
       FROM jsonb_to_recordset($6::jsonb) AS d(
         "callIndex" int, "callRef" text, ordinal int, "receiptKey" text, "contractState" text, "contractVersion" text,
         "promptVersion" text, "promptFingerprint" text, "configVersionId" bigint, "decisionType" text, "sourceUnitId" text, payload jsonb
       )
     ON CONFLICT (receipt_key) DO NOTHING
     RETURNING 1`,
    [c.accountId, c.fileId, c.extractionId, c.passId, c.passOrigin.slice(0, 60), JSON.stringify(rows)] as never[],
  )) as unknown[];
  return r.length;
}

/** Issues des réceptions (dans la transaction des décisions, ou seule pour un incident technique). */
export async function finalizeReceipts(sql: Sql, accountId: number, fileId: number, rows: readonly ReceiptOutcomeRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const r = (await sql.unsafe(
    `UPDATE document_value_decision_receipts r
        SET outcome = d.outcome, reason = left(d.reason, 200), retryable = d.retryable, decision_fp = d."decisionFp",
            decision_id = d."decisionId", write_state = d."writeState",
            source_unit_id = coalesce(d."sourceUnitId", r.source_unit_id), updated_at = now()
       FROM jsonb_to_recordset($3::jsonb) AS d(
         "receiptKey" text, outcome text, reason text, retryable boolean, "decisionFp" text, "decisionId" bigint, "writeState" text, "sourceUnitId" text
       )
      WHERE r.receipt_key = d."receiptKey" AND r.account_id = $1 AND r.file_id = $2
      RETURNING 1`,
    [accountId, fileId, JSON.stringify(rows)] as never[],
  )) as unknown[];
  return r.length;
}

/** Réception telle que relue (relecture exacte, reprise). */
export interface StoredReceipt {
  id: number;
  passId: string;
  passOrigin: string;
  receiptKey: string;
  callIndex: number;
  callRef: string | null;
  ordinal: number;
  contractState: string;
  contractVersion: string | null;
  promptVersion: string | null;
  promptFingerprint: string | null;
  configVersionId: number | null;
  decisionType: string | null;
  sourceUnitId: string | null;
  outcome: ReceiptOutcome;
  reason: string | null;
  retryable: boolean;
  decisionFp: string | null;
  decisionId: number | null;
  writeState: ReceiptWriteState;
  recoveryAttempts: number;
  payload: Record<string, unknown>;
}

const COLONNES = `id::float8 AS id, pass_id AS "passId", pass_origin AS "passOrigin", receipt_key AS "receiptKey", call_index AS "callIndex",
  call_ref AS "callRef", ordinal, contract_state AS "contractState", contract_version AS "contractVersion", prompt_version AS "promptVersion",
  prompt_fingerprint AS "promptFingerprint", config_version_id::float8 AS "configVersionId", decision_type AS "decisionType",
  source_unit_id AS "sourceUnitId", outcome, reason, retryable, decision_fp AS "decisionFp", decision_id::float8 AS "decisionId",
  write_state AS "writeState", recovery_attempts AS "recoveryAttempts", payload`;

const lire = (r: Record<string, unknown>): StoredReceipt => ({
  ...(r as unknown as StoredReceipt),
  id: Number(r.id), callIndex: Number(r.callIndex), ordinal: Number(r.ordinal),
  configVersionId: r.configVersionId == null ? null : Number(r.configVersionId),
  decisionId: r.decisionId == null ? null : Number(r.decisionId), recoveryAttempts: Number(r.recoveryAttempts ?? 0),
  payload: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload ?? {}) as Record<string, unknown>,
});

/** Réceptions d'UNE passe (relecture exacte), du bon compte et du bon document. */
export async function loadPassReceipts(sql: Sql, accountId: number, fileId: number, passId: string): Promise<StoredReceipt[]> {
  return ((await sql.unsafe(
    `SELECT ${COLONNES} FROM document_value_decision_receipts WHERE account_id = $1 AND file_id = $2 AND pass_id = $3 ORDER BY call_index, ordinal`,
    [accountId, fileId, passId] as never[],
  )) as Array<Record<string, unknown>>).map(lire);
}

/**
 * Réceptions à REPRENDRE sans IA : manifeste resté `PENDING` (crash), incident
 * technique réessayable, écriture non confirmée / absente / divergente.
 */
export async function loadRecoverableReceipts(sql: Sql, accountId: number, fileId: number): Promise<StoredReceipt[]> {
  return ((await sql.unsafe(
    `SELECT ${COLONNES} FROM document_value_decision_receipts
      WHERE account_id = $1 AND file_id = $2
        AND (outcome = 'PENDING' OR (outcome = 'NOT_EVALUATED' AND retryable)
             OR (outcome IN ('VALID', 'INVALID') AND write_state IN ('NEW', 'ALREADY_PRESENT', 'UNCONFIRMED', 'MISSING', 'DIVERGENT', 'PENDING')))
      ORDER BY pass_id, call_index, ordinal`,
    [accountId, fileId] as never[],
  )) as Array<Record<string, unknown>>).map(lire);
}

/** Une reprise de plus consommée (rend les clés encore sous le plafond). */
export async function claimRecovery(sql: Sql, accountId: number, fileId: number, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const r = (await sql.unsafe(
    `UPDATE document_value_decision_receipts SET recovery_attempts = recovery_attempts + 1, updated_at = now()
      WHERE account_id = $1 AND file_id = $2 AND receipt_key = ANY($3::text[]) AND recovery_attempts < $4
      RETURNING receipt_key AS k`,
    [accountId, fileId, keys, RECEIPT_RECOVERY_MAX] as never[],
  )) as Array<{ k: string }>;
  return new Set(r.map((x) => String(x.k)));
}

/**
 * Décisions ACTIVES écrites par une réparation différée mais JAMAIS confirmées
 * par relecture exacte : elles ne justifient aucune couverture tant qu'une
 * reprise ne les a pas relues. Table absente : aucune (décisions historiques
 * sans réception : non vérifiables sur l'appel, jamais exclues en masse).
 */
export async function unconfirmedDecisionIds(sql: Sql, accountId: number, fileId: number): Promise<Set<number>> {
  if (!(await receiptsTableReady(sql))) return new Set();
  const r = (await sql.unsafe(
    `SELECT decision_id::float8 AS id FROM document_value_decision_receipts
      WHERE account_id = $1 AND file_id = $2 AND decision_id IS NOT NULL
      GROUP BY decision_id
     HAVING NOT bool_or(write_state = 'CONFIRMED')`,
    [accountId, fileId] as never[],
  )) as Array<{ id: number }>;
  return new Set(r.map((x) => Number(x.id)));
}
