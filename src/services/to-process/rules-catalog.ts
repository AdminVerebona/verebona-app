/**
 * Catalogue initial des règles de traitement — CDC V2.0 §10.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PAS D'ACTION SANS RÈGLE
 *
 * Le principe P-06 est la contrainte la plus structurante de ce fichier :
 * « L'absence d'un champ optionnel ne génère pas automatiquement une action.
 * Une règle métier explicite doit justifier "À compléter". »
 *
 * Conséquence : ce catalogue n'est pas une liste indicative, c'est la
 * condition d'existence des actions de complétion. Un champ absent du
 * catalogue ne remplira jamais « À traiter », quel que soit son état. C'est
 * exactement ce qui empêche la file de se remplir de champs descriptifs que
 * personne ne renseignera jamais (§10.5, dernier alinéa).
 *
 * ── LA PRIORITÉ EST PORTÉE PAR LA RÈGLE, PAS PAR LA NATURE ────────────────
 *
 * §9.2 : « La priorité est définie par type de problème précis, et non par
 * nature d'action À arbitrer / À compléter. » Chaque règle porte donc ses
 * propres priorités, et une même règle peut en donner deux différentes selon
 * qu'elle produit un arbitrage ou une complétion (DOC-RUB-02 vs DOC-RUB-03).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { ActionKind, ActionPriority, TargetType } from './action-model';

/**
 * ══════════════════════════════════════════════════════════════════════════
 * LE CATALOGUE PILOTE, IL NE DÉCRIT PAS (lot 28, ticket P0)
 *
 * Constat du ticket : l'existence d'une règle ici ne garantissait pas qu'elle
 * soit déclenchée — LINK-ASSET, DATA-CONTRACT-END, DATA-WARRANTY-END et
 * DATA-SUPPLIER n'avaient aucun producteur. Chaque règle déclare donc
 * désormais son PRODUCTEUR (`producer`), et le contrôle du catalogue
 * (`checkRulesCatalog`, test `rules-catalog-producteurs.test.ts`) vérifie que
 * le module existe et que son point d'entrée est réellement appelé.
 *
 * Les producteurs GÉNÉRIQUES lisent ce catalogue au lieu de coder une règle :
 *   · DOCUMENT_BRIDGE        — `document-rule-bridge.ts` : toute règle
 *                              `targetType: 'DOCUMENT'` qui le déclare est
 *                              évaluée après chaque analyse, après chaque
 *                              correction de l'utilisateur et par le
 *                              balayage horaire. Ajouter une donnée
 *                              documentaire = ajouter une ligne ici ;
 *   · CLASSIFICATION         — Rubrique / Type (`decide()`, §10.2) ;
 *   · RECONCILIATION_BRIDGE  — données de BIEN décidées par T3.
 * Les autres sont des producteurs métier dédiés, câblés à leur moteur.
 * ══════════════════════════════════════════════════════════════════════════
 */
export type RuleProducer =
  | 'DOCUMENT_BRIDGE'
  | 'CLASSIFICATION'
  | 'RECONCILIATION_BRIDGE'
  | 'STATE_SCAN'
  | 'T3_EQUIPMENT_LINK'
  | 'T3_ENTITY_FIELDS'
  | 'T4_AGENDA_DUPLICATE'
  | 'T4_STATUS'
  | 'T4_PROPOSAL'
  | 'MIGRATION_REVIEW';

