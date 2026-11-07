/**
 * Cartes « À traiter » du statut du BIEN — CDC 15 D-15 (lot 14). Lot 113P
 * (#715) : le volet « statut d'une échéance » (AGENDA-DONE / AGENDA-NOT-DONE,
 * T4-12) est SUPPRIMÉ — voir plus bas.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * STATUT DU BIEN (ASSET-STATUS, D-15)
 *
 * Un événement historique « vente » créé (manuel ou T4, `writeAgendaItem`)
 * ne change jamais le statut du bien : il le PROPOSE. Lot 32 (PO-Q11) :
 * statuts officiels EN_SERVICE, VENDU, TRANSMIS, ARCHIVED (`asset-status`) —
 * ARCHIVED relève du parcours d'archivage, jamais d'une carte :
 *   · sale  (Vente / transmission) → VENDU, TRANSMIS ;
 *   · claim (Sinistre)             → aucune carte : la liste officielle n'a
 *     plus de statut « en réparation » ni « détruit » (« pas besoin de
 *     maintenance etc. »).
 * Le statut actuel est présenté comme valeur actuelle ; déjà égal à l'une
 * des propositions, aucune carte. Écrivain `ASSET_STATUS_WRITER` : bien du
 * compte, non supprimé, ni archivé ni verrouillé ; valeur de la liste ;
 * annulation = statut précédent restauré (colonne jamais nulle).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db';
import { agendaItems, assets } from '@/db/schema';
import type { ActionProposal } from './action-model';
import type { DbClient, FieldWriter } from './resolve-action.service';
import { upsertAction, type UpsertActionResult } from './to-process-action.service';
import { ASSET_STATUSES, assetStatusLabel } from '@/lib/asset-status';

const ASSET_STATUS_RULE = 'ASSET-STATUS';
const ASSET_STATUS_FIELD = 'status';

// ── Statut d'une échéance : SUPPRIMÉ (lot 113P, #715) ───────────────────────
//
// Décision PO du 06/11/2026 : les événements de l'agenda n'ont plus de statut.
// Les cartes AGENDA-DONE (« Cette échéance a-t-elle été réalisée ? ») et
// AGENDA-NOT-DONE ne sont plus produites ni résolues ; les cartes ouvertes
// restantes sont closes par la migration 1527 (motif OBSOLETE, trace
// EVENT_STATUS_RETIRED). Seul le statut du BIEN (D-15) demeure ci-dessous.

// ── Statut du bien (D-15) ───────────────────────────────────────────────────

/**
 * Statuts qu'une carte peut poser : la liste officielle (lot 32, PO-Q11) hors
 * ARCHIVED (parcours d'archivage). La contrainte `assets_status_check` est
 * alignée sur cette liste (migration 0278) ; `allowedAssetStatuses` la relit
 * en base par sécurité (base pas encore migrée : valeurs non admises jamais
 * proposées).
 */
export const USER_SETTABLE_ASSET_STATUSES = ASSET_STATUSES.filter((s) => s !== 'ARCHIVED');

/**
 * Correspondance D-15, par ordre de préférence ; les deux premières valeurs
 * ADMISES par la base sont proposées. Un sinistre ne propose plus rien
 * (aucun statut officiel ne le décrit).
 */
export const ASSET_STATUS_BY_EVENT: Readonly<Record<string, ReadonlyArray<{ value: string; label: string; confidence: number }>>> = {
  sale: [
    { value: 'VENDU', label: 'Vendu', confidence: 0.8 },
    { value: 'TRANSMIS', label: 'Transmis (donné, hérité…)', confidence: 0.6 },
  ],
};

const STATUS_LABEL = (s: string): string => assetStatusLabel(s);

let admisCache: { values: Set<string>; at: number } | null = null;

/**
 * Valeurs de `assets.status` admises par la contrainte EN BASE (cache 5 min).
 * Contrainte absente ou illisible : liste du modèle.
 */
async function allowedAssetStatuses(client: DbClient = db): Promise<Set<string>> {
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
  // Lot 43 (C4 TRG-009 / TRG-010) : passage à VENDU / TRANSMIS (ou retour)
  // → Cession établie (ou retirée) par la donnée structurée du bien.
  afterCommit: async ({ accountId, targetId, value }) => notifyAssetStatusChanged(accountId, targetId, value),
  afterUndo: async ({ accountId, targetId, value }) => notifyAssetStatusChanged(accountId, targetId, value),
};

/** Opérations : le statut du bien a changé (après commit, ne lève jamais). */
async function notifyAssetStatusChanged(accountId: number, assetId: number, status: unknown): Promise<void> {
  try {
    const { notifyOperationsEvent } = await import('@/services/business-operations/consolidation/queue');
    notifyOperationsEvent(accountId, { trigger: status === 'VENDU' || status === 'TRANSMIS' ? 'asset_disposed' : 'asset_updated', assetId });
  } catch (e) {
    console.error(`[to-process] statut du bien ${assetId} : Opérations non notifiées :`, (e as Error).message);
  }
}

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
    { value: currentStatus, label: `Inchangé : ${STATUS_LABEL(currentStatus)}`, confidence: 0, isCurrentValue: true },
  ];
}

/**
 * D-15 — propose le changement de statut du bien après un événement
 * historique « vente » (idempotent : une carte par bien).
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
  const libelle = item ? `${item.title}${item.date ? ` (${item.date})` : ''}`.slice(0, 200) : 'Événement';
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
