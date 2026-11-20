/**
 * DIAGNOSTIC LISIBLE DU GRAPHE DES OPÉRATIONS (lot 116C, carte Trello #806 §4 ;
 * CDC « Opérations / Agenda V2.0 » AC73). Module PUR (aucun accès aux données) :
 * partagé par le contrôle de cohérence `COH-OPERATION-GRAPH`, la lecture du BO
 * (`graph/audit-read.ts`) et l'écran d'exploitation.
 *
 * Chaque écart rendu par `auditOperationGraph` (`graph/store.ts`, lecture
 * seule) reçoit ici : sa FAMILLE (celle de la carte #806 : lien orphelin,
 * intercomptes, réactivation d'un refus, provenance, double comptage,
 * compatibilité de la colonne historique), un LIBELLÉ d'exploitation, sa
 * GRAVITÉ et la CONDUITE À TENIR. Aucune réparation n'est proposée en
 * automatique : un écart du graphe touche une décision de l'utilisateur ou
 * l'isolation d'un compte — il se LIT, se comprend, puis se corrige par le
 * geste métier existant.
 *
 * ÉTAT D'UN COMPTE — jamais un faux « vérifié » : un compte n'est dit
 * « contrôlé » que si une PREUVE de contrôle existe (`coherence_object_proofs`),
 * avec sa date et la version de règles appliquée. Sans preuve : « jamais
 * contrôlé ». Preuve d'une version de règles antérieure : « à recontrôler ».
 */
import type { GraphFinding, GraphFindingCode, GraphFindingObject } from './store';

export const OPERATION_GRAPH_CHECK_ID = 'COH-OPERATION-GRAPH';
/** Version des règles du contrôle : la changer rend tout le stock à réexaminer. */
export const OPERATION_GRAPH_CHECK_VERSION = 1;

export type GraphFindingFamily = 'CROSS_ACCOUNT' | 'ORPHAN' | 'REFUSAL_REACTIVATED' | 'PROVENANCE' | 'DOUBLE_COUNTING' | 'LEGACY_COLUMN';

export interface GraphFindingDescription {
  family: GraphFindingFamily;
  /** BLOCKING : isolation d'un compte ou décision de l'utilisateur contournée ; WARNING : incohérence à corriger. */
  severity: 'BLOCKING' | 'WARNING';
  label: string;
  /** Conduite à tenir par l'exploitant (aucune réparation automatique). */
  action: string;
}

export const GRAPH_FAMILY_LABELS: Readonly<Record<GraphFindingFamily, string>> = {
  CROSS_ACCOUNT: 'Lien entre deux comptes',
  ORPHAN: 'Lien orphelin',
  REFUSAL_REACTIVATED: 'Décision de l’utilisateur contournée',
  PROVENANCE: 'Provenance manquante',
  DOUBLE_COUNTING: 'Risque de double comptage',
  LEGACY_COLUMN: 'Écart avec la colonne historique',
};

export const GRAPH_OBJECT_LABELS: Readonly<Record<GraphFindingObject, string>> = {
  RELATION: 'relation entre opérations', AGENDA_LINK: 'lien opération ↔ événement de l’Agenda', AGENDA_ITEM: 'événement de l’Agenda',
  OPERATION: 'opération', DOCUMENT: 'justificatif',
};

const SANS_REPARATION = 'Aucune réparation automatique.';

