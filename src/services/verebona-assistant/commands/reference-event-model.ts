/**
 * Événements de référence dans l'Assistant — modèle PUR (lot 114X, Trello #753,
 * CDC T2 §14.3 W21 – W26, §14.4 « Opérations », X69 – X73).
 *
 * Ce module ne lit rien et n'écrit rien. Il porte :
 *   · les paramètres figés des six commandes (ce que le plan enregistre) ;
 *   · le vocabulaire utilisateur des types (jamais « Opération » : « événement
 *     de référence », « intervention », « achat »…), DÉRIVÉ des référentiels
 *     existants — aucun type n'est énuméré ici ;
 *   · le choix du champ de date et de la nature d'une association (règles
 *     structurelles lues dans le modèle du graphe, carte #744) ;
 *   · la TRADUCTION de chaque résultat de la façade d'écriture
 *     (`operation-write.facade`) en texte pour l'utilisateur : jamais un code.
 */
import { BUSINESS_OPERATION_TYPE_CODES, type BusinessOperationStatus, type BusinessOperationTypeCode } from '@/services/business-operations/model';
import {
  RELATION_SOURCE_TYPE, type OperationPatchDateField, type OperationRelationNature, type OperationWriteCode, type OperationWriteResult,
} from '@/services/business-operations/graph/model';
import { referenceEventLabel } from '@/services/documents/business-period-surfaces';
import { SITUATION_LABELS } from '@/lib/agenda/situation';
import type { ActionResult, PlannedAction } from './catalog';

// ── Paramètres figés ───────────────────────────────────────────────────────

/** Rôles qu'un fournisseur peut recevoir depuis l'Assistant (sous-ensemble des rôles « utilisateur » de la façade). */
export const REFERENCE_EVENT_SUPPLIER_ROLES = ['PROVIDER', 'INTERVENER'] as const;
export type ReferenceEventSupplierRole = (typeof REFERENCE_EVENT_SUPPLIER_ROLES)[number];

/** Situation déclarée : a eu lieu (REALIZED) ou à prévoir (ENVISAGED). « Annulé » ne se déclare pas : un événement créé à tort se supprime. */
export type DeclaredStatus = Extract<BusinessOperationStatus, 'REALIZED' | 'ENVISAGED'>;

export type ReferenceEventParams =
  // CREATE_REFERENCE_EVENT (W21) : `distinctFrom` = événements comparables annoncés à l'aperçu, que la confirmation déclare distincts.
  | {
      kind: 'reference_event_create';
      declaration: string;
      typeCode: DeclarableTypeCode | null;
      status: DeclaredStatus;
      eventLabel: string | null;
      /** Champ de date retenu et date certaine (AAAA-MM-JJ) ; `null` : non daté — aucune date n'est inventée. */
      dateField: OperationPatchDateField | null;
      eventDate: string | null;
      eventAssetIds: number[];
      distinctFrom: number[];
    }
  // UPDATE_REFERENCE_EVENT (W22) : un champ à la fois ; la version présentée est figée.
  | {
      kind: 'reference_event_update';
      operationId: number;
      declaration: string;
      change:
        | { field: OperationPatchDateField; value: string }
        | { field: 'provider' | 'label'; value: string }
        | { field: 'type'; value: DeclarableTypeCode }
        | { field: 'status'; value: DeclaredStatus };
      expectedVersion: number;
    }
  // INVALIDATE_REFERENCE_EVENT (W23) : invalidation logique, jamais une suppression physique.
  | { kind: 'reference_event_invalidate'; operationId: number; expectedVersion: number }
  // ASSOCIATE_REFERENCE_EVENTS (W24) : relation orientée (origine → cible) ou simple association ; versions présentées figées.
  | { kind: 'reference_events_associate'; fromOperationId: number; toOperationId: number; nature: OperationRelationNature; expectedVersions: [number, number] }
  // LINK_DOCUMENT_REFERENCE_EVENT (W25).
  | { kind: 'reference_event_document'; operationId: number; linkedDocumentId: number; expectedVersion: number; documentVersion: string; operationFromAction?: string }
  // LINK_SUPPLIER_REFERENCE_EVENT (W26).
  | { kind: 'reference_event_supplier'; operationId: number; linkedSupplierId: number; role: ReferenceEventSupplierRole; expectedVersion: number; supplierVersion: string; operationFromAction?: string }
  /**
   * Passage 114AB (#753) — GESTES INVERSES du point d'écriture de la carte #744 : rétablir un événement
   * supprimé, dissocier deux événements, retirer un document ou un fournisseur, rattacher une échéance.
   * Mêmes règles que les gestes directs : version présentée figée, état relu avant d'écrire.
   */
  | { kind: 'reference_event_restore'; operationId: number; expectedVersion: number }
  | { kind: 'reference_events_dissociate'; fromOperationId: number; toOperationId: number; expectedVersions: [number, number] }
  | { kind: 'reference_event_document_unlink'; operationId: number; linkedDocumentId: number; expectedVersion: number; documentVersion: string }
  | { kind: 'reference_event_supplier_unlink'; operationId: number; linkedSupplierId: number; expectedVersion: number; supplierVersion: string }
  | { kind: 'reference_event_agenda'; operationId: number; agendaItemId: number; expectedVersion: number; agendaItemVersion: string };

