/**
 * L114P — carte Trello #770 « IA — Exclure tout modèle sans tarif officiel vérifié et réinitialiser les alertes
 * tarifaires » (base PostgreSQL réelle, aucun appel IA, aucun réseau).
 *
 *   R10 · remise à zéro : les cinq codes tarifaires hérités encore ouverts sont clôturés avec le motif
 *         REBASE_PRICING_POLICY_PRE_MEP, décomptes avant / après et identifiants conservés ; les autres familles
 *         d'alertes et les alertes déjà résolues sont intactes ; second passage sans effet ;
 *   R11 · appels historiques non chiffrés : vrai nombre conservé, aucune alerte, aucune réouverture au recontrôle ;
 *   R12 · appel non chiffré POSTÉRIEUR à la bascule : alerte ciblée ; corrigé : résolue, ligne conservée ;
 *   R03 / R05 / R08 · référentiel réel : confirmé (KNOWN) ou gratuit officiel = appelable ; amorçage jamais
 *         confirmé, UNKNOWN, STALE au-delà du délai = non appelable ; chaîne active non conforme signalée ;
 *   R07 · contrôle final lu dans la transaction.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';

const MIGRATION = readFileSync(join(process.cwd(), 'src/db/migrations/1691_l114_tarifs_ia_remise_a_zero_alertes.sql'), 'utf8');
const CODES = ['ai_pricing_active_unpriced', 'ai_pricing_unpriced_calls', 'ai_pricing_stale', 'ai_pricing_source_unreadable', 'ai_pricing_model_unpriced'];

scenario('L114P', 'Tarifs IA : éligibilité obligatoire, remise à zéro des alertes héritées, historique conservé, incident actuel signalé', ({ sql, make }) => {
  let accountId = 0;
  const P = () => import('@/services/ai/gateway/pricing/pricing.repository');
  const S = () => import('@/services/ai/gateway/pricing/pricing-supervision');
  const ouvertes = async () => (await sql<Array<{ code: string; n: number }>>`
    SELECT code, COUNT(*)::int AS n FROM ai_alerts WHERE resolved_at IS NULL GROUP BY code ORDER BY code`).map((r) => `${r.code}:${r.n}`);
  const appel = (model: string, quand: string) => sql`
    INSERT INTO ai_usage_event (account_id, operation_type, provider, model, is_billable, input_tokens, output_tokens, cost_micros, status, metadata, use_case_code, pricing_status, created_at)
    VALUES (${accountId}, 'e2e_l114p', 'gemini', ${model}, TRUE, 2000, 100, NULL, 'success', ${JSON.stringify({ traceId: `l114p-${model}-${quand}`, pricing: null })}::jsonb, 'SOURCE_ANALYSIS', 'missing', ${quand}::timestamptz)`;

  beforeAll(async () => {
    accountId = (await make.account()).id;
    for (const t of ['ai_model_price_status', 'ai_model_pricing', 'ai_pricing_policy_rebase']) await sql.unsafe(`DELETE FROM ${t}`);
    await sql`DELETE FROM ai_alerts`;
    await sql`DELETE FROM ai_usage_event WHERE operation_type = 'e2e_l114p'`;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  // Scénario tarifaire : la garde est éprouvée sur le référentiel RÉEL (sans la preuve de test du socle).
  beforeEach(async () => { (await P()).__setVerifiedTestPricesForTests(false); });
  afterAll(async () => { (await P()).clearPricingCache(); vi.restoreAllMocks(); });

  it('L114P-E01 (R10) — remise à zéro : codes hérités clôturés et audités, autres alertes intactes, second passage sans effet', async () => {
    for (const [i, code] of CODES.entries()) {
      await sql`INSERT INTO ai_alerts (kind, code, severity, message, details, dedupe_key, created_at)
                VALUES ('anomaly', ${code}, 'warning', ${`héritée ${code}`}, ${JSON.stringify({ model: `m${i}` })}::jsonb, ${`l114p:${code}`}, NOW() - interval '3 days')`;
    }
    // Une alerte tarifaire DÉJÀ résolue (motif d'origine conservé) et une alerte d'une AUTRE famille.
    await sql`INSERT INTO ai_alerts (kind, code, severity, message, details, dedupe_key, created_at, resolved_at, resolution_code, resolution_reason)
              VALUES ('anomaly', 'ai_pricing_stale', 'info', 'ancienne', '{}'::jsonb, 'l114p:deja', NOW() - interval '9 days', NOW() - interval '8 days', 'CONDITION_CLEARED', 'reconfirmé')`;
    await sql`INSERT INTO ai_alerts (kind, code, severity, message, details, dedupe_key)
              VALUES ('budget', 'ai_budget_threshold', 'critical', 'autre famille', '{}'::jsonb, 'l114p:autre')`;
    expect(await ouvertes()).toEqual([...CODES.map((c) => `${c}:1`), 'ai_budget_threshold:1'].sort());

    await sql.unsafe(MIGRATION);
    expect(await ouvertes()).toEqual(['ai_budget_threshold:1']);
    const closes = await sql<Array<{ code: string; resolution_code: string; resolution_reason: string; resolved_by: number | null }>>`
      SELECT code, resolution_code, resolution_reason, resolved_by FROM ai_alerts WHERE dedupe_key LIKE 'l114p:ai_pricing_%' ORDER BY code`;
    expect(closes).toHaveLength(5);
    expect(closes.every((a) => a.resolution_code === 'REBASE_PRICING_POLICY_PRE_MEP' && a.resolved_by === null && /Remise à zéro à la bascule #770/.test(a.resolution_reason))).toBe(true);
    const [deja] = await sql<Array<{ resolution_code: string }>>`SELECT resolution_code FROM ai_alerts WHERE dedupe_key = 'l114p:deja'`;
    expect(deja.resolution_code).toBe('CONDITION_CLEARED');
    const [m1] = await sql<Array<{ applied_at: Date; closed_count: number; details: { before: Record<string, number>; after: Record<string, number>; closedIds: number[]; otherFamiliesOpenBefore: number; otherFamiliesOpenAfter: number } }>>`
      SELECT applied_at, closed_count, details FROM ai_pricing_policy_rebase WHERE policy = 'REBASE_PRICING_POLICY_PRE_MEP'`;
    expect(m1.closed_count).toBe(5);
    expect(m1.details.before).toEqual(Object.fromEntries(CODES.map((c) => [c, 1])));
    expect(m1.details.after).toEqual({});
    expect(m1.details.closedIds).toHaveLength(5);
    expect([m1.details.otherFamiliesOpenBefore, m1.details.otherFamiliesOpenAfter]).toEqual([1, 1]);
    const nbAlertes = Number((await sql`SELECT COUNT(*)::int AS n FROM ai_alerts`)[0].n);

    // Second passage : aucune clôture, date de bascule inchangée — même avec une alerte tarifaire NOUVELLE ouverte depuis.
    await sql`INSERT INTO ai_alerts (kind, code, severity, message, details, dedupe_key) VALUES ('anomaly', 'ai_pricing_active_unpriced', 'warning', 'nouvelle, actuelle', '{}'::jsonb, 'l114p:nouvelle')`;
    await sql.unsafe(MIGRATION);
    const [m2] = await sql<Array<{ applied_at: Date; closed_count: number }>>`SELECT applied_at, closed_count FROM ai_pricing_policy_rebase`;
    expect([m2.closed_count, new Date(m2.applied_at).getTime()]).toEqual([5, new Date(m1.applied_at).getTime()]);
    expect(await ouvertes()).toEqual(['ai_budget_threshold:1', 'ai_pricing_active_unpriced:1']);
    expect(Number((await sql`SELECT COUNT(*)::int AS n FROM ai_alerts`)[0].n)).toBe(nbAlertes + 1);
    await sql`DELETE FROM ai_alerts WHERE dedupe_key = 'l114p:nouvelle'`;
  });

  it('L114P-E02 (R11) — appels historiques non chiffrés : nombre réel conservé, AUCUNE alerte, aucune réouverture aux recontrôles', async () => {
    // Les chaînes actives de la base de test sont tarifées par le socle : seul l'historique est en cause ici.
    (await P()).__setVerifiedTestPricesForTests(true);
    for (let i = 0; i < 7; i++) await appel('gemini-historique', new Date(Date.now() - (5 * 86_400_000 + i * 60_000)).toISOString());
    // La bascule est postérieure à ces appels.
    await sql`UPDATE ai_pricing_policy_rebase SET applied_at = NOW() - interval '1 day'`;
    const { reconcilePricingAlerts, summarizePricing, pricingPolicyRebaseAt } = await S();
    expect(await pricingPolicyRebaseAt()).not.toBeNull();
    for (const passage of ['cron', 'dashboard', 'redemarrage']) {
      const r = await reconcilePricingAlerts(passage);
      expect(r).not.toBeNull();
      expect(r!.raised).toBe(0);
      expect(r!.conditions.unpricedCalls).toEqual([expect.objectContaining({ model: 'gemini-historique', calls: 7, callsSincePolicy: 0 })]);
    }
    expect((await ouvertes()).filter((x) => x.startsWith('ai_pricing_'))).toEqual([]);
    const s = summarizePricing((await reconcilePricingAlerts('synthese'))!.conditions, 0, []);
    expect(s).toMatchObject({ severity: 'ok', counters: expect.objectContaining({ unpricedCalls: 7, currentUnpricedCalls: 0 }) });
    expect(s.historicalNote).toMatch(/^7 appel\(s\) historique\(s\) non chiffré\(s\)/);
    // Les traces ne sont ni supprimées ni revalorisées.
    expect(await sql`SELECT cost_micros, pricing_status FROM ai_usage_event WHERE operation_type = 'e2e_l114p'`).toEqual(Array(7).fill({ cost_micros: null, pricing_status: 'missing' }));
  });

  it('L114P-E03 (R12) — appel exécuté sans tarif APRÈS la bascule : alerte ciblée ; une fois corrigé : résolue, traces conservées', async () => {
    (await P()).__setVerifiedTestPricesForTests(true);
    await appel('gemini-contournement', new Date().toISOString());
    const { reconcilePricingAlerts } = await S();
    const r = await reconcilePricingAlerts('e2e');
    expect(r!.raised).toBe(1);
    const [a] = await sql<Array<{ id: number; code: string; message: string; details: { calls: number; historicalCalls: number } }>>`
      SELECT id, code, message, details FROM ai_alerts WHERE resolved_at IS NULL AND code LIKE 'ai_pricing_%'`;
    expect(a).toMatchObject({ code: 'ai_pricing_unpriced_calls', details: expect.objectContaining({ calls: 1, historicalCalls: 0 }) });
    expect(a.message).toMatch(/^Appel IA exécuté sans tarif vérifié : 1 appel\(s\) de gemini-contournement/);
    // Recontrôle : même alerte (une par condition), pas un doublon.
    expect((await reconcilePricingAlerts('e2e'))!.raised).toBe(0);
    // Corrigé (coût désormais connu pour cet appel) : l'alerte se résout seule, la ligne reste.
    await sql`UPDATE ai_usage_event SET cost_micros = 12, pricing_status = 'applied' WHERE model = 'gemini-contournement'`;
    const fin = await reconcilePricingAlerts('e2e');
    expect(fin!.resolved).toBe(1);
    const [apres] = await sql<Array<{ resolved_at: Date | null; resolution_code: string }>>`SELECT resolved_at, resolution_code FROM ai_alerts WHERE id = ${a.id}`;
    expect(apres.resolved_at).not.toBeNull();
    expect(apres.resolution_code).toBe('CONDITION_CLEARED');
    expect((await ouvertes()).filter((x) => x.startsWith('ai_pricing_'))).toEqual([]);
  });

  it('L114P-E04 (R03, R05, R08, R07) — référentiel réel : seuls les tarifs officiels confirmés (0 compris) rendent un modèle appelable', async () => {
    const ligne = (model: string, i: number, o: number) => sql`
      INSERT INTO ai_model_pricing (provider, model, input_micros, output_micros, currency, source, source_reference, verified, effective_from, fetched_at)
      VALUES ('gemini', ${model}, ${i}, ${o}, 'USD', 'public_catalog', 'e2e', FALSE, NOW() - interval '1 hour', NOW())`;
    const statut = (model: string, status: string, staleDays: number | null) => sql`
      INSERT INTO ai_model_price_status (provider, model, status, input_per_million, output_per_million, source, reason, fetched_at, last_changed_at, stale_since)
      VALUES ('gemini', ${model}, ${status}, ${status === 'UNKNOWN' ? null : 0.3}, ${status === 'UNKNOWN' ? null : 2.5}, 'e2e', 'e2e', NOW(), NOW(),
              ${staleDays === null ? null : new Date(Date.now() - staleDays * 86_400_000).toISOString()}::timestamptz)`;
    await ligne('m-confirme', 0.3, 2.5); await statut('m-confirme', 'KNOWN', null);
    await ligne('m-gratuit', 0, 0); await statut('m-gratuit', 'KNOWN', null);
    await ligne('m-amorce', 0.3, 2.5);
    await ligne('m-stale-recent', 0.3, 2.5); await statut('m-stale-recent', 'STALE', 2);
    await ligne('m-stale-vieux', 0.3, 2.5); await statut('m-stale-vieux', 'STALE', 60);
    await ligne('m-inconnu', 0.3, 2.5); await statut('m-inconnu', 'UNKNOWN', null);
    const repo = await P();
    repo.clearPricingCache();
    await repo.loadPricingCache();
    const { pricingRefusalFor, pricingRefusalInTx, splitByPricing } = await import('@/services/ai/gateway/pricing/pricing-guard');
    expect(await splitByPricing(['m-confirme', 'm-gratuit', 'm-amorce', 'm-stale-recent', 'm-stale-vieux', 'm-inconnu', 'm-absent'])).toEqual({
      priced: ['m-confirme', 'm-gratuit', 'm-stale-recent'],
      unpriced: [
        { model: 'm-amorce', reason: 'tarif non confirmé par une source officielle' },
        { model: 'm-stale-vieux', reason: 'preuve tarifaire périmée (non reconfirmée dans le délai de validité)' },
        { model: 'm-inconnu', reason: 'tarif non lisible sur la page officielle' },
        { model: 'm-absent', reason: 'aucun tarif officiel connu' },
      ],
    });
    // Coût d'un tarif officiel de 0 : nul et calculable (jamais « inconnu »).
    const { calcCostMicros } = await import('@/services/ai/gateway/cost-catalog');
    expect(calcCostMicros('m-gratuit', 1000, 100)).toBe(0);
    expect(calcCostMicros('m-absent', 1000, 100)).toBeNull();

    // R07 : contrôle final dans une transaction — un tarif invalidé entre-temps est vu, même si le cache le porte encore.
    await sql`UPDATE ai_model_pricing SET invalidated_at = NOW() WHERE model = 'm-confirme'`;
    expect(await pricingRefusalFor('m-confirme')).toBeNull(); // cache d'instance pas encore relu
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      expect(await pricingRefusalInTx(tx as never, 'm-confirme')).toBe('aucun tarif officiel connu');
      expect(await pricingRefusalInTx(tx as never, 'm-gratuit')).toBeNull();
    });
    // Invalidation propagée par la clé de version : le cache relu ne sert plus le tarif retiré.
    await repo.bumpPricingVersion('e2e-l114p');
    await repo.refreshPricingCacheIfStale(Date.now() + repo.PRICING_VERSION_CHECK_MS + 1);
    expect(await pricingRefusalFor('m-confirme')).toBe('aucun tarif officiel connu');

    // Route active non conforme (aucun tarif vérifié pour les modèles des chaînes actives de cette base) : signalée
    // comme incident ACTUEL — « ce rang n'est plus appelé » — et résolue dès que le tarif est établi.
    const { reconcilePricingAlerts, evaluatePricingConditions } = await S();
    const c = await evaluatePricingConditions();
    expect(c.activeUnpriced.length).toBeGreaterThan(0);
    await reconcilePricingAlerts('e2e');
    const actives = await sql<Array<{ message: string }>>`SELECT message FROM ai_alerts WHERE resolved_at IS NULL AND code = 'ai_pricing_active_unpriced'`;
    expect(actives).toHaveLength(c.activeUnpriced.length);
    expect(actives.every((a) => /^Chaîne active sans tarif officiel vérifié : .* — ce rang n’est plus appelé, le rang configuré suivant est essayé/.test(a.message))).toBe(true);
    repo.__setVerifiedTestPricesForTests(true);
    const fin = await reconcilePricingAlerts('e2e');
    expect(fin!.resolved).toBe(actives.length);
    expect((await ouvertes()).filter((x) => x.startsWith('ai_pricing_'))).toEqual([]);
  });
});
