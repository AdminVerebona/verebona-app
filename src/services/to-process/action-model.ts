/**
 * Modèle d'action « À traiter » — CDC V2.0 §7, §9, §13.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE CARTE = UNE ACTION, PAS UN OBJET
 *
 * Le §7.1 rompt avec la V1 : « Une carte ou une ligne représente une action,
 * pas un objet. Un même document, bien ou équipement peut donc générer
 * plusieurs actions simultanées. »
 *
 * Toute la mécanique d'unicité en découle. L'identité d'une action n'est pas
 * l'objet concerné, c'est le triplet objet + donnée + nature (§7.3). Deux
 * problèmes distincts sur la même facture — Rubrique absente et bien non
 * rattaché — sont deux actions ; le même problème redétecté par une nouvelle
 * analyse est une mise à jour.
 *
 * ── LE CYCLE, ET POURQUOI IL EST NUMÉROTÉ ─────────────────────────────────
 *
 * Le §7.3 veut qu'un problème résolu puis réapparu crée une NOUVELLE action,
 * sans que l'ancienne résolution soit perdue. Une contrainte d'unicité posée
 * sur le triplet seul l'interdirait : la ligne résolue occuperait la place.
 *
 * `cycleNumber` lève l'ambiguïté, et l'unicité ne porte que sur les actions
 * actives — index partiel `WHERE resolved_at IS NULL` (§13.4).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** §7.2 — les deux seules natures d'action de la V2. */
export type ActionKind = 'ARBITRATE' | 'COMPLETE';

/** §9.1 — trois niveaux, libellés grand public côté UX. */
export type ActionPriority = 'DO_FIRST' | 'DO_NEXT' | 'CAN_WAIT';

/** Objets susceptibles de porter une action. */
export type TargetType = 'DOCUMENT' | 'ASSET' | 'EQUIPMENT' | 'AGENDA_ITEM' | 'SUPPLIER';

/** §12.1 — origine d'une valeur. */
export type ValueOrigin =
  | 'USER'
  | 'DOCUMENT_EXTRACTION'
  | 'RECONCILIATION'
  | 'IMPORT'
  | 'SYSTEM_RULE'
  | 'ADMIN';

export type ResolutionReason =
  /** L'utilisateur a retenu une proposition depuis la carte. */
  | 'USER_ARBITRATED'
  /** L'utilisateur a saisi la valeur ailleurs (drawer, écran métier) — §5.3. */
  | 'USER_COMPLETED'
  /** Règle autorisant un état final sans valeur — §7.4. */
  | 'NOT_APPLICABLE'
  /** Le problème a disparu : nouvelle preuve, correction, source supprimée. */
  | 'OBSOLETE'
  /** L'objet concerné n'existe plus. */
  | 'TARGET_DELETED';

/** Une valeur candidate, telle que le moteur d'optimisation la produit (§11.5). */
export interface ActionProposal {
  /** Valeur applicable telle quelle, sérialisable. */
  value: string | number | boolean | null;
  /** Libellé affiché sur la carte. */
  label: string;
  /** 0 → 1. Jamais exposé à l'utilisateur (§11.2). */
  confidence: number;
  /** Identifiants des preuves (documents, extractions) ayant produit la valeur. */
  evidenceIds?: string[];
  /** Contexte de source affiché légèrement sur la carte (§8.4). */
  sourceContext?: {
    label: string;
    targetType?: TargetType;
    targetId?: number;
  };
  /**
   * Valeur actuelle protégée par l'utilisateur, présentée pour confirmation
   * (§8.5). Elle n'est pas une proposition de l'IA et n'a pas de confiance.
   */
  isCurrentValue?: boolean;
}

export interface ToProcessAction {
  id?: number;
  publicId?: string;
  accountId: number;
  targetType: TargetType;
  targetId: number;
  /** Donnée concernée. Exclusif avec `relationKey`. */
  fieldKey: string | null;
  /** Relation concernée (rattachement). Exclusif avec `fieldKey`. */
  relationKey: string | null;
  actionKind: ActionKind;
  /** Code de la règle du catalogue §10 ayant créé l'action. */
  ruleCode: string;
  priority: ActionPriority;
  /** Question affichée en élément dominant de la carte (§8.4). */
  question: string;
  proposals: ActionProposal[];
  activeSince: Date;
  lastSeenAt: Date;
  resolvedAt?: Date | null;
  resolutionReason?: ResolutionReason | null;
  cycleNumber: number;
  /** Échéance associée, quand la règle en porte une (§9.2). */
  dueDate?: Date | null;
}

/**
 * Clé d'unicité d'une action active (§7.3, §13.4).
 *
 * `fieldKey` et `relationKey` sont fondus en un seul segment : une donnée et
 * une relation ne portent jamais le même nom, et les distinguer dans la clé
 * ferait dépendre l'unicité d'un détail de nommage.
 */
export function actionIdentityKey(
  action: Pick<
    ToProcessAction,
    'accountId' | 'targetType' | 'targetId' | 'fieldKey' | 'relationKey' | 'actionKind'
  >,
): string {
  const dataKey = action.fieldKey ?? action.relationKey ?? '';
  return [
    action.accountId,
    action.targetType,
    action.targetId,
    dataKey,
    action.actionKind,
  ].join('|');
}

/**
 * Une action « À arbitrer » n'existe que si elle a de quoi être arbitrée.
 *
 * §8.5 et critère ATP-05 : « À arbitrer n'existe que si au moins une
 * proposition est affichable. » Une valeur actuelle seule ne suffit pas —
 * confirmer une valeur qu'aucune autre ne conteste ne résout rien.
 */
export function isDisplayableArbitration(proposals: ActionProposal[]): boolean {
  return proposals.some((p) => !p.isCurrentValue);
}

/**
 * Propositions retenues pour l'affichage (§8.5).
 *
 * Deux propositions au maximum, plus la valeur actuelle si elle est protégée.
 * Le front ajoute « Autre » ; il n'a pas à être présent dans les données.
 */
export function selectDisplayedProposals(proposals: ActionProposal[]): ActionProposal[] {
  const current = proposals.filter((p) => p.isCurrentValue);
  const candidates = proposals
    .filter((p) => !p.isCurrentValue)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 2);
  return [...candidates, ...current.slice(0, 1)];
}
