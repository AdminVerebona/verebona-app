/**
 * T3 DOCUMENT_ASSET — reprise automatique du rattachement Document → Bien
 * que T1 n'a pas résolu avec certitude (lot 31B, ticket T3).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉROULÉ (un travail T3 de cible `document`, idempotent et relançable)
 *
 *   1. Relecture CANONIQUE : document disparu → TARGET_GONE ; décision de
 *      l'utilisateur (lien USER, rattachement choisi ou retiré) → rien ;
 *      rattachement principal déjà posé (colonne, lien PRIMARY) → rien.
 *      Un lien MENTIONED n'est PAS un rattachement.
 *   2. Entrées PERSISTÉES seulement — jamais le fichier : candidats et
 *      preuves de T1 (`document_asset_resolutions.t1_candidates`), faits et
 *      texte de la base de connaissance (`document_extractions`,
 *      `document_facts`), liens IA existants, identifiants canoniques des
 *      biens du compte.
 *   3. Déterministe d'abord : identifiant exact et unique → rattachement sans
 *      IA ; identifiants exclusifs de plusieurs biens dans un document
 *      multi-biens → A ET B.
 *   4. Sinon, s'il existe des candidats : prompt maître T3 (branche
 *      LINK_AMBIGUITY, relation DOCUMENT_ASSET), puis décision déterministe
 *      (`decideFromAiOutput`). Aucun candidat : rien à demander au modèle.
 *   5. Relecture canonique JUSTE AVANT l'écriture (choix utilisateur > IA),
 *      écriture par le service canonique Document ↔ Bien
 *      (`linkDocumentToAsset`), contrôle APRÈS l'écriture (un choix
 *      utilisateur concurrent retire le lien IA), projection des faits sur
 *      le bien (preuves, T3 du bien), événement `document_linked`.
 *   6. Abstention : UNE action « À traiter » LINK-ASSET (« À quel bien
 *      rattacher ce document ? ») avec les candidats de T3, document
 *      VALIDATION_REQUIRED — jamais avant cet échec.
 *
 * Idempotence : une relance sur les mêmes entrées (empreinte) ne rappelle
 * pas le modèle ; le lien et l'action sont uniques par construction
 * (index uniques 0221 et 0147) ; un document résolu n'est jamais rejugé.
 * Lot 32C : chaque issue porte la version du moteur et l'empreinte des
 * identifiants des biens (`resolution_version`, `identifiers_fingerprint`) ;
 * l'empreinte des entrées inclut la version — une abstention d'une version
 * antérieure est réévaluée (déterministe d'abord), jamais réutilisée.
 *
 * Lot 34E (réconciliation CONTINUE) :
 *   · les candidats sont RECONSTRUITS à chaque évaluation par le Candidate
 *     Builder serveur (`candidate-builder.ts`) depuis la connaissance
 *     persistée du document et l'état ACTUEL du compte — les candidats T1 ne
 *     sont plus qu'un indice parmi d'autres ;
 *   · NO_CANDIDATE, ABSTAINED, MULTI_ASSET ne sont jamais définitifs : chaque
 *     issue porte la révision de connaissance du compte et l'empreinte du
 *     contexte PERTINENT (`context.ts`) ; contexte identique → CONFIRMED_NO_CHANGE
 *     sans IA ; contexte modifié → réévaluation, déterministe d'abord
 *     (identifiant fort, référence partagée, nom distinctif unique), IA
 *     seulement si nécessaire ;
 *   · la carte « À traiter » LINK-ASSET reflète l'état COURANT : fermée au
 *     rattachement, COMPLETE → ARBITRATE quand des candidats apparaissent,
 *     propositions actualisées quand le jeu de candidats change ;
 *   · monitoring : `last_evaluation` et détail du travail (révisions, motif,
 *     empreintes, sources testées, candidats, IA, décision, action).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { AiGateway } from '../../gateway/ai-gateway';
import { isExecutionCancelled, type ExecutionGuard } from '../../queue/execution-control';
import { T3LinkAmbiguityOutput } from '../master/t3-contract';
import { unlinkDocument } from '@/services/documents/document-asset-links';
import { attachAutomatically, clearAutomaticPrimaryColumn, closeAssetLinkQuestion } from './automatic-attachment';
import { hasPrimaryAttachment, hasUserDecision, readAttachmentState, type AttachmentState } from './attachment-state';
import {
  decideContextualDeterministic, decideDeterministic, decideFromAiOutput, documentAssetVariables, promptCandidates, rankCandidates,
  type DocumentAssetDecision, type DocumentSubject,
} from './decision';
import { candidateSourcesOf, computeDocumentAssetContext, type DocumentAssetContext } from './context';
import type { AccountMatchingIndex } from './matching-index';
import { DOCUMENT_ASSET_RESOLUTION_VERSION } from './version';
import {
  getResolution, OPEN_OUTCOMES, recordOutcome, restoreLastOutcome,
  type DocumentAssetResolution, type ResolutionStatus, type StoredCandidate,
} from './resolution.repository';
import { getAccountKnowledgeRevision, knowledgeChangedSince } from '../continuous/knowledge-revision';

/** Issue métier d'une exécution (vocabulaire de la file T3). */
export type DocumentAssetOutcome = 'APPLIED' | 'NO_CHANGE' | 'ABSTAIN' | 'SUPERSEDED' | 'TARGET_GONE';

