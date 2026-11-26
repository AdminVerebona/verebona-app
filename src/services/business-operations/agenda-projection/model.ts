/**
 * T4 / Agenda : projection des Opérations — règles PURES (lot 46, O7 ; CDC
 * Opérations V1 ch. 17 / 17.1, P14, B16, C16, C16.1, C16.2, C22, F-138 à
 * F-147, INV-029, INV-030, INV-FINAL-012).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE PROJECTION N'EST JAMAIS OBLIGATOIRE (P14)
 *
 * L'Agenda représente le temps : il n'est ni la condition d'une Opération ni
 * sa copie. Ce module dit, pour UNE Opération, quel événement d'agenda la
 * représenterait (tableau C16) — ou pourquoi aucun :
 *
 *   INTERVENTION ENVISAGED   planned_date connue → événement planifié (DEADLINE)
 *   INTERVENTION REALIZED    realized_date connue → historique (HISTORICAL) ;
 *                            l'événement planifié lié est complété ; sans
 *                            date de réalisation, aucune date n'est inventée
 *                            (F-140) : l'événement lié est seulement marqué
 *   CLAIM REALIZED           realized_date → historique « sinistre »
 *   ACQUISITION REALIZED     realized_date → historique d'entrée en possession,
 *                            intitulé DESCRIPTIF (« Achat Polisport groovy
 *                            coussin gris », jamais « Achat » nu) — SAUF si
 *                            la seule preuve est une COMMANDE (carte #813) :
 *                            un bon de commande, même payé, ne crée aucun
 *                            événement « Achat », daté ou non
 *   DISPOSAL REALIZED        realized_date → historique de sortie
 *   CONTRACT                 seulement l'échéance explicite (fin du contrat,
 *                            type « contrat » du domaine Agenda) et
 *                            actionnable (à venir) ; jamais de copie
 *                            permanente (F-144) — la prise d'effet n'est pas
 *                            un type géré par l'Agenda
 *   FINANCING / OTHER / nul  aucune projection (aucune échéance de
 *                            financement n'est portée par les règles Agenda)
 *
 * Lot 83A (CDC v5 O-7, §6.1, §11, §12, E01–E05) — PLUSIEURS ÉLÉMENTS PAR
 * OPÉRATION. Une Opération regroupe 0..N éléments d'agenda (étapes,
 * rendez-vous, échéances…) ; la projection ne gère QUE sa représentation ; les
 * autres membres restent des éléments autonomes — jamais promus parce qu'ils
 * sont liés, jamais absorbés, jamais détachés par la projection (seule
 * l'invalidation de l'Opération les libère).
 *
 * Lot 114O (carte #744, CDC « Opérations / Agenda V2.0 » §4, §16, §20, AC40,
 * AC52) — AUCUN RÔLE : la projection N'ÉCRIT PLUS le rôle « principal »
 * (`agenda_items.operation_role`) et ne le lit plus. Elle pose les liens N↔N et
 * le FAIT PORTÉ par le lien (`business_operation_agenda_links.fact_key`, clé de
 * projection sans sa partie datée) :
 *   · l'EMPLACEMENT d'un événement global est l'élément dont le lien PORTE le
 *     fait, à défaut la propre projection de l'Opération — « porte le fait »
 *     remplace « est le principal », sans hiérarchie entre les éléments ;
 *   · une ÉCHÉANCE (contrat) ne fait porter aucun fait : son emplacement est
 *     choisi par la règle de représentation inchangée (choix de l'utilisateur,
 *     saisi avant projeté, intact, plus ancien) ;
 *   · aucun fait n'est DÉDUIT pour une relation durable (contrat, financement,
 *     §11.10, AC52) ni pour un regroupement non qualifié.
 * Événement établi SANS date (§11.4, AC17) : créé sans date (ni date
 * inventée, ni « Sans échéance ») ; la carte « À traiter » de date existante
 * (DATA-AGENDA-DATE) la demande, ou l'arbitre si T3 a trouvé des dates
 * contradictoires (§11.8, AC20) ; une date établie ensuite est posée et la
 * carte se ferme d'elle-même (§11.7, AC19). L'intervention envisagée puis
 * réalisée reste la MÊME occurrence (C22). Le contrat porte la date de son
 * échéance dans sa clé : un renouvellement est une nouvelle échéance.
 *
 * RAPPROCHEMENT AVANT PROJECTION (C16.1, F-147) : un événement existant qui
 * représente la même réalité (saisi à la main, produit par T1/T4 depuis le
 * même document, sinistre historique d'un constat, événement choisi dans le
 * formulaire Sinistre) est LIÉ (`business_operation_id`) au lieu d'être
 * dupliqué. Rapprochement CERTAIN seulement : même bien ou même document,
 * type métier compatible ou intitulé explicite, date à ±3 jours (±7 entre une
 * intervention planifiée et sa réalisation). Un rapprochement seulement
 * PROBABLE (intitulé proche — `findDuplicate` de T4 —, même document à une
 * autre date, deux événements aussi plausibles) : la projection S'ABSTIENT —
 * ni lien hasardeux, ni doublon — et, depuis le lot 53 (retour PO D14), une
 * carte « À traiter » présente les événements candidats et leur provenance
 * (`to-process/agenda-projection-cards.ts`) : l'utilisateur relie, ou fait
 * ajouter un nouvel événement. Une hypothèse n'est jamais promue en
 * événement confirmé sans ce choix.
 *
 * CONVENTIONS AGENDA RÉUTILISÉES (§4.4.4, T4-12) : un élément modifié par
 * l'utilisateur n'est jamais réécrit ; une réalisation est écrite
 * automatiquement seulement sur un élément automatique intact, sinon proposée
 * (carte « réalisé ? »). Le texte de l'utilisateur n'est jamais remplacé par
 * un libellé technique. Aucun libellé produit ne contient le mot « Opération »
 * (P09).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { findDuplicate } from '@/services/ai/agenda/dedupe.service';
import { natureTokens } from '../consolidation/matching';
import type { AgendaEventNature } from '@/services/agenda/agenda-functional-key';
import type { BusinessOperationStatus, BusinessOperationTypeCode } from '../model';
import { factKeyOf, isDurableRelation, isGlobalEventFact } from '../grouping/model';
import { ACQUISITION_TYPE_NAME, acquisitionEventTitle } from '@/lib/reference-events/operation-title';
import { agendaTitleAuthority, type TitleAuthorityDecision } from '../title-provenance';

/** Valeur de `agenda_items.projection_origin` d'un événement GÉNÉRÉ (0318). */
export const PROJECTION_ORIGIN = 'OPERATION';
/** `projection_kind` de `business_operation_projection_suppressions` (0316). */
export const PROJECTION_KIND_AGENDA = 'AGENDA';
/** `origin_ref_type` d'un événement projeté (texte libre, jamais `asset_file`). */
export const PROJECTION_ORIGIN_REF_TYPE = 'business_operation';
/** `origin_type` d'un événement projeté : déduit par règle d'une donnée consolidée. */
export const PROJECTION_ORIGIN_TYPE = 'deduced_rule';
/** Préfixe des clés fonctionnelles des projections (distinctes des clés par document, T4-08). */
const PROJECTION_KEY_PREFIX = 'bo:v1:';

/** Tolérance de date d'un rapprochement certain (même que le dédoublonnage T4). */
const MATCH_DATE_TOLERANCE_DAYS = 3;
/** Intervention planifiée ↔ réalisée : fenêtre « exacte » de T4-14. */
const PLANNED_TO_REALIZED_TOLERANCE_DAYS = 7;
/** Même document, autre date : au-delà de la tolérance mais jusqu'ici, rapprochement PROBABLE. */
const SAME_DOCUMENT_PROBABLE_DAYS = 30;

// ── Entrées ─────────────────────────────────────────────────────────────────

/** Opération telle que la projection la lit (une lecture, aucune écriture). */
export interface OperationSnapshot {
  id: number;
  accountId: number;
  typeCode: BusinessOperationTypeCode | null;
  status: BusinessOperationStatus;
  technicalLabel: string | null;
  provider: string | null;
  plannedDate: string | null;
  realizedDate: string | null;
  endDate: string | null;
  /** Ni invalidée ni fusionnée. */
  active: boolean;
  /** Biens liés (liens actifs). */
  assetIds: number[];
  /** Équipements liés (liens actifs). */
  equipmentIds: number[];
  /** Documents sources actifs (non supprimés). */
  documentFileIds: number[];
  /** CONTRACT : fin d'effet explicite (`contract_details.effective_to`). */
  contractEffectiveTo: string | null;
  /** CLAIM : événement de l'HISTORIQUE choisi comme ancre au lot 44. */
  claimHistoryEventId: number | null;
  /** DISPOSAL : vente ou transmission (statut du bien). */
  disposalKind: 'SALE' | 'TRANSMISSION' | null;
  /**
   * Carte #813 (D) : TOUTES les preuves actives de l'Opération sont des pièces de COMMANDE ou des devis
   * (source documentaire de rôle ORDER / QUOTE, ou document classé bon de commande au référentiel). Une
   * commande prouve la commande, jamais la réalisation : aucun événement « Achat » n'en est projeté.
   * Absent (appelants antérieurs, tests) : non.
   */
  orderOnlyEvidence?: boolean;
  /**
   * Carte #813 (A) : noms des biens liés (ordre des identifiants). RÈGLE REMPLACÉE (carte #821) : le bien associé
   * ne nomme plus jamais un achat — ces noms servent seulement à RECONNAÎTRE un intitulé automatique qui ne dit pas
   * ce qui a été acheté (« Achat — Cupra », `isUninformativePurchaseTitle`).
   */
  assetNames?: string[];
  /**
   * Carte #821 : titres des justificatifs sources de l'Opération (titre retenu et titre proposé par l'analyse) —
   * le nom d'un justificatif ne désigne pas l'objet acheté (« Achat — Ticket de carburant »). Absent : aucun.
   */
  documentTitles?: string[];
  /**
   * Lot 76H : documents dont T3 a consolidé TOUTE la preuve d'intervention
   * dans cette Opération — source DOCUMENT active de cette seule Opération
   * d'intervention active, et chaque candidat T1 établi d'intervention du
   * document résolu (MATCH / CREATE, fusions suivies) vers elle, aucun en
   * attente ni en arbitrage. C'est la décision d'identité de T3 que la
   * projection exploite (aucune règle « un document = un événement »).
   */
  exclusiveFileIds?: number[];
  /**
   * Lot 83A (§11.8) : dates de réalisation CONTRADICTOIRES entre sources,
   * telles que T3 les a tracées (provenance 78A, contradiction ouverte) —
   * au moins deux valeurs crédibles. Absent ou < 2 : aucune contradiction.
   */
  realizedDateConflict?: string[];
}

