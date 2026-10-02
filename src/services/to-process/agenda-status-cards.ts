/**
 * Cartes « À traiter » du statut — CDC 15 T4-12 (propose_done /
 * propose_not_done) et D-15 (changement de statut du bien) ; lot 14.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * STATUT D'UNE ÉCHÉANCE (AGENDA-DONE, AGENDA-NOT-DONE)
 *
 * `reconcileStatus()` (T4, agent A) rend quatre états. Seul `completed` avec
 * une confiance certaine et une occurrence établie est écrit
 * automatiquement (`mark_done` → 'realise'). Les deux autres verdicts
 * actionnables deviennent une carte sur l'ÉLÉMENT D'AGENDA (champ
 * `manualStatus`) :
 *   · propose_done     « Cette échéance a-t-elle été réalisée ? »
 *                      → « Oui, c'est fait » ('realise') | « Pas encore » (null) ;
 *   · propose_not_done « Cette échéance semble ne pas avoir été réalisée »
 *                      → « Annulée » ('annule') | « Toujours à faire » (null).
 * `not_completed` n'est JAMAIS écrit automatiquement : seule la réponse de
 * l'utilisateur pose un statut. Une carte par élément (identité objet +
 * champ, §7.3) : un nouveau verdict remplace la carte de l'autre nature.
 * Empreinte : élément + document preuve + verdict — rejouer la même preuve
 * ne crée rien, une carte « Non applicable » ne revient qu'avec une
 * nouvelle preuve (§7.4).
 *
 * Résolution (`resolveArbitration`, liste blanche) : écrivain
 * `AGENDA_STATUS_WRITER`, qui pose le statut par la PRIMITIVE
 * `writeAgendaItem` (canal MANUAL, dans la transaction de résolution) et
 * trace STATUS_CHANGED (origine USER). Annulation : le statut précédent — le
 * plus souvent « aucun » (null) — est restauré.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * STATUT DU BIEN (ASSET-STATUS, D-15)
 *
 * Un événement historique « vente » ou « sinistre » créé (manuel ou T4,
 * `writeAgendaItem`) ne change jamais
 * le statut du bien : il le PROPOSE. Correspondance avec les valeurs réelles
 * du modèle (`assets.status`, valeurs modifiables par l'utilisateur de la
 * fiche — ARCHIVED relève du parcours d'archivage, EN_MAINTENANCE /
 * HORS_SERVICE ne sont pas proposées à la saisie) :
 *   · sale  (Vente / transmission) → VENDU, TRANSMIS ;
 *   · claim (Sinistre)             → EN_REPARATION, DETRUIT.
 * Le statut actuel est présenté comme valeur actuelle ; déjà égal à l'une
 * des propositions, aucune carte. Écrivain `ASSET_STATUS_WRITER` : bien du
 * compte, non supprimé, ni archivé ni verrouillé ; valeur de la liste ;
 * annulation = statut précédent restauré (colonne jamais nulle).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { agendaItems, agendaOccurrenceEvents, assets, toProcessActionEvents, toProcessActions } from '@/db/schema';
import type { ActionProposal, ResolutionReason } from './action-model';
import type { DbClient, FieldWriter } from './resolve-action.service';
import { upsertAction, type UpsertActionResult } from './to-process-action.service';

export const AGENDA_DONE_RULE = 'AGENDA-DONE';
export const AGENDA_NOT_DONE_RULE = 'AGENDA-NOT-DONE';
export const AGENDA_STATUS_FIELD = 'manualStatus';
export const ASSET_STATUS_RULE = 'ASSET-STATUS';
export const ASSET_STATUS_FIELD = 'status';

export type AgendaStatusProposalKind = 'propose_done' | 'propose_not_done';
const RULE_OF: Record<AgendaStatusProposalKind, string> = {
  propose_done: AGENDA_DONE_RULE,
  propose_not_done: AGENDA_NOT_DONE_RULE,
};

// ── Statut d'une échéance ───────────────────────────────────────────────────

const AGENDA_STATUS_VALUES = new Set<unknown>(['realise', 'annule', null]);
/** Même type d'événement d'occurrence que `updateManualStatus`. */
const OCCURRENCE_STATUS_CHANGED = 'STATUS_CHANGED';

