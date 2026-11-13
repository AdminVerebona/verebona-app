/**
 * REVUE IA DU RATTACHEMENT d'un document déjà rattaché (lot 113L, ticket #711).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AVANT : une correspondance exacte (adresse, immatriculation…) d'un autre
 * bien, calculée par le serveur APRÈS l'appel T1, concluait seule à une
 * contradiction (`detectAssetContradiction`, base IDENTIFIER) et ouvrait la
 * carte LINK-ASSET-CONFLICT. Une adresse de destinataire suffisait.
 *
 * MAINTENANT : la correspondance est un INDICE. Après T1 (et à chaque
 * réévaluation), le serveur rassemble les indices, les unités sources où ils
 * apparaissent (bloc, page, nature, voisines — valeurs masquées), le
 * rattachement actuel, les cibles des faits et les candidats, et les SOUMET au
 * traitement IA responsable : T3, prompt maître `t3_master_v1`, branche
 * LINK_AMBIGUITY, opération `t3_link_ambiguity`, relation DOCUMENT_ASSET
 * (revue). Même passerelle, même schéma, mêmes traces d'exécution. Le modèle
 * DÉCIDE (rattachement confirmé / arbitrage justifié / multi-biens) ; le code
 * CONTRÔLE (monde fermé, compte, état actuel du document, choix de
 * l'utilisateur, doublons) puis APPLIQUE et TRACE (`attachment_review`).
 *
 *   · confirmé, multi-biens  → aucune carte ; carte ouverte fermée (OBSOLETE,
 *                               motif tracé) ; multi-biens : autres biens liés
 *                               en SECONDARY (jamais de bien principal changé) ;
 *   · arbitrage              → UNE carte LINK-ASSET-CONFLICT, raison issue des
 *                               preuves ; couple déjà tranché (« Garder » /
 *                               « Ignorer ») jamais reproposé ;
 *   · aucune décision        → aucune carte nouvelle (jamais la règle
 *     (échec IA, réponse        supprimée en repli) ; carte existante
 *     invalide, contexte        conservée telle quelle ; Supervision et
 *     insuffisant)              relance durable (phase « À traiter ouverts »).
 *
 * MÉMOIRE : contexte PERTINENT inchangé (clé `attachmentReviewKey`) →
 * décision réutilisée sans appel : une réanalyse (reprise des montants TCO,
 * réanalyse ordinaire) ne recrée pas un faux conflit sans élément nouveau.
 * Jamais de déplacement automatique d'un document.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { AiGateway } from '../../../gateway/ai-gateway';
import { isExecutionCancelled, type ExecutionGuard } from '../../../queue/execution-control';
import { isPermanentFailure, PermanentJobError, type JobBusinessResult } from '../../../queue/queue-policy';
import type { QueuedJob } from '../../../queue/job-queue.repository';
import { T3LinkAmbiguityOutput } from '../../master/t3-contract';
import { buildT3Payload, parseTargetId, registerT3JobKind } from '../../t3-job-contract';
import { readAttachmentState, type AttachmentState } from '../attachment-state';
import { computeDocumentAssetContext } from '../context';
import { loadAccountMatchingIndex, type AccountMatchingIndex } from '../matching-index';
import { getResolution, type StoredT1Candidate } from '../resolution.repository';
import { aiNotConfigured, T3_TECHNICAL_RETRY_MINUTES, technicalCategoryOf } from '../technical-failure';
import { attachAutomatically } from '../automatic-attachment';
import { addressRoleOf } from '../address-roles';
import { attachmentReviewLinkJustification } from '../link-justification';
import { ATTACHMENT_REVIEW_OPERATION, attachmentReviewContractActive, attachmentReviewEnabled } from './contract';
import {
  attachmentOriginOf, attachmentReviewKey, attachmentReviewVariables, buildAttachmentIndices, decideAttachmentReview,
  otherAssetIds, reusableDecision, reviewContextSufficient, reviewNeeded, reviewUnitContexts, unitMatchesOf,
  ATTACHMENT_REVIEW_VERSION,
  type AttachmentIndex, type AttachmentReviewDecision, type ReviewCandidate, type ReviewSourceUnit, type ReviewSubject, type ReviewUnitContext,
} from './model';

/** Sorte de travail T3 et type de cible de la file (distinct de `document` : jamais de collision avec T3 DOCUMENT_ASSET). */
export const ATTACHMENT_REVIEW_KIND = 'document_attachment_review';
export const ATTACHMENT_REVIEW_TARGET = 'document_attachment';
const ANOMALY_FP = 't3-attachment-review';

export type ReviewCardEffect = 'NONE' | 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'CLOSED' | 'SKIPPED' | 'KEPT';

export type ReviewStatus =
  | 'REVIEWED' | 'REUSED' | 'NO_INDEX' | 'NOT_ATTACHED' | 'DOCUMENT_NOT_OPEN' | 'TARGET_GONE' | 'USER_DECIDED_PAIR'
  | 'NO_KNOWLEDGE' | 'RETRY_LATER' | 'TECHNICAL_FAILURE' | 'DISABLED' | 'SUPERSEDED';

