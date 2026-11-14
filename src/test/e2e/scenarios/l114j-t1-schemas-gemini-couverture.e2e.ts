/**
 * Lot 114 sur base réelle — carte #776 « IA T1 / Gateway — Schémas Gemini
 * compatibles, conservation exhaustive et contrôle de couverture ».
 * Passerelle RÉELLE, fournisseur simulé par le rejeu (`replay-gateway`,
 * erreur fournisseur 400 et filtre `whenStructured`), PostgreSQL réel.
 *
 *   · E2E-L114J-01 (AC06, AC21) : mémoire durable `ai_schema_compatibility`
 *     (migration 1710) — refus idempotent, réexamen réservé par UN seul
 *     demandeur parmi des demandes concurrentes, délai doublé, réservation
 *     rendue, acceptation, état statique jamais écrasant ;
 *   · E2E-L114J-02 (AC04, AC06, AC17, AC18) : T1 — refus HTTP 400 puis réponse
 *     sans schéma → couple refusé en base, UNE alerte ; « redémarrage » →
 *     document suivant sans schéma, sans alerte de plus ; supervision lue sur
 *     les traces réelles ; échéance → un essai avec schéma, accepté → couple
 *     qualifié, alerte résolue automatiquement ;
 *   · E2E-L114J-03 (AC18) : réévaluation ciblée et idempotente des alertes —
 *     couple remplacé : résolue ; couple toujours refusé : conservée ; refus
 *     sans alerte : levée une fois ; alertes d'autres codes intactes.
 */
import { afterAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState } from '../chain';

vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: async () => undefined,
}));

const ERREUR_400 = '{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}';

type Meta = {
  providerMeta?: { structuredOutput?: string };
  providerRequest?: { responseSchemaSent: boolean; schemaOmittedReason: string | null; schemaCompat?: { state: string; decision: string; why: string; retest: boolean } };
  providerAttempts?: Array<{ kind: string; outcome: string; httpStatus: number | null; durationMs: number }>;
};

