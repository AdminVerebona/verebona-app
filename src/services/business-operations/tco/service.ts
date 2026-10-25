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
import { documentTitleColumnsSql, documentTitleOf, type DocumentTitleColumns } from '@/lib/documents/document-title-source';
import { BusinessOperationReadService, type AssistantOperationRead } from '../read-service';
import { computeTco, nonRealizedComponentIds, type TcoAssetPrice, type TcoEquipmentPrice, type TcoOperation, type TcoResult, type UsageBudget } from './model';
import { presumedDuplicateComponents, unjustifiedComponent, type ComponentProvenance } from './fact-identity';
import { TCO_STABLE_SOURCE_KINDS, type TcoUserDecision } from './user-decisions';
import { civilDateParis, type LedgerComponent } from '../finance/engine';
import { operationCoverage, type EconomicDocumentInput, type EconomicHint } from '../finance/economic-lines';
import { readCanonicalValue, type AssetRowJson } from '@/services/canonical/asset-state/canonical-asset-view';
import { ASSET_LIST_LINK_ROLES_SQL } from '@/services/documents/asset-document-scope';
import { EXPENSE_THEME_V2_CODES } from '@/services/verebona-assistant/canonical/expense-classes';
import { evidenceReadFilter } from '@/services/ai/evidence/field-evidence.service';

/** Lot 68 : rôles de lien qui RATTACHENT un document à un bien (PRIMARY, SECONDARY) — jamais MENTIONED. */
const ROLES = sql.raw(ASSET_LIST_LINK_ROLES_SQL);

type Row = Record<string, unknown>;
interface Runner { execute: (q: SQL) => Promise<unknown> }
const rows = async <T = Row>(r: Runner, q: SQL): Promise<T[]> => (await r.execute(q)) as unknown as T[];
const txt = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const intArray = (v: readonly number[]): string => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;

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

/**
 * Lot 81D — dates d'acquisition et de cession CANONIQUES de la fiche (vue
 * canonique existante, `readCanonicalValue`) : clé `acquisitionDate`, puis
 * ses alias historiques (`purchaseDate`, `dateAchat`…), puis la colonne
 * historique miroir `assets.purchase_date` — même référentiel que l'API de
 * détail du bien. Jamais la date d'ajout dans Verebona (`created_at`). Valeur
 * brute rendue telle quelle : la validation stricte est celle du moteur.
 */
export function assetTcoDatesOf(row: AssetRowJson): { acquisitionDate: string | null; saleDate: string | null } {
  const v = (k: string): string | null => {
    const x = readCanonicalValue(row, k)?.value;
    return typeof x === 'string' && x.trim() ? x.trim() : null;
  };
  return { acquisitionDate: v('acquisitionDate'), saleDate: v('saleDate') };
}

/**
 * Calcule le TCO d'un bien du compte (lecture seule). Lot 81D : date de
 * référence = date civile à Paris (`civilDateParis`), injectable (`today`).
 */
export async function readAssetTco(accountId: number, assetId: number, opts: { today?: string; runner?: Runner } = {}): Promise<TcoResult> {
  const r = opts.runner ?? db;
  const [asset] = await rows(r, sql`
    SELECT a.id, a.status, a.category, a.key_characteristics, row_to_json(a) AS j FROM assets a WHERE a.id = ${assetId} AND a.account_id = ${accountId} AND a.deleted_at IS NULL`);
  if (!asset) throw new AssetNotFoundForTcoError();
  let kc: Record<string, unknown> = {};
  try { kc = typeof asset.key_characteristics === 'string' ? JSON.parse(asset.key_characteristics) : ((asset.key_characteristics as Record<string, unknown> | null) ?? {}); } catch { kc = {}; }
  const dates = assetTcoDatesOf(asJson(asset.j) as AssetRowJson);

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
  // Lot 78B (§3A, §3B, §3C) : provenance de chaque composante et liens d'autorité USER au bien.
  const componentProvenance = await readComponentProvenance(r, accountId, ids, assetId);
  const liensUtilisateur = ids.length ? new Set((await rows<{ operation_id: string }>(r, sql`
    SELECT operation_id FROM business_operation_asset_links
     WHERE account_id = ${accountId} AND active AND asset_id = ${assetId} AND authority = 'USER' AND operation_id = ANY(${intArray(ids)}::bigint[])`)).map((x) => Number(x.operation_id))) : new Set<number>();

  const operations: TcoOperation[] = lus.map((o) => {
    const parEquipement = equip.filter((e) => Number(e.operation_id) === o.id).map((e) => Number(e.asset_id));
    return {
      id: o.id, typeCode: o.typeCode, status: o.status,
      realizedDate: o.realizedDate, startDate: o.startDate, plannedDate: o.plannedDate,
      assetIds: [...new Set([...o.assetIds, ...parEquipement])],
      label: libelle(o),
      components: o.components.map((c): LedgerComponent => {
        const d = detailComposante.get(c.id);
        return {
          id: c.id, operationId: o.id, kind: c.kind, amountMinor: c.amountMinor, currency: c.currency, amountEurCents: c.amountEurCents,
          // Lot 86F : date économique RÉSOLUE par le lecteur des Opérations (jamais la date de l'Opération par défaut).
          economicDate: c.economicDate, periodStart: txt(d?.period_start), periodEnd: txt(d?.period_end),
          targetAssetId: c.targetAssetId, targetEquipmentId: d?.target_equipment_id == null ? null : Number(d.target_equipment_id), label: c.label,
          ...(c.economicDateResolution ? { economicDateResolution: c.economicDateResolution } : {}),
        };
      }),
      documents: o.documents.map((d) => ({ fileId: d.fileId, title: d.title, role: d.role, date: d.date })),
      sourceKinds: o.sourceKinds ?? [],
      userLinked: liensUtilisateur.has(o.id),
      equipmentLinked: equip.some((e) => Number(e.operation_id) === o.id && Number(e.asset_id) === assetId),
    };
  });

  // Lot 61 : dépenses documentaires et prix d'achat de la fiche (sans Opération requise).
  const doc = await readAssetDocuments(r, accountId, assetId);
  const { price: assetPrice, expected: acquisitionExpected } = await readAssetAcquisition(r, accountId, assetId);
  // Lot 71A : prix d'achat des équipements du bien (dépenses, jamais le prix du bien). Lot 75D (I) : pages, aucune troncature silencieuse.
  const { prices: equipmentPrices, complete: equipementsComplets } = await readEquipmentPrices(r, accountId, assetId);
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
  // Lot 80A : décisions « Ajouter / Retirer du TCO » de l'utilisateur pour ce bien.
  const userDecisions = await readTcoLineDecisions(r, accountId, assetId);
  const historique = Array.isArray(kc.valuationHistory) ? (kc.valuationHistory as Array<Record<string, unknown>>) : [];
  const valuationHistory = historique.length ? historique.map((v) => ({
    value: typeof v.value === 'number' ? v.value : null, date: txt(v.date), mode: txt(v.mode), source: txt(v.source), currency: txt(v.currency),
  })) : (typeof kc.estimatedValue === 'number' ? [{
    value: kc.estimatedValue, date: txt(kc.estimatedValueDate), mode: txt(kc.estimatedValueMode), source: null, currency: txt(kc.estimatedValueCurrency),
  }] : []);

  const result = computeTco({
    assetId, today: opts.today ?? civilDateParis(), operations, equipmentAssets,
    assetAcquisitionDate: dates.acquisitionDate, assetSaleDate: dates.saleDate, assetStatus: txt(asset.status),
    valuationHistory, desiredSalePriceCents: desired, budgets, readComplete: readComplete && doc.complete && equipementsComplets,
    documents: doc.documents, assetPrice, equipmentPrices, acquisitionExpected,
    assetCategory: txt(asset.category), componentProvenance, userDecisions,
  });
  // Lot 68 : diagnostic BO — justificatifs qui CITENT seulement le bien (exclus des sources, expliqués).
  return { ...result, citedOnlyDocuments: await readCitedOnlyDocuments(r, accountId, assetId) };
}