export const GRAPH_FINDING_DESCRIPTIONS: Readonly<Record<GraphFindingCode, GraphFindingDescription>> = {
  RELATION_CROSS_ACCOUNT: {
    family: 'CROSS_ACCOUNT', severity: 'BLOCKING',
    label: 'Relation active entre deux opérations qui ne sont pas dans le même compte.',
    action: `À traiter en priorité : vérifier qu’aucune donnée d’un compte n’est lisible depuis l’autre, puis retirer la relation. ${SANS_REPARATION}`,
  },
  AGENDA_LINK_CROSS_ACCOUNT: {
    family: 'CROSS_ACCOUNT', severity: 'BLOCKING',
    label: 'Lien actif entre une opération et un événement de l’Agenda d’un autre compte.',
    action: `À traiter en priorité : vérifier qu’aucune donnée d’un compte n’est lisible depuis l’autre, puis retirer le lien. ${SANS_REPARATION}`,
  },
  CLAIM_CONTRACT_LINK_CROSS_ACCOUNT: {
    family: 'CROSS_ACCOUNT', severity: 'BLOCKING',
    label: 'Sinistre relié à un contrat d’assurance d’un autre compte.',
    action: `À traiter en priorité : le contrat d’un autre compte ne doit jamais être consultable depuis ce sinistre. ${SANS_REPARATION}`,
  },
  RELATION_ON_MERGED_OPERATION: {
    family: 'ORPHAN', severity: 'WARNING',
    label: 'Relation active restée sur une opération fusionnée (elle aurait dû suivre l’opération conservée).',
    action: `Vérifier la fusion concernée dans le journal du graphe. ${SANS_REPARATION}`,
  },
  AGENDA_LINK_ON_MERGED_OPERATION: {
    family: 'ORPHAN', severity: 'WARNING',
    label: 'Lien d’Agenda actif resté sur une opération fusionnée.',
    action: `Vérifier la fusion concernée dans le journal du graphe. ${SANS_REPARATION}`,
  },
  CLAIM_CONTRACT_LINK_ORPHAN: {
    family: 'ORPHAN', severity: 'WARNING',
    label: 'Sinistre relié à une opération qui n’est plus un contrat d’assurance utilisable (fusionnée, ou d’un autre type).',
    action: `Faire choisir de nouveau le contrat depuis le sinistre. ${SANS_REPARATION}`,
  },
  RELATION_REFUSAL_REACTIVATED: {
    family: 'REFUSAL_REACTIVATED', severity: 'BLOCKING',
    label: 'Relation active posée par un traitement alors que la dernière décision de l’utilisateur sur cette paire est un refus.',
    action: `Le refus de l’utilisateur doit l’emporter : chercher l’écriture en cause dans le journal du graphe. ${SANS_REPARATION}`,
  },
  AGENDA_LINK_REFUSAL_REACTIVATED: {
    family: 'REFUSAL_REACTIVATED', severity: 'BLOCKING',
    label: 'Événement de l’Agenda rattaché de nouveau par un traitement à une opération dont l’utilisateur l’avait retiré.',
    action: `Le retrait décidé par l’utilisateur doit l’emporter : chercher l’écriture en cause. ${SANS_REPARATION}`,
  },
  SPLIT_PAIR_REMERGED_AUTOMATICALLY: {
    family: 'REFUSAL_REACTIVATED', severity: 'BLOCKING',
    label: 'Deux opérations séparées par l’utilisateur (scission) ont été refusionnées sans sa décision.',
    action: `Une scission ne se défait que sur décision explicite de l’utilisateur : prévenir le support, la séparation est à refaire avec lui. ${SANS_REPARATION}`,
  },
  RELATION_INFERRED_WITHOUT_EVIDENCE: {
    family: 'PROVENANCE', severity: 'WARNING',
    label: 'Relation posée par un traitement sans aucune preuve enregistrée.',
    action: `Une relation déduite doit citer ce qui la fonde : vérifier le traitement qui l’a écrite. ${SANS_REPARATION}`,
  },
  AGENDA_LINK_INFERRED_WITHOUT_EVIDENCE: {
    family: 'PROVENANCE', severity: 'WARNING',
    label: 'Lien d’Agenda supplémentaire posé par un traitement sans aucune preuve enregistrée.',
    action: `Un lien déduit doit citer ce qui le fonde : vérifier le traitement qui l’a écrit. ${SANS_REPARATION}`,
  },
  DOCUMENT_CANDIDATE_ON_TWO_OPERATIONS: {
    family: 'DOUBLE_COUNTING', severity: 'WARNING',
    label: 'Le même fait d’un même justificatif fonde deux opérations actives : ses montants peuvent être comptés deux fois.',
    action: `Comparer le coût de possession des biens concernés, puis relancer la consolidation du justificatif. ${SANS_REPARATION}`,
  },
  LEGACY_LINK_MISSING: {
    family: 'LEGACY_COLUMN', severity: 'WARNING',
    label: 'Événement de l’Agenda rattaché par la colonne historique sans lien actif dans le graphe.',
    action: `Écart de compatibilité : les écrans récents ne voient pas ce rattachement. ${SANS_REPARATION}`,
  },
  LEGACY_LINK_STALE: {
    family: 'LEGACY_COLUMN', severity: 'WARNING',
    label: 'Lien du graphe encore marqué « colonne historique » alors que la colonne ne le porte plus.',
    action: `Écart de compatibilité : les écrans anciens ne voient pas ce rattachement. ${SANS_REPARATION}`,
  },
};

