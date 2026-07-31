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
 *     pipeline appelait `applyAiSuggestionsToAsset`, `linkDocumentToEquipments`
 *     puis, une heure plus tard, `enrich-and-coherence` : jusqu'à cinq appels
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
import { db } from '@/db';
import { assetFiles, assets, rooms, equipments, documentLots, documentLotItems } from '@/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { canConsumeAnalysis, consumeAnalysisCredits } from '@/services/commercial-model.service';

import { getSourceAdapter } from './adapters';
import { groupSources } from './steps/group-sources.step';
import { extractSource } from './steps/extract-source.step';
import { classifyDocument } from './steps/classify-document.step';
import { classifyCategory } from './steps/classify-category.step';
import { updateClassification } from '@/services/documents/classification.service';

/**
 * Version du pipeline, consignée avec chaque correction utilisateur.
 *
 * Sans elle, le signal d'échec du §5.2 est inexploitable : on saurait que le
 * modèle s'est trompé, jamais quelle version s'est trompée — donc jamais si
 * une évolution a corrigé le défaut ou l'a aggravé.
 */
const PIPELINE_VERSION = 'source-analysis-v1';

/**
 * Traduit la confiance qualitative du modèle en score numérique.
 *
 * Les trois niveaux du schéma sont volontairement grossiers : un modèle qui
 * annonce « 0,87 » invente une précision qu'il n'a pas. La conversion sert au
 * stockage et à la mesure, jamais à l'affichage (§8.2).
 */
function confidenceToScore(c?: 'certain' | 'probable' | 'conflictual'): number | null {
  if (c === 'certain') return 1;
  if (c === 'probable') return 0.6;
  if (c === 'conflictual') return 0.3;
  return null;
}
import { identifyEntities } from './steps/identify-entities.step';
import { buildAgendaCandidates } from './steps/build-agenda-candidates.step';
import { persistEvidence } from './steps/persist-evidence.step';
import { persistAnalysisResult } from './persistence/analysis-result.repository';
import { notifyLotCompleted } from './lot-notification';
import { broadcast } from './stream/broadcast';
import { combineTraces } from './trace';
import { emitSourceAnalyzed } from './events';
import type {
  SourceInput, SourceType, SourceAnalysisResult, AnalysisContext, AnalysisWarning,
} from './types';

export interface RunSourceAnalysisInput {
  sourceType: SourceType;
  sourceIds: number[];
  accountId: number;
  userId: number;
  linkedAssetId?: number | null;
  /** Consommer un crédit d'analyse. false pour une réanalyse technique. */
  billable?: boolean;
}

