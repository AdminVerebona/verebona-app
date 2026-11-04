/**
 * Lot 108H — brique générique « ouvrir dans le navigateur système »
 * (`lib/native/open-external`) : AppLauncher dans l'app, nouvel onglet sur le
 * Web, jamais `Browser` (SFSafariViewController / Custom Tabs).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseExternalOpenStrategy, normalizeExternalUrl, openExternalUrl } from '@/lib/native/open-external';
import { chooseLegalOpenStrategy } from '@/lib/legal/open-legal-link';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const SITE = 'https://www.verebona.fr/legal/parrainage';
const APP = 'https://app.verebona.fr';

afterEach(() => { vi.unstubAllGlobals(); });

describe('L108H-EXT-01 — choix de la méthode', () => {
  it.each([
    [null, true, SITE, 'web-new-tab'],
    ['ios', true, SITE, 'native-external'],
    ['android', true, SITE, 'native-external'],
    ['ios', false, SITE, 'native-system-handoff'],
    ['android', false, `${APP}/cguv`, 'native-unavailable'],
  ] as const)('%s, AppLauncher %s, %s → %s', (platform, hasAppLauncher, url, attendu) => {
    expect(chooseExternalOpenStrategy({ platform, hasAppLauncher, urlOrigin: new URL(url).origin, appOrigin: APP })).toBe(attendu);
  });

  it('les textes juridiques utilisent la même règle (alias)', () => {
    expect(chooseLegalOpenStrategy).toBe(chooseExternalOpenStrategy);
  });
});

describe('L108H-EXT-02 — ouverture', () => {
  it('iOS / Android : AppLauncher.openUrl (UIApplication.open / ACTION_VIEW), jamais la vue', async () => {
    for (const platform of ['ios', 'android'] as const) {
      const openUrl = vi.fn(async () => ({ completed: true }));
      const windowOpen = vi.fn(() => true);
      const r = await openExternalUrl(SITE, { platform, appLauncher: { openUrl }, appOrigin: APP, windowOpen });
      expect(r).toEqual({ ok: true, strategy: 'native-external', url: SITE });
      expect(openUrl).toHaveBeenCalledWith({ url: SITE });
      expect(windowOpen).not.toHaveBeenCalled();
    }
  });

  it('plugin résolu dans window.Capacitor.Plugins.AppLauncher (jamais Browser)', async () => {
    const openUrl = vi.fn(async () => ({ completed: true }));
    const browserOpen = vi.fn(async () => undefined);
    vi.stubGlobal('window', {
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { AppLauncher: { openUrl }, Browser: { open: browserOpen } } },
      location: { origin: APP },
    });
    const r = await openExternalUrl(SITE);
    expect(r.ok && r.strategy).toBe('native-external');
    expect(openUrl).toHaveBeenCalledWith({ url: SITE });
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it('Web / PWA : nouvel onglet, aucun appel natif', async () => {
    const openUrl = vi.fn(async () => ({ completed: true }));
    const windowOpen = vi.fn(() => true);
    const r = await openExternalUrl(SITE, { platform: null, appLauncher: { openUrl }, windowOpen });
    expect(r).toEqual({ ok: true, strategy: 'web-new-tab', url: SITE });
    expect(windowOpen).toHaveBeenCalledWith(SITE);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('échecs explicites, jamais d’exception', async () => {
    expect(await openExternalUrl(SITE, { platform: 'ios', appLauncher: { openUrl: async () => ({ completed: false }) } }))
      .toEqual({ ok: false, reason: 'open_failed', strategy: 'native-external', url: SITE });
    expect(await openExternalUrl(SITE, { platform: 'ios', appLauncher: { openUrl: async () => { throw new Error('x'); } } }))
      .toMatchObject({ ok: false, reason: 'open_failed' });
    const windowOpen = vi.fn(() => true);
    expect(await openExternalUrl(`${APP}/cguv`, { platform: 'android', appLauncher: null, appOrigin: APP, windowOpen }))
      .toMatchObject({ ok: false, reason: 'unavailable', strategy: 'native-unavailable' });
    expect(windowOpen).not.toHaveBeenCalled();
    for (const bad of ['javascript:alert(1)', '/legal/parrainage', 'https://u:p@www.verebona.fr/', '', null, 42]) {
      expect(await openExternalUrl(bad, { platform: 'ios', appLauncher: { openUrl: vi.fn() } })).toMatchObject({ ok: false, reason: 'invalid' });
    }
    expect(normalizeExternalUrl(' https://www.verebona.fr/legal/parrainage ')?.toString()).toBe(SITE);
  });
});

describe('L108H-EXT-03 — preuve par le code natif embarqué', () => {
  it('coque : AppLauncher déclaré et lié (iOS SPM, Android Gradle) ; Browser jamais appelé pour un lien externe sortant', () => {
    const pkg = JSON.parse(read('mobile/package.json')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@capacitor/app-launcher']).toMatch(/^8\.\d+\.\d+$/);
    expect(read('mobile/ios/App/CapApp-SPM/Package.swift')).toContain('.product(name: "CapacitorAppLauncher", package: "CapacitorAppLauncher")');
    expect(read('mobile/android/app/capacitor.build.gradle')).toMatch(/implementation project\(':capacitor-app-launcher'\)/);
    const src = read('src/lib/native/open-external.ts');
    expect(src).toContain('nativePlugin<AppLauncherPlugin>(NATIVE_PLUGINS.appLauncher)');
    expect(src).not.toMatch(/NATIVE_PLUGINS\.browser/);
  });

  it('la vue n’autorise que le domaine de l’app : le site public n’y est jamais chargé', () => {
    const cfg = read('mobile/capacitor.config.ts');
    // Lot 108G : origine seule, aucun domaine supplémentaire (le site public n'est jamais chargé dans la vue).
    expect(cfg).toMatch(/allowNavigation: \[\]/);
    expect(cfg).not.toMatch(/allowNavigation: \[[^\]]*public/i);
  });
});
