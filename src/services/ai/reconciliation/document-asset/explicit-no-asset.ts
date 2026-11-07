/**
 * Lot 113V (#719, post-MEP) — T3 DOCUMENT_ASSET face à un NON-RATTACHEMENT
 * EXPLICITE (« Aucun » choisi sur la carte « À quel bien rattacher ce
 * document ? »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA DÉCISION DE L'UTILISATEUR PRIME — SANS APPEL AU MODÈLE
 *
 * T3 lit la décision AVANT toute écriture, comme un choix de l'utilisateur
 * (`readExplicitNoAssetDecision`). Le modèle n'est JAMAIS appelé pour un tel
 * document : il n'a donc pas besoin de connaître la décision (aucune
 * consigne de prompt nécessaire). Le contexte est reconstruit sans IA
 * (connaissance persistée, Candidate Builder, règles déterministes) pour un
 * seul usage : repérer un élément RÉELLEMENT NOUVEAU (`noAssetNewElements`) :
 *
 *   · rien de nouveau (même document, mêmes biens, réanalyse TCO ou
 *     ordinaire, passage planifié) → aucune carte, aucun rattachement, issue
 *     `USER_DECIDED` / `USER_NO_ASSET` datée (empreinte du contexte : le
 *     passage suivant confirme sans travail) ; une carte de réexamen devenue
 *     sans objet (bien supprimé entre-temps) est fermée ;
 *   · bien ajouté depuis le choix et désigné (candidat ou preuve), ou preuve
 *     déterministe nouvelle après une nouvelle analyse du document → UNE carte
 *     LINK-ASSET qui NOMME l'élément nouveau (question du producteur, origine
 *     CODE) : la décision n'est JAMAIS écrasée automatiquement ; tant que
 *     l'utilisateur n'a pas répondu, la même carte est entretenue (aucun
 *     doublon, aucune relance) ; « Aucun » de nouveau → l'élément fait partie
 *     des biens présentés : plus de réexamen pour lui.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { unnamedLabel } from '@/services/to-process/card-labels';
import {
  NO_ASSET_REASON_CODE, noAssetNewElements, noAssetReexaminationQuestion, type ExplicitNoAssetDecision,
} from '@/services/to-process/no-asset-choice';
import type { QuestionSource } from '@/services/to-process/ai-user-question';
import { closeAssetLinkQuestion } from './automatic-attachment';
import type { DocumentAssetContext } from './context';
import { decideContextualDeterministic, decideDeterministic } from './decision';
import { decideFromIdentity } from './identity/decision';
import { identityGraphFailed } from './identity/load';
import { recordOutcome, type StoredCandidate } from './resolution.repository';
import type { DocumentAssetEvaluation, ToProcessEffect } from './resolve-document-asset.service';

/** Trace de l'évaluation d'un document « Aucun » (monitoring). */
export interface ExplicitNoAssetEvaluation {
  decisionActionId: number;
  decidedAt: string;
  offeredAssetIds: number[];
  documentChanged: boolean;
  newAssetIds: number[];
  newEvidenceAssetIds: number[];
}

type Draft = Omit<DocumentAssetEvaluation, 'newResolution' | 'aiCalled' | 'decision' | 'linkedAssetId' | 'toProcessAction' | 'result' | 'promptCandidateCount'>;

export interface RespectNoAssetDeps {
  /** Biens pouvant recevoir le document (défaut : règle de la carte, lot 113A). */
  eligibleAssets?: (accountId: number) => Promise<Array<{ id: number; name: string | null }>>;
  /** Révision de la connaissance du document (défaut : celle du pont documentaire). */
  documentRevision?: (accountId: number, fileId: number) => Promise<string | null>;
}

/** Biens désignés par une preuve DÉTERMINISTE (sans IA), dans le contexte actuel. Pure. */
export function provenAssetIds(ctx: Pick<DocumentAssetContext, 'identification' | 'candidates' | 'multiAssetDeclared' | 'identity' | 'identityGraphStatus'>): number[] {
  const opts = { multiAssetDeclared: ctx.multiAssetDeclared };
  const d = decideDeterministic(ctx.identification, opts)
    ?? decideContextualDeterministic(ctx.candidates, ctx.identification, opts)
    ?? (identityGraphFailed({ status: ctx.identityGraphStatus as never }) ? null
      : decideFromIdentity(ctx.identity ?? null, ctx.candidates, { ...opts, identifiedAssetIds: ctx.identification.assetIds }));
  if (!d || d.kind === 'ABSTAIN') return [];
  return d.kind === 'APPLY' ? [d.assetId] : [...d.assetIds];
}

/** Provenance CODE de la question d'un réexamen (formulation déterministe du producteur). */
function codeSource(): QuestionSource {
  return {
    origin: 'CODE', rule: 'LINK-ASSET', treatment: 'T3', operation: null, contract: null, contractActive: false,
    promptVersion: null, traceId: null, fallback: 'AI_NOT_CALLED', rejection: null, at: new Date().toISOString(),
  };
}

/**
 * Évaluation T3 d'un document dont le non-rattachement est explicite. Aucun
 * appel au modèle, aucun lien, aucune colonne. Ne lève que pour une
 * interruption (garde d'exécution).
 */
