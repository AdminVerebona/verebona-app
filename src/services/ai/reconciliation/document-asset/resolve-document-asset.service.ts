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
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import { AiGateway } from '../../gateway/ai-gateway';
import { isExecutionCancelled, type ExecutionGuard } from '../../queue/execution-control';
import { T3LinkAmbiguityOutput } from '../master/t3-contract';
import { getDocumentKnowledge } from '../../knowledge/document-knowledge.service';
import { unlinkDocument } from '@/services/documents/document-asset-links';
import { attachAutomatically, clearAutomaticPrimaryColumn, closeAssetLinkQuestion } from './automatic-attachment';
import { loadAssetIdentifiers } from './asset-identifiers.repository';
import { hasPrimaryAttachment, hasUserDecision, readAttachmentState, type AttachmentState } from './attachment-state';
import {
  decideDeterministic, decideFromAiOutput, documentAssetVariables, rankCandidates,
  type DocumentAssetCandidate, type DocumentAssetDecision, type DocumentSubject,
} from './decision';
import {
  identifiersFingerprint, matchSignals, promptIdentifiers, resolveAssetByIdentifiers, type AssetIdentifierRecord,
} from './identifiers';
import { DOCUMENT_ASSET_RESOLUTION_VERSION } from './version';
import {
  getResolution, recordOutcome, restoreLastOutcome, type ResolutionStatus, type StoredCandidate,
} from './resolution.repository';

/** Issue métier d'une exécution (vocabulaire de la file T3). */
export type DocumentAssetOutcome = 'APPLIED' | 'NO_CHANGE' | 'ABSTAIN' | 'SUPERSEDED' | 'TARGET_GONE';

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
}

