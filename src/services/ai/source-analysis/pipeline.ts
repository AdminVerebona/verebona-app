/**
 * Pipeline commun d'analyse unifiée des sources — USAGE IA n°1.
 *
 * Implémente les quatorze étapes du CDC §4.1.4. Remplace
 * `document-ai/unified-analysis-pipeline.ts`, `web-links/[id]/analyze` et le
 * chaînage d'appels post-analyse constaté à l'audit.
 *
 * TROIS CORRECTIONS STRUCTURELLES PAR RAPPORT À L'EXISTANT
 *
 *  1. Plus aucun appel IA en cascade après l'analyse (défaut n°1). L'ancien
 *     pipeline appelait la complétion des champs vides, `linkDocumentToEquipments`
 *     puis, une heure plus tard, l'enrichissement-cohérence : jusqu'à cinq appels
 *     modèles pour un seul dépôt. Ici, l'analyse ÉMET un événement ; la
 *     réconciliation décide seule.
 *
 *  2. Les fichiers secondaires d'un groupe ne sont supprimés qu'APRÈS
 *     persistance complète et succès des rattachements (§4.1.7). L'ancien code
 *     les effaçait dès l'état `ANALYZED`, avant les rattachements.
 *
 *  3. Le résultat est identique pour un fichier et pour un lien web
 *     (critère d'acceptation n°6).
 */
import { isDefinitiveGatewayFailure, userFacingFailReason, MAX_ANALYSIS_RETRIES } from './failure-policy';
import { buildKnowledgeFromSourceAnalysis } from '../knowledge/document-knowledge';
import { persistDocumentKnowledgeDetailed } from '../knowledge/document-knowledge.service';
import { T1ExecutionRecorder, collectAttemptTraces, writeT1Report } from '../execution-report/t1-report';
import {
  ensureRawExtract, markOcr, markPersistence, markStructuring, persistenceOutcome, type RawExtractOutcome,
} from './raw-extract/raw-extract.service';
import { buildOcrPages } from './raw-extract/ocr-pages';
import { applyReliableFacts } from './steps/apply-reliable-facts.step';
import { currentJobContext } from '../queue/job-context';
import { db } from '@/db';
import { assetFiles, assets, substructures, equipments, documentLots, documentLotItems } from '@/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { canConsumeAnalysis, consumeAnalysisCredits } from '@/services/commercial-model.service';

import { getSourceAdapter } from './adapters';
import { loadAssetFamilies } from './master/rubric-rules';
import { applyV2Classification } from '@/services/documents/apply-v2-classification.service';

/**
 * Version du pipeline, consignée avec chaque correction utilisateur.
 *
 * Sans elle, le signal d'échec du §5.2 est inexploitable : on saurait que le
 * modèle s'est trompé, jamais quelle version s'est trompée — donc jamais si
 * une évolution a corrigé le défaut ou l'a aggravé.
 */
const PIPELINE_VERSION = 'source-analysis-v1';

/** Préfixe du motif de report pour plafond (`account-cost-cap#costCapAnalysisReason`). */
const COST_CAP_REASON_PREFIX = 'Plafond IA du mois atteint';

import { buildAgendaCandidatesT4, attachEvidenceToCandidates } from './steps/build-agenda-candidates.step';
import { describeEvidenceWriteErrors, persistProjectedFacts } from './steps/persist-evidence.step';
import {
  computeInputHash, finalizeRunWrites, loadReplayableRun, persistAnalysisResult,
} from './persistence/analysis-result.repository';
import { titleInputsFromAnalysis } from './document-title';
import { ensureBusinessTitle } from '@/services/documents/document-title.service';
import { notifyLotCompleted } from './lot-notification';
import { broadcast } from './stream/broadcast';
import { emitSourceAnalyzed } from './events';
import type {
  SourceInput, SourceType, SourceAnalysisResult, AnalysisContext,
} from './types';
import { isExecutionCancelled, type ExecutionGuard } from '../queue/execution-control';
import { isCostCapReached, costCapResumeAt, isAiSuspended } from '../gateway/errors';
import { AI_SUSPENSION_USER_REASON } from '../queue/queue-policy';
import { markSourcesGrouped } from '@/services/documents/grouped-sources';
// Prompt maître T1 — seul moteur depuis le lot 16b-3 (CDC 15 §23, §29).
import { analyseGroupWithMaster, type MasterGroupAnalysis } from './master/analyse-group-master';
import { enqueueT3ForAffectedAssets, enqueueT3ForAffectedEntities } from './master/reconciliation-fanout';
import { computeMasterDocumentLinks, writeMasterDocumentLinks } from './master/document-links';
import { syncDocumentRulesFromAnalysis } from '@/services/to-process/document-rule-bridge';
import { groupUpload } from './steps/group-upload.step';
import { loadAssetIdentifiers } from '../reconciliation/document-asset/asset-identifiers.repository';
import { automaticColumnAssetOf, userChosenAssetOf } from '../reconciliation/document-asset/attachment-state';
import { closeAssetLinkQuestion, writeAutomaticPrimaryColumn } from '../reconciliation/document-asset/automatic-attachment';

interface RunSourceAnalysisInput {
  sourceType: SourceType;
  sourceIds: number[];
  accountId: number;
  userId: number;
  linkedAssetId?: number | null;
  /** Consommer un crédit d'analyse. false pour une réanalyse technique. */
  billable?: boolean;
  /**
   * Garde d'exécution (file durable). Contrôlée avant chaque écriture
   * significative : une exécution interrompue par un rollback, un arrêt
   * d'urgence ou une désactivation n'écrit plus aucun résultat — même si
   * l'appel IA répond après l'interruption.
   */
  guard?: ExecutionGuard;
  /**
   * Lot 81E : hors file, l'appelant remet-il en file durable les sources en
   * échec (`entrypoint`, défaut oui) ? Sert seulement à ne pas annoncer comme
   * définitif un échec qui va être repris automatiquement.
   */
  retryOnFailure?: boolean;
}

export interface RunSourceAnalysisOutput {
  results: SourceAnalysisResult[];
  analysedCount: number;
  skippedReason?: 'quota' | 'already_running' | 'no_valid_source' | 'cost_cap';
  /**
   * Lot 22 — `skippedReason: 'cost_cap'` : plafond mensuel de coût IA du
   * compte atteint, analyse NON lancée (aucun état touché, aucun crédit).
   * `resumeAt` : début de la période suivante, où le travail est repris.
   */
  costCap?: { resumeAt: string; capMicros: number; spentMicros: number };
  /**
   * Lot 22 — sources NON analysées pour plafond (contrôle préalable : toutes ;
   * plafond franchi en cours d'analyse hors file : le groupe en cours et les
   * suivants). Remises « en file » avec le motif, jamais en échec ; l'appelant
   * hors file les confie à la file durable au 1er.
   */
  costCapSourceIds?: number[];
  /**
   * Lot 87A (CDC Pilotage IA V2 P7, RUN-02) — HORS FILE seulement : sources
   * NON analysées parce que la passerelle a SUSPENDU l'exécution (aucun
   * secours admissible). Jamais en échec, aucune écriture métier : remises
   * « en file » avec le motif ; l'appelant les confie à la file durable, qui
   * les reprend depuis un point sûr. Sous la file, la suspension remonte au
   * boucleur (`queue-worker`, `suspendJobForAi`).
   */
  aiSuspendedSourceIds?: number[];
  /** Lot 87A : cause établie et message de la suspension (`AiSuspendedError`). */
  aiSuspension?: { cause: string; message: string };
  /**
   * Sources dont l'analyse a ÉCHOUÉ pendant cette exécution (master T1 en
   * échec sur toute sa chaîne de modèles, sortie inexploitable, persistance
   * impossible…) : état `ANALYSIS_FAILED` écrit, motif conservé, aucun crédit
   * consommé. Lot 16b-3 : plus de repli « étapes » — la reprise passe par la
   * file durable (`entrypoint#analyzeFileSources`, `t1-handler`).
   */
  failedSourceIds: number[];
  /**
   * Parmi `failedSourceIds` : échecs DÉFINITIFS (sortie du master invalide sur
   * toute la chaîne, prompt maître invalide — `failure-policy`). Au plus une
   * reprise, jamais relancés par la reprise serveur.
   */
  definitiveFailedSourceIds?: number[];
}