const CITED_MAX = 200;

/** Lot 78B : motifs du TCO qui retirent une composante ou un justificatif du total (règle partagée avec T2). */
// Lot 80A : + retrait décidé par l'utilisateur (USER_EXCLUDED) — même effet sur T2 que sur le TCO du bien.
// Lot 81D : + dépense non réalisée (prévue sans paiement daté et justifié, datée après la date de référence).
const MOTIFS_78B_COMPOSANTE: ReadonlySet<string> = new Set(['SAME_FACT_OTHER_DOCUMENT', 'NOT_OWNERSHIP_COST', 'SOURCE_WITHDRAWN', 'COUNTED_FOR_OTHER_ASSET', 'USER_EXCLUDED', 'NOT_REALIZED', 'FUTURE_DATED']);
const MOTIFS_78B_DOCUMENT: ReadonlySet<string> = new Set(['SAME_FACT_OTHER_DOCUMENT', 'NOT_OWNERSHIP_COST', 'USER_EXCLUDED', 'FUTURE_DATED']);

/** Lot 80A : dépense ajoutée au TCO du bien par l'utilisateur (T2 la compte si ses propres règles ne la comptent pas). */
export interface T2UserAddedExpense {
  source: 'OPERATION' | 'DOCUMENT' | 'ASSET_DATA' | 'EQUIPMENT_DATA';
  lineId: string;
  operationId: number | null;
  componentId: number | null;
  fileId: number | null;
  eurCents: number;
  date: string | null;
  label: string;
  /** Motif automatique remplacé (une composante écartée par 78B redevient naturellement comptée par T2). */
  automaticReason: string | null;
}

/**
 * Lot 78B (TCO-R-14 : même règle pour T2 et le TCO) — composantes et
 * justificatifs que le total des dépenses de T2 ne compte pas, décidés par
 * les MÊMES règles que le TCO (aucune seconde logique) :
 *   · périmètre d'UN bien : la décision du TCO de ce bien elle-même
 *     (`readAssetTco` : doublons présumés, justificatif retiré, prix d'un autre
 *     bien, achat non incorporé ; justificatifs seuls décrivant le même achat
 *     immobilier ou un achat non incorporé) ;
 *   · compte entier ou plusieurs biens : les règles qui ne dépendent d'aucun
 *     bien (`presumedDuplicateComponents`, `unjustifiedComponent` : doublon
 *     présumé dans une Opération, justificatif retiré ; lot 81D :
 *     `nonRealizedComponentIds`, dépense non réalisée) — un achat d'objet reste
 *     une dépense du compte.
 * Lot 81D : même date de référence que le TCO (date civile à Paris, injectable).
 */
export async function t2CostExclusions(
  accountId: number,
  ops: ReadonlyArray<Pick<AssistantOperationRead, 'id' | 'typeCode' | 'components' | 'status' | 'realizedDate' | 'startDate'> & { plannedDate?: string | null }>,
  assetIds: readonly number[] | null,
  r: Runner = db,
  opts: { today?: string } = {},
): Promise<{ components: Set<number>; files: Set<number>; userAdded: T2UserAddedExpense[] }> {
  const today = opts.today ?? civilDateParis();
  const components = new Set<number>();
  const files = new Set<number>();
  const userAdded: T2UserAddedExpense[] = [];
  if (assetIds?.length === 1) {
    const t = await readAssetTco(accountId, assetIds[0], { runner: r, today });
    // Lot 80A : dépenses AJOUTÉES par l'utilisateur au TCO de ce bien (décision prioritaire) — T2 les compte aussi.
    for (const l of t.lines) {
      if (!l.userDecision?.applied || l.userDecision.decision !== 'INCLUDE' || l.includedCents <= 0) continue;
      userAdded.push({
        source: l.source, lineId: l.id, operationId: l.operationId, componentId: l.source === 'OPERATION' && l.id.startsWith('c:') ? Number(l.id.slice(2)) : null,
        fileId: l.fileId, eurCents: l.includedCents, date: l.date, label: l.label, automaticReason: l.userDecision.automaticReason,
      });
    }
    for (const l of t.lines) {
      if (l.source === 'OPERATION' && l.reason && MOTIFS_78B_COMPOSANTE.has(l.reason)) components.add(Number(l.id.slice(2)));
    }
    const parFichier = new Map<number, typeof t.lines>();
    for (const l of t.lines) if (l.source === 'DOCUMENT' && l.fileId != null) parFichier.set(l.fileId, [...(parFichier.get(l.fileId) ?? []), l]);
    for (const [f, ls] of parFichier) {
      if (ls.some((l) => l.reason && MOTIFS_78B_DOCUMENT.has(l.reason)) && !ls.some((l) => l.includedCents > 0)) files.add(f);
    }
    return { components, files, userAdded };
  }
  const ids = ops.map((o) => o.id);
  if (!ids.length) return { components, files, userAdded };
  const prov = await readComponentProvenance(r, accountId, ids, 0);
  const periodes = new Map((await rows<{ id: string; period_start: string | null; period_end: string | null; target_equipment_id: number | null }>(r, sql`
    SELECT id, period_start::text AS period_start, period_end::text AS period_end, target_equipment_id FROM business_operation_financial_components
     WHERE account_id = ${accountId} AND active AND operation_id = ANY(${intArray(ids)}::bigint[])`)).map((c) => [Number(c.id), c]));
  const force = (id: number) => { const p = prov.get(id); return p ? (p.otherSourceKinds.includes('ASSET_DATA') ? 4 : 0) + (p.explained === true ? 1 : 0) : 0; };
  for (const o of ops) {
    const comps: LedgerComponent[] = o.components.map((c) => {
      const d = periodes.get(c.id);
      return {
        id: c.id, operationId: o.id, kind: c.kind, amountMinor: c.amountMinor, currency: c.currency, amountEurCents: c.amountEurCents,
        economicDate: c.economicDate, periodStart: txt(d?.period_start), periodEnd: txt(d?.period_end), targetAssetId: c.targetAssetId,
        targetEquipmentId: d?.target_equipment_id == null ? null : Number(d.target_equipment_id),
        ...(c.economicDateResolution ? { economicDateResolution: c.economicDateResolution } : {}),
      };
    });
    for (const id of presumedDuplicateComponents({ typeCode: o.typeCode, components: comps }, prov, force).keys()) components.add(id);
    for (const c of comps) if (unjustifiedComponent(prov.get(c.id)) === 'SOURCES_WITHDRAWN') components.add(c.id);
    // Lot 81D : non-réalisation (règle du moteur partagé, indépendante de tout bien).
    for (const id of nonRealizedComponentIds([{
      typeCode: o.typeCode, status: o.status, realizedDate: o.realizedDate, startDate: o.startDate, plannedDate: o.plannedDate ?? null, components: comps,
    }], prov, today)) components.add(id);
  }
  return { components, files, userAdded };
}