/** Écarts signalés IMMÉDIATEMENT à la Supervision (sans attendre un constat persistant). */
export const GRAPH_IMMEDIATE_FINDINGS: readonly GraphFindingCode[] = (Object.keys(GRAPH_FINDING_DESCRIPTIONS) as GraphFindingCode[])
  .filter((c) => GRAPH_FINDING_DESCRIPTIONS[c].severity === 'BLOCKING');

/** État du contrôle d'un compte — fondé sur la PREUVE de contrôle, jamais sur une absence d'écart. */
export type GraphControlState =
  /** Aucune preuve de contrôle : rien ne permet de dire que le graphe de ce compte est sain. */
  | 'NEVER_CONTROLLED'
  /** Dernier contrôle fait avec une version de règles antérieure : à refaire avant de conclure. */
  | 'OUTDATED_RULES'
  /** Dernier contrôle en erreur technique : aucun verdict. */
  | 'CONTROL_FAILED'
  /** Contrôlé, aucun écart. */
  | 'CONSISTENT'
  /** Contrôlé, écarts constatés. */
  | 'FINDINGS';

export const GRAPH_CONTROL_STATE_LABELS: Readonly<Record<GraphControlState, string>> = {
  NEVER_CONTROLLED: 'Jamais contrôlé',
  OUTDATED_RULES: 'À recontrôler (règles plus récentes)',
  CONTROL_FAILED: 'Dernier contrôle en erreur',
  CONSISTENT: 'Contrôlé : aucun écart',
  FINDINGS: 'Contrôlé : écarts constatés',
};

export interface GraphControlProof {
  /** Fin du dernier contrôle (ISO), null : jamais terminé. */
  completedAt: string | null;
  result: string | null;
  rulesVersion: number;
  trigger: string | null;
  mode: string | null;
  error: string | null;
}

/** État du contrôle d'un compte à partir de sa preuve (pur). */
export function graphControlState(proof: GraphControlProof | null, rulesVersion: number = OPERATION_GRAPH_CHECK_VERSION): GraphControlState {
  if (!proof || proof.completedAt === null || proof.result === null) return 'NEVER_CONTROLLED';
  if (proof.result === 'ERROR') return 'CONTROL_FAILED';
  if (proof.rulesVersion !== rulesVersion) return 'OUTDATED_RULES';
  return proof.result === 'CONSISTENT' ? 'CONSISTENT' : 'FINDINGS';
}

export interface GraphFindingLine {
  code: GraphFindingCode;
  family: GraphFindingFamily;
  familyLabel: string;
  severity: 'BLOCKING' | 'WARNING';
  label: string;
  action: string;
  count: number;
  objectLabel: string;
  sample: number[];
}

/** Lignes lisibles du diagnostic, les plus graves d'abord (ordre stable). */
export function describeGraphFindings(findings: readonly GraphFinding[], objects: Readonly<Record<GraphFindingCode, GraphFindingObject>>): GraphFindingLine[] {
  return findings.map((f) => {
    const d = GRAPH_FINDING_DESCRIPTIONS[f.code];
    return {
      code: f.code, family: d.family, familyLabel: GRAPH_FAMILY_LABELS[d.family], severity: d.severity, label: d.label, action: d.action,
      count: f.count, objectLabel: GRAPH_OBJECT_LABELS[objects[f.code]], sample: [...f.sample],
    };
  }).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'BLOCKING' ? -1 : 1) || a.code.localeCompare(b.code));
}
