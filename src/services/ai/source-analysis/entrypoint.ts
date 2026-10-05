/**
 * Point d'entrée unique de l'usage IA n°1 (analyse des sources) — CDC §10.1,
 * §10.3 et §10.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL MOTEUR DEPUIS LE LOT 16b-3
 *
 * L'aiguillage `AI_UNIFIED_SOURCE_ANALYSIS` (moteur historique
 * `document-ai/unified-analysis-pipeline` ↔ pipeline unifié) et le
 * commutateur `AI_T1_ANALYSIS_MODE` (étapes / observation / master) sont
 * retirés : toute analyse passe par `runSourceAnalysis`, prompt maître T1.
 *
 * Les appelants (dépôt, analyse par lot, reprise, analyse rétroactive,
 * webhook de facturation, déplacement en masse, changement de bien,
 * analyse directe, montée de référentiel) continuent de passer par ces
 * fonctions, jamais par le pipeline directement (`ai:check-legacy`,
 * critère 24) : quota, déduplication, garde de file et reprise des échecs
 * restent tenus à un seul endroit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ÉCHEC DU MASTER : REPRISE PAR LA FILE DURABLE, JAMAIS DE REPLI
 *
 * Plus de chemin « étapes » vers lequel se replier. Une source dont l'analyse
 * échoue est mise en `ANALYSIS_FAILED` avec son motif par le pipeline
 * (`failedSourceIds`), sans crédit consommé, puis :
 *   · sous la file (garde présente) : `t1-handler` fait échouer le job, la
 *     file le reprend avec son backoff (MOD-005) ; au dernier essai, l'état
 *     d'échec motivé reste affiché (tiroir, bandeau) ;
 *   · hors file (analyse directe, changement de bien…) : la source est remise
 *     en file durable (`enqueueFileAnalyses`, après un premier délai de
 *     backoff), avec la même règle de facturation que la demande initiale —
 *     un seul crédit à la réussite, aucun pour les essais en échec.
 * Un échec DÉFINITIF (sortie du master invalide sur toute la chaîne) n'a droit
 * qu'à une reprise, puis n'est plus relancé automatiquement
 * (`failure-policy`, revue 3a). Une ligne `asset_files` qui est un lien web
 * est analysée par l'adaptateur lien web (`runRouted`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { SourceType } from './types';
import type { RunSourceAnalysisOutput } from './pipeline';
import { isExecutionCancelled, type ExecutionGuard } from '../queue/execution-control';
import { REQUEUE_ORIGIN_SUFFIX } from './failure-policy';
import { isCostCapReached } from '../gateway/errors';

export interface AnalyzeFileSourcesOptions {
  /** Déduit du premier fichier si absent — l'ancienne signature ne le portait pas. */
  userId?: number;
  linkedAssetId?: number | null;
  /** false pour une reprise technique : ne consomme pas de crédit d'analyse. */
  billable?: boolean;
  /** Appelant, journalisé (et repris dans l'origine d'une remise en file). */
  origin?: string;
  /**
   * Type de source à préparer. `'file'` par défaut — aucun des neuf appelants
   * existants n'a à changer.
   *
   * ══════════════════════════════════════════════════════════════════════
   * POURQUOI CE PARAMÈTRE EXISTE
   *
   * Le corpus de mesure appelait `AiGateway` directement : il ne traversait
   * jamais le pipeline complet (regroupement, projection, persistance).
   *
   * Le type était écrit en dur plus bas. L'ouvrir permet au corpus de
   * passer par le pipeline COMPLET, en servant ses fixtures par un
   * adaptateur dédié.
   *
   * Il reste hors du chemin de production : aucun appelant applicatif ne le
   * renseigne, et `'future_source'` n'est enregistré que le temps d'une
   * campagne.
   * ══════════════════════════════════════════════════════════════════════
   */
  sourceType?: SourceType;
  /**
   * Garde d'exécution de la file durable (annulation par rollback, arrêt
   * d'urgence, désactivation). Absente hors file.
   */
  guard?: ExecutionGuard;
  /**
   * Hors file : remettre en file durable les sources dont l'analyse a échoué
   * (défaut `true`). `false` pour une mesure (corpus) qui constate l'échec
   * sans rien relancer.
   */
  retryOnFailure?: boolean;
}