/**
 * Lot 78B (§3A, §3B) — provenance PERSISTÉE de chaque composante active des
 * Opérations lues : justificatifs des sources DOCUMENT actives qui la portent,
 * justificatifs retirés (source inactive), autres natures de sources actives,
 * références de facture de ses sources, et si l'un de ses justificatifs porte
 * son montant (montant du document, ou indice T1 actif de même montant — même
 * critère que `free_components`). Lecture seule, pages de 500 Opérations.
 */
export async function readComponentProvenance(r: Runner, accountId: number, operationIds: readonly number[], assetId: number): Promise<Map<number, ComponentProvenance>> {
  const out = new Map<number, ComponentProvenance>();
  if (!operationIds.length) return out;
  // Preuve ACTIVE du prix d'achat d'un AUTRE bien portée par un justificatif de la composante (règle centralisée L71A-C).
  const actives = await activeEvidence({ assetLevel: true });
  const liste = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : String(v ?? '').replace(/[{}"]/g, '').split(',').filter(Boolean));
  for (let i = 0; i < operationIds.length; i += 500) {
    const page = operationIds.slice(i, i + 500);
    for (const c of await rows(r, sql`
      SELECT c.id,
             ARRAY(SELECT DISTINCT s.source_entity_key FROM business_operation_financial_component_sources cs
                     JOIN business_operation_sources s ON s.id = cs.operation_source_id AND s.account_id = c.account_id
                    WHERE cs.component_id = c.id AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key ~ '^[0-9]{1,9}$') AS docs,
             ARRAY(SELECT DISTINCT s.source_entity_key FROM business_operation_financial_component_sources cs
                     JOIN business_operation_sources s ON s.id = cs.operation_source_id AND s.account_id = c.account_id
                    WHERE cs.component_id = c.id AND NOT s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key ~ '^[0-9]{1,9}$') AS withdrawn,
             ARRAY(SELECT DISTINCT s.source_kind FROM business_operation_financial_component_sources cs
                     JOIN business_operation_sources s ON s.id = cs.operation_source_id AND s.account_id = c.account_id
                    WHERE cs.component_id = c.id AND s.active AND s.source_kind <> 'DOCUMENT') AS other_kinds,
             -- Lot 85A (O-9) : identités stables des sources non documentaires (même forme que \`tcoSourceIdentity\`).
             ARRAY(SELECT DISTINCT s.source_kind || ':' || s.source_entity_key || COALESCE(':' || NULLIF(s.locator->>'nature', ''), '')
                     FROM business_operation_financial_component_sources cs
                     JOIN business_operation_sources s ON s.id = cs.operation_source_id AND s.account_id = c.account_id
                    WHERE cs.component_id = c.id AND s.active AND s.source_kind = ANY(${`{${[...TCO_STABLE_SOURCE_KINDS].join(',')}}`}::text[])) AS other_keys,
             ARRAY(SELECT DISTINCT br.normalized_value FROM business_operation_financial_component_sources cs
                     JOIN business_operation_sources s ON s.id = cs.operation_source_id AND s.account_id = c.account_id AND s.active
                     JOIN business_operation_references br ON br.operation_id = c.operation_id AND br.source_id = s.id AND br.account_id = c.account_id
                                                          AND br.active AND br.reference_kind = 'INVOICE'
                    WHERE cs.component_id = c.id) AS invoice_refs,
             EXISTS (SELECT 1 FROM business_operation_financial_component_sources cs
                       JOIN business_operation_sources s ON s.id = cs.operation_source_id AND s.account_id = c.account_id AND s.active AND s.source_kind = 'DOCUMENT'
                       JOIN asset_files f ON f.id = (CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END) AND f.account_id = c.account_id
                      WHERE cs.component_id = c.id
                        AND (abs(f.amount_cents) = c.amount_minor
                             OR EXISTS (SELECT 1 FROM document_operation_candidates dc
                                          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(dc.payload->'financialHints') = 'array'
                                                                                       THEN dc.payload->'financialHints' ELSE '[]'::jsonb END) h
                                         WHERE dc.file_id = f.id AND dc.account_id = f.account_id AND dc.status = 'ACTIVE' AND dc.established
                                           AND h->>'amountMinor' ~ '^[0-9]+$' AND (h->>'amountMinor')::numeric = c.amount_minor))) AS explained,
             EXISTS (SELECT 1 FROM business_operation_financial_component_sources cs
                       JOIN business_operation_sources s ON s.id = cs.operation_source_id AND s.account_id = c.account_id AND s.active AND s.source_kind = 'DOCUMENT'
                      WHERE cs.component_id = c.id AND s.source_entity_key ~ '^[0-9]{1,9}$'
                        AND EXISTS (SELECT 1 FROM field_evidence
                                     WHERE account_id = c.account_id AND status = 'active' AND source_type = 'document'
                                       AND source_id = (CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END)
                                       AND asset_id IS DISTINCT FROM ${assetId} AND field_key = ANY(${`{${ACQUISITION_PRICE_KEYS.join(',')}}`}::text[])${actives})) AS other_asset_price
        FROM business_operation_financial_components c
       WHERE c.account_id = ${accountId} AND c.active AND c.operation_id = ANY(${intArray(page)}::bigint[])`)) {
      const docs = liste(c.docs).map(Number).filter((x) => Number.isSafeInteger(x));
      out.set(Number(c.id), {
        documentFileIds: docs, withdrawnFileIds: liste(c.withdrawn).map(Number).filter((x) => Number.isSafeInteger(x) && !docs.includes(x)),
        otherSourceKinds: liste(c.other_kinds), invoiceRefs: liste(c.invoice_refs), explained: docs.length ? Boolean(c.explained) : null,
        otherAssetAcquisition: Boolean(c.other_asset_price),
        ...(liste(c.other_keys).length ? { otherSourceKeys: liste(c.other_keys).sort() } : {}),
      });
    }
  }
  return out;
}

/**
 * Lot 68 (68A) — documents qui CITENT seulement le bien (lien MENTIONED
 * actif, sans colonne historique ni lien PRIMARY / SECONDARY vers lui)
 * portant un montant ou un candidat T1 établi : jamais une source du TCO du
 * bien ; listés au diagnostic BO pour expliquer leur absence. Plafonné.
 */
export async function readCitedOnlyDocuments(r: Runner, accountId: number, assetId: number): Promise<Array<{ fileId: number; title: string }>> {
  const x = await rows<{ id: number } & DocumentTitleColumns>(r, sql`
    SELECT f.id, ${sql.raw(documentTitleColumnsSql('f'))}
      FROM asset_files f
     WHERE f.account_id = ${accountId} AND f.deleted_at IS NULL
       AND f.asset_id IS DISTINCT FROM ${assetId} AND f.linked_asset_id IS DISTINCT FROM ${assetId}
       AND EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id AND l.status = 'ACTIVE'
                     AND l.link_role = 'MENTIONED' AND l.asset_id = ${assetId})
       AND NOT EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id AND l.status = 'ACTIVE'
                         AND l.link_role IN ${ROLES} AND l.asset_id = ${assetId})
       AND (f.amount_cents IS NOT NULL
            OR EXISTS (SELECT 1 FROM document_operation_candidates c WHERE c.file_id = f.id AND c.account_id = f.account_id AND c.status = 'ACTIVE' AND c.established))
     ORDER BY f.id LIMIT ${CITED_MAX}`);
  return x.map((d) => ({ fileId: Number(d.id), title: documentTitleOf(d) }));
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
 * Documents RATTACHÉS au bien (colonnes historiques, liens N-N actifs de
 * rôle PRIMARY ou SECONDARY — même périmètre que la liste des documents du
 * bien, `asset-document-scope`) portant un
 * montant ou un candidat T1 établi ; leurs candidats ACTIFS établis ; leurs
 * Opérations ACTIVES (non invalidées, non fusionnées). Lot 68 (68A) : un
 * bien seulement CITÉ par l'analyse (lien MENTIONED, ex. adresse du client
 * sur une facture de garage) n'est ni une source du TCO de ce bien, ni un bien
 * d'attribution du document (la facture de la Polo citant la maison n'est
 * plus candidate pour la maison, ni « non ventilée » pour la Polo). Pages sur curseur
 * stable ; garde-fou de volume → lecture PARTIELLE signalée, jamais un total
 * présenté comme complet.
 */
export async function readAssetDocuments(r: Runner, accountId: number, assetId: number): Promise<{ documents: EconomicDocumentInput[]; complete: boolean }> {
  return readEconomicDocuments(r, accountId, { assetId });
}

/**
 * Lot 75J — lecture des entrées économiques de documents : ceux d'un BIEN
 * (TCO, ci-dessus) ou une liste de FICHIERS (T2, `expenseCoverageSignals`).
 * Mêmes colonnes, mêmes candidats, mêmes Opérations (périmètre du compte
 * pour une liste de fichiers) : une seule lecture, une seule règle.
 */
async function readEconomicDocuments(r: Runner, accountId: number, scope: { assetId: number } | { fileIds: readonly number[] }): Promise<{ documents: EconomicDocumentInput[]; complete: boolean }> {
  const parFichiers = 'fileIds' in scope;
  const assetId = parFichiers ? null : scope.assetId;
  const filtre = parFichiers
    ? sql`f.id = ANY(${intArray(scope.fileIds)}::int[])`
    : sql`(EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id AND l.status = 'ACTIVE'
                       AND l.link_role IN ${ROLES} AND l.asset_id = ${assetId})
              OR f.asset_id = ${assetId} OR f.linked_asset_id = ${assetId})
         AND (f.amount_cents IS NOT NULL
              OR EXISTS (SELECT 1 FROM document_operation_candidates c WHERE c.file_id = f.id AND c.account_id = f.account_id AND c.status = 'ACTIVE' AND c.established)
              -- Lot 75D (D) : justificatif financier reconnu SANS montant (facture, quittance…) — lu pour être signalé
              -- « montant inconnu » (jamais 0 €) ; aucune relecture PDF ni IA.
              OR f.document_type_code = ANY(${pgTextArray(EXPENSE_THEME_V2_CODES)}::text[])
              OR concat_ws(' ', f.document_type_code, f.document_type) ~* ${INVOICE_LIKE_SQL})`;
  if (parFichiers && !scope.fileIds.length) return { documents: [], complete: true };
  const lus: Row[] = [];
  let curseur = 0;
  let complete = true;
  for (;;) {
    const lot = await rows(r, sql`
      SELECT f.id, ${sql.raw(documentTitleColumnsSql('f'))},
             f.document_type_code AS v2, f.document_type AS legacy, f.document_date::text AS date, f.supplier,
             f.amount_cents, f.sha256_hash AS hash, f.analysis_state AS state, f.fusion_ignored_with AS ignored,
             COALESCE(f.user_edited_fields->>'amountCents', 'false') = 'true' AS user_amount,
             e.currency, COALESCE(e.multi_asset, false) AS multi_asset,
             ARRAY(SELECT DISTINCT u.x FROM (
                     SELECT l.asset_id AS x FROM document_asset_links l
                      WHERE l.account_id = f.account_id AND l.file_id = f.id AND l.status = 'ACTIVE' AND l.link_role IN ${ROLES}
                     UNION SELECT f.asset_id UNION SELECT f.linked_asset_id) u
                    WHERE u.x IS NOT NULL
                      AND EXISTS (SELECT 1 FROM assets a WHERE a.id = u.x AND a.account_id = f.account_id AND a.deleted_at IS NULL)) AS linked,
             ARRAY(SELECT DISTINCT q.x FROM (
                     SELECT l.equipment_id AS x FROM document_asset_links l
                      WHERE l.account_id = f.account_id AND l.file_id = f.id AND l.status = 'ACTIVE' AND l.link_role IN ${ROLES}
                     UNION SELECT f.equipment_id) q WHERE q.x IS NOT NULL) AS equipments
        FROM asset_files f
        LEFT JOIN LATERAL (SELECT upper(trim(x.currency)) AS currency, x.multi_asset FROM document_extractions x
                            WHERE x.file_id = f.id AND x.account_id = f.account_id ORDER BY x.id DESC LIMIT 1) e ON TRUE
       WHERE f.account_id = ${accountId} AND f.deleted_at IS NULL AND f.id > ${curseur}
         AND ${filtre}
       ORDER BY f.id LIMIT ${DOCS_PAGE}`);
    // Lot 87D : titre par la règle unique des vues (liste, fiche, recherche).
    for (const x of lot) x.title = documentTitleOf(x);
    lus.push(...lot);
    if (lot.length < DOCS_PAGE) break;
    if (lus.length >= DOCS_MAX) { complete = false; break; }
    curseur = Number(lot[lot.length - 1].id);
  }
  const ids = lus.map((d) => Number(d.id));
  const candidats = await readDocumentCandidates(r, accountId, ids);
  const operations = await readDocumentOperations(r, accountId, ids, assetId);
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
      linkedEquipmentIds: (Array.isArray(d.equipments) ? d.equipments : String(d.equipments ?? '').replace(/[{}]/g, '').split(',').filter(Boolean)).map(Number),
      candidates: candidats.get(id) ?? [], operations: operations.get(id) ?? [], acquisitionEvidence: preuves.has(id),
    };
  });
  return { documents, complete };
}