/**
 * Point d'entrée unique de l'usage 1. Toute source, quelle qu'elle soit, passe
 * par ici : il n'existe aucune autre voie d'analyse dans l'application.
 */
export async function runSourceAnalysis(
  req: RunSourceAnalysisInput,
): Promise<RunSourceAnalysisOutput> {
  // ── Étape 1 : contrôle d'accès et appartenance ──────────────────────────
  const ownedIds = await filterOwnedSources(req.sourceIds, req.accountId);
  if (ownedIds.length === 0) {
    return { results: [], analysedCount: 0, skippedReason: 'no_valid_source', failedSourceIds: [] };
  }

  // Déduplication : ne pas relancer une analyse déjà en cours (§5.7).
  //
  // Sous garde de file, l'exécution est titulaire exclusive du job (jeton) :
  // un état ANALYZING laissé par une exécution interrompue ou abandonnée ne
  // doit pas empêcher sa reprise propre.
  const pendingIds = req.guard ? ownedIds : await excludeInProgress(ownedIds);
  if (pendingIds.length === 0) {
    return { results: [], analysedCount: 0, skippedReason: 'already_running', failedSourceIds: [] };
  }

  // Quota : vérifié avant tout appel facturable.
  if (req.billable !== false) {
    const gate = await canConsumeAnalysis(req.accountId, pendingIds.length);
    if (!gate.allowed) return { results: [], analysedCount: 0, skippedReason: 'quota', failedSourceIds: [] };
  }

  // Lot 22 — plafond mensuel de coût IA du compte : contrôlé AVANT d'ouvrir
  // le lot et de passer les sources en ANALYZING (la passerelle refuserait de
  // toute façon chaque appel). Rien n'est écrit : l'appelant reporte (file
  // durable) ou remet en file au 1er (hors file). Un plafond franchi PENDANT
  // l'analyse est refusé par la passerelle (`COST_CAP_REACHED`).
  {
    const { costCapReachedFor } = await import('../gateway/account-cost-cap');
    const cap = await costCapReachedFor(req.accountId);
    if (cap) {
      return {
        results: [], analysedCount: 0, skippedReason: 'cost_cap', failedSourceIds: [],
        costCap: { resumeAt: cap.resumeAt.toISOString(), capMicros: cap.capMicros, spentMicros: cap.spentMicros },
        costCapSourceIds: pendingIds,
      };
    }
  }

  const guard = req.guard;
  await guard?.assertActive('ouverture du lot');
  const lotId = await openLot(req.accountId, pendingIds, req.userId);
  await setState(pendingIds, 'ANALYZING');

  // ── Étapes 2 et 3 : qualification et préparation par l'adaptateur ───────
  const adapter = getSourceAdapter(req.sourceType);
  let input: SourceInput;
  try {
    input = await adapter.prepare({
      sourceIds: pendingIds,
      accountId: req.accountId,
      userId: req.userId,
      linkedAssetId: req.linkedAssetId,
    });
  } catch (e) {
    await failSources(pendingIds, (e as Error).message, lotId);
    return { results: [], analysedCount: 0, skippedReason: 'no_valid_source', failedSourceIds: [] };
  }
  // Lot 31B (ticket T1, §7, T1-LINK-06 / 08) — KNOWN_TARGET = choix HUMAIN :
  //   · une colonne `asset_id` posée AUTOMATIQUEMENT par une analyse
  //     précédente (marque `assetIdAuto`) n'en est pas un : une nouvelle
  //     analyse certaine peut la déplacer ;
  //   · un lien N-N USER PRIMARY (sans colonne) en est un — T1 ne le
  //     remplace jamais silencieusement.
  if (input.sourceIds.length > 0) {
    const lead = input.sourceIds[0];
    if (!req.linkedAssetId && input.linkedAssetId) {
      const auto = await automaticColumnAssetOf(req.accountId, lead).catch(() => null);
      if (auto !== null && auto === input.linkedAssetId) input.linkedAssetId = null;
    }
    if (!input.linkedAssetId) {
      input.linkedAssetId = await userChosenAssetOf(req.accountId, lead).catch(() => null);
    }
  }
  // Lot 49 (SEC-08, T1) : revalidation SERVEUR du périmètre, indépendante de
  // l'adaptateur et de l'appelant (job ancien ou relancé, `linkedAssetId`
  // transmis) — KNOWN_TARGET d'un autre compte : ignoré, jamais projeté.
  if (input.linkedAssetId) {
    const { knownAssetOfAccount } = await import('@/services/security/account-ownership');
    input.linkedAssetId = await knownAssetOfAccount(req.accountId, input.linkedAssetId, 't1.known_target');
  }

  // ══════════════════════════════════════════════════════════════════════
  // PROMPT MAÎTRE T1 SEUL — lot 16b-3 (CDC 15 §29, D-04)
  //
  // GROUP_UPLOAD puis ANALYZE_DOCUMENT par groupe, projection déterministe,
  // faits écrits sur LEUR cible. Plus d'étapes historiques, plus de mode
  // observation, plus de repli : un échec du master (toute sa chaîne de
  // modèles, sortie inexploitable) met les sources du groupe en
  // `ANALYSIS_FAILED` avec leur motif (`failSources`) — jamais d'analyse
  // partielle ni de perte silencieuse. La nouvelle tentative passe par la
  // file durable (backoff, `t1-handler`) ; aucun crédit n'est consommé pour
  // un groupe en échec.
  // ══════════════════════════════════════════════════════════════════════

  // ── Étape 4 : regroupement (interne, jamais un usage) ───────────────────
  const { groups, trace: groupTrace } = await groupUpload(input);

  const ctx = await loadAnalysisContext(req.accountId, input.linkedAssetId ?? null);

  // ── Étapes 5 à 12, par groupe ───────────────────────────────────────────
  const results: SourceAnalysisResult[] = [];
  const failedSourceIds: number[] = [];
  const definitiveFailedSourceIds: number[] = [];
  let analysedCount = 0;
  // Lot 22 : plafond franchi en cours d'analyse (hors file) — groupe en cours
  // et suivants non analysés, remis « en file » avec le motif.
  let plafond: { resumeAt: Date; capMicros: number; spentMicros: number; sourceIds: number[] } | null = null;
  // Lot 87A : suspension IA hors file (aucun secours admissible) — groupe en
  // cours et suivants non analysés, remis « en file » avec le motif.
  let suspendues: { ids: number[]; cause: string; message: string } | null = null;

  for (const [gi, groupIndices] of groups.entries()) {
    const leadSourceId = input.sourceIds[groupIndices[0]];
    const groupSourceIds = groupIndices.map((i) => input.sourceIds[i]);

    broadcast(leadSourceId, { type: 'progress', stage: 'extraction' });

    // Lot 58C : rapport d'exécution du document (étapes, déclaré, écritures relues).
    const rec = new T1ExecutionRecorder();
    // Lot 61 (ticket T1 §3, §6) : phase EXTRACTION — extract brut déterministe
    // de chaque fichier du groupe, écrit AVANT le modèle et conservé quel que
    // soit le sort de la structuration ; réutilisé à la reprise (aucune
    // ré-extraction). Lot 75C (A) : un extract non ENREGISTRÉ n'est plus
    // ignoré — étape bloquante `RAW_EXTRACT` en échec (la structuration se
    // poursuit : ce qui peut être écrit l'est ; le document n'est jamais
    // déclaré analysé, la reprise réécrit l'extract sans rappeler Gemini).
    const rawOutcomes: RawExtractOutcome[] = [];
    if (input.sourceType === 'file') {
      const jobId = currentJobContext()?.jobId ?? null;
      for (const i of groupIndices) {
        const r = await ensureRawExtract({
          accountId: input.accountId, fileId: input.sourceIds[i], url: input.contentUrls?.[i], mimeType: input.mimeTypes[i] ?? null, jobId,
        });
        rawOutcomes.push(r);
        if (r.summary) rec.rawExtracts.push(r.summary);
      }
      const manquants = rawOutcomes.filter((r) => !r.summary);
      if (manquants.length) {
        rec.fail('RAW_EXTRACT', manquants.map((r) => `fichier ${r.fileId} : ${r.error ?? 'non enregistré'}`).join(' · '),
          { files: manquants.map((r) => ({ fileId: r.fileId, error: r.error })) });
      } else {
        rec.ok('RAW_EXTRACT', { files: rawOutcomes.map((r) => ({ fileId: r.fileId, status: r.summary!.status, reused: r.summary!.reused, identity: r.summary!.identity })) });
      }
      await markStructuring(groupSourceIds, input.accountId, 'RUNNING');
    }
    try {
      let master: MasterGroupAnalysis;
      // Lot 75C (F) : écritures d'une analyse précédente inachevées (même
      // entrée, même contenu) → sa sortie STRUCTURÉE est rejouée, Gemini
      // n'est pas rappelé.
      const rejeu = await replayableMaster(input, leadSourceId, groupSourceIds, rawOutcomes);
      if (rejeu) {
        master = rejeu.master;
      } else {
        try {
          master = await analyseGroupWithMaster(input, groupIndices, ctx, groupTrace);
        } catch (e) {
          // Lot 22 : un refus pour plafond n'est jamais un échec du master.
          // Lot 87A : une suspension (aucun secours admissible) non plus.
          if (isExecutionCancelled(e) || isCostCapReached(e) || isAiSuspended(e)) throw e;
          // Lot 75C (H) : traces de CHAQUE tentative (trace, modèle, code, étape) rattachées au rapport.
          const essais = await collectAttemptTraces({ accountId: input.accountId, fileIds: groupSourceIds, since: rec.startedAt, error: e });
          rec.traceIds = [...new Set([...(groupTrace?.traceIds ?? []), ...essais.traceIds])];
          rec.attempts = essais.attempts;
          rec.fail('MASTER', e, { ...structuringFailureDetail(e), attempts: essais.attempts });
          // Lot 61 : l'extract brut reste écrit ; la structuration est en échec, explicitement.
          await markStructuring(groupSourceIds, input.accountId, 'FAILED', e);
          throw new T1MasterAnalysisError((e as Error).message, {
            // Revue 3a : le code de la passerelle n'est plus écrasé — il
            // distingue une sortie invalide (définitif) d'une panne (transitoire).
            lastFailureCode: (e as { lastFailureCode?: string; code?: string }).lastFailureCode
              ?? (e as { code?: string }).code ?? null,
            definitive: isDefinitiveGatewayFailure(e),
          });
        }
      }
      const result = master.result;
      rec.ok('MASTER', {
        facts: master.facts.length, promptVersion: master.promptVersion,
        ...(rejeu ? { replayedFromRunId: rejeu.runId, reason: 'sortie structurée conservée rejouée : aucun appel au modèle' } : {}),
      });
      if (input.sourceType === 'file') await markStructuring(groupSourceIds, input.accountId, 'SUCCEEDED');
      rec.traceIds = result.operationTrace?.traceIds ?? [];
      rec.masterFacts = master.facts;

      // Candidats agenda (CDC 15 T4-01, T4-03, T4-04) : registre et nature
      // HISTORICAL / DEADLINE — toujours depuis le lot 16b-2 (AI_T4_EFFECTS
      // retiré) ; ils remplacent ceux de l'analyse.
      result.agendaCandidates = buildAgendaCandidatesT4(result.extractedFields, {
        sourceFileId: leadSourceId,
        documentAssetId: resolveAssetId(master, input),
        multiAsset: master.projection.multiAsset,
        documentTitle: result.document.title?.value ?? null,
        documentDate: result.document.date?.value ?? null,
        documentType: result.document.type?.value ?? null,
        documentTypeCode: result.document.rubric?.documentTypeCode ?? null,
        capabilities: ctx.capabilities,
      });

      // ⚠️ Point de contrôle essentiel : l'appel IA a pu répondre APRÈS un
      // rollback. Aucun de ses résultats n'est alors écrit.
      await guard?.assertActive('persistance du résultat');

      broadcast(leadSourceId, { type: 'progress', stage: 'persistance' });

      // Étape 12 — persistance, idempotente.
      const persisted = await persistAnalysisResult({
        input, leadSourceId, groupSourceIds, lotId, result,
        // Version résolue du master dans l'empreinte du run.
        master: { masterPromptVersion: master.promptVersion },
        // Lot 75C (F) : sortie rejouable tant que les écritures ne sont pas achevées.
        masterSnapshot: input.sourceType === 'file' ? masterSnapshotOf(master, rawOutcomes) : undefined,
      }).catch((e) => { rec.fail('ANALYSIS_RUN', e); throw e; });
      rec.ok('ANALYSIS_RUN', {
        runId: persisted.runId, deduplicated: persisted.deduplicated === true,
        ...(persisted.repaired?.length ? { repaired: persisted.repaired } : {}),
      });
      rec.analysisRunId = persisted.runId ?? null;
      rec.deduplicated = persisted.deduplicated === true;

      // Lot 75C (B) : pages sans couche texte — la lecture DÉJÀ faite par le
      // modèle (transcription paginée, unités de la couche A) est persistée
      // par page, à part de l'extract d'origine. Aucun appel IA.
      if (input.sourceType === 'file') {
        for (const o of rawOutcomes) {
          if (!o.summary) continue;
          const ocr = buildOcrPages({
            pagesWithoutText: o.summary.pagesWithoutText, pageCount: o.summary.pageCount,
            units: master.sourceLayer?.units ?? null, transcription: result.document.transcription ?? null,
            groupSize: groupSourceIds.length, scannedPages: master.sourceLayer?.report.diagnostics?.pagesScanned ?? null,
          });
          if (ocr.status === 'NOT_REQUIRED') continue;
          try {
            const ecrit = await markOcr(o.fileId, input.accountId, ocr, persisted.runId ?? null);
            rec.ocr.set(o.fileId, { result: ocr, persisted: ecrit });
            if (ecrit) rec.ok('OCR', { fileId: o.fileId, status: ocr.status, recognized: ocr.recognized, unreadable: ocr.unreadable });
            else rec.fail('OCR', `fichier ${o.fileId} : colonnes de transcription absentes (migration 0545)`);
          } catch (e) {
            rec.ocr.set(o.fileId, { result: ocr, persisted: false });
            rec.fail('OCR', e, { fileId: o.fileId });
          }
        }
      }

      // ══════════════════════════════════════════════════════════════════
      // ÉTAPE 12 bis — REPRÉSENTATION DURABLE DU DOCUMENT (base de connaissance)
      //
      // Texte, description, métadonnées, éléments structurants et faits
      // génériques, avec preuves et provenance — que le document soit
      // rattaché à un bien ou non, qu'une colonne métier existe ou non.
      // T2, T3, T4 et les traitements futurs lisent ici avant de relire le
      // fichier. Un échec est journalisé sans faire échouer l'analyse : le
      // run et les propositions, eux, sont déjà écrits.
      // ══════════════════════════════════════════════════════════════════
      await guard?.assertActive('base de connaissance');
      const knowledge = buildKnowledgeFromSourceAnalysis(result, {
        accountId: input.accountId,
        fileId: leadSourceId,
        analysisRunId: persisted.runId ?? null,
        assetIdAtAnalysis: resolveAssetId(master, input),
        sourceType: input.sourceType === 'web_link' ? 'web_link' : 'asset_file',
        sourceVersion: input.sourceVersion ?? null,
        // Multi-biens déclaré par le modèle ou constaté sur les cibles des faits (U8).
        multiAsset: master.projection.multiAsset,
        // Version résolue du master (fichier ou version de configuration).
        promptVersion: master.promptVersion,
        // Lot 34F : couche A (unités de la source, couverture, faits non résolus).
        sourceLayer: master.sourceLayer,
        // Lot 40 : candidats Opération (barrière serveur appliquée), même transaction que les faits.
        operationCandidates: master.operationCandidates,
      });
      rec.knowledge = knowledge;
      await persistDocumentKnowledgeDetailed(knowledge).then((k) => {
        rec.extractionId = k.extractionId;
        rec.ok('KNOWLEDGE', { extractionId: k.extractionId });
        // Lot 75C (E) : couche source (unités, provenance, couverture) attendue
        // et non écrite → les faits restent écrits, la persistance n'est PAS
        // réussie ; la reprise (sortie rejouée) la reconstruit.
        if (k.sourceLayer === 'FAILED') rec.fail('SOURCE_LAYER', k.sourceLayerError ?? 'couche source non écrite');
        else if (k.sourceLayer === 'WRITTEN') rec.ok('SOURCE_LAYER');
      }, (e: Error) => {
        // Lot 58C : l'échec n'est plus seulement journalisé — le rapport
        // l'affiche et liste chaque donnée déclarée comme NON enregistrée.
        rec.fail('KNOWLEDGE', e);
        console.error(`[source-analysis] base de connaissance du fichier ${leadSourceId} non écrite :`, e.message);
      });

      // ══════════════════════════════════════════════════════════════════
      // ÉTAPE 12 bis-2 — TITRE MÉTIER (lot 33C, ticket T1/T3)
      //
      // Analyse terminée, données persistées → contrôle du titre courant →
      // (re)construction si nécessaire → persistance, par le service COMMUN
      // à T1 et T3. Avant le lot 33C, le titre n'était écrit que par
      // `persistAnalysisResult` : jamais sur un run dédupliqué, jamais par-
      // dessus la marque `user_edited_fields.retainedTitle` — que le tiroir
      // posait À TORT en réenregistrant le nom de fichier (« <uuid>.pdf »).
      // Ne lève jamais (sauf interruption) : une analyse réussie n'est pas
      // perdue pour un titre ; T3 rattrape.
      // ══════════════════════════════════════════════════════════════════
      await guard?.assertActive('titre du document');
      const titre = await ensureBusinessTitle({
        fileId: leadSourceId,
        accountId: input.accountId,
        origin: 'T1',
        mode: 'refresh',
        inputs: titleInputsFromAnalysis(result),
        guard: guard ?? undefined,
      });
      if (titre?.outcome === 'FAILED') rec.fail('TITLE', titre.reason ?? 'échec');
      else rec.ok('TITLE', { outcome: titre?.outcome ?? null, reason: titre?.reason ?? null });

      // ══════════════════════════════════════════════════════════════════
      // ÉTAPE 12 ter — CLASSEMENT V2 ET FILE « À TRAITER » (CDC V2 §10.2, §11.3)
      //
      // Appelé même SANS proposition : c'est ce qui distingue DOC-RUB-03
      // (« Rubrique absente + aucune proposition → À compléter ») du silence.
      // Un document que le modèle n'a pas su classer doit produire une action,
      // sans quoi il resterait « Sans rubrique » sans que rien ne le signale.
      //
      // Ne lève jamais, pour la même raison que le classement V1 : une analyse
      // réussie ne doit pas être perdue parce qu'une carte n'a pas pu être
      // créée.
      // ══════════════════════════════════════════════════════════════════
      const assetIdsForV2 = result.assetCandidates
        .map((c) => c.entityId)
        .filter((id): id is number => typeof id === 'number');

      await guard?.assertActive('classement');
      await applyV2Classification({
        fileId: leadSourceId,
        accountId: input.accountId,
        proposal: result.document.rubric
          ? {
              rubricCode: result.document.rubric.rubricCode,
              documentTypeCode: result.document.rubric.documentTypeCode,
              confidence: result.document.rubric.confidence,
              excerpt: result.document.rubric.excerpt,
            }
          : null,
        origin: 'DOCUMENT_EXTRACTION',
        assetFamilies: await loadAssetFamilies(assetIdsForV2),
        promptVersion: result.document.rubric?.promptVersion ?? null,
        pipelineVersion: PIPELINE_VERSION,
      }).then(() => rec.ok('CLASSIFICATION'), (e) => {
        rec.fail('CLASSIFICATION', e);
        console.error(
          `[source-analysis] classement V2 du fichier ${leadSourceId} impossible :`,
          (e as Error).message,
        );
      });

      // Étape 9 (suite) — preuves.
      const assetId = resolveAssetId(master, input);
      // T1-04, T1-05 : chaque fait projeté est écrit sur SA cible, anciennes
      // preuves du document remplacées — plus jamais tous les champs sur un
      // seul bien. Appelé MÊME sans fait : c'est ce qui retire (supersede) les
      // preuves d'une analyse antérieure.
      await guard?.assertActive('preuves');
      const ecrites = await persistProjectedFacts({
        input,
        leadSourceId,
        facts: master.facts,
        capabilities: ctx.capabilities,
        documentType: result.document.type?.value,
        documentDate: result.document.date?.value,
        trace: result.operationTrace,
        analysisRunId: persisted.runId,
        promptVersion: master.promptVersion,
      }).catch((e) => { rec.fail('EVIDENCE', e); throw e; });
      rec.projection = ecrites ?? null;
      // Lot 75C (C) : une écriture de preuve OBLIGATOIRE en échec n'est plus
      // une simple anomalie de rapport — l'étape est en échec (persistance non
      // réussie, reprise idempotente). Les faits volontairement non projetés
      // (génériques, sans cible vérifiée…) restent de simples motifs.
      if (ecrites?.writeErrors?.length) rec.fail('EVIDENCE', describeEvidenceWriteErrors(ecrites.writeErrors), { writeErrors: ecrites.writeErrors.length });
      else rec.ok('EVIDENCE', { written: ecrites?.evidenceIds?.size ?? 0, notProjected: ecrites?.skipped?.length ?? 0 });

      // Lot 75C (D) : faits FIABLES (certains, cible vérifiée, sans conflit) →
      // attribut métier de LEUR cible, par le moteur de décision et la
      // primitive de T3, relu. T3 reste programmé ci-dessous pour tout le reste.
      await guard?.assertActive('attributs métier');
      if (ecrites?.evidenceIds && ecrites.evidenceIds.size > 0) {
        try {
          rec.attributes = await applyReliableFacts({
            accountId: input.accountId, leadSourceId, facts: master.facts, evidenceIds: ecrites.evidenceIds,
          });
          const ko = rec.attributes.filter((a) => a.outcome === 'FAILED' || a.outcome === 'NOT_CONFIRMED');
          if (ko.length) rec.fail('ATTRIBUTES', ko.map((a) => `${a.fieldKey}@${a.targetType}:${a.entityId} : ${a.reason}`).join(' · ').slice(0, 1_000));
          else rec.ok('ATTRIBUTES', { written: rec.attributes.filter((a) => a.outcome === 'WRITTEN').length, examined: rec.attributes.length });
        } catch (e) {
          if (isExecutionCancelled(e)) throw e;
          rec.fail('ATTRIBUTES', e);
        }
      }
      // Candidats T4 : preuve du champ d'origine sur le bien du document (T4-07, T4-08).
      if (assetId && ecrites?.evidenceIds) {
        const suffixe = `@ASSET:${assetId}`;
        attachEvidenceToCandidates(result.agendaCandidates, new Map([...ecrites.evidenceIds]
          .filter(([k]) => k.endsWith(suffixe)).map(([k, id]) => [k.slice(0, -suffixe.length), id])));
      }
      // Chaque bien touché est réconcilié, pas seulement celui du document
      // (multi-biens, preuves remplacées sur un autre bien).
      await enqueueT3ForAffectedAssets({
        accountId: req.accountId,
        userId: req.userId,
        leadSourceId,
        affectedAssetIds: ecrites?.affectedAssetIds ?? [],
        documentAssetId: assetId,
      });
      // Équipements et pièces touchés : réconciliation ciblée (lot 18, R3).
      await enqueueT3ForAffectedEntities({
        accountId: req.accountId, userId: req.userId, leadSourceId,
        targets: ecrites?.affectedTargets ?? [],
      });
      // Lot 31B : bien certain retenu par l'analyse → la question « À quel
      // bien… ? » éventuellement ouverte est close par le SYSTÈME, avant
      // l'écriture des liens (le déclencheur 0257 la fermerait sinon avec
      // un motif « utilisateur »).
      if (assetId !== null && assetId !== (input.linkedAssetId ?? null)) {
        await closeAssetLinkQuestion(input.accountId, leadSourceId).catch((e: Error) => {
          console.error(`[source-analysis] question de rattachement du fichier ${leadSourceId} non close :`, e.message);
        });
      }
      // Relation N-N (X-01, T1-05) : chaque bien vérifié est relié
      // (PRIMARY / SECONDARY / MENTIONED, origine AI) — un seul bien compris
      // (lot 31B). Non bloquant : les preuves sont écrites, le lien se rattrape.
      await writeMasterDocumentLinks({
        accountId: input.accountId,
        fileId: leadSourceId,
        links: computeMasterDocumentLinks({
          facts: master.facts,
          assetCandidates: result.assetCandidates,
          documentAssetId: master.documentAssetId,
          knownAssetId: input.linkedAssetId ?? null,
        }),
      }).then(() => rec.ok('LINKS'), (e: Error) => {
        rec.fail('LINKS', e);
        console.error(`[source-analysis] liens document ↔ biens du fichier ${leadSourceId} non écrits :`, e.message);
      });
      // Lot 71A (BUG P1, point B) : rattachement aux ÉQUIPEMENTS du bien
      // désignés par les données structurées (cible T1 vérifiée, n° de série,
      // modèle, désignation) — liens N-N, plusieurs possibles ; ambiguïté →
      // T3 (contexte enrichi) puis carte LINK-ELT, le document reste sur le
      // bien. Non bloquant.
      await guard?.assertActive('rattachement aux équipements');
      try {
        const { syncDocumentEquipmentLinks } = await import('@/services/equipment/document-equipment-link.service');
        await syncDocumentEquipmentLinks({ accountId: input.accountId, fileId: leadSourceId, allowAi: true, guard: guard ?? undefined });
      } catch (e) {
        if (isExecutionCancelled(e)) throw e;
        console.error(`[source-analysis] rattachement aux équipements du fichier ${leadSourceId} impossible :`, (e as Error).message);
      }
      // Lot 31B : rattachement principal VISIBLE (colonne lue par les listes
      // de documents) pour un bien retenu automatiquement — jamais par-dessus
      // un choix ou un retrait de l'utilisateur (`ASSET_LINK_SLOT.writeAuto`).
      if (assetId !== null && assetId !== (input.linkedAssetId ?? null)) {
        await writeAutomaticPrimaryColumn(input.accountId, leadSourceId, assetId).then(() => rec.ok('PRIMARY_ASSET', { assetId }), (e: Error) => {
          rec.fail('PRIMARY_ASSET', e);
          console.error(`[source-analysis] rattachement principal du fichier ${leadSourceId} non écrit :`, e.message);
        });
      }

      // ══════════════════════════════════════════════════════════════════
      // ÉTAPE 12 quater — RÈGLES DOCUMENTAIRES « À TRAITER » (lot 28)
      //
      // Pont GÉNÉRIQUE piloté par `PROCESSING_RULES` : rattachement à un
      // bien (LINK-ASSET), dates de fin de contrat / de garantie, fournisseur
      // du document. Rattachement fiable → écrit ; candidats ambigus →
      // À arbitrer ; aucun candidat → À compléter ; donnée non pertinente
      // pour le Type → rien. Après le classement (le Type décide de la
      // pertinence) et les liens N-N (un document multi-biens est déjà
      // rattaché). Ne lève jamais.
      // ══════════════════════════════════════════════════════════════════
      await guard?.assertActive('règles « À traiter »');
      await rec.run('RULES', () => syncDocumentRulesFromAnalysis({
        accountId: input.accountId,
        fileId: leadSourceId,
        runRef: persisted.runId ? `analysis_run:${persisted.runId}` : null,
        observations: {
          // Lot 58B : la clé LUE accompagne un fait sans clé canonique (fait
          // requalifié générique) — le pont la rapproche par le registre.
          facts: master.facts.map((f) => ({
            canonicalKey: f.canonicalKey, rawKey: f.rawKey ?? null, value: f.value, confidence: f.confidence, excerpt: f.evidence?.excerpt ?? null,
          })),
          assetCandidates: result.assetCandidates.map((c) => ({
            entityId: c.entityId, verified: c.verified, score: c.score, confidence: c.confidence,
          })),
          documentAssetId: assetId,
          // Lot 31B (ticket T3, §9) : sans bien certain, T3 DOCUMENT_ASSET
          // reprend IMMÉDIATEMENT (abonné `source_analyzed`) ; la question
          // « À quel bien rattacher ce document ? » n'est posée qu'après
          // l'échec ou l'abstention de T3, avec SES candidats.
          deferAssetLinkToT3: assetId === null,
          metadata: {
            supplier: result.document.supplier?.value?.name
              ? {
                  value: result.document.supplier.value.name,
                  confidence: result.document.supplier.confidence,
                  excerpt: result.document.supplier.excerpt,
                }
              : undefined,
          },
        },
      }));

      // ══════════════════════════════════════════════════════════════════
      // Lot 61 (ticket T1 §6, §8) — PHASE PERSISTANCE : jamais de faux succès.
      // La base de connaissance (extract, faits, couverture) est une écriture
      // BLOQUANTE : son échec n'arrête pas les écritures suivantes (preuves,
      // liens, règles : tout ce qui peut l'être est écrit), mais le document
      // n'est jamais déclaré analysé — échec TRANSITOIRE explicite, reprise
      // idempotente par la file durable (faits, preuves, unités remplacés).
      // ══════════════════════════════════════════════════════════════════
      const persistance = persistenceOutcome(rec.steps);
      if (input.sourceType === 'file') await markPersistence(groupSourceIds, input.accountId, persistance.status, persistance.error);
      // Lot 75C (F) : achèvement des écritures du run (la sortie conservée n'est effacée qu'en cas de réussite).
      await finalizeRunWrites(persisted.runId, persistance.status, persistance.error);
      if (persistance.status === 'FAILED') {
        throw new T1PersistenceIncompleteError(persistance.error ?? 'écriture bloquante en échec');
      }

      // ⚠️ CORRECTION §4.1.7 — la suppression des fichiers secondaires
      // n'intervient qu'ici, après persistance ET preuves réussies.
      await guard?.assertActive('finalisation');
      if (groupSourceIds.length > 1) {
        await softDeleteSecondarySources(leadSourceId, groupSourceIds.slice(1), lotId);
      }

      await markLotItems(lotId, groupSourceIds, 'completed', persisted.runId);
      // État final — CDC §4.2.4. Lot 71B (décision PO du 19/10 : « Il ne
      // doit pas y avoir de système de validation sur les fiches. Soit il y a
      // besoin d'une carte À traiter, soit la donnée est ajoutée. ») : la fin
      // d'analyse ne met PLUS JAMAIS un document « à valider »
      // (`VALIDATION_REQUIRED`, ancien `computeFinalState`). Ce que cet état
      // promettait est porté par les moteurs : bien incertain → T3
      // DOCUMENT_ASSET (rattachement ou carte LINK-ASSET) ; document
      // multi-biens → chaque fait reste sur sa cible, la réconciliation
      // tranche ou ouvre un arbitrage ; contradiction avec le bien choisi →
      // carte dédiée (lot 32C) ; données documentaires → pont « À traiter ».
      // Seul le doublon (FUSION_SUGGESTED) est décidé ci-dessous.
      const etatFinal = 'ANALYZED';

      // ══════════════════════════════════════════════════════════════════
      // DÉTECTION DE DOUBLON — ET SES DEUX CONSÉQUENCES
      //
      // L'ancien pipeline la pratiquait, le nouveau l'avait perdue. Elle
      // porte deux effets, et le second est financier :
      //
      //   · l'état devient FUSION_SUGGESTED : le tiroir du document
      //     présente la suggestion de fusion (l'ancienne file V1
      //     `to-process.service`, qui s'en servait aussi, est supprimée au
      //     lot 28) ;
      //
      //   · le document N'EST PAS COMPTÉ dans le quota. Sans cela, déposer
      //     deux fois la même facture consomme deux analyses, et
      //     l'utilisateur paie une seconde fois pour un doublon qu'il n'a pas
      //     voulu.
      //
      // La détection ne doit jamais faire échouer l'analyse : elle a réussi
      // et ses résultats sont écrits. Un doublon non détecté se rattrape.
      // ══════════════════════════════════════════════════════════════════
      let estDoublon = false;
      try {
        const { detectFusionCandidates } = await import(
          '@/services/document-ai/fusion-detector'
        );
        const fusion = await detectFusionCandidates(leadSourceId, req.accountId);
        if (fusion.hasCandidates) {
          estDoublon = true;
          await setState(groupSourceIds, 'FUSION_SUGGESTED');
        }
      } catch (e) {
        console.error(
          `[source-analysis] détection de doublon impossible pour ${leadSourceId} :`,
          (e as Error).message,
        );
      }

      if (!estDoublon) {
        await setState(groupSourceIds, etatFinal);
      }
      rec.ok('FINAL_STATE', { state: estDoublon ? 'FUSION_SUGGESTED' : etatFinal });

      // Un doublon ne compte ni dans le total analysé, ni donc dans les
      // crédits consommés plus bas.
      if (!persisted.deduplicated && !estDoublon) analysedCount++;
      results.push(result);

      // ── Étapes 13 et 14 : déclenchement des moteurs aval ────────────────
      // Émission d'événement, jamais d'import direct : le pipeline ne connaît
      // ni la réconciliation ni l'agenda (§10.2).
      await guard?.assertActive('moteurs aval');
      await emitSourceAnalyzed({
        accountId: req.accountId,
        userId: req.userId,
        assetId,
        leadSourceId,
        result,
      });
      rec.ok('DOWNSTREAM_EVENT');
      // Lot 58C : instantané immuable, après les écritures (ne lève jamais).
      await writeT1Report(rec, { accountId: req.accountId, fileId: leadSourceId, groupSourceIds });
    } catch (e) {
      // Interruption : aucune écriture (pas même l'échec) — la nouvelle
      // exécution reprendra ces sources avec la configuration restaurée.
      if (isExecutionCancelled(e)) throw e;
      // Lot 22 — plafond mensuel de coût IA du compte franchi pendant
      // l'analyse. Jamais `failSources` (ni ANALYSIS_FAILED, ni compteur) :
      //   · sous la file : le refus remonte, le boucleur reporte le job au 1er ;
      //   · hors file : ce groupe et les suivants repassent « en file » avec
      //     le motif ; l'appelant les confie à la file au 1er (même chemin que
      //     le contrôle préalable).
      if (isCostCapReached(e)) {
        if (guard) throw e;
        const restants = groups.slice(gi).flatMap((g) => g.map((i) => input.sourceIds[i]));
        const resumeAt = costCapResumeAt(e) ?? new Date(Date.now() + 3_600_000);
        await markCostCapped(restants, resumeAt);
        plafond = {
          resumeAt, sourceIds: restants,
          capMicros: Number((e as { capMicros?: number }).capMicros ?? 0),
          spentMicros: Number((e as { spentMicros?: number }).spentMicros ?? 0),
        };
        break;
      }
      // Lot 87A (P7, RUN-02) — suspension du master hors file : aucun secours
      // admissible, RIEN d'écrit (le master n'a pas abouti). Jamais
      // `failSources` : ce groupe et les suivants repassent « en file » avec
      // le motif ; l'appelant les confie à la file, qui les reprend depuis un
      // point sûr. Sous la file, la suspension a déjà remonté (interruption).
      if (isAiSuspended(e) && !rec.steps.some((x) => x.step === 'MASTER' && x.status === 'OK')) {
        if (guard) throw e;
        const restants = groups.slice(gi).flatMap((g) => g.map((i) => input.sourceIds[i]));
        await markAiSuspended(restants);
        suspendues = {
          ids: restants, cause: String((e as { failureCause?: unknown }).failureCause ?? 'UNKNOWN'),
          message: String((e as Error).message ?? '').slice(0, 1000),
        };
        break;
      }
      console.warn(`[source-analysis] analyse T1 en échec pour la source ${leadSourceId} :`, (e as Error).message);
      const definitif = e instanceof T1MasterAnalysisError && e.definitive;
      await failSources(groupSourceIds, failReason(e), lotId, { definitive: definitif });
      // Lot 61 : une étape bloquante de persistance en échec APRÈS le master
      // (run, preuves, règles) est aussi un échec de la phase persistance.
      if (input.sourceType === 'file' && !(e instanceof T1MasterAnalysisError) && !(e instanceof T1PersistenceIncompleteError)
        && rec.steps.some((x) => x.step === 'MASTER' && x.status === 'OK')) {
        await markPersistence(groupSourceIds, input.accountId, 'FAILED', persistenceOutcome(rec.steps).error ?? (e as Error).message);
      }
      // Lot 75C (F) : run écrit, écritures inachevées → sortie conservée pour la reprise.
      if (!(e instanceof T1PersistenceIncompleteError) && rec.analysisRunId != null) {
        await finalizeRunWrites(rec.analysisRunId, 'FAILED', persistenceOutcome(rec.steps).error ?? (e as Error).message);
      }
      // Persistance incomplète : des données sont écrites — rapport PARTIAL
      // (lignes NOT_PERSISTED motivées), document en échec, jamais en succès.
      if (e instanceof T1PersistenceIncompleteError) rec.fail('PERSISTENCE', e);
      else rec.failure = failReason(e);
      await writeT1Report(rec, { accountId: req.accountId, fileId: leadSourceId, groupSourceIds });
      failedSourceIds.push(...groupSourceIds);
      if (definitif) definitiveFailedSourceIds.push(...groupSourceIds);
    }
  }

  if (analysedCount > 0 && req.billable !== false) {
    await consumeAnalysisCredits(req.accountId, analysedCount).catch(() => {});
  }

  // Revue 3a (point 6) : les analyses sont persistées — une panne de clôture
  // de lot ou de notification ne doit pas faire échouer l'exécution (sous la
  // file, le job serait relancé et rappellerait le master pour rien).
  try { await closeLot(lotId); } catch (e) { console.error('[source-analysis] clôture du lot impossible :', (e as Error).message); }

  // ══════════════════════════════════════════════════════════════════════
  // NOTIFICATION DU RÉSULTAT DU LOT — CDC notifications §7.2, lot 81E
  //
  // Le résultat est relu depuis les états persistés des documents
  // (`lot-notification.ts`) : réussite, réussite partielle ou échec total,
  // une seule notification. Un échec qui va être repris automatiquement
  // (file durable, ou remise en file par l'entrée unique hors file) n'est
  // jamais annoncé comme définitif : le lot reste en attente jusqu'à l'issue.
  //
  // Seule pièce que l'ancien pipeline émettait et que le nouveau avait
  // perdue. Sans elle, la bascule aurait rendu l'analyse muette : le
  // document apparaît, la fiche s'enrichit, et l'utilisateur n'est prévenu
  // de rien.
  //
  // Contrairement à l'enrichissement — qui passe, lui, par l'événement
  // `emitSourceAnalyzed` et ses abonnés —, la notification n'a pas de
  // destinataire naturel dans ce mécanisme : elle porte sur le LOT, pas sur
  // un bien. Elle est donc émise ici.
  // ══════════════════════════════════════════════════════════════════════
  try {
    await notifyLotCompleted({
      accountId: req.accountId,
      userId: req.userId,
      lotId,
      analysedCount,
      // Lot 81E : échecs RÉELS de cette exécution (jamais doublons ni regroupés).
      failedCount: failedSourceIds.length,
      retryExpectedSourceIds: req.guard || req.retryOnFailure !== false ? failedSourceIds : [],
    });
  } catch (e) {
    console.error('[source-analysis] notification de fin de lot impossible :', (e as Error).message);
  }

  return {
    results, analysedCount, failedSourceIds, definitiveFailedSourceIds,
    ...(plafond ? {
      ...(analysedCount === 0 && results.length === 0 && failedSourceIds.length === 0 ? { skippedReason: 'cost_cap' as const } : {}),
      costCap: { resumeAt: plafond.resumeAt.toISOString(), capMicros: plafond.capMicros, spentMicros: plafond.spentMicros },
      costCapSourceIds: plafond.sourceIds,
    } : {}),
    ...(suspendues ? { aiSuspendedSourceIds: suspendues.ids, aiSuspension: { cause: suspendues.cause, message: suspendues.message } } : {}),
  };
}