/** Élément d'agenda lu pour la projection (lié à l'Opération, ou candidat au rapprochement). */
export interface AgendaItemSnapshot {
  id: number;
  title: string;
  date: string | null;
  isAutomatic: boolean;
  isAutomaticModified: boolean;
  /** `projection_origin = 'OPERATION'` : élément GÉNÉRÉ par une projection. */
  projected: boolean;
  businessOperationId: number | null;
  /** L'Opération liée (si autre) est encore active. */
  linkedOperationActive: boolean;
  nature: AgendaEventNature | null;
  businessType: string | null;
  homeCategory: string | null;
  functionalKey: string | null;
  originRefType: string | null;
  originRefId: number | null;
  assetIds: number[];
  equipmentIds: number[];
  fileIds: number[];
  /**
   * Lot 76H : statut encore ouvert à l'utilisateur — « à qualifier »
   * (`requires_qualification`), prévision « à confirmer » (FORECAST) ou
   * prévision confirmée par l'utilisateur : jamais absorbé.
   */
  pendingStatus?: boolean;
  /**
   * Carte #859 : mêmes gardes que `pendingStatus` SANS la confirmation d'une prévision par l'utilisateur (une
   * décision sur la DATE, jamais sur le titre) — « à qualifier », prévision à confirmer, consolidation restaurée.
   * Absent : `pendingStatus` (instantané de test).
   */
  pendingHold?: boolean;
  /**
   * Carte #859 : autorité sur le CHAMP titre (SYSTEM / USER / INCONNU, motif, preuve — `title-provenance.ts`).
   * Absente (instantané de test) : déduite des seuls indicateurs (`agendaTitleAuthority` sans provenance).
   */
  titleAuthority?: TitleAuthorityDecision;
  /** Lot 76H : champ d'origine (date lue dans un champ explicite du document). */
  originFieldKey?: string | null;
  /** Lot 76H : sources documentaires de l'élément (`agenda_item_sources`). */
  sourceCount?: number;
  /**
   * Lot 76H : Opération d'intervention active dont T3 a fait le document
   * source de l'élément (`exclusiveFileIds`) — l'élément représente CETTE
   * intervention, jamais une autre.
   */
  coveredByOperationId?: number | null;
  /**
   * Lot 114O (#744, migration 1721) : FAIT que le lien de l'élément avec son
   * Opération PORTE (`fact_key` ; null : aucun — état normal d'un membre) et
   * ORIGINE de ce lien (USER / AI / MIGRATION / SYSTEM). `undefined` : non lu
   * (instantané de test) — aucune action sur le fait porté n'est planifiée.
   * Remplace le rôle « principal » et son auteur (0652).
   */
  carriedFact?: string | null;
  carrierOrigin?: string | null;
  /**
   * Lot 87B : l'utilisateur a pris une décision sur un lien Document ↔ cet
   * élément (détachement mémorisé, AGENDA_FILE_LINK) — une projection
   * technique qui la porte ne cède jamais sa place automatiquement.
   */
  userLinkDecision?: boolean;
  /**
   * Lot 87B : Opérations dont T3 a fait de CET élément une source AGENDA
   * active (lot 47B : événement saisi qui établit l'intervention) — preuve
   * de provenance EXACTE (identifiant), comme le document source. Aussi :
   * Opération d'acquisition dont la date de la fiche a été RECOPIÉE de cet
   * élément (D-13, journal `canonical_field_writes`) — le fait fondateur de
   * l'Opération est cet élément.
   */
  agendaSourceOperationIds?: number[];
  /**
   * Lot 87B : l'unique Opération ACTIVE dont le document d'origine de
   * l'élément est une source (null : aucune, ou plusieurs) — provenance
   * exacte qui permet à la projection technique de lui céder sa place.
   */
  originSoleOperationId?: number | null;
  /**
   * Lot 87B (CODE-08) : l'utilisateur a détaché de cet élément son document
   * d'ORIGINE (décision AGENDA_FILE_LINK) — l'origine n'est plus une preuve
   * de provenance pour rattacher l'élément à une Opération.
   */
  originLinkRejected?: boolean;
}

/**
 * Lot 87B (CODE-03, CODE-11) : rôle qu'une décision T4 VALIDÉE et appliquée
 * (réévaluation sémantique, journal 0752) a donné à un élément pour cette
 * Opération. `STEP` / `INDEPENDENT` / `DUPLICATE` (doublon d'une occurrence
 * conservée, resté par protection) : l'élément n'est plus un candidat à la
 * représentation de l'événement global (aucune nouvelle demande, aucune
 * carte). Lot 114O (#744) : `PRINCIPAL` est le vocabulaire du CONTRAT DE
 * SORTIE T4 (jamais persisté) — il est traduit en FAIT PORTÉ par le lien.
 */
export type T4RepresentationRole = 'PRINCIPAL' | 'STEP' | 'INDEPENDENT' | 'DUPLICATE';

// ── Projection attendue ────────────────────────────────────────────────────

type NoProjectionReason =
  | 'INACTIVE' | 'TYPE_NOT_PROJECTED' | 'NO_ASSET' | 'NO_DATE' | 'STATUS_NOT_PROJECTED' | 'CANCELLED' | 'EQUIVALENT_EXISTS'
  /** Carte #813 (D) : achat dont la seule preuve est une commande — aucun événement d'Agenda. */
  | 'ORDER_ONLY_EVIDENCE';

export interface DesiredProjection {
  /** Clé de projection (`projection_key` des suppressions). */
  key: string;
  nature: AgendaEventNature;
  businessType: string;
  /**
   * Date de l'événement ; null = aucune date établie (inconnue ou
   * contradictoire) — jamais inventée (F-140, P6) ; lot 83A : un événement
   * établi (`creatable`) est alors créé SANS date (§11.4).
   */
  date: string | null;
  title: string;
  category: 'action' | 'information';
  /** État métier à refléter : ouvert (à venir) ou réalisé. */
  target: 'OPEN' | 'REALIZED';
  /**
   * Un événement absent peut-il être CRÉÉ ? Échéance : actionnable (à venir).
   * Lot 83A : événement global RÉALISÉ (réalisation prouvée par une source
   * certaine, C8) — oui, avec ou sans date (§11.4).
   */
  creatable: boolean;
}

type ProjectionDecision =
  | { kind: 'PROJECT'; desired: DesiredProjection }
  | {
    kind: 'NONE';
    reason: NoProjectionReason;
    /**
     * Les éléments liés (utilisateur, T3, T4) restent-ils membres ? Non
     * seulement quand l'Opération n'est plus (invalidée, fusionnée). Lot 83A
     * (§6.1) : un type non projeté (regroupement non qualifié, financement…)
     * ne défait plus le regroupement — seules les projections intactes
     * partent.
     */
    keepLinks: boolean;
  };

/** Types métier de l'Agenda (EVENT_CATALOG) compatibles avec chaque type d'Opération. */
const COMPATIBLE_BUSINESS_TYPES: Readonly<Partial<Record<BusinessOperationTypeCode, readonly string[]>>> = {
  INTERVENTION: ['maintenance', 'repair', 'inspection', 'dpe'],
  CLAIM: ['claim'],
  ACQUISITION: ['purchase'],
  DISPOSAL: ['sale'],
  CONTRACT: ['contract', 'insurance', 'lease'],
};

/** Intitulés explicites d'un événement sans type métier (saisi à la main), sans accents. */
const TITLE_KEYWORDS: Readonly<Partial<Record<BusinessOperationTypeCode, RegExp>>> = {
  INTERVENTION: /\b(entretien|revision|reparation|reparer|controle|travaux|intervention|remplacement|installation|vidange|maintenance|diagnostic|depannage|ramonage|nettoyage|pose)\b/,
  CLAIM: /\b(sinistre|accident|degats?|vol|incendie|casse|constat|inondation|grele|bris)\b/,
  ACQUISITION: /\b(achat|acquisition|achete|achetee|acquis)\b/,
  DISPOSAL: /\b(vente|vendu|vendue|cession|cede|cedee|transmission|transmis|donation)\b/,
  CONTRACT: /\b(contrat|assurance|echeance|resiliation|renouvellement|bail|abonnement)\b/,
};

export const normalizeText = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Libellé technique présentable : une ligne, ≤ 80 caractères, jamais le mot « Opération » (P09). */
export function presentableLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/\s+/g, ' ').trim();
  if (!s || s.length > 80 || /op[ée]ration/i.test(s)) return null;
  return s;
}

/**
 * Clé de projection d'une Opération (null : type jamais projeté).
 * Lot 86C : la fin d'un contrat est UNIQUEMENT sa fin d'effet établie
 * (`contract_details.effective_to`, alimentée par les seules sources
 * contractuelles) — jamais la fin d'une période facturée (`end_date`).
 */
export function projectionKeyOf(op: Pick<OperationSnapshot, 'typeCode' | 'contractEffectiveTo'>): string | null {
  switch (op.typeCode) {
    case 'INTERVENTION':
    case 'CLAIM':
    case 'ACQUISITION':
    case 'DISPOSAL':
      return op.typeCode;
    case 'CONTRACT': {
      const d = op.contractEffectiveTo;
      return d ? `CONTRACT:END:${d}` : 'CONTRACT:END';
    }
    default:
      return null;
  }
}

/** Clé fonctionnelle de l'élément projeté (`agenda_items.functional_key`). */
export const projectionFunctionalKey = (operationId: number, key: string): string => `${PROJECTION_KEY_PREFIX}${operationId}:${key}`;

/** Clé de projection portée par une clé fonctionnelle de projection (null sinon). */
export function parseProjectionFunctionalKey(fk: string | null | undefined): { operationId: number; key: string } | null {
  if (!fk || !fk.startsWith(PROJECTION_KEY_PREFIX)) return null;
  const m = /^(\d+):(.+)$/.exec(fk.slice(PROJECTION_KEY_PREFIX.length));
  return m ? { operationId: Number(m[1]), key: m[2] } : null;
}

