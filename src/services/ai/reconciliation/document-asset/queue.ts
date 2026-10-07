/**
 * T3 DOCUMENT_ASSET sur la file durable (lot 31B), au contrat de file du
 * lot 31C (`t3-job-contract.ts` : sortes de travail enregistrées, contexte
 * versionné `payloadVersion: 1`, `PermanentJobError`, résultat métier).
 *
 * Deux sortes de travail enregistrées (`registerDocumentAssetT3`) :
 *   · `document_asset` (cible `document`, compte requis) : résolution d'UN
 *     document — mise en file IMMÉDIATE (`source_analyzed`) quand T1 termine
 *     sans bien principal certain, ou par le rattrapage planifié ;
 *   · `document_asset_sweep` (cible `document_sweep`, sans compte) : une PAGE
 *     bornée du rattrapage des documents sans bien principal. La première
 *     page est ouverte par la racine du balayage planifié T3 (démarreur
 *     `registerT3SweepStarter`, même cycle, même déclencheur) ; chaque page
 *     met en file au plus `documentSweepPageSize()` travaux, puis UNE
 *     continuation (curseur = identifiant de document, clé unique
 *     « cycle:page », `onlyIfNeverQueued`). File encore chargée → la page se
 *     reporte sans rien ajouter. Durable, reprenable, multi-instances ; T1
 *     n'est jamais relancé.
 *
 * Lot 32C : une décision T3 n'est réutilisable que si les entrées
 * pertinentes ET la version du moteur (`DOCUMENT_ASSET_RESOLUTION_VERSION`)
 * sont inchangées — une ancienne abstention (version antérieure ou NULL),
 * une nouvelle analyse T1 ou un identifiant canonique de bien modifié
 * (journal 0274, empreinte comparée) la rendent obsolète ; un vrai cas
 * ambigu de la version courante n'est jamais rejoué d'heure en heure.
 */
import type { QueuedJob } from '../../queue/job-queue.repository';
import type { ExecutionGuard } from '../../queue/execution-control';
import { isPermanentFailure, PermanentJobError, type JobBusinessResult } from '../../queue/queue-policy';
import type { SourceAnalysisResult } from '../../source-analysis/types';
import { envNumber } from '@/lib/env-number';
import { buildT3Payload, parseTargetId, registerT3JobKind } from '../t3-job-contract';
import { confirmEvaluation, markPending, type StoredT1Candidate } from './resolution.repository';
import { resolveDocumentAsset } from './resolve-document-asset.service';
import { T1_SETTLED_STATES } from './question-gate';
import { DOCUMENT_ASSET_RESOLUTION_VERSION } from './version';

/** Type de cible des travaux T3 DOCUMENT_ASSET dans `ai_job_queue`. */
export const T3_TARGET_DOCUMENT = 'document';
/** Type de cible des pages du rattrapage planifié. */
export const T3_TARGET_DOCUMENT_SWEEP = 'document_sweep';
export const DOCUMENT_ASSET_KIND = 'document_asset';
export const DOCUMENT_ASSET_SWEEP_KIND = 'document_asset_sweep';

/** Documents remis en file par page (`T3_DOCUMENT_SWEEP_PAGE_SIZE`, 50 par défaut, 1 à 500). */
export function documentSweepPageSize(): number {
  return Math.min(500, Math.floor(envNumber('T3_DOCUMENT_SWEEP_PAGE_SIZE', 50, { min: 1 })));
}
/** Délai avant la page suivante (`T3_SWEEP_PAGE_DELAY_SECONDS`, comme le balayage des comptes). */
const pageDelaySeconds = () => Math.floor(envNumber('T3_SWEEP_PAGE_DELAY_SECONDS', 60, { min: 0 }));
/** Report d'une page quand la file est chargée (`T3_SWEEP_BACKLOG_DELAY_SECONDS`). */
const backlogDelaySeconds = () => Math.floor(envNumber('T3_SWEEP_BACKLOG_DELAY_SECONDS', 300, { min: 0 }));