/** Lot 87A : sources non analysées pour suspension IA (hors file) — « en file » avec le motif. */
async function markAiSuspended(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.update(assetFiles)
    .set({ analysisState: 'UPLOADED', analysisFailReason: AI_SUSPENSION_USER_REASON, updatedAt: new Date() })
    .where(inArray(assetFiles.id, ids));
  for (const id of ids) broadcast(id, { type: 'state_update', analysisState: 'UPLOADED' });
}

/** Lot 22 : sources non analysées pour plafond — « en file » avec le motif daté. */
async function markCostCapped(ids: number[], resumeAt: Date): Promise<void> {
  if (ids.length === 0) return;
  const { costCapAnalysisReason } = await import('../gateway/account-cost-cap');
  const motif = costCapAnalysisReason(resumeAt);
  await db.update(assetFiles)
    .set({ analysisState: 'UPLOADED', analysisFailReason: motif, updatedAt: new Date() })
    .where(inArray(assetFiles.id, ids));
  for (const id of ids) broadcast(id, { type: 'state_update', analysisState: 'UPLOADED' });
}

/**
 * Échec du prompt maître T1 pour un groupe (toute la chaîne de modèles, ou
 * sortie inexploitable après réparation). Lot 16b-3 : plus de repli sur les
 * étapes — le groupe est mis en échec, la file durable le reprend.
 */
