/**
 * Lot 108B — ticket TCO-646 §B : un montant financier manquant déclenche
 * D'ABORD une récupération automatique ; l'alerte « Des justificatifs de
 * dépense n’ont pas de montant lisible… » n'apparaît qu'après un échec réel.
 *
 * Chemins de PRODUCTION sur PostgreSQL 16 réel : contrôle de cohérence
 * `COH-TCO-AMOUNT-RECOVERY` par le moteur réel (`controlObjects`, mode
 * correctif), file T1 réelle (`ai_job_queue`), service TCO réel
 * (`readAssetTco`), route HTTP réelle de la fiche, Supervision réelle
 * (`computeCoherenceAlerts`). Aucun appel IA : l'issue d'une relance T1 est
 * simulée par ce que T1 écrit (montant du document, état d'analyse, job clos).
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, RECETTE_TODAY } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 }));
const CHECK = 'COH-TCO-AMOUNT-RECOVERY';

scenario('L108B', 'TCO — montants inconnus récupérés automatiquement avant toute alerte', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;

  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }) as never);
    ({ NextRequest } = await import('next/server'));
  });

  const tco = async (c: AccountRow, assetId: number) => (await import('@/services/business-operations/tco/service')).readAssetTco(c.id, assetId, { today: RECETTE_TODAY });
  const getTco = async (c: AccountRow, assetId: number) => {
    session.currentAccountId = c.id; session.userId = c.ownerUserId;
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  /** Un passage du contrôle sur les objets du compte (moteur réel, mode correctif). */
  const controler = async (c: AccountRow, ids?: number[]) => {
    const [{ controlObjects }, { getCheck }, { pgClient }] = await Promise.all([import('@/services/coherence/engine'), import('@/services/coherence/registry'), import('@/db')]);
    const check = getCheck(CHECK)!;
    const ctx = { sql: pgClient, now: new Date(), today: RECETTE_TODAY, mode: 'CORRECTIVE' as const, correlationId: 'e2e:l108b' };
    const objets = ids ?? await check.listObjects!(ctx, c.id, 0, 100);
    return controlObjects({ ctx, check, accountId: c.id, ids: objets, trigger: 'MANUAL', campaignId: null, stillEligible: async () => ({ eligible: true, reason: '' }) });
  };
  const etat = async (fileId: number) => (await sql<Array<Record<string, any>>>`
    SELECT status, amount_cents::int AS amount_cents, amount_role, source_kind, source_ref, proposals, fingerprint_attempts, total_attempts,
           technical_failures, last_error_code FROM document_amount_recoveries WHERE file_id = ${fileId}`)[0] ?? null;
  const preuve = async (c: AccountRow, fileId: number) => (await sql<Array<{ last_result: string; finding: Record<string, any> | null }>>`
    SELECT last_result, finding FROM coherence_object_proofs WHERE account_id = ${c.id} AND check_id = ${CHECK} AND object_id = ${fileId}`)[0] ?? null;
  const jobsT1 = (fileId: number) => sql<Array<{ id: number; status: string; payload: Record<string, any> }>>`
    SELECT id::int AS id, status, payload FROM ai_job_queue WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(fileId)} ORDER BY id`;
  /** Ce qu'écrit une relance T1 aboutie (ou en échec) : job clos, état d'analyse, montant du document. */
  const finT1 = async (fileId: number, o: { amountCents?: number | null; failed?: boolean }) => {
    await sql`UPDATE ai_job_queue SET status = 'DONE' WHERE treatment = 'T1' AND target_id = ${String(fileId)} AND status IN ('PENDING', 'RUNNING')`;
    await sql`UPDATE asset_files SET analysis_state = ${o.failed ? 'ANALYSIS_FAILED' : 'ANALYZED'}, amount_cents = ${o.amountCents ?? null} WHERE id = ${fileId}`;
  };
  const cartes = async (c: AccountRow) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${c.id}`)[0].n;
  const velo = (c: AccountRow): Promise<AssetRow> => make.asset(c, { category: 'OBJET', name: 'Vélo', purchasePriceCents: 30_000, keyCharacteristics: { acquisitionDate: '2026-01-10' } });
  const sansMontant = (c: AccountRow, a: AssetRow, titre = 'Révision (illisible)') => k.document(c, a.id, [], { type: 'MAINTENANCE_INVOICE', title: titre, amountCents: null, date: '2026-06-01' });
  const extraction = (c: AccountRow, fileId: number, cents: number | null, fullText: string | null = null) =>
    sql`INSERT INTO document_extractions (account_id, file_id, amount_cents, full_text) VALUES (${c.id}, ${fileId}, ${cents}, ${fullText})
        ON CONFLICT (file_id) DO UPDATE SET amount_cents = EXCLUDED.amount_cents, full_text = EXCLUDED.full_text`;

  it('L108B-E2E-01 — montant présent dans l’extraction T1 persistée : « en cours » puis récupéré sans IA, compté UNE fois, alerte jamais affichée', async () => {
    const c = await make.account({ plan: 'premium' });
    const v = await velo(c);
    const f = await sansMontant(c, v);
    await extraction(c, f, 12_000);

    // Avant tout contrôle : aucune alerte « montant illisible », état neutre, TCO honnêtement incomplet (jamais 0 €).
    const avant = await tco(c, v.id);
    expect(avant.reliability.warnings).not.toContain('AMOUNTS_UNKNOWN');
    expect(avant.reliability.warnings).toContain('AMOUNTS_RECOVERY_PENDING');
    expect(avant.amountRecovery).toMatchObject({ inProgress: 1, items: [{ fileId: f, state: 'IN_PROGRESS' }] });
    expect(avant.status).toBe('INCOMPLETE');
    expect(avant.summary.cumulativeCostCents).toBe(30_000);
    const route = await getTco(c, v.id);
    expect(route.status).toBe(200);
    expect(route.body.tco.warningLabels.join(' ')).not.toMatch(/montant lisible|Lecture automatique/);
    expect(route.body.tco.amountRecovery.items).toEqual([{ fileId: f, title: 'Révision (illisible)', state: 'IN_PROGRESS' }]);
    // La consultation n'écrit rien et ne relance rien.
    expect(await etat(f)).toBeNull();
    expect(await jobsT1(f)).toHaveLength(0);

    const r = await controler(c);
    expect(r.results.REPAIRED).toBe(1);
    expect((await sql<{ amount_cents: number }[]>`SELECT amount_cents FROM asset_files WHERE id = ${f}`)[0].amount_cents).toBe(12_000);
    expect(await etat(f)).toMatchObject({ status: 'RECOVERED', amount_cents: 12_000, source_kind: 'T1_EXTRACTION', amount_role: 'DOCUMENT_TOTAL' });
    expect(await jobsT1(f)).toHaveLength(0);
    const apres = await tco(c, v.id);
    expect(apres.summary.cumulativeCostCents).toBe(42_000);
    expect(apres.reliability.warnings).not.toContain('AMOUNTS_UNKNOWN');
    expect(apres.reliability.warnings).not.toContain('AMOUNTS_RECOVERY_PENDING');
    expect(apres.amountRecovery).toBeUndefined();

    // Idempotent : un second passage ne change rien (aucun doublon de coût, aucune écriture).
    await controler(c, [f]);
    expect((await tco(c, v.id)).summary.cumulativeCostCents).toBe(42_000);
    expect((await preuve(c, f))?.last_result).toBe('CONSISTENT');
  });

  it('L108B-E2E-02 — rien de persisté : relance T1 sur l’original par la file existante (technique, non facturée), une seule ; montant relu → provenance T1, recalcul sans doublon', async () => {
    const c = await make.account({ plan: 'premium' });
    const v = await velo(c);
    const f = await sansMontant(c, v);

    await controler(c);
    const jobs = await jobsT1(f);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({ fileId: f, origin: 'tco-amount-recovery', processingVisibility: 'TECHNICAL', billable: false });
    expect(await etat(f)).toMatchObject({ status: 'T1_PENDING', total_attempts: 1, fingerprint_attempts: 1 });
    expect((await preuve(c, f))?.last_result).toBe('REPAIR_PENDING');
    // Toujours « en cours » côté fiche, jamais l'alerte.
    expect((await tco(c, v.id)).reliability.warnings).not.toContain('AMOUNTS_UNKNOWN');

    // Anti-boucle : la relance en cours n'est jamais doublée.
    await controler(c, [f]);
    expect(await jobsT1(f)).toHaveLength(1);
    expect((await etat(f)).total_attempts).toBe(1);

    // T1 relit le montant (même chemin qu'une analyse : montant du document écrit).
    await finT1(f, { amountCents: 8_900 });
    await controler(c, [f]);
    expect(await etat(f)).toMatchObject({ status: 'RECOVERED', source_kind: 'T1_RELAUNCH', amount_cents: 8_900 });
    const t = await tco(c, v.id);
    expect(t.summary.cumulativeCostCents).toBe(38_900);
    expect(t.amountRecovery).toBeUndefined();
    expect(await jobsT1(f)).toHaveLength(1);
  });

  it('L108B-E2E-03 — après relance sans résultat : « Montant introuvable », document lié, alerte levée seulement maintenant, aucune carte « À traiter »', async () => {
    const c = await make.account({ plan: 'premium' });
    const v = await velo(c);
    const f = await sansMontant(c, v, 'Facture garage');
    await controler(c);
    await finT1(f, { amountCents: null });
    await controler(c, [f]);
    expect(await etat(f)).toMatchObject({ status: 'NOT_FOUND', last_error_code: 'NO_AMOUNT_AFTER_T1' });
    expect((await preuve(c, f))?.finding).toMatchObject({ anomaly: 'AMOUNT_NOT_FOUND' });
    const t = await tco(c, v.id);
    expect(t.reliability.warnings).toContain('AMOUNTS_UNKNOWN');
    expect(t.status).toBe('INCOMPLETE');
    expect(t.summary.cumulativeCostCents).toBe(30_000);
    const route = await getTco(c, v.id);
    expect(route.body.tco.amountRecovery).toMatchObject({ notFound: 1, items: [{ fileId: f, title: 'Facture garage', state: 'NOT_FOUND' }] });
    expect(route.body.tco.warningLabels.join(' ')).toMatch(/même après une nouvelle lecture automatique/);
    expect(await cartes(c)).toBe(0);
    // Plus de relance sur la même empreinte (limite de tentatives).
    await controler(c, [f]);
    expect(await jobsT1(f)).toHaveLength(1);
  });

  it('L108B-E2E-04 — échec TECHNIQUE de la relance : Supervision BO immédiate, état neutre pour l’utilisateur, aucune carte « À traiter »', async () => {
    const c = await make.account({ plan: 'premium' });
    const v = await velo(c);
    const f = await sansMontant(c, v);
    await controler(c);
    await finT1(f, { failed: true });
    await controler(c, [f]);
    expect(await etat(f)).toMatchObject({ status: 'TECHNICAL_FAILURE', technical_failures: 1 });
    // Rejoué : le compteur ne bouge pas (transition comptée une seule fois), aucune relance avant le délai.
    await controler(c, [f]);
    expect(await etat(f)).toMatchObject({ status: 'TECHNICAL_FAILURE', technical_failures: 1 });
    expect(await jobsT1(f)).toHaveLength(1);
    expect((await preuve(c, f))?.finding).toMatchObject({ anomaly: 'AMOUNT_RECOVERY_TECHNICAL_FAILURE' });
    const { computeCoherenceAlerts } = await import('@/services/coherence/supervision');
    const { pgClient } = await import('@/db');
    const alertes = await computeCoherenceAlerts(new Date(), pgClient);
    expect(alertes.some((a) => a.fingerprint.includes(CHECK.toLowerCase()) && a.fingerprint.includes('amount_recovery_technical_failure'))).toBe(true);
    const t = await tco(c, v.id);
    expect(t.amountRecovery?.items[0]).toMatchObject({ fileId: f, state: 'IN_PROGRESS' });
    expect(t.reliability.warnings).not.toContain('AMOUNTS_UNKNOWN');
    expect(await cartes(c)).toBe(0);
  });

  it('L108B-E2E-05 — jamais inventé ni écrasé : contradictions → à confirmer ; montant retiré par l’utilisateur respecté ; Standard : aucune relance IA ; composante qui ne cite que le document', async () => {
    const c = await make.account({ plan: 'premium' });
    const v = await velo(c);
    // Contradiction : l'extraction dit 120 €, le total lu et recoupé dit 99 € → aucune écriture, relance, puis « à confirmer ».
    const f1 = await sansMontant(c, v, 'Facture contradictoire');
    await extraction(c, f1, 12_000, 'Entretien\nTotal HT 82,50\nTVA 16,50\nTotal TTC 99,00');
    await controler(c, [f1]);
    expect((await sql<{ amount_cents: number | null }[]>`SELECT amount_cents FROM asset_files WHERE id = ${f1}`)[0].amount_cents).toBeNull();
    expect(await etat(f1)).toMatchObject({ status: 'T1_PENDING' });
    await finT1(f1, { amountCents: null });
    await controler(c, [f1]);
    const e1 = await etat(f1);
    expect(e1).toMatchObject({ status: 'TO_CONFIRM', last_error_code: 'AMOUNTS_CONTRADICTORY' });
    expect((e1.proposals as Array<{ cents: number }>).map((p) => p.cents).sort((a, b) => a - b)).toEqual([9_900, 12_000]);
    expect((await tco(c, v.id)).amountRecovery?.items.find((i) => i.fileId === f1)?.state).toBe('TO_CONFIRM');

    // Montant retiré par l'utilisateur : jamais remplacé, même si l'extraction en porte un.
    const f2 = await sansMontant(c, v, 'Ticket effacé');
    await extraction(c, f2, 5_000);
    await sql`UPDATE asset_files SET user_edited_fields = '{"amountCents": true}'::jsonb WHERE id = ${f2}`;
    await controler(c, [f2]);
    expect((await sql<{ amount_cents: number | null }[]>`SELECT amount_cents FROM asset_files WHERE id = ${f2}`)[0].amount_cents).toBeNull();
    expect(await etat(f2)).toMatchObject({ status: 'USER_OWNED' });
    expect(await jobsT1(f2)).toHaveLength(0);

    // Composante d'un événement de référence qui ne cite que ce justificatif : montant consolidé repris, compté une fois.
    const f3 = await k.document(c, v.id, [cand({ summary: 'Pneu', provider: 'Atelier', targetHints: [cible(v.id)], temporalHints: { realizedDate: '2026-06-01' }, financialHints: [fh('REALIZED_COST', 6_500)] })],
      { type: 'REPAIR_INVOICE', title: 'Pneu', amountCents: 6_500, date: '2026-06-01' });
    await k.passer(c);
    const avantPneu = (await tco(c, v.id)).summary.cumulativeCostCents;
    // Le montant du document disparaît (relecture partielle) et l'indice T1 aussi : seule la composante le porte encore.
    await sql`UPDATE asset_files SET amount_cents = NULL WHERE id = ${f3}`;
    await sql`UPDATE document_operation_candidates SET payload = payload - 'financialHints' WHERE file_id = ${f3}`;
    const pendant = await tco(c, v.id);
    expect(pendant.summary.cumulativeCostCents).toBe(avantPneu);
    await controler(c, [f3]);
    expect((await tco(c, v.id)).summary.cumulativeCostCents).toBe(avantPneu);

    // Compte Standard : aucune relance IA (le TCO n'y est pas visible), constat sans coût.
    const s = await make.account({ plan: 'standard' });
    const vs = await velo(s);
    const fs = await sansMontant(s, vs);
    await controler(s, [fs]);
    expect(await jobsT1(fs)).toHaveLength(0);
    expect(await etat(fs)).toMatchObject({ status: 'NOT_FOUND', last_error_code: 'NO_AMOUNT_T1_NOT_ALLOWED' });
  });
});
