/**
 * Lot 114H (Trello #775, P1-C) — RÉÉVALUATION AUTOMATISÉE DE LA COUVERTURE T1
 * DU STOCK, et clôture des SEULES alertes dont la cause a disparu.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Les lots 113AN (#741) et 114G (#760) ont corrigé les règles de couverture
 * (faux « non résolu », valeurs partiellement structurées, coordonnées…) et
 * ce lot corrige les règles de reprise. Aucun ne recalculait les documents
 * DÉJÀ analysés : leurs états, leurs alertes et leurs échéances de reprise
 * restaient ceux de l'ancienne condition, jusqu'à une consultation manuelle
 * du BO. Cette campagne applique les règles ACTUELLES à tout le stock, sans
 * action de personne, lancée par la tâche planifiée `t1-coverage-reassessment`
 * (au démarrage, puis toutes les heures tant qu'il reste des documents).
 *
 * CE QU'ELLE FAIT, DOCUMENT PAR DOCUMENT — SANS AUCUN APPEL IA
 *   1. re-vérification déterministe des pages d'un PDF contre son texte
 *      original déjà persisté (`reverifyStoredCoverage`, lot 109K), quand elle
 *      est due — jamais de promotion sans texte retrouvé ;
 *   2. réconciliation des unités avec les faits, décisions de valeur,
 *      tableaux, candidats et métadonnées persistés
 *      (`reconcileStoredDocumentCoverage`, lots 113AN / 114G), et règle
 *      unique des reprises (`retry-policy.ts`) : attentes sans chemin levées,
 *      état et anomalies recalculés, échéance retirée ou, pour une lacune
 *      réellement réparable, reposée — la réparation ciblée elle-même reste
 *      exécutée par `t1-completeness-retry`, avec ses plafonds normaux ;
 *   3. alertes de Supervision du document (`ai:t1-completeness:<id>`,
 *      `ai:t1-normalisation-loss:<id>`) : CLOSE si l'état recalculé ne la
 *      justifie plus, MAINTENUE si la cause existe toujours, OUVERTE si une
 *      lacune réelle sans reprise admissible n'était pas signalée ;
 *   4. journal `t1_coverage_reassessments` (migration 1705) : avant / après,
 *      version des règles, date, alertes, durée.
 * Puis les alertes T1 ouvertes SANS document éligible au passage (document
 * supprimé, couverture devenue complète entre-temps) sont examinées par leur
 * empreinte, sur l'état COURANT.
 *
 * CE QU'ELLE NE FAIT JAMAIS
 *   · appeler un modèle, relire un fichier, réanalyser un document ;
 *   · créer ou modifier un fait, une décision, un événement brut, un appel IA
 *     ou une trace d'audit ;
 *   · promouvoir une unité sans preuve, ni effacer une incertitude ;
 *   · notifier l'utilisateur ;
 *   · clore une alerte dont la cause subsiste.
 *
 * REPRENABLE, PAGINÉE, IDEMPOTENTE
 *   · pagination par identifiant de document (curseur), lots bornés
 *     (`T1_REASSESSMENT_BATCH`), échéance de passage ;
 *   · point de reprise = le journal : un document journalisé pour la version
 *     courante n'est pas retraité (une erreur l'est, `REASSESSMENT_MAX_ATTEMPTS`
 *     fois au plus) ; deux campagnes de suite : la seconde ne fait rien ;
 *   · comptes éligibles seulement (lot 82A) — les autres sont repris à leur
 *     réactivation ; toute lecture et écriture est filtrée par le compte du
 *     document.
 *
 * RÈGLE PERMANENTE (carte § 4) : tout correctif T1 qui change la condition
 * d'une alerte ou d'un état de couverture AUGMENTE `T1_COVERAGE_RULES_VERSION` ;
 * le stock est alors réévalué de nouveau, automatiquement.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { processingEligibleSql } from '@/services/account/processing-eligibility';
import { completenessFingerprint, normalisationLossFingerprint, T1_COVERAGE_ALERT_PREFIXES } from './monitoring';

/**
 * Version des règles de couverture / d'alerte T1 appliquées au stock.
 *   1 — lot 114H (#775) : règles 113AN + 114G + règle unique des reprises.
 */
export const T1_COVERAGE_RULES_VERSION = 1;

/** États de qualité réévalués (carte § 4.1). */
export const REASSESSED_QUALITY_STATES = ['COMPLETE_WITH_UNRESOLVED', 'VERIFICATION_INCOMPLETE', 'INCOMPLETE_RETRYABLE', 'INCOMPLETE_FINAL'] as const;

