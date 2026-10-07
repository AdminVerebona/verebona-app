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
import { isDefinitiveGatewayFailure, MAX_ANALYSIS_RETRIES } from './failure-policy';
import { buildKnowledgeFromSourceAnalysis } from '../knowledge/document-knowledge';
import { persistDocumentKnowledge } from '../knowledge/document-knowledge.service';
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
import { persistProjectedFacts } from './steps/persist-evidence.step';
import { persistAnalysisResult } from './persistence/analysis-result.repository';
import { notifyLotCompleted } from './lot-notification';
import { broadcast } from './stream/broadcast';
import { emitSourceAnalyzed } from './events';
import type {
  SourceInput, SourceType, SourceAnalysisResult, AnalysisContext,
} from './types';
import { isExecutionCancelled, type ExecutionGuard } from '../queue/execution-control';
import { isCostCapReached, costCapResumeAt } from '../gateway/errors';
import { markSourcesGrouped } from '@/services/documents/grouped-sources';
// Prompt maître T1 — seul moteur depuis le lot 16b-3 (CDC 15 §23, §29).
import { analyseGroupWithMaster, type MasterGroupAnalysis } from './master/analyse-group-master';
import { enqueueT3ForAffectedAssets, enqueueT3ForAffectedEntities } from './master/reconciliation-fanout';
import { computeMasterDocumentLinks, writeMasterDocumentLinks } from './master/document-links';
import { syncDocumentRulesFromAnalysis } from '@/services/to-process/document-rule-bridge';
import { groupUpload } from './steps/group-upload.step';

export interface RunSourceAnalysisInput {
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
  const lotId = await openLot(req.accountId, pendingIds);
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

  for (const [gi, groupIndices] of groups.entries()) {
    const leadSourceId = input.sourceIds[groupIndices[0]];
    const groupSourceIds = groupIndices.map((i) => input.sourceIds[i]);

    broadcast(leadSourceId, { type: 'progress', stage: 'extraction' });

    try {
      let master: MasterGroupAnalysis;
      try {
        master = await analyseGroupWithMaster(input, groupIndices, ctx, groupTrace);
      } catch (e) {
        // Lot 22 : un refus pour plafond n'est jamais un échec du master.
        if (isExecutionCancelled(e) || isCostCapReached(e)) throw e;
        throw new T1MasterAnalysisError((e as Error).message, {
          // Revue 3a : le code de la passerelle n'est plus écrasé — il
          // distingue une sortie invalide (définitif) d'une panne (transitoire).
          lastFailureCode: (e as { lastFailureCode?: string; code?: string }).lastFailureCode
            ?? (e as { code?: string }).code ?? null,
          definitive: isDefinitiveGatewayFailure(e),
        });
      }
      const result = master.result;

      // Candidats agenda (CDC 15 T4-01, T4-03, T4-04) : registre et nature
      // HISTORICAL / DEADLINE — toujours depuis le lot 16b-2 (AI_T4_EFFECTS
      // retiré) ; ils remplacent ceux de l'analyse.
      result.agendaCandidates = buildAgendaCandidatesT4(result.extractedFields, {
        sourceFileId: leadSourceId,
        documentAssetId: resolveAssetId(result, input),
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
      });

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
      await persistDocumentKnowledge(buildKnowledgeFromSourceAnalysis(result, {
        accountId: input.accountId,
        fileId: leadSourceId,
        analysisRunId: persisted.runId ?? null,
        assetIdAtAnalysis: resolveAssetId(result, input),
        sourceType: input.sourceType === 'web_link' ? 'web_link' : 'asset_file',
        sourceVersion: input.sourceVersion ?? null,
        // Multi-biens déclaré par le modèle ou constaté sur les cibles des faits (U8).
        multiAsset: master.projection.multiAsset,
        // Version résolue du master (fichier ou version de configuration).
        promptVersion: master.promptVersion,
      })).catch((e: Error) => {
        console.error(`[source-analysis] base de connaissance du fichier ${leadSourceId} non écrite :`, e.message);
      });

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
      }).catch((e) => {
        console.error(
          `[source-analysis] classement V2 du fichier ${leadSourceId} impossible :`,
          (e as Error).message,
        );
      });