/**
 * Résultat lisible d'une évaluation (monitoring, ticket « réconciliation
 * continue » : « Context changed: NO / Result: CONFIRMED_NO_CHANGE / AI call: NO »).
 */
export type DocumentAssetEvaluationResult =
  | 'CONFIRMED_NO_CHANGE' | 'RESOLVED_DETERMINISTICALLY' | 'RESOLVED_BY_AI' | 'MULTI_ASSET'
  | 'ABSTAINED' | 'NO_CANDIDATE' | 'USER_DECIDED' | 'ALREADY_LINKED' | 'TARGET_GONE';

/** Action « À traiter » consécutive à l'évaluation. */
export type ToProcessEffect = 'NONE' | 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'CLOSED' | 'SKIPPED';

/** Monitoring d'une évaluation DOCUMENT_ASSET (persisté dans `last_evaluation`, rendu dans le détail du travail). */
export interface DocumentAssetEvaluation {
  documentId: number;
  at: string;
  trigger: string | null;
  reprocessReason: string | null;
  previousKnowledgeRevision: number | null;
  currentKnowledgeRevision: number;
  /** Natures de connaissance modifiées depuis la révision précédente. */
  knowledgeChanged: string[];
  previousResolution: ResolutionStatus | null;
  newResolution: ResolutionStatus | null;
  previousFingerprint: string | null;
  currentFingerprint: string;
  fingerprintChanged: boolean;
  candidateCount: number;
  /** `assetId` → sources de découverte. */
  candidateSources: Record<string, string[]>;
  /** Sources effectivement testées (NO_CANDIDATE : `candidateCount = 0` et ces sources). */
  testedSources: string[];
  deterministicMatches: string[];
  /** Candidats transmis au modèle (borne du prompt, jamais de la découverte). */
  promptCandidateCount: number;
  aiCalled: boolean;
  decision: string | null;
  linkedAssetId: number | null;
  toProcessAction: ToProcessEffect;
  result: DocumentAssetEvaluationResult;
}

export interface ResolveDocumentAssetInput {
  accountId: number;
  fileId: number;
  /** Utilisateur à l'origine (projection des faits) ; à défaut, propriétaire du document. */
  userId?: number | null;
  guard?: ExecutionGuard;
  /**
   * Dernière tentative de la file : une panne du modèle devient une
   * abstention (« À traiter ») au lieu d'une nouvelle tentative.
   */
  finalAttempt?: boolean;
  /** T3 inactif : pas d'appel modèle (déterministe seul, puis « À traiter »). */
  skipAi?: boolean;
  /** Index de rapprochement du compte déjà construit (balayage, réconciliation compte). */
  index?: AccountMatchingIndex;
  /** Déclencheur et motif de la reprise (monitoring). */
  triggerCode?: string | null;
  reprocessReason?: string | null;
}

export interface ResolveDocumentAssetResult {
  outcome: DocumentAssetOutcome;
  status: ResolutionStatus | null;
  decision?: DocumentAssetDecision;
  /** Appel modèle effectué. */
  aiCalled: boolean;
  evaluation?: DocumentAssetEvaluation;
}

/** Points d'injection (tests unitaires). */
export interface ResolveDocumentAssetDeps {
  callModel?: (p: { accountId: number; userId: number | null; fileId: number; variables: Record<string, unknown> }) => Promise<T3LinkAmbiguityOutput>;
}

