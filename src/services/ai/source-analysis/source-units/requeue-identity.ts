/**
 * Lot 115H (Trello #785, § 2 et § 4) — IDENTITÉ PERSISTANTE ET IDEMPOTENTE
 * D'UNE DEMANDE DE REPRISE T1, et réservation durable de son droit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Le lot 114H lisait l'issue RÉELLE de la file et ne consommait aucune reprise
 * pour un travail déjà vivant ; le § 1 de ce lot a ajouté le contrôle et la
 * réservation du droit AVANT tout enfilement. Deux trous restaient :
 *
 *   § 2 — une demande IDENTIQUE à ce qu'une exécution est déjà en train de
 *   satisfaire posait `coalesce_requested` sur le travail en cours, et un
 *   PASSAGE SUPPLÉMENTAIRE naissait à sa clôture : une seconde analyse
 *   complète du même document, qu'aucune reprise n'avait payée et qu'aucun
 *   compteur n'annonçait. Et comme le droit n'est pas consommé pour un travail
 *   vivant, des clics répétés — ou BO + planificateur, ou deux exécutants —
 *   multipliaient ces passages gratuits.
 *
 *   § 4 — la création du travail et l'écriture du compteur sont dans deux
 *   transactions distinctes (la file a la sienne). Un arrêt entre les deux
 *   laissait une tentative ACCEPTÉE mais NON comptabilisée, et rien ne
 *   permettait de la rattraper : il n'existait aucune identité de demande à
 *   laquelle se raccrocher.
 *
 * CE QUE CE MODULE APPORTE
 *
 *   1. une IDENTITÉ stable de la demande (`request_key`) : compte, document,
 *      origine et EMPREINTE DES PREUVES. Deux demandes identiques retrouvent
 *      la même ligne (idempotence) ; une demande portée par une preuve ou une
 *      source réellement NOUVELLE a une identité distincte, donc son propre
 *      droit réservé et sa propre consommation — elle n'est jamais présentée
 *      comme une simple absence de doublon ;
 *   2. la trace des FRONTIÈRES franchies (`steps`) : réservé, enfilé,
 *      constaté, compté, diagnostiqué. Une reprise après panne sait ce qui est
 *      acquis : elle ne réserve pas deux fois et n'oublie aucune tentative ;
 *   3. la RÉCUPÉRATION des réservations orphelines
 *      (`recoverRequeueReservations`) : une réservation dont aucun travail
 *      vivant n'est né est rendue, exactement une fois.
 *
 * Aucune règle métier n'est codée ici : les bornes viennent de
 * `retry-policy.ts`, l'état réel du travail de `job-queue.repository`.
 * Tolérant à l'absence de la migration 1805 : le code retombe alors sur le
 * comportement du lot 114H complété du § 1 (contrôle et réservation du droit),
 * sans identité persistante.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import type { RequeueOrigin } from './retry-policy';

type Row = Record<string, unknown>;

/** États d'une demande de reprise T1 (colonne `state` de `t1_requeue_requests`). */
export const REQUEUE_REQUEST_STATES = ['RESERVED', 'CONFIRMED', 'OBSERVED', 'RELEASED', 'REFUSED', 'RECOVERED'] as const;
export type RequeueRequestState = (typeof REQUEUE_REQUEST_STATES)[number];

/** Frontières franchies par une demande (jamais de contenu de document). */
export interface RequeueSteps {
  reserved?: boolean;
  enqueued?: boolean;
  inspected?: boolean;
  counted?: boolean;
  diagnosed?: boolean;
  recovered?: boolean;
}

/**
 * EMPREINTE DES PREUVES d'un document au moment d'une demande (pure).
 *
 * C'est elle qui tranche « demande identique » / « demande réellement
 * distincte ». Elle ne retient que des codes et des compteurs — jamais de
 * contenu : état de qualité, motif et nature de la vérification, pages
 * manquantes, résidus, empreinte de la dernière confrontation déterministe et
 * empreinte du fichier source lu. Deux appels sur des données inchangées
 * rendent la MÊME empreinte (idempotence) ; le moindre changement de preuve en
 * rend une autre.
 */