export async function respectExplicitNoAsset(p: {
  accountId: number; fileId: number; decision: ExplicitNoAssetDecision; ctx: DocumentAssetContext; revision: number;
  /** Document ouvert (ni brouillon, ni écarté) : une carte peut être soumise. */
  open: boolean; cardBefore: number | null; evaluation: Draft;
  g: (quoi: string) => Promise<void>;
  deps?: RespectNoAssetDeps;
}): Promise<{ outcome: 'SUPERSEDED'; status: 'USER_DECIDED'; aiCalled: false; evaluation: DocumentAssetEvaluation }> {
  const { accountId, fileId, ctx, decision } = p;
  const eligibles = await (p.deps?.eligibleAssets ?? (async (a: number) => (await import('@/services/to-process/asset-link-choices')).loadEligibleLinkAssets(a)))(accountId);
  const nomDe = new Map(eligibles.map((a) => [a.id, a.name && a.name.trim() ? a.name.trim() : unnamedLabel('ASSET')]));
  let revDoc: string | null = null;
  try {
    revDoc = await (p.deps?.documentRevision ?? (async (a: number, f: number) => (await import('@/services/to-process/document-field-evidence')).currentKnowledgeRev(a, f)))(accountId, fileId);
  } catch (e) {
    console.error(`[t3-document-asset] révision du document ${fileId} illisible (choix « Aucun ») :`, (e as Error).message);
  }
  const documentChanged = decision.knowledgeRev !== null && revDoc !== null && revDoc !== decision.knowledgeRev;
  const prouves = provenAssetIds(ctx);
  const el = noAssetNewElements({
    offeredAssetIds: decision.offeredAssetIds, provenAssetIds: prouves, candidateAssetIds: ctx.candidates.map((c) => c.assetId),
    eligibleAssetIds: eligibles.map((a) => a.id), documentChanged,
  });
  const suivi: ExplicitNoAssetEvaluation = {
    decisionActionId: decision.actionId, decidedAt: decision.decidedAt, offeredAssetIds: decision.offeredAssetIds.slice(0, 50),
    documentChanged, newAssetIds: el.newAssetIds, newEvidenceAssetIds: el.newEvidenceAssetIds,
  };
  const candidates: StoredCandidate[] = el.proposalIds.map((id) => ({
    assetId: id, label: nomDe.get(id) ?? unnamedLabel('ASSET'), score: prouves.includes(id) ? 0.85 : 0.5,
    reason: el.newAssetIds.includes(id) ? 'NEW_ASSET_SINCE_NO_ASSET_CHOICE' : 'NEW_EVIDENCE_SINCE_NO_ASSET_CHOICE',
  }));

  let effet: ToProcessEffect = 'NONE';
  if (candidates.length > 0 && p.open) {
    await p.g('question « À traiter » (réexamen après « Aucun »)');
    const { upsertAction } = await import('@/services/to-process/to-process-action.service');
    const r = await upsertAction({
      accountId, targetType: 'DOCUMENT', targetId: fileId, relationKey: 'assetIds', actionKind: 'ARBITRATE', ruleCode: 'LINK-ASSET',
      question: noAssetReexaminationQuestion({
        newAssetLabels: el.newAssetIds.map((id) => nomDe.get(id) ?? unnamedLabel('ASSET')), newEvidence: el.newEvidenceAssetIds.length > 0,
      }),
      questionSource: codeSource(),
      proposals: candidates.map((c) => ({ value: c.assetId, label: c.label, confidence: c.score })),
      triggerContext: {
        current: '', producer: 'T3_DOCUMENT_ASSET',
        reexamination: { after: NO_ASSET_REASON_CODE, decisionActionId: decision.actionId, newAssetIds: el.newAssetIds, newEvidenceAssetIds: el.newEvidenceAssetIds },
      },
    });
    effet = r.status === 'CREATED' ? 'CREATED' : r.status === 'UPDATED' ? 'UPDATED' : 'SKIPPED';
  } else if (p.cardBefore !== null) {
    // Carte de réexamen devenue sans objet (élément nouveau disparu) : fermée par le système.
    await p.g('question « À traiter » sans objet (choix « Aucun »)');
    effet = (await closeAssetLinkQuestion(accountId, fileId)) > 0 ? 'CLOSED' : 'UNCHANGED';
  }

  const evaluation: DocumentAssetEvaluation & { explicitNoAsset: ExplicitNoAssetEvaluation } = {
    ...p.evaluation, aiCalled: false, promptCandidateCount: 0, decision: `USER_DECIDED:${NO_ASSET_REASON_CODE}`, linkedAssetId: null,
    newResolution: 'USER_DECIDED', toProcessAction: effet, result: 'USER_DECIDED', reasonCode: NO_ASSET_REASON_CODE, branch: 'NONE',
    ai: { operation: 't3_link_ambiguity', traceIds: [], status: 'NOT_CALLED', error: null, reason: 'USER_NO_ASSET_RESPECTED' },
    explicitNoAsset: suivi,
  };
  await p.g('état de résolution');
  await recordOutcome({
    accountId, fileId, status: 'USER_DECIDED', method: 'NONE', reasonCode: NO_ASSET_REASON_CODE, candidates,
    inputFingerprint: ctx.fingerprint, extractionAt: ctx.extractionAt, identifiersFingerprint: ctx.idsFingerprint,
    knowledgeRevision: p.revision, contextFingerprint: ctx.fingerprint, lastEvaluation: { ...evaluation },
  });
  console.info(`[t3-document-asset] document ${fileId} : choix « Aucun » respecté (décision ${decision.actionId})`
    + ` · nouveaux biens ${el.newAssetIds.length} · preuves nouvelles ${el.newEvidenceAssetIds.length} · À traiter ${effet} · IA : NON`);
  return { outcome: 'SUPERSEDED', status: 'USER_DECIDED', aiCalled: false, evaluation };
}
