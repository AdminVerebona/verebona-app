/**
 * Lot 79A — BO › Opérations › détail : « Rétablir » une séparation automatique
 * d'identité économique (lot 78A) sur PostgreSQL 16 réel. Chemins de
 * PRODUCTION : persistance T1, consolidation T3 (`consolidateAccountOperations`),
 * route BO réelle (garde simulée), `revertIdentitySeparation`, projection
 * Agenda, diagnostic BO, contrôle qualité / Supervision, export 77C.
 *
 *   L79A-E01 rétablissement réel par la route : décision ADMIN_REVIEW, TCO / champs dérivés / agenda
 *            recalculés, journal d'audit (admin, motif, avant / après), trace au détail BO ;
 *   L79A-E02 jamais re-séparé : réévaluation complète du stock (balayage horaire), passages répétés,
 *            reconsolidation — aucune séparation, aucun doute, aucune anomalie IDENTITY_* ; l'anomalie
 *            de Supervision liée est résolue ;
 *   L79A-E03 idempotence et concurrence : double clic, deux administrateurs simultanés → un seul rétablissement ;
 *   L79A-E04 refus : non-admin, autre compte, Opération sans rapport, séparation plus effective
 *            (source supprimée, Opération d'origine fusionnée / invalidée) — message clair, journalisé ;
 *   L79A-E05 export de diagnostic 77C : le rétablissement figure dans tracabilite/identite-economique.json.
 */
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { RECETTE_TODAY, cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow } from '../factories';

const garde = vi.hoisted(() => ({ id: 0, email: 'admin-l79a@test.invalid', refus: null as null | string }));
vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: async () => { if (garde.refus) throw new Error(garde.refus); return garde.id; },
  getSession: async () => ({ userId: garde.id, email: garde.email }),
  isSessionError: (e: unknown) => ['AUTH_REQUIRED', 'INSUFFICIENT_PERMISSIONS'].includes((e as Error)?.message),
  sessionErrorResponse: (e: unknown) => new Response(null, { status: (e as Error).message === 'AUTH_REQUIRED' ? 401 : 403 }),
}));

