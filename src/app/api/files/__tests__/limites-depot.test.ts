/**
 * Limites de dépôt — CDC 2 §4, APP-PERF-28.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL CONTRAT, APPLIQUÉ PARTOUT, AU OCTET PRÈS
 *
 * Les valeurs vivaient en trois copies et divergeaient : `presign` acceptait
 * une vidéo de 500 Mo que la confirmation refusait (lot de 100 Mo). Elles
 * vivent désormais dans `@/lib/upload-limits`, importé par le dialogue (et
 * donc le menu mobile), `presign` et `confirm`.
 *
 * T-01 : 25 Mo et +1 octet (document), seuil vidéo et +1.
 * T-02 : lot à 100 Mo et au-dessus ; fichier initial du menu mobile trié
 *        comme les autres entrées.
 * T-03 : presign et confirm appelés directement avec une taille invalide.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  TAILLE_MAX_DOCUMENT, TAILLE_MAX_VIDEO, TAILLE_MAX_LOT, MAX_DOCUMENTS_PAR_DEPOT,
  verifierFichier, verifierLot, trierFichiersPourDepot, tailleMaxPour, enMo,
} from '@/lib/upload-limits';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const PRESIGN = read('src/app/api/files/presign/route.ts');
const CONFIRM = read('src/app/api/files/confirm/route.ts');
const DIALOGUE = read('src/components/documents/unified-document-dialog.tsx');
const MOBILE = read('src/components/mobile/mobile-actions-sheet.tsx');

const PDF = 'application/pdf';
const MP4 = 'video/mp4';

describe('contrat (valeurs retenues)', () => {
  it('document 25 Mo conservé, lot 10 documents / 100 Mo', () => {
    expect(TAILLE_MAX_DOCUMENT).toBe(25_000_000);
    expect(MAX_DOCUMENTS_PAR_DEPOT).toBe(10);
    expect(TAILLE_MAX_LOT).toBe(100_000_000);
  });

  it('vidéo : la limite réellement praticable (100 Mo), plus 500 Mo annoncés puis refusés', () => {
    expect(TAILLE_MAX_VIDEO).toBe(100_000_000);
  });

  it('invariant CA-01 : tout fichier autorisé seul tient dans un lot', () => {
    expect(Math.max(TAILLE_MAX_DOCUMENT, TAILLE_MAX_VIDEO)).toBeLessThanOrEqual(TAILLE_MAX_LOT);
  });
});

describe('seuils au octet près (T-01)', () => {
  it('document : 25 000 000 acceptés, 25 000 001 refusés', () => {
    expect(verifierFichier(25_000_000, PDF)).toBeNull();
    expect(verifierFichier(25_000_001, PDF)).toMatchObject({ code: 'FILE_TOO_LARGE', max: 25_000_000 });
  });

  it('vidéo : 100 000 000 acceptés, 100 000 001 refusés', () => {
    expect(verifierFichier(100_000_000, MP4)).toBeNull();
    expect(verifierFichier(100_000_001, MP4)).toMatchObject({ code: 'FILE_TOO_LARGE', max: 100_000_000 });
  });

  it('vide, négative, décimale ou non numérique : refus', () => {
    expect(verifierFichier(0, PDF)?.code).toBe('FILE_EMPTY');
    expect(verifierFichier(-1, PDF)?.code).toBe('INVALID_SIZE');
    expect(verifierFichier(12.5, PDF)?.code).toBe('INVALID_SIZE');
    expect(verifierFichier('abc', PDF)?.code).toBe('INVALID_SIZE');
    expect(verifierFichier(undefined, PDF)?.code).toBe('INVALID_SIZE');
    expect(verifierFichier('1000', PDF)).toBeNull();
  });

  it('type hors liste (HEIC, SVG) refusé avant transfert', () => {
    expect(verifierFichier(1000, 'image/heic')?.code).toBe('INVALID_MIME_TYPE');
    expect(verifierFichier(1000, 'image/svg+xml')?.code).toBe('INVALID_MIME_TYPE');
    expect(verifierFichier(1000, '')?.code).toBe('INVALID_MIME_TYPE');
  });

  it('messages en unités décimales cohérentes avec les constantes', () => {
    expect(enMo(25_000_000)).toBe('25 Mo');
    expect(enMo(100_000_000)).toBe('100 Mo');
    expect(verifierFichier(25_000_001, PDF)?.message).toMatch(/25 Mo/);
    expect(tailleMaxPour(MP4)).toBe(TAILLE_MAX_VIDEO);
  });
});

describe('lot (T-02)', () => {
  it('100 Mo exactement acceptés, +1 octet refusé ; 11 fichiers refusés', () => {
    expect(verifierLot([25_000_000, 25_000_000, 25_000_000, 25_000_000])).toBeNull();
    expect(verifierLot([25_000_000, 25_000_000, 25_000_000, 25_000_001])?.code).toBe('BATCH_TOO_LARGE');
    expect(verifierLot(Array(10).fill(1))).toBeNull();
    expect(verifierLot(Array(11).fill(1))?.code).toBe('TOO_MANY_FILES');
  });

  it('tri des entrées : refus unitaires, nombre, puis cumul — dans l’ordre', () => {
    const f = (name: string, size: number, mimeType = PDF) => ({ name, size, mimeType });
    const tri = trierFichiersPourDepot(
      [f('deja.pdf', 60_000_000, MP4)],
      [f('vide.pdf', 0), f('gros.pdf', 25_000_001), f('a.pdf', 25_000_000), f('b.pdf', 15_000_000), f('c.pdf', 1)],
      (x) => x,
    );
    expect(tri.refuses.map((r) => [r.fichier.name, r.refus.code])).toEqual([['vide.pdf', 'FILE_EMPTY'], ['gros.pdf', 'FILE_TOO_LARGE']]);
    expect(tri.retenus.map((x) => x.name)).toEqual(['a.pdf', 'b.pdf']);
    expect(tri.horsLot.map((x) => x.name)).toEqual(['c.pdf']);
  });

  it('nombre maximal atteint : les suivants sont écartés', () => {
    const deja = Array.from({ length: 9 }, (_, i) => ({ name: `${i}.pdf`, size: 1, mimeType: PDF }));
    const tri = trierFichiersPourDepot(deja, [{ name: 'x.pdf', size: 1, mimeType: PDF }, { name: 'y.pdf', size: 1, mimeType: PDF }], (x) => x);
    expect(tri.retenus.map((x) => x.name)).toEqual(['x.pdf']);
    expect(tri.horsNombre.map((x) => x.name)).toEqual(['y.pdf']);
  });
});

describe('toutes les entrées appliquent le même contrat (CA-02)', () => {
  it('aucune copie locale des limites dans les routes ni le dialogue', () => {
    for (const src of [PRESIGN, CONFIRM, DIALOGUE]) {
      expect(src).toMatch(/from '@\/lib\/upload-limits'/);
      expect(src).not.toMatch(/(MAX_FILE_SIZE_VIDEO|MAX_FILE_SIZE_DOCUMENT|MAX_TAILLE_FICHIER)\s*=\s*\d/);
      expect(src).not.toMatch(/500_000_000/);
    }
  });

  it('presign et confirm appellent le contrôle unitaire ; confirm contrôle aussi le lot', () => {
    expect(PRESIGN).toMatch(/verifierFichier\(size, mimeType\)/);
    expect(CONFIRM).toMatch(/verifierFichier\(Number\(f\.size \?\? 0\), f\.mimeType\)/);
    expect(CONFIRM).toMatch(/verifierLot\(/);
  });

  it('le fichier initial (menu mobile, appareil photo) passe par le même tri que le sélecteur', () => {
    expect(DIALOGUE).toMatch(/addFiles\(initialFiles, \[\]\)/);
    expect(DIALOGUE).toMatch(/trierFichiersPourDepot\(/);
    expect(MOBILE).toMatch(/input\.accept = ACCEPT_DEPOT/);
  });

  it('le dépassement est annoncé, pas silencieux', () => {
    expect(DIALOGUE).toMatch(/toast\.error/);
    expect(DIALOGUE).toMatch(/ont été écartés|a été écarté/);
  });
});

// ── Appels directs aux routes (T-03) ────────────────────────────────────────

const session = { userId: 7, currentAccountId: 70 };
vi.mock('@/lib/auth-guards', () => ({ getSession: async () => ({ ...session }) }));
vi.mock('@/lib/session-service', () => ({ SessionService: { handleSessionError: () => new Response(null, { status: 401 }) } }));
vi.mock('@/lib/s3-client', () => ({ s3Client: {}, S3_BUCKET: 'bucket-test' }));
vi.mock('@/services/entitlements.service', () => ({ canAddDocument: async () => ({ allowed: true }) }));
vi.mock('@/services/funnel-analytics.service', () => ({ trackFunnelEvent: async () => {} }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({ emitBusinessEvents: async () => {} }));
vi.mock('@/services/commercial-model.service', () => ({ canConsumeAnalysis: async () => ({ allowed: false }) }));
const garde = vi.hoisted(() => ({ refus: vi.fn() }));
vi.mock('@/lib/write-access-guard', () => ({ refuserSiLectureSeule: garde.refus }));
const objet = vi.hoisted(() => ({ verifier: vi.fn() }));
vi.mock('@/lib/upload-object-check', () => ({ verificationObjetActive: () => true, verifierObjetDepose: objet.verifier }));
const base = vi.hoisted(() => ({ lignes: [] as unknown[] }));
vi.mock('@/db', () => {
  // Toute requête de presign au-delà des contrôles statiques « atteint la
  // base » : la limite a été franchie. Confirm lit les lignes préparées.
  const chaine = (): unknown => new Proxy(() => {}, {
    get: (_t, p) => (p === 'then' ? (ok: (v: unknown) => void) => ok(base.lignes) : chaine()),
    apply: () => chaine(),
  });
  return { db: { select: () => chaine(), insert: () => { throw new Error('DB_REACHED'); }, update: () => chaine(), transaction: async () => { throw new Error('DB_REACHED'); } } };
});

const requete = (url: string, body: unknown) => new Request(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}) as never;
const HASH = 'a'.repeat(64);

describe('presign appelé directement (T-03)', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });

  const presign = async (size: unknown, mimeType = PDF, extra: Record<string, unknown> = {}) => {
    const { POST } = await import('../presign/route');
    const filename = mimeType === MP4 ? 'film.mp4' : 'facture.pdf';
    const res = await POST(requete('http://x/api/files/presign', { filename, mimeType, size, sha256Hash: HASH, ...extra }));
    return { status: res.status, body: await res.json() };
  };

  it('document : limite franchie (la base est atteinte), limite + 1 refusée sans écriture', async () => {
    base.lignes = [{ count: 0 }];
    expect((await presign(25_000_001)).body).toMatchObject({ error: 'FILE_TOO_LARGE', maxSize: 25_000_000 });
    // Au plafond exact, tous les contrôles statiques passent : la route va
    // jusqu'aux contrôles de compte (ici, base simulée ⇒ erreur interne).
    expect(await presign(25_000_000)).toMatchObject({ status: 500, body: { error: 'INTERNAL_ERROR' } });
    expect(await presign(100_000_000, MP4)).toMatchObject({ status: 500, body: { error: 'INTERNAL_ERROR' } });
  });

  it('vidéo : 100 000 001 octets refusés au presign (et non plus acceptés jusqu’à 500 Mo)', async () => {
    expect((await presign(100_000_001, MP4)).body).toMatchObject({ error: 'FILE_TOO_LARGE', maxSize: 100_000_000 });
    expect((await presign(400_000_000, MP4)).status).toBe(400);
  });

  it('taille vide ou invalide : refus explicite', async () => {
    expect((await presign(0)).body.error).toBe('FILE_EMPTY');
    expect((await presign(12.5)).body.error).toBe('INVALID_SIZE');
    expect((await presign('abc')).body.error).toBe('INVALID_SIZE');
  });

  it('empreinte de repli refusée (APP-PERF-24)', async () => {
    const res = await presign(1000, PDF, { sha256Hash: 'placeholder-hash' });
    expect(res).toMatchObject({ status: 400, body: { error: 'INVALID_HASH' } });
  });

  it('identifiant d’opération malformé refusé', async () => {
    const res = await presign(1000, PDF, { operationId: 'x y' });
    expect(res).toMatchObject({ status: 400, body: { error: 'INVALID_OPERATION_ID' } });
  });
});

describe('confirm appelé directement (T-03)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    garde.refus.mockReset();
    objet.verifier.mockReset();
  });

  const ligne = (over: Record<string, unknown>) => ({
    id: 1, userId: 7, accountId: 70, uploadStatus: 'PENDING', deletedAt: null, uploadOperationId: null,
    confirmFingerprint: null, mimeType: PDF, size: 1000, s3Key: 'k', s3Bucket: 'b', ...over,
  });
  const confirmer = async (body: Record<string, unknown> = { fileId: 1 }) => {
    const { POST } = await import('../confirm/route');
    const res = await POST(requete('http://x/api/files/confirm', body));
    return { status: res.status, body: await res.json() };
  };

  it('taille déclarée au-delà du contrat : refus avant toute écriture', async () => {
    base.lignes = [ligne({ size: 25_000_001 })];
    expect(await confirmer()).toMatchObject({ status: 400, body: { code: 'FILE_TOO_LARGE' } });
    expect(garde.refus).not.toHaveBeenCalled();
  });

  it('vidéo de 100 Mo exactement : passe les limites (atteint le contrôle des droits)', async () => {
    base.lignes = [ligne({ size: 100_000_000, mimeType: MP4 })];
    garde.refus.mockResolvedValue(new Response(JSON.stringify({ code: 'TRIAL_EXPIRED' }), { status: 403 }));
    expect((await confirmer()).status).toBe(403);
    expect(garde.refus).toHaveBeenCalledWith(70);
  });

  it('fichier d’un autre compte que la session : refusé (CA-03)', async () => {
    base.lignes = [ligne({ accountId: 71 })];
    expect(await confirmer()).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
  });

  it('objet absent du stockage : 409 reprenable, rien n’est confirmé (CA-03)', async () => {
    base.lignes = [ligne({})];
    garde.refus.mockResolvedValue(null);
    objet.verifier.mockResolvedValue({ kind: 'absent' });
    expect(await confirmer()).toMatchObject({ status: 409, body: { code: 'OBJECT_MISSING' } });
  });

  it('stockage injoignable : 503, la ligne reste en attente', async () => {
    base.lignes = [ligne({})];
    garde.refus.mockResolvedValue(null);
    objet.verifier.mockResolvedValue({ kind: 'indisponible', detail: 'timeout' });
    expect(await confirmer()).toMatchObject({ status: 503, body: { code: 'STORAGE_UNAVAILABLE' } });
  });

  it('dépôt écarté (supprimé) : jamais reconfirmé', async () => {
    base.lignes = [ligne({ deletedAt: new Date() })];
    expect(await confirmer()).toMatchObject({ status: 409, body: { code: 'FILE_DISCARDED' } });
  });

  it('client antérieur (sans clé) sur un fichier déjà confirmé : INVALID_STATUS conservé', async () => {
    base.lignes = [ligne({ uploadStatus: 'COMPLETED' })];
    expect(await confirmer()).toMatchObject({ status: 400, body: { code: 'INVALID_STATUS' } });
  });
});
