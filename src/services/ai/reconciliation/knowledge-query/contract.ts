/**
 * T3 master — branche KNOWLEDGE_QUERY (lot 85F, ticket P1 « T3 doit exploiter
 * toute la connaissance T1 persistée avant de conclure qu'une information
 * manque », §5, §7, §8, §17). Partie PURE : ne dépend que de zod.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONTRAT (demande à l'équipe IA `85F-t3-comprehension-connaissance-t1`)
 *
 * Entrée : une QUESTION MÉTIER sur une donnée documentaire et un contexte T1
 * FERMÉ (faits, faits non intégrés, unités sources des documents de la même
 * réalité métier), portés par les six emplacements EXISTANTS du master T3 —
 * aucun nouvel emplacement, aucune consigne glissée dans les données
 * (CDC 15 §22.3) :
 *   FIELD            question métier, champ cible, type de valeur ;
 *   CURRENT_STATE    la donnée est inconnue (jamais une valeur protégée) ;
 *   EVIDENCES        éléments T1 (référence opaque, document, couche, nature,
 *                    libellé, valeur, texte, fiabilité, page) ;
 *   SUBJECT_CONTEXT  documents (cible et liés : même Opération, même
 *                    référence de contrat), date du jour, page de contexte ;
 *   CANDIDATES       constituants de calcul que le CODE sait exploiter
 *                    (déclarés par donnée dans `document-derivations.ts`) ;
 *   RELATION_TYPE    marqueur de branche.
 *
 * Sortie : issue (FOUND, CONSTITUENTS, CONTRADICTION, AMBIGUOUS, NOT_FOUND)
 * et constats (cible, valeur telle qu'écrite, preuves citées, extrait,
 * confiance, sens métier). Le modèle ne fait jamais foi : `validate.ts`.
 *
 * La branche est FACULTATIVE (`OPTIONAL_MASTER_TASKS`) et son texte est
 * attendu de l'équipe IA (`MASTER_TASKS_TEXT_PENDING`) : sans la section
 * « BRANCHE TASK = KNOWLEDGE_QUERY » dans la version active du prompt T3,
 * aucun appel n'est fait (« interprétation en attente »).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { z } from 'zod';

export const KNOWLEDGE_QUERY_OPERATION = 't3_knowledge_query';
export const KNOWLEDGE_QUERY_TASK = 'KNOWLEDGE_QUERY';
/** Version du contrat d'entrée (dans FIELD) : entre dans l'empreinte de la question. */
export const KNOWLEDGE_QUERY_CONTRACT_VERSION = 't3-knowledge-query-v1';
/** Référence de la demande à l'équipe IA (constats du contrôle de cohérence). */
export const KNOWLEDGE_QUERY_PENDING_CONTRACT = '85F-t3-comprehension-connaissance-t1';

/** Cible d'un constat : la donnée elle-même, ou un rôle de constituant de calcul. */
export const FIELD_TARGET = 'FIELD';

/**
 * Rôles de constituants et type de valeur attendu. Les rôles sont les
 * propriétés des déclarations de calcul EXISTANTES (`DerivationSpec`,
 * `ScheduleSpec`) : le code sait les exploiter, il ne reconnaît aucun mot.
 */
export const CONSTITUENT_VALUE_TYPES = {
  start: 'date',
  duration: 'duration',
  firstInstalment: 'date',
  lastInstalment: 'date',
  count: 'count',
  periodicity: 'periodicity',
  disbursement: 'date',
  repayment: 'indicator',
} as const;
export type ConstituentRole = keyof typeof CONSTITUENT_VALUE_TYPES;
export type ConstituentValueType = (typeof CONSTITUENT_VALUE_TYPES)[ConstituentRole];

export type FieldValueType = 'date' | 'text' | 'number';

const confidence = z.enum(['certain', 'probable', 'conflictual']);
export type KnowledgeConfidence = z.infer<typeof confidence>;

const KNOWLEDGE_QUERY_OUTCOMES = ['FOUND', 'CONSTITUENTS', 'CONTRADICTION', 'AMBIGUOUS', 'NOT_FOUND'] as const;

export const t3KnowledgeFinding = z.object({
  target: z.string().min(1).max(40),
  rawValue: z.string().min(1).max(200),
  value: z.union([z.string().max(200), z.number()]).nullable().optional(),
  evidenceRefs: z.array(z.string().min(1).max(40)).min(1).max(5),
  excerpt: z.string().min(1).max(400),
  confidence,
  meaning: z.string().min(1).max(200),
});
export type T3KnowledgeFinding = z.infer<typeof t3KnowledgeFinding>;