async function defaultCallModel(p: { accountId: number; userId: number | null; fileId: number; variables: Record<string, unknown> }) {
  const res = await AiGateway.execute({
    useCaseCode: 'DATA_RECONCILIATION',
    operationCode: 't3_link_ambiguity',
    accountId: p.accountId,
    userId: p.userId ?? undefined,
    sourceIds: [p.fileId],
    promptVariables: p.variables,
    outputSchema: T3LinkAmbiguityOutput,
  });
  return res.data as T3LinkAmbiguityOutput;
}

/** Le contexte de la décision ouverte est-il inchangé (même empreinte, même version) ? (pure) */
export function isUnchangedOpenContext(
  r: Pick<DocumentAssetResolution, 'lastOutcome' | 'contextFingerprint' | 'resolutionVersion'> | null,
  fingerprint: string,
): boolean {
  return !!r && r.contextFingerprint === fingerprint && r.resolutionVersion === DOCUMENT_ASSET_RESOLUTION_VERSION
    && r.lastOutcome !== null && OPEN_OUTCOMES.includes(r.lastOutcome);
}

/** Base du monitoring d'une évaluation (pure). */
export function evaluationBase(p: {
  fileId: number; ctx: DocumentAssetContext; resolution: DocumentAssetResolution | null; revision: number;
  changed: string[]; triggerCode?: string | null; reprocessReason?: string | null;
}): Omit<DocumentAssetEvaluation, 'newResolution' | 'aiCalled' | 'decision' | 'linkedAssetId' | 'toProcessAction' | 'result' | 'promptCandidateCount'> {
  const prev = p.resolution?.contextFingerprint ?? null;
  return {
    documentId: p.fileId,
    at: new Date().toISOString(),
    trigger: p.triggerCode ?? null,
    reprocessReason: p.reprocessReason ?? (p.resolution ? (prev ? 'KNOWLEDGE_CHANGED' : 'LEGACY_RESOLUTION') : 'FIRST_EVALUATION'),
    previousKnowledgeRevision: p.resolution?.knowledgeRevision ?? null,
    currentKnowledgeRevision: p.revision,
    knowledgeChanged: p.changed,
    previousResolution: p.resolution?.lastOutcome ?? null,
    previousFingerprint: prev,
    currentFingerprint: p.ctx.fingerprint,
    fingerprintChanged: prev !== p.ctx.fingerprint,
    candidateCount: p.ctx.candidates.length,
    candidateSources: candidateSourcesOf(p.ctx),
    testedSources: p.ctx.build.testedSources,
    deterministicMatches: p.ctx.build.deterministicMatches,
  };
}