/** Trace persistée (`document_asset_resolutions.attachment_review`) et rendue dans le détail du travail T3. */
export interface AttachmentReviewTrace {
  version: number;
  key: string | null;
  at: string;
  status: ReviewStatus;
  trigger: string | null;
  reprocessReason: string | null;
  currentAssetIds: number[];
  attachmentOrigin: string | null;
  indices: Array<Pick<AttachmentIndex, 'indexId' | 'assetId' | 'kind' | 'via' | 'exclusive' | 'currentAsset' | 'unitIds'>>;
  /** Unités transmises (identifiant, page, nature ; texte jamais conservé ici). */
  unitsSent: Array<{ unitId: string; page: number | null; kind: string; withText: boolean; indexIds: number[] }>;
  candidateIds: number[];
  contract: boolean;
  aiCalled: boolean;
  aiReused: boolean;
  aiStatus: 'OK' | 'ERROR' | 'NOT_CALLED';
  operation: string;
  traceIds: string[];
  promptVersion: string | null;
  /** Section `attachmentReview` / meilleurs `matches` reçus (sans texte libre au-delà de la justification). */
  output: Record<string, unknown> | null;
  decision: AttachmentReviewDecision | null;
  card: { before: number | null; after: number | null; effect: ReviewCardEffect };
  secondaryLinked: number[];
  /** Lot 113AM (#739) : biens jugés concernés par la revue mais refusés par la garde d'admission (preuve insuffisante). */
  secondaryRefused?: number[];
  error: string | null;
  failures: number;
  /** Lot 113S : provenance de la question de la carte (AI / CODE, motif d'un repli). */
  question?: { origin: 'AI' | 'CODE'; fallback: string | null; rejection: string | null; contractActive: boolean } | null;
}

export interface AttachmentReviewResult {
  outcome: 'APPLIED' | 'NO_CHANGE' | 'ABSTAIN' | 'SUPERSEDED' | 'TARGET_GONE';
  status: ReviewStatus;
  aiCalled: boolean;
  trace: AttachmentReviewTrace;
}

interface CallResult { output: T3LinkAmbiguityOutput; traceId: string | null; promptVersion: string | null }

export interface AttachmentReviewDeps {
  callModel?: (p: { accountId: number; userId: number | null; fileId: number; variables: Record<string, unknown> }) => Promise<CallResult>;
  contractActive?: () => Promise<boolean>;
  aiConfigSignature?: () => Promise<string>;
  index?: AccountMatchingIndex;
}

export interface ReviewInput {
  accountId: number;
  fileId: number;
  userId?: number | null;
  guard?: ExecutionGuard;
  /** Dernière tentative : une panne du modèle devient une issue technique (aucune carte), sinon la file relance. */
  finalAttempt?: boolean;
  triggerCode?: string | null;
  reprocessReason?: string | null;
  /** Relance explicite (lancement manuel) : la mémoire n'est pas lue. */
  forced?: boolean;
  /** T3 inactif par configuration : aucune IA, aucune carte. */
  skipAi?: boolean;
}

async function defaultCallModel(p: { accountId: number; userId: number | null; fileId: number; variables: Record<string, unknown> }): Promise<CallResult> {
  const res = await AiGateway.execute({
    useCaseCode: 'DATA_RECONCILIATION',
    operationCode: ATTACHMENT_REVIEW_OPERATION,
    accountId: p.accountId,
    userId: p.userId ?? undefined,
    sourceIds: [p.fileId],
    promptVariables: p.variables,
    outputSchema: T3LinkAmbiguityOutput,
  });
  return { output: res.data as T3LinkAmbiguityOutput, traceId: res.traceId ?? null, promptVersion: res.promptVersion ?? null };
}

// ── Lectures ───────────────────────────────────────────────────────────────

export async function readAttachmentReview(fileId: number, accountId: number): Promise<AttachmentReviewTrace | null> {
  const rows = (await pgClient.unsafe(
    `SELECT attachment_review FROM document_asset_resolutions WHERE file_id = $1 AND account_id = $2`, [fileId, accountId] as never[],
  )) as unknown as Array<{ attachment_review: unknown }>;
  const v = rows[0]?.attachment_review;
  if (!v) return null;
  try { return (typeof v === 'string' ? JSON.parse(v) : v) as AttachmentReviewTrace; } catch { return null; }
}

async function writeAttachmentReview(accountId: number, fileId: number, trace: AttachmentReviewTrace, t1Candidates?: StoredT1Candidate[] | null): Promise<void> {
  await pgClient.unsafe(
    `INSERT INTO document_asset_resolutions (file_id, account_id, status, last_outcome, method, reason_code, t1_candidates, attachment_review, requested_at, updated_at)
     VALUES ($1, $2, 'ALREADY_LINKED', 'ALREADY_LINKED', 'NONE', 'PRIMARY_PRESENT', COALESCE($4::jsonb, '[]'::jsonb), $3::jsonb, now(), now())
     ON CONFLICT (file_id) DO UPDATE SET attachment_review = $3::jsonb, updated_at = now(),
       t1_candidates = COALESCE($4::jsonb, document_asset_resolutions.t1_candidates)
     WHERE document_asset_resolutions.account_id = $2`,
    [fileId, accountId, JSON.stringify(trace), t1Candidates ? JSON.stringify(t1Candidates) : null] as never[],
  );
}

