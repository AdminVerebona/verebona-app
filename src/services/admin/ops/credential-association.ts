/**
 * BO › Exploitation › Application mobile — contrôle « Association iOS /
 * Android » (lot 111E, remplissage automatique des mots de passe).
 *
 * Pour que l'iPhone propose les identifiants Verebona (Apple Mots de passe,
 * Dashlane, 1Password, Bitwarden…) dans l'app, il faut que :
 *   1. le binaire signé déclare `webcredentials:<hôte>` (entitlements — vérifié
 *      au build par le workflow iOS) ;
 *   2. https://<hôte>/.well-known/apple-app-site-association réponde 200, sans
 *      redirection, en JSON valide, avec `webcredentials.apps` contenant
 *      « <Team ID>.<bundle ID> » EXACT du binaire ;
 *   3. le CDN d'Apple ait récupéré ce fichier (iOS ne lit pas le serveur
 *      directement, sauf mode développeur).
 * Côté Android, `/.well-known/assetlinks.json` (relation
 * `delegate_permission/common.get_login_creds`, paquet et empreinte exacts)
 * permet au gestionnaire Google de relier l'app au site.
 *
 * Ce contrôle relit les VARIABLES (noms manquants, valeurs invalides —
 * jamais une valeur secrète : identifiants d'app et nombre d'empreintes, qui
 * sont publics dans les fichiers eux-mêmes), puis interroge réellement les
 * deux adresses publiques de l'environnement et la copie du CDN Apple.
 * LECTURE SEULE. Une réponse correcte ne prouve PAS le remplissage sur
 * l'appareil (recette R1–R8, docs/exploitation/recette-111e-autofill.md).
 */
import { appLinksStatus } from '@/lib/mobile/app-links';

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Identifiant d'app attendu par environnement serveur — mêmes valeurs que
 * `appId` de `mobile/config/environments.mjs` (contrôlé par le test
 * l111e-association-bo.test.ts).
 */
export const EXPECTED_APP_IDS: Readonly<Record<'preprod' | 'production', string>> = {
  preprod: 'fr.verebona.app.preprod',
  production: 'fr.verebona.app',
};

const IOS_VARS = ['MOBILE_IOS_TEAM_ID', 'MOBILE_IOS_BUNDLE_IDS'] as const;
const ANDROID_VARS = ['MOBILE_ANDROID_PACKAGE', 'MOBILE_ANDROID_SHA256_FINGERPRINTS'] as const;
const ORIGIN_VARS = ['APP_URL', 'NEXT_PUBLIC_APP_URL'] as const;
const TIMEOUT_MS = 5000;

export type Verdict = 'ok' | 'ko' | 'non-configure';

export interface ServedFile {
  url: string;
  status: number | null;
  redirected: boolean;
  contentType: string | null;
  jsonValid: boolean;
  /** Le fichier servi contient-il l'élément attendu (webcredentials / get_login_creds) pour les identités configurées ? */
  matches: boolean;
  error: string | null;
}

export interface PlatformAssociation {
  verdict: Verdict;
  /** Phrase lisible par le PO. */
  summary: string;
  /** NOMS de variables absentes. */
  missingVariables: string[];
  /** Valeurs présentes mais invalides (nom + motif). */
  issues: string[];
  /** Identités déclarées (publiques : elles figurent dans le fichier servi). */
  identities: string[];
  /** L'identifiant d'app de CET environnement figure-t-il parmi les identités ? null si inconnu (local). */
  expectedAppPresent: boolean | null;
  served: ServedFile | null;
}

export interface CredentialAssociationReport {
  environment: string;
  origin: string | null;
  host: string | null;
  expectedAppId: string | null;
  missingOriginVariables: string[];
  ios: PlatformAssociation & { appleCdn: ServedFile | null; appleCdnUrl: string | null };
  android: PlatformAssociation & { fingerprintCount: number };
  checkedAt: string;
}

