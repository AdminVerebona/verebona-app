/**
 * Lot 107D — ticket P1 « Draisienne : total multi-articles proposé comme prix
 * d'un article, arbitrage réapparu alors que l'utilisateur avait répondu »,
 * sur PostgreSQL 16 réel. Diagnostic SANS accès à la base de préproduction :
 * reproduction SYNTHÉTIQUE des chemins démontrés par le code (aucun montant
 * ni objet codé dans le code testé ; chiffres du §6 du ticket).
 *
 *   E2E-01  cause 1 : prix d'achat ancré dans le candidat Opération du ticket
 *           (T3 76J) = total du panier → plus aucune preuve ; preuve « panier »
 *           historique écartée, carte historique close ;
 *   E2E-02  stock : prix automatique égal au total corrigé par la ligne
 *           (contrôle COH-PRICE-MULTI-ARTICLE), traçable ; second passage sans
 *           doublon ; valeur USER égale au total jamais touchée ;
 *   E2E-03  cause 2 : arbitrage tranché (route « À traiter », desktop / mobile
 *           = même API) → carte disparue, valeur conservée ; trois passages
 *           (T3, cohérence, réanalyse de la même pièce) → aucune réouverture ;
 *   E2E-04  nouvelle preuve indépendante : probable → rien ; certaine → nouvel
 *           arbitrage MOTIVÉ (sources), valeur USER intacte ;
 *   E2E-05  remise de ligne (net), remise globale / coupon / lot / quantité
 *           sans prix unitaire → abstention, motif tracé ;
 *   E2E-06  bien + équipement sur le même ticket, articles identiques →
 *           attribution ciblée, aucune contamination du parent ;
 *   E2E-07  carte rouverte du stock (même preuve réémise) close par le
 *           contrôle, sans toucher la valeur ; idempotence.
 * Aucun appel modèle (T3 sans revue IA).
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import { proofOf, runCoherenceFor } from '../coherence-run';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/db', async (o) => ({ ...(await o<object>()), ensureMigrations: async () => {} }));

type Kc = Record<string, unknown>;
interface Carte { id: number; public_id: string; rule_code: string; action_kind: string; resolved_at: Date | null; resolution_reason: string | null; cycle_number: number;
  proposals_json: Array<{ value: unknown; isCurrentValue?: boolean; evidenceIds?: string[] }>; reopen_reason: Record<string, unknown> | null; evidence_keys: unknown }

const CHECK = 'COH-PRICE-MULTI-ARTICLE';
const TICKET_3 = ['MAGASIN DEMO', '24/04/2026 15:42', 'DRAISIENNE BOIS 12P 69,99', 'CASQUE ENFANT 34,95', 'SONNETTE 22,99', 'TOTAL TTC 127,93', 'CB 127,93'];

scenario('L107D', 'Prix multi-articles : total jamais prix d’un article ; arbitrage tranché jamais rouvert sans preuve nouvelle', ({ sql, make }) => {
  let engine: typeof import('@/services/ai/reconciliation/reconciliation-engine');
  let evidence: typeof import('@/services/ai/evidence/field-evidence.service');
  const session = { userId: 0, currentAccountId: 0 };
  let api: {
    resolve: (publicId: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
    page: () => Promise<{ total: number; actions: Array<{ publicId: string; targetId: number }> }>;
  };

  beforeAll(async () => {
    engine = await import('@/services/ai/reconciliation/reconciliation-engine');
    evidence = await import('@/services/ai/evidence/field-evidence.service');
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId, role: 'USER', email: '' }) as never);
    const { NextRequest } = await import('next/server');
    const resolve = await import('@/app/api/v2/to-process/[publicId]/resolve/route');
    const page = await import('@/app/api/v2/to-process/route');
    api = {
      resolve: async (publicId, body) => {
        const res = await resolve.POST(new NextRequest(`http://app.test/api/v2/to-process/${publicId}/resolve`, {
          method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
        }), { params: Promise.resolve({ publicId }) });
        return { status: res.status, body: await res.json() as Record<string, unknown> };
      },
      page: async () => (await (await page.GET(new NextRequest('http://app.test/api/v2/to-process'))).json()) as { total: number; actions: Array<{ publicId: string; targetId: number }> },
    };
  });

  // ── Fabriques ────────────────────────────────────────────────────────────
  const compte = async () => {
    const c = await make.account({ plan: 'premium' });
    session.userId = c.ownerUserId; session.currentAccountId = c.id;
    return c;
  };
  const objet = async (c: AccountRow, name: string, o: { kc?: Kc; priceCents?: number | null } = {}) =>
    (await make.asset(c, { category: 'OBJECT', name, keyCharacteristics: o.kc, purchasePriceCents: o.priceCents ?? null })).id;
  /** Justificatif analysé : couche A persistée (unités de la source) + montant du document. */
  const justificatif = async (c: AccountRow, assetId: number, lignes: string[] | null, totalCents: number) => {
    const f = await make.assetFile(c, { assetId });
    await sql`UPDATE asset_files SET document_type = 'FACTURE' WHERE id = ${f.id}`;
    const [x] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, full_text, full_text_chars, amount_cents)
      VALUES (${c.id}, ${f.id}, ${(lignes ?? []).join('\n')}, ${(lignes ?? []).join('\n').length}, ${totalCents}) RETURNING id`;
    if (lignes) {
      await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, content_text, payload, coverage_status)
        VALUES (${c.id}, ${f.id}, ${x.id}, 'doc:meta:amount', 'DOCUMENT_METADATA', 0, ${`${(totalCents / 100).toFixed(2)} €`}, ${JSON.stringify({ field: 'amount', cents: totalCents })}::jsonb, 'COVERED'),
               (${c.id}, ${f.id}, ${x.id}, 'page:1:block:1', 'TEXT_BLOCK', 1, ${lignes.join('\n')}, '{}'::jsonb, 'COVERED')`;
    }
    return { fileId: f.id, extractionId: x.id };
  };
  /** Preuve de prix ; `version` simule une réanalyse (nouvelle ligne de preuve, même contenu). */
  const preuve = (c: AccountRow, assetId: number, fileId: number, euros: number, o: { rule?: string | null; confidence?: 'certain' | 'probable'; version?: number; equipmentId?: number; excerpt?: string; section?: string } = {}) =>
    evidence.recordEvidence({
      accountId: c.id, assetId, fieldKey: 'acquisitionPrice', value: euros, normalizedValue: String(euros), sourceType: 'document', sourceId: fileId,
      sourceVersion: o.version ?? 1, location: o.section ? { section: o.section } : {}, excerpt: o.excerpt ?? `TOTAL TTC ${euros}`, confidence: o.confidence ?? 'certain', authorityScore: 60,
      canonicalKey: 'acquisitionPrice', documentType: 'FACTURE', projectionOrigin: o.rule === null ? 'MODEL_CANONICAL' : 'DETERMINISTIC_RULE', projectionRule: o.rule ?? null,
      target: o.equipmentId ? { type: 'EQUIPMENT', entityId: o.equipmentId, label: null, confidence: 'certain' } : { type: 'ASSET', entityId: assetId, label: null, confidence: 'certain' },
    });
  const reanalyser = async (c: AccountRow, ancienne: number, assetId: number, fileId: number, euros: number, version: number, excerpt?: string) => {
    await sql`UPDATE field_evidence SET lifecycle_status = 'SUPERSEDED', superseded_at = now() WHERE id = ${ancienne}`;
    return preuve(c, assetId, fileId, euros, { version, excerpt });
  };
  /** Candidat Opération ACQUISITION du ticket (cible certaine), coût réalisé TOTAL ancré sur un fait. */
  const candidatAchat = async (c: AccountRow, d: { fileId: number; extractionId: number }, assetId: number, amountMinor: number) => {
    const [fait] = await sql<{ id: number }[]>`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, confidence, excerpt)
      VALUES (${c.id}, ${d.fileId}, ${d.extractionId}, 'montant', 'Montant', ${String(amountMinor / 100)}, 'certain', 'TOTAL TTC 127,93') RETURNING id`;
    const payload = {
      payloadVersion: 1, targetHints: [{ type: 'ASSET', entityId: assetId, rawLabel: null, confidence: 'certain' }], temporalHints: { realizedDate: '2026-04-24' },
      financialHints: [{ role: 'REALIZED_COST', amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, evidence: { factId: fait.id, fingerprint: 'x', sourceUnitIds: [] } }],
      evidence: [{ factId: fait.id, fingerprint: 'x', sourceUnitIds: [] }], evidenceFactIds: [fait.id],
    };
    const [cand] = await sql<{ id: number }[]>`INSERT INTO document_operation_candidates (account_id, file_id, extraction_id, candidate_key, established, confidence, type_hint, status_hint, summary, payload, status, t3_pending)
      VALUES (${c.id}, ${d.fileId}, ${d.extractionId}, ${`k${fait.id}`}, true, 'certain', 'ACQUISITION', 'REALIZED', 'achat', ${JSON.stringify(payload)}::jsonb, 'ACTIVE', false) RETURNING id`;
    return { candidateId: cand.id, factId: fait.id };
  };
  const t3 = (c: AccountRow, assetId: number) => engine.reconcileAsset({ accountId: c.id, assetId, triggeredBy: 'manual', aiReview: false });
  const cartes = async (assetId: number, targetType = 'ASSET') => (await sql<Carte[]>`
    SELECT id, public_id, rule_code, action_kind, resolved_at, resolution_reason, cycle_number, proposals_json, reopen_reason, evidence_keys
      FROM to_process_actions WHERE target_type = ${targetType} AND target_id = ${assetId} AND field_key = 'acquisitionPrice' ORDER BY id`)
    .map((x): Carte => ({ ...x, proposals_json: (typeof x.proposals_json === 'string' ? JSON.parse(x.proposals_json) : x.proposals_json) ?? [] }));
  const ouvertes = async (assetId: number, targetType = 'ASSET') => (await cartes(assetId, targetType)).filter((x) => x.resolved_at === null);
  const fiche = async (assetId: number) => {
    const [r] = await sql<{ kc: string | null; cents: number | null }[]>`SELECT key_characteristics AS kc, purchase_price_cents AS cents FROM assets WHERE id = ${assetId}`;
    const kc = (r.kc ? JSON.parse(r.kc) : {}) as Kc;
    return { kc, prix: kc.acquisitionPrice ?? (r.cents == null ? null : Number(r.cents) / 100), origine: kc.acquisitionPrice__origin ?? (r.cents == null ? null : 'USER') };
  };
  const preuvesActives = (assetId: number) => sql<{ id: number; value_json: unknown; projection_rule: string | null; target_type: string | null; target_entity_id: number | null }[]>`
    SELECT id, value_json, projection_rule, target_type, target_entity_id FROM field_evidence
     WHERE asset_id = ${assetId} AND field_key = 'acquisitionPrice' AND status = 'active' AND COALESCE(lifecycle_status, 'ACTIVE') = 'ACTIVE' ORDER BY id`;
  const equipement = async (assetId: number, name: string) =>
    (await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${assetId}, ${name}) RETURNING id`)[0].id;
  const surPage = async (assetId: number) => (await api.page()).actions.filter((a) => a.targetId === assetId);

  // ══ E2E-01 — cause 1 : total du panier matérialisé comme prix (T3 76J) ═══════

  it('L107D-E2E-01 — ticket 3 articles, prix saisi 69,99 € : le total (127,93 €) du candidat Opération n’est plus une preuve ; preuve « panier » historique écartée, carte historique close ; valeur intacte', async () => {
    const c = await compte();
    const b = await objet(c, 'Draisienne', { priceCents: 6999 });
    const d = await justificatif(c, b, TICKET_3, 12793);
    const cand = await candidatAchat(c, d, b, 12793);

    await t3(c, b);
    expect((await preuvesActives(b)).filter((e) => e.projection_rule === 'T3_ACQUISITION_OPERATION_PRICE')).toEqual([]);
    expect(await ouvertes(b)).toEqual([]);
    expect(await fiche(b)).toMatchObject({ prix: 69.99, origine: 'USER' });

    // Stock : preuve « panier » écrite par l'ancien code + carte « 127,93 € (proposition) / 69,99 € (actuelle) ».
    const panier = await preuve(c, b, d.fileId, 127.93, { rule: 'T3_ACQUISITION_OPERATION_PRICE', section: `operation_candidate:${cand.candidateId}:fact:${cand.factId}` });
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, priority, question, proposals_json, active_since, last_seen_at, cycle_number, created_at, updated_at)
      VALUES (${c.id}, 'ASSET', ${b}, 'acquisitionPrice', 'ARBITRATE', 'DATA-ACQUISITION-PRICE', 'DO_NEXT', 'Quel est le prix d’acquisition de ce bien ?',
        ${JSON.stringify([{ value: 127.93, label: '127.93', confidence: 0.6, evidenceIds: [String(panier)] }, { value: 69.99, label: '69.99', confidence: 1, isCurrentValue: true }])}::jsonb, now(), now(), 1, now(), now())`;
    expect(await surPage(b)).toHaveLength(1);

    await t3(c, b);
    const [carte] = await cartes(b);
    expect(carte.resolution_reason).toBe('OBSOLETE');
    expect(await surPage(b)).toEqual([]);
    expect(await fiche(b)).toMatchObject({ prix: 69.99, origine: 'USER' });
    // Décision tracée : preuve écartée, motif.
    const [dec] = await sql<{ action: string; reason_code: string }[]>`SELECT action, reason_code FROM reconciliation_decisions WHERE account_id = ${c.id} AND asset_id = ${b} AND field_key = 'acquisitionPrice' ORDER BY id DESC LIMIT 1`;
    expect(dec).toMatchObject({ action: 'keep', reason_code: 'NON_ATTRIBUTABLE_AMOUNT' });
    // Rapport T3 : document, montant, rôle, motif.
    const [r] = await sql<{ eid: number }[]>`SELECT COALESCE(entries_report_id, id) AS eid FROM ai_execution_reports WHERE account_id = ${c.id} AND treatment = 'T3' AND target_id = ${b} ORDER BY id DESC LIMIT 1`;
    const [e] = await sql<{ links: { excluded?: Array<Record<string, unknown>> } }[]>`SELECT links FROM ai_execution_report_entries WHERE report_id = ${r.eid} AND field_key = 'acquisitionPrice' ORDER BY seq DESC LIMIT 1`;
    expect(e.links.excluded?.[0]).toMatchObject({ evidenceId: panier, sourceFileId: d.fileId, cents: 12793, reason: 'BASKET_TOTAL_MULTI_ARTICLE' });

    // Second passage : rien de nouveau.
    await t3(c, b);
    expect(await ouvertes(b)).toEqual([]);
  });

  // ══ E2E-02 — stock : prix automatique égal au total, corrigé par la ligne ═════

  it('L107D-E2E-02 — prix AUTOMATIQUE 127,93 € (total) : contrôle quotidien → preuve panier retirée, ligne 69,99 € attribuée, prix corrigé et tracé ; second passage : aucun doublon ; prix USER égal au total jamais touché', async () => {
    const c = await compte();
    const auto = await objet(c, 'Draisienne', { kc: { acquisitionPrice: 127.93, acquisitionPrice__origin: 'DOCUMENT_EXTRACTION', acquisitionPrice__authority: 60 } });
    const dA = await justificatif(c, auto, TICKET_3, 12793);
    await preuve(c, auto, dA.fileId, 127.93, { rule: 'PURCHASE_RECEIPT_ACQUISITION_PRICE' });
    const user = await objet(c, 'Draisienne', { kc: { acquisitionPrice: 127.93, acquisitionPrice__origin: 'USER' } });
    const dU = await justificatif(c, user, TICKET_3, 12793);
    await preuve(c, user, dU.fileId, 127.93, { rule: 'PURCHASE_RECEIPT_ACQUISITION_PRICE' });

    const r1 = await runCoherenceFor(sql, [c.id]);
    expect(r1.results[CHECK]?.REPAIRED).toBe(2);
    const p = await proofOf(sql, c.id, CHECK, auto);
    expect(p?.last_result).toBe('REPAIRED');

    expect(await fiche(auto)).toMatchObject({ prix: 69.99 });
    const actives = await preuvesActives(auto);
    expect(actives.map((e) => [Number(e.value_json), e.projection_rule])).toEqual([[69.99, 'PURCHASE_LINE_ATTRIBUTED']]);
    // Écriture canonique traçable (avant / après).
    const [w] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM canonical_field_writes WHERE account_id = ${c.id} AND asset_id = ${auto} AND canonical_key = 'acquisitionPrice'`;
    expect(w.n).toBeGreaterThan(0);
    // Valeur USER intacte (127,93 € saisi par l'utilisateur : sa décision fait foi).
    expect(await fiche(user)).toMatchObject({ prix: 127.93, origine: 'USER' });

    const avant = { preuves: (await preuvesActives(auto)).length, ecritures: w.n };
    const r2 = await runCoherenceFor(sql, [c.id]);
    expect(r2.results[CHECK]?.REPAIRED ?? 0).toBe(0);
    expect((await proofOf(sql, c.id, CHECK, auto))?.last_result).toBe('CONSISTENT');
    const [w2] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM canonical_field_writes WHERE account_id = ${c.id} AND asset_id = ${auto} AND canonical_key = 'acquisitionPrice'`;
    expect({ preuves: (await preuvesActives(auto)).length, ecritures: w2.n }).toEqual(avant);
    await t3(c, auto);
    expect(await fiche(auto)).toMatchObject({ prix: 69.99 });
    expect(await ouvertes(auto)).toEqual([]);
  });

  // ══ E2E-03 — cause 2 : décision utilisateur persistante ══════════════════════

  it('L107D-E2E-03 — arbitrage tranché par la route « À traiter » (desktop = mobile) : carte disparue, valeur conservée ; trois passages (T3, cohérence, réanalyse de la même pièce) → aucune réouverture', async () => {
    const c = await compte();
    const b = await objet(c, 'Draisienne', { priceCents: 6999 });
    // Pièce à UN article (aucune exclusion) dont la valeur diffère : contradiction réelle.
    const d = await justificatif(c, b, ['VELO DRAISIENNE 74,50', 'TOTAL 74,50'], 7450);
    const e1 = await preuve(c, b, d.fileId, 74.5, { excerpt: 'VELO DRAISIENNE 74,50' });

    await t3(c, b);
    const [carte] = await ouvertes(b);
    expect(carte.proposals_json.filter((x) => !x.isCurrentValue).map((x) => x.value)).toEqual([74.5]);
    expect(await surPage(b)).toHaveLength(1);

    const r = await api.resolve(carte.public_id, { mode: 'arbitrate', value: 69.99 });
    expect(r.status).toBe(200);
    // Disparition immédiate, persistance au rechargement.
    expect(await surPage(b)).toEqual([]);
    expect(await surPage(b)).toEqual([]);
    expect(await fiche(b)).toMatchObject({ prix: 69.99, origine: 'USER' });

    // Passage 1 : T3 (reprise horaire).
    await t3(c, b);
    expect(await ouvertes(b)).toEqual([]);
    // Passage 2 : contrôle de cohérence.
    await runCoherenceFor(sql, [c.id]);
    expect(await ouvertes(b)).toEqual([]);
    // Passage 3 : réanalyse T1 de la MÊME pièce (nouvelle ligne de preuve, même contenu) puis T3.
    const e2 = await reanalyser(c, e1, b, d.fileId, 74.5, 2, 'VELO DRAISIENNE 74,50');
    expect(e2).not.toBe(e1);
    await t3(c, b);
    await runCoherenceFor(sql, [c.id]);
    await t3(c, b);
    expect(await ouvertes(b)).toEqual([]);
    expect((await cartes(b)).map((x) => x.cycle_number)).toEqual([1]);
    expect(await surPage(b)).toEqual([]);
    expect(await fiche(b)).toMatchObject({ prix: 69.99, origine: 'USER' });
    const [dec] = await sql<{ reason_code: string }[]>`SELECT reason_code FROM reconciliation_decisions WHERE account_id = ${c.id} AND asset_id = ${b} AND field_key = 'acquisitionPrice' ORDER BY id DESC LIMIT 1`;
    expect(dec.reason_code).toBe('USER_DECISION_SAME_EVIDENCE');
  });

  // ══ E2E-04 — nouvelle preuve indépendante ════════════════════════════════════

  it('L107D-E2E-04 — après décision : preuve d’un autre document probable → aucune carte ; certaine → nouvel arbitrage MOTIVÉ (source, valeur), valeur USER jamais écrasée', async () => {
    const c = await compte();
    const b = await objet(c, 'Draisienne', { priceCents: 6999 });
    const d1 = await justificatif(c, b, ['VELO DRAISIENNE 74,50', 'TOTAL 74,50'], 7450);
    await preuve(c, b, d1.fileId, 74.5, { excerpt: 'VELO DRAISIENNE 74,50' });
    await t3(c, b);
    const [carte] = await ouvertes(b);
    expect((await api.resolve(carte.public_id, { mode: 'arbitrate', value: 69.99 })).status).toBe(200);

    const d2 = await justificatif(c, b, ['DRAISIENNE 80,00', 'TOTAL 80,00'], 8000);
    const probable = await preuve(c, b, d2.fileId, 80, { confidence: 'probable', excerpt: 'DRAISIENNE 80,00' });
    await t3(c, b);
    expect(await ouvertes(b)).toEqual([]);

    await sql`UPDATE field_evidence SET lifecycle_status = 'SUPERSEDED' WHERE id = ${probable}`;
    const d3 = await justificatif(c, b, ['DRAISIENNE 81,00', 'TOTAL 81,00'], 8100);
    const certaine = await preuve(c, b, d3.fileId, 81, { excerpt: 'DRAISIENNE 81,00' });
    await t3(c, b);
    const [nouvelle] = await ouvertes(b);
    expect(nouvelle.cycle_number).toBe(2);
    expect(nouvelle.reopen_reason).toMatchObject({ code: 'NEW_INDEPENDENT_EVIDENCE', decidedActionId: carte.id, sources: [{ source: `document:${d3.fileId}`, evidenceId: String(certaine), value: 81 }] });
    const [ev] = await sql<{ details: Record<string, unknown> }[]>`SELECT details FROM to_process_action_events WHERE action_id = ${nouvelle.id} AND event = 'REOPENED_NEW_EVIDENCE'`;
    expect(ev.details).toMatchObject({ code: 'NEW_INDEPENDENT_EVIDENCE' });
    expect(await fiche(b)).toMatchObject({ prix: 69.99, origine: 'USER' });
    // Même situation au passage suivant : même carte (aucun doublon, aucun nouveau cycle).
    await t3(c, b);
    expect((await ouvertes(b)).map((x) => x.id)).toEqual([nouvelle.id]);
  });

  // ══ E2E-05 — remises, coupons, lots, quantités ══════════════════════════════

  it('L107D-E2E-05 — remise de ligne → prix net ; remise globale, coupon, lot, quantité sans prix unitaire → abstention motivée, aucun prix inventé', async () => {
    const c = await compte();
    const cas = [
      { lignes: ['DRAISIENNE BOIS 80,00', 'REMISE -10,01', 'CASQUE 34,95', 'TOTAL 104,94'], total: 10494, attendu: 69.99 },
      { lignes: ['DRAISIENNE BOIS 69,99', 'CASQUE 34,95', 'SOUS-TOTAL 104,94', 'REMISE FIDELITE -10,00', 'TOTAL 94,94'], total: 9494, refus: 'GLOBAL_ADJUSTMENT_UNCERTAIN' },
      { lignes: ['DRAISIENNE BOIS 69,99', 'CASQUE 34,95', 'BON D ACHAT -5,00', 'TOTAL 99,94'], total: 9994, refus: 'GLOBAL_ADJUSTMENT_UNCERTAIN' },
      { lignes: ['LOT DE 2 DRAISIENNES 120,00', 'CASQUE 34,95', 'TOTAL 154,95'], total: 15495, refus: 'BUNDLE_OR_LOT' },
      { lignes: ['Qté 2 DRAISIENNE BOIS 139,98', 'TOTAL 139,98'], total: 13998, refus: 'QUANTITY_UNIT_PRICE_NOT_SHOWN' },
    ];
    for (const k of cas) {
      const b = await objet(c, 'Draisienne', { kc: { acquisitionPrice: k.total / 100, acquisitionPrice__origin: 'DOCUMENT_EXTRACTION', acquisitionPrice__authority: 60 } });
      const d = await justificatif(c, b, k.lignes, k.total);
      await preuve(c, b, d.fileId, k.total / 100, { rule: 'PURCHASE_RECEIPT_ACQUISITION_PRICE' });
      const { diagnoseAssetPrices } = await import('@/services/ai/reconciliation/multi-article-repair');
      const diag = await diagnoseAssetPrices(sql as never, c.id, b);
      expect(diag.basketEvidence.map((x) => x.cents)).toEqual([k.total]);
      if (k.attendu) expect(diag.lineAttributions.map((x) => x.cents / 100)).toEqual([k.attendu]);
      else expect(diag.abstentions.map((x) => x.reason)).toEqual([k.refus]);
    }
    await runCoherenceFor(sql, [c.id]);
    const biens = await sql<{ id: number; kc: string }[]>`SELECT id, key_characteristics AS kc FROM assets WHERE account_id = ${c.id} ORDER BY id`;
    const prix = biens.map((x) => JSON.parse(x.kc).acquisitionPrice ?? null);
    // Ligne nette démontrée : 69,99 € ; abstentions : prix automatique « panier » retiré (aucun prix inventé).
    expect(prix).toEqual([69.99, null, null, null, null]);
  });

  // ══ E2E-06 — multi-cibles, articles identiques ═══════════════════════════════

  it('L107D-E2E-06 — bien + équipement sur le même ticket : chacun SA ligne, jamais le total ni le prix de l’autre ; articles identiques : abstention', async () => {
    const c = await compte();
    const velo = await objet(c, 'Vélo enfant', { kc: { acquisitionPrice: 154.94, acquisitionPrice__origin: 'DOCUMENT_EXTRACTION', acquisitionPrice__authority: 60 } });
    const casque = await equipement(velo, 'Casque enfant');
    const d = await justificatif(c, velo, ['VELO ENFANT 16P 119,99', 'CASQUE ENFANT 34,95', 'TOTAL 154,94'], 15494);
    await preuve(c, velo, d.fileId, 154.94, { rule: 'PURCHASE_RECEIPT_ACQUISITION_PRICE' });
    await preuve(c, velo, d.fileId, 154.94, { rule: null, equipmentId: casque, excerpt: 'CB 154,94' });
    // Service du contrôle appelé directement : COH-ASSET-EQUIPMENT-SEPARATION (lot 71A) traiterait sinon d'abord ce stock synthétique.
    const rep = await import('@/services/ai/reconciliation/multi-article-repair');
    const diag = await rep.diagnoseAssetPrices(sql as never, c.id, velo);
    expect(diag.lineAttributions.map((l) => [l.target.type, l.cents]).sort()).toEqual([['ASSET', 11999], ['EQUIPMENT', 3495]]);
    await rep.repairAssetPrices(sql as never, c.id, diag, { correlationId: 'e2e-107d' });
    const actives = await preuvesActives(velo);
    expect(actives.map((e) => [e.target_type, Number(e.value_json)]).sort()).toEqual([['ASSET', 119.99], ['EQUIPMENT', 34.95]]);
    expect(await fiche(velo)).toMatchObject({ prix: 119.99 });

    const chaise = await objet(c, 'Chaise jardin', { kc: { acquisitionPrice: 50, acquisitionPrice__origin: 'DOCUMENT_EXTRACTION', acquisitionPrice__authority: 60 } });
    const d2 = await justificatif(c, chaise, ['CHAISE JARDIN 25,00', 'CHAISE JARDIN 25,00', 'TOTAL 50,00'], 5000);
    await preuve(c, chaise, d2.fileId, 50, { rule: 'PURCHASE_RECEIPT_ACQUISITION_PRICE' });
    const { diagnoseAssetPrices } = await import('@/services/ai/reconciliation/multi-article-repair');
    expect((await diagnoseAssetPrices(sql as never, c.id, chaise)).abstentions.map((x) => x.reason)).toEqual(['AMBIGUOUS_LINES']);
  });

  // ══ E2E-07 — stock de cartes rouvertes ═══════════════════════════════════════

  it('L107D-E2E-07 — carte rouverte du stock (même preuve réémise après décision) : close par le contrôle, valeur intacte, motif tracé ; second passage : rien', async () => {
    const c = await compte();
    const b = await objet(c, 'Draisienne', { priceCents: 6999 });
    const d = await justificatif(c, b, ['VELO DRAISIENNE 74,50', 'TOTAL 74,50'], 7450);
    const e1 = await preuve(c, b, d.fileId, 74.5, { excerpt: 'VELO DRAISIENNE 74,50' });
    await t3(c, b);
    const [carte] = await ouvertes(b);
    expect((await api.resolve(carte.public_id, { mode: 'arbitrate', value: 69.99 })).status).toBe(200);
    // Ancien comportement : réanalyse → nouvelle preuve → nouvelle carte (cycle 2), insérée telle quelle.
    const e2 = await reanalyser(c, e1, b, d.fileId, 74.5, 2, 'VELO DRAISIENNE 74,50');
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, priority, question, proposals_json, active_since, last_seen_at, cycle_number, created_at, updated_at)
      VALUES (${c.id}, 'ASSET', ${b}, 'acquisitionPrice', 'ARBITRATE', 'DATA-ACQUISITION-PRICE', 'DO_NEXT', 'Quel est le prix d’acquisition de ce bien ?',
        ${JSON.stringify([{ value: 74.5, label: '74.5', confidence: 1, evidenceIds: [String(e2)] }, { value: 69.99, label: '69.99', confidence: 1, isCurrentValue: true }])}::jsonb, now(), now(), 2, now(), now())`;
    expect(await surPage(b)).toHaveLength(1);

    const r1 = await runCoherenceFor(sql, [c.id]);
    expect(r1.results[CHECK]?.REPAIRED).toBe(1);
    expect(await ouvertes(b)).toEqual([]);
    expect(await surPage(b)).toEqual([]);
    const [ev] = await sql<{ details: Record<string, unknown> }[]>`SELECT e.details FROM to_process_action_events e JOIN to_process_actions a ON a.id = e.action_id
      WHERE a.target_id = ${b} AND a.cycle_number = 2 AND e.event = 'OBSOLETE'`;
    expect(ev.details).toMatchObject({ reason: 'ALREADY_DECIDED_SAME_EVIDENCE', memory: 'SAME_EVIDENCE', decidedActionId: carte.id });
    expect(await fiche(b)).toMatchObject({ prix: 69.99, origine: 'USER' });
    const r2 = await runCoherenceFor(sql, [c.id]);
    expect(r2.results[CHECK]?.REPAIRED ?? 0).toBe(0);
    await t3(c, b);
    expect(await ouvertes(b)).toEqual([]);
  });
});