/** Où vit chaque producteur, et par quelle(s) fonction(s) il est appelé. */
export const RULE_PRODUCERS: Readonly<Record<RuleProducer, {
  module: string;
  /** Points d'entrée qui DOIVENT être appelés hors de leur module (contrôlé). */
  entries: readonly string[];
  /** Vrai : le producteur lit le catalogue, aucune règle n'y est codée. */
  generic: boolean;
}>> = {
  DOCUMENT_BRIDGE: { module: 'src/services/to-process/document-rule-bridge.ts', entries: ['syncDocumentRulesFromAnalysis', 'syncDocumentRulesFromState'], generic: true },
  CLASSIFICATION: { module: 'src/services/documents/apply-v2-classification.service.ts', entries: ['applyV2Classification'], generic: true },
  RECONCILIATION_BRIDGE: { module: 'src/services/to-process/reconciliation-bridge.ts', entries: ['syncReconciliationToProcess'], generic: true },
  STATE_SCAN: { module: 'src/services/to-process/producers.service.ts', entries: ['produceAccountActions'], generic: false },
  T3_EQUIPMENT_LINK: { module: 'src/services/to-process/document-equipment-link.ts', entries: ['proposeDocumentEquipmentLink'], generic: false },
  T3_ENTITY_FIELDS: { module: 'src/services/to-process/entity-field-cards.ts', entries: ['syncEntityFieldCards'], generic: false },
  T4_AGENDA_DUPLICATE: { module: 'src/services/agenda/agenda-persistence.ts', entries: ['createDuplicateArbitration'], generic: false },
  T4_STATUS: { module: 'src/services/to-process/agenda-status-cards.ts', entries: ['proposeAgendaStatus', 'proposeAssetStatusChange'], generic: false },
  T4_PROPOSAL: { module: 'src/services/to-process/agenda-proposal-cards.ts', entries: ['proposeAgendaCreation'], generic: false },
  MIGRATION_REVIEW: { module: 'src/services/to-process/migration-review-cards.ts', entries: ['upsertMigrationReviewCard'], generic: false },
};

export interface ProcessingRule {
  /** Code stable, tracé sur chaque action (§13.3). */
  code: string;
  targetType: TargetType;
  /** Donnée visée. Exclusif avec `relationKey`. */
  fieldKey?: string;
  /** Relation visée. Exclusif avec `fieldKey`. */
  relationKey?: string;
  /** Priorité appliquée quand la règle produit un arbitrage. */
  arbitratePriority: ActionPriority;
  /**
   * Priorité appliquée quand la règle produit une complétion.
   * `null` = la règle ne justifie jamais de complétion (§10.4, LINK-ELT-03).
   */
  completePriority: ActionPriority | null;
  /**
   * §10.6 — faux par défaut. N'est activé que lorsque l'absence de la donnée
   * peut légitimement constituer un état final.
   */
  allowNotApplicable: boolean;
  /** Question affichée en élément dominant de la carte (§8.4). */
  question: string;
  /**
   * Seuil temporel de promotion, en jours avant échéance (§9.2).
   * Au franchissement, l'action devient candidate à « À faire d'abord ».
   */
  dueSoonDays?: number;
  /**
   * Impact métier intrinsèque, 0 → 100. Premier critère de départage pour les
   * dix places « À faire d'abord » (§9.4). Il n'est jamais affiché.
   */
  businessImpact: number;
  /** Traitement qui crée, met à jour et ferme les actions de la règle (lot 28). */
  producer: RuleProducer;
  /**
   * Pertinence métier pour un DOCUMENT (lot 28) : Types documentaires V2
   * pour lesquels la donnée est attendue. Hors de ces Types (et sans valeur
   * saisie par l'utilisateur), la règle n'ouvre AUCUNE action : une valeur
   * fiable est écrite en silence, une absence ou une hésitation n'est pas un
   * problème. Absent = la règle vaut pour tout document.
   */
  relevantDocumentTypes?: readonly string[];
  /**
   * Relation « au moins un » (lot 28) : n'importe quelle valeur déjà présente
   * satisfait la règle (un document rattaché à un bien n'appelle plus de
   * question, même si l'analyse en cite un autre). Défaut : `one`.
   */
  cardinality?: 'one' | 'atLeastOne';
}

/** Types de contrats dont la date de fin est attendue (DATA-CONTRACT-END). */
export const CONTRACT_END_DOCUMENT_TYPES = [
  'SERVICE_CONTRACT',
  'SUBSCRIPTION_CONTRACT',
  'MAINTENANCE_CONTRACT',
  'FINANCING_CONTRACT',
  'LEASING_FINANCING_CONTRACT',
] as const;

/** Types de garanties dont la date de fin est attendue (DATA-WARRANTY-END). */
export const WARRANTY_END_DOCUMENT_TYPES = ['WARRANTY_CERTIFICATE', 'EXTENDED_WARRANTY'] as const;

