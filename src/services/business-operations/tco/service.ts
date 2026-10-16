/**
 * Service TCO (lot 54D, ticket §3.1 ; lot 61, ticket P1 TCO §3, §4) — lecture seule.
 *
 * Lot 61 : lit AUSSI, sans exiger d'Opération, les documents du bien (types,
 * montants, candidats T1 établis et actifs = qualification économique
 * PERSISTÉE, représentation par une Opération active et citation par ses
 * composantes) et le prix d'achat de la fiche (valeur canonique, origine,
 * preuves documentaires). Un T3 en attente ou en erreur ne bloque rien : la
 * dépense qualifiée compte directement ; sa reprise par T3 la remplace par
 * la composante, sans variation du total (`finance/economic-lines.ts`).
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
import { computeTco, type TcoAssetPrice, type TcoOperation, type TcoResult, type UsageBudget } from './model';
import type { LedgerComponent } from '../finance/engine';
import type { EconomicDocumentInput, EconomicHint } from '../finance/economic-lines';
import { readCanonicalValue, type AssetRowJson } from '@/services/canonical/asset-state/canonical-asset-view';

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
      sourceKinds: o.sourceKinds ?? [],
    };
  });

  // Lot 61 : dépenses documentaires et prix d'achat de la fiche (sans Opération requise).
  const doc = await readAssetDocuments(r, accountId, assetId);
  const assetPrice = await readAssetPrice(r, accountId, assetId);
  // Équipements ciblés par les indices T1 : bien porteur (attribution, comme pour les composantes).
  const equipIds = [...new Set(doc.documents.flatMap((d) => d.candidates.flatMap((c) => c.targets.filter((t) => t.type === 'EQUIPMENT' && t.entityId != null).map((t) => t.entityId!))))]
    .filter((id) => !equipmentAssets.has(id));
  if (equipIds.length) {
    for (const e of await rows<{ id: number; asset_id: number }>(r, sql`
      SELECT e.id, e.asset_id FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = ${accountId}
       WHERE e.id = ANY(${intArray(equipIds)}::int[])`)) equipmentAssets.set(Number(e.id), Number(e.asset_id));
  }

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
    valuationHistory, desiredSalePriceCents: desired, budgets, readComplete: readComplete && doc.complete,
    documents: doc.documents, assetPrice,
  });
}

// ── Lot 61 : dépenses documentaires du bien (données persistées) ───────────

const DOCS_PAGE = 1000;
const DOCS_MAX = 20_000;

const asJson = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
};
const asArray = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') as Array<Record<string, unknown>> : []);
const n = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Documents liés au bien (liens actifs, colonnes historiques) portant un
 * montant ou un candidat T1 établi ; leurs candidats ACTIFS établis ; leurs
 * Opérations ACTIVES (non invalidées, non fusionnées). Pages sur curseur
 * stable ; garde-fou de volume → lecture PARTIELLE signalée, jamais un total
 * présenté comme complet.
 */
