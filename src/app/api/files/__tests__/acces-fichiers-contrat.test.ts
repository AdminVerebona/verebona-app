/**
 * Lot 24 — #21/#24 (APP-PERF-13, APP-PERF-20) : routes fichiers et BO alignées
 * sur le contrat `lib/auth/session-errors`.
 *
 * Avant : `view`, `download` et `files/[id]` comparaient des messages anglais
 * (« Unauthorized », « Access denied ») qu'aucune garde ne lève — un refus de
 * session normal y devenait un 500 (et `files/[id]` renvoyait le message
 * technique au client). Attendu : 401/403/503 typés avec `requestId`, refus
 * normaux non journalisés comme panne, 404 pour un fichier d'un autre compte,
 * 500 sans détail technique.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const etat = vi.hoisted(() => ({
  session: null as null | Error | { userId: number; currentAccountId: number | null; role: string },
  admin: null as null | Error,
  lignes: [] as unknown[],
  dbErreur: null as Error | null,
  supprimes: 0,
}));

vi.mock('@/lib/auth-guards', async (orig) => {
  const vrai = await orig<typeof import('@/lib/auth-guards')>();
  return {
    ...vrai,
    getSession: async () => { if (etat.session instanceof Error) throw etat.session; return etat.session; },
    requireAdmin: async () => { if (etat.admin) throw etat.admin; return 1; },
  };
});
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => { if (etat.session instanceof Error) throw etat.session; return etat.session; },
  },
}));
vi.mock('@/db', () => {
  const chaine: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'leftJoin', 'innerJoin', 'orderBy']) chaine[m] = () => chaine;
  chaine.limit = async () => { if (etat.dbErreur) throw etat.dbErreur; return etat.lignes; };
  chaine.update = () => ({ set: () => ({ where: () => ({ returning: async () => {
    etat.supprimes += 1;
    return (etat.lignes as Array<Record<string, unknown>>).map((l) => ({ ...l, deletedAt: new Date() }));
  } }) }) });
  return { db: chaine };
});
vi.mock('@/lib/s3-config', () => ({
  getS3Config: () => ({ signedUrlTtlSeconds: 60 }),
  isS3Configured: () => true,
  logS3Error: vi.fn(),
  S3ConfigError: class S3ConfigError extends Error {},
  signGetUrl: async () => 'https://s3.example.com/signe',
}));
const journal = vi.hoisted(() => ({ error: vi.fn(), blocked: vi.fn(), success: vi.fn() }));
vi.mock('@/lib/file-logger', () => ({ FileLogger: journal }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({ emitBusinessEvent: vi.fn() }));
vi.mock('@/services/ai/evidence/document-evidence-lifecycle', () => ({ onDocumentsDeleted: vi.fn() }));

const { GET: view } = await import('../[id]/view/route');
const { GET: download } = await import('../[id]/download/route');
const { GET: lire, DELETE: supprimer } = await import('../[id]/route');
const { GET: typeDocument } = await import('../../admin/document-types/[id]/route');

const ctx = { params: Promise.resolve({ id: '42' }) };
const req = (path: string, method = 'GET') => new NextRequest(`http://localhost${path}`, { method });
const SESSION = { userId: 7, currentAccountId: 3, role: 'USER' };
const fichier = (accountId: number) => ({
  id: 42, accountId, assetId: 1, uploadStatus: 'COMPLETED', s3Bucket: 'b', s3Key: 'k', mimeType: 'application/pdf',
  originalFilename: 'a.pdf', filename: 'a.pdf', size: 10, isWebLink: false, deletedAt: null,
});

beforeEach(() => {
  etat.session = SESSION;
  etat.admin = null;
  etat.lignes = [];
  etat.dbErreur = null;
  etat.supprimes = 0;
  journal.error.mockReset();
  journal.blocked.mockReset();
});

async function lireCorps(r: Response) {
  const corps = await r.json() as Record<string, unknown>;
  return { status: r.status, corps, entete: r.headers.get('x-request-id') };
}

describe.each([
  ['view', () => view(req('/api/files/42/view'), ctx)],
  ['download', () => download(req('/api/files/42/download'), ctx)],
  ['files/[id] GET', () => lire(req('/api/files/42'), ctx)],
  ['files/[id] DELETE', () => supprimer(req('/api/files/42', 'DELETE'), ctx)],
] as const)('%s — refus de session typés', (_nom, appel) => {
  it.each([
    ['AUTH_REQUIRED', 401],
    ['INVALID_TOKEN', 401],
    ['ACCOUNT_SUSPENDED', 403],
    ['SESSION_UNAVAILABLE', 503],
  ] as const)('%s → %i, code stable et requestId, non journalisé comme panne', async (code, status) => {
    etat.session = new Error(code);
    const r = await lireCorps(await appel());
    expect(r.status).toBe(status);
    expect(r.corps.code).toBe(code);
    expect(typeof r.corps.requestId).toBe('string');
    expect(r.entete).toBe(r.corps.requestId);
    expect(journal.error).not.toHaveBeenCalled();
  });

  it('erreur inattendue → 500 INTERNAL_ERROR avec requestId, sans détail technique', async () => {
    etat.dbErreur = new Error('connect ECONNREFUSED 10.0.0.1:5432 secret');
    const r = await lireCorps(await appel());
    expect(r.status).toBe(500);
    expect(r.corps.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(r.corps)).not.toMatch(/ECONNREFUSED|secret/);
    expect(typeof r.corps.requestId).toBe('string');
  });
});

describe.each([
  ['view', () => view(req('/api/files/42/view'), ctx)],
  ['download', () => download(req('/api/files/42/download'), ctx)],
] as const)('%s — lecture directe', (_nom, appel) => {
  it('session sans compte courant → 401 AUTH_REQUIRED', async () => {
    etat.session = { ...SESSION, currentAccountId: null };
    const r = await lireCorps(await appel());
    expect(r.status).toBe(401);
    expect(r.corps.code).toBe('AUTH_REQUIRED');
  });

  it('fichier absent ou supprimé → 404 FILE_NOT_FOUND', async () => {
    const r = await lireCorps(await appel());
    expect(r.status).toBe(404);
    expect(r.corps).toMatchObject({ code: 'FILE_NOT_FOUND', message: expect.any(String) });
    expect(typeof r.corps.requestId).toBe('string');
  });

  it('fichier d’un AUTRE compte → 404 (existence non confirmée), aucune URL signée', async () => {
    etat.lignes = [fichier(99)];
    const r = await lireCorps(await appel());
    expect(r.status).toBe(404);
    expect(r.corps.code).toBe('FILE_NOT_FOUND');
    expect(JSON.stringify(r.corps)).not.toMatch(/s3\.example\.com/);
  });
});

it('view — fichier du compte : URL signée, cache privé', async () => {
  etat.lignes = [fichier(3)];
  const r = await view(req('/api/files/42/view'), ctx);
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  expect(await r.json()).toMatchObject({ viewUrl: 'https://s3.example.com/signe' });
});

describe('BO — GET /api/admin/document-types/[id]', () => {
  it.each([
    ['AUTH_REQUIRED', 401],
    ['INSUFFICIENT_PERMISSIONS', 403],
    ['SESSION_UNAVAILABLE', 503],
  ] as const)('%s → %i typé (et non plus 500)', async (code, status) => {
    etat.admin = new Error(code);
    const r = await lireCorps(await typeDocument(req('/api/admin/document-types/42'), ctx));
    expect(r.status).toBe(status);
    expect(r.corps.code).toBe(code);
  });

  it('erreur inattendue : 500 sans message technique', async () => {
    etat.dbErreur = new Error('relation "document_types" does not exist');
    const r = await lireCorps(await typeDocument(req('/api/admin/document-types/42'), ctx));
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.corps)).not.toMatch(/relation/);
  });
});

describe('files/[id] — fichier d’un autre compte', () => {
  it('GET → 404 FILE_NOT_FOUND (et non plus 403), métadonnées non servies', async () => {
    etat.lignes = [fichier(99)];
    const r = await lireCorps(await lire(req('/api/files/42'), ctx));
    expect(r.status).toBe(404);
    expect(r.corps.code).toBe('FILE_NOT_FOUND');
    expect(r.corps.s3Key).toBeUndefined();
  });

  it('DELETE par un utilisateur → 404, rien n’est supprimé', async () => {
    etat.lignes = [fichier(99)];
    const r = await lireCorps(await supprimer(req('/api/files/42', 'DELETE'), ctx));
    expect(r.status).toBe(404);
    expect(r.corps.code).toBe('FILE_NOT_FOUND');
    expect(etat.supprimes).toBe(0);
  });

  it('DELETE par un administrateur : passe-droit conservé', async () => {
    etat.session = { ...SESSION, role: 'ADMIN' };
    etat.lignes = [fichier(99)];
    const r = await supprimer(req('/api/files/42', 'DELETE'), ctx);
    expect(r.status).toBe(200);
    expect(etat.supprimes).toBe(1);
  });

  it('GET de son propre fichier : servi', async () => {
    etat.lignes = [fichier(3)];
    expect((await lire(req('/api/files/42'), ctx)).status).toBe(200);
  });
});
