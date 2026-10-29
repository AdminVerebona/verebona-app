/**
 * Lot 97A — contrat de la RÉÉVALUATION SÉMANTIQUE T3 de l'identité d'une
 * Opération à PLUSIEURS sources (demande `87B-t3-identite-multi-operations`).
 * Partie PURE : ne dépend que de zod.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUI DÉCIDE QUOI
 *
 *   T3   dit, source par source, si elle relève bien de l'Opération examinée
 *        (`KEEP`), d'aucune Opération du contexte (`SEPARATE`) ou d'une
 *        Opération voisine fournie (`MOVE`) — branche OPERATION_IDENTITY du
 *        prompt maître T3, contrat `t3-operation-identity-v1`.
 *   Code collecte le contexte BORNÉ (Opération, sources, voisines, documents
 *        et extraits, décisions de l'utilisateur), VALIDE la réponse (monde
 *        fermé, complétude, cohérence interne, protections), puis applique
 *        les seules décisions CERTAINES par le mécanisme existant de la
 *        consolidation T3 : décisions de rattachement (`business_operation_
 *        match_decisions`, origine `AI_IDENTITY`) relues par
 *        `decideCandidate`, consolidation du document par la file durable.
 *        Le code ne sépare ni ne déplace jamais rien de lui-même.
 *
 * Activation prudente : la branche n'est appelée que si le prompt T3 ACTIF
 * porte la section « BRANCHE TASK = OPERATION_IDENTITY » ET le marqueur
 * `t3-operation-identity-v1` (texte collé par le PO). Sinon : constat
 * `MULTI_SOURCE_IDENTITY` (comportement d'avant), aucune écriture.
 *
 * Références opaques (monde fermé) : `O1` = l'Opération examinée, `O2`… les
 * voisines, `S1`… ses sources, `D1`… les documents. Aucun identifiant
 * technique n'est transmis ; le serveur refuse toute référence inconnue.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { z } from 'zod';
import type { ContextDocument, ContextOperation } from './contract';

/** Version du contrat d'entrée / sortie (marqueur exact recherché dans le prompt T3 actif). */
export const IDENTITY_CONTRACT_VERSION = 't3-operation-identity-v1';
/** Branche du prompt maître T3. */
export const IDENTITY_TASK = 'OPERATION_IDENTITY';
/** Opération du registre IA. */
export const IDENTITY_OPERATION = 't3_operation_identity';
/** Origine des décisions de rattachement posées par une décision T3 appliquée (migration 0836). */
export const IDENTITY_DECISION_ORIGIN = 'AI_IDENTITY';

// ── Entrée (variables des six emplacements du master T3) ────────────────────

export interface IdentitySource {
  ref: string;
  /** `DOCUMENT`, `ASSET_DATA`… (nature de la source gérée). */
  kind: string;
  /** Document de la source (`D…`) ; null pour une donnée structurée. */
  document: string | null;
  /** Rôle documentaire déclaré par T1 (INVOICE, QUOTE…). */
  role: string | null;
  type: string | null;
  status: string | null;
  summary: string | null;
  provider: string | null;
  dates: { plannedDate: string | null; startDate: string | null; realizedDate: string | null; endDate: string | null };
  amounts: string[];
  references: string[];
  assets: string[];
  /** Comment la source a rejoint l'Opération : FOUNDING (créatrice), USER, REFERENCE, RULE, AI, OTHER. */
  attachedBy: 'FOUNDING' | 'USER' | 'REFERENCE' | 'RULE' | 'AI' | 'OTHER';
  /** Source à décider (document) ; sinon contexte seulement. */
  inScope: boolean;
  /** Rattachement voulu par l'utilisateur : jamais séparé ni déplacé. */
  protected: boolean;
}

export interface IdentityInput {
  contractVersion: typeof IDENTITY_CONTRACT_VERSION;
  task: typeof IDENTITY_TASK;
  today: string;
  operation: ContextOperation;
  sources: IdentitySource[];
  neighbours: ContextOperation[];
  documents: ContextDocument[];
  /** Motif de la demande (contrôle de cohérence, préoccupation signalée par T4…). */
  request: string;
  bounds: { complete: boolean; droppedSources: number; droppedNeighbours: number; droppedDocuments: number };
}