/** Exécute la réconciliation DOCUMENT_ASSET d'un document. Lève seulement pour être relancé (panne du modèle, interruption). */
export async function resolveDocumentAsset(
  input: ResolveDocumentAssetInput,
  deps: ResolveDocumentAssetDeps = {},
): Promise<ResolveDocumentAssetResult> {
  const { accountId, fileId } = input;

  // ── 1. Relecture canonique ────────────────────────────────────────────
  // Garde d'exécution AVANT CHAQUE écriture (lot 31C) : un travail
  // interrompu (rollback, arrêt d'urgence, bail perdu) n'écrit plus rien.
  const g: Garde = async (quoi) => { await input.guard?.assertActive(`T3 DOCUMENT_ASSET — ${quoi}`); };
  const state = await readAttachmentState(accountId, fileId);
  const stop = await stopReason(accountId, fileId, state, g);
  if (stop) return stop;

  // ── 2. Contexte ACTUEL : révision lue AVANT la relecture (une écriture
  //       concurrente rendra la décision de nouveau réévaluable), puis
  //       connaissance persistée + Candidate Builder sur TOUS les biens.
  const revision = await getAccountKnowledgeRevision(accountId);
  const resolution = await getResolution(fileId);
  const ctx = await computeDocumentAssetContext({ accountId, fileId, state, resolution, index: input.index });
  const changed = resolution?.knowledgeRevision != null ? await knowledgeChangedSince(accountId, resolution.knowledgeRevision) : [];
  const base = evaluationBase({ fileId, ctx, resolution, revision, changed, triggerCode: input.triggerCode, reprocessReason: input.reprocessReason });

  // Contexte pertinent inchangé : la décision ouverte reste valable, sans IA.
  if (isUnchangedOpenContext(resolution, ctx.fingerprint)) {
    const evaluation: DocumentAssetEvaluation = {
      ...base, newResolution: resolution!.lastOutcome, aiCalled: false, decision: null, linkedAssetId: null,
      toProcessAction: 'UNCHANGED', result: 'CONFIRMED_NO_CHANGE', promptCandidateCount: 0,
    };
    await g('état de résolution');
    await restoreLastOutcome(fileId, { identifiersFingerprint: ctx.idsFingerprint, knowledgeRevision: revision, lastEvaluation: { ...evaluation } });
    logEvaluation(evaluation);
    return { outcome: 'NO_CHANGE', status: resolution!.lastOutcome, aiCalled: false, evaluation };
  }

  // ── 3. Déterministe : identifiants forts, puis référence partagée / nom distinctif ──
  let decision = decideDeterministic(ctx.identification, { multiAssetDeclared: ctx.multiAssetDeclared })
    ?? decideContextualDeterministic(ctx.candidates, ctx.identification, { multiAssetDeclared: ctx.multiAssetDeclared });
  let aiCalled = false;
  const pourModele = promptCandidates(ctx.candidates);

  // ── 4. Modèle (candidats du serveur seulement, monde fermé) ───────────
  if (!decision) {
    if (ctx.candidates.length === 0) {
      decision = { kind: 'ABSTAIN', reasonCode: 'NO_CANDIDATE', ranked: [] };
    } else if (input.skipAi) {
      decision = { kind: 'ABSTAIN', reasonCode: 'AI_UNAVAILABLE', ranked: rankCandidates(ctx.candidates) };
    } else {
      await input.guard?.assertActive('T3 DOCUMENT_ASSET — appel du modèle');
      const ext = ctx.sources?.extraction;
      const subject: DocumentSubject = {
        title: ext?.title ?? null,
        documentType: ext?.documentType ?? null,
        documentDate: ext?.documentDate ?? null,
        supplier: ext?.supplier ?? null,
        description: ext?.description ?? null,
        multiAssetDeclared: ext?.multiAsset ?? null,
        facts: (ctx.sources?.facts ?? []).map((f) => ({ canonicalKey: f.canonicalKey, label: f.label, value: f.value, excerpt: f.excerpt })),
      };
      try {
        aiCalled = true;
        const output = await (deps.callModel ?? defaultCallModel)({
          accountId, userId: input.userId ?? state.userId, fileId, variables: documentAssetVariables(subject, pourModele),
        });
        decision = decideFromAiOutput(output, pourModele);
        // Candidats découverts au-delà de la borne du prompt : toujours proposés à l'utilisateur.
        if (decision.kind === 'ABSTAIN' && pourModele.length < ctx.candidates.length) {
          const vus = new Set(decision.ranked.map((r) => r.assetId));
          decision.ranked.push(...rankCandidates(ctx.candidates).filter((r) => !vus.has(r.assetId)).map((r) => ({ ...r, score: Math.min(r.score, 0.3) })));
        }
      } catch (e) {
        if (isExecutionCancelled(e)) throw e;
        // Panne du modèle : nouvelle tentative par la file (backoff) ; à la
        // dernière, l'utilisateur est sollicité plutôt que de laisser le
        // document sans bien.
        if (!input.finalAttempt) throw e;
        console.warn(`[t3-document-asset] document ${fileId} : modèle indisponible (${(e as Error).message}) — « À traiter ».`);
        decision = { kind: 'ABSTAIN', reasonCode: 'AI_UNAVAILABLE', ranked: rankCandidates(ctx.candidates) };
      }
    }
  }

  // ── 5 / 6. Application ────────────────────────────────────────────────
  await input.guard?.assertActive('T3 DOCUMENT_ASSET — écriture');
  const result = await applyDecision({
    accountId, fileId, userId: input.userId ?? state.userId, decision, ctx, revision, g,
    evaluation: { ...base, aiCalled, promptCandidateCount: aiCalled ? pourModele.length : 0 },
  });
  console.info(`[t3-document-asset] document ${fileId} : ${decision.kind}${decision.kind === 'ABSTAIN' ? ` (${decision.reasonCode})` : ` [${decision.method}]`} → ${result.outcome}`);
  if (result.evaluation) logEvaluation(result.evaluation);
  return { ...result, decision, aiCalled };
}