/** Essais au plus d'un document en erreur, par version. */
export const REASSESSMENT_MAX_ATTEMPTS = 3;
const DEFAULT_BATCH = 100;
/** Fenêtre (minutes) autour de l'échéance pendant laquelle la tâche de reprise peut tenir le document (bail de 30 min). */
const RETRY_ACTIVITY_WINDOW_MINUTES = 31;

type Row = Record<string, unknown>;
type Env = Record<string, string | undefined>;

export type ReassessmentOutcome = 'RESOLVED' | 'RECONCILED' | 'REPAIR_SCHEDULED' | 'STILL_UNRESOLVED' | 'UNVERIFIABLE' | 'FINAL_GAP' | 'UNCHANGED' | 'ERROR';

/** État d'une couverture consigné au journal (compteurs et codes — jamais de contenu). */
export interface CoverageSnapshot {
  qualityState: string; anomalies: string[];
  covered: number; unresolved: number; uncertain: number; failed: number; total: number;
  retryAttempts: number; retryScheduled: boolean; lastRetryResult: string | null;
}

export type AlertAction = 'CLOSED' | 'MAINTAINED' | 'OPENED';
export interface AlertDecision { fingerprint: string; anomalyId: number | null; action: AlertAction; cause: string }

/** Issue de la réévaluation, depuis l'avant / après (pure, testée). */
export function reassessmentOutcomeOf(p: {
  before: CoverageSnapshot; after: CoverageSnapshot; requalified: number; written: boolean;
}): ReassessmentOutcome {
  const { before, after } = p;
  if (after.qualityState === 'COMPLETE') return 'RESOLVED';
  if (after.qualityState === 'INCOMPLETE_FINAL') return before.qualityState === 'INCOMPLETE_FINAL' && !p.written ? 'UNCHANGED' : 'FINAL_GAP';
  if (after.qualityState === 'INCOMPLETE_RETRYABLE') return after.retryScheduled ? 'REPAIR_SCHEDULED' : 'STILL_UNRESOLVED';
  const identique = !p.written && before.qualityState === after.qualityState && before.retryScheduled === after.retryScheduled
    && before.anomalies.join('|') === after.anomalies.join('|');
  if (identique) return 'UNCHANGED';
  if (p.requalified > 0) return 'RECONCILED';
  return after.qualityState === 'VERIFICATION_INCOMPLETE' ? 'UNVERIFIABLE' : 'STILL_UNRESOLVED';
}

/**
 * Décision sur UNE alerte T1 de couverture, depuis l'état COURANT (pure, testée).
 * `null` : rien à faire (aucune alerte ouverte et aucune cause).
 */
export function alertDecisionOf(p: {
  kind: 'COMPLETENESS' | 'NORMALISATION_LOSS'; open: boolean;
  /** Document supprimé (ou introuvable). */
  deleted: boolean;
  /** Couverture courante ; null : aucune couche A. */
  qualityState: string | null; normalisationLosses: number | null;
  rulesVersion: number;
}): { action: AlertAction; cause: string } | null {
  const v = `règles T1 v${p.rulesVersion}`;
  if (p.deleted) return p.open ? { action: 'CLOSED', cause: `${v} : document supprimé — plus d’objet à réparer` } : null;
  // Sans couverture lisible, la cause ne peut pas être vérifiée : l'alerte est conservée.
  if (p.qualityState === null) return p.open ? { action: 'MAINTAINED', cause: `${v} : couverture absente — cause non vérifiable` } : null;
  if (p.kind === 'COMPLETENESS') {
    if (p.qualityState === 'INCOMPLETE_FINAL') {
      return p.open ? { action: 'MAINTAINED', cause: `${v} : lacune réelle sans reprise admissible (INCOMPLETE_FINAL)` }
        : { action: 'OPENED', cause: `${v} : lacune réelle sans reprise admissible, non signalée jusqu’ici` };
    }
    return p.open ? { action: 'CLOSED', cause: `${v} : état recalculé ${p.qualityState} — l’analyse n’est plus définitivement incomplète` } : null;
  }
  // Perte de normalisation : compteur absent des diagnostics = non vérifiable, l'alerte est conservée.
  if (p.normalisationLosses === null) return p.open ? { action: 'MAINTAINED', cause: `${v} : diagnostics absents — cause non vérifiable` } : null;
  if (p.normalisationLosses > 0) return p.open ? { action: 'MAINTAINED', cause: `${v} : ${p.normalisationLosses} perte(s) de normalisation non compensée(s)` } : null;
  return p.open ? { action: 'CLOSED', cause: `${v} : aucune perte de normalisation dans la couverture courante` } : null;
}

