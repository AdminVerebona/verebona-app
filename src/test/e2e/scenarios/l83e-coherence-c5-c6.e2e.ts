/**
 * Lot 83E — contrôle de cohérence global, lots C5 (Agenda / T4 / « À
 * traiter ») et C6 (T6, notifications, abonnements, Duo), sur PostgreSQL 16
 * réel (toutes les migrations, dont 0676). Arbitrages PO du 23/10/2026 C-Q1,
 * C-Q2, C-Q3, C-Q4, C-Q9, C-Q10, C-Q11.
 *
 *   L83E-E2E-01  échéance CALCULABLE absente (Opération réalisée sans
 *                événement) → recréée par la projection (même moteur, sans
 *                IA) puis recontrôlée ; second passage sans réparation ;
 *   L83E-E2E-02  événements OBSOLÈTES : Opération invalidée (projection
 *                retirée, tracée), projection orpheline, événement
 *                documentaire dont la source a été retirée ;
 *   L83E-E2E-03  ancien runner de pertinence RETIRÉ : la tâche ne lance plus
 *                de campagne, l'historique reste lisible (0676), une anomalie
 *                est corrigée par UNE seule chaîne (contrôle du registre) ;
 *   L83E-E2E-04  cartes orphelines (document, bien, équipement supprimés)
 *                fermées par le service des cartes, tracées ;
 *   L83E-E2E-05  résolution non propagée (lien document → équipement) reposée
 *                par le service des liens ; retrait de l'utilisateur respecté ;
 *   L83E-E2E-06  T6 bloquée constatée sans second signalement ; notification
 *                regroupée avec un incident jamais parti remise en file (81E) ;
 *   L83E-E2E-07  abonnement local divergent de Stripe (simulé, LECTURE
 *                seule) → resynchronisé par la synchronisation existante ;
 *                droits dénormalisés réparés ; échec de réparation → Supervision ;
 *   L83E-E2E-08  compte non éligible du fait de son abonnement mais payé
 *                chez Stripe (lot 84A, décision PO L83-Q1) : à blanc, aucune
 *                écriture ; correctif, resynchronisé par la synchronisation
 *                existante puis réactivé (rattrapage 82A) ; aucun autre
 *                contrôle métier ; comptes suspendu et archivé : rien ;
 *   L83E-E2E-09  mode À BLANC : constats consignés, AUCUNE écriture métier.
 *
 * Toutes les campagnes sont BORNÉES aux comptes créés ici et toutes les
 * assertions portent sur ces comptes. Aucun appel IA réel, aucun appel
 * Stripe réel (lecteur simulé : `subscriptions.retrieve` seulement).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Stripe from 'stripe';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import { uid, type AccountRow } from '../factories';
import { runCoherenceFor, proofOf } from '../coherence-run';
import { LEGACY_PRICE_VARS } from '@/services/billing/legacy-price-env';

type Json = Record<string, any>;
const TODAY = '2026-10-12';
const NOW = new Date('2026-10-12T09:00:00Z');

/** Abonnement Stripe SIMULÉ (prix reconnus par la double lecture de transition STRIPE_PRICE_*). */
function fakeSub(o: { id: string; customer: string; status: Stripe.Subscription.Status; accountId: number; cancelAtPeriodEnd?: boolean; periodEnd: number }): Stripe.Subscription {
  return {
    id: o.id, object: 'subscription', customer: o.customer, status: o.status, cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
    start_date: o.periodEnd - 40 * 86400, metadata: { accountId: String(o.accountId) }, discounts: [],
    items: { data: [{ price: { id: 'price_e2e_premium_monthly', unit_amount: 590, recurring: { interval: 'month' } }, current_period_start: o.periodEnd - 30 * 86400, current_period_end: o.periodEnd }] },
  } as unknown as Stripe.Subscription;
}

