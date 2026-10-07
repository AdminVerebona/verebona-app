/**
 * Mascotte d'accueil — contrats (CDC « Mascotte d'accueil & T6 » V1, §16, annexe C).
 *
 * Module pur, lisible côté client : le front reçoit `MascotPresentation` et
 * n'a besoin de rien d'autre pour afficher (MascotPresenter, §5).
 */

/** Familles, dans l'ordre obligatoire de la hiérarchie V1 (§6). */
export const MASCOT_FAMILIES = ['PROCESSING', 'ONBOARDING', 'TO_PROCESS', 'DATE', 'MASCOT_RULE'] as const;
export type MascotFamily = (typeof MASCOT_FAMILIES)[number];

/** Même référentiel que « À traiter » (REC-002, D-07). */
export type MascotPriority = 'DO_FIRST' | 'DO_NEXT' | 'CAN_WAIT';

export type MascotIntent = 'inform' | 'act' | 'onboard' | 'deadline';

/** Codes de signaux V1 (§7) — liste fermée. */
export type MascotSourceCode =
  | 'PROC-DOC-UPLOAD' | 'PROC-DOC-ANALYSIS' | 'PROC-EXPORT'
  | 'ONB-ASSET' | 'ONB-DOC'
  | `ATP-${string}`
  | 'DATE-NEXT' | 'DATE-NEXT-2'
  | 'MASC-EXT-ACTION' | 'MASC-BLOCKED';

export type MascotDrawerKind = 'document' | 'echeance' | 'equipement' | 'piece';

/**
 * Cible d'une action : toujours un parcours existant (ActionResolver, §5).
 * Aucune n'écrit de donnée métier ; « C'est fait » n'écrit que l'acquittement
 * propre à la mascotte (GEN-002).
 */
export type MascotActionTarget =
  | { kind: 'drawer'; drawer: MascotDrawerKind; id: number; mode?: 'view' | 'edit'; showAnalysisResults?: boolean }
  | {
      kind: 'to_process';
      publicId: string;
      targetType: 'DOCUMENT' | 'ASSET' | 'EQUIPMENT' | 'ROOM' | 'AGENDA_ITEM' | 'SUPPLIER';
      targetId: number;
      targetPublicId: string | null;
      field: string | null;
      /**
       * Cible SUPPLIER : fournisseur réellement visé, résolu côté serveur
       * (`targetId` peut être celui d'une revue). Absent/null : repli (ATP-005).
       */
      supplierId?: number | null;
    }
  | { kind: 'route'; href: string }
  | { kind: 'create_asset' }
  | { kind: 'upload_document'; assetId?: number | null }
  | { kind: 'done'; occurrenceKey: string; cycleKey: string }
  | { kind: 'ask'; question: string; context: { intent: string; assetId?: number } };

export interface MascotAction {
  /** Stable pour la visite : sert la télémétrie « cliqué ». */
  actionId: string;
  label: string;
  target: MascotActionTarget;
}

/** Faits autorisés pour T6 : valeurs simples, déjà validées (T6-003, SEC-007). */
export type MascotFacts = Record<string, string | number | boolean | null>;

/** Objet interne MascotSubject (§16.1). */
export interface MascotSubject {
  subjectId: string;
  sourceFamily: MascotFamily;
  sourceCode: MascotSourceCode;
  accountId: number;
  targetType?: string;
  targetId?: number;
  priority: MascotPriority | null;
  requiresAttention: boolean;
  intent: MascotIntent;
  facts: MascotFacts;
  /** Maximum 2 (§16.1). */
  actions: MascotAction[];
  fallbackText: string;
  /** Segment qu'il est permis de mettre en valeur (T6-010), présent dans fallbackText. */
  allowedHighlight: string | null;
  occurrenceKey: string;
  /** Doublons fonctionnels (SEL-003, UX-008) : même clé = même sujet métier. */
  dedupeKeys: string[];
  /** Libellé court quand le sujet n'est proposé qu'en élément secondaire. */
  secondaryLabel: string;
  /** Bien concerné, pour la question « Que sais-tu sur … ? » (Q-ASSET). */
  assetId?: number | null;
  assetName?: string | null;
}

export type MascotSecondaryKind = 'onboarding' | 'recommendation' | 'question';

export interface MascotSecondary {
  id: string;
  kind: MascotSecondaryKind;
  sourceCode: string;
  occurrenceKey: string;
  action: MascotAction;
}

export interface MascotParagraph {
  subjectId: string;
  sourceCode: string;
  occurrenceKey: string;
  text: string;
  /** Sous-chaîne exacte de `text`, ou null (JSON-002). */
  highlight: string | null;
  actions: MascotAction[];
  /**
   * Tuile d'action de la bulle (Direction D v2 §3.2) : sévérité, libellé,
   * bien et statut. Calculée côté serveur à partir des faits du sujet.
   */
  tile?: MascotTile;
}