/**
 * Passage 114Z4 (#753) : `operationFromAction` — l'événement visé est celui qu'une AUTRE action du même plan
 * enregistre (« Déclare … puis relie … à celui-ci »). `operationId` vaut 0 dans l'aperçu : il est remplacé à
 * l'exécution par l'identifiant réellement créé, et seulement si l'action dont il dépend a réussi (sinon
 * SKIPPED_DEPENDENCY). Aucun identifiant ne vient du modèle ni du client.
 */
export const DEFERRED_OPERATION_ID = 0;

// ── État lu d'un événement de référence ────────────────────────────────────

/** Événement de référence ACTIF du compte, tel que l'Assistant le présente et le recontrôle avant d'écrire. */
export interface ReferenceEventState {
  id: number;
  typeCode: BusinessOperationTypeCode | null;
  status: BusinessOperationStatus;
  /** Libellé utilisateur (« Intervention — Vidange ») : celui de la fiche d'un événement de référence. */
  label: string;
  technicalLabel: string | null;
  provider: string | null;
  plannedDate: string | null;
  startDate: string | null;
  realizedDate: string | null;
  endDate: string | null;
  /** Biens du compte liés (lien actif). */
  assets: Array<{ id: number; name: string }>;
  /** Titres des documents qui le fondent (sources actives, documents non supprimés). */
  documentTitles: string[];
  /** Version de l'événement (verrou optimiste de la façade) — recontrôlée à l'exécution. */
  version: number;
  /** Échéances de l'Agenda rattachées — lu pour l'aperçu d'une suppression seulement. */
  agendaItems?: number;
  /** Documents MEMBRES de l'événement (fondateurs ou rattachés par l'utilisateur) — lu pour l'aperçu d'une suppression seulement. */
  documentCount?: number;
  /**
   * Passage 114AB (#753) : `true` pour un événement SUPPRIMÉ par l'utilisateur, lu seulement pour l'aperçu
   * d'un rétablissement. Un état sans ce marqueur est toujours un événement ACTIF du compte.
   */
  invalidated?: true;
}

/** Recherche d'un événement de référence dans le compte. */
export interface ReferenceEventQuery { typeCode: BusinessOperationTypeCode | null; words: string[]; date: string | null }

const dates = (s: ReferenceEventState): Array<string | null> => [s.realizedDate, s.startDate, s.plannedDate, s.endDate];
/** Date présentée d'un événement : réalisation, sinon début, sinon date prévue. */
export const shownDate = (s: ReferenceEventState): string | null => s.realizedDate ?? s.startDate ?? s.plannedDate;

