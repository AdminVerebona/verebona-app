/**
 * Sinistre = Opération CLAIM — règles PURES (lot 44, O5 ; refonte lot 83D,
 * CDC « Opérations, Agenda, Timeline, Sinistres v5 » §15 à §18 ; arbitrages
 * PO V-Q1, V-Q2, V-Q8 du 23/10/2026).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE SINISTRE N'A PLUS D'ÉCRAN NI DE FORMULAIRE (V-Q1)
 *
 * Le concept est porté par l'Opération CLAIM consolidée par T3 depuis les
 * documents, ses éléments d'Agenda (principal + étapes = chronologie), ses
 * documents (photos et justificatifs reliés, jamais dupliqués), ses Pièces
 * et équipements (82D) et ses données d'assurance utiles et sourcées :
 *
 *   claim_details      type, date de déclaration, référence assureur,
 *                      police / contrat, avancement du dossier, circonstances,
 *                      conséquences, mesures, estimation (§17.1) ;
 *   claim_damages      dommages détaillés et leurs photos / justificatifs
 *                      (données d'assurance conservées, V-Q8 — sans écran
 *                      de saisie) ;
 *   composantes        indemnité (INDEMNITY), coût réel (REALIZED_COST).
 *
 * Retirés (V-Q2, lot 83D) : actions et échanges propres au mini-module
 * (§18.1 : une étape est un élément d'Agenda ; §18.2 : un échange est un
 * document), intervention ENFANT d'un sinistre (§18.4, AC39), forme
 * « sous-rubrique » `claim_json` et sa migration.
 *
 * Aucun accès base ici : lecture `read.ts`. Le mot « Opération » n'apparaît
 * jamais côté utilisateur (P09).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { CLAIM_TYPE_OPTIONS } from '@/lib/assets/additional-infos';
import type { BusinessOperationStatus, ClaimFileStatus } from '../model';

// ── Lecture : enregistrement d'un sinistre ─────────────────────────────────

export interface ClaimDetailsRecord {
  claimType: string | null;
  declaredOn: string | null;
  insurerClaimRef: string | null;
  insuranceContractOperationId: number | null;
  policyReferenceText: string | null;
  status: ClaimFileStatus | null;
  statusDetail: string | null;
  circumstances: string | null;
  consequences: string | null;
  measuresSummary: string | null;
  exchangesSummary: string | null;
  estimatedDamageMinor: number | null;
  /** Événement de l'historique (`events`) désigné comme ancre (lot 44) ; lu pour la chronologie. */
  historyEventId: number | null;
}

/** Dommage détaillé (V-Q8) : photos (`asset_photos`) et justificatifs (`asset_files`) RELIÉS, jamais copiés. */
export interface ClaimDamageRecord {
  itemKey: string | null;
  zone: string;
  element: string | null;
  finding: string | null;
  estimatedAmountMinor: number | null;
  fileIds: number[];
  photoIds: number[];
}

/** Élément d'Agenda de l'Opération (chronologie §16) : le principal d'abord, puis les étapes par date. */
export interface ClaimAgendaRecord {
  id: number;
  title: string;
  date: string | null;
  role: 'PRINCIPAL' | 'RELATED';
}

export interface ClaimCosts {
  /** Coût réel (REALIZED_COST du sinistre), en centimes EUR — jamais diminué (Q4). */
  grossCents: number;
  /** Indemnités (INDEMNITY), en centimes EUR. */
  indemnityCents: number;
  /** Coût net = brut − indemnité (peut être négatif si l'indemnité dépasse le coût connu). */
  netCents: number;
  /** Lot 54D (§4.3) : avoirs et remboursements (REDUCTION, REFUND) ; reste à charge complet. */
  reductionsCents?: number;
  outOfPocketCents?: number;
  /** Lot 54D (E09) : montants SANS contre-valeur EUR établie, jamais comptés 0 € ; `complete` faux dès qu'il en existe. */
  unconverted?: Array<{ kind: string; amountMinor: number; currency: string }>;
  complete?: boolean;
}

export interface ClaimRecord {
  id: number;
  accountId: number;
  /** Verrou optimiste (business_operations.version). */
  version: number;
  status: BusinessOperationStatus;
  /** Date de survenue. */
  realizedDate: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  assets: Array<{ assetId: number; role: 'PRIMARY' | 'CONCERNED' }>;
  details: ClaimDetailsRecord | null;
  damages: ClaimDamageRecord[];
  /** Tous les documents ACTIFS de l'Opération (`business_operation_documents`, 82D), du compte. */
  documentIds: number[];
  /** Pièces (`substructures`) et équipements concernés (liens actifs 82D), du compte. */
  rooms: Array<{ id: number; name: string; assetId: number }>;
  equipments: Array<{ id: number; name: string; assetId: number }>;
  /** Chronologie : éléments d'Agenda de l'Opération (principal d'abord). */
  agenda: ClaimAgendaRecord[];
  /** Indemnité totale (INDEMNITY actives), centimes EUR ; null si aucune. */
  indemnityCents: number | null;
  costs: ClaimCosts;
  /** Élément d'Agenda principal (ou, à défaut, le premier élément lié). */
  agendaItemId: number | null;
  /** Libellé du contrat d'assurance lié (assureur · n°), si le lien est établi. */
  contractLabel: string | null;
  /** Provenance (diagnostic et libellés) : saisie historique, ancien formulaire migré, documents. */
  origin: { form: boolean; migration: boolean; documents: number };
}

