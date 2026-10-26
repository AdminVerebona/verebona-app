/**
 * Lot 79B — Icônes PWA Apple / Android (ticket P2 « Corriger l'icône Verebona
 * sur Apple et Android »).
 *
 * Identifiants : L79B-SRC (symbole officiel validé), L79B-AND (Android 192/512,
 * maskable distincte, zone de sécurité), L79B-APL (apple-touch-icon 180
 * opaque), L79B-CACHE (noms versionnés, cache HTTP, service worker), L79B-ID
 * (identité de la PWA conservée).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import vm from 'node:vm';
import sharp from 'sharp';
import { NextRequest } from 'next/server';
// Même fonction que le routeur de Next pour les règles `headers()`.
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import {
  PWA_APPLE_TOUCH_ICON_180,
  PWA_ICON_ANY_192,
  PWA_ICON_ANY_512,
  PWA_ICON_MASKABLE_192,
  PWA_ICON_MASKABLE_512,
  PWA_MANIFEST_ICONS,
} from '@/lib/pwa/icons';
import { GET as getManifest } from '@/app/api/manifest/route';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const publicFile = (url: string) => join(ROOT, 'public', url.replace(/^\//, ''));
const sha256 = (url: string) => createHash('sha256').update(readFileSync(publicFile(url))).digest('hex');

/**
 * Empreintes des fichiers de la « première planche » validée par le PO
 * (commit a179e11, lot 71H) — `git show a179e11:public/<fichier> | sha256sum`.
 */
const PLANCHE_VALIDEE = {
  'android-chrome-192x192.png': '5fc7759d4723e977a32e678f807ee1c6115966fc1afbb53449c18787a71642e9',
  'android-chrome-512x512.png': 'afb66f1c153dc5b8529a2cd583bdf77dc0237eb2c33ea5af715d8df79806810c',
  'apple-touch-icon-v2.png': '9d62d83b1814a3e600f1dd3b5ad1b80d6114501552ab60ece5e3469dbbda8291',
} as const;

const PETROLE = [0x17, 0x47, 0x4d];