/** Décision C16 pour une Opération (pure). `today` : AAAA-MM-JJ. */
export function decideProjection(op: OperationSnapshot, today: string): ProjectionDecision {
  if (!op.active) return { kind: 'NONE', reason: 'INACTIVE', keepLinks: false };
  const key = projectionKeyOf(op);
  if (!key || !op.typeCode) return { kind: 'NONE', reason: 'TYPE_NOT_PROJECTED', keepLinks: true };
  // P08 : une Opération sans bien fiable ne nourrit pas les usages liés à un bien.
  if (op.assetIds.length === 0) return { kind: 'NONE', reason: 'NO_ASSET', keepLinks: true };
  const label = presentableLabel(op.technicalLabel);
  const provider = presentableLabel(op.provider);
  // Lot 83A (§11.8, AC20) : dates de réalisation contradictoires (T3) → aucune date retenue, arbitrage.
  const realise = establishedRealizedDate(op);

  switch (op.typeCode) {
    case 'INTERVENTION': {
      const title = label ?? (provider ? `Intervention — ${provider}` : 'Intervention');
      if (op.status === 'CANCELLED') return { kind: 'NONE', reason: 'CANCELLED', keepLinks: true };
      if (op.status === 'ENVISAGED') {
        // Une intervention seulement envisagée sans date n'est pas un événement établi : rien n'est créé.
        if (!op.plannedDate) return { kind: 'NONE', reason: 'NO_DATE', keepLinks: true };
        return { kind: 'PROJECT', desired: { key, nature: 'DEADLINE', businessType: 'maintenance', date: op.plannedDate, title, category: 'action', target: 'OPEN', creatable: true } };
      }
      // REALIZED (réalisation prouvée) : historique, daté si la date est établie ;
      // sinon SANS date (§11.4, aucune date inventée) — un événement planifié lié
      // est seulement complété (F-140).
      return { kind: 'PROJECT', desired: { key, nature: 'HISTORICAL', businessType: 'maintenance', date: realise, title, category: 'information', target: 'REALIZED', creatable: true } };
    }
    case 'CLAIM': {
      if (op.status !== 'REALIZED') return { kind: 'NONE', reason: 'STATUS_NOT_PROJECTED', keepLinks: true };
      // L'événement de l'historique choisi au formulaire Sinistre représente déjà la survenue.
      if (op.claimHistoryEventId !== null) return { kind: 'NONE', reason: 'EQUIVALENT_EXISTS', keepLinks: true };
      return { kind: 'PROJECT', desired: { key, nature: 'HISTORICAL', businessType: 'claim', date: realise, title: label ?? 'Sinistre', category: 'information', target: 'REALIZED', creatable: true } };
    }
    case 'ACQUISITION':
    case 'DISPOSAL': {
      if (op.status !== 'REALIZED') return { kind: 'NONE', reason: 'STATUS_NOT_PROJECTED', keepLinks: true };
      const acq = op.typeCode === 'ACQUISITION';
      // Carte #813 (D) — décision centrale : un bon de commande SEUL ne crée aucun événement « Achat », daté
      // ou non, quel que soit le statut enregistré (commande payée, statut antérieur à la correction T3). Une
      // projection intacte déjà créée est retirée par le plan (trace restaurable) ; un élément touché par
      // l'utilisateur reste, lié. Une date distincte et explicite (livraison, retrait) relève des événements
      // que T4 crée depuis le document, jamais d'un « Achat » par défaut.
      if (acq && op.orderOnlyEvidence === true) return { kind: 'NONE', reason: 'ORDER_ONLY_EVIDENCE', keepLinks: true };
      // Carte #813 (A) — règle remplacée : un achat légitime ne s'appelle plus « Achat » nu.
      // Carte #821 — règle remplacée : l'événement porte l'intitulé de l'opération (objet réellement acheté :
      // désignation, catégorie de dépense, bien dont l'acquisition est établie) ; sans intitulé descriptif, le libellé
      // neutre — jamais « Achat — <prestataire> » ni « Achat — <bien associé> ».
      const title = acq ? acquisitionEventTitle({ label })
        : op.disposalKind === 'TRANSMISSION' ? 'Transmission' : 'Vente';
      return { kind: 'PROJECT', desired: { key, nature: 'HISTORICAL', businessType: acq ? 'purchase' : 'sale', date: realise, title, category: 'information', target: 'REALIZED', creatable: true } };
    }
    case 'CONTRACT': {
      if (op.status === 'CANCELLED') return { kind: 'NONE', reason: 'CANCELLED', keepLinks: true };
      // Lot 86C : aucune échéance « Fin de contrat » sans fin d'effet ÉTABLIE (plus de
      // repli sur la fin de la dernière période facturée) ; une projection intacte
      // devenue injustifiée est retirée (trace restaurable), un élément touché reste.
      const date = op.contractEffectiveTo;
      if (!date) return { kind: 'NONE', reason: 'NO_DATE', keepLinks: true };
      // F-144 : seule une échéance ACTIONNABLE (à venir) est créée ; une
      // échéance passée déjà projetée reste telle quelle.
      return {
        kind: 'PROJECT',
        desired: { key, nature: 'DEADLINE', businessType: 'contract', date, title: provider ? `Fin de contrat — ${provider}` : 'Fin de contrat', category: 'action', target: 'OPEN', creatable: date >= today },
      };
    }
    default:
      return { kind: 'NONE', reason: 'TYPE_NOT_PROJECTED', keepLinks: true };
  }
}

/** Lot 83A : contradiction ouverte de T3 sur la date de réalisation (≥ 2 valeurs crédibles). */
export const realizedDateContested = (op: Pick<OperationSnapshot, 'realizedDateConflict'>): boolean =>
  new Set((op.realizedDateConflict ?? []).filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))).size >= 2;

/** Date de réalisation ÉTABLIE (pure) : celle de T3, sauf contradiction ouverte (§11.8 : conserver la date vide). */
export const establishedRealizedDate = (op: Pick<OperationSnapshot, 'realizedDate' | 'realizedDateConflict'>): string | null =>
  (realizedDateContested(op) ? null : op.realizedDate);


// ── Élément « touché » par l'utilisateur (convention §14.6) ────────────────

/** Lot 113P (#715) : plus de statut d'événement — touché = saisi ou modifié par l'utilisateur. */
export const isTouched = (i: Pick<AgendaItemSnapshot, 'isAutomatic' | 'isAutomaticModified'>): boolean =>
  !i.isAutomatic || i.isAutomaticModified;

/**
 * Carte #859 — autorité sur le TITRE d'un élément (pure), indépendante des autres champs : un élément automatique
 * dont seule la date a été corrigée garde un titre SYSTEM. Celle lue en base (`titleAuthority`) prime ; à défaut,
 * les seuls indicateurs (élément saisi → USER, jamais modifié → SYSTEM, modifié sans trace du champ → INCONNU).
 */
export const itemTitleAuthority = (i: Pick<AgendaItemSnapshot, 'title' | 'isAutomatic' | 'isAutomaticModified' | 'titleAuthority'>): TitleAuthorityDecision =>
  i.titleAuthority ?? agendaTitleAuthority({ title: i.title, isAutomatic: i.isAutomatic, isAutomaticModified: i.isAutomaticModified });

/** Carte #859 : le titre d'un événement d'ACHAT peut-il être amélioré automatiquement ? (titre SYSTEM prouvé seulement). */
export const purchaseTitleRenamable = (i: Pick<AgendaItemSnapshot, 'title' | 'isAutomatic' | 'isAutomaticModified' | 'titleAuthority'>): boolean =>
  i.isAutomatic && itemTitleAuthority(i).authority === 'SYSTEM';

// ── Rapprochement (C16.1) ──────────────────────────────────────────────────

const DAY = 86_400_000;
export function dayGap(a: string, b: string): number {
  const x = Date.parse(`${a}T00:00:00Z`);
  const y = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.MAX_SAFE_INTEGER;
  return Math.abs(Math.round((x - y) / DAY));
}

/**
 * Lot 53 (D14) : événements candidats d'un rapprochement incertain, par ordre de préférence.
 * Lot 87B (CODE-04) : `strong` — signaux FORTS sans provenance (même bien, type compatible ou
 * même intitulé, date dans la tolérance) : ce que l'ancienne règle rattachait d'office ; ce n'est
 * plus qu'un candidat soumis à T4 et, à défaut, à l'utilisateur (carte D14).
 */
interface ProbableCandidate { item: AgendaItemSnapshot; reason: string; strong?: boolean }

/**
 * Lot 87B (CODE-04) — PROVENANCE exacte d'un élément pour une Opération
 * (pure) : relié à un de ses documents, produit depuis un de ses documents
 * (origine non détachée par l'utilisateur), ou source AGENDA de l'Opération
 * établie par T3 (47B). Seule preuve qui permet au code de rattacher sans
 * décision T4 ; le bien, le type, l'intitulé et la date ne sont que des signaux.
 */
function hasOperationProvenance(op: Pick<OperationSnapshot, 'id' | 'documentFileIds'>, c: AgendaItemSnapshot): boolean {
  const docs = new Set(op.documentFileIds);
  return c.fileIds.some((f) => docs.has(f))
    || (c.originRefType === 'asset_file' && c.originRefId !== null && docs.has(c.originRefId) && c.originLinkRejected !== true)
    || (c.agendaSourceOperationIds ?? []).includes(op.id);
}
/** Candidats présentés au plus dans une carte (2 propositions affichées + « nouvel événement »). */
const PROBABLE_CANDIDATES_MAX = 3;

export type MatchResult =
  | { kind: 'certain'; item: AgendaItemSnapshot; reason: string }
  | { kind: 'probable'; item: AgendaItemSnapshot; reason: string; candidates: ProbableCandidate[] }
  | { kind: 'none' };

/**
 * Événement existant représentant la même réalité (pure). Les candidats sont
 * déjà restreints au compte, aux biens / documents de l'Opération, aux
 * éléments non annulés, datés, non liés à une autre Opération active.
 */
export function matchExistingItem(op: OperationSnapshot, desired: DesiredProjection, candidates: readonly AgendaItemSnapshot[]): MatchResult {
  if (!desired.date || !op.typeCode) return { kind: 'none' };
  const compatibles = COMPATIBLE_BUSINESS_TYPES[op.typeCode] ?? [];
  const motsCles = TITLE_KEYWORDS[op.typeCode];
  const biens = new Set(op.assetIds);

  type Scored = { item: AgendaItemSnapshot; score: number; reason: string };
  const certains: Scored[] = [];
  const probables: Array<ProbableCandidate & { ecart: number }> = [];

  for (const c of candidates) {
    if (!c.date) continue;
    if (c.businessOperationId !== null && c.businessOperationId !== op.id && c.linkedOperationActive) continue;
    if (c.projected) continue; // projection d'une autre Opération (ou orpheline) : jamais adoptée
    // Lot 87B : « même document » = provenance exacte (document lié, origine non détachée, source AGENDA T3).
    const memeDoc = hasOperationProvenance(op, c);
    const memeBien = c.assetIds.some((a) => biens.has(a));
    if (!memeDoc && !memeBien) continue;
    const conflitType = c.businessType !== null && !compatibles.includes(c.businessType);
    if (conflitType) continue;
    const typeOk = (c.businessType !== null && compatibles.includes(c.businessType))
      || (c.businessType === null && !!motsCles && motsCles.test(normalizeText(c.title)));
    const ecart = dayGap(c.date, desired.date);
    const planifieVersRealise = op.typeCode === 'INTERVENTION' && desired.nature === 'HISTORICAL' && c.nature !== 'HISTORICAL';
    const tolerance = planifieVersRealise ? PLANNED_TO_REALIZED_TOLERANCE_DAYS : MATCH_DATE_TOLERANCE_DAYS;
    const doublon = findDuplicate({ title: desired.title, date: desired.date }, [{
      id: c.id, title: c.title, date: c.date, category: null, manual: true, originFieldKey: null,
    }]);
    if (ecart <= tolerance && memeDoc) {
      certains.push({
        item: c,
        score: 4 + (typeOk ? 2 : 0) + (ecart === 0 ? 1 : 0),
        reason: ['même document', typeOk ? 'type compatible' : doublon.kind === 'exact' ? 'même intitulé' : null, `écart ${ecart} j`].filter(Boolean).join(', '),
      });
      continue;
    }
    // Lot 87B (CODE-04) : même bien + type compatible (ou même intitulé) + date proche ne sont que des
    // SIGNAUX — jamais un rattachement décidé par le code : candidat soumis à T4 (représentation) et,
    // à défaut, à l'utilisateur (carte « À traiter » existante, lot 53 D14).
    if (ecart <= tolerance && (typeOk || doublon.kind === 'exact')) {
      probables.push({ item: c, ecart, strong: true, reason: `signaux : même bien, ${typeOk ? 'type compatible' : 'même intitulé'}, écart ${ecart} j` });
      continue;
    }
    if (doublon.kind === 'probable' || (memeDoc && ecart <= SAME_DOCUMENT_PROBABLE_DAYS) || (typeOk && memeBien && ecart <= tolerance * 2)) {
      probables.push({ item: c, ecart, reason: doublon.kind === 'probable' ? doublon.reason : memeDoc ? `même document, écart ${ecart} j` : `type compatible, écart ${ecart} j` });
    }
  }

  if (certains.length) {
    certains.sort((a, b) => b.score - a.score || a.item.id - b.item.id);
    const [best, second] = certains;
    // Deux événements aussi plausibles : aucun choix arbitraire (lot 53, D14 : l'utilisateur choisit).
    if (second && second.score === best.score) {
      const ex = certains.filter((x) => x.score === best.score).slice(0, PROBABLE_CANDIDATES_MAX)
        .map((x) => ({ item: x.item, strong: true, reason: `plusieurs événements équivalents (${x.reason})` }));
      return { kind: 'probable', item: best.item, reason: 'plusieurs événements équivalents', candidates: ex };
    }
    return { kind: 'certain', item: best.item, reason: best.reason };
  }
  if (!probables.length) return { kind: 'none' };
  // Ordre stable : écart de date croissant, puis le plus ancien élément.
  // Lot 87B : signaux forts d'abord (ce sont eux que T4 / l'utilisateur doivent voir).
  probables.sort((a, b) => Number(b.strong === true) - Number(a.strong === true) || a.ecart - b.ecart || a.item.id - b.item.id);
  const retenus = probables.slice(0, PROBABLE_CANDIDATES_MAX).map(({ item, reason, strong }) => ({ item, reason, ...(strong ? { strong } : {}) }));
  return { kind: 'probable', item: retenus[0].item, reason: retenus[0].reason, candidates: retenus };
}