export interface ResolveDocumentAssetResult {
  outcome: DocumentAssetOutcome;
  status: ResolutionStatus | null;
  decision?: DocumentAssetDecision;
  /** Appel modèle effectué. */
  aiCalled: boolean;
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

/** Noms, familles et sous-types des biens candidats (du compte, actifs). */
async function loadAssetLabels(accountId: number, ids: number[]): Promise<Map<number, { name: string; category: string | null; subtype: string | null }>> {
  if (ids.length === 0) return new Map();
  const rows = (await pgClient.unsafe(
    `SELECT id, name, category, subtype FROM assets WHERE account_id = $1 AND deleted_at IS NULL AND id = ANY($2::int[])`,
    [accountId, ids] as never[],
  )) as unknown as Array<{ id: number; name: string | null; category: string | null; subtype: string | null }>;
  return new Map(rows.map((r) => [Number(r.id), { name: r.name ?? `Bien ${r.id}`, category: r.category, subtype: r.subtype }]));
}

const factValue = (f: { normalizedValue?: unknown; valueText?: unknown; valueNumber?: unknown }): string | null => {
  const v = f.normalizedValue ?? f.valueText ?? f.valueNumber;
  return v === null || v === undefined || typeof v === 'object' ? null : String(v);
};

/**
 * Empreinte des entrées : même empreinte = même décision, sans rappeler le
 * modèle. Lot 32C : la version du moteur en fait partie — une décision n'est
 * réutilisable que si les entrées ET la version sont les mêmes.
 */
export function inputFingerprint(p: {
  extractionAt: string | null; candidates: DocumentAssetCandidate[]; matches: string[]; version?: number;
}): string {
  const payload = JSON.stringify({
    v: p.version ?? DOCUMENT_ASSET_RESOLUTION_VERSION,
    e: p.extractionAt,
    c: [...p.candidates].sort((a, b) => a.assetId - b.assetId).map((c) => [c.assetId, c.t1?.confidence ?? null, c.t1?.score ?? null, c.currentRole, c.serverSignals.length]),
    m: [...p.matches].sort(),
  });
  return createHash('sha256').update(payload).digest('hex');
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

  // ── 2. Entrées persistées ─────────────────────────────────────────────
  const [resolution, knowledge] = await Promise.all([
    getResolution(fileId),
    getDocumentKnowledge(accountId, fileId),
  ]);
  const t1 = new Map((resolution?.t1Candidates ?? []).map((c) => [c.assetId, c]));
  const facts = knowledge?.facts ?? [];
  const records = await loadAssetIdentifiers(accountId);
  // Identifiants des biens tels que lus pour CETTE évaluation (lot 32C) : le
  // rattrapage ne rejoue que si l'un d'eux change depuis.
  const idsFingerprint = identifiersFingerprint(records);
  const identification = resolveAssetByIdentifiers(records, {
    facts: facts.map((f) => ({ canonicalKey: f.canonicalKey ?? null, value: factValue(f) })),
    texts: [knowledge?.extraction.fullText, ...[...t1.values()].map((c) => c.signals)],
  });
  const factTargets = facts
    .filter((f) => f.targetType === 'ASSET' && f.targetEntityId != null)
    .map((f) => Number(f.targetEntityId));

  const candidateIds = [...new Set([
    ...t1.keys(), ...identification.assetIds, ...state.secondaryAssetIds, ...state.mentionedAssetIds, ...factTargets,
  ])];
  const labels = await loadAssetLabels(accountId, candidateIds);
  const recordById = new Map<number, AssetIdentifierRecord>(records.map((r) => [r.assetId, r]));
  const missing = candidateIds.filter((id) => labels.has(id) && !recordById.has(id));
  if (missing.length) for (const r of await loadAssetIdentifiers(accountId, missing)) recordById.set(r.assetId, r);

  const candidates: DocumentAssetCandidate[] = candidateIds
    .filter((id) => labels.has(id))
    .map((id) => {
      const l = labels.get(id)!;
      const c = t1.get(id);
      return {
        assetId: id,
        name: l.name,
        family: recordById.get(id)?.family ?? null,
        subtype: l.subtype,
        identifiers: promptIdentifiers(recordById.get(id)),
        serverSignals: matchSignals(identification, id),
        t1: c ? { confidence: c.confidence, score: c.score, reason: c.reason, signals: c.signals } : null,
        currentRole: state.secondaryAssetIds.includes(id) || factTargets.includes(id)
          ? 'SECONDARY' as const
          : state.mentionedAssetIds.includes(id) ? 'MENTIONED' as const : null,
      };
    });

  const extractionAt = knowledge?.extraction.extractedAt ? new Date(String(knowledge.extraction.extractedAt)).toISOString() : null;
  const fingerprint = inputFingerprint({
    extractionAt, candidates, matches: identification.matches.map((m) => `${m.assetId}:${m.kind}`),
  });
  // Relance sur des entrées identiques : décision déjà prise, aucun appel modèle.
  const derniere = resolution?.lastOutcome ?? null;
  if (resolution && resolution.inputFingerprint === fingerprint
      && (derniere === 'ABSTAINED' || derniere === 'NO_CANDIDATE' || derniere === 'MULTI_ASSET')) {
    await g('état de résolution');
    await restoreLastOutcome(fileId, { identifiersFingerprint: idsFingerprint });
    return { outcome: 'NO_CHANGE', status: derniere, aiCalled: false };
  }

  // ── 3. Déterministe ───────────────────────────────────────────────────
  let decision = decideDeterministic(identification, { multiAssetDeclared: knowledge?.extraction.multiAsset === true });
  let aiCalled = false;

  // ── 4. Modèle (candidats fournis seulement) ───────────────────────────
  if (!decision) {
    if (candidates.length === 0) {
      decision = { kind: 'ABSTAIN', reasonCode: 'NO_CANDIDATE', ranked: [] };
    } else if (input.skipAi) {
      decision = { kind: 'ABSTAIN', reasonCode: 'AI_UNAVAILABLE', ranked: rankCandidates(candidates) };
    } else {
      await input.guard?.assertActive('T3 DOCUMENT_ASSET — appel du modèle');
      const subject: DocumentSubject = {
        title: knowledge?.extraction.title ?? null,
        documentType: knowledge?.extraction.documentTypeCode ?? null,
        documentDate: knowledge?.extraction.documentDate ?? null,
        supplier: knowledge?.extraction.supplierName ?? null,
        description: knowledge?.extraction.description ?? null,
        multiAssetDeclared: knowledge?.extraction.multiAsset ?? null,
        facts: facts.map((f) => ({ canonicalKey: f.canonicalKey ?? null, label: f.label, value: factValue(f), excerpt: f.excerpt })),
      };
      try {
        aiCalled = true;
        const output = await (deps.callModel ?? defaultCallModel)({
          accountId, userId: input.userId ?? state.userId, fileId, variables: documentAssetVariables(subject, candidates),
        });
        decision = decideFromAiOutput(output, candidates);
      } catch (e) {
        if (isExecutionCancelled(e)) throw e;
        // Panne du modèle : nouvelle tentative par la file (backoff) ; à la
        // dernière, l'utilisateur est sollicité plutôt que de laisser le
        // document sans bien.
        if (!input.finalAttempt) throw e;
        console.warn(`[t3-document-asset] document ${fileId} : modèle indisponible (${(e as Error).message}) — « À traiter ».`);
        decision = { kind: 'ABSTAIN', reasonCode: 'AI_UNAVAILABLE', ranked: rankCandidates(candidates) };
      }
    }
  }

  // ── 5 / 6. Application ────────────────────────────────────────────────
  await input.guard?.assertActive('T3 DOCUMENT_ASSET — écriture');
  const result = await applyDecision({
    accountId, fileId, userId: input.userId ?? state.userId, decision, labels, fingerprint, extractionAt, idsFingerprint, g,
  });
  console.info(`[t3-document-asset] document ${fileId} : ${decision.kind}${decision.kind === 'ABSTAIN' ? ` (${decision.reasonCode})` : ` [${decision.method}]`} → ${result.outcome}`);
  return { ...result, decision, aiCalled };
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

async function applyDecision(p: {
  accountId: number; fileId: number; userId: number | null; decision: DocumentAssetDecision;
  labels: Map<number, { name: string }>; fingerprint: string; extractionAt: string | null; idsFingerprint: string; g: Garde;
}): Promise<Omit<ResolveDocumentAssetResult, 'decision' | 'aiCalled'>> {
  const { accountId, fileId, decision, g } = p;
  // Relecture JUSTE AVANT l'écriture : l'utilisateur a pu trancher pendant
  // l'appel au modèle (ticket T3, §11).
  const avant = await readAttachmentState(accountId, fileId);
  const stop = await stopReason(accountId, fileId, avant, g);
  if (stop) return stop.outcome === 'NO_CHANGE' ? { ...stop, outcome: 'SUPERSEDED' } : stop;

  if (decision.kind === 'ABSTAIN') {
    const candidates: StoredCandidate[] = decision.ranked.map((r) => ({
      assetId: r.assetId, label: p.labels.get(r.assetId)?.name ?? `Bien ${r.assetId}`, score: r.score, reason: r.reason,
    }));
    await openUserQuestion({ accountId, fileId, state: avant, candidates, g });
    const status = decision.reasonCode === 'NO_CANDIDATE' ? 'NO_CANDIDATE' : 'ABSTAINED';
    await g('état de résolution');
    await recordOutcome({
      accountId, fileId, status, method: decision.reasonCode === 'NO_CANDIDATE' ? 'NONE' : 'AI', reasonCode: decision.reasonCode,
      candidates, inputFingerprint: p.fingerprint, extractionAt: p.extractionAt, identifiersFingerprint: p.idsFingerprint,
    });
    return { outcome: 'ABSTAIN', status };
  }

  const cibles = decision.kind === 'APPLY' ? [decision.assetId] : decision.assetIds;
  const role = decision.kind === 'APPLY' ? 'PRIMARY' as const : 'SECONDARY' as const;
  // Fermer l'éventuelle question AVANT d'écrire : le déclencheur 0257 la
  // fermerait sinon avec un motif « utilisateur ».
  await g('question « À traiter »');
  await closeAssetLinkQuestion(accountId, fileId);
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
  await g('état de résolution');
  await recordOutcome({
    accountId, fileId, status, method: decision.method, reasonCode: decision.reason.slice(0, 200),
    decidedAssetIds: cibles, inputFingerprint: p.fingerprint, extractionAt: p.extractionAt, identifiersFingerprint: p.idsFingerprint,
  });
  return { outcome: 'APPLIED', status };
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
}

/**
 * Abstention de T3 : UNE action « À traiter » LINK-ASSET (index unique des
 * actions actives), ARBITRATE avec les candidats de T3, ou COMPLETE sans
 * candidat. Document « à valider » si une proposition l'accompagne.
 */
async function openUserQuestion(p: { accountId: number; fileId: number; state: AttachmentState; candidates: StoredCandidate[]; g: Garde }): Promise<void> {
  if (!p.state.open) return;
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
