/**
 * Lot 110A — partage natif à trois choix : règles pures (contrat, jeton
 * d'import, statuts, isolation des comptes, suivi) et intégration (lecture du
 * code). Les parcours serveur réels : src/test/e2e/scenarios/l110a-partage-natif.e2e.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextRequest } from 'next/server';

import {
  SHARE_IMPORT_LABELS, SHARE_IMPORT_STATUS_LABELS, SHARE_IMPORT_TYPES, SHARE_IMPORT_HEIC_MIMES, SHARE_IMPORT_TOKEN_PATTERN,
  classifyDepotStatus, isShareImportMime, outcomeHttpStatus, shareImportAccountKey, shareImportMessage,
} from '@/lib/mobile/share-import-policy';
import { ALLOWED_MIME_TYPES } from '@/lib/file-validation';
import {
  isSettled, needsGrant, parseNativeState, sessionAccountKey, summarize, trackingPath, visibleShareItems, type NativeShareItem,
} from '@/lib/native/share-import';
import { mergeTracking } from '@/components/native/share-import/ShareImportTracking';
import { shareCardTitle } from '@/components/native/ShareImportStatusCard';

vi.mock('@/lib/auth-guards', () => ({ getSession: vi.fn(async () => ({ userId: 99, currentAccountId: 98, via: 'cookie' })) }));

const read = (p: string) => readFileSync(resolve(__dirname, '../../../..', p), 'utf8');

const item = (over: Partial<NativeShareItem> = {}): NativeShareItem => ({
  id: 'AAAA-BBBB-CCCC', createdAt: 1, accountKey: 'u1-a1', accountHint: 'u1-a1', files: [
    { operationId: 'op-0000000000000001', name: 'Facture.pdf', state: 'uploading' },
  ], refused: [], ...over,
});

describe('L110A — contrat unique', () => {
  it('libellés validés et statuts fidèles (jamais « ajouté » avant accusé)', () => {
    expect(SHARE_IMPORT_LABELS).toEqual({ importAndOpen: 'Importer et ouvrir Verebona', importOnly: 'Importer sans ouvrir', cancel: 'Annuler' });
    expect(SHARE_IMPORT_STATUS_LABELS.uploading).toBe('Importation en cours');
    expect(SHARE_IMPORT_STATUS_LABELS.waiting_auth).toBe('En attente de connexion');
    expect(SHARE_IMPORT_STATUS_LABELS.waiting_network).toBe('En attente de connexion');
    expect(SHARE_IMPORT_STATUS_LABELS.imported).toBe('Document ajouté');
  });

  it('formats du partage = formats documentaires du serveur ; HEIC converti (refusé tel quel par le serveur)', () => {
    for (const t of SHARE_IMPORT_TYPES) expect(ALLOWED_MIME_TYPES).toContain(t.mime);
    for (const h of SHARE_IMPORT_HEIC_MIMES) { expect(ALLOWED_MIME_TYPES).not.toContain(h); expect(isShareImportMime(h)).toBe(false); }
    expect(SHARE_IMPORT_TYPES.some((t) => t.mime.startsWith('video/'))).toBe(false);
    expect(isShareImportMime('APPLICATION/PDF')).toBe(true);
  });

  it('catégories de réponse : 2xx accusé, 4xx refus définitif, 401 / CGUV connexion, 409 objet absent / 429 / 5xx reprise', () => {
    expect(classifyDepotStatus(201, null)).toBe('imported');
    expect(classifyDepotStatus(400, 'INVALID_MIME_TYPE')).toBe('refused');
    expect(classifyDepotStatus(403, 'DOCUMENT_QUOTA_REACHED')).toBe('refused');
    expect(classifyDepotStatus(413, 'STORAGE_QUOTA_EXCEEDED')).toBe('refused');
    expect(classifyDepotStatus(409, 'IDEMPOTENCY_KEY_REUSED')).toBe('refused');
    expect(classifyDepotStatus(409, 'OBJECT_MISSING')).toBe('retry');
    expect(classifyDepotStatus(401, 'INVALID_TOKEN')).toBe('auth');
    expect(classifyDepotStatus(403, 'CGUV_REACCEPTANCE_REQUIRED')).toBe('auth');
    expect(classifyDepotStatus(503, 'SESSION_UNAVAILABLE')).toBe('retry');
    expect(classifyDepotStatus(429, 'RATE_LIMIT_EXCEEDED')).toBe('retry');
    expect(classifyDepotStatus(500, null)).toBe('retry');
    expect([outcomeHttpStatus('imported'), outcomeHttpStatus('imported', true), outcomeHttpStatus('auth'), outcomeHttpStatus('retry'), outcomeHttpStatus('refused')])
      .toEqual([201, 200, 401, 503, 422]);
  });

  it('messages en français simple ; jamais un message technique anglais', () => {
    expect(shareImportMessage('DOCUMENT_QUOTA_REACHED')).toMatch(/Nombre maximal de documents/);
    expect(shareImportMessage('UNKNOWN', 'Filename is required')).toBe('Le document n’a pas pu être importé.');
    expect(shareImportMessage('UNKNOWN', 'Le fichier reçu ne correspond pas')).toBe('Le fichier reçu ne correspond pas');
  });

  it('clé de compte identique côté serveur et interface ; jeton jamais une session', () => {
    expect(shareImportAccountKey(12, 34)).toBe('u12-a34');
    expect(sessionAccountKey(12, 34)).toBe('u12-a34');
    expect(sessionAccountKey(12, null)).toBeNull();
    expect(SHARE_IMPORT_TOKEN_PATTERN.test('vbsi_' + 'A'.repeat(43))).toBe(true);
    expect(SHARE_IMPORT_TOKEN_PATTERN.test('eyJhbGciOi.eyJ1c2VySWQiOjF9.sig')).toBe(false);
  });
});

describe('L110A — jeton d’import (règles pures)', () => {
  it('ligne du jeton : absent, révoqué, expiré, épuisé, valide', async () => {
    const { decideGrantRow, shareImportGrantTtlMs } = await import('@/services/mobile/share-import/grants');
    const now = new Date('2026-11-04T12:00:00Z');
    const row = { id: 1, userId: 1, accountId: 2, sessionSid: 's', platform: 'ios' as const, maxUses: 100, uses: 3, createdAt: now, expiresAt: new Date(now.getTime() + 1000), revokedAt: null };
    expect(decideGrantRow(null, now)).toEqual({ ok: false, code: 'GRANT_INVALID' });
    expect(decideGrantRow({ ...row, revokedAt: now }, now)).toEqual({ ok: false, code: 'GRANT_REVOKED' });
    expect(decideGrantRow({ ...row, expiresAt: now }, now)).toEqual({ ok: false, code: 'GRANT_EXPIRED' });
    expect(decideGrantRow({ ...row, uses: 100 }, now)).toEqual({ ok: false, code: 'GRANT_EXHAUSTED' });
    expect(decideGrantRow(row, now)).toEqual({ ok: true });
    expect(shareImportGrantTtlMs({})).toBe(72 * 3600_000);
    expect(shareImportGrantTtlMs({ MOBILE_SHARE_IMPORT_GRANT_TTL_HOURS: '24' })).toBe(24 * 3600_000);
    expect(shareImportGrantTtlMs({ MOBILE_SHARE_IMPORT_GRANT_TTL_HOURS: '9999' })).toBe(168 * 3600_000);
    expect(shareImportGrantTtlMs({ MOBILE_SHARE_IMPORT_GRANT_TTL_HOURS: '0' })).toBe(72 * 3600_000);
  });

  it('identifiants d’import du suivi : valides, dédoublonnés, bornés', async () => {
    const { parseOperationIds, SHARE_IMPORT_STATUS_MAX_IDS } = await import('@/services/mobile/share-import/status');
    expect(parseOperationIds('aaaaaaaaaaaaaaaa,aaaaaaaaaaaaaaaa, bad , ../../x,bbbbbbbbbbbbbbbb')).toEqual(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
    expect(parseOperationIds(Array.from({ length: 80 }, (_, i) => `op-${String(i).padStart(16, '0')}`).join(','))).toHaveLength(SHARE_IMPORT_STATUS_MAX_IDS);
  });

  it('identité déléguée aux routes de dépôt : seulement pour la requête construite en interne', async () => {
    const { delegateDepotSession, resolveDepotSession } = await import('@/lib/documents/depot-session');
    const interne = delegateDepotSession(new NextRequest('http://x/api/files/presign', { method: 'POST' }), { userId: 7, currentAccountId: 8 });
    expect(await resolveDepotSession(interne)).toEqual({ userId: 7, currentAccountId: 8, via: 'share-import-grant' });
    // Une requête reçue, même avec des en-têtes imitant l'identité, passe par la garde de session.
    const externe = new NextRequest('http://x/api/files/presign', { method: 'POST', headers: { 'x-user-id': '7', via: 'share-import-grant' } });
    expect(await resolveDepotSession(externe)).toMatchObject({ userId: 99, currentAccountId: 98 });
  });
});

describe('L110A — interface : isolation, jeton, états', () => {
  it('état natif validé ; état inconnu → « en cours », jamais « ajouté »', () => {
    const s = parseNativeState({
      available: true, grant: { accountKey: 'u1-a1', expiresAt: '2026-11-07T00:00:00.000Z', token: 'vbsi_secret' },
      items: [
        { id: 'AAAA-BBBB-CCCC', createdAt: 5, accountKey: 'u1-a1', files: [{ operationId: 'op-0000000000000001', name: 'a.pdf', state: 'bizarre' }] },
        { id: '../x', files: [] },
      ],
    });
    expect(s.items).toHaveLength(1);
    expect(s.items[0].files[0].state).toBe('queued');
    expect(JSON.stringify(s)).not.toContain('vbsi_secret');
  });

  it('isolation : un partage n’apparaît QUE pour son compte (ou le dernier compte connu, ou le premier si aucun)', () => {
    const a = item({ id: 'AAAA-AAAA-0001', accountKey: 'u1-a1' });
    const b = item({ id: 'BBBB-BBBB-0002', accountKey: 'u2-a2' });
    const hintA = item({ id: 'CCCC-CCCC-0003', accountKey: null, accountHint: 'u1-a1' });
    const none = item({ id: 'DDDD-DDDD-0004', accountKey: null, accountHint: null });
    expect(visibleShareItems([a, b, hintA, none], 'u1-a1').map((i) => i.id)).toEqual([a.id, hintA.id, none.id]);
    expect(visibleShareItems([a, b, hintA, none], 'u2-a2').map((i) => i.id)).toEqual([b.id, none.id]);
    // Même utilisateur, autre espace (Duo) : rien du premier espace.
    expect(visibleShareItems([a], 'u1-a9')).toEqual([]);
    expect(visibleShareItems([a, none], null)).toEqual([]);
  });

  it('jeton demandé si absent, d’un autre compte ou à moins de 24 h de son échéance', () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    expect(needsGrant(null, 'u1-a1', now)).toBe(true);
    expect(needsGrant({ accountKey: 'u2-a2', expiresAt: '2026-11-07T12:00:00.000Z' }, 'u1-a1', now)).toBe(true);
    expect(needsGrant({ accountKey: 'u1-a1', expiresAt: '2026-11-05T11:00:00.000Z' }, 'u1-a1', now)).toBe(true);
    expect(needsGrant({ accountKey: 'u1-a1', expiresAt: '2026-11-07T12:00:00.000Z' }, 'u1-a1', now)).toBe(false);
    expect(needsGrant(null, null, now)).toBe(false);
  });

  it('carte d’état : en cours / attente / ajouté / échec, distincts', () => {
    const f = (state: NativeShareItem['files'][number]['state'], n = 1) => ({ operationId: `op-000000000000000${n}`, name: `d${n}.pdf`, state });
    expect(shareCardTitle([item({ files: [f('uploading')] })])).toBe('Importation en cours');
    expect(shareCardTitle([item({ files: [f('uploading', 1), f('imported', 2)] })])).toBe('Importation en cours (2 documents)');
    expect(shareCardTitle([item({ files: [f('waiting_auth')] })])).toBe('Import en attente de connexion');
    expect(shareCardTitle([item({ files: [f('imported')] })])).toBe('Document ajouté à Verebona');
    expect(shareCardTitle([item({ files: [f('failed')] })])).toBe('Échec de l’import');
    expect(shareCardTitle([item({ files: [f('imported', 1), f('failed', 2)] })])).toBe('1 ajouté, 1 en échec');
    expect(isSettled(item({ files: [f('imported', 1), f('failed', 2)] }))).toBe(true);
    expect(isSettled(item({ files: [f('imported', 1), f('waiting_network', 2)] }))).toBe(false);
    expect(summarize([item({ files: [f('queued', 1), f('waiting_network', 2), f('imported', 3), f('failed', 4)] })])).toEqual({ inProgress: 1, waiting: 1, imported: 1, failed: 1 });
    expect(trackingPath(item())).toBe('/documents/import-partage?partage=AAAA-BBBB-CCCC&ops=op-0000000000000001');
  });

  it('suivi : « ajouté » seulement sur accusé serveur ; reçu mais non confirmé = en cours', () => {
    const ops = ['op-0000000000000001', 'op-0000000000000002', 'op-0000000000000003', 'op-0000000000000004'];
    const r = mergeTracking(ops, [
      { operationId: ops[0], state: 'imported', fileId: 10, title: 'Facture', processingStatus: 'PROCESSING' },
      { operationId: ops[1], state: 'receiving', fileId: 11 },
    ], [
      { operationId: ops[1], name: 'b.pdf', state: 'uploading' },
      { operationId: ops[2], name: 'c.pdf', state: 'failed', message: 'Espace de stockage de votre compte plein.' },
      { operationId: ops[3], name: 'd.pdf', state: 'waiting_auth', message: 'Connectez-vous' },
    ]);
    expect(r.map((x) => x.state)).toEqual(['imported', 'uploading', 'failed', 'waiting_auth']);
    expect(r[0]).toMatchObject({ fileId: 10, name: 'Facture' });
    expect(r[2].message).toMatch(/stockage/);
  });
});

describe('L110A — intégration (lecture du code)', () => {
  it('import du partage : mêmes routes de dépôt, identité déléguée, aucune session émise', () => {
    const op = read('src/services/mobile/share-import/import-operation.ts');
    expect(op).toMatch(/import\('@\/app\/api\/files\/presign\/route'\)/);
    expect(op).toMatch(/import\('@\/app\/api\/files\/confirm\/route'\)/);
    expect(op).toMatch(/delegateDepotSession/);
    for (const r of ['src/app/api/files/presign/route.ts', 'src/app/api/files/confirm/route.ts']) {
      expect(read(r)).toMatch(/const session = await resolveDepotSession\(request\);/);
    }
    const grants = read('src/services/mobile/share-import/grants.ts') + read('src/app/api/mobile/share-import/grant/route.ts');
    expect(grants).not.toMatch(/signAccessToken|issueSession|createSession|setSessionCookies/);
    expect(read('src/app/api/mobile/share-import/grant/route.ts')).toMatch(/getSession\(request\)/);
  });

  it('route d’import : sans cookie (CSRF et jeton de session exemptés), jamais journalisée avec le jeton', () => {
    expect(read('src/lib/csrf.ts')).toMatch(/'\/api\/mobile\/share-import\/upload'/);
    expect(read('src/middleware.ts')).toMatch(/'\/api\/mobile\/share-import\/upload'/);
    const upload = read('src/app/api/mobile/share-import/upload/route.ts');
    expect(upload).not.toMatch(/cookies/);
    expect(read('src/services/mobile/share-import/import-operation.ts')).not.toMatch(/console\.[a-z]+\([^)]*token/);
  });

  it('plus de seconde confirmation pour un partage validé : carte d’état sans « Importer » ni « Abandonner »', () => {
    const card = read('src/components/native/ShareImportStatusCard.tsx');
    expect(card).not.toMatch(/>Importer</);
    expect(card).not.toMatch(/Abandonner/);
    const tracking = read('src/components/native/share-import/ShareImportTracking.tsx');
    expect(tracking).not.toMatch(/openCreateFlow|Fichier \/ Lien|Scanner/);
    const runtime = read('src/components/native/NativeBridgeRuntime.tsx');
    expect(runtime).toMatch(/useShareImport\(/);
    expect(runtime).toMatch(/<ShareImportStatusCard/);
  });
});