// ── Libellés ───────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const frDate = (d: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : null);

/** « Dégât des eaux · 12/03/2026 » ; sans type ni date : « Sinistre sans date ». */
export function claimLabel(s: { claimType?: unknown; occurredOn?: unknown }): string {
  const type = CLAIM_TYPE_OPTIONS.find((o) => o.value === s.claimType)?.label ?? null;
  const date = frDate(str(s.occurredOn));
  if (type && date) return `${type} · ${date}`;
  if (type) return `${type} · date à préciser`;
  if (date) return `Sinistre du ${date}`;
  return 'Sinistre sans date';
}

/** Libellé d'un enregistrement (choix du sinistre du dossier). */
export const claimRecordLabel = (r: Pick<ClaimRecord, 'details' | 'realizedDate'>): string =>
  claimLabel({ claimType: r.details?.claimType ?? null, occurredOn: r.realizedDate });

// ── Champs clés établis (lot 69) ───────────────────────────────────────────

/** Champ clé d'une synthèse de sinistre complète. */
export type ClaimKeyField = 'claimType' | 'occurredOn';

/**
 * Champs clés RÉELLEMENT absents (type, date de survenue), dans cet ordre.
 * Une seule règle pour tout message : jamais « type et date » quand un seul
 * manque (lot 69).
 */
export function claimMissingKeyFields(s: { claimType?: unknown; occurredOn?: unknown } | null | undefined): ClaimKeyField[] {
  const present = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== '';
  const out: ClaimKeyField[] = [];
  if (!present(s?.claimType)) out.push('claimType');
  if (!present(s?.occurredOn)) out.push('occurredOn');
  return out;
}

/**
 * Lot 83D (V-Q1) : plus de formulaire Sinistre — les champs clés viennent des
 * documents (déclaration, constat, courrier de l'assureur). « Type du
 * sinistre non établi par vos documents », etc. ; null si rien ne manque.
 */
export function claimMissingKeyFieldsMessage(missing: readonly ClaimKeyField[], suffix = ''): string | null {
  const t = missing.includes('claimType');
  const d = missing.includes('occurredOn');
  const head = t && d ? 'Type et date du sinistre non établis' : t ? 'Type du sinistre non établi' : d ? 'Date du sinistre non établie' : null;
  return head ? `${head} par vos documents${suffix}.` : null;
}

// ── Coûts (Q4) ─────────────────────────────────────────────────────────────

/**
 * Composante d'un sinistre : `amountCents` = montant EUR (centimes) ou `null`
 * si la contre-valeur EUR n'est pas établie (lot 54D, E09 : jamais 0) ;
 * devise et montant d'origine conservés pour le signalement.
 */
export interface ComponentAmount { kind: string; amountCents: number | null; amountMinor?: number; currency?: string }

/**
 * Coût brut (REALIZED_COST), indemnité (INDEMNITY), net = brut − indemnité.
 * Le brut n'est jamais diminué (Q4). Lot 54D : un montant non convertible est
 * exclu des totaux EUR et signalé (E09) ; réductions / remboursements donnent
 * le reste à charge complet (§4.3).
 */
export function claimCosts(components: readonly ComponentAmount[]): ClaimCosts {
  const connus = components.filter((c) => c.amountCents !== null && c.amountCents !== undefined);
  const sum = (...k: string[]) => connus.filter((c) => k.includes(c.kind)).reduce((n, c) => n + (c.amountCents as number), 0);
  const grossCents = sum('REALIZED_COST');
  const indemnityCents = sum('INDEMNITY');
  const reductionsCents = sum('REDUCTION', 'REFUND');
  const unconverted = components
    .filter((c) => (c.amountCents === null || c.amountCents === undefined) && ['REALIZED_COST', 'INDEMNITY', 'REDUCTION', 'REFUND'].includes(c.kind))
    .map((c) => ({ kind: c.kind, amountMinor: c.amountMinor ?? 0, currency: (c.currency ?? 'XXX').trim().toUpperCase() }));
  return {
    grossCents, indemnityCents, netCents: grossCents - indemnityCents,
    reductionsCents, outOfPocketCents: grossCents - reductionsCents - indemnityCents,
    unconverted, complete: unconverted.length === 0,
  };
}