export const AGENDA_STATUS_WRITER: FieldWriter = {
  targetType: 'AGENDA_ITEM',
  fieldKey: AGENDA_STATUS_FIELD,
  nullable: true,
  validate: (v) => v !== undefined && AGENDA_STATUS_VALUES.has(v),
  check: async (client, itemId, accountId) => {
    const [row] = await client.select({ id: agendaItems.id }).from(agendaItems)
      .where(and(eq(agendaItems.id, itemId), eq(agendaItems.accountId, accountId))).limit(1);
    return !!row;
  },
  read: async (client, itemId, accountId) => {
    const [row] = await client.select({ v: agendaItems.manualStatus }).from(agendaItems)
      .where(and(eq(agendaItems.id, itemId), eq(agendaItems.accountId, accountId))).limit(1);
    return row?.v ?? null;
  },
  write: async (client, itemId, accountId, value) => {
    const manualStatus = (value ?? null) as 'realise' | 'annule' | null;
    // Primitive unique (T4-09), dans la transaction de résolution (§13.5).
    const { upsertAgendaItem } = await import('@/services/agenda/agenda-write-primitive');
    await upsertAgendaItem(
      { itemId, accountId, assetId: null, origin: 'MANUAL', details: { manualStatus } },
      { client: client as unknown as { transaction: typeof db.transaction } },
    );
    await client.insert(agendaOccurrenceEvents).values({
      // Trace d'occurrence (agenda_occurrence_events), pas une notification.
      agendaItemId: itemId, accountId, eventType: OCCURRENCE_STATUS_CHANGED,
      detailJson: { manualStatus, origin: 'USER', via: 'to_process' },
    });
  },
  // Effets d'après validation (D-13 recopie « achat », D-15 statut du bien),
  // comme `updateManualStatus` — jamais dans la transaction de résolution.
  afterCommit: async ({ accountId, targetId, value, userId }) => {
    if (value !== 'realise') return;
    const { agendaEffectsAfterCommit } = await import('@/services/agenda/write-agenda-item');
    await agendaEffectsAfterCommit({ accountId, itemId: targetId, actorUserId: userId, created: false, manualStatus: 'realise' });
  },
};

/** Propositions d'une carte de statut (pures, testées). */
export function agendaStatusProposals(kind: AgendaStatusProposalKind, sourceFileId: number | null): ActionProposal[] {
  const source = sourceFileId
    ? { evidenceIds: [`file:${sourceFileId}`], sourceContext: { label: 'Document analysé', targetType: 'DOCUMENT' as const, targetId: sourceFileId } }
    : {};
  return kind === 'propose_done'
    ? [
      { value: 'realise', label: 'Oui, c’est fait', confidence: 0.8, ...source },
      { value: null, label: 'Pas encore', confidence: 0.2 },
    ]
    : [
      { value: 'annule', label: 'Non, elle n’aura pas lieu (annulée)', confidence: 0.6, ...source },
      { value: null, label: 'Elle reste à faire', confidence: 0.4 },
    ];
}

/** Empreinte d'une carte de statut : élément + preuve + verdict (§7.4). */
export function agendaStatusTriggerContext(itemId: number, kind: AgendaStatusProposalKind, sourceFileId: number | null): Record<string, unknown> {
  return { itemId, decision: kind, sourceFileId };
}

/**
 * Ferme les cartes de statut ACTIVES d'un élément (autre verdict, statut
 * écrit, élément clos à la main). `except` : règle à laisser ouverte.
 */
