/**
 * Lot 21 sur base réelle — décisions PO du 01/10 :
 *   D-J1 réglages administrés : modification, journal admin, double
 *        validation, prise en compte SANS REDÉMARRAGE par une autre instance ;
 *   D-J2 limiteur partagé : deux instances, un seul plafond ;
 *   D-J3 OPEN_SEARCH_RESULTS : jeton lié au compte, revérification en base ;
 *   §20.3 réémission : seuls les canaux en échec, origine « réémise ».
 */
import { afterAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0, planType: 'PREMIUM' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ ...session }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

scenario('LOT21-ADMIN', 'Assistant : réglages administrés, limiteur partagé, résultats de recherche', ({ sql, make }) => {
  afterAll(async () => {
    const S = await import('@/services/verebona-assistant/config/assistant-settings');
    S.setAssistantSettingsStoreForTests(null);
    vi.useRealTimers();
  });

  it('D-J1 : modification journalisée, vue par une autre instance sans redémarrage', async () => {
    const S = await import('@/services/verebona-assistant/config/assistant-settings');
    const { getAssistantConfig } = await import('@/services/verebona-assistant/config/assistant-config');
    S.setAssistantSettingsStoreForTests(S.dbAssistantSettingsStore);
    const admin = await make.user({ role: 'ADMIN' });

    await S.refreshAssistantSettings(true);
    const r = await S.updateAssistantSetting({ key: 'rate_limit_per_minute', value: 17, adminId: admin.id });
    expect(r).toMatchObject({ status: 'APPLIED', after: 17 });
    expect(getAssistantConfig().rateLimitPerMinute).toBe(17);
    const [ligne] = await sql<{ value: unknown; updated_by: number }[]>`SELECT value, updated_by FROM verebona_assistant_settings WHERE key = 'rate_limit_per_minute'`;
    expect(ligne).toMatchObject({ value: 17, updated_by: admin.id });
    const [journal] = await sql<{ admin_email: string; old_value: unknown; new_value: unknown; result: string }[]>`
      SELECT admin_email, old_value, new_value, result FROM admin_audit_log
       WHERE action_type = 'ASSISTANT_SETTING_UPDATE' AND admin_user_id = ${admin.id} ORDER BY id DESC LIMIT 1`;
    expect(journal).toMatchObject({ admin_email: admin.email, result: 'SUCCESS', new_value: { key: 'rate_limit_per_minute', value: 17 } });

    // Une AUTRE instance modifie la valeur (même base, compteur partagé).
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    await S.dbAssistantSettingsStore.write('rate_limit_per_minute', 23, admin.id);
    await S.refreshAssistantSettings();
    expect(S.effectiveSetting('rate_limit_per_minute')).toBe(17); // dans la fenêtre de 5 s
    vi.setSystemTime(Date.now() + S.REFRESH_MS + 1);
    await S.refreshAssistantSettings();
    expect(S.effectiveSetting('rate_limit_per_minute')).toBe(23);
    expect(getAssistantConfig().rateLimitPerMinute).toBe(23);
    vi.useRealTimers();
  });

  it('D-J1 : double validation — même administrateur refusé, second administrateur accordé', async () => {
    const S = await import('@/services/verebona-assistant/config/assistant-settings');
    S.setAssistantSettingsStoreForTests(S.dbAssistantSettingsStore);
    // Lot 35B : « Modèles preview en production » supprimé — le mécanisme de
    // double validation est exercé sur un réglage de test.
    const retirer = S.registerAssistantSettingForTests({
      key: 'reglage_sensible_e2e', env: 'VEREBONA_E2E_REGLAGE_SENSIBLE', group: 'interrupteurs', label: 'e2e',
      description: 'e2e', type: 'bool', default: false, doubleValidation: (v) => v === true,
    });
    const a = await make.user({ role: 'ADMIN' });
    const b = await make.user({ role: 'ADMIN' });
    const r = await S.updateAssistantSetting({ key: 'reglage_sensible_e2e', value: true, adminId: a.id }) as { status: string; requestId: number };
    expect(r.status).toBe('PENDING_APPROVAL');
    await expect(S.updateAssistantSetting({ key: 'reglage_sensible_e2e', value: true, adminId: b.id })).rejects.toMatchObject({ code: 'REQUEST_PENDING' });
    await expect(S.decideAssistantSettingRequest({ requestId: r.requestId, adminId: a.id, decision: 'approve' })).rejects.toMatchObject({ code: 'SAME_ADMIN' });
    await S.decideAssistantSettingRequest({ requestId: r.requestId, adminId: b.id, decision: 'approve' });
    expect(S.effectiveSetting('reglage_sensible_e2e')).toBe(true);
    const actions = await sql<{ action_type: string; result: string }[]>`
      SELECT action_type, result FROM admin_audit_log WHERE admin_user_id IN (${a.id}, ${b.id}) ORDER BY id`;
    expect(actions.map((x) => `${x.action_type}:${x.result}`)).toEqual([
      'ASSISTANT_SETTING_REQUEST:SUCCESS', 'ASSISTANT_SETTING_APPROVE:DENIED', 'ASSISTANT_SETTING_APPROVE:SUCCESS',
    ]);
    // Remise à l'état initial (désactiver : immédiat).
    await S.updateAssistantSetting({ key: 'reglage_sensible_e2e', value: false, adminId: a.id });
    retirer();
  });

  it('D-J2 : deux instances partagent le compteur (10 / min au total), une requête par appel', async () => {
    const { SharedRateLimiter, pgRateCounterStore } = await import('@/lib/verebona/rate-limit');
    const [{ unlogged }] = await sql<{ unlogged: boolean }[]>`
      SELECT relpersistence = 'u' AS unlogged FROM pg_class WHERE relname = 'verebona_rate_limit_counters'`;
    expect(unlogged).toBe(true);
    const store = pgRateCounterStore(sql as never);
    const a = new SharedRateLimiter(store, undefined, 2_000);
    const b = new SharedRateLimiter(store, undefined, 2_000);
    const u = 900_000 + Math.floor(Math.random() * 1000);
    const entrees = [
      { key: `e2e:q:u:${u}`, limit: 10, scope: 'user' as const },
      { key: `e2e:q:a:${u}`, limit: 30, scope: 'account' as const },
      { key: `e2e:q:ip:10.0.0.${u % 250}`, limit: 50, scope: 'ip' as const },
    ];
    const decisions = [];
    for (let i = 0; i < 11; i++) decisions.push(await (i % 2 ? a : b).check(entrees));
    expect(decisions.slice(0, 10).every((d) => d.allowed)).toBe(true);
    expect(decisions[10]).toMatchObject({ allowed: false, scope: 'user' });
    expect(decisions[10].retryAfterMs).toBeGreaterThan(0);
    const rows = await sql<{ bucket_key: string; hits: number }[]>`
      SELECT bucket_key, hits FROM verebona_rate_limit_counters WHERE bucket_key LIKE ${`e2e:q:%:${u}`} OR bucket_key LIKE 'e2e:q:ip:%'`;
    expect(rows.find((r) => r.bucket_key === `e2e:q:u:${u}`)?.hits).toBe(11);
    expect(a.health()).toMatchObject({ mode: 'shared', degraded: false });
    await store.purge();
  });

  it('D-J3 : jeton lié au compte, documents revérifiés en base avant Mes documents filtrés', async () => {
    vi.stubEnv('JWT_SECRET', 'e2e-secret');
    const compte = await make.account();
    const autre = await make.account();
    const bien = await make.asset(compte);
    const f1 = await make.assetFile(compte, { assetId: bien.id });
    const f2 = await make.assetFile(compte, { assetId: bien.id });
    const etranger = await make.assetFile(autre);
    session.userId = compte.ownerUserId;
    session.currentAccountId = compte.id;

    const { createSearchToken } = await import('@/services/verebona-assistant/core/search-token');
    const { GET } = await import('@/app/api/verebona/search-results/route');
    const { NextRequest } = await import('next/server');

    const t = createSearchToken({ accountId: compte.id, scope: 'documents', ids: [f1.id, etranger.id, f2.id], assets: [bien.id] });
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${f2.id}`;
    const r = await GET(new NextRequest(`http://app.test/api/verebona/search-results?t=${t}`));
    expect(r.status).toBe(303);
    // Le document d'un autre compte et le document supprimé sont écartés.
    expect(r.headers.get('location')).toBe(`http://app.test/documents?resultats=${f1.id}`);

    // Jeton d'un autre compte : aucun filtre.
    const t2 = createSearchToken({ accountId: autre.id, scope: 'documents', ids: [etranger.id] });
    expect((await GET(new NextRequest(`http://app.test/x?t=${t2}`))).headers.get('location')).toBe('http://app.test/documents');

    // Tous les documents du jeton ont disparu : « aucun résultat », pas la liste complète.
    const t3 = createSearchToken({ accountId: compte.id, scope: 'documents', ids: [f2.id] });
    expect((await GET(new NextRequest(`http://app.test/x?t=${t3}`))).headers.get('location')).toBe('http://app.test/documents?resultats=aucun');
    vi.unstubAllEnvs();
  });

  it('§20.3 : la réémission ne sert que l’e-mail en échec, l’origine passe à « réémise »', async () => {
    const admin = await make.user({ role: 'ADMIN' });
    const dest = await make.user();
    const cle = `e2e:reemission:${Date.now()}`;
    const [o] = await sql<{ id: string }[]>`
      INSERT INTO notification_outbox (event_type, recipient_user_id, payload_json, mandatory_bell, dedupe_key, status, created_at)
      VALUES ('e2e_test', ${dest.id}, ${JSON.stringify({ titre: 'x' })}::jsonb, true, ${cle}, 'partial', now()) RETURNING id`;
    await sql`
      INSERT INTO notification_deliveries (outbox_id, user_id, channel, status, attempt_count, created_at)
      VALUES (${o.id}, ${dest.id}, 'bell', 'sent', 1, now()), (${o.id}, ${dest.id}, 'email', 'failed', 1, now())`;

    const { reemettreNotification, ReemissionError } = await import('@/services/notifications/notification-reemission.service');
    const r = await reemettreNotification({ actorEmail: admin.email, actorUserId: admin.id, outboxId: o.id, confirme: true });
    expect(r.canaux).toEqual(['email']);
    const [nouvelle] = await sql<{ payload_json: Record<string, unknown>; mandatory_bell: boolean; status: string }[]>`
      SELECT payload_json, mandatory_bell, status FROM notification_outbox WHERE id = ${r.nouvelleId}`;
    expect(nouvelle).toMatchObject({ status: 'pending', mandatory_bell: true, payload_json: { titre: 'x', _reemission: { origine: o.id, canaux: ['email'] } } });
    const [origine] = await sql<{ status: string }[]>`SELECT status FROM notification_outbox WHERE id = ${o.id}`;
    expect(origine.status).toBe('reemitted');

    // Seconde réémission du même échec : refusée.
    await expect(reemettreNotification({ actorEmail: admin.email, actorUserId: admin.id, outboxId: o.id, confirme: true }))
      .rejects.toMatchObject({ code: 'DEJA_REEMISE' });
    expect(ReemissionError).toBeDefined();

    // Tout livré : rien à réémettre, l'origine reste inchangée.
    const [o2] = await sql<{ id: string }[]>`
      INSERT INTO notification_outbox (event_type, recipient_user_id, dedupe_key, status, created_at)
      VALUES ('e2e_test', ${dest.id}, ${cle + ':2'}, 'sent', now()) RETURNING id`;
    await sql`INSERT INTO notification_deliveries (outbox_id, user_id, channel, status, attempt_count, created_at)
      VALUES (${o2.id}, ${dest.id}, 'bell', 'sent', 1, now())`;
    await expect(reemettreNotification({ actorEmail: admin.email, actorUserId: admin.id, outboxId: o2.id, confirme: true }))
      .rejects.toMatchObject({ code: 'RIEN_A_REEMETTRE' });
    expect((await sql<{ status: string }[]>`SELECT status FROM notification_outbox WHERE id = ${o2.id}`)[0].status).toBe('sent');
  });
});