/**
 * Variables RÉELLES du master T3 (les six emplacements, aucun nouveau) :
 * FIELD = contrat + Opération examinée ; CURRENT_STATE = ses sources ;
 * EVIDENCES = documents et extraits ; SUBJECT_CONTEXT = date, monde fermé,
 * motif, bornes ; CANDIDATES = Opérations voisines ; RELATION_TYPE.
 */
export function identityVariables(input: IdentityInput): Record<string, unknown> {
  return {
    FIELD: { contractVersion: input.contractVersion, task: input.task, operation: input.operation },
    CURRENT_STATE: { sources: input.sources },
    EVIDENCES: { documents: input.documents },
    SUBJECT_CONTEXT: { today: input.today, closedWorld: true, request: input.request, bounds: input.bounds },
    CANDIDATES: { neighbours: input.neighbours },
    RELATION_TYPE: IDENTITY_TASK,
  };
}

/** Le texte d'un prompt porte-t-il la branche ET le marqueur ? (pure) */
export function promptCarriesIdentity(text: string | null | undefined, branches: readonly string[]): boolean {
  return typeof text === 'string' && text.includes(IDENTITY_CONTRACT_VERSION) && branches.includes(IDENTITY_TASK);
}

// ── Sortie (schéma validé par la passerelle, puis `identity-validate.ts`) ───

const ref = z.string().min(1).max(12);

export const IDENTITY_SOURCE_DECISIONS = ['KEEP', 'SEPARATE', 'MOVE'] as const;

const IdentitySourceDecision = z.object({
  source: ref,
  decision: z.enum(IDENTITY_SOURCE_DECISIONS),
  /** Opération voisine d'arrivée (`O2`…) pour MOVE ; null sinon. */
  targetOperation: ref.nullable(),
  confidence: z.enum(['certain', 'probable', 'ambiguous']),
  evidence: z.array(z.object({ document: ref.nullable().optional(), excerpt: z.string().min(1).max(400) })).max(6).default([]),
  reason: z.string().min(1).max(300),
});

export const T3OperationIdentityOutput = z.object({
  task: z.literal(IDENTITY_TASK),
  outcome: z.enum(['CONFIRMED', 'REVISED', 'ABSTAIN']),
  sources: z.array(IdentitySourceDecision).max(30).default([]),
  reason: z.string().min(1).max(300),
}).superRefine((v, ctx) => {
  if (v.outcome === 'ABSTAIN' && v.sources.length) ctx.addIssue({ code: 'custom', path: ['sources'], message: 'outcome=ABSTAIN exige sources=[]' });
  if (v.outcome === 'CONFIRMED' && v.sources.some((s) => s.decision !== 'KEEP')) {
    ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'outcome=CONFIRMED exige decision=KEEP pour chaque source' });
  }
  if (v.outcome === 'REVISED') {
    if (!v.sources.some((s) => s.decision !== 'KEEP')) ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'outcome=REVISED exige au moins une source SEPARATE ou MOVE' });
    if (!v.sources.some((s) => s.decision === 'KEEP')) ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'outcome=REVISED exige au moins une source KEEP (l’Opération examinée garde au moins une source)' });
  }
  v.sources.forEach((s, i) => {
    if ((s.decision === 'MOVE') !== (s.targetOperation !== null)) {
      ctx.addIssue({ code: 'custom', path: ['sources', i, 'targetOperation'], message: 'targetOperation est obligatoire pour MOVE et null sinon' });
    }
  });
});
export type T3OperationIdentityOutput = z.infer<typeof T3OperationIdentityOutput>;

/** Motifs de refus (validation, protections) — stables, journalisés. */
export const IDENTITY_ISSUES = [
  'SCHEMA', 'UNKNOWN_REFERENCE', 'OUT_OF_SCOPE_REFERENCE', 'SOURCE_DECIDED_TWICE', 'SOURCE_NOT_DECIDED', 'TARGET_IS_EXAMINED_OPERATION',
  'PROTECTED_OBJECT', 'STATE_CHANGED',
] as const;
export type IdentityIssue = (typeof IDENTITY_ISSUES)[number];