/**
 * Événements qui répondent à la désignation (pure, testée) : type nommé, date complète (l'une de ses dates),
 * et TOUS les mots présents dans ce qui le décrit — intitulé, prestataire, titres de ses documents, noms de ses
 * biens, nom de son type. Jamais un rapprochement approximatif.
 */
export function matchReferenceEvents(states: readonly ReferenceEventState[], q: ReferenceEventQuery): ReferenceEventState[] {
  return states.filter((s) => {
    if (q.typeCode && s.typeCode !== q.typeCode) return false;
    if (q.date && !dates(s).includes(q.date)) return false;
    const texte = sansAccent([s.technicalLabel, s.provider, ...s.documentTitles, ...s.assets.map((a) => a.name), typeLabel(s.typeCode)].filter(Boolean).join(' '));
    return q.words.every((w) => texte.includes(w));
  });
}

// ── Vocabulaire des types (dérivé des référentiels) ────────────────────────

/** Types proposables depuis l'Assistant : tous ceux du référentiel, sauf OTHER (jamais un repli). */
export type DeclarableTypeCode = Exclude<BusinessOperationTypeCode, 'OTHER'>;
export const DECLARABLE_TYPE_CODES: readonly DeclarableTypeCode[] =
  BUSINESS_OPERATION_TYPE_CODES.filter((c): c is DeclarableTypeCode => c !== 'OTHER');

const sansAccent = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’]/g, "'");

/** Nom affiché d'un type (« Intervention », « Achat »…) — celui de la fiche d'un événement de référence. */
export function typeLabel(typeCode: BusinessOperationTypeCode | null): string {
  return typeCode ? referenceEventLabel({ typeCode, technicalLabel: null }) : 'Type non précisé';
}

/**
 * Mots supplémentaires compris pour un type — ceux que l'Assistant emploie lui-même dans ses réponses
 * (`operationNoun`, « vente ») et le nom du référentiel (« acquisition »). Un test vérifie l'alignement avec
 * `operationNoun` : un nom employé par l'Assistant est toujours compris en retour.
 */
const SYNONYMES: Partial<Record<DeclarableTypeCode, readonly string[]>> = { DISPOSAL: ['vente'], ACQUISITION: ['acquisition'] };

/** Mot (sans accent, minuscules) → type. « événement de référence » n'y figure pas : il ne dit pas le type. */
export const TYPE_NOUNS: ReadonlyMap<string, DeclarableTypeCode> = new Map(
  DECLARABLE_TYPE_CODES.flatMap((code) => [sansAccent(typeLabel(code)), ...(SYNONYMES[code] ?? [])].map((mot) => [mot, code] as const)),
);

/** « Intervention, Achat, Contrat… » — pour demander un type. */
export const typeChoices = (): string => DECLARABLE_TYPE_CODES.map((c) => typeLabel(c).toLowerCase()).join(', ');

// ── Situation et dates ─────────────────────────────────────────────────────

/** Libellé de la situation — mêmes mots que l'Agenda (« A eu lieu », « À prévoir »). */
export const situationLabel = (s: DeclaredStatus): string => SITUATION_LABELS[s === 'REALIZED' ? 'A_EU_LIEU' : 'A_PREVOIR'];

/**
 * Types dont la date déclarée est un DÉBUT (une durée suit) : ceux d'où part une relation de financement, et le
 * contrat. Choix par défaut, à valider par le PO (fiche de recette).
 */
const TYPES_A_DUREE: readonly BusinessOperationTypeCode[] = ['CONTRACT', 'FINANCING'];

/** Champ qui reçoit LA date d'un événement déclaré : prévue s'il est à prévoir ; début pour un contrat ou un financement ; sinon réalisation. */
export function declaredDateField(typeCode: BusinessOperationTypeCode | null, status: BusinessOperationStatus): OperationPatchDateField {
  if (status !== 'REALIZED') return 'plannedDate';
  return typeCode && TYPES_A_DUREE.includes(typeCode) ? 'startDate' : 'realizedDate';
}

export const DATE_FIELD_LABELS: Readonly<Record<OperationPatchDateField, string>> = {
  plannedDate: 'Date prévue', startDate: 'Date de début', realizedDate: 'Date', endDate: 'Date de fin',
};