/** Sortie de la branche KNOWLEDGE_QUERY (schéma ; la validation métier est `validate.ts`). */
export const T3KnowledgeQueryOutput = z.object({
  task: z.literal('KNOWLEDGE_QUERY'),
  outcome: z.enum(KNOWLEDGE_QUERY_OUTCOMES),
  findings: z.array(t3KnowledgeFinding).max(12).optional().default([]),
  reason: z.string().min(1).max(400),
}).superRefine((v, ctx) => {
  const f = v.findings ?? [];
  const champ = f.filter((x) => x.target === FIELD_TARGET);
  if (v.outcome === 'FOUND' && champ.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['findings'], message: 'FOUND : au moins un constat de cible FIELD' });
  }
  if (v.outcome === 'CONSTITUENTS' && (f.length === 0 || champ.length > 0)) {
    ctx.addIssue({ code: 'custom', path: ['findings'], message: 'CONSTITUENTS : au moins un constituant, aucune cible FIELD' });
  }
  if (v.outcome === 'CONTRADICTION') {
    const parCible = new Map<string, Set<string>>();
    for (const x of f) (parCible.get(x.target) ?? parCible.set(x.target, new Set()).get(x.target)!).add(x.rawValue);
    if (![...parCible.values()].some((s) => s.size >= 2)) {
      ctx.addIssue({ code: 'custom', path: ['findings'], message: 'CONTRADICTION : deux valeurs différentes pour une même cible' });
    }
  }
  if (v.outcome === 'NOT_FOUND' && f.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['findings'], message: 'NOT_FOUND : aucun constat' });
  }
});
export type T3KnowledgeQueryOutput = z.infer<typeof T3KnowledgeQueryOutput>;

// ── Entrée ──────────────────────────────────────────────────────────────────

/** Couche T1 d'un élément de contexte. */
export type KnowledgeLayer = 'FACT' | 'UNRESOLVED_FACT' | 'SOURCE_UNIT';

/** Élément de connaissance T1 transmis (borné, traçable). */
export interface KnowledgeElement {
  /** Référence opaque et stable (`U-<id>`, `F-<id>`, `N-<id>`). */
  ref: string;
  /** Document (référence de `SUBJECT_CONTEXT.documents`). */
  document: string;
  fileId: number;
  layer: KnowledgeLayer;
  /** Nature de l'unité (TEXT_BLOCK…) ou clé lue du fait. */
  kind: string;
  label: string | null;
  value: string | null;
  text: string | null;
  confidence: KnowledgeConfidence;
  page: number | null;
  /** Unité couverte (COVERED) — diagnostic d'une unité partiellement structurée. */
  covered?: boolean;
  /** Unités sources d'un fait (provenance). */
  sourceUnitIds?: string[];
  /** Identifiant d'unité dans le document (`source_unit_id`). */
  sourceUnitId?: string | null;
}

export interface KnowledgeDocument {
  ref: string;
  fileId: number;
  role: 'TARGET' | 'LINKED';
  relation: 'SAME_OPERATION' | 'SAME_CONTRACT_REFERENCE' | null;
  title: string | null;
  documentType: string | null;
}

export interface KnowledgeConstituent {
  role: ConstituentRole;
  key: string;
  label: string | null;
  valueType: ConstituentValueType;
}

export interface KnowledgeQuestion {
  key: string;
  label: string | null;
  valueType: FieldValueType;
  businessQuestion: string;
  ruleCode: string;
  constituents: KnowledgeConstituent[];
}

export interface KnowledgePage {
  index: number;
  count: number;
  elements: KnowledgeElement[];
}

/** Variables du master T3 pour UNE page de contexte (pure, déterministe). */
export function knowledgeQueryVariables(p: {
  question: KnowledgeQuestion; documents: KnowledgeDocument[]; page: KnowledgePage; today: string;
}): Record<string, unknown> {
  return {
    FIELD: {
      contractVersion: KNOWLEDGE_QUERY_CONTRACT_VERSION, key: p.question.key, label: p.question.label, valueType: p.question.valueType,
      businessQuestion: p.question.businessQuestion, ruleCode: p.question.ruleCode,
    },
    CURRENT_STATE: { value: null, protectedByUser: false },
    EVIDENCES: p.page.elements.map((e) => ({
      ref: e.ref, document: e.document, layer: e.layer, kind: e.kind, label: e.label, value: e.value, text: e.text, confidence: e.confidence, page: e.page,
    })),
    SUBJECT_CONTEXT: {
      today: p.today, closedWorld: true,
      documents: p.documents.map((d) => ({ ref: d.ref, role: d.role, relation: d.relation, title: d.title, documentType: d.documentType })),
      page: { index: p.page.index, count: p.page.count },
    },
    CANDIDATES: p.question.constituents.map((c) => ({ role: c.role, key: c.key, label: c.label, valueType: c.valueType })),
    RELATION_TYPE: KNOWLEDGE_QUERY_TASK,
  };
}