/** Délai au-delà duquel une demande PENDING sans travail vivant est considérée perdue. */
export const LOST_REQUEST_MINUTES = 60;

/**
 * Marge (minutes) entre la modification d'un identifiant de bien et la date
 * d'évaluation d'une abstention (lot 32C) : une modification commise par une
 * transaction longue, datée AVANT l'évaluation mais invisible pendant
 * celle-ci, rend tout de même la décision obsolète. Coût borné : une
 * confirmation de plus (sans travail T3 si l'empreinte est inchangée).
 */
export const IDENTIFIER_CHANGE_MARGIN_MINUTES = 10;

export interface DocumentAssetQueueDeps {
  enqueue: typeof import('../../queue/job-queue.repository').enqueue;
  isTriggerActive: (treatment: 'T3', code: string) => Promise<boolean>;
}

async function defaultDeps(): Promise<DocumentAssetQueueDeps> {
  const [{ enqueue }, { isTriggerActive }] = await Promise.all([
    import('../../queue/job-queue.repository'),
    import('../../queue/triggers'),
  ]);
  return { enqueue, isTriggerActive };
}

/** Candidats « bien » de T1 conservés pour T3 : identifiants vérifiés seulement (pure). */
export function t1CandidatesOf(result: Pick<SourceAnalysisResult, 'assetCandidates'>): StoredT1Candidate[] {
  const vus = new Map<number, StoredT1Candidate>();
  for (const c of result.assetCandidates ?? []) {
    if (!c.verified || c.entityId === null) continue;
    const prev = vus.get(c.entityId);
    if (prev && prev.score >= c.score) continue;
    vus.set(c.entityId, {
      assetId: c.entityId, confidence: c.confidence, score: Number.isFinite(c.score) ? c.score : 0,
      reason: (c.reason ?? '').slice(0, 300), signals: (c.excerpt ?? '').slice(0, 1000),
    });
  }
  return [...vus.values()].sort((a, b) => a.assetId - b.assetId);
}

/**
 * Demande la résolution T3 DOCUMENT_ASSET d'un document. Rend l'identifiant
 * du travail, ou `null` si le déclencheur `source_analyzed` est inactif dans
 * la version effective — l'utilisateur est alors sollicité directement
 * (déterministe d'abord, aucun appel modèle).
 */
export async function requestDocumentAssetResolution(
  p: {
    accountId: number; userId: number | null; fileId: number;
    t1Candidates?: StoredT1Candidate[]; triggerCode: string;
  },
  deps?: DocumentAssetQueueDeps,
): Promise<number | null> {
  const d = deps ?? await defaultDeps();
  await markPending({ accountId: p.accountId, fileId: p.fileId, t1Candidates: p.t1Candidates, triggerCode: p.triggerCode });
  if (p.triggerCode === 'source_analyzed' && !(await d.isTriggerActive('T3', 'source_analyzed'))) {
    await resolveDocumentAsset({ accountId: p.accountId, fileId: p.fileId, userId: p.userId, skipAi: true });
    return null;
  }
  const { jobId } = await d.enqueue({
    treatment: 'T3',
    scope: { accountId: p.accountId, targetType: T3_TARGET_DOCUMENT, targetId: p.fileId },
    triggerCode: p.triggerCode,
    payload: buildT3Payload(DOCUMENT_ASSET_KIND, { userId: p.userId }),
    payloadOnDedupe: 'replace',
  });
  return jobId;
}

// ── Sortes de travail ──────────────────────────────────────────────────────

export interface DocumentAssetPayload {
  kind: typeof DOCUMENT_ASSET_KIND;
  fileId: number;
  userId: number | null;
  requestedAt: string | null;
}

export interface DocumentSweepPayload {
  kind: typeof DOCUMENT_ASSET_SWEEP_KIND;
  cycleId: string;
  page: number;
  afterFileId: number;
  requestedAt: string | null;
}

