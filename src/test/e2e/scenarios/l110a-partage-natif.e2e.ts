/**
 * Lot 110A — partage natif iOS / Android : jeton d'import et UNE SEULE
 * opération d'import, sur PostgreSQL réel.
 *
 *   · le jeton n'est émis que derrière la garde de session (route `grant`),
 *     ne sert qu'à l'import, dans l'espace de la session qui l'a produit ;
 *   · l'import passe par les MÊMES routes que le dépôt (`presign`, `confirm`) :
 *     document COMPLETED, travail T1 en file, idempotence par identifiant
 *     d'import (reprise = même document, aucun doublon) ;
 *   · statuts fidèles : refus définitif (format, quota), « auth » (jeton
 *     expiré / révoqué / épuisé, session révoquée), « retry » (stockage) ;
 *   · isolation des comptes (Duo : changement d'espace, retrait d'adhésion).
 *
 * Le stockage n'est jamais appelé : dépôt simulé, objet vérifié simulé.
 */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { scenario } from '../scenario';

vi.mock('@/services/documents/thumbnails/thumbnail.service', async (o) => ({
  ...(await o<typeof import('@/services/documents/thumbnails/thumbnail.service')>()),
  enqueueThumbnails: () => undefined,
}));

process.env.OVH_S3_ACCESS_KEY_ID ??= 'e2e';
process.env.OVH_S3_SECRET_ACCESS_KEY ??= 'e2e';
process.env.OVH_S3_BUCKET ??= 'e2e-bucket';
process.env.OVH_S3_ENDPOINT ??= 'https://s3.e2e.invalid';

/** Session de l'application ouverte (routes `grant` et `status`). */
const session = { userId: 0, currentAccountId: 0, sid: 'sid-e2e', email: 'x@test.invalid', role: 'USER', status: 'ACTIVE', planType: 'standard' };
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ ...session }),
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()),
  emitBusinessEvent: async () => {},
  emitBusinessEvents: async () => {},
}));
vi.mock('@/services/commercial-model.service', async (o) => ({ ...(await o<object>()), canConsumeAnalysis: async () => ({ allowed: true }) }));
const droits = vi.hoisted(() => ({ document: true, cguv: false }));
vi.mock('@/services/entitlements.service', async (o) => ({
  ...(await o<object>()),
  canAddDocument: async () => (droits.document ? { allowed: true } : { allowed: false, reason: 'DOCUMENT_QUOTA_REACHED', message: 'Quota atteint', limit: 30 }),
}));
vi.mock('@/services/legal/cguv-reacceptance.service', async (o) => ({ ...(await o<object>()), isReacceptanceRequired: async () => droits.cguv }));
vi.mock('@/lib/write-access-guard', () => ({ refuserSiLectureSeule: async () => null }));
vi.mock('@/services/document-ai/fusion-detector', () => ({ detectFusionCandidates: async () => [] }));
vi.mock('@/lib/upload-object-check', () => ({ verificationObjetActive: () => true, verifierObjetDepose: async () => ({ kind: 'ok' }) }));

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const op = () => crypto.randomUUID();