export async function readAssetDocuments(r: Runner, accountId: number, assetId: number): Promise<{ documents: EconomicDocumentInput[]; complete: boolean }> {
  const lus: Row[] = [];
  let curseur = 0;
  let complete = true;
  for (;;) {
    const lot = await rows(r, sql`
      SELECT f.id, coalesce(nullif(f.retained_title, ''), f.original_filename, 'Document') AS title,
             f.document_type_code AS v2, f.document_type AS legacy, f.document_date::text AS date, f.supplier,
             f.amount_cents, f.sha256_hash AS hash, f.analysis_state AS state, f.fusion_ignored_with AS ignored,
             COALESCE(f.user_edited_fields->>'amountCents', 'false') = 'true' AS user_amount,
             e.currency, COALESCE(e.multi_asset, false) AS multi_asset,
             ARRAY(SELECT DISTINCT u.x FROM (
                     SELECT l.asset_id AS x FROM document_asset_links l
                      WHERE l.account_id = f.account_id AND l.file_id = f.id AND l.status = 'ACTIVE'
                     UNION SELECT f.asset_id UNION SELECT f.linked_asset_id) u
                    WHERE u.x IS NOT NULL
                      AND EXISTS (SELECT 1 FROM assets a WHERE a.id = u.x AND a.account_id = f.account_id AND a.deleted_at IS NULL)) AS linked
        FROM asset_files f
        LEFT JOIN LATERAL (SELECT upper(trim(x.currency)) AS currency, x.multi_asset FROM document_extractions x
                            WHERE x.file_id = f.id AND x.account_id = f.account_id ORDER BY x.id DESC LIMIT 1) e ON TRUE
       WHERE f.account_id = ${accountId} AND f.deleted_at IS NULL AND f.id > ${curseur}
         AND (EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id AND l.status = 'ACTIVE' AND l.asset_id = ${assetId})
              OR f.asset_id = ${assetId} OR f.linked_asset_id = ${assetId})
         AND (f.amount_cents IS NOT NULL
              OR EXISTS (SELECT 1 FROM document_operation_candidates c WHERE c.file_id = f.id AND c.account_id = f.account_id AND c.status = 'ACTIVE' AND c.established))
       ORDER BY f.id LIMIT ${DOCS_PAGE}`);
    lus.push(...lot);
    if (lot.length < DOCS_PAGE) break;
    if (lus.length >= DOCS_MAX) { complete = false; break; }
    curseur = Number(lot[lot.length - 1].id);
  }
  const ids = lus.map((d) => Number(d.id));
  const candidats = new Map<number, EconomicDocumentInput['candidates']>();
  const operations = new Map<number, EconomicDocumentInput['operations']>();
  for (let i = 0; i < ids.length; i += 500) {
    const page = ids.slice(i, i + 500);
    for (const c of await rows(r, sql`
      SELECT c.id, c.file_id, c.type_hint, c.status_hint, c.payload, c.t3_outcome FROM document_operation_candidates c
       WHERE c.account_id = ${accountId} AND c.status = 'ACTIVE' AND c.established AND c.file_id = ANY(${intArray(page)}::int[])
       ORDER BY c.id`)) {
      const p = (asJson(c.payload) ?? {}) as Record<string, unknown>;
      const hints: EconomicHint[] = asArray(p.financialHints).map((h) => ({
        role: String(h.role ?? ''), amountMinor: Number(h.amountMinor ?? 0), currency: String(h.currency ?? 'EUR'),
        amountEurMinor: n(h.amountEurMinor), amountScope: txt(h.amountScope), economicDate: txt(h.economicDate),
        periodStart: txt(h.periodStart), periodEnd: txt(h.periodEnd),
      })).filter((h) => Number.isSafeInteger(h.amountMinor) && h.amountMinor >= 0);
      const f = Number(c.file_id);
      candidats.set(f, [...(candidats.get(f) ?? []), {
        id: Number(c.id), typeHint: txt(c.type_hint), statusHint: txt(c.status_hint), sourceRole: txt(p.sourceRoleHint), provider: txt(p.provider),
        references: asArray(p.businessReferences).map((x) => ({ kind: String(x.kind ?? ''), value: String(x.value ?? '') })),
        targets: asArray(p.targetHints).map((x) => ({ type: String(x.type ?? ''), entityId: n(x.entityId) })),
        hints, t3Outcome: txt(c.t3_outcome),
      }]);
    }
    for (const o of await rows(r, sql`
      SELECT s.source_entity_key AS file_key, o.id AS operation_id, o.status, o.type_code, o.technical_label,
             bool_or(EXISTS (SELECT 1 FROM business_operation_financial_component_sources cs
                               JOIN business_operation_financial_components c ON c.id = cs.component_id AND c.active
                              WHERE cs.operation_source_id = s.id)) AS cites,
             EXISTS (SELECT 1 FROM business_operation_financial_components c WHERE c.operation_id = o.id AND c.account_id = o.account_id AND c.active AND c.kind <> 'FORECAST_COST') AS exploitable,
             EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.account_id = o.account_id AND l.active) AS has_assets,
             (EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.account_id = o.account_id AND l.active AND l.asset_id = ${assetId})
              OR EXISTS (SELECT 1 FROM business_operation_equipment_links q WHERE q.operation_id = o.id AND q.account_id = o.account_id AND q.active AND q.asset_id = ${assetId})) AS in_scope
        FROM business_operation_sources s
        JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id
       WHERE s.account_id = ${accountId} AND s.source_kind = 'DOCUMENT' AND s.active
         AND s.source_entity_key = ANY(${`{${page.join(',')}}`}::text[])
         AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
       GROUP BY s.source_entity_key, o.id, o.status, o.type_code, o.technical_label, o.account_id`)) {
      const f = Number(o.file_key);
      const nom = NOMS[String(o.type_code ?? 'OTHER')] ?? 'Dépense';
      operations.set(f, [...(operations.get(f) ?? []), {
        operationId: Number(o.operation_id), label: txt(o.technical_label) ? `${nom} — ${String(o.technical_label).slice(0, 80)}` : nom,
        inScope: Boolean(o.in_scope), cancelled: o.status === 'CANCELLED', hasAssets: Boolean(o.has_assets),
        exploitable: Boolean(o.exploitable), citesDocument: Boolean(o.cites), typeCode: txt(o.type_code),
      }]);
    }
  }
  const preuves = await acquisitionEvidenceFiles(r, accountId, ids);
  const documents = lus.map((d): EconomicDocumentInput => {
    const id = Number(d.id);
    const ignored = asJson(d.ignored);
    return {
      fileId: id, title: String(d.title ?? 'Document'), typeCode: txt(d.v2), legacyType: txt(d.legacy), date: txt(d.date), supplier: txt(d.supplier),
      amountCents: n(d.amount_cents), currency: txt(d.currency), userEditedAmount: Boolean(d.user_amount), hash: txt(d.hash), state: txt(d.state),
      ignoredWith: Array.isArray(ignored) ? ignored.map(Number) : null,
      linkedAssetIds: (Array.isArray(d.linked) ? d.linked : String(d.linked ?? '').replace(/[{}]/g, '').split(',').filter(Boolean)).map(Number),
      multiAsset: Boolean(d.multi_asset),
      candidates: candidats.get(id) ?? [], operations: operations.get(id) ?? [], acquisitionEvidence: preuves.has(id),
    };
  });
  return { documents, complete };
}