const pgTextArray = (v: readonly string[]): string => `{${v.map((x) => `"${x.replace(/["\\]/g, '')}"`).join(',')}}`;
/** Même motif que `INVOICE_LIKE` (`finance/economic-lines.ts`) : type documentaire de facture ou de ticket. */
const INVOICE_LIKE_SQL = '(INVOICE|FACTURE|TICKET)';

/** Candidats T1 ÉTABLIS et ACTIFS des documents (qualification économique persistée), par fichier. */
async function readDocumentCandidates(r: Runner, accountId: number, ids: readonly number[]): Promise<Map<number, EconomicDocumentInput['candidates']>> {
  const candidats = new Map<number, EconomicDocumentInput['candidates']>();
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
  }
  return candidats;
}

/**
 * Opérations ACTIVES (non invalidées, non fusionnées) dont chaque document est
 * une source active, avec la COUVERTURE au niveau du fait (lot 75D, B) :
 * citation par une composante hors prévision (pour ce bien), composantes
 * citant d'AUTRES justificatifs, natures des composantes sans justificatif.
 * `assetId` null : périmètre du compte (T2).
 */
async function readDocumentOperations(r: Runner, accountId: number, ids: readonly number[], assetId: number | null): Promise<Map<number, EconomicDocumentInput['operations']>> {
  const operations = new Map<number, EconomicDocumentInput['operations']>();
  for (let i = 0; i < ids.length; i += 500) {
    const page = ids.slice(i, i + 500);
    for (const o of await rows(r, sql`
      SELECT s.source_entity_key AS file_key, o.id AS operation_id, o.status, o.type_code, o.technical_label,
             bool_or(EXISTS (SELECT 1 FROM business_operation_financial_component_sources cs
                               JOIN business_operation_financial_components c ON c.id = cs.component_id AND c.active AND c.kind <> 'FORECAST_COST'
                              WHERE cs.operation_source_id = s.id)) AS cites,
             bool_or(EXISTS (SELECT 1 FROM business_operation_financial_component_sources cs
                               JOIN business_operation_financial_components c ON c.id = cs.component_id AND c.active AND c.kind <> 'FORECAST_COST'
                              WHERE cs.operation_source_id = s.id
                                AND (${assetId}::int IS NULL OR c.target_asset_id = ${assetId}
                                     OR (c.target_asset_id IS NULL AND (c.target_equipment_id IS NULL
                                         OR EXISTS (SELECT 1 FROM equipments e WHERE e.id = c.target_equipment_id AND e.asset_id = ${assetId})))))) AS cites_here,
             bool_or(EXISTS (SELECT 1 FROM business_operation_financial_components c
                               JOIN business_operation_financial_component_sources cs ON cs.component_id = c.id
                               JOIN business_operation_sources s2 ON s2.id = cs.operation_source_id AND s2.active AND s2.source_kind = 'DOCUMENT'
                              WHERE c.operation_id = o.id AND c.account_id = o.account_id AND c.active AND c.kind <> 'FORECAST_COST'
                                AND s2.source_entity_key <> s.source_entity_key)) AS cites_other,
             -- Composantes « libres » : qu'aucun justificatif cité n'explique (montant du document ou indice T1 de même
             -- nature et de même montant), ou sans justificatif (fiche, saisie, arbitrage, migration).
             (SELECT coalesce(json_agg(json_build_object('kind', c.kind, 'amountMinor', c.amount_minor, 'currency', trim(c.currency), 'documented', x.documented)), '[]'::json)
                FROM business_operation_financial_components c
                CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM business_operation_financial_component_sources cs
                                                     JOIN business_operation_sources s2 ON s2.id = cs.operation_source_id AND s2.active AND s2.source_kind = 'DOCUMENT'
                                                    WHERE cs.component_id = c.id) AS documented) x
               WHERE c.operation_id = o.id AND c.account_id = o.account_id AND c.active AND c.kind <> 'FORECAST_COST'
                 AND NOT EXISTS (
                   SELECT 1 FROM business_operation_financial_component_sources cs
                     JOIN business_operation_sources s2 ON s2.id = cs.operation_source_id AND s2.active AND s2.source_kind = 'DOCUMENT'
                     JOIN asset_files f ON f.id::text = s2.source_entity_key AND f.account_id = c.account_id
                    WHERE cs.component_id = c.id
                      AND (abs(f.amount_cents) = c.amount_minor
                           OR EXISTS (SELECT 1 FROM document_operation_candidates dc
                                        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(dc.payload->'financialHints') = 'array'
                                                                                     THEN dc.payload->'financialHints' ELSE '[]'::jsonb END) h
                                       WHERE dc.file_id = f.id AND dc.account_id = f.account_id AND dc.status = 'ACTIVE' AND dc.established
                                         AND h->>'role' = c.kind AND h->>'amountMinor' ~ '^[0-9]+$' AND (h->>'amountMinor')::numeric = c.amount_minor)))) AS free_components,
             EXISTS (SELECT 1 FROM business_operation_financial_components c WHERE c.operation_id = o.id AND c.account_id = o.account_id AND c.active AND c.kind <> 'FORECAST_COST') AS exploitable,
             EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.account_id = o.account_id AND l.active) AS has_assets,
             (${assetId}::int IS NULL
              OR EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.account_id = o.account_id AND l.active AND l.asset_id = ${assetId})
              OR EXISTS (SELECT 1 FROM business_operation_equipment_links q WHERE q.operation_id = o.id AND q.account_id = o.account_id AND q.active AND q.asset_id = ${assetId})) AS in_scope
        FROM business_operation_sources s
        JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id
       WHERE s.account_id = ${accountId} AND s.source_kind = 'DOCUMENT' AND s.active
         AND s.source_entity_key = ANY(${`{${page.join(',')}}`}::text[])
         AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
       GROUP BY s.source_entity_key, o.id, o.status, o.type_code, o.technical_label, o.account_id`)) {
      const f = Number(o.file_key);
      const nom = NOMS[String(o.type_code ?? 'OTHER')] ?? 'Dépense';
      const libres = asArray(asJson(o.free_components)).map((c) => ({
        kind: String(c.kind ?? ''), amountMinor: Number(c.amountMinor ?? 0), currency: String(c.currency ?? ''), documented: Boolean(c.documented),
      }));
      operations.set(f, [...(operations.get(f) ?? []), {
        operationId: Number(o.operation_id), label: txt(o.technical_label) ? `${nom} — ${String(o.technical_label).slice(0, 80)}` : nom,
        inScope: Boolean(o.in_scope), cancelled: o.status === 'CANCELLED', hasAssets: Boolean(o.has_assets),
        exploitable: Boolean(o.exploitable), citesDocument: Boolean(o.cites), typeCode: txt(o.type_code),
        citesForOtherAssetOnly: Boolean(o.cites) && !o.cites_here, citesOtherDocuments: Boolean(o.cites_other), freeComponents: libres,
      }]);
    }
  }
  return operations;
}