/**
 * Unités sources persistées (couche exhaustive T1), bornées, ordre de lecture.
 * Toutes couvertures : une unité non comprise par T1 (UNRESOLVED, FAILED)
 * reste un texte LU du document — un contexte, jamais un fait.
 */
async function loadReviewUnits(accountId: number, fileId: number): Promise<ReviewSourceUnit[]> {
  const rows = (await pgClient.unsafe(
    `SELECT source_unit_id, kind, page, ordinal, parent_unit_id, content_text, label, value_text
       FROM document_source_units
      WHERE file_id = $1 AND account_id = $2 AND kind <> 'PAGE_GAP'
      ORDER BY ordinal LIMIT 2000`,
    [fileId, accountId] as never[],
  ).catch(() => [])) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    unitId: String(r.source_unit_id), kind: String(r.kind), page: r.page == null ? null : Number(r.page), ordinal: Number(r.ordinal),
    parentUnitId: (r.parent_unit_id as string | null) ?? null, text: (r.content_text as string | null) ?? null,
    label: (r.label as string | null) ?? null, value: (r.value_text as string | null) ?? null,
  }));
}

/**
 * Document SANS couche exhaustive (historique) : fenêtres de la transcription
 * autour de chaque valeur d'identifiant, comme unités de contexte (pure vis-à-vis
 * du modèle : masquées ensuite comme les autres).
 */