/**
 * Analyse un ou plusieurs fichiers. Seul point d'entrée autorisé depuis le code
 * applicatif.
 *
 * Ne lève jamais hors file — la plupart des appelants sont en « fire and
 * forget » et une exception y serait perdue, ou pire, remonterait dans une
 * réponse HTTP déjà envoyée. Sous garde de file, une panne inattendue remonte
 * à la file (reprise avec backoff).
 */
export async function analyzeFileSources(
  fileIds: number[],
  accountId: number,
  options: AnalyzeFileSourcesOptions = {},
): Promise<RunSourceAnalysisOutput | null> {
  if (fileIds.length === 0 || !accountId) return null;

  const outcome = await runRouted(fileIds, accountId, options);

  // Hors file : les sources en échec sont confiées à la file durable.
  if (
    outcome && outcome.failedSourceIds.length > 0
    && !options.guard && options.retryOnFailure !== false
    // La file T1 ne reçoit que des lignes `asset_files` (fichiers et liens
    // web, aiguillés à l'exécution) : une source d'un autre type (adaptateur
    // de corpus) n'y est jamais confiée.
    && (options.sourceType === undefined || options.sourceType === 'file')
  ) {
    await requeueFailedSources(outcome.failedSourceIds, accountId, options);
  }

  // Lot 22 — hors file, plafond mensuel de coût IA du compte atteint : rien
  // n'a été lancé. Les fichiers sont confiés à la file durable, différés au
  // début de la période suivante (même facturation que la demande) : ils
  // seront analysés automatiquement le 1er, sans relance entre-temps.
  if (
    outcome?.costCap && (outcome.costCapSourceIds?.length ?? 0) > 0
    && !options.guard && options.retryOnFailure !== false
    && (options.sourceType === undefined || options.sourceType === 'file')
  ) {
    // Contrôle préalable (toutes les sources) ou plafond franchi en cours
    // d'analyse (groupe en cours et suivants) : même chemin.
    await deferToNextPeriod(outcome.costCapSourceIds!, accountId, options, outcome.costCap.resumeAt);
  }
  return outcome;
}

/** Remise en file durable, différée au début de la période suivante (plafond de coût). */
async function deferToNextPeriod(
  ids: number[],
  accountId: number,
  options: AnalyzeFileSourcesOptions,
  resumeAt: string,
): Promise<void> {
  try {
    const [{ enqueueFileAnalyses }, { costCapAnalysisReason }, { and, eq, inArray }] = await Promise.all([
      import('./queue/t1-handler'),
      import('../gateway/account-cost-cap'),
      import('drizzle-orm'),
    ]);
    const until = new Date(resumeAt);
    const acceptes = await enqueueFileAnalyses(ids, accountId, {
      userId: options.userId,
      origin: options.origin ?? 'inconnue',
      ...(options.billable === false ? { billable: false } : {}),
      // Même marge de 60 s que `deferJobUntil`.
      delaySeconds: Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000) + 60),
      costCapDeferredUntil: until.toISOString(),
    });
    // Motif lisible (tiroir du document) : « en file », reprise le 1er.
    await db.update(assetFiles)
      .set({ analysisFailReason: costCapAnalysisReason(until), updatedAt: new Date() })
      .where(and(inArray(assetFiles.id, ids), eq(assetFiles.accountId, accountId), eq(assetFiles.analysisState, 'UPLOADED')));
    console.info(
      `[source-analysis] plafond IA du compte ${accountId} atteint : ${acceptes.length}/${ids.length} source(s) `
      + `reportée(s) au ${until.toISOString()} (origine : ${options.origin ?? 'inconnue'}).`,
    );
  } catch (e) {
    // La reprise serveur (`analysis-recovery`) retrouvera ces sources à la période suivante.
    console.error('[source-analysis] report des sources (plafond IA) impossible :', (e as Error).message);
  }
}