/** Tuile d'action d'un sujet (Direction D v2 §3.2). */
export interface MascotTile {
  /** amber = à vérifier, red = en retard, blue = information, green = dépôt. */
  tone: 'amber' | 'red' | 'blue' | 'green';
  icon: 'circle-alert' | 'clock' | 'calendar-days' | 'file-text' | 'plus' | 'download';
  /** Libellé de l'action (« Vérifier l'information »). */
  label: string;
  /** Bien concerné (ou document), affiché avant le statut. */
  assetName: string | null;
  /** « À vérifier », « En retard (2 j) »… */
  status: string;
  /** Le sujet mérite l'attention (et non une simple information). */
  attention: boolean;
  /**
   * Nature du sujet, pour la pose de la mascotte (gradation) : en retard,
   * information à vérifier (incohérence, arbitrage), autre action (compléter,
   * préciser, échéance du jour, premier pas), information.
   */
  kind?: 'overdue' | 'verify' | 'action' | 'info';
}

export type MascotStatus = 'ok' | 'clear' | 'degraded';

// ── « À traiter » de la mascotte (lot 32, MASC2) ─────────────────────────────

/** OPEN_CHOICES : composant de choix de la file ; OPEN_TODO_CARD : la carte, ciblée par son ID. */
export type MascotTodoActionType = 'OPEN_CHOICES' | 'OPEN_TODO_CARD';

export interface MascotTodoChoice {
  value: string | number | boolean | null;
  label: string;
  isCurrentValue?: boolean;
}

/** Vue d'une action telle que la file « À traiter » l'affiche (`ToProcessActionView`). */
export interface MascotTodoCard {
  publicId: string;
  targetType: 'DOCUMENT' | 'ASSET' | 'EQUIPMENT' | 'ROOM' | 'AGENDA_ITEM' | 'SUPPLIER';
  targetId: number;
  fieldKey: string | null;
  relationKey: string | null;
  actionKind: 'ARBITRATE' | 'COMPLETE';
  priority: MascotPriority;
  ruleCode: string;
  question: string;
  proposals: Array<MascotTodoChoice & { sourceContext?: { label: string } }>;
  inputType?: 'date' | 'text' | null;
  target: {
    label: string;
    mimeType?: string | null;
    publicId?: string | null;
    assetId?: number | null;
    assetName?: string | null;
    supplierId?: number | null;
  };
}

/**
 * Élément « À traiter » de niveau 2 — contrat du ticket MASC2. La
 * destination se lit dans `actionType`, jamais dans un libellé.
 */
export interface MascotTodoItem {
  todoId: string;
  todoType: string;
  entityType: MascotTodoCard['targetType'];
  entityId: number;
  actionType: MascotTodoActionType;
  availableChoices?: MascotTodoChoice[];
  targetField?: string | null;
  documentId?: number | null;
  assetId?: number | null;
  priority: MascotPriority;
  actionKind: MascotTodoCard['actionKind'];
  /** « Numéro d’immatriculation à vérifier » */
  title: string;
  /** « Vélo Jean Fourche » */
  subtitle: string | null;
  /** « Vérifier », « Choisir le bien », « Compléter » */
  cta: string;
  /** Vue de l'action (file) : la carte et la résolution d'« À traiter » sont réutilisées. */
  card: MascotTodoCard;
}

/** Total de la file (= pastille du menu, = page) et premiers éléments, dans l'ordre de la file. */
export interface MascotTodoBlock {
  total: number;
  items: MascotTodoItem[];
}

/** Payload servi au front — remplace `situation.message` (MIG-002). */
export interface MascotPresentation {
  schemaVersion: 'mascot-presentation-v1';
  status: MascotStatus;
  /** Discours produit par T6, par le texte de secours, ou déterministe (rien à dire). */
  source: 't6' | 'fallback' | 'deterministic';
  /** Empreinte du contexte : le client ignore une réponse obsolète (RUN-010, §20). */
  contextHash: string;
  paragraphs: MascotParagraph[];
  secondaries: MascotSecondary[];
  /** « Certaines informations n'ont pas pu être actualisées » (§20). */
  degradedNotice: string | null;
  computedAt: string;
  /**
   * « À traiter » (lot 32, MASC2) : niveau 2 de la bulle, depuis la même
   * source que la file. Absent (présentation ancienne) ou `null` (file
   * illisible) : aucun élément.
   */
  todo?: MascotTodoBlock | null;
}

/** Plafonds UX (UX-007, SEC-001). */
export const MAX_SUBJECTS = 2;
export const MAX_ACTIONS_TOTAL = 5;
export const MAX_SECONDARIES = 3;
export const MAX_ACTIONS_PER_SUBJECT = 2;

export const CLEAR_TEXT = 'Tout est à jour pour le moment.';
export const DEGRADED_NOTICE = 'Certaines informations n’ont pas pu être actualisées.';