async function transcriptionUnits(accountId: number, fileId: number, records: AccountMatchingIndex['records']): Promise<ReviewSourceUnit[]> {
  const rows = (await pgClient.unsafe(
    `SELECT left(coalesce(full_text, ''), 200000) AS t FROM document_extractions WHERE file_id = $1 AND account_id = $2 LIMIT 1`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{ t: string }>;
  const texte = rows[0]?.t ?? '';
  if (!texte.trim()) return [];
  const lignes = texte.split(/\n+/);
  const out: ReviewSourceUnit[] = [];
  lignes.forEach((l, i) => {
    if (!l.trim()) return;
    out.push({ unitId: `transcription:line:${i + 1}`, kind: 'TRANSCRIPTION_LINE', page: null, ordinal: 1_000_000 + i, parentUnitId: null, text: l, label: null, value: null });
  });
  // Seules les lignes porteuses d'un indice et leurs voisines seront transmises (`reviewUnitContexts`).
  void records;
  return out.slice(0, 5_000);
}

/** Carte LINK-ASSET-CONFLICT ouverte du document. */
async function openConflictCard(accountId: number, fileId: number): Promise<{ id: number; ctx: Record<string, unknown> | null } | null> {
  const rows = (await pgClient.unsafe(
    `SELECT id, trigger_context FROM to_process_actions
      WHERE account_id = $1 AND target_type = 'DOCUMENT' AND target_id = $2 AND rule_code = 'LINK-ASSET-CONFLICT' AND resolved_at IS NULL
      ORDER BY id LIMIT 1`,
    [accountId, fileId] as never[],
  )) as unknown as Array<{ id: number; trigger_context: unknown }>;
  if (!rows[0]) return null;
  const c = rows[0].trigger_context;
  return { id: Number(rows[0].id), ctx: (typeof c === 'string' ? JSON.parse(c) : c) as Record<string, unknown> | null };
}

/** Couples (actuel → proposé) déjà tranchés par l'utilisateur (« Garder », « Ignorer »). */
async function decidedPairs(accountId: number, fileId: number): Promise<Set<string>> {
  const rows = (await pgClient.unsafe(
    `SELECT (trigger_context ->> 'currentAssetId') AS cur, (trigger_context ->> 'suggestedAssetId') AS sug FROM to_process_actions
      WHERE account_id = $1 AND target_type = 'DOCUMENT' AND target_id = $2 AND relation_key = 'assetConflict'
        AND resolved_at IS NOT NULL AND resolution_reason IN ('USER_ARBITRATED', 'NOT_APPLICABLE')`,
    [accountId, fileId] as never[],
  )) as unknown as Array<{ cur: string | null; sug: string | null }>;
  return new Set(rows.filter((r) => r.cur && r.sug).map((r) => `${r.cur}:${r.sug}`));
}

/** Biens du rattachement principal actuel (colonnes, liens PRIMARY). Pure. */
export function currentAssetsOf(s: Pick<AttachmentState, 'columnAssetId' | 'primaryAssetIds'>): number[] {
  return [...new Set([...(s.columnAssetId !== null ? [s.columnAssetId] : []), ...s.primaryAssetIds])].sort((a, b) => a - b);
}

// ── Revue ──────────────────────────────────────────────────────────────────

/** Revue d'un document. Lève seulement pour être relancée par la file (panne du modèle avant la dernière tentative, interruption). */
export async function reviewDocumentAttachment(input: ReviewInput, deps: AttachmentReviewDeps = {}): Promise<AttachmentReviewResult> {
  const { accountId, fileId } = input;
  const g = async (quoi: string) => { await input.guard?.assertActive(`T3 revue du rattachement — ${quoi}`); };
  const prev = await readAttachmentReview(fileId, accountId);
  const trace: AttachmentReviewTrace = {
    version: ATTACHMENT_REVIEW_VERSION, key: null, at: new Date().toISOString(), status: 'REVIEWED',
    trigger: input.triggerCode ?? null, reprocessReason: input.reprocessReason ?? null, currentAssetIds: [], attachmentOrigin: null,
    indices: [], unitsSent: [], candidateIds: [], contract: false, aiCalled: false, aiReused: false, aiStatus: 'NOT_CALLED',
    operation: ATTACHMENT_REVIEW_OPERATION, traceIds: [], promptVersion: null, output: null, decision: null,
    card: { before: null, after: null, effect: 'NONE' }, secondaryLinked: [], error: null, failures: 0,
  };
  const fin = async (outcome: AttachmentReviewResult['outcome'], status: ReviewStatus, persist = true): Promise<AttachmentReviewResult> => {
    trace.status = status;
    if (persist) { await g('trace de la revue'); await writeAttachmentReview(accountId, fileId, trace).catch((e) => console.error(`[t3-attachment-review] trace du document ${fileId} non écrite :`, (e as Error).message)); }
    console.info(`[t3-attachment-review] document ${fileId} : ${status}${trace.decision ? ` · ${trace.decision.kind}${trace.decision.kind === 'NO_DECISION' ? `(${trace.decision.reasonCode})` : ''}` : ''}`
      + ` · IA ${trace.aiCalled ? 'OUI' : trace.aiReused ? 'réutilisée' : 'NON'} · carte ${trace.card.effect}`);
    return { outcome, status, aiCalled: trace.aiCalled, trace };
  };
  if (!attachmentReviewEnabled()) return fin('NO_CHANGE', 'DISABLED', false);

  const state = await readAttachmentState(accountId, fileId);
  const carte = await openConflictCard(accountId, fileId);
  trace.card.before = carte?.id ?? null;
  trace.card.after = carte?.id ?? null;
  const conflict = await import('@/services/to-process/document-asset-conflict');
  if (!state.exists) {
    await g('carte sans objet');
    if (carte && await conflict.closeAssetConflictCard(accountId, carte.id, 'TARGET_GONE', { review: 'TARGET_GONE' })) trace.card = { ...trace.card, after: null, effect: 'CLOSED' };
    return fin('TARGET_GONE', 'TARGET_GONE', false);
  }
  const current = currentAssetsOf(state);
  trace.currentAssetIds = current;
  trace.attachmentOrigin = attachmentOriginOf(state);
  if (current.length === 0) {
    // Plus rattaché : la question n'a plus d'objet (le balayage T3 DOCUMENT_ASSET reprend le document).
    await g('carte sans objet');
    if (carte && await conflict.closeAssetConflictCard(accountId, carte.id, 'OBSOLETE', { review: 'NOT_ATTACHED' })) trace.card = { ...trace.card, after: null, effect: 'CLOSED' };
    return fin('NO_CHANGE', 'NOT_ATTACHED');
  }
  if (!state.open) return fin('NO_CHANGE', 'DOCUMENT_NOT_OPEN');

  const index = deps.index ?? await loadAccountMatchingIndex(accountId);
  const resolution = await getResolution(fileId);
  // Aucun graphe d'identité : aucune règle de rôle déterministe ici, l'IA interprète le contexte.
  const ctx = await computeDocumentAssetContext({ accountId, fileId, state, resolution, index, identityGraph: null });
  if (!ctx.sources) {
    // Aucune connaissance T1 persistée : rien à juger — la carte éventuelle n'est ni confirmée ni infirmée.
    trace.card.effect = carte ? 'KEPT' : 'NONE';
    trace.decision = { kind: 'NO_DECISION', reasonCode: 'INSUFFICIENT_CONTEXT' };
    return fin('ABSTAIN', 'NO_KNOWLEDGE');
  }
  let units = await loadReviewUnits(accountId, fileId);
  // Lot 113AM (#739) : les correspondances d'adresse NON qualifiées « lieu du bien » restent des INDICES
  // soumis à la revue (jamais un lien) — identification d'avant la qualification.
  const indicesIdentification = ctx.build.identificationWithIndices ?? ctx.identification;
  const t1Designations = (resolution?.t1Candidates ?? []).filter((c) => c.reason !== SERVER_IDENTIFIER_REASON);
  let unitMatches = unitMatchesOf(units, index.records);
  let indices = buildAttachmentIndices({ currentAssetIds: current, identification: indicesIdentification, t1Designations, unitMatches });
  if (indices.some((i) => !i.currentAsset && i.kind !== 'T1_DESIGNATION' && i.unitIds.length === 0)) {
    // Document historique (sans couche exhaustive ou indice lu hors unité) : lignes de la transcription.
    units = [...units, ...await transcriptionUnits(accountId, fileId, index.records)];
    unitMatches = unitMatchesOf(units, index.records);
    indices = buildAttachmentIndices({ currentAssetIds: current, identification: indicesIdentification, t1Designations, unitMatches });
  }
  trace.indices = indices.map((i) => ({ indexId: i.indexId, assetId: i.assetId, kind: i.kind, via: i.via, exclusive: i.exclusive, currentAsset: i.currentAsset, unitIds: i.unitIds }));

  if (!reviewNeeded(indices)) {
    // Plus aucun indice d'un autre bien : rien ne motive une question.
    trace.decision = { kind: 'CONFIRMED', reason: 'aucun indice d’un autre bien', source: 'NO_INDEX' };
    await g('carte sans objet');
    if (carte && await conflict.closeAssetConflictCard(accountId, carte.id, 'OBSOLETE', { review: 'NO_INDEX' })) trace.card = { ...trace.card, after: null, effect: 'CLOSED' };
    return fin('NO_CHANGE', 'NO_INDEX');
  }
  const autres = otherAssetIds(indices);
  const tranches = await decidedPairs(accountId, fileId);
  if (autres.every((o) => current.some((c) => tranches.has(`${c}:${o}`)))) {
    trace.card.effect = carte ? 'KEPT' : 'NONE';
    return fin('NO_CHANGE', 'USER_DECIDED_PAIR');
  }

  const unitCtx: ReviewUnitContext[] = reviewUnitContexts(units, indices, index.records);
  trace.unitsSent = unitCtx.map((u) => ({ unitId: u.unitId, page: u.page, kind: u.kind, withText: !!u.context, indexIds: u.indexIds }));
  const ids = [...new Set([...current, ...indices.map((i) => i.assetId)])].filter((id) => index.byId.has(id)).sort((a, b) => a - b);
  const facts = ctx.sources.facts;
  const candidates: ReviewCandidate[] = ids.map((id) => {
    const a = index.byId.get(id)!;
    const t1 = t1Designations.find((c) => c.assetId === id);
    const cand = ctx.candidates.find((c) => c.assetId === id);
    return {
      assetId: id, name: a.name, family: a.family, subtype: a.subtype, identifiers: cand?.identifiers ?? {},
      t1: t1 ? { confidence: t1.confidence, score: t1.score, reason: [t1.reason, t1.signals].filter(Boolean).join(' — ') } : null,
      current: current.includes(id),
      factCount: facts.filter((f) => f.targetType === 'ASSET' && f.targetEntityId === id).length,
    };
  });
  trace.candidateIds = candidates.map((c) => c.assetId);
  const contract = await (deps.contractActive ?? attachmentReviewContractActive)().catch(() => false);
  trace.contract = contract;
  const signature = await (deps.aiConfigSignature ?? (() => AiGateway.effectiveConfigSignature(ATTACHMENT_REVIEW_OPERATION)))().catch(() => 'unresolved');
  const key = attachmentReviewKey({ currentAssetIds: current, origin: trace.attachmentOrigin as never, indices, units: unitCtx, candidates, contract, aiConfigSignature: signature });
  trace.key = key;
  trace.failures = prev?.key === key ? prev.failures : 0;
  const forced = input.forced === true || input.triggerCode === 'manual';

  let decision: AttachmentReviewDecision;
  let status: ReviewStatus = 'REVIEWED';
  if (!forced && prev?.key === key && reusableDecision(prev.decision)) {
    decision = prev.decision!;
    trace.aiReused = true;
    trace.promptVersion = prev.promptVersion;
    trace.traceIds = prev.traceIds;
    trace.output = prev.output;
    status = 'REUSED';
  } else if (!forced && prev?.key === key && prev.decision?.kind === 'NO_DECISION' && !reusableDecision(prev.decision)
      && Date.now() - new Date(prev.at).getTime() < T3_TECHNICAL_RETRY_MINUTES * 60_000) {
    // Échec récent sur le même contexte : relance durable après le délai, jamais en boucle.
    trace.decision = prev.decision;
    trace.card.effect = carte ? 'KEPT' : 'NONE';
    return fin('ABSTAIN', 'RETRY_LATER', false);
  } else if (!reviewContextSufficient(indices, unitCtx)) {
    decision = { kind: 'NO_DECISION', reasonCode: 'INSUFFICIENT_CONTEXT' };
  } else if (input.skipAi) {
    decision = { kind: 'NO_DECISION', reasonCode: 'AI_DISABLED' };
  } else {
    const ext = ctx.sources.extraction;
    const subject: ReviewSubject = {
      fileId, title: ext?.title ?? null, documentType: ext?.documentType ?? null, documentDate: ext?.documentDate ?? null,
      supplier: ext?.supplier ?? null, description: ext?.description ?? null, multiAssetDeclared: ext?.multiAsset ?? null,
      facts: facts.map((f) => ({ canonicalKey: f.canonicalKey, label: f.label, value: f.value, excerpt: f.excerpt, targetAssetId: f.targetType === 'ASSET' ? f.targetEntityId : null })),
    };
    const variables = attachmentReviewVariables({ subject, candidates, indices, units: unitCtx, currentAssetIds: current, origin: trace.attachmentOrigin as never, records: index.records });
    await g('appel du modèle');
    try {
      trace.aiCalled = true;
      const r = await (deps.callModel ?? defaultCallModel)({ accountId, userId: input.userId ?? state.userId, fileId, variables });
      trace.aiStatus = 'OK';
      trace.promptVersion = r.promptVersion;
      if (r.traceId) trace.traceIds = [r.traceId];
      trace.output = {
        matches: r.output.matches.slice(0, 10).map((m) => ({ candidateId: m.candidateId, score: m.score, confidence: m.confidence })),
        documentScope: r.output.documentScope ?? null,
        attachmentReview: r.output.attachmentReview ?? null,
      };
      decision = decideAttachmentReview(r.output, {
        currentAssetIds: current, candidateIds: trace.candidateIds, indexIds: indices.map((i) => i.indexId), unitIds: unitCtx.map((u) => u.unitId), contract,
      });
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      if (aiNotConfigured(e)) {
        trace.aiCalled = false;
        decision = { kind: 'NO_DECISION', reasonCode: 'AI_NOT_CONFIGURED' };
      } else {
        trace.aiStatus = 'ERROR';
        trace.error = (e as Error).message.slice(0, 300);
        if (!input.finalAttempt) throw e;
        trace.failures += 1;
        trace.decision = { kind: 'NO_DECISION', reasonCode: 'TECHNICAL_FAILURE' };
        trace.card.effect = carte ? 'KEPT' : 'NONE';
        await reportReviewAnomaly(accountId, fileId, technicalCategoryOf(e), trace.error);
        return fin('ABSTAIN', 'TECHNICAL_FAILURE');
      }
    }
    if (decision.kind === 'NO_DECISION' && ['CLOSED_WORLD_VIOLATION', 'REVIEW_OUTPUT_MISSING', 'INCONSISTENT_OUTPUT'].includes(decision.reasonCode)) {
      // Réponse invalide : jamais une contradiction métier — Supervision, relance après le délai.
      trace.failures += 1;
      await reportReviewAnomaly(accountId, fileId, 'SCHEMA', decision.reasonCode);
    }
  }
  trace.decision = decision;

  // ── Application : relecture de l'état JUSTE AVANT l'écriture ──────────
  await g('écriture');
  const apres = await readAttachmentState(accountId, fileId);
  if (JSON.stringify(currentAssetsOf(apres)) !== JSON.stringify(current)) return fin('SUPERSEDED', 'SUPERSEDED');
  const details = { review: decision.kind, reviewKey: key, promptVersion: trace.promptVersion, traceId: trace.traceIds[0] ?? null };
  let outcome: AttachmentReviewResult['outcome'] = 'NO_CHANGE';
  if (decision.kind === 'CONFIRMED' || decision.kind === 'MULTI_ASSET') {
    if (carte && await conflict.closeAssetConflictCard(accountId, carte.id, 'OBSOLETE', details)) {
      trace.card = { ...trace.card, after: null, effect: 'CLOSED' };
      outcome = 'APPLIED';
    }
    if (decision.kind === 'MULTI_ASSET') {
      for (const id of decision.assetIds) {
        if (apres.primaryAssetIds.includes(id) || apres.secondaryAssetIds.includes(id) || apres.userLinkAssetIds.includes(id)) continue;
        if (await userRemovedLink(accountId, fileId, id)) continue;
        await g('lien SECONDARY');
        // Lot 113AM (#739) : garde d'admission — un bien que seule une adresse non qualifiée « lieu du bien »
        // désigne n'est jamais lié, même si la revue le juge concerné (refus journalisé, aucune carte).
        const lie = await attachAutomatically({
          accountId, fileId, assetId: id, role: 'SECONDARY', confidence: 1,
          justification: attachmentReviewLinkJustification({
            assetId: id, indices, facts, modelCandidate: t1Designations.some((c) => c.assetId === id),
            addressRole: addressRoleOf(ctx.build.addressQualifications ?? [], id), reviewKey: key,
          }),
        });
        if (!lie.linked) { trace.secondaryRefused = [...(trace.secondaryRefused ?? []), id]; continue; }
        trace.secondaryLinked.push(id);
        outcome = 'APPLIED';
      }
    }
  } else if (decision.kind === 'ARBITRATE' && carte && carte.ctx?.reviewKey === key && Number(carte.ctx?.suggestedAssetId) === decision.suggestedAssetId
      // Lot 113S : une question de T3 passe toujours par la carte (mise à jour idempotente du libellé, jamais de doublon).
      && typeof decision.userQuestion !== 'string') {
    // Même arbitrage, même contexte : la carte ouverte est déjà la bonne (aucune écriture, aucun doublon).
    trace.card.effect = 'UNCHANGED';
    outcome = 'NO_CHANGE';
  } else if (decision.kind === 'ARBITRATE') {
    await g('question « À traiter »');
    // Lot 113S : question formulée par T3 dans la même sortie (`t3-user-question-v1`), contrôlée contre le
    // contexte de la carte (biens candidats, document) ; jamais un second appel.
    const { questionContractActive, T3_USER_QUESTION_CONTRACT } = await import('@/services/to-process/ai-user-question');
    const qContrat = await questionContractActive(ATTACHMENT_REVIEW_OPERATION, T3_USER_QUESTION_CONTRACT);
    const ext = ctx.sources.extraction;
    const r = await conflict.proposeDocumentAssetConflict({
      accountId, fileId, currentAssetId: current[0], suggestedAssetId: decision.suggestedAssetId, basis: 'AI_REVIEW', kinds: [],
      review: { reviewKey: key, ambiguous: decision.ambiguous, reason: decision.reason },
      aiQuestion: {
        treatment: 'T3', operation: ATTACHMENT_REVIEW_OPERATION, contract: T3_USER_QUESTION_CONTRACT, raw: decision.userQuestion ?? null,
        aiCalled: trace.aiCalled || trace.aiReused, contractActive: qContrat, promptVersion: trace.promptVersion, traceId: trace.traceIds[0] ?? null,
        extraLabels: [...candidates.map((c) => c.name), ext?.title, ext?.supplier],
        foreignLabels: [...index.byId.values()].filter((a) => !trace.candidateIds.includes(a.assetId)).map((a) => a.name),
      },
    });
    if (r.questionSource) {
      trace.question = { origin: r.questionSource.origin, fallback: r.questionSource.fallback, rejection: r.questionSource.rejection, contractActive: qContrat };
    }
    const now = await openConflictCard(accountId, fileId);
    trace.card.after = now?.id ?? null;
    trace.card.effect = r.status === 'CREATED' ? 'CREATED' : r.status === 'UPDATED' ? 'UPDATED' : 'SKIPPED';
    outcome = r.status === 'CREATED' || r.status === 'UPDATED' ? 'APPLIED' : 'ABSTAIN';
  } else {
    trace.card.effect = carte ? 'KEPT' : 'NONE';
    outcome = 'ABSTAIN';
  }
  return fin(outcome, status);
}

/** Raison posée par le serveur sur un candidat créé par l'identification (même texte que T1 `SERVER_IDENTIFIER_REASON`). */
const SERVER_IDENTIFIER_REASON = 'identifiant canonique exact (contrôle serveur)';

async function userRemovedLink(accountId: number, fileId: number, assetId: number): Promise<boolean> {
  const rows = (await pgClient.unsafe(
    `SELECT 1 FROM document_asset_links WHERE account_id = $1 AND file_id = $2 AND asset_id = $3 AND origin = 'USER' AND status = 'REMOVED' LIMIT 1`,
    [accountId, fileId, assetId] as never[],
  )) as unknown as unknown[];
  return rows.length > 0;
}

async function reportReviewAnomaly(accountId: number, fileId: number, category: string, error: string): Promise<void> {
  try {
    const { reportAnomaly, buildFingerprint } = await import('@/services/admin/anomaly.service');
    await reportAnomaly({
      domain: 'ai', fingerprint: buildFingerprint('ai', ANOMALY_FP, category, accountId), accountId,
      title: `T3 — revue du rattachement des documents : échec (${category}), relance automatique`,
      detail: {
        code: `T3_ATTACHMENT_REVIEW_${category}`, fileId, cause: error.slice(0, 300), retryAfterMinutes: T3_TECHNICAL_RETRY_MINUTES,
        effect: 'aucune carte « À traiter » créée par l’échec ; revue reprise par la phase « À traiter ouverts » de T3',
      },
    });
  } catch (e) {
    console.error(`[t3-attachment-review] supervision non alimentée (document ${fileId}) :`, (e as Error).message);
  }
}

// ── File durable ───────────────────────────────────────────────────────────

interface ReviewPayload { kind: typeof ATTACHMENT_REVIEW_KIND; fileId: number; userId: number | null; reprocessReason: string | null; forced: boolean }

/**
 * Demande la revue d'un document (file durable T3, travail dédupliqué par
 * document). Les candidats du MODÈLE T1 (jamais ceux enrichis par le serveur)
 * sont conservés pour la revue. Déclencheur T3 inactif : revue sans IA
 * (aucune carte). Rend l'identifiant du travail.
 */
export async function requestAttachmentReview(p: {
  accountId: number; fileId: number; userId: number | null; triggerCode: string; reprocessReason?: string | null;
  t1Candidates?: StoredT1Candidate[] | null; forced?: boolean;
}): Promise<number | null> {
  if (!attachmentReviewEnabled()) return null;
  if (p.t1Candidates) {
    await pgClient.unsafe(
      `INSERT INTO document_asset_resolutions (file_id, account_id, status, last_outcome, method, reason_code, t1_candidates, requested_at, updated_at)
       VALUES ($1, $2, 'ALREADY_LINKED', 'ALREADY_LINKED', 'NONE', 'PRIMARY_PRESENT', $3::jsonb, now(), now())
       ON CONFLICT (file_id) DO UPDATE SET t1_candidates = $3::jsonb, updated_at = now() WHERE document_asset_resolutions.account_id = $2`,
      [p.fileId, p.accountId, JSON.stringify(p.t1Candidates)] as never[],
    );
  }
  const [{ enqueue }, { isTriggerActive }] = await Promise.all([import('../../../queue/job-queue.repository'), import('../../../queue/triggers')]);
  if (p.triggerCode === 'source_analyzed' && !(await isTriggerActive('T3', 'source_analyzed'))) {
    await reviewDocumentAttachment({ accountId: p.accountId, fileId: p.fileId, userId: p.userId, skipAi: true, triggerCode: p.triggerCode, reprocessReason: p.reprocessReason ?? null });
    return null;
  }
  const { jobId } = await enqueue({
    treatment: 'T3',
    scope: { accountId: p.accountId, targetType: ATTACHMENT_REVIEW_TARGET, targetId: p.fileId },
    triggerCode: p.triggerCode,
    payload: buildT3Payload(ATTACHMENT_REVIEW_KIND, { userId: p.userId, ...(p.reprocessReason ? { reprocessReason: p.reprocessReason } : {}), ...(p.forced ? { forced: true } : {}) }),
    payloadOnDedupe: 'replace',
  });
  return jobId;
}

async function runReviewJob(job: QueuedJob, p: ReviewPayload, guard: ExecutionGuard): Promise<JobBusinessResult> {
  await guard.assertActive('T3 revue du rattachement');
  const r = await reviewDocumentAttachment({
    accountId: job.accountId as number, fileId: p.fileId, userId: p.userId, guard,
    finalAttempt: isPermanentFailure(job.attempts + 1), triggerCode: job.triggerCode ?? null, reprocessReason: p.reprocessReason, forced: p.forced,
  });
  return { result: r.outcome, detail: { fileId: p.fileId, status: r.status, aiCalled: r.aiCalled, review: r.trace } };
}

let enregistre = false;

/** Enregistre la sorte de travail (idempotent ; démarrage, et chargement du module). */
export function registerAttachmentReviewT3(): void {
  if (enregistre) return;
  enregistre = true;
  registerT3JobKind<ReviewPayload>({
    kind: ATTACHMENT_REVIEW_KIND,
    targetTypes: [ATTACHMENT_REVIEW_TARGET],
    account: 'required',
    versions: [1],
    parse(raw, job) {
      const u = raw.userId;
      if (u !== undefined && u !== null && (typeof u !== 'number' || !Number.isInteger(u) || u < 1)) throw new PermanentJobError(`T3 job ${job.id} : userId invalide`);
      return {
        kind: ATTACHMENT_REVIEW_KIND, fileId: parseTargetId(job), userId: (u as number | null | undefined) ?? null,
        reprocessReason: typeof raw.reprocessReason === 'string' ? raw.reprocessReason.slice(0, 60) : null, forced: raw.forced === true,
      };
    },
    run: ({ job, payload, guard }) => runReviewJob(job, payload, guard),
  });
}

/**
 * Phase « À traiter ouverts » (rattrapage EXISTANT de T3, aucun planificateur
 * nouveau) : revues en échec (panne, réponse invalide) dont le délai de
 * relance est écoulé, sur des documents toujours rattachés. Bornée. Ne lève
 * que pour une interruption.
 */
export async function retryFailedAttachmentReviews(accountId: number, opts: { guard?: ExecutionGuard; triggerCode?: string | null; limit?: number } = {}): Promise<number> {
  const rows = (await pgClient.unsafe(
    `SELECT r.file_id FROM document_asset_resolutions r
      WHERE r.account_id = $1 AND r.attachment_review IS NOT NULL
        AND r.attachment_review -> 'decision' ->> 'kind' = 'NO_DECISION'
        AND r.attachment_review -> 'decision' ->> 'reasonCode' IN ('TECHNICAL_FAILURE', 'CLOSED_WORLD_VIOLATION', 'REVIEW_OUTPUT_MISSING', 'INCONSISTENT_OUTPUT')
        AND (r.attachment_review ->> 'at')::timestamptz <= now() - ($2 || ' minutes')::interval
        AND NOT EXISTS (SELECT 1 FROM to_process_actions a WHERE a.account_id = r.account_id AND a.target_type = 'DOCUMENT'
                          AND a.target_id = r.file_id AND a.rule_code = 'LINK-ASSET-CONFLICT' AND a.resolved_at IS NULL)
      ORDER BY r.file_id LIMIT $3`,
    [accountId, String(T3_TECHNICAL_RETRY_MINUTES), opts.limit ?? 20] as never[],
  ).catch(() => [])) as unknown as Array<{ file_id: number }>;
  let n = 0;
  for (const r of rows) {
    await opts.guard?.assertActive('T3 revue du rattachement — relance');
    try {
      await reviewDocumentAttachment({ accountId, fileId: Number(r.file_id), guard: opts.guard, finalAttempt: true, triggerCode: opts.triggerCode ?? 'schedule_hourly', reprocessReason: 'REVIEW_RETRY' });
      n += 1;
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      console.error(`[t3-attachment-review] relance du document ${r.file_id} impossible :`, (e as Error).message);
    }
  }
  return n;
}

registerAttachmentReviewT3();