/** Clés du prix d'achat (clé canonique et alias historiques). */
const ACQUISITION_PRICE_KEYS = ['acquisitionPrice', 'purchasePrice', 'prixAchat', 'prixAcquisition', 'purchasePriceCents'];

/**
 * Documents (parmi `fileIds`) preuves ACTIVES du prix d'achat d'un bien du
 * compte (T1 a lu sur le document le prix d'acquisition du bien). Lot 61.
 */
export async function acquisitionEvidenceFiles(r: Runner, accountId: number, fileIds: readonly number[]): Promise<Set<number>> {
  const out = new Set<number>();
  for (let i = 0; i < fileIds.length; i += 1000) {
    const page = fileIds.slice(i, i + 1000);
    for (const x of await rows<{ id: number }>(r, sql`
      SELECT DISTINCT source_id AS id FROM field_evidence
       WHERE account_id = ${accountId} AND status = 'active' AND source_type = 'document'
         AND source_id = ANY(${intArray(page)}::int[]) AND field_key = ANY(${`{${ACQUISITION_PRICE_KEYS.join(',')}}`}::text[])`)) out.add(Number(x.id));
  }
  return out;
}

/**
 * Lot 61 (cohérence T2 / TCO) : parmi `fileIds`, justificatifs rattachés
 * à un ACHAT actif de leur bien sans en porter le prix (aucune composante
 * active ne les cite) ni en être la preuve — dépenses distinctes
 * (`isDistinctFromAcquisition`), lues par T2 comme par le TCO.
 */
