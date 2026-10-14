/**
 * Service TCO (lot 54D, ticket §3.1) — lecture seule des données CONSOLIDÉES.
 *
 * Lit : Opérations actives liées au bien (liens bien ET équipements du bien,
 * pages sur curseur stable — aucune troncature), leurs composantes actives
 * et documents sources ; la fiche (dates d'acquisition / de cession saisies,
 * statut, `valuationHistory`) ; le prix souhaité (informations
 * commerciales) ; les forfaits d'usage. Calcule par `computeTco` (règles du
 * moteur partagé). N'écrit RIEN, ne rescane aucun PDF, ne crée aucune
 * Opération : recalculé à chaque lecture.
 *
 * Droits (§3.7) : `readAssetTco` est appelé par la route après contrôle du
 * droit Premium (Premium, Premium Duo, essai) ; un compte Standard ne reçoit
 * aucune donnée financière. Premium Duo : les données sont celles du COMPTE,
 * partagées par ses utilisateurs autorisés.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { BusinessOperationReadService, type AssistantOperationRead } from '../read-service';
import { computeTco, type TcoOperation, type TcoResult, type UsageBudget } from './model';
import type { LedgerComponent } from '../finance/engine';

type Row = Record<string, unknown>;
interface Runner { execute: (q: SQL) => Promise<unknown> }
const rows = async <T = Row>(r: Runner, q: SQL): Promise<T[]> => (await r.execute(q)) as unknown as T[];
const txt = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const intArray = (v: readonly number[]): string => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;
const todayUtc = () => new Date().toISOString().slice(0, 10);

const NOMS: Record<string, string> = {
  ACQUISITION: 'Achat', INTERVENTION: 'Intervention', CONTRACT: 'Contrat', FINANCING: 'Financement', CLAIM: 'Sinistre', DISPOSAL: 'Cession', OTHER: 'Dépense',
};

/** Libellé utilisateur (jamais « Opération », P09). */
function libelle(o: AssistantOperationRead): string {
  const base = NOMS[o.typeCode ?? 'OTHER'] ?? 'Dépense';
  const t = o.technicalLabel?.trim() || o.documents[0]?.title || o.provider || null;
  return t ? `${base} — ${t.slice(0, 80)}` : base;
}

export class AssetNotFoundForTcoError extends Error {
  constructor() { super('Bien introuvable.'); this.name = 'AssetNotFoundForTcoError'; }
}

/** Opérations actives du bien : liées au bien, ou à un équipement du bien (identifiants, curseur). */
async function operationIdsOfAsset(r: Runner, accountId: number, assetId: number): Promise<number[]> {
  const out: number[] = [];
  let curseur = 0;
  for (;;) {
    const lot = await rows<{ id: string }>(r, sql`
      SELECT o.id FROM business_operations o
       WHERE o.account_id = ${accountId} AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL AND o.id > ${curseur}
         AND (EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.account_id = o.account_id AND l.active AND l.asset_id = ${assetId})
              OR EXISTS (SELECT 1 FROM business_operation_equipment_links e WHERE e.operation_id = o.id AND e.account_id = o.account_id AND e.active AND e.asset_id = ${assetId}))
       ORDER BY o.id LIMIT 1000`);
    out.push(...lot.map((x) => Number(x.id)));
    if (lot.length < 1000) return out;
    curseur = Number(lot[lot.length - 1].id);
  }
}