const entierPositifOuNul = (job: Pick<QueuedJob, 'id'>, raw: Record<string, unknown>, key: string, min: number): number | null => {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new PermanentJobError(`T3 job ${job.id} : ${key} invalide`);
  return v;
};
const dateOpt = (job: Pick<QueuedJob, 'id'>, raw: Record<string, unknown>): string | null => {
  const v = raw.requestedAt;
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || Number.isNaN(new Date(v).getTime())) throw new PermanentJobError(`T3 job ${job.id} : requestedAt invalide`);
  return v;
};

/** Exécution d'un travail `document_asset` : résultat métier du service. */
export async function runDocumentAssetJob(job: QueuedJob, p: DocumentAssetPayload, guard: ExecutionGuard): Promise<JobBusinessResult> {
  await guard.assertActive('T3 DOCUMENT_ASSET');
  const r = await resolveDocumentAsset({
    accountId: job.accountId as number,
    fileId: p.fileId,
    userId: p.userId,
    guard,
    // Après cette tentative, la file abandonnerait : on sollicite l'utilisateur.
    finalAttempt: isPermanentFailure(job.attempts + 1),
  });
  const decision = r.decision;
  return {
    result: r.outcome,
    detail: {
      fileId: p.fileId, status: r.status, aiCalled: r.aiCalled,
      ...(decision ? { decision: decision.kind } : {}),
      ...(decision?.kind === 'ABSTAIN' ? { reasonCode: decision.reasonCode, candidates: decision.ranked.length } : {}),
      ...(decision?.kind === 'APPLY' ? { assetIds: [decision.assetId], method: decision.method } : {}),
      ...(decision?.kind === 'MULTI_ASSET' ? { assetIds: decision.assetIds, method: decision.method } : {}),
    },
  };
}

