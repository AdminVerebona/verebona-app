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
 *   ACQUISITION REALIZED     realized_date → historique d'entrée en possession
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
 * OPÉRATION, LA CLÉ DE PROJECTION EST CELLE DU PRINCIPAL. Une Opération
 * regroupe 0..N éléments d'agenda (étapes, rendez-vous, échéances…) ; la
 * projection ne gère QUE sa représentation : pour un événement global
 * (intervention, sinistre, achat, cession) l'emplacement est l'élément
 * PRINCIPAL (`operation_role`), à défaut sa propre projection ; les autres
 * membres restent des éléments autonomes — jamais promus parce qu'ils sont
 * liés, jamais absorbés, jamais détachés par la projection (seule
 * l'invalidation de l'Opération les libère). Principal FACULTATIF : aucun
 * principal n'est déduit pour une relation durable (contrat, financement,
 * §11.10, AC52) ni pour un regroupement non qualifié ; le principal par
 * document reste la décision de T4 (demande IA 82D-t4-principal, en attente).
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
import { isDurableRelation, projectionRoleOf, type OperationRole } from '../grouping/model';

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
  manualStatus: string | null;
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
   * Lot 82D (0652, CDC v5 §27.2) : rôle de l'élément dans son Opération
   * (PRINCIPAL | RELATED ; null hors Opération) et son auteur. `undefined` :
   * non lu (instantané de test) — aucune action de rôle n'est alors planifiée.
   */
  operationRole?: OperationRole | null;
  operationRoleOrigin?: string | null;
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
 * carte) ; `PRINCIPAL` est porté par le rôle lui-même.
 */
export type T4RepresentationRole = 'PRINCIPAL' | 'STEP' | 'INDEPENDENT' | 'DUPLICATE';

// ── Projection attendue ────────────────────────────────────────────────────

type NoProjectionReason =
  | 'INACTIVE' | 'TYPE_NOT_PROJECTED' | 'NO_ASSET' | 'NO_DATE' | 'STATUS_NOT_PROJECTED' | 'CANCELLED' | 'EQUIVALENT_EXISTS';

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
      const title = acq ? 'Achat' : op.disposalKind === 'TRANSMISSION' ? 'Transmission' : 'Vente';
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

export const isTouched = (i: Pick<AgendaItemSnapshot, 'isAutomatic' | 'isAutomaticModified' | 'manualStatus'>): boolean =>
  !i.isAutomatic || i.isAutomaticModified || (i.manualStatus !== null && i.manualStatus !== '');

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
    if (!c.date || c.manualStatus === 'annule') continue;
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
      id: c.id, title: c.title, date: c.date, category: null, status: c.manualStatus, manual: true, originFieldKey: null,
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
      // Lot 82D (V-Q4) : un principal n'est jamais absorbé, ni un élément
      // que l'utilisateur a rattaché comme élément distinct (étape).
      && c.operationRole !== 'PRINCIPAL' && c.operationRoleOrigin !== 'USER'
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
      && c.operationRole !== 'PRINCIPAL' && c.operationRoleOrigin !== 'USER'
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
  manualStatus?: 'realise';
  businessOperationId?: number;
  /** Lot 82D : `fileIds` absent pour un principal (documents propagés par le service de regroupement). */
  links?: { assetIds: number[]; equipmentIds: number[]; fileIds?: number[] };
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
  | { kind: 'MARK_DONE'; itemId: number }
  | { kind: 'PROPOSE_DONE'; itemId: number }
  | {
    kind: 'ABSTAIN'; reason: string; itemId?: number;
    /** Lot 53 (D14) : rapprochement incertain — événements candidats et motif (carte « À traiter »). */
    candidates?: Array<{ itemId: number; title: string; date: string | null; reason: string }>;
    /** Clé de projection concernée (carte, décision « ne rien ajouter »). */
    key?: string;
  }
  | { kind: 'SUPPRESSED'; key: string }
  /**
   * Lot 82D (CDC v5 §11, V-Q5) : rôle de l'élément qui représente
   * l'Opération selon la projection T4 (événement global → PRINCIPAL,
   * échéance → RELATED), appliqué par le service de regroupement (un
   * principal choisi par l'utilisateur n'est jamais remplacé).
   */
  | { kind: 'ROLE'; itemId: number; role: OperationRole }
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
  /** Éléments ayant déjà une carte de statut (ouverte ou tranchée) : jamais reproposée. */
  statusCardItems?: ReadonlySet<number>;
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
 * Lot 83A (CDC v5 O-7, E01, E04) — emplacement d'un ÉVÉNEMENT GLOBAL : la
 * clé de projection est celle du PRINCIPAL. L'élément principal de
 * l'Opération (quel qu'en soit l'auteur) ; à défaut la propre projection de
 * l'Opération représentant un événement global (clé PRINCIPAL, même après
 * requalification du type), touchée ou non ; sinon AUCUN — un membre lié
 * n'est jamais l'emplacement du seul fait d'être lié (§6.5, AC34).
 */
