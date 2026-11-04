/**
 * Ouverture des textes juridiques — lot 103A (recette iOS du 31/10/2026,
 * décision PO : depuis l'application iOS / Android, tout texte juridique
 * s'ouvre dans le NAVIGATEUR EXTERNE du téléphone).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE PRIMITIVE, TROIS QUESTIONS
 *
 *   1. L'adresse est-elle une destination juridique autorisée ?
 *      HTTPS (HTTP local hors production seulement), sans identifiants ni
 *      donnée de session dans l'URL, et :
 *        · sur le SITE PUBLIC (`NEXT_PUBLIC_PUBLIC_SITE_URL`, variante www /
 *          apex, origines des surcharges `NEXT_PUBLIC_LEGAL_*_URL` et
 *          origines déclarées par le serveur — `LEGAL_PUBLIC_EXTRA_ORIGINS`) ;
 *        · lot 108L : JAMAIS l'origine de l'application (app.*), ni ses
 *          anciennes adresses `/cguv…` / `/cgvu…` (l'archive technique de
 *          l'application n'est plus jamais la cible d'un lien utilisateur).
 *      Toute autre adresse est refusée : aucune redirection ouverte.
 *   2. Où tourne l'interface ? (`lib/native/bridge`)
 *   3. Comment ouvrir ?
 *        · navigateur (Web) : nouvel onglet, comme avant (le composant
 *          `LegalLink` laisse faire la balise `<a target="_blank">`) ;
 *        · application : `AppLauncher.openUrl` (@capacitor/app-launcher) =
 *          `UIApplication.shared.open` (iOS) / `Intent.ACTION_VIEW` (Android)
 *          → Safari / Chrome ou le navigateur par défaut, HORS de la vue
 *          Verebona, qui reste en arrière-plan avec sa page, son tiroir et
 *          ses saisies. Jamais `Browser.open` (SFSafariViewController /
 *          Custom Tabs : intégré à l'app), jamais un chargement dans la vue ;
 *        · application sans ce plugin (binaire antérieur au lot 103A) : une
 *          adresse HORS de l'origine de l'app est confiée à Capacitor, qui
 *          remet au système toute navigation vers un domaine non autorisé
 *          (`allowNavigation`) ; une adresse de l'origine de l'app ne peut pas
 *          l'être sans remplacer la vue → échec explicite.
 *   Échec : message + adresse officielle à copier — jamais un écran sans issue.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { type NativePlatform } from '@/lib/native/bridge';
import { chooseExternalOpenStrategy, openExternalUrl, type AppLauncherPlugin, type ExternalOpenStrategy } from '@/lib/native/open-external';
import { appOrigin as nativeAppOrigin } from '@/lib/native/shell-info';
import { PUBLIC_SITE_URL } from '@/lib/external-urls';

/**
 * Chemins juridiques historiques de l'application (redirection publique ou
 * archive technique). Lot 108L : jamais une destination de lien utilisateur.
 */
export const APP_LEGAL_PATH = /^\/(?:cguv|cgvu)(?:\/versions\/[A-Za-z0-9._-]{1,40})?\/?$/;

/** Paramètres qui ne doivent jamais voyager vers un texte juridique (session, identité, secrets). */
export const SENSITIVE_QUERY_KEY =
  /^(?:token|access_token|refresh_token|id_token|jwt|sid|session|session_id|sessionid|auth|authorization|code|handoff|ticket|state|nonce|password|email|key|apikey|api_key|signature|installation|installation_id)$/i;

export interface LegalLinkPolicy {
  /** Origines du site public (et assimilées) autorisées pour tout chemin. */
  publicOrigins: readonly string[];
  /** Origine de l'application : seuls les chemins `APP_LEGAL_PATH` y sont admis. */
  appOrigin: string | null;
  /** HTTP admis pour localhost / 127.0.0.1 (hors production). */
  allowLoopbackHttp: boolean;
}

function originOf(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!/^https?:\/\//i.test(v)) return null;
  try { return new URL(v).origin; } catch { return null; }
}

