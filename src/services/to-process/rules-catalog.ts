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
    fieldKey: 'purchasePriceCents',
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
] as const;

const RULE_BY_CODE = new Map<string, ProcessingRule>(
  PROCESSING_RULES.map((r) => [r.code, r]),
);

export function getRule(code: string): ProcessingRule | undefined {
  return RULE_BY_CODE.get(code);
}

/** Règle couvrant une donnée ou une relation donnée. */
export function findRule(
  targetType: TargetType,
  key: string,
): ProcessingRule | undefined {
  return PROCESSING_RULES.find(
    (r) => r.targetType === targetType && (r.fieldKey === key || r.relationKey === key),
  );
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
