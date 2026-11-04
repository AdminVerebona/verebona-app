/**
 * Lot 108G — interface distante (cible V1) : file technique des partages,
 * ouverture dans le navigateur système, signal d'issue des parcours de création,
 * intégration dans la coque (lecture du code).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  SHARE_INBOX_MAX_ITEMS, SHARE_INBOX_TTL_MS, accountKey, addAndroidShare, claimInboxItem, claimedBy, filesSignature,
  loadInbox, nextToPresent, parseIosItems, purgeExpired, readAndroidItems, readClaims, recordAndroidShare, removeInboxItem,
  submittedToUploadQueue, visibleFor, type InboxItem,
} from '@/lib/native/share-inbox';
import { triageSharedFiles } from '@/lib/native/share-in';
import { CREATE_FLOW_SETTLED, parseCreateFlowRequest, settleCreateFlow } from '@/lib/create-flows';

const read = (p: string) => readFileSync(resolve(__dirname, '../../../..', p), 'utf8');
const ORIGIN = 'https://app.preprod.verebona.fr';
const UA_IOS = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 VerebonaApp/1.4.0 (52; preprod)';

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); }, _m: m };
}

function installNative(platform: 'ios' | 'android', plugins: Record<string, unknown>) {
  const win = Object.assign(new EventTarget(), {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => platform, Plugins: plugins, convertFileSrc: (p: string) => p },
    location: { protocol: 'https:', origin: ORIGIN, pathname: '/accueil', search: '' },
  });
  vi.stubGlobal('window', win);
  vi.stubGlobal('navigator', { userAgent: UA_IOS });
  return win;
}

const item = (id: string, receivedAt: number, n = 1): InboxItem => ({
  id, source: 'android', receivedAt, refused: [],
  files: Array.from({ length: n }, (_, k) => ({ uri: `/cache/${id}-${k}.pdf`, name: `${id}-${k}.pdf`, mimeType: 'application/pdf' })),
});

let storage: ReturnType<typeof memoryStorage>;
beforeEach(() => { storage = memoryStorage(); vi.stubGlobal('localStorage', storage); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('L108G-INBOX — règles pures', () => {
  it('deux partages successifs = deux éléments ; un rejeu du même partage = aucun doublon', () => {
    let n = 0;
    const id = () => `id-${++n}`;
    const a = [{ uri: '/c/a.pdf', name: 'a.pdf', mimeType: 'application/pdf' }];
    const b = [{ uri: '/c/b.jpg', name: 'b.jpg', mimeType: 'image/jpeg' }, { uri: '/c/c.png', name: 'c.png', mimeType: 'image/png' }];
    let r = addAndroidShare([], a, 1000, id);
    r = addAndroidShare(r.items, b, 2000, id);
    expect(r.items.map((i) => i.files.length)).toEqual([1, 2]);
    const replay = addAndroidShare(r.items, [...b].reverse(), 3000, id);
    expect(replay.added).toBeNull();
    expect(replay.items).toHaveLength(2);
    expect(filesSignature(b)).toBe(filesSignature([...b].reverse()));
  });

  it('format refusé : motif explicite, jamais d’élément vide ; HEIC reçue telle quelle refusée avec consigne', () => {
    const r = addAndroidShare([], [{ uri: '/c/x.zip', name: 'x.zip', mimeType: 'application/zip' }], 1, () => 'z');
    expect(r.added).toBeNull();
    expect(r.refused[0].reason).toMatch(/Format non pris en charge/);
    const t = triageSharedFiles([
      { uri: '/a', name: 'IMG_1.HEIC', mimeType: 'image/heic' },
      { uri: '/b', name: 'p.webp', mimeType: 'image/webp' },
      { uri: '/c', name: 't.tiff', mimeType: 'image/tiff' },
    ]);
    expect(t.accepted.map((f) => f.name)).toEqual(['p.webp']);
    expect(t.refused.find((f) => f.name === 'IMG_1.HEIC')?.reason).toMatch(/JPEG/);
    expect(t.refused.find((f) => f.name === 't.tiff')).toBeTruthy();
  });

  it('purge : expirés effacés et signalés ; plafond respecté (les plus anciens sortent)', () => {
    const now = 10 * SHARE_INBOX_TTL_MS;
    const { kept, expired } = purgeExpired([item('old', now - SHARE_INBOX_TTL_MS - 1), item('new', now - 1)], now);
    expect(kept.map((i) => i.id)).toEqual(['new']);
    expect(expired.map((i) => i.id)).toEqual(['old']);
    const many = Array.from({ length: SHARE_INBOX_MAX_ITEMS }, (_, k) => item(`i${k}`, now - 1000 + k));
    const r = addAndroidShare(many, [{ uri: '/c/last.pdf', name: 'last.pdf', mimeType: 'application/pdf' }], now, () => 'last');
    expect(r.items).toHaveLength(SHARE_INBOX_MAX_ITEMS);
    expect(r.dropped.map((i) => i.id)).toEqual(['i0']);
  });

  it('isolation par compte : un élément pris par A est invisible pour B ; effacé à la déconnexion de A', () => {
    const items = [item('x', 1), item('y', 2)];
    const A = accountKey(1)!;
    const B = accountKey(2)!;
    const claims = { x: A };
    expect(visibleFor(items, claims, A).map((i) => i.id)).toEqual(['x', 'y']);
    expect(visibleFor(items, claims, B).map((i) => i.id)).toEqual(['y']);
    expect(visibleFor(items, claims, null)).toEqual([]);
    expect(claimedBy({ x: A, y: B }, A)).toEqual(['x']);
    expect(accountKey(null)).toBeNull();
  });

  it('proposition : le plus ancien non encore proposé pendant ce lancement', () => {
    const items = [item('b', 2), item('a', 1)];
    const A = accountKey(7)!;
    expect(nextToPresent(items, {}, A, new Set())?.id).toBe('a');
    expect(nextToPresent(items, {}, A, new Set(['a']))?.id).toBe('b');
    expect(nextToPresent(items, {}, A, new Set(['a', 'b']))).toBeNull();
  });

  it('fichiers remis à la file de dépôt → élément consommé (pas de second document)', () => {
    const f = { name: 'facture.pdf', size: 1200, lastModified: 555 };
    const q = [{ nom: 'facture.pdf', taille: 1200, derniereModif: 555, creeLe: 2000 }];
    expect(submittedToUploadQueue(q, [f], 1000)).toBe(true);
    expect(submittedToUploadQueue(q, [f], 3000)).toBe(false);
    expect(submittedToUploadQueue([{ ...q[0], derniereModif: 1 }], [f], 1000)).toBe(false);
  });

  it('iOS : éléments du plugin validés (identifiant, formats, conversions signalées)', () => {
    const items = parseIosItems({
      items: [
        { id: 'A1B2C3D4-0000-1111-2222-333344445555', createdAt: 42, files: [
          { uri: 'file:///g/partages-v1/x/0-a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 10 },
          { uri: 'file:///g/partages-v1/x/1-IMG.jpg', name: 'IMG.jpg', mimeType: 'image/jpeg', convertedFrom: 'HEIC' },
        ], refused: [{ name: 'doc.docx', reason: 'Format non pris en charge' }] },
        { id: '../../etc', files: [] },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].receivedAt).toBe(42);
    expect(items[0].files[1].convertedFrom).toBe('HEIC');
    expect(items[0].refused[0].name).toBe('doc.docx');
    expect(parseIosItems(null)).toEqual([]);
  });
});

describe('L108G-INBOX — accès natif', () => {
  it('iOS : lecture par le plugin local, effacement après import / abandon', async () => {
    const remove = vi.fn(async () => ({ removed: true }));
    const list = vi.fn(async () => ({ items: [{ id: 'A1B2C3D4-0000', createdAt: 1, files: [{ uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf' }] }], expired: 2 }));
    installNative('ios', { VerebonaShareInbox: { list, remove } });
    const r = await loadInbox();
    expect(list).toHaveBeenCalledWith({ maxAgeMs: SHARE_INBOX_TTL_MS });
    expect(r.expired).toBe(2);
    expect(r.items[0].id).toBe('A1B2C3D4-0000');
    claimInboxItem(r.items[0].id, 'u:9');
    expect(readClaims()).toEqual({ 'A1B2C3D4-0000': 'u:9' });
    await removeInboxItem(r.items[0]);
    expect(remove).toHaveBeenCalledWith({ id: 'A1B2C3D4-0000' });
    expect(readClaims()).toEqual({});
  });

  it('Android : partage gardé (références seulement) jusqu’à l’effacement ; copie locale supprimée', async () => {
    const deleteFile = vi.fn(async () => undefined);
    installNative('android', { Filesystem: { deleteFile } });
    const r = recordAndroidShare([{ uri: '/data/cache/shared_files/share-1.tmp', name: 'f.pdf', mimeType: 'application/pdf' }], Date.now());
    expect(r.added).not.toBeNull();
    expect(JSON.stringify([...storage._m.values()])).not.toMatch(/%PDF/);
    expect((await loadInbox()).items).toHaveLength(1);
    await removeInboxItem(r.added!);
    expect(readAndroidItems()).toEqual([]);
    expect(deleteFile).toHaveBeenCalledWith({ path: '/data/cache/shared_files/share-1.tmp' });
  });

  it('Web : aucune file', async () => {
    expect(await loadInbox()).toEqual({ items: [], expired: 0 });
  });
});

describe('L108G-EXT — liens entrants hors app : navigateur système (brique 108H)', () => {
  it('la coque n’utilise plus le plugin Browser intégré', () => {
    const runtime = read('src/components/native/NativeBridgeRuntime.tsx');
    expect(runtime).toMatch(/openExternalUrl\(r\.url\)/);
    expect(runtime).not.toMatch(/NATIVE_PLUGINS\.browser/);
  });
});

describe('L108G-FLOW — issue des parcours de création', () => {
  it('requestId conservé s’il est sûr ; événement d’issue émis', () => {
    expect(parseCreateFlowRequest({ flow: 'document', requestId: 'A1B2-c3' })?.requestId).toBe('A1B2-c3');
    expect(parseCreateFlowRequest({ flow: 'document', requestId: '<script>' })?.requestId).toBeUndefined();
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    const seen: unknown[] = [];
    win.addEventListener(CREATE_FLOW_SETTLED, (e) => seen.push((e as CustomEvent).detail));
    settleCreateFlow('abc', 'success');
    settleCreateFlow(undefined, 'closed');
    expect(seen).toEqual([{ requestId: 'abc', outcome: 'success' }]);
  });

  it('hôte : ouverture, succès et fermeture signalés', () => {
    const host = read('src/components/drawers/GlobalCreateFlowHost.tsx');
    expect(host).toMatch(/if \(ouvert\) settleCreateFlow\(ouvert\.requestId, 'opened'\)/);
    expect(host).toMatch(/settleCreateFlow\(ouvert\.requestId, 'success'\)/);
    expect(host).toMatch(/settleCreateFlow\(ouvert\?\.requestId, 'closed'\)/);
  });
});

describe('L108G-RUNTIME — coque native (lecture du code)', () => {
  const runtime = read('src/components/native/NativeBridgeRuntime.tsx');
  it('plus de fichiers partagés gardés en mémoire seulement', () => {
    expect(runtime).not.toMatch(/pendingFiles/);
    expect(runtime).toMatch(/recordAndroidShare\(e\?\.files\)/);
    expect(runtime).toMatch(/loadInbox\(\)/);
    expect(runtime).toMatch(/requestId: item\.id/);
    expect(runtime).toMatch(/removeInboxItem/);
    expect(runtime).toMatch(/t\.reason !== 'logout'/);
    expect(runtime).toMatch(/>Abandonner</);
  });
  it('réseau : « Connexion Internet indisponible » + « Réessayer », sans rechargement', () => {
    expect(runtime).toMatch(/Connexion Internet indisponible/);
    expect(runtime).toMatch(/Réessayer/);
    expect(runtime).toMatch(/reessayerReseau/);
  });
  it('CSP appliquée à la vue de l’application seulement', () => {
    const cfg = read('next.config.mjs');
    expect(cfg).toMatch(/value: "\.\*VerebonaApp\/\.\*"/);
    expect(cfg).toMatch(/key: "Content-Security-Policy",\n\s+value: \[\n\s+"object-src 'none'"/);
    expect(cfg).toMatch(/"frame-src 'self' blob: data:"/);
    expect(cfg).toMatch(/Content-Security-Policy-Report-Only/);
  });
  it('envoi natif interrompu : état explicite, pas de promesse de reprise automatique', () => {
    const up = read('src/lib/native/native-upload.ts');
    expect(up).not.toMatch(/Il reprendra à la prochaine tentative/);
    expect(up).toMatch(/« Reprendre »/);
  });
});
