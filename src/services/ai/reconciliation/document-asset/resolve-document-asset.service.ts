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
 *      rattacher ce document ? ») avec les candidats de T3 — jamais avant
 *      cet échec. Lot 71B : la carte SUFFIT, le document reste « analysé »
 *      (plus d'état « à valider » sur la fiche, décision PO du 19/10).
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
 *
 * Lot 49B (tickets « T3 — Réexaminer systématiquement les À traiter
 * ouverts » et « T3 : exploiter la couche exhaustive T1 ») :
 *   · une carte « À traiter » LINK-ASSET OUVERTE est un problème actif : le
 *     court-circuit « contexte inchangé → restaurer l'issue précédente » ne
 *     s'applique plus — le document est RÉEXAMINÉ (données persistées,
 *     Candidate Builder, état actuel de TOUS les biens, déterministe, puis IA
 *     si des candidats demandent un arbitrage). L'issue précédente n'est
 *     qu'un historique (monitoring), jamais une donnée de décision ;
 *   · sans carte ouverte, contexte identique → CONFIRMED_NO_CHANGE (AC6) ;
 *   · le réarbitrage à contexte INCHANGÉ n'est plus plafonné par T3 (lot 54A :
 *     plus jamais AI_DEFERRED ; seuls les freins globaux de la passerelle) ;
 *   · sources documentaires réellement utilisées (`documentSources`) et
 *     unités source considérées (`matchedSourceUnitIds`) tracées.
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
  type DocumentAssetCandidate, type DocumentAssetDecision, type DocumentSubject,
} from './decision';
import { candidateSourcesOf, computeDocumentAssetContext, type DocumentAssetContext } from './context';
import { knowledgeSourceCounts, usedDocumentSources } from './document-sources';
import { loadSupplierHistory, semanticCandidates, semanticPages, semanticShortlist, SEMANTIC_RELATION } from './semantic-search';
import type { RearbitrationDeferral } from './rearbitration-budget';
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
  | 'ABSTAINED' | 'NO_CANDIDATE' | 'USER_DECIDED' | 'ALREADY_LINKED' | 'TARGET_GONE'
  /** Lot 49B : réexamen d'une carte ouverte à contexte inchangé, arbitrage IA reporté (plafond). */
  | 'AI_DEFERRED';

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
  /** Lot 49B : sources documentaires réellement utilisées (EXTRACTION, TRANSCRIPTION, FACTS, T1_CANDIDATES, SOURCE_UNITS, UNRESOLVED_FACTS). */
  documentSources?: string[];
  /** Lot 49B : unités source T1 (ou faits non résolus) qui désignent un candidat. */
  matchedSourceUnitIds?: string[];
  /** Lot 49B : nouvelle tentative réelle (faux seulement pour CONFIRMED_NO_CHANGE). */
  reevaluated?: boolean;
  /** Lot 49B : carte « À traiter » LINK-ASSET ouverte à l'origine du réexamen. */
  openActionId?: number | null;
  /** Lot 49B : réarbitrage IA reporté (plafond de coût). */
  aiDeferred?: RearbitrationDeferral | null;
  /** Lot 49B : dernier appel modèle pour ce document (priorité des réarbitrages reportés). */
  lastAiAt?: string | null;
  /** Lot 57B : éléments T1 exploitables chargés, par source. */
  knowledgeCounts?: Record<string, number>;
  /** Lot 57B : sources T1 absentes (EXTRACTION : aucune connaissance T1) ou en échec. */
  missingSources?: string[];
  /** Lot 57B : motif exploitable de l'issue (NO_CANDIDATE, INSUFFICIENT_EVIDENCE, AMBIGUOUS, AI_UNAVAILABLE…). */
  reasonCode?: string | null;
  /** Lot 57B : appels IA (opération, traces, erreur). */
  ai?: { operation: string; traceIds: string[]; status: 'OK' | 'ERROR' | 'NOT_CALLED'; error: string | null; reason: string } | null;
  /** Lot 57B : recherche sémantique (aucun candidat structuré). */
  semanticSearch?: {
    attempted: boolean; reason: string; rounds: number; presented: number; matched: number; origins: Record<string, number>;
  } | null;
}

