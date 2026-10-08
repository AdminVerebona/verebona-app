/**
 * T3 — rattrapage des TITRES de documents (lot 33C, ticket « T1/T3 :
 * garantir le renommage métier des documents »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONTRÔLE INDÉPENDANT DES AUTRES TRAITEMENTS
 *
 * Un document dont l'analyse, le classement, le rattachement et l'agenda sont
 * terminés reste éligible : seuls comptent son état d'analyse ABOUTI, un
 * titre NON conforme (`isValidBusinessTitle`) et une source SYSTEM. Aucune
 * autre action T3 (DOCUMENT_ASSET, réconciliation) n'est requise ni lue.
 *
 * Même mécanique que le rattrapage DOCUMENT_ASSET (lots 31B / 32C) :
 *   · sorte de travail `document_title_sweep` (cible `document_title_sweep`,
 *     sans compte) au contrat de file 31C (`payloadVersion: 1`) ;
 *   · page 0 ouverte par la racine du balayage planifié T3
 *     (`registerT3SweepStarter('document_title', …)`, même cycle, même
 *     déclencheur) — pas de nouveau cycle tant qu'une page vit encore ;
 *   · chaque page traite au plus `titleSweepPageSize()` documents (curseur =
 *     identifiant), puis met en file UNE continuation (clé unique
 *     « cycle:page », `onlyIfNeverQueued`) : bornée, reprenable (une page
 *     rejouée est idempotente), multi-instances (prélèvement atomique de la
 *     file + écriture en compare-and-set).
 *
 * Le titre est reconstruit depuis les données PERSISTÉES par le service
 * commun `DocumentTitleService` — jamais d'OCR, d'extraction, d'appel T1 ni
 * de classification. Un titre utilisateur n'est jamais repris.
 *
 * Préfiltre SQL = sur-ensemble des titres techniques
 * (`technicalTitleSqlPredicate`) ; la règle JS tranche. Un document « données
 * insuffisantes » n'est repris qu'après une nouvelle analyse
 * (`title_checked_at` < `last_analysis_at`) : pas de boucle horaire.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { QueuedJob } from '../queue/job-queue.repository';
import type { ExecutionGuard } from '../queue/execution-control';
import { PermanentJobError, type JobBusinessResult } from '../queue/queue-policy';
import { envNumber } from '@/lib/env-number';
import { technicalTitleSqlPredicate } from '@/lib/documents/document-title-rules';
import { buildT3Payload, registerT3JobKind } from './t3-job-contract';
import { T1_SETTLED_STATES } from './document-asset/question-gate';
import type { TitleOutcome } from '@/services/documents/document-title.service';

export const T3_TARGET_DOCUMENT_TITLE_SWEEP = 'document_title_sweep';
export const DOCUMENT_TITLE_SWEEP_KIND = 'document_title_sweep';

/** Documents examinés par page (`T3_TITLE_SWEEP_PAGE_SIZE`, 100 par défaut, 1 à 500). */
export function titleSweepPageSize(): number {
  return Math.min(500, Math.floor(envNumber('T3_TITLE_SWEEP_PAGE_SIZE', 100, { min: 1 })));
}
/** Délai avant la page suivante (`T3_TITLE_SWEEP_PAGE_DELAY_SECONDS`, 10 s par défaut). */
const pageDelaySeconds = () => Math.floor(envNumber('T3_TITLE_SWEEP_PAGE_DELAY_SECONDS', 10, { min: 0 }));

export interface DocumentTitleSweepDeps {
  enqueue: typeof import('../queue/job-queue.repository').enqueue;
}
async function defaultDeps(): Promise<DocumentTitleSweepDeps> {
  const { enqueue } = await import('../queue/job-queue.repository');
  return { enqueue };
}

export interface DocumentTitleSweepPayload {
  kind: typeof DOCUMENT_TITLE_SWEEP_KIND;
  cycleId: string;
  page: number;
  afterFileId: number;
  requestedAt: string | null;
}