export class T1MasterAnalysisError extends Error {
  readonly code = 'T1_MASTER_FAILED';
  /** Code de la passerelle (dernier modèle de la chaîne), conservé. */
  readonly lastFailureCode: string | null;
  /** Échec définitif (`failure-policy#isDefinitiveGatewayFailure`). */
  readonly definitive: boolean;
  constructor(cause: string, opts: { lastFailureCode?: string | null; definitive?: boolean } = {}) {
    super(cause);
    this.name = 'T1MasterAnalysisError';
    this.lastFailureCode = opts.lastFailureCode ?? null;
    this.definitive = opts.definitive ?? false;
  }
}

/**
 * Lot 61 (ticket T1 §6) — structuration réussie mais écriture BLOQUANTE en
 * échec (base de connaissance) : le document n'est jamais déclaré analysé.
 * Échec TRANSITOIRE (la file durable reprend ; écritures idempotentes).
 */
class T1PersistenceIncompleteError extends Error {
  readonly code = 'T1_PERSISTENCE_INCOMPLETE';
  constructor(detail: string) {
    super(`Persistance incomplète : ${detail}`.slice(0, 1_000));
    this.name = 'T1PersistenceIncompleteError';
  }
}

/** Version de la sortie rejouable (`master_snapshot`). */
const SNAPSHOT_VERSION = 1;

