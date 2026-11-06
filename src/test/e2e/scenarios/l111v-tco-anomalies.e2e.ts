/**
 * Lot 111V — TCO : chaque anomalie a une issue (ticket P1 « TCO — rendre
 * chaque anomalie corrigeable, fiabiliser les exclusions et clôturer les
 * arbitrages »), sur base RÉELLE (routes, moteur, persistance, contrôle de
 * cohérence, file `ai_job_queue`).
 *
 *   L111V-E01 avis de taxe foncière EUR (type V2 connu, colonne historique au
 *             repli « AUTRE ») : jamais « document sans valeur » ni « devise
 *             étrangère » ; nature établie par T1 → charge retenue ; sinon
 *             « Ajouter » possible, T2 cohérent ;
 *   L111V-E02 attestation sans dépense : aucune ligne, aucun « montant
 *             inconnu », récupération close sans objet, aucune relecture T1 ;
 *   L111V-E03 abonnements de même montant, périodes distinctes : deux
 *             dépenses, aucun doublon présumé ;
 *   L111V-E04 même fait confirmé : une contribution, deux sources, point clos,
 *             décision persistée et journalisée, survit à la reconsolidation
 *             T3, réversible ;
 *   L111V-E05 exclusion confirmée persistante après recalcul et T3 ; contrôle
 *             COH-TCO-EXTRACTED-EXPENSES conforme (issue explicable) ;
 *   L111V-E06 faux doublon → dépenses distinctes : second coût inclus, compteur ;
 *   L111V-E07 états de récupération : sans état / en file / RUNNING / reprise
 *             prévue / échec technique épuisé / introuvable ;
 *   L111V-E08 droits : Premium Duo (membre), essai autorisés ; Standard 403 ;
 *             lecture seule refusée, aucune écriture.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0, role: 'USER', email: '' }));
type Json = Record<string, any>;

scenario('L111V', 'TCO — anomalies corrigeables, arbitrages durables, états de récupération réels', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;

  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId, role: session.role, email: session.email }) as never);
    ({ NextRequest } = await import('next/server'));
  });

  const as = (compte: AccountRow, userId = compte.ownerUserId) => { session.currentAccountId = compte.id; session.userId = userId; session.role = 'USER'; };
  const getTco = async (assetId: number) => {
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as Json };
  };
  const decide = async (assetId: number, body: Json) => {
    const { POST } = await import('@/app/api/assets/[id]/tco/decisions/route');
    const res = await POST(new NextRequest(`http://x/api/assets/${assetId}/tco/decisions`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as Json };
  };
  const coherent = (tco: Json) => {
    const a = tco.annual;
    expect(a.years.reduce((n: number, y: Json) => n + y.netCents, 0) + a.undated.costsCents - a.undated.creditsCents).toBe(tco.summary.cumulativeCostCents);
  };
  const ouverts = (tco: Json) => (tco.diagnostics.items as Json[]).filter((d) => d.status === 'OPEN').map((d) => d.code);
  const diag = (tco: Json, code: string): Json => (tco.diagnostics.items as Json[]).find((d) => d.code === code) as Json;
  const ligne = (tco: Json, pred: (l: Json) => boolean) => (tco.lines as Json[]).find(pred);

  const PRIX = 30_000_000;
  const TAXE = 140_000;
  const ABO = 4_050;

  const maisonDe = (compte: AccountRow): Promise<AssetRow> =>
    make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', purchasePriceCents: PRIX, keyCharacteristics: { acquisitionDate: '2015-03-02' } });

  /** Avis de taxe foncière tel qu'il est stocké : type V2 connu, colonne historique `document_type` au repli « AUTRE ». */
  async function avisTaxe(compte: AccountRow, maison: AssetRow, o: { t1?: boolean; title?: string; cents?: number } = {}) {
    const montant = o.cents ?? TAXE;
    const f = await k.document(compte, maison.id, o.t1 ? [cand({
      typeHint: 'OTHER', summary: 'Taxe foncière 2026', provider: 'Finances publiques', sourceRoleHint: 'INVOICE', targetHints: [cible(maison.id)],
      temporalHints: { realizedDate: '2026-09-01' }, financialHints: [fh('REALIZED_COST', montant, { economicDate: '2026-09-01', periodStart: '2026-01-01', periodEnd: '2026-12-31' })],
    })] : [], { type: 'PROPERTY_TAX_NOTICE', title: o.title ?? 'Avis de taxe foncière 2026', amountCents: montant, date: '2026-09-01' });
    await sql`UPDATE asset_files SET document_type = 'AUTRE' WHERE id = ${f}`;
    return f;
  }

  /** Deux justificatifs de 40,50 € réunis dans UNE dépense (T3 réel, puis réunion explicite comme en préproduction). */
  async function abonnement(compte: AccountRow, maison: AssetRow, o: { periodes: boolean }) {
    const piece = (n: number) => k.document(compte, maison.id, [cand({
      typeHint: 'INTERVENTION', summary: 'Télésurveillance', provider: 'Télésurveillance', sourceRoleHint: 'INVOICE', targetHints: [cible(maison.id)],
      temporalHints: { realizedDate: '2026-02-03' },
      financialHints: [fh('REALIZED_COST', ABO, { economicDate: '2026-02-03', ...(o.periodes ? { periodStart: `2026-0${n + 1}-01`, periodEnd: `2026-0${n + 1}-28` } : {}) })],
    })], { type: 'SUBSCRIPTION_INVOICE', title: `Facture télésurveillance ${n}`, amountCents: ABO, date: '2026-02-03' });
    const a = await piece(1);
    const b = await piece(2);
    await k.passer(compte);
    const ops = await sql<{ id: number }[]>`
      SELECT DISTINCT s.operation_id::int AS id FROM business_operation_sources s JOIN business_operations x ON x.id = s.operation_id
       WHERE s.account_id = ${compte.id} AND s.source_kind = 'DOCUMENT' AND s.active AND s.source_entity_key IN (${String(a)}, ${String(b)})
         AND x.invalidated_at IS NULL AND x.merged_into_operation_id IS NULL ORDER BY 1`;
    expect(ops.length).toBeGreaterThan(0);
    const garde = ops[0].id;
    for (const x of ops.slice(1)) {
      await sql`UPDATE business_operation_sources SET operation_id = ${garde} WHERE operation_id = ${x.id}`;
      await sql`UPDATE business_operation_financial_components SET operation_id = ${garde} WHERE operation_id = ${x.id}`;
      await sql`UPDATE business_operations SET merged_into_operation_id = ${garde}, invalidated_at = now(), invalidation_reason = 'MERGED' WHERE id = ${x.id}`;
    }
    // Un justificatif resté hors de la dépense (T3 du socle) : rattaché comme en préproduction — sa source et SA composante.
    for (const f of [a, b]) {
      const deja = await sql`SELECT 1 FROM business_operation_sources WHERE operation_id = ${garde} AND source_kind = 'DOCUMENT' AND source_entity_key = ${String(f)} AND active`;
      if (deja.length) continue;
      const [modele] = await sql<{ id: number }[]>`SELECT id::int AS id FROM business_operation_sources WHERE operation_id = ${garde} AND source_kind = 'DOCUMENT' AND active ORDER BY id LIMIT 1`;
      const [src] = await sql<{ id: number }[]>`
        INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, source_role, locator, authority, confidence, match_method, match_reason)
        SELECT account_id, operation_id, source_kind, ${String(f)}, source_role, locator, authority, confidence, match_method, match_reason FROM business_operation_sources WHERE id = ${modele.id}
        RETURNING id::int AS id`;
      const [c] = await sql<{ id: number }[]>`
        INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency, amount_eur_cents, economic_date, period_start, period_end, target_asset_id, label, fingerprint)
        SELECT account_id, operation_id, kind, amount_minor, currency, amount_eur_cents, economic_date,
               ${o.periodes ? '2026-03-01' : null}::date, ${o.periodes ? '2026-03-28' : null}::date, target_asset_id, label, coalesce(fingerprint, '') || ${`-e2e-${f}`}
          FROM business_operation_financial_components WHERE operation_id = ${garde} AND active AND amount_minor = ${ABO} ORDER BY id LIMIT 1
        RETURNING id::int AS id`;
      await sql`INSERT INTO business_operation_financial_component_sources (component_id, operation_source_id, is_primary) VALUES (${c.id}, ${src.id}, true)`;
    }
    return { a, b, operationId: garde };
  }

  it('L111V-E01 — avis de taxe foncière EUR : jamais « document sans valeur » ni « devise étrangère » ; T1 → charge retenue ; sinon « Ajouter » réel, T2 cohérent', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await maisonDe(compte);
    const sansT1 = await avisTaxe(compte, maison);
    const avecT1 = await avisTaxe(compte, maison, { t1: true, title: 'Avis de taxe foncière 2026 du garage', cents: 38_000 });
    as(compte);
    const r = await getTco(maison.id);
    expect(r.status).toBe(200);
    const t = r.body.tco;
    const lu = ligne(t, (l) => l.fileId === avecT1 && l.includedCents > 0)!;
    expect(lu).toMatchObject({ status: 'RETAINED_DIRECT', includedCents: 38_000, kind: 'REALIZED_COST' });
    const nonQualifie = ligne(t, (l) => l.fileId === sansT1)!;
    expect(nonQualifie).toMatchObject({ status: 'NOT_QUALIFIED', reason: 'THEME_UNKNOWN', eurCents: TAXE });
    expect(nonQualifie.reason).not.toBe('NOT_EXPENSE_DOCUMENT');
    expect(JSON.stringify(nonQualifie.actions)).not.toMatch(/devise/);
    expect(nonQualifie.actions.options.map((o: Json) => o.action)).toEqual(['INCLUDE', 'CONFIRM_EXCLUSION']);
    expect(ouverts(t)).toContain('DOCUMENTS_NOT_QUALIFIED');
    const total = t.summary.cumulativeCostCents;
    // Ajouter : charge comptée, aucun paiement inventé ; T2 compte la même dépense (même règle).
    const add = await decide(maison.id, { lineId: nonQualifie.id, lineKey: nonQualifie.decisionKey, action: 'INCLUDE' });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    expect(add.body.tco.summary.cumulativeCostCents).toBe(total + TAXE);
    expect(ouverts(add.body.tco)).not.toContain('DOCUMENTS_NOT_QUALIFIED');
    coherent(add.body.tco);
    const { t2CostExclusions } = await import('@/services/business-operations/tco/service');
    const t2 = await t2CostExclusions(compte.id, [], [maison.id]);
    expect(t2.userAdded.map((u) => [u.fileId, u.eurCents])).toEqual([[sansT1, TAXE]]);
  });

  it('L111V-E02 — attestation d’assurance sans dépense : aucune ligne, aucun montant exigé, récupération close sans objet, aucune relecture T1', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await maisonDe(compte);
    const attestation = await k.document(compte, maison.id, [], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation habitation', amountCents: null, date: '2026-01-05' });
    const conditions = await k.document(compte, maison.id, [], { type: 'INSURANCE_POLICY', title: 'Conditions générales', amountCents: null, date: '2026-01-05' });
    // État hérité d'avant le correctif : récupération « ouverte » sur ces documents (bloc « Lecture du montant en cours (2) »).
    for (const f of [attestation, conditions]) await sql`INSERT INTO document_amount_recoveries (account_id, file_id, status) VALUES (${compte.id}, ${f}, 'PENDING')`;
    as(compte);
    const t = (await getTco(maison.id)).body.tco;
    expect((t.lines as Json[]).filter((l) => l.fileId === attestation || l.fileId === conditions)).toEqual([]);
    expect(t.amountRecovery ?? null).toBeNull();
    expect(diag(t, 'AMOUNTS_RECOVERY_PENDING')).toBeUndefined();
    expect(diag(t, 'AMOUNTS_UNKNOWN')).toBeUndefined();
    // Contrôle réel (mode correctif) : clos sans objet, jamais relu.
    const [{ controlObjects }, { getCheck }, { pgClient }] = await Promise.all([import('@/services/coherence/engine'), import('@/services/coherence/registry'), import('@/db')]);
    const check = getCheck('COH-TCO-AMOUNT-RECOVERY')!;
    const ctx = { sql: pgClient, now: new Date(), today: '2026-11-05', mode: 'CORRECTIVE' as const, correlationId: 'e2e:l111v' };
    await controlObjects({ ctx, check, accountId: compte.id, ids: [attestation, conditions], trigger: 'MANUAL', campaignId: null, stillEligible: async () => ({ eligible: true, reason: '' }) });
    const etats = await sql<{ status: string }[]>`SELECT status FROM document_amount_recoveries WHERE file_id IN (${attestation}, ${conditions}) ORDER BY file_id`;
    expect(etats.map((e) => e.status)).toEqual(['NOT_APPLICABLE', 'NOT_APPLICABLE']);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_job_queue WHERE treatment = 'T1' AND target_id IN (${String(attestation)}, ${String(conditions)})`;
    expect(n).toBe(0);
    // Second passage : rien de plus (aucune boucle).
    await controlObjects({ ctx, check, accountId: compte.id, ids: [attestation, conditions], trigger: 'MANUAL', campaignId: null, stillEligible: async () => ({ eligible: true, reason: '' }) });
    const [{ m }] = await sql<{ m: number }[]>`SELECT count(*)::int AS m FROM ai_job_queue WHERE treatment = 'T1' AND target_id IN (${String(attestation)}, ${String(conditions)})`;
    expect(m).toBe(0);
  });

  it('L111V-E03 — abonnements de même montant, périodes distinctes : deux dépenses, aucun doublon présumé (jamais fusionnées sur 40,50 € seul)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await maisonDe(compte);
    await abonnement(compte, maison, { periodes: true });
    as(compte);
    const t = (await getTco(maison.id)).body.tco;
    expect((t.lines as Json[]).filter((l) => l.amountMinor === ABO).reduce((n, l) => n + l.includedCents, 0)).toBe(2 * ABO);
    expect(t.reliability.warnings).not.toContain('PRESUMED_DUPLICATES');
    expect(ouverts(t)).not.toContain('PRESUMED_DUPLICATES');
  });

  it('L111V-E04 — même fait confirmé : une contribution, les deux sources conservées, point clos ; persisté, journalisé, survit à T3, réversible', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await maisonDe(compte);
    const j = await abonnement(compte, maison, { periodes: false });
    as(compte);
    const t = (await getTco(maison.id)).body.tco;
    const d = diag(t, 'PRESUMED_DUPLICATES');
    expect(d, JSON.stringify((t.lines as Json[]).map((l) => [l.id, l.status, l.reason, l.amountMinor]))).toMatchObject({ status: 'OPEN', count: 1 });
    expect(d.text).not.toMatch(/rien à faire/);
    const src = d.sources[0];
    expect(src.actions.map((o: Json) => o.action)).toEqual(['SAME_FACT', 'DISTINCT_FACTS']);
    expect(src.counterpart).toMatchObject({ amountCents: ABO });
    expect(t.diagnostics.open.decisions).toBeGreaterThanOrEqual(1);
    const total = t.summary.cumulativeCostCents;
    const r = await decide(maison.id, { lineId: src.lineId, lineKey: src.lineKey, action: 'SAME_FACT' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const apres = r.body.tco;
    expect(apres.summary.cumulativeCostCents).toBe(total);
    expect(ouverts(apres)).not.toContain('PRESUMED_DUPLICATES');
    expect(apres.reliability.warnings).not.toContain('PRESUMED_DUPLICATES');
    expect(diag(apres, 'USER_DECISIONS')).toMatchObject({ status: 'DECIDED' });
    // Les deux justificatifs restent consultables.
    const fichiers = new Set((apres.lines as Json[]).filter((l) => l.amountMinor === ABO).flatMap((l) => [l.fileId, ...(l.sourceFileIds ?? [])]));
    expect(fichiers.has(j.a) && fichiers.has(j.b)).toBe(true);
    // Persistance : décision, ligne liée, traitement automatique remplacé ; journal (qui, quand, geste).
    const [row] = await sql<Json[]>`SELECT decision, related_line_keys, automatic_status, automatic_reason, decided_by FROM asset_cost_line_decisions WHERE asset_id = ${maison.id}`;
    expect(row).toMatchObject({ decision: 'SAME_FACT', automatic_status: 'DUPLICATE', automatic_reason: 'SAME_FACT_OTHER_DOCUMENT', decided_by: compte.ownerUserId });
    expect(row.related_line_keys.length).toBe(1);
    const journal = await sql<Json[]>`SELECT action, user_id FROM asset_cost_line_decision_events WHERE asset_id = ${maison.id} ORDER BY id`;
    expect(journal).toEqual([{ action: 'SAME_FACT', user_id: compte.ownerUserId }]);
    // Réversible : « Annuler mon choix » rouvre le point (journalisé), puis le choix est refait.
    const decidee = ligne(apres, (l) => l.userDecision?.decision === 'SAME_FACT')!;
    expect(decidee.actions.options.map((o: Json) => o.action)).toEqual(['REVERT']);
    const rev = await decide(maison.id, { lineId: decidee.id, lineKey: decidee.decisionKey, action: 'REVERT' });
    expect(rev.body.outcome).toBe('REVERTED');
    expect(ouverts(rev.body.tco)).toContain('PRESUMED_DUPLICATES');
    expect((await sql`SELECT 1 FROM asset_cost_line_decisions WHERE asset_id = ${maison.id}`).length).toBe(0);
    const src2 = diag(rev.body.tco, 'PRESUMED_DUPLICATES').sources[0];
    expect((await decide(maison.id, { lineId: src2.lineId, lineKey: src2.lineKey, action: 'SAME_FACT' })).status).toBe(200);
    expect((await sql<Json[]>`SELECT action FROM asset_cost_line_decision_events WHERE asset_id = ${maison.id} ORDER BY id`).map((e) => e.action)).toEqual(['SAME_FACT', 'REVERT', 'SAME_FACT']);
    // Reconsolidation T3 (relance, réunion des justificatifs) : le choix survit, le point reste clos, la dépense compte UNE fois.
    await k.passer(compte);
    const t3 = (await getTco(maison.id)).body.tco;
    expect(ouverts(t3)).not.toContain('PRESUMED_DUPLICATES');
    expect(t3.summary.cumulativeCostCents).toBe(total);
    expect((t3.lines as Json[]).filter((l) => l.amountMinor === ABO).reduce((n, l) => n + l.includedCents, 0)).toBe(ABO);
    expect(ligne(t3, (l) => l.userDecision?.decision === 'SAME_FACT')).toBeDefined();
    expect(ouverts(t3)).not.toContain('USER_DECISION_TO_RECONFIRM');
  });

  it('L111V-E05 — exclusion confirmée : montant inchangé, point clos, persistante après recalcul et T3 ; contrôle COH-TCO-EXTRACTED-EXPENSES conforme', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await maisonDe(compte);
    const f = await avisTaxe(compte, maison);
    as(compte);
    const t = (await getTco(maison.id)).body.tco;
    const l = ligne(t, (x) => x.fileId === f)!;
    const [{ getCheck }, { pgClient }] = await Promise.all([import('@/services/coherence/registry'), import('@/db')]);
    const check = getCheck('COH-TCO-EXTRACTED-EXPENSES')!;
    const ctx = { sql: pgClient, now: new Date(), today: '2026-11-05', mode: 'CORRECTIVE' as const, correlationId: 'e2e:l111v' };
    const avant = (await check.inspect!(ctx as never, compte.id, [maison.id])).get(maison.id)!;
    expect(avant).toMatchObject({ verdict: 'FINDING', anomaly: 'EXTRACTED_EXPENSE_NOT_EVALUATED', detail: expect.objectContaining({ resolution: 'USER_DECISION', t1Relaunch: false }) });
    const r = await decide(maison.id, { lineId: l.id, lineKey: l.decisionKey, action: 'CONFIRM_EXCLUSION' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.tco.summary.cumulativeCostCents).toBe(t.summary.cumulativeCostCents);
    expect(ouverts(r.body.tco)).toEqual([]);
    expect(r.body.tco.decidedLinesTotal).toBe(1);
    // Recalcul + T3 : le choix reste visible et appliqué ; aucune réouverture.
    await k.passer(compte);
    const apres = (await getTco(maison.id)).body.tco;
    expect(ouverts(apres)).toEqual([]);
    expect(ligne(apres, (x) => x.fileId === f)!.userDecision).toMatchObject({ decision: 'CONFIRM_EXCLUSION', applied: true });
    expect(apres.summary.cumulativeCostCents).toBe(t.summary.cumulativeCostCents);
    // Contrôle permanent : issue explicable (décision de l'utilisateur), aucune écriture, aucune IA.
    expect((await check.inspect!(ctx as never, compte.id, [maison.id])).get(maison.id)).toMatchObject({ verdict: 'CONSISTENT' });
  });

  it('L111V-E06 — faux doublon → « dépenses distinctes » : inclusion exacte du second coût, compteur à jour, aucune source dupliquée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await maisonDe(compte);
    await abonnement(compte, maison, { periodes: false });
    as(compte);
    const t = (await getTco(maison.id)).body.tco;
    const src = diag(t, 'PRESUMED_DUPLICATES').sources[0];
    const avant = t.diagnostics.open.decisions;
    const r = await decide(maison.id, { lineId: src.lineId, lineKey: src.lineKey, action: 'DISTINCT_FACTS' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const apres = r.body.tco;
    expect(apres.summary.cumulativeCostCents).toBe(t.summary.cumulativeCostCents + ABO);
    expect((apres.lines as Json[]).filter((l) => l.amountMinor === ABO && l.includedCents > 0).length).toBe(2);
    expect(apres.reliability.warnings).not.toContain('USER_INCLUDED_DUPLICATES');
    expect(apres.diagnostics.open.decisions).toBe(avant - 1);
    coherent(apres);
  });

  it('L111V-E07 — états de récupération réels : sans état, en file, RUNNING, reprise prévue, échec technique épuisé, introuvable', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await maisonDe(compte);
    const f = await k.document(compte, maison.id, [], { type: 'MAINTENANCE_INVOICE', title: 'Facture chaudière', amountCents: null, date: '2026-06-01' });
    as(compte);
    const etat = async () => ((await getTco(maison.id)).body.tco.amountRecovery?.items as Json[] | undefined)?.find((i) => i.fileId === f);
    expect(await etat()).toMatchObject({ state: 'WAITING' });
    const [job] = await sql<{ id: number }[]>`
      INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status)
      VALUES ('T1', ${compte.id}, 'asset_file', ${String(f)}, ${`e2e-l111v-${f}`}, 'PENDING') RETURNING id`;
    expect(await etat()).toMatchObject({ state: 'QUEUED' });
    await sql`UPDATE ai_job_queue SET status = 'RUNNING', started_at = now() WHERE id = ${job.id}`;
    const lecture = (await getTco(maison.id)).body.tco;
    expect(diag(lecture, 'AMOUNTS_RECOVERY_PENDING')).toMatchObject({ status: 'IN_PROGRESS', sources: [expect.objectContaining({ detail: 'Lecture du montant en cours' })] });
    await sql`UPDATE ai_job_queue SET status = 'FAILED', finished_at = now() WHERE id = ${job.id}`;
    await sql`INSERT INTO document_amount_recoveries (account_id, file_id, status, technical_failures, last_requested_at) VALUES (${compte.id}, ${f}, 'TECHNICAL_FAILURE', 1, now())`;
    const reprise = await etat();
    expect(reprise).toMatchObject({ state: 'RETRY_SCHEDULED' });
    expect(new Date(reprise!.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    await sql`UPDATE document_amount_recoveries SET technical_failures = 3 WHERE file_id = ${f}`;
    const epuise = (await getTco(maison.id)).body.tco;
    expect(ouverts(epuise)).toContain('AMOUNTS_UNKNOWN');
    expect(diag(epuise, 'AMOUNTS_UNKNOWN').sources[0]).toMatchObject({ fileId: f, detail: 'Lecture automatique indisponible' });
    expect(diag(epuise, 'AMOUNTS_UNKNOWN').sources[0].actions.map((o: Json) => o.action)).toEqual(['EDIT_DOCUMENT', 'CONFIRM_EXCLUSION']);
    await sql`UPDATE document_amount_recoveries SET status = 'NOT_FOUND' WHERE file_id = ${f}`;
    expect(await etat()).toMatchObject({ state: 'NOT_FOUND' });
    // Aucune lecture déclenchée par la consultation.
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_job_queue WHERE target_id = ${String(f)} AND id <> ${job.id}`;
    expect(n).toBe(0);
  });

  it('L111V-E08 — droits : membre Premium Duo et essai autorisés ; Standard 403 et lecture seule refusée, aucune écriture', async () => {
    const duo = await make.account({ plan: 'premium_duo' });
    const maison = await maisonDe(duo);
    const f = await avisTaxe(duo, maison);
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${duo.id}, ${membre.id}, 'member', 'active') ON CONFLICT DO NOTHING`;
    as(duo, membre.id);
    const l = ligne((await getTco(maison.id)).body.tco, (x) => x.fileId === f)!;
    expect((await decide(maison.id, { lineId: l.id, lineKey: l.decisionKey, action: 'CONFIRM_EXCLUSION' })).status).toBe(200);
    await sql`UPDATE account_subscriptions SET plan_code = 'standard' WHERE account_id = ${duo.id}`;
    const bloque = await decide(maison.id, { lineId: l.id, lineKey: l.decisionKey, action: 'REVERT' });
    expect(bloque.status).toBe(403);
    expect((await sql`SELECT 1 FROM asset_cost_line_decisions WHERE asset_id = ${maison.id}`).length).toBe(1);
    // Essai (Premium en cours d'essai) : autorisé ; lecture seule (essai échu) : refusé, aucune écriture.
    const owner = await make.user();
    const essai = await make.account({ owner, plan: null });
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_consumed, trial_started_at, trial_ends_at)
              VALUES (${essai.id}, 'premium', 'trialing', true, now() - interval '2 days', now() + interval '5 days')`;
    const m2 = await maisonDe(essai);
    const f2 = await avisTaxe(essai, m2);
    as(essai);
    const l2 = ligne((await getTco(m2.id)).body.tco, (x) => x.fileId === f2)!;
    expect((await decide(m2.id, { lineId: l2.id, lineKey: l2.decisionKey, action: 'CONFIRM_EXCLUSION' })).status).toBe(200);
    await sql`UPDATE account_subscriptions SET status = 'readonly', trial_ends_at = now() - interval '1 day' WHERE account_id = ${essai.id}`;
    const ro = await decide(m2.id, { lineId: l2.id, lineKey: l2.decisionKey, action: 'REVERT' });
    expect([403, 423]).toContain(ro.status);
    expect((await sql`SELECT 1 FROM asset_cost_line_decisions WHERE asset_id = ${m2.id}`).length).toBe(1);
  });
});