/**
 * Documents à contrôler (SQL pur, borné, curseur par identifiant) :
 *   · analyse T1 aboutie (état abouti, analyse datée ou représentation durable) ;
 *   · visible (ni supprimé, ni regroupé, ni brouillon, ni ignoré), pas un lien web ;
 *   · titre SYSTÈME (`title_source = 'SYSTEM'`) ;
 *   · titre potentiellement technique (préfiltre) ;
 *   · pas déjà jugé « données insuffisantes » depuis la dernière analyse.
 * AUCUNE condition sur le rattachement, le classement, l'agenda ou une autre
 * action T3 (§5 du ticket).
 */
export const TITLE_SWEEP_SQL = `
  SELECT f.id, f.account_id
    FROM asset_files f
   WHERE ($3::int IS NULL OR f.account_id = $3::int)
     AND f.id > $1::int
     AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL
     AND COALESCE(f.is_draft, false) = false AND COALESCE(f.is_ignored, false) = false
     AND COALESCE(f.is_web_link, false) = false
     AND f.title_source = 'SYSTEM'
     AND f.analysis_state IN ('${T1_SETTLED_STATES.join("', '")}')
     AND (f.last_analysis_at IS NOT NULL OR EXISTS (SELECT 1 FROM document_extractions e WHERE e.file_id = f.id))
     AND (f.title_checked_at IS NULL OR f.last_analysis_at IS NULL OR f.title_checked_at < f.last_analysis_at)
     AND (${technicalTitleSqlPredicate('f.retained_title')}
          OR f.retained_title = f.s3_key OR f.retained_title = f.public_id::text)
   ORDER BY f.id
   LIMIT $2`;

export async function listDocumentsWithNonCompliantTitle(q: { afterFileId?: number; limit: number; accountId?: number | null }): Promise<Array<{ fileId: number; accountId: number }>> {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(TITLE_SWEEP_SQL, [q.afterFileId ?? 0, q.limit, q.accountId ?? null] as never[])) as unknown as Array<{ id: number; account_id: number }>;
  return rows.map((r) => ({ fileId: Number(r.id), accountId: Number(r.account_id) }));
}

type Compteurs = Record<TitleOutcome, number>;
const compteursVides = (): Compteurs => ({ UPDATED: 0, SKIP_VALID_TITLE: 0, SKIP_USER_TITLE: 0, SKIP_INSUFFICIENT_DATA: 0, FAILED: 0 });

/** Contrôle (et corrige) une liste de documents par le service commun, origine T3. */
export async function repairTitles(rows: ReadonlyArray<{ fileId: number; accountId: number }>, guard?: ExecutionGuard): Promise<Compteurs> {
  const { ensureBusinessTitle } = await import('@/services/documents/document-title.service');
  const c = compteursVides();
  for (const r of rows) {
    await guard?.assertActive('T3 titre des documents');
    const res = await ensureBusinessTitle({ fileId: r.fileId, accountId: r.accountId, origin: 'T3', mode: 'repair', guard });
    c[res.outcome]++;
  }
  return c;
}

/** Page du rattrapage planifié des titres. */
export async function runDocumentTitleSweepPage(
  job: QueuedJob, p: DocumentTitleSweepPayload, guard: ExecutionGuard, deps?: DocumentTitleSweepDeps,
): Promise<JobBusinessResult> {
  const d = deps ?? await defaultDeps();
  const size = titleSweepPageSize();
  const triggerCode = job.triggerCode ?? 'schedule_hourly';
  const rows = await listDocumentsWithNonCompliantTitle({ afterFileId: p.afterFileId, limit: size });
  const c = await repairTitles(rows, guard);
  const fin = rows.length < size;
  const suivant = rows.length > 0 ? rows[rows.length - 1].fileId : p.afterFileId;
  if (!fin) {
    await guard.assertActive('T3 titre des documents — continuation du rattrapage');
    await d.enqueue({
      treatment: 'T3',
      scope: { targetType: T3_TARGET_DOCUMENT_TITLE_SWEEP, targetId: `${p.cycleId}:${p.page + 1}` },
      triggerCode,
      delaySeconds: pageDelaySeconds(),
      payload: buildT3Payload(DOCUMENT_TITLE_SWEEP_KIND, { cycleId: p.cycleId, page: p.page + 1, afterFileId: suivant }),
      onlyIfNeverQueued: true,
    });
  }
  if (c.UPDATED > 0 || c.FAILED > 0) {
    console.info(`[t3-document-title] rattrapage ${p.cycleId}:${p.page} : ${c.UPDATED} titre(s) corrigé(s), ${c.FAILED} échec(s).`);
  }
  return {
    result: c.UPDATED > 0 ? 'APPLIED' : 'NO_CHANGE',
    detail: { cycleId: p.cycleId, page: p.page, afterFileId: p.afterFileId, examined: rows.length, ...c, last: fin },
  };
}

