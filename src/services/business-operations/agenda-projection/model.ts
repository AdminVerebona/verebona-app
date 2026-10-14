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
 * Une Opération a AU PLUS UN emplacement d'agenda (clé de projection) :
 * l'intervention envisagée puis réalisée est la MÊME occurrence (C22 :
 * « l'événement prévu devient historique »). Le contrat porte la date de son
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
import type { AgendaEventNature } from '@/services/agenda/agenda-functional-key';
import type { BusinessOperationStatus, BusinessOperationTypeCode } from '../model';

/** Valeur de `agenda_items.projection_origin` d'un événement GÉNÉRÉ (0318). */
export const PROJECTION_ORIGIN = 'OPERATION';
/** `projection_kind` de `business_operation_projection_suppressions` (0316). */
export const PROJECTION_KIND_AGENDA = 'AGENDA';
/** `origin_ref_type` d'un événement projeté (texte libre, jamais `asset_file`). */
export const PROJECTION_ORIGIN_REF_TYPE = 'business_operation';
/** `origin_type` d'un événement projeté : déduit par règle d'une donnée consolidée. */
export const PROJECTION_ORIGIN_TYPE = 'deduced_rule';
/** Préfixe des clés fonctionnelles des projections (distinctes des clés par document, T4-08). */
export const PROJECTION_KEY_PREFIX = 'bo:v1:';

/** Tolérance de date d'un rapprochement certain (même que le dédoublonnage T4). */
export const MATCH_DATE_TOLERANCE_DAYS = 3;
/** Intervention planifiée ↔ réalisée : fenêtre « exacte » de T4-14. */
export const PLANNED_TO_REALIZED_TOLERANCE_DAYS = 7;
/** Même document, autre date : au-delà de la tolérance mais jusqu'ici, rapprochement PROBABLE. */
export const SAME_DOCUMENT_PROBABLE_DAYS = 30;

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
}

// ── Projection attendue ────────────────────────────────────────────────────

export type NoProjectionReason =
  | 'INACTIVE' | 'TYPE_NOT_PROJECTED' | 'NO_ASSET' | 'NO_DATE' | 'STATUS_NOT_PROJECTED' | 'CANCELLED' | 'EQUIVALENT_EXISTS';

export interface DesiredProjection {
  /** Clé de projection (`projection_key` des suppressions). */
  key: string;
  nature: AgendaEventNature;
  businessType: string;
  /** Date de l'événement ; null = aucune date connue (rien n'est créé, F-140). */
  date: string | null;
  title: string;
  category: 'action' | 'information';
  /** État métier à refléter : ouvert (à venir) ou réalisé. */
  target: 'OPEN' | 'REALIZED';
  /** Un événement absent peut-il être CRÉÉ (date connue, échéance actionnable) ? */
  creatable: boolean;
}

export type ProjectionDecision =
  | { kind: 'PROJECT'; desired: DesiredProjection }
  | {
    kind: 'NONE';
    reason: NoProjectionReason;
    /**
     * Les liens posés vers des événements existants (utilisateur, T4) sont-ils
     * conservés ? Non quand l'Opération n'est plus (invalidée, fusionnée) ou
     * n'est plus d'un type projeté ; oui sinon (date manquante, ancre de
     * l'historique, annulation…).
     */
    keepLinks: boolean;
  };