function principalSlot(linked: readonly AgendaItemSnapshot[], key: string): AgendaItemSnapshot | null {
  const principal = linked.find((i) => i.operationRole === 'PRINCIPAL');
  if (principal) return principal;
  const propres = linked.filter((i) => i.projected && projectionRoleOf(cleDe(i) ?? key) === 'PRINCIPAL');
  return propres.sort((a, b) => Number(cleDe(b) === key) - Number(cleDe(a) === key) || Number(isTouched(a)) - Number(isTouched(b)) || a.id - b.id)[0] ?? null;
}

/**
 * Emplacement d'une ÉCHÉANCE (clé RELATED : fin de contrat) — règle de
 * représentation inchangée (lot 46 / 82D) : choix de l'utilisateur, saisi /
 * T4 avant projeté, intact après touché, plus ancien.
 */
function deadlineSlot(linked: readonly AgendaItemSnapshot[]): AgendaItemSnapshot | null {
  const choixUtilisateur = (i: AgendaItemSnapshot) => Number(i.operationRole === 'PRINCIPAL' && i.operationRoleOrigin === 'USER');
  return [...linked].sort((a, b) => choixUtilisateur(b) - choixUtilisateur(a)
    || Number(a.projected) - Number(b.projected)
    || Number(isTouched(b)) - Number(isTouched(a)) || a.id - b.id)[0] ?? null;
}

/**
 * Action de rôle si l'élément représentatif n'a pas le rôle voulu par la
 * projection. Lot 83A : un rôle posé par l'UTILISATEUR n'est jamais modifié
 * par la projection (§10, P8).
 */
function roleActions(item: AgendaItemSnapshot, key: string, principalWithdrawn = false): ProjectionAction[] {
  if (item.operationRole === undefined || item.operationRoleOrigin === 'USER') return [];
  const voulu = projectionRoleOf(key);
  // Lot 84B : rôle principal retiré par l'utilisateur — jamais rétabli par la projection.
  if (voulu === 'PRINCIPAL' && principalWithdrawn && item.operationRole !== 'PRINCIPAL') return [];
  return item.operationRole === voulu ? [] : [{ kind: 'ROLE', itemId: item.id, role: voulu }];
}

/**
 * Lot 83A (§11.10, AC52) : principal DÉDUIT (T4, T3, reprise) d'une relation
 * durable → rétrogradé en élément lié (l'élément reste) ; jamais un choix de
 * l'utilisateur. Même règle que l'invariant O7-NO-INFERRED-PRINCIPAL.
 */
function durableRelationDemotions(op: OperationSnapshot, linked: readonly AgendaItemSnapshot[]): ProjectionAction[] {
  if (!isDurableRelation(op.typeCode)) return [];
  return linked.filter((i) => i.operationRole === 'PRINCIPAL' && i.operationRoleOrigin !== 'USER')
    .map((i) => ({ kind: 'ROLE' as const, itemId: i.id, role: 'RELATED' as const }));
}