// ── Nature d'une association (W24) ─────────────────────────────────────────

/**
 * Type de l'événement VISÉ pour qu'une association soit qualifiée depuis l'Assistant : le financement d'un achat,
 * la réparation (intervention) d'un sinistre — les deux cas décrits par le CDC « Opérations / Agenda » (§9, SC-09).
 * Toute autre paire est une simple association. Choix par défaut, à valider par le PO (fiche de recette).
 */
const CIBLE_QUALIFIEE: Readonly<Record<Exclude<OperationRelationNature, 'ASSOCIATED'>, BusinessOperationTypeCode>> = {
  FINANCING: 'ACQUISITION',
  CLAIM_REPAIR: 'INTERVENTION',
};

/**
 * Nature et sens d'une association entre deux événements de référence, d'après leurs types. Le type d'ORIGINE
 * d'une relation orientée est lu dans le modèle du graphe (`RELATION_SOURCE_TYPE` : le financement, le
 * sinistre) ; la relation n'est qualifiée que si l'autre événement a le type visé (`CIBLE_QUALIFIEE`). Sinon :
 * simple association, dans l'ordre donné. Jamais une fusion.
 */
export function relationBetween(
  a: { id: number; typeCode: BusinessOperationTypeCode | null }, b: { id: number; typeCode: BusinessOperationTypeCode | null },
): { nature: OperationRelationNature; fromOperationId: number; toOperationId: number } {
  for (const nature of Object.keys(CIBLE_QUALIFIEE) as Array<keyof typeof CIBLE_QUALIFIEE>) {
    const origine = RELATION_SOURCE_TYPE[nature];
    const cible = CIBLE_QUALIFIEE[nature];
    if (a.typeCode === origine && b.typeCode === cible) return { nature, fromOperationId: a.id, toOperationId: b.id };
    if (b.typeCode === origine && a.typeCode === cible) return { nature, fromOperationId: b.id, toOperationId: a.id };
  }
  return { nature: 'ASSOCIATED', fromOperationId: a.id, toOperationId: b.id };
}

/** Phrase de l'aperçu qui dit ce que l'association signifie (textes à valider par le PO). */
export function relationSentence(nature: OperationRelationNature, from: string, to: string): string {
  if (nature === 'FINANCING') return `« ${from} » sera indiqué comme le financement de « ${to} ».`;
  if (nature === 'CLAIM_REPAIR') return `« ${to} » sera indiqué comme la réparation de « ${from} ».`;
  return 'Les deux événements de référence seront simplement associés.';
}

// ── Traduction des résultats de la façade ──────────────────────────────────

export const REFERENCE_EVENT_NOT_FOUND = 'Événement de référence introuvable ou hors de votre compte.';
export const REFERENCE_EVENT_CHANGED_SINCE_PREVIEW = 'Cet événement de référence a été modifié depuis l’aperçu : rien n’a été fait. Refaites votre demande.';
const IMPOSSIBLE_ICI = 'Cette action n’est pas possible depuis l’assistant : rien n’a été écrit.';

/**
 * Texte utilisateur de CHAQUE code de la façade (liste exhaustive : un code ajouté par la façade ne compile plus
 * tant qu'il n'a pas son texte). Jamais un code brut, jamais le mot « Opération ». Textes à valider par le PO.
 */
