/**
 * Lot 102D — opposition à l'utilisation des données pour l'amélioration, sur
 * PostgreSQL réel.
 *
 *   AC-1  Mon compte (API) : opposition enregistrée et TRACÉE (date, auteur,
 *         canal, libellé exact, empreinte) ; idempotente
 *   AC-2  retrait : membre non auteur refusé ; titulaire accepté ;
 *         `excluded_before` figé au retrait
 *   AC-3  qualification : compte opposé exclu des comptes réels ; rejeu : ni
 *         capture d'un compte opposé, ni capture antérieure au retrait ; les
 *         captures postérieures au retrait servent de nouveau
 *   AC-4  exports d'exécutions IA : contenu d'un compte opposé jamais exporté
 *         (même habilité) ; autre compte inchangé
 *   AC-5  BO : consultation (état, journal, total) ; suppression du compte →
 *         préférences et journal supprimés
 *   AC-6  service rendu inchangé : éligibilité aux traitements métier intacte
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';

const APP = 'https://app.e2e.verebona.test';
const etat = vi.hoisted(() => ({ session: { userId: 0, currentAccountId: 0 as number | null }, adminOk: true }));

vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: etat.session.userId, currentAccountId: etat.session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
    requireAdmin: async () => { if (!etat.adminOk) throw new Error('ADMIN_REQUIRED'); return 1; },
  },
}));

const put = (body: unknown, ua = 'Mozilla/5.0 Verebona-iOS') => new NextRequest(`${APP}/api/users/me/data-use`, {
  method: 'PUT', headers: { 'content-type': 'application/json', 'user-agent': ua }, body: JSON.stringify(body),
});

scenario('L102D-O', 'Opposition à l’utilisation des données pour l’amélioration', ({ sql, make }) => {
  async function capture(accountId: number, at: string, op = 't4_classify_event') {
    const [r] = await sql<Array<{ id: number }>>`
      INSERT INTO ai_call_captures (captured_at, trace_id, call_kind, origin, account_id, operation_code, capture_status, prompt_status, prompt_text, response_status, response_raw)
      VALUES (${at}::timestamptz, ${`l102d-${accountId}-${at}`}, 'analysis', 'gateway', ${accountId}, ${op}, 'CAPTURED', 'CAPTURED', 'PROMPT-L102D', 'CAPTURED', 'REPONSE-L102D')
      RETURNING id`;
    return Number(r.id);
  }

  it('AC-1 — opposition depuis l’application : enregistrée, tracée, idempotente', async () => {
    const acc = await make.account();
    etat.session = { userId: acc.ownerUserId, currentAccountId: acc.id };
    const { GET, PUT } = await import('@/app/api/users/me/data-use/route');
    expect((await (await GET(new NextRequest(`${APP}/api/users/me/data-use`))).json()).preference.optOut).toBe(false);

    const r1 = await PUT(put({ optOut: true, channel: 'mobile' }));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ changed: true, preference: { optOut: true } });
    const r2 = await PUT(put({ optOut: true, channel: 'mobile' }));
    expect((await r2.json()).changed).toBe(false);

    const [pref] = await sql<Array<{ improvement_opt_out: boolean; opted_out_by_user_id: number; excluded_before: string }>>`
      SELECT improvement_opt_out, opted_out_by_user_id, excluded_before::text AS excluded_before FROM account_data_use_preferences WHERE account_id = ${acc.id}`;
    expect(pref).toEqual({ improvement_opt_out: true, opted_out_by_user_id: acc.ownerUserId, excluded_before: 'infinity' });
    const ev = await sql<Array<{ action: string; channel: string; user_id: number; label_shown: string; label_sha256: string; user_agent: string }>>`
      SELECT action, channel, user_id, label_shown, label_sha256, user_agent FROM account_data_use_preference_events WHERE account_id = ${acc.id}`;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ action: 'OPT_OUT', channel: 'mobile', user_id: acc.ownerUserId, user_agent: 'Mozilla/5.0 Verebona-iOS' });
    expect(ev[0].label_shown).toMatch(/Je m’oppose[\s\S]*— activé$/);
    expect(ev[0].label_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('AC-2 — retrait : refusé au membre non auteur, accepté au titulaire ; exclusion figée au retrait', async () => {
    const acc = await make.account();
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${acc.id}, ${membre.id}, 'member', 'active')`;
    const { PUT } = await import('@/app/api/users/me/data-use/route');
    etat.session = { userId: acc.ownerUserId, currentAccountId: acc.id };
    await PUT(put({ optOut: true }));
    etat.session = { userId: membre.id, currentAccountId: acc.id };
    expect((await PUT(put({ optOut: false }))).status).toBe(403);
    etat.session = { userId: acc.ownerUserId, currentAccountId: acc.id };
    const ok = await PUT(put({ optOut: false }));
    expect((await ok.json()).preference.optOut).toBe(false);
    const [pref] = await sql<Array<{ excluded_before: Date; withdrawn_at: Date }>>`
      SELECT excluded_before, withdrawn_at FROM account_data_use_preferences WHERE account_id = ${acc.id}`;
    expect(new Date(pref.excluded_before).getTime()).toBe(new Date(pref.withdrawn_at).getTime());
    const actions = await sql<Array<{ action: string }>>`SELECT action FROM account_data_use_preference_events WHERE account_id = ${acc.id} ORDER BY id`;
    expect(actions.map((a) => a.action)).toEqual(['OPT_OUT', 'OPT_IN']);
  });

  it('AC-3 — qualification : comptes et rejeu des captures respectent l’opposition', async () => {
    const libre = await make.account();
    const oppose = await make.account();
    const retire = await make.account();
    const { setImprovementOptOut } = await import('@/services/privacy/improvement-opt-out');
    await setImprovementOptOut({ accountId: oppose.id, userId: oppose.ownerUserId, optOut: true, channel: 'web' });

    const cLibre = await capture(libre.id, '2026-10-01T10:00:00Z');
    const cOppose = await capture(oppose.id, '2026-10-01T10:00:00Z');
    const cAvant = await capture(retire.id, '2026-10-01T10:00:00Z');
    await setImprovementOptOut({ accountId: retire.id, userId: retire.ownerUserId, optOut: true, channel: 'web', now: new Date('2026-10-05T10:00:00Z') });
    await setImprovementOptOut({ accountId: retire.id, userId: retire.ownerUserId, optOut: false, channel: 'web', now: new Date('2026-10-10T10:00:00Z') });
    const cPendant = await capture(retire.id, '2026-10-07T10:00:00Z');
    const cApres = await capture(retire.id, '2026-10-12T10:00:00Z');

    const repo = await import('@/services/ai/qualification/repository');
    const comptes = await repo.eligibleAccountIds(null);
    expect(comptes).toContain(libre.id);
    expect(comptes).toContain(retire.id);
    expect(comptes).not.toContain(oppose.id);

    const rows = await repo.loadReplayCaptures({ operationCode: 't4_classify_event', accountIds: [libre.id, oppose.id, retire.id], perAccount: 10, max: 100 });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(cLibre);
    expect(ids).toContain(cApres);
    expect(ids).not.toContain(cOppose);
    expect(ids).not.toContain(cAvant);
    expect(ids).not.toContain(cPendant);
  });

  it('AC-4 — export d’exécutions IA : contenu d’un compte opposé retiré, même pour un habilité', async () => {
    const libre = await make.account();
    const oppose = await make.account();
    const { setImprovementOptOut } = await import('@/services/privacy/improvement-opt-out');
    await setImprovementOptOut({ accountId: oppose.id, userId: oppose.ownerUserId, optOut: true, channel: 'web' });
    const xs: Array<{ id: string; traceIds: string[] }> = [];
    for (const a of [libre, oppose]) {
      const exec = `l102d:${a.id}`;
      const [ev] = await sql<Array<{ id: number }>>`
        INSERT INTO ai_usage_event (account_id, operation_type, operation_code, provider, model, status, metadata, business_execution_id)
        VALUES (${a.id}, 't4_classify_event', 't4_classify_event', 'fake', 'm', 'success', ${JSON.stringify({ traceId: `t-${exec}` })}::jsonb, ${exec})
        RETURNING id`;
      await sql`INSERT INTO ai_call_captures (trace_id, usage_event_id, call_kind, origin, account_id, operation_code, capture_status, prompt_status, prompt_text, response_status, response_raw, business_execution_id)
                VALUES (${`t-${exec}`}, ${ev.id}, 'analysis', 'gateway', ${a.id}, 't4_classify_event', 'CAPTURED', 'CAPTURED', ${`PROMPT-${a.id}-L102D`}, 'CAPTURED', ${`REPONSE-${a.id}-L102D`}, ${exec})`;
      xs.push({ id: exec, traceIds: [`t-${exec}`] });
    }
    const { readCallsOf, callLine } = await import('@/services/ai/business-execution/export');
    const q = async (text: string, params: unknown[] = []) => (await sql.unsafe(text, params as never[])) as unknown as Record<string, unknown>[];
    const calls = await readCallsOf(q, xs as never, true);
    const ligne = (exec: string) => JSON.stringify(calls.get(exec)!.map((c) => callLine(exec, c.row, c.capture, true)));
    expect(ligne(`l102d:${libre.id}`)).toContain(`PROMPT-${libre.id}-L102D`);
    const exclue = ligne(`l102d:${oppose.id}`);
    expect(exclue).not.toContain(`PROMPT-${oppose.id}-L102D`);
    expect(exclue).not.toContain(`REPONSE-${oppose.id}-L102D`);
    expect(exclue).toContain('"$etat":"exclu"');
  });

  it('AC-5 — BO : état, journal, total ; suppression du compte → données supprimées', async () => {
    const acc = await make.account();
    const { setImprovementOptOut } = await import('@/services/privacy/improvement-opt-out');
    await setImprovementOptOut({ accountId: acc.id, userId: acc.ownerUserId, optOut: true, channel: 'web' });
    const { GET } = await import('@/app/api/admin/accounts/[id]/data-use/route');
    const res = await GET(new NextRequest(`${APP}/api/admin/accounts/${acc.id}/data-use`), { params: Promise.resolve({ id: String(acc.id) }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.preference.optOut).toBe(true);
    expect(body.events[0]).toMatchObject({ action: 'OPT_OUT', channel: 'web' });
    expect(body.totalOptedOut).toBeGreaterThanOrEqual(1);
    etat.adminOk = false;
    try {
      const refus = await GET(new NextRequest(`${APP}/api/admin/accounts/${acc.id}/data-use`), { params: Promise.resolve({ id: String(acc.id) }) });
      expect(refus.status).toBeGreaterThanOrEqual(401);
    } finally { etat.adminOk = true; }

    await sql`DELETE FROM accounts WHERE id = ${acc.id}`;
    expect(await sql`SELECT 1 FROM account_data_use_preferences WHERE account_id = ${acc.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM account_data_use_preference_events WHERE account_id = ${acc.id}`).toHaveLength(0);
  });

  it('AC-6 — service rendu inchangé : le compte opposé reste éligible à ses traitements', async () => {
    const acc = await make.account();
    const { setImprovementOptOut } = await import('@/services/privacy/improvement-opt-out');
    await setImprovementOptOut({ accountId: acc.id, userId: acc.ownerUserId, optOut: true, channel: 'web' });
    const { processingEligibleSql } = await import('@/services/account/processing-eligibility');
    const [r] = await sql.unsafe(`SELECT ${processingEligibleSql('$1::int')} AS ok`, [acc.id] as never[]) as unknown as Array<{ ok: boolean }>;
    expect(r.ok).toBe(true);
  });
});
