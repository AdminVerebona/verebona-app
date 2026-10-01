/**
 * Chromium serveur pour les dossiers V12 (DEC-003, MIG-03, §15.1).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN NAVIGATEUR PAR INSTANCE, UN RENDU À LA FOIS
 *
 *  · singleton paresseux : lancé au premier rendu, refermé après
 *    `EXPORTS_BROWSER_IDLE_MS` d'inactivité (60 s par défaut) — la mémoire
 *    d'un Chromium au repos n'est pas gardée pour rien ;
 *  · un seul rendu simultané par instance (file d'attente locale) : un
 *    dossier riche occupe plusieurs centaines de Mo, deux en parallèle
 *    feraient tomber un conteneur de 1 Go ;
 *  · recyclé après `EXPORTS_BROWSER_MAX_RENDERS` rendus (fuites éventuelles) ;
 *  · un rendu qui dépasse son délai TUE le navigateur (plus fiable que de
 *    fermer une page bloquée), le suivant en relance un ;
 *  · `--no-sandbox` : les conteneurs (Scalingo) n'autorisent pas les espaces
 *    de noms utilisateur ; l'isolement repose sur l'absence de JavaScript
 *    dans les pages et le blocage de toute requête hors `file:`/`data:`
 *    (voir `render-pdf.ts`) ;
 *  · `--disable-dev-shm-usage` : /dev/shm est minuscule dans un conteneur.
 *
 * Binaire : `CHROMIUM_EXECUTABLE_PATH` s'il est défini, sinon le
 * « chromium-headless-shell » installé par Playwright (voir
 * `scripts/install-chromium.mjs`, `src/services/exports/v12/README.md`).
 *
 * `playwright-core` est chargé dynamiquement (serveur uniquement,
 * `serverExternalPackages` dans next.config.mjs).
 * ══════════════════════════════════════════════════════════════════════════
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright-core';

const envInt = (name: string, def: number, min: number, max: number): number => {
  const n = Math.floor(Number(process.env[name]));
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : def;
};

export const browserIdleMs = () => envInt('EXPORTS_BROWSER_IDLE_MS', 60_000, 1_000, 3_600_000);
export const browserMaxRenders = () => envInt('EXPORTS_BROWSER_MAX_RENDERS', 50, 1, 10_000);
export const browserLaunchTimeoutMs = () => envInt('EXPORTS_BROWSER_LAUNCH_TIMEOUT_MS', 30_000, 1_000, 300_000);

export const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--font-render-hinting=none',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--mute-audio',
  '--no-first-run',
];

interface BrowserState {
  browser: Browser | null;
  launching: Promise<Browser> | null;
  renders: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  queue: Promise<unknown>;
  busy: number;
}

// État porté par globalThis : Next.js peut charger ce module plusieurs fois.
const KEY = Symbol.for('verebona.exports.v12.browser');
function state(): BrowserState {
  const g = globalThis as unknown as Record<symbol, BrowserState | undefined>;
  return (g[KEY] ??= { browser: null, launching: null, renders: 0, idleTimer: null, queue: Promise.resolve(), busy: 0 });
}

/**
 * Ubuntu ≥ 26.04 (stack scalingo-26) : Playwright 1.56 ne connaît pas cette
 * version et chercherait un binaire « ubuntu26.04 » inexistant. Le postinstall
 * installe le build ubuntu24.04 (scripts/install-chromium.mjs) : même
 * substitution ici, AVANT l'import de playwright-core (plateforme lue au chargement).
 */
