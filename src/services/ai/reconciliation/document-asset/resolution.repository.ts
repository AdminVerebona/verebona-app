/**
 * État de la réconciliation T3 DOCUMENT_ASSET par document (migration 0265).
 * Voir l'en-tête de la migration pour la signification des statuts.
 */
import { pgClient } from '@/db';

export const RESOLUTION_STATUSES = [
  'PENDING', 'RESOLVED', 'MULTI_ASSET', 'ABSTAINED', 'NO_CANDIDATE', 'USER_DECIDED', 'ALREADY_LINKED', 'TARGET_GONE',
] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];
export type ResolutionMethod = 'DETERMINISTIC' | 'AI' | 'NONE';

/** Candidat produit par T1 (identifiant VÉRIFIÉ, preuves de l'analyse). */
export interface StoredT1Candidate {
  assetId: number;
  confidence: string;
  score: number;
  /** Raison et signaux de T1 (texte lu dans le document). */
  reason: string;
  signals: string;
}

/** Candidat présenté à l'utilisateur après abstention. */
export interface StoredCandidate {
  assetId: number;
  label: string;
  score: number;
  reason: string;
}

export interface DocumentAssetResolution {
  fileId: number;
  accountId: number;
  status: ResolutionStatus;
  /** Dernière issue terminale (le statut repasse PENDING à chaque demande). */
  lastOutcome: ResolutionStatus | null;
  method: ResolutionMethod | null;
  reasonCode: string | null;
  t1Candidates: StoredT1Candidate[];
  candidates: StoredCandidate[];
  decidedAssetIds: number[];
  inputFingerprint: string | null;
  extractionAt: string | null;
  runs: number;
  requestedAt: string;
}

const parse = <T>(v: unknown, d: T): T => {
  if (v == null) return d;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return d; } }
  return v as T;
};

export async function getResolution(fileId: number): Promise<DocumentAssetResolution | null> {
  const rows = (await pgClient.unsafe(
    `SELECT file_id, account_id, status, last_outcome, method, reason_code, t1_candidates, candidates, decided_asset_ids,
            input_fingerprint, extraction_at, runs, requested_at
       FROM document_asset_resolutions WHERE file_id = $1`,
    [fileId] as never[],
  )) as unknown as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  return {
    fileId: Number(r.file_id),
    accountId: Number(r.account_id),
    status: String(r.status) as ResolutionStatus,
    lastOutcome: (r.last_outcome as ResolutionStatus | null) ?? null,
    method: (r.method as ResolutionMethod | null) ?? null,
    reasonCode: (r.reason_code as string | null) ?? null,
    t1Candidates: parse<StoredT1Candidate[]>(r.t1_candidates, []),
    candidates: parse<StoredCandidate[]>(r.candidates, []),
    decidedAssetIds: ((r.decided_asset_ids as number[] | null) ?? []).map(Number),
    inputFingerprint: (r.input_fingerprint as string | null) ?? null,
    extractionAt: r.extraction_at ? new Date(String(r.extraction_at)).toISOString() : null,
    runs: Number(r.runs ?? 0),
    requestedAt: new Date(String(r.requested_at)).toISOString(),
  };
}

/**
 * Demande de résolution : la ligne passe (ou reste) PENDING. Les candidats
 * T1 fournis remplacent les précédents (nouvelle analyse) ; absents (passage
 * planifié), ceux déjà connus sont conservés.
 */
export async function markPending(p: {
  accountId: number; fileId: number; t1Candidates?: StoredT1Candidate[]; triggerCode: string;
}): Promise<void> {
  await pgClient.unsafe(
    `INSERT INTO document_asset_resolutions (file_id, account_id, status, t1_candidates, trigger_code, requested_at, updated_at)
     VALUES ($1, $2, 'PENDING', COALESCE($3::jsonb, '[]'::jsonb), $4, now(), now())
     ON CONFLICT (file_id) DO UPDATE SET
       status = 'PENDING',
       t1_candidates = COALESCE($3::jsonb, document_asset_resolutions.t1_candidates),
       -- Nouvelles entrées T1 : l'empreinte précédente ne vaut plus.
       input_fingerprint = CASE WHEN $3::jsonb IS NULL THEN document_asset_resolutions.input_fingerprint ELSE NULL END,
       trigger_code = $4, requested_at = now(), updated_at = now()`,
    [p.fileId, p.accountId, p.t1Candidates ? JSON.stringify(p.t1Candidates) : null, p.triggerCode] as never[],
  );
}

/** Issue d'une exécution T3 DOCUMENT_ASSET. */
export async function recordOutcome(p: {
  accountId: number; fileId: number; status: Exclude<ResolutionStatus, 'PENDING'>;
  method: ResolutionMethod; reasonCode: string; candidates?: StoredCandidate[]; decidedAssetIds?: number[];
  inputFingerprint?: string | null; extractionAt?: string | null;
}): Promise<void> {
  await pgClient.unsafe(
    `INSERT INTO document_asset_resolutions (file_id, account_id, status, last_outcome, method, reason_code, candidates, decided_asset_ids,
                                             input_fingerprint, extraction_at, runs, decided_at, updated_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6::jsonb, $7::int[], $8, $9::timestamptz, 1, now(), now())
     ON CONFLICT (file_id) DO UPDATE SET
       status = $3, last_outcome = $3, method = $4, reason_code = $5, candidates = $6::jsonb, decided_asset_ids = $7::int[],
       input_fingerprint = $8, extraction_at = $9::timestamptz,
       runs = document_asset_resolutions.runs + 1, decided_at = now(), updated_at = now()`,
    [
      p.fileId, p.accountId, p.status, p.method, p.reasonCode, JSON.stringify(p.candidates ?? []),
      p.decidedAssetIds ?? [], p.inputFingerprint ?? null, p.extractionAt ?? null,
    ] as never[],
  );
}

/** Statuts après lesquels l'utilisateur peut être sollicité (« À traiter »). */
export const USER_QUESTION_STATUSES: readonly ResolutionStatus[] = ['ABSTAINED', 'NO_CANDIDATE'];

/** Relance sur des entrées identiques : la ligne reprend sa dernière issue. */
export async function restoreLastOutcome(fileId: number): Promise<void> {
  await pgClient.unsafe(
    `UPDATE document_asset_resolutions SET status = last_outcome, updated_at = now()
      WHERE file_id = $1 AND last_outcome IS NOT NULL`,
    [fileId] as never[],
  );
}