function envName(env: Env): string {
  const v = (env.NEXT_PUBLIC_APP_ENV ?? '').trim().toLowerCase();
  return v === 'production' || v === 'prod' ? 'production' : v === 'preprod' ? 'preprod' : (v || 'local');
}

function originOf(env: Env): string | null {
  for (const k of ORIGIN_VARS) {
    const raw = env[k]?.trim();
    if (!raw) continue;
    try { return new URL(raw).origin; } catch { /* valeur invalide : variable suivante */ }
  }
  return null;
}

const missing = (env: Env, names: readonly string[]) => names.filter((n) => !(env[n] ?? '').trim());

async function fetchJson(url: string, fetchImpl: FetchLike): Promise<{ file: Omit<ServedFile, 'matches'>; body: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { redirect: 'manual', cache: 'no-store', signal: ctrl.signal, headers: { accept: 'application/json' } });
    const redirected = res.status >= 300 && res.status < 400;
    const contentType = res.headers.get('content-type');
    let body: unknown = null;
    let jsonValid = false;
    if (res.status === 200) {
      try { body = JSON.parse(await res.text()); jsonValid = true; } catch { jsonValid = false; }
    }
    return { file: { url, status: res.status, redirected, contentType, jsonValid, error: null }, body };
  } catch (e) {
    const aborted = (e as Error)?.name === 'AbortError';
    return { file: { url, status: null, redirected: false, contentType: null, jsonValid: false, error: aborted ? 'délai dépassé' : 'adresse injoignable depuis le serveur' }, body: null };
  } finally {
    clearTimeout(timer);
  }
}

function aasaMatches(body: unknown, appIds: string[]): boolean {
  const apps = (body as { webcredentials?: { apps?: unknown } } | null)?.webcredentials?.apps;
  return Array.isArray(apps) && appIds.length > 0 && appIds.every((id) => apps.includes(id));
}

function assetLinksMatches(body: unknown, pkg: string | null): boolean {
  if (!Array.isArray(body) || !pkg) return false;
  return body.some((s) => {
    const st = s as { relation?: unknown; target?: { namespace?: unknown; package_name?: unknown; sha256_cert_fingerprints?: unknown } };
    return Array.isArray(st.relation) && st.relation.includes('delegate_permission/common.get_login_creds')
      && st.target?.namespace === 'android_app' && st.target.package_name === pkg
      && Array.isArray(st.target.sha256_cert_fingerprints) && st.target.sha256_cert_fingerprints.length > 0;
  });
}

function servedProblem(f: ServedFile | null, what: string): string | null {
  if (!f) return null;
  if (f.error) return `${what} : ${f.error}`;
  if (f.redirected) return `${what} : redirection (HTTP ${f.status}) — doit répondre directement`;
  if (f.status !== 200) return `${what} : HTTP ${f.status}`;
  if (!f.jsonValid) return `${what} : JSON invalide`;
  if (f.contentType && !/application\/json/i.test(f.contentType)) return `${what} : type ${f.contentType} (attendu application/json)`;
  if (!f.matches) return `${what} : identités servies différentes de la configuration`;
  return null;
}

/**
 * Contrôle complet (variables + fichiers servis + copie Apple). `fetchImpl`
 * injectable pour les tests ; aucune valeur de variable n'est journalisée.
 */
