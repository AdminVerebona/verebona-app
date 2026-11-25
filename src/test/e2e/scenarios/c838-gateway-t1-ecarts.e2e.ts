/**
 * Carte #838 sur base réelle — « IA T1 / Gateway : fermer les écarts
 * vérifiables dans le code, sans accès Gemini ni préproduction ».
 * PostgreSQL RÉEL (migration 1980 appliquée), transport fournisseur MOCKÉ
 * (FakeProvider) : AUCUN appel Gemini. Ces scénarios n'établissent PAS
 * l'acceptation réelle d'un schéma par le fournisseur.
 *
 *   · C838-E2E-MIG  migration 1980 additive et idempotente (deux passes) ;
 *   · C838-E2E-A1   bail ATOMIQUE du premier essai : 25 demandes concurrentes
 *                   (connexions distinctes) → une seule ; 20 requêtes
 *                   passerelle concurrentes → un seul envoi du schéma non
 *                   qualifié ; processus interrompu, bail expiré, reprise,
 *                   fencing par jeton ;
 *   · C838-E2E-A2   panne de la mémoire partagée injectée (cache froid,
 *                   cache chaud avec refus connu, deux workers, base
 *                   rétablie) : jamais de schéma refusé réautorisé, aucune
 *                   tempête, aucune qualification ni alerte fausse ;
 *   · C838-E2E-A3   requalification bornée d'une qualification à version
 *                   servie incertaine (fenêtre, bail, report, version connue) ;
 *   · C838-E2E-B1   motif d'absence de littéral écrit et relu, littéral long
 *                   exact, anciens faits « motif non renseigné » ;
 *   · C838-E2E-C    réparation 400 + JSON : traces complètes en base, vues
 *                   analyse / réparation / total, coût inconnu ≠ 0 ;
 *   · C838-E2E-D1   5 200+ alertes : arrêt au milieu, crash, deux workers,
 *                   reprise AUTOMATIQUE au dernier curseur sûr, nouvelles
 *                   alertes pendant le parcours, fin de cycle, invalidation.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { z } from 'zod';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';
import { T1_TEST_OPERATION, t1TestVariables, t1Out, t1Schema } from '@/services/ai/gateway/__tests__/t1-master-request';

type Meta = {
  callKind?: string; parentCallIndex?: number;
  providerRequest?: { responseSchemaSent: boolean; schemaOmittedReason: string | null; schemaCompat?: { why: string; qualification?: string; degradedCause?: string } };
  providerAttempts?: Array<{ kind: string; outcome: string; httpStatus: number | null; responseSchemaSent: boolean; costStatus?: string; costMicros?: number | null }>;
  costEvidence?: { status: string; attempts: number; unknownAttempts: number };
};

scenario('C838', 'Passerelle T1 : qualification réservée, panne mémoire, requalification, motif d’absence, coûts et reprise des alertes', ({ sql, make }) => {
  useTargetState();

  const C = () => import('@/services/ai/gateway/schema-compat');
  const S = () => import('@/services/ai/gateway/schema-compat/store');
  const A = () => import('@/services/ai/gateway/schema-compat/alerts');
  const M = () => import('@/services/ai/gateway/schema-compat/static-matrix');
  const CODE = 'ai_schema_incompatibility';
  const REFUS = { reason: 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA' as const, httpStatus: 400, providerCode: 'INVALID_ARGUMENT', appVersion: 'sha-e2e-838' };
  const cle = (model: string) => ({
    provider: 'gemini', model, operationCode: 't1_analyze_document', contractId: 'T1_ANALYZE_DOCUMENT', contractVersion: 7,
    schemaHash: 'aaaaaaaaaaaa', providerSchemaHash: 'bbbbbbbbbbbb', adapterVersion: 'ps-e2e-838', generationProfileHash: '-',
  });
  const purger = async () => {
    await sql`DELETE FROM ai_schema_compatibility`;
    await sql`DELETE FROM ai_alerts WHERE code = ${CODE}`;
    await sql`DELETE FROM ai_schema_compat_reeval_checkpoints`;
  };
  let fournisseurAvant: unknown = null;
  const installerFake = async () => {
    const P = await import('@/services/ai/gateway/providers');
    if (fournisseurAvant === null) fournisseurAvant = P.getAiProvider();
    const f = new P.FakeProvider();
    P.setAiProvider(f);
    return f;
  };

  afterAll(async () => {
    const compat = await C();
    compat.__setSchemaCompatStoreForTests(null);
    compat.__enableSchemaCompatDbForTests(false);
    if (fournisseurAvant) (await import('@/services/ai/gateway/providers')).setAiProvider(fournisseurAvant as never);
    await purger().catch(() => undefined);
  });

  it('C838-E2E-MIG — migration 1980 additive, idempotente (deux passes), colonnes et table présentes', async () => {
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      const texte = await readFile(join(process.cwd(), 'src/db/migrations/1980_c838_gateway_qualification_bail_checkpoint.sql'), 'utf-8');
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE (table_name = 'ai_schema_compatibility' AND column_name LIKE 'qualification_%')
          OR (table_name = 'document_facts' AND column_name = 'raw_value_absence')
       ORDER BY 1, 2`;
    expect(cols.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      'ai_schema_compatibility.qualification_attempts', 'ai_schema_compatibility.qualification_claim_token', 'ai_schema_compatibility.qualification_claimed_until',
      'document_facts.raw_value_absence',
    ]);
    expect(await sql`SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_schema_compat_reeval_checkpoints'`).toHaveLength(1);
  });

  it('C838-E2E-A1-01 — bail ATOMIQUE du premier essai : 25 demandes concurrentes → 1 ; expiration, reprise, fencing', async () => {
    await purger();
    const store = await S();
    const { coupleKeyId, SCHEMA_COMPAT_POLICY: P } = await C();
    const k = cle('modele-838-bail');
    const id = coupleKeyId(k);
    const t0 = Date.UTC(2026, 10, 25, 8, 0, 0);
    // Connexions distinctes du pool : la base arbitre (aucun verrou global, une seule clé).
    const prises = await Promise.all(Array.from({ length: 25 }, () => store.claimQualification(k, 'FIRST', t0)));
    const gagnes = prises.filter((p) => p.status === 'claimed');
    expect(gagnes).toHaveLength(1);
    expect(prises.filter((p) => p.status === 'busy')).toHaveLength(24);
    const [ligne] = await sql<{ state: string; qualification_attempts: number; qualification_claim_token: string }[]>`
      SELECT state, qualification_attempts, qualification_claim_token FROM ai_schema_compatibility WHERE key_id = ${id}`;
    expect(ligne).toMatchObject({ state: 'NOT_TESTED', qualification_attempts: 1 });
    const jeton = (gagnes[0] as { token: string }).token;
    expect(ligne.qualification_claim_token).toBe(jeton);
    // Un autre couple n'est pas bloqué (pas de verrou global).
    expect((await store.claimQualification(cle('modele-838-autre'), 'FIRST', t0)).status).toBe('claimed');
    // Processus interrompu : bail vivant → personne ; bail expiré → UNE reprise.
    expect((await store.claimQualification(k, 'FIRST', t0 + P.qualificationLeaseMs - 1)).status).toBe('busy');
    const reprises = await Promise.all(Array.from({ length: 8 }, () => store.claimQualification(k, 'FIRST', t0 + P.qualificationLeaseMs + 1)));
    expect(reprises.filter((p) => p.status === 'claimed')).toHaveLength(1);
    // Fencing : l'ancien détenteur ne rend pas le bail du nouveau.
    expect(await store.releaseQualification(id, jeton, t0 + P.qualificationLeaseMs + 2, false)).toBe(false);
    const nouveau = (reprises.find((p) => p.status === 'claimed') as { token: string }).token;
    // Issue écrite (refus), puis bail rendu : plus aucun premier essai n'est réservable.
    await store.recordRejection(k, REFUS, t0 + P.qualificationLeaseMs + 3);
    expect(await store.releaseQualification(id, nouveau, t0 + P.qualificationLeaseMs + 4, false)).toBe(true);
    expect((await store.claimQualification(k, 'FIRST', t0 + P.qualificationLeaseMs + 5)).status).toBe('busy');
    expect(await store.getCouple(id)).toMatchObject({ state: 'REJECTED_CONFIRMED' });
  });

  it('C838-E2E-A1-02 — 20 requêtes passerelle concurrentes, couple jamais testé : un seul envoi du schéma non qualifié, base qualifiée', async () => {
    await purger();
    const compat = await C();
    compat.__enableSchemaCompatDbForTests(true);
    const fake = await installerFake();
    fake.onAny(async () => {
      await new Promise((r) => setTimeout(r, 150));
      return { rawText: t1Out({ ok: true }), inputTokens: 10, outputTokens: 5 };
    });
    const compte = await make.account();
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => AiGateway.execute({
      useCaseCode: 'SOURCE_ANALYSIS', operationCode: T1_TEST_OPERATION, accountId: compte.id,
      promptVariables: t1TestVariables(`facture c838 ${i}`), outputSchema: t1Schema({ ok: z.boolean() }), idempotencyKey: `c838-a1-${i}-${Math.random()}`,
    })));
    await compat.__flushSchemaCompatWritesForTests();
    expect(res.every((r) => (r.data as { ok: boolean }).ok)).toBe(true);
    const evts = await sql<{ metadata: Meta }[]>`SELECT metadata FROM ai_usage_event WHERE account_id = ${compte.id} AND operation_code = ${T1_TEST_OPERATION} ORDER BY id`;
    expect(evts).toHaveLength(20);
    const why = evts.map((e) => e.metadata.providerRequest?.schemaCompat?.why);
    // UN seul essai de qualification ; aucun autre schéma envoyé tant qu'il n'est pas conclu.
    expect(why.filter((w) => w === 'first_qualification')).toHaveLength(1);
    expect(evts.filter((e) => e.metadata.providerRequest?.responseSchemaSent && e.metadata.providerRequest?.schemaCompat?.why !== 'qualified')).toHaveLength(1);
    expect(why.filter((w) => w === 'qualification_in_progress').length).toBeGreaterThanOrEqual(5);
    expect(fake.calls.filter((c) => c.responseSchema !== undefined)).toHaveLength(1 + why.filter((w) => w === 'qualified').length);
    // Base : couple qualifié par l'appel réel, bail rendu.
    const lignes = await sql<{ state: string; qualification_claim_token: string | null; qualification_attempts: number }[]>`
      SELECT state, qualification_claim_token, qualification_attempts FROM ai_schema_compatibility WHERE operation_code = ${T1_TEST_OPERATION}`;
    expect(lignes).toEqual([{ state: 'QUALIFIED', qualification_claim_token: null, qualification_attempts: 1 }]);
    compat.__enableSchemaCompatDbForTests(false);
  });

  it('C838-E2E-A2 — panne BDD injectée : cache froid, cache chaud avec refus, deux workers, base rétablie, aucune tempête', async () => {
    await purger();
    const compat = await C();
    const store = await S();
    // Ancré sur l'horloge RÉELLE : la fin du scénario passe par la passerelle, qui date ses décisions avec
    // `Date.now()`. Une date en dur (ancienne version : 25/11/2026 10:00 UTC) faisait expirer le délai de
    // réexamen du refus dès l'après-midi : `retest_due` au lieu de `recent_rejection` (bombe à retardement).
    const t0 = Date.now() - 60_000;
    const refuse = cle('modele-838-refuse');
    const qualif = cle('modele-838-qualifie');
    await store.recordRejection(refuse, REFUS, t0);
    await store.recordAcceptance(qualif, 'sha', t0, 'v1');
    const lectures = { load: 0 };
    const panne = {
      loadKnownCouples: async () => { lectures.load++; throw Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' }); },
      getCouple: async () => { throw new Error('connection terminated unexpectedly'); },
      claimQualification: async () => { throw new Error('connection terminated unexpectedly'); },
    };
    const avant = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_schema_compatibility`;
    // Worker 1 : cache CHAUD (lecture réelle réussie).
    compat.__enableSchemaCompatDbForTests(true);
    expect(await compat.decideSchemaUse(refuse, t0 + 1)).toMatchObject({ send: false, why: 'recent_rejection' });
    expect(await compat.decideSchemaUse(qualif, t0 + 2)).toMatchObject({ send: true, why: 'qualified' });
    // Panne injectée (connexion coupée) SANS redémarrage : le cache chaud est conservé.
    compat.__setSchemaCompatStoreForTests(panne as never, { keepProcessMemory: true });
    const tPanne = t0 + compat.SHARED_TTL_MS + 10;
    // Refus connu : il commande toujours (jamais réautorisé par la panne) ; qualifié connu : schéma ; inconnu : dégradé.
    expect(await compat.decideSchemaUse(refuse, tPanne)).toMatchObject({ send: false, why: 'recent_rejection' });
    expect(await compat.decideSchemaUse(qualif, tPanne + 1)).toMatchObject({ send: true, why: 'qualified' });
    expect(await compat.decideSchemaUse(cle('modele-838-inconnu'), tPanne + 2)).toMatchObject({ send: false, why: 'memory_unavailable' });
    // Worker 2 : cache FROID pendant la panne — le refus n'est PAS réautorisé (JSON sans schéma).
    compat.__resetSchemaCompatProcessForTests();
    lectures.load = 0;
    expect(await compat.decideSchemaUse(refuse, tPanne + 3)).toMatchObject({ send: false, why: 'memory_unavailable', degraded: { cause: 'shared_unreadable' } });
    // Aucune tempête : 40 décisions pendant la panne → une seule tentative de relecture.
    for (let i = 0; i < 40; i++) await compat.decideSchemaUse(cle(`modele-838-x-${i}`), tPanne + 4 + i);
    expect(lectures.load).toBe(1);
    // Rien d'écrit : ni fausse qualification, ni ligne, ni alerte.
    await compat.__flushSchemaCompatWritesForTests();
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_schema_compatibility`)[0].n).toBe(avant[0].n);
    expect(await store.getCouple(compat.coupleKeyId(refuse))).toMatchObject({ state: 'REJECTED_CONFIRMED' });
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_alerts WHERE code = ${CODE}`)[0].n).toBe(0);
    // Passerelle en panne : JSON sans schéma, validation locale, motif tracé.
    const fake = await installerFake();
    fake.onAny(() => ({ rawText: t1Out({ ok: true }), inputTokens: 10, outputTokens: 5 }));
    const compte = await make.account();
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    for (let i = 0; i < 3; i++) {
      await AiGateway.execute({
        useCaseCode: 'SOURCE_ANALYSIS', operationCode: T1_TEST_OPERATION, accountId: compte.id,
        promptVariables: t1TestVariables(`panne ${i}`), outputSchema: t1Schema({ ok: z.boolean() }), idempotencyKey: `c838-a2-${i}-${Math.random()}`,
      });
    }
    expect(fake.calls.every((c) => c.responseSchema === undefined && c.jsonResponse === true)).toBe(true);
    const evts = await sql<{ metadata: Meta }[]>`SELECT metadata FROM ai_usage_event WHERE account_id = ${compte.id} ORDER BY id`;
    for (const e of evts) expect(e.metadata.providerRequest).toMatchObject({ schemaOmittedReason: 'memory_unavailable', schemaCompat: { degradedCause: 'shared_unreadable' } });
    // Base RÉTABLIE (même processus) : relecture à la période suivante, décisions prouvées de nouveau.
    compat.__setSchemaCompatStoreForTests(null, { keepProcessMemory: true });
    // (horloge réelle : les appels passerelle ci-dessus ont daté la dernière tentative de relecture)
    const tRetour = Date.now() + 3 * compat.SHARED_TTL_MS;
    expect(await compat.decideSchemaUse(refuse, tRetour)).toMatchObject({ send: false, why: 'recent_rejection' });
    expect(await compat.decideSchemaUse(qualif, tRetour + 1)).toMatchObject({ send: true, why: 'qualified' });
    expect(compat.schemaMemoryDegradedStats().sharedHealthy).toBe(true);
    compat.__enableSchemaCompatDbForTests(false);
  });

  it('C838-E2E-A3 — requalification bornée : fenêtre, UN bail parmi 10, acceptation à version connue, report après essai sans conclusion', async () => {
    await purger();
    const store = await S();
    const { coupleKeyId, SCHEMA_COMPAT_POLICY: P } = await C();
    const t0 = Date.UTC(2026, 10, 25, 12, 0, 0);
    const k = cle('modele-838-alias');
    const id = coupleKeyId(k);
    await store.recordAcceptance(k, 'sha', t0, null);
    expect(await store.getCouple(id)).toMatchObject({ state: 'QUALIFIED', versionUncertain: true });
    // Dans la fenêtre : rien à requalifier (jamais à chaque requête).
    expect((await store.claimQualification(k, 'REQUALIFY', t0 + 3_600_000)).status).toBe('busy');
    // Fenêtre échue : 10 instances, UNE requalification.
    const echu = t0 + P.uncertainQualificationTtlMs + 1;
    const prises = await Promise.all(Array.from({ length: 10 }, () => store.claimQualification(k, 'REQUALIFY', echu)));
    expect(prises.filter((p) => p.status === 'claimed')).toHaveLength(1);
    const jeton = (prises.find((p) => p.status === 'claimed') as { token: string }).token;
    // Essai sans conclusion : report de `inconclusiveRetestMs`, schéma toujours admis entre-temps.
    expect(await store.releaseQualification(id, jeton, echu + 5, true)).toBe(true);
    expect(await store.getCouple(id)).toMatchObject({ state: 'QUALIFIED', nextRetestAt: echu + 5 + P.inconclusiveRetestMs });
    expect((await store.claimQualification(k, 'REQUALIFY', echu + 60_000)).status).toBe('busy');
    const r2 = await store.claimQualification(k, 'REQUALIFY', echu + 5 + P.inconclusiveRetestMs);
    expect(r2.status).toBe('claimed');
    // Acceptation à version CONNUE : plus aucune requalification par la règle d'incertitude.
    await store.recordAcceptance(k, 'sha', echu + 6 + P.inconclusiveRetestMs, 'gemini-x-002');
    await store.releaseQualification(id, (r2 as { token: string }).token, echu + 7 + P.inconclusiveRetestMs, false);
    expect(await store.getCouple(id)).toMatchObject({ versionUncertain: false, servedModelVersion: 'gemini-x-002', nextRetestAt: null });
    expect((await store.claimQualification(k, 'REQUALIFY', echu + 100 * P.uncertainQualificationTtlMs)).status).toBe('busy');
    // Jamais d'identifiant de version inventé.
    const [l] = await sql<{ served_model_version: string | null }[]>`SELECT served_model_version FROM ai_schema_compatibility WHERE key_id = ${id}`;
    expect(l.served_model_version).toBe('gemini-x-002');
  });

  it('C838-E2E-B1 — motif d’absence de littéral : écrit avec le fait, littéral long exact, fait antérieur lu « non renseigné »', async () => {
    const compte = await make.account();
    const f = await make.assetFile(compte);
    const [ex] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, provider, model, prompt_version, fact_count)
      VALUES (${compte.id}, ${f.id}, 'fake', 'm', 't1_analyze_document@v7', 4) RETURNING id`;
    const { insertFactRows } = await import('@/services/ai/knowledge/document-knowledge.service');
    const { readRawValueAbsence } = await import('@/services/ai/source-analysis/master/raw-value-absence');
    const { pgClient } = await import('@/db');
    const long = 'Désignation : ' + 'pompe à chaleur air/eau, '.repeat(78);
    const fait = (over: Record<string, unknown>) => ({
      factKey: 'acquisitionPrice', subject: null, attribute: null, label: null, valueText: '1234.5', valueNumber: 1234.5, valueUnit: 'EUR',
      valueJson: 1234.5, normalizedValue: '1234.5', periodStart: null, periodEnd: null, confidence: 'certain' as const, excerpt: 'Total TTC : 1 234,50 €',
      location: { page: 1 }, evidenceOrigin: 'TEXT_EXTRACTION' as const, visualEvidence: null,
      canonicalKey: 'acquisitionPrice', rawKey: 'Total TTC', valueType: 'money_eur', canonicalUnit: 'EUR', projectionOrigin: 'MODEL_CANONICAL', ...over,
    });
    await pgClient.begin(async (tx) => {
      await insertFactRows(tx as never, { accountId: compte.id, fileId: f.id, sourceType: 'asset_file', provider: 'fake', model: 'm', promptVersion: 'v' }, Number(ex.id), [
        fait({ rawValue: '1 234,50 €' }),
        fait({ rawValue: long.slice(0, 2000), canonicalKey: null, factKey: 'designation', projectionOrigin: 'GENERIC' }),
        fait({ rawValue: null, evidenceOrigin: 'VISUAL_ANALYSIS', excerpt: null, visualEvidence: { description: 'chaudière murale blanche' } }),
        fait({ rawValue: null, excerpt: 'Montant total : mille deux cent trente-quatre euros cinquante' }),
      ] as never, { canonical: true, provenance: false });
    });
    // Aucun « null inexpliqué » possible en base : un fait LU sans citation est refusé par la contrainte 0161
    // (`document_facts_evidence_ck`), un fait OBSERVÉ exige sa description — chaque absence a donc un motif vérifiable.
    await expect(pgClient.begin(async (tx) => insertFactRows(tx as never,
      { accountId: compte.id, fileId: f.id, sourceType: 'asset_file', provider: 'fake', model: 'm', promptVersion: 'v' }, Number(ex.id),
      [fait({ rawValue: null, excerpt: null })] as never, { canonical: true, provenance: false }))).rejects.toThrow(/document_facts_evidence_ck/);
    // Fait ANTÉRIEUR à la carte : aucune valeur, aucun motif (rien n'est inventé pour lui).
    await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, value_text, confidence, excerpt, canonical_key)
      VALUES (${compte.id}, ${f.id}, ${ex.id}, 'ancien', 'x', 'certain', 'x', 'ancien')`;
    const lus = await sql<{ fact_key: string; raw_value: string | null; raw_value_absence: string | null }[]>`
      SELECT fact_key, raw_value, raw_value_absence FROM document_facts WHERE extraction_id = ${ex.id} ORDER BY id`;
    // Règle remplacée (carte #863, B1) : une citation qui ne porte pas la valeur sous une forme VÉRIFIABLE (montant
    // écrit en toutes lettres) ne justifie plus l'absence — `UNJUSTIFIED` explicite, jamais LITERAL_IN_EXCERPT de convenance.
    expect(lus.map((r) => [r.fact_key, r.raw_value_absence])).toEqual([
      ['acquisitionPrice', null], ['designation', null], ['acquisitionPrice', 'VISUAL_ONLY'], ['acquisitionPrice', 'UNJUSTIFIED'], ['ancien', null],
    ]);
    expect(lus[0].raw_value).toBe('1 234,50 €');
    expect(lus[1].raw_value).toBe(long.slice(0, 2000));
    expect(lus.map((r) => readRawValueAbsence({ rawValue: r.raw_value, rawValueAbsence: r.raw_value_absence }))).toEqual([
      null, null, 'VISUAL_ONLY', 'UNJUSTIFIED', 'LEGACY_UNSPECIFIED',
    ]);
  });

  it('C838-E2E-C — réparation 400 + JSON : toutes les requêtes tracées en base, vues analyse / réparation / total, coût inconnu ≠ 0', async () => {
    const fake = await installerFake();
    fake.onAny((input) => {
      if (input.callKind === 'repair') {
        if (input.responseSchema) throw Object.assign(new Error('Invalid JSON payload: response_schema is too complex'), { status: 400 });
        return { rawText: t1Out({ ok: true }), inputTokens: 5, outputTokens: 5 };
      }
      return { rawText: t1Out({ ok: 'peut-être' }), inputTokens: 10, outputTokens: 5 };
    });
    const compte = await make.account();
    const { AiGateway } = await import('@/services/ai/gateway/ai-gateway');
    const res = await AiGateway.execute({
      useCaseCode: 'SOURCE_ANALYSIS', operationCode: T1_TEST_OPERATION, accountId: compte.id,
      promptVariables: t1TestVariables('réparation c838'), outputSchema: t1Schema({ ok: z.boolean() }), idempotencyKey: `c838-c-${Math.random()}`,
    });
    expect(res.data).toMatchObject({ ok: true });
    expect(res.costUnknownAttempts).toBeGreaterThanOrEqual(1);
    const evts = await sql<{ status: string; cost_micros: number | null; metadata: Meta }[]>`
      SELECT status, cost_micros, metadata FROM ai_usage_event WHERE account_id = ${compte.id} ORDER BY id`;
    expect(evts.map((e) => e.metadata.callKind ?? 'analysis')).toEqual(['analysis', 'repair']);
    const rep = evts[1].metadata;
    expect(rep.providerRequest).toMatchObject({ responseSchemaSent: true });
    expect(rep.providerAttempts!.map((a) => [a.kind, a.outcome, a.httpStatus, a.responseSchemaSent])).toEqual([
      ['initial', 'FAILED', 400, true], ['schema_rejected_retry', 'SUCCESS', null, false],
    ]);
    expect(rep.providerAttempts![0]).toMatchObject({ costStatus: 'UNKNOWN', costMicros: null });
    expect(rep.costEvidence).toMatchObject({ attempts: 2 });
    expect(rep.costEvidence!.unknownAttempts).toBeGreaterThanOrEqual(1);
    expect(rep.parentCallIndex).toBe(0);
    // Vues séparées sur les traces RÉELLES (lecture SQL réelle) : la réparation est visible, sa part inconnue aussi.
    const { getSchemaCostViews, getSchemaUsageReport } = await import('@/services/ai/gateway/schema-compat/supervision');
    // Fenêtre bornée sur l'horloge de la BASE (les traces sont datées par `now()` SQL), pas sur l'horloge JS.
    const [{ fin }] = await sql<{ fin: Date }[]>`SELECT now() + interval '1 minute' AS fin`;
    const v = await getSchemaCostViews({ days: 1, operationCode: T1_TEST_OPERATION }, new Date(fin));
    expect(v.unavailable).toBeNull();
    expect(v.views!.repair.calls).toBeGreaterThanOrEqual(1);
    expect(v.views!.repair.attemptsCostUnknown).toBeGreaterThanOrEqual(1);
    expect(v.views!.total.calls).toBe(v.views!.analysis.calls + v.views!.repair.calls);
    expect(v.views!.total.providerRequests).toBe(v.views!.analysis.providerRequests + v.views!.repair.providerRequests);
    expect(['PARTIAL', 'UNKNOWN']).toContain(v.views!.total.costStatus);
    // Le rapport historique « analyse seule » ne compte pas la réparation comme un appel d'analyse.
    const u = await getSchemaUsageReport({ days: 1, operationCode: T1_TEST_OPERATION }, new Date(fin));
    expect(u.totals.calls).toBe(v.views!.analysis.calls);
  });

  it('C838-E2E-D1 — 5 200+ alertes : arrêt au milieu, crash, deux workers, reprise AUTOMATIQUE, nouvelles alertes, fin de cycle', async () => {
    await purger();
    const store = await S();
    const alerts = await A();
    const cur = (await M()).staticSchemaRowOf('t1_analyze_document')!;
    const base = {
      provider: 'gemini', operationCode: cur.operationCode, contractId: cur.contractId, contractVersion: cur.contractVersion,
      schemaHash: cur.schemaHash, providerSchemaHash: cur.providerSchemaHash, adapterVersion: cur.adapterVersion,
    };
    const t0 = Date.UTC(2026, 10, 25, 14, 0, 0);
    const TOTAL = 5_200;
    const couples = Array.from({ length: TOTAL }, (_, i) => ({ ...base, model: `modele-838-d1-${String(i).padStart(5, '0')}` }));
    for (let i = 0; i < couples.length; i += 200) {
      const lot = couples.slice(i, i + 200);
      const etats = await Promise.all(lot.map((k, j) => store.recordRejection(k, REFUS, t0 + (i + j) * 10)));
      await Promise.all(etats.map((r) => alerts.raiseSchemaIncompatibilityAlert(r!.state)));
    }
    const ouvertes = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_alerts WHERE code = ${CODE} AND resolved_at IS NULL`)[0].n;
    expect(await ouvertes()).toBe(TOTAL);
    // 100 couples dont le motif est désormais PROUVÉ disparu (schéma accepté de nouveau) : seules leurs alertes se ferment.
    const acceptes = couples.filter((_, i) => i % 52 === 0);
    for (const k of acceptes) await store.recordAcceptance(k, 'sha', t0 + 10_000_000, 'v1');
    const chaine = async () => couples.map((c) => c.model);
    const ck = { cyclePeriodMs: 0 };
    const point = async () => (await sql<{ phase: string; alert_cursor: string; cycle: number; lease_token: string | null; resumes: number }[]>`
      SELECT phase, alert_cursor, cycle, lease_token, resumes FROM ai_schema_compat_reeval_checkpoints WHERE scope = 'schema_compat_alerts'`)[0];

    // (1) Arrêt AU MILIEU (budget) : curseur sûr durable, bail rendu.
    const p1 = await alerts.reevaluateSchemaCompatAlerts({ checkpoint: ck, maxAlerts: 2_000, readChain: chaine });
    expect(p1).toMatchObject({ examined: 2_000, done: false, checkpoint: { status: 'RAN', cycle: 1, resumed: false } });
    let pt = await point();
    expect(pt).toMatchObject({ phase: 'ALERTS', cycle: 1, lease_token: null });
    expect(Number(pt.alert_cursor)).toBe(p1.resumeFromAlertId);

    // (2) Reprise AUTOMATIQUE (aucun curseur passé), puis CRASH au milieu de la page suivante.
    const tombe = (p: { examined: number }) => { if (p.examined >= 450) throw new Error('arrêt brutal du processus (simulé)'); };
    await expect(alerts.reevaluateSchemaCompatAlerts({ checkpoint: ck, readChain: chaine, onProgress: tombe })).rejects.toThrow(/arrêt brutal/);
    pt = await point();
    expect(Number(pt.alert_cursor)).toBeGreaterThan(Number(p1.resumeFromAlertId));
    expect(pt.lease_token).not.toBeNull();
    const curseurSur = Number(pt.alert_cursor);

    // (3) Second worker pendant que le bail du processus « mort » vit encore : il ne fait RIEN.
    const p3 = await alerts.reevaluateSchemaCompatAlerts({ checkpoint: ck, readChain: chaine });
    expect(p3).toMatchObject({ examined: 0, checkpoint: { status: 'LEASE_HELD' } });

    // (4) Nouvelles alertes pendant le parcours (identifiants plus grands que le curseur) : prises dans ce cycle.
    const nouveaux = Array.from({ length: 30 }, (_, i) => ({ ...base, model: `modele-838-d1-nouveau-${i}` }));
    for (const k of nouveaux) await alerts.raiseSchemaIncompatibilityAlert((await store.recordRejection(k, REFUS, t0 + 20_000_000))!.state);
    const chaineComplete = async () => [...couples, ...nouveaux].map((c) => c.model);

    // (5) Bail expiré (processus mort) : DEUX workers simultanés → un seul reprend, au dernier curseur sûr.
    await sql`UPDATE ai_schema_compat_reeval_checkpoints SET lease_expires_at = now() - interval '1 second'`;
    const restantes = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_alerts WHERE code = ${CODE} AND resolved_at IS NULL AND id > ${curseurSur}`)[0].n;
    const [w1, w2] = await Promise.all([
      alerts.reevaluateSchemaCompatAlerts({ checkpoint: ck, readChain: chaineComplete }),
      alerts.reevaluateSchemaCompatAlerts({ checkpoint: ck, readChain: chaineComplete }),
    ]);
    const statuts = [w1.checkpoint!.status, w2.checkpoint!.status].sort();
    expect(statuts).toEqual(['LEASE_HELD', 'RAN']);
    const repris = w1.checkpoint!.status === 'RAN' ? w1 : w2;
    expect(repris.checkpoint).toMatchObject({ resumed: true, cycle: 1, startedFrom: { phase: 'ALERTS', alertCursor: curseurSur }, cycleCompleted: true });
    // Exactement la suite : ni trou ni doublon (les alertes déjà parcourues ne sont pas relues).
    expect(repris.examined).toBe(restantes);
    expect(repris.done).toBe(true);
    // Fin de cycle : curseur remis à zéro, phase DONE, bail rendu.
    pt = await point();
    expect(pt).toMatchObject({ phase: 'DONE', alert_cursor: '0', lease_token: null, cycle: 1 });
    expect(pt.resumes).toBeGreaterThanOrEqual(2);

    // (6) Clôture UNIQUEMENT des motifs prouvés disparus ; les refus HTTP 400 restent visibles.
    const resolues = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_alerts WHERE code = ${CODE} AND resolution_code = 'SCHEMA_ACCEPTED_AGAIN'`;
    expect(resolues[0].n).toBe(acceptes.length);
    expect(await ouvertes()).toBe(TOTAL + nouveaux.length - acceptes.length);
    const http = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_schema_compatibility WHERE last_http_status = 400 AND state = 'REJECTED_CONFIRMED'`;
    expect(http[0].n).toBe(TOTAL - acceptes.length + nouveaux.length);
    expect(repris.coverageCoordination.unchanged).toBe(true);

    // (7) Cycle suivant pas encore dû (passage automatique) : rien ; à la demande : nouveau cycle depuis le début.
    const pas = await alerts.reevaluateSchemaCompatAlerts({ checkpoint: { cyclePeriodMs: alerts.REEVAL_CYCLE_PERIOD_MS }, readChain: chaineComplete });
    expect(pas.checkpoint).toMatchObject({ status: 'NOTHING_TO_DO' });
    expect(pas.examined).toBe(0);
    const nouveauCycle = await alerts.reevaluateSchemaCompatAlerts({ checkpoint: ck, maxAlerts: 100, readChain: chaineComplete });
    expect(nouveauCycle.checkpoint).toMatchObject({ status: 'RAN', cycle: 2, startedFrom: { alertCursor: 0 } });

    // (8) Périmètre modifié : point de reprise INVALIDÉ de façon contrôlée (recommence au début).
    await sql`UPDATE ai_schema_compat_reeval_checkpoints SET scope_fingerprint = 'ancien-perimetre'`;
    const inval = await alerts.reevaluateSchemaCompatAlerts({ checkpoint: ck, maxAlerts: 50, readChain: chaineComplete });
    expect(inval.checkpoint).toMatchObject({ status: 'RAN', invalidated: true, startedFrom: { alertCursor: 0 } });
    // Le passage n'écrit jamais sur les anomalies de couverture T1 (#775).
    expect(inval.coverageCoordination.unchanged).toBe(true);
  });
});