interface MasterSnapshot {
  v: number;
  master: MasterGroupAnalysis;
  /** Empreinte du contenu de chaque fichier lu au moment de la structuration. */
  sources: Record<string, string | null>;
}

/** Sortie structurée rejouable (faits non dupliqués : `projection.facts` = `facts`). */
function masterSnapshotOf(master: MasterGroupAnalysis, raws: readonly RawExtractOutcome[]): MasterSnapshot {
  return {
    v: SNAPSHOT_VERSION,
    master: { ...master, projection: { ...master.projection, facts: [] } },
    sources: Object.fromEntries(raws.map((r) => [String(r.fileId), r.summary?.sourceSha256 ?? r.sourceSha256 ?? null])),
  };
}

/**
 * Lot 75C (ticket T1 résiduels, F) — sortie structurée d'une analyse dont les
 * écritures sont inachevées, rejouable SANS appel au modèle : même entrée
 * (empreinte du run : sources, version de source, version du master) et
 * même CONTENU (empreinte des octets de chaque fichier). Sinon `null` : le
 * modèle est appelé, comme avant. Ne lève jamais.
 */
async function replayableMaster(
  input: SourceInput, leadSourceId: number, groupSourceIds: number[], raws: readonly RawExtractOutcome[],
): Promise<{ runId: number; master: MasterGroupAnalysis } | null> {
  if (input.sourceType !== 'file') return null;
  try {
    const r = await loadReplayableRun(input.accountId, leadSourceId);
    if (!r) return null;
    const snap = r.snapshot as Partial<MasterSnapshot> | null;
    const m = snap?.master;
    if (snap?.v !== SNAPSHOT_VERSION || !m?.result || !m.promptVersion || !Array.isArray(m.facts)) return null;
    if (computeInputHash({ groupSourceIds, input, master: { masterPromptVersion: m.promptVersion } }) !== r.inputHash) return null;
    for (const o of raws) {
      const avant = snap.sources?.[String(o.fileId)] ?? null;
      const maintenant = o.summary?.sourceSha256 ?? o.sourceSha256 ?? null;
      if (!avant || !maintenant || avant !== maintenant) return null;
    }
    // Une seule liste de faits (mutations de provenance partagées, comme à l'analyse).
    m.projection = { ...m.projection, facts: m.facts };
    m.operationCandidates ??= [];
    console.info(`[source-analysis] fichier ${leadSourceId} : sortie structurée du run ${r.runId} rejouée (écritures inachevées), aucun appel au modèle.`);
    return { runId: r.runId, master: m };
  } catch (e) {
    console.error(`[source-analysis] sortie rejouable du fichier ${leadSourceId} illisible :`, (e as Error).message);
    return null;
  }
}

