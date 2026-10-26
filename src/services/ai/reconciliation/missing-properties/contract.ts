/**
 * Lot 88B — propriétés métier MANQUANTES reconstruites à partir de
 * l'ensemble des preuves (ticket P1 « Contrôle de cohérence — Détecter et
 * réparer les propriétés métier manquantes »). Partie PURE : constantes du
 * contrat, éléments de contexte, variables du master T3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONTRAT T3 RÉUTILISÉ : branche KNOWLEDGE_QUERY (lot 85F), opération
 * `t3_knowledge_query`, MÊME schéma de sortie (`T3KnowledgeQueryOutput`,
 * aucun nouveau contrat de sortie ni nouvel emplacement du master).
 *
 * Seule l'ENTRÉE évolue (`contractVersion` = `t3-knowledge-query-v2`,
 * portée par `{{FIELD}}`) :
 *   · v1 (85F, inchangée) : UNE donnée d'UN document ;
 *   · v2 (88B) : les propriétés canoniques VIDES d'un OBJET métier (bien,
 *     équipement), listées dans `{{CANDIDATES}}` (rôle = clé du registre),
 *     avec un contexte TRANSVERSAL fermé (faits, preuves de champ — champs
 *     voisins compris —, unités, métadonnées documentaires, Opérations et
 *     composantes économiques, Agenda, valeurs canoniques existantes,
 *     décisions de réconciliation). Sortie : `findings[].target` = clé de la
 *     propriété ; `confidence: certain` = valeur ÉTABLIE (suffisante pour
 *     écrire) ; `probable` / `conflictual` = abstention.
 *
 * La v2 n'est utilisée QUE si la version ACTIVE du prompt T3 porte le
 * marqueur `t3-knowledge-query-v2` (section de la branche KNOWLEDGE_QUERY
 * livrée par l'équipe IA, demande `88B-t3-proprietes-manquantes`) : sinon
 * aucun appel, constat « arbitrage en attente du contrat IA ». Claude ne
 * modifie aucun prompt.
 *
 * Aucune règle métier ici (ni ailleurs dans le chantier) : le code ne sait
 * pas ce qu'est un prix d'achat ou un compromis ; il collecte, borne,
 * transmet, VALIDE (monde fermé, extrait recopié, valeur normalisable par le
 * registre) et écrit par le writer canonique.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { KnowledgeConfidence } from '../knowledge-query/contract';

/** Identifiants des contrôles du registre de cohérence (lot 88B). */
export const MISSING_PROPERTIES_CHECK_ID = 'COH-MISSING-PROPERTIES';
export const MISSING_PROPERTIES_EQUIPMENT_CHECK_ID = 'COH-MISSING-PROPERTIES-EQUIPMENT';
/** Version du contrat d'ENTRÉE (dans `{{FIELD}}`), marqueur attendu dans le prompt actif. */
export const MISSING_PROPERTIES_CONTRACT_VERSION = 't3-knowledge-query-v2';
/** Mode transmis dans `{{FIELD}}` (donnée, jamais une consigne). */
const MISSING_PROPERTIES_MODE = 'MISSING_PROPERTIES';
/** Demande à l'équipe IA (constats tant que le prompt actif ne porte pas le contrat). */
export const MISSING_PROPERTIES_PENDING_CONTRACT = '88B-t3-proprietes-manquantes';
/** Règle de projection des preuves créées par une décision (exclues du contexte : jamais d'auto-alimentation). */
export const MISSING_PROPERTIES_PROJECTION_RULE = 'COH-MISSING-PROPERTIES';
export const MISSING_PROPERTIES_PROJECTION_ORIGIN = 'T3_MISSING_PROPERTY';
/** Provenance des écritures canoniques (journal 0216 `source_type`) : exclues du contexte. */
export const MISSING_PROPERTIES_SOURCE_TYPE = 'coherence_missing_property';
/** Version des règles de collecte / décision : entre dans l'empreinte de la question. */
export const MISSING_PROPERTIES_RULES_VERSION = 'l88b-v1';

export type SubjectType = 'ASSET' | 'EQUIPMENT';

/**
 * Lot 91B — état du contrat d'entrée dans le prompt T3 actif, en clair pour
 * le journal et le diagnostic (pure) : porté, marqueur absent, branche
 * KNOWLEDGE_QUERY absente, coupure d'urgence, prompt illisible.
 */
export function contractStateOf(c: { contractCarried: boolean; available: boolean; reason: string }): 'CARRIED' | 'MARKER_MISSING' | 'BRANCH_MISSING' | 'DISABLED' | 'UNREADABLE' {
  if (c.contractCarried) return 'CARRIED';
  if (c.reason === 'DISABLED') return 'DISABLED';
  if (c.reason === 'UNREADABLE') return 'UNREADABLE';
  if (!c.available) return 'BRANCH_MISSING';
  return 'MARKER_MISSING';
}

/** Couches du contexte transversal (ordre de transmission neutre et déterministe). */
export const SUBJECT_LAYERS = ['CANONICAL', 'OPERATION', 'OPERATION_COMPONENT', 'AGENDA', 'DECISION'] as const;
export const DOCUMENT_LAYERS = ['DOCUMENT_METADATA', 'FIELD_EVIDENCE', 'FACT', 'UNRESOLVED_FACT', 'SOURCE_UNIT'] as const;
export type ContextLayer = (typeof SUBJECT_LAYERS)[number] | (typeof DOCUMENT_LAYERS)[number];