/** Une ligne de journal lisible par évaluation (exploitation). */
function logEvaluation(e: DocumentAssetEvaluation): void {
  console.info(`[t3-document-asset] document ${e.documentId} — révision ${e.previousKnowledgeRevision ?? '∅'} → ${e.currentKnowledgeRevision}`
    + ` · motif ${e.reprocessReason ?? '∅'}${e.knowledgeChanged.length ? ` (${e.knowledgeChanged.join(', ')})` : ''}`
    + ` · contexte modifié : ${e.fingerprintChanged ? 'OUI' : 'NON'} · candidats ${e.candidateCount}`
    + ` · IA : ${e.aiCalled ? 'OUI' : 'NON'} · résultat ${e.result} · À traiter ${e.toProcessAction}`);
}

/** Arrêt avant tout travail (pure vis-à-vis du modèle). */
type Garde = (quoi: string) => Promise<void>;

async function stopReason(accountId: number, fileId: number, s: AttachmentState, g: Garde): Promise<ResolveDocumentAssetResult | null> {
  if (!s.exists || hasUserDecision(s) || hasPrimaryAttachment(s)) await g('état de résolution');
  if (!s.exists) {
    await recordOutcome({ accountId, fileId, status: 'TARGET_GONE', method: 'NONE', reasonCode: 'DOCUMENT_GONE' }).catch(() => undefined);
    return { outcome: 'TARGET_GONE', status: 'TARGET_GONE', aiCalled: false };
  }
  if (hasUserDecision(s)) {
    await recordOutcome({ accountId, fileId, status: 'USER_DECIDED', method: 'NONE', reasonCode: 'USER_DECISION' });
    return { outcome: 'SUPERSEDED', status: 'USER_DECIDED', aiCalled: false };
  }
  if (hasPrimaryAttachment(s)) {
    await recordOutcome({ accountId, fileId, status: 'ALREADY_LINKED', method: 'NONE', reasonCode: 'PRIMARY_PRESENT' });
    return { outcome: 'NO_CHANGE', status: 'ALREADY_LINKED', aiCalled: false };
  }
  return null;
}

type EvaluationDraft = Omit<DocumentAssetEvaluation, 'newResolution' | 'decision' | 'linkedAssetId' | 'toProcessAction' | 'result'>;

