/**
 * Lot 85A (O-2, CDC v5 §20.4) — reconstruction d'un compte APRÈS la purge,
 * par les services métier EXISTANTS uniquement (aucun nouveau moteur, aucune
 * nouvelle analyse T1 : les candidats T1 persistés ont été remis en
 * consolidation par la purge). Chaque service prend lui-même le verrou
 * Opération du compte pour chacune de ses transactions.
 *
 *   §20.4  étape                              service existant
 *   ─────  ─────────────────────────────────  ────────────────────────────────
 *   1–3    documents, agenda, données fiche   consolidateAccountOperations
 *          (relus, traitements nécessaires)   (T3 complet : fiche de chaque bien,
 *                                             éléments d'agenda sources, documents,
 *                                             attentes, M3 sous ses plafonds)
 *   4–5    Opérations et membres              idem, passages enchaînés
 *   —      séries récurrentes (§20.4 fin)     requestAccountRetroReconciliation (55B)
 *                                             + reconsolidateForAsset (84E) par bien
 *   9      composantes financières            reconsolidateAllActiveOperations
 *   8      liens biens / Pièces / équipements recomputeDirectLinksForOperations (84E)
 *   6–7    principaux, documents propagés     projectAccountOperations (83A, 82D)
 *   11     « À traiter »                      cartes des passages T3 et de la projection
 *   10     TCO                                relu (`readAssetTco`, calculé à la lecture)
 *   12     rapport                            `service.ts`
 *
 * Un dernier passage T3 + projection contrôle la convergence (il ne doit plus
 * rien écrire) : la reconstruction est ensuite idempotente (AC43).
 */
import type { OperationMatchDeps, OperationMatchPhaseResult } from '../consolidation/m3';
import { MAX_CONSOLIDATION_PASSES } from './model';

type Sql = typeof import('@/db').pgClient;

interface RebuildStepsOptions {
  correlationId: string;
  today?: string;
  /** Niveau M3 : dépendances injectables (tests) ; `false` le coupe. Défaut : passerelle réelle sous ses plafonds. */
  operationMatch?: false | OperationMatchDeps;
  /** Garde avant chaque écriture (compte devenu non éligible, interruption). */
  beforeWrite?: (what: string) => Promise<void>;
  log?: (m: string) => void;
}

export interface RebuildStepsReport {
  consolidation: { passes: number; documents: number; changes: number; errors: number; remaining: boolean; outcomes: Record<string, number> };
  series: { retroMarked: number; assets: number; changes: number; passes: number };
  reconsolidated: { operations: number; changes: number; errors: number };
  directLinks: { operations: number; created: number; examined: number };
  projection: { created: number; linked: number; removed: number; detached: number; roles: number; principalLinks: number; changes: number; matchCards: number; dateCards: number };
  convergence: { consolidationChanges: number; projectionChanges: number };
  m3: { calls: number; deferred: number; deferredReasons: Record<string, number>; errors: number };
  errors: string[];
}

const add = (a: Record<string, number>, b: Partial<Record<string, number>> | undefined) => {
  for (const [k, v] of Object.entries(b ?? {})) a[k] = (a[k] ?? 0) + (v ?? 0);
};

async function pg(): Promise<Sql> { return (await import('@/db')).pgClient; }

async function accountAssets(accountId: number): Promise<number[]> {
  return ((await (await pg()).unsafe(`SELECT id FROM assets WHERE account_id = $1 AND deleted_at IS NULL ORDER BY id`, [accountId] as never[])) as unknown as Array<{ id: number }>).map((x) => Number(x.id));
}

async function activeOperationIds(accountId: number): Promise<number[]> {
  return ((await (await pg()).unsafe(
    `SELECT id FROM business_operations WHERE account_id = $1 AND invalidated_at IS NULL AND merged_into_operation_id IS NULL ORDER BY id`,
    [accountId] as never[])) as unknown as Array<{ id: number }>).map((x) => Number(x.id));
}