/** Remise en file durable des sources en échec d'une analyse hors file. */
async function requeueFailedSources(
  ids: number[],
  accountId: number,
  options: AnalyzeFileSourcesOptions,
): Promise<void> {
  try {
    const [{ enqueueFileAnalyses }, { backoffSeconds }] = await Promise.all([
      import('./queue/t1-handler'),
      import('../queue/queue-policy'),
    ]);
    const acceptes = await enqueueFileAnalyses(ids, accountId, {
      userId: options.userId,
      origin: `${options.origin ?? 'inconnue'}${REQUEUE_ORIGIN_SUFFIX}`,
      // Même règle que la demande initiale : rien n'a été consommé pour l'essai
      // en échec, la réussite consommera un seul crédit (ou aucun si la
      // demande n'était pas facturable).
      ...(options.billable === false ? { billable: false } : {}),
      delaySeconds: backoffSeconds(1),
    });
    console.info(
      `[source-analysis] ${acceptes.length}/${ids.length} source(s) en échec remise(s) en file durable `
      + `(origine : ${options.origin ?? 'inconnue'}).`,
    );
  } catch (e) {
    // La reprise serveur (`analysis-recovery`) retrouvera l'état ANALYSIS_FAILED.
    console.error('[source-analysis] remise en file des sources en échec impossible :', (e as Error).message);
  }
}

/**
 * Revue 3a (point 3) : une ligne `asset_files` peut être un LIEN WEB
 * (`is_web_link`). Sans type explicite, chaque lien est analysé par
 * l'adaptateur lien web (téléchargement de la page) et les fichiers par
 * l'adaptateur fichier — quel que soit l'appelant (dépôt, file durable,
 * reprise serveur, réanalyse depuis le tiroir). Avant, un lien repris comme
 * fichier était analysé SANS contenu (type `application/x-web-link` non lu)
 * et ses preuves antérieures retirées.
 */
async function runRouted(
  fileIds: number[],
  accountId: number,
  options: AnalyzeFileSourcesOptions,
): Promise<RunSourceAnalysisOutput | null> {
  if (options.sourceType !== undefined) return runUnified(fileIds, accountId, options);
  let liens = new Set<number>();
  try {
    const { inArray } = await import('drizzle-orm');
    const rows = await db.select({ id: assetFiles.id, isWebLink: assetFiles.isWebLink })
      .from(assetFiles).where(inArray(assetFiles.id, fileIds));
    liens = new Set(rows.filter((r) => r.isWebLink).map((r) => r.id));
  } catch (e) {
    console.error('[source-analysis] type des sources illisible — analysées comme fichiers :', (e as Error).message);
  }
  if (liens.size === 0) return runUnified(fileIds, accountId, options);

  const fichiers = fileIds.filter((id) => !liens.has(id));
  const issues: Array<RunSourceAnalysisOutput | null> = [];
  if (fichiers.length > 0) issues.push(await runUnified(fichiers, accountId, options));
  for (const id of fileIds.filter((x) => liens.has(x))) {
    issues.push(await runUnified([id], accountId, { ...options, sourceType: 'web_link' }));
  }
  return mergeOutcomes(issues);
}

