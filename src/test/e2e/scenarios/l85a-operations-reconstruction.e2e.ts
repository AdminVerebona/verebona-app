/**
 * Lot 85A — CDC « Opérations, Agenda, Timeline, Sinistres v5 », lots O-2
 * (purge et reconstruction en préproduction, §20, AC41–AC43, E20) et O-9
 * (TCO sur le nouveau modèle, §19, AC40, AC51, E19, E30), sur PostgreSQL 16
 * réel. Jeu `operations-v1` (7 comptes réalistes, persistance T1 réelle,
 * consolidation T3 réelle), projection Agenda réelle, service de
 * regroupement réel, TCO réel, moteur des rattrapages réel. Modèle IA SIMULÉ
 * (aucun réseau) ; point de restauration simulé (stockage absent du harnais).
 *
 *   L85A-E01  Simuler : inventaire exact (purgées / conservées et motifs),
 *             AUCUNE écriture (empreinte complète du compte inchangée) ;
 *   L85A-E02  Appliquer REFUSÉ sans point de restauration < 24 h : rien
 *             d'écrit, refus journalisé ;
 *   L85A-E03  AC41 / AC42 — reconstruction du compte « Premium » avec saisies
 *             de l'utilisateur (élément saisi, élément modifié + date choisie,
 *             lien manuel, décision TCO, décision de regroupement) toutes
 *             CONSERVÉES ; regroupements dérivés purgés puis reconstruits ;
 *             aucun appel T1 ; travaux T3 du compte retenus puis relâchés ;
 *             campagne de cohérence demandée sur le compte ;
 *   L85A-E04  idempotence : second passage = AUCUNE écriture (UP_TO_DATE) ;
 *   L85A-E05  restauration EXACTE (toutes les tables du compte) ;
 *   L85A-E06  restauration refusée pour un compte modifié depuis (rien écrit) ;
 *   L85A-E07  AC43 — deux reconstructions successives : même résultat
 *             métier (signature sans identifiant) et même TCO ;
 *   L85A-E08  C-Q10 — compte non éligible exclu : rien d'écrit ;
 *   L85A-E09  M3 borné par ses plafonds et mesuré ; décision REJECTED
 *             conservée et respectée ;
 *   L85A-E10  AC40 / E19 / O-9 — TCO identique avant / après reconstruction
 *             sur tout le jeu ; une Opération invalidée n'est plus une source
 *             de coût ; décision TCO à clé `o:` re-clée `s:` et toujours
 *             appliquée (aucune décision perdue) ;
 *   L85A-E11  AC51 / E30 — factures récurrentes regroupées : chacune comptée
 *             exactement une fois, avant et après reconstruction ;
 *   L85A-E12  moteur des rattrapages : Simuler / refus / Appliquer / Restaurer
 *             par le BO (journal d'administration, rapport lisible).
 *
 * Assertions bornées aux comptes créés ici.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import { setDefaultResponder } from '../replay-gateway';
import type { AccountRow } from '../factories';
import type { ProviderCallInput } from '@/services/ai/gateway/providers/provider.port';
import {
  RECETTE_TODAY, buildRecetteDatasets, cand, cible, fh, operationsKit, ref, type OperationsKit, type RecetteDatasets,
} from '../datasets/operations-v1';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;

// ── Modèle simulé (OPERATION_MATCH), compté ─────────────────────────────────
const m3 = { calls: 0 };
function modele(input: ProviderCallInput): unknown {
  void input;
  m3.calls++;
  return { task: 'OPERATION_MATCH', decision: 'AMBIGUOUS', matchedCandidateId: null, confidence: 'probable', reason: 'éléments insuffisants', concordantSignals: ['même prestataire'], contradictions: [] };
}

/** Tables techniques (journaux, IA, file, cohérence) : hors de l'état métier comparé. */
const TECHNIQUES = /^(ai_|coherence_|operations_rebuild_|ops_backfill|admin_|business_operation_targeted_runs$|agenda_intervention_reprise_runs$|claim_legacy_cleanup|scheduled_task|job_locks|t3_enqueue|user_session|auth_|idempotency)/;