/** Variante www ↔ apex d'une origine HTTPS (l'apex du site public redirige vers www). */
function withWwwVariant(origin: string): string[] {
  try {
    const u = new URL(origin);
    if (/^(?:localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return [origin];
    const alt = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
    return alt.includes('.') ? [origin, `${u.protocol}//${alt}${u.port ? `:${u.port}` : ''}`] : [origin];
  } catch {
    return [origin];
  }
}

/** Politique d'après la configuration (pure, testée). */
export function buildLegalLinkPolicy(input: {
  publicSiteUrl: string;
  overrides?: ReadonlyArray<string | null | undefined>;
  extraOrigins?: ReadonlyArray<string | null | undefined>;
  appOrigin: string | null;
  production: boolean;
}): LegalLinkPolicy {
  const set = new Set<string>();
  const site = originOf(input.publicSiteUrl);
  if (site) for (const o of withWwwVariant(site)) set.add(o);
  for (const raw of [...(input.overrides ?? []), ...(input.extraOrigins ?? [])]) {
    const o = originOf(raw);
    if (o) set.add(o);
  }
  return { publicOrigins: [...set], appOrigin: originOf(input.appOrigin), allowLoopbackHttp: !input.production };
}

export type LegalUrlRefusal = 'invalid' | 'insecure' | 'credentials' | 'domain' | 'sensitive_data';
export type LegalUrlCheck = { ok: true; url: string; origin: string } | { ok: false; reason: LegalUrlRefusal };

/** Contrôle d'une destination juridique (pur, testé). Une adresse relative est lue sur l'origine de l'app. */
export function checkLegalUrl(raw: unknown, policy: LegalLinkPolicy): LegalUrlCheck {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000 || raw.trim() === '#') return { ok: false, reason: 'invalid' };
  let u: URL;
  try { u = new URL(raw.trim(), policy.appOrigin ?? undefined); } catch { return { ok: false, reason: 'invalid' }; }
  const loopback = /^(?:localhost|127\.0\.0\.1)$/.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback && policy.allowLoopbackHttp)) return { ok: false, reason: 'insecure' };
  if (u.username || u.password) return { ok: false, reason: 'credentials' };
  for (const key of u.searchParams.keys()) if (SENSITIVE_QUERY_KEY.test(key)) return { ok: false, reason: 'sensitive_data' };
  if (/(?:^|[&#])(?:access_token|id_token|token|code|sid)=/i.test(u.hash.slice(1))) return { ok: false, reason: 'sensitive_data' };
  // Lot 108L : site public uniquement — l'application (app.*, /cguv, /cgvu) n'est jamais une cible.
  const isApp = !!policy.appOrigin && u.origin === policy.appOrigin;
  if (isApp || !policy.publicOrigins.includes(u.origin)) return { ok: false, reason: 'domain' };
  return { ok: true, url: u.toString(), origin: u.origin };
}

/**
 * Méthode d'ouverture — lot 108H : brique générique `lib/native/open-external`
 * (navigateur système via AppLauncher, jamais `Browser`). Alias conservés.
 */
export type LegalOpenStrategy = ExternalOpenStrategy;

/** Choix de la méthode d'ouverture (pur, testé) — voir `chooseExternalOpenStrategy`. */
export const chooseLegalOpenStrategy = chooseExternalOpenStrategy;

// ── Contexte d'exécution ───────────────────────────────────────────────────

let serverOrigins: string[] = [];

/** Origines juridiques déclarées par le serveur (`GET /api/legal/links` › `allowedOrigins`). */
export function registerServerLegalOrigins(origins: unknown): void {
  if (!Array.isArray(origins)) return;
  serverOrigins = origins.map((o) => originOf(typeof o === 'string' ? o : null)).filter((o): o is string => !!o && o.startsWith('https://'));
}

// Accès LITTÉRAUX (Next injecte les NEXT_PUBLIC_* au build).
const BUILD_OVERRIDES = [
  process.env.NEXT_PUBLIC_LEGAL_MENTIONS_URL,
  process.env.NEXT_PUBLIC_LEGAL_CGUV_URL,
  process.env.NEXT_PUBLIC_LEGAL_PRIVACY_URL,
  process.env.NEXT_PUBLIC_LEGAL_SUBPROCESSORS_URL,
  process.env.NEXT_PUBLIC_LEGAL_REFERRAL_URL,
];

/** Origine de l'application dans ce contexte (coque native, sinon page courante). */
function currentAppOrigin(): string | null {
  const native = nativeAppOrigin();
  if (native) return native;
  if (typeof window === 'undefined') return null;
  return window.location?.origin && /^https?:\/\//.test(window.location.origin) ? window.location.origin : null;
}

/** Politique du contexte courant (navigateur ou application). */
export function currentLegalLinkPolicy(): LegalLinkPolicy {
  return buildLegalLinkPolicy({
    publicSiteUrl: PUBLIC_SITE_URL,
    overrides: BUILD_OVERRIDES,
    extraOrigins: serverOrigins,
    appOrigin: currentAppOrigin(),
    production: process.env.NODE_ENV === 'production',
  });
}

export type LegalOpenResult =
  | { ok: true; strategy: LegalOpenStrategy; url: string }
  | { ok: false; reason: LegalUrlRefusal | 'open_failed' | 'unavailable'; strategy: LegalOpenStrategy | null; copyUrl: string | null };

export interface OpenLegalLinkDeps {
  policy?: LegalLinkPolicy;
  platform?: NativePlatform | null;
  appLauncher?: AppLauncherPlugin | null;
  windowOpen?: (url: string) => boolean;
}

/** Adresse officielle à proposer à la copie (la demandée si elle est sûre, sinon le repli). */
function copyable(raw: unknown, fallbackUrl: string | null | undefined, policy: LegalLinkPolicy): string | null {
  const own = checkLegalUrl(raw, policy);
  if (own.ok) return own.url;
  const fb = checkLegalUrl(fallbackUrl, policy);
  return fb.ok ? fb.url : null;
}

/**
 * Ouvre un texte juridique selon le contexte. `fallbackUrl` : adresse
 * officielle de repli à copier si la destination est refusée (ex. page CGUV
 * du site public). Ne lève jamais.
 */
export async function openLegalLink(raw: unknown, opts: { fallbackUrl?: string | null } & OpenLegalLinkDeps = {}): Promise<LegalOpenResult> {
  const policy = opts.policy ?? currentLegalLinkPolicy();
  const check = checkLegalUrl(raw, policy);
  if (!check.ok) return { ok: false, reason: check.reason, strategy: null, copyUrl: copyable(null, opts.fallbackUrl, policy) };

  // Lot 108H : ouverture par la brique générique (navigateur système dans l'app).
  const r = await openExternalUrl(check.url, {
    platform: opts.platform, appLauncher: opts.appLauncher, appOrigin: policy.appOrigin, windowOpen: opts.windowOpen,
  });
  if (r.ok) return r;
  return { ok: false, reason: r.reason === 'invalid' ? 'open_failed' : r.reason, strategy: r.strategy, copyUrl: r.url ?? check.url };
}

/** Message d'un échec (pur, testé). */
export function legalOpenFailureMessage(r: Extract<LegalOpenResult, { ok: false }>): string {
  switch (r.reason) {
    case 'open_failed':
    case 'unavailable':
      return 'Le navigateur du téléphone n’a pas pu être ouvert. Copiez le lien officiel ci-dessous et collez-le dans votre navigateur.';
    default:
      return 'Ce lien n’est pas une adresse officielle des textes juridiques de Verebona : il n’a pas été ouvert.'
        + (r.copyUrl ? ' Vous pouvez copier l’adresse officielle ci-dessous.' : '');
  }
}

/** Copie dans le presse-papiers (geste de l'utilisateur requis). */
export async function copyLegalUrl(url: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return true;
    }
  } catch { /* repli ci-dessous */ }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