/**
 * Lot 75J (point laissé par 75D, cohérence T2 / TCO) — SIGNAUX DE COUVERTURE
 * INCERTAINE des dépenses que T2 totalise, calculés par la MÊME règle que le
 * TCO (`qualifyDocumentLines` : rapprochement incertain d'un acompte / solde,
 * justificatif financier sans montant lisible) — aucune seconde logique
 * financière, aucun montant recalculé. `fileIds` : documents COMPTÉS par T2 ;
 * s'y ajoutent les justificatifs financiers SANS montant du périmètre (biens,
 * compte, année). Le TCO passe alors en INCOMPLETE ; T2 dit « total peut-être
 * incomplet ».
 */
export async function expenseCoverageSignals(
  accountId: number,
  o: { fileIds: readonly number[]; assetIds: readonly number[] | null; year: number | null; today?: string },
  r: Runner = db,
): Promise<{ uncertain: number[]; amountUnknown: Array<{ fileId: number; theme: string | null; title: string }>; complete: boolean }> {
  const ids = o.assetIds?.length ? [...new Set(o.assetIds)] : null;
  const LIMITE = 1000;
  const sansMontant = await rows(r, sql`
    SELECT f.id FROM asset_files f
     WHERE f.account_id = ${accountId} AND f.deleted_at IS NULL AND f.amount_cents IS NULL
       AND (f.document_type_code = ANY(${pgTextArray(EXPENSE_THEME_V2_CODES)}::text[])
            OR concat_ws(' ', f.document_type_code, f.document_type) ~* ${INVOICE_LIKE_SQL})
       AND (${o.year}::int IS NULL OR f.document_date IS NULL OR extract(year FROM f.document_date)::int = ${o.year}::int)
       AND (${ids == null}::boolean
            OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.account_id = f.account_id AND l.file_id = f.id AND l.status = 'ACTIVE'
                        AND l.link_role IN ${ROLES} AND l.asset_id = ANY(${intArray(ids ?? [])}::int[]))
            OR f.asset_id = ANY(${intArray(ids ?? [])}::int[]) OR f.linked_asset_id = ANY(${intArray(ids ?? [])}::int[]))
     ORDER BY f.id LIMIT ${LIMITE + 1}`);
  const complete = sansMontant.length <= LIMITE;
  const tous = [...new Set([...o.fileIds.filter((x) => Number.isSafeInteger(x) && x > 0), ...sansMontant.slice(0, LIMITE).map((x) => Number(x.id))])];
  if (!tous.length) return { uncertain: [], amountUnknown: [], complete };
  const { documents } = await readEconomicDocuments(r, accountId, { fileIds: tous });
  const { qualifyDocumentLines } = await import('../finance/economic-lines');
  const drafts = qualifyDocumentLines(documents, { today: o.today ?? new Date().toISOString().slice(0, 10) });
  const comptes = new Set(o.fileIds);
  const sansMontantIds = new Set(sansMontant.map((x) => Number(x.id)));
  const uncertain = [...new Set(drafts.filter((d) => d.status === null && d.uncertain && comptes.has(d.fileId)).map((d) => d.fileId))];
  const vus = new Set<number>();
  const amountUnknown: Array<{ fileId: number; theme: string | null; title: string }> = [];
  for (const d of drafts) {
    // Montant inconnu (règle du TCO) ; ou justificatif sans montant sur la fiche du document dont seuls les
    // indices T1 portent le coût : le TCO le compte, le total T2 (montants des documents) ne le lit pas — signalé.
    const nonLu = d.status === null && d.kind === 'REALIZED_COST' && !comptes.has(d.fileId) && sansMontantIds.has(d.fileId);
    if ((d.reason !== 'AMOUNT_UNKNOWN' && !nonLu) || vus.has(d.fileId)) continue;
    vus.add(d.fileId);
    amountUnknown.push({ fileId: d.fileId, theme: d.theme ?? null, title: d.title });
  }
  return { uncertain, amountUnknown, complete };
}

