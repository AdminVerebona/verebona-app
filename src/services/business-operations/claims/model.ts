/**
 * Sinistre = Opération CLAIM — règles PURES (lot 44, O5 ; CDC Opérations V1
 * ch. 15, B14, C13.1, C14, C14.1 à C14.3 ; décisions PO Q2, Q3, Q4, Q11).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE CORRESPONDANCE « FORMULAIRE ↔ OPÉRATION »
 *
 * L'écran Sinistre (et le dossier Assurance-sinistre) gardent leur
 * vocabulaire : les clés de l'ancienne sous-rubrique `claim` des
 * informations complémentaires (`lib/assets/additional-infos.ts`). Ce module
 * traduit, dans les deux sens, entre cette forme et le stockage de l'Opération
 * CLAIM (C14) :
 *
 *   claimType            claim_details.claim_type
 *   occurredOn           business_operations.realized_date (date de survenue)
 *   declaredOn           claim_details.declared_on (ne remplace jamais la survenue)
 *   insurerClaimRef      claim_details.insurer_claim_ref + référence CLAIM (M1)
 *   policyReference      claim_details.policy_reference_text (+ contrat certain,
 *                        `insurance_contract_operation_id`, C13.1)
 *   status               claim_details.status — avancement du DOSSIER (C14.1),
 *                        distinct du statut de l'Opération (toujours REALIZED)
 *   statusDetail …       claim_details (textes)
 *   measures             claim_details.measures_summary
 *   exchangesSummary     claim_details.exchanges_summary
 *   estimatedDamageCents claim_details.estimated_damage_minor (jamais TCO)
 *   compensationCents    composante INDEMNITY (Q4 : coût brut jamais diminué)
 *   claimEventKey        agenda_items.business_operation_id (agenda:N) ou
 *                        claim_details.history_event_id (event:N)
 *   damages / actions /  business_operation_claim_damages / _actions /
 *   exchanges            _exchanges (une ligne n'est jamais une Opération)
 *
 * Aucun accès base ici : lecture `read.ts`, écriture
 * `consolidation/claim-form.ts`, migration `consolidation/claim-migration.ts`.
 * Le mot « Opération » n'apparaît jamais côté utilisateur (P09).
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  CLAIM_TYPE_OPTIONS, sanitizeSection,
  type AdditionalInfoSectionData, type ListItem, type NormalizedPatch,
} from '@/lib/assets/additional-infos';
import type { BusinessOperationStatus, ClaimFileStatus } from '../model';
import type { ClaimActionInput, ClaimDamageInput, ClaimDetailsInput, ClaimExchangeInput, ClaimListsInput } from '../repository';

/** Version de la migration C14.3 de l'ancien formulaire (clé stable des sources MIGRATION et des repères). */
export const CLAIM_MIGRATION_VERSION = 'C14.3-v1';

/** Clé stable d'une source MIGRATION (C23.1 : compte × bien × champ × version). */
export function claimMigrationSourceKey(accountId: number, assetId: number): string {
  return `claim_json:${CLAIM_MIGRATION_VERSION}:a${accountId}:b${assetId}`;
}

/** Empreinte d'indemnité saisie (formulaire ou migration) : un seul fait INDEMNITY par sinistre (C12.1). */
export const CLAIM_FORM_INDEMNITY_FINGERPRINT = 'claim-form:indemnity';

// ── Lecture : enregistrement relationnel d'un sinistre ─────────────────────

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
  historyEventId: number | null;
}

export interface ClaimCosts {
  /** Coût réel (REALIZED_COST du sinistre et de ses interventions enfants), en centimes EUR — jamais diminué (Q4). */
  grossCents: number;
  /** Indemnités (INDEMNITY), en centimes EUR. */
  indemnityCents: number;
  /** Coût net = brut − indemnité (peut être négatif si l'indemnité dépasse le coût connu). */
  netCents: number;
}