// ── Lot 76H : représentations équivalentes établies par T3 ─────────────────

/**
 * Types métier T4 qui peuvent décrire UNE MÊME intervention réalisée ou
 * prévue (entretien, réparation). Cette compatibilité ne prouve rien seule :
 * l'identité vient de T3 (`exclusiveFileIds`). Contrôle et DPE ne sont
 * jamais absorbés (événements réglementaires distincts).
 */
const CONSOLIDABLE_INTERVENTION_TYPES: readonly string[] = ['maintenance', 'repair'];

/**
 * Événements automatiques T4 qui REPRÉSENTENT l'Opération (pure) : produits
 * par un document dont T3 a consolidé toute la preuve d'intervention dans
 * cette Opération (`exclusiveFileIds`), sur un de ses biens, de type
 * entretien / réparation, de même nature, à la date de l'intervention
 * (±3 jours) — intacts (jamais touchés par l'utilisateur, ni « à qualifier »
 * ou « à confirmer »), non projetés, non liés à une autre Opération active.
 * Même document + même date + même bien ne suffit JAMAIS : sans décision
 * d'identité de T3 sur le document, la liste est vide.
 */
export function coveredEquivalents(op: OperationSnapshot, desired: DesiredProjection, pool: readonly AgendaItemSnapshot[]): AgendaItemSnapshot[] {
  if (!desired.date || !op.active) return [];
  // Lot 87B : sinistre, achat, cession — représentations T4 produites depuis un document SOURCE de
  // l'Opération (provenance T3), type métier compatible : mêmes gardes. Sélection de CANDIDATS : le
  // code ne fusionne plus jamais ces représentations (T4 décide, `REPRESENTATION_REQUIRED`).
  if (op.typeCode === 'CLAIM' || op.typeCode === 'ACQUISITION' || op.typeCode === 'DISPOSAL') return provenanceEquivalents(op, desired, pool);
  if (op.typeCode !== 'INTERVENTION') return [];
  const docs = new Set(op.exclusiveFileIds ?? []);
  if (!docs.size) return [];
  const biens = new Set(op.assetIds);
  const vus = new Set<number>();
  return pool.filter((c) => {
    if (vus.has(c.id)) return false;
    vus.add(c.id);
    return !!c.date && !c.projected && c.isAutomatic && !isTouched(c) && c.pendingStatus !== true
      // Lot 82D (V-Q4) : un élément qui PORTE un fait n'est jamais absorbé, ni un
      // élément que l'utilisateur a rattaché comme élément distinct (étape).
      && c.carriedFact == null && c.carrierOrigin !== 'USER'
      && (c.businessOperationId === null || c.businessOperationId === op.id || !c.linkedOperationActive)
      && c.originRefType === 'asset_file' && c.originRefId !== null && docs.has(c.originRefId) && c.originLinkRejected !== true
      && c.businessType !== null && CONSOLIDABLE_INTERVENTION_TYPES.includes(c.businessType)
      && (c.nature === null || c.nature === desired.nature)
      && c.assetIds.some((a) => biens.has(a))
      && dayGap(c.date, desired.date!) <= MATCH_DATE_TOLERANCE_DAYS;
  });
}

/** Lot 87B : représentations T4 d'un sinistre / achat / cession produites depuis ses documents sources (pure). */
function provenanceEquivalents(op: OperationSnapshot, desired: DesiredProjection, pool: readonly AgendaItemSnapshot[]): AgendaItemSnapshot[] {
  const docs = new Set(op.documentFileIds);
  if (!docs.size || !op.typeCode) return [];
  const compatibles = COMPATIBLE_BUSINESS_TYPES[op.typeCode] ?? [];
  const biens = new Set(op.assetIds);
  const vus = new Set<number>();
  return pool.filter((c) => {
    if (vus.has(c.id)) return false;
    vus.add(c.id);
    return !!c.date && !c.projected && c.isAutomatic && !isTouched(c) && c.pendingStatus !== true
      && c.carriedFact == null && c.carrierOrigin !== 'USER'
      && (c.businessOperationId === null || c.businessOperationId === op.id || !c.linkedOperationActive)
      && c.originRefType === 'asset_file' && c.originRefId !== null && docs.has(c.originRefId) && c.originLinkRejected !== true
      && (c.businessType === null || compatibles.includes(c.businessType))
      && (c.nature === null || c.nature === desired.nature)
      && c.assetIds.some((a) => biens.has(a))
      && dayGap(c.date, desired.date!) <= MATCH_DATE_TOLERANCE_DAYS;
  });
}

/**
 * ORDRE de présentation des candidats (pure, déterministe) : déjà lié à
 * l'Opération, puis date égale à celle de l'intervention, puis date lue dans
 * un champ explicite, puis le plus de sources documentaires, puis le plus
 * ancien. Lot 87B (CODE-04) : ne décide plus rien — il ordonne les
 * propositions d'une carte « À traiter » (D14) ; le principal d'une
 * consolidation est désigné par T4 (`semantic/`).
 */
export function choosePrincipal(items: readonly AgendaItemSnapshot[], operationId: number, date: string | null): AgendaItemSnapshot {
  const rang = (i: AgendaItemSnapshot): number[] => [
    i.businessOperationId === operationId ? 0 : 1,
    date && i.date === date ? 0 : 1,
    i.originFieldKey ? 0 : 1,
    -(i.sourceCount ?? 0),
    i.id,
  ];
  return [...items].sort((a, b) => {
    const x = rang(a);
    const y = rang(b);
    for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return x[k] - y[k];
    return 0;
  })[0];
}

/**
 * Intitulés génériques produits par T4 (`HISTORICAL_TITLES` + « — sujet » :
 * « Réparation — Maison », « Entretien réalisé — Prestation ») ou par la
 * projection sans libellé (« Intervention — prestataire »). Un intitulé
 * saisi ou précis (« Entretien chaudière ») n'est jamais générique.
 */
const GENERIC_T4_HEADS: ReadonlySet<string> = new Set(['reparation', 'entretien realise', 'controle realise', 'intervention']);
export const isGenericAgendaTitle = (title: string): boolean => GENERIC_T4_HEADS.has(normalizeText(title.split(' — ')[0] ?? ''));

/**
 * Description PRÉCISE de l'Opération (pure) : libellé technique présentable
 * (T1, preuve), qui dit QUELS travaux (mots porteurs de nature, au sens du
 * faisceau T3) et n'est pas lui-même générique. Sinon null : rien n'est
 * inventé.
 */
export function preciseOperationTitle(op: Pick<OperationSnapshot, 'technicalLabel'>): string | null {
  const label = presentableLabel(op.technicalLabel);
  if (!label || isGenericAgendaTitle(label) || natureTokens(label).size === 0) return null;
  return label;
}

// ── Plan d'une Opération ───────────────────────────────────────────────────

export interface ItemSync {
  title?: string;
  /** Lot 83A : null = date de la projection retirée (date d'origine retirée ou contestée, §11.8). */
  date?: string | null;
  nature?: AgendaEventNature;
  businessType?: string;
  homeCategory?: 'action' | 'information';
  functionalKey?: string;
  businessOperationId?: number;
  /** Lot 82D : `fileIds` absent pour un principal (documents propagés par le service de regroupement). */
  links?: { assetIds: number[]; equipmentIds: number[]; fileIds?: number[] };
}

/**
 * Carte #832 (§ 3.C) — cette action ne change-t-elle QU'UN INTITULÉ (pure) ?
 *
 * Règle UNIQUE, partagée par le passage « titre seulement » de la projection
 * (`service.ts`, option `titleOnly`) et par le rapport de la reprise des
 * intitulés d'achat (`nonTitleActions`) : un renommage, ou une synchronisation
 * dont le seul champ est le titre. Tout le reste — création, lien, date,
 * retrait, détachement, fait porté, représentation à décider — n'en est pas.
 */
export function isTitleOnlyAction(a: ProjectionAction): boolean {
  if (a.kind === 'RETITLE') return true;
  // Une synchronisation sans changement n'écrit rien : elle n'est pas « autre chose » qu'un titre
  // (même lecture que le rapport de reprise avant cette carte, parité stricte).
  return a.kind === 'SYNC' && Object.keys(a.changes).every((k) => k === 'title');
}

// ── Carte #860 : sélection des SEULS titres exécutables (mode « titre seulement ») ──

/**
 * Carte #860 (§ 3.B) — changement de titre EXTRAIT d'un plan normal : renommage (RETITLE) ou titre d'une
 * synchronisation (SYNC, mixte ou non). Le reste de la SYNC n'est JAMAIS exécuté en mode « titre seulement » : il
 * reste au plan informatif (`deferred`), pour la projection ordinaire.
 */
export interface TitleOnlyCandidate {
  itemId: number;
  /** Titre prévu par le plan normal. */
  title: string;
  /** Titre lu au moment du plan (valeur attendue revérifiée à l'écriture). */
  from: string;
  /** Action d'origine : RETITLE (écrivain `retitleAgendaItem`) ou titre d'une SYNC (écrivain dédié au titre). */
  source: 'RETITLE' | 'SYNC';
  /** SYNC : clé fonctionnelle, type et nature lus au plan — revérifiés à l'écriture (représentation inchangée). */
  expected?: { functionalKey: string | null; businessType: string | null; nature: string | null };
}