export async function closeAgendaStatusCards(
  accountId: number,
  itemId: number,
  reason: Extract<ResolutionReason, 'OBSOLETE' | 'USER_COMPLETED'>,
  opts: { except?: string; client?: DbClient } = {},
): Promise<number[]> {
  const client = opts.client ?? db;
  const actives = await client.select({ id: toProcessActions.id, ruleCode: toProcessActions.ruleCode, cycleNumber: toProcessActions.cycleNumber })
    .from(toProcessActions)
    .where(and(
      eq(toProcessActions.accountId, accountId), eq(toProcessActions.targetType, 'AGENDA_ITEM'),
      eq(toProcessActions.targetId, itemId), eq(toProcessActions.fieldKey, AGENDA_STATUS_FIELD),
      isNull(toProcessActions.resolvedAt),
    ));
  const now = new Date();
  const fermees: number[] = [];
  for (const a of actives) {
    if (opts.except && a.ruleCode === opts.except) continue;
    await client.update(toProcessActions)
      .set({ resolvedAt: now, resolutionReason: reason, updatedAt: now })
      .where(and(eq(toProcessActions.id, a.id), isNull(toProcessActions.resolvedAt)));
    await client.insert(toProcessActionEvents).values({
      actionId: a.id, accountId, event: reason, targetType: 'AGENDA_ITEM', targetId: itemId,
      fieldKey: AGENDA_STATUS_FIELD, details: { ruleCode: a.ruleCode, cycleNumber: a.cycleNumber, reason: 'AGENDA_STATUS_SETTLED' },
      createdAt: now,
    });
    fermees.push(a.id);
  }
  return fermees;
}

/**
 * Carte « réalisée ? » / « non réalisée ? » sur un élément d'agenda
 * (idempotente). Rien pour un élément introuvable ou déjà clos.
 */
export async function proposeAgendaStatus(p: {
  accountId: number;
  itemId: number;
  kind: AgendaStatusProposalKind;
  sourceFileId: number | null;
}): Promise<UpsertActionResult> {
  const [item] = await db.select({ status: agendaItems.manualStatus, date: agendaItems.startDate })
    .from(agendaItems)
    .where(and(eq(agendaItems.id, p.itemId), eq(agendaItems.accountId, p.accountId))).limit(1);
  if (!item) return { status: 'SKIPPED', reason: 'Élément d’agenda introuvable dans le compte.' };
  if (item.status) return { status: 'SKIPPED', reason: 'Statut déjà posé : rien à proposer.' };
  const rule = RULE_OF[p.kind];
  await closeAgendaStatusCards(p.accountId, p.itemId, 'OBSOLETE', { except: rule });
  return upsertAction({
    accountId: p.accountId,
    targetType: 'AGENDA_ITEM',
    targetId: p.itemId,
    fieldKey: AGENDA_STATUS_FIELD,
    actionKind: 'ARBITRATE',
    ruleCode: rule,
    proposals: agendaStatusProposals(p.kind, p.sourceFileId),
    triggerContext: agendaStatusTriggerContext(p.itemId, p.kind, p.sourceFileId),
  });
}

/** Carte ouverte « non réalisée ? » (lecture pour l'accueil / la mascotte). */
export interface OpenNotDoneProposal {
  publicId: string;
  agendaItemId: number;
  title: string;
  startDate: string | null;
  sourceFileId: number | null;
  activeSince: Date;
}

/**
 * Cartes AGENDA-NOT-DONE ouvertes d'un compte (élément non clos), plus
 * récentes d'abord. `assetIds` : restreint aux éléments liés à ces biens.
 */
export async function listOpenNotDoneProposals(
  accountId: number,
  opts: { assetIds?: number[]; limit?: number } = {},
): Promise<OpenNotDoneProposal[]> {
  const biens = opts.assetIds?.filter((a) => Number.isInteger(a) && a > 0) ?? null;
  const rows = await db.execute(sql`
    SELECT t.public_id AS "publicId", i.id AS "agendaItemId", i.title, i.start_date::text AS "startDate",
           (t.trigger_context->>'sourceFileId')::int AS "sourceFileId", t.active_since AS "activeSince"
      FROM to_process_actions t
      JOIN agenda_items i ON i.id = t.target_id AND i.account_id = t.account_id
     WHERE t.account_id = ${accountId} AND t.target_type = 'AGENDA_ITEM' AND t.rule_code = ${AGENDA_NOT_DONE_RULE}
       AND t.resolved_at IS NULL AND (i.manual_status IS NULL OR i.manual_status = '')
       ${biens && biens.length
    ? sql`AND EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = i.id AND l.asset_id IN (${sql.join(biens.map((b) => sql`${b}`), sql`, `)}))`
    : sql``}
     ORDER BY t.active_since DESC
     LIMIT ${Math.min(Math.max(opts.limit ?? 20, 1), 100)}`);
  return (rows as unknown as OpenNotDoneProposal[]).map((r) => ({
    ...r, agendaItemId: Number(r.agendaItemId), sourceFileId: r.sourceFileId == null ? null : Number(r.sourceFileId),
    activeSince: new Date(r.activeSince),
  }));
}