scenario('L79A', 'BO « Rétablir » une séparation automatique d\'identité économique', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const comptes: number[] = [];
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });
  afterEach(() => { garde.refus = null; });
  afterAll(async () => {
    if (comptes.length) await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE account_id = ANY(${comptes}) AND status = 'PENDING'`;
  });

  const maisonDe = (compte: AccountRow) => make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
  const chaises = (assetId: number) => cand({
    typeHint: 'ACQUISITION', summary: 'Commande de quatre chaises de jardin', provider: 'Tikamoon', sourceRoleHint: 'INVOICE',
    targetHints: [cible(assetId)], businessReferences: [ref('ORDER', 'TK-5521')], temporalHints: { realizedDate: '2025-05-12' },
    financialHints: [fh('REALIZED_COST', 27735, { economicDate: '2025-05-12' })],
  });
  const acte = (assetId: number, over: Parameters<typeof cand>[0] = {}) => cand({
    typeHint: 'ACQUISITION', summary: 'Acte authentique de vente de la maison', provider: 'Office notarial Martin', sourceRoleHint: 'SALE_DOCUMENT',
    targetHints: [cible(assetId)], temporalHints: { realizedDate: '2021-06-30' },
    financialHints: [fh('REALIZED_COST', 49_000_000, { economicDate: '2021-06-30' })], ...over,
  });
  const realise = async (opId: number) => (await k.composantes(opId)).filter((c) => c.kind === 'REALIZED_COST').reduce((t, c) => t + c.amount_minor, 0);
  const sourcesActives = async (opId: number) => (await k.sources(opId)).filter((s) => s.active).map((s) => Number(s.source_entity_key)).sort((a, b) => a - b);

  /**
   * Cas réel #76 (lot 78A) : documents de la maison rattachés à tort à la commande Tikamoon par l'ancienne
   * règle M2, puis séparés AUTOMATIQUEMENT par le passage T3 (correction rétroactive du lot 78A).
   */
  async function separe(avantPassage?: (accountId: number) => Promise<void>) {
    const compte = await make.account({ plan: 'premium' });
    comptes.push(compte.id);
    const maison = await maisonDe(compte);
    const fTika = await k.document(compte, maison.id, [chaises(maison.id)], { title: 'Commande Tikamoon' });
    await k.passer(compte);
    const [op76] = await k.actives(compte);
    const docs = [
      await k.document(compte, maison.id, [acte(maison.id)], { title: 'Acte de vente' }),
      await k.document(compte, maison.id, [acte(maison.id, { summary: 'Attestation notariée d\'acquisition', temporalHints: { realizedDate: '2021-07-02' }, financialHints: [fh('REALIZED_COST', 49_000_000, { economicDate: '2021-07-02' })] })], { title: 'Attestation' }),
    ];
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const { sql: dsql } = await import('drizzle-orm');
    await withBusinessOperationWrite(compte.id, async (repo, session) => {
      for (const f of docs) {
        const [c] = await sql<{ id: number; candidate_key: string }[]>`SELECT id::int AS id, candidate_key FROM document_operation_candidates WHERE file_id = ${f} AND status = 'ACTIVE'`;
        const version = `c${c.id}|a${maison.id}|t`;
        const sid = await repo.addSource(op76.id, {
          kind: 'DOCUMENT', entityKey: f, version, role: 'SALE_DOCUMENT', locator: { candidateKey: c.candidate_key }, authority: 'DOCUMENT',
          confidence: 'certain', matchMethod: 'M2', matchReason: 'MATCH_M2',
        }, 'T3_MATCH_AND_ENRICH');
        await repo.refreshSourceVersion(sid, version);
        await session.tx.execute(dsql`
          UPDATE document_operation_candidates SET t3_pending = false, t3_processed_at = now(), t3_outcome = 'MATCH_AND_ENRICH', t3_reason = 'MATCH_M2',
                 t3_operation_id = ${op76.id},
                 t3_detail = ${JSON.stringify({ matchMethod: 'M2', certain: [{ operationId: op76.id, method: 'M2', why: 'OWNERSHIP_CYCLE_ACQUISITION' }], plausible: [], contradictions: [], excluded: [] })}::jsonb
           WHERE id = ${c.id}`);
      }
    });
    const { reconsolidateOperations } = await import('@/services/business-operations/consolidation/consolidator');
    await reconsolidateOperations(compte.id, [op76.id], { today: RECETTE_TODAY, syncCards: false });
    await sql`UPDATE document_operation_candidates SET t3_detail = t3_detail - 'identityReview' WHERE account_id = ${compte.id}`;
    // Anomalie dure AVANT correction (composite) : contradiction d'attributs — base de la Supervision liée.
    expect(await k.anomaliesDures(compte.id)).toMatchObject({ IDENTITY_ATTRIBUTE_CONFLICT: 1 });
    await avantPassage?.(compte.id);
    await k.passer(compte);
    const separations = await sql<{ id: number; file_id: number; target_operation_id: number }[]>`
      SELECT id::int AS id, file_id, target_operation_id::int AS target_operation_id FROM business_operation_identity_reviews
       WHERE account_id = ${compte.id} AND kind = 'SEPARATED' AND status = 'APPLIED' ORDER BY file_id`;
    expect(separations.map((x) => x.file_id)).toEqual(docs);
    const maisonOp = separations[0].target_operation_id;
    expect(await sourcesActives(op76.id)).toEqual([fTika]);
    expect(await sourcesActives(maisonOp)).toEqual(docs);
    return { compte, maison, op76: op76.id, maisonOp, fTika, docs, separations };
  }

  const route = () => import('@/app/api/admin/operations/[id]/identity-reviews/[reviewId]/restore/route');
  const post = async (operationId: number, reviewId: number, body: unknown) => {
    const r = await (await route()).POST(
      new NextRequest(`http://x/api/admin/operations/${operationId}/identity-reviews/${reviewId}/restore`, {
        method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: String(operationId), reviewId: String(reviewId) }) },
    );
    return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> };
  };
  const audit = (reviewId: number) => sql<{ admin_user_id: number; admin_email: string; result: string; details: string; old_value: Record<string, unknown> | null; new_value: Record<string, unknown> | null }[]>`
    SELECT admin_user_id, admin_email, result, details, old_value, new_value FROM admin_audit_log
     WHERE action_type = 'OPERATION_IDENTITY_RESTORE' AND target_type = 'OPERATION_IDENTITY_REVIEW' AND target_id = ${reviewId} ORDER BY id`;
  const detailBo = async (opId: number) => {
    const { OperationDiagnosticsService } = await import('@/services/business-operations/diagnostics/service');
    return (await new OperationDiagnosticsService().detail(opId))!;
  };
  const decisionsAdmin = (accountId: number) => sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM business_operation_match_decisions WHERE account_id = ${accountId} AND origin = 'ADMIN_REVIEW' AND active`;
  const admin = async () => {
    const a = await make.user({ role: 'ADMIN' });
    garde.id = a.id;
    return a;
  };
  const MOTIF = 'Vérifié avec le client : acte et commande décrivent le même achat.';

  it('L79A-E01 — rétablissement réel par la route BO : décision ADMIN_REVIEW, TCO / dates / agenda recalculés, journal et trace au détail', async () => {
    const { compte, op76, maisonOp, docs, separations, fTika } = await separe();
    const sep = separations[0];
    // Détail BO : bouton proposé sur l'Opération d'origine ET sur celle qui porte aujourd'hui le document.
    for (const opId of [op76, maisonOp]) {
      const r = (await detailBo(opId)).identityReviews!.find((x) => Number(x.id) === sep.id)!;
      expect(r.restore).toEqual({
        reviewId: sep.id, fileId: docs[0], candidateKey: 'op1', summary: 'Acte authentique de vente de la maison', originOperationId: op76,
        currentOperationId: maisonOp, amounts: [{ role: 'REALIZED_COST', amountMinor: 49_000_000, currency: 'EUR' }],
      });
    }
    const a = await admin();
    // Motif trop court : refus, rien d'écrit.
    expect(await post(op76, sep.id, { reason: 'court !' })).toMatchObject({ status: 400, body: { code: 'INVALID_REASON' } });
    expect((await decisionsAdmin(compte.id))[0].n).toBe(0);

    const r = await post(op76, sep.id, { reason: `  ${MOTIF} ` });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ accountId: compte.id, operationId: op76, fileId: docs[0] });
    // Passage T3 demandé aussitôt (même périmètre qu'un arbitrage résolu).
    const [job] = await sql<{ target_type: string; status: string }[]>`SELECT target_type, status FROM ai_job_queue WHERE id = ${r.body.jobId as number}`;
    expect(job).toMatchObject({ target_type: 'business_operations', status: 'PENDING' });
    // Journal d'audit admin : un succès, motif, avant / après — écrit avec la décision.
    const [ligne] = await audit(sep.id);
    expect(ligne).toMatchObject({ admin_user_id: a.id, admin_email: garde.email, result: 'SUCCESS' });
    expect(JSON.parse(ligne.details)).toMatchObject({ reason: MOTIF, accountId: compte.id, operationId: op76, reviewId: sep.id });
    expect(ligne.old_value).toMatchObject({ reviewStatus: 'APPLIED', operationId: op76, fileId: docs[0], candidateOperationId: maisonOp });
    expect(ligne.new_value).toMatchObject({ reviewStatus: 'REVERTED', decision: 'CONFIRMED', origin: 'ADMIN_REVIEW', operationId: op76 });

    // Le moteur T3 réapplique la décision (mécanismes existants) : TCO, dates, agenda.
    await k.passer(compte);
    expect(await sourcesActives(op76)).toEqual([fTika, docs[0]]);
    expect(await sourcesActives(maisonOp)).toEqual([docs[1]]);
    expect(await realise(op76)).toBe(27735 + 49_000_000);
    expect(await realise(maisonOp)).toBe(49_000_000);
    const ops = await k.operations(compte);
    // Fondatrice conservée (date, prestataire) ; la maison prend la date de l'attestation (seule source restante).
    expect(ops.find((o) => o.id === op76)).toMatchObject({ realized_date: '2025-05-12', provider: 'Tikamoon' });
    expect(ops.find((o) => o.id === maisonOp)).toMatchObject({ realized_date: '2021-07-02' });
    const projection = await import('@/services/business-operations/agenda-projection/service');
    await projection.projectAccountOperations(compte.id, { all: true, today: RECETTE_TODAY });
    const agenda = (opId: number) => sql<{ start_date: string }[]>`SELECT start_date::text AS start_date FROM agenda_items WHERE account_id = ${compte.id} AND business_operation_id = ${opId} ORDER BY id`;
    expect((await agenda(maisonOp)).map((x) => x.start_date)).toEqual(['2021-07-02']);
    expect((await agenda(op76)).map((x) => x.start_date)).toEqual(['2025-05-12']);

    // Détail BO : plus de bouton, trace « Rétablie par … le … — motif : … » ; décision visible.
    const d = await detailBo(op76);
    const rev = d.identityReviews!.find((x) => Number(x.id) === sep.id)!;
    expect(rev).toMatchObject({ status: 'REVERTED', restore: null, restoredBy: { adminId: a.id, adminEmail: garde.email, reason: MOTIF } });
    expect(d.matchDecisions.map((m) => [m.decision, m.origin, m.reason_code])).toContainEqual(['CONFIRMED', 'ADMIN_REVIEW', 'ADMIN_IDENTITY_SEPARATION_REVERTED']);
    const { renderToStaticMarkup } = await import('react-dom/server');
    const React = await import('react');
    (globalThis as { React?: unknown }).React = React;
    const { OperationDetailView } = await import('@/app/admin/operations/_components/views');
    expect(renderToStaticMarkup(React.createElement(OperationDetailView, { d }))).toContain(`Rétablie par ${garde.email} le `);
    // L'autre séparation (attestation) reste rétablissable, indépendamment.
    expect(d.identityReviews!.find((x) => Number(x.id) === separations[1].id)!.restore).not.toBeNull();
  });

  it('L79A-E02 — jamais re-séparé : réévaluation complète (balayage horaire), passages répétés, reconsolidation ; aucune anomalie IDENTITY_*, Supervision résolue', async () => {
    // Supervision : l'anomalie liée (contradiction d'attributs du composite #76) est ouverte par le contrôle qualité.
    const { runOperationsQualityCheck } = await import('@/services/business-operations/diagnostics/alerts');
    const { OperationDiagnosticsService } = await import('@/services/business-operations/diagnostics/service');
    const anomalies = await import('@/services/admin/anomaly.service');
    const fp = 'other:business-operations:identity_attribute_conflict';
    const ouverte = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_anomalies WHERE fingerprint = ${fp} AND status = 'open'`)[0].n;
    const controle = (accountId: number) => runOperationsQualityCheck({
      detect: () => new OperationDiagnosticsService().hardAnomalies(accountId),
      openFingerprints: async () => (await sql<{ fingerprint: string }[]>`SELECT fingerprint FROM admin_anomalies WHERE status = 'open' AND fingerprint LIKE 'other:business-operations:%'`).map((x) => x.fingerprint),
      report: anomalies.reportAnomaly,
      resolve: (f) => anomalies.autoResolveAnomaly(f, { origin: 'operations_quality_check_cleared', cause: 'test L79A' }),
    });
    const { compte, op76, docs, separations, fTika } = await separe(async (accountId) => {
      await controle(accountId);
      expect(await ouverte()).toBe(1);
    });

    await admin();
    expect((await post(op76, separations[0].id, { reason: MOTIF })).status).toBe(200);
    await k.passer(compte);
    expect(await sourcesActives(op76)).toEqual([fTika, docs[0]]);

    // Réévaluation du stock entier (changement de version de contrôle / stock non estampillé) : le balayage
    // horaire prend le compte et repasse TOUS les candidats — la source rétablie n'est jamais re-séparée.
    const { listAccountsToConsolidate } = await import('@/services/business-operations/consolidation/consolidator');
    for (let i = 0; i < 2; i++) {
      await sql`UPDATE document_operation_candidates SET t3_detail = t3_detail - 'identityReview' WHERE account_id = ${compte.id}`;
      expect(await listAccountsToConsolidate(compte.id - 1, 10)).toContain(compte.id);
      expect((await k.passer(compte)).identityReviewMarked).toBeGreaterThan(0);
      await k.passer(compte);
    }
    const { reconsolidateAllActiveOperations } = await import('@/services/business-operations/consolidation/queue');
    await reconsolidateAllActiveOperations(compte.id, { today: RECETTE_TODAY });
    expect(await sourcesActives(op76)).toEqual([fTika, docs[0]]);
    expect(await realise(op76)).toBe(27735 + 49_000_000);
    const journal = await sql<{ kind: string; status: string; file_id: number }[]>`
      SELECT kind, status, file_id FROM business_operation_identity_reviews WHERE account_id = ${compte.id} ORDER BY id`;
    expect(journal.filter((j) => j.file_id === docs[0])).toEqual([{ kind: 'SEPARATED', status: 'REVERTED', file_id: docs[0] }]);
    expect(journal.filter((j) => j.status === 'OPEN')).toEqual([]);
    // Contradiction fondatrice / source rétablie : arbitrée au BO (tracée à part), plus « à examiner ».
    const [p] = await sql<{ p: { conflicts: unknown[]; arbitratedConflicts?: Array<{ field: string }> } }[]>`SELECT attribute_provenance AS p FROM business_operations WHERE id = ${op76}`;
    expect(p.p.conflicts).toEqual([]);
    expect(p.p.arbitratedConflicts?.map((c) => c.field)).toEqual(['realizedDate', 'provider']);
    expect(await k.anomaliesDures(compte.id)).toEqual({});
    // Stable : un passage de plus n'écrit rien.
    const h = await k.historique(compte);
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE account_id = ${compte.id} AND status = 'ACTIVE'`;
    await k.passer(compte);
    expect(await k.historique(compte)).toBe(h);
    // L'anomalie de Supervision liée est résolue par le contrôle qualité (SUP-008).
    const res = await controle(compte.id);
    expect(res.counts.IDENTITY_ATTRIBUTE_CONFLICT).toBe(0);
    expect(await ouverte()).toBe(0);
  });

  it('L79A-E03 — idempotence et concurrence : double clic puis deux administrateurs simultanés → un seul rétablissement', async () => {
    const { compte, op76, maisonOp, separations } = await separe();
    const a1 = await admin();
    expect((await post(op76, separations[0].id, { reason: MOTIF })).status).toBe(200);
    // Double clic : refus clair, aucune seconde décision.
    const bis = await post(op76, separations[0].id, { reason: MOTIF });
    expect(bis).toMatchObject({ status: 409, body: { code: 'ALREADY_RESTORED', error: 'Cette séparation a déjà été rétablie.' } });
    expect((await decisionsAdmin(compte.id))[0].n).toBe(1);

    // Deux administrateurs au même instant sur l'autre séparation (depuis deux Opérations affichées).
    const a2 = await make.user({ role: 'ADMIN' });
    const { revertIdentitySeparation, IdentityRestoreRefusedError } = await import('@/services/business-operations/consolidation/identity-review');
    const res = await Promise.allSettled([
      revertIdentitySeparation(separations[1].id, { adminId: a1.id, operationId: op76, reason: MOTIF }),
      revertIdentitySeparation(separations[1].id, { adminId: a2.id, operationId: maisonOp, reason: MOTIF }),
    ]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const refus = res.find((x): x is PromiseRejectedResult => x.status === 'rejected')!.reason;
    expect(refus).toBeInstanceOf(IdentityRestoreRefusedError);
    expect((refus as InstanceType<typeof IdentityRestoreRefusedError>).code).toBe('ALREADY_RESTORED');
    expect((await decisionsAdmin(compte.id))[0].n).toBe(2);
    expect((await audit(separations[1].id)).map((l) => l.result)).toEqual(['SUCCESS']);
    expect((await audit(separations[0].id)).map((l) => l.result)).toEqual(['SUCCESS', 'DENIED']);
  });

  it('L79A-E04 — refus : non-admin, autre compte, Opération sans rapport, source supprimée, origine fusionnée ou invalidée', async () => {
    const A = await separe();
    const B = await separe();
    await admin();
    // Non-admin / sans session : refusé avant tout accès.
    garde.refus = 'INSUFFICIENT_PERMISSIONS';
    expect((await post(A.op76, A.separations[0].id, { reason: MOTIF })).status).toBe(403);
    garde.refus = 'AUTH_REQUIRED';
    expect((await post(A.op76, A.separations[0].id, { reason: MOTIF })).status).toBe(401);
    garde.refus = null;
    expect(await audit(A.separations[0].id)).toEqual([]);
    // Séparation d'un AUTRE compte demandée depuis une Opération du compte A : introuvable.
    expect(await post(A.op76, B.separations[0].id, { reason: MOTIF })).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
    // Opération du même compte sans rapport avec la séparation : introuvable.
    const autreOp = (await k.actives(A.compte)).find((o) => o.id !== A.op76 && o.id !== A.maisonOp);
    if (autreOp) expect((await post(autreOp.id, A.separations[0].id, { reason: MOTIF })).status).toBe(404);
    expect((await decisionsAdmin(A.compte.id))[0].n).toBe(0);
    expect((await decisionsAdmin(B.compte.id))[0].n).toBe(0);

    // Source supprimée depuis : bouton retiré, refus clair.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${A.docs[0]}`;
    expect((await detailBo(A.op76)).identityReviews!.find((x) => Number(x.id) === A.separations[0].id)).toMatchObject({ restore: null, restore_block: 'SOURCE_DELETED' });
    expect(await post(A.op76, A.separations[0].id, { reason: MOTIF })).toMatchObject({ status: 409, body: { code: 'SOURCE_DELETED' } });
    // Opération d'origine invalidée puis fusionnée depuis.
    await sql`UPDATE business_operations SET invalidated_at = now(), invalidation_reason = 'TEST' WHERE id = ${B.op76}`;
    expect(await post(B.op76, B.separations[0].id, { reason: MOTIF })).toMatchObject({ status: 409, body: { code: 'ORIGIN_INVALIDATED' } });
    await sql`UPDATE business_operations SET merged_into_operation_id = ${B.maisonOp} WHERE id = ${B.op76}`;
    expect(await post(B.maisonOp, B.separations[1].id, { reason: MOTIF })).toMatchObject({ status: 409, body: { code: 'ORIGIN_MERGED' } });
    expect((await detailBo(B.maisonOp)).identityReviews!.every((x) => x.restore === null)).toBe(true);
    // Rien n'a été rétabli ; chaque refus est journalisé (DENIED) avec son code.
    expect((await decisionsAdmin(A.compte.id))[0].n + (await decisionsAdmin(B.compte.id))[0].n).toBe(0);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_identity_reviews WHERE account_id = ANY(${[A.compte.id, B.compte.id]}) AND status = 'REVERTED'`)[0].n).toBe(0);
    expect((await audit(B.separations[0].id)).map((l) => [l.result, JSON.parse(l.details).code])).toEqual([['DENIED', 'NOT_FOUND'], ['DENIED', 'ORIGIN_INVALIDATED']]);
    expect((await audit(A.separations[0].id)).map((l) => [l.result, JSON.parse(l.details).code])).toEqual(
      autreOp ? [['DENIED', 'NOT_FOUND'], ['DENIED', 'SOURCE_DELETED']] : [['DENIED', 'SOURCE_DELETED']]);
  });

  it('L79A-E05 — export de diagnostic 77C : rétablissement (admin, motif, avant / après) dans tracabilite/identite-economique.json', async () => {
    const { compte, op76, separations } = await separe();
    const a = await admin();
    expect((await post(op76, separations[0].id, { reason: MOTIF })).status).toBe(200);
    await k.passer(compte);
    const { generateDiagnostic } = await import('@/services/admin/diagnostics-export/collect');
    const b = await generateDiagnostic({ scope: 'operation', id: op76, reinforced: false }, { adminUserId: a.id });
    const identite = JSON.parse(b.files.find((x) => x.path === 'tracabilite/identite-economique.json')!.content) as {
      journal: Array<{ id: number; status: string; resolved_by_admin_id: number }>; retablissements: Array<Record<string, any>>;
    };
    expect(identite.journal.find((j) => Number(j.id) === separations[0].id)).toMatchObject({ status: 'REVERTED', resolved_by_admin_id: a.id });
    expect(identite.retablissements).toEqual([expect.objectContaining({
      admin_user_id: a.id, separation_id: separations[0].id, resultat: 'SUCCESS', motif: MOTIF, operation_affichee: op76,
      avant: expect.objectContaining({ reviewStatus: 'APPLIED' }), apres: expect.objectContaining({ reviewStatus: 'REVERTED', origin: 'ADMIN_REVIEW' }),
    })]);
    // Aucune adresse e-mail d'administrateur dans l'export.
    expect(JSON.stringify(identite.retablissements)).not.toContain(garde.email);
  });
});