/** Carte #860 : motif stable d'un titre prévu par le plan mais NON isolable (abstention motivée, aucune écriture). */
export type TitleOnlyRefusalReason =
  /** L'élément n'est pas (encore) rattaché à cette Opération : le titre suppose un rattachement à venir. */
  | 'ITEM_NOT_LINKED_TO_OPERATION'
  /** Le plan rattache (ou fait porter le fait par) cet élément : le titre dépend de ce rattachement. */
  | 'TITLE_DEPENDS_ON_ATTACHMENT'
  /** Le plan retire ou détache cet élément : son titre n'a plus d'objet. */
  | 'TITLE_DEPENDS_ON_REMOVAL'
  /** Représentation ambiguë (décision T4 / carte de rapprochement) qui concerne cet élément. */
  | 'TITLE_DEPENDS_ON_REPRESENTATION'
  /** Le titre accompagne une requalification du type d'événement, de sa nature ou de sa clé de projection. */
  | 'TITLE_DEPENDS_ON_TYPE_CORRECTION' | 'TITLE_DEPENDS_ON_NATURE_CORRECTION' | 'TITLE_DEPENDS_ON_KEY_CHANGE'
  /** Événement saisi par l'utilisateur. */
  | 'MANUAL_ITEM'
  /** Titre USER ou de provenance INCONNUE (carte #859). */
  | 'TITLE_NOT_SYSTEM'
  /** Synchronisation d'une projection qui n'est plus intacte. */
  | 'PROJECTION_MODIFIED'
  /** Statut ouvert à l'utilisateur (« à qualifier », prévision à confirmer, consolidation restaurée). */
  | 'ITEM_PENDING_STATUS'
  /** Opération inactive (fusionnée, invalidée). */
  | 'OPERATION_INACTIVE'
  /** Le titre a changé depuis le plan (valeur attendue différente). */
  | 'TITLE_CHANGED_SINCE_PLAN'
  /** Deux titres différents prévus pour le même élément dans le même plan. */
  | 'CONFLICTING_TITLES';

export interface TitleOnlySelection {
  /** Titres exécutables en mode « titre seulement ». */
  executable: TitleOnlyCandidate[];
  /** Titres prévus mais non isolables, avec motif (aucune écriture). */
  refused: Array<Omit<TitleOnlyCandidate, 'expected'> & { reason: TitleOnlyRefusalReason; authority?: TitleAuthorityDecision }>;
  /**
   * Actions du plan normal NON exécutées en mode « titre seulement » (informatives) : toutes les actions autres que
   * les titres, et le RESTE d'une SYNC mixte (sans son titre). Les titres refusés restent dans leur action d'origine.
   */
  deferred: ProjectionAction[];
}

/**
 * Carte #860 (§ 3.B, § 3.C) — RÈGLE UNIQUE de sélection des titres exécutables en mode « titre seulement »,
 * partagée par la simulation, la projection `titleOnly` et la reprise des intitulés d'achat (pure).
 *
 * Un titre prévu par le plan normal (RETITLE, ou titre d'une SYNC — même mixte) n'est exécutable que si :
 *   · l'événement existe et est déjà rattaché à CETTE Opération, active (jamais un candidat que le plan prévoit de
 *     rattacher, jamais un élément que le plan retire, détache ou soumet à une décision de représentation) ;
 *   · le changement est INDÉPENDANT : une SYNC qui requalifie aussi le type, la nature, la clé ou l'appartenance
 *     n'en livre pas le titre (il décrit une autre représentation) ; date, catégorie et liens ne s'y opposent pas —
 *     ils restent en attente ;
 *   · l'événement est automatique, de titre SYSTEM prouvé (carte #859, `itemTitleAuthority`), sans statut ouvert ;
 *     une SYNC ne vise qu'une projection INTACTE.
 * Les mêmes gardes sont revérifiées atomiquement à l'écriture (WHERE de l'écrivain).
 */
export function selectTitleOnlyActions(p: {
  op: Pick<OperationSnapshot, 'id' | 'active'>;
  plan: readonly ProjectionAction[];
  linked: readonly AgendaItemSnapshot[];
}): TitleOnlySelection {
  const out: TitleOnlySelection = { executable: [], refused: [], deferred: [] };
  const rattaches = new Set<number>();
  const retires = new Set<number>();
  const ambigus = new Set<number>();
  for (const a of p.plan) {
    // Un fait porté (CARRY) sur l'emplacement déjà rattaché qualifie la relation sans changer de représentation : le
    // titre en reste indépendant. Un LINK, lui, fait d'un candidat ou d'un membre la représentation de l'Opération.
    if (a.kind === 'LINK') rattaches.add(a.itemId);
    if (a.kind === 'REMOVE' || a.kind === 'DETACH') retires.add(a.itemId);
    if (a.kind === 'REPRESENTATION_REQUIRED') for (const id of a.itemIds) ambigus.add(id);
    if (a.kind === 'ABSTAIN') {
      if (a.candidates?.length && a.itemId !== undefined) ambigus.add(a.itemId);
      for (const c of a.candidates ?? []) ambigus.add(c.itemId);
    }
  }
  const proposes: Array<{ c: TitleOnlyCandidate; sync?: ItemSync }> = [];
  for (const a of p.plan) {
    if (a.kind === 'RETITLE') {
      proposes.push({ c: { itemId: a.itemId, title: a.title, from: a.from, source: 'RETITLE' } });
      continue;
    }
    if (a.kind === 'SYNC') {
      const { title, ...reste } = a.changes;
      if (Object.keys(reste).length) out.deferred.push({ kind: 'SYNC', itemId: a.itemId, changes: reste });
      if (title === undefined) continue;
      const item = p.linked.find((i) => i.id === a.itemId);
      proposes.push({ c: { itemId: a.itemId, title, from: item?.title ?? '', source: 'SYNC' }, sync: a.changes });
      continue;
    }
    out.deferred.push(a);
  }
  const vus = new Map<number, string>();
  for (const { c, sync } of proposes) {
    const refuse = (reason: TitleOnlyRefusalReason, authority?: TitleAuthorityDecision) =>
      out.refused.push({ itemId: c.itemId, title: c.title, from: c.from, source: c.source, reason, ...(authority ? { authority } : {}) });
    if (vus.has(c.itemId)) {
      if (vus.get(c.itemId) !== c.title) {
        // Deux titres pour un même élément : aucun n'est exécuté.
        out.executable = out.executable.filter((x) => x.itemId !== c.itemId);
        refuse('CONFLICTING_TITLES');
      }
      continue;
    }
    vus.set(c.itemId, c.title);
    const item = p.linked.find((i) => i.id === c.itemId);
    if (!p.op.active) { refuse('OPERATION_INACTIVE'); continue; }
    if (!item || item.businessOperationId !== p.op.id) { refuse('ITEM_NOT_LINKED_TO_OPERATION'); continue; }
    if (retires.has(c.itemId)) { refuse('TITLE_DEPENDS_ON_REMOVAL'); continue; }
    if (rattaches.has(c.itemId) || sync?.businessOperationId !== undefined) { refuse('TITLE_DEPENDS_ON_ATTACHMENT'); continue; }
    if (ambigus.has(c.itemId)) { refuse('TITLE_DEPENDS_ON_REPRESENTATION'); continue; }
    if (sync?.businessType !== undefined) { refuse('TITLE_DEPENDS_ON_TYPE_CORRECTION'); continue; }
    if (sync?.nature !== undefined) { refuse('TITLE_DEPENDS_ON_NATURE_CORRECTION'); continue; }
    if (sync?.functionalKey !== undefined) { refuse('TITLE_DEPENDS_ON_KEY_CHANGE'); continue; }
    if (!item.isAutomatic) { refuse('MANUAL_ITEM'); continue; }
    const autorite = itemTitleAuthority(item);
    if (autorite.authority !== 'SYSTEM') { refuse('TITLE_NOT_SYSTEM', autorite); continue; }
    if (c.source === 'SYNC' && (!item.projected || isTouched(item))) { refuse('PROJECTION_MODIFIED'); continue; }
    if (item.pendingHold ?? item.pendingStatus) { refuse('ITEM_PENDING_STATUS'); continue; }
    if (item.title !== c.from) { refuse('TITLE_CHANGED_SINCE_PLAN'); continue; }
    if (c.title === c.from) continue; // aucun changement effectif : rien à écrire
    out.executable.push(c.source === 'SYNC'
      ? { ...c, expected: { functionalKey: item.functionalKey, businessType: item.businessType, nature: item.nature } }
      : c);
  }
  return out;
}

export type ProjectionAction =
  | { kind: 'CREATE'; desired: DesiredProjection; functionalKey: string }
  | { kind: 'SYNC'; itemId: number; changes: ItemSync }
  | { kind: 'LINK'; itemId: number; reason: string }
  // Lot 87B : l'action CONSOLIDATE (absorption décidée par la projection, lot 76H) est RETIRÉE — une
  // consolidation n'est plus appliquée que sur décision T4 validée (`semantic/apply.ts`).
  /**
   * Lot 87B (CODE-03, CODE-04) : plusieurs représentations possibles d'une
   * même Opération (doublons ? étapes distinctes ?) — AUCUNE écriture de la
   * projection : la décision est demandée à T4 (réévaluation sémantique,
   * `semantic/orchestrator.ts`) ; sans capacité T4, constat (aucune fusion).
   */
  | { kind: 'REPRESENTATION_REQUIRED'; itemIds: number[]; reason: string }
  /** Lot 76H : intitulé générique T4 d'un élément intact remplacé par la description précise de l'Opération. */
  | { kind: 'RETITLE'; itemId: number; title: string; from: string }
  | { kind: 'REMOVE'; itemId: number; reason: string }
  | { kind: 'DETACH'; itemId: number; reason: string }
  // Lot 113P (#715) : MARK_DONE / PROPOSE_DONE retirés — plus de statut d'événement.
  | {
    kind: 'ABSTAIN'; reason: string; itemId?: number;
    /** Lot 53 (D14) : rapprochement incertain — événements candidats et motif (carte « À traiter »). */
    candidates?: Array<{ itemId: number; title: string; date: string | null; reason: string }>;
    /** Clé de projection concernée (carte, décision « ne rien ajouter »). */
    key?: string;
  }
  | { kind: 'SUPPRESSED'; key: string }
  /**
   * Lot 114O (#744, remplace l'action ROLE du lot 82D) : FAIT que le lien de
   * cet élément porte pour l'Opération (`null` : il n'en porte aucun), appliqué
   * par le service de regroupement — un fait posé par l'utilisateur n'est
   * jamais repris. Qualification de la relation, jamais un rang.
   */
  | { kind: 'CARRY'; itemId: number; fact: string | null }
  /**
   * Lot 83A (§11.7, AC19) : date établie posée sur un principal AUTOMATIQUE
   * intact resté sans date (élément T4 d'un document) — jamais sur une saisie.
   */
  | { kind: 'DATE'; itemId: number; date: string };

export interface PlanInput {
  op: OperationSnapshot;
  decision: ProjectionDecision;
  /** Éléments liés à cette Opération (`business_operation_id`). */
  linked: readonly AgendaItemSnapshot[];
  /** Clés supprimées par l'utilisateur pour cette Opération. */
  suppressedKeys: ReadonlySet<string>;
  /** Pool de rapprochement (éléments du compte sur les biens / documents de l'Opération). */
  candidates: readonly AgendaItemSnapshot[];
  /** Éléments déjà retenus par une autre Opération dans ce passage. */
  taken?: ReadonlySet<number>;
  /**
   * Lot 53 (D14) : l'utilisateur a répondu « nouvel événement » à la carte de
   * rapprochement — création sans nouveau rapprochement (suppression utilisateur
   * toujours respectée).
   */
  forceCreate?: boolean;
  /**
   * Lot 84B (CDC v5 §10, §11.9 ; point ouvert 83A) : l'utilisateur a RETIRÉ
   * le rôle principal dans cette Opération (décision mémorisée) — aucun
   * principal n'y est reconnu, promu ni créé ; ses éléments restent.
   */
  principalWithdrawn?: boolean;
  /**
   * Lot 87B (CODE-03, CODE-11) : rôles donnés par la DERNIÈRE décision T4
   * appliquée pour cette Opération (élément → rôle). Une étape ou un
   * événement indépendant décidé par T4 n'est plus jamais candidat : la
   * projection ne redemande rien et ne pose aucune carte sur lui.
   */
  t4Roles?: ReadonlyMap<number, T4RepresentationRole>;
}