/**
 * Lot 75D (B, cohérence T2 / TCO) — pour chaque document, Opérations actives
 * dont il est source et qui NE couvrent PAS son fait (`operationCoverage` :
 * pas de composante qui le reprend, achat distinct, Opération sans montant) :
 * le justificatif y fait foi. MÊME règle que le TCO, lue par T2
 * (`sumQualifiedExpenses`) — aucune seconde logique financière.
 */
export async function documentsNotCoveredByOperations(accountId: number, fileIds: readonly number[], r: Runner = db): Promise<Map<number, Set<number>>> {
  const ids = [...new Set(fileIds.filter((x) => Number.isSafeInteger(x) && x > 0))];
  const out = new Map<number, Set<number>>();
  if (!ids.length) return out;
  const docs = new Map<number, { title: string; amountCents: number | null; userEditedAmount: boolean; typeCode: string | null; legacyType: string | null }>();
  for (let i = 0; i < ids.length; i += 1000) {
    const page = ids.slice(i, i + 1000);
    for (const d of await rows(r, sql`
      SELECT f.id, ${sql.raw(documentTitleColumnsSql('f'))}, f.amount_cents,
             f.document_type_code AS v2, f.document_type AS legacy,
             COALESCE(f.user_edited_fields->>'amountCents', 'false') = 'true' AS user_amount
        FROM asset_files f WHERE f.account_id = ${accountId} AND f.id = ANY(${intArray(page)}::int[])`)) {
      docs.set(Number(d.id), { title: documentTitleOf(d), amountCents: n(d.amount_cents), userEditedAmount: Boolean(d.user_amount), typeCode: txt(d.v2), legacyType: txt(d.legacy) });
    }
  }
  const [candidats, operations, preuves] = [
    await readDocumentCandidates(r, accountId, ids), await readDocumentOperations(r, accountId, ids, null), await acquisitionEvidenceFiles(r, accountId, ids),
  ];
  for (const [fileId, ops] of operations) {
    const d = docs.get(fileId);
    if (!d) continue;
    const entree = { ...d, candidates: candidats.get(fileId) ?? [], acquisitionEvidence: preuves.has(fileId) };
    const non = ops.filter((o) => !o.cancelled && operationCoverage(o, entree) !== 'COVERED' && operationCoverage(o, entree) !== 'INCLUDED_IN_TOTAL');
    if (non.length) out.set(fileId, new Set(non.map((o) => o.operationId)));
  }
  return out;
}