/** Enchaîne la reconstruction d'un compte (voir l'en-tête). Ne purge rien. */
export async function rebuildAccount(accountId: number, agendaSourceItems: readonly number[], o: RebuildStepsOptions): Promise<RebuildStepsReport> {
  const log = o.log ?? (() => undefined);
  const rep: RebuildStepsReport = {
    consolidation: { passes: 0, documents: 0, changes: 0, errors: 0, remaining: false, outcomes: {} },
    series: { retroMarked: 0, assets: 0, changes: 0, passes: 0 },
    reconsolidated: { operations: 0, changes: 0, errors: 0 },
    directLinks: { operations: 0, created: 0, examined: 0 },
    projection: { created: 0, linked: 0, removed: 0, detached: 0, roles: 0, principalLinks: 0, changes: 0, matchCards: 0, dateCards: 0 },
    convergence: { consolidationChanges: 0, projectionChanges: 0 },
    m3: { calls: 0, deferred: 0, deferredReasons: {}, errors: 0 },
    errors: [],
  };
  const { consolidateAccountOperations } = await import('../consolidation/consolidator');
  const base = { correlationId: o.correlationId, today: o.today, beforeWrite: o.beforeWrite, ...(o.operationMatch !== undefined ? { operationMatch: o.operationMatch } : {}) };
  const m3 = (r: OperationMatchPhaseResult | undefined) => {
    if (!r) return;
    rep.m3.calls += r.calls; rep.m3.deferred += r.deferred; rep.m3.errors += r.errors;
    add(rep.m3.deferredReasons, r.deferredReasons);
  };

  /** Passages T3 enchaînés jusqu'à épuisement (bornés). */
  const consolider = async (premier: { assetIds?: number[]; agendaItemIds?: number[] }, cible: { passes: number; changes: number }) => {
    let remaining = true;
    for (let i = 0; i < MAX_CONSOLIDATION_PASSES && remaining; i++) {
      const r = await consolidateAccountOperations(accountId, { ...base, ...(i === 0 ? premier : {}), reevaluateHolds: true });
      cible.passes++;
      cible.changes += r.changes;
      rep.consolidation.documents += r.documents;
      rep.consolidation.errors += r.errors;
      add(rep.consolidation.outcomes, r.outcomes);
      m3(r.m3);
      for (const t of r.technicalErrors ?? []) rep.errors.push(`T3 document ${t.fileId ?? '—'} : ${t.code}`);
      remaining = r.remaining;
      // Rien n'a bougé et plus rien d'attendu : convergé.
      if (!r.remaining && r.changes === 0 && i > 0) break;
    }
    rep.consolidation.remaining = remaining;
  };

  // 1–5. T3 complet : données structurées de TOUS les biens, éléments d'agenda sources, documents (candidats persistés).
  const biens = await accountAssets(accountId);
  log(`compte ${accountId} : consolidation T3 (${biens.length} bien(s), ${agendaSourceItems.length} élément(s) d'agenda source)`);
  await consolider({ assetIds: biens, agendaItemIds: [...agendaSourceItems] }, rep.consolidation);

  // Séries récurrentes : réexamen rétroactif (55B) puis reconsolidation ciblée de chaque bien (84E).
  const { requestAccountRetroReconciliation } = await import('../consolidation/retro');
  rep.series.retroMarked = await requestAccountRetroReconciliation(accountId);
  const { reconsolidateForAsset } = await import('../consolidation/targeted');
  for (const assetId of biens) {
    const r = await reconsolidateForAsset(accountId, assetId, { trigger: 'operations_rebuild', correlationId: o.correlationId, today: o.today, beforeWrite: o.beforeWrite });
    rep.series.assets++;
    rep.series.changes += r.changes;
    rep.errors.push(...r.errors.map((e) => `séries du bien ${assetId} : ${e}`));
  }
  await consolider({}, rep.series);

  // 9. Opérations actives (dont les conservées) recalculées depuis leurs sources : composantes, cibles, détails.
  const { reconsolidateAllActiveOperations } = await import('../consolidation/queue');
  const rc = await reconsolidateAllActiveOperations(accountId, { correlationId: o.correlationId, today: o.today, beforeWrite: o.beforeWrite });
  rep.reconsolidated = { operations: rc.operations, changes: rc.changes, errors: rc.errors };

  // 8. Liens directs Document ↔ Équipement de chaque document membre (preuve propre au document, garde anti-cartésienne).
  const { recomputeDirectLinksForOperations } = await import('../consolidation/targeted');
  const actives = await activeOperationIds(accountId);
  for (let i = 0; i < actives.length; i += 100) {
    const r = await recomputeDirectLinksForOperations(accountId, actives.slice(i, i + 100), { trigger: 'operations_rebuild', correlationId: o.correlationId, today: o.today, beforeWrite: o.beforeWrite });
    rep.directLinks.created += r.directLinks.created;
    rep.directLinks.examined += r.directLinks.examined;
    rep.errors.push(...r.errors.map((e) => `liens directs : ${e}`));
  }
  rep.directLinks.operations = actives.length;

  // 6–7, 11. Projection Agenda COMPLÈTE : principaux, documents propagés, cartes de rapprochement et de date.
  const { projectAccountOperations } = await import('../agenda-projection/service');
  const pr = await projectAccountOperations(accountId, { all: true, correlationId: o.correlationId, today: o.today });
  if (pr.skipped) rep.errors.push(`projection Agenda : ${pr.skipped}`);
  rep.projection = {
    created: pr.created, linked: pr.linked, removed: pr.removed, detached: pr.detached, roles: pr.roles ?? 0, principalLinks: pr.principalLinks ?? 0,
    changes: pr.changes, matchCards: pr.matchCards ?? 0, dateCards: pr.dateCards ?? 0,
  };

  // Convergence : un passage T3 et une projection de plus ne doivent (presque) plus rien écrire.
  const fin = { passes: 0, changes: 0 };
  await consolider({}, fin);
  rep.convergence.consolidationChanges = fin.changes;
  const pr2 = await projectAccountOperations(accountId, { all: true, correlationId: o.correlationId, today: o.today });
  rep.convergence.projectionChanges = pr2.changes;
  return rep;
}

// ── Lectures du rapport ─────────────────────────────────────────────────────