/** Code, code du dernier modèle et étape d'un échec de structuration (rapport, BO). */
function structuringFailureDetail(e: unknown): Record<string, unknown> {
  const x = (e ?? {}) as { code?: unknown; lastFailureCode?: unknown; recoverable?: unknown; aiStage?: unknown; cause?: { aiStage?: unknown } };
  return {
    code: typeof x.code === 'string' ? x.code : null,
    lastFailureCode: typeof x.lastFailureCode === 'string' ? x.lastFailureCode : null,
    recoverable: typeof x.recoverable === 'boolean' ? x.recoverable : null,
    stage: typeof x.aiStage === 'string' ? x.aiStage : typeof x.cause?.aiStage === 'string' ? x.cause.aiStage : null,
  };
}

/**
 * Motif TECHNIQUE de l'échec, conservé sur le document (borné, sans pile).
 * Lot 34C : jamais rendu à l'application (`toUserFile`, `userStreamEvent`) —
 * lu par BO › Exécutions IA, la fiche document du BO et le rejeu des sorties
 * invalides ; classé en code fonctionnel (`classifyUserFailure`).
 */
function failReason(e: unknown): string {
  // Lot 34D : défaut interne du moteur (contrat runtime) — message générique.
  const message = (userFacingFailReason(e) ?? (e as Error)?.message ?? 'erreur inconnue').slice(0, 300);
  return e instanceof T1MasterAnalysisError
    ? `Analyse impossible (prompt maître T1) : ${message}`
    : message;
}