export interface RunSourceAnalysisOutput {
  results: SourceAnalysisResult[];
  analysedCount: number;
  skippedReason?: 'quota' | 'already_running' | 'no_valid_source';
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
    return { results: [], analysedCount: 0, skippedReason: 'no_valid_source' };
  }

  // Déduplication : ne pas relancer une analyse déjà en cours (§5.7).
  const pendingIds = await excludeInProgress(ownedIds);
  if (pendingIds.length === 0) {
    return { results: [], analysedCount: 0, skippedReason: 'already_running' };
  }

  // Quota : vérifié avant tout appel facturable.
  if (req.billable !== false) {
    const gate = await canConsumeAnalysis(req.accountId, pendingIds.length);
    if (!gate.allowed) return { results: [], analysedCount: 0, skippedReason: 'quota' };
  }

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
    return { results: [], analysedCount: 0, skippedReason: 'no_valid_source' };
  }

  // ── Étape 4 : regroupement (interne, jamais un usage) ───────────────────
  const { groups, trace: groupTrace } = await groupSources(input);

  const ctx = await loadAnalysisContext(req.accountId, input.linkedAssetId ?? null);

  // ── Étapes 5 à 12, par groupe ───────────────────────────────────────────
  const results: SourceAnalysisResult[] = [];
  let analysedCount = 0;

  for (const groupIndices of groups) {
    const leadSourceId = input.sourceIds[groupIndices[0]];
    const groupSourceIds = groupIndices.map((i) => input.sourceIds[i]);

    broadcast(leadSourceId, { type: 'progress', stage: 'extraction' });

    try {
      const result = await analyseGroup(input, groupIndices, ctx, groupTrace);

      broadcast(leadSourceId, { type: 'progress', stage: 'persistance' });

      // Étape 12 — persistance, idempotente.
      const persisted = await persistAnalysisResult({
        input, leadSourceId, groupSourceIds, lotId, result,
      });

      // ══════════════════════════════════════════════════════════════════
      // ÉTAPE 12 bis — ÉCRITURE DU CLASSEMENT (CDC 5 §5.2, §8.4)
      //
      // Passe par `updateClassification`, jamais par une écriture directe.
      // Ce service applique les règles du §4.3 — compatibilité, attribution
      // automatique, recalcul de l'état — et surtout LES VERROUILLAGES :
      // une catégorie posée par l'utilisateur n'est pas écrasée par le modèle.
      //
      // Écrire directement dans `asset_files` contournerait ces règles, et
      // l'utilisateur verrait son classement manuel défait à la prochaine
      // réanalyse — sans rien pour l'expliquer.
      //
      // Ne lève jamais : l'analyse a réussi et les résultats sont écrits. Un
      // classement manqué se rattrape, une analyse perdue non.
      // ══════════════════════════════════════════════════════════════════
      if (result.document.category?.value || result.document.type?.value) {
        await updateClassification({
          // Les sources SONT les fichiers : `filterOwnedSources` les lit dans
          // `asset_files`. Le document de tête porte donc le classement du
          // groupe — c'est lui qui reste visible, les secondaires étant
          // marqués supprimés au regroupement.
          fileId: leadSourceId,
          accountId: input.accountId,
          categoryCode: result.document.category?.value,
          documentTypeCode: result.document.type?.value,
          source: 'AI',
          // §8.2 : enregistrées, jamais exposées au front.
          categoryConfidence: confidenceToScore(result.document.category?.confidence),
          typeConfidence: confidenceToScore(result.document.type?.confidence),
          pipelineVersion: PIPELINE_VERSION,
        }).catch((e) => {
          console.error(
            `[source-analysis] classement du fichier ${leadSourceId} impossible :`,
            (e as Error).message,
          );
        });
      }

      // Étape 9 (suite) — preuves, uniquement si un bien est déterminé.
      const assetId = resolveAssetId(result, input);
      if (assetId) {
        await persistEvidence({
          input,
          leadSourceId,
          assetId,
          fields: result.extractedFields,
          documentType: result.document.type?.value,
          documentDate: result.document.date?.value,
          trace: result.operationTrace,
        });
      }

      // ⚠️ CORRECTION §4.1.7 — la suppression des fichiers secondaires
      // n'intervient qu'ici, après persistance ET preuves réussies.
      if (groupSourceIds.length > 1) {
        await softDeleteSecondarySources(groupSourceIds.slice(1), lotId);
      }

      await markLotItems(lotId, groupSourceIds, 'completed', persisted.runId);
      // `persisted.proposalCount` : nombre de propositions réellement écrites.
      // Voir `computeFinalState` — un document n'est mis à valider que s'il a
      // quelque chose à faire valider.
      await setState(groupSourceIds, computeFinalState(result, persisted.proposalCount ?? 0));

      if (!persisted.deduplicated) analysedCount++;
      results.push(result);

      // ── Étapes 13 et 14 : déclenchement des moteurs aval ────────────────
      // Émission d'événement, jamais d'import direct : le pipeline ne connaît
      // ni la réconciliation ni l'agenda, ce qui permet le mode shadow (§10.2).
      await emitSourceAnalyzed({
        accountId: req.accountId,
        userId: req.userId,
        assetId,
        leadSourceId,
        result,
      });
    } catch (e) {
      await failSources(groupSourceIds, (e as Error).message, lotId);
    }
  }

  if (analysedCount > 0 && req.billable !== false) {
    await consumeAnalysisCredits(req.accountId, analysedCount).catch(() => {});
  }

  await closeLot(lotId);

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
  await notifyLotCompleted({
    accountId: req.accountId,
    userId: req.userId,
    lotId,
    analysedCount,
    failedCount: Math.max(0, pendingIds.length - analysedCount),
  });

  return { results, analysedCount };
}