export function requeueEvidenceFingerprint(p: {
  qualityState?: string | null;
  anomalies?: readonly string[] | null;
  verificationReason?: string | null;
  sourceVerification?: string | null;
  pagesMissing?: readonly number[] | null;
  unresolvedUnits?: number | null;
  uncertainUnits?: number | null;
  failedUnits?: number | null;
  /** Empreinte de la dernière re-vérification déterministe (`reverificationFingerprint`). */
  reverificationFingerprint?: string | null;
  /** Empreinte du fichier source réellement lu (`document_raw_extracts.source_sha256`). */
  sourceSha256?: string | null;
  /** Version de la couche A écrite. */
  layerVersion?: number | null;
}): string {
  const pages = [...(p.pagesMissing ?? [])].map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const anomalies = [...(p.anomalies ?? [])].map(String).sort();
  const parts = [
    p.qualityState ?? '', anomalies.join(','), p.verificationReason ?? '', p.sourceVerification ?? '',
    pages.join(','), String(p.unresolvedUnits ?? 0), String(p.uncertainUnits ?? 0), String(p.failedUnits ?? 0),
    p.reverificationFingerprint ?? '', p.sourceSha256 ?? '', String(p.layerVersion ?? 0),
  ];
  return createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 32);
}

/**
 * IDENTITÉ stable d'une demande (pure). `explicit` : identité imposée par
 * l'appelant (une action du BO qui veut sa propre demande, une continuation) ;
 * sinon l'identité est déduite de l'origine et de l'empreinte des preuves.
 */
export function requeueRequestKey(p: {
  origin: string; requestedBy: RequeueOrigin; evidenceFingerprint: string; explicit?: string | null;
}): string {
  if (p.explicit && p.explicit.trim() !== '') return p.explicit.trim().slice(0, 180);
  return `${p.requestedBy}:${p.origin}:${p.evidenceFingerprint}`.slice(0, 180);
}

let tablePresente: { ready: boolean; at: number } | null = null;