/** Document visé par une empreinte d'alerte T1 de couverture (pure) ; null : autre empreinte. */
export function alertTargetOf(fingerprint: string): { kind: 'COMPLETENESS' | 'NORMALISATION_LOSS'; fileId: number } | null {
  const [completude, perte] = T1_COVERAGE_ALERT_PREFIXES;
  const lire = (prefixe: string) => {
    if (!fingerprint.startsWith(prefixe)) return null;
    const n = Number(fingerprint.slice(prefixe.length));
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const a = lire(completude);
  if (a !== null) return { kind: 'COMPLETENESS', fileId: a };
  const b = lire(perte);
  return b !== null ? { kind: 'NORMALISATION_LOSS', fileId: b } : null;
}

export interface ReassessmentPassResult {
  rulesVersion: number;
  /** Documents examinés pendant ce passage, par issue. */
  examined: number;
  byOutcome: Partial<Record<ReassessmentOutcome, number>>;
  /** Documents laissés au passage suivant (reprise planifiée en cours ou imminente). */
  deferred: number;
  errors: number;
  alertsClosed: number; alertsMaintained: number; alertsOpened: number;
  /** Alertes sans document éligible examinées (document supprimé, couverture complète…). */
  orphanAlertsExamined: number;
  /** Reprises ciblées programmées / échéances retirées par le recalcul. */
  retriesScheduled: number; retriesCancelled: number;
  /** Appels IA de la campagne : toujours 0 (aucun chemin de ce module n'appelle un modèle). */
  aiCalls: 0;
  durationMs: number;
  more: boolean;
  /** Motif d'inactivité (schéma absent) ; absent : campagne exécutée. */
  disabled?: string;
}

function batchSize(env: Env = process.env): number {
  const n = Number(env.T1_REASSESSMENT_BATCH);
  return env.T1_REASSESSMENT_BATCH !== undefined && env.T1_REASSESSMENT_BATCH.trim() !== '' && Number.isFinite(n)
    ? Math.min(500, Math.max(1, Math.trunc(n))) : DEFAULT_BATCH;
}

/** Journal 1705 présent ? Ne lève jamais. */
export async function reassessmentJournalReady(): Promise<boolean> {
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(`SELECT to_regclass('t1_coverage_reassessments') IS NOT NULL AS ok`)) as unknown as Array<{ ok: boolean }>;
    return r[0]?.ok === true;
  } catch {
    return false;
  }
}

const liste = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function snapshotOf(c: Row | null | undefined): CoverageSnapshot | null {
  if (!c) return null;
  return {
    qualityState: String(c.qualityState), anomalies: liste(c.anomalies).sort(),
    covered: Number(c.coveredUnits ?? 0), unresolved: Number(c.unresolvedUnits ?? 0), uncertain: Number(c.uncertainUnits ?? 0),
    failed: Number(c.failedUnits ?? 0), total: Number(c.totalSourceUnits ?? 0),
    retryAttempts: Number(c.retryAttempts ?? 0), retryScheduled: c.nextRetryAt !== null && c.nextRetryAt !== undefined,
    lastRetryResult: c.lastRetryResult == null ? null : String(c.lastRetryResult),
  };
}

/** Pertes de normalisation des diagnostics ; null : compteur absent (non vérifiable). */
function lossesOf(verification: unknown): number | null {
  const d = (typeof verification === 'string' ? JSON.parse(verification) : verification) as { normalisationLosses?: unknown } | null;
  return d && typeof d.normalisationLosses === 'number' ? d.normalisationLosses : null;
}

/**
 * Applique la décision à UNE alerte (écriture). `CLOSED` : résolution
 * automatique historisée sur l'anomalie elle-même (origine, cause, date) ;
 * l'anomalie et ses occurrences restent consultables.
 */