// ── Statut du bien (D-15) ───────────────────────────────────────────────────

/**
 * Statuts qu'une carte peut poser : ceux du modèle Drizzle hors ARCHIVED
 * (parcours d'archivage). La base peut être PLUS STRICTE : la contrainte
 * `assets_status_check` en vigueur (migration 0121) n'admet que
 * EN_SERVICE, EN_MAINTENANCE, HORS_SERVICE, ARCHIVED et TRANSMIS. Les
 * valeurs réellement proposées et écrites sont donc celles que la contrainte
 * ADMET, lues en base (`allowedAssetStatuses`).
 */
export const USER_SETTABLE_ASSET_STATUSES = [
  'EN_SERVICE', 'EN_MAINTENANCE', 'EN_PANNE', 'EN_REPARATION', 'HORS_SERVICE', 'VENDU', 'DETRUIT', 'INACTIF', 'TRANSMIS',
] as const;

/**
 * Correspondance D-15, par ordre de préférence ; les deux premières valeurs
 * ADMISES par la base sont proposées. Avec la contrainte 0121 :
 *   · sale  (Vente / transmission) → TRANSMIS (VENDU refusé par la base) ;
 *   · claim (Sinistre)             → HORS_SERVICE, EN_MAINTENANCE
 *                                    (DETRUIT, EN_REPARATION refusés).
 * Si la contrainte est élargie aux valeurs de l'interface, VENDU / DETRUIT /
 * EN_REPARATION reprennent la tête sans changement de code.
 */
export const ASSET_STATUS_BY_EVENT: Readonly<Record<string, ReadonlyArray<{ value: string; label: string; confidence: number }>>> = {
  sale: [
    { value: 'VENDU', label: 'Vendu', confidence: 0.8 },
    { value: 'TRANSMIS', label: 'Vendu ou transmis', confidence: 0.6 },
  ],
  claim: [
    { value: 'DETRUIT', label: 'Détruit (perte totale)', confidence: 0.5 },
    { value: 'EN_REPARATION', label: 'En réparation', confidence: 0.5 },
    { value: 'HORS_SERVICE', label: 'Hors service (perte totale)', confidence: 0.4 },
    { value: 'EN_MAINTENANCE', label: 'En réparation', confidence: 0.4 },
  ],
};

const STATUS_LABEL: Record<string, string> = {
  EN_SERVICE: 'En service', EN_PANNE: 'En panne', EN_REPARATION: 'En réparation', VENDU: 'Vendu',
  DETRUIT: 'Détruit', INACTIF: 'Inactif', TRANSMIS: 'Transmis', EN_MAINTENANCE: 'En maintenance', HORS_SERVICE: 'Hors service',
};

let admisCache: { values: Set<string>; at: number } | null = null;

/**
 * Valeurs de `assets.status` admises par la contrainte EN BASE (cache 5 min).
 * Contrainte absente ou illisible : liste du modèle.
 */
