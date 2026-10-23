/**
 * Lot 78A — identité économique des Opérations sur PostgreSQL 16 réel
 * (ticket « [P1] Opérations & TCO », §2, §5, §6, tests de non-régression §7).
 * Chemins de PRODUCTION : persistance T1 des candidats, consolidation T3
 * (`consolidateAccountOperations`), reconsolidation, projection Agenda,
 * diagnostic BO, export de diagnostic 77C.
 *
 *   L78A-E01 §7.1  commande Tikamoon 277,35 € / acquisition de la maison 490 000 € : deux réalités, sans contamination ;
 *   L78A-E02 §7.2  plusieurs documents d'un seul achat immobilier : une Opération, prix non multiplié ;
 *   L78A-E03 §7.3  trois candidats redondants (commande, facture, règlement) : une Opération ;
 *   L78A-E04 §7.4  deux transactions réelles dans un document : deux Opérations ;
 *   L78A-E05 §7.5  dates et prestataires contradictoires : aucune consolidation arbitraire ;
 *   L78A-E06 §7.8  reconsolidations répétées : résultat stable, aucun doublon, aucune écriture ;
 *   L78A-E07 §5 / §7.9  correction rétroactive du cas #76 : séparation tracée, composantes / dates / agenda
 *                  recalculés, justificatifs conservés, idempotence, rétablissement (BO) ;
 *   L78A-E08 §5    décision utilisateur (M0) jamais défaite ; doublons historiques d'un même document rapprochés sans fusion ;
 *   L78A-E09 §6    traçabilité : lien composante → indice T1 → fait persisté, provenance, journal, BO, export 77C.
 */
import { beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import { RECETTE_TODAY, cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow } from '../factories';

scenario('L78A', 'Identité économique des Opérations : M1/M2 sécurisés, correction rétroactive, traçabilité', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  const maisonDe = (compte: AccountRow) => make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
  const chaises = (assetId: number, over: Parameters<typeof cand>[0] = {}) => cand({
    typeHint: 'ACQUISITION', summary: 'Commande de quatre chaises de jardin', provider: 'Tikamoon', sourceRoleHint: 'INVOICE',
    targetHints: [cible(assetId)], businessReferences: [ref('ORDER', 'TK-5521')], temporalHints: { realizedDate: '2025-05-12' },
    financialHints: [fh('REALIZED_COST', 27735, { economicDate: '2025-05-12' })], ...over,
  });
  const acte = (assetId: number, over: Parameters<typeof cand>[0] = {}) => cand({
    typeHint: 'ACQUISITION', summary: 'Acte authentique de vente de la maison', provider: 'Office notarial Martin', sourceRoleHint: 'SALE_DOCUMENT',
    targetHints: [cible(assetId)], temporalHints: { realizedDate: '2021-06-30' },
    financialHints: [fh('REALIZED_COST', 49_000_000, { economicDate: '2021-06-30' })], ...over,
  });
  const fichierDe = async (fileId: number) => (await sql<{ id: number; t3_operation_id: number | null; t3_outcome: string; t3_reason: string; t3_detail: Record<string, any> }[]>`
    SELECT id::int AS id, t3_operation_id::int AS t3_operation_id, t3_outcome, t3_reason, t3_detail FROM document_operation_candidates
     WHERE file_id = ${fileId} AND status = 'ACTIVE' ORDER BY id`);
  const realise = async (opId: number) => (await k.composantes(opId)).filter((c) => c.kind === 'REALIZED_COST').reduce((t, c) => t + c.amount_minor, 0);

  it('L78A-E01 / §7.1 — commande Tikamoon (277,35 €) puis acte de la maison (490 000 €), même bien : deux Opérations, aucune contamination', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await maisonDe(compte);
    await k.document(compte, maison.id, [chaises(maison.id)], { title: 'Commande Tikamoon' });
    await k.passer(compte);
    const [tika] = await k.actives(compte);
    const fActe = await k.document(compte, maison.id, [acte(maison.id)], { title: 'Acte de vente' });
    await k.passer(compte);
    const ops = await k.actives(compte);
    expect(ops).toHaveLength(2);
    const maisonOp = ops.find((o) => o.id !== tika.id)!;
    expect(await realise(tika.id)).toBe(27735);
    expect(await realise(maisonOp.id)).toBe(49_000_000);
    expect((await k.operations(compte)).find((o) => o.id === tika.id)).toMatchObject({ realized_date: '2025-05-12', provider: 'Tikamoon' });
    expect(maisonOp).toMatchObject({ realized_date: '2021-06-30', provider: 'Office notarial Martin' });
    const [c] = await fichierDe(fActe);
    expect(c).toMatchObject({ t3_outcome: 'CREATE_NEW', t3_operation_id: maisonOp.id });
    expect(c.t3_detail.identity).toEqual([expect.objectContaining({ operationId: tika.id, basis: 'OWNERSHIP_CYCLE', outcome: 'REFUSED' })]);
    expect((await k.sources(tika.id)).filter((s) => s.active)).toHaveLength(1);
  });

  it('L78A-E02 / §7.2 — acte, attestation notariée et compromis d\'UN achat immobilier : une Opération, prix compté une fois', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await maisonDe(compte);
    await k.document(compte, maison.id, [acte(maison.id)], { title: 'Acte' });
    await k.passer(compte);
    await k.document(compte, maison.id, [acte(maison.id, { summary: 'Attestation de propriété', provider: 'Office notarial Martin' })], { title: 'Attestation' });
    await k.document(compte, maison.id, [acte(maison.id, {
      summary: 'Compromis de vente de la maison', provider: 'Agence du Centre', sourceRoleHint: 'CONTRACT_DOCUMENT', statusHint: 'ENVISAGED',
      temporalHints: { plannedDate: '2021-06-30' }, financialHints: [fh('FORECAST_COST', 49_000_000)],
    })], { title: 'Compromis' });
    await k.passer(compte);
    const ops = await k.actives(compte);
    expect(ops).toHaveLength(1);
    expect((await k.sources(ops[0].id)).filter((s) => s.active)).toHaveLength(3);
    expect(await realise(ops[0].id)).toBe(49_000_000);
    expect(await k.coutNet(ops[0].id)).toBe(49_000_000);
  });

  it('L78A-E03 / §7.3 — trois candidats redondants d\'une même transaction (commande, facture, règlement) : une Opération, stable à la réanalyse', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await maisonDe(compte);
    const base = { typeHint: 'ACQUISITION' as const, provider: 'Tikamoon', targetHints: [cible(maison.id)], temporalHints: { realizedDate: '2025-05-12' }, businessReferences: [] };
    const f = await k.document(compte, maison.id, [
      cand({ ...base, candidateKey: 'op1', summary: 'Commande de chaises de jardin', sourceRoleHint: 'ORDER', statusHint: 'ENVISAGED', financialHints: [fh('FORECAST_COST', 27735)] }),
      cand({ ...base, candidateKey: 'op2', summary: 'Facture chaises de jardin', sourceRoleHint: 'INVOICE', financialHints: [fh('REALIZED_COST', 27735)] }),
      cand({ ...base, candidateKey: 'op3', summary: 'Paiement par carte', sourceRoleHint: 'PAYMENT_PROOF', confidence: 'probable', financialHints: [fh('PAYMENT', 27735)] }),
    ], { title: 'Commande Tikamoon' });
    await k.passer(compte);
    const ops = await k.actives(compte);
    expect(ops).toHaveLength(1);
    expect((await fichierDe(f)).map((c) => c.t3_operation_id)).toEqual([ops[0].id, ops[0].id, ops[0].id]);
    expect(await realise(ops[0].id)).toBe(27735);
    // Réanalyse identique : même résultat, aucune écriture métier.
    const avant = await k.historique(compte);
    await k.t1(compte, f, [
      cand({ ...base, candidateKey: 'op1', summary: 'Commande de chaises de jardin', sourceRoleHint: 'ORDER', statusHint: 'ENVISAGED', financialHints: [fh('FORECAST_COST', 27735)] }),
      cand({ ...base, candidateKey: 'op2', summary: 'Facture chaises de jardin', sourceRoleHint: 'INVOICE', financialHints: [fh('REALIZED_COST', 27735)] }),
      cand({ ...base, candidateKey: 'op3', summary: 'Paiement par carte', sourceRoleHint: 'PAYMENT_PROOF', confidence: 'probable', financialHints: [fh('PAYMENT', 27735)] }),
    ], true);
    await k.passer(compte);
    expect(await k.actives(compte)).toEqual(ops);
    expect(await k.historique(compte)).toBe(avant);
  });

  it('L78A-E04 / §7.4 — deux transactions réelles dans un même document (chaises, table) : deux Opérations distinctes', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await maisonDe(compte);
    await k.document(compte, maison.id, [
      chaises(maison.id, { candidateKey: 'op1', businessReferences: [] }),
      chaises(maison.id, { candidateKey: 'op2', businessReferences: [], summary: 'Table de jardin en teck', financialHints: [fh('REALIZED_COST', 89_900)] }),
    ], { title: 'Facture Tikamoon' });
    await k.passer(compte);
    const ops = await k.actives(compte);
    expect(ops).toHaveLength(2);
    expect((await Promise.all(ops.map((o) => realise(o.id)))).sort((a, b) => a - b)).toEqual([27735, 89_900]);
  });

  it('L78A-E05 / §7.5 — même bien, même cycle, dates à quatre ans et prestataires différents : jamais une Opération composite', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await maisonDe(compte);
    await k.document(compte, maison.id, [cand({ typeHint: 'ACQUISITION', summary: 'Achat', provider: 'Vendeur A', targetHints: [cible(maison.id)], temporalHints: { realizedDate: '2021-01-04' } })]);
    await k.passer(compte);
    await k.document(compte, maison.id, [cand({ typeHint: 'ACQUISITION', summary: 'Achat', provider: 'Vendeur B', targetHints: [cible(maison.id)], temporalHints: { realizedDate: '2025-02-10' } })]);
    await k.passer(compte);
    const ops = await k.actives(compte);
    expect(ops.map((o) => [o.provider, o.realized_date])).toEqual([['Vendeur A', '2021-01-04'], ['Vendeur B', '2025-02-10']]);
  });

  it('L78A-E06 / §7.8 — reconsolidations répétées (passage, reconsolidation complète BO) : résultat stable, aucun doublon, aucune écriture', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await maisonDe(compte);
    await k.document(compte, maison.id, [chaises(maison.id)]);
    await k.document(compte, maison.id, [acte(maison.id)]);
    await k.passer(compte);
    const ops = await k.actives(compte);
    const h = await k.historique(compte);
    const { reconsolidateAllActiveOperations } = await import('@/services/business-operations/consolidation/queue');
    for (let i = 0; i < 3; i++) {
      await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE account_id = ${compte.id} AND status = 'ACTIVE'`;
      await k.passer(compte);
      await reconsolidateAllActiveOperations(compte.id, { today: RECETTE_TODAY });
    }
    expect(await k.actives(compte)).toEqual(ops);
    expect(await k.historique(compte)).toBe(h);
  });

  // ── §5 / §7.9 : correction rétroactive du cas réel #76 ──────────────────

  /** État historique contaminé : les documents de la maison rattachés à la commande par l'ancienne règle M2 « cycle ». */
  async function casReel76() {
    const compte = await make.account({ plan: 'premium' });
    const maison = await maisonDe(compte);
    const fTika = await k.document(compte, maison.id, [chaises(maison.id)], { title: 'Commande Tikamoon' });
    await k.passer(compte);
    const [op76] = await k.actives(compte);
    const docs = [
      await k.document(compte, maison.id, [acte(maison.id)], { title: 'Acte de vente' }),
      await k.document(compte, maison.id, [acte(maison.id, { summary: 'Attestation notariée d\'acquisition', temporalHints: { realizedDate: '2021-07-02' }, financialHints: [fh('REALIZED_COST', 49_000_000, { economicDate: '2021-07-02' })] })], { title: 'Attestation' }),
      await k.document(compte, maison.id, [acte(maison.id, { summary: 'Titre de propriété', temporalHints: { realizedDate: '2007-04-02' }, financialHints: [fh('REALIZED_COST', 49_000_000, { economicDate: '2007-04-02' })] })], { title: 'Titre' }),
    ];
    // Rattachement M2 historique (sans IA, sans contrôle) tel qu'enregistré avant le lot 78A.
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(compte.id, async (repo, session) => {
      for (const f of docs) {
        const [c] = await sql<{ id: number; candidate_key: string }[]>`SELECT id::int AS id, candidate_key FROM document_operation_candidates WHERE file_id = ${f} AND status = 'ACTIVE'`;
        const version = `c${c.id}|a${maison.id}|t`;
        const sid = await repo.addSource(op76.id, {
          kind: 'DOCUMENT', entityKey: f, version, role: 'SALE_DOCUMENT', locator: { candidateKey: c.candidate_key }, authority: 'DOCUMENT',
          confidence: 'certain', matchMethod: 'M2', matchReason: 'MATCH_M2',
        }, 'T3_MATCH_AND_ENRICH');
        await repo.refreshSourceVersion(sid, version);
        await session.tx.execute((await import('drizzle-orm')).sql`
          UPDATE document_operation_candidates SET t3_pending = false, t3_processed_at = now(), t3_outcome = 'MATCH_AND_ENRICH', t3_reason = 'MATCH_M2',
                 t3_operation_id = ${op76.id},
                 t3_detail = ${JSON.stringify({ matchMethod: 'M2', certain: [{ operationId: op76.id, method: 'M2', why: 'OWNERSHIP_CYCLE_ACQUISITION' }], plausible: [], contradictions: [], excluded: [] })}::jsonb
           WHERE id = ${c.id}`);
      }
    });
    const { reconsolidateOperations } = await import('@/services/business-operations/consolidation/consolidator');
    await reconsolidateOperations(compte.id, [op76.id], { today: RECETTE_TODAY, syncCards: false });
    // Le stock historique n'a jamais été réévalué (aucune version de contrôle).
    await sql`UPDATE document_operation_candidates SET t3_detail = t3_detail - 'identityReview' WHERE account_id = ${compte.id}`;
    return { compte, maison, op76: op76.id, fTika, docs };
  }

  it('L78A-E07 / §5 / §7.9 — #76 : le passage planifié sépare les documents de la maison (certain), recalcule l\'Opération, tracé, idempotent, réversible', async () => {
    const { compte, op76, fTika, docs } = await casReel76();
    // Composite avant correction (reproduction du cas réel) : 277,35 € + 3 × 490 000 €. §2C : même composite, la
    // date de la source fondatrice n'est plus écrasée (avant le lot 78A : 2007) et la contradiction est tracée.
    expect(await realise(op76)).toBe(27735 + 3 * 49_000_000);
    expect((await k.operations(compte)).find((o) => o.id === op76)!.realized_date).toBe('2025-05-12');
    const prov = async () => (await sql<{ p: Record<string, any> }[]>`SELECT attribute_provenance AS p FROM business_operations WHERE id = ${op76}`)[0].p;
    expect((await prov()).conflicts.map((c: { field: string }) => c.field)).toEqual(['realizedDate', 'provider']);
    expect(await k.anomaliesDures(compte.id)).toMatchObject({ IDENTITY_ATTRIBUTE_CONFLICT: 1 });
    const projection = await import('@/services/business-operations/agenda-projection/service');
    await projection.projectAccountOperations(compte.id, { all: true, today: RECETTE_TODAY });
    const agenda76 = async () => sql<{ start_date: string }[]>`SELECT start_date::text AS start_date FROM agenda_items WHERE account_id = ${compte.id} AND business_operation_id = ${op76} ORDER BY id`;
    const agendaMaison = async (opId: number) => sql<{ start_date: string }[]>`SELECT start_date::text AS start_date FROM agenda_items WHERE account_id = ${compte.id} AND business_operation_id = ${opId} ORDER BY id`;
    // Lot 83A (CDC v5 §11.8, AC20) — test corrigé : dates de réalisation contradictoires tracées par T3 → l'événement
    // principal reste SANS date et la carte de date existante (DATA-AGENDA-DATE) arbitre ; la date de l'Opération
    // (source fondatrice, 78A) est inchangée.
    expect((await agenda76()).map((a) => a.start_date)).toEqual([null]);
    const carteDate = () => sql<{ action_kind: string; resolved: boolean }[]>`
      SELECT a.action_kind, a.resolved_at IS NOT NULL AS resolved FROM to_process_actions a JOIN agenda_items i ON i.id = a.target_id
       WHERE a.account_id = ${compte.id} AND a.target_type = 'AGENDA_ITEM' AND a.field_key = 'date' AND i.business_operation_id = ${op76}`;
    expect(await carteDate()).toEqual([{ action_kind: 'ARBITRATE', resolved: false }]);
    const historiqueAvant = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_history WHERE operation_id = ${op76}`)[0].n;

    // Le balayage planifié prend le compte (stock non réévalué), sans action de l'exploitant.
    const { listAccountsToConsolidate } = await import('@/services/business-operations/consolidation/consolidator');
    expect(await listAccountsToConsolidate(compte.id - 1, 10)).toContain(compte.id);
    const r = await k.passer(compte);
    expect(r.identityReviewMarked).toBeGreaterThan(0);

    // L'Opération #76 redevient la commande : montant, date, prestataire.
    const ops = await k.actives(compte);
    const o76 = ops.find((o) => o.id === op76)!;
    expect(o76).toMatchObject({ realized_date: '2025-05-12', provider: 'Tikamoon' });
    expect(await realise(op76)).toBe(27735);
    // Aucun justificatif détruit : sources désactivées (motif tracé), composantes supersédées, candidats intacts.
    const src76 = await sql<{ source_entity_key: string; active: boolean }[]>`SELECT source_entity_key, active FROM business_operation_sources WHERE operation_id = ${op76} ORDER BY id`;
    expect(src76).toEqual([{ source_entity_key: String(fTika), active: true }, ...docs.map((d) => ({ source_entity_key: String(d), active: false }))]);
    expect((await k.composantes(op76, false)).length).toBeGreaterThanOrEqual(2);
    const retraits = await sql<{ reason_code: string }[]>`SELECT reason_code FROM business_operation_history WHERE operation_id = ${op76} AND event_type = 'SOURCE_REMOVED' ORDER BY id`;
    expect(retraits.map((x) => x.reason_code)).toEqual(['T3_IDENTITY_SEPARATED', 'T3_IDENTITY_SEPARATED', 'T3_IDENTITY_SEPARATED']);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_history WHERE operation_id = ${op76}`)[0].n).toBeGreaterThan(historiqueAvant);
    // La maison devient sa propre Opération (acte + attestation, montant concordant) ; le titre de 2007 est DIFFÉRÉ (M3), jamais rattaché d'office.
    const maisonOp = ops.find((o) => o.id !== op76)!;
    expect(ops).toHaveLength(2);
    expect(maisonOp).toMatchObject({ realized_date: '2021-06-30', type_code: 'ACQUISITION' });
    expect((await fichierDe(docs[0]))[0]).toMatchObject({ t3_outcome: 'CREATE_NEW', t3_operation_id: maisonOp.id });
    expect((await fichierDe(docs[1]))[0]).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_operation_id: maisonOp.id });
    expect((await fichierDe(docs[2]))[0]).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'M3_REQUIRED' });
    // Journal : trois séparations appliquées, traçables.
    const journal = await sql<{ id: number; kind: string; status: string; operation_id: number; target_operation_id: number | null; file_id: number; signals: string[] }[]>`
      SELECT id::int AS id, kind, status, operation_id::int AS operation_id, target_operation_id::int AS target_operation_id, file_id, signals
        FROM business_operation_identity_reviews WHERE account_id = ${compte.id} ORDER BY file_id`;
    // La commande fondatrice, d'abord signalée (doute : sources contradictoires), est résolue une fois les intrus partis.
    expect(journal.filter((j) => j.kind === 'SUSPECT').map((j) => [j.status, j.file_id])).toEqual([['RESOLVED', fTika]]);
    const separations = journal.filter((j) => j.kind === 'SEPARATED');
    expect(separations.map((j) => [j.kind, j.status, j.operation_id, j.file_id])).toEqual(docs.map((d) => ['SEPARATED', 'APPLIED', op76, d]));
    expect(separations[0].target_operation_id).toBe(maisonOp.id);
    expect(separations[0].signals).toEqual(expect.arrayContaining(['!AMOUNT_INCOMPATIBLE']));
    expect((await prov()).conflicts).toEqual([]);
    expect(await k.anomaliesDures(compte.id)).not.toHaveProperty('IDENTITY_ATTRIBUTE_CONFLICT');
    // Agenda mis à jour (projection) : la commande à sa date, la maison à la sienne.
    await projection.projectAccountOperations(compte.id, { all: true, today: RECETTE_TODAY });
    expect((await agenda76()).map((a) => a.start_date)).toEqual(['2025-05-12']);
    // Lot 83A (AC19) : contradiction levée → date posée, carte de date close d'elle-même.
    expect(await carteDate()).toEqual([{ action_kind: 'ARBITRATE', resolved: true }]);
    expect((await agendaMaison(maisonOp.id)).map((a) => a.start_date)).toEqual(['2021-06-30']);
    // Idempotence : nouveaux passages et reconsolidation complète sans écriture.
    const h = await k.historique(compte);
    await k.passer(compte);
    await k.passer(compte);
    const { reconsolidateAllActiveOperations } = await import('@/services/business-operations/consolidation/queue');
    await reconsolidateAllActiveOperations(compte.id, { today: RECETTE_TODAY });
    expect(await k.historique(compte)).toBe(h);
    expect(await k.actives(compte)).toEqual(ops);
    // Stock entièrement réévalué (le compte ne reste listé que pour l'examen IA M3 dû au titre de 2007).
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_operation_candidates c WHERE c.account_id = ${compte.id}
                                         AND c.status = 'ACTIVE' AND c.established AND COALESCE(c.t3_detail->>'identityReview', '') <> 'l78a-v1'`)[0].n).toBe(0);

    // Réversible : rétablissement d'une séparation (BO) par une décision prioritaire, tracée.
    const { revertIdentitySeparation } = await import('@/services/business-operations/consolidation/identity-review');
    const admin = await make.user({ role: 'ADMIN' });
    await revertIdentitySeparation(separations[2].id, { adminId: admin.id });
    await k.passer(compte);
    expect((await fichierDe(docs[2]))[0]).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_operation_id: op76 });
    expect((await sql<{ status: string; resolved_by_admin_id: number }[]>`SELECT status, resolved_by_admin_id FROM business_operation_identity_reviews WHERE id = ${separations[2].id}`)[0])
      .toEqual({ status: 'REVERTED', resolved_by_admin_id: admin.id });
    expect((await sql<{ origin: string; decision: string }[]>`SELECT origin, decision FROM business_operation_match_decisions WHERE account_id = ${compte.id} AND active`))
      .toEqual([{ origin: 'ADMIN_REVIEW', decision: 'CONFIRMED' }]);
  });

  it('L78A-E08 / §5 — décision utilisateur (M0) jamais défaite ; doublons historiques d\'un même document rapprochés sans fusion (réversible)', async () => {
    const { compte, op76, docs } = await casReel76();
    // L'utilisateur avait confirmé le rattachement du titre à cette Opération.
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const [c3] = await sql<{ candidate_key: string }[]>`SELECT candidate_key FROM document_operation_candidates WHERE file_id = ${docs[2]} AND status = 'ACTIVE'`;
    await withBusinessOperationWrite(compte.id, (repo) => repo.recordMatchDecision({
      sourceKind: 'DOCUMENT', entityKey: docs[2], sourceVersion: c3.candidate_key, operationId: op76, decision: 'CONFIRMED', origin: 'USER_ARBITRATION', reasonCode: 'USER_SAME_OPERATION',
    }));
    await k.passer(compte);
    expect((await fichierDe(docs[2]))[0]).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_operation_id: op76 });
    expect((await fichierDe(docs[0]))[0].t3_operation_id).not.toBe(op76);

    // Doublons historiques d'un même document (trois candidats redondants consolidés séparément avant le lot 78A).
    const autre = await make.account({ plan: 'premium' });
    const maison = await maisonDe(autre);
    const base = { typeHint: 'ACQUISITION' as const, provider: 'Tikamoon', targetHints: [cible(maison.id)], temporalHints: { realizedDate: '2025-05-12' } };
    const f = await k.document(autre, maison.id, [
      cand({ ...base, candidateKey: 'op1', summary: 'Commande de chaises', sourceRoleHint: 'ORDER', statusHint: 'ENVISAGED', financialHints: [fh('FORECAST_COST', 27735)] }),
    ]);
    await k.passer(autre);
    // Deuxième candidat ajouté puis consolidé SANS le contrôle du lot 78A (état historique : deux Opérations).
    const { withBusinessOperationWrite: w } = await import('@/services/business-operations/write');
    await k.t1(autre, f, [
      cand({ ...base, candidateKey: 'op1', summary: 'Commande de chaises', sourceRoleHint: 'ORDER', statusHint: 'ENVISAGED', financialHints: [fh('FORECAST_COST', 27735)] }),
      cand({ ...base, candidateKey: 'op2', summary: 'Facture chaises', sourceRoleHint: 'INVOICE', financialHints: [fh('REALIZED_COST', 27735)] }),
    ], true);
    const [c2] = await sql<{ id: number }[]>`SELECT id::int AS id FROM document_operation_candidates WHERE file_id = ${f} AND status = 'ACTIVE' AND candidate_key = 'op2'`;
    const [c1] = await sql<{ id: number }[]>`SELECT id::int AS id FROM document_operation_candidates WHERE file_id = ${f} AND status = 'ACTIVE' AND candidate_key = 'op1'`;
    const [opA] = await k.actives(autre);
    const opB = await w(autre.id, async (repo) => (await repo.create({
      type: { code: 'ACQUISITION' }, status: 'REALIZED', realizedDate: '2025-05-12', provider: 'Tikamoon', technicalLabel: 'Facture chaises',
      source: { kind: 'DOCUMENT', entityKey: f, version: `c${c2.id}|a${maison.id}|t`, role: 'INVOICE', locator: { candidateKey: 'op2' }, authority: 'DOCUMENT', confidence: 'certain', matchMethod: null, matchReason: 'NO_MATCH_ESTABLISHED' },
      assets: [{ assetId: maison.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'T3_CREATE_NEW',
    })).id);
    await w(autre.id, async (repo) => {
      const s = await sql<{ id: number }[]>`SELECT id::int AS id FROM business_operation_sources WHERE operation_id = ${opA.id} AND active`;
      await repo.refreshSourceVersion(s[0].id, `c${c1.id}|a${maison.id}|t`);
    });
    await sql`UPDATE document_operation_candidates SET t3_pending = false, t3_processed_at = now(), t3_outcome = 'CREATE_NEW',
                     t3_operation_id = CASE candidate_key WHEN 'op1' THEN ${opA.id}::bigint ELSE ${opB}::bigint END, t3_detail = '{}'::jsonb
               WHERE file_id = ${f} AND status = 'ACTIVE'`;
    expect(await k.actives(autre)).toHaveLength(2);
    await k.passer(autre);
    const ops = await k.actives(autre);
    expect(ops.map((o) => o.id)).toEqual([opA.id]);
    // B invalidée (réactivable), jamais fusionnée ; journal du doublon.
    expect((await k.operations(autre)).find((o) => o.id === opB)).toMatchObject({ merged_into_operation_id: null });
    expect((await k.operations(autre)).find((o) => o.id === opB)!.invalidated_at).not.toBeNull();
    expect((await sql<{ kind: string; operation_id: number; target_operation_id: number }[]>`
      SELECT kind, operation_id::int AS operation_id, target_operation_id::int AS target_operation_id FROM business_operation_identity_reviews WHERE account_id = ${autre.id}`))
      .toEqual([{ kind: 'DUPLICATE_RELOCATED', operation_id: opB, target_operation_id: opA.id }]);
    expect(await realise(opA.id)).toBe(27735);
  });

  it('L78A-E09 / §6 / §4 — traçabilité : composante → candidat T1 → indice → fait persisté ; provenance ; journal ; BO ; export de diagnostic', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await maisonDe(compte);
    const f = await make.assetFile(compte, { assetId: maison.id });
    const [x] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${f.id}) RETURNING id`;
    const [fait] = await sql<{ id: number }[]>`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, canonical_key, label, value_number, value_unit, raw_value, confidence, excerpt, status)
      VALUES (${compte.id}, ${f.id}, ${x.id}, 'totalAmount', 'totalAmount', 'Total', 277.35, 'EUR', '277,35 €', 'certain', 'Total TTC 277,35 €', 'active') RETURNING id`;
    const { replaceOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/persist');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await replaceOperationCandidates(tx as never, {
        accountId: compte.id, fileId: f.id, extractionId: x.id, analysisRunId: null, reanalysis: false,
        candidates: [chaises(maison.id)], facts: new Map([['f1', [{ factId: Number(fait.id), sourceUnitIds: ['u1'] }]]]),
      });
    });
    await k.passer(compte);
    const [op] = await k.actives(compte);
    const [cid] = await sql<{ id: number }[]>`SELECT id::int AS id FROM document_operation_candidates WHERE file_id = ${f.id} AND status = 'ACTIVE'`;
    const [lien] = await sql<{ evidence: Record<string, unknown> }[]>`
      SELECT cs.evidence FROM business_operation_financial_component_sources cs JOIN business_operation_financial_components c ON c.id = cs.component_id
       WHERE c.operation_id = ${op.id} AND c.active`;
    expect(lien.evidence).toEqual({ candidateId: cid.id, hintIndexes: [0], factIds: [Number(fait.id)] });
    const [p] = await sql<{ p: Record<string, any> }[]>`SELECT attribute_provenance AS p FROM business_operations WHERE id = ${op.id}`;
    expect(p.p.fields).toMatchObject({ realizedDate: { value: '2025-05-12' }, provider: { value: 'Tikamoon' }, label: { value: 'Commande de quatre chaises de jardin' } });
    expect(p.p.conflicts).toEqual([]);
    // Idempotence de la trace : un nouveau passage n'écrit rien.
    const h = await k.historique(compte);
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE account_id = ${compte.id}`;
    await k.passer(compte);
    expect(await k.historique(compte)).toBe(h);

    // BO › Opérations : provenance, lien d'indice, contrôle d'identité (lecture seule).
    const { OperationDiagnosticsService } = await import('@/services/business-operations/diagnostics/service');
    const d = await new OperationDiagnosticsService().detail(op.id);
    expect(d!.attributeProvenance).toMatchObject({ fields: { provider: { value: 'Tikamoon' } } });
    expect((d!.components[0].sources as Array<Record<string, unknown>>)[0].evidence).toEqual({ candidateId: cid.id, hintIndexes: [0], factIds: [Number(fait.id)] });

    // Export de diagnostic (77C) : lien persisté, plus de « non persisté » ; fichier d'identité économique.
    const { generateDiagnostic } = await import('@/services/admin/diagnostics-export/collect');
    const admin = await make.user({ role: 'ADMIN' });
    const jour = new Date().toISOString().slice(0, 10);
    const b = await generateDiagnostic({ scope: 'operation', id: op.id, from: jour, to: jour, treatments: [], reinforced: false }, { adminUserId: admin.id });
    const lire = <T>(path: string): T => JSON.parse(b.files.find((x) => x.path === path)!.content) as T;
    const traces = lire<Array<{ chaine: Array<{ etape: string; donnees?: Record<string, any> }> }>>('tracabilite/montants.json');
    const ext = traces[0].chaine.find((s) => s.etape === 'EXTRACTION_IA')!;
    expect(ext.donnees!.lienPersiste).toEqual({ candidat: cid.id, indices: [0], faits: [Number(fait.id)] });
    expect(ext.donnees!.faits.map((y: { id: number }) => Number(y.id))).toEqual([Number(fait.id)]);
    expect(JSON.stringify(b.manifest)).not.toMatch(/Lien composante → indice T1/);
    const identite = lire<{ candidats: Array<Record<string, unknown>>; sources: Array<Record<string, unknown>>; provenance: Array<Record<string, unknown>> }>('tracabilite/identite-economique.json');
    expect(identite.candidats[0]).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_reason: 'MATCH_M2', version_controle: 'l78a-v1' });
    expect(identite.sources[0]).toMatchObject({ nature_decision: 'CREATION', active: true });
    expect(identite.provenance[0].provenance).toMatchObject({ fields: { provider: { value: 'Tikamoon' } } });
  });
});