export const WRITE_CODE_TEXT: Readonly<Record<Exclude<OperationWriteCode, 'OK' | 'NO_CHANGE'>, string>> = {
  NEW_EVIDENCE_AFTER_REFUSAL: 'Cette association avait été refusée ; un élément nouveau demande votre décision dans « À traiter » : rien n’a été écrit.',
  VERSION_MISMATCH: REFERENCE_EVENT_CHANGED_SINCE_PREVIEW,
  IDEMPOTENCY_KEY_REUSED: 'Cette action a déjà été traitée : rien n’a été refait.',
  SPLIT_PART_NOT_LINKED: 'Un des éléments à séparer n’appartient pas à cet événement de référence : rien n’a été écrit.',
  SPLIT_NOTHING_TO_MOVE: 'Il faut choisir au moins un élément à séparer : rien n’a été écrit.',
  TYPE_MISMATCH: 'Ces deux événements de référence ne sont pas de même nature : ils ne peuvent pas être réunis ; rien n’a été écrit.',
  INVALID_INPUT: 'Ces informations ne peuvent pas être enregistrées telles quelles : rien n’a été écrit.',
  READ_ONLY_ACCOUNT: 'Votre compte est en lecture seule : rien n’a été écrit.',
  NOT_A_MEMBER: 'Vous n’avez pas accès à ce compte : rien n’a été écrit.',
  NOT_FOUND_IN_ACCOUNT: 'Un des éléments de cette action est introuvable dans votre compte : rien n’a été écrit.',
  OPERATION_INACTIVE: 'Cet événement de référence n’est plus actif (il a été supprimé ou regroupé avec un autre) : rien n’a été écrit.',
  REFLEXIVE: 'Un événement de référence ne peut pas être associé à lui-même : rien n’a été écrit.',
  NATURE_TYPE_MISMATCH: 'Ces deux événements de référence ne peuvent pas être associés de cette façon : rien n’a été écrit.',
  EVIDENCE_REQUIRED: IMPOSSIBLE_ICI,
  USER_REJECTED: IMPOSSIBLE_ICI,
  USER_RELATION_PROTECTED: IMPOSSIBLE_ICI,
  USER_ONLY: IMPOSSIBLE_ICI,
  LINKED_ELSEWHERE: 'Cet élément est déjà rattaché à un autre événement de référence : rien n’a été modifié.',
  NOT_LINKED: 'Cet élément n’est pas rattaché à cet événement de référence : rien n’a été modifié.',
  TYPE_DETAILS_PRESENT: 'Le type de cet événement de référence ne peut pas être changé : des informations propres à son type actuel y sont enregistrées. Rien n’a été écrit.',
  STATUS_TRANSITION_REFUSED: 'La situation de cet événement de référence ne peut pas être changée ainsi : rien n’a été écrit. S’il a été enregistré à tort, supprimez-le.',
  NOT_RESTORABLE: 'Cet événement de référence ne peut pas être rétabli : rien n’a été écrit.',
  DUPLICATE_DECLARATION: 'Cette déclaration est déjà enregistrée : rien n’a été créé en double.',
  TECHNICAL_FAILURE: 'Une erreur technique est survenue : rien n’a été écrit. Réessayez dans un instant.',
};

/**
 * Résultat d'une commande de la façade → résultat d'action de l'Assistant.
 *   appliqué (écrit)            SUCCESS, texte de réussite ;
 *   appliqué (déjà satisfait)   SUCCESS, texte « déjà fait » — rien n'a été écrit, et c'est dit ;
 *   arbitrage requis, interdit  REFUSED ;
 *   conflit, échec              FAILED.
 */
export function translateWriteResult<T>(
  action: Pick<PlannedAction, 'actionId'>, r: OperationWriteResult<T>,
  textes: { done: string; alreadyDone: string }, entityId?: number | null,
): ActionResult {
  if (r.status === 'APPLIED') {
    // Rejeu par clé d'idempotence d'une écriture déjà faite : l'action demandée EST faite — texte de réussite.
    const message = r.changed || r.replayed ? textes.done : textes.alreadyDone;
    return { actionId: action.actionId, status: 'SUCCESS', message, entity: entityId ? { type: 'reference_event', id: entityId } : null };
  }
  const message = r.code === 'OK' || r.code === 'NO_CHANGE' ? WRITE_CODE_TEXT.TECHNICAL_FAILURE : WRITE_CODE_TEXT[r.code];
  const status: ActionResult['status'] = r.status === 'FORBIDDEN' || r.status === 'ARBITRATION_REQUIRED' ? 'REFUSED' : 'FAILED';
  return { actionId: action.actionId, status, message };
}
