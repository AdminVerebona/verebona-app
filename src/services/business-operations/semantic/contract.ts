/**
 * Lot 87B — contrat de la RÉÉVALUATION SÉMANTIQUE T3 / T4 (ticket P1
 * « Code — compléter l'orchestration T3/T4 et la réévaluation sémantique »,
 * CODE-01 à CODE-11). Partie PURE : ne dépend que de zod.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUI DÉCIDE QUOI (V-Q5, ticket §2)
 *
 *   T3   identité des Opérations (quels documents / faits forment une même
 *        Opération, fusion / séparation) — contrat ACTUEL : rapprochement
 *        sémantique M3 (`OPERATION_MATCH`, un document face à ≤ 5
 *        Opérations). Le code le sollicite à nouveau quand une décision
 *        historique est suspecte (verdict écarté, CODE-06).
 *   T4   représentation de ces Opérations dans l'Agenda : quelles occurrences
 *        existent, lesquelles sont des doublons, lesquelles sont des étapes
 *        distinctes, comment elles se rattachent, laquelle est principale —
 *        sur PLUSIEURS éléments à la fois (CODE-03). Le contrat T4 actuel
 *        (CLASSIFY_EVENT, VERIFY_COMPLETION, TEMPORAL_AMBIGUITY) ne raisonne
 *        que sur UN événement : le contrat multi-événements ci-dessous est
 *        DEMANDÉ à l'équipe IA (`87B-t4-representation-agenda-multi-evenements`).
 *        Tant qu'il n'est pas livré, la capacité est INDISPONIBLE : aucun
 *        appel, aucune fusion ni séparation par le code — constat qualifié.
 *   Code collecte les preuves (contexte large et BORNÉ), sélectionne les
 *        candidats (signaux), orchestre T3 → T4, VALIDE la décision reçue,
 *        l'applique atomiquement par les services existants, la trace, et
 *        protège les décisions de l'utilisateur.
 *
 * Références opaques (monde fermé) : les éléments d'agenda (`A1`…), éléments
 * restaurables d'une ancienne consolidation (`R1`…), documents (`D1`…) et
 * Opérations (`O1` = l'Opération examinée, `O2`… voisines) ne portent jamais
 * d'identifiant technique : le serveur seul fait la correspondance, et refuse
 * toute référence inconnue (CODE-10).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { z } from 'zod';

/** Version du contrat d'entrée / sortie multi-événements (entre dans l'empreinte du contexte). */
export const REPRESENTATION_CONTRACT_VERSION = 't4-agenda-representation-v1';
/** Branche demandée à l'équipe IA (aucun prompt modifié par le code). */
export const REPRESENTATION_TASK = 'AGENDA_REPRESENTATION';
/** Demandes à l'équipe IA (constats du contrôle, journal). */
export const REPRESENTATION_AI_CONTRACT = '87B-t4-representation-agenda-multi-evenements';
export const T3_IDENTITY_AI_CONTRACT = '87B-t3-identite-multi-operations';

export type SemanticScope = 'T3' | 'T4';
export type SemanticTrigger = 'COHERENCE' | 'PROJECTION' | 'T3_DECISION' | 'REPRISE' | 'MANUAL';
export type SemanticStatus =
  | 'PENDING' | 'UNAVAILABLE' | 'DEFERRED' | 'AI_FAILED' | 'REJECTED' | 'APPLIED' | 'PARTIAL' | 'NO_CHANGE' | 'ABSTAINED' | 'FAILED';

// ── Contexte transmis à T4 (CODE-01) ────────────────────────────────────────

export interface ContextAmount { kind: string; amountMinor: number; currency: string; date: string | null; periodStart: string | null; periodEnd: string | null }
export interface ContextReference { kind: string; value: string }

export interface ContextOperation {
  ref: string;
  type: string | null;
  status: string;
  label: string | null;
  provider: string | null;
  plannedDate: string | null;
  startDate: string | null;
  realizedDate: string | null;
  endDate: string | null;
  assets: string[];
  equipments: string[];
  rooms: string[];
  amounts: ContextAmount[];
  references: ContextReference[];
  documents: string[];
  /** Voisine seulement : biens communs avec l'Opération examinée. */
  sharedAssets?: string[];
}

export interface ContextAgendaItem {
  ref: string;
  title: string;
  date: string | null;
  nature: string | null;
  businessType: string | null;
  /** Élément saisi par l'utilisateur, automatique (T4 / fiche), ou projection technique d'une Opération. */
  origin: 'USER' | 'AUTOMATIC' | 'PROJECTION';
  /** Modifié, confirmé ou doté d'un statut par l'utilisateur (jamais absorbé). */
  touchedByUser: boolean;
  status: string | null;
  /** Opération de rattachement (`O1`, voisine, `OTHER` hors contexte) ou null. */
  operationRef: string | null;
  role: 'PRINCIPAL' | 'RELATED' | null;
  roleOrigin: string | null;
  /** Documents reliés (liens) et document d'origine. */
  documents: string[];
  originDocument: string | null;
  /** Preuves de production (document, rôle) — conservées à toute consolidation. */
  sources: Array<{ document: string | null; role: string | null }>;
  assets: string[];
  /** Élément à décider dans cette réévaluation (sinon : contexte seulement). */
  inScope: boolean;
}