function preparePlatformOverride(): void {
  if (process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE || process.platform !== 'linux') return;
  try {
    const rel = fs.readFileSync('/etc/os-release', 'utf8');
    if (!/^ID="?ubuntu"?$/m.test(rel)) return;
    const major = Number(/^VERSION_ID="?(\d+)/m.exec(rel)?.[1]);
    if (major >= 26) process.env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE = `ubuntu24.04-${process.arch}`;
  } catch {
    /* pas d'os-release : détection Playwright par défaut */
  }
}

/**
 * Prépare l'environnement de résolution du binaire AVANT l'import de
 * playwright-core (qui lit `PLAYWRIGHT_BROWSERS_PATH` au chargement) :
 * navigateur installé dans le paquet (`PLAYWRIGHT_BROWSERS_PATH=0`, slug
 * Scalingo) détecté automatiquement.
 */
function prepareBrowsersPath(): void {
  preparePlatformOverride();
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;
  const local = path.join(process.cwd(), 'node_modules', 'playwright-core', '.local-browsers');
  if (fs.existsSync(local)) process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
}

/** fontconfig des polices installées par l'apt-buildpack (repli des glyphes absents des polices embarquées). */
function fontconfigEnv(): Record<string, string> {
  if (process.env.FONTCONFIG_FILE) return {};
  const aptFonts = path.join(process.cwd(), '.apt', 'usr', 'share', 'fonts');
  if (!fs.existsSync(aptFonts)) return {};
  const file = path.join(os.tmpdir(), 'verebona-exports-fonts.conf');
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>/usr/share/fonts</dir>\n  <dir>${aptFonts}</dir>\n  <cachedir>${path.join(os.tmpdir(), 'verebona-fontconfig-cache')}</cachedir>\n</fontconfig>\n`);
    }
    return { FONTCONFIG_FILE: file };
  } catch {
    return {};
  }
}

/** Chemin explicite du binaire (`CHROMIUM_EXECUTABLE_PATH`), sinon résolution Playwright. */
export function chromiumExecutablePath(): string | undefined {
  const p = process.env.CHROMIUM_EXECUTABLE_PATH?.trim();
  return p ? p : undefined;
}

async function launch(): Promise<Browser> {
  prepareBrowsersPath();
  const { chromium } = await import('playwright-core');
  const env = { ...process.env, ...fontconfigEnv() } as Record<string, string>;
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromiumExecutablePath(),
    args: CHROMIUM_ARGS,
    timeout: browserLaunchTimeoutMs(),
    env,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  const st = state();
  browser.on('disconnected', () => {
    if (st.browser === browser) { st.browser = null; st.renders = 0; }
  });
  return browser;
}

async function getBrowser(): Promise<Browser> {
  const st = state();
  if (st.browser?.isConnected()) return st.browser;
  if (!st.launching) {
    st.launching = launch()
      .then((b) => { st.browser = b; st.renders = 0; return b; })
      .finally(() => { st.launching = null; });
  }
  return st.launching;
}

/** Ferme le navigateur (inactivité, recyclage, délai dépassé, arrêt). */
export async function closeBrowser(reason = 'arrêt'): Promise<void> {
  const st = state();
  if (st.idleTimer) { clearTimeout(st.idleTimer); st.idleTimer = null; }
  const b = st.browser;
  st.browser = null;
  st.renders = 0;
  if (!b) return;
  try {
    await Promise.race([b.close(), new Promise((r) => setTimeout(r, 5_000))]);
  } catch { /* déjà fermé */ }
  // Filet : un processus qui ne répond plus est tué.
  try { (b as unknown as { process?: () => { kill: (s: string) => void } | null }).process?.()?.kill('SIGKILL'); } catch { /* absent */ }
  if (reason !== 'inactivité') console.info(`[exports-v12] Chromium fermé (${reason}).`);
}

function armIdleTimer(): void {
  const st = state();
  if (st.idleTimer) clearTimeout(st.idleTimer);
  st.idleTimer = setTimeout(() => {
    if (state().busy === 0) void closeBrowser('inactivité');
  }, browserIdleMs());
  st.idleTimer.unref?.();
}

export class RenderTimeoutError extends Error {
  readonly exportErrorCode = 'RENDER_TIMEOUT';
  constructor(ms: number) { super(`Rendu Chromium interrompu après ${Math.round(ms / 1000)} s`); }
}

/**
 * Exécute `fn` avec le navigateur partagé, un rendu à la fois, sous délai
 * global. Au dépassement : navigateur tué, `RenderTimeoutError`.
 */
export function withBrowser<T>(fn: (browser: Browser) => Promise<T>, timeoutMs: number): Promise<T> {
  const st = state();
  const run = async (): Promise<T> => {
    st.busy++;
    if (st.idleTimer) { clearTimeout(st.idleTimer); st.idleTimer = null; }
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const browser = await getBrowser();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RenderTimeoutError(timeoutMs)), timeoutMs);
        timer.unref?.();
      });
      try {
        return await Promise.race([fn(browser), timeout]);
      } catch (e) {
        if (e instanceof RenderTimeoutError) await closeBrowser('délai de rendu dépassé');
        throw e;
      }
    } finally {
      if (timer) clearTimeout(timer);
      st.busy--;
      st.renders++;
      if (st.renders >= browserMaxRenders()) await closeBrowser('recyclage');
      armIdleTimer();
    }
  };
  const next = st.queue.then(run, run);
  st.queue = next.catch(() => undefined);
  return next;
}

/**
 * Chromium est-il utilisable ici ? Lancement réel, puis fermeture : seule
 * preuve fiable (binaire présent ET bibliothèques système disponibles).
 * Utilisé par les tests d'intégration et le diagnostic.
 */
export async function isChromiumAvailable(): Promise<boolean> {
  try {
    prepareBrowsersPath();
    const explicit = chromiumExecutablePath();
    if (explicit && !fs.existsSync(explicit)) return false;
    const { chromium } = await import('playwright-core');
    const b = await chromium.launch({ headless: true, executablePath: explicit, args: CHROMIUM_ARGS, timeout: 20_000 });
    await b.close();
    return true;
  } catch {
    return false;
  }
}