/** Calcule le TCO d'un bien du compte (lecture seule). */
export async function readAssetTco(accountId: number, assetId: number, opts: { today?: string; runner?: Runner } = {}): Promise<TcoResult> {
  const r = opts.runner ?? db;
  const [asset] = await rows(r, sql`
    SELECT a.id, a.status, a.key_characteristics FROM assets a WHERE a.id = ${assetId} AND a.account_id = ${accountId} AND a.deleted_at IS NULL`);
  if (!asset) throw new AssetNotFoundForTcoError();
  let kc: Record<string, unknown> = {};
  try { kc = typeof asset.key_characteristics === 'string' ? JSON.parse(asset.key_characteristics) : ((asset.key_characteristics as Record<string, unknown> | null) ?? {}); } catch { kc = {}; }

  const lecteur = new BusinessOperationReadService(r as never);
  const ids = await operationIdsOfAsset(r, accountId, assetId);
  const lus: AssistantOperationRead[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const page = ids.slice(i, i + 500);
    lus.push(...(await lecteur.listAllForAssistant(accountId, { ids: page })).operations);
  }
  const readComplete = lus.length === ids.length;

  // Équipements du bien, composantes ciblant un équipement, et biens portés par les équipements liés.
  const equip = ids.length ? await rows<{ operation_id: string; asset_id: number }>(r, sql`
    SELECT operation_id, asset_id FROM business_operation_equipment_links
     WHERE account_id = ${accountId} AND active AND operation_id = ANY(${intArray(ids)}::bigint[])`) : [];
  const cibles = ids.length ? await rows<{ id: string; target_equipment_id: number | null; period_start: string | null; period_end: string | null }>(r, sql`
    SELECT id, target_equipment_id, period_start::text AS period_start, period_end::text AS period_end FROM business_operation_financial_components
     WHERE account_id = ${accountId} AND active AND operation_id = ANY(${intArray(ids)}::bigint[])`) : [];
  const detailComposante = new Map(cibles.map((c) => [Number(c.id), c]));
  const equipements = await rows<{ id: number; asset_id: number }>(r, sql`
    SELECT e.id, e.asset_id FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = ${accountId}
     WHERE e.id IN (SELECT DISTINCT target_equipment_id FROM business_operation_financial_components
                     WHERE account_id = ${accountId} AND active AND target_equipment_id IS NOT NULL AND operation_id = ANY(${intArray(ids.length ? ids : [0])}::bigint[]))`);
  const equipmentAssets = new Map(equipements.map((e) => [Number(e.id), Number(e.asset_id)]));

  const operations: TcoOperation[] = lus.map((o) => {
    const parEquipement = equip.filter((e) => Number(e.operation_id) === o.id).map((e) => Number(e.asset_id));
    return {
      id: o.id, typeCode: o.typeCode, status: o.status, parentOperationId: o.parentOperationId,
      realizedDate: o.realizedDate, startDate: o.startDate, plannedDate: o.plannedDate,
      assetIds: [...new Set([...o.assetIds, ...parEquipement])],
      label: libelle(o),
      components: o.components.map((c): LedgerComponent => {
        const d = detailComposante.get(c.id);
        return {
          id: c.id, operationId: o.id, kind: c.kind, amountMinor: c.amountMinor, currency: c.currency, amountEurCents: c.amountEurCents,
          economicDate: c.economicDate, periodStart: txt(d?.period_start), periodEnd: txt(d?.period_end),
          targetAssetId: c.targetAssetId, targetEquipmentId: d?.target_equipment_id == null ? null : Number(d.target_equipment_id), label: c.label,
        };
      }),
      documents: o.documents.map((d) => ({ fileId: d.fileId, title: d.title, role: d.role })),
    };
  });

  const [info] = await rows<{ desired: unknown }>(r, sql`
    SELECT commercial_json->'desiredSalePriceCents' AS desired FROM asset_additional_infos WHERE asset_id = ${assetId} AND account_id = ${accountId}`);
  const desired = typeof info?.desired === 'number' && Number.isSafeInteger(info.desired) ? info.desired : null;
  const budgets = await readUsageBudgets(accountId, assetId, r);
  const historique = Array.isArray(kc.valuationHistory) ? (kc.valuationHistory as Array<Record<string, unknown>>) : [];
  const valuationHistory = historique.length ? historique.map((v) => ({
    value: typeof v.value === 'number' ? v.value : null, date: txt(v.date), mode: txt(v.mode), source: txt(v.source), currency: txt(v.currency),
  })) : (typeof kc.estimatedValue === 'number' ? [{
    value: kc.estimatedValue, date: txt(kc.estimatedValueDate), mode: txt(kc.estimatedValueMode), source: null, currency: txt(kc.estimatedValueCurrency),
  }] : []);

  return computeTco({
    assetId, today: opts.today ?? todayUtc(), operations, equipmentAssets,
    assetAcquisitionDate: txt(kc.acquisitionDate), assetSaleDate: txt(kc.saleDate), assetStatus: txt(asset.status),
    valuationHistory, desiredSalePriceCents: desired, budgets, readComplete,
  });
}