/** Issue combinée : `null` seulement si toutes les exécutions ont échoué. */
function mergeOutcomes(issues: Array<RunSourceAnalysisOutput | null>): RunSourceAnalysisOutput | null {
  const ok = issues.filter((i): i is RunSourceAnalysisOutput => i !== null);
  if (ok.length === 0) return null;
  return {
    results: ok.flatMap((i) => i.results),
    analysedCount: ok.reduce((n, i) => n + i.analysedCount, 0),
    failedSourceIds: ok.flatMap((i) => i.failedSourceIds),
    definitiveFailedSourceIds: ok.flatMap((i) => i.definitiveFailedSourceIds ?? []),
    ...(ok.length === issues.length && ok.every((i) => i.skippedReason) ? { skippedReason: ok[0].skippedReason } : {}),
    ...(ok.find((i) => i.costCap)?.costCap ? {
      costCap: ok.find((i) => i.costCap)!.costCap,
      costCapSourceIds: ok.flatMap((i) => i.costCapSourceIds ?? []),
    } : {}),
  };
}

async function runUnified(
  fileIds: number[],
  accountId: number,
  options: AnalyzeFileSourcesOptions,
): Promise<RunSourceAnalysisOutput | null> {
  try {
    const userId = options.userId ?? (await resolveUserId(fileIds[0]));
    if (!userId) {
      console.warn(`[source-analysis] Aucun utilisateur résolu pour le fichier ${fileIds[0]} — abandon.`);
      return null;
    }

    const { runSourceAnalysis } = await import('./pipeline');
    const outcome = await runSourceAnalysis({
      sourceType: options.sourceType ?? 'file',
      sourceIds: fileIds,
      accountId,
      userId,
      linkedAssetId: options.linkedAssetId ?? null,
      billable: options.billable,
      guard: options.guard,
    });

    if (outcome.skippedReason) {
      console.info(
        `[source-analysis] ${fileIds.length} fichier(s) non analysé(s) ` +
        `(${outcome.skippedReason}) — origine : ${options.origin ?? 'inconnue'}.`,
      );
    }
    return outcome;
  } catch (e) {
    // Une interruption n'est pas un échec : elle remonte à la file, qui ne
    // clôt pas le job (déjà remis en attente pour une reprise propre).
    if (isExecutionCancelled(e)) throw e;
    // Lot 22 : plafond IA du compte franchi pendant une analyse EN FILE — la
    // file reporte le job au 1er (le pipeline ne lève ce refus que sous garde).
    if (options.guard && isCostCapReached(e)) throw e;
    console.error(
      `[source-analysis] Échec du pipeline d'analyse (origine : ${options.origin ?? 'inconnue'}) :`,
      (e as Error).message,
    );
    // Sous la file : la panne remonte, la file reprend le job (backoff).
    if (options.guard) throw e;
    return null;
  }
}

/**
 * Analyse un lien web. Second point d'entrée autorisé (§4.1.7 : un lien web
 * produit les mêmes informations qu'un document). La route rend l'issue à
 * l'utilisateur ; une source en échec reste `ANALYSIS_FAILED`, relançable.
 */
export async function analyzeWebLinkSource(
  webLinkId: number,
  accountId: number,
  options: { userId: number },
): Promise<RunSourceAnalysisOutput> {
  const { runSourceAnalysis } = await import('./pipeline');
  return runSourceAnalysis({
    sourceType: 'web_link',
    sourceIds: [webLinkId],
    accountId,
    userId: options.userId,
  });
}

async function resolveUserId(fileId: number): Promise<number | null> {
  const [row] = await db
    .select({ userId: assetFiles.userId })
    .from(assetFiles)
    .where(eq(assetFiles.id, fileId))
    .limit(1);
  return row?.userId ?? null;
}

/**
 * Abonne un flux SSE à la progression d'analyse d'un fichier (registre du
 * pipeline, `stream/broadcast`). Lot 16b-3 : le second registre, celui du
 * moteur historique, a disparu avec lui.
 */
export async function registerAnalysisStreamWriter(
  assetFileId: number,
  writer: (data: Record<string, unknown>) => void,
): Promise<() => void> {
  const { registerStreamWriter } = await import('./stream/broadcast');
  return registerStreamWriter(assetFileId, writer);
}