export interface TcoSnapshot {
  assets: Array<{
    assetId: number; cumulativeCostCents: number | null; retainedLines: number; decisionsApplied: number; orphanDecisions: number;
    /** Lignes retenues (clé stable → montant inclus) : comparaison fine avant / après. */
    retained: Record<string, number>;
    error?: string;
  }>;
}

/** TCO relu de chaque bien (moteur existant, lecture seule) : coût cumulé, lignes retenues, décisions appliquées / orphelines. */
export async function readAccountTco(accountId: number, today?: string): Promise<TcoSnapshot> {
  const { readAssetTco } = await import('../tco/service');
  const out: TcoSnapshot = { assets: [] };
  for (const assetId of await accountAssets(accountId)) {
    try {
      const t = await readAssetTco(accountId, assetId, { today });
      const retenues = t.lines.filter((l) => l.status === 'RETAINED_DIRECT' || l.status === 'RETAINED_CONSOLIDATED');
      const retained: Record<string, number> = {};
      for (const l of retenues) retained[l.decisionKey ?? l.id] = (retained[l.decisionKey ?? l.id] ?? 0) + l.includedCents;
      out.assets.push({
        assetId, cumulativeCostCents: t.summary.cumulativeCostCents, retainedLines: retenues.length,
        decisionsApplied: t.userDecisions.applied, orphanDecisions: t.userDecisions.orphans.length, retained,
      });
    } catch (e) {
      out.assets.push({ assetId, cumulativeCostCents: null, retainedLines: 0, decisionsApplied: 0, orphanDecisions: 0, retained: {}, error: (e as Error).message.slice(0, 200) });
    }
  }
  return out;
}

/** Écarts de TCO entre deux lectures (pure). */
export function tcoDifferences(a: TcoSnapshot, b: TcoSnapshot): string[] {
  const out: string[] = [];
  for (const x of a.assets) {
    const y = b.assets.find((z) => z.assetId === x.assetId);
    if (!y) continue;
    if (x.cumulativeCostCents !== y.cumulativeCostCents) out.push(`bien ${x.assetId} : coût cumulé ${x.cumulativeCostCents ?? '—'} → ${y.cumulativeCostCents ?? '—'} (centimes)`);
    if (x.decisionsApplied !== y.decisionsApplied) out.push(`bien ${x.assetId} : décisions TCO appliquées ${x.decisionsApplied} → ${y.decisionsApplied}`);
    if (y.orphanDecisions > x.orphanDecisions) out.push(`bien ${x.assetId} : décisions TCO sans ligne ${x.orphanDecisions} → ${y.orphanDecisions}`);
  }
  return out;
}

/** Opérations actives du compte décrites sans identifiant technique (signature métier, AC43). */
export async function readSignatureOperations(sql: import('postgres').Sql, accountId: number): Promise<import('./model').SignatureOperation[]> {
  const r = (await sql.unsafe(`
    SELECT o.type_code, o.status, o.realized_date::text AS realized_date, o.planned_date::text AS planned_date, o.start_date::text AS start_date,
           o.end_date::text AS end_date, o.provider,
           COALESCE((SELECT array_agg(DISTINCT s.source_entity_key::int) FROM business_operation_sources s
                      WHERE s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key ~ '^[0-9]{1,9}$'), '{}') AS documents,
           COALESCE((SELECT array_agg(DISTINCT l.asset_id) FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.active), '{}') AS assets,
           COALESCE((SELECT array_agg(DISTINCT l.equipment_id) FROM business_operation_equipment_links l WHERE l.operation_id = o.id AND l.active), '{}') AS equipments,
           COALESCE((SELECT array_agg(DISTINCT l.substructure_id) FROM business_operation_room_links l WHERE l.operation_id = o.id AND l.active), '{}') AS rooms,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', c.kind, 'amountMinor', c.amount_minor, 'currency', trim(c.currency), 'date', c.economic_date::text,
                                                         'periodStart', c.period_start::text, 'periodEnd', c.period_end::text))
                       FROM business_operation_financial_components c WHERE c.operation_id = o.id AND c.active), '[]'::jsonb) AS components,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('title', i.title, 'date', i.start_date::text, 'role', i.operation_role, 'automatic', i.is_automatic))
                       FROM agenda_items i WHERE i.business_operation_id = o.id AND i.account_id = o.account_id), '[]'::jsonb) AS agenda
      FROM business_operations o
     WHERE o.account_id = $1 AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`, [accountId] as never[])) as unknown as Array<Record<string, unknown>>;
  const nums = (v: unknown) => (Array.isArray(v) ? v.map(Number) : []);
  const txt = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return r.map((x) => ({
    type: txt(x.type_code), status: String(x.status), realizedDate: txt(x.realized_date), plannedDate: txt(x.planned_date),
    startDate: txt(x.start_date), endDate: txt(x.end_date), provider: txt(x.provider),
    documents: nums(x.documents), assets: nums(x.assets), equipments: nums(x.equipments), rooms: nums(x.rooms),
    components: (x.components as import('./model').SignatureOperation['components']) ?? [],
    agenda: (x.agenda as import('./model').SignatureOperation['agenda']) ?? [],
  }));
}