scenario('L83E', 'Cohérence C5 / C6 : Agenda, « À traiter », T6, notifications, abonnements, Duo', ({ sql, make }) => {
  const anciennes: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const v of LEGACY_PRICE_VARS) {
      if (!v.billingPeriod) continue;
      anciennes[v.name] = process.env[v.name];
      process.env[v.name] = `price_e2e_${v.planCode}_${v.billingPeriod}`;
    }
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(anciennes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    (await import('@/services/coherence/registry/checks/billing')).__setCoherenceStripeReaderForTests(null);
  });

  // ── Jeux de données ──────────────────────────────────────────────────────
  const maison = (c: AccountRow) => make.asset(c, { category: 'IMMOBILIER', name: `Maison ${c.id}` });
  /** Intervention RÉALISÉE (Opération) rattachée au bien, sans aucun événement d'agenda. */
  const intervention = async (c: AccountRow, assetId: number, date = '2026-03-10') => {
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO business_operations (account_id, type_code, status, realized_date, technical_label)
      VALUES (${c.id}, 'INTERVENTION', 'REALIZED', ${date}, 'Ramonage') RETURNING id::int AS id`;
    await sql`INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, authority) VALUES (${c.id}, ${id}, 'MIGRATION', ${`e2e:${id}`}, 'STRUCTURED')`;
    await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority) VALUES (${c.id}, ${id}, ${assetId}, 'PRIMARY', 'STRUCTURED')`;
    return id;
  };
  const evenementsDe = (op: number) => sql<Json[]>`SELECT id::int AS id, projection_origin, start_date::text AS d FROM agenda_items WHERE business_operation_id = ${op} ORDER BY id`;
  const carte = async (c: AccountRow, o: { type: string; target: number; rule: string; field?: string | null; relation?: string | null; kind?: string }) => (await sql<{ id: number }[]>`
    INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, relation_key, action_kind, rule_code, question)
    VALUES (${c.id}, ${o.type}, ${o.target}, ${o.field ?? null}, ${o.relation ?? null}, ${o.kind ?? 'COMPLETE'}, ${o.rule}, 'Question e2e') RETURNING id`)[0].id;
  const ouverte = async (id: number) => (await sql<{ open: boolean }[]>`SELECT resolved_at IS NULL AS open FROM to_process_actions WHERE id = ${id}`)[0]?.open ?? null;
  const reparations = (accountId: number) => sql<Json[]>`
    SELECT check_id, object_id::int AS object_id, service, outcome, recheck_verdict, anomaly, ai_calls FROM coherence_repairs WHERE account_id = ${accountId} ORDER BY id`;
  const stripe = async () => import('@/services/coherence/registry/checks/billing');

  // ══ L83E-E2E-01 ═══════════════════════════════════════════════════════════

  it('L83E-E2E-01 — échéance calculable absente → recréée par la projection (sans IA) puis recontrôlée ; second passage sans réparation', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const op = await intervention(c, m.id);
    expect(await evenementsDe(op)).toEqual([]);
    const run = await runCoherenceFor(sql, [c.id], { now: NOW, today: TODAY });
    expect(run.status).toBe('COMPLETE');
    const evts = await evenementsDe(op);
    expect(evts).toEqual([expect.objectContaining({ projection_origin: 'OPERATION', d: '2026-03-10' })]);
    expect(await proofOf(sql, c.id, 'COH-AGENDA-OPERATION-PROJECTION', op)).toMatchObject({ last_result: 'REPAIRED', finding: null });
    const r = (await reparations(c.id)).filter((x) => x.check_id === 'COH-AGENDA-OPERATION-PROJECTION');
    expect(r).toEqual([expect.objectContaining({ object_id: op, service: 'projectAccountOperations', outcome: 'REPAIRED', recheck_verdict: 'CONSISTENT', anomaly: 'MISSING_CALCULABLE_EVENT', ai_calls: 0 })]);
    // Second passage : rien à faire (idempotent, aucun doublon d'événement ni de réparation).
    await runCoherenceFor(sql, [c.id], { now: NOW, today: TODAY });
    expect(await evenementsDe(op)).toHaveLength(1);
    expect((await reparations(c.id)).filter((x) => x.check_id === 'COH-AGENDA-OPERATION-PROJECTION')).toHaveLength(1);
    expect(await proofOf(sql, c.id, 'COH-AGENDA-OPERATION-PROJECTION', op)).toMatchObject({ last_result: 'CONSISTENT' });
  });

  // ══ L83E-E2E-02 ═══════════════════════════════════════════════════════════

  it('L83E-E2E-02 — événements obsolètes : Opération invalidée, projection orpheline, événement documentaire sans source — retirés tracés et restaurables', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const op = await intervention(c, m.id);
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    await projectAccountOperations(c.id, { operationIds: [op], today: TODAY });
    const [evt] = await evenementsDe(op);
    await sql`UPDATE business_operations SET invalidated_at = now(), invalidation_reason = 'e2e : Opération invalidée' WHERE id = ${op}`;
    // Projection orpheline (Opération supprimée : lien mis à NULL).
    const [{ id: orphelin }] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, projection_origin)
      VALUES (${c.id}, 'Entretien (ancienne Opération)', '2026-05-01', true, 'deduced_rule', 'OPERATION') RETURNING id`;
    // Événement documentaire automatique dont le document source a été supprimé, sans autre rattachement.
    const f = await make.assetFile(c, { assetId: null });
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${f.id}`;
    const [{ id: docEvt }] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, origin_ref_type, origin_ref_id)
      VALUES (${c.id}, 'Fin de garantie', '2027-01-01', true, 'qualified_document', 'asset_file', ${f.id}) RETURNING id`;
    const run = await runCoherenceFor(sql, [c.id], { now: NOW, today: TODAY });
    expect(run.status).toBe('COMPLETE');
    const restants = await sql<{ id: number }[]>`SELECT id FROM agenda_items WHERE id = ANY(${[evt.id, orphelin, docEvt]}::int[])`;
    expect(restants).toEqual([]);
    const traces = await sql<Json[]>`SELECT agenda_item_id::int AS id, reason FROM agenda_item_removals WHERE account_id = ${c.id} ORDER BY agenda_item_id`;
    expect(traces).toEqual(expect.arrayContaining([
      { id: evt.id, reason: 'OPERATION_PROJECTION' }, { id: orphelin, reason: 'OPERATION_PROJECTION' }, { id: docEvt, reason: 'ORPHAN_SOURCE_DELETED' },
    ]));
    // Intégration lot 83 : l'invariant O-1 (83B, exécuté avant) détache d'abord l'élément de l'Opération
    // invalidée, puis le contrôle des projections orphelines le retire — une seule chaîne par écart ;
    // le contrôle de projection de l'Opération constate alors la cohérence.
    expect(['REPAIRED', 'CONSISTENT']).toContain((await proofOf(sql, c.id, 'COH-AGENDA-OPERATION-PROJECTION', op)).last_result);
    expect(await proofOf(sql, c.id, 'COH-AGENDA-PROJECTION-ORPHANS', orphelin)).toMatchObject({ last_result: 'REPAIRED' });
    expect(await proofOf(sql, c.id, 'COH-AGENDA-ORPHANS', docEvt)).toMatchObject({ last_result: 'REPAIRED' });
  });

  // ══ L83E-E2E-03 ═══════════════════════════════════════════════════════════

  it('L83E-E2E-03 — runner de pertinence retiré : la tâche ne lance plus de campagne, l’historique reste lisible, une anomalie corrigée par UNE seule chaîne', async () => {
    const c = await make.account();
    // Historique : une campagne restée « en cours » est close SUPERSEDED par la migration 0676 (rejouable), éléments conservés.
    const [{ id: camp }] = await sql<{ id: number }[]>`
      INSERT INTO to_process_relevance_campaigns (code, engine_version, trigger_code, before_counts) VALUES (${`l83e-hist-${c.id}`}, 'l76-2', 'schedule', '{}'::jsonb) RETURNING id`;
    await sql`INSERT INTO to_process_relevance_campaign_items (campaign_id, action_id, account_id, file_id, rule_code, outcome) VALUES (${camp}, NULL, ${c.id}, NULL, 'DATA-AGENDA-DATE', 'KEPT')`;
    await sql.unsafe(await readFile(join(process.cwd(), 'src/db/migrations/0676_l83e_pertinence_vers_registre.sql'), 'utf8'));
    const hist = await import('@/services/to-process/relevance-campaign.service');
    const toutes = await hist.listRelevanceCampaigns(50);
    const vue = toutes.find((x) => x.id === Number(camp))!;
    expect(vue).toMatchObject({ status: 'SUPERSEDED', remaining: null });
    expect(vue.scope).toMatchObject({ supersededBy: expect.stringContaining('COH-TODO-RELEVANCE-CARDS') });
    expect(await hist.listCampaignItems(camp, { accountId: c.id })).toHaveLength(1);
    // Anomalie : carte de date sur un événement « à savoir » jamais jugée par le moteur courant.
    const [{ id: info }] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, is_automatic, origin_type, home_category) VALUES (${c.id}, 'À savoir', true, 'qualified_document', 'information') RETURNING id`;
    const cAgenda = await carte(c, { type: 'AGENDA_ITEM', target: info, rule: 'DATA-AGENDA-DATE', field: 'date' });
    // L'ancienne tâche : plus aucune campagne lancée, la carte n'est pas touchée.
    const nCamp = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM to_process_relevance_campaigns`)[0].n;
    const avant = await nCamp();
    const { findTask } = await import('@/services/scheduling/scheduled-tasks.catalog');
    await findTask('to-process-relevance-reevaluation')!.run({ deadline: Date.now() + 60_000, trigger: 'manual' } as never);
    expect(await nCamp()).toBe(avant);
    expect(await ouverte(cAgenda)).toBe(true);
    // Une seule chaîne : le contrôle du registre (même producteur que le balayage).
    const run = await runCoherenceFor(sql, [c.id], { now: NOW, today: TODAY });
    expect(run.status).toBe('COMPLETE');
    expect(await ouverte(cAgenda)).toBe(false);
    expect((await reparations(c.id)).filter((x) => x.object_id === cAgenda)).toEqual([
      expect.objectContaining({ check_id: 'COH-TODO-RELEVANCE-CARDS', service: 'produceAgendaActions', outcome: 'REPAIRED', anomaly: 'CARD_NOT_REEVALUATED' }),
    ]);
    const [d] = await sql<Json[]>`SELECT engine_version, trigger_code, run_ref FROM to_process_decisions WHERE target_type = 'AGENDA_ITEM' AND target_id = ${info} ORDER BY id DESC LIMIT 1`;
    expect(d).toMatchObject({ engine_version: 'atp-admissibility-v1', trigger_code: 'BACKFILL', run_ref: expect.stringContaining('COH-TODO-RELEVANCE-CARDS') });
    // Rejoué : aucune seconde correction.
    await runCoherenceFor(sql, [c.id], { now: NOW, today: TODAY });
    expect((await reparations(c.id)).filter((x) => x.object_id === cAgenda)).toHaveLength(1);
  });

  // ══ L83E-E2E-04 ═══════════════════════════════════════════════════════════

  it('L83E-E2E-04 — cartes liées à un objet supprimé (document, bien, équipement) fermées par le service des cartes, tracées ; carte vivante intacte', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const autre = await make.asset(c, { name: 'Garage' });
    const f = await make.assetFile(c, { assetId: m.id });
    const [{ id: eq }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${m.id}, 'Chaudière') RETURNING id`;
    const cDoc = await carte(c, { type: 'DOCUMENT', target: f.id, rule: 'LINK-ASSET', relation: 'assetIds' });
    const cBien = await carte(c, { type: 'ASSET', target: autre.id, rule: 'DATA-ACQUISITION-PRICE', field: 'purchasePrice' });
    const cEq = await carte(c, { type: 'EQUIPMENT', target: eq, rule: 'ENTITY-FIELD', field: 'brand', kind: 'ARBITRATE' });
    const [{ id: eqVivant }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${m.id}, 'Alarme') RETURNING id`;
    const cVivante = await carte(c, { type: 'EQUIPMENT', target: eqVivant, rule: 'ENTITY-FIELD', field: 'brand', kind: 'ARBITRATE' });
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${f.id}`;
    await sql`UPDATE assets SET deleted_at = now() WHERE id = ${autre.id}`;
    await sql`DELETE FROM equipments WHERE id = ${eq}`;
    expect((await runCoherenceFor(sql, [c.id], { now: NOW, today: TODAY })).status).toBe('COMPLETE');
    for (const id of [cDoc, cBien, cEq]) {
      expect(await ouverte(id), String(id)).toBe(false);
      expect(await proofOf(sql, c.id, 'COH-TODO-ORPHAN-CARDS', id)).toMatchObject({ last_result: 'REPAIRED' });
      expect(await sql`SELECT event FROM to_process_action_events WHERE action_id = ${id} AND event = 'TARGET_DELETED'`).toHaveLength(1);
    }
    expect(await sql`SELECT resolution_reason FROM to_process_actions WHERE id = ANY(${[cDoc, cBien, cEq]}::int[])`).toEqual(Array(3).fill({ resolution_reason: 'TARGET_DELETED' }));
    expect(await ouverte(cVivante)).toBe(true);
    expect(await proofOf(sql, c.id, 'COH-TODO-ORPHAN-CARDS', cVivante)).toMatchObject({ last_result: 'CONSISTENT' });
    // Aucune carte supprimée physiquement.
    expect(await sql`SELECT id FROM to_process_actions WHERE account_id = ${c.id}`).toHaveLength(4);
  });

  // ══ L83E-E2E-05 ═══════════════════════════════════════════════════════════

  it('L83E-E2E-05 — résolution non propagée (rattachement document → équipement choisi) reposée par le service des liens ; retrait de l’utilisateur respecté', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const [{ id: eq }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${m.id}, 'Chaudière') RETURNING id`;
    const resolue = async (fileId: number) => {
      const id = await carte(c, { type: 'DOCUMENT', target: fileId, rule: 'LINK-ELT', relation: 'elementId', kind: 'ARBITRATE' });
      await sql`UPDATE asset_files SET equipment_id = ${eq} WHERE id = ${fileId}`;
      await sql`UPDATE to_process_actions SET resolved_at = now() - interval '1 hour', resolution_reason = 'USER_ARBITRATED' WHERE id = ${id}`;
      await sql`INSERT INTO to_process_action_events (action_id, account_id, event, target_type, target_id, field_key, new_value, details, created_at)
                VALUES (${id}, ${c.id}, 'RESOLVED_ARBITRATION', 'DOCUMENT', ${fileId}, 'elementId', ${JSON.stringify(eq)}::jsonb, '{"ruleCode":"LINK-ELT"}'::jsonb, now() - interval '1 hour')`;
      return id;
    };
    const f1 = await make.assetFile(c, { assetId: m.id });
    const perdue = await resolue(f1.id);
    // Propagation perdue (lien jamais posé) : aucun lien actif vers l'équipement choisi.
    await sql`DELETE FROM document_asset_links WHERE file_id = ${f1.id} AND equipment_id = ${eq}`;
    const f2 = await make.assetFile(c, { assetId: m.id });
    const retiree = await resolue(f2.id);
    // Retrait par l'utilisateur APRÈS la résolution : son geste fait foi.
    await sql`UPDATE document_asset_links SET status = 'REMOVED', removed_at = now() WHERE file_id = ${f2.id} AND equipment_id = ${eq}`;
    expect((await runCoherenceFor(sql, [c.id], { now: NOW, today: TODAY })).status).toBe('COMPLETE');
    expect(await sql`SELECT origin, link_role FROM document_asset_links WHERE file_id = ${f1.id} AND equipment_id = ${eq} AND status = 'ACTIVE'`)
      .toEqual([{ origin: 'USER', link_role: 'SECONDARY' }]);
    expect(await proofOf(sql, c.id, 'COH-TODO-RESOLUTION-PROPAGATION', perdue)).toMatchObject({ last_result: 'REPAIRED' });
    expect(await sql`SELECT id FROM document_asset_links WHERE file_id = ${f2.id} AND equipment_id = ${eq} AND status = 'ACTIVE'`).toEqual([]);
    expect(await proofOf(sql, c.id, 'COH-TODO-RESOLUTION-PROPAGATION', retiree)).toMatchObject({ last_result: 'CONSISTENT' });
  });

  // ══ L83E-E2E-06 ═══════════════════════════════════════════════════════════

  it('L83E-E2E-06 — T6 bloquée constatée (sans second signalement) ; notification regroupée avec un incident jamais parti remise en file (81E)', async () => {
    const c = await make.account();
    const [{ id: item }] = await sql<{ id: number }[]>`INSERT INTO agenda_items (account_id, title, start_date) VALUES (${c.id}, 'Assurance', '2026-11-01') RETURNING id`;
    await sql`INSERT INTO t6_evaluation_runs (agenda_item_id, account_id, status, requested_at) VALUES (${item}, ${c.id}, 'PENDING', now() - interval '3 hours')`;
    const [{ id: porteur }] = await sql<{ id: string }[]>`
      INSERT INTO notification_outbox (event_type, category, account_id, recipient_user_id, dedupe_key, status, processed_at)
      VALUES ('PAYMENT_FAILED', 'billing', ${c.id}, ${c.ownerUserId}, ${`l83e-p-${c.id}`}, 'failed', now()) RETURNING id`;
    const [{ id: regroupe }] = await sql<{ id: string }[]>`
      INSERT INTO notification_outbox (event_type, category, account_id, recipient_user_id, dedupe_key, status, grouped_with_id, processed_at)
      VALUES ('PAYMENT_FAILED', 'billing', ${c.id}, ${c.ownerUserId}, ${`l83e-g-${c.id}`}, 'grouped', ${porteur}, now()) RETURNING id`;
    for (let i = 0; i < 3; i++) await runCoherenceFor(sql, [c.id], { now: new Date(), today: TODAY });
    const p = await proofOf(sql, c.id, 'COH-T6-EVALUATIONS', item);
    expect(p).toMatchObject({ last_result: 'FINDING', finding: expect.objectContaining({ anomaly: 'T6_PENDING_WITHOUT_EXECUTION' }) });
    // Aucune action sur l'évaluation (reprise : chaîne T6 ou BO), aucun appel IA.
    expect(await sql`SELECT status, attempts FROM t6_evaluation_runs WHERE agenda_item_id = ${item}`).toEqual([{ status: 'PENDING', attempts: 0 }]);
    // Supervision : déjà signalé par `mascot-t6-supervision` — pas de second signalement « persistant ».
    const { computeCoherenceAlerts } = await import('@/services/coherence/supervision');
    const alertes = (await computeCoherenceAlerts(new Date())).map((a) => a.fingerprint);
    expect(alertes).not.toContain('other:coherence:coh-t6-evaluations:persistent');
    // File : l'événement regroupé avec un incident qui n'est parti par aucun canal est remis en file (jamais supprimé).
    expect(await sql`SELECT status, grouped_with_id FROM notification_outbox WHERE id = ${regroupe}`).toEqual([{ status: 'pending', grouped_with_id: null }]);
    expect((await reparations(c.id)).filter((x) => x.check_id === 'COH-NOTIF-OUTBOX')).toEqual([expect.objectContaining({ service: 'reopenGroupedBy', outcome: 'REPAIRED' })]);
  });

  // ══ L83E-E2E-07 ═══════════════════════════════════════════════════════════

  async function abonne(o: { status?: string; planType?: string; periodEnd: number } ) {
    const c = await make.account({ plan: 'premium' });
    const customer = `cus_${uid('e2e')}`;
    const subId = `sub_${uid('e2e')}`;
    await sql`UPDATE accounts SET stripe_customer_id = ${customer}, stripe_subscription_id = ${subId}, subscription_status = 'ACTIVE', plan_type = ${o.planType ?? 'PREMIUM'} WHERE id = ${c.id}`;
    await sql`UPDATE users SET plan_type = ${o.planType ?? 'PREMIUM'} WHERE id = ${c.ownerUserId}`;
    await sql`UPDATE account_subscriptions SET stripe_subscription_id = ${subId}, stripe_customer_id = ${customer}, billing_period = 'monthly',
                status = ${o.status ?? 'active'}, current_period_end_at = to_timestamp(${o.periodEnd}), stripe_price_id = 'price_e2e_premium_monthly',
                cancel_at_period_end = false WHERE account_id = ${c.id}`;
    return { ...c, customer, subId };
  }

  it('L83E-E2E-07 — abonnement local divergent de Stripe (simulé, lecture seule) → resynchronisé ; droits dénormalisés réparés ; échec de réparation → Supervision', async () => {
    const fin = Math.floor(Date.now() / 1000) + 20 * 86400;
    const a = await abonne({ periodEnd: fin });
    const b = await abonne({ periodEnd: fin, planType: 'STANDARD' });
    const appels: string[] = [];
    const stripeSubs = new Map<string, Stripe.Subscription>([
      [a.subId, fakeSub({ id: a.subId, customer: a.customer, status: 'active', accountId: a.id, cancelAtPeriodEnd: true, periodEnd: fin })],
      [b.subId, fakeSub({ id: b.subId, customer: b.customer, status: 'active', accountId: b.id, periodEnd: fin })],
    ]);
    (await stripe()).__setCoherenceStripeReaderForTests(async (id) => { appels.push(id); return stripeSubs.get(id)!; });
    expect((await runCoherenceFor(sql, [a.id, b.id])).status).toBe('COMPLETE');
    // A : résiliation programmée chez Stripe, absente localement → resynchronisée (copie locale ET état dénormalisé).
    expect(await sql`SELECT cancel_at_period_end FROM account_subscriptions WHERE account_id = ${a.id}`).toEqual([{ cancel_at_period_end: true }]);
    expect(await sql`SELECT subscription_status FROM accounts WHERE id = ${a.id}`).toEqual([{ subscription_status: 'CANCELED' }]);
    expect(await proofOf(sql, a.id, 'COH-BILLING-STRIPE', a.id)).toMatchObject({ last_result: 'REPAIRED' });
    expect((await reparations(a.id)).filter((x) => x.check_id === 'COH-BILLING-STRIPE')).toEqual([
      expect.objectContaining({ service: 'syncSubscriptionFromStripe', outcome: 'REPAIRED', recheck_verdict: 'CONSISTENT', anomaly: 'CANCELLATION' }),
    ]);
    expect(await proofOf(sql, a.id, 'COH-ENTITLEMENTS', a.id)).toMatchObject({ last_result: 'CONSISTENT' });
    // B : offre dénormalisée fausse (STANDARD pour un Premium payé) → même synchronisation.
    expect(await sql`SELECT plan_type FROM accounts WHERE id = ${b.id}`).toEqual([{ plan_type: 'PREMIUM' }]);
    expect(await proofOf(sql, b.id, 'COH-ENTITLEMENTS', b.id)).toMatchObject({ last_result: 'REPAIRED' });
    // Lecture Stripe seulement (aucune écriture : le lecteur simulé n'expose que `retrieve`).
    expect(new Set(appels)).toEqual(new Set([a.subId, b.subId]));
    // Échec de la synchronisation (Stripe illisible à la réparation) : REPAIR_FAILED → Supervision existante.
    const c = await abonne({ periodEnd: fin });
    let n = 0;
    (await stripe()).__setCoherenceStripeReaderForTests(async (id) => {
      if (id !== c.subId) return stripeSubs.get(id)!;
      n += 1;
      if (n > 1) throw Object.assign(new Error('Stripe indisponible (e2e)'), { type: 'StripeConnectionError' });
      return fakeSub({ id: c.subId, customer: c.customer, status: 'past_due', accountId: c.id, periodEnd: fin });
    });
    await runCoherenceFor(sql, [c.id]);
    expect(await proofOf(sql, c.id, 'COH-BILLING-STRIPE', c.id)).toMatchObject({ last_result: 'REPAIR_FAILED' });
    expect(await sql`SELECT status FROM account_subscriptions WHERE account_id = ${c.id}`).toEqual([{ status: 'active' }]);
    const { syncCoherenceSupervision } = await import('@/services/coherence/supervision');
    await syncCoherenceSupervision({ now: new Date() });
    const [anomalie] = await sql<Json[]>`SELECT status, technical_detail AS detail FROM admin_anomalies WHERE fingerprint = 'other:coherence:coh-billing-stripe:repair_failed'`;
    expect(anomalie).toMatchObject({ status: 'open' });
    expect(String(anomalie.detail.accountIds)).toContain(String(c.id));
    (await stripe()).__setCoherenceStripeReaderForTests(null);
  });

  // ══ L83E-E2E-08 ═══════════════════════════════════════════════════════════
  // Lot 84A (décision PO L83-Q1) : attendu MODIFIÉ — un compte non éligible du fait de son abonnement
  // alors que Stripe indique un paiement est RESYNCHRONISÉ en mode correctif (rien en mode à blanc),
  // puis réactivé par le rattrapage 82A normal ; aucun autre contrôle métier ; suspendu / archivé : rien.

  it('L83E-E2E-08 — compte bloqué par son abonnement mais payé chez Stripe : à blanc rien ; correctif → resynchronisé puis réactivé (rattrapage 82A) ; aucun contrôle métier ; suspendu / archivé ignorés', async () => {
    const fin = Math.floor(Date.now() / 1000) + 20 * 86400;
    const termine = await abonne({ periodEnd: fin, status: 'canceled' });
    await sql`UPDATE accounts SET subscription_status = 'EXPIRED', plan_type = 'STANDARD' WHERE id = ${termine.id}`;
    await sql`UPDATE users SET plan_type = 'STANDARD' WHERE id = ${termine.ownerUserId}`;
    // Contenu métier qui serait réparé sur un compte éligible : carte orpheline.
    const f = await make.assetFile(termine, { assetId: null });
    const orpheline = await carte(termine, { type: 'DOCUMENT', target: f.id, rule: 'LINK-ASSET', relation: 'assetIds' });
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${f.id}`;
    const suspendu = await abonne({ periodEnd: fin, status: 'canceled' });
    await sql`UPDATE accounts SET is_active = false, subscription_status = 'EXPIRED' WHERE id = ${suspendu.id}`;
    const archive = await abonne({ periodEnd: fin, status: 'canceled' });
    await sql`UPDATE accounts SET archived_at = now(), subscription_status = 'EXPIRED' WHERE id = ${archive.id}`;
    const clients = new Map([[termine.subId, termine], [suspendu.subId, suspendu], [archive.subId, archive]]);
    const appels: string[] = [];
    (await stripe()).__setCoherenceStripeReaderForTests(async (id) => {
      appels.push(id);
      const c = clients.get(id)!;
      // Stripe : abonnement PAYÉ (actif) — divergence avec la copie locale « terminé ».
      return fakeSub({ id, customer: c.customer, status: 'active', accountId: c.id, periodEnd: fin });
    });
    // État d'éligibilité observé (comme la tâche account-eligibility-sync) : les trois comptes sont non éligibles.
    const cycle = await import('@/services/account/processing-lifecycle');
    for (const c of [termine, suspendu, archive]) await cycle.syncAccountEligibility(c.id, { source: 'e2e' });
    const etat = async (id: number) => (await sql<Json[]>`
      SELECT eligible, reason, last_reactivated_at, last_reactivation_source, last_catchup_result FROM account_processing_states WHERE account_id = ${id}`)[0];
    expect(await etat(termine.id)).toMatchObject({ eligible: false, reason: 'SUBSCRIPTION_ENDED', last_reactivated_at: null });
    const photo = async () => ({
      abo: await sql`SELECT account_id, status, cancel_at_period_end, plan_code FROM account_subscriptions WHERE account_id = ANY(${[termine.id, suspendu.id, archive.id]}::int[]) ORDER BY account_id`,
      comptes: await sql`SELECT id, subscription_status, plan_type FROM accounts WHERE id = ANY(${[termine.id, suspendu.id, archive.id]}::int[]) ORDER BY id`,
    });
    const orch = await import('@/services/coherence/orchestrator');

    // ── 1. Mode À BLANC : constat WOULD_REPAIR, AUCUNE écriture, aucune réactivation.
    const avant = await photo();
    const blanc = await runCoherenceFor(sql, [termine.id, suspendu.id, archive.id], { mode: 'DRY_RUN' });
    expect(blanc.status).toBe('COMPLETE');
    expect(await proofOf(sql, termine.id, 'COH-BILLING-STRIPE', termine.id)).toMatchObject({
      last_result: 'WOULD_REPAIR', last_mode: 'DRY_RUN', finding: expect.objectContaining({ anomaly: 'STATUS', detail: expect.objectContaining({ accountScope: 'SUBSCRIPTION_STATE_READ' }) }),
    });
    expect(await photo()).toEqual(avant);
    expect(await reparations(termine.id)).toEqual([]);
    expect(await etat(termine.id)).toMatchObject({ eligible: false, last_reactivated_at: null });
    // Compte non éligible : AUCUN contrôle métier — la carte orpheline n'est ni contrôlée ni fermée.
    expect(await proofOf(sql, termine.id, 'COH-TODO-ORPHAN-CARDS', orpheline)).toBeNull();
    expect(await ouverte(orpheline)).toBe(true);
    const lus = (await sql<{ check_id: string }[]>`SELECT DISTINCT check_id FROM coherence_object_proofs WHERE account_id = ${termine.id}`).map((x) => x.check_id);
    expect(lus.length).toBeGreaterThan(0);
    expect(lus.every((x) => ['COH-BILLING-STRIPE', 'COH-DUO-RELATIONS', 'COH-ENTITLEMENTS', 'COH-SUBSCRIPTION-COMMUNICATIONS'].includes(x)), lus.join(',')).toBe(true);

    // ── 2. Mode CORRECTIF : resynchronisation (service existant) puis recontrôle.
    const run = await runCoherenceFor(sql, [termine.id, suspendu.id, archive.id]);
    expect(run.status).toBe('COMPLETE');
    const camp = (await orch.getCampaign(run.campaignId))!;
    expect(camp.accounts).toMatchObject({ visited: 0, skipped: { SUBSCRIPTION_ENDED: 1, ACCOUNT_SUSPENDED: 1, ACCOUNT_ARCHIVED: 1 }, subscriptionStateRead: 1 });
    expect(await proofOf(sql, termine.id, 'COH-BILLING-STRIPE', termine.id)).toMatchObject({ last_result: 'REPAIRED', finding: null });
    const rep = (await reparations(termine.id)).filter((x) => x.check_id === 'COH-BILLING-STRIPE');
    expect(rep).toEqual([expect.objectContaining({ service: 'syncSubscriptionFromStripe', outcome: 'REPAIRED', recheck_verdict: 'CONSISTENT', anomaly: 'STATUS', ai_calls: 0 })]);
    expect(await sql`SELECT status, plan_code FROM account_subscriptions WHERE account_id = ${termine.id}`).toEqual([{ status: 'active', plan_code: 'premium' }]);
    expect(await sql`SELECT subscription_status FROM accounts WHERE id = ${termine.id}`).toEqual([{ subscription_status: 'ACTIVE' }]);
    // Réactivation : rattrapage 82A NORMAL, déclenché par la synchronisation elle-même (asynchrone, non bloquant).
    let e: Json = {};
    for (let i = 0; i < 100; i++) {
      e = await etat(termine.id);
      if (e.last_reactivated_at) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(e).toMatchObject({ eligible: true, last_reactivation_source: 'subscription_sync' });
    expect(e.last_catchup_result).toMatchObject({ 'catchup-control': { ok: true } });
    const rattrapage = Number((e.last_catchup_result as Json)['catchup-control'].detail.coherenceCatchupCampaignId);
    expect(await sql`SELECT kind, scope_account_ids FROM coherence_campaigns WHERE id = ${rattrapage}`).toEqual([{ kind: 'CATCHUP', scope_account_ids: [termine.id] }]);
    // Les contrôles métier ne reprennent qu'une fois le compte REDEVENU éligible (rattrapage 82A ; ou phase de vérification
    // de la campagne en cours, qui réévalue l'éligibilité à la reprise du compte) — jamais tant qu'il est bloqué (étape 1).
    // Compte suspendu, compte archivé : ni lecture Stripe, ni preuve, ni écriture.
    expect([...new Set(appels)]).toEqual([termine.subId]);
    for (const c of [suspendu, archive]) {
      expect(await sql`SELECT check_id FROM coherence_object_proofs WHERE account_id = ${c.id}`).toEqual([]);
      expect(await reparations(c.id)).toEqual([]);
    }
    const apres = await photo();
    expect(apres.abo.filter((r) => r.account_id !== termine.id)).toEqual(avant.abo.filter((r) => r.account_id !== termine.id));
    expect(apres.comptes.filter((r) => r.id !== termine.id)).toEqual(avant.comptes.filter((r) => r.id !== termine.id));

    // ── 3. Idempotence : second passage correctif, plus rien à réparer.
    await runCoherenceFor(sql, [termine.id]);
    expect((await reparations(termine.id)).filter((x) => x.check_id === 'COH-BILLING-STRIPE')).toHaveLength(1);
    (await stripe()).__setCoherenceStripeReaderForTests(null);
  });

  // ══ L83E-E2E-09 ═══════════════════════════════════════════════════════════

  it('L83E-E2E-09 — mode À BLANC : constats consignés (WOULD_REPAIR), AUCUNE écriture métier ni réparation', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const op = await intervention(c, m.id);
    const f = await make.assetFile(c, { assetId: null });
    const orpheline = await carte(c, { type: 'DOCUMENT', target: f.id, rule: 'LINK-ASSET', relation: 'assetIds' });
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${f.id}`;
    const [{ id: porteur }] = await sql<{ id: string }[]>`
      INSERT INTO notification_outbox (event_type, category, account_id, recipient_user_id, dedupe_key, status, processed_at)
      VALUES ('PAYMENT_FAILED', 'billing', ${c.id}, ${c.ownerUserId}, ${`l83e-dp-${c.id}`}, 'failed', now()) RETURNING id`;
    await sql`INSERT INTO notification_outbox (event_type, category, account_id, recipient_user_id, dedupe_key, status, grouped_with_id, processed_at)
              VALUES ('PAYMENT_FAILED', 'billing', ${c.id}, ${c.ownerUserId}, ${`l83e-dg-${c.id}`}, 'grouped', ${porteur}, now())`;
    const photo = async () => ({
      agenda: await sql`SELECT id, start_date, business_operation_id FROM agenda_items WHERE account_id = ${c.id} ORDER BY id`,
      cartes: await sql`SELECT id, resolved_at, resolution_reason FROM to_process_actions WHERE account_id = ${c.id} ORDER BY id`,
      evenements: await sql`SELECT count(*)::int AS n FROM to_process_action_events WHERE account_id = ${c.id}`,
      outbox: await sql`SELECT id, status, grouped_with_id FROM notification_outbox WHERE account_id = ${c.id} ORDER BY id`,
      decisions: await sql`SELECT count(*)::int AS n FROM to_process_decisions WHERE account_id = ${c.id}`,
      retraits: await sql`SELECT count(*)::int AS n FROM agenda_item_removals WHERE account_id = ${c.id}`,
    });
    const avant = await photo();
    const run = await runCoherenceFor(sql, [c.id], { mode: 'DRY_RUN', now: NOW, today: TODAY });
    expect(run.status).toBe('COMPLETE');
    expect(await photo()).toEqual(avant);
    expect(await reparations(c.id)).toEqual([]);
    expect(await proofOf(sql, c.id, 'COH-AGENDA-OPERATION-PROJECTION', op)).toMatchObject({ last_result: 'WOULD_REPAIR', last_mode: 'DRY_RUN', finding: expect.objectContaining({ anomaly: 'MISSING_CALCULABLE_EVENT' }) });
    expect(await proofOf(sql, c.id, 'COH-TODO-ORPHAN-CARDS', orpheline)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'CARD_TARGET_DELETED' }) });
    expect(await proofOf(sql, c.id, 'COH-NOTIF-OUTBOX', c.id)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'GROUPED_WITH_UNSENT_CARRIER' }) });
  });
});