/**
 * Couches d'HISTORIQUE : transmises pour information, elles n'entrent PAS
 * dans l'empreinte du contexte (une décision de réconciliation rejouée à
 * l'identique ou horodatée autrement ne justifie pas un nouvel appel T3).
 */
export const HISTORY_LAYERS: ReadonlySet<ContextLayer> = new Set(['DECISION']);

/**
 * Élément du contexte transmis (même forme que l'élément T1 de 85F, couches
 * étendues). `ref` opaque et stable : seule citation admise.
 */
export interface PropertyContextElement {
  ref: string;
  /** Document (référence de `SUBJECT_CONTEXT.documents`) ou `S` (objet lui-même). */
  document: string;
  /** Document source (`asset_files.id`), 0 hors document. */
  fileId: number;
  layer: ContextLayer;
  /** Nature (clé du fait, clé de la preuve, type d'Opération, nature de composante…). */
  kind: string;
  label: string | null;
  value: string | null;
  text: string | null;
  confidence: KnowledgeConfidence;
  page: number | null;
  /** Références liées (documents d'une Opération, Opération d'un élément d'Agenda…). */
  links?: string[];
  /** Provenance (diagnostic, provenance des preuves créées) — jamais jugée sur ses mots. */
  provenance?: ElementProvenance;
}

/** Provenance d'un élément : d'où vient-il, peut-il fonder une preuve `field_evidence` ? */
export interface ElementProvenance {
  /** Documents (`asset_files.id`) qui portent l'élément. */
  fileIds: number[];
  /** Éléments d'Agenda sources. */
  agendaItemIds: number[];
  /** Opération / composante. */
  operationId?: number | null;
  componentId?: number | null;
  /** Élément dérivé des propriétés de l'objet lui-même (fiche) : jamais une preuve indépendante. */
  derivedFromSubject?: boolean;
}

export interface PropertyContextDocument {
  ref: string;
  fileId: number;
  /** Relation à l'objet : rattachement direct, via une Opération, via l'Agenda. */
  relation: 'LINKED' | 'OPERATION' | 'AGENDA';
  title: string | null;
  documentType: string | null;
  rubric: string | null;
  documentDate: string | null;
}

/** Propriété demandée (registre canonique). */
export interface PropertyQuestion {
  key: string;
  label: string;
  valueType: 'date' | 'number' | 'text';
  /** Type du registre (money_eur, enum…), unité, valeurs admises : données, pas de consigne. */
  registryType: string;
  unit: string | null;
  enumValues: string[] | null;
}

export interface PropertyPage {
  index: number;
  count: number;
  elements: PropertyContextElement[];
}

/** Type de valeur attendu par la validation serveur (analyseurs existants). Pure. */
export function questionValueType(registryType: string): PropertyQuestion['valueType'] {
  if (registryType === 'date') return 'date';
  if (registryType === 'number' || registryType === 'money_eur' || registryType === 'money_cents') return 'number';
  return 'text';
}

/** Variables du master T3 pour UNE page de contexte (pure, déterministe) — six emplacements existants. */
export function missingPropertiesVariables(p: {
  subject: { type: SubjectType; category: string | null; subtype: string | null; family: string | null };
  properties: readonly PropertyQuestion[];
  documents: readonly PropertyContextDocument[];
  page: PropertyPage;
  today: string;
  truncated: boolean;
}): Record<string, unknown> {
  return {
    FIELD: {
      contractVersion: MISSING_PROPERTIES_CONTRACT_VERSION, mode: MISSING_PROPERTIES_MODE,
      subject: { ref: 'S', type: p.subject.type, category: p.subject.category, subtype: p.subject.subtype, family: p.subject.family },
      key: null, label: null, valueType: null,
    },
    CURRENT_STATE: { properties: p.properties.map((q) => ({ key: q.key, value: null, protectedByUser: false })) },
    EVIDENCES: p.page.elements.map((e) => ({
      ref: e.ref, document: e.document, layer: e.layer, kind: e.kind, label: e.label, value: e.value, text: e.text,
      confidence: e.confidence, page: e.page, ...(e.links?.length ? { links: e.links } : {}),
      ...(e.provenance?.derivedFromSubject ? { derivedFromSubject: true } : {}),
    })),
    SUBJECT_CONTEXT: {
      today: p.today, closedWorld: true, subject: 'S',
      documents: p.documents.map((d) => ({
        ref: d.ref, relation: d.relation, title: d.title, documentType: d.documentType, rubric: d.rubric, documentDate: d.documentDate,
      })),
      page: { index: p.page.index, count: p.page.count }, truncated: p.truncated,
    },
    CANDIDATES: p.properties.map((q) => ({
      role: q.key, key: q.key, label: q.label, valueType: q.valueType, registryType: q.registryType, unit: q.unit,
      ...(q.enumValues ? { enumValues: q.enumValues } : {}),
    })),
    RELATION_TYPE: 'KNOWLEDGE_QUERY',
  };
}