/** Dernier appel modèle connu d'une résolution (monitoring précédent). Pure. */
export function previousAiAt(r: Pick<DocumentAssetResolution, 'lastEvaluation'> | null): string | null {
  const e = r?.lastEvaluation as { lastAiAt?: unknown; aiCalled?: unknown; at?: unknown } | null | undefined;
  if (!e) return null;
  if (typeof e.lastAiAt === 'string') return e.lastAiAt;
  return e.aiCalled === true && typeof e.at === 'string' ? e.at : null;
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
  /**
   * Lot 49B — réarbitrage IA d'une carte ouverte à contexte INCHANGÉ :
   * `allow` (budget accordé par la phase « open actions »), `defer` (budget du
   * passage épuisé). Absent : plafond journalier vérifié ici.
   */
  /** Lot 54A : IGNORÉ (plus aucun report pour quota T3) — conservé pour compatibilité des appelants. */
  rearbitration?: 'allow' | { defer: RearbitrationDeferral };
  /** Lot 49B : carte LINK-ASSET ouverte déjà connue (phase « open actions ») ; à défaut, relue. */
  openActionId?: number | null;
}

export interface ResolveDocumentAssetResult {
  outcome: DocumentAssetOutcome;
  status: ResolutionStatus | null;
  decision?: DocumentAssetDecision;
  /** Appel modèle effectué. */
  aiCalled: boolean;
  evaluation?: DocumentAssetEvaluation;
  /** Lot 49B : réarbitrage IA reporté (plafond) — la carte reste ouverte. */
  aiDeferred?: RearbitrationDeferral;
}

/** Points d'injection (tests unitaires). */
export interface ResolveDocumentAssetDeps {
  callModel?: (p: { accountId: number; userId: number | null; fileId: number; variables: Record<string, unknown>; onTrace?: (traceId: string) => void }) => Promise<T3LinkAmbiguityOutput>;
  /** Lot 57B : historique fournisseur (défaut : base). */
  supplierHistory?: (accountId: number, fileId: number, supplier: string | null) => Promise<Map<number, number>>;
  /** Carte LINK-ASSET ouverte du document (défaut : base). */
  openAssetLinkAction?: (accountId: number, fileId: number) => Promise<number | null>;
  /** Plafond journalier des réarbitrages (défaut : `ai_usage_event`). */
  /** Lot 54A : IGNORÉ (plafond journalier supprimé). */
  dailyRearbitrationAllowed?: (accountId: number) => Promise<boolean>;
}

/** Carte « À traiter » LINK-ASSET ouverte d'un document (identifiant), ou null. */
export async function openAssetLinkActionOf(accountId: number, fileId: number): Promise<number | null> {
  const rows = (await pgClient.unsafe(
    `SELECT id FROM to_process_actions
      WHERE account_id = $1 AND target_type = 'DOCUMENT' AND target_id = $2 AND rule_code = 'LINK-ASSET' AND resolved_at IS NULL
      ORDER BY id LIMIT 1`,
    [accountId, fileId] as never[],
  )) as unknown as Array<{ id: number }>;
  return rows[0] ? Number(rows[0].id) : null;
}