/** Une action de rôle par élément (la première l'emporte), ordre conservé. */
function uniqueRoles(actions: ProjectionAction[]): ProjectionAction[] {
  const vus = new Set<number>();
  return actions.filter((a) => {
    if (a.kind !== 'ROLE') return true;
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
 * Statut d'un élément lié non projeté (ou projeté touché) quand une
 * INTERVENTION est réalisée (C16.1 « à la réalisation ») — seul type qui
 * passe d'un état prévu à un état réalisé ; un sinistre, un achat, une
 * cession naissent réalisés (aucune carte pour un fait passé saisi).
 */
function statusActions(op: OperationSnapshot, item: AgendaItemSnapshot, desired: DesiredProjection, cards: ReadonlySet<number>): ProjectionAction[] {
  if (op.typeCode !== 'INTERVENTION' || desired.target !== 'REALIZED') return [];
  if (item.manualStatus || item.nature === 'HISTORICAL') return [];
  // Élément automatique intact (T4) : marqué réalisé ; sinon proposé, une seule fois.
  if (!item.projected && !isTouched(item)) return [{ kind: 'MARK_DONE', itemId: item.id }];
  if (cards.has(item.id)) return [];
  return [{ kind: 'PROPOSE_DONE', itemId: item.id }];
}

/**
 * Plan d'actions pour UNE Opération (pur, idempotent : un état à jour rend un plan vide).
 *
 * Lot 83A (CDC v5 O-7) — la projection n'agit que sur SA représentation :
 *   · événement global (clé PRINCIPAL) : emplacement = principal, sinon sa
 *     propre projection (`principalSlot`) ; sans emplacement, l'événement est
 *     RECONNU parmi les éléments existants (rapprochement certain C16.1 ou
 *     représentations T4 établies par T3, 76H) — membres compris, mais un
 *     membre n'est jamais choisi parce qu'il est lié — sinon CRÉÉ, daté ou
 *     non (§11.3, §11.4) ;
 *   · échéance (clé RELATED) : règle de représentation inchangée ;
 *   · les autres membres ne sont ni promus, ni absorbés, ni détachés ;
 *     relation durable : aucun principal déduit (AC52).
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
  const cards = p.statusCardItems ?? new Set<number>();

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
  const evenementGlobal = projectionRoleOf(d.key) === 'PRINCIPAL';
  const item = evenementGlobal ? principalSlot(p.linked, d.key) : deadlineSlot(p.linked);

  // Lot 87B (CODE-03, CODE-11) : une étape ou un événement indépendant décidé par T4 n'est plus un candidat.
  const libre = (c: AgendaItemSnapshot) => !decideParT4(p, c);
  let demandeMembres: ProjectionAction | null = null;
  if (item && evenementGlobal && item.projected && !isTouched(item) && item.operationRoleOrigin !== 'USER' && d.date && !p.principalWithdrawn) {
    // Lot 83A (C16.1, V-Q4) : la propre projection INTACTE fait double emploi avec un membre qui représente
    // la même occurrence — vrai doublon : la projection est retirée, le membre devient le principal (AC15).
    // Lot 87B (CODE-04) : seulement sur PROVENANCE exacte (document de l'Opération, source AGENDA T3) ; même
    // bien + type + date ne sont que des signaux → décision T4 demandée, la projection reste. Une projection
    // qui porte une décision de l'utilisateur (lien détaché) ne cède jamais sa place automatiquement.
    const membres = p.linked.filter((i) => i.id !== item.id && !i.projected && i.operationRole !== 'PRINCIPAL' && libre(i));
    const reconnu = membres.length ? matchExistingItem(op, d, membres) : { kind: 'none' as const };
    if (reconnu.kind === 'certain' && item.userLinkDecision !== true) {
      return [
        { kind: 'REMOVE', itemId: item.id, reason: 'DUPLICATE_PROJECTION' },
        { kind: 'LINK', itemId: reconnu.item.id, reason: `élément du regroupement : ${reconnu.reason}` },
        ...statusActions(op, reconnu.item, d, cards),
      ];
    }
    const forts = reconnu.kind === 'certain' ? [reconnu.item] : reconnu.kind === 'probable' ? reconnu.candidates.filter((c) => c.strong).map((c) => c.item) : [];
    if (forts.length) demandeMembres = { kind: 'REPRESENTATION_REQUIRED', itemIds: [item.id, ...forts.map((x) => x.id)], reason: 'MEMBER_MAY_REPRESENT_EVENT' };
  }
  if (item) {
    // Doublons (fusion, lien posé à côté d'une projection) : propres projections INTACTES de la même
    // représentation retirées (C22 « unifier » — vrai doublon de l'emplacement). Lot 82D (V-Q4) : une
    // échéance d'une autre clé est une occurrence distincte ; lot 83A : un élément principal ou un
    // membre non projeté ne l'est jamais.
    for (const autre of p.linked) {
      if (autre.id === item.id || !autre.projected || isTouched(autre) || autre.operationRole === 'PRINCIPAL') continue;
      const cle = cleDe(autre);
      const meme = evenementGlobal ? projectionRoleOf(cle ?? d.key) === 'PRINCIPAL' : cle === null || cle === d.key;
      if (meme) actions.push({ kind: 'REMOVE', itemId: autre.id, reason: 'DUPLICATE_PROJECTION' });
    }
    actions.push(...occupiedSlotActions(p, d, fk, item, cards));
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
  // Lot 83A : membres de l'Opération non projetés (étapes, saisies, éléments T3) — candidats à la
  // reconnaissance du principal (AC15) ; « même Opération ≠ doublon » (§6.5) : un membre seulement
  // vaguement ressemblant n'est jamais l'objet d'une abstention.
  const membres = evenementGlobal ? p.linked.filter((i) => !i.projected && i.operationRole !== 'PRINCIPAL' && !pool.includes(i) && libre(i)) : [];
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
      actions.push(...statusActions(op, seul, d, cards));
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
  // AC15 : un membre qui représente l'événement global avec PROVENANCE exacte devient le principal.
  const reconnu = membres.length ? matchExistingItem(op, d, membres) : { kind: 'none' as const };
  if (reconnu.kind === 'certain') {
    actions.push({ kind: 'LINK', itemId: reconnu.item.id, reason: `élément du regroupement : ${reconnu.reason}` });
    actions.push(...statusActions(op, reconnu.item, d, cards));
    return actions;
  }
  // Lot 87B (CODE-04) : membre seulement SIGNALÉ (même bien, type compatible ou même intitulé, date proche)
  // — l'ancienne règle le promouvait principal d'office. Ni promotion, ni projection à côté : décision T4
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
    actions.push(...statusActions(op, m.item, d, cards));
    return actions;
  }
  if (!d.creatable) return [{ kind: 'ABSTAIN', reason: 'NOT_CREATABLE' }];
  return [{ kind: 'CREATE', desired: d, functionalKey: fk }];
}

/** Emplacement occupé : convergence 76H, mise à jour de la projection intacte, sinon statut / intitulé / date / rôle. */
function occupiedSlotActions(p: PlanInput, d: DesiredProjection, fk: string, item: AgendaItemSnapshot, cards: ReadonlySet<number>): ProjectionAction[] {
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
    const projectionTechnique = item.projected && !isTouched(item) && item.operationRoleOrigin !== 'USER' && item.userLinkDecision !== true && !p.principalWithdrawn;
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
        ...statusActions(op, seul, d, cards),
      ];
    }
    // Lot 87B (CODE-03, V-Q4) : autres représentations possibles à côté de l'emplacement — la projection
    // ne les absorbe plus (l'ancienne règle 76H fusionnait sur provenance + type + date) : T4 décide.
    const ids = [...new Set([...couverts.map((c) => c.id), ...autresForts.map((c) => c.id)])];
    if (ids.length) actions.push({ kind: 'REPRESENTATION_REQUIRED', itemIds: [item.id, ...ids], reason: couverts.length ? 'EQUIVALENTS_BESIDE_SLOT' : 'CANDIDATES_BESIDE_SLOT' });
  }

  if (item.projected && !isTouched(item)) {
    const changes: ItemSync = {};
    if (item.title !== d.title) changes.title = d.title;
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
    if (!d.date && d.target === 'REALIZED' && nature !== 'HISTORICAL' && !item.manualStatus) changes.manualStatus = 'realise';
    // Lot 82D (§7.1) : les documents d'un PRINCIPAL sont propagés par le service de
    // regroupement (OPERATION_PRINCIPAL, refus utilisateur respectés) — la projection
    // ne les recopie plus ; une échéance garde ses liens directs (AI_DIRECT).
    const principalVoulu = projectionRoleOf(d.key) === 'PRINCIPAL';
    const links = principalVoulu
      ? { assetIds: op.assetIds, equipmentIds: op.equipmentIds }
      : { assetIds: op.assetIds, equipmentIds: op.equipmentIds, fileIds: op.documentFileIds };
    if (!sameSet(item.assetIds, links.assetIds) || !sameSet(item.equipmentIds, links.equipmentIds) || (!principalVoulu && !sameSet(item.fileIds, op.documentFileIds))) {
      changes.links = links;
    }
    if (Object.keys(changes).length) actions.push({ kind: 'SYNC', itemId: item.id, changes });
    actions.push(...roleActions(item, d.key, p.principalWithdrawn));
    return actions;
  }
  // Élément saisi, produit par T4, ou projeté puis modifié : jamais réécrit
  // — statut seulement ; lot 76H : l'intitulé GÉNÉRIQUE d'un élément T4
  // intact cède à la description précise et prouvée de l'Opération ; lot
  // 83A : un élément T4 intact resté sans date reçoit la date établie.
  actions.push(...retitleActions(op, item));
  actions.push(...dateActions(item, d));
  actions.push(...statusActions(op, item, d, cards));
  actions.push(...roleActions(item, d.key, p.principalWithdrawn));
  return actions;
}

/**
 * Lot 87B : événement T4 intact produit depuis un document dont l'Opération
 * est la SEULE Opération active (provenance exacte, aucune décision
 * sémantique) — jamais un élément saisi, touché, à statut ouvert ou dont
 * l'utilisateur a détaché l'origine.
 */
function soleProvenance(op: OperationSnapshot, c: AgendaItemSnapshot): boolean {
  return c.isAutomatic && !c.projected && !isTouched(c) && c.pendingStatus !== true && c.operationRoleOrigin !== 'USER'
    && c.originLinkRejected !== true && c.originRefType === 'asset_file' && c.originSoleOperationId === op.id;
}

/** Lot 76H (§3.5) : intitulé T4 générique d'un élément automatique INTACT → description précise de l'Opération. */
function retitleActions(op: OperationSnapshot, item: AgendaItemSnapshot): ProjectionAction[] {
  if (op.typeCode !== 'INTERVENTION' || item.projected || !item.isAutomatic || isTouched(item) || item.pendingStatus) return [];
  if (!isGenericAgendaTitle(item.title)) return [];
  const precis = preciseOperationTitle(op);
  return precis && precis !== item.title ? [{ kind: 'RETITLE', itemId: item.id, title: precis, from: item.title }] : [];
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