export const PROCESSING_RULES: readonly ProcessingRule[] = [
  // ── §10.2 Documents — Rubrique et Type ──────────────────────────────────
  {
    code: 'DOC-RUB',
    targetType: 'DOCUMENT',
    fieldKey: 'rubricCode',
    arbitratePriority: 'DO_NEXT',
    completePriority: 'DO_NEXT',
    allowNotApplicable: false, // §10.6 : la Rubrique n'est jamais « Non applicable ».
    question: 'Dans quelle rubrique classer ce document ?',
    businessImpact: 70,
    producer: 'CLASSIFICATION',
  },
  {
    code: 'DOC-TYP',
    targetType: 'DOCUMENT',
    fieldKey: 'documentTypeCode',
    // §10.2, DOC-TYP-02 et DOC-TYP-03 : « Peut attendre » dans les deux cas.
    arbitratePriority: 'CAN_WAIT',
    completePriority: 'CAN_WAIT',
    // §10.6 : le Type dispose de « Autre » et n'utilise donc pas « Non applicable ».
    allowNotApplicable: false,
    question: 'Quel est le type de ce document ?',
    businessImpact: 20,
    producer: 'CLASSIFICATION',
  },

  // ── §10.3 Rattachement à un bien ────────────────────────────────────────
  {
    code: 'LINK-ASSET',
    targetType: 'DOCUMENT',
    relationKey: 'assetIds',
    arbitratePriority: 'DO_NEXT',
    completePriority: 'DO_NEXT',
    // §2.3 : « L'absence de rattachement à un bien n'est jamais considérée
    // comme normale. » Aucun état final sans bien.
    allowNotApplicable: false,
    // Lot 31B (ticket T3, §8) : posée seulement après l'abstention de T3
    // DOCUMENT_ASSET, avec ses candidats.
    question: 'À quel bien rattacher ce document ?',
    businessImpact: 75,
    producer: 'DOCUMENT_BRIDGE',
    cardinality: 'atLeastOne',
  },

  // ── §10.4 Rattachement secondaire ───────────────────────────────────────
  {
    code: 'LINK-ELT',
    targetType: 'DOCUMENT',
    relationKey: 'elementId',
    arbitratePriority: 'CAN_WAIT',
    // LINK-ELT-03 : « Aucune action : rattachement secondaire facultatif. »
    completePriority: null,
    allowNotApplicable: true,
    question: 'À quelle pièce ou quel équipement rattacher ce document ?',
    businessImpact: 10,
    producer: 'T3_EQUIPMENT_LINK',
  },

  // ── §10.5 Données métier ────────────────────────────────────────────────
  {
    code: 'DATA-CONTRACT-END',
    targetType: 'DOCUMENT',
    fieldKey: 'contractEndDate',
    arbitratePriority: 'DO_NEXT',
    completePriority: 'DO_NEXT',
    allowNotApplicable: true,
    question: "Quelle est la date de fin de ce contrat ?",
    dueSoonDays: 30,
    businessImpact: 80,
    producer: 'DOCUMENT_BRIDGE',
    relevantDocumentTypes: CONTRACT_END_DOCUMENT_TYPES,
  },
  {
    code: 'DATA-WARRANTY-END',
    targetType: 'DOCUMENT',
    fieldKey: 'warrantyEndDate',
    arbitratePriority: 'DO_NEXT',
    completePriority: 'DO_NEXT',
    allowNotApplicable: true,
    question: 'Jusqu’à quand court cette garantie ?',
    dueSoonDays: 30,
    businessImpact: 65,
    producer: 'DOCUMENT_BRIDGE',
    relevantDocumentTypes: WARRANTY_END_DOCUMENT_TYPES,
  },
  {
    code: 'DATA-AGENDA-DATE',
    targetType: 'AGENDA_ITEM',
    fieldKey: 'date',
    arbitratePriority: 'DO_NEXT',
    completePriority: 'DO_NEXT',
    // §10.5 : un événement qui nécessite une date en a besoin ; pas d'état
    // final sans elle.
    allowNotApplicable: false,
    question: 'À quelle date cet événement a-t-il lieu ?',
    dueSoonDays: 14,
    businessImpact: 85,
    producer: 'STATE_SCAN',
  },
  {
    // Rapprochement d'échéances incertain (T4) : « même échéance » ou
    // « échéances différentes ». Relation propre à chaque couple événement
    // existant + échéance détectée (relationKey `duplicate:…`).
    code: 'AGENDA-DUPLICATE',
    targetType: 'AGENDA_ITEM',
    relationKey: 'duplicate',
    arbitratePriority: 'DO_NEXT',
    completePriority: null,
    allowNotApplicable: false,
    question: 'S’agit-il de la même échéance ?',
    dueSoonDays: 14,
    businessImpact: 75,
    producer: 'T4_AGENDA_DUPLICATE',
  },
  {
    code: 'DATA-REGISTRATION',
    targetType: 'ASSET',
    fieldKey: 'registrationNumber',
    arbitratePriority: 'DO_NEXT',
    completePriority: 'DO_NEXT',
    allowNotApplicable: true,
    question: 'Quel est le numéro d’immatriculation de ce bien ?',
    businessImpact: 60,
    producer: 'RECONCILIATION_BRIDGE',
  },
  {
    code: 'DATA-ACQUISITION-PRICE',
    targetType: 'ASSET',
    // CDC 15 X-03 : clé CANONIQUE du registre (T3 travaille en
    // `acquisitionPrice`, euros) — l'ancienne clé `purchasePriceCents` n'en
    // est plus qu'un alias, résolu par `findRule`.
    fieldKey: 'acquisitionPrice',
    arbitratePriority: 'DO_NEXT',
    // §10.5 : « absence seule ne déclenche pas systématiquement une action ».
    completePriority: null,
    allowNotApplicable: true,
    question: 'Quel est le prix d’acquisition de ce bien ?',
    businessImpact: 40,
    producer: 'RECONCILIATION_BRIDGE',
  },
  {
    code: 'DATA-SUPPLIER',
    targetType: 'DOCUMENT',
    fieldKey: 'supplier',
    arbitratePriority: 'CAN_WAIT',
    // §10.5 : « Absence seule : aucune action ; arbitrage si proposition
    // utile ou contradiction. »
    completePriority: null,
    allowNotApplicable: true,
    question: 'Quel fournisseur a émis ce document ?',
    businessImpact: 15,
    producer: 'DOCUMENT_BRIDGE',
  },

  // ── §10.3 Rattachement d'un équipement à un bien ────────────────────────
  {
    code: 'LINK-EQUIP-ASSET',
    targetType: 'EQUIPMENT',
    relationKey: 'assetId',
    arbitratePriority: 'DO_NEXT',
    completePriority: 'DO_NEXT',
    // Même raison qu'un document : un équipement rattaché à rien est
    // introuvable dans le parc, et l'absence n'est jamais un état normal.
    allowNotApplicable: false,
    question: 'À quel bien cet équipement appartient-il ?',
    businessImpact: 70,
    producer: 'STATE_SCAN',
  },

  // ── §10.5 Identité d'un fournisseur ─────────────────────────────────────
  {
    code: 'SUPPLIER-IDENTITY',
    targetType: 'SUPPLIER',
    fieldKey: 'identity',
    arbitratePriority: 'DO_NEXT',
    // Un fournisseur détecté sans candidat connu n'appelle pas de saisie :
    // la fiche se créera à la confirmation. Sans règle de complétion, aucune
    // carte ne réclame un champ que personne ne remplirait (P-06).
    completePriority: null,
    allowNotApplicable: true,
    question: 'S’agit-il du même fournisseur ?',
    businessImpact: 45,
    producer: 'STATE_SCAN',
  },
  // L'ancienne règle ASSET-RENTED (« Bien mis en location ») est retirée avec
  // l'attribut : l'usage « Mis en location » de la fiche porte seul l'information.

  // ── CDC 15 T4-12 (lot 14) : statut d'une échéance ───────────────────────
  // Verdicts de `reconcileStatus()` qui ne s'écrivent jamais seuls : une
  // réalisation probable, ou une non-réalisation (jamais écrite
  // automatiquement). Voir `agenda-status-cards.ts`.
  {
    code: 'AGENDA-DONE',
    targetType: 'AGENDA_ITEM',
    fieldKey: 'manualStatus',
    arbitratePriority: 'DO_NEXT',
    completePriority: null,
    allowNotApplicable: true,
    question: 'Cette échéance a-t-elle été réalisée ?',
    businessImpact: 55,
    producer: 'T4_STATUS',
  },
  {
    code: 'AGENDA-NOT-DONE',
    targetType: 'AGENDA_ITEM',
    fieldKey: 'manualStatus',
    arbitratePriority: 'DO_NEXT',
    completePriority: null,
    allowNotApplicable: true,
    question: 'Cette échéance semble ne pas avoir été réalisée : qu’en est-il ?',
    businessImpact: 60,
    producer: 'T4_STATUS',
  },

  // ── CDC 15 T4-04 (lot 14) : échéance d'une source non autoritaire ───────
  // Devis, document de type inconnu : l'échéance lue est PROPOSÉE, jamais
  // créée d'office. Une carte par échéance de la source (relation
  // `agenda:<clé>`). Voir `agenda-proposal-cards.ts`.
  {
    code: 'AGENDA-PROPOSAL',
    targetType: 'DOCUMENT',
    relationKey: 'agenda',
    arbitratePriority: 'CAN_WAIT',
    completePriority: null,
    allowNotApplicable: true,
    question: 'Ajouter cette échéance à l’agenda ?',
    businessImpact: 35,
    producer: 'T4_PROPOSAL',
  },

  // ── CDC 15 §14, MIG-09 (lot 17) : cas ambigus des rattrapages de données ─
  // Valeur de bien à choisir (alias en conflit, montant ×100 non prouvé,
  // colonne historique ≠ fiche). Une carte par champ : la carte porte la clé
  // canonique en `field_key` (fermée par la saisie de la valeur) ; la
  // relation ci-dessous ne sert qu'au contrôle du catalogue.
  // Voir `migration-review-cards.ts`.
  {
    code: 'MIG-REVIEW',
    targetType: 'ASSET',
    relationKey: 'migration',
    arbitratePriority: 'CAN_WAIT',
    completePriority: null,
    allowNotApplicable: true,
    question: 'Quelle valeur garder pour ce champ ?',
    businessImpact: 30,
    producer: 'MIGRATION_REVIEW',
  },

  // ── CDC 15 T1-04 (lot 18, R3) : conflit sur un champ d'ÉQUIPEMENT ───────
  // Deux preuves (ou une preuve et une saisie) divergent sur un champ de la
  // fiche canonique d'un équipement. Même mécanisme que le conflit de champ
  // d'un bien (ARBITRATE, propositions + valeur en place) ; la carte porte la
  // clé canonique en `field_key`, la relation ne sert qu'au contrôle du
  // catalogue. Voir `entity-field-cards.ts`.
  {
    code: 'ENTITY-FIELD',
    targetType: 'EQUIPMENT',
    relationKey: 'canonicalField',
    arbitratePriority: 'CAN_WAIT',
    completePriority: null,
    allowNotApplicable: true,
    question: 'Quelle valeur garder pour ce champ de l’équipement ?',
    businessImpact: 35,
    producer: 'T3_ENTITY_FIELDS',
  },
  // Même conflit sur une PIÈCE (lot 19) — `roomArea` aujourd'hui. Code
  // distinct (un code par règle et par type de cible), même mécanisme.
  {
    code: 'ENTITY-FIELD-ROOM',
    targetType: 'ROOM',
    relationKey: 'canonicalField',
    arbitratePriority: 'CAN_WAIT',
    completePriority: null,
    allowNotApplicable: true,
    question: 'Quelle valeur garder pour ce champ de la pièce ?',
    businessImpact: 30,
    producer: 'T3_ENTITY_FIELDS',
  },

  // ── CDC 15 D-15 (lot 14) : statut du bien après vente ou sinistre ───────
  // Un événement historique ne change jamais le statut : il le propose.
  {
    code: 'ASSET-STATUS',
    targetType: 'ASSET',
    fieldKey: 'status',
    arbitratePriority: 'DO_NEXT',
    completePriority: null,
    allowNotApplicable: true,
    question: 'Le statut de ce bien a-t-il changé ?',
    businessImpact: 50,
    producer: 'T4_STATUS',
  },
] as const;