      // Étape 9 (suite) — preuves.
      const assetId = resolveAssetId(result, input);
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
      });
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
      // Relation N-N (X-01, T1-05) : chaque bien vérifié d'un document
      // multi-biens est relié (PRIMARY / SECONDARY / MENTIONED, origine AI).
      // Non bloquant : les preuves sont écrites, le lien se rattrape.
      await writeMasterDocumentLinks({
        accountId: input.accountId,
        fileId: leadSourceId,
        links: computeMasterDocumentLinks({
          facts: master.facts,
          assetCandidates: result.assetCandidates,
          documentAssetId: master.documentAssetId,
          knownAssetId: input.linkedAssetId ?? null,
        }),
      }).catch((e: Error) => {
        console.error(`[source-analysis] liens document ↔ biens du fichier ${leadSourceId} non écrits :`, e.message);
      });

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
      await syncDocumentRulesFromAnalysis({
        accountId: input.accountId,
        fileId: leadSourceId,
        observations: {
          facts: master.facts.map((f) => ({
            canonicalKey: f.canonicalKey, value: f.value, confidence: f.confidence, excerpt: f.evidence?.excerpt ?? null,
          })),
          assetCandidates: result.assetCandidates.map((c) => ({
            entityId: c.entityId, verified: c.verified, score: c.score, confidence: c.confidence,
          })),
          documentAssetId: assetId,
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
      });

      // ⚠️ CORRECTION §4.1.7 — la suppression des fichiers secondaires
      // n'intervient qu'ici, après persistance ET preuves réussies.
      await guard?.assertActive('finalisation');
      if (groupSourceIds.length > 1) {
        await softDeleteSecondarySources(leadSourceId, groupSourceIds.slice(1), lotId);
      }

      await markLotItems(lotId, groupSourceIds, 'completed', persisted.runId);
      // `persisted.proposalCount` : nombre de propositions réellement écrites.
      // Voir `computeFinalState` — un document n'est mis à valider que s'il a
      // quelque chose à faire valider.
      const etatFinal = computeFinalState(result, persisted.proposalCount ?? 0);

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
      if (etatFinal === 'ANALYZED') {
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
      }

      if (!estDoublon) {
        await setState(groupSourceIds, etatFinal);
      }

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
      console.warn(`[source-analysis] analyse T1 en échec pour la source ${leadSourceId} :`, (e as Error).message);
      const definitif = e instanceof T1MasterAnalysisError && e.definitive;
      await failSources(groupSourceIds, failReason(e), lotId, { definitive: definitif });
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
  // NOTIFICATION DE FIN DE LOT — CDC notifications §7.2
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
      failedCount: Math.max(0, pendingIds.length - analysedCount),
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
  };
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

/** Motif d'échec affiché dans le tiroir du document (borné, sans pile). */
function failReason(e: unknown): string {
  const message = ((e as Error)?.message ?? 'erreur inconnue').slice(0, 300);
  return e instanceof T1MasterAnalysisError
    ? `Analyse impossible (prompt maître T1) : ${message}`
    : message;
}

// ── Helpers d'état et de persistance ───────────────────────────────────────

function resolveAssetId(result: SourceAnalysisResult, input: SourceInput): number | null {
  if (input.linkedAssetId) return input.linkedAssetId;
  const verified = result.assetCandidates.filter((c) => c.verified && c.entityId !== null);
  // Un seul candidat certain : rattachement possible. Sinon, la réconciliation
  // arbitrera — l'analyse ne tranche pas un rattachement ambigu.
  if (verified.length === 1 && verified[0].confidence === 'certain') return verified[0].entityId;
  return null;
}

/**
 * État final du document — CDC §4.2.4.
 *
 * ⚠️ `VALIDATION_REQUIRED` est une PROMESSE FAITE À L'UTILISATEUR : « ouvrez ce
 * document, il y a une décision à prendre ». Elle n'est tenable que si une
 * proposition l'accompagne. Un document marqué à valider dont le tiroir ne
 * montre rien est une impasse : l'utilisateur ne peut ni décider, ni sortir de
 * l'état.
 *
 * Deux corrections par rapport à la version précédente :
 *
 * • `NO_EXPLOITABLE_CONTENT` ne met plus le document à valider. Un document
 *   illisible n'appelle AUCUNE décision de l'utilisateur — il n'y a rien à
 *   trancher. Il est classé `ANALYZED`, l'avertissement restant consultable
 *   dans le résultat d'analyse.
 *
 * • L'ambiguïté de rattachement ne met le document à valider QUE si une
 *   proposition a effectivement été écrite. Le §4.2.4 est explicite :
 *   « preuve probable ou ambiguë → proposition ou revue IA ciblée ». Pas un
 *   état, une proposition. Tant que le pipeline n'en écrit pas, marquer le
 *   document à valider promet une décision qu'on ne présente jamais.
 */
function computeFinalState(result: SourceAnalysisResult, proposalCount: number): string {
  const ambiguous = result.warnings.some(
    (w) => w.code === 'AMBIGUOUS_ASSET' || w.code === 'MULTI_ASSET_DOCUMENT',
  );

  // La condition porte sur les propositions écrites, jamais sur l'ambiguïté
  // seule : c'est ce qui garantit qu'un document à valider a toujours quelque
  // chose à montrer.
  if (ambiguous && proposalCount > 0) return 'VALIDATION_REQUIRED';

  return 'ANALYZED';
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
  patch.analysisFailReason = sql`CASE WHEN ${assetFiles.analysisFailReason} LIKE ${COST_CAP_REASON_PREFIX + '%'} THEN NULL ELSE ${assetFiles.analysisFailReason} END`;
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
  for (const id of ids) broadcast(id, { type: 'error', analysisState: 'ANALYSIS_FAILED', message: reason });
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

async function openLot(accountId: number, ids: number[]): Promise<number> {
  const [lot] = await db.insert(documentLots)
    .values({ accountId, status: 'analyzing' })
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

/** Contexte du compte — borné, réutilisé par toutes les étapes (§5.6). */
async function loadAnalysisContext(
  accountId: number, linkedAssetId: number | null,
): Promise<AnalysisContext> {
  const assetRows = await db
    .select({ id: assets.id, name: assets.name, category: assets.category, subtype: assets.subtype })
    .from(assets)
    .where(and(eq(assets.accountId, accountId), isNull(assets.deletedAt)))
    .limit(200);

  const assetIds = assetRows.map((a) => a.id);

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
  };
}
