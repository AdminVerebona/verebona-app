/**
 * Lot 23 sur base réelle — CDC Assistant §32.6, §15.12 :
 *   · invalidation d'un cache depuis le BO : version partagée incrémentée,
 *     vue par une AUTRE instance, journal admin (auteur, date, motif) ;
 *   · familles de `ai_operation_idempotency` : suppression ciblée, clés
 *     réservées (dernier corpus d'aide valide) jamais supprimées ;
 *   · état des caches lisible sur le schéma réel ;
 *   · export CSV des métriques agrégées : période, cloisonnement (aucun
 *     identifiant), anonymisation des offres, échappement, journal ;
 *   · registre des modèles en lecture seule ; migration 0237 (index).
 */
import { afterAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ adminId: 0, email: 'admin@e2e.test' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => session.adminId,
    getSession: async () => ({ userId: session.adminId, email: session.email }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));

const JOUR = '2031-01-15'; // période isolée des autres scénarios

scenario('LOT23', 'Caches (état, invalidation multi-instances, journal), export CSV des métriques, registre des modèles', ({ sql, make }) => {
  afterAll(async () => {
    await sql`DELETE FROM ai_operation_idempotency WHERE key_hash LIKE 'e2e-l23%' OR key_hash LIKE 't4-temporal:e2e-l23%' OR key_hash LIKE 'assistant:ce2e%'`;
    await sql`DELETE FROM verebona_request_runs WHERE request_id LIKE 'e2e-l23-%'`;
    await sql`DELETE FROM ai_usage_event WHERE master_prompt_version = 't2_master_v1@e2e'`;
    await sql`DELETE FROM verebona_ai_runs WHERE request_id LIKE 'e2e-l23-%'`;
  });

  it('invalidation : version partagée, autre instance, journal auteur / date / motif', async () => {
    const { SharedCacheInvalidator, dbSharedCacheVersionStore } = await import('@/services/ai/cache/shared-cache-invalidation');
    const A = await import('@/services/ai/cache/cache-admin');
    const admin = await make.user({ role: 'ADMIN' });
    const videB = vi.fn();
    const instanceA = A.registerLocalCaches(new SharedCacheInvalidator(dbSharedCacheVersionStore));
    const instanceB = new SharedCacheInvalidator(dbSharedCacheVersionStore).register('help-corpus', videB);
    await instanceA.poll();
    await instanceB.poll();
    const [avant] = await sql<{ version: string }[]>`SELECT version FROM verebona_cache_versions WHERE scope = 'cache:help-corpus'`;

    await A.invalidateAdminCache({ cacheId: 'help-corpus', reason: 'Articles republiés (e2e)', adminId: admin.id }, { invalidator: instanceA });

    const [apres] = await sql<{ version: string; last_reason: string }[]>`SELECT version, last_reason FROM verebona_cache_versions WHERE scope = 'cache:help-corpus'`;
    expect(Number(apres.version)).toBe(Number(avant?.version ?? 0) + 1);
    expect(apres.last_reason).toBe(`admin:${admin.id}`);
    expect(await instanceB.poll()).toEqual(['help-corpus']);
    expect(videB).toHaveBeenCalledTimes(1);

    const [j] = await sql<{ admin_email: string; result: string; target_type: string; new_value: { cache: string; reason: string }; timestamp: Date }[]>`
      SELECT admin_email, result, target_type, new_value, timestamp FROM admin_audit_log
       WHERE action_type = 'AI_CACHE_INVALIDATE' AND admin_user_id = ${admin.id} ORDER BY id DESC LIMIT 1`;
    expect(j).toMatchObject({ admin_email: admin.email, result: 'SUCCESS', target_type: 'AI_CACHE', new_value: { cache: 'help-corpus', reason: 'Articles republiés (e2e)' } });
    expect(Date.now() - new Date(j.timestamp).getTime()).toBeLessThan(60_000);

    // Retrieval : la version GLOBALE (clé de toutes les instances) bouge.
    const [g0] = await sql<{ version: string }[]>`SELECT version FROM verebona_cache_versions WHERE scope = 'global'`;
    await A.invalidateAdminCache({ cacheId: 'retrieval', reason: 'Données corrigées (e2e)', adminId: admin.id }, { invalidator: instanceA });
    const [g1] = await sql<{ version: string }[]>`SELECT version FROM verebona_cache_versions WHERE scope = 'global'`;
    expect(Number(g1.version)).toBe(Number(g0?.version ?? 0) + 1);
  });

  it('familles d’idempotence : suppression ciblée, clé réservée conservée ; état lisible', async () => {
    const A = await import('@/services/ai/cache/cache-admin');
    const { SharedCacheInvalidator, dbSharedCacheVersionStore } = await import('@/services/ai/cache/shared-cache-invalidation');
    const inv = new SharedCacheInvalidator(dbSharedCacheVersionStore);
    const admin = await make.user({ role: 'ADMIN' });
    await sql`INSERT INTO ai_operation_idempotency (key_hash, result_json, expires_at) VALUES
      ('t4-temporal:e2e-l23:a1', '{}'::jsonb, now() + interval '1 day'),
      ('assistant:ce2e1:x', '{}'::jsonb, now() + interval '1 day'),
      ('e2e-l23-passerelle', '{}'::jsonb, now() + interval '1 day'),
      ('help-corpus:last-valid:e2e-l23', '{"version":"v-e2e"}'::jsonb, 'infinity')
      ON CONFLICT (key_hash) DO NOTHING`;

    const etat = await A.getCachesState();
    expect(etat.caches).toHaveLength(A.ADMIN_CACHE_IDS.length);
    expect(etat.notes.filter((n) => /lecture impossible/.test(n))).toEqual([]);
    expect(etat.caches.find((c) => c.id === 't4-temporal')!.volume[0].value).toBeGreaterThanOrEqual(1);

    const t4 = await A.invalidateAdminCache({ cacheId: 't4-temporal', reason: 'Règle de dates revue (e2e)', adminId: admin.id }, { invalidator: inv });
    expect(t4.effect.rowsDeleted).toBeGreaterThanOrEqual(1);
    await A.invalidateAdminCache({ cacheId: 'gateway-idempotency', reason: 'Schéma modifié (e2e)', adminId: admin.id }, { invalidator: inv });
    const restantes = (await sql<{ key_hash: string }[]>`
      SELECT key_hash FROM ai_operation_idempotency
       WHERE key_hash IN ('t4-temporal:e2e-l23:a1', 'assistant:ce2e1:x', 'e2e-l23-passerelle', 'help-corpus:last-valid:e2e-l23')
       ORDER BY key_hash`).map((r) => r.key_hash);
    expect(restantes).toEqual(['assistant:ce2e1:x', 'help-corpus:last-valid:e2e-l23']);
    await sql`DELETE FROM ai_operation_idempotency WHERE key_hash = 'help-corpus:last-valid:e2e-l23'`;

    // Route : motif absent → 400 ; état → 200.
    session.adminId = admin.id;
    const { GET, POST } = await import('@/app/api/admin/ai/caches/route');
    const { NextRequest } = await import('next/server');
    const refus = await POST(new NextRequest('http://app.test/api/admin/ai/caches', { method: 'POST', body: JSON.stringify({ cacheId: 'prompts', reason: '' }) }));
    expect(refus.status).toBe(400);
    expect((await GET(new NextRequest('http://app.test/api/admin/ai/caches'))).status).toBe(200);
  });

  it('export CSV en flux : période, seuil de 5 comptes, filtres, échappement, journal', async () => {
    const comptes = [];
    for (let i = 0; i < 5; i++) comptes.push(await make.account());
    const rare = await make.account();
    await sql`UPDATE accounts SET plan_type = 'PREMIUM' WHERE id = ${rare.id}`;
    for (const [i, c] of comptes.entries()) {
      await sql`INSERT INTO verebona_request_runs (request_id, account_id, user_id, intent, mode, status, latency_ms, cache_hit, created_at)
                VALUES (${`e2e-l23-r${i}`}, ${c.id}, ${c.ownerUserId}, 'ACCOUNT_SUMMARY', 'ai', 'ok', ${1000 + i}, ${i === 0}, ${`${JOUR}T10:00:00+01:00`})`;
    }
    await sql`INSERT INTO verebona_request_runs (request_id, account_id, user_id, intent, mode, status, latency_ms, cache_hit, created_at) VALUES
      ('e2e-l23-rare', ${rare.id}, ${rare.ownerUserId}, 'E2E_RARE_INTENT', 'ai', 'ok', 700, false, ${`${JOUR}T11:00:00+01:00`}),
      ('e2e-l23-hors', ${rare.id}, ${rare.ownerUserId}, 'ACCOUNT_SUMMARY', 'ai', 'ok', 500, false, ${'2031-01-20T10:00:00+01:00'})`;
    await sql`INSERT INTO verebona_ai_runs (request_id, account_id, model_alias, resolved_model_id, prompt_version, input_tokens, output_tokens,
                estimated_cost_micros, latency_ms, fallback_used, status, created_at) VALUES
      ('e2e-l23-rare', ${rare.id}, 'assistant-default:t2_answer', 'gemini-3.5-flash-lite', '=HACK()', 4000, 200, 600, 900, false, 'ok', ${`${JOUR}T10:00:00+01:00`})`;
    await sql`INSERT INTO ai_usage_event (account_id, operation_type, use_case_code, operation_code, model, input_tokens, output_tokens, cost_micros, status, master_prompt_version, created_at)
              VALUES (${rare.id}, 't2_answer', 'INTELLIGENT_ASSISTANT', 't2_answer', 'gemini-3.5-flash-lite', 4000, 200, 600, 'success', 't2_master_v1@e2e', ${`${JOUR}T10:00:00+01:00`})`;

    const admin = await make.user({ role: 'ADMIN' });
    session.adminId = admin.id;
    const { GET } = await import('@/app/api/admin/ai/metrics-export/route');
    const { NextRequest } = await import('next/server');
    const lire = async (qs: string) => {
      const res = await GET(new NextRequest(`http://app.test/api/admin/ai/metrics-export?${qs}`));
      expect(res.status).toBe(200);
      return { res, lignes: (await res.text()).replace(/^﻿/, '').trim().split('\r\n') };
    };
    const { res, lignes } = await lire(`from=${JOUR}&to=${JOUR}`);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toContain(`verebona-metriques-ia_${JOUR}_${JOUR}.csv`);
    expect(lignes[0]).toBe('section;jour;intention;mode;statut;offre;traitement;alias_modele;modele;version_prompt;tache;indicateur;valeur');
    expect(lignes).toContain(`_meta;;;;;;;;;;;periode_debut;${JOUR}`);
    expect(lignes).toContain(`assistant_demandes;${JOUR};ACCOUNT_SUMMARY;ai;ok;;;;;;;demandes;5`); // ≥ 5 comptes : libellé visible
    expect(lignes).toContain(`assistant_demandes;${JOUR};< 5 comptes;ai;ok;;;;;;;demandes;1`); // intention rare masquée
    expect(lignes.join('\n')).not.toContain('E2E_RARE_INTENT');
    expect(lignes).toContain(`assistant_appels_modele;${JOUR};;;ok;;T2;< 5 comptes;< 5 comptes;;'=HACK();appels;1`); // tâche neutralisée
    expect(lignes).toContain(`ia_usage_par_offre;${JOUR};;;;< 5 comptes;INTELLIGENT_ASSISTANT;;;t2_master_v1@e2e;;appels;1`);
    expect(lignes.at(-1)).toBe('_meta;;;;;;;;;;;tronque;non');
    expect(lignes.join('\n')).not.toContain('2031-01-20'); // hors période
    expect(lignes.join('\n')).not.toMatch(new RegExp(`;(${[...comptes, rare].map((c) => c.id).join('|')});|e2e-l23-`)); // aucun identifiant

    // Filtre d'offre : les groupes < 5 comptes sont RETIRÉS (pas réétiquetés).
    const offre = await lire(`from=${JOUR}&to=${JOUR}&plan=PREMIUM`);
    expect(offre.lignes.filter((l) => !l.startsWith('_meta') && !l.startsWith('section;'))).toEqual([]);
    expect(offre.lignes).toContain('_meta;;;;;;;;;;;filtre_plan;PREMIUM (sections : assistant_demandes, assistant_appels_modele, ia_usage_par_offre)');
    // Version de prompt : version maître réelle (usage par offre seulement).
    const version = await lire(`from=${JOUR}&to=${JOUR}&promptVersion=autre_version`);
    expect(version.lignes.some((l) => l.startsWith('ia_usage_par_offre;'))).toBe(false);
    expect(version.lignes.some((l) => l.startsWith('assistant_demandes;'))).toBe(true);

    await new Promise((r) => setTimeout(r, 50)); // journal de fin de flux
    const journal = await sql<{ result: string; details: string; new_value: { from: string; to: string } }[]>`
      SELECT result, details, new_value FROM admin_audit_log WHERE action_type = 'AI_METRICS_EXPORT' AND admin_user_id = ${admin.id} ORDER BY id`;
    // La ligne « fin » est écrite à la clôture du flux, de façon asynchrone :
    // elle peut suivre la « demande » de l'export suivant. On contrôle donc
    // les volumes et le contenu, pas l'ordre d'insertion.
    const phases = journal.map((j) => [j.result, JSON.parse(j.details).phase] as const);
    expect(phases.filter(([r, p]) => r === 'SUCCESS' && p === 'demande')).toHaveLength(3);
    expect(phases.filter(([r, p]) => r === 'SUCCESS' && p === 'fin')).toHaveLength(3);
    expect(phases).toHaveLength(6);
    expect(phases[0]).toEqual(['SUCCESS', 'demande']);
    const fins = journal.filter((j) => JSON.parse(j.details).phase === 'fin');
    for (const f of fins) expect(JSON.parse(f.details)).toMatchObject({ truncated: false });
    expect(journal[0].new_value).toMatchObject({ from: JOUR, to: JOUR });

    const refus = await GET(new NextRequest('http://app.test/api/admin/ai/metrics-export?from=2030-01-01&to=2031-06-01'));
    expect(refus.status).toBe(400);
  });

  it('registre des modèles (lecture seule) et index de la migration 0237', async () => {
    const admin = await make.user({ role: 'ADMIN' });
    session.adminId = admin.id;
    const { GET } = await import('@/app/api/admin/ai/model-registry/route');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest('http://app.test/api/admin/ai/model-registry'));
    expect(res.status).toBe(200);
    const body = await res.json() as { aliases: Array<{ alias: string; status: string; rollbackModel: string | null }>; models: Array<{ model: string }>; coherence: Array<{ level: string }> };
    expect(body.aliases.map((a) => a.alias)).toEqual(['assistant-default', 'assistant-escalation']);
    expect(body.aliases.every((a) => a.status === 'stable' && a.rollbackModel)).toBe(true);
    expect(body.coherence.filter((i) => i.level === 'error')).toEqual([]);
    const [idx] = await sql<{ valid: boolean }[]>`
      SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'verebona_ai_runs_created_at_idx'`;
    expect(idx?.valid).toBe(true);
  });
});