async function applyDecision(p: {
  accountId: number; fileId: number; userId: number | null; decision: DocumentAssetDecision;
  ctx: DocumentAssetContext; revision: number; g: Garde; evaluation: EvaluationDraft;
}): Promise<Omit<ResolveDocumentAssetResult, 'decision' | 'aiCalled'>> {
  const { accountId, fileId, decision, g, ctx } = p;
  const fin = (o: { newResolution: ResolutionStatus | null; linkedAssetId?: number | null; toProcessAction: ToProcessEffect; result: DocumentAssetEvaluationResult }): DocumentAssetEvaluation => ({
    ...p.evaluation, decision: decision.kind === 'ABSTAIN' ? `ABSTAIN:${decision.reasonCode}` : `${decision.kind}:${decision.method}`,
    linkedAssetId: o.linkedAssetId ?? null, newResolution: o.newResolution, toProcessAction: o.toProcessAction, result: o.result,
  });
  // Relecture JUSTE AVANT l'écriture : l'utilisateur a pu trancher pendant
  // l'appel au modèle (ticket T3, §11).
  const avant = await readAttachmentState(accountId, fileId);
  const stop = await stopReason(accountId, fileId, avant, g);
  if (stop) return stop.outcome === 'NO_CHANGE' ? { ...stop, outcome: 'SUPERSEDED' } : stop;
  const commun = {
    inputFingerprint: ctx.fingerprint, extractionAt: ctx.extractionAt, identifiersFingerprint: ctx.idsFingerprint,
    knowledgeRevision: p.revision, contextFingerprint: ctx.fingerprint,
  };

  if (decision.kind === 'ABSTAIN') {
    const candidates: StoredCandidate[] = decision.ranked.map((r) => ({
      assetId: r.assetId, label: ctx.labels.get(r.assetId)?.name ?? `Bien ${r.assetId}`, score: r.score, reason: r.reason,
    }));
    // Carte LINK-ASSET synchronisée sur l'état COURANT (créée, ou
    // COMPLETE → ARBITRATE, ou propositions actualisées).
    const effet = await openUserQuestion({ accountId, fileId, state: avant, candidates, g });
    const status = decision.reasonCode === 'NO_CANDIDATE' ? 'NO_CANDIDATE' : 'ABSTAINED';
    const evaluation = fin({ newResolution: status, toProcessAction: effet, result: status });
    await g('état de résolution');
    await recordOutcome({
      accountId, fileId, status, method: decision.reasonCode === 'NO_CANDIDATE' ? 'NONE' : 'AI', reasonCode: decision.reasonCode,
      candidates, ...commun, lastEvaluation: { ...evaluation },
    });
    return { outcome: 'ABSTAIN', status, evaluation };
  }

  const cibles = decision.kind === 'APPLY' ? [decision.assetId] : decision.assetIds;
  const role = decision.kind === 'APPLY' ? 'PRIMARY' as const : 'SECONDARY' as const;
  // Fermer l'éventuelle question AVANT d'écrire : le déclencheur 0257 la
  // fermerait sinon avec un motif « utilisateur ».
  await g('question « À traiter »');
  const fermees = await closeAssetLinkQuestion(accountId, fileId);
  for (const assetId of cibles) {
    await g('lien et colonne de rattachement');
    await attachAutomatically({
      accountId, fileId, assetId, role, confidence: decision.kind === 'APPLY' ? decision.score : 1,
    });
  }

  // Contrôle APRÈS l'écriture : un rattachement utilisateur concurrent gagne.
  const apres = await readAttachmentState(accountId, fileId);
  const concurrent = hasUserDecision(apres)
    || (apres.columnAssetId !== null && !(decision.kind === 'APPLY' && apres.columnAssetId === decision.assetId && apres.columnIsAutomatic))
    || apres.primaryAssetIds.some((id) => !cibles.includes(id));
  if (concurrent) {
    for (const assetId of cibles) {
      if (!apres.userLinkAssetIds.includes(assetId)) {
        await g('retrait du lien IA');
        await unlinkDocument({ accountId, fileId, target: { assetId }, origins: ['AI'] });
        await clearAutomaticPrimaryColumn(accountId, fileId, assetId);
      }
    }
    await g('état de résolution');
    await recordOutcome({ accountId, fileId, status: 'USER_DECIDED', method: decision.method, reasonCode: 'USER_DECISION_CONCURRENT' });
    return { outcome: 'SUPERSEDED', status: 'USER_DECIDED' };
  }

  // Le document n'attend plus de décision : « à valider » levé.
  await g('état du document');
  await setAnalysisState(accountId, fileId, 'VALIDATION_REQUIRED', 'ANALYZED');
  await g('projection et événement document_linked');
  await afterLink({ accountId, fileId, userId: p.userId, assetIds: cibles });

  const status = decision.kind === 'APPLY' ? 'RESOLVED' : 'MULTI_ASSET';
  // Multi-biens : la décision reste OUVERTE (aucun bien principal). Son
  // empreinte est celle du contexte APRÈS l'écriture (ses propres liens
  // SECONDARY compris) : le passage suivant ne la rejoue pas pour ses
  // propres liens.
  const fingerprint = decision.kind === 'MULTI_ASSET'
    ? (await computeDocumentAssetContext({ accountId, fileId, state: apres, resolution: { t1Candidates: ctx.t1Candidates }, index: ctx.index })).fingerprint
    : ctx.fingerprint;
  const evaluation = fin({
    newResolution: status, linkedAssetId: decision.kind === 'APPLY' ? decision.assetId : null,
    toProcessAction: fermees > 0 ? 'CLOSED' : 'NONE',
    result: decision.kind === 'MULTI_ASSET' ? 'MULTI_ASSET' : decision.method === 'AI' ? 'RESOLVED_BY_AI' : 'RESOLVED_DETERMINISTICALLY',
  });
  await g('état de résolution');
  await recordOutcome({
    accountId, fileId, status, method: decision.method, reasonCode: decision.reason.slice(0, 200),
    decidedAssetIds: cibles, ...commun, contextFingerprint: fingerprint, inputFingerprint: fingerprint, lastEvaluation: { ...evaluation },
  });
  return { outcome: 'APPLIED', status, evaluation };
}

/**
 * Après un rattachement par T3 : faits persistés projetés sur le bien
 * (preuves, réconciliation T3 du bien — `projectDocumentKnowledgeToAsset`),
 * puis événement `document_linked`. Non bloquant : le lien est posé.
 */