export interface ClaimRecord {
  id: number;
  accountId: number;
  /** Verrou optimiste (business_operations.version). */
  version: number;
  status: BusinessOperationStatus;
  realizedDate: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  assets: Array<{ assetId: number; role: 'PRIMARY' | 'CONCERNED' }>;
  details: ClaimDetailsRecord | null;
  lists: ClaimListsInput;
  /** Indemnité totale (INDEMNITY actives), centimes EUR ; null si aucune. */
  indemnityCents: number | null;
  costs: ClaimCosts;
  /** Élément d'agenda lié (C14 : pivot `agenda_items.business_operation_id`). */
  agendaItemId: number | null;
  /** Libellé du contrat d'assurance lié (assureur · n°), si le lien est établi. */
  contractLabel: string | null;
  /** Provenance (diagnostic et libellés) : saisie, ancien formulaire, documents. */
  origin: { form: boolean; migration: boolean; documents: number };
}

const t = (v: string | null | undefined): string | null => (v == null || String(v).trim() === '' ? null : String(v));

/** Clé d'événement de la forme historique (`agenda:N` / `event:N`). */
export function claimEventKeyOf(r: Pick<ClaimRecord, 'agendaItemId' | 'details'>): string | null {
  if (r.agendaItemId) return `agenda:${r.agendaItemId}`;
  if (r.details?.historyEventId) return `event:${r.details.historyEventId}`;
  return null;
}

const rowId = (key: string | null, prefix: string, i: number) => key ?? `${prefix}${i + 1}`;

/**
 * Sinistre → forme de la sous-rubrique « Sinistre » (formulaire, dossier,
 * miroir `claim_json`). Relue par `sanitizeSection` : seules les valeurs
 * valides du dictionnaire sortent (une donnée documentaire hors référentiel
 * n'atteint jamais le PDF).
 */
export function claimToSection(r: ClaimRecord): AdditionalInfoSectionData {
  const d = r.details;
  const raw: Record<string, unknown> = {
    claimEventKey: claimEventKeyOf(r),
    claimType: d?.claimType,
    occurredOn: r.realizedDate,
    declaredOn: d?.declaredOn,
    insurerClaimRef: d?.insurerClaimRef,
    policyReference: d?.policyReferenceText,
    status: d?.status,
    statusDetail: d?.statusDetail,
    circumstances: d?.circumstances,
    consequences: d?.consequences,
    measures: d?.measuresSummary,
    exchangesSummary: d?.exchangesSummary,
    estimatedDamageCents: d?.estimatedDamageMinor,
    compensationCents: r.indemnityCents,
    damages: r.lists.damages.map((x, i) => ({
      id: rowId(x.itemKey, 'd', i), zone: x.zone, element: x.element, finding: x.finding,
      estimatedAmountCents: x.estimatedAmountMinor, photoIds: x.photoIds, documentIds: x.fileIds,
    })),
    actions: r.lists.actions.map((x, i) => ({
      id: rowId(x.itemKey, 'a', i), date: x.date, endDate: x.endDate, status: x.status, title: x.title,
      performedBy: x.performedBy, detail: x.detail, invoiceDocumentId: x.invoiceFileId,
    })),
    exchanges: r.lists.exchanges.map((x, i) => ({
      id: rowId(x.itemKey, 'x', i), date: x.date, direction: x.direction, party: x.party, channel: x.channel,
      summary: x.summary, documentId: x.documentFileId,
    })),
  };
  // Valeurs nulles retirées avant la relecture défensive (champ vide = non stocké).
  const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));
  for (const k of ['damages', 'actions', 'exchanges']) raw[k] = (raw[k] as Array<Record<string, unknown>>).map(clean);
  return sanitizeSection('claim', clean(raw));
}

// ── Écriture : sous-rubrique → stockage ────────────────────────────────────