/**
 * L71A-C — règle UNIQUE de preuve ACTIVE pour le TCO : le filtre de lecture
 * canonique des preuves (`evidenceReadFilter` : cycle de vie ACTIVE, jamais
 * WITHDRAWN ni SUPERSEDED ; `assetLevel` : preuve du bien lui-même). Toutes
 * les lectures de preuves du TCO (et de T2, via `acquisitionEvidenceFiles`)
 * passent par ici.
 */
async function activeEvidence(opts: { assetLevel: boolean }): Promise<SQL> {
  return sql.raw(await evidenceReadFilter({ assetLevel: opts.assetLevel }));
}

/** Clés du prix d'achat (clé canonique et alias historiques). */
const ACQUISITION_PRICE_KEYS = ['acquisitionPrice', 'purchasePrice', 'prixAchat', 'prixAcquisition', 'purchasePriceCents'];

/**
 * Documents (parmi `fileIds`) preuves ACTIVES du prix d'achat d'un bien du
 * compte (T1 a lu sur le document le prix d'acquisition du bien). Lot 61.
 * Lot 71A : preuves du BIEN seulement (cible NULL ou ASSET = le bien) — le
 * prix lu pour un équipement n'en fait pas la facture d'achat du bien.
 */
export async function acquisitionEvidenceFiles(r: Runner, accountId: number, fileIds: readonly number[]): Promise<Set<number>> {
  const out = new Set<number>();
  if (!fileIds.length) return out;
  // L71A-C : preuves ACTIVES seulement (jamais WITHDRAWN ni SUPERSEDED), preuves du bien lui-même — règle centralisée.
  const actives = await activeEvidence({ assetLevel: true });
  for (let i = 0; i < fileIds.length; i += 1000) {
    const page = fileIds.slice(i, i + 1000);
    for (const x of await rows<{ id: number }>(r, sql`
      SELECT DISTINCT source_id AS id FROM field_evidence
       WHERE account_id = ${accountId} AND status = 'active' AND source_type = 'document'
         AND source_id = ANY(${intArray(page)}::int[]) AND field_key = ANY(${`{${ACQUISITION_PRICE_KEYS.join(',')}}`}::text[])${actives}`)) out.add(Number(x.id));
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
 * Lot 75D (H) — un achat du bien est-il attendu ? Non : véhicule en LLD /
 * LOA / prêt (même règle que l'achat structuré, lot 43 C13), logement occupé
 * en location ou à titre gratuit, objet reçu (don, cadeau, héritage,
 * succession), prêté ou loué. Pure, sur la vue canonique de la fiche.
 */
export function acquisitionExpectedOf(row: AssetRowJson): boolean {
  const v = (k: string) => { const x = readCanonicalValue(row, k)?.value; return typeof x === 'string' ? x.trim() : null; };
  if (row.category === 'VEHICULE' && ['LLD', 'LOA', 'PRET_GRATUIT'].includes(v('vehicleOwnershipStatus') ?? '')) return false;
  if (row.category === 'IMMOBILIER' && ['LOCATAIRE', 'OCCUPANT_GRATUIT'].includes(v('occupancyStatus') ?? '')) return false;
  const mode = (v('acquisitionMode') ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (row.category === 'OBJET' && /\b(don|donation|cadeau|offert|heritage|herite|succession|legs|pret|prete|location|loue)\b/.test(mode)) return false;
  return true;
}

/**
 * Prix d'achat de la fiche (valeur canonique : clé, alias ou colonne miroir),
 * son origine et ses preuves documentaires actives (facture d'achat = même
 * fait). Devise : `acquisitionCurrency` si renseignée, euro sinon. Lot 75D
 * (H) : rend aussi si un achat est attendu (`acquisitionExpectedOf`).
 */
export async function readAssetAcquisition(r: Runner, accountId: number, assetId: number): Promise<{ price: TcoAssetPrice | null; expected: boolean }> {
  const [x] = await rows<{ j: unknown }>(r, sql`SELECT row_to_json(a) AS j FROM assets a WHERE a.id = ${assetId} AND a.account_id = ${accountId} AND a.deleted_at IS NULL`);
  const row = asJson(x?.j) as AssetRowJson | null;
  if (!row) return { price: null, expected: true };
  // Même règle que l'achat structuré (lot 43, C13) : un véhicule en LLD / LOA / prêt n'a pas d'acquisition.
  const expected = acquisitionExpectedOf(row);
  const detention = readCanonicalValue(row, 'vehicleOwnershipStatus');
  if (row.category === 'VEHICULE' && typeof detention?.value === 'string' && ['LLD', 'LOA', 'PRET_GRATUIT'].includes(detention.value)) return { price: null, expected };
  const st = readCanonicalValue(row, 'acquisitionPrice');
  const eur = typeof st?.value === 'number' ? st.value : Number(st?.value);
  if (!st || !Number.isFinite(eur) || eur <= 0) return { price: null, expected };
  const devise = readCanonicalValue(row, 'acquisitionCurrency');
  const currency = typeof devise?.value === 'string' && /^[A-Za-z]{3}$/.test(devise.value.trim()) ? devise.value.trim().toUpperCase() : 'EUR';
  // Lot 71A : preuves du BIEN lui-même — la facture d'un équipement (preuve ciblant l'équipement, portée par le bien)
  // n'est jamais la preuve du prix du bien. L71A-C : preuves ACTIVES seulement (règle centralisée).
  const actives = await activeEvidence({ assetLevel: true });
  const preuves = await rows<{ id: number }>(r, sql`
    SELECT DISTINCT source_id AS id FROM field_evidence
     WHERE account_id = ${accountId} AND asset_id = ${assetId} AND status = 'active' AND source_type = 'document'
       AND field_key = ANY(${`{${ACQUISITION_PRICE_KEYS.join(',')}}`}::text[])${actives}`);
  return { price: { amountMinor: Math.round(eur * 100), currency, origin: st.origin ?? null, evidenceFileIds: preuves.map((p) => Number(p.id)) }, expected };
}

/** Prix d'achat de la fiche seul (compatibilité). */
export async function readAssetPrice(r: Runner, accountId: number, assetId: number): Promise<TcoAssetPrice | null> {
  return (await readAssetAcquisition(r, accountId, assetId)).price;
}

const EQUIPMENTS_PAGE = 500;
const EQUIPMENTS_MAX = 20_000;

/**
 * Lot 71A — prix d'achat de la fiche de chaque équipement ACTUEL du bien
 * (vue canonique de l'équipement : fiche puis colonne miroir), sa date
 * d'achat propre (jamais celle du bien) et ses preuves documentaires actives
 * (preuves CIBLANT l'équipement). Euro (le registre porte le prix en euros).
 * Lot 75D (I) : pages sur curseur stable (`e.id`) — plus de borne silencieuse
 * à 500 ; garde-fou de volume → lecture PARTIELLE signalée (`complete`).
 */
export async function readEquipmentPrices(r: Runner, accountId: number, assetId: number): Promise<{ prices: TcoEquipmentPrice[]; complete: boolean }> {
  const eqs: Array<{ id: number; name: string; kc: unknown; ppc: number | null; evc: number | null }> = [];
  let curseur = 0;
  let complete = true;
  for (;;) {
    const lot = await rows<{ id: number; name: string; kc: unknown; ppc: number | null; evc: number | null }>(r, sql`
      SELECT e.id, e.name, to_jsonb(e)->'key_characteristics' AS kc, e.purchase_price_cents AS ppc, e.estimated_value_cents AS evc
        FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = ${accountId} AND a.deleted_at IS NULL
       WHERE e.asset_id = ${assetId} AND e.archived_at IS NULL AND e.id > ${curseur} ORDER BY e.id LIMIT ${EQUIPMENTS_PAGE}`);
    eqs.push(...lot);
    if (lot.length < EQUIPMENTS_PAGE) break;
    if (eqs.length >= EQUIPMENTS_MAX) { complete = false; break; }
    curseur = Number(lot[lot.length - 1].id);
  }
  if (!eqs.length) return { prices: [], complete };
  const { buildCanonicalEntityState } = await import('@/services/canonical/entity-state/entity-view');
  const out: TcoEquipmentPrice[] = [];
  for (const e of eqs) {
    const kc = (asJson(e.kc) ?? {}) as Record<string, unknown>;
    const st = buildCanonicalEntityState({
      target: { type: 'EQUIPMENT', id: Number(e.id) }, assetId, accountId, name: e.name, archived: false, kc,
      columns: { 'equipments.purchase_price_cents': e.ppc ?? null, 'equipments.estimated_value_cents': e.evc ?? null },
    });
    const prix = Number(st.fields.acquisitionPrice?.value);
    if (!Number.isFinite(prix) || prix <= 0) continue;
    const date = txt(st.fields.acquisitionDate?.value);
    out.push({ equipmentId: Number(e.id), name: String(e.name ?? 'Équipement'), amountMinor: Math.round(prix * 100), currency: 'EUR',
      date, origin: st.fields.acquisitionPrice?.origin ?? null, evidenceFileIds: [] });
  }
  if (!out.length) return { prices: out, complete };
  // L71A-C : preuves ACTIVES seulement (jamais WITHDRAWN ni SUPERSEDED) — règle centralisée.
  const actives = await activeEvidence({ assetLevel: false });
  const preuves: Array<{ id: number; source_id: number }> = [];
  for (let i = 0; i < out.length; i += 1000) {
    preuves.push(...await rows<{ id: number; source_id: number }>(r, sql`
      SELECT DISTINCT target_entity_id AS id, source_id FROM field_evidence
       WHERE account_id = ${accountId} AND status = 'active' AND source_type = 'document' AND target_type = 'EQUIPMENT'${actives}
         AND target_entity_id = ANY(${intArray(out.slice(i, i + 1000).map((x) => x.equipmentId))}::int[])
         AND field_key = ANY(${`{${ACQUISITION_PRICE_KEYS.join(',')}}`}::text[])`));
  }
  return { prices: out.map((x) => ({ ...x, evidenceFileIds: preuves.filter((p) => Number(p.id) === x.equipmentId).map((p) => Number(p.source_id)) })), complete };
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

// ── Lot 80A : décisions « Ajouter / Retirer du TCO » (table 0623) ──────────

/** La table des décisions existe-t-elle ? (déploiement avant migration : aucune décision, jamais d'erreur). */
async function tableDecisionsPresente(r: Runner): Promise<boolean> {
  const [t] = await rows<{ ok: boolean }>(r, sql`SELECT to_regclass('asset_cost_line_decisions') IS NOT NULL AS ok`);
  return Boolean(t?.ok);
}

/** Décisions actives de l'utilisateur sur les lignes du TCO d'un bien du compte (lecture seule). */
export async function readTcoLineDecisions(r: Runner, accountId: number, assetId: number): Promise<TcoUserDecision[]> {
  if (!(await tableDecisionsPresente(r))) return [];
  const x = await rows(r, sql`
    SELECT d.line_key, d.decision, to_char(d.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at, d.decided_by
      FROM asset_cost_line_decisions d JOIN assets a ON a.id = d.asset_id AND a.account_id = d.account_id
     WHERE d.account_id = ${accountId} AND d.asset_id = ${assetId}
     ORDER BY d.decided_at DESC, d.id DESC LIMIT 5000`);
  return x
    .filter((d) => d.decision === 'INCLUDE' || d.decision === 'EXCLUDE')
    .map((d) => ({ key: String(d.line_key), decision: d.decision as TcoUserDecision['decision'], decidedAt: String(d.decided_at), decidedByUserId: d.decided_by == null ? null : Number(d.decided_by) }));
}