scenario('L85A', 'Opérations v5 O-2 / O-9 : purge et reconstruction (préproduction), TCO', ({ sql, make, replay }) => {
  useTargetState();
  let k: OperationsKit;
  let d: RecetteDatasets;
  let svc: typeof import('@/services/business-operations/rebuild/service');
  const point = async () => [{ backupId: 'bk-e2e-l85a', version: 2, finishedAt: new Date(Date.now() - 3_600_000).toISOString(), restorable: true }];
  const coherence: Array<{ ids: number[]; runId: string }> = [];
  const demanderCoherence = async (ids: number[], runId: string) => { coherence.push({ ids, runId }); return 4242; };
  const appliquer = (accountId: number, over: Partial<Parameters<typeof svc.runOperationsRebuild>[0]> = {}) => svc.runOperationsRebuild({
    sql, mode: 'APPLY', accountId, today: RECETTE_TODAY, restorePoints: point, requestCoherence: demanderCoherence, reason: 'recette e2e L85A', ...over,
  });

  /** Empreinte COMPLÈTE d'un compte : toutes les tables métier portant le compte + tables filles du périmètre. */
  async function empreinte(accountId: number): Promise<Record<string, string>> {
    const tables = await sql<{ t: string }[]>`
      SELECT DISTINCT c.table_name AS t FROM information_schema.columns c
        JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
       WHERE c.table_schema = current_schema() AND c.column_name = 'account_id' ORDER BY 1`;
    const out: Record<string, string> = {};
    const lire = async (t: string, where: string) => {
      const [r] = await sql.unsafe<Array<{ n: number; h: string }>>(
        `SELECT count(*)::int AS n, md5(COALESCE(string_agg(md5(to_jsonb(x)::text), ',' ORDER BY to_jsonb(x)::text), '')) AS h FROM "${t}" x WHERE ${where}`, [accountId] as never[]);
      out[t] = `${r.n}:${r.h}`;
    };
    for (const { t } of tables) if (!TECHNIQUES.test(t)) await lire(t, 'x.account_id = $1');
    const { REBUILD_SCOPE } = await import('@/services/business-operations/rebuild/model');
    for (const s of REBUILD_SCOPE) {
      if (out[s.table] !== undefined) continue;
      const [e] = await sql<{ ok: boolean }[]>`SELECT to_regclass(${s.table}) IS NOT NULL AS ok`;
      if (e.ok) await lire(s.table, s.filter.replace(/\bt\./g, 'x.'));
    }
    return out;
  }
  const ecarts = (a: Record<string, string>, b: Record<string, string>) => Object.keys({ ...a, ...b }).filter((t) => a[t] !== b[t]).sort();

  const tcoDe = async (accountId: number) => (await import('@/services/business-operations/rebuild/reconstruct')).readAccountTco(accountId, RECETTE_TODAY);
  const projeter = async (c: AccountRow) => (await import('@/services/business-operations/agenda-projection/service')).projectAccountOperations(c.id, { all: true, today: RECETTE_TODAY });
  const signature = async (c: AccountRow) => svc.businessSignatureHash(sql, c.id);

  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    await import('@/services/ai/reconciliation');
    setDefaultResponder('t3_operation_match', 'OPERATION_MATCH', modele);
    k = operationsKit(sql, make);
    svc = await import('@/services/business-operations/rebuild/service');
    d = await buildRecetteDatasets(sql, make, k);
    for (const c of Object.values(d)) await projeter(c.compte);
  }, 600_000);
  afterAll(() => { setDefaultResponder('t3_operation_match', 'OPERATION_MATCH', null); });

  it('L85A-E01 — Simuler : inventaire exact, motifs de conservation, AUCUNE écriture', async () => {
    const c = d.premium.compte;
    const avant = await empreinte(c.id);
    const r = await svc.runOperationsRebuild({ sql, mode: 'SIMULATE', accountId: c.id, today: RECETTE_TODAY });
    expect(r.status).toBe('succeeded');
    const a = r.accounts.find((x) => x.accountId === c.id)!;
    expect(a.status).toBe('PLANNED');
    expect(a.plan!.purged.length).toBeGreaterThan(0);
    // Le sinistre saisi avec l'ancien formulaire (source CLAIM_FORM) est conservé, avec son motif.
    expect(a.plan!.kept.find((x) => x.id === d.premium.sinistre)?.reasons).toContain('USER_SOURCE');
    expect(a.plan!.purged).not.toContain(d.premium.sinistre);
    expect(a.plan!.candidatesRequeued).toBeGreaterThan(0);
    expect(ecarts(avant, await empreinte(c.id))).toEqual([]);
    const [run] = await sql`SELECT mode, status FROM operations_rebuild_runs WHERE id = ${r.runId}`;
    expect(run).toMatchObject({ mode: 'SIMULATE', status: 'succeeded' });
  });

  it('L85A-E02 — Appliquer refusé sans point de restauration de moins de 24 h : rien n’est écrit', async () => {
    const c = d.premium.compte;
    const avant = await empreinte(c.id);
    const vieux = async () => [{ backupId: 'bk-vieux', version: 2, finishedAt: new Date(Date.now() - 30 * 3_600_000).toISOString(), restorable: true }];
    for (const restorePoints of [async () => [], vieux]) {
      const r = await appliquer(c.id, { restorePoints });
      expect(r.status).toBe('refused');
      expect(r.refusal).toMatch(/point de restauration/i);
      const [run] = await sql`SELECT mode, status FROM operations_rebuild_runs WHERE id = ${r.runId}`;
      expect(run).toMatchObject({ mode: 'REFUSED', status: 'refused' });
    }
    expect(ecarts(avant, await empreinte(c.id))).toEqual([]);
  });

  let runPremium = '';
  let avantPremium: Record<string, string> = {};
  const saisies: Json = {};

  it('L85A-E03 — AC41 / AC42 : reconstruction d’un compte réaliste, saisies de l’utilisateur conservées, aucun appel T1', async () => {
    const c = d.premium.compte;
    const g = await import('@/services/business-operations/grouping/service');
    // Saisies de l'utilisateur.
    const manuel = await make.agendaItem(c, { title: 'Ramonage prévu (saisi)', startDate: '2026-11-03', assetIds: [d.premium.maison.id] });
    const projections = await sql<{ id: number; business_operation_id: number }[]>`
      SELECT id, business_operation_id::int AS business_operation_id FROM agenda_items
       WHERE account_id = ${c.id} AND projection_origin = 'OPERATION' AND is_automatic AND NOT is_automatic_modified ORDER BY id`;
    expect(projections.length).toBeGreaterThanOrEqual(3);
    const modifie = projections[0];
    await sql`UPDATE agenda_items SET title = 'Intervention chaudière (titre corrigé)', start_date = '2026-03-13', date_source = 'USER', is_automatic_modified = true WHERE id = ${modifie.id}`;
    const lie = projections[1];
    await g.withGroupingWrite(c.id, (ctx) => g.linkDocumentToAgendaItem(ctx, { itemId: lie.id, fileId: d.premium.dpeFacture }), { actorUserId: c.owner.id });
    // Événement de référence désigné par l'utilisateur (mémoire unifiée 84B) : son regroupement est conservé.
    const designe = projections[2];
    await g.withGroupingWrite(c.id, (ctx) => g.designatePrincipal(ctx, { operationId: designe.business_operation_id, itemId: designe.id, origin: 'USER', reasonCode: 'E2E_L85A_USER_PRINCIPAL' }), { actorUserId: c.owner.id });
    const { decideTcoLine } = await import('@/services/business-operations/tco/user-decisions.service');
    const tco = await (await import('@/services/business-operations/tco/service')).readAssetTco(c.id, d.premium.maison.id, { today: RECETTE_TODAY });
    const ligne = tco.lines.find((l) => (l.status === 'RETAINED_CONSOLIDATED' || l.status === 'RETAINED_DIRECT') && l.fileId === d.premium.entretienChaudiere)!;
    expect(ligne).toBeDefined();
    await decideTcoLine(c.id, d.premium.maison.id, c.owner.id, { lineId: ligne.id, action: 'EXCLUDE' }, { today: RECETTE_TODAY });
    // Prix d'achat de la fiche retiré par l'utilisateur : la reconsolidation complète le fait porter par une Opération
    // d'acquisition (donnée structurée) — la décision SUIT le fait (O-9), jamais perdue.
    await decideTcoLine(c.id, d.premium.maison.id, c.owner.id, { lineId: `asset:${d.premium.maison.id}:acquisitionPrice`, action: 'EXCLUDE' }, { today: RECETTE_TODAY });
    // Travail T3 du compte en attente (retenu pendant la reconstruction, relâché ensuite).
    const [job] = await sql<{ id: number }[]>`
      INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, origin, trigger_code, payload, available_at)
      VALUES ('T3', ${c.id}, 'business_operations', ${String(c.id)}, ${`e2e-l85a-${c.id}`}, 'automatic', 'schedule_hourly',
              '{"kind":"business_operations","events":[]}'::jsonb, now() + interval '1 day') RETURNING id`;
    Object.assign(saisies, { manuel: manuel.id, modifie: modifie.id, lie: lie.id, job: job.id });
    const itemAvant = async (id: number) => (await sql`SELECT title, start_date::text AS d, date_source, is_automatic, is_automatic_modified FROM agenda_items WHERE id = ${id}`)[0];
    saisies.etat = { manuel: await itemAvant(manuel.id), modifie: await itemAvant(modifie.id) };
    const tcoAvant = await tcoDe(c.id);
    const appelsAvant = replay.calls.length;
    avantPremium = await empreinte(c.id);
    const sinistreAvant = await sql`SELECT id FROM business_operations WHERE id = ${d.premium.sinistre}`;
    expect(sinistreAvant.length).toBe(1);

    const r = await appliquer(c.id);
    runPremium = r.runId;
    expect(r.status).toBe('succeeded');
    expect(r.restorePoint).toMatchObject({ backupId: 'bk-e2e-l85a' });
    const a = r.accounts.find((x) => x.accountId === c.id)!;
    expect(a.warnings).toEqual(expect.not.arrayContaining([expect.stringMatching(/baisse|T1 sollicitée/)]));
    expect(a.status).toBe('REBUILT');
    // AC41 : des Opérations dérivées ont été supprimées ; AC42 : elles sont reconstruites depuis les sources.
    const restantes = await sql<{ id: number }[]>`SELECT id::int AS id FROM business_operations WHERE account_id = ${c.id} AND id = ANY(${a.plan!.purged}::bigint[])`;
    expect(restantes).toEqual([]);
    expect(a.operations!.after).toBeGreaterThan(0);
    expect(a.operations!.after).toBe(a.operations!.before);
    // Le sinistre saisi et l'Opération reliée par l'utilisateur (lien manuel) sont CONSERVÉS (même identifiant).
    expect((await sql`SELECT 1 FROM business_operations WHERE id = ${d.premium.sinistre}`).length).toBe(1);
    const garde = a.plan!.kept.find((x) => x.id === designe.business_operation_id);
    expect(garde?.reasons).toEqual(expect.arrayContaining(['USER_AGENDA_ROLE', 'USER_DECISION']));
    const [principal] = await sql`SELECT business_operation_id::int AS op, operation_role, operation_role_origin FROM agenda_items WHERE id = ${designe.id}`;
    expect(principal).toMatchObject({ op: designe.business_operation_id, operation_role: 'PRINCIPAL', operation_role_origin: 'USER' });
    // L'élément relié manuellement à un document n'est jamais retiré, même s'il était une projection automatique.
    expect((await sql`SELECT 1 FROM agenda_items WHERE id = ${lie.id}`).length).toBe(1);
    // Saisies de l'utilisateur intactes.
    expect(await itemAvant(manuel.id)).toEqual(saisies.etat.manuel);
    expect(await itemAvant(modifie.id)).toEqual(saisies.etat.modifie);
    const [lien] = await sql`SELECT provenances FROM agenda_file_links WHERE agenda_item_id = ${lie.id} AND asset_file_id = ${d.premium.dpeFacture}`;
    expect(lien.provenances).toContain('MANUAL_DIRECT');
    expect(a.userData!.losses).toEqual([]);
    expect(a.userData!.after).toEqual(a.userData!.before);
    // Chaque document consolidé : candidat traité, rattaché à une Opération active s'il l'était avant.
    const enAttente = await sql`SELECT 1 FROM document_operation_candidates WHERE account_id = ${c.id} AND status = 'ACTIVE' AND t3_pending`;
    expect(enAttente).toEqual([]);
    // TCO identique (seules les Opérations changent) et décision TCO toujours appliquée.
    const tcoApres = await tcoDe(c.id);
    const montants = (t: Awaited<ReturnType<typeof tcoDe>>) => t.assets.map((x) => [x.assetId, x.cumulativeCostCents, x.decisionsApplied, x.orphanDecisions, Object.values(x.retained).sort((p, q) => p - q)]);
    expect(montants(tcoApres)).toEqual(montants(tcoAvant));
    expect(a.tco!.differences).toEqual([]);
    expect(tcoApres.assets.find((x) => x.assetId === d.premium.maison.id)!.decisionsApplied).toBe(2);
    expect(tcoAvant.assets.find((x) => x.assetId === d.premium.maison.id)!.retained[`asset:${d.premium.maison.id}:acquisitionPrice`]).toBeUndefined();
    // Aucune nouvelle analyse T1 (ni appel, ni travail) ; aucun appel IA hors M3.
    expect(replay.calls.slice(appelsAvant).filter((x) => /^(t1_|extract_source)/.test(x.operationCode ?? ''))).toEqual([]);
    expect(a.ai!.t1Calls).toBe(0);
    expect(a.ai!.t1JobsQueued).toBe(0);
    expect(replay.calls.slice(appelsAvant).every((x) => x.operationCode === 't3_operation_match')).toBe(true);
    // Arrêt T3 du compte : travail retenu puis relâché (disponible, marque retirée).
    expect(a.queueHeld).toBeGreaterThanOrEqual(1);
    const [j] = await sql`SELECT available_at <= now() AS dispo, payload ? 'operationsRebuildHold' AS marque FROM ai_job_queue WHERE id = ${job.id}`;
    expect(j).toMatchObject({ dispo: true, marque: false });
    await sql`DELETE FROM ai_job_queue WHERE id = ${job.id}`;
    // Campagne de cohérence demandée sur le compte reconstruit.
    expect(r.coherence).toMatchObject({ requested: true, campaignId: 4242, accounts: [c.id] });
    expect(coherence.at(-1)).toMatchObject({ ids: [c.id], runId: r.runId });
    // Convergence : le dernier passage n'écrit plus rien.
    expect(a.steps!.convergence).toEqual({ consolidationChanges: 0, projectionChanges: 0 });
    // Journal : image avant et rapport par compte.
    const [acc] = await sql`SELECT status, before_hash IS NOT NULL AS b, after_hash IS NOT NULL AS h FROM operations_rebuild_accounts WHERE run_id = ${r.runId} AND account_id = ${c.id}`;
    expect(acc).toMatchObject({ status: 'REBUILT', b: true, h: true });
    const [snap] = await sql`SELECT count(*)::int AS n FROM operations_rebuild_snapshots WHERE run_id = ${r.runId} AND account_id = ${c.id}`;
    expect(snap.n).toBeGreaterThan(20);
  });

  it('L85A-E04 — idempotence : un second passage n’écrit RIEN (compte inchangé depuis la reconstruction)', async () => {
    const c = d.premium.compte;
    const avant = await empreinte(c.id);
    const r = await appliquer(c.id);
    expect(r.accounts.find((x) => x.accountId === c.id)!.status).toBe('UP_TO_DATE');
    expect(ecarts(avant, await empreinte(c.id))).toEqual([]);
  });

  it('L85A-E05 — Restaurer : le compte revient EXACTEMENT à son état d’avant (toutes ses tables)', async () => {
    const c = d.premium.compte;
    const r = await svc.restoreOperationsRebuild(sql, runPremium, { reason: 'recette e2e L85A' });
    expect(r.refused).toEqual([]);
    expect(r.restored.map((x) => x.accountId)).toEqual([c.id]);
    expect(ecarts(avantPremium, await empreinte(c.id))).toEqual([]);
    // Une seconde restauration de la même exécution ne trouve plus rien.
    const r2 = await svc.restoreOperationsRebuild(sql, runPremium);
    expect(r2.restored).toEqual([]);
  });

  it('L85A-E06 — restauration refusée pour un compte modifié depuis la reconstruction : rien n’est écrit', async () => {
    const c = d.standard.compte;
    const r = await appliquer(c.id);
    expect(r.accounts.find((x) => x.accountId === c.id)!.status).toBe('REBUILT');
    await make.agendaItem(c, { title: 'Saisi après la reconstruction', startDate: '2026-12-01' });
    const avant = await empreinte(c.id);
    const x = await svc.restoreOperationsRebuild(sql, r.runId);
    expect(x.restored).toEqual([]);
    expect(x.refused).toMatchObject([{ accountId: c.id, tables: expect.arrayContaining(['agenda_items']) }]);
    expect(ecarts(avant, await empreinte(c.id))).toEqual([]);
  });

  it('L85A-E07 — AC43 : une seconde reconstruction identique ne modifie pas le résultat métier', async () => {
    const c = d.multiBiens.compte;
    const sig0 = await signature(c);
    const tco0 = await tcoDe(c.id);
    const r1 = await appliquer(c.id);
    expect(r1.accounts[0].status).toBe('REBUILT');
    const sig1 = await signature(c);
    const r2 = await appliquer(c.id, { force: true });
    expect(r2.accounts[0].status).toBe('REBUILT');
    expect(r2.accounts[0].plan!.purged.length).toBeGreaterThan(0);
    expect(await signature(c)).toBe(sig1);
    expect(sig1).toBe(sig0);
    expect((await tcoDe(c.id)).assets.map((x) => x.cumulativeCostCents)).toEqual(tco0.assets.map((x) => x.cumulativeCostCents));
  });

  it('L85A-E08 — C-Q10 : compte non éligible (sans abonnement) exclu, rien n’est écrit', async () => {
    const c = await make.account({ plan: null });
    const v = await make.asset(c, { category: 'VEHICULE', name: 'Twingo' });
    await k.document(c, v.id, [cand({ summary: 'Vidange', provider: 'Garage Sud', targetHints: [cible(v.id)], businessReferences: [ref('INVOICE', 'NE-1')], temporalHints: { realizedDate: '2026-03-01' }, financialHints: [fh('REALIZED_COST', 9000)] })], { type: 'MAINTENANCE_INVOICE', title: 'Vidange', amountCents: 9000 });
    await k.passer(c);
    expect((await k.actives(c)).length).toBe(1);
    const avant = await empreinte(c.id);
    for (const mode of ['SIMULATE', 'APPLY'] as const) {
      const r = mode === 'APPLY' ? await appliquer(c.id) : await svc.runOperationsRebuild({ sql, mode, accountId: c.id, today: RECETTE_TODAY });
      expect(r.accounts).toEqual([]);
      expect(r.excluded).toMatchObject([{ accountId: c.id, reason: 'NO_SUBSCRIPTION' }]);
    }
    expect(ecarts(avant, await empreinte(c.id))).toEqual([]);
  });

  it('L85A-E09 — M3 borné par ses plafonds et mesuré ; la décision « autre intervention » de l’utilisateur est respectée', async () => {
    const c = d.ambiguites.compte;
    const rejet = await sql<{ id: number; candidate_operation_id: number }[]>`
      SELECT id::int AS id, candidate_operation_id::int AS candidate_operation_id FROM business_operation_match_decisions
       WHERE account_id = ${c.id} AND active AND decision = 'REJECTED'`;
    expect(rejet.length).toBe(1);
    const appels0 = m3.calls;
    const r = await appliquer(c.id);
    const a = r.accounts[0];
    expect(['REBUILT', 'PARTIAL']).toContain(a.status);
    const appels = m3.calls - appels0;
    expect(a.steps!.m3.calls).toBe(appels);
    expect(appels).toBeLessThanOrEqual(30);
    expect(appels).toBeLessThanOrEqual(5 * (a.steps!.consolidation.passes + a.steps!.series.passes + 1));
    expect(a.ai!.byOperation.t3_operation_match ?? 0).toBe(appels);
    // L'Opération refusée par l'utilisateur est conservée, la décision aussi, et la facture n'y est jamais rattachée.
    expect(a.plan!.kept.find((x) => x.id === rejet[0].candidate_operation_id)?.reasons).toContain('USER_DECISION');
    const [dec] = await sql`SELECT active, decision FROM business_operation_match_decisions WHERE id = ${rejet[0].id}`;
    expect(dec).toMatchObject({ active: true, decision: 'REJECTED' });
    const rattache = await sql`
      SELECT 1 FROM business_operation_sources WHERE operation_id = ${rejet[0].candidate_operation_id} AND active AND source_kind = 'DOCUMENT'
         AND source_entity_key = ${String(d.ambiguites.factureSansRef)}`;
    expect(rattache).toEqual([]);
    // Plafond journalier M3 (existant, inchangé) déjà atteint : aucun appel de plus, report tracé (jamais d'abandon).
    const appels1 = m3.calls;
    const r2 = await appliquer(c.id, { force: true, operationMatch: { maxCallsPerDay: appels } });
    expect(m3.calls - appels1).toBe(0);
    expect(r2.accounts[0].steps!.m3.calls).toBe(0);
    expect(r2.accounts[0].steps!.m3.deferredReasons.DAILY_CAP ?? 0).toBeGreaterThan(0);
  });

  it('L85A-E10 — AC40 / E19 / O-9 : TCO identique après reconstruction ; Opération invalidée hors coût ; décision `o:` re-clée, jamais perdue', async () => {
    // Historique (Opérations des données structurées) : décision prise AVANT ce lot sur la clé `o:` d'une composante sans justificatif.
    const c = d.historique.compte;
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    const { tcoLineKeys } = await import('@/services/business-operations/tco/user-decisions');
    const t0 = await readAssetTco(c.id, d.historique.voiture.id, { today: RECETTE_TODAY });
    const sansJustificatif = t0.lines.find((l) => l.source === 'OPERATION' && (l.sourceIdentities?.length ?? 0) > 0 && !(l.sourceFileIds?.length));
    expect(sansJustificatif, JSON.stringify(t0.lines.map((l) => [l.id, l.source, l.status, l.sourceIdentities, l.sourceFileIds]))).toBeDefined();
    const cles = tcoLineKeys(sansJustificatif!);
    expect(cles.primary).toMatch(/^s:ASSET_DATA:/);
    const legacy = cles.secondary.find((x) => x.startsWith('o:'))!;
    expect(legacy).toBe(`o:${sansJustificatif!.operationId}:${sansJustificatif!.kind}:${sansJustificatif!.amountMinor}:EUR`);
    const decision = sansJustificatif!.status.startsWith('RETAINED') ? 'EXCLUDE' : 'INCLUDE';
    await sql`INSERT INTO asset_cost_line_decisions (account_id, asset_id, line_key, decision, decided_by) VALUES (${c.id}, ${d.historique.voiture.id}, ${legacy}, ${decision}, ${c.owner.id})`;
    const t1 = await readAssetTco(c.id, d.historique.voiture.id, { today: RECETTE_TODAY });
    expect(t1.lines.find((l) => l.decisionKey === cles.primary)?.userDecision?.key).toBe(legacy);
    const tcoAvant = await tcoDe(c.id);
    const r = await appliquer(c.id);
    expect(r.accounts[0].status).toBe('REBUILT');
    expect(r.accounts[0].plan!.purged).toContain(sansJustificatif!.operationId);
    expect(r.accounts[0].plan!.tcoDecisionsRekeyed).toMatchObject([{ from: legacy, to: cles.primary }]);
    const [row] = await sql`SELECT line_key, decision FROM asset_cost_line_decisions WHERE account_id = ${c.id}`;
    expect(row).toMatchObject({ line_key: cles.primary, decision });
    const tcoApres = await tcoDe(c.id);
    expect(tcoApres.assets.map((x) => [x.cumulativeCostCents, x.decisionsApplied, x.orphanDecisions, Object.values(x.retained).sort((p, q) => p - q)]))
      .toEqual(tcoAvant.assets.map((x) => [x.cumulativeCostCents, x.decisionsApplied, x.orphanDecisions, Object.values(x.retained).sort((p, q) => p - q)]));

    // AC40 sur tout le jeu : chaque compte reconstruit garde EXACTEMENT son TCO.
    for (const jeu of [d.duo, d.devises]) {
      const avant = await tcoDe(jeu.compte.id);
      const x = await appliquer(jeu.compte.id);
      expect(x.accounts[0].status).toBe('REBUILT');
      expect(x.accounts[0].tco!.differences).toEqual([]);
      const v = (t: Awaited<ReturnType<typeof tcoDe>>) => t.assets.map((y) => [y.cumulativeCostCents, Object.values(y.retained).sort((p, q) => p - q)]);
      expect(v(await tcoDe(jeu.compte.id))).toEqual(v(avant));
    }

    // E19 : une Opération INVALIDÉE (mauvaise Opération) n'est plus une source de coût — le document compte une fois.
    const e = await make.account({ plan: 'premium' });
    const maison = await make.asset(e, { category: 'IMMOBILIER', name: 'Maison E19' });
    const f = await k.document(e, maison.id, [cand({ summary: 'Réparation portail', provider: 'Ferronnerie Est', targetHints: [cible(maison.id)], businessReferences: [ref('INVOICE', 'E19-1')], temporalHints: { realizedDate: '2026-04-10' }, financialHints: [fh('REALIZED_COST', 50000)] })], { type: 'REPAIR_INVOICE', title: 'Facture portail', amountCents: 50000, date: '2026-04-10' });
    await k.passer(e);
    const [op] = await k.actives(e);
    const cout = async () => (await readAssetTco(e.id, maison.id, { today: RECETTE_TODAY })).summary.cumulativeCostCents;
    expect(await cout()).toBe(50000);
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(e.id, (repo) => repo.invalidate(op.id, 'E2E_L85A_MAUVAISE_OPERATION'));
    const tInv = await readAssetTco(e.id, maison.id, { today: RECETTE_TODAY });
    expect(tInv.summary.cumulativeCostCents).toBe(50000);
    expect(tInv.lines.some((l) => l.operationId === op.id && l.status.startsWith('RETAINED'))).toBe(false);
    const x = await appliquer(e.id);
    expect(x.accounts[0].plan!.purged).toContain(op.id);
    expect(await cout()).toBe(50000);
    expect((await k.actives(e)).length).toBe(1);
    void f;
  });

  it('L85A-E11 — AC51 / E30 : factures récurrentes d’un même service comptées chacune une fois, avant et après reconstruction', async () => {
    const c = await make.account({ plan: 'premium' });
    const maison = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison télésurveillance' });
    const pad = (m: number) => String(m).padStart(2, '0');
    for (const m of [1, 2, 3]) {
      await k.document(c, maison.id, [cand({
        provider: 'Homiris', summary: `Abonnement télésurveillance — ${pad(m)}/2026`, targetHints: [cible(maison.id)],
        businessReferences: [ref('INVOICE', `FH-2026-${pad(m)}`), ref('CUSTOMER', 'CL-778 812')],
        temporalHints: { startDate: `2026-${pad(m)}-01`, endDate: `2026-${pad(m)}-28` },
        financialHints: [fh('REALIZED_COST', 3990, { amountScope: 'INSTALLMENT', economicDate: `2026-${pad(m)}-05`, periodStart: `2026-${pad(m)}-01`, periodEnd: `2026-${pad(m)}-28` })],
      })], { type: 'SUBSCRIPTION_INVOICE', title: `Facture ${pad(m)}/2026`, amountCents: 3990, date: `2026-${pad(m)}-05` });
      await k.passer(c);
    }
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    const etat = async () => {
      const ops = await k.actives(c);
      const t = await readAssetTco(c.id, maison.id, { today: RECETTE_TODAY });
      return { ops: ops.length, comps: (await Promise.all(ops.map((o) => k.composantes(o.id)))).flat().length, cout: t.summary.cumulativeCostCents };
    };
    const avant = await etat();
    expect(avant).toEqual({ ops: 1, comps: 3, cout: 3 * 3990 });
    const r = await appliquer(c.id);
    expect(r.accounts[0].status).toBe('REBUILT');
    expect(await etat()).toEqual(avant);
  });

  it('L85A-E12 — moteur des rattrapages : Simuler, refus sans point, rapport lisible (BO)', async () => {
    const { executeBackfill } = await import('@/services/admin/ops/backfill/executors');
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    const { validateBackfillRequest } = await import('@/services/admin/ops/backfill/definitions');
    const c = d.devises.compte;
    const hooks = { log: () => undefined, progress: () => undefined };
    const v = validateBackfillRequest({ script: 'operations-v5-rebuild', action: 'simulate', accountId: c.id });
    if (!v.ok) throw new Error(v.message);
    const out = await executeBackfill(sql, v.value, hooks);
    const s = summarizeBackfill('operations-v5-rebuild', 'simulate', null, out);
    expect(s.headline).toMatch(/^Simulation : 1 compte\(s\) examiné\(s\)/);
    expect(s.restorable).toBe(false);
    // Application sans stockage de sauvegarde configuré (harnais) : refus, code RESTORE_POINT_REQUIRED.
    const a = validateBackfillRequest({ script: 'operations-v5-rebuild', action: 'apply', accountId: c.id, reason: 'recette e2e L85A' });
    if (!a.ok) throw new Error(a.message);
    await expect(executeBackfill(sql, a.value, hooks, { id: c.owner.id })).rejects.toMatchObject({ code: 'RESTORE_POINT_REQUIRED' });
    const restore = validateBackfillRequest({ script: 'operations-v5-rebuild', action: 'restore', runId: runPremium, reason: 'recette e2e L85A' });
    expect(restore.ok).toBe(true);
  });
});