async function applyAlertDecision(p: {
  accountId: number | null; fileId: number; kind: 'COMPLETENESS' | 'NORMALISATION_LOSS'; anomalyId: number | null;
  decision: { action: AlertAction; cause: string }; coverage: Row | null;
}): Promise<AlertDecision> {
  const fingerprint = p.kind === 'COMPLETENESS' ? completenessFingerprint(p.fileId) : normalisationLossFingerprint(p.fileId);
  let anomalyId = p.anomalyId;
  if (p.decision.action === 'CLOSED') {
    const { autoResolveAnomaly } = await import('@/services/admin/anomaly.service');
    await autoResolveAnomaly(fingerprint, { origin: `t1_coverage_reassessment:v${T1_COVERAGE_RULES_VERSION}`, cause: p.decision.cause });
  } else if (p.decision.action === 'OPENED' && p.coverage && p.accountId !== null) {
    const { reportT1IncompleteFinal } = await import('./monitoring');
    anomalyId = await reportT1IncompleteFinal({
      accountId: p.accountId, fileId: p.fileId, persisted: true,
      report: {
        qualityState: 'INCOMPLETE_FINAL', anomalies: liste(p.coverage.anomalies), coverageRatio: Number(p.coverage.coverageRatio ?? 0),
        failedUnits: Number(p.coverage.failedUnits ?? 0), truncatedSectionsCount: Number(p.coverage.truncatedSectionsCount ?? 0),
        droppedFactsCount: Number(p.coverage.droppedFactsCount ?? 0),
      },
    });
  }
  return { fingerprint, anomalyId, action: p.decision.action, cause: p.decision.cause };
}