export interface ContextRestorable {
  ref: string;
  /** Élément qui l'a absorbé (référence d'un élément du contexte, ou null s'il a disparu). */
  absorbedInto: string | null;
  title: string;
  date: string | null;
  businessType: string | null;
  documents: string[];
  reason: string;
  at: string;
}

export interface ContextDocument {
  ref: string;
  type: string | null;
  title: string | null;
  date: string | null;
  provider: string | null;
  amounts: ContextAmount[];
  references: ContextReference[];
  excerpts: string[];
  operations: string[];
}

type UserDecisionKind =
  | 'ITEM_DETACHED' | 'ITEM_ATTACHED' | 'LINK_DETACHED' | 'PRINCIPAL_WITHDRAWN' | 'PRINCIPAL_CHOSEN' | 'PROJECTION_DELETED' | 'CONSOLIDATION_RESTORED';

export interface ContextUserDecision { kind: UserDecisionKind; item?: string | null; document?: string | null; operation?: string | null }

export interface ContextPriorDecision { at: string; scope: SemanticScope; status: string; summary: string }

export interface RepresentationInput {
  contractVersion: typeof REPRESENTATION_CONTRACT_VERSION;
  task: typeof REPRESENTATION_TASK;
  /** Date de référence (jamais dans l'empreinte : le contexte reste stable d'un jour à l'autre). */
  today: string;
  operation: ContextOperation;
  neighbours: ContextOperation[];
  agendaItems: ContextAgendaItem[];
  restorable: ContextRestorable[];
  documents: ContextDocument[];
  userDecisions: ContextUserDecision[];
  priorDecisions: ContextPriorDecision[];
  bounds: {
    complete: boolean;
    droppedItems: number;
    droppedDocuments: number;
    droppedNeighbours: number;
    droppedExcerpts: number;
  };
}

// ── Entrée validée côté serveur (lot 97A : contrat d'exécution `t4_input_v3`) ──

const refOpaque = z.string().min(1).max(12);
const amountSchema = z.looseObject({ kind: z.string(), amountMinor: z.number().int(), currency: z.string() });
const contextOperationSchema = z.looseObject({
  ref: refOpaque, type: z.string().nullable(), status: z.string(), assets: z.array(z.string()), amounts: z.array(amountSchema), documents: z.array(refOpaque),
});

/**
 * Forme de l'entrée `t4-agenda-representation-v1` contrôlée AVANT tout appel
 * (passerelle, contexte structuré) : version et branche exactes, références
 * opaques seulement, au moins un élément à décider. Les champs descriptifs
 * restent ouverts (`looseObject`) : le constructeur `context.ts` fait foi.
 */
export const T4AgendaRepresentationInput = z.looseObject({
  contractVersion: z.literal(REPRESENTATION_CONTRACT_VERSION),
  task: z.literal(REPRESENTATION_TASK),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  operation: contextOperationSchema,
  neighbours: z.array(contextOperationSchema).max(20),
  agendaItems: z.array(z.looseObject({ ref: refOpaque, title: z.string(), inScope: z.boolean(), origin: z.enum(['USER', 'AUTOMATIC', 'PROJECTION']) })).min(1).max(60)
    .refine((l) => l.some((i) => i.inScope), 'au moins un élément à décider (inScope)'),
  restorable: z.array(z.looseObject({ ref: refOpaque })).max(20),
  documents: z.array(z.looseObject({ ref: refOpaque })).max(20),
  userDecisions: z.array(z.looseObject({ kind: z.string() })).max(100),
  priorDecisions: z.array(z.looseObject({ at: z.string(), scope: z.enum(['T3', 'T4']), status: z.string() })).max(10),
  bounds: z.looseObject({ complete: z.boolean() }),
});

// ── Sortie attendue de T4 (contrat demandé, CODE-03) ────────────────────────

const confidence = z.enum(['certain', 'probable', 'ambiguous']);

const evidence = z.array(z.object({
  document: z.string().min(1).max(12).nullable().optional(),
  excerpt: z.string().min(1).max(400),
})).max(6);

/**
 * Une OCCURRENCE Agenda selon T4 : un ou plusieurs éléments qui la
 * représentent. Plusieurs éléments = doublons ou représentations
 * complémentaires d'une MÊME occurrence (consolidés sur `keep`, preuves
 * conservées) ; deux occurrences distinctes = étapes distinctes ou
 * événements indépendants.
 *   role PRINCIPAL    événement principal de l'Opération examinée ;
 *        STEP         étape distincte de cette Opération (élément lié) ;
 *        INDEPENDENT  ne représente pas cette Opération (jamais rattaché ;
 *                     détaché s'il l'était par une inférence).
 */