/** La migration 1805 est-elle appliquée ? (mémorisé 30 s ; ne lève jamais) */
export async function requeueRequestsReady(): Promise<boolean> {
  if (tablePresente && Date.now() - tablePresente.at < 30_000) return tablePresente.ready;
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(`SELECT to_regclass('t1_requeue_requests') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    tablePresente = { ready: r[0]?.ok === true, at: Date.now() };
  } catch {
    tablePresente = { ready: false, at: Date.now() };
  }
  return tablePresente.ready;
}

/** Remise à zéro de la mémoire de présence (tests). */
export function resetRequeueRequestsReadyCache(): void {
  tablePresente = null;
}

export interface RequeueRequestRecord {
  id: number;
  state: RequeueRequestState;
  reservedAttempt: number | null;
  attemptConsumed: boolean;
  jobId: number | null;
  reason: string | null;
  steps: RequeueSteps;
  /** La ligne vient d'être créée par cet appel (aucune demande antérieure de cette identité). */
  fresh: boolean;
}

const etapes = (v: unknown): RequeueSteps => {
  const o = (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return {};
  const out: RequeueSteps = {};
  for (const k of ['reserved', 'enqueued', 'inspected', 'counted', 'diagnosed', 'recovered'] as const) {
    if (o[k] === true) out[k] = true;
  }
  return out;
};

const enregistrement = (r: Row, fresh: boolean): RequeueRequestRecord => ({
  id: Number(r.id),
  state: String(r.state) as RequeueRequestState,
  reservedAttempt: r.reserved_attempt == null ? null : Number(r.reserved_attempt),
  attemptConsumed: r.attempt_consumed === true,
  jobId: r.job_id == null ? null : Number(r.job_id),
  reason: r.reason == null ? null : String(r.reason),
  steps: etapes(r.steps),
  fresh,
});

/**
 * Ouvre (ou retrouve) la demande de cette identité. Deux appels concurrents de
 * la MÊME identité obtiennent la même ligne : l'unicité est en base
 * (`t1_requeue_requests_key_uidx`), et l'insertion est conditionnelle.
 * `null` : migration 1805 absente — l'appelant poursuit sans identité persistante.
 */
export async function openRequeueRequest(p: {
  accountId: number; fileId: number; requestKey: string; origin: string; requestedBy: RequeueOrigin;
  evidenceFingerprint: string;
}): Promise<RequeueRequestRecord | null> {
  if (!(await requeueRequestsReady())) return null;
  const { pgClient } = await import('@/db');
  const cols = `id, state, reserved_attempt, attempt_consumed, job_id, reason, steps`;
  try {
    const inserees = (await pgClient.unsafe(
      `INSERT INTO t1_requeue_requests (account_id, file_id, request_key, origin, requested_by, evidence_fingerprint, state, steps)
       VALUES ($1, $2, $3, $4, $5, $6, 'RESERVED', '{}'::jsonb)
       ON CONFLICT (account_id, file_id, request_key) DO NOTHING
       RETURNING ${cols}`,
      [p.accountId, p.fileId, p.requestKey, p.origin, p.requestedBy, p.evidenceFingerprint] as never[],
    )) as unknown as Row[];
    if (inserees[0]) return enregistrement(inserees[0], true);
    // Demande déjà connue : son état dit ce qui est acquis (lecture filtrée par le compte).
    const existantes = (await pgClient.unsafe(
      `SELECT ${cols} FROM t1_requeue_requests
        WHERE account_id = $1 AND file_id = $2 AND request_key = $3`,
      [p.accountId, p.fileId, p.requestKey] as never[],
    )) as unknown as Row[];
    return existantes[0] ? enregistrement(existantes[0], false) : null;
  } catch (e) {
    console.warn(`[t1-requeue] identité de demande non enregistrée pour le document ${p.fileId} (non bloquant) :`, (e as Error).message);
    return null;
  }
}

/**
 * Consigne l'avancement d'une demande : nouvelles frontières franchies, état,
 * travail corrélé, motif, consommation. Les étapes sont CUMULÉES (jamais
 * effacées) : une reprise après panne lit ce qui est acquis.
 * Jamais bloquant — l'identité ne doit pas faire échouer une reprise.
 */
export async function recordRequeueProgress(p: {
  requestId: number;
  steps?: RequeueSteps;
  state?: RequeueRequestState;
  jobId?: number | null;
  reason?: string | null;
  reservedAttempt?: number | null;
  attemptConsumed?: boolean;
}): Promise<void> {
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `UPDATE t1_requeue_requests
          SET steps = steps || $2::jsonb,
              state = COALESCE($3, state),
              job_id = COALESCE($4::bigint, job_id),
              reason = COALESCE($5, reason),
              reserved_attempt = COALESCE($6::int, reserved_attempt),
              attempt_consumed = COALESCE($7::boolean, attempt_consumed),
              updated_at = NOW()
        WHERE id = $1`,
      [p.requestId, JSON.stringify(p.steps ?? {}), p.state ?? null, p.jobId ?? null, p.reason ?? null,
        p.reservedAttempt ?? null, p.attemptConsumed === undefined ? null : p.attemptConsumed] as never[],
    );
  } catch (e) {
    console.warn(`[t1-requeue] avancement de la demande ${p.requestId} non consigné (non bloquant) :`, (e as Error).message);
  }
}

/** Délai au-delà duquel une réservation sans travail vivant est considérée orpheline (minutes). */
export const REQUEUE_RESERVATION_STALE_MINUTES = 30;

export interface RequeueRecoveryResult {
  /** Réservations examinées. */
  examined: number;
  /** Réservations dont un travail vivant a été constaté : la consommation est TENUE. */
  confirmed: number;
  /** Réservations rendues (aucun travail vivant) : la tentative n'est pas perdue, elle n'est pas consommée. */
  released: number;
  /** Migration 1805 absente. */
  disabled?: string;
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * REPRISE APRÈS PANNE ENTRE DEUX ÉCRITURES (carte § 4)
 *
 * Une demande restée `RESERVED` au-delà de `REQUEUE_RESERVATION_STALE_MINUTES`
 * a réservé une reprise sans que la suite ait abouti. Deux cas, tranchés sur
 * l'ÉTAT RÉEL du travail en base, document par document et compte par compte :
 *
 *   · un travail vivant du document existe → la tentative a bien eu lieu : la
 *     réservation est TENUE (`CONFIRMED`, consommation acquise) ; rien n'est
 *     compté deux fois ;
 *   · aucun travail vivant → la réservation est RENDUE : `retry_attempts`
 *     retrouve exactement ce que cette demande avait pris, et la demande passe
 *     à `RECOVERED`. La transition d'état est CONDITIONNELLE
 *     (`WHERE state = 'RESERVED'`) : la restitution a lieu au plus une fois,
 *     même si deux processus récupèrent en même temps.
 *
 * Aucune suppression, aucun appel IA, aucune notification. Ne lève jamais.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function recoverRequeueReservations(opts: {
  staleMinutes?: number; limit?: number; accountId?: number;
} = {}): Promise<RequeueRecoveryResult> {
  const res: RequeueRecoveryResult = { examined: 0, confirmed: 0, released: 0 };
  if (!(await requeueRequestsReady())) return { ...res, disabled: 'MIGRATION_1805_MISSING' };
  const { pgClient } = await import('@/db');
  const minutes = Math.max(1, Math.trunc(opts.staleMinutes ?? REQUEUE_RESERVATION_STALE_MINUTES));
  const limite = Math.min(500, Math.max(1, Math.trunc(opts.limit ?? 100)));
  let lignes: Row[];
  try {
    lignes = (await pgClient.unsafe(
      `SELECT id, account_id, file_id, reserved_attempt, job_id FROM t1_requeue_requests
        WHERE state = 'RESERVED' AND updated_at < NOW() - make_interval(mins => $1)
          AND ($3::int IS NULL OR account_id = $3)
        ORDER BY updated_at
        LIMIT $2`,
      [minutes, limite, opts.accountId ?? null] as never[],
    )) as unknown as Row[];
  } catch (e) {
    console.warn('[t1-requeue] récupération des réservations impossible (non bloquant) :', (e as Error).message);
    return res;
  }
  const { inspectCorrelatedJob } = await import('../../queue/job-queue.repository');
  for (const l of lignes) {
    res.examined++;
    const accountId = Number(l.account_id);
    const fileId = Number(l.file_id);
    try {
      const travail = await inspectCorrelatedJob({
        treatment: 'T1', accountId, targetType: 'asset_file', targetId: fileId,
        jobId: l.job_id == null ? null : Number(l.job_id),
      });
      if (travail.state === 'ALIVE') {
        await pgClient.unsafe(
          `UPDATE t1_requeue_requests
              SET state = 'CONFIRMED', attempt_consumed = TRUE, job_id = COALESCE($2::bigint, job_id),
                  steps = steps || '{"recovered":true,"inspected":true,"counted":true}'::jsonb, updated_at = NOW()
            WHERE id = $1 AND state = 'RESERVED'`,
          [Number(l.id), travail.jobId] as never[],
        );
        res.confirmed++;
        continue;
      }
      // Aucun travail vivant : la réservation est RENDUE, au plus une fois (transition conditionnelle).
      const rendue = (await pgClient.unsafe(
        `UPDATE t1_requeue_requests
            SET state = 'RECOVERED', attempt_consumed = FALSE, reason = $2,
                steps = steps || '{"recovered":true,"inspected":true}'::jsonb, updated_at = NOW()
          WHERE id = $1 AND state = 'RESERVED'
          RETURNING id`,
        [Number(l.id), `réservation rendue : aucun travail T1 vivant (${travail.state})`] as never[],
      )) as unknown as Row[];
      if (rendue.length === 0) continue;
      if (l.reserved_attempt != null) {
        await pgClient.unsafe(
          `UPDATE document_extraction_coverage
              SET retry_attempts = GREATEST(0, retry_attempts - 1), updated_at = NOW()
            WHERE file_id = $1 AND account_id = $2`,
          [fileId, accountId] as never[],
        );
      }
      res.released++;
      console.info(`[t1-requeue] document ${fileId} : réservation orpheline rendue (aucun travail vivant, ${travail.state}).`);
    } catch (e) {
      console.warn(`[t1-requeue] réservation ${String(l.id)} non récupérée (non bloquant) :`, (e as Error).message);
    }
  }
  return res;
}