async function analyser(url: string) {
  const { data, info } = await sharp(publicFile(url)).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  const px = (x: number, y: number) => Array.from(data.subarray((y * w + x) * channels, (y * w + x) * channels + channels));
  let alphaMin = 255;
  let rMax = 0;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  const fond = px(0, 0).slice(0, 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = px(x, y);
      if (channels === 4) alphaMin = Math.min(alphaMin, p[3]);
      const ecart = Math.abs(p[0] - fond[0]) + Math.abs(p[1] - fond[1]) + Math.abs(p[2] - fond[2]);
      if (ecart > 12) {
        rMax = Math.max(rMax, Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2));
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  const coins = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
  return {
    w, h, channels, alphaMin, coins, fond,
    rayonMax: rMax / w,
    centreX: (minX + maxX + 1) / 2 / w,
    centreY: (minY + maxY + 1) / 2 / h,
    largeur: (maxX - minX + 1) / w,
  };
}

function manifesteStatique() {
  return JSON.parse(read('public/manifest.json')) as {
    icons: Array<{ src: string; sizes: string; purpose?: string; type?: string }>;
    shortcuts: Array<{ icons: Array<{ src: string }> }>;
    id?: string; start_url: string; scope: string; background_color: string; theme_color: string;
  };
}

async function manifesteServi(ua: string) {
  const res = await getManifest(new NextRequest('https://verebona.app/api/manifest', { headers: { 'user-agent': ua } }));
  return { res, json: await res.json() };
}
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

describe('L79B-SRC — fichiers servis = symbole officiel validé (planche a179e11)', () => {
  it('L79B-SRC-01 — chaque icône PWA est une copie octet pour octet de la planche validée', () => {
    expect(sha256(PWA_ICON_ANY_192)).toBe(PLANCHE_VALIDEE['android-chrome-192x192.png']);
    expect(sha256(PWA_ICON_MASKABLE_192)).toBe(PLANCHE_VALIDEE['android-chrome-192x192.png']);
    expect(sha256(PWA_ICON_ANY_512)).toBe(PLANCHE_VALIDEE['android-chrome-512x512.png']);
    expect(sha256(PWA_ICON_MASKABLE_512)).toBe(PLANCHE_VALIDEE['android-chrome-512x512.png']);
    expect(sha256(PWA_APPLE_TOUCH_ICON_180)).toBe(PLANCHE_VALIDEE['apple-touch-icon-v2.png']);
  });

  it('L79B-SRC-02 — les anciens noms encore servis (installations existantes) portent aussi la planche validée', () => {
    for (const [nom, empreinte] of Object.entries(PLANCHE_VALIDEE)) expect(sha256(`/${nom}`)).toBe(empreinte);
    // Convention iOS : `/apple-touch-icon.png` est demandé sans déclaration.
    expect(sha256('/apple-touch-icon.png')).toBe(PLANCHE_VALIDEE['apple-touch-icon-v2.png']);
  });

  it('L79B-SRC-03 — aucun relief ni reflet : aplats de la charte (pétrole, ivoire, cuivre) et leur seul anticrénelage', async () => {
    for (const url of [PWA_ICON_ANY_512, PWA_APPLE_TOUCH_ICON_180]) {
      const { data, info } = await sharp(publicFile(url)).raw().toBuffer({ resolveWithObject: true });
      const charte = [PETROLE, [0xf8, 0xf6, 0xf1], [0xd6, 0x6b, 0x53]];
      let aplats = 0;
      const n = info.width * info.height;
      for (let i = 0; i < n; i++) {
        const p = data.subarray(i * info.channels, i * info.channels + 3);
        if (charte.some((c) => c[0] === p[0] && c[1] === p[1] && c[2] === p[2])) aplats++;
      }
      // Un dégradé ou un reflet produirait une large part de teintes hors charte ;
      // seuls les bords anticrénelés des cases en sont (< 5 % des pixels).
      expect(aplats / n).toBeGreaterThan(0.95);
    }
  });
});

describe('L79B-AND — Android : 192 / 512, maskable distincte', () => {
  it('L79B-AND-01 — 192 × 192 et 512 × 512, PNG opaques, fond pétrole plein cadre', async () => {
    for (const [url, taille] of [
      [PWA_ICON_ANY_192, 192], [PWA_ICON_ANY_512, 512], [PWA_ICON_MASKABLE_192, 192], [PWA_ICON_MASKABLE_512, 512],
    ] as const) {
      const a = await analyser(url);
      expect([a.w, a.h]).toEqual([taille, taille]);
      expect(a.channels === 3 || a.alphaMin === 255).toBe(true);
      for (const coin of a.coins) expect(coin.slice(0, 3)).toEqual(PETROLE);
    }
  });

  it('L79B-AND-02 — maskable : symbole entier dans le disque de sécurité (rayon 40 %), centré, ni étiré', async () => {
    for (const url of [PWA_ICON_MASKABLE_192, PWA_ICON_MASKABLE_512]) {
      const a = await analyser(url);
      expect(a.rayonMax).toBeLessThanOrEqual(0.4);
      expect(Math.abs(a.centreX - 0.5)).toBeLessThan(0.01);
      expect(Math.abs(a.centreY - 0.5)).toBeLessThan(0.01);
      expect(a.largeur).toBeGreaterThan(0.5); // lisible : plus de la moitié du cadre
    }
  });

  it('L79B-AND-03 — manifeste servi (Android, iPhone, ordinateur) : 192 et 512 en « any » ET en « maskable », jamais « any maskable »', async () => {
    for (const ua of [UA_ANDROID, UA_IPHONE, UA_DESKTOP]) {
      const { json } = await manifesteServi(ua);
      const icons = json.icons as Array<{ src: string; sizes: string; purpose: string; type: string }>;
      expect(icons).toEqual([...PWA_MANIFEST_ICONS]);
      for (const purpose of ['any', 'maskable']) {
        expect(icons.filter((i) => i.purpose === purpose).map((i) => i.sizes).sort()).toEqual(['192x192', '512x512']);
      }
      expect(icons.some((i) => /\s/.test(i.purpose))).toBe(false);
      for (const i of icons) expect(existsSync(publicFile(i.src))).toBe(true);
    }
  });

  it('L79B-AND-04 — manifeste statique (pré-caché par le SW) aligné ; raccourcis sur l’icône versionnée', () => {
    const m = manifesteStatique();
    expect(m.icons).toEqual([...PWA_MANIFEST_ICONS]);
    for (const s of m.shortcuts) expect(s.icons.map((i) => i.src)).toEqual([PWA_ICON_ANY_192]);
  });
});

describe('L79B-APL — Apple : apple-touch-icon 180 opaque', () => {
  it('L79B-APL-01 — 180 × 180, opaque, coins carrés (aucun arrondi intégré : iOS applique son masque)', async () => {
    const a = await analyser(PWA_APPLE_TOUCH_ICON_180);
    expect([a.w, a.h]).toEqual([180, 180]);
    expect(a.channels === 3 || a.alphaMin === 255).toBe(true);
    for (const coin of a.coins) expect(coin.slice(0, 3)).toEqual(PETROLE);
    expect(Math.abs(a.centreX - 0.5)).toBeLessThan(0.01);
    expect(Math.abs(a.centreY - 0.5)).toBeLessThan(0.01);
  });

  it('L79B-APL-02 — déclaration unique dans le layout racine (hérité par toutes les pages), sans autre variante', () => {
    const layout = read('src/app/layout.tsx');
    expect(layout).toMatch(/apple: \[\s*\{ url: PWA_APPLE_TOUCH_ICON_180, sizes: '180x180', type: 'image\/png' \},\s*\]/);
    expect(layout).not.toContain('apple-touch-icon-v2');
    // Aucune autre page / layout ne redéclare d'icône Apple ni de manifeste.
    const autres: string[] = [];
    const parcourir = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (e.name !== '__tests__') parcourir(p); continue; }
        if (!/\.(tsx?|jsx?)$/.test(e.name) || p === 'src/app/layout.tsx') continue;
        const src = readFileSync(join(ROOT, p), 'utf-8');
        if (/apple-touch-icon|appleWebApp|\bicons:\s*\{|rel=["']manifest/.test(src)) autres.push(p);
      }
    };
    parcourir('src/app');
    expect(autres).toEqual([]);
  });
});

describe('L79B-CACHE — nouveaux noms, cache HTTP et service worker', () => {
  it('L79B-CACHE-01 — plus aucune référence aux anciens noms dans manifestes, layout et SW', () => {
    for (const p of ['src/app/api/manifest/route.ts', 'src/app/layout.tsx', 'public/manifest.json', 'public/sw.js']) {
      const src = read(p);
      expect(src, p).not.toMatch(/android-chrome-|apple-touch-icon(-v2)?\.png|\/icon-\d+x\d+\.png/);
      // Les favicons (onglet, `?v=`) restent déclarés dans le layout, plus dans les manifestes.
      if (p !== 'src/app/layout.tsx') expect(src, p).not.toMatch(/favicon-(128|256)x/);
    }
    // Toutes les icônes PWA vivent dans public/pwa/ sous un nom suffixé du lot.
    for (const url of [PWA_ICON_ANY_192, PWA_ICON_ANY_512, PWA_ICON_MASKABLE_192, PWA_ICON_MASKABLE_512, PWA_APPLE_TOUCH_ICON_180]) {
      expect(url).toMatch(/^\/pwa\/[a-z0-9-]+-l\d+\.png$/);
    }
  });

  it('L79B-CACHE-02 — cache HTTP : /pwa/ immuable, anciens noms / sw.js / manifest.json revalidés, manifeste dynamique no-store', async () => {
    const { default: config } = await import('../../../../next.config.mjs');
    const regles = (await config.headers!()) as Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    const cacheControl = (chemin: string) => {
      let valeur: string | undefined;
      for (const r of regles) {
        if (getPathMatch(r.source, { strict: true, removeUnnamedParams: true })(chemin) === false) continue;
        const h = r.headers.find((x) => x.key.toLowerCase() === 'cache-control');
        if (h) valeur = h.value;
      }
      return valeur;
    };
    for (const url of PWA_MANIFEST_ICONS.map((i) => i.src).concat(PWA_APPLE_TOUCH_ICON_180)) {
      expect(cacheControl(url)).toBe('public, max-age=31536000, immutable');
    }
    for (const ancien of ['/apple-touch-icon.png', '/apple-touch-icon-v2.png', '/android-chrome-192x192.png', '/android-chrome-512x512.png', '/sw.js', '/manifest.json']) {
      expect(cacheControl(ancien), ancien).toBe('no-cache');
    }
    // Rien d'autre n'est touché (favicons versionnés par `?v=`, pages, API).
    for (const autre of ['/favicon.ico', '/accueil', '/api/manifest', '/images/x.png']) expect(cacheControl(autre)).toBeUndefined();
    const { res } = await manifesteServi(UA_ANDROID);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('L79B-CACHE-03 — service worker : nouvelle version de cache, anciens caches verebona-* supprimés, autres caches conservés', async () => {
    const source = read('public/sw.js');
    expect(source).toContain("const NOTIFICATION_ICON = '/pwa/icon-any-192-l79.png';");
    expect(source).not.toContain("const CACHE_VERSION = 'v5.1.0';");
    const listeners: Record<string, (e: unknown) => void> = {};
    const deleted: string[] = [];
    const self = {
      addEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = fn; },
      clients: { matchAll: async () => [], claim: async () => undefined },
      registration: {},
      location: { origin: 'https://app' },
      skipWaiting: () => undefined,
    };
    const caches = {
      keys: async () => ['verebona-v5.1.0', 'verebona-static-v5.1.0', 'verebona-v5.2.0', 'verebona-static-v5.2.0', 'autre-bibliotheque'],
      delete: async (n: string) => { deleted.push(n); return true; },
    };
    vm.runInNewContext(source, { self, caches, fetch: async () => new Response(''), Response, Request, URL, location: { origin: 'https://app' }, console, Date, Map, Promise });
    let attente: Promise<unknown> = Promise.resolve();
    listeners.activate({ waitUntil: (p: Promise<unknown>) => { attente = p; } });
    await attente;
    expect(deleted.sort()).toEqual(['verebona-static-v5.1.0', 'verebona-v5.1.0']);
  });

  it('L79B-CACHE-04 — les icônes ne sont pas derrière le middleware d’authentification', () => {
    const mw = read('src/middleware.ts');
    const matcher = mw.slice(mw.indexOf('matcher: ['));
    expect(matcher).not.toMatch(/'\/pwa|'\/:path\*'|'\/\(\.\*\)'/);
  });
});

describe('L79B-ID — identité de la PWA conservée', () => {
  it('L79B-ID-01 — ni `id` ajouté, ni `start_url` / `scope` modifiés ; couleurs du splash conservées', async () => {
    const { json: mobile } = await manifesteServi(UA_ANDROID);
    expect(mobile.id).toBeUndefined();
    expect(mobile.start_url).toBe('/accueil');
    expect(mobile.scope).toBe('/');
    expect(mobile.display).toBe('standalone');
    expect(mobile.background_color).toBe('#17474D');
    expect(mobile.theme_color).toBe('#17474D');
    const statique = manifesteStatique();
    expect(statique.id).toBeUndefined();
    expect(statique.start_url).toBe('/accueil');
    expect(statique.scope).toBe('/');
    const { json: bureau } = await manifesteServi(UA_DESKTOP);
    expect(bureau.id).toBeUndefined();
    expect(bureau.start_url).toBeUndefined();
    expect(bureau.scope).toBeUndefined();
    // Le SW reste enregistré au même chemin (même périmètre, même abonnement push).
    expect(read('src/lib/push/push-client.ts')).toContain("navigator.serviceWorker.register('/sw.js')");
  });
});