const RepresentationOccurrence = z.object({
  items: z.array(z.string().min(1).max(12)).min(1).max(20),
  keep: z.string().min(1).max(12),
  role: z.enum(['PRINCIPAL', 'STEP', 'INDEPENDENT']),
  confidence,
  evidence: evidence.default([]),
  reason: z.string().min(1).max(300),
});
type RepresentationOccurrence = z.infer<typeof RepresentationOccurrence>;

/** Occurrence absorbée par une ancienne consolidation (lot 76H) qui doit redevenir distincte (CODE-07). */
const RepresentationRestoration = z.object({
  restore: z.string().min(1).max(12),
  role: z.enum(['PRINCIPAL', 'STEP', 'INDEPENDENT']),
  confidence,
  evidence: evidence.default([]),
  reason: z.string().min(1).max(300),
});
type RepresentationRestoration = z.infer<typeof RepresentationRestoration>;

export const T4AgendaRepresentationOutput = z.object({
  task: z.literal(REPRESENTATION_TASK),
  outcome: z.enum(['DECIDED', 'ABSTAIN']),
  occurrences: z.array(RepresentationOccurrence).max(20).default([]),
  restorations: z.array(RepresentationRestoration).max(20).default([]),
  /**
   * L'identité de l'Opération elle-même paraît erronée (éléments qui
   * relèvent d'une autre Opération, Opération à scinder) : le serveur
   * demande alors une réévaluation T3 (CODE-05 « T3 puis T4 »).
   */
  identityConcern: z.object({
    kind: z.enum(['OTHER_OPERATION', 'SPLIT', 'MERGE']),
    items: z.array(z.string().min(1).max(12)).max(20).default([]),
    operation: z.string().min(1).max(12).nullable().optional(),
    reason: z.string().min(1).max(300),
  }).nullable().optional(),
  reason: z.string().min(1).max(300),
}).superRefine((v, ctx) => {
  if (v.outcome === 'ABSTAIN' && (v.occurrences.length || v.restorations.length)) {
    ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'outcome=ABSTAIN exige occurrences=[] et restorations=[]' });
  }
  for (const [i, o] of v.occurrences.entries()) {
    if (!o.items.includes(o.keep)) ctx.addIssue({ code: 'custom', path: ['occurrences', i, 'keep'], message: 'keep doit appartenir à items' });
  }
});
export type T4AgendaRepresentationOutput = z.infer<typeof T4AgendaRepresentationOutput>;

// ── Mutations (plan appliqué par le serveur, CODE-09) ───────────────────────

export type RepresentationMutation =
  /** Doublons d'une même occurrence : absorbés par `keepId` (journal 0591, preuves et liens conservés, restaurable). */
  | { kind: 'CONSOLIDATE'; keepId: number; absorbIds: number[]; reason: string }
  /** Projection technique (intacte) redondante avec l'occurrence décidée : retirée (trace restaurable). */
  | { kind: 'REMOVE_PROJECTION'; itemId: number; keepId: number; reason: string }
  /** Rattachement / rôle dans l'Opération (service de regroupement, origine T4). */
  | { kind: 'ATTACH'; itemId: number; role: 'PRINCIPAL' | 'RELATED'; reason: string }
  /** Élément indépendant détaché de l'Opération (jamais un rattachement de l'utilisateur). */
  | { kind: 'DETACH'; itemId: number; reason: string }
  /** Occurrence absorbée à tort : restaurée depuis le journal 0591, puis rattachée. */
  | { kind: 'RESTORE'; journalId: number; absorbedItemId: number; role: 'PRINCIPAL' | 'RELATED' | null; reason: string };

export interface RefusedMutation { mutation: RepresentationMutation | { kind: string; ref?: string }; reason: string }

/** Motifs de refus (validation, protection, application) — stables, journalisés. */
export const VALIDATION_ISSUES = [
  'SCHEMA', 'UNKNOWN_REFERENCE', 'OUT_OF_SCOPE_REFERENCE', 'ITEM_IN_SEVERAL_OCCURRENCES', 'ITEM_NOT_DECIDED',
  'RESTORATION_REPEATED', 'SEVERAL_PRINCIPALS', 'KEEP_NOT_IN_ITEMS', 'ABSTAIN_WITH_DECISIONS',
  /** La décision modifierait un objet protégé (correction de l'utilisateur, autre Opération…) : refusée en bloc. */
  'PROTECTED_OBJECT',
  /** Une garde a écarté une mutation au moment de l'appliquer (état changé) : transaction annulée. */
  'STATE_CHANGED',
] as const;
export type ValidationIssue = (typeof VALIDATION_ISSUES)[number];

export const PROTECTION_REASONS = [
  'NOT_CERTAIN', 'USER_TOUCHED', 'USER_DETACHED', 'USER_DETACHED_LINK', 'USER_ATTACHED', 'USER_PRINCIPAL', 'PRINCIPAL_WITHDRAWN', 'LINKED_ELSEWHERE',
  'PENDING_USER_STATUS', 'RESTORED_BY_USER', 'NOT_RESTORABLE', 'PROJECTION_TOUCHED', 'KEEP_NOT_ABSORBABLE', 'STATE_CHANGED', 'APPLY_FAILED',
] as const;
export type ProtectionReason = (typeof PROTECTION_REASONS)[number];