// ── Forfaits d'usage (§3.5) ────────────────────────────────────────────────

export async function readUsageBudgets(accountId: number, assetId: number, r: Runner = db): Promise<UsageBudget[]> {
  const [t] = await rows<{ ok: boolean }>(r, sql`SELECT to_regclass('asset_usage_budgets') IS NOT NULL AS ok`);
  if (!t?.ok) return [];
  const x = await rows(r, sql`
    SELECT b.id, b.asset_id, b.category, b.label, b.amount_minor, trim(b.currency) AS currency, b.periodicity,
           b.valid_from::text AS valid_from, b.valid_to::text AS valid_to
      FROM asset_usage_budgets b JOIN assets a ON a.id = b.asset_id AND a.account_id = b.account_id
     WHERE b.account_id = ${accountId} AND b.asset_id = ${assetId} ORDER BY b.id`);
  return x.map((b) => ({
    id: Number(b.id), assetId: Number(b.asset_id), category: String(b.category) as UsageBudget['category'], label: txt(b.label),
    amountMinor: Number(b.amount_minor), currency: String(b.currency), periodicity: String(b.periodicity) as UsageBudget['periodicity'],
    validFrom: txt(b.valid_from), validTo: txt(b.valid_to),
  }));
}

export interface UsageBudgetInput {
  category: UsageBudget['category']; label: string | null; amountMinor: number; currency: string;
  periodicity: UsageBudget['periodicity']; validFrom: string | null; validTo: string | null;
}

/** Crée un forfait (le bien doit être du compte). Rend l'identifiant, ou null (bien absent). */
export async function createUsageBudget(accountId: number, assetId: number, userId: number | null, b: UsageBudgetInput): Promise<number | null> {
  const [x] = await rows<{ id: string }>(db, sql`
    INSERT INTO asset_usage_budgets (account_id, asset_id, category, label, amount_minor, currency, periodicity, valid_from, valid_to, created_by, updated_by)
    SELECT a.account_id, a.id, ${b.category}, ${b.label}, ${b.amountMinor}, ${b.currency}, ${b.periodicity}, ${b.validFrom}::date, ${b.validTo}::date, ${userId}, ${userId}
      FROM assets a WHERE a.id = ${assetId} AND a.account_id = ${accountId} AND a.deleted_at IS NULL
    RETURNING id`);
  return x ? Number(x.id) : null;
}

/** Modifie un forfait du bien du compte. Rend vrai si une ligne a été modifiée. */
export async function updateUsageBudget(accountId: number, assetId: number, id: number, userId: number | null, b: UsageBudgetInput): Promise<boolean> {
  const x = await rows(db, sql`
    UPDATE asset_usage_budgets SET category = ${b.category}, label = ${b.label}, amount_minor = ${b.amountMinor}, currency = ${b.currency},
           periodicity = ${b.periodicity}, valid_from = ${b.validFrom}::date, valid_to = ${b.validTo}::date, updated_by = ${userId}, updated_at = now()
     WHERE id = ${id} AND asset_id = ${assetId} AND account_id = ${accountId} RETURNING id`);
  return x.length > 0;
}

/** Supprime un forfait (geste explicite de l'utilisateur ; jamais au changement d'offre). */
export async function deleteUsageBudget(accountId: number, assetId: number, id: number): Promise<boolean> {
  const x = await rows(db, sql`DELETE FROM asset_usage_budgets WHERE id = ${id} AND asset_id = ${assetId} AND account_id = ${accountId} RETURNING id`);
  return x.length > 0;
}
