/**
 * Candidats Opération de T1 — persistance durable (lot 40, CDC Opérations V1
 * C3.2, C9, C9.1, T1-OP-009 ; migrations 0317 et 0320).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MÊME TRANSACTION QUE LES FAITS — JAMAIS D'ÉTAT MIXTE LISIBLE
 *
 * Appelée par `persistDocumentKnowledge`, dans sa transaction, APRÈS
 * l'écriture des faits :
 *
 *   1. SUPERSESSION : les candidats ACTIFS du fichier passent en SUPERSEDED.
 *      `document_extractions` est un UPSERT par fichier : `extraction_id`
 *      n'est PAS une version. La version d'un candidat est portée par son
 *      statut et `analysis_run_id` ; la clé locale n'est unique que parmi les
 *      ACTIFS (index partiel 0320). Une réanalyse qui ne produit plus aucun
 *      candidat retire donc les anciens (F-063).
 *   2. ANCRAGE STABLE : chaque preuve (empreinte `t1FactRef`) est convertie
 *      en { identifiant du fait PERSISTÉ, empreinte, unités de la source } —
 *      l'index de faits du modèle ne survit pas aux lots et aux filtres.
 *   3. INSERTION des nouveaux candidats, sous point de sauvegarde : un
 *      candidat impossible à écrire n'emporte jamais les faits (écrits comme
 *      avant) ; il n'en reste alors AUCUN actif pour le fichier (les anciens
 *      sont déjà supersédés) — jamais un candidat orphelin d'un ancien run.
 *
 * MARQUEUR T3 (C3.2, C4 TRG-001 / TRG-002) — aucun branchement T3 dans ce
 * lot, rien n'est visible côté utilisateur :
 *   · `t3_pending = true` : T3 doit examiner la ligne — candidat ÉTABLI
 *     nouvellement actif, ou candidat déjà consolidé (`t3_processed_at`)
 *     qui vient d'être supersédé (retrait de contribution, C9) ;
 *   · `trigger_code` : `source_analyzed` (1re analyse) ou
 *     `source_reanalyzed` (le fichier avait déjà une extraction).
 * Un candidat non établi ou jamais consolidé ne réveille jamais T3.
 *
 * Reprise ciblée (lot 34F, `insertFactRows` seul) : elle AJOUTE des faits et
 * ne supersède rien — les ancres existantes restent valides ; elle ne crée
 * ni ne modifie aucun candidat.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { AnchoredOperationCandidate } from './prepare';

type Tx = { unsafe: (q: string, p?: never[]) => Promise<unknown> };

/** Fait persisté désigné par une empreinte. */
export interface PersistedFactAnchor {
  factId: number;
  sourceUnitIds: string[];
}

/** Preuve stable d'un candidat persisté (payload). */
export interface CandidateEvidenceAnchor {
  /** `document_facts.id` du fait persisté (null : fait non persisté). */
  factId: number | null;
  /** Empreinte `factFingerprint` du fait T1 d'origine. */
  fingerprint: string;
  sourceUnitIds: string[];
}

/** Version du payload (jsonb) — artefact d'extraction, pas une donnée métier. */
export const OPERATION_CANDIDATE_PAYLOAD_VERSION = 1;

const RECONTROLE_MS = 5 * 60_000;
let etat: { ready: boolean; checkedAt: number } | null = null;
let signale = false;

/** Table 0317 et colonnes 0320 présentes ? Ne lève jamais (illisible = absent). */
export async function operationCandidatesReady(): Promise<boolean> {
  if (etat && (etat.ready || Date.now() - etat.checkedAt < RECONTROLE_MS)) return etat.ready;
  let ready = false;
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(
      `SELECT to_regclass('document_operation_candidates') IS NOT NULL
          AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                       AND table_name = 'document_operation_candidates' AND column_name = 't3_pending') AS ok`,
    )) as unknown as Array<{ ok: boolean }>;
    ready = Boolean(r[0]?.ok);
  } catch {
    ready = false;
  }
  etat = { ready, checkedAt: Date.now() };
  if (!ready && !signale) {
    signale = true;
    console.error('[t1-operation-candidates] ⚠️ MIGRATIONS 0317 / 0320 NON APPLIQUÉES : candidats Opération de T1 non écrits. '
      + 'Les faits restent écrits comme avant.');
  }
  return ready;
}

/** Tests seulement. */
export function resetOperationCandidatesReadyForTests(): void {
  etat = null;
  signale = false;
}