// ── Helpers d'état et de persistance ───────────────────────────────────────

/**
 * Bien du document : celui retenu par l'analyse (`analyzeDocument` : bien
 * connu, identifiant canonique exact et unique, unique candidat certain).
 * Sinon `null` — T3 DOCUMENT_ASSET arbitrera, l'analyse ne tranche pas un
 * rattachement ambigu. Lot 31B : une seule source de vérité (la décision de
 * l'étape T1), plus de recalcul divergent depuis les candidats.
 */
function resolveAssetId(master: Pick<MasterGroupAnalysis, 'documentAssetId'>, input: SourceInput): number | null {
  return input.linkedAssetId ?? master.documentAssetId ?? null;
}

async function filterOwnedSources(ids: number[], accountId: number): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db.select({ id: assetFiles.id }).from(assetFiles).where(and(
    inArray(assetFiles.id, ids),
    eq(assetFiles.accountId, accountId),
    isNull(assetFiles.deletedAt),
  ));
  return rows.map((r) => r.id);
}

async function excludeInProgress(ids: number[]): Promise<number[]> {
  const rows = await db.select({ id: assetFiles.id, state: assetFiles.analysisState })
    .from(assetFiles).where(inArray(assetFiles.id, ids));
  return rows.filter((r) => r.state !== 'ANALYZING').map((r) => r.id);
}

/**
 * États où l'analyse a ABOUTI. Eux seuls remettent le compteur d'échecs à zéro.
 *
 * `ANALYZING` n'en fait pas partie, et c'est tout l'objet du correctif
 * ci-dessous. La liste est la même que celle du moteur historique
 * (`unified-analysis-pipeline`), qui avait vu juste.
 */
const ETATS_ABOUTIS = ['ANALYZED', 'VALIDATION_REQUIRED', 'CONFLICT_DETECTED', 'FUSION_SUGGESTED'];

