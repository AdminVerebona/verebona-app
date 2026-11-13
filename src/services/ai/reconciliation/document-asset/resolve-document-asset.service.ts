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
 *
 * Lot 105D (ticket « Rattachement rétroactif après création d'un bien ») :
 *   · identité documentaire (`identity/`) : après les identifiants forts et
 *     les règles contextuelles, un membre d'un groupe DEMONSTRABLE /
 *     ATTESTED / CONFIRMED est rattaché SANS IA (`decideFromIdentity`) ; un
 *     membre d'un groupe à confirmer par carte groupée s'abstient sans IA ni
 *     carte individuelle (GROUP_CONFIRMATION_PENDING) ; un bien refusé par
 *     l'utilisateur n'est plus jamais reproposé (GROUP_REFUSED) ;
 *   · MÉMOIRE DES DÉCISIONS IA (lot 99A étendu, D4) : à contexte inchangé
 *     (empreinte, configuration IA effective, contrat, version), une
 *     abstention du modèle est RÉUTILISÉE sans nouvel appel — nouvelle preuve,
 *     nouveau bien, décision USER, version ou relance manuelle l'invalident ;
 *   · preuves croisées transmises au modèle (contrat
 *     `t3-document-asset-cross-v1`) seulement si le prompt actif le porte.
 *
 * Lot 108E (ticket « T3 DOCUMENT_ASSET — correctif #626 bis ») :
 *   · A3 — la recherche SÉMANTIQUE reçoit les mêmes preuves croisées et les
 *     mêmes garde-fous que la branche structurée (biens refuses retirés,
 *     contrôle serveur de la sortie croisée) ; sans contrat : mode d'avant ;
 *   · A4 — sortie `crossDocument` OBLIGATOIRE et vérifiée dès que le modèle a
 *     reçu les preuves croisées (`decideFromAiOutput`) ;
 *   · A5 / A6 — graphe d'identité en panne, modèle indisponible à la dernière
 *     tentative, erreur du fournisseur en recherche sémantique : issue
 *     TECHNICAL_FAILURE (`technical-failure.ts`), Supervision, relance
 *     durable — JAMAIS une carte « À traiter » créée ni mise à jour par la
 *     panne ; une carte née d'une panne est fermée ;
 *   · A7 — projection et recalcul après rattachement déclenchés aussi sans
 *     utilisateur initiateur, en CONTEXTE TECHNIQUE journalisé
 *     (`projection-actor.ts`) ; document d'appareil : aucun fait sans cible
 *     réattribué au bien porteur (ni prix ni garantie d'appareil) ;
 *   · C — journal par document enrichi : branche, état du graphe, sources,
 *     appartenances, contrôle croisé, panne, projection, carte avant / après.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { AiGateway } from '../../gateway/ai-gateway';
import { isExecutionCancelled, type ExecutionGuard } from '../../queue/execution-control';
import { T3LinkAmbiguityOutput } from '../master/t3-contract';
import { unlinkDocument } from '@/services/documents/document-asset-links';
import { attachAutomatically, clearAutomaticPrimaryColumn, closeAssetLinkQuestion } from './automatic-attachment';
import { documentAssetLinkJustification } from './link-justification';
import { admitDocumentAssetLink, type LinkJustification } from '@/services/documents/document-asset-links/admission';
import { logLinkRefusal, recordLinkAdmission } from '@/services/documents/document-asset-links/admission-journal';
import { hasPrimaryAttachment, hasUserDecision, readAttachmentState, type AttachmentState } from './attachment-state';
import {
  decideContextualDeterministic, decideDeterministic, decideFromAiOutput, documentAssetVariables, promptCandidates, rankCandidates,
  type DocumentAssetCandidate, type DocumentAssetDecision, type DocumentSubject,
} from './decision';
import { candidateSourcesOf, computeDocumentAssetContext, type DocumentAssetContext } from './context';
import { knowledgeSourceCounts, usedDocumentSources } from './document-sources';
import { loadSupplierHistory, semanticCandidates, semanticPages, semanticShortlist, SEMANTIC_RELATION } from './semantic-search';
import { unnamedLabel, userSourceLabel } from '@/services/to-process/card-labels';
import type { RearbitrationDeferral } from './rearbitration-budget';
import type { AccountMatchingIndex } from './matching-index';
import { DOCUMENT_ASSET_RESOLUTION_VERSION } from './version';
import {
  getResolution, OPEN_OUTCOMES, recordOutcome, restoreLastOutcome,
  type DocumentAssetResolution, type ResolutionStatus, type StoredCandidate,
} from './resolution.repository';
import { getAccountKnowledgeRevision, knowledgeChangedSince } from '../continuous/knowledge-revision';
import { crossDocumentContext, decideFromIdentity, identityGate } from './identity/decision';
import { crossDocumentContractActive, documentAssetAiMemoryEnabled } from './identity/contract';
import type { AccountIdentityGraph } from './identity/graph';
import { identityGraphFailed, type IdentityGraphOutcome } from './identity/load';
import {
  aiNotConfigured, reportTechnicalFailure, resolveTechnicalFailures, T3_TECHNICAL_RETRY_MINUTES, technicalCategoryOf, TECHNICAL_FAILURE_REASON, wasTechnicalOutcome,
  type TechnicalFailureCategory, type TechnicalFailureDetail,
} from './technical-failure';
import { resolveProjectionActor, type ProjectionEffect } from './projection-actor';
import { createHash } from 'node:crypto';
import { readExplicitNoAssetDecision } from '@/services/to-process/no-asset-decision';
import type { ExplicitNoAssetDecision } from '@/services/to-process/no-asset-choice';
import { respectExplicitNoAsset, type RespectNoAssetDeps } from './explicit-no-asset';

/** Issue métier d'une exécution (vocabulaire de la file T3). */
type DocumentAssetOutcome = 'APPLIED' | 'NO_CHANGE' | 'ABSTAIN' | 'SUPERSEDED' | 'TARGET_GONE';

/**
 * Résultat lisible d'une évaluation (monitoring, ticket « réconciliation
 * continue » : « Context changed: NO / Result: CONFIRMED_NO_CHANGE / AI call: NO »).
 */
export type DocumentAssetEvaluationResult =
  | 'CONFIRMED_NO_CHANGE' | 'RESOLVED_DETERMINISTICALLY' | 'RESOLVED_BY_AI' | 'MULTI_ASSET'
  | 'ABSTAINED' | 'NO_CANDIDATE' | 'USER_DECIDED' | 'ALREADY_LINKED' | 'TARGET_GONE'
  /** Lot 49B : réexamen d'une carte ouverte à contexte inchangé, arbitrage IA reporté (plafond). */
  | 'AI_DEFERRED'
  /** Lot 108E (A6) : panne technique — aucune carte, relance durable, Supervision. */
  | 'TECHNICAL_FAILURE';

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
  /** Lot 105D : identité documentaire du document (groupe, rôle, statut). */
  identity?: {
    groupKey: string | null; status: string | null; via: string | null; targetAssetId: number | null; cardEligible: boolean;
    exclusions: Array<{ groupKey: string; reason: string }>;
    /** Lot 108E : toutes les appartenances (logement, appareil…). */
    memberships?: Array<{ groupKey: string; family: string; status: string; via: string; targetAssetId: number | null; candidateAssetIds: number[]; equipmentIds: number[] }>;
  } | null;
  /** Lot 105D : mémoire de la dernière décision du modèle (réutilisée à contexte inchangé). */
  aiMemory?: AiMemoryEntry | null;
  /** Lot 105D : décision du modèle réutilisée (aucun appel). */
  aiReused?: boolean;
  /** Lot 105D : preuves croisées transmises au modèle (contrat t3-document-asset-cross-v1). */
  crossDocumentSent?: boolean;
  /** Lot 108E (C) : branche de décision effectivement suivie. */
  branch?: 'DETERMINISTIC' | 'IDENTITY' | 'GROUP_GATE' | 'STRUCTURED' | 'SEMANTIC' | 'MEMORY' | 'TECHNICAL' | 'NONE';
  /** Lot 108E (C, A4) : contrôle serveur de la sortie croisée (obligatoire si les preuves ont été transmises). */
  crossDocument?: { required: boolean; present: boolean; reasons: string[]; blocked: boolean } | null;
  /** Lot 108E (C, A5) : état du graphe d'identité pour cette évaluation. */
  identityGraph?: { status: string; error: string | null } | null;
  /** Lot 108E (C, A1) : sources T1 exploitées / absentes par le graphe pour ce document. */
  identitySources?: { counts: Record<string, number>; absent: string[]; transcriptionChars: number } | null;
  /** Lot 108E (A6) : panne technique (catégorie, relance, carte née d'une panne fermée). */
  technicalFailure?: TechnicalFailureDetail | null;
  /** Lot 108E (A7) : effet de la projection après rattachement (acteur, biens, preuves). */
  projection?: ProjectionEffect | null;
  /** Lot 108E (C) : carte « À traiter » LINK-ASSET avant l'évaluation (identifiant) — après : `toProcessAction`. */
  cardBefore?: number | null;
  /** Lot 113V : non-rattachement explicite (« Aucun ») respecté — éléments nouveaux examinés. */
  explicitNoAsset?: import('./explicit-no-asset').ExplicitNoAssetEvaluation | null;
}

/** Lot 105D — décision du modèle mémorisée (abstention seulement : un rattachement clôt le document). */
export interface AiMemoryEntry {
  key: string;
  path: 'STRUCTURED' | 'SEMANTIC';
  reasonCode: string;
  ranked: Array<{ assetId: number; score: number; reason: string }>;
  at: string;
  traceId: string | null;
  /** Lot 113S : question proposée par T3 avec cette décision (réutilisée avec elle). */
  userQuestion?: string | null;
}

/** Mémoire IA de la résolution précédente (monitoring), ou null. Pure. */
export function previousAiMemory(r: Pick<DocumentAssetResolution, 'lastEvaluation'> | null): AiMemoryEntry | null {
  const m = (r?.lastEvaluation as { aiMemory?: AiMemoryEntry | null } | null | undefined)?.aiMemory;
  return m && typeof m.key === 'string' && Array.isArray(m.ranked) ? m : null;
}

/**
 * Clé de la mémoire IA (pure) : contexte pertinent (empreinte, qui couvre
 * connaissance du document, candidats, identité du groupe et versions),
 * voie (structurée / sémantique), configuration IA effective (prompt, modèle),
 * contrat de variables transmis.
 */
export function aiMemoryKey(p: { fingerprint: string; path: 'STRUCTURED' | 'SEMANTIC'; aiConfigSignature: string; crossContract: boolean }): string {
  return createHash('sha256').update(JSON.stringify([DOCUMENT_ASSET_RESOLUTION_VERSION, p.fingerprint, p.path, p.aiConfigSignature, p.crossContract])).digest('hex').slice(0, 40);
}

/** Dernier appel modèle connu d'une résolution (monitoring précédent). Pure. */
export function previousAiAt(r: Pick<DocumentAssetResolution, 'lastEvaluation'> | null): string | null {
  const e = r?.lastEvaluation as { lastAiAt?: unknown; aiCalled?: unknown; at?: unknown } | null | undefined;
  if (!e) return null;
  if (typeof e.lastAiAt === 'string') return e.lastAiAt;
  return e.aiCalled === true && typeof e.at === 'string' ? e.at : null;
}

interface ResolveDocumentAssetInput {
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
  /** Lot 105D : graphe d'identité du passage (phase « open actions ») ; à défaut, mémorisé par index. */
  identityGraph?: AccountIdentityGraph | null;
  /** Lot 108E : issue du graphe du passage (panne comprise) — prioritaire sur `identityGraph`. */
  identityOutcome?: IdentityGraphOutcome;
}

interface ResolveDocumentAssetResult {
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
interface ResolveDocumentAssetDeps {
  callModel?: (p: { accountId: number; userId: number | null; fileId: number; variables: Record<string, unknown>; onTrace?: (traceId: string) => void }) => Promise<T3LinkAmbiguityOutput>;
  /** Lot 57B : historique fournisseur (défaut : base). */
  supplierHistory?: (accountId: number, fileId: number, supplier: string | null) => Promise<Map<number, number>>;
  /** Carte LINK-ASSET ouverte du document (défaut : base). */
  openAssetLinkAction?: (accountId: number, fileId: number) => Promise<number | null>;
  /** Plafond journalier des réarbitrages (défaut : `ai_usage_event`). */
  /** Lot 54A : IGNORÉ (plafond journalier supprimé). */
  dailyRearbitrationAllowed?: (accountId: number) => Promise<boolean>;
  /** Lot 105D : le prompt actif porte-t-il le contrat « preuves croisées » ? (défaut : version effective) */
  crossContractActive?: () => Promise<boolean>;
  /** Lot 105D : signature de la configuration IA effective (défaut : passerelle). */
  aiConfigSignature?: () => Promise<string>;
  /** Lot 113V : décision « Aucun » en vigueur (défaut : trace de la carte, `readExplicitNoAssetDecision`). */
  explicitNoAsset?: (accountId: number, fileId: number) => Promise<ExplicitNoAssetDecision | null>;
  /** Lot 113V : biens éligibles / révision du document (défaut : base). */
  noAsset?: RespectNoAssetDeps;
}

async function defaultAiConfigSignature(): Promise<string> {
  return AiGateway.effectiveConfigSignature('t3_link_ambiguity');
}

/** Relance explicite (lancement manuel, motif forcé, réexamen d'une carte née d'une panne) : la mémoire IA n'est jamais lue. */
function forcedReevaluation(input: Pick<ResolveDocumentAssetInput, 'triggerCode' | 'reprocessReason'>): boolean {
  return input.triggerCode === 'manual' || input.reprocessReason === 'FORCED' || input.reprocessReason === 'MANUAL'
    || input.reprocessReason === 'TECHNICAL_CARD_REVIEW' || input.reprocessReason === 'TECHNICAL_RETRY';
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
    identity: p.ctx.identity && (p.ctx.identity.group || p.ctx.identity.exclusions.length) ? {
      groupKey: p.ctx.identity.group?.groupKey ?? null, status: p.ctx.identity.group?.status ?? null, via: p.ctx.identity.member?.via ?? null,
      targetAssetId: p.ctx.identity.group?.targetAssetId ?? null, cardEligible: p.ctx.identity.group?.cardEligible ?? false,
      exclusions: p.ctx.identity.exclusions.slice(0, 5),
      // Lot 108E : toutes les appartenances (logement, appareil…) et leur statut face aux biens.
      memberships: (p.ctx.identity.memberships ?? []).slice(0, 10).map((m) => ({
        groupKey: m.group.groupKey, family: m.group.family, status: m.group.status, via: m.member.via, targetAssetId: m.group.targetAssetId,
        candidateAssetIds: m.group.candidateAssetIds.slice(0, 10), equipmentIds: (m.group.equipmentIds ?? []).slice(0, 10),
      })),
    } : null,
    identityGraph: { status: p.ctx.identityGraphStatus ?? 'PROVIDED', error: p.ctx.identityGraphError ?? null },
    identitySources: (p.ctx.identity?.graph.coverage?.get(p.fileId) as DocumentAssetEvaluation['identitySources'] | undefined) ?? null,
    // Lot 105D : la mémoire IA suit l'évaluation tant qu'elle n'est pas remplacée.
    aiMemory: previousAiMemory(p.resolution),
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
  const ctx = await computeDocumentAssetContext({
    accountId, fileId, state, resolution, index: input.index,
    ...(input.identityOutcome ? { identityOutcome: input.identityOutcome } : input.identityGraph !== undefined ? { identityGraph: input.identityGraph } : {}),
  });
  const changed = resolution?.knowledgeRevision != null ? await knowledgeChangedSince(accountId, resolution.knowledgeRevision) : [];
  const base = evaluationBase({ fileId, ctx, resolution, revision, changed, triggerCode: input.triggerCode, reprocessReason: input.reprocessReason });
  const openCard = deps.openAssetLinkAction ?? openAssetLinkActionOf;

  // Lot 113V (#719) : « Aucun » choisi par l'utilisateur et en vigueur — sa décision prime :
  // aucun appel au modèle, aucun rattachement ; réexamen soumis seulement sur un élément nouveau.
  const aucun = await (deps.explicitNoAsset ?? readExplicitNoAssetDecision)(accountId, fileId);
  if (aucun) {
    const carte = input.openActionId ?? await openCard(accountId, fileId);
    return respectExplicitNoAsset({
      accountId, fileId, decision: aucun, ctx, revision, open: state.open, cardBefore: carte, g, deps: deps.noAsset,
      evaluation: { ...base, reevaluated: true, openActionId: carte, cardBefore: carte },
    });
  }

  // Lot 108E (A5) : graphe d'identité en PANNE (≠ coupure) — aucune décision (les garde-fous de rôle d'adresse,
  // de refus et de groupe en dépendent), aucune carte : issue technique, Supervision, relance durable.
  if (identityGraphFailed({ status: ctx.identityGraphStatus as never })) {
    const cardBefore = input.openActionId ?? await openCard(accountId, fileId);
    return technicalOutcome({
      accountId, fileId, ctx, resolution, revision, g, cardBefore, aiCalled: false, traces: [],
      evaluation: { ...base, reevaluated: true, openActionId: cardBefore, promptCandidateCount: 0 },
      category: 'IDENTITY_GRAPH', error: `${ctx.identityGraphStatus}${ctx.identityGraphError ? ` — ${ctx.identityGraphError}` : ''}`,
    });
  }

  // Contexte pertinent inchangé : sans carte « À traiter » ouverte, la
  // décision ouverte reste valable, sans IA (AC6). Avec une carte ouverte
  // (lot 49B) : problème ACTIF, réexamen complet — l'issue précédente n'est
  // qu'un historique.
  const inchange = isUnchangedOpenContext(resolution, ctx.fingerprint);
  const openActionId = inchange
    ? (input.openActionId ?? await openCard(accountId, fileId))
    : (input.openActionId ?? null);
  if (inchange && openActionId === null) {
    const evaluation: DocumentAssetEvaluation = {
      ...base, newResolution: resolution!.lastOutcome, aiCalled: false, decision: null, linkedAssetId: null,
      toProcessAction: 'UNCHANGED', result: 'CONFIRMED_NO_CHANGE', promptCandidateCount: 0, reevaluated: false, cardBefore: null, branch: 'NONE',
    };
    await g('état de résolution');
    await restoreLastOutcome(fileId, { identifiersFingerprint: ctx.idsFingerprint, knowledgeRevision: revision, lastEvaluation: { ...evaluation } });
    logEvaluation(evaluation);
    return { outcome: 'NO_CHANGE', status: resolution!.lastOutcome, aiCalled: false, evaluation };
  }
  // Lot 108E (C) : carte LINK-ASSET ouverte AVANT l'évaluation (journal avant / après).
  const cardBefore = openActionId ?? await openCard(accountId, fileId);
  const reexamen = { ...base, reevaluated: true, openActionId, cardBefore };

  // ── 3. Déterministe : identifiants forts, puis référence partagée / nom distinctif ──
  let branch: NonNullable<DocumentAssetEvaluation['branch']> = 'NONE';
  let decision = decideDeterministic(ctx.identification, { multiAssetDeclared: ctx.multiAssetDeclared })
    ?? decideContextualDeterministic(ctx.candidates, ctx.identification, { multiAssetDeclared: ctx.multiAssetDeclared });
  if (decision) branch = 'DETERMINISTIC';
  else {
    // Lot 105D : identité du groupe (identifiant d'un seul bien, documents déjà rattachés, confirmation de l'utilisateur).
    decision = decideFromIdentity(ctx.identity ?? null, ctx.candidates, { multiAssetDeclared: ctx.multiAssetDeclared, identifiedAssetIds: ctx.identification.assetIds });
    if (decision) branch = 'IDENTITY';
  }
  let aiCalled = false;
  let pourModele = promptCandidates(ctx.candidates);
  const traces: string[] = [];
  let aiError: string | null = null;
  let aiReason = decision ? 'DETERMINISTIC_PROOF' : 'NOT_NEEDED';
  let semantic: DocumentAssetEvaluation['semanticSearch'] = null;
  let crossReport: DocumentAssetEvaluation['crossDocument'] = null;
  const callModel = deps.callModel ?? defaultCallModel;
  const ext0 = ctx.sources?.extraction;
  const subject0: DocumentSubject = {
    title: ext0?.title ?? null, documentType: ext0?.documentType ?? null, documentDate: ext0?.documentDate ?? null,
    supplier: ext0?.supplier ?? null, description: ext0?.description ?? null, multiAssetDeclared: ext0?.multiAsset ?? null,
    facts: (ctx.sources?.facts ?? []).map((f) => ({ canonicalKey: f.canonicalKey, label: f.label, value: f.value, excerpt: f.excerpt })),
  };

  // ── 4 bis. Lot 105D : garde d'identité AVANT tout appel modèle ─────────
  const gate = decision ? null : identityGate(ctx.identity ?? null);
  let candidatsIa = ctx.candidates;
  let refuses = new Set<number>();
  if (!decision && gate?.kind === 'GROUP_CONFIRMATION_PENDING') {
    // La relation groupe → bien appartient à l'utilisateur (carte groupée) : aucune IA, aucune carte individuelle.
    aiReason = 'GROUP_CONFIRMATION_PENDING';
    branch = 'GROUP_GATE';
    decision = { kind: 'ABSTAIN', reasonCode: 'GROUP_CONFIRMATION_PENDING', ranked: [] };
  } else if (!decision && gate?.kind === 'REFUSED_ASSETS') {
    refuses = new Set(gate.refusedAssetIds);
    candidatsIa = ctx.candidates.filter((c) => !refuses.has(c.assetId));
    if (candidatsIa.length === 0) {
      // Seuls des biens refuses restaient : aucune question répétée, aucune recherche sémantique.
      aiReason = 'GROUP_REFUSED';
      branch = 'GROUP_GATE';
      decision = { kind: 'ABSTAIN', reasonCode: 'GROUP_REFUSED', ranked: [] };
    } else pourModele = promptCandidates(candidatsIa);
  }

  // ── 4 ter. Lot 105D : mémoire IA et contrat « preuves croisées » ───────
  let aiMemory = null as AiMemoryEntry | null;
  let aiReused = false as boolean;
  let crossSent = false;
  const memoire = async (path: 'STRUCTURED' | 'SEMANTIC'): Promise<{ key: string; reuse: AiMemoryEntry | null; cross: boolean }> => {
    const cross = await (deps.crossContractActive ?? crossDocumentContractActive)().catch(() => false);
    if (!documentAssetAiMemoryEnabled()) return { key: '', reuse: null, cross };
    const sig = await (deps.aiConfigSignature ?? defaultAiConfigSignature)().catch(() => 'unresolved');
    const key = aiMemoryKey({ fingerprint: ctx.fingerprint, path, aiConfigSignature: sig, crossContract: cross });
    const prev = previousAiMemory(resolution);
    return { key, reuse: !forcedReevaluation(input) && prev?.key === key && prev.path === path ? prev : null, cross };
  };
  const reutiliser = (m: AiMemoryEntry) => {
    for (const r of m.ranked) {
      const a = ctx.index.byId.get(r.assetId);
      if (a && !ctx.labels.has(r.assetId)) ctx.labels.set(r.assetId, { name: a.name, category: a.category, subtype: a.subtype });
    }
    aiReused = true;
    aiMemory = m;
    void import('../../reuse/reuse-counters').then(({ noteReuse }) => noteReuse({ kind: 'DECISION_REUSED', accountId, treatment: 'T3', operationCode: 't3_link_ambiguity' })).catch(() => undefined);
    const ids = new Set(ctx.index.assets.map((a) => a.assetId));
    return {
      kind: 'ABSTAIN' as const, reasonCode: m.reasonCode as Extract<DocumentAssetDecision, { kind: 'ABSTAIN' }>['reasonCode'], ranked: m.ranked.filter((r) => ids.has(r.assetId) && !refuses.has(r.assetId)),
      ...(typeof m.userQuestion === 'string' ? { userQuestion: m.userQuestion } : {}),
    };
  };
  const memoriser = (key: string, path: 'STRUCTURED' | 'SEMANTIC', d: DocumentAssetDecision) => {
    if (!key || d.kind !== 'ABSTAIN' || aiError) return;
    aiMemory = {
      key, path, reasonCode: d.reasonCode, ranked: d.ranked.slice(0, 20), at: new Date().toISOString(), traceId: traces[0] ?? null,
      ...(typeof d.userQuestion === 'string' ? { userQuestion: d.userQuestion.slice(0, 1000) } : {}),
    };
  };
  // Lot 105D / 108E (A3) : preuves croisées vérifiées par le serveur, MÊMES pour les deux branches.
  const croisement = (cross: boolean) => {
    const croise = cross ? crossDocumentContext(ctx.identity ?? null, fileId, ctx.identity?.graph.documents) : null;
    return {
      variables: cross ? { fileId, context: croise?.context ?? null } : null,
      check: croise ? { allowedEvidenceIds: croise.allowedEvidenceIds, member: croise.server.documentStatus === 'MEMBER', required: true, server: croise.server } : null,
    };
  };

  // ── 4. Modèle (candidats du serveur seulement, monde fermé) ───────────
  if (!decision) {
    if (candidatsIa.length === 0) {
      // Lot 57B (défaut B) : aucun candidat STRUCTURÉ → recherche sémantique
      // IA parmi les biens du compte (sélection progressive), jamais un
      // NO_CANDIDATE sans raisonnement quand la connaissance T1 existe.
      const m = input.skipAi ? null : await memoire('SEMANTIC');
      if (m?.reuse) {
        decision = reutiliser(m.reuse);
        aiReason = 'DECISION_REUSED';
        branch = 'MEMORY';
        semantic = { attempted: false, reason: 'DECISION_REUSED', rounds: 0, presented: 0, matched: m.reuse.ranked.length, origins: {} };
      } else {
        branch = 'SEMANTIC';
        const cr = croisement(m?.cross === true);
        const r = await semanticSearch({
          accountId, fileId, userId: input.userId ?? state.userId, ctx, subject: subject0, skipAi: input.skipAi === true,
          guard: input.guard, callModel, supplierHistory: deps.supplierHistory ?? loadSupplierHistory, traces,
          // Lot 108E (A3) : mêmes garde-fous que la branche structurée.
          excludedAssetIds: refuses, cross: cr,
        });
        decision = r.decision;
        aiCalled = r.aiCalled;
        aiError = r.aiError;
        semantic = r.semantic;
        crossSent = r.crossSent;
        crossReport = r.crossReport;
        aiReason = r.aiCalled ? 'SEMANTIC_SEARCH' : `SEMANTIC_SEARCH_SKIPPED:${r.semantic.reason}`;
        if (r.presented.length) pourModele = r.presented;
        if (r.aiException && aiNotConfigured(r.aiException)) {
          // IA non configurée (opération inactive, compte inéligible) : comme T3 inactif — vraie absence de preuve, pas une panne.
          aiError = null;
          aiCalled = false;
          aiReason = 'AI_NOT_CONFIGURED';
          semantic = { ...r.semantic, reason: 'AI_NOT_CONFIGURED' };
          decision = { kind: 'ABSTAIN', reasonCode: 'NO_CANDIDATE', ranked: [] };
        } else if (r.aiException) {
          // Lot 108E (A6) : erreur du fournisseur ≠ « aucun bien » — relance par la file, puis issue technique.
          if (!input.finalAttempt) throw r.aiException;
          return technicalOutcome({
            accountId, fileId, ctx, resolution, revision, g, cardBefore, aiCalled: true, traces,
            evaluation: { ...reexamen, promptCandidateCount: pourModele.length, semanticSearch: semantic, crossDocumentSent: crossSent, branch: 'SEMANTIC', lastAiAt: new Date().toISOString() },
            category: technicalCategoryOf(r.aiException), error: aiError ?? 'erreur du fournisseur',
          });
        }
        if (aiCalled && m) memoriser(m.key, 'SEMANTIC', decision);
      }
    } else if (input.skipAi) {
      aiReason = 'AI_DISABLED';
      branch = 'STRUCTURED';
      decision = { kind: 'ABSTAIN', reasonCode: 'AI_UNAVAILABLE', ranked: rankCandidates(candidatsIa) };
    } else {
      const m = await memoire('STRUCTURED');
      if (m.reuse) {
        // Lot 105D (D4) : même contexte, même configuration IA → décision du modèle réutilisée, aucun appel.
        decision = reutiliser(m.reuse);
        aiReason = 'DECISION_REUSED';
        branch = 'MEMORY';
      } else {
      // Lot 54A (écart 1) : plus aucun report pour quota T3 interne — une carte
      // ouverte qui demande un arbitrage est TOUJOURS arbitrée (le plafond de
      // coût du compte, la disponibilité du modèle et le circuit breaker de la
      // passerelle restent les seuls freins ; `rearbitration` est ignoré).
      await input.guard?.assertActive('T3 DOCUMENT_ASSET — appel du modèle');
      aiReason = 'STRUCTURED_CANDIDATES_NEED_ARBITRATION';
      branch = 'STRUCTURED';
      const cr = croisement(m.cross);
      crossSent = m.cross;
      try {
        aiCalled = true;
        const output = await callModel({
          accountId, userId: input.userId ?? state.userId, fileId,
          variables: documentAssetVariables(subject0, pourModele, cr.variables),
          onTrace: (t) => traces.push(t),
        });
        const rapport: { cross?: NonNullable<DocumentAssetEvaluation['crossDocument']> } = {};
        decision = decideFromAiOutput(output, pourModele, cr.check, rapport);
        crossReport = rapport.cross ?? null;
        // Candidats découverts au-delà de la borne du prompt : toujours proposés à l'utilisateur.
        if (decision.kind === 'ABSTAIN' && pourModele.length < candidatsIa.length) {
          const vus = new Set(decision.ranked.map((r) => r.assetId));
          decision.ranked.push(...rankCandidates(candidatsIa).filter((r) => !vus.has(r.assetId)).map((r) => ({ ...r, score: Math.min(r.score, 0.3) })));
        }
        memoriser(m.key, 'STRUCTURED', decision);
      } catch (e) {
        if (isExecutionCancelled(e)) throw e;
        if (aiNotConfigured(e)) {
          // IA non configurée : même traitement que T3 inactif (aucune panne, aucune relance, question si utile).
          aiCalled = false;
          aiReason = 'AI_NOT_CONFIGURED';
          decision = { kind: 'ABSTAIN', reasonCode: 'AI_UNAVAILABLE', ranked: rankCandidates(candidatsIa) };
        } else {
        aiError = (e as Error).message.slice(0, 200);
        // Panne du modèle : nouvelle tentative par la file (backoff). Lot 108E (A6) : à la
        // dernière, issue TECHNIQUE (Supervision, relance durable) — jamais une question métier.
        if (!input.finalAttempt) throw e;
        console.warn(`[t3-document-asset] document ${fileId} : modèle indisponible (${(e as Error).message}) — issue technique, relance durable.`);
        return technicalOutcome({
          accountId, fileId, ctx, resolution, revision, g, cardBefore, aiCalled: true, traces,
          evaluation: { ...reexamen, promptCandidateCount: pourModele.length, crossDocumentSent: crossSent, branch: 'STRUCTURED', lastAiAt: new Date().toISOString() },
          category: technicalCategoryOf(e), error: aiError,
        });
        }
      }
      }
    }
  }
  // Appel réussi : les incidents « modèle » du compte sont résolus (contrôle après correction).
  if (aiCalled && !aiError) void resolveTechnicalFailures(accountId, ['MODEL', 'QUOTA', 'SCHEMA']);

  // ── 5 / 6. Application ────────────────────────────────────────────────
  await input.guard?.assertActive('T3 DOCUMENT_ASSET — écriture');
  const result = await applyDecision({
    accountId, fileId, userId: input.userId ?? null, decision, ctx, revision, g, triggerCode: input.triggerCode ?? null,
    // Lot 113AM (correctif) : biens réellement présentés au modèle (recherche sémantique comprise) — la garde
    // d'admission juge la décision IA sur les indices que le serveur a fournis, pas seulement sur les candidats structurés.
    presentedCandidates: pourModele,
    evaluation: {
      ...reexamen, aiCalled, promptCandidateCount: aiCalled ? pourModele.length : 0, ...(aiCalled ? { lastAiAt: new Date().toISOString() } : {}),
      reasonCode: decision.kind === 'ABSTAIN' ? decision.reasonCode : 'RESOLVED',
      ai: { operation: 't3_link_ambiguity', traceIds: traces.slice(0, 5), status: aiError ? 'ERROR' : aiCalled ? 'OK' : 'NOT_CALLED', error: aiError, reason: aiReason },
      semanticSearch: semantic,
      // Lot 105D : mémoire IA (nouvelle décision, réutilisée, ou précédente conservée).
      aiMemory: aiMemory ?? reexamen.aiMemory ?? null,
      aiReused,
      crossDocumentSent: crossSent,
      crossDocument: crossReport,
      branch,
      technicalFailure: null,
    },
  });
  console.info(`[t3-document-asset] document ${fileId} : ${decision.kind}${decision.kind === 'ABSTAIN' ? ` (${decision.reasonCode})` : ` [${decision.method}]`} → ${result.outcome}`);
  if (result.evaluation) logEvaluation(result.evaluation);
  return { ...result, decision, aiCalled };
}

/**
 * Lot 108E (A5, A6) — issue TECHNIQUE : aucune carte créée ni mise à jour ;
 * une carte NÉE D'UNE PANNE (issue précédente technique) est fermée ;
 * empreinte effacée (jamais « contexte inchangé »), relance durable par le
 * balayage après `T3_TECHNICAL_RETRY_MINUTES` ; anomalie Supervision.
 */
async function technicalOutcome(p: {
  accountId: number; fileId: number; ctx: DocumentAssetContext; resolution: DocumentAssetResolution | null; revision: number; g: Garde;
  cardBefore: number | null; aiCalled: boolean; traces: string[];
  evaluation: Omit<DocumentAssetEvaluation, 'newResolution' | 'aiCalled' | 'decision' | 'linkedAssetId' | 'toProcessAction' | 'result'>;
  category: TechnicalFailureCategory; error: string;
}): Promise<ResolveDocumentAssetResult> {
  const { accountId, fileId } = p;
  let fermee: number | null = null;
  if (p.cardBefore !== null && wasTechnicalOutcome(p.resolution)) {
    await p.g('question « À traiter » née d’une panne');
    const { closeTechnicalLinkCard } = await import('@/services/to-process/identity-group-cards');
    if (await closeTechnicalLinkCard(accountId, p.cardBefore, `T3_TECHNICAL_FAILURE:${p.category}`)) fermee = p.cardBefore;
  }
  const decision: DocumentAssetDecision = { kind: 'ABSTAIN', reasonCode: 'TECHNICAL_FAILURE', ranked: [] };
  const evaluation: DocumentAssetEvaluation = {
    ...p.evaluation, aiCalled: p.aiCalled, decision: `ABSTAIN:${TECHNICAL_FAILURE_REASON}`, linkedAssetId: null, newResolution: 'ABSTAINED',
    toProcessAction: fermee !== null ? 'CLOSED' : p.cardBefore !== null ? 'UNCHANGED' : 'NONE', result: 'TECHNICAL_FAILURE',
    reasonCode: p.category === 'IDENTITY_GRAPH' ? 'RESOLVER_FAILED' : 'AI_UNAVAILABLE',
    ai: { operation: 't3_link_ambiguity', traceIds: p.traces.slice(0, 5), status: p.aiCalled ? 'ERROR' : 'NOT_CALLED', error: p.error.slice(0, 200), reason: `TECHNICAL_FAILURE:${p.category}` },
    branch: 'TECHNICAL',
    technicalFailure: {
      category: p.category, error: p.error.slice(0, 300), retryAfterMinutes: T3_TECHNICAL_RETRY_MINUTES, technicalCardClosed: fermee,
      cardOrigin: p.cardBefore === null || fermee !== null ? null : 'BUSINESS',
    },
  };
  await p.g('état de résolution');
  await recordOutcome({
    accountId, fileId, status: 'ABSTAINED', method: 'NONE', reasonCode: TECHNICAL_FAILURE_REASON,
    // Candidats d'une issue métier précédente conservés (diagnostic), jamais republiés par la panne.
    candidates: p.resolution?.candidates ?? [],
    inputFingerprint: null, extractionAt: p.ctx.extractionAt, identifiersFingerprint: p.ctx.idsFingerprint,
    knowledgeRevision: p.revision, contextFingerprint: null, lastEvaluation: { ...evaluation },
  });
  await reportTechnicalFailure({ accountId, fileId, category: p.category, error: p.error });
  console.warn(`[t3-document-asset] document ${fileId} : panne technique ${p.category} — aucune carte, relance dans ${T3_TECHNICAL_RETRY_MINUTES} min${fermee ? ` · carte ${fermee} née d'une panne fermée` : ''}.`);
  logEvaluation(evaluation);
  return { outcome: 'ABSTAIN', status: 'ABSTAINED', decision, aiCalled: p.aiCalled, evaluation };
}

/**
 * Lot 57B (défaut B) — recherche sémantique IA quand aucun candidat
 * structuré n'existe (`semantic-search.ts`). Biens du compte seulement
 * (index du compte), sélection progressive, branche IA existante. Ne lève
 * que pour une interruption. Lot 108E : une panne du modèle est RENDUE
 * (`aiException`) — l'appelant relance (file) ou rend une issue technique ;
 * jamais NO_CANDIDATE. Mêmes garde-fous que la branche structurée (A3) :
 * biens refuses exclus, preuves croisées et contrôle serveur de la sortie
 * quand le contrat est actif.
 */
async function semanticSearch(p: {
  accountId: number; fileId: number; userId: number | null; ctx: DocumentAssetContext; subject: DocumentSubject; skipAi: boolean;
  guard?: ExecutionGuard; callModel: NonNullable<ResolveDocumentAssetDeps['callModel']>;
  supplierHistory: NonNullable<ResolveDocumentAssetDeps['supplierHistory']>; traces: string[];
  excludedAssetIds?: ReadonlySet<number>;
  cross?: { variables: { fileId: number; context: import('./identity/decision').CrossDocumentContext | null } | null; check: Parameters<typeof decideFromAiOutput>[2] };
}): Promise<{
  decision: DocumentAssetDecision; aiCalled: boolean; aiError: string | null; aiException: unknown;
  semantic: NonNullable<DocumentAssetEvaluation['semanticSearch']>; presented: DocumentAssetCandidate[];
  crossSent: boolean; crossReport: DocumentAssetEvaluation['crossDocument'];
}> {
  const crossSent = !!p.cross?.variables;
  const vide = (reason: string) => ({
    decision: { kind: 'ABSTAIN' as const, reasonCode: 'NO_CANDIDATE' as const, ranked: [] }, aiCalled: false, aiError: null, aiException: null,
    semantic: { attempted: false, reason, rounds: 0, presented: 0, matched: 0, origins: {} }, presented: [] as DocumentAssetCandidate[], crossSent: false, crossReport: null,
  });
  const { ctx } = p;
  if (!ctx.sources) return vide('NO_T1_KNOWLEDGE');
  if (ctx.index.assets.length === 0) return vide('NO_ASSET_IN_ACCOUNT');
  if (p.skipAi) return vide('AI_DISABLED');
  const historique = await p.supplierHistory(p.accountId, p.fileId, ctx.sources.extraction?.supplier ?? null);
  // Lot 108E (A3) : un bien refusé par l'utilisateur n'est jamais reproposé, ni en recherche sémantique.
  const shortlist = semanticShortlist(ctx.index, ctx.sources, historique).filter((h) => !p.excludedAssetIds?.has(h.assetId));
  const pages = semanticPages(shortlist);
  const origins: Record<string, number> = {};
  for (const h of shortlist) for (const o of h.origins) origins[o] = (origins[o] ?? 0) + 1;
  const presented: DocumentAssetCandidate[] = [];
  let rounds = 0;
  let crossReport: DocumentAssetEvaluation['crossDocument'] = null;
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
        variables: { ...documentAssetVariables(p.subject, cands, p.cross?.variables ?? null), RELATION_TYPE: SEMANTIC_RELATION },
        onTrace: (t) => p.traces.push(t),
      });
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      const err = (e as Error).message.slice(0, 200);
      console.warn(`[t3-document-asset] document ${p.fileId} : recherche sémantique — modèle indisponible (${err}).`);
      return {
        decision: { kind: 'ABSTAIN', reasonCode: 'NO_CANDIDATE', ranked: [] }, aiCalled: true, aiError: err, aiException: e,
        semantic: { attempted: true, reason: 'AI_UNAVAILABLE', rounds, presented: presented.length, matched: 0, origins }, presented, crossSent, crossReport,
      };
    }
    const rapport: { cross?: NonNullable<DocumentAssetEvaluation['crossDocument']> } = {};
    const decision = decideFromAiOutput(output, cands, p.cross?.check ?? null, rapport);
    crossReport = rapport.cross ?? crossReport;
    const retenus = new Set(output.matches.map((m) => m.candidateId).filter((id) => cands.some((c) => c.assetId === id)));
    if (decision.kind !== 'ABSTAIN') {
      return { decision, aiCalled: true, aiError: null, aiException: null, semantic: { attempted: true, reason: 'RESOLVED', rounds, presented: presented.length, matched: retenus.size, origins }, presented, crossSent, crossReport };
    }
    if (retenus.size > 0) {
      // Le modèle désigne un ou des biens sans preuve suffisante : proposés à l'utilisateur (justification du modèle).
      const ranked = decision.reasonCode === 'CLOSED_WORLD_VIOLATION' ? [] : decision.ranked.filter((r) => retenus.has(r.assetId));
      return {
        decision: ranked.length ? { ...decision, ranked } : { kind: 'ABSTAIN', reasonCode: 'NO_CANDIDATE', ranked: [] },
        aiCalled: true, aiError: null, aiException: null,
        semantic: { attempted: true, reason: decision.reasonCode, rounds, presented: presented.length, matched: retenus.size, origins }, presented, crossSent, crossReport,
      };
    }
  }
  return {
    decision: { kind: 'ABSTAIN', reasonCode: 'NO_CANDIDATE', ranked: [] }, aiCalled: rounds > 0, aiError: null, aiException: null,
    semantic: { attempted: rounds > 0, reason: rounds > 0 ? 'NO_MATCH' : 'NO_ASSET_IN_ACCOUNT', rounds, presented: presented.length, matched: 0, origins }, presented,
    crossSent: crossSent && rounds > 0, crossReport,
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
  /** Lot 108E (A7) : utilisateur INITIATEUR seulement (null : contexte technique — cohérence, balayage). */
  accountId: number; fileId: number; userId: number | null; decision: DocumentAssetDecision;
  ctx: DocumentAssetContext; revision: number; g: Garde; evaluation: EvaluationDraft; triggerCode?: string | null;
  /** Biens présentés au modèle (structurés ou présélection sémantique) ; complète `ctx.candidates` pour la justification. */
  presentedCandidates?: readonly DocumentAssetCandidate[];
}): Promise<Omit<ResolveDocumentAssetResult, 'decision' | 'aiCalled'>> {
  const { accountId, fileId, g, ctx } = p;
  let decision = p.decision;
  // Lot 113AM (#739) : garde d'admission AVANT toute écriture (et avant de fermer la question) — un
  // rattachement dont la seule preuve est une adresse non qualifiée « lieu du bien » (souscripteur,
  // destinataire, facturation…) est refusé ; la décision devient une abstention SANS ce bien (jamais
  // une question sur un faux conflit). Refus journalisés (étape, règle, preuves).
  const justifications = new Map<number, LinkJustification>();
  if (decision.kind !== 'ABSTAIN') {
    const cibles0 = decision.kind === 'APPLY' ? [decision.assetId] : decision.assetIds;
    const refuses: number[] = [];
    for (const assetId of cibles0) {
      const j = documentAssetLinkJustification({
        assetId, decision, branch: p.evaluation.branch, candidates: [...ctx.candidates, ...(p.presentedCandidates ?? [])], identification: ctx.identification,
        qualifications: ctx.build.addressQualifications ?? [], identity: ctx.identity ?? null,
        facts: (ctx.sources?.facts ?? []).map((f) => ({ canonicalKey: f.canonicalKey, value: f.value, label: f.label, subject: f.subject, targetType: f.targetType, targetEntityId: f.targetEntityId })),
        texts: (ctx.sources?.texts ?? []).filter((t) => !t.uncertain).map((t) => t.text),
      });
      justifications.set(assetId, j);
      const admission = admitDocumentAssetLink('AI', j);
      if (admission.admitted) continue;
      refuses.push(assetId);
      const rec = { accountId, fileId, target: { assetId }, writeKind: 'LINK' as const, justification: j, decision: admission };
      logLinkRefusal(rec);
      await recordLinkAdmission({ ...rec, origin: 'AI', role: decision.kind === 'APPLY' ? 'PRIMARY' : 'SECONDARY' });
    }
    if (refuses.length > 0) {
      const restants = cibles0.filter((id) => !refuses.includes(id));
      decision = decision.kind === 'MULTI_ASSET' && restants.length > 1
        ? { ...decision, assetIds: restants }
        : decision.kind === 'MULTI_ASSET' && restants.length === 1
          ? { kind: 'APPLY', assetId: restants[0], score: 1, reason: `${decision.reason}:ADMITTED_ONLY`, method: decision.method }
          : { kind: 'ABSTAIN', reasonCode: 'INSUFFICIENT_EVIDENCE', ranked: rankCandidates(ctx.candidates.filter((c) => !refuses.includes(c.assetId))) };
    }
  }
  const fin = (o: { newResolution: ResolutionStatus | null; linkedAssetId?: number | null; toProcessAction: ToProcessEffect; result: DocumentAssetEvaluationResult }): DocumentAssetEvaluation => ({
    ...p.evaluation, decision: decision.kind === 'ABSTAIN' ? `ABSTAIN:${decision.reasonCode}` : `${decision.kind}:${decision.method}`,
    linkedAssetId: o.linkedAssetId ?? null, newResolution: o.newResolution, toProcessAction: o.toProcessAction, result: o.result,
  });
  // Relecture JUSTE AVANT l'écriture : l'utilisateur a pu trancher pendant
  // l'appel au modèle (ticket T3, §11).
  const avant = await readAttachmentState(accountId, fileId);
  const stop = await stopReason(accountId, fileId, avant, g);
  if (stop) return stop.outcome === 'NO_CHANGE' ? { ...stop, outcome: 'SUPERSEDED' } : stop;
  // Lot 113V : « Aucun » choisi PENDANT l'évaluation (appel au modèle) — la décision de l'utilisateur gagne.
  if (await readExplicitNoAssetDecision(accountId, fileId)) {
    await g('état de résolution');
    await recordOutcome({ accountId, fileId, status: 'USER_DECIDED', method: 'NONE', reasonCode: 'USER_NO_ASSET' });
    return { outcome: 'SUPERSEDED', status: 'USER_DECIDED' };
  }
  const commun = {
    inputFingerprint: ctx.fingerprint, extractionAt: ctx.extractionAt, identifiersFingerprint: ctx.idsFingerprint,
    knowledgeRevision: p.revision, contextFingerprint: ctx.fingerprint,
  };

  if (decision.kind === 'ABSTAIN') {
    const candidates: StoredCandidate[] = decision.ranked.map((r) => ({
      assetId: r.assetId, label: ctx.labels.get(r.assetId)?.name ?? unnamedLabel('ASSET'), score: r.score, reason: r.reason,
    }));
    // Lot 105D : la question appartient à la carte GROUPÉE (ou l'utilisateur a refusé ces biens) —
    // aucune carte individuelle : celle qui subsiste est fermée (pas de doublon, aucune question répétée).
    const parGroupe = decision.reasonCode === 'GROUP_CONFIRMATION_PENDING' || decision.reasonCode === 'GROUP_REFUSED';
    let effet: ToProcessEffect;
    if (parGroupe) {
      await g('question « À traiter »');
      const { closeIndividualCards } = await import('@/services/to-process/identity-group-cards');
      const motif = decision.reasonCode === 'GROUP_REFUSED' ? `REFUSED:${ctx.identity?.group?.groupKey ?? '?'}` : ctx.identity?.group?.groupKey ?? '?';
      effet = (await closeIndividualCards(accountId, [fileId], motif)) > 0 ? 'CLOSED' : 'NONE';
    } else {
      // Carte LINK-ASSET synchronisée sur l'état COURANT (créée, ou
      // COMPLETE → ARBITRATE, ou propositions actualisées).
      effet = await openUserQuestion({
        accountId, fileId, state: avant, candidates, g, supplier: ctx.sources?.extraction?.supplier ?? null,
        // Lot 113S : question proposée par T3 dans la même sortie (appel ou décision mémorisée), contrôlée par la carte.
        ai: {
          raw: decision.userQuestion ?? null, called: p.evaluation.aiCalled === true || p.evaluation.aiReused === true,
          traceId: p.evaluation.ai?.traceIds?.[0] ?? p.evaluation.aiMemory?.traceId ?? null,
          title: ctx.sources?.extraction?.title ?? null,
          others: ctx.index.assets.filter((a) => !candidates.some((c) => c.assetId === a.assetId)).map((a) => a.name),
        },
      });
    }
    const status = decision.reasonCode === 'NO_CANDIDATE' ? 'NO_CANDIDATE' : 'ABSTAINED';
    const evaluation = fin({ newResolution: status, toProcessAction: effet, result: status });
    await g('état de résolution');
    await recordOutcome({
      accountId, fileId, status, method: decision.reasonCode === 'NO_CANDIDATE' || parGroupe ? 'NONE' : 'AI', reasonCode: decision.reasonCode,
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
      justification: justifications.get(assetId) ?? { step: 'T3_DOCUMENT_ASSET', rule: decision.reason, proofs: [] },
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
  const projection = await afterLink({ accountId, fileId, userId: p.userId, assetIds: cibles, ctx, triggerCode: p.triggerCode ?? null });

  const status = decision.kind === 'APPLY' ? 'RESOLVED' : 'MULTI_ASSET';
  // Multi-biens : la décision reste OUVERTE (aucun bien principal). Son
  // empreinte est celle du contexte APRÈS l'écriture (ses propres liens
  // SECONDARY compris) : le passage suivant ne la rejoue pas pour ses
  // propres liens.
  const fingerprint = decision.kind === 'MULTI_ASSET'
    ? (await computeDocumentAssetContext({ accountId, fileId, state: apres, resolution: { t1Candidates: ctx.t1Candidates }, index: ctx.index })).fingerprint
    : ctx.fingerprint;
  const evaluation = {
    ...fin({
      newResolution: status, linkedAssetId: decision.kind === 'APPLY' ? decision.assetId : null,
      toProcessAction: fermees > 0 ? 'CLOSED' : 'NONE',
      result: decision.kind === 'MULTI_ASSET' ? 'MULTI_ASSET' : decision.method === 'AI' ? 'RESOLVED_BY_AI' : 'RESOLVED_DETERMINISTICALLY',
    }),
    projection,
  };
  await g('état de résolution');
  await recordOutcome({
    accountId, fileId, status, method: decision.method, reasonCode: decision.reason.slice(0, 200),
    decidedAssetIds: cibles, ...commun, contextFingerprint: fingerprint, inputFingerprint: fingerprint, lastEvaluation: { ...evaluation },
  });
  return { outcome: 'APPLIED', status, evaluation };
}

/**
 * Après un rattachement par T3 : faits persistés projetés sur le bien
 * (preuves, réconciliation T3 du bien, équipements, Opérations, Agenda T4 —
 * `projectDocumentKnowledgeToAsset`), puis événement `document_linked` et
 * titre SYSTEM. Non bloquant : le lien est posé.
 *
 * Lot 108E (A7) : SANS utilisateur initiateur (cohérence, balayage), la
 * projection a lieu en CONTEXTE TECHNIQUE journalisé (`projection-actor.ts`)
 * — plus jamais sautée. Document d'appareil (A2) : faits sans cible jamais
 * réattribués au bien porteur (ni prix ni garantie d'appareil).
 */
async function afterLink(p: {
  accountId: number; fileId: number; userId: number | null; assetIds: number[]; ctx?: DocumentAssetContext; triggerCode?: string | null;
}): Promise<ProjectionEffect> {
  const k = await import('../../knowledge/document-knowledge.service');
  const { enqueueT3ForAssets } = await import('../t3-queue');
  const acteur = await resolveProjectionActor(p.accountId, p.userId, p.triggerCode ?? null);
  const appareil = p.ctx ? isEquipmentDocumentContext(p.ctx) : false;
  const effet: ProjectionEffect = {
    actor: acteur.kind, reason: acteur.reason, trigger: p.triggerCode ?? null, equipmentDocument: appareil, assets: [],
  };
  if (acteur.kind !== 'USER') {
    console.info(`[t3-document-asset] document ${p.fileId} : projection en contexte technique (${acteur.reason}${acteur.kind === 'TECHNICAL' ? `, titulaire ${acteur.userId}` : ''}, déclencheur ${p.triggerCode ?? '∅'}).`);
  }
  for (const assetId of p.assetIds) {
    if (acteur.userId === null) { effet.assets.push({ assetId, status: 'SKIPPED', evidence: null, error: 'NO_ACCOUNT_OWNER' }); continue; }
    try {
      const projetable = await k.hasProjectableKnowledge(p.fileId);
      if (projetable) {
        const n = await k.projectDocumentKnowledgeToAsset({
          accountId: p.accountId, userId: acteur.userId, fileId: p.fileId, assetId, ...(appareil ? { reassignUntargeted: false } : {}),
        });
        effet.assets.push({ assetId, status: 'PROJECTED', evidence: n });
      } else {
        await enqueueT3ForAssets({ accountId: p.accountId, userId: acteur.userId, assetIds: [assetId], sourceFileId: p.fileId, reason: 'document_linked' });
        effet.assets.push({ assetId, status: 'T3_ENQUEUED', evidence: null });
      }
    } catch (e) {
      if (isExecutionCancelled(e)) throw e;
      effet.assets.push({ assetId, status: 'ERROR', evidence: null, error: (e as Error).message.slice(0, 200) });
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
  return effet;
}

/** Lot 108E (A2) : le document porte-t-il une identité d'appareil (série, IMEI, modèle) ? Pure vis-à-vis de la base. */
function isEquipmentDocumentContext(ctx: DocumentAssetContext): boolean {
  if (ctx.identity?.graph.equipmentDocuments?.has(ctx.fileId)) return true;
  return (ctx.sources?.facts ?? []).some((f) => f.canonicalKey === 'serialNumber' || f.canonicalKey === 'imei' || f.canonicalKey === 'modelName');
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
async function openUserQuestion(p: {
  accountId: number; fileId: number; state: AttachmentState; candidates: StoredCandidate[]; g: Garde; supplier?: string | null;
  /** Lot 113S : question de T3 (brute), appel réel ou mémorisé, trace ; titre du document ; autres biens du compte. */
  ai?: { raw: unknown; called: boolean; traceId: string | null; title: string | null; others: string[] };
}): Promise<ToProcessEffect> {
  if (!p.state.open) return 'NONE';
  await p.g('question « À traiter »');
  const { upsertAction } = await import('@/services/to-process/to-process-action.service');
  // Lot 77B : la justification (serveur ou modèle) n'est jamais affichée
  // telle quelle — formulation utilisateur (« Déjà 3 documents de Cardif IARD
  // sur Maison ») ou rien. Le motif brut reste au diagnostic (`candidates`).
  const proposals = p.candidates.slice(0, 5).map((c) => {
    const source = userSourceLabel(c.reason, { assetName: c.label, supplier: p.supplier ?? null });
    return {
      value: c.assetId, label: c.label, confidence: Math.min(0.89, Math.max(0, c.score)),
      ...(source ? { sourceContext: { label: source.slice(0, 120) } } : {}),
    };
  });
  // Lot 113S (#716) : arbitrage avec candidats — question de T3 si elle passe le contrôle (biens
  // candidats, titre du document, fournisseur) ; sinon question du catalogue, provenance tracée.
  // Sans candidat (« À compléter ») : question simple du catalogue, jamais d'IA.
  const choix = proposals.length > 0 && p.ai
    ? await (await import('@/services/to-process/ai-user-question')).resolveAiCardQuestion(p.accountId, {
      rule: 'LINK-ASSET', treatment: 'T3', operation: 't3_link_ambiguity', contract: T3_USER_QUESTION_MARKER, raw: p.ai.raw, aiCalled: p.ai.called,
      contractActive: await (await import('@/services/to-process/ai-user-question')).questionContractActive('t3_link_ambiguity', T3_USER_QUESTION_MARKER),
      traceId: p.ai.traceId, check: { allowedLabels: [...proposals.map((x) => x.label), p.ai.title, p.supplier], foreignLabels: p.ai.others },
    }, p.fileId)
    : null;
  const res = await upsertAction({
    accountId: p.accountId,
    targetType: 'DOCUMENT',
    targetId: p.fileId,
    relationKey: 'assetIds',
    actionKind: proposals.length > 0 ? 'ARBITRATE' : 'COMPLETE',
    ruleCode: 'LINK-ASSET',
    ...(choix ? { question: choix.question, questionSource: choix.source } : {}),
    proposals,
    // `current` : même instantané que le pont documentaire (rattachement vide).
    triggerContext: { current: '', producer: 'T3_DOCUMENT_ASSET' },
  });
  return res.status === 'CREATED' ? 'CREATED' : res.status === 'UPDATED' ? 'UPDATED' : 'SKIPPED';
}

/** Lot 113S : marqueur du contrat de question T3 (même valeur que `T3_USER_QUESTION_CONTRACT`, sans import circulaire). */
const T3_USER_QUESTION_MARKER = 't3-user-question-v1';

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