/** Types métier de l'Agenda (EVENT_CATALOG) compatibles avec chaque type d'Opération. */
export const COMPATIBLE_BUSINESS_TYPES: Readonly<Partial<Record<BusinessOperationTypeCode, readonly string[]>>> = {
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

/** Clé de projection d'une Opération (null : type jamais projeté). */
export function projectionKeyOf(op: Pick<OperationSnapshot, 'typeCode' | 'contractEffectiveTo' | 'endDate'>): string | null {
  switch (op.typeCode) {
    case 'INTERVENTION':
    case 'CLAIM':
    case 'ACQUISITION':
    case 'DISPOSAL':
      return op.typeCode;
    case 'CONTRACT': {
      const d = op.contractEffectiveTo ?? op.endDate;
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
  if (!key || !op.typeCode) return { kind: 'NONE', reason: 'TYPE_NOT_PROJECTED', keepLinks: false };
  // P08 : une Opération sans bien fiable ne nourrit pas les usages liés à un bien.
  if (op.assetIds.length === 0) return { kind: 'NONE', reason: 'NO_ASSET', keepLinks: true };
  const label = presentableLabel(op.technicalLabel);
  const provider = presentableLabel(op.provider);

  switch (op.typeCode) {
    case 'INTERVENTION': {
      const title = label ?? (provider ? `Intervention — ${provider}` : 'Intervention');
      if (op.status === 'CANCELLED') return { kind: 'NONE', reason: 'CANCELLED', keepLinks: true };
      if (op.status === 'ENVISAGED') {
        if (!op.plannedDate) return { kind: 'NONE', reason: 'NO_DATE', keepLinks: true };
        return { kind: 'PROJECT', desired: { key, nature: 'DEADLINE', businessType: 'maintenance', date: op.plannedDate, title, category: 'action', target: 'OPEN', creatable: true } };
      }
      // REALIZED : historique si la date de réalisation est connue ; sinon
      // l'événement planifié lié est seulement complété (aucune date inventée, F-140).
      if (op.realizedDate) {
        return { kind: 'PROJECT', desired: { key, nature: 'HISTORICAL', businessType: 'maintenance', date: op.realizedDate, title, category: 'information', target: 'REALIZED', creatable: true } };
      }
      return { kind: 'PROJECT', desired: { key, nature: 'DEADLINE', businessType: 'maintenance', date: null, title, category: 'action', target: 'REALIZED', creatable: false } };
    }
    case 'CLAIM': {
      if (op.status !== 'REALIZED') return { kind: 'NONE', reason: 'STATUS_NOT_PROJECTED', keepLinks: true };
      // L'événement de l'historique choisi au formulaire Sinistre représente déjà la survenue.
      if (op.claimHistoryEventId !== null) return { kind: 'NONE', reason: 'EQUIVALENT_EXISTS', keepLinks: true };
      if (!op.realizedDate) return { kind: 'NONE', reason: 'NO_DATE', keepLinks: true };
      return { kind: 'PROJECT', desired: { key, nature: 'HISTORICAL', businessType: 'claim', date: op.realizedDate, title: label ?? 'Sinistre', category: 'information', target: 'REALIZED', creatable: true } };
    }
    case 'ACQUISITION':
    case 'DISPOSAL': {
      if (op.status !== 'REALIZED') return { kind: 'NONE', reason: 'STATUS_NOT_PROJECTED', keepLinks: true };
      if (!op.realizedDate) return { kind: 'NONE', reason: 'NO_DATE', keepLinks: true };
      const acq = op.typeCode === 'ACQUISITION';
      const title = acq ? 'Achat' : op.disposalKind === 'TRANSMISSION' ? 'Transmission' : 'Vente';
      return { kind: 'PROJECT', desired: { key, nature: 'HISTORICAL', businessType: acq ? 'purchase' : 'sale', date: op.realizedDate, title, category: 'information', target: 'REALIZED', creatable: true } };
    }
    case 'CONTRACT': {
      if (op.status === 'CANCELLED') return { kind: 'NONE', reason: 'CANCELLED', keepLinks: true };
      const date = op.contractEffectiveTo ?? op.endDate;
      if (!date) return { kind: 'NONE', reason: 'NO_DATE', keepLinks: true };
      // F-144 : seule une échéance ACTIONNABLE (à venir) est créée ; une
      // échéance passée déjà projetée reste telle quelle.
      return {
        kind: 'PROJECT',
        desired: { key, nature: 'DEADLINE', businessType: 'contract', date, title: provider ? `Fin de contrat — ${provider}` : 'Fin de contrat', category: 'action', target: 'OPEN', creatable: date >= today },
      };
    }
    default:
      return { kind: 'NONE', reason: 'TYPE_NOT_PROJECTED', keepLinks: false };
  }
}

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

/** Lot 53 (D14) : événements candidats d'un rapprochement incertain, par ordre de préférence. */
export interface ProbableCandidate { item: AgendaItemSnapshot; reason: string }
/** Candidats présentés au plus dans une carte (2 propositions affichées + « nouvel événement »). */
export const PROBABLE_CANDIDATES_MAX = 3;

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
  const docs = new Set(op.documentFileIds);
  const biens = new Set(op.assetIds);

  type Scored = { item: AgendaItemSnapshot; score: number; reason: string };
  const certains: Scored[] = [];
  const probables: Array<ProbableCandidate & { ecart: number }> = [];

  for (const c of candidates) {
    if (!c.date || c.manualStatus === 'annule') continue;
    if (c.businessOperationId !== null && c.businessOperationId !== op.id && c.linkedOperationActive) continue;
    if (c.projected) continue; // projection d'une autre Opération (ou orpheline) : jamais adoptée
    const memeDoc = c.fileIds.some((f) => docs.has(f)) || (c.originRefType === 'asset_file' && c.originRefId !== null && docs.has(c.originRefId));
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
    if (ecart <= tolerance && (typeOk || memeDoc || doublon.kind === 'exact')) {
      certains.push({
        item: c,
        score: (memeDoc ? 4 : 0) + (typeOk ? 2 : 0) + (ecart === 0 ? 1 : 0),
        reason: [memeDoc ? 'même document' : 'même bien', typeOk ? 'type compatible' : doublon.kind === 'exact' ? 'même intitulé' : null, `écart ${ecart} j`].filter(Boolean).join(', '),
      });
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
        .map((x) => ({ item: x.item, reason: `plusieurs événements équivalents (${x.reason})` }));
      return { kind: 'probable', item: best.item, reason: 'plusieurs événements équivalents', candidates: ex };
    }
    return { kind: 'certain', item: best.item, reason: best.reason };
  }
  if (!probables.length) return { kind: 'none' };
  // Ordre stable : écart de date croissant, puis le plus ancien élément.
  probables.sort((a, b) => a.ecart - b.ecart || a.item.id - b.item.id);
  const retenus = probables.slice(0, PROBABLE_CANDIDATES_MAX).map(({ item, reason }) => ({ item, reason }));
  return { kind: 'probable', item: retenus[0].item, reason: retenus[0].reason, candidates: retenus };
}

// ── Plan d'une Opération ───────────────────────────────────────────────────

export interface ItemSync {
  title?: string;
  date?: string;
  nature?: AgendaEventNature;
  businessType?: string;
  homeCategory?: 'action' | 'information';
  functionalKey?: string;
  manualStatus?: 'realise';
  businessOperationId?: number;
  links?: { assetIds: number[]; equipmentIds: number[]; fileIds: number[] };
}

export type ProjectionAction =
  | { kind: 'CREATE'; desired: DesiredProjection; functionalKey: string }
  | { kind: 'SYNC'; itemId: number; changes: ItemSync }
  | { kind: 'LINK'; itemId: number; reason: string }
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
  | { kind: 'SUPPRESSED'; key: string };

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
}

const sameSet = (a: readonly number[], b: readonly number[]): boolean => {
  const x = [...new Set(a)].sort((m, n) => m - n);
  const y = [...new Set(b)].sort((m, n) => m - n);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Ordre de préférence de l'élément principal : saisi / T4 avant projeté, intact après touché, plus ancien. */
function principal(linked: readonly AgendaItemSnapshot[]): AgendaItemSnapshot {
  return [...linked].sort((a, b) => Number(a.projected) - Number(b.projected)
    || Number(isTouched(b)) - Number(isTouched(a)) || a.id - b.id)[0];
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

/** Plan d'actions pour UNE Opération (pur, idempotent : un état à jour rend un plan vide). */
export function planOperationProjection(p: PlanInput): ProjectionAction[] {
  const { op, decision } = p;
  const actions: ProjectionAction[] = [];
  const cards = p.statusCardItems ?? new Set<number>();

  if (decision.kind === 'NONE') {
    for (const i of p.linked) {
      if (i.projected && !isTouched(i)) actions.push({ kind: 'REMOVE', itemId: i.id, reason: decision.reason });
      else if (!decision.keepLinks) actions.push({ kind: 'DETACH', itemId: i.id, reason: decision.reason });
    }
    return actions;
  }

  const d = decision.desired;
  const fk = projectionFunctionalKey(op.id, d.key);
  let item: AgendaItemSnapshot | null = null;

  if (p.linked.length) {
    item = principal(p.linked);
    // Doublons (fusion, lien posé à côté d'une projection) : projections intactes retirées (C22 « unifier »).
    for (const autre of p.linked) {
      if (autre.id !== item.id && autre.projected && !isTouched(autre)) actions.push({ kind: 'REMOVE', itemId: autre.id, reason: 'DUPLICATE_PROJECTION' });
    }
  } else {
    if (p.suppressedKeys.has(d.key)) return [{ kind: 'SUPPRESSED', key: d.key }];
    if (!d.date) return [{ kind: 'ABSTAIN', reason: 'NO_DATE' }];
    if (p.forceCreate) {
      if (!d.creatable) return [{ kind: 'ABSTAIN', reason: 'NOT_CREATABLE' }];
      return [{ kind: 'CREATE', desired: d, functionalKey: fk }];
    }
    const pool = p.taken?.size ? p.candidates.filter((c) => !p.taken!.has(c.id)) : p.candidates;
    const m = matchExistingItem(op, d, pool);
    if (m.kind === 'probable') {
      return [{
        kind: 'ABSTAIN', reason: `PROBABLE_EQUIVALENT: ${m.reason}`, itemId: m.item.id, key: d.key,
        candidates: m.candidates.map((c) => ({ itemId: c.item.id, title: c.item.title, date: c.item.date, reason: c.reason })),
      }];
    }
    if (m.kind === 'certain') {
      actions.push({ kind: 'LINK', itemId: m.item.id, reason: m.reason });
      actions.push(...statusActions(op, m.item, d, cards));
      return actions;
    }
    if (!d.creatable) return [{ kind: 'ABSTAIN', reason: 'NOT_CREATABLE' }];
    return [{ kind: 'CREATE', desired: d, functionalKey: fk }];
  }

  // Élément principal présent.
  if (item.projected && !isTouched(item)) {
    const changes: ItemSync = {};
    if (item.title !== d.title) changes.title = d.title;
    if (d.date && item.date !== d.date) changes.date = d.date;
    // Sans date de réalisation (F-140) : l'occurrence planifiée garde sa date et sa nature, elle est marquée réalisée.
    const nature = d.date ? d.nature : item.nature ?? d.nature;
    if (item.nature !== nature) changes.nature = nature;
    if (item.businessType !== d.businessType) changes.businessType = d.businessType;
    const categorie = d.date ? d.category : (item.homeCategory as 'action' | 'information' | null) ?? d.category;
    if (item.homeCategory !== categorie) changes.homeCategory = categorie;
    if (item.functionalKey !== fk) changes.functionalKey = fk;
    if (item.businessOperationId !== op.id) changes.businessOperationId = op.id;
    if (!d.date && d.target === 'REALIZED' && nature !== 'HISTORICAL' && !item.manualStatus) changes.manualStatus = 'realise';
    const links = { assetIds: op.assetIds, equipmentIds: op.equipmentIds, fileIds: op.documentFileIds };
    if (!sameSet(item.assetIds, links.assetIds) || !sameSet(item.equipmentIds, links.equipmentIds) || !sameSet(item.fileIds, links.fileIds)) {
      changes.links = links;
    }
    if (Object.keys(changes).length) actions.push({ kind: 'SYNC', itemId: item.id, changes });
    return actions;
  }
  // Élément saisi, produit par T4, ou projeté puis modifié : jamais réécrit (titre, date) — statut seulement.
  actions.push(...statusActions(op, item, d, cards));
  return actions;
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