scenario('L110A', 'Partage natif : jeton d’import, opération d’import unique, statuts, isolation', ({ sql, make }) => {
  const depots: string[] = [];
  let stockageEnPanne = false;

  beforeEach(async () => {
    droits.document = true;
    droits.cguv = false;
    stockageEnPanne = false;
    depots.length = 0;
    const { __setShareImportStorageWriterForTests } = await import('@/services/mobile/share-import/import-operation');
    __setShareImportStorageWriterForTests(async (url) => {
      if (stockageEnPanne) throw new Error('stockage injoignable (simulé)');
      depots.push(url);
    });
  });
  afterAll(async () => {
    const { __setShareImportStorageWriterForTests } = await import('@/services/mobile/share-import/import-operation');
    __setShareImportStorageWriterForTests(null);
  });

  const ouvrirSession = (userId: number, accountId: number, sid = `sid-${userId}-${accountId}`) => {
    session.userId = userId;
    session.currentAccountId = accountId;
    session.sid = sid;
  };
  const jeton = async (client = 'IOS') => {
    const { POST } = await import('@/app/api/mobile/share-import/grant/route');
    const res = await POST(new NextRequest('http://x/api/mobile/share-import/grant', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-verebona-client': client, 'x-verebona-app-version': '1.0.0' }, body: '{}',
    }));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const importer = async (token: string, o: { operationId?: string; body?: Uint8Array; mime?: string; name?: string; sha?: string } = {}) => {
    const body = o.body ?? PDF;
    const { POST } = await import('@/app/api/mobile/share-import/upload/route');
    const res = await POST(new NextRequest('http://x/api/mobile/share-import/upload', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': o.mime ?? 'application/pdf',
        'x-verebona-operation-id': o.operationId ?? op(),
        'x-verebona-file-name': encodeURIComponent(o.name ?? 'Facture énergie.pdf'),
        'x-verebona-sha256': o.sha ?? sha(body),
      },
      body: body as unknown as BodyInit,
    }));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const statuts = async (ops: string[]) => {
    const { GET } = await import('@/app/api/mobile/share-import/status/route');
    const res = await GET(new NextRequest(`http://x/api/mobile/share-import/status?ops=${ops.join(',')}`));
    return (await res.json() as { items: Array<Record<string, unknown>> }).items;
  };
  const lignes = (operationId: string) => sql<{ id: number; account_id: number; upload_status: string; original_filename: string }[]>`
    SELECT id, account_id, upload_status, original_filename FROM asset_files WHERE upload_operation_id = ${operationId}`;
  const travauxT1 = async (fileId: number) => Number((await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ai_job_queue WHERE treatment = 'T1' AND target_type = 'asset_file' AND target_id = ${String(fileId)}`)[0].n);

  it('jeton : émis derrière la session, pour l’app native seulement ; seule l’empreinte est stockée', async () => {
    const c = await make.account({ plan: 'premium' });
    ouvrirSession(c.ownerUserId, c.id);
    expect((await jeton('WEB')).status).toBe(400);
    const g = await jeton('IOS');
    expect(g.status).toBe(201);
    expect(String(g.body.token)).toMatch(/^vbsi_[A-Za-z0-9_-]{43}$/);
    expect(g.body).toMatchObject({ accountKey: `u${c.ownerUserId}-a${c.id}`, maxUses: 100, uploadPath: '/api/mobile/share-import/upload' });
    const h = Date.parse(String(g.body.expiresAt)) - Date.now();
    expect(h).toBeGreaterThan(71 * 3600_000);
    expect(h).toBeLessThanOrEqual(72 * 3600_000);
    const [row] = await sql<{ token_hash: string; platform: string; session_sid: string }[]>`
      SELECT token_hash, platform, session_sid FROM mobile_share_import_grants WHERE user_id = ${c.ownerUserId}`;
    expect(row).toMatchObject({ token_hash: sha(new TextEncoder().encode(String(g.body.token))), platform: 'ios', session_sid: `sid-${c.ownerUserId}-${c.id}` });
  });

  it('import : MÊME opération que le dépôt (COMPLETED, T1) ; reprise = même document, sans doublon', async () => {
    const c = await make.account({ plan: 'premium' });
    ouvrirSession(c.ownerUserId, c.id);
    const token = String((await jeton()).body.token);
    const id = op();
    const a = await importer(token, { operationId: id });
    expect(a).toMatchObject({ status: 201, body: { outcome: 'imported', operationId: id } });
    const fileId = Number(a.body.fileId);
    expect(await lignes(id)).toEqual([expect.objectContaining({ id: fileId, account_id: c.id, upload_status: 'COMPLETED', original_filename: 'Facture énergie.pdf' })]);
    expect(await travauxT1(fileId)).toBe(1);
    expect(depots).toHaveLength(1);
    expect(depots[0]).toMatch(/X-Amz-Signature=/);

    // Accusé perdu, double toucher, redémarrage : même identifiant d'import.
    const b = await importer(token, { operationId: id });
    expect(b).toMatchObject({ status: 200, body: { outcome: 'imported', fileId, replay: true } });
    expect(await lignes(id)).toHaveLength(1);
    expect(await travauxT1(fileId)).toBe(1);
    expect(depots).toHaveLength(1);
  });

  it('stockage en panne : « retry » sans faux succès, puis reprise sur la même ligne', async () => {
    const c = await make.account({ plan: 'premium' });
    ouvrirSession(c.ownerUserId, c.id);
    const token = String((await jeton()).body.token);
    const id = op();
    stockageEnPanne = true;
    expect(await importer(token, { operationId: id })).toMatchObject({ status: 503, body: { outcome: 'retry', code: 'STORAGE_UNAVAILABLE' } });
    expect((await lignes(id)).map((l) => l.upload_status)).toEqual(['PENDING']);
    expect((await statuts([id]))[0]).toMatchObject({ state: 'receiving' });
    stockageEnPanne = false;
    const r = await importer(token, { operationId: id });
    expect(r).toMatchObject({ status: 201, body: { outcome: 'imported' } });
    expect(await lignes(id)).toEqual([expect.objectContaining({ id: Number(r.body.fileId), upload_status: 'COMPLETED' })]);
  });

  it('refus définitifs : format, intégrité, quota — aucun document enregistré', async () => {
    const c = await make.account({ plan: 'premium' });
    ouvrirSession(c.ownerUserId, c.id);
    const token = String((await jeton()).body.token);
    const heic = op();
    expect(await importer(token, { operationId: heic, mime: 'image/heic', name: 'IMG_0001.HEIC' })).toMatchObject({ status: 422, body: { outcome: 'refused', code: 'INVALID_MIME_TYPE' } });
    const altere = op();
    expect(await importer(token, { operationId: altere, sha: 'a'.repeat(64) })).toMatchObject({ status: 422, body: { outcome: 'refused', code: 'INTEGRITY_MISMATCH' } });
    droits.document = false;
    const quota = op();
    const q = await importer(token, { operationId: quota });
    expect(q).toMatchObject({ status: 422, body: { outcome: 'refused', code: 'DOCUMENT_QUOTA_REACHED' } });
    expect(String(q.body.message)).toMatch(/Nombre maximal de documents/);
    for (const id of [heic, altere, quota]) expect(await lignes(id)).toHaveLength(0);
  });

  it('jeton invalide, expiré, épuisé, remplacé, révoqué ; session révoquée ; CGUV à accepter → « auth », rien d’importé', async () => {
    const c = await make.account({ plan: 'premium' });
    ouvrirSession(c.ownerUserId, c.id);
    expect(await importer('vbsi_' + 'x'.repeat(43))).toMatchObject({ status: 401, body: { outcome: 'auth', code: 'GRANT_INVALID' } });
    expect(await importer('session-jwt.complet.ici')).toMatchObject({ status: 401, body: { code: 'GRANT_INVALID' } });

    const t1 = String((await jeton()).body.token);
    const t2 = String((await jeton()).body.token); // rotation : même session
    expect(await importer(t1)).toMatchObject({ status: 401, body: { code: 'GRANT_REVOKED' } });

    await sql`UPDATE mobile_share_import_grants SET uses = max_uses WHERE token_hash = ${sha(new TextEncoder().encode(t2))}`;
    expect(await importer(t2)).toMatchObject({ status: 401, body: { code: 'GRANT_EXHAUSTED' } });

    const t3 = String((await jeton()).body.token);
    await sql`UPDATE mobile_share_import_grants SET expires_at = now() - interval '1 minute' WHERE token_hash = ${sha(new TextEncoder().encode(t3))}`;
    expect(await importer(t3)).toMatchObject({ status: 401, body: { code: 'GRANT_EXPIRED' } });

    const t4 = String((await jeton()).body.token);
    droits.cguv = true;
    expect(await importer(t4)).toMatchObject({ status: 401, body: { outcome: 'auth', code: 'CGUV_REACCEPTANCE_REQUIRED' } });
    droits.cguv = false;

    // DELETE (déconnexion / changement d'espace) : jeton révoqué.
    const { DELETE } = await import('@/app/api/mobile/share-import/grant/route');
    expect((await DELETE(new NextRequest('http://x/api/mobile/share-import/grant', { method: 'DELETE' }))).status).toBe(200);
    expect(await importer(t4)).toMatchObject({ status: 401, body: { code: 'GRANT_REVOKED' } });

    // Changement de mot de passe / « déconnecter tous les appareils » : borne de révocation.
    const t5 = String((await jeton()).body.token);
    await new Promise((r) => setTimeout(r, 5));
    const { revokeAllUserSessionsWithReport } = await import('@/db');
    await revokeAllUserSessionsWithReport(c.ownerUserId, 'PASSWORD_CHANGE');
    // Comme la route de changement de mot de passe : cache local de la borne vidé (autres instances ≤ 60 s, comme les jetons d'accès).
    const { serverCacheDelete } = await import('@/lib/server-cache');
    const { sessionCutoffCacheKey } = await import('@/lib/auth/session-cutoff');
    serverCacheDelete(sessionCutoffCacheKey(c.ownerUserId));
    expect(await importer(t5)).toMatchObject({ status: 401, body: { outcome: 'auth', code: 'SESSION_REVOKED' } });
    const [r] = await sql<{ revoked_reason: string }[]>`SELECT revoked_reason FROM mobile_share_import_grants WHERE token_hash = ${sha(new TextEncoder().encode(t5))}`;
    expect(r.revoked_reason).toBe('SESSION_REVOKED');
    expect(Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${c.id}`)[0].n)).toBe(0);
  });

  it('intégration 110B — jeton émis par une session sans double authentification : refusé dès que la MFA est exigée', async () => {
    const c = await make.account({ plan: 'premium' });
    ouvrirSession(c.ownerUserId, c.id);
    const t = String((await jeton()).body.token);
    const h = sha(new TextEncoder().encode(t));
    expect((await sql<{ a: number | null }[]>`SELECT session_aal AS a FROM mobile_share_import_grants WHERE token_hash = ${h}`)[0].a).toBe(1);
    const avant = (await sql<{ f: Date | null }[]>`SELECT enforced_from AS f FROM mfa_enforcement_settings WHERE scope = 'users'`)[0]?.f ?? null;
    try {
      await sql`UPDATE mfa_enforcement_settings SET enforced_from = ${new Date(Date.now() - 86_400_000).toISOString()}::timestamptz WHERE scope = 'users'`;
      expect(await importer(t)).toMatchObject({ status: 401, body: { outcome: 'auth', code: 'MFA_REQUIRED' } });
      expect(Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${c.id}`)[0].n)).toBe(0);
      // Même jeton porté par une session de niveau 2 : la garde MFA ne s'y oppose plus.
      await sql`UPDATE mobile_share_import_grants SET session_aal = 2 WHERE token_hash = ${h}`;
      expect((await importer(t)).body).not.toMatchObject({ code: 'MFA_REQUIRED' });
    } finally {
      await sql`UPDATE mfa_enforcement_settings SET enforced_from = ${avant ? new Date(avant).toISOString() : null}::timestamptz WHERE scope = 'users'`;
    }
  });

  it('isolation : le document va dans l’espace du jeton ; un autre compte ne voit rien ; adhésion retirée → refus', async () => {
    // Utilisateur membre de deux espaces (Premium Duo) : jeton émis sur A.
    const a = await make.account({ plan: 'premium_duo' });
    const b = await make.account({ plan: 'premium_duo' });
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${b.id}, ${a.ownerUserId}, 'member', 'active')`;
    ouvrirSession(a.ownerUserId, a.id, 'sid-duo');
    const tokenA = String((await jeton('ANDROID')).body.token);

    // L'utilisateur passe sur l'espace B dans l'app : le jeton A importe toujours dans A, jamais dans B.
    ouvrirSession(a.ownerUserId, b.id, 'sid-duo');
    const id = op();
    const r = await importer(tokenA, { operationId: id });
    expect(r.body.outcome).toBe('imported');
    expect((await lignes(id)).map((l) => l.account_id)).toEqual([a.id]);
    expect((await statuts([id]))[0]).toEqual({ operationId: id, state: 'not_received' });
    ouvrirSession(a.ownerUserId, a.id, 'sid-duo');
    expect((await statuts([id]))[0]).toMatchObject({ operationId: id, state: 'imported', fileId: Number(r.body.fileId) });

    // Un autre utilisateur ne voit jamais cet import, même avec l'identifiant.
    const autre = await make.account({ plan: 'premium' });
    ouvrirSession(autre.ownerUserId, autre.id);
    expect((await statuts([id]))[0]).toEqual({ operationId: id, state: 'not_received' });
    // … et le même identifiant d'import chez lui crée SON document, dans SON espace.
    const tokenAutre = String((await jeton()).body.token);
    const r2 = await importer(tokenAutre, { operationId: id });
    expect(r2.body.outcome).toBe('imported');
    expect(r2.body.fileId).not.toBe(r.body.fileId);
    expect((await lignes(id)).map((l) => l.account_id).sort()).toEqual([a.id, autre.id].sort());

    // Adhésion à l'espace du jeton retirée : refus définitif, jeton révoqué.
    ouvrirSession(a.ownerUserId, b.id, 'sid-duo-2');
    const tokenB = String((await jeton('ANDROID')).body.token);
    await sql`UPDATE account_memberships SET status = 'removed' WHERE account_id = ${b.id} AND user_id = ${a.ownerUserId}`;
    expect(await importer(tokenB)).toMatchObject({ status: 422, body: { outcome: 'refused', code: 'ACCOUNT_ACCESS_REVOKED' } });
  });
});