export async function documentsDistinctFromAcquisition(accountId: number, fileIds: readonly number[], r: Runner = db): Promise<Set<number>> {
  const ids = [...new Set(fileIds.filter((x) => Number.isSafeInteger(x) && x > 0))];
  const out = new Set<number>();
  if (!ids.length) return out;
  const candidats = new Set<number>();
  for (let i = 0; i < ids.length; i += 1000) {
    const page = ids.slice(i, i + 1000);
    for (const x of await rows<{ f: string }>(r, sql`
      SELECT s.source_entity_key AS f FROM business_operation_sources s
        JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id
       WHERE s.account_id = ${accountId} AND s.source_kind = 'DOCUMENT' AND s.active AND o.type_code = 'ACQUISITION' AND o.status <> 'CANCELLED'
         AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
         AND s.source_entity_key = ANY(${`{${page.join(',')}}`}::text[])
         AND NOT EXISTS (SELECT 1 FROM business_operation_financial_component_sources cs
                           JOIN business_operation_financial_components c ON c.id = cs.component_id AND c.active
                           JOIN business_operation_sources s2 ON s2.id = cs.operation_source_id
                          WHERE s2.operation_id = o.id AND s2.source_kind = 'DOCUMENT' AND s2.source_entity_key = s.source_entity_key)`)) candidats.add(Number(x.f));
  }
  const preuves = await acquisitionEvidenceFiles(r, accountId, [...candidats]);
  for (const f of candidats) if (!preuves.has(f)) out.add(f);
  return out;
}

/**
 * Prix d'achat de la fiche (valeur canonique : clé, alias ou colonne miroir),
 * son origine et ses preuves documentaires actives (facture d'achat = même
 * fait). Devise : `acquisitionCurrency` si renseignée, euro sinon.
 */
export async function readAssetPrice(r: Runner, accountId: number, assetId: number): Promise<TcoAssetPrice | null> {
  const [x] = await rows<{ j: unknown }>(r, sql`SELECT row_to_json(a) AS j FROM assets a WHERE a.id = ${assetId} AND a.account_id = ${accountId} AND a.deleted_at IS NULL`);
  const row = asJson(x?.j) as AssetRowJson | null;
  if (!row) return null;
  // Même règle que l'achat structuré (lot 43, C13) : un véhicule en LLD / LOA / prêt n'a pas d'acquisition.
  const detention = readCanonicalValue(row, 'vehicleOwnershipStatus');
  if (row.category === 'VEHICULE' && typeof detention?.value === 'string' && ['LLD', 'LOA', 'PRET_GRATUIT'].includes(detention.value)) return null;
  const st = readCanonicalValue(row, 'acquisitionPrice');
  const eur = typeof st?.value === 'number' ? st.value : Number(st?.value);
  if (!st || !Number.isFinite(eur) || eur <= 0) return null;
  const devise = readCanonicalValue(row, 'acquisitionCurrency');
  const currency = typeof devise?.value === 'string' && /^[A-Za-z]{3}$/.test(devise.value.trim()) ? devise.value.trim().toUpperCase() : 'EUR';
  const preuves = await rows<{ id: number }>(r, sql`
    SELECT DISTINCT source_id AS id FROM field_evidence
     WHERE account_id = ${accountId} AND asset_id = ${assetId} AND status = 'active' AND source_type = 'document'
       AND field_key = ANY(${`{${ACQUISITION_PRICE_KEYS.join(',')}}`}::text[])`);
  return { amountMinor: Math.round(eur * 100), currency, origin: st.origin ?? null, evidenceFileIds: preuves.map((p) => Number(p.id)) };
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