/** Alertes T1 de couverture OUVERTES d'un document : empreinte → identifiant. */
async function openAlertsOf(fileId: number): Promise<Map<string, number>> {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT id, fingerprint FROM admin_anomalies WHERE status = 'open' AND fingerprint = ANY($1::text[])`,
    [[completenessFingerprint(fileId), normalisationLossFingerprint(fileId)]] as never[],
  )) as unknown as Array<{ id: number; fingerprint: string }>;
  return new Map(rows.map((r) => [String(r.fingerprint), Number(r.id)]));
}

export interface DocumentReassessment {
  fileId: number; accountId: number; outcome: ReassessmentOutcome;
  before: CoverageSnapshot | null; after: CoverageSnapshot | null; alerts: AlertDecision[];
  detail: Record<string, unknown>; durationMs: number; error?: string;
}

/**
 * Réévalue UN document (voir l'en-tête) et journalise. Idempotente : rejouée
 * sur un document déjà à jour, elle n'écrit rien d'autre que le journal.
 * Sans appel IA. Ne lève pas : une erreur est journalisée (`ERROR`).
 */
export async function reassessDocumentCoverage(p: { accountId: number; fileId: number }): Promise<DocumentReassessment> {
  const debut = Date.now();
  const { loadDocumentCoverage } = await import('./repository');
  let before: CoverageSnapshot | null = null;
  try {
    const cov0 = await loadDocumentCoverage(p.fileId, p.accountId);
    before = snapshotOf(cov0 as unknown as Row | null);
    if (!cov0 || !before) {
      return await journaliser({ ...p, outcome: 'UNCHANGED', before: null, after: null, alerts: [], detail: { skipped: 'NO_COVERAGE' }, durationMs: Date.now() - debut });
    }
    // 1. Re-vérification déterministe des pages (texte original persisté) — seulement quand elle est due.
    const { reverificationDue, reverifyStoredCoverage } = await import('./stored-reverification');
    let reverification: Record<string, unknown> | null = null;
    if (reverificationDue({ qualityState: cov0.qualityState, verification: cov0.verification })) {
      const rv = await reverifyStoredCoverage({ accountId: p.accountId, fileId: p.fileId });
      reverification = {
        result: rv.result, reason: rv.reason, qualityBefore: rv.qualityBefore, qualityAfter: rv.qualityAfter,
        pagesVerified: rv.pagesVerified?.length ?? 0, pagesMissing: rv.pagesMissing ?? [], pagesUnverifiable: rv.pagesUnverifiable?.length ?? 0,
        requeued: rv.requeued ?? false,
      };
    }
    // 2. Réconciliation sans IA et règle unique des reprises (écrit seulement si quelque chose change).
    const { reconcileStoredDocumentCoverage } = await import('./stored-reconciliation');
    const rec = await reconcileStoredDocumentCoverage({
      accountId: p.accountId, fileId: p.fileId, apply: true, origin: `t1-coverage-reassessment:v${T1_COVERAGE_RULES_VERSION}`,
    });
    const cov1 = await loadDocumentCoverage(p.fileId, p.accountId);
    const after = snapshotOf(cov1 as unknown as Row | null) ?? before;
    // 3. Alertes de Supervision du document, sur l'état RECALCULÉ.
    const ouvertes = await openAlertsOf(p.fileId);
    const alerts: AlertDecision[] = [];
    for (const kind of ['COMPLETENESS', 'NORMALISATION_LOSS'] as const) {
      const fp = kind === 'COMPLETENESS' ? completenessFingerprint(p.fileId) : normalisationLossFingerprint(p.fileId);
      const decision = alertDecisionOf({
        kind, open: ouvertes.has(fp), deleted: false, qualityState: after.qualityState,
        normalisationLosses: lossesOf(cov1?.verification ?? null), rulesVersion: T1_COVERAGE_RULES_VERSION,
      });
      if (decision) alerts.push(await applyAlertDecision({ accountId: p.accountId, fileId: p.fileId, kind, anomalyId: ouvertes.get(fp) ?? null, decision, coverage: cov1 as unknown as Row | null }));
    }
    const parRegle: Record<string, number> = {};
    for (const q of rec.requalified) parRegle[q.rule ?? 'unknown'] = (parRegle[q.rule ?? 'unknown'] ?? 0) + 1;
    const written = rec.outcome === 'APPLIED' || (reverification !== null && reverification.result !== 'SKIPPED');
    const outcome = reassessmentOutcomeOf({ before, after, requalified: rec.requalified.length, written });
    return await journaliser({
      ...p, outcome, before, after, alerts, durationMs: Date.now() - debut,
      detail: {
        reconciliation: rec.outcome, requalified: rec.requalified.length, requalifiedByRule: parRegle,
        ...(rec.retry ? { retry: { pendingReleased: rec.retry.pendingReleased, actions: rec.retry.actions, blocked: rec.retry.blocked, scheduledBefore: rec.retry.scheduledBefore, scheduledAfter: rec.retry.scheduledAfter } } : {}),
        ...(reverification ? { reverification } : {}),
        aiCalls: 0,
      },
    });
  } catch (e) {
    const error = String((e as Error).message ?? e).slice(0, 500);
    console.error(`[t1-coverage-reassessment] fichier ${p.fileId} :`, error);
    return journaliser({ ...p, outcome: 'ERROR', before, after: null, alerts: [], detail: {}, durationMs: Date.now() - debut, error }).catch(() => ({
      ...p, outcome: 'ERROR' as const, before, after: null, alerts: [], detail: {}, durationMs: Date.now() - debut, error,
    }));
  }
}

/** Écrit (ou complète, pour une erreur retentée) la ligne de journal du document pour la version courante. */
async function journaliser(r: DocumentReassessment): Promise<DocumentReassessment> {
  const { pgClient } = await import('@/db');
  await pgClient.unsafe(
    `INSERT INTO t1_coverage_reassessments (account_id, file_id, rules_version, outcome, state_before, state_after, alerts, detail, error, duration_ms)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)
     ON CONFLICT (file_id, rules_version) DO UPDATE SET
       outcome = EXCLUDED.outcome, state_before = EXCLUDED.state_before, state_after = EXCLUDED.state_after, alerts = EXCLUDED.alerts,
       detail = EXCLUDED.detail, error = EXCLUDED.error, duration_ms = EXCLUDED.duration_ms,
       attempts = t1_coverage_reassessments.attempts + 1, updated_at = NOW()
     WHERE t1_coverage_reassessments.outcome = 'ERROR'`,
    [r.accountId, r.fileId, T1_COVERAGE_RULES_VERSION, r.outcome, JSON.stringify(r.before ?? {}), JSON.stringify(r.after ?? {}),
      JSON.stringify(r.alerts), JSON.stringify(r.detail), r.error ?? null, Math.max(0, Math.trunc(r.durationMs))] as never[],
  );
  return r;
}

/**
 * UN PASSAGE de la campagne (tâche `t1-coverage-reassessment`). Voir l'en-tête.
 * `accountId` : passage limité à un compte (tests, diagnostic).
 */
export async function runCoverageReassessment(opts: {
  deadline?: number; env?: Env; maxBatches?: number; accountId?: number;
} = {}): Promise<ReassessmentPassResult> {
  const debut = Date.now();
  const res: ReassessmentPassResult = {
    rulesVersion: T1_COVERAGE_RULES_VERSION, examined: 0, byOutcome: {}, deferred: 0, errors: 0,
    alertsClosed: 0, alertsMaintained: 0, alertsOpened: 0, orphanAlertsExamined: 0, retriesScheduled: 0, retriesCancelled: 0,
    aiCalls: 0, durationMs: 0, more: false,
  };
  const fin = (extra: Partial<ReassessmentPassResult> = {}): ReassessmentPassResult => ({ ...res, ...extra, durationMs: Date.now() - debut });
  const { coverageProvenanceReady, sourceLayerReady } = await import('./repository');
  if (!(await sourceLayerReady())) return fin({ disabled: 'SOURCE_LAYER_MISSING' });
  // Migration 1665 (lots 113AN / 114G) : sans elle, la réconciliation ne peut pas conserver ses preuves — rien n'est tenté.
  if (!(await coverageProvenanceReady())) return fin({ disabled: 'MIGRATION_1665_MISSING' });
  if (!(await reassessmentJournalReady())) return fin({ disabled: 'MIGRATION_1705_MISSING' });
  const { pgClient } = await import('@/db');
  const lot = batchSize(opts.env);
  const compter = (alerts: readonly AlertDecision[]) => {
    for (const a of alerts) {
      if (a.action === 'CLOSED') res.alertsClosed++; else if (a.action === 'OPENED') res.alertsOpened++; else res.alertsMaintained++;
    }
  };

  // ── A. Documents du stock, par identifiant croissant ─────────────────────
  const vus = new Set<number>();
  let apres = 0;
  for (let n = 0; n < (opts.maxBatches ?? 10_000); n++) {
    if (opts.deadline && Date.now() > opts.deadline) { res.more = true; break; }
    const rows = (await pgClient.unsafe(
      `SELECT c.file_id, c.account_id,
              (c.next_retry_at IS NOT NULL AND c.next_retry_at BETWEEN NOW() - make_interval(mins => $6) AND NOW() + make_interval(mins => $6)) AS reprise_active
         FROM document_extraction_coverage c
         JOIN asset_files af ON af.id = c.file_id AND af.account_id = c.account_id AND af.deleted_at IS NULL
        WHERE c.file_id > $1 AND c.quality_state = ANY($2::text[])
          AND ($7::int IS NULL OR c.account_id = $7)
          -- Analyse en cours : l'analyse écrira elle-même la couverture avec les règles courantes.
          AND af.analysis_state IS DISTINCT FROM 'ANALYZING' AND af.analysis_state IS DISTINCT FROM 'UPLOADED'
          -- Lot 82A (C-Q10) : comptes éligibles seulement (repris à la réactivation).
          AND ${processingEligibleSql('c.account_id')}
          AND NOT EXISTS (SELECT 1 FROM t1_coverage_reassessments j
                           WHERE j.file_id = c.file_id AND j.rules_version = $3 AND (j.outcome <> 'ERROR' OR j.attempts >= $4))
        ORDER BY c.file_id
        LIMIT $5`,
      [apres, [...REASSESSED_QUALITY_STATES], T1_COVERAGE_RULES_VERSION, REASSESSMENT_MAX_ATTEMPTS, lot + 1, RETRY_ACTIVITY_WINDOW_MINUTES, opts.accountId ?? null] as never[],
    )) as unknown as Array<{ file_id: number; account_id: number; reprise_active: boolean }>;
    const plus = rows.length > lot;
    for (const r of rows.slice(0, lot)) {
      apres = Number(r.file_id);
      if (opts.deadline && Date.now() > opts.deadline) { res.more = true; break; }
      // Reprise planifiée en cours ou imminente : `t1-completeness-retry` applique déjà les règles courantes à ce
      // document ; il est repris au passage suivant (aucune écriture concurrente de la même couche).
      if (r.reprise_active) { res.deferred++; res.more = true; continue; }
      const d = await reassessDocumentCoverage({ accountId: Number(r.account_id), fileId: Number(r.file_id) });
      vus.add(Number(r.file_id));
      res.examined++;
      res.byOutcome[d.outcome] = (res.byOutcome[d.outcome] ?? 0) + 1;
      if (d.outcome === 'ERROR') { res.errors++; res.more = true; }
      compter(d.alerts);
      if (d.before && d.after && !d.before.retryScheduled && d.after.retryScheduled) res.retriesScheduled++;
      if (d.before && d.after && d.before.retryScheduled && !d.after.retryScheduled) res.retriesCancelled++;
    }
    if (res.more && opts.deadline && Date.now() > opts.deadline) break;
    if (!plus) break;
    // Nombre de lots du passage atteint alors qu'il reste des documents : le passage suivant reprend.
    if (n + 1 >= (opts.maxBatches ?? 10_000)) res.more = true;
  }

  // ── B. Alertes T1 ouvertes dont le document n'a pas été examiné ci-dessus ─
  //    (document supprimé, couverture complète, compte non éligible) : décision sur l'état COURANT.
  //    Lecture seule tant que rien n'est à clore : parcourue en entier à chaque passage (bornée par l'échéance seulement,
  //    les alertes maintenues restant ouvertes par construction).
  //    Seulement quand A est terminé : jamais une décision sur un document dont le recalcul est encore à venir.
  let apresAlerte = 0;
  while (!res.more) {
    if (opts.deadline && Date.now() > opts.deadline) { res.more = true; break; }
    const alertes = (await pgClient.unsafe(
      `SELECT an.id, an.fingerprint, an.account_id FROM admin_anomalies an
        WHERE an.status = 'open' AND an.id > $1 AND (an.fingerprint LIKE $2 OR an.fingerprint LIKE $3)
          AND ($5::int IS NULL OR an.account_id = $5)
        ORDER BY an.id LIMIT $4`,
      [apresAlerte, `${T1_COVERAGE_ALERT_PREFIXES[0]}%`, `${T1_COVERAGE_ALERT_PREFIXES[1]}%`, lot + 1, opts.accountId ?? null] as never[],
    )) as unknown as Array<{ id: number; fingerprint: string; account_id: number | null }>;
    for (const a of alertes.slice(0, lot)) {
      apresAlerte = Number(a.id);
      const cible = alertTargetOf(String(a.fingerprint));
      // Document examiné en A pendant ce passage : son alerte vient d'être décidée (jamais comptée deux fois).
      if (!cible || vus.has(cible.fileId)) continue;
      res.orphanAlertsExamined++;
      try {
        const [etat] = (await pgClient.unsafe(
          `SELECT af.id AS file, af.account_id, af.deleted_at, c.quality_state AS "qualityState", c.anomalies, c.coverage_ratio::float8 AS "coverageRatio",
                  c.failed_units AS "failedUnits", c.truncated_sections_count AS "truncatedSectionsCount", c.dropped_facts_count AS "droppedFactsCount",
                  to_jsonb(c) -> 'verification' AS verification
             FROM (SELECT $1::int AS id) x
             LEFT JOIN asset_files af ON af.id = x.id
             LEFT JOIN document_extraction_coverage c ON c.file_id = af.id AND c.account_id = af.account_id`,
          [cible.fileId] as never[],
        )) as unknown as Row[];
        const supprime = !etat || etat.file == null || etat.deleted_at != null;
        const decision = alertDecisionOf({
          kind: cible.kind, open: true, deleted: supprime, qualityState: supprime || etat?.qualityState == null ? null : String(etat.qualityState),
          normalisationLosses: supprime ? null : lossesOf(etat?.verification ?? null), rulesVersion: T1_COVERAGE_RULES_VERSION,
        });
        if (!decision) continue;
        const d = await applyAlertDecision({
          accountId: a.account_id == null ? null : Number(a.account_id), fileId: cible.fileId, kind: cible.kind, anomalyId: Number(a.id), decision,
          coverage: supprime ? null : etat ?? null,
        });
        compter([d]);
        if (d.action === 'CLOSED') console.info(`[t1-coverage-reassessment] alerte ${a.id} (${a.fingerprint}) close : ${d.cause}`);
      } catch (e) {
        res.errors++;
        console.error(`[t1-coverage-reassessment] alerte ${a.id} :`, (e as Error).message);
      }
    }
    if (alertes.length <= lot) break;
  }
  return fin();
}

/** Bilan CUMULÉ de la campagne pour une version des règles (lecture du journal — BO). */
export interface ReassessmentReport {
  rulesVersion: number;
  available: boolean;
  documents: number;
  byOutcome: Record<string, number>;
  /** Changements d'état de qualité « avant → après », avec leur nombre. */
  transitions: Array<{ from: string; to: string; documents: number }>;
  unitsRequalified: number;
  alertsClosed: number; alertsMaintained: number; alertsOpened: number;
  retriesScheduled: number; retriesCancelled: number;
  errors: number;
  /** Documents du stock encore à examiner pour cette version (comptes éligibles ou non). */
  remaining: number;
  /** Alertes T1 de couverture encore ouvertes en Supervision. */
  openAlerts: number;
  totalDurationMs: number;
  /** Toujours 0 : la campagne n'appelle aucun modèle ; coût IA nul. */
  aiCalls: 0;
  aiCost: 0;
  firstAt: string | null; lastAt: string | null;
}

export async function getCoverageReassessmentReport(rulesVersion: number = T1_COVERAGE_RULES_VERSION): Promise<ReassessmentReport> {
  const vide: ReassessmentReport = {
    rulesVersion, available: false, documents: 0, byOutcome: {}, transitions: [], unitsRequalified: 0, alertsClosed: 0, alertsMaintained: 0,
    alertsOpened: 0, retriesScheduled: 0, retriesCancelled: 0, errors: 0, remaining: 0, openAlerts: 0, totalDurationMs: 0, aiCalls: 0, aiCost: 0,
    firstAt: null, lastAt: null,
  };
  if (!(await reassessmentJournalReady())) return vide;
  const { pgClient } = await import('@/db');
  const q = async (sql: string, params: unknown[]) => (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];
  const [parIssue, transitions, [tot], [reste], [ouvertes], [closes]] = await Promise.all([
    q(`SELECT outcome, COUNT(*)::int AS n FROM t1_coverage_reassessments WHERE rules_version = $1 GROUP BY outcome`, [rulesVersion]),
    q(`SELECT state_before ->> 'qualityState' AS de, state_after ->> 'qualityState' AS vers, COUNT(*)::int AS n
         FROM t1_coverage_reassessments
        WHERE rules_version = $1 AND outcome <> 'ERROR' AND state_before ->> 'qualityState' IS DISTINCT FROM state_after ->> 'qualityState'
        GROUP BY 1, 2 ORDER BY n DESC, 1, 2`, [rulesVersion]),
    q(`SELECT COUNT(*)::int AS documents, COALESCE(SUM(duration_ms), 0)::float8 AS duree, MIN(created_at) AS debut, MAX(updated_at) AS fin,
              COALESCE(SUM(CASE WHEN jsonb_typeof(detail -> 'requalified') = 'number' THEN (detail ->> 'requalified')::int END), 0)::int AS requalifiees,
              COALESCE(SUM((SELECT COUNT(*) FROM jsonb_array_elements(alerts) a WHERE a ->> 'action' = 'MAINTAINED')), 0)::int AS maintenues,
              COALESCE(SUM((SELECT COUNT(*) FROM jsonb_array_elements(alerts) a WHERE a ->> 'action' = 'OPENED')), 0)::int AS ouvertes,
              COUNT(*) FILTER (WHERE state_before ->> 'retryScheduled' = 'false' AND state_after ->> 'retryScheduled' = 'true')::int AS programmees,
              COUNT(*) FILTER (WHERE state_before ->> 'retryScheduled' = 'true' AND state_after ->> 'retryScheduled' = 'false')::int AS retirees
         FROM t1_coverage_reassessments WHERE rules_version = $1`, [rulesVersion]),
    q(`SELECT COUNT(*)::int AS n FROM document_extraction_coverage c
         JOIN asset_files af ON af.id = c.file_id AND af.deleted_at IS NULL
        WHERE c.quality_state = ANY($2::text[])
          AND NOT EXISTS (SELECT 1 FROM t1_coverage_reassessments j WHERE j.file_id = c.file_id AND j.rules_version = $1 AND (j.outcome <> 'ERROR' OR j.attempts >= $3))`,
    [rulesVersion, [...REASSESSED_QUALITY_STATES], REASSESSMENT_MAX_ATTEMPTS]),
    q(`SELECT COUNT(*)::int AS n FROM admin_anomalies WHERE status = 'open' AND (fingerprint LIKE $1 OR fingerprint LIKE $2)`,
      [`${T1_COVERAGE_ALERT_PREFIXES[0]}%`, `${T1_COVERAGE_ALERT_PREFIXES[1]}%`]),
    // Clôtures de la campagne, lues sur les anomalies elles-mêmes (documents examinés ET alertes sans document éligible).
    q(`SELECT COUNT(*)::int AS n FROM admin_anomalies WHERE status = 'resolved' AND auto_resolution_origin = $1`,
      [`t1_coverage_reassessment:v${rulesVersion}`]),
  ]);
  const byOutcome: Record<string, number> = {};
  for (const r of parIssue) byOutcome[String(r.outcome)] = Number(r.n);
  const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
  return {
    rulesVersion, available: true, documents: Number(tot?.documents ?? 0), byOutcome,
    transitions: transitions.map((t) => ({ from: String(t.de ?? '—'), to: String(t.vers ?? '—'), documents: Number(t.n) })),
    unitsRequalified: Number(tot?.requalifiees ?? 0), alertsClosed: Number(closes?.n ?? 0), alertsMaintained: Number(tot?.maintenues ?? 0),
    alertsOpened: Number(tot?.ouvertes ?? 0), retriesScheduled: Number(tot?.programmees ?? 0), retriesCancelled: Number(tot?.retirees ?? 0),
    errors: Number(byOutcome.ERROR ?? 0), remaining: Number(reste?.n ?? 0), openAlerts: Number(ouvertes?.n ?? 0),
    totalDurationMs: Number(tot?.duree ?? 0), aiCalls: 0, aiCost: 0, firstAt: iso(tot?.debut), lastAt: iso(tot?.fin),
  };
}