import { resolveAlias } from '@/services/canonical/registry';
import { getDocumentType } from '@/lib/referential/v2';

const RULE_BY_CODE = new Map<string, ProcessingRule>(
  PROCESSING_RULES.map((r) => [r.code, r]),
);

export function getRule(code: string): ProcessingRule | undefined {
  return RULE_BY_CODE.get(code);
}

/**
 * Règle couvrant une donnée ou une relation donnée.
 *
 * CDC 15 X-03 : pour une donnée de BIEN, la clé est d'abord ramenée à sa clé
 * canonique du registre (`purchasePriceCents`, `prixAchat` →
 * `acquisitionPrice`) — les règles « À traiter » et T3 parlent la même
 * langue, et un alias ne crée jamais une seconde carte.
 */
export function findRule(
  targetType: TargetType,
  key: string,
): ProcessingRule | undefined {
  const cle = targetType === 'ASSET' ? canonicalAssetKey(key) : key;
  return PROCESSING_RULES.find(
    (r) => r.targetType === targetType && (r.fieldKey === cle || r.relationKey === cle || r.fieldKey === key),
  );
}

/** Clé canonique d'une donnée de bien (alias résolu), sinon la clé telle quelle. */
export function canonicalAssetKey(key: string): string {
  return resolveAlias(key) ?? key;
}