/**
 * Écrit l'état d'analyse d'un ensemble de sources.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ CORRECTION D'UNE BOUCLE D'ÉCHEC INFINIE — constatée en recette le 21/09/2026
 *
 * Cette fonction remettait `analysisRetryCount` à zéro À CHAQUE APPEL, y compris
 * pour `ANALYZING`. Or `ANALYZING` est écrit au DÉBUT de chaque analyse.
 *
 * Le cycle était donc :
 *   1. la reprise trouve un document en échec (compteur à 1, sous la limite) ;
 *   2. elle le relance ; le pipeline écrit `ANALYZING` → compteur remis à ZÉRO ;
 *   3. l'analyse échoue → compteur à 1 ;
 *   4. cinq minutes plus tard, retour à l'étape 1.
 *
 * Le compteur ne dépassait jamais 1. La limite de dix tentatives de
 * `analysis-recovery.service` était donc inatteignable, et un document qui
 * échoue toujours — fichier illisible, contenu vide — était relancé
 * indéfiniment, avec un appel modèle FACTURÉ à chaque tour.
 *
 * Les journaux de préproduction montraient les lots 417 à 435 se succéder de
 * cinq en cinq minutes sur le même document, sans fin.
 *
 * Le moteur historique, lui, ne remettait à zéro que sur les états aboutis.
 * C'est une régression du nouveau moteur, pas un défaut d'origine.
 * ══════════════════════════════════════════════════════════════════════════
 */
async function setState(ids: number[], state: string): Promise<void> {
  if (ids.length === 0) return;

  const patch: Record<string, unknown> = { analysisState: state, updatedAt: new Date() };
  // Lot 22 : le motif « plafond IA du mois atteint » n'est plus d'actualité
  // dès que l'analyse reprend (les autres motifs sont conservés).
  // Lot 87A : idem pour le motif de suspension IA (aucun secours admissible).
  patch.analysisFailReason = sql`CASE WHEN ${assetFiles.analysisFailReason} LIKE ${COST_CAP_REASON_PREFIX + '%'} OR ${assetFiles.analysisFailReason} = ${AI_SUSPENSION_USER_REASON} THEN NULL ELSE ${assetFiles.analysisFailReason} END`;
  // Seul un aboutissement efface l'ardoise. Un début d'analyse ne prouve rien.
  if (ETATS_ABOUTIS.includes(state)) patch.analysisRetryCount = 0;

  await db.update(assetFiles).set(patch).where(inArray(assetFiles.id, ids));
  for (const id of ids) broadcast(id, { type: 'state_update', analysisState: state });
}

async function failSources(
  ids: number[], reason: string, lotId: number | null, opts: { definitive?: boolean } = {},
): Promise<void> {
  await db.update(assetFiles)
    .set({
      analysisState: 'ANALYSIS_FAILED',
      analysisFailReason: reason,
      // Échec définitif : compteur porté au plafond de la reprise serveur,
      // qui ne le relancera plus (`failure-policy`).
      analysisRetryCount: opts.definitive
        ? sql`GREATEST(${assetFiles.analysisRetryCount} + 1, ${MAX_ANALYSIS_RETRIES})`
        : sql`${assetFiles.analysisRetryCount} + 1`,
      updatedAt: new Date(),
    })
    .where(inArray(assetFiles.id, ids));
  // Lot 34C : le motif TECHNIQUE reste sur le document (BO › Exécutions IA,
  // rejeu) ; le flux de l'application ne reçoit que l'état — le relais
  // (`userStreamEvent`) le traduit en statut fonctionnel (une reprise
  // prévue n'est pas un échec affiché).
  for (const id of ids) broadcast(id, { type: 'error', analysisState: 'ANALYSIS_FAILED' });
  await markLotItems(lotId, ids, 'failed');
}

/**
 * Sources secondaires d'un groupe : rattachées au document principal
 * (masquées des listes, conservées en stockage et jamais purgées tant que le
 * document existe — `grouped-sources`), et non plus simplement supprimées.
 */
async function softDeleteSecondarySources(leadId: number, ids: number[], lotId: number | null): Promise<void> {
  await markSourcesGrouped(leadId, ids);
  if (lotId) {
    await db.update(documentLotItems).set({ commitStatus: 'committed' })
      .where(and(eq(documentLotItems.lotId, lotId), inArray(documentLotItems.assetFileId, ids)));
  }
}

async function openLot(accountId: number, ids: number[], userId?: number | null): Promise<number> {
  // Lot 81E : le résultat du lot sera notifié au demandeur, une fois
  // définitif (`lot-notification.ts`) ; sans demandeur, rien à notifier.
  const [lot] = await db.insert(documentLots)
    .values({ accountId, status: 'analyzing', notificationState: userId ? 'awaiting' : 'silent', notificationUserId: userId ?? null })
    .returning({ id: documentLots.id });

  await db.insert(documentLotItems).values(
    ids.map((id, i) => ({ lotId: lot.id, assetFileId: id, position: i, analysisStatus: 'analyzing' as const })),
  );
  return lot.id;
}

async function markLotItems(
  lotId: number | null, ids: number[], status: 'completed' | 'failed', runId?: number,
): Promise<void> {
  if (!lotId || ids.length === 0) return;
  await db.update(documentLotItems)
    .set({ analysisStatus: status, ...(runId ? { currentAnalysisRunId: runId } : {}) })
    .where(and(eq(documentLotItems.lotId, lotId), inArray(documentLotItems.assetFileId, ids)));
}

async function closeLot(lotId: number | null): Promise<void> {
  if (!lotId) return;
  const items = await db.select({ status: documentLotItems.analysisStatus })
    .from(documentLotItems).where(eq(documentLotItems.lotId, lotId));
  const failed = items.filter((i) => i.status === 'failed').length;
  await db.update(documentLots)
    .set({ status: failed > 0 ? 'partially_failed' : 'committed', committedAt: new Date() })
    .where(eq(documentLots.id, lotId));
}

/** Contexte du compte — borné, réutilisé par toutes les étapes (§5.6). Lot 34F : exporté (reprise ciblée). */
export async function loadAnalysisContext(
  accountId: number, linkedAssetId: number | null,
): Promise<AnalysisContext> {
  const assetRows = await db
    .select({ id: assets.id, name: assets.name, category: assets.category, subtype: assets.subtype })
    .from(assets)
    .where(and(eq(assets.accountId, accountId), isNull(assets.deletedAt)))
    .limit(200);

  const assetIds = assetRows.map((a) => a.id);
  // Lot 31B : identifiants canoniques (fiche canonique) — ENTITY_CONTEXT
  // (non sensibles seulement) et correspondance déterministe serveur. Une
  // lecture impossible n'empêche jamais l'analyse.
  const assetIdentifiers = await loadAssetIdentifiers(accountId, assetIds).catch((e: Error) => {
    console.error('[source-analysis] identifiants des biens non lus :', e.message);
    return [];
  });

  // Capacités du compte AU MOMENT de l'analyse (pièces, équipements) :
  // contexte T1 filtré, sortie T1 contrôlée, gardes T3 / T4 (account-capabilities).
  const { getAccountCapabilities } = await import('@/services/account-capabilities.service');
  const [roomRows, equipRows, titleRows, capabilities] = await Promise.all([
    assetIds.length
      // D-G (lot 20, 0229) : pièces = sous-structures ; les identifiants proposés
      // au modèle (puis revérifiés) sont des `substructures.id`.
      ? db.select({ id: substructures.id, name: substructures.name, assetId: substructures.assetId })
          .from(substructures).where(inArray(substructures.assetId, assetIds)).limit(300)
      : Promise.resolve([]),
    assetIds.length
      ? db.select({ id: equipments.id, name: equipments.name, type: equipments.type, assetId: equipments.assetId })
          .from(equipments).where(inArray(equipments.assetId, assetIds)).limit(300)
      : Promise.resolve([]),
    db.select({ title: assetFiles.retainedTitle })
      .from(assetFiles)
      .where(and(eq(assetFiles.accountId, accountId), isNull(assetFiles.deletedAt)))
      .limit(100),
    getAccountCapabilities(accountId),
  ]);

  return {
    accountId,
    userId: 0,
    assets: assetRows,
    rooms: roomRows as AnalysisContext['rooms'],
    equipments: equipRows as AnalysisContext['equipments'],
    existingTitles: titleRows.map((t) => t.title).filter((t): t is string => Boolean(t)),
    linkedAssetId,
    capabilities,
    assetIdentifiers,
  };
}
