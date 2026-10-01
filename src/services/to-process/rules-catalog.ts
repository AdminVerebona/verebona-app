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
}

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
    question: 'À quel bien ce document se rapporte-t-il ?',
    businessImpact: 75,
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
  },
] as const;

import { resolveAlias } from '@/services/canonical/registry';

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
  }

  return problems;
}
