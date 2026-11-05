/**
 * Lot 111P — partage iOS « Vous n'êtes pas connecté » à tort (correctif
 * 110A) : renouvellement du jeton d'import par le circuit EXISTANT, sur
 * PostgreSQL réel.
 *
 *   · vérification serveur légère (GET `grant`) : références non secrètes des
 *     jetons actifs de la session, jamais un jeton, aucun usage consommé ;
 *   · jeton refusé (remplacé, révoqué, épuisé, échu) → nouveau jeton par la
 *     route `grant` → l'import EN ATTENTE se termine avec le même identifiant
 *     d'import, sans doublon ;
 *   · double partage / double toucher : aucun doublon ;
 *   · changement d'espace (Duo) : le jeton de l'ancien espace est remplacé et
 *     refusé ; rien n'est importé dans le mauvais espace ;
 *   · double authentification exigée : renouvellement REFUSÉ (MFA_REQUIRED),
 *     donc aucune boucle ; espace en lecture seule : refus définitif.
 *   · traces serveur expurgées (code, jamais le jeton).
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

const session = { userId: 0, currentAccountId: 0, sid: 'sid-e2e', email: 'x@test.invalid', role: 'USER', status: 'ACTIVE', planType: 'standard', aal: 1 };
const garde = vi.hoisted(() => ({ refus: null as string | null, lectureSeule: false }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => {
      if (garde.refus) throw new Error(garde.refus);
      return { ...session };
    },
    handleSessionError: () => new Response('unauthorized', { status: 401 }),
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()),
  emitBusinessEvent: async () => {},
  emitBusinessEvents: async () => {},
}));
vi.mock('@/services/commercial-model.service', async (o) => ({ ...(await o<object>()), canConsumeAnalysis: async () => ({ allowed: true }) }));
vi.mock('@/services/entitlements.service', async (o) => ({ ...(await o<object>()), canAddDocument: async () => ({ allowed: true }) }));
vi.mock('@/services/legal/cguv-reacceptance.service', async (o) => ({ ...(await o<object>()), isReacceptanceRequired: async () => false }));
vi.mock('@/lib/write-access-guard', () => ({
  refuserSiLectureSeule: async () => (garde.lectureSeule ? new Response(JSON.stringify({ code: 'ACCOUNT_READ_ONLY' }), { status: 403 }) : null),
}));
vi.mock('@/services/document-ai/fusion-detector', () => ({ detectFusionCandidates: async () => [] }));
vi.mock('@/lib/upload-object-check', () => ({ verificationObjetActive: () => true, verifierObjetDepose: async () => ({ kind: 'ok' }) }));

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const op = () => crypto.randomUUID();
const ref = (token: string) => sha(token).slice(0, 12);

scenario('L111P', 'Partage natif : renouvellement du jeton refusé, vérification légère, doublons, espaces, MFA', ({ sql, make }) => {
  beforeEach(async () => {
    garde.refus = null;
    garde.lectureSeule = false;
    session.aal = 1;
    const { __setShareImportStorageWriterForTests } = await import('@/services/mobile/share-import/import-operation');
    __setShareImportStorageWriterForTests(async () => undefined);
  });
  afterAll(async () => {
    const { __setShareImportStorageWriterForTests } = await import('@/services/mobile/share-import/import-operation');
    __setShareImportStorageWriterForTests(null);
  });

  const ouvrirSession = (userId: number, accountId: number, sid = `sid-${userId}`) => {
    session.userId = userId;
    session.currentAccountId = accountId;
    session.sid = sid;
  };
  const headers = { 'content-type': 'application/json', 'x-verebona-client': 'IOS', 'x-verebona-app-version': '1.0.0' };
  const jeton = async () => {
    const { POST } = await import('@/app/api/mobile/share-import/grant/route');
    const res = await POST(new NextRequest('http://x/api/mobile/share-import/grant', { method: 'POST', headers, body: '{}' }));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const verifier = async () => {
    const { GET } = await import('@/app/api/mobile/share-import/grant/route');
    const res = await GET(new NextRequest('http://x/api/mobile/share-import/grant', { method: 'GET', headers }));
    return { status: res.status, body: await res.json() as { grants?: Array<{ ref: string; expiresAt: string; usesLeft: number }>; code?: string } };
  };
  const importer = async (token: string, operationId = op()) => {
    const { POST } = await import('@/app/api/mobile/share-import/upload/route');
    const res = await POST(new NextRequest('http://x/api/mobile/share-import/upload', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/pdf', 'x-verebona-operation-id': operationId,
        'x-verebona-file-name': encodeURIComponent('Facture partagée.pdf'), 'x-verebona-sha256': sha(PDF), 'x-verebona-share-client': 'IOS',
      },
      body: PDF as unknown as BodyInit,
    }));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const lignes = (operationId: string) => sql<{ id: number; account_id: number }[]>`
    SELECT id, account_id FROM asset_files WHERE upload_operation_id = ${operationId}`;

  it('vérification légère : référence non secrète du jeton actif, aucun jeton rendu, aucun usage consommé', async () => {
    const c = await make.account({ plan: 'premium' });
    ouvrirSession(c.ownerUserId, c.id);
    const t = String((await jeton()).body.token);
    const v = await verifier();
    expect(v.status).toBe(200);
    expect(v.body.grants).toEqual([{ ref: ref(t), expiresAt: expect.any(String), usesLeft: 100 }]);
    expect(JSON.stringify(v.body)).not.toMatch(/vbsi_/);
    const [row] = await sql<{ uses: number }[]>`SELECT uses FROM mobile_share_import_grants WHERE token_hash = ${sha(t)}`;
    expect(row.uses).toBe(0);
    // Réservé à l'application native.
    const { GET } = await import('@/app/api/mobile/share-import/grant/route');
    expect((await GET(new NextRequest('http://x/api/mobile/share-import/grant', { method: 'GET' }))).status).toBe(400);
  });

  it('jeton remplacé / révoqué : refusé, la vérification ne le connaît plus ; renouvelé → l’import en attente se termine, sans doublon', async () => {
    const c = await make.account({ plan: 'premium' });
    ouvrirSession(c.ownerUserId, c.id);
    const ancien = String((await jeton()).body.token);
    // Un autre provisionnement de la même session (autre déclencheur) remplace le jeton.
    const courant = String((await jeton()).body.token);
    const enAttente = op();
    const info = vi.spyOn(console, 'info');
    const refus = await importer(ancien, enAttente);
    expect(refus).toMatchObject({ status: 401, body: { outcome: 'auth', code: 'GRANT_REVOKED' } });
    expect(String(refus.body.message)).not.toMatch(/Connexion à Verebona nécessaire|pas connecté/);
    // Trace serveur expurgée : code et catégorie, jamais le jeton ni le nom du fichier.
    const trace = info.mock.calls.map((a) => String(a[0])).find((l) => l.includes('share_import.grant_rejected'));
    expect(trace).toBeDefined();
    expect(JSON.parse(trace!)).toEqual({ event: 'share_import.grant_rejected', code: 'GRANT_REVOKED', outcome: 'auth', client: 'IOS' });
    expect(info.mock.calls.flat().join(' ')).not.toMatch(/vbsi_|Facture partagée/);
    info.mockRestore();
    expect((await verifier()).body.grants?.map((g) => g.ref)).toEqual([ref(courant)]);
    expect(await lignes(enAttente)).toHaveLength(0);

    // Le natif a marqué le refus de `ancien` ; l'app renouvelle (route `grant`) ; reprise : même identifiant d'import.
    const nouveau = String((await jeton()).body.token);
    expect(await importer(courant, op())).toMatchObject({ body: { code: 'GRANT_REVOKED' } }); // rotation : un seul jeton vivant
    const ok = await importer(nouveau, enAttente);
    expect(ok).toMatchObject({ status: 201, body: { outcome: 'imported' } });
    const rejeu = await importer(nouveau, enAttente);
    expect(rejeu).toMatchObject({ status: 200, body: { outcome: 'imported', replay: true, fileId: ok.body.fileId } });
    expect(await lignes(enAttente)).toEqual([expect.objectContaining({ account_id: c.id })]);

    // Déconnexion explicite (DELETE) : refus, vérification vide.
    const { DELETE } = await import('@/app/api/mobile/share-import/grant/route');
    await DELETE(new NextRequest('http://x/api/mobile/share-import/grant', { method: 'DELETE', headers }));
    expect((await verifier()).body.grants).toEqual([]);
    expect(await importer(nouveau)).toMatchObject({ body: { code: 'GRANT_REVOKED' } });
  });

  it('jeton presque épuisé puis épuisé, ou échu : visible à la vérification ; renouvelé → import repris', async () => {
    const c = await make.account({ plan: 'premium' });
    ouvrirSession(c.ownerUserId, c.id);
    const t = String((await jeton()).body.token);
    await sql`UPDATE mobile_share_import_grants SET uses = max_uses - 5 WHERE token_hash = ${sha(t)}`;
    expect((await verifier()).body.grants?.[0]).toMatchObject({ ref: ref(t), usesLeft: 5 }); // ≤ 10 : renouvellement anticipé
    await sql`UPDATE mobile_share_import_grants SET uses = max_uses WHERE token_hash = ${sha(t)}`;
    expect((await verifier()).body.grants).toEqual([]);
    const id = op();
    expect(await importer(t, id)).toMatchObject({ body: { outcome: 'auth', code: 'GRANT_EXHAUSTED' } });
    const t2 = String((await jeton()).body.token);
    await sql`UPDATE mobile_share_import_grants SET expires_at = now() - interval '1 minute' WHERE token_hash = ${sha(t2)}`;
    expect((await verifier()).body.grants).toEqual([]);
    expect(await importer(t2, id)).toMatchObject({ body: { outcome: 'auth', code: 'GRANT_EXPIRED' } });
    const t3 = String((await jeton()).body.token);
    expect(await importer(t3, id)).toMatchObject({ status: 201, body: { outcome: 'imported' } });
    expect(await lignes(id)).toHaveLength(1);
  });

  it('double partage et double toucher (envois simultanés) : un document par identifiant d’import, aucun doublon', async () => {
    const c = await make.account({ plan: 'premium' });
    ouvrirSession(c.ownerUserId, c.id);
    const t = String((await jeton()).body.token);
    const a = op();
    const b = op();
    const res = await Promise.all([importer(t, a), importer(t, b), importer(t, a)]);
    for (const r of res) expect(['imported', 'retry']).toContain(r.body.outcome); // le doublon simultané : rendu ou reporté, jamais créé
    // Reprise du natif (même identifiant) : tous terminés, exactement deux documents.
    for (const id of [a, b]) expect((await importer(t, id)).body.outcome).toBe('imported');
    expect(await lignes(a)).toHaveLength(1);
    expect(await lignes(b)).toHaveLength(1);
    expect(Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${c.id}`)[0].n)).toBe(2);
  });

  it('changement d’espace (Duo) : le jeton de l’ancien espace est remplacé et refusé ; le nouveau importe dans le NOUVEL espace seulement', async () => {
    const a = await make.account({ plan: 'premium_duo' });
    const b = await make.account({ plan: 'premium_duo' });
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${b.id}, ${a.ownerUserId}, 'member', 'active')`;
    ouvrirSession(a.ownerUserId, a.id, 'sid-duo-111p');
    const tA = String((await jeton()).body.token);
    // Bascule vers B (même session) : l'app retire le jeton A et en demande un pour B.
    ouvrirSession(a.ownerUserId, b.id, 'sid-duo-111p');
    const gB = await jeton();
    expect(gB.body.accountKey).toBe(`u${a.ownerUserId}-a${b.id}`);
    const tB = String(gB.body.token);
    expect((await verifier()).body.grants?.map((g) => g.ref)).toEqual([ref(tB)]);
    // Un partage préparé avec le jeton A n'importe plus rien (ni dans A, ni dans B).
    const idA = op();
    expect(await importer(tA, idA)).toMatchObject({ body: { outcome: 'auth', code: 'GRANT_REVOKED' } });
    expect(await lignes(idA)).toHaveLength(0);
    const idB = op();
    expect((await importer(tB, idB)).body.outcome).toBe('imported');
    expect((await lignes(idB)).map((l) => l.account_id)).toEqual([b.id]);
    // Retour sur A : la vérification de l'espace A ne voit pas le jeton B.
    ouvrirSession(a.ownerUserId, a.id, 'sid-duo-111p');
    expect((await verifier()).body.grants).toEqual([]);
  });

  it('double authentification exigée : renouvellement refusé (MFA_REQUIRED) — aucun jeton, donc aucune boucle ; lecture seule : refus définitif', async () => {
    const c = await make.account({ plan: 'premium' });
    ouvrirSession(c.ownerUserId, c.id);
    const t = String((await jeton()).body.token);
    garde.refus = 'MFA_REQUIRED';
    const info = vi.spyOn(console, 'info');
    const r = await jeton();
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('MFA_REQUIRED');
    expect(r.body.token).toBeUndefined();
    expect(info.mock.calls.map((x) => String(x[0])).some((l) => l.includes('"share_import.grant_refused"') && l.includes('"MFA_REQUIRED"'))).toBe(true);
    info.mockRestore();
    expect((await verifier()).status).toBe(403);
    garde.refus = null;
    // Espace en lecture seule : refus DÉFINITIF de l'import (pas un refus du jeton : aucun renouvellement utile).
    garde.lectureSeule = true;
    const id = op();
    expect(await importer(t, id)).toMatchObject({ status: 422, body: { outcome: 'refused', code: 'ACCOUNT_READ_ONLY' } });
    expect(await lignes(id)).toHaveLength(0);
  });
});