async function defaultCallModel(p: { accountId: number; userId: number | null; fileId: number; variables: Record<string, unknown>; onTrace?: (traceId: string) => void }) {
  const res = await AiGateway.execute({
    useCaseCode: 'DATA_RECONCILIATION',
    operationCode: 't3_link_ambiguity',
    accountId: p.accountId,
    userId: p.userId ?? undefined,
    sourceIds: [p.fileId],
    promptVariables: p.variables,
    outputSchema: T3LinkAmbiguityOutput,
  });
  if (res.traceId) p.onTrace?.(res.traceId);
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
    documentSources: usedDocumentSources(p.ctx.sources),
    matchedSourceUnitIds: (p.ctx.matchedSourceUnits ?? []).map((u) => u.unitId).slice(0, 50),
    lastAiAt: previousAiAt(p.resolution),
    knowledgeCounts: knowledgeSourceCounts(p.ctx.sources),
    missingSources: p.ctx.sources ? [...(p.ctx.sources.failedOrigins ?? [])] : ['EXTRACTION'],
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

  // Contexte pertinent inchangé : sans carte « À traiter » ouverte, la
  // décision ouverte reste valable, sans IA (AC6). Avec une carte ouverte
  // (lot 49B) : problème ACTIF, réexamen complet — l'issue précédente n'est
  // qu'un historique.
  const inchange = isUnchangedOpenContext(resolution, ctx.fingerprint);
  const openActionId = inchange
    ? (input.openActionId ?? await (deps.openAssetLinkAction ?? openAssetLinkActionOf)(accountId, fileId))
    : (input.openActionId ?? null);
  if (inchange && openActionId === null) {
    const evaluation: DocumentAssetEvaluation = {
      ...base, newResolution: resolution!.lastOutcome, aiCalled: false, decision: null, linkedAssetId: null,
      toProcessAction: 'UNCHANGED', result: 'CONFIRMED_NO_CHANGE', promptCandidateCount: 0, reevaluated: false,
    };
    await g('état de résolution');
    await restoreLastOutcome(fileId, { identifiersFingerprint: ctx.idsFingerprint, knowledgeRevision: revision, lastEvaluation: { ...evaluation } });
    logEvaluation(evaluation);
    return { outcome: 'NO_CHANGE', status: resolution!.lastOutcome, aiCalled: false, evaluation };
  }
  const reexamen = { ...base, reevaluated: true, openActionId };

  // ── 3. Déterministe : identifiants forts, puis référence partagée / nom distinctif ──
  let decision = decideDeterministic(ctx.identification, { multiAssetDeclared: ctx.multiAssetDeclared })
    ?? decideContextualDeterministic(ctx.candidates, ctx.identification, { multiAssetDeclared: ctx.multiAssetDeclared });
  let aiCalled = false;
  let pourModele = promptCandidates(ctx.candidates);
  const traces: string[] = [];
  let aiError: string | null = null;
  let aiReason = decision ? 'DETERMINISTIC_PROOF' : 'NOT_NEEDED';
  let semantic: DocumentAssetEvaluation['semanticSearch'] = null;
  const callModel = deps.callModel ?? defaultCallModel;
  const ext0 = ctx.sources?.extraction;
  const subject0: DocumentSubject = {
    title: ext0?.title ?? null, documentType: ext0?.documentType ?? null, documentDate: ext0?.documentDate ?? null,
    supplier: ext0?.supplier ?? null, description: ext0?.description ?? null, multiAssetDeclared: ext0?.multiAsset ?? null,
    facts: (ctx.sources?.facts ?? []).map((f) => ({ canonicalKey: f.canonicalKey, label: f.label, value: f.value, excerpt: f.excerpt })),
  };

  // ── 4. Modèle (candidats du serveur seulement, monde fermé) ───────────
  if (!decision) {
    if (ctx.candidates.length === 0) {
      // Lot 57B (défaut B) : aucun candidat STRUCTURÉ → recherche sémantique
      // IA parmi les biens du compte (sélection progressive), jamais un
      // NO_CANDIDATE sans raisonnement quand la connaissance T1 existe.
      const r = await semanticSearch({
        accountId, fileId, userId: input.userId ?? state.userId, ctx, subject: subject0, skipAi: input.skipAi === true,
        guard: input.guard, callModel, supplierHistory: deps.supplierHistory ?? loadSupplierHistory, traces,
      });
      decision = r.decision;
      aiCalled = r.aiCalled;
      aiError = r.aiError;
      semantic = r.semantic;
      aiReason = r.aiCalled ? 'SEMANTIC_SEARCH' : `SEMANTIC_SEARCH_SKIPPED:${r.semantic.reason}`;
      if (r.presented.length) pourModele = r.presented;
    } else if (input.skipAi) {
      aiReason = 'AI_DISABLED';
      decision = { kind: 'ABSTAIN', reasonCode: 'AI_UNAVAILABLE', ranked: rankCandidates(ctx.candidates) };
    } else {
      // Lot 54A (écart 1) : plus aucun report pour quota T3 interne — une carte
      // ouverte qui demande un arbitrage est TOUJOURS arbitrée (le plafond de
      // coût du compte, la disponibilité du modèle et le circuit breaker de la
      // passerelle restent les seuls freins ; `rearbitration` est ignoré).
      await input.guard?.assertActive('T3 DOCUMENT_ASSET — appel du modèle');
      aiReason = 'STRUCTURED_CANDIDATES_NEED_ARBITRATION';
      try {
        aiCalled = true;
        const output = await callModel({
          accountId, userId: input.userId ?? state.userId, fileId, variables: documentAssetVariables(subject0, pourModele),
          onTrace: (t) => traces.push(t),
        });
        decision = decideFromAiOutput(output, pourModele);
        // Candidats découverts au-delà de la borne du prompt : toujours proposés à l'utilisateur.
        if (decision.kind === 'ABSTAIN' && pourModele.length < ctx.candidates.length) {
          const vus = new Set(decision.ranked.map((r) => r.assetId));
          decision.ranked.push(...rankCandidates(ctx.candidates).filter((r) => !vus.has(r.assetId)).map((r) => ({ ...r, score: Math.min(r.score, 0.3) })));
        }
      } catch (e) {
        if (isExecutionCancelled(e)) throw e;
        aiError = (e as Error).message.slice(0, 200);
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
    evaluation: {
      ...reexamen, aiCalled, promptCandidateCount: aiCalled ? pourModele.length : 0, ...(aiCalled ? { lastAiAt: new Date().toISOString() } : {}),
      reasonCode: decision.kind === 'ABSTAIN' ? (aiError && decision.reasonCode === 'NO_CANDIDATE' ? 'AI_UNAVAILABLE' : decision.reasonCode) : 'RESOLVED',
      ai: { operation: 't3_link_ambiguity', traceIds: traces.slice(0, 5), status: aiError ? 'ERROR' : aiCalled ? 'OK' : 'NOT_CALLED', error: aiError, reason: aiReason },
      semanticSearch: semantic,
    },
  });
  console.info(`[t3-document-asset] document ${fileId} : ${decision.kind}${decision.kind === 'ABSTAIN' ? ` (${decision.reasonCode})` : ` [${decision.method}]`} → ${result.outcome}`);
  if (result.evaluation) logEvaluation(result.evaluation);
  return { ...result, decision, aiCalled };
}

/**
 * Lot 57B (défaut B) — recherche sémantique IA quand aucun candidat
 * structuré n'existe (`semantic-search.ts`). Biens du compte seulement
 * (index du compte), sélection progressive, branche IA existante. Ne lève
 * que pour une interruption : une panne du modèle est rendue (AI_UNAVAILABLE),
 * la carte reste ouverte et sera retentée au passage suivant.
 */
async function semanticSearch(p: {
  accountId: number; fileId: number; userId: number | null; ctx: DocumentAssetContext; subject: DocumentSubject; skipAi: boolean;
  guard?: ExecutionGuard; callModel: NonNullable<ResolveDocumentAssetDeps['callModel']>;
  supplierHistory: NonNullable<ResolveDocumentAssetDeps['supplierHistory']>; traces: string[];
}): Promise<{
  decision: DocumentAssetDecision; aiCalled: boolean; aiError: string | null;
  semantic: NonNullable<DocumentAssetEvaluation['semanticSearch']>; presented: DocumentAssetCandidate[];
}> {
  const vide = (reason: string) => ({
    decision: { kind: 'ABSTAIN' as const, reasonCode: 'NO_CANDIDATE' as const, ranked: [] }, aiCalled: false, aiError: null,
    semantic: { attempted: false, reason, rounds: 0, presented: 0, matched: 0, origins: {} }, presented: [] as DocumentAssetCandidate[],
  });
  const { ctx } = p;
  if (!ctx.sources) return vide('NO_T1_KNOWLEDGE');
  if (ctx.index.assets.length === 0) return vide('NO_ASSET_IN_ACCOUNT');
  if (p.skipAi) return vide('AI_DISABLED');
  const historique = await p.supplierHistory(p.accountId, p.fileId, ctx.sources.extraction?.supplier ?? null);
  const shortlist = semanticShortlist(ctx.index, ctx.sources, historique);
  const pages = semanticPages(shortlist);
  const origins: Record<string, number> = {};
  for (const h of shortlist) for (const o of h.origins) origins[o] = (origins[o] ?? 0) + 1;
  const presented: DocumentAssetCandidate[] = [];
  let rounds = 0;
  for (const page of pages) {
    const cands = semanticCandidates(page, ctx.index);
    for (const c of cands) {
      const a = ctx.index.byId.get(c.assetId)!;
      ctx.labels.set(c.assetId, { name: a.name, category: a.category, subtype: a.subtype });
    }
    presented.push(...cands);
    await p.guard?.assertActive('T3 DOCUMENT_ASSET — recherche sémantique');
    rounds += 1;
    let output: T3LinkAmbiguityOutput;
    try {
      output = await p.callModel({
        accountId: p.accountId, userId: p.userId, fileId: p.fileId,
        variables: { ...documentAssetVariables(p.subject, cands), RELATION_TYPE: SEMANTIC_RELATION },
        onTrace: (t) => p.traces.push(t),
      });
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      const err = (e as Error).message.slice(0, 200);
      console.warn(`[t3-document-asset] document ${p.fileId} : recherche sémantique — modèle indisponible (${err}).`);
      return {
        decision: { kind: 'ABSTAIN', reasonCode: 'NO_CANDIDATE', ranked: [] }, aiCalled: true, aiError: err,
        semantic: { attempted: true, reason: 'AI_UNAVAILABLE', rounds, presented: presented.length, matched: 0, origins }, presented,
      };
    }
    const decision = decideFromAiOutput(output, cands);
    const retenus = new Set(output.matches.map((m) => m.candidateId).filter((id) => cands.some((c) => c.assetId === id)));
    if (decision.kind !== 'ABSTAIN') {
      return { decision, aiCalled: true, aiError: null, semantic: { attempted: true, reason: 'RESOLVED', rounds, presented: presented.length, matched: retenus.size, origins }, presented };
    }
    if (retenus.size > 0) {
      // Le modèle désigne un ou des biens sans preuve suffisante : proposés à l'utilisateur (justification du modèle).
      const ranked = decision.reasonCode === 'CLOSED_WORLD_VIOLATION' ? [] : decision.ranked.filter((r) => retenus.has(r.assetId));
      return {
        decision: ranked.length ? { ...decision, ranked } : { kind: 'ABSTAIN', reasonCode: 'NO_CANDIDATE', ranked: [] },
        aiCalled: true, aiError: null,
        semantic: { attempted: true, reason: decision.reasonCode, rounds, presented: presented.length, matched: retenus.size, origins }, presented,
      };
    }
  }
  return {
    decision: { kind: 'ABSTAIN', reasonCode: 'NO_CANDIDATE', ranked: [] }, aiCalled: rounds > 0, aiError: null,
    semantic: { attempted: rounds > 0, reason: rounds > 0 ? 'NO_MATCH' : 'NO_ASSET_IN_ACCOUNT', rounds, presented: presented.length, matched: 0, origins }, presented,
  };
}

/** Une ligne de journal lisible par évaluation (exploitation). */
function logEvaluation(e: DocumentAssetEvaluation): void {
  console.info(`[t3-document-asset] document ${e.documentId} — révision ${e.previousKnowledgeRevision ?? '∅'} → ${e.currentKnowledgeRevision}`
    + ` · motif ${e.reprocessReason ?? '∅'}${e.knowledgeChanged.length ? ` (${e.knowledgeChanged.join(', ')})` : ''}`
    + ` · contexte modifié : ${e.fingerprintChanged ? 'OUI' : 'NON'} · candidats ${e.candidateCount}`
    + ` · IA : ${e.aiCalled ? 'OUI' : 'NON'}${e.aiDeferred ? ` (reportée : ${e.aiDeferred})` : ''} · résultat ${e.result} · À traiter ${e.toProcessAction}`
    + `${e.openActionId ? ` · carte ${e.openActionId} réexaminée` : ''}`
    + `${e.documentSources?.length ? ` · sources ${e.documentSources.join('+')}` : ''}`
    + `${e.matchedSourceUnitIds?.length ? ` · unités ${e.matchedSourceUnitIds.length}` : ''}`);
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

  // Ancien état « à valider » (antérieur au lot 71B) levé s'il subsiste.
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
 * candidat. Lot 71B : l'état du document n'est plus modifié — la question
 * vit dans « À traiter », jamais comme une validation sur la fiche.
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
