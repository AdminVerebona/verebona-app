/**
 * Lot 115 sur base réelle — carte #784 « IA T1 / passerelle : compléter #776 ».
 * PostgreSQL réel, migration 1795 appliquée. AUCUN appel à un fournisseur
 * d'IA : tout se prouve par la mémoire partagée, les traces rejouées et les
 * projections.
 *
 *   · E2E-L784-01 (§B1, AC06/AC18/AC21) : VOLUMÉTRIE — plus de 2 000 couples
 *     mémorisés ; un refus ANCIEN, hors du cache borné, reste connu et
 *     commande toujours la décision ; parcours exhaustif, paginé et reprenable
 *     par `key_id`, dans un ordre qu'une mise à jour concurrente ne déplace
 *     pas ; bilan par état ;
 *   · E2E-L784-02 (§E1, §E2, AC18) : ROUTAGE RÉEL — alerte d'un modèle retiré
 *     close AVEC MOTIF ; alerte d'un modèle toujours déclaré ou de routage
 *     illisible CONSERVÉE (et non rouverte au passage suivant) ;
 *   · E2E-L784-03 (§E2, AC18/AC21) : RATTRAPAGE de plus de 5 000 alertes —
 *     budget par passage, reprise exacte, interruption, idempotence, aucune
 *     alerte sautée ni traitée deux fois, aucune remise à zéro ;
 *   · E2E-L784-04 (§A3, AC06) : VERSION SERVIE — mémorisée, incertitude
 *     marquée quand le fournisseur est muet, et un changement de version rend
 *     l'essai avec schéma dû SANS déclarer la moindre compatibilité ;
 *   · E2E-L784-05 (§D2, AC17/AC19) : plus de 200 combinaisons de traces —
 *     totaux et taux EXACTS sur l'ensemble, ventilation paginée signalée ;
 *   · E2E-L784-06 (§E1, §E3) : le STATUT DE ROUTAGE est servi au BO par la vue
 *     d'ensemble, et la COORDINATION avec les alertes de couverture T1 (#775)
 *     est un constat : elles sont inchangées, aucune n'est touchée.
 */
import { afterAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';

scenario('L784', 'Passerelle des schémas : volumétrie, routage réel, rattrapage reprenable, version servie et totaux exacts', ({ sql, make }) => {
  useTargetState();

  const C = () => import('@/services/ai/gateway/schema-compat');
  const S = () => import('@/services/ai/gateway/schema-compat/store');
  const A = () => import('@/services/ai/gateway/schema-compat/alerts');
  const M = () => import('@/services/ai/gateway/schema-compat/static-matrix');
  const CODE = 'ai_schema_incompatibility';

  const purger = async () => {
    await sql`DELETE FROM ai_schema_compatibility`;
    await sql`DELETE FROM ai_alerts WHERE code = ${CODE}`;
  };

  /** Couple courant de T1, tel que la passerelle le projette aujourd'hui. */
  const courantT1 = async () => {
    const cur = (await M()).staticSchemaRowOf('t1_analyze_document')!;
    return {
      provider: 'gemini', operationCode: cur.operationCode, contractId: cur.contractId, contractVersion: cur.contractVersion,
      schemaHash: cur.schemaHash, providerSchemaHash: cur.providerSchemaHash, adapterVersion: cur.adapterVersion,
    };
  };
  const REFUS = { reason: 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA' as const, httpStatus: 400, providerCode: 'INVALID_ARGUMENT', appVersion: 'sha-e2e-784' };

  afterAll(async () => {
    (await C()).__enableSchemaCompatDbForTests(false);
    await purger().catch(() => undefined);
  });

  it('E2E-L784-01 (§B1) — PLUS DE 2 000 couples : un refus ANCIEN reste connu et décide ; parcours exhaustif, paginé, reprenable', async () => {
    await purger();
    const store = await S();
    const { coupleKeyId } = await C();
    const base = await courantT1();
    const t0 = Date.UTC(2026, 10, 16, 8, 0, 0);

    // Le couple ANCIEN : écrit le PREMIER, donc le plus ancien par `updated_at` — c'est précisément
    // celui que la lecture bornée aux 2 000 lignes les plus récentes laissait tomber.
    const ancien = { ...base, model: 'modele-784-ancien' };
    const idAncien = coupleKeyId(ancien);
    await store.recordRejection(ancien, REFUS, t0);

    // 2 100 autres couples refusés, tous plus récents (volumétrie > 2 000 exigée par la carte).
    const TOTAL_AUTRES = 2_100;
    const lignes = Array.from({ length: TOTAL_AUTRES }, (_, i) => ({ ...base, model: `modele-784-${String(i).padStart(5, '0')}` }));
    for (let i = 0; i < lignes.length; i += 150) {
      await Promise.all(lignes.slice(i, i + 150).map((k, j) => store.recordRejection(k, REFUS, t0 + 60_000 + (i + j) * 10)));
    }
    const total = TOTAL_AUTRES + 1;
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_schema_compatibility`)[0].n).toBe(total);

    // (a) Le cache borné ne porte PLUS l'ancien couple, et il le DIT (`truncated`).
    const cache = (await store.loadKnownCouples(2_000))!;
    expect(cache.rows).toHaveLength(2_000);
    expect(cache.truncated).toBe(true);
    expect(cache.rows.find((c) => c.keyId === idAncien)).toBeUndefined();

    // (b) … mais la DÉCISION ne se prend pas sur cette absence : lue par clé, elle est juste.
    //     C'est le défaut que la carte signale : « ne jamais omettre un refus parce qu'il est ancien ».
    expect(await store.getCouple(idAncien)).toMatchObject({ state: 'REJECTED_CONFIRMED', keyId: idAncien });
    const compat = await C();
    compat.__enableSchemaCompatDbForTests(true);
    compat.__resetSchemaCompatProcessForTests();
    const decision = await compat.decideSchemaUse(ancien, t0 + 120_000);
    // Refus mémorisé et non échu : le schéma n'est PAS renvoyé (aucun HTTP 400 repayé).
    expect(decision).toMatchObject({ send: false, retest: false, state: 'REJECTED_CONFIRMED', why: 'recent_rejection' });
    compat.__enableSchemaCompatDbForTests(false);

    // (c) PARCOURS EXHAUSTIF par `key_id` : toutes les lignes, une seule fois, ordre stable.
    const vus: string[] = [];
    let apres: string | null = null;
    for (;;) {
      const page = await store.scanCouples({ states: ['REJECTED_CONFIRMED', 'NEEDS_RECHECK'], afterKeyId: apres, limit: 500 });
      expect(page).not.toBeNull();
      if (page!.length === 0) break;
      for (const c of page!) vus.push(c.keyId);
      apres = page![page!.length - 1].keyId;
    }
    expect(vus).toHaveLength(total);
    expect(new Set(vus).size).toBe(total);
    expect(vus).toContain(idAncien);
    // Ordre stable et croissant : une mise à jour concurrente d'`updated_at` ne déplace aucune ligne.
    expect([...vus].sort()).toEqual(vus);

    // (d) Reprise au milieu : la suite exacte, sans trou ni doublon — même après une mise à jour
    //     concurrente d'une ligne DÉJÀ parcourue (ce qu'un tri par `updated_at` aurait fait resurgir).
    const milieu = vus[1_000];
    await store.recordRejection(lignes[0], REFUS, t0 + 10_000_000);
    const suite: string[] = [];
    let curseur: string | null = milieu;
    for (;;) {
      const page = await store.scanCouples({ states: ['REJECTED_CONFIRMED', 'NEEDS_RECHECK'], afterKeyId: curseur, limit: 500 });
      if (page!.length === 0) break;
      for (const c of page!) suite.push(c.keyId);
      curseur = page![page!.length - 1].keyId;
    }
    expect(suite).toEqual(vus.slice(1_001));

    // (e) Bilan par état : un constat chiffré, jamais une remise à zéro.
    expect(await store.countCouples()).toMatchObject({ REJECTED_CONFIRMED: total });
  });

  it('E2E-L784-02 (§E1) — modèle RETIRÉ : alerte close avec motif ; modèle toujours déclaré ou routage illisible : alerte CONSERVÉE, non rouverte', async () => {
    await purger();
    const store = await S();
    const alerts = await A();
    const { coupleKeyId } = await C();
    const { DECLARED_MODELS } = await import('@/services/ai/registry/models');
    const base = await courantT1();
    const t0 = Date.UTC(2026, 10, 16, 9, 0, 0);

    // (a) modèle retiré : absent de la chaîne configurée ET absent du référentiel → PREUVE de retrait ;
    const retire = { ...base, model: 'modele-784-retire-definitivement' };
    // (b) modèle hors chaîne mais TOUJOURS déclaré : retrait possiblement temporaire → on ne conclut pas ;
    const toujoursDeclare = { ...base, model: DECLARED_MODELS[0]!.model };
    // (c) modèle de la chaîne configurée : l'alerte garde tout son objet.
    const route = { ...base, model: 'modele-784-route' };
    for (const k of [retire, toujoursDeclare, route]) {
      const r = await store.recordRejection(k, REFUS, t0);
      expect(await alerts.raiseSchemaIncompatibilityAlert(r!.state)).toBe(true);
    }
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_alerts WHERE code = ${CODE} AND resolved_at IS NULL`)[0].n).toBe(3);

    const bilan = await alerts.reevaluateSchemaCompatAlerts({ readChain: async () => ['modele-784-route'] });
    expect(bilan).toMatchObject({
      examined: 3, keptActive: 1, keptRoutingUnknown: 1, unavailable: false, done: true,
      resolved: { SCHEMA_MODEL_WITHDRAWN: 1, SCHEMA_ACCEPTED_AGAIN: 0, SCHEMA_SUPERSEDED: 0 },
    });
    const etat = async (keyId: string) => (await sql<{ resolved_at: Date | null; resolution_code: string | null }[]>`
      SELECT resolved_at, resolution_code FROM ai_alerts WHERE code = ${CODE} AND details->>'keyId' = ${keyId}`)[0];
    // Close AVEC MOTIF : la raison du classement est conservée, pas effacée.
    expect(await etat(coupleKeyId(retire))).toMatchObject({ resolution_code: 'SCHEMA_MODEL_WITHDRAWN' });
    expect((await etat(coupleKeyId(retire))).resolved_at).not.toBeNull();
    // CONSERVÉES : l'une faute de preuve de retrait, l'autre parce que la cause est bien réelle.
    expect(await etat(coupleKeyId(toujoursDeclare))).toMatchObject({ resolved_at: null, resolution_code: null });
    expect(await etat(coupleKeyId(route))).toMatchObject({ resolved_at: null, resolution_code: null });
    // Le refus du modèle retiré reste dans la matrice : rien n'est supprimé.
    expect(await store.getCouple(coupleKeyId(retire))).toMatchObject({ state: 'REJECTED_CONFIRMED' });

    // ROUTAGE ILLISIBLE : aucune alerte n'est close, aucune n'est levée en double.
    const illisible = await alerts.reevaluateSchemaCompatAlerts({ readChain: async () => { throw new Error('configuration illisible'); } });
    // Aucune alerte close, et AUCUNE levée : lever ici rouvrirait l'alerte du modèle retiré, qu'on
    // vient de clore — ce que la carte interdit. L'abstention est comptée, pas silencieuse.
    expect(illisible).toMatchObject({ examined: 2, keptRoutingUnknown: 2, keptActive: 0, raised: 0, raiseSkippedRoutingUnknown: 1, done: true });
    for (const k of [toujoursDeclare, route]) expect(await etat(coupleKeyId(k))).toMatchObject({ resolved_at: null });

    // PASSAGE SUIVANT (contrôle quotidien), routage de nouveau lisible : l'alerte close n'est PAS
    // rouverte, et aucun doublon n'apparaît — exigence explicite de la carte (§E1).
    const lendemain = await alerts.reevaluateSchemaCompatAlerts({ readChain: async () => ['modele-784-route'] });
    expect(lendemain).toMatchObject({ examined: 2, raised: 0, resolved: { SCHEMA_MODEL_WITHDRAWN: 0 }, done: true });
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_alerts WHERE code = ${CODE} AND details->>'keyId' = ${coupleKeyId(retire)}`)[0].n).toBe(1);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_alerts WHERE code = ${CODE}`)[0].n).toBe(3);
  });

  it('E2E-L784-03 (§E2) — PLUS DE 5 000 alertes : budget par passage, reprise exacte, interruption et idempotence', async () => {
    await purger();
    const store = await S();
    const alerts = await A();
    const base = await courantT1();
    const t0 = Date.UTC(2026, 10, 16, 10, 0, 0);

    // 5 200 couples refusés, chacun avec son alerte : au-delà des 50 pages de 100 de l'origine, qui
    // s'arrêtaient en SILENCE (défaut constaté par la carte).
    const TOTAL = 5_200;
    const couples = Array.from({ length: TOTAL }, (_, i) => ({ ...base, model: `modele-784-alerte-${String(i).padStart(5, '0')}` }));
    for (let i = 0; i < couples.length; i += 200) {
      const lot = couples.slice(i, i + 200);
      const etats = await Promise.all(lot.map((k, j) => store.recordRejection(k, REFUS, t0 + (i + j) * 10)));
      await Promise.all(etats.map((r) => alerts.raiseSchemaIncompatibilityAlert(r!.state)));
    }
    const ouvertes = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_alerts WHERE code = ${CODE} AND resolved_at IS NULL`)[0].n;
    expect(await ouvertes()).toBe(TOTAL);

    const chaine = async () => couples.map((c) => c.model);
    // (a) Passage BORNÉ : il ne tronque rien en silence — il dit où reprendre.
    const p1 = await alerts.reevaluateSchemaCompatAlerts({ maxAlerts: 1_500, readChain: chaine });
    expect(p1).toMatchObject({ examined: 1_500, done: false, keptActive: 1_500, unavailable: false });
    expect(p1.resumeFromAlertId).not.toBeNull();
    expect(p1.before.openAlerts).toBe(TOTAL);

    // (b) REPRISE exacte là où il s'est arrêté : la suite, sans trou ni doublon.
    const p2 = await alerts.reevaluateSchemaCompatAlerts({ fromAlertId: p1.resumeFromAlertId!, maxAlerts: 1_500, readChain: chaine });
    expect(p2).toMatchObject({ examined: 1_500, done: false, keptActive: 1_500 });
    const p3 = await alerts.reevaluateSchemaCompatAlerts({ fromAlertId: p2.resumeFromAlertId!, readChain: chaine });
    // Le dernier passage va jusqu'au bout : 5 200 − 3 000 = 2 200 alertes restantes.
    expect(p3).toMatchObject({ examined: TOTAL - 3_000, done: true, resumeFromAlertId: null });

    // (c) EXHAUSTIVITÉ : un passage sans borne examine les 5 200 (l'ancien s'arrêtait à 5 000).
    const complet = await alerts.reevaluateSchemaCompatAlerts({ readChain: chaine });
    expect(complet).toMatchObject({ examined: TOTAL, done: true, keptActive: TOTAL, raised: 0, unavailable: false });
    expect(complet.couplesScanned).toBe(TOTAL);
    // (d) IDEMPOTENCE : rien n'a été résolu, rien n'a été levé, rien n'a été supprimé.
    expect(complet.before.openAlerts).toBe(TOTAL);
    expect(complet.after.openAlerts).toBe(TOTAL);
    expect(await ouvertes()).toBe(TOTAL);

    // (e) Une alerte MANQUANTE est levée une seule fois, même pour un couple ANCIEN (au-delà de
    //     2 000 : la lecture bornée d'origine ne l'aurait jamais vu).
    const orphelin = couples[0];
    await sql`DELETE FROM ai_alerts WHERE code = ${CODE} AND details->>'model' = ${orphelin.model}`;
    const rattrapage = await alerts.reevaluateSchemaCompatAlerts({ readChain: chaine });
    expect(rattrapage).toMatchObject({ raised: 1, done: true });
    expect(await ouvertes()).toBe(TOTAL);
    // Un second passage n'en lève pas une de plus (pas de doublon par passage quotidien).
    expect((await alerts.reevaluateSchemaCompatAlerts({ readChain: chaine })).raised).toBe(0);
  });

  it('E2E-L784-04 (§A3) — version SERVIE : mémorisée, incertitude marquée, et un changement rend l’essai dû sans rien déclarer compatible', async () => {
    await purger();
    const store = await S();
    const { coupleKeyId, SCHEMA_COMPAT_POLICY: P } = await C();
    const base = await courantT1();
    const t0 = Date.UTC(2026, 10, 16, 11, 0, 0);

    // (a) Refus constaté SANS version servie : l'incertitude est écrite, aucune version inventée.
    const muet = { ...base, model: 'modele-784-version-muette' };
    const idMuet = coupleKeyId(muet);
    await store.recordRejection(muet, REFUS, t0);
    expect(await store.getCouple(idMuet)).toMatchObject({ versionUncertain: true, servedModelVersion: null, servedVersionAtState: null });

    // (b) Refus constaté AVEC version servie : elle devient la référence de cet état.
    const suivi = { ...base, model: 'modele-784-version-suivie' };
    const idSuivi = coupleKeyId(suivi);
    const r = await store.recordRejection(suivi, { ...REFUS, servedModelVersion: '2.5-001' }, t0);
    expect(r!.state).toMatchObject({ servedModelVersion: '2.5-001', servedVersionAtState: '2.5-001', versionUncertain: false });
    const echeanceInitiale = r!.state.nextRetestAt;
    expect(echeanceInitiale).toBe(t0 + P.firstRetestMs);

    // (c) MÊME version observée plus tard : rien ne change (aucune écriture inutile, échéance tenue).
    expect(await store.noteServedModelVersion(idSuivi, '2.5-001', t0 + 1_000)).toBeNull();
    expect(await store.getCouple(idSuivi)).toMatchObject({ nextRetestAt: echeanceInitiale });

    // (d) Version DIFFÉRENTE : le refus portait sur une autre version servie — l'essai avec schéma
    //     devient dû, mais l'état reste « refusé » : AUCUNE compatibilité n'est déclarée.
    const t1 = t0 + 2_000;
    const change = await store.noteServedModelVersion(idSuivi, '2.5-002', t1);
    expect(change).toMatchObject({ state: 'REJECTED_CONFIRMED', reason: 'SERVED_VERSION_CHANGED', servedModelVersion: '2.5-002', nextRetestAt: t1, retestClaimedUntil: null });
    expect(change!.state).not.toBe('QUALIFIED');

    // (e) L'essai redevenu dû reste RÉSERVÉ : parmi 6 instances, UNE seule le prend (aucune rafale).
    const prises = await Promise.all(Array.from({ length: 6 }, () => store.claimRetest(idSuivi, t1 + 1)));
    expect(prises.filter((x) => x !== null)).toHaveLength(1);

    // (f) Fournisseur redevenu muet : l'incertitude est marquée, l'échéance n'est pas touchée.
    const apres = await store.getCouple(idSuivi);
    await store.noteServedModelVersion(idSuivi, null, t1 + 2);
    expect(await store.getCouple(idSuivi)).toMatchObject({ versionUncertain: true, nextRetestAt: apres!.nextRetestAt, state: 'NEEDS_RECHECK' });

    // (g) Couple INCONNU : aucune ligne n'est créée.
    expect(await store.noteServedModelVersion('couple|qui|n-existe|pas', '2.5-003', t1)).toBeNull();
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_schema_compatibility`)[0].n).toBe(2);

    // (h) Migration 1795 : colonnes présentes et rétrocompatibles (profil '-' pour les lignes d'avant).
    const colonnes = await sql<{ column_name: string; column_default: string | null }[]>`
      SELECT column_name, column_default FROM information_schema.columns
       WHERE table_name = 'ai_schema_compatibility'
         AND column_name IN ('generation_profile_hash', 'served_model_version', 'served_version_at_state', 'version_uncertain')
       ORDER BY column_name`;
    expect(colonnes.map((c) => c.column_name)).toEqual(['generation_profile_hash', 'served_model_version', 'served_version_at_state', 'version_uncertain']);
    expect(await store.getCouple(idMuet)).toMatchObject({ key: { generationProfileHash: '-' } });
  });

  it('E2E-L784-05 (§D2) — PLUS DE 200 combinaisons : totaux et taux EXACTS sur l’ensemble, ventilation paginée signalée', async () => {
    const { getSchemaUsageReport, SCHEMA_USAGE_GROUP_PAGE } = await import('@/services/ai/gateway/schema-compat/supervision');
    const compte = await make.account();
    const COMBINAISONS = SCHEMA_USAGE_GROUP_PAGE + 60;
    const maintenant = new Date();
    const quand = maintenant.toISOString();
    await sql`DELETE FROM ai_usage_event WHERE operation_code = 'l784_supervision'`;

    // Une combinaison (modèle, empreinte de schéma) par trace : plus de 200 groupes, un appel chacun.
    for (let i = 0; i < COMBINAISONS; i++) {
      const metadata = {
        callKind: 'analysis',
        runtimeContract: { contractId: 'T1_ANALYZE_DOCUMENT', contractVersion: 7, schemaHash: `hash-${i}` },
        providerRequest: { responseSchemaSent: true, providerSchemaHash: `ps-${i}`, schemaOmittedReason: null },
        providerAttempts: [
          // Tentative refusée : coût INCONNU (un HTTP 400 ne prouve pas 0 €).
          { step: 1, kind: 'initial', outcome: 'FAILED', httpStatus: 400, durationMs: 120, costStatus: 'UNKNOWN', costMicros: null },
          // Tentative qui a répondu : coût OBSERVÉ.
          { step: 2, kind: 'diagnostic_retry', outcome: 'SUCCESS', httpStatus: null, durationMs: 300, costStatus: 'OBSERVED', costMicros: 10 },
        ],
        providerMeta: { structuredOutput: 'schema_rejected_retried_without' },
      };
      await sql`
        INSERT INTO ai_usage_event (account_id, operation_code, operation_type, model, status, input_tokens, output_tokens, cost_micros, duration_ms, metadata, created_at)
        VALUES (${compte.id}, 'l784_supervision', 'l784_supervision', ${`modele-784-sup-${i}`}, 'success', 100, 20, 10, 420, ${JSON.stringify(metadata)}::jsonb, ${quand}::timestamptz)`;
    }

    const r = await getSchemaUsageReport({ days: 1, operationCode: 'l784_supervision' }, new Date(maintenant.getTime() + 1_000));
    expect(r.unavailable).toBeNull();
    // Ventilation : une page, et le fait qu'il en reste est DIT.
    expect(r.groups).toHaveLength(SCHEMA_USAGE_GROUP_PAGE);
    expect(r.groupsTruncated).toBe(true);
    expect(r.groupCount).toBe(COMBINAISONS);
    // TOTAUX : ceux des 260 appels, pas ceux des 200 affichés — c'est le défaut corrigé.
    expect(r.totals.calls).toBe(COMBINAISONS);
    expect(r.totals.schemaSent).toBe(COMBINAISONS);
    expect(r.totals.schemaRefused400).toBe(COMBINAISONS);
    expect(r.totals.providerRequests).toBe(COMBINAISONS * 2);
    expect(r.totals.inputTokens).toBe(COMBINAISONS * 100);
    expect(r.totals.costMicros).toBe(COMBINAISONS * 10);
    // Taux calculés sur les totaux exacts (0 % de schéma accepté : la dégradation reste visible).
    expect(r.totals.rates).toMatchObject({ acceptedRate: 0, refusal400Rate: 1, requestsPerCall: 2 });
    expect(r.totals.durationP50Ms).toBe(420);
    // Natures de coût distinguées : une tentative observée et une INCONNUE par appel ; jamais 0 € supposé.
    expect(r.totals.attemptsCostObserved).toBe(COMBINAISONS);
    expect(r.totals.attemptsCostUnknown).toBe(COMBINAISONS);
    expect(r.totals.attemptsCostZero).toBe(0);
    // Temps passé dans les requêtes refusées : relevé, jamais fondu dans la durée de l'appel.
    expect(r.totals.failedAttemptMs).toBe(COMBINAISONS * 120);

    await sql`DELETE FROM ai_usage_event WHERE operation_code = 'l784_supervision'`;
  });

  it('E2E-L784-06 (§E1, §E3) — statut de routage servi au BO ; alertes de couverture T1 (#775) inchangées', async () => {
    await purger();
    const store = await S();
    const alerts = await A();
    const { getSchemaCompatOverview } = await import('@/services/ai/gateway/schema-compat/overview');
    const { T1_COVERAGE_ALERT_PREFIXES } = await import('@/services/ai/source-analysis/source-units/monitoring');
    const base = await courantT1();
    const t0 = Date.UTC(2026, 10, 16, 11, 0, 0);
    const couple = { ...base, model: 'modele-784-bo-routage' };
    const r = await store.recordRejection(couple, REFUS, t0);
    expect(await alerts.raiseSchemaIncompatibilityAlert(r!.state)).toBe(true);

    // §E1 : la vue d'ensemble du BO SERT le statut de routage de chaque couple, avec son libellé.
    const vue = await getSchemaCompatOverview({ days: 1, operationCode: 't1_analyze_document' });
    const ligne = (vue.couples ?? []).find((c) => c.model === couple.model);
    expect(ligne).toBeDefined();
    // Le modèle n'est pas dans la chaîne configurée de la préproduction de test : rien n'est conclu.
    expect(['ACTIVE', 'WITHDRAWN', 'UNKNOWN']).toContain(ligne!.routingStatus);
    expect(ligne!.routingLabel.length).toBeGreaterThan(10);

    // §E3 : une anomalie de couverture T1 (#775) OUVERTE, dans son propre référentiel.
    const compte = await make.account();
    const [prefixe] = T1_COVERAGE_ALERT_PREFIXES;
    await sql`DELETE FROM admin_anomalies WHERE fingerprint LIKE ${`${prefixe}%`}`;
    await sql`INSERT INTO admin_anomalies (domain, fingerprint, title, status, account_id, technical_detail)
              VALUES ('ai', ${`${prefixe}999777`}, 'Analyse T1 incomplète (e2e 784)', 'open', ${compte.id}, '{}'::jsonb)`;

    // Réévaluation des alertes de SCHÉMA : elle CONSTATE la famille de #775, et n'y touche pas.
    const bilan = await alerts.reevaluateSchemaCompatAlerts({ readChain: async () => ['modele-784-bo-routage'] });
    expect(bilan.coverageCoordination).toMatchObject({
      openCoverageAnomalies: 1, openCoverageAnomaliesAfter: 1, unchanged: true, evaluator: 'schema_compat_alerts',
    });
    expect(bilan.coverageCoordination.coverageFamily).toEqual([...T1_COVERAGE_ALERT_PREFIXES]);

    // Le schéma est de nouveau ACCEPTÉ (réussite en mode JSON puis acceptation) : l'alerte de schéma est
    // close… et la lacune de couverture T1 reste OUVERTE. Une réussite JSON ne masque aucune couverture.
    await store.recordAcceptance(couple, 'sha-e2e-784', t0 + 60_000);
    const apres = await alerts.reevaluateSchemaCompatAlerts({ readChain: async () => ['modele-784-bo-routage'] });
    expect(apres.resolved.SCHEMA_ACCEPTED_AGAIN).toBe(1);
    expect(apres.coverageCoordination).toMatchObject({ openCoverageAnomalies: 1, openCoverageAnomaliesAfter: 1, unchanged: true });
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM admin_anomalies WHERE status = 'open' AND fingerprint LIKE ${`${prefixe}%`}`;
    expect(n).toBe(1);
    await sql`DELETE FROM admin_anomalies WHERE fingerprint LIKE ${`${prefixe}%`}`;
  });
});