const entier = (job: Pick<QueuedJob, 'id'>, raw: Record<string, unknown>, key: string): number => {
  const v = raw[key];
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new PermanentJobError(`T3 job ${job.id} : ${key} invalide`);
  return v;
};

let enregistre = false;

/** Enregistre la sorte de travail. Idempotent (démarrage, chargement du module). */
export function registerDocumentTitleT3(): void {
  if (enregistre) return;
  enregistre = true;
  registerT3JobKind<DocumentTitleSweepPayload>({
    kind: DOCUMENT_TITLE_SWEEP_KIND,
    targetTypes: [T3_TARGET_DOCUMENT_TITLE_SWEEP],
    account: 'forbidden',
    versions: [1],
    parse(raw, job) {
      const cycleId = raw.cycleId;
      if (typeof cycleId !== 'string' || !cycleId) throw new PermanentJobError(`T3 job ${job.id} : page de rattrapage des titres sans cycle`);
      const requestedAt = raw.requestedAt;
      if (requestedAt !== undefined && requestedAt !== null
        && (typeof requestedAt !== 'string' || Number.isNaN(new Date(requestedAt).getTime()))) {
        throw new PermanentJobError(`T3 job ${job.id} : requestedAt invalide`);
      }
      return {
        kind: DOCUMENT_TITLE_SWEEP_KIND, cycleId,
        page: entier(job, raw, 'page'), afterFileId: entier(job, raw, 'afterFileId'),
        requestedAt: (requestedAt as string | null | undefined) ?? null,
      };
    },
    run: ({ job, payload, guard }) => runDocumentTitleSweepPage(job, payload, guard),
  });
}

/**
 * Démarreur branché sur la racine du balayage planifié T3 : page 0 du cycle
 * (clé unique). Si une page d'un cycle précédent vit encore, aucun nouveau
 * cycle n'est ouvert (elle poursuit, curseur stable).
 */
export async function startDocumentTitleSweep(
  ctx: { cycleId: string; triggerCode: string; guard: ExecutionGuard }, deps?: DocumentTitleSweepDeps,
): Promise<void> {
  const d = deps ?? await defaultDeps();
  const { pgClient } = await import('@/db');
  const [{ n }] = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM ai_job_queue WHERE treatment = 'T3' AND target_type = $1 AND status IN ('PENDING', 'RUNNING')`,
    [T3_TARGET_DOCUMENT_TITLE_SWEEP] as never[],
  )) as unknown as Array<{ n: number }>;
  if (Number(n ?? 0) > 0) return;
  await ctx.guard.assertActive('T3 titre des documents — ouverture du rattrapage');
  await d.enqueue({
    treatment: 'T3',
    scope: { targetType: T3_TARGET_DOCUMENT_TITLE_SWEEP, targetId: `${ctx.cycleId}:0` },
    triggerCode: ctx.triggerCode,
    payload: buildT3Payload(DOCUMENT_TITLE_SWEEP_KIND, { cycleId: ctx.cycleId, page: 0, afterFileId: 0 }),
    onlyIfNeverQueued: true,
  });
}

/**
 * Rattrapage direct (BO, tests) : contrôle au plus `limit` documents
 * (d'un compte, ou de tous). Le passage planifié passe par les pages.
 */
export async function sweepDocumentTitles(opts: { accountId?: number | null; limit?: number; guard?: ExecutionGuard } = {}): Promise<Compteurs> {
  const rows = await listDocumentsWithNonCompliantTitle({ limit: opts.limit ?? titleSweepPageSize(), accountId: opts.accountId ?? null });
  return repairTitles(rows, opts.guard);
}

registerDocumentTitleT3();