export async function checkCredentialAssociation(env: Env = process.env, fetchImpl: FetchLike = fetch): Promise<CredentialAssociationReport> {
  const environment = envName(env);
  const origin = originOf(env);
  const host = origin ? new URL(origin).host : null;
  const expectedAppId = environment === 'preprod' || environment === 'production' ? EXPECTED_APP_IDS[environment] : null;
  const st = appLinksStatus(env);
  const live = !!origin && /^https:/.test(origin);

  // ── iOS ───────────────────────────────────────────────────────────────
  const iosMissing = missing(env, IOS_VARS);
  const iosIds = st.ios.appIds;
  const iosExpected = expectedAppId ? iosIds.some((id) => id.endsWith(`.${expectedAppId}`)) : null;
  let iosServed: ServedFile | null = null;
  let appleCdn: ServedFile | null = null;
  const appleCdnUrl = host ? `https://app-site-association.cdn-apple.com/a/v1/${host}` : null;
  if (live) {
    const r = await fetchJson(`${origin}/.well-known/apple-app-site-association`, fetchImpl);
    iosServed = { ...r.file, matches: aasaMatches(r.body, iosIds) };
    if (appleCdnUrl) {
      const c = await fetchJson(appleCdnUrl, fetchImpl);
      appleCdn = { ...c.file, matches: aasaMatches(c.body, iosIds) };
    }
  }
  const iosProblems = [
    ...(iosExpected === false ? [`identifiant ${expectedAppId} de cet environnement absent de MOBILE_IOS_BUNDLE_IDS`] : []),
    ...[servedProblem(iosServed, 'fichier servi')].filter((x): x is string => !!x),
  ];
  const iosVerdict: Verdict = !st.ios.configured ? 'non-configure' : iosProblems.length || st.ios.issues.length ? 'ko' : 'ok';
  const iosSummary = iosVerdict === 'non-configure'
    ? `Non configuré : /.well-known/apple-app-site-association répond 404, iOS ne peut pas relier l’app à ${host ?? 'ce domaine'}.`
    : iosVerdict === 'ok'
      ? (iosServed
        ? `Servi correctement (HTTP 200, JSON, webcredentials.apps = ${iosIds.join(', ')}).${appleCdn && servedProblem(appleCdn, 'copie Apple') ? ' Copie du CDN Apple pas encore à jour : voir ci-dessous.' : ''}`
        : `Variables valides (${iosIds.join(', ')}) ; fichier non vérifiable ici (adresse publique https inconnue).`)
      : `À corriger : ${[...st.ios.issues, ...iosProblems].join(' ; ')}.`;

  // ── Android ───────────────────────────────────────────────────────────
  const andMissing = missing(env, ANDROID_VARS);
  const pkg = st.android.packageName;
  const andExpected = expectedAppId && pkg ? pkg === expectedAppId : (expectedAppId ? false : null);
  let andServed: ServedFile | null = null;
  if (live) {
    const r = await fetchJson(`${origin}/.well-known/assetlinks.json`, fetchImpl);
    andServed = { ...r.file, matches: assetLinksMatches(r.body, pkg) };
  }
  const andProblems = [
    ...(st.android.configured && andExpected === false ? [`paquet attendu pour cet environnement : ${expectedAppId}`] : []),
    ...[servedProblem(andServed, 'fichier servi')].filter((x): x is string => !!x),
  ];
  const andVerdict: Verdict = !st.android.configured ? 'non-configure' : andProblems.length || st.android.issues.length ? 'ko' : 'ok';
  const andSummary = andVerdict === 'non-configure'
    ? 'Non configuré : /.well-known/assetlinks.json répond 404 (le remplissage par domaine dans la vue reste possible, sans lien app ↔ site).'
    : andVerdict === 'ok'
      ? (andServed
        ? `Servi correctement (HTTP 200, JSON, get_login_creds pour ${pkg}, ${st.android.fingerprintCount} empreinte(s)).`
        : `Variables valides (${pkg}) ; fichier non vérifiable ici (adresse publique https inconnue).`)
      : `À corriger : ${[...st.android.issues, ...andProblems].join(' ; ')}.`;

  return {
    environment,
    origin,
    host,
    expectedAppId,
    missingOriginVariables: origin ? [] : [...ORIGIN_VARS],
    ios: {
      verdict: iosVerdict, summary: iosSummary, missingVariables: iosMissing, issues: st.ios.issues,
      identities: iosIds, expectedAppPresent: iosExpected, served: iosServed, appleCdn, appleCdnUrl,
    },
    android: {
      verdict: andVerdict, summary: andSummary, missingVariables: andMissing, issues: st.android.issues,
      identities: pkg ? [pkg] : [], expectedAppPresent: andExpected, served: andServed, fingerprintCount: st.android.fingerprintCount,
    },
    checkedAt: new Date().toISOString(),
  };
}
