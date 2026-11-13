/**
 * Lot 113AQ (Trello #750 + #751, anomalie BO #12) — contradictions d'attributs
 * d'Opération sur PostgreSQL 16 réel, par les chemins de PRODUCTION :
 * persistance T1 des candidats, reconsolidation T3, contrôle de cohérence
 * (orchestrateur réel), contrôle qualité planifié (`runOperationsQualityCheck`),
 * Supervision (`admin_anomalies` / occurrences), route BO réelle (garde
 * administrateur réelle, seule la lecture du cookie est simulée), export 113AI.
 * Aucun appel IA (aucune branche T3 sollicitée).
 *
 *   L113AQ-E2E-01  faux conflits d'avant (paiement / réalisation, banque / intervenant / facturant) : aucun conflit,
 *                  faits consultables, aucune anomalie ; relevé ANCIEN (v1) → anomalie, contrôle COH-OPS-ATTRIBUTE-CONFLICTS
 *                  le requalifie (reconsolidation ciblée), sans écrire aucune valeur ni effet de bord ; idempotent
 *   L113AQ-E2E-02  conflit réel (même référence, deux dates) : détecté avec les deux valeurs et leurs sources ; valeur
 *                  retenue inchangée ; rejeu sans écriture
 *   L113AQ-E2E-03  Supervision : relevé structuré par compte ↔ Opération ; balayages identiques sans nouvelle occurrence ;
 *                  évolution de population = nouvelle occurrence ; diagnostic écran = export JSON / Markdown ; lecture
 *                  sans mutation ni IA ; droits ; contrôle T3 en échec → « non vérifiable » ; conflit corrigé → hors actif
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { runCoherenceFor, proofOf } from '../coherence-run';
import { RECETTE_TODAY, cand, cible, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow } from '../factories';

type Json = Record<string, any>;

scenario('L113AQ', 'Opérations — contradictions d’attributs qualifiées et diagnostic BO #12 (#750, #751)', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const session = { userId: 0, role: 'USER', email: '' };
  let NextRequest: typeof import('next/server').NextRequest;
  type Route = (r: import('next/server').NextRequest, c?: unknown) => Promise<Response>;
  let conflictsRoute: Route;
  let exportRoute: Route;
  const req = (url: string) => new NextRequest(`http://app.test${url}`, { headers: { origin: 'http://app.test', host: 'app.test' } });
  const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

  beforeAll(async () => {
    ({ NextRequest } = await import('next/server'));
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    conflictsRoute = (await import('@/app/api/admin/anomalies/[id]/conflicts/route')).GET as Route;
    exportRoute = (await import('@/app/api/admin/anomalies/[id]/export/route')).GET as Route;
    await import('@/services/business-operations/consolidation/queue');
  });
  afterAll(() => { vi.restoreAllMocks(); });

  const prov = async (opId: number) => (await sql<{ p: Json }[]>`SELECT attribute_provenance AS p FROM business_operations WHERE id = ${opId}`)[0].p;
  const histo = async (opId: number) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_history WHERE operation_id = ${opId}`)[0].n;

  /** Opération créée par T3 depuis un premier document, puis sources RATTACHÉES (rattachement historique, sans IA). */
  async function operation(compte: AccountRow, premier: ReturnType<typeof cand>, autres: Array<{ c: ReturnType<typeof cand>; role: string }>, assetId: number) {
    await k.document(compte, assetId, [premier]);
    await k.passer(compte);
    const [op] = await k.actives(compte);
    const fichiers: number[] = [];
    for (const a of autres) fichiers.push(await k.document(compte, assetId, [a.c]));
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(compte.id, async (repo, s) => {
      for (const [i, f] of fichiers.entries()) {
        const [c] = await sql<{ id: number; candidate_key: string }[]>`SELECT id, candidate_key FROM document_operation_candidates WHERE file_id = ${f} AND status = 'ACTIVE'`;
        const version = `c${c.id}|a${assetId}|t`;
        const sid = await repo.addSource(op.id, {
          kind: 'DOCUMENT', entityKey: f, version, role: autres[i].role as never, locator: { candidateKey: c.candidate_key }, authority: 'DOCUMENT',
          confidence: 'certain', matchMethod: 'M1', matchReason: 'E2E_L113AQ',
        }, 'T3_MATCH_AND_ENRICH');
        await repo.refreshSourceVersion(sid, version);
        await s.tx.execute((await import('drizzle-orm')).sql`
          UPDATE document_operation_candidates SET t3_pending = false, t3_processed_at = now(), t3_outcome = 'MATCH_AND_ENRICH', t3_reason = 'MATCH_M1',
                 t3_operation_id = ${op.id} WHERE id = ${c.id}`);
      }
    });
    const { reconsolidateOperations } = await import('@/services/business-operations/consolidation/consolidator');
    await reconsolidateOperations(compte.id, [op.id], { today: RECETTE_TODAY, syncCards: false });
    return { opId: op.id, fichiers };
  }

  const plomberie = (assetId: number, over: Parameters<typeof cand>[0] = {}) => cand({
    typeHint: 'INTERVENTION', summary: 'Remplacement du chauffe-eau', provider: 'Plomberie Durand', sourceRoleHint: 'INVOICE',
    targetHints: [cible(assetId)], businessReferences: [ref('INVOICE', 'FA-2024-001')], temporalHints: { realizedDate: '2024-01-10' }, ...over,
  });

  // ── E01 ──────────────────────────────────────────────────────────────────
  it('L113AQ-E2E-01 — faux conflits d’avant : aucun conflit, faits consultables ; relevé v1 requalifié par COH-OPS-ATTRIBUTE-CONFLICTS sans effet de bord', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const { opId } = await operation(compte, plomberie(maison.id), [
      { c: plomberie(maison.id, { summary: 'Prélèvement', provider: 'Banque Populaire', sourceRoleHint: 'PAYMENT_PROOF', businessReferences: [], temporalHints: { realizedDate: '2025-03-20' } }), role: 'PAYMENT_PROOF' },
      { c: plomberie(maison.id, { summary: 'Rapport de mise en service', provider: 'Diagnostics Ouest', sourceRoleHint: 'REPORT', businessReferences: [], temporalHints: {} }), role: 'REPORT' },
    ], maison.id);
    const p = await prov(opId);
    expect(p).toMatchObject({ version: 2, rules: 'iac-113aq-v2', conflicts: [] });
    expect(p.divergences.map((x: Json) => [x.field, x.qualification, x.reasonCode]).sort()).toEqual([
      ['provider', 'LEGITIMATE_DIFFERENCE', 'ROLES_DIFFER'], ['realizedDate', 'LEGITIMATE_DIFFERENCE', 'ROLES_DIFFER'],
    ]);
    expect(await k.anomaliesDures(compte.id)).not.toHaveProperty('IDENTITY_ATTRIBUTE_CONFLICT');
    const [op] = await k.actives(compte);
    expect(op).toMatchObject({ provider: 'Plomberie Durand' });

    // Les AUTRES contrôles de la campagne (projection Agenda…) sont d'abord stabilisés : l'état comparé ensuite
    // ne peut changer que par COH-OPS-ATTRIBUTE-CONFLICTS.
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE', today: RECETTE_TODAY });
    expect(await sql`SELECT id FROM coherence_repairs WHERE account_id = ${compte.id} AND check_id = 'COH-OPS-ATTRIBUTE-CONFLICTS'`).toHaveLength(0);
    // Stock historique : relevé ANCIEN (version 1, sans rôle ni qualification) tel que persisté avant 113AQ.
    const v1 = { version: 1, fields: p.fields, conflicts: p.divergences.map((x: Json) => ({ field: x.field, values: x.values.map((v: Json) => ({ value: v.value, sourceIds: v.sourceIds })), retained: x.retained })) };
    await sql`UPDATE business_operations SET attribute_provenance = ${JSON.stringify(v1)}::jsonb WHERE id = ${opId}`;
    expect(await k.anomaliesDures(compte.id)).toMatchObject({ IDENTITY_ATTRIBUTE_CONFLICT: 1 });
    const { readConflictDiagnostic } = await import('@/services/business-operations/diagnostics/attribute-conflicts-read');
    const avantDiag = await readConflictDiagnostic({ accountId: compte.id });
    expect(avantDiag.conflicts.map((e) => [e.attribute.key, e.qualification, e.reasonCode, e.lineState]).sort()).toEqual([
      ['provider', 'INSUFFICIENT_EVIDENCE', 'LEGACY_RULES_NOT_RECHECKED', 'NON_VERIFIABLE'], ['realizedDate', 'INSUFFICIENT_EVIDENCE', 'LEGACY_RULES_NOT_RECHECKED', 'NON_VERIFIABLE'],
    ].sort());

    // AC15 : aucune autre donnée touchée par la requalification (agenda, composantes, valeurs, historique).
    const etat = async () => ({
      op: (await k.actives(compte)).find((o) => o.id === opId),
      comp: await k.composantes(opId),
      agenda: await sql`SELECT id, start_date::text AS d, title FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`,
      histo: await histo(opId),
    });
    const avant = await etat();
    const r = await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE', today: RECETTE_TODAY });
    expect(r.results['COH-OPS-ATTRIBUTE-CONFLICTS']).toBeDefined();
    const reparations = await sql<Json[]>`SELECT outcome, result FROM coherence_repairs WHERE account_id = ${compte.id} AND check_id = 'COH-OPS-ATTRIBUTE-CONFLICTS' ORDER BY id`;
    expect(reparations).toHaveLength(1);
    expect(reparations[0].outcome).toBe('REPAIRED');
    expect(reparations[0].result).toMatchObject({ requalified: true, before: { rulesVersion: 1, conflicts: 2 }, after: { rulesVersion: 2, conflicts: 0, divergences: 2 } });
    expect((await prov(opId)).version).toBe(2);
    expect(await k.anomaliesDures(compte.id)).not.toHaveProperty('IDENTITY_ATTRIBUTE_CONFLICT');
    // Rejeu : plus rien à requalifier, aucune nouvelle réparation. Pendant que le relevé v1 était persisté, la
    // projection Agenda (83A) avait retiré la date de l'événement principal à cause de la FAUSSE contradiction ;
    // une fois requalifiée, la campagne suivante la rétablit : état final identique à l'état d'avant, rien d'autre touché.
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE', today: RECETTE_TODAY });
    expect(await etat()).toEqual(avant);
    expect(await sql`SELECT id FROM coherence_repairs WHERE account_id = ${compte.id} AND check_id = 'COH-OPS-ATTRIBUTE-CONFLICTS'`).toHaveLength(1);
    // Preuve conservée de la réparation (l'objet n'est plus dans le périmètre du contrôle : aucun recontrôle répété).
    expect(await proofOf(sql, compte.id, 'COH-OPS-ATTRIBUTE-CONFLICTS', opId)).toMatchObject({ last_result: 'REPAIRED', finding: null });
  });

  // ── E02 ──────────────────────────────────────────────────────────────────
  it('L113AQ-E2E-02 — conflit réel (même référence, deux dates) : détecté avec les deux valeurs et leurs sources, valeur retenue inchangée, rejeu sans écriture', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const { opId, fichiers } = await operation(compte, plomberie(maison.id, { businessReferences: [ref('INVOICE', 'F-77')], temporalHints: { realizedDate: '2023-02-01' } }), [
      { c: plomberie(maison.id, { businessReferences: [ref('INVOICE', 'F-77')], temporalHints: { realizedDate: '2025-02-01' } }), role: 'INVOICE' },
    ], maison.id);
    const p = await prov(opId);
    expect(p.conflicts).toEqual([expect.objectContaining({ field: 'realizedDate', role: 'REALIZATION', qualification: 'REAL_CONFLICT_UNRESOLVED', reasonCode: 'SAME_REFERENCE' })]);
    expect(p.conflicts[0].values.map((v: Json) => v.value)).toEqual(['2023-02-01', '2025-02-01']);
    expect(await k.anomaliesDures(compte.id)).toMatchObject({ IDENTITY_ATTRIBUTE_CONFLICT: 1 });
    const { readConflictDiagnostic } = await import('@/services/business-operations/diagnostics/attribute-conflicts-read');
    const d = await readConflictDiagnostic({ accountId: compte.id });
    expect(d.conflicts).toHaveLength(1);
    expect(d.conflicts[0]).toMatchObject({ accountId: compte.id, operationId: opId, lineState: 'ACTIVE', qualification: 'REAL_CONFLICT_UNRESOLVED' });
    expect(d.conflicts[0].values.map((v) => v.sources.map((s) => s.fileId)).flat()).toEqual(expect.arrayContaining([fichiers[0]]));
    expect(d.conflicts[0].persistedValue).toBe((await k.actives(compte))[0].realized_date);
    const h = await histo(opId);
    const { reconsolidateOperations } = await import('@/services/business-operations/consolidation/consolidator');
    const avant = JSON.stringify(await prov(opId));
    for (let i = 0; i < 3; i++) await reconsolidateOperations(compte.id, [opId], { today: RECETTE_TODAY, syncCards: false });
    expect(JSON.stringify(await prov(opId))).toBe(avant);
    expect(await histo(opId)).toBe(h);
  });

  // ── E03 ──────────────────────────────────────────────────────────────────
  it('L113AQ-E2E-03 — Supervision : relevé structuré, balayages identiques sans occurrence, évolution de population, écran = export, lecture seule, droits', async () => {
    // Base de scénario partagée par les tests du fichier : les relevés des tests précédents sont neutralisés
    // (le contrôle qualité lit TOUTES les Opérations, comme en exploitation).
    await sql`UPDATE business_operations SET attribute_provenance = NULL`;
    const admin = await make.user({ role: 'ADMIN' });
    const simple = await make.user();
    const a = await make.account({ plan: 'premium' });
    const maisonA = await make.asset(a, { category: 'IMMOBILIER', name: 'Maison A' });
    const opA = (await operation(a, plomberie(maisonA.id, { businessReferences: [ref('INVOICE', 'F-1')], temporalHints: { realizedDate: '2022-01-01' } }), [
      { c: plomberie(maisonA.id, { businessReferences: [ref('INVOICE', 'F-1')], temporalHints: { realizedDate: '2024-06-01' } }), role: 'INVOICE' },
    ], maisonA.id)).opId;

    const anomalies = await import('@/services/admin/anomaly.service');
    const { runOperationsQualityCheck } = await import('@/services/business-operations/diagnostics/alerts');
    const { OperationDiagnosticsService } = await import('@/services/business-operations/diagnostics/service');
    const { alertingConflictLines } = await import('@/services/business-operations/diagnostics/attribute-conflicts-read');
    const FP = 'other:business-operations:identity_attribute_conflict';
    const controle = () => runOperationsQualityCheck({
      detect: () => new OperationDiagnosticsService().hardAnomalies(null),
      openFingerprints: async () => (await sql<{ fingerprint: string }[]>`SELECT fingerprint FROM admin_anomalies WHERE status = 'open' AND fingerprint LIKE 'other:business-operations:%'`).map((x) => x.fingerprint),
      report: anomalies.reportAnomaly, reportDetailed: anomalies.reportAnomalyDetailed,
      resolve: (f) => anomalies.autoResolveAnomaly(f, { origin: 'operations_quality_check_cleared', cause: 'test L113AQ' }),
      conflictLines: () => alertingConflictLines(),
    });
    const anomalie = async () => (await sql<Json[]>`SELECT id, status, occurrence_count, technical_detail FROM admin_anomalies WHERE fingerprint = ${FP} ORDER BY id DESC LIMIT 1`)[0];

    await controle();
    const a1 = await anomalie();
    expect(a1).toMatchObject({ status: 'open', occurrence_count: 1 });
    expect(a1.technical_detail).toMatchObject({ code: 'IDENTITY_ATTRIBUTE_CONFLICT', contract: 'verebona.operation-attribute-conflicts/1',
      conflicts: [`${a.id}:${opA}:realizedDate:REAL_CONFLICT_UNRESOLVED`], conflictsTotal: 1, byQualification: { REAL_CONFLICT_UNRESOLVED: 1 } });
    // AC08 : balayages identiques → aucune nouvelle occurrence matérielle (le journal de la tâche les garde).
    for (let i = 0; i < 3; i++) expect((await controle()).unchanged).toBe(1);
    expect((await anomalie()).occurrence_count).toBe(1);
    expect(await sql`SELECT id FROM admin_anomaly_occurrences WHERE anomaly_id = ${a1.id}`).toHaveLength(1);

    // Évolution de population (nouvelle Opération, autre compte) : occurrence justifiée.
    const b = await make.account({ plan: 'premium' });
    const maisonB = await make.asset(b, { category: 'IMMOBILIER', name: 'Maison B' });
    const opB = (await operation(b, plomberie(maisonB.id, { provider: 'Alpha', businessReferences: [ref('ORDER', 'C-9')], temporalHints: {} }), [
      { c: plomberie(maisonB.id, { provider: 'Beta', sourceRoleHint: 'ORDER', businessReferences: [ref('ORDER', 'C-9')], temporalHints: {} }), role: 'ORDER' },
    ], maisonB.id)).opId;
    expect((await controle()).unchanged).toBe(0);
    expect((await anomalie()).occurrence_count).toBe(2);

    // Lecture BO : droits, contrat, compte EXPLICITE par entrée, sans mutation ni IA.
    const photo = async () => ({
      ops: await sql`SELECT id, attribute_provenance, last_reconciled_at, realized_date, provider FROM business_operations ORDER BY id`,
      an: await sql`SELECT id, occurrence_count, technical_detail, updated_at FROM admin_anomalies ORDER BY id`,
      occ: (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_anomaly_occurrences`)[0].n,
      ia: (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_usage_events`)[0].n,
      cartes: (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM to_process_actions`)[0].n,
    });
    const avant = await photo();
    Object.assign(session, { userId: simple.id, role: 'USER', email: simple.email });
    expect((await conflictsRoute(req(`/api/admin/anomalies/${a1.id}/conflicts`), ctx(a1.id))).status).toBe(403);
    expect((await conflictsRoute(req('/api/admin/anomalies/999999/conflicts'), ctx(999999))).status).toBe(403);
    Object.assign(session, { userId: admin.id, role: 'ADMIN', email: admin.email });
    expect((await conflictsRoute(req(`/api/admin/anomalies/${a1.id}/conflicts?page=0`), ctx(a1.id))).status).toBe(400);
    const res = await conflictsRoute(req(`/api/admin/anomalies/${a1.id}/conflicts`), ctx(a1.id));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { diagnostic } = await res.json() as { diagnostic: Json };
    expect(diagnostic).toMatchObject({ contract: 'verebona.operation-attribute-conflicts', contractVersion: 1, readOnly: true, complete: true });
    expect(diagnostic.conflicts.map((e: Json) => [e.accountId, e.operationId, e.attribute.key, e.role.code, e.qualification, e.lineState])).toEqual([
      [a.id, opA, 'realizedDate', 'REALIZATION', 'REAL_CONFLICT_UNRESOLVED', 'ACTIVE'],
      [b.id, opB, 'provider', 'SUPPLIER', 'REAL_CONFLICT_UNRESOLVED', 'ACTIVE'],
    ].sort((x, y) => Number(x[0]) - Number(y[0])));
    expect(diagnostic.counters).toMatchObject({ occurrences: 2, materialOccurrences: 2, periodicReports: 0, operations: 2, activeConflicts: 2, legitimateDifferences: 0 });
    expect(diagnostic.occurrences.map((o: Json) => o.kind)).toEqual(['POPULATION_CHANGE', 'FIRST']);
    expect(diagnostic.alert).toMatchObject({ anomalyStatus: 'open', maintainedBy: 'ACTIVE_CONFLICTS' });
    // Écran = export JSON = Markdown (même service).
    const ej = await exportRoute(req(`/api/admin/anomalies/${a1.id}/export?format=json`), ctx(a1.id));
    const doc = await ej.json() as Json;
    expect(doc).toMatchObject({ format: 'verebona.bo-anomalies/2', complete: true });
    const section = doc.items[0].conflitsAttributs;
    expect(section).toMatchObject({ contrat: 'verebona.operation-attribute-conflicts/1', complet: true, erreur: null });
    expect(section.diagnostic.conflicts.map((e: Json) => [e.accountId, e.operationId, e.attribute.key, e.qualification]))
      .toEqual(diagnostic.conflicts.map((e: Json) => [e.accountId, e.operationId, e.attribute.key, e.qualification]));
    const md = await (await exportRoute(req(`/api/admin/anomalies/${a1.id}/export?format=md`), ctx(a1.id))).text();
    expect(md).toContain('### Contradictions d’attributs par Opération');
    expect(md).toContain(`| #${a.id} | #${opA} | Date de réalisation |`);
    expect(md).toContain('2022-01-01 [réalisation');
    const audit = await sql<{ details: string }[]>`SELECT details FROM admin_audit_log WHERE action_type = 'ANOMALY_EXPORT' AND target_id = ${a1.id} ORDER BY id DESC LIMIT 2`;
    expect(audit.map((x) => (JSON.parse(x.details) as Json).conflicts)).toEqual([expect.objectContaining({ complete: true }), expect.objectContaining({ complete: true })]);
    // Aucune mutation métier, aucun appel IA, aucune carte à la lecture.
    expect(await photo()).toEqual(avant);
    // Une autre famille d'anomalie : diagnostic non applicable, comportement inchangé.
    const autre = (await anomalies.reportAnomaly({ domain: 'other', fingerprint: 'other:e2e:l113aq', title: 'Autre', detail: { code: 'AUTRE' } }))!;
    expect((await conflictsRoute(req(`/api/admin/anomalies/${autre}/conflicts`), ctx(autre))).status).toBe(404);
    expect((await (await exportRoute(req(`/api/admin/anomalies/${autre}/export?format=json`), ctx(autre))).json() as Json).items[0].conflitsAttributs).toBeUndefined();

    // AC06 : contrôle T3 non achevé (erreur technique) → « non vérifiable » motivé, jamais une fermeture.
    await sql`UPDATE document_operation_candidates SET t3_reason = 'TECHNICAL_ERROR:PROVIDER_UNAVAILABLE' WHERE account_id = ${b.id} AND t3_operation_id = ${opB}`;
    const d2 = (await (await conflictsRoute(req(`/api/admin/anomalies/${a1.id}/conflicts`), ctx(a1.id))).json() as Json).diagnostic;
    expect(d2.conflicts.find((e: Json) => e.operationId === opB)).toMatchObject({ qualification: 'CHECK_FAILED', lineState: 'NON_VERIFIABLE', lastCheck: { result: 'FAILED' } });
    expect(d2.alert.maintainedBy).toBe('BOTH');
    await sql`UPDATE document_operation_candidates SET t3_reason = 'MATCH_M1' WHERE account_id = ${b.id} AND t3_operation_id = ${opB}`;

    // AC07 : conflit de B corrigé (source retirée, reconsolidation) → hors compteur actif ; A reste ouvert ; historique conservé.
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const [srcB] = await sql<{ id: number }[]>`SELECT id::int AS id FROM business_operation_sources WHERE operation_id = ${opB} AND source_role = 'ORDER'`;
    await withBusinessOperationWrite(b.id, async (repo) => { await repo.deactivateSource(srcB.id, 'E2E_L113AQ_CORRECTION'); });
    const { reconsolidateOperations } = await import('@/services/business-operations/consolidation/consolidator');
    await reconsolidateOperations(b.id, [opB], { today: RECETTE_TODAY, syncCards: false });
    await controle();
    const a3 = await anomalie();
    expect(a3).toMatchObject({ status: 'open', occurrence_count: 3 });
    expect(a3.technical_detail.conflicts).toEqual([`${a.id}:${opA}:realizedDate:REAL_CONFLICT_UNRESOLVED`]);
    const d3 = (await (await conflictsRoute(req(`/api/admin/anomalies/${a1.id}/conflicts`), ctx(a1.id))).json() as Json).diagnostic;
    expect(d3.counters).toMatchObject({ activeConflicts: 1, operations: 1, occurrences: 3 });
    expect(d3.occurrences.map((o: Json) => o.kind)).toEqual(['POPULATION_CHANGE', 'POPULATION_CHANGE', 'FIRST']);
  });
});