/** Ancre d'une empreinte (premier fait persisté qui la porte), sinon fait non persisté. */
function anchorOf(ref: string, facts: ReadonlyMap<string, PersistedFactAnchor[]>): CandidateEvidenceAnchor {
  const f = facts.get(ref)?.[0];
  return { factId: f?.factId ?? null, fingerprint: ref, sourceUnitIds: f?.sourceUnitIds ?? [] };
}

/** Payload persisté d'un candidat (pur). */
export function candidatePayload(c: AnchoredOperationCandidate, facts: ReadonlyMap<string, PersistedFactAnchor[]>): Record<string, unknown> {
  const evidence = c.evidenceFactRefs.map((r) => anchorOf(r, facts));
  return {
    payloadVersion: OPERATION_CANDIDATE_PAYLOAD_VERSION,
    contract: 't1_analyze_document@v5',
    origin: c.origin,
    sourceRoleHint: c.sourceRoleHint,
    provider: c.provider,
    targetHints: c.targetHints,
    businessReferences: c.businessReferences,
    temporalHints: c.temporalHints,
    financialHints: c.financialHints.map(({ factRef, ...h }) => ({ ...h, evidence: anchorOf(factRef, facts) })),
    evidence,
    evidenceFactIds: evidence.flatMap((e) => (e.factId !== null ? [e.factId] : [])),
    unresolvedEvidence: evidence.filter((e) => e.factId === null).length,
    exclusionReason: c.exclusionReason,
    adjustments: c.adjustments,
  };
}

export interface CandidatePersistResult {
  superseded: number;
  inserted: number;
  /** Lignes marquées pour T3 (nouveaux établis + retraits de candidats consolidés). */
  t3Pending: number;
}

/**
 * Supersède les candidats actifs du fichier puis écrit les nouveaux, DANS la
 * transaction de l'appelant (voir l'en-tête). `facts` : empreinte → faits
 * persistés de CETTE analyse.
 */
export async function replaceOperationCandidates(tx: Tx & { savepoint?: (f: (sp: unknown) => Promise<void>) => Promise<void> }, p: {
  accountId: number;
  fileId: number;
  extractionId: number;
  analysisRunId: number | null;
  reanalysis: boolean;
  candidates: readonly AnchoredOperationCandidate[];
  facts: ReadonlyMap<string, PersistedFactAnchor[]>;
}): Promise<CandidatePersistResult> {
  const sup = (await tx.unsafe(
    `UPDATE document_operation_candidates
        SET status = 'SUPERSEDED', superseded_at = now(),
            t3_pending = (t3_processed_at IS NOT NULL)
      WHERE file_id = $1 AND status = 'ACTIVE'
      RETURNING t3_pending`,
    [p.fileId] as never[],
  )) as unknown as Array<{ t3_pending: boolean }>;
  const result: CandidatePersistResult = { superseded: sup.length, inserted: 0, t3Pending: sup.filter((r) => r.t3_pending).length };
  if (p.candidates.length === 0) return result;

  const lignes = p.candidates.map((c) => ({
    candidate_key: c.candidateKey,
    established: c.established,
    confidence: c.confidence,
    type_hint: c.typeHint,
    status_hint: c.statusHint,
    summary: c.summary,
    payload: candidatePayload(c, p.facts),
    t3_pending: c.established,
  }));
  const ecrire = async (t: Tx) => {
    await t.unsafe(
      `INSERT INTO document_operation_candidates (
         account_id, file_id, extraction_id, analysis_run_id, candidate_key, established, confidence,
         type_hint, status_hint, summary, payload, status, t3_pending, trigger_code
       )
       SELECT $1, $2, $3, $4, c.candidate_key, c.established, c.confidence, c.type_hint, c.status_hint, c.summary,
              c.payload, 'ACTIVE', c.t3_pending, $6
         FROM jsonb_to_recordset($5::jsonb) AS c(
           candidate_key text, established boolean, confidence text, type_hint text, status_hint text,
           summary text, payload jsonb, t3_pending boolean
         )`,
      [p.accountId, p.fileId, p.extractionId, p.analysisRunId, JSON.stringify(lignes),
        p.reanalysis ? 'source_reanalyzed' : 'source_analyzed'] as never[],
    );
  };
  try {
    if (tx.savepoint) await tx.savepoint((sp) => ecrire(sp as Tx));
    else await ecrire(tx);
    result.inserted = lignes.length;
    result.t3Pending += lignes.filter((l) => l.t3_pending).length;
  } catch (err) {
    if (!tx.savepoint) throw err;
    console.error(`[t1-operation-candidates] candidats du fichier ${p.fileId} non écrits :`, (err as Error).message);
  }
  return result;
}