export async function allowedAssetStatuses(client: DbClient = db): Promise<Set<string>> {
  if (admisCache && Date.now() - admisCache.at < 5 * 60_000) return admisCache.values;
  let values = new Set<string>([...USER_SETTABLE_ASSET_STATUSES, 'ARCHIVED']);
  try {
    const rows = await (client as unknown as typeof db).execute(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'assets_status_check' AND conrelid = 'assets'::regclass`);
    const def = (rows as unknown as Array<{ def: string }>)[0]?.def;
    if (def) {
      const lus = [...def.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
      if (lus.length) values = new Set(lus);
    }
  } catch { /* liste du modèle */ }
  admisCache = { values, at: Date.now() };
  return values;
}

/** Réservé aux tests. */
export function __resetAllowedAssetStatusesForTests(values: string[] | null = null): void {
  admisCache = values ? { values: new Set(values), at: Date.now() } : null;
}

/** Bien modifiable du compte : existant, non supprimé, ni archivé ni verrouillé. */
async function writableAsset(client: DbClient, assetId: number, accountId: number): Promise<{ status: string } | null> {
  const [a] = await client.select({ status: assets.status, lockState: assets.lockState }).from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId), isNull(assets.deletedAt))).limit(1);
  if (!a || a.status === 'ARCHIVED' || (a.lockState && a.lockState !== 'NONE')) return null;
  return { status: a.status };
}

export const ASSET_STATUS_WRITER: FieldWriter = {
  targetType: 'ASSET',
  fieldKey: ASSET_STATUS_FIELD,
  validate: (v) => typeof v === 'string' && (USER_SETTABLE_ASSET_STATUSES as readonly string[]).includes(v),
  // Bien du compte, modifiable, et valeur admise par la contrainte en base.
  check: async (client, assetId, accountId, value) => (await writableAsset(client, assetId, accountId)) !== null
    && (await allowedAssetStatuses(client)).has(value as string),
  read: async (client, assetId, accountId) => {
    const [a] = await client.select({ v: assets.status }).from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId))).limit(1);
    return a?.v ?? null;
  },
  write: async (client, assetId, accountId, value) => {
    await client.update(assets).set({ status: value as string, updatedAt: new Date() })
      .where(and(eq(assets.id, assetId), eq(assets.accountId, accountId), isNull(assets.deletedAt)));
  },
};

/**
 * Propositions ASSET-STATUS (pures, testées) : les deux premières valeurs
 * admises ; vide si le statut est déjà l'une des valeurs du type.
 */
export function assetStatusProposals(
  businessType: string, currentStatus: string, sourceLabel: string, admis: ReadonlySet<string>,
): ActionProposal[] {
  const toutes = ASSET_STATUS_BY_EVENT[businessType] ?? [];
  if (toutes.some((c) => c.value === currentStatus)) return [];
  const vus = new Set<string>();
  const cibles = toutes.filter((c) => admis.has(c.value) && !vus.has(c.label) && vus.add(c.label)).slice(0, 2);
  if (cibles.length === 0) return [];
  return [
    ...cibles.map((c) => ({ value: c.value, label: c.label, confidence: c.confidence, sourceContext: { label: sourceLabel } })),
    { value: currentStatus, label: `Inchangé : ${STATUS_LABEL[currentStatus] ?? currentStatus}`, confidence: 0, isCurrentValue: true },
  ];
}

/**
 * D-15 — propose le changement de statut du bien après un événement
 * historique « vente » / « sinistre » (idempotent : une carte par bien).
 */
export async function proposeAssetStatusChange(p: {
  accountId: number;
  assetId: number;
  agendaItemId: number;
  businessType: string;
}): Promise<UpsertActionResult> {
  const bien = await writableAsset(db, p.assetId, p.accountId);
  if (!bien) return { status: 'SKIPPED', reason: 'Bien introuvable, archivé ou verrouillé.' };
  const [item] = await db.select({ title: agendaItems.title, date: agendaItems.startDate }).from(agendaItems)
    .where(and(eq(agendaItems.id, p.agendaItemId), eq(agendaItems.accountId, p.accountId))).limit(1);
  const libelle = item ? `${item.title}${item.date ? ` (${item.date})` : ''}`.slice(0, 200) : 'Événement de l’agenda';
  const proposals = assetStatusProposals(p.businessType, bien.status, libelle, await allowedAssetStatuses());
  if (proposals.length === 0) return { status: 'SKIPPED', reason: 'Aucun statut à proposer (déjà appliqué ou type sans effet).' };
  return upsertAction({
    accountId: p.accountId,
    targetType: 'ASSET',
    targetId: p.assetId,
    fieldKey: ASSET_STATUS_FIELD,
    actionKind: 'ARBITRATE',
    ruleCode: ASSET_STATUS_RULE,
    proposals,
    triggerContext: { businessType: p.businessType, agendaItemId: p.agendaItemId },
  });
}