scenario('L114J', 'Schémas de sortie : mémoire partagée des refus, réexamen borné, supervision et alertes de compatibilité', ({ sql, make, useRecordings }) => {
  useTargetState();

  const C = () => import('@/services/ai/gateway/schema-compat');
  const S = () => import('@/services/ai/gateway/schema-compat/store');
  const A = () => import('@/services/ai/gateway/schema-compat/alerts');
  const CODE = 'ai_schema_incompatibility';

  const purger = async () => {
    await sql`DELETE FROM ai_schema_compatibility`;
    await sql`DELETE FROM ai_alerts WHERE code = ${CODE}`;
  };
  const alertes = async () => sql<{ id: number; resolved_at: Date | null; resolution_code: string | null; occurrences: number; details: { keyId: string; model: string }; message: string; drilldown_href: string }[]>`
    SELECT id, resolved_at, resolution_code, occurrences, details, message, drilldown_href FROM ai_alerts WHERE code = ${CODE} ORDER BY id`;
  const analyser = async (compte: { id: number; ownerUserId: number }, fileId: number, linkedAssetId: number | null) => {
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${fileId}.pdf`}, analysis_state = NULL WHERE id = ${fileId}`;
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    return analyzeFileSources([fileId], compte.id, { userId: compte.ownerUserId, linkedAssetId, billable: false, origin: 'e2e/l114j' });
  };
  const appelsT1 = async (accountId: number) => sql<{ id: number; model: string; status: string; metadata: Meta }[]>`
    SELECT id, model, status, metadata FROM ai_usage_event
     WHERE account_id = ${accountId} AND operation_code = 't1_analyze_document' ORDER BY id`;

  afterAll(async () => {
    (await C()).__enableSchemaCompatDbForTests(false);
    await purger().catch(() => undefined);
  });

  it('E2E-L114J-01 (AC06, AC21) — mémoire durable : refus idempotent, réexamen réservé une seule fois, délai doublé, acceptation', async () => {
    await purger();
    const store = await S();
    const { SCHEMA_COMPAT_POLICY: P, coupleKeyId } = await C();
    const key = { provider: 'gemini', model: 'modele-e2e-114j', operationCode: 't1_analyze_document', contractId: 'T1_ANALYZE_DOCUMENT', contractVersion: 7, schemaHash: 'aaaaaaaaaaaa', providerSchemaHash: 'bbbbbbbbbbbb', adapterVersion: 'ps-e2e' };
    const keyId = coupleKeyId(key);
    const t0 = Date.UTC(2026, 10, 13, 8, 0, 0);
    const refus = { reason: 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA' as const, httpStatus: 400, providerCode: 'INVALID_ARGUMENT', appVersion: 'sha-e2e' };

    // Premier refus : ligne créée, transition.
    const r1 = await store.recordRejection(key, refus, t0);
    expect(r1).toMatchObject({ transition: true, state: { state: 'REJECTED_CONFIRMED', rejectionCount: 1, consecutiveRejections: 1, nextRetestAt: t0 + P.firstRetestMs, lastHttpStatus: 400, lastProviderCode: 'INVALID_ARGUMENT', policyVersion: P.version, appVersion: 'sha-e2e' } });
    // Refus concurrents du même couple (requêtes parties avant la mémorisation) : idempotent, délai inchangé.
    const concurrents = await Promise.all([1, 2, 3].map((i) => store.recordRejection(key, refus, t0 + i * 10)));
    for (const c of concurrents) expect(c).toMatchObject({ transition: false, state: { consecutiveRejections: 1, nextRetestAt: t0 + P.firstRetestMs } });
    expect((await store.getCouple(keyId))!.rejectionCount).toBe(4);
    expect(await sql`SELECT 1 FROM ai_schema_compatibility WHERE key_id = ${keyId}`).toHaveLength(1);

    // Avant l'échéance : aucun réexamen réservable.
    expect(await store.claimRetest(keyId, t0 + P.firstRetestMs - 1)).toBeNull();
    // À l'échéance, 6 demandes concurrentes : UNE seule obtient l'essai.
    const du = t0 + P.firstRetestMs + 1000;
    const prises = await Promise.all(Array.from({ length: 6 }, () => store.claimRetest(keyId, du)));
    expect(prises.filter((x) => x !== null)).toHaveLength(1);
    expect(await store.getCouple(keyId)).toMatchObject({ state: 'NEEDS_RECHECK', retestCount: 1, retestClaimedUntil: du + P.retestLeaseMs });
    // La passerelle d'une autre instance connaît l'état (refus et réexamen en cours).
    expect((await store.loadKnownCouples())!.find((c) => c.keyId === keyId)?.state).toBe('NEEDS_RECHECK');

    // Réexamen refusé : délai doublé, réservation levée.
    const r2 = await store.recordRejection(key, refus, du + 50);
    expect(r2).toMatchObject({ transition: true, state: { state: 'REJECTED_CONFIRMED', consecutiveRejections: 2, rejectionCount: 5, nextRetestAt: du + 50 + 2 * P.firstRetestMs, retestClaimedUntil: null } });

    // Réexamen suivant sans conclusion : réservation rendue, court report, rien de déduit.
    const du2 = du + 50 + 2 * P.firstRetestMs + 1;
    expect(await store.claimRetest(keyId, du2)).not.toBeNull();
    expect(await store.releaseRetest(keyId, du2 + 10)).toBe(true);
    expect(await store.getCouple(keyId)).toMatchObject({ state: 'REJECTED_CONFIRMED', reason: 'RETEST_INCONCLUSIVE', consecutiveRejections: 2, nextRetestAt: du2 + 10 + P.inconclusiveRetestMs, retestClaimedUntil: null });
    expect(await store.releaseRetest(keyId, du2 + 20)).toBe(false);

    // Réservation caduque (instance arrêtée) : reprenable après son expiration seulement.
    const du3 = du2 + 10 + P.inconclusiveRetestMs + 1;
    expect(await store.claimRetest(keyId, du3)).not.toBeNull();
    expect(await store.claimRetest(keyId, du3 + 1000)).toBeNull();
    expect(await store.claimRetest(keyId, du3 + P.retestLeaseMs + 1)).not.toBeNull();

    // Acceptation par un appel réel : qualifié, compteurs remis à zéro, état antérieur rendu.
    const a1 = await store.recordAcceptance(key, 'sha-e2e-2', du3 + 2000);
    expect(a1).toMatchObject({ previous: 'NEEDS_RECHECK', state: { state: 'QUALIFIED', reason: 'ACCEPTED_ON_REAL_CALL', acceptedCount: 1, consecutiveRejections: 0, nextRetestAt: null, retestClaimedUntil: null, rejectionCount: 5 } });
    // Refus d'un couple déjà accepté : revu après le délai court.
    const r3 = await store.recordRejection(key, refus, du3 + 3000);
    expect(r3!.state).toMatchObject({ state: 'REJECTED_CONFIRMED', consecutiveRejections: 1, nextRetestAt: du3 + 3000 + P.retestAfterQualifiedMs });

    // État statique : tracé pour un couple inconnu, jamais écrasant pour un couple observé.
    expect(await store.recordUnsupported(key, 'too_complex', null, du3 + 4000)).toBe(false);
    expect((await store.getCouple(keyId))!.state).toBe('REJECTED_CONFIRMED');
    const statique = { ...key, providerSchemaHash: null, model: 'modele-e2e-114j-statique' };
    expect(await store.recordUnsupported(statique, 'too_complex', null, du3 + 4000)).toBe(true);
    expect(await store.recordUnsupported(statique, 'too_complex', null, du3 + 5000)).toBe(false);
    expect(await store.getCouple(coupleKeyId(statique))).toMatchObject({ state: 'UNSUPPORTED_BY_CONTRACT', reason: 'STATIC_too_complex', key: { providerSchemaHash: null } });
    // Matrice du BO : les deux couples, filtrés par modèle.
    expect((await store.listCouples({ model: 'modele-e2e-114j' }))!.map((c) => c.keyId)).toEqual([keyId]);
    // Aucun contenu en base : identifiants, versions, empreintes, compteurs.
    const [ligne] = await sql`SELECT * FROM ai_schema_compatibility WHERE key_id = ${keyId}`;
    expect(Object.keys(ligne).sort()).toEqual(['accepted_count', 'adapter_version', 'app_version', 'consecutive_rejections', 'contract_id', 'contract_version', 'created_at', 'first_rejected_at', 'id', 'key_id', 'last_accepted_at', 'last_http_status', 'last_provider_code', 'last_rejected_at', 'model', 'next_retest_at', 'operation_code', 'policy_version', 'provider', 'provider_schema_hash', 'reason_code', 'rejection_count', 'retest_claimed_until', 'retest_count', 'schema_hash', 'state', 'updated_at']);
  });

  it('E2E-L114J-02 (AC04, AC06, AC17, AC18) — T1 : refus mémorisé en base, connu après redémarrage, supervision et alerte, réexamen accepté', async () => {
    await purger();
    const compat = await C();
    compat.__enableSchemaCompatDbForTests(true);
    const { getSchemaUsageReport } = await import('@/services/ai/gateway/schema-compat/supervision');
    const filtre = { days: 1, operationCode: 't1_analyze_document' };
    const avant = (await getSchemaUsageReport(filtre)).totals;

    const compte = await make.account();
    const bien = await make.asset(compte);
    const sortie = (titre: string) => sortieT1({
      title: titre, date: '2026-04-24', documentTypeCode: 'MAINTENANCE_INVOICE', assets: [{ id: bien.id, label: 'Maison' }],
      facts: [{ canonicalKey: 'lastRevision', value: '2026-04-24', valueType: 'date', excerpt: 'Entretien réalisé le 24/04/2026', assetId: bien.id }],
    });

    // ── 1. Refus HTTP 400 avec schéma, réponse sans schéma (#437 conservé) ──
    const f1 = await make.assetFile(compte, { assetId: bien.id });
    let replay = await useRecordings([
      { operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', whenStructured: true, output: null, error: { message: ERREUR_400, status: 400 } },
      { operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', whenStructured: false, output: sortie('Facture entretien chaudière'), inputTokens: 13_927, outputTokens: 1790, meta: { finishReason: 'STOP' } },
    ]);
    expect((await analyser(compte, f1.id, bien.id))?.analysedCount).toBe(1);
    await drainQueues();
    await compat.__flushSchemaCompatWritesForTests();
    let rows = await appelsT1(compte.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'success' });
    expect(rows[0].metadata.providerAttempts!.map((a) => [a.kind, a.outcome, a.httpStatus])).toEqual([['initial', 'FAILED', 400], ['diagnostic_retry', 'SUCCESS', null]]);
    expect(rows[0].metadata.providerRequest!.schemaCompat).toMatchObject({ state: 'NOT_TESTED', decision: 'sent', retest: false });
    const model = rows[0].model;
    const [couple] = await sql<{ key_id: string; state: string; reason_code: string; model: string; contract_version: number; rejection_count: number; next_retest_at: Date; last_http_status: number }[]>`
      SELECT key_id, state, reason_code, model, contract_version, rejection_count, next_retest_at, last_http_status FROM ai_schema_compatibility WHERE operation_code = 't1_analyze_document'`;
    expect(couple).toMatchObject({ state: 'REJECTED_CONFIRMED', reason_code: 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA', model, contract_version: 7, rejection_count: 1, last_http_status: 400 });
    // UNE alerte de condition, sans contenu documentaire, lien vers le suivi.
    let al = await alertes();
    expect(al).toHaveLength(1);
    expect(al[0]).toMatchObject({ resolved_at: null, occurrences: 1, details: { keyId: couple.key_id, model } });
    expect(al[0].message).not.toMatch(/chaudière|Maison/);
    expect(al[0].drilldown_href).toContain('tab=schemas');
    // Le refus de schéma n'a rien écrit sur la disponibilité du modèle (#771).
    expect(await sql`SELECT 1 FROM ai_model_operational_status WHERE model = ${model} AND ok IS FALSE`).toHaveLength(0);

    // ── 2. « Redémarrage » : mémoire locale vide, la base fait foi → aucun schéma renvoyé, aucun 400 repayé ──
    compat.__resetSchemaCompatProcessForTests();
    const f2 = await make.assetFile(compte, { assetId: bien.id });
    replay = await useRecordings([
      { operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: sortie('Facture ramonage'), inputTokens: 9000, outputTokens: 1200, meta: { finishReason: 'STOP' } },
    ]);
    expect((await analyser(compte, f2.id, bien.id))?.analysedCount).toBe(1);
    await drainQueues();
    await compat.__flushSchemaCompatWritesForTests();
    const analyses2 = replay.calls.filter((c) => (c.callKind ?? 'analysis') === 'analysis' && c.operationCode === 't1_analyze_document');
    expect(analyses2).toHaveLength(1);
    expect(analyses2[0].responseSchema).toBeUndefined();
    expect(analyses2[0].jsonResponse).toBe(true);
    rows = await appelsT1(compte.id);
    expect(rows).toHaveLength(2);
    expect(rows[1].metadata.providerRequest).toMatchObject({ responseSchemaSent: false, schemaOmittedReason: 'recent_rejection', schemaCompat: { state: 'REJECTED_CONFIRMED', decision: 'skipped', why: 'recent_rejection' } });
    // Pas de doublon d'alerte pour un refus déjà connu.
    al = await alertes();
    expect(al).toHaveLength(1);
    expect(al[0].occurrences).toBe(1);

    // ── 3. Supervision lue sur les traces réelles (écarts depuis le début du test) ──
    const apres = (await getSchemaUsageReport(filtre)).totals;
    const ecart = (k: keyof typeof apres) => Number(apres[k]) - Number(avant[k]);
    expect({ calls: ecart('calls'), sent: ecart('schemaSent'), accepted: ecart('schemaAccepted'), refused: ecart('schemaRefused400'), retries: ecart('retriesWithoutSchema'), answered: ecart('answeredAfterRetry'), skipped: ecart('skippedKnownRejection'), success: ecart('finalSuccess'), requests: ecart('providerRequests') })
      .toEqual({ calls: 2, sent: 1, accepted: 0, refused: 1, retries: 1, answered: 1, skipped: 1, success: 2, requests: 3 });
    expect(ecart('inputTokens')).toBe(13_927 + 9000);
    const groupe = (await getSchemaUsageReport({ ...filtre, model, contractVersion: 7 })).groups.find((g) => g.model === model);
    expect(groupe).toMatchObject({ operationCode: 't1_analyze_document', contractId: 'T1_ANALYZE_DOCUMENT', contractVersion: 7 });
    expect((await getSchemaUsageReport({ ...filtre, contractVersion: 999 })).groups).toEqual([]);

    // ── 4. Échéance du réexamen : UN essai avec schéma, accepté → couple qualifié, alerte résolue ──
    await sql`UPDATE ai_schema_compatibility SET next_retest_at = now() - interval '1 minute' WHERE key_id = ${couple.key_id}`;
    compat.__resetSchemaCompatProcessForTests();
    const f3 = await make.assetFile(compte, { assetId: bien.id });
    replay = await useRecordings([
      { operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', whenStructured: true, output: sortie('Facture plomberie'), inputTokens: 8000, outputTokens: 1100, meta: { finishReason: 'STOP' } },
    ]);
    expect((await analyser(compte, f3.id, bien.id))?.analysedCount).toBe(1);
    await drainQueues();
    await compat.__flushSchemaCompatWritesForTests();
    rows = await appelsT1(compte.id);
    expect(rows).toHaveLength(3);
    expect(rows[2].metadata.providerRequest).toMatchObject({ responseSchemaSent: true, schemaCompat: { decision: 'sent', why: 'retest_due', retest: true } });
    expect(rows[2].metadata.providerMeta?.structuredOutput).toBe('requested_schema');
    const [apresEssai] = await sql<{ state: string; reason_code: string; accepted_count: number; retest_count: number; next_retest_at: Date | null }[]>`
      SELECT state, reason_code, accepted_count, retest_count, next_retest_at FROM ai_schema_compatibility WHERE key_id = ${couple.key_id}`;
    expect(apresEssai).toMatchObject({ state: 'QUALIFIED', reason_code: 'ACCEPTED_ON_REAL_CALL', accepted_count: 1, retest_count: 1, next_retest_at: null });
    al = await alertes();
    expect(al).toHaveLength(1);
    expect(al[0].resolved_at).not.toBeNull();
    expect(al[0].resolution_code).toBe('SCHEMA_ACCEPTED_AGAIN');
    // Les trois documents sont analysés et leurs faits conservés : aucune donnée métier perdue par le repli.
    const faits = await sql<{ file_id: number }[]>`SELECT DISTINCT file_id FROM document_facts WHERE file_id IN (${f1.id}, ${f2.id}, ${f3.id}) AND fact_key = 'lastRevision'`;
    expect(faits).toHaveLength(3);
    // Vue d'ensemble du BO : couple qualifié, courant, aucune alerte ouverte.
    const { getSchemaCompatOverview } = await import('@/services/ai/gateway/schema-compat/overview');
    const vue = await getSchemaCompatOverview({ days: 1, operationCode: 't1_analyze_document', model });
    expect(vue.couples!.find((c) => c.keyId === couple.key_id)).toMatchObject({ state: 'QUALIFIED', current: true, rejectionCount: 1, acceptedCount: 1 });
    expect(vue.openAlerts).toBe(0);
    expect(vue.staticMatrix.find((s) => s.operationCode === 't1_analyze_document')).toMatchObject({ omitted: null, lostBranches: [] });
    compat.__enableSchemaCompatDbForTests(false);
  });

  it('E2E-L114J-03 (AC18) — réévaluation des alertes : ciblée, idempotente ; résolue si la cause a disparu, conservée sinon', async () => {
    await purger();
    const store = await S();
    const alerts = await A();
    const { coupleKeyId } = await C();
    const { staticSchemaRowOf } = await import('@/services/ai/gateway/schema-compat/static-matrix');
    const cur = staticSchemaRowOf('t1_analyze_document')!;
    const courant = { provider: 'gemini', operationCode: cur.operationCode, contractId: cur.contractId, contractVersion: cur.contractVersion, schemaHash: cur.schemaHash, providerSchemaHash: cur.providerSchemaHash, adapterVersion: cur.adapterVersion };
    const refus = { reason: 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA' as const, httpStatus: 400, providerCode: 'INVALID_ARGUMENT', appVersion: null };
    const maintenant = Date.now();
    // (a) couple remplacé (ancien schéma projeté) — alerte devenue injustifiée ;
    const ancien = { ...courant, model: 'modele-114j-a', providerSchemaHash: '000000000000', adapterVersion: 'ps-ancien' };
    // (b) couple courant toujours refusé — alerte encore réelle ;
    const actif = { ...courant, model: 'modele-114j-b' };
    // (c) couple courant refusé SANS alerte (alerte non écrite au moment du refus) ;
    const sansAlerte = { ...courant, model: 'modele-114j-c' };
    // (d) couple refusé puis accepté, dont l'alerte n'a pas été résolue au fil de l'eau.
    const reaccepte = { ...courant, model: 'modele-114j-d' };
    for (const k of [ancien, actif, reaccepte]) {
      const r = await store.recordRejection(k, refus, maintenant);
      expect(await alerts.raiseSchemaIncompatibilityAlert(r!.state)).toBe(true);
    }
    await store.recordRejection(sansAlerte, refus, maintenant);
    await store.recordAcceptance(reaccepte, null, maintenant + 1000);
    // Répétition de la même condition : aucune seconde alerte.
    expect(await alerts.raiseSchemaIncompatibilityAlert((await store.getCouple(coupleKeyId(actif)))!)).toBe(false);
    expect(await alertes()).toHaveLength(3);
    const autresAvant = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_alerts WHERE code <> ${CODE} AND resolved_at IS NULL`;

    const bilan = await alerts.reevaluateSchemaCompatAlerts();
    expect(bilan).toEqual({ examined: 3, resolved: { SCHEMA_ACCEPTED_AGAIN: 1, SCHEMA_SUPERSEDED: 1 }, keptActive: 1, keptUndetermined: 0, raised: 1, unavailable: false });
    const al = await alertes();
    const par = (m: string) => al.filter((a) => a.details.model === m);
    expect(par('modele-114j-a')[0]).toMatchObject({ resolution_code: 'SCHEMA_SUPERSEDED' });
    expect(par('modele-114j-d')[0]).toMatchObject({ resolution_code: 'SCHEMA_ACCEPTED_AGAIN' });
    expect(par('modele-114j-b')[0]).toMatchObject({ resolved_at: null, resolution_code: null });
    expect(par('modele-114j-c')).toHaveLength(1);
    expect(par('modele-114j-c')[0].resolved_at).toBeNull();
    // Rien n'est supprimé : alertes résolues conservées, refus historiques conservés dans la matrice.
    expect(al).toHaveLength(4);
    expect((await store.getCouple(coupleKeyId(ancien)))!).toMatchObject({ state: 'REJECTED_CONFIRMED', rejectionCount: 1 });

    // Second passage (contrôle quotidien) : rien ne change, aucun doublon.
    const bis = await alerts.reevaluateSchemaCompatAlerts();
    expect(bis).toEqual({ examined: 2, resolved: { SCHEMA_ACCEPTED_AGAIN: 0, SCHEMA_SUPERSEDED: 0 }, keptActive: 2, keptUndetermined: 0, raised: 0, unavailable: false });
    expect(await alertes()).toHaveLength(4);
    // Alertes des autres domaines (couverture T1 #775, modèles #771, tarifs #770) : jamais touchées.
    const autresApres = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_alerts WHERE code <> ${CODE} AND resolved_at IS NULL`;
    expect(autresApres[0].n).toBe(autresAvant[0].n);
  });
});