/**
 * La donnée peut-elle générer une action de complétion ?
 *
 * P-06 et §10.5 : sans règle, ou avec une règle dont `completePriority` est
 * `null`, l'absence de valeur reste un état acceptable.
 */
export function allowsCompletion(targetType: TargetType, key: string): boolean {
  return findRule(targetType, key)?.completePriority != null;
}

export function priorityForRule(rule: ProcessingRule, kind: ActionKind): ActionPriority {
  if (kind === 'ARBITRATE') return rule.arbitratePriority;
  return rule.completePriority ?? 'DO_NEXT';
}

/** Contrôle d'intégrité du catalogue, exécuté par les tests et la CI. */
export function checkRulesCatalog(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const rule of PROCESSING_RULES) {
    if (seen.has(rule.code)) problems.push(`Règle déclarée deux fois : ${rule.code}.`);
    seen.add(rule.code);

    const hasField = !!rule.fieldKey;
    const hasRelation = !!rule.relationKey;
    if (hasField === hasRelation) {
      problems.push(
        `Règle ${rule.code} : exactement l'un de fieldKey / relationKey doit être ` +
          'renseigné — la clé d’unicité du §7.3 en dépend.',
      );
    }
    if (rule.businessImpact < 0 || rule.businessImpact > 100) {
      problems.push(`Règle ${rule.code} : businessImpact hors de 0–100.`);
    }
    if (!RULE_PRODUCERS[rule.producer]) {
      problems.push(`Règle ${rule.code} : producteur inconnu (${String(rule.producer)}).`);
    }
    if (rule.producer === 'DOCUMENT_BRIDGE' && rule.targetType !== 'DOCUMENT') {
      problems.push(`Règle ${rule.code} : le pont documentaire ne traite que des DOCUMENT.`);
    }
    if (rule.relevantDocumentTypes && rule.targetType !== 'DOCUMENT') {
      problems.push(`Règle ${rule.code} : relevantDocumentTypes n'a de sens que pour un DOCUMENT.`);
    }
    if (rule.relevantDocumentTypes?.some((code) => !getDocumentType(code))) {
      problems.push(`Règle ${rule.code} : Type documentaire hors référentiel dans relevantDocumentTypes.`);
    }
    if (rule.cardinality === 'atLeastOne' && !rule.relationKey) {
      problems.push(`Règle ${rule.code} : cardinality « atLeastOne » réservée aux relations.`);
    }
  }

  return problems;
}

/** Donnée (champ ou relation) visée par une règle. */
export function ruleDataKey(rule: ProcessingRule): string {
  return (rule.fieldKey ?? rule.relationKey)!;
}

/** Règles produites par le pont documentaire générique (lot 28). */
export function documentBridgeRules(): ProcessingRule[] {
  return PROCESSING_RULES.filter((r) => r.producer === 'DOCUMENT_BRIDGE' && r.targetType === 'DOCUMENT');
}

/**
 * La donnée est-elle attendue pour ce document ? (pertinence métier, lot 28)
 *
 * Sans `relevantDocumentTypes`, toujours. Sinon, seulement pour les Types
 * listés — un document de Type encore inconnu n'est pas présumé concerné :
 * c'est DOC-TYP qui le fera classer, et la règle sera réévaluée ensuite.
 */
export function isRuleRelevantForDocument(rule: ProcessingRule, documentTypeCode: string | null | undefined): boolean {
  if (!rule.relevantDocumentTypes) return true;
  return !!documentTypeCode && rule.relevantDocumentTypes.includes(documentTypeCode);
}