/** Lot 87B : T4 a décidé que cet élément n'est PAS l'événement global de l'Opération (étape, indépendant). */
const decideParT4 = (p: Pick<PlanInput, 't4Roles'>, i: AgendaItemSnapshot): boolean => {
  const r = p.t4Roles?.get(i.id);
  return r === 'STEP' || r === 'INDEPENDENT' || r === 'DUPLICATE';
};

const sameSet =(a: readonly number[], b: readonly number[]): boolean => {
  const x = [...new Set(a)].sort((m, n) => m - n);
  const y = [...new Set(b)].sort((m, n) => m - n);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Clé de projection portée par un élément PROJETÉ (null : clé illisible ou ancienne projection sans clé). */
const cleDe = (i: AgendaItemSnapshot): string | null => parseProjectionFunctionalKey(i.functionalKey)?.key ?? null;

/**
 * Lot 83A (CDC v5 O-7, E01, E04) / lot 114O (#744) — emplacement d'un
 * ÉVÉNEMENT GLOBAL : l'élément dont le lien PORTE un fait de l'Opération (quel
 * qu'en soit l'auteur ; le fait exact d'abord) ; à défaut la propre projection
 * de l'Opération représentant un événement global (même après requalification
 * du type), touchée ou non ; sinon AUCUN — un membre lié n'est jamais
 * l'emplacement du seul fait d'être lié (§6.5, AC34).
 */
function porteurEvenementGlobal(linked: readonly AgendaItemSnapshot[], key: string): AgendaItemSnapshot | null {
  const fait = factKeyOf(key);
  const porteurs = linked.filter((i) => i.carriedFact != null);
  const porteur = porteurs.find((i) => i.carriedFact === fait) ?? porteurs[0];
  if (porteur) return porteur;
  const propres = linked.filter((i) => i.projected && isGlobalEventFact(factKeyOf(cleDe(i) ?? key)));
  return propres.sort((a, b) => Number(cleDe(b) === key) - Number(cleDe(a) === key) || Number(isTouched(a)) - Number(isTouched(b)) || a.id - b.id)[0] ?? null;
}

/**
 * Emplacement d'une ÉCHÉANCE (fin de contrat : aucun fait porté) — règle de
 * représentation inchangée (lot 46 / 82D) : choix de l'utilisateur, saisi /
 * T4 avant projeté, intact après touché, plus ancien.
 */
function porteurEcheance(linked: readonly AgendaItemSnapshot[]): AgendaItemSnapshot | null {
  const choixUtilisateur = (i: AgendaItemSnapshot) => Number(i.carriedFact != null && i.carrierOrigin === 'USER');
  return [...linked].sort((a, b) => choixUtilisateur(b) - choixUtilisateur(a)
    || Number(a.projected) - Number(b.projected)
    || Number(isTouched(b)) - Number(isTouched(a)) || a.id - b.id)[0] ?? null;
}

/**
 * Fait VOULU par la projection pour son emplacement (lot 114O, #744) :
 * l'événement global fait porter son fait ; une échéance n'en fait porter
 * aucun (traduction de la table C16, sans hiérarchie).
 */
const faitVoulu = (key: string): string | null => (isGlobalEventFact(factKeyOf(key)) ? factKeyOf(key) : null);

/**
 * Action sur le FAIT PORTÉ si l'emplacement ne porte pas le fait voulu
 * (remplace l'action de rôle du lot 82D). Lot 83A : un fait posé par
 * l'UTILISATEUR n'est jamais modifié par la projection (§10, P8).
 */
function carryActions(item: AgendaItemSnapshot, key: string, principalWithdrawn = false): ProjectionAction[] {
  if (item.carriedFact === undefined || item.carrierOrigin === 'USER') return [];
  const voulu = faitVoulu(key);
  // Lot 84B : désignation retirée par l'utilisateur — jamais rétablie par la projection.
  if (voulu !== null && principalWithdrawn && item.carriedFact !== voulu) return [];
  return item.carriedFact === voulu ? [] : [{ kind: 'CARRY', itemId: item.id, fact: voulu }];
}

/**
 * Lot 83A (§11.10, AC52) : fait DÉDUIT (T4, T3, reprise) porté dans une
 * relation durable → retiré (l'élément et son lien restent, membre de plein
 * droit) ; jamais un choix de l'utilisateur. Même règle que l'invariant
 * O7-NO-INFERRED-PRINCIPAL.
 */
function durableRelationDemotions(op: OperationSnapshot, linked: readonly AgendaItemSnapshot[]): ProjectionAction[] {
  if (!isDurableRelation(op.typeCode)) return [];
  return linked.filter((i) => i.carriedFact != null && i.carrierOrigin !== 'USER')
    .map((i) => ({ kind: 'CARRY' as const, itemId: i.id, fact: null }));
}

/** Une action sur le fait porté par élément (la première l'emporte), ordre conservé. */
function uniqueRoles(actions: ProjectionAction[]): ProjectionAction[] {
  const vus = new Set<number>();
  return actions.filter((a) => {
    if (a.kind !== 'CARRY') return true;
    if (vus.has(a.itemId)) return false;
    vus.add(a.itemId);
    return true;
  });
}

/**
 * Lot 83A (§11.7, AC19) : date établie posée sur un principal automatique
 * intact (non projeté) resté sans date — jamais une saisie, jamais un statut
 * ouvert à l'utilisateur.
 */
function dateActions(item: AgendaItemSnapshot, d: DesiredProjection): ProjectionAction[] {
  if (!d.date || item.date || item.projected || !item.isAutomatic || isTouched(item) || item.pendingStatus) return [];
  return [{ kind: 'DATE', itemId: item.id, date: d.date }];
}

/**
 * Plan d'actions pour UNE Opération (pur, idempotent : un état à jour rend un plan vide).
 *
 * Lot 83A (CDC v5 O-7) — la projection n'agit que sur SA représentation :
 *   · événement global : emplacement = l'élément qui PORTE le fait, sinon sa
 *     propre projection (`porteurEvenementGlobal`) ; sans emplacement, l'événement est
 *     RECONNU parmi les éléments existants (rapprochement certain C16.1 ou
 *     représentations T4 établies par T3, 76H) — membres compris, mais un
 *     membre n'est jamais choisi parce qu'il est lié — sinon CRÉÉ, daté ou
 *     non (§11.3, §11.4) ;
 *   · échéance : règle de représentation inchangée, aucun fait porté ;
 *   · les autres membres ne sont ni promus, ni absorbés, ni détachés ;
 *     relation durable : aucun fait déduit (AC52).
 *
 * Lot 87B (ticket « orchestration T3/T4 », CODE-03, CODE-04) — le plan ne
 * DÉCIDE plus aucune identité d'occurrence : il rattache seulement sur
 * PROVENANCE exacte (document de l'Opération, source AGENDA établie par T3,
 * unique représentation T4 d'un document dont T3 a consolidé toute la
 * preuve) ; dès que plusieurs représentations sont possibles, ou qu'un
 * élément n'est que SIGNALÉ (même bien, type, intitulé, date proche), il
 * rend `REPRESENTATION_REQUIRED` (décision T4, `semantic/`) — avec, quand
 * rien ne représente encore l'événement, la carte D14 existante (choix de
 * l'utilisateur si T4 ne peut pas décider). Aucune absorption.
 */
export function planOperationProjection(p: PlanInput): ProjectionAction[] {
  const { op, decision } = p;
  const actions: ProjectionAction[] = [];

  if (decision.kind === 'NONE') {
    for (const i of p.linked) {
      if (i.projected && !isTouched(i)) actions.push({ kind: 'REMOVE', itemId: i.id, reason: decision.reason });
      else if (!decision.keepLinks) actions.push({ kind: 'DETACH', itemId: i.id, reason: decision.reason });
    }
    if (decision.keepLinks) actions.push(...durableRelationDemotions(op, p.linked.filter((i) => !(i.projected && !isTouched(i)))));
    return actions;
  }

  const d = decision.desired;
  const fk = projectionFunctionalKey(op.id, d.key);
  const evenementGlobal = isGlobalEventFact(factKeyOf(d.key));
  const item = evenementGlobal ? porteurEvenementGlobal(p.linked, d.key) : porteurEcheance(p.linked);

  // Lot 87B (CODE-03, CODE-11) : une étape ou un événement indépendant décidé par T4 n'est plus un candidat.
  const libre = (c: AgendaItemSnapshot) => !decideParT4(p, c);
  let demandeMembres: ProjectionAction | null = null;
  if (item && evenementGlobal && item.projected && !isTouched(item) && item.carrierOrigin !== 'USER' && d.date && !p.principalWithdrawn) {
    // Lot 83A (C16.1, V-Q4) : la propre projection INTACTE fait double emploi avec un membre qui représente
    // la même occurrence — vrai doublon : la projection est retirée, le membre porte le fait (AC15).
    // Lot 87B (CODE-04) : seulement sur PROVENANCE exacte (document de l'Opération, source AGENDA T3) ; même
    // bien + type + date ne sont que des signaux → décision T4 demandée, la projection reste. Une projection
    // qui porte une décision de l'utilisateur (lien détaché) ne cède jamais sa place automatiquement.
    const membres = p.linked.filter((i) => i.id !== item.id && !i.projected && i.carriedFact == null && libre(i));
    const reconnu = membres.length ? matchExistingItem(op, d, membres) : { kind: 'none' as const };
    if (reconnu.kind === 'certain' && item.userLinkDecision !== true) {
      return [
        { kind: 'REMOVE', itemId: item.id, reason: 'DUPLICATE_PROJECTION' },
        { kind: 'LINK', itemId: reconnu.item.id, reason: `élément du regroupement : ${reconnu.reason}` },
        // Carte #821 : le membre qui porte désormais l'achat prend l'intitulé de l'opération (élément automatique intact seulement).
        ...(op.typeCode === 'ACQUISITION' ? retitleActions(op, reconnu.item) : []),
      ];
    }
    const forts = reconnu.kind === 'certain' ? [reconnu.item] : reconnu.kind === 'probable' ? reconnu.candidates.filter((c) => c.strong).map((c) => c.item) : [];
    if (forts.length) demandeMembres = { kind: 'REPRESENTATION_REQUIRED', itemIds: [item.id, ...forts.map((x) => x.id)], reason: 'MEMBER_MAY_REPRESENT_EVENT' };
  }
  if (item) {
    // Doublons (fusion, lien posé à côté d'une projection) : propres projections INTACTES de la même
    // représentation retirées (C22 « unifier » — vrai doublon de l'emplacement). Lot 82D (V-Q4) : une
    // échéance d'une autre clé est une occurrence distincte ; lot 83A : un élément qui porte un fait
    // ou un membre non projeté ne l'est jamais.
    for (const autre of p.linked) {
      if (autre.id === item.id || !autre.projected || isTouched(autre) || autre.carriedFact != null) continue;
      const cle = cleDe(autre);
      const meme = evenementGlobal ? isGlobalEventFact(factKeyOf(cle ?? d.key)) : cle === null || cle === d.key;
      if (meme) actions.push({ kind: 'REMOVE', itemId: autre.id, reason: 'DUPLICATE_PROJECTION' });
    }
    actions.push(...occupiedSlotActions(p, d, fk, item));
    if (demandeMembres && !actions.some((a) => a.kind === 'REPRESENTATION_REQUIRED')) actions.push(demandeMembres);
    if (!evenementGlobal) actions.push(...durableRelationDemotions(op, p.linked));
    return uniqueRoles(actions);
  }

  if (p.suppressedKeys.has(d.key)) return [{ kind: 'SUPPRESSED', key: d.key }];
  // Lot 84B (§10, §11.9) : rôle principal retiré par l'utilisateur — ni reconnaissance, ni création.
  if (evenementGlobal && p.principalWithdrawn) return [{ kind: 'SUPPRESSED', key: d.key }];
  if (!d.date) {
    // §11.4 / AC17 : l'identité de l'événement est établie, sa date non — créé SANS date (jamais
    // inventée, jamais « Sans échéance ») ; aucun rapprochement sur une date absente.
    if (!d.creatable) return [{ kind: 'ABSTAIN', reason: 'NO_DATE' }];
    return [{ kind: 'CREATE', desired: d, functionalKey: fk }];
  }
  if (p.forceCreate) {
    if (!d.creatable) return [{ kind: 'ABSTAIN', reason: 'NOT_CREATABLE' }];
    return [{ kind: 'CREATE', desired: d, functionalKey: fk }];
  }
  const pool = (p.taken?.size ? p.candidates.filter((c) => !p.taken!.has(c.id)) : p.candidates).filter(libre);
  // Lot 83A : membres de l'Opération non projetés (étapes, saisies, éléments T3) — candidats à porter
  // le fait de l'événement global (AC15) ; « même Opération ≠ doublon » (§6.5) : un membre seulement
  // vaguement ressemblant n'est jamais l'objet d'une abstention.
  const membres = evenementGlobal ? p.linked.filter((i) => !i.projected && i.carriedFact == null && !pool.includes(i) && libre(i)) : [];
  // Lot 76H : T3 a établi que la preuve d'intervention de ces documents est CETTE Opération.
  const couverts = coveredEquivalents(op, d, [...pool, ...membres]);
  if (couverts.length) {
    // Les représentations d'une AUTRE intervention établie par T3 ne sont pas des candidates.
    const autres = matchExistingItem(op, d, pool.filter((c) => !couverts.includes(c)
      && !(c.coveredByOperationId != null && c.coveredByOperationId !== op.id)));
    if (couverts.length === 1 && autres.kind === 'none') {
      // Lot 76H / 87B : UNE seule représentation T4, produite depuis un document dont T3 a fait la preuve de
      // CETTE Opération — rattachement par provenance (aucune fusion, réversible) : elle la représente.
      const seul = couverts[0];
      actions.push({ kind: 'LINK', itemId: seul.id, reason: 'représentation établie par l’Opération (T3)' });
      actions.push(...retitleActions(op, seul));
      return actions;
    }
    // Lot 87B (CODE-03, CODE-04, V-Q4) : PLUSIEURS représentations possibles (doublons ? étapes
    // distinctes ? « visite puis réparation » ?) — le code ne fusionne pas, ne choisit pas : T4 décide ;
    // à défaut (contrat non livré), l'utilisateur choisit (carte D14 « plusieurs événements équivalents »).
    const concurrents = autres.kind === 'none' ? [] : (autres.kind === 'certain' ? [{ item: autres.item, reason: autres.reason }] : autres.candidates);
    const premier = choosePrincipal(couverts, op.id, d.date);
    const cands = [
      { itemId: premier.id, title: premier.title, date: premier.date, reason: 'événement du document de l’intervention' },
      ...couverts.filter((c) => c.id !== premier.id).map((c) => ({ itemId: c.id, title: c.title, date: c.date, reason: 'autre événement du document de l’intervention' })),
      ...concurrents.map((c) => ({ itemId: c.item.id, title: c.item.title, date: c.item.date, reason: c.reason })),
    ].slice(0, PROBABLE_CANDIDATES_MAX);
    return [
      { kind: 'ABSTAIN', reason: 'PROBABLE_EQUIVALENT: plusieurs représentations possibles', itemId: premier.id, key: d.key, candidates: cands },
      {
        kind: 'REPRESENTATION_REQUIRED', reason: concurrents.length ? 'COVERED_AND_OTHER_CANDIDATES' : 'SEVERAL_COVERED_REPRESENTATIONS',
        itemIds: [...new Set([...couverts.map((c) => c.id), ...concurrents.map((c) => c.item.id)])],
      },
    ];
  }
  // AC15 : un membre qui représente l'événement global avec PROVENANCE exacte porte son fait.
  const reconnu = membres.length ? matchExistingItem(op, d, membres) : { kind: 'none' as const };
  if (reconnu.kind === 'certain') {
    actions.push({ kind: 'LINK', itemId: reconnu.item.id, reason: `élément du regroupement : ${reconnu.reason}` });
    // Carte #821 : l'événement automatique intact du justificatif, rattaché par provenance, prend l'intitulé de l'achat.
    if (op.typeCode === 'ACQUISITION') actions.push(...retitleActions(op, reconnu.item));
    return actions;
  }
  // Lot 87B (CODE-04) : membre seulement SIGNALÉ (même bien, type compatible ou même intitulé, date proche)
  // — l'ancienne règle le promouvait d'office. Ni promotion, ni projection à côté : décision T4
  // demandée et, à défaut, carte D14 (« Oui, … » / « Non, ajouter un nouvel événement »).
  const membresForts = reconnu.kind === 'probable' ? reconnu.candidates.filter((c) => c.strong) : [];
  if (membresForts.length) {
    return [
      {
        kind: 'ABSTAIN', reason: `PROBABLE_EQUIVALENT: ${membresForts[0].reason}`, itemId: membresForts[0].item.id, key: d.key,
        candidates: membresForts.map((c) => ({ itemId: c.item.id, title: c.item.title, date: c.item.date, reason: c.reason })),
      },
      { kind: 'REPRESENTATION_REQUIRED', itemIds: membresForts.map((c) => c.item.id), reason: 'MEMBER_MAY_REPRESENT_EVENT' },
    ];
  }
  const m = matchExistingItem(op, d, pool);
  if (m.kind === 'probable') {
    // Lot 53 (D14) : carte « À traiter » existante ; lot 87B : la décision de représentation est aussi
    // demandée à T4 (rattachement ou événement indépendant), sans qu'aucune règle du code ne tranche.
    return [{
      kind: 'ABSTAIN', reason: `PROBABLE_EQUIVALENT: ${m.reason}`, itemId: m.item.id, key: d.key,
      candidates: m.candidates.map((c) => ({ itemId: c.item.id, title: c.item.title, date: c.item.date, reason: c.reason })),
    }, { kind: 'REPRESENTATION_REQUIRED', itemIds: m.candidates.map((c) => c.item.id), reason: 'UNCERTAIN_EXISTING_EVENT' }];
  }
  if (m.kind === 'certain') {
    actions.push({ kind: 'LINK', itemId: m.item.id, reason: m.reason });
    // Carte #821 : l'événement automatique intact du justificatif, rattaché par provenance, prend l'intitulé de l'achat.
    if (op.typeCode === 'ACQUISITION') actions.push(...retitleActions(op, m.item));
    return actions;
  }
  if (!d.creatable) return [{ kind: 'ABSTAIN', reason: 'NOT_CREATABLE' }];
  return [{ kind: 'CREATE', desired: d, functionalKey: fk }];
}

/** Emplacement occupé : convergence 76H, mise à jour de la projection intacte, sinon statut / intitulé / date / rôle. */
function occupiedSlotActions(p: PlanInput, d: DesiredProjection, fk: string, item: AgendaItemSnapshot): ProjectionAction[] {
  const { op } = p;
  const actions: ProjectionAction[] = [];
  // Lot 76H / 87B : autres représentations de l'Opération à côté de son emplacement (liées à elle, ou
  // créées avant / pendant la consolidation T3). Lot 82D / 83A (V-Q4) : ni un principal, ni un élément
  // rattaché par l'utilisateur (`coveredEquivalents`). Lot 87B : jamais absorbées par le code.
  if (d.date && item.date && dayGap(item.date, d.date) <= (item.nature !== d.nature ? PLANNED_TO_REALIZED_TOLERANCE_DAYS : MATCH_DATE_TOLERANCE_DAYS)) {
    const pool = [
      ...p.linked.filter((i) => i.id !== item.id),
      ...p.candidates.filter((c) => c.id !== item.id && c.businessOperationId !== op.id && !p.taken?.has(c.id)),
    ].filter((c) => !decideParT4(p, c));
    const couverts = coveredEquivalents(op, d, pool);
    const projectionTechnique = item.projected && !isTouched(item) && item.carrierOrigin !== 'USER' && item.userLinkDecision !== true && !p.principalWithdrawn;
    // Candidats NON liés à l'Opération (autre document, saisie, provenance sans exclusivité T3) : signaux.
    const autres = matchExistingItem(op, d, pool.filter((c) => c.businessOperationId !== op.id && !couverts.includes(c)
      && !(c.coveredByOperationId != null && c.coveredByOperationId !== op.id)));
    const autresForts = autres.kind === 'certain' ? [autres.item] : autres.kind === 'probable' ? autres.candidates.filter((c) => c.strong).map((c) => c.item) : [];
    // Représentation T4 à provenance EXACTE : couverte (T3 a consolidé toute la preuve du document dans cette
    // Opération), ou produite depuis un document dont CETTE Opération est la seule Opération active.
    const uniques = couverts.length ? couverts
      : autres.kind === 'certain' && soleProvenance(op, autres.item) ? [autres.item] : [];
    const concurrents = autresForts.filter((c) => !uniques.includes(c));
    if (uniques.length === 1 && !concurrents.length && projectionTechnique && uniques[0].businessOperationId !== op.id) {
      // Lot 87B : la projection TECHNIQUE (artefact du code, intacte, sans décision de l'utilisateur) CÈDE la
      // place à l'unique représentation T4 produite depuis un document dont T3 a fait la preuve de CETTE
      // Opération — retrait tracé et restaurable, rattachement par provenance ; aucune fusion de preuves.
      const seul = uniques[0];
      return [
        { kind: 'REMOVE', itemId: item.id, reason: 'PROJECTION_YIELDS_TO_T4_REPRESENTATION' },
        { kind: 'LINK', itemId: seul.id, reason: 'représentation établie par l’Opération (T3)' },
        ...retitleActions(op, seul),
      ];
    }
    // Lot 87B (CODE-03, V-Q4) : autres représentations possibles à côté de l'emplacement — la projection
    // ne les absorbe plus (l'ancienne règle 76H fusionnait sur provenance + type + date) : T4 décide.
    const ids = [...new Set([...couverts.map((c) => c.id), ...autresForts.map((c) => c.id)])];
    if (ids.length) actions.push({ kind: 'REPRESENTATION_REQUIRED', itemIds: [item.id, ...ids], reason: couverts.length ? 'EQUIVALENTS_BESIDE_SLOT' : 'CANDIDATES_BESIDE_SLOT' });
  }

  if (item.projected && !isTouched(item)) {
    const changes: ItemSync = {};
    // Carte #859 : le titre d'un achat ne se synchronise que s'il est SYSTEM (provenance du champ).
    if (item.title !== d.title && (op.typeCode !== 'ACQUISITION' || purchaseTitleRenamable(item))) changes.title = d.title;
    // Lot 83A (§11.7, §11.8) : la date établie est posée ; sans date établie, l'occurrence
    // planifiée garde sa date (F-140) mais un historique projeté perd la date qui n'est plus
    // établie (source retirée, dates contradictoires) — jamais une date conservée sans preuve.
    const date = d.date ?? (item.nature === 'HISTORICAL' ? null : item.date);
    if (item.date !== date) changes.date = date;
    const nature = d.date ? d.nature : item.nature ?? d.nature;
    if (item.nature !== nature) changes.nature = nature;
    if (item.businessType !== d.businessType) changes.businessType = d.businessType;
    const categorie = d.date ? d.category : (item.homeCategory as 'action' | 'information' | null) ?? d.category;
    if (item.homeCategory !== categorie) changes.homeCategory = categorie;
    if (item.functionalKey !== fk) changes.functionalKey = fk;
    if (item.businessOperationId !== op.id) changes.businessOperationId = op.id;
    // Lot 82D (§7.1) : les documents de l'Opération sont propagés vers son élément PORTEUR par le
    // service de regroupement (OPERATION_PRINCIPAL, refus utilisateur respectés) — la projection
    // ne les recopie plus ; une échéance garde ses liens directs (AI_DIRECT).
    const principalVoulu = isGlobalEventFact(factKeyOf(d.key));
    const links = principalVoulu
      ? { assetIds: op.assetIds, equipmentIds: op.equipmentIds }
      : { assetIds: op.assetIds, equipmentIds: op.equipmentIds, fileIds: op.documentFileIds };
    if (!sameSet(item.assetIds, links.assetIds) || !sameSet(item.equipmentIds, links.equipmentIds) || (!principalVoulu && !sameSet(item.fileIds, op.documentFileIds))) {
      changes.links = links;
    }
    if (Object.keys(changes).length) actions.push({ kind: 'SYNC', itemId: item.id, changes });
    actions.push(...carryActions(item, d.key, p.principalWithdrawn));
    return actions;
  }
  // Élément saisi, produit par T4, ou projeté puis modifié : jamais réécrit
  // (lot 113P : plus de statut posé) ; lot 76H : l'intitulé GÉNÉRIQUE d'un élément T4
  // intact cède à la description précise et prouvée de l'Opération ; lot
  // 83A : un élément T4 intact resté sans date reçoit la date établie.
  actions.push(...retitleActions(op, item));
  actions.push(...dateActions(item, d));
  actions.push(...carryActions(item, d.key, p.principalWithdrawn));
  return actions;
}

/**
 * Lot 87B : événement T4 intact produit depuis un document dont l'Opération
 * est la SEULE Opération active (provenance exacte, aucune décision
 * sémantique) — jamais un élément saisi, touché, à statut ouvert ou dont
 * l'utilisateur a détaché l'origine.
 */
function soleProvenance(op: OperationSnapshot, c: AgendaItemSnapshot): boolean {
  return c.isAutomatic && !c.projected && !isTouched(c) && c.pendingStatus !== true && c.carrierOrigin !== 'USER'
    && c.originLinkRejected !== true && c.originRefType === 'asset_file' && c.originSoleOperationId === op.id;
}

/**
 * Carte #832 (§ 3.B) — SUJET annoncé par un intitulé d'achat (pur).
 *
 * `null` : l'intitulé ne commence pas par le nom du type, ce n'est pas un
 * intitulé d'achat généré (« Plein du 20 novembre »).
 * `''`   : « Achat » seul, aucun sujet.
 * sinon  : le sujet normalisé, lu APRÈS le nom du type, que les générateurs
 *          aient écrit « Achat — Decathlon », « Achat Decathlon » ou
 *          « Achat  –  Decathlon ». `normalizeText` ramenant toute ponctuation
 *          à une espace, les trois donnent le même sujet : « decathlon ».
 */
export function purchaseTitleSubject(title: string): string | null {
  const n = normalizeText(title);
  const type = normalizeText(ACQUISITION_TYPE_NAME);
  if (!type) return null;
  if (n === type) return '';
  // Frontière de mot exigée : « Achatterie » n'est pas un intitulé d'achat.
  return n.startsWith(`${type} `) ? n.slice(type.length + 1).trim() : null;
}

/**
 * Carte #821 — intitulé AUTOMATIQUE d'achat qui ne dit pas ce qui a été acheté (pur) : la tête est le nom du type
 * (« Achat », celui du catalogue d'événements et de `HISTORICAL_TITLES`) et le sujet est absent, ou n'est que le
 * nom d'un bien associé, le prestataire, ou le titre d'un justificatif de l'Opération — aucun ne désigne l'objet
 * de l'achat. Tout autre intitulé (« Achat — Pneus hiver », « Achat du vélo ») est EXPLICITE.
 *
 * Carte #832 (§ 3.B) — LE SÉPARATEUR N'EST PLUS OBLIGATOIRE. La version
 * précédente découpait sur « ␣—␣ » seulement : « Achat Decathlon » et
 * « Achat Cupra », écrits SANS tiret par les générateurs d'intitulés, étaient
 * donc tenus pour explicites et conservés tels quels — c'est l'écart constaté
 * sur la capture du 22/11/2026. Le sujet est maintenant lu après le nom du
 * type quelle que soit la ponctuation (`purchaseTitleSubject`).
 *
 * Un vrai objet dont le nom coïncide avec celui d'un bien ou d'un prestataire
 * n'est pas perdu pour autant : cette fonction ne RENOMME rien. Elle ouvre
 * seulement la porte, et le renommage n'a lieu que si l'Opération, elle,
 * désigne l'objet (`precisePurchaseTitle` — qui applique la même règle et rend
 * `null` sinon). Une vraie acquisition du véhicule garde donc « Achat Cupra ».
 */
export function isUninformativePurchaseTitle(title: string, op: Pick<OperationSnapshot, 'assetNames' | 'provider' | 'documentTitles'>): boolean {
  const sujet = purchaseTitleSubject(title);
  if (sujet === null) return false;
  if (!sujet) return true;
  return [...(op.assetNames ?? []), op.provider, ...(op.documentTitles ?? [])].some((n) => !!n && normalizeText(n) === sujet);
}

/**
 * Carte #821 — intitulé PRÉCIS d'un achat (pur) : l'intitulé de l'Opération quand il dit ce qui a été acheté
 * (« Achat de carburant ») ; null : rien de plus précis que le type (rien n'est inventé).
 */
export function precisePurchaseTitle(op: Pick<OperationSnapshot, 'technicalLabel' | 'assetNames' | 'provider' | 'documentTitles'>): string | null {
  const titre = acquisitionEventTitle({ label: presentableLabel(op.technicalLabel) });
  return titre === ACQUISITION_TYPE_NAME || isUninformativePurchaseTitle(titre, op) ? null : titre;
}

/**
 * Lot 76H (§3.5) : intitulé T4 générique d'un élément automatique INTACT → description précise de l'Opération.
 * Carte #821 : même mécanisme pour un ACHAT — l'événement automatique intact produit depuis le justificatif
 * (« Achat », « Achat — Cupra ») reçoit l'intitulé de l'Opération, SUR L'ÉVÉNEMENT EXISTANT (même identifiant,
 * renommage journalisé et restaurable). Jamais un élément saisi, modifié, à statut ouvert, ni un intitulé explicite.
 */
function retitleActions(op: OperationSnapshot, item: AgendaItemSnapshot): ProjectionAction[] {
  if (op.typeCode === 'ACQUISITION') return purchaseRetitleActions(op, item);
  if (item.projected || !item.isAutomatic || isTouched(item) || item.pendingStatus) return [];
  if (op.typeCode !== 'INTERVENTION') return [];
  if (!isGenericAgendaTitle(item.title)) return [];
  const precis = preciseOperationTitle(op);
  return precis && precis !== item.title ? [{ kind: 'RETITLE', itemId: item.id, title: precis, from: item.title }] : [];
}

/**
 * Carte #859 — renommage d'un événement d'ACHAT (pur), décidé sur la provenance du SEUL champ titre : la correction
 * d'une date, d'un lien ou d'une description par l'utilisateur ne bloque plus l'amélioration d'un titre SYSTEM ; un
 * titre USER, un élément saisi ou une provenance INCONNUE ne sont jamais renommés. Les gardes indépendantes restent :
 * « à qualifier », prévision à confirmer, consolidation restaurée (`pendingHold`), type d'événement incompatible.
 *   · DOCUMENT (élément non projeté, action RETITLE) : intitulé non informatif seulement (#821, #832) ;
 *   · OPERATION (projection de l'opération déjà rattachée, modifiée par l'utilisateur — l'élément intact est
 *     synchronisé par SYNC) : action RETITLE, TITRE SEUL — jamais la date ni un autre champ.
 * Écriture : `retitleAgendaItem`, gardes revérifiées dans le WHERE (provenance du titre, valeur attendue, compte,
 * rattachement, opération d'achat active).
 */
function purchaseRetitleActions(op: OperationSnapshot, item: AgendaItemSnapshot): ProjectionAction[] {
  if (!purchaseTitleRenamable(item) || (item.pendingHold ?? item.pendingStatus)) return [];
  if (item.businessType !== null && !(COMPATIBLE_BUSINESS_TYPES.ACQUISITION ?? []).includes(item.businessType)) return [];
  if (item.projected) {
    // Projection intacte : SYNC ; projection d'une AUTRE opération : jamais.
    if (!isTouched(item) || item.businessOperationId !== op.id) return [];
  } else if (!isUninformativePurchaseTitle(item.title, op)) {
    return [];
  }
  const nom = precisePurchaseTitle(op);
  return nom && nom !== item.title ? [{ kind: 'RETITLE', itemId: item.id, title: nom, from: item.title }] : [];
}

// ── Anti-boucle (C16.2, C4) ────────────────────────────────────────────────

/**
 * Une modification d'agenda déclenche-t-elle T3 (déclencheur Agenda, C4) ?
 * Seulement un geste UTILISATEUR sur un élément lié à une Opération : une
 * écriture de la projection elle-même (origine OPERATION, aucun champ
 * utilisateur modifié) est un NO-OP — c'est ce qui casse la boucle
 * T3 → T4 → Agenda → T3 (17.1).
 */
export function agendaChangeTriggersT3(p: {
  businessOperationId: number | null;
  /** Écriture issue d'une projection (canal système). */
  fromProjection: boolean;
  /** Au moins un champ visible par l'utilisateur a changé (titre, dates, statut, liens) ou l'élément est supprimé. */
  userFieldsChanged: boolean;
  /**
   * Lot 47B (TRG-012) : élément NON lié saisi par l'utilisateur qui peut
   * établir une intervention (`agendaItemMayEstablishOperation`).
   */
  candidate?: boolean;
}): boolean {
  if (p.fromProjection) return false;
  if (p.businessOperationId === null && !p.candidate) return false;
  return p.userFieldsChanged;
}