/** Page du rattrapage planifié. */
export async function runDocumentSweepPage(
  job: QueuedJob, p: DocumentSweepPayload, guard: ExecutionGuard, deps?: DocumentAssetQueueDeps,
): Promise<JobBusinessResult> {
  const d = deps ?? await defaultDeps();
  const size = documentSweepPageSize();
  const triggerCode = job.triggerCode ?? 'schedule_hourly';
  const { pgClient } = await import('@/db');
  const [{ n }] = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM ai_job_queue
      WHERE treatment = 'T3' AND target_type = $1 AND status = 'PENDING'`,
    [T3_TARGET_DOCUMENT] as never[],
  )) as unknown as Array<{ n: number }>;
  const backlog = Number(n ?? 0);

  let fileIds: number[] = [];
  let suivant = p.afterFileId;
  let fin = false;
  let confirmed = 0;
  if (backlog < size) {
    const rows = await listDocumentsWithoutPrimary({ afterFileId: p.afterFileId, limit: size });
    const done = await requestStaleResolutions(rows, { guard, triggerCode, deps: d, label: 'rattrapage planifié' });
    fileIds = done.enqueued;
    confirmed = done.confirmed;
    if (rows.length > 0) suivant = rows[rows.length - 1].fileId;
    fin = rows.length < size;
  }
  if (!fin) {
    await guard.assertActive('T3 DOCUMENT_ASSET — continuation du rattrapage');
    await d.enqueue({
      treatment: 'T3',
      scope: { targetType: T3_TARGET_DOCUMENT_SWEEP, targetId: `${p.cycleId}:${p.page + 1}` },
      triggerCode,
      delaySeconds: backlog >= size ? backlogDelaySeconds() : pageDelaySeconds(),
      payload: buildT3Payload(DOCUMENT_ASSET_SWEEP_KIND, { cycleId: p.cycleId, page: p.page + 1, afterFileId: suivant }),
      onlyIfNeverQueued: true,
    });
  }
  if (fileIds.length > 0) console.info(`[t3-document-asset] rattrapage ${p.cycleId}:${p.page} : ${fileIds.length} document(s) remis en file.`);
  return {
    result: fileIds.length > 0 ? 'APPLIED' : 'NO_CHANGE',
    detail: { cycleId: p.cycleId, page: p.page, afterFileId: p.afterFileId, enqueued: fileIds.length, confirmed, backlog, last: fin },
  };
}

let enregistre = false;

/**
 * Enregistre les deux sortes de travail et le démarreur du rattrapage sur
 * le balayage planifié T3. Idempotent ; appelé au démarrage par
 * `registerReconciliationHandlers` (et au chargement de ce module).
 */
export function registerDocumentAssetT3(): void {
  if (enregistre) return;
  enregistre = true;
  registerT3JobKind<DocumentAssetPayload>({
    kind: DOCUMENT_ASSET_KIND,
    targetTypes: [T3_TARGET_DOCUMENT],
    account: 'required',
    versions: [1],
    parse(raw, job) {
      return {
        kind: DOCUMENT_ASSET_KIND,
        fileId: parseTargetId(job),
        userId: entierPositifOuNul(job, raw, 'userId', 1),
        requestedAt: dateOpt(job, raw),
      };
    },
    run: ({ job, payload, guard }) => runDocumentAssetJob(job, payload, guard),
  });
  registerT3JobKind<DocumentSweepPayload>({
    kind: DOCUMENT_ASSET_SWEEP_KIND,
    targetTypes: [T3_TARGET_DOCUMENT_SWEEP],
    account: 'forbidden',
    versions: [1],
    parse(raw, job) {
      const cycleId = raw.cycleId;
      if (typeof cycleId !== 'string' || !cycleId) throw new PermanentJobError(`T3 job ${job.id} : page de rattrapage sans cycle`);
      return {
        kind: DOCUMENT_ASSET_SWEEP_KIND,
        cycleId,
        page: entierPositifOuNul(job, raw, 'page', 0) ?? 0,
        afterFileId: entierPositifOuNul(job, raw, 'afterFileId', 0) ?? 0,
        requestedAt: dateOpt(job, raw),
      };
    },
    run: ({ job, payload, guard }) => runDocumentSweepPage(job, payload, guard),
  });
}

/** Démarreur branché sur la racine du balayage planifié T3 (page 0, clé unique par cycle). */
export async function startDocumentSweep(
  ctx: { cycleId: string; triggerCode: string; guard: ExecutionGuard }, deps?: DocumentAssetQueueDeps,
): Promise<void> {
  const d = deps ?? await defaultDeps();
  await ctx.guard.assertActive('T3 DOCUMENT_ASSET — ouverture du rattrapage');
  await compactIdentifierChanges();
  await d.enqueue({
    treatment: 'T3',
    scope: { targetType: T3_TARGET_DOCUMENT_SWEEP, targetId: `${ctx.cycleId}:0` },
    triggerCode: ctx.triggerCode,
    payload: buildT3Payload(DOCUMENT_ASSET_SWEEP_KIND, { cycleId: ctx.cycleId, page: 0, afterFileId: 0 }),
    onlyIfNeverQueued: true,
  });
}

// ── Sélection des documents à reprendre ────────────────────────────────────

/**
 * Documents à reprendre (SQL pur, borné, curseur par identifiant). Critères
 * du ticket T3, §10, et du ticket « rattrapage des abstentions » (lot 32C) :
 *   · T1 terminé (état d'analyse abouti ET représentation persistée) ;
 *   · aucun rattachement principal (colonne, lien PRIMARY) — un lien
 *     MENTIONED ne compte pas ;
 *   · aucune décision utilisateur (lien USER, choix ou retrait explicite) —
 *     jamais rejugée, quelle que soit la version ;
 *   · aucun travail T3 DOCUMENT_ASSET vivant ;
 *   · décision encore VALABLE exclue :
 *       – multi-biens ou décision utilisateur sur la MÊME analyse ;
 *       – abstention (ABSTAINED, NO_CANDIDATE) sur la MÊME analyse, par la
 *         version COURANTE du moteur, sans modification d'un identifiant de
 *         bien du compte depuis son évaluation ;
 *       – demande de moins d'une heure (perdue au-delà).
 *     Une abstention d'une version antérieure — ou sans version (NULL,
 *     lignes historiques) — est donc rejouée UNE fois, à partir des données
 *     T1 persistées : jamais T1. (`IS NOT DISTINCT FROM` : sous `NOT (…)`,
 *     une comparaison à NULL rendrait la condition entière NULL — la ligne
 *     serait écartée au lieu d'être reprise.)
 * `identifiers_only` : la seule raison de la reprise est une modification
 * d'identifiant de bien — le balayage compare alors l'empreinte des
 * identifiants avant de mettre quoi que ce soit en file.
 */
export const SWEEP_SQL = `
  SELECT f.id, f.account_id, f.user_id,
         (r.file_id IS NOT NULL AND r.status IN ('ABSTAINED', 'NO_CANDIDATE')
          AND r.extraction_at IS NOT NULL AND r.extraction_at >= date_trunc('milliseconds', e.extracted_at)
          AND r.resolution_version IS NOT DISTINCT FROM $5::int) AS identifiers_only,
         r.identifiers_fingerprint
    FROM asset_files f
    JOIN document_extractions e ON e.file_id = f.id AND e.account_id = f.account_id
    LEFT JOIN document_asset_resolutions r ON r.file_id = f.id
   WHERE ($3::int IS NULL OR f.account_id = $3::int)
     AND f.id > $4::int
     AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL
     AND COALESCE(f.is_draft, false) = false AND COALESCE(f.is_ignored, false) = false
     AND f.asset_id IS NULL AND f.linked_asset_id IS NULL
     AND f.analysis_state IN ('${T1_SETTLED_STATES.join("', '")}')
     AND COALESCE((f.user_edited_fields ->> 'assetId')::boolean, false) = false
     AND NOT EXISTS (
       SELECT 1 FROM document_asset_links l
        WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND l.asset_id IS NOT NULL
          AND (l.link_role = 'PRIMARY' OR l.origin = 'USER'))
     AND NOT EXISTS (
       SELECT 1 FROM ai_job_queue q
        WHERE q.treatment = 'T3' AND q.target_type = '${T3_TARGET_DOCUMENT}' AND q.target_id = f.id::text
          AND q.status IN ('PENDING', 'RUNNING'))
     AND (r.file_id IS NULL OR NOT COALESCE((
          -- Millisecondes : l'instant est relu côté serveur (précision JS).
          (r.status IN ('MULTI_ASSET', 'USER_DECIDED')
            AND r.extraction_at IS NOT NULL AND r.extraction_at >= date_trunc('milliseconds', e.extracted_at))
       OR (r.status IN ('ABSTAINED', 'NO_CANDIDATE')
            AND r.extraction_at IS NOT NULL AND r.extraction_at >= date_trunc('milliseconds', e.extracted_at)
            AND r.resolution_version IS NOT DISTINCT FROM $5::int
            AND NOT EXISTS (
              SELECT 1 FROM document_asset_identifier_changes c
               WHERE c.account_id = f.account_id
                 AND c.changed_at > COALESCE(r.evaluated_at, r.decided_at, r.updated_at) - ($6 || ' minutes')::interval))
       OR (r.status = 'PENDING' AND r.requested_at > now() - ($1 || ' minutes')::interval)), false))
   ORDER BY f.id
   LIMIT $2`;

export interface SweepCandidate {
  fileId: number;
  accountId: number;
  userId: number | null;
  /** Abstention courante, rejouée seulement si les identifiants des biens ont changé. */
  identifiersOnly: boolean;
  /** Empreinte des identifiants lors de l'abstention (comparée avant toute mise en file). */
  identifiersFingerprint: string | null;
}

export async function listDocumentsWithoutPrimary(q: { afterFileId?: number; limit: number; accountId?: number | null }): Promise<SweepCandidate[]> {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(SWEEP_SQL, [
    String(LOST_REQUEST_MINUTES), q.limit, q.accountId ?? null, q.afterFileId ?? 0,
    DOCUMENT_ASSET_RESOLUTION_VERSION, String(IDENTIFIER_CHANGE_MARGIN_MINUTES),
  ] as never[])) as unknown as Array<{
    id: number; account_id: number; user_id: number | null; identifiers_only: boolean | null; identifiers_fingerprint: string | null;
  }>;
  return rows.map((r) => ({
    fileId: Number(r.id), accountId: Number(r.account_id), userId: r.user_id == null ? null : Number(r.user_id),
    identifiersOnly: r.identifiers_only === true, identifiersFingerprint: r.identifiers_fingerprint ?? null,
  }));
}

/**
 * Met en file les documents retenus par le balayage. Une abstention de la
 * version courante, reprise seulement parce qu'un bien du compte a été
 * modifié, est d'abord comparée à l'empreinte ACTUELLE des identifiants :
 * inchangée → évaluation confirmée, aucun travail (pas de boucle horaire).
 */
export async function requestStaleResolutions(
  rows: readonly SweepCandidate[],
  opts: { guard?: ExecutionGuard; triggerCode: string; deps?: DocumentAssetQueueDeps; label?: string },
): Promise<{ enqueued: number[]; confirmed: number }> {
  const label = `T3 DOCUMENT_ASSET — ${opts.label ?? 'rattrapage'}`;
  const empreintes = new Map<number, string>();
  const aConfirmer = new Map<string, number[]>();
  const enqueued: number[] = [];
  for (const r of rows) {
    if (r.identifiersOnly && r.identifiersFingerprint) {
      let fp = empreintes.get(r.accountId);
      if (fp === undefined) {
        const [{ loadAssetIdentifiers }, { identifiersFingerprint }] = await Promise.all([
          import('./asset-identifiers.repository'), import('./identifiers'),
        ]);
        fp = identifiersFingerprint(await loadAssetIdentifiers(r.accountId));
        empreintes.set(r.accountId, fp);
      }
      if (fp === r.identifiersFingerprint) {
        aConfirmer.set(fp, [...(aConfirmer.get(fp) ?? []), r.fileId]);
        continue;
      }
    }
    await opts.guard?.assertActive(label);
    await requestDocumentAssetResolution({ accountId: r.accountId, userId: r.userId, fileId: r.fileId, triggerCode: opts.triggerCode }, opts.deps);
    enqueued.push(r.fileId);
  }
  let confirmed = 0;
  for (const [fp, ids] of aConfirmer) {
    await opts.guard?.assertActive(`${label} (évaluation confirmée)`);
    confirmed += await confirmEvaluation(ids, fp);
  }
  return { enqueued, confirmed };
}

/**
 * Journal des modifications d'identifiants de biens (déclencheur 0274) : seule
 * la plus récente par compte compte pour le balayage — les autres sont
 * retirées à l'ouverture de chaque cycle (table minuscule). Ne lève jamais.
 */
export async function compactIdentifierChanges(): Promise<void> {
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `DELETE FROM document_asset_identifier_changes c
        WHERE EXISTS (SELECT 1 FROM document_asset_identifier_changes d
                       WHERE d.account_id = c.account_id
                         AND (d.changed_at > c.changed_at OR (d.changed_at = c.changed_at AND d.id > c.id)))`,
    );
  } catch (e) {
    console.error('[t3-document-asset] compactage du journal des identifiants impossible :', (e as Error).message);
  }
}

/**
 * Rattrapage direct d'UN compte (BO, tests) : remet en file au plus `limit`
 * documents. Le passage planifié, lui, passe par les pages ci-dessus. Rend le
 * nombre de documents remis en file.
 */
export async function sweepDocumentsWithoutPrimary(opts: {
  guard?: ExecutionGuard; triggerCode?: string | null; limit?: number; deps?: DocumentAssetQueueDeps; accountId?: number | null;
} = {}): Promise<number> {
  const rows = await listDocumentsWithoutPrimary({ limit: opts.limit ?? documentSweepPageSize(), accountId: opts.accountId ?? null });
  const { enqueued } = await requestStaleResolutions(rows, {
    guard: opts.guard, triggerCode: opts.triggerCode ?? 'schedule_hourly', deps: opts.deps,
  });
  return enqueued.length;
}

registerDocumentAssetT3();