/** Étapes 5 à 11 pour un groupe de sources constituant un même document. */
async function analyseGroup(
  input: SourceInput,
  groupIndices: number[],
  ctx: AnalysisContext,
  groupTrace: SourceAnalysisResult['operationTrace'],
): Promise<SourceAnalysisResult> {
  const warnings: AnalysisWarning[] = [];

  // Étapes 5 et 7 — extraction du contenu et des informations structurées.
  const extracted = await extractSource(input, groupIndices, ctx);
  warnings.push(...extracted.warnings);

  const hints = {
    title: extracted.document.title?.value,
    supplierName: extracted.document.supplier?.value.name,
    extractedText: extracted.document.transcription,
  };

  // Étapes 6 et 8 — parallélisables : aucune ne dépend de l'autre.
  const [classified, entities] = await Promise.all([
    classifyDocument(input, groupIndices, hints),
    identifyEntities(input, groupIndices, ctx, hints),
  ]);
  warnings.push(...entities.warnings);

  // ══════════════════════════════════════════════════════════════════════
  // ÉTAPE 6 bis — CATÉGORIE (CDC 5 §7.1)
  //
  // APRÈS la classification par type et l'identification des entités, car
  // elle dépend des deux : le type détermine les catégories possibles (§4.3),
  // et les biens rattachés les restreignent encore (§4.4).
  //
  // La règle déterministe tranche la majorité des cas sans appel modèle — un
  // DPE, une garantie, un contrôle technique n'admettent qu'une catégorie.
  // ══════════════════════════════════════════════════════════════════════
  const categorie = await classifyCategory(input, groupIndices, {
    documentType: (classified.type ?? extracted.document.type)?.value,
    assetIds: entities.assetCandidates
      .map((c) => c.entityId)
      .filter((id): id is number => typeof id === 'number'),
    title: hints.title,
    extractedText: hints.extractedText,
  });

  // Étape 11 — candidats agenda, déterministes.
  const agendaCandidates = buildAgendaCandidates(extracted.extractedFields, hints.title);

  return {
    sourceGroup: {
      sourceIds: groupIndices.map((i) => input.sourceIds[i]),
      leadSourceId: input.sourceIds[groupIndices[0]],
    },
    document: {
      ...extracted.document,
      type: classified.type ?? extracted.document.type,
      category: categorie.category,
    },
    assetCandidates: entities.assetCandidates,
    roomCandidates: entities.roomCandidates,
    // Étape 10 — les équipements sortent de l'analyse (§4.1.7), plus d'un
    // service autonome appelé après coup.
    equipmentCandidates: entities.equipmentCandidates,
    extractedFields: extracted.extractedFields,
    agendaCandidates,
    warnings,
    operationTrace: combineTraces(
      groupTrace, extracted.trace, classified.trace, entities.trace, categorie.trace,
    ),
  };
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

async function setState(ids: number[], state: string): Promise<void> {
  if (ids.length === 0) return;
  await db.update(assetFiles)
    .set({ analysisState: state, updatedAt: new Date(), analysisRetryCount: 0 })
    .where(inArray(assetFiles.id, ids));
  for (const id of ids) broadcast(id, { type: 'state_update', analysisState: state });
}

async function failSources(ids: number[], reason: string, lotId: number | null): Promise<void> {
  await db.update(assetFiles)
    .set({
      analysisState: 'ANALYSIS_FAILED',
      analysisFailReason: reason,
      analysisRetryCount: sql`${assetFiles.analysisRetryCount} + 1`,
      updatedAt: new Date(),
    })
    .where(inArray(assetFiles.id, ids));
  for (const id of ids) broadcast(id, { type: 'error', analysisState: 'ANALYSIS_FAILED', message: reason });
  await markLotItems(lotId, ids, 'failed');
}

async function softDeleteSecondarySources(ids: number[], lotId: number | null): Promise<void> {
  await db.update(assetFiles).set({ deletedAt: new Date() }).where(inArray(assetFiles.id, ids));
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

  const [roomRows, equipRows, titleRows] = await Promise.all([
    assetIds.length
      ? db.select({ id: rooms.id, name: rooms.name, assetId: rooms.assetId })
          .from(rooms).where(inArray(rooms.assetId, assetIds)).limit(300)
      : Promise.resolve([]),
    assetIds.length
      ? db.select({ id: equipments.id, name: equipments.name, type: equipments.type, assetId: equipments.assetId })
          .from(equipments).where(inArray(equipments.assetId, assetIds)).limit(300)
      : Promise.resolve([]),
    db.select({ title: assetFiles.retainedTitle })
      .from(assetFiles)
      .where(and(eq(assetFiles.accountId, accountId), isNull(assetFiles.deletedAt)))
      .limit(100),
  ]);

  return {
    accountId,
    userId: 0,
    assets: assetRows,
    rooms: roomRows as AnalysisContext['rooms'],
    equipments: equipRows as AnalysisContext['equipments'],
    existingTitles: titleRows.map((t) => t.title).filter((t): t is string => Boolean(t)),
    linkedAssetId,
  };
}