export interface ClaimSectionWrite {
  details: Omit<ClaimDetailsInput, 'insuranceContractOperationId' | 'historyEventId'>;
  occurredOn: string | null;
  compensationCents: number | null;
  claimEventKey: string | null;
  /** Listes à écrire ; `childOperationId` est recalculé par l'écriture (C14.2). */
  lists: ClaimListsInput;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
const ids = (v: unknown): number[] => (Array.isArray(v) ? v : v == null ? [] : [v]).filter((n): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0);
const list = (s: AdditionalInfoSectionData, k: string): ListItem[] => (Array.isArray(s[k]) ? (s[k] as ListItem[]) : []);

/** Sous-rubrique VALIDÉE (dictionnaire) → valeurs à écrire sur l'Opération CLAIM. */
export function sectionToClaimWrite(s: AdditionalInfoSectionData): ClaimSectionWrite {
  const damages: ClaimDamageInput[] = list(s, 'damages').filter((x) => str(x.zone)).map((x) => ({
    itemKey: str(x.id), zone: str(x.zone)!, element: str(x.element), finding: str(x.finding),
    estimatedAmountMinor: int(x.estimatedAmountCents), fileIds: ids(x.documentIds), photoIds: ids(x.photoIds),
  }));
  const actions: ClaimActionInput[] = list(s, 'actions').filter((x) => str(x.title)).map((x) => ({
    itemKey: str(x.id), date: str(x.date), endDate: str(x.endDate), status: (str(x.status) as ClaimActionInput['status']),
    title: str(x.title)!, detail: str(x.detail), performedBy: str(x.performedBy), invoiceFileId: ids(x.invoiceDocumentId)[0] ?? null,
    childOperationId: null,
  }));
  const exchanges: ClaimExchangeInput[] = list(s, 'exchanges').filter((x) => str(x.summary)).map((x) => ({
    itemKey: str(x.id), date: str(x.date), party: str(x.party) as ClaimExchangeInput['party'], channel: str(x.channel) as ClaimExchangeInput['channel'],
    direction: str(x.direction) as ClaimExchangeInput['direction'], summary: str(x.summary)!, documentFileId: ids(x.documentId)[0] ?? null,
  }));
  return {
    details: {
      claimType: str(s.claimType),
      declaredOn: str(s.declaredOn),
      insurerClaimRef: str(s.insurerClaimRef),
      policyReferenceText: str(s.policyReference),
      status: (str(s.status) as ClaimFileStatus | null),
      statusDetail: str(s.statusDetail),
      circumstances: str(s.circumstances),
      consequences: str(s.consequences),
      measuresSummary: str(s.measures),
      exchangesSummary: str(s.exchangesSummary),
      estimatedDamageMinor: int(s.estimatedDamageCents),
    },
    occurredOn: str(s.occurredOn),
    compensationCents: int(s.compensationCents),
    claimEventKey: str(s.claimEventKey),
    lists: { damages, actions, exchanges },
  };
}

// ── Brouillon (lot 53, retour PO D10) ──────────────────────────────────────

/**
 * Le correctif porte-t-il au moins UNE information du sinistre (valeur non
 * vide, ligne de liste) ? Un sinistre n'est créé en base qu'à la première
 * sauvegarde EFFECTIVE : « Ajouter un sinistre » ouvre un brouillon côté
 * interface, et un brouillon vide ou abandonné ne laisse rien en base. Pure.
 */
export function claimPatchHasContent(patch: NormalizedPatch | null | undefined): boolean {
  const set = patch?.set?.claim;
  if (!set) return false;
  return Object.values(set).some((v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    return true;
  });
}

// ── Statuts (C14.1) ────────────────────────────────────────────────────────

/**
 * Clôture de traitement selon l'avancement du dossier (C14.1) : seul « Clos »
 * renseigne `closed_at` ; « Refusé » et « Indemnisé » restent ouverts sauf
 * clôture explicite. Le sinistre reste REALIZED dans tous les cas
 * (INV-FINAL-022, INV-FINAL-023).
 */
export function claimClosedFor(status: ClaimFileStatus | null): boolean {
  return status === 'CLOS';
}

// ── Seuil de migration (C14.3, décision du lot) ────────────────────────────

/**
 * Seuil minimal pour créer un sinistre depuis l'ancien formulaire : au moins
 * un type, une date (survenue, déclaration, ou événement lié daté), une
 * référence (dossier, contrat) ou un montant (estimation, indemnité). En
 * dessous, rien n'est créé : l'ancienne saisie reste lisible (lecture
 * legacy) et l'utilisateur peut la reprendre lui-même.
 */
export function meetsClaimMigrationThreshold(s: AdditionalInfoSectionData, linkedEventDate: string | null = null): boolean {
  return !!(str(s.claimType) || str(s.occurredOn) || str(s.declaredOn) || linkedEventDate
    || str(s.insurerClaimRef) || str(s.policyReference)
    || int(s.estimatedDamageCents) !== null || int(s.compensationCents) !== null);
}

/** Une ancienne saisie a-t-elle un contenu quelconque ? */
export function hasClaimContent(s: AdditionalInfoSectionData): boolean {
  return Object.keys(s).length > 0;
}

// ── Miroir de compatibilité (Q11) ──────────────────────────────────────────

/**
 * Sinistre recopié dans `claim_json` d'un bien : le plus récent (date de
 * survenue, sinon date de création), puis le plus récemment créé. Rend null
 * si le bien n'a aucun sinistre actif.
 */
export function pickMirrorClaim<T extends Pick<ClaimRecord, 'id' | 'realizedDate' | 'createdAt'>>(claims: readonly T[]): T | null {
  if (!claims.length) return null;
  const key = (c: T) => c.realizedDate ?? c.createdAt.slice(0, 10);
  return [...claims].sort((a, b) => key(b).localeCompare(key(a)) || b.id - a.id)[0];
}

// ── Coûts (Q4) ─────────────────────────────────────────────────────────────

export interface ComponentAmount { kind: string; amountCents: number }

/** Coût brut (REALIZED_COST), indemnité (INDEMNITY), net = brut − indemnité. Le brut n'est jamais diminué. */
export function claimCosts(components: readonly ComponentAmount[]): ClaimCosts {
  const sum = (k: string) => components.filter((c) => c.kind === k).reduce((n, c) => n + c.amountCents, 0);
  const grossCents = sum('REALIZED_COST');
  const indemnityCents = sum('INDEMNITY');
  return { grossCents, indemnityCents, netCents: grossCents - indemnityCents };
}

// ── Libellés (liste de la fiche, choix du dossier) ─────────────────────────

const frDate = (d: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : null);

/** « Dégât des eaux · 12/03/2026 » ; sans type ni date : « Sinistre sans date ». */
export function claimLabel(s: Pick<AdditionalInfoSectionData, string>): string {
  const type = CLAIM_TYPE_OPTIONS.find((o) => o.value === s.claimType)?.label ?? null;
  const date = frDate(str(s.occurredOn));
  if (type && date) return `${type} · ${date}`;
  if (type) return `${type} · date à préciser`;
  if (date) return `Sinistre du ${date}`;
  return 'Sinistre sans date';
}

/** Résumé d'un sinistre pour la liste de la fiche (aucun terme technique, P09). */
export interface ClaimSummaryDto {
  id: number;
  label: string;
  claimType: string | null;
  occurredOn: string | null;
  status: ClaimFileStatus | null;
  insurerClaimRef: string | null;
  estimatedDamageCents: number | null;
  compensationCents: number | null;
  /** Autres biens concernés (nom affiché) ; vide si le sinistre ne concerne que ce bien. */
  otherAssets: Array<{ id: number; name: string }>;
  /** Établi aussi par des documents (constat, courrier de l'assureur…). */
  documented: boolean;
  closed: boolean;
}

export function toClaimSummary(r: ClaimRecord, assetId: number, assetNames: ReadonlyMap<number, string>): ClaimSummaryDto {
  const s = claimToSection(r);
  return {
    id: r.id,
    label: claimLabel(s),
    claimType: (s.claimType as string | undefined) ?? null,
    occurredOn: (s.occurredOn as string | undefined) ?? null,
    status: r.details?.status ?? null,
    insurerClaimRef: t(r.details?.insurerClaimRef),
    estimatedDamageCents: r.details?.estimatedDamageMinor ?? null,
    compensationCents: r.indemnityCents,
    otherAssets: r.assets.filter((a) => a.assetId !== assetId).map((a) => ({ id: a.assetId, name: assetNames.get(a.assetId) ?? `Bien ${a.assetId}` })),
    documented: r.origin.documents > 0,
    closed: !!r.closedAt,
  };
}