async function afterLink(p: { accountId: number; fileId: number; userId: number | null; assetIds: number[] }): Promise<void> {
  const k = await import('../../knowledge/document-knowledge.service');
  const { enqueueT3ForAssets } = await import('../t3-queue');
  for (const assetId of p.assetIds) {
    try {
      const projetable = p.userId ? await k.hasProjectableKnowledge(p.fileId) : false;
      if (projetable && p.userId) {
        await k.projectDocumentKnowledgeToAsset({ accountId: p.accountId, userId: p.userId, fileId: p.fileId, assetId });
      } else if (p.userId) {
        await enqueueT3ForAssets({ accountId: p.accountId, userId: p.userId, assetIds: [assetId], sourceFileId: p.fileId, reason: 'document_linked' });
      }
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      console.error(`[t3-document-asset] projection du document ${p.fileId} sur le bien ${assetId} impossible :`, (e as Error).message);
    }
  }
  try {
    const { enqueueAccountReconciliation } = await import('../account-reconciliation.service');
    await enqueueAccountReconciliation(p.accountId, { event: 'document_linked', objectType: 'document', objectId: p.fileId });
  } catch (e) {
    console.error(`[t3-document-asset] événement document_linked du document ${p.fileId} non émis :`, (e as Error).message);
  }
  // Nouvelle connaissance T3 (document → bien) : contrôle ciblé du titre
  // (moteur de titre commun, origine T3 ; un titre USER n'est jamais touché).
  await refreshDocumentTitle(p.accountId, p.fileId);
}

/** Contrôle ciblé du titre après une nouvelle connaissance T3 (ne lève jamais, sauf interruption). */
export async function refreshDocumentTitle(accountId: number, fileId: number): Promise<void> {
  try {
    const { ensureBusinessTitle } = await import('@/services/documents/document-title.service');
    await ensureBusinessTitle({ fileId, accountId, origin: 'T3', mode: 'repair', trigger: 'CONTEXT_CHANGED' });
  } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    console.error(`[t3-document-asset] contrôle du titre du document ${fileId} impossible :`, (e as Error).message);
  }
}

/**
 * Abstention de T3 : UNE action « À traiter » LINK-ASSET (index unique des
 * actions actives), ARBITRATE avec les candidats de T3, ou COMPLETE sans
 * candidat. Document « à valider » si une proposition l'accompagne.
 */
async function openUserQuestion(p: { accountId: number; fileId: number; state: AttachmentState; candidates: StoredCandidate[]; g: Garde }): Promise<ToProcessEffect> {
  if (!p.state.open) return 'NONE';
  await p.g('question « À traiter »');
  const { upsertAction } = await import('@/services/to-process/to-process-action.service');
  const proposals = p.candidates.slice(0, 5).map((c) => ({
    value: c.assetId, label: c.label, confidence: Math.min(0.89, Math.max(0, c.score)),
    sourceContext: { label: c.reason.slice(0, 120) },
  }));
  const res = await upsertAction({
    accountId: p.accountId,
    targetType: 'DOCUMENT',
    targetId: p.fileId,
    relationKey: 'assetIds',
    actionKind: proposals.length > 0 ? 'ARBITRATE' : 'COMPLETE',
    ruleCode: 'LINK-ASSET',
    proposals,
    // `current` : même instantané que le pont documentaire (rattachement vide).
    triggerContext: { current: '', producer: 'T3_DOCUMENT_ASSET' },
  });
  if (proposals.length > 0 && res.status !== 'SKIPPED' && p.state.analysisState === 'ANALYZED') {
    await p.g('état du document');
    await setAnalysisState(p.accountId, p.fileId, 'ANALYZED', 'VALIDATION_REQUIRED');
  }
  return res.status === 'CREATED' ? 'CREATED' : res.status === 'UPDATED' ? 'UPDATED' : 'SKIPPED';
}

/** Transition d'état d'analyse conditionnelle, diffusée au tiroir du document (SSE). */
async function setAnalysisState(accountId: number, fileId: number, from: string, to: string): Promise<void> {
  const rows = (await pgClient.unsafe(
    `UPDATE asset_files SET analysis_state = $4, updated_at = now()
      WHERE id = $1 AND account_id = $2 AND analysis_state = $3 RETURNING id`,
    [fileId, accountId, from, to] as never[],
  )) as unknown as unknown[];
  if (rows.length > 0) {
    const { broadcast } = await import('../../source-analysis/stream/broadcast');
    broadcast(fileId, { type: 'state_update', analysisState: to });
  }
}
