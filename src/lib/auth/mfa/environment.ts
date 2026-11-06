/**
 * Environnement applicatif et cohérence de la configuration MFA — lot 111W
 * (BO › Exploitation › Double authentification).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ENVIRONNEMENT APPLICATIF ≠ NODE_ENV
 *
 * Next.js déployé tourne TOUJOURS avec `NODE_ENV=production`, préproduction
 * comprise : c'est le mode d'exécution technique, pas l'environnement. Le BO
 * affichait `VEREBONA_ENV ?? NODE_ENV` — `VEREBONA_ENV` n'est qu'une variable
 * des builds MOBILES (GitHub, `mobile/config/environments.mjs`), absente du
 * serveur : d'où le repli « production » en préproduction.
 *
 * Le mécanisme existant de l'application est `NEXT_PUBLIC_APP_ENV` (mode
 * Stripe, versions de configuration IA — `services/ai/config/environment.ts`,
 * dont on réutilise la lecture et les synonymes). Absente ou illisible :
 * « Inconnu / configuration à vérifier », JAMAIS « production » par défaut.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * COHÉRENCE (lecture seule, aucun secret)
 *
 * Confronte l'environnement, l'origine applicative (`APP_URL`, puis
 * `NEXT_PUBLIC_APP_URL` — même ordre que `lib/app-url.ts`), le RP ID et les
 * origines WebAuthn. N'affiche que des NOMS de variables, des hôtes et des
 * origines (publics par nature : le navigateur les voit) — jamais une clé.
 * Ne modifie rien : les validations WebAuthn de `passkeys.ts` restent seules
 * juges à l'usage.
 */
import { parseEnvironment, type AiEnvironment } from '@/services/ai/config/environment';
import { webAuthnStatus } from './passkeys';
import { keyRingStatus } from './secret-box';

type Env = Record<string, string | undefined>;

export type AppEnvironmentKey = AiEnvironment;

export const APP_ENV_VARIABLE = 'NEXT_PUBLIC_APP_ENV';
export const UNKNOWN_ENVIRONMENT_LABEL = 'Inconnu / configuration à vérifier';

const ENV_LABELS: Readonly<Record<AppEnvironmentKey, string>> = {
  preprod: 'Préproduction',
  production: 'Production',
  local: 'Développement local',
};

/**
 * Hôte de PRÉPRODUCTION : un libellé preprod / pre-prod / preproduction /
 * staging / recette — même règle que `PREPROD_HOST` de
 * `mobile/config/environments.mjs` (garde des builds mobiles). Sert seulement
 * à SIGNALER une discordance probable, jamais à décider d'un comportement.
 */
export const PREPROD_HOST_RE = /(^|[.-])(preprod|pre-prod|preproduction|staging|recette)([.-]|$)/i;

export interface AppEnvironmentView {
  /** `null` = inconnu. */
  key: AppEnvironmentKey | null;
  label: string;
  variable: typeof APP_ENV_VARIABLE;
  /** Mode d'exécution technique Next.js (affiché séparément). */
  nodeEnv: string | null;
}

export function resolveAppEnvironment(env: Env = process.env): AppEnvironmentView {
  const key = parseEnvironment(env.NEXT_PUBLIC_APP_ENV);
  return {
    key,
    label: key ? ENV_LABELS[key] : UNKNOWN_ENVIRONMENT_LABEL,
    variable: APP_ENV_VARIABLE,
    nodeEnv: (env.NODE_ENV ?? '').trim() || null,
  };
}

export type CoherenceSeverity = 'error' | 'warning' | 'info';
export interface CoherenceIssue { code: string; severity: CoherenceSeverity; message: string }
export interface MfaCoherenceReport {
  verdict: 'ok' | 'warn' | 'ko';
  environment: AppEnvironmentView;
  appOrigin: { origin: string | null; variable: 'APP_URL' | 'NEXT_PUBLIC_APP_URL' | null };
  issues: CoherenceIssue[];
}

const ORIGIN_VARIABLES = ['APP_URL', 'NEXT_PUBLIC_APP_URL'] as const;

function appOriginOf(env: Env): { origin: string | null; variable: (typeof ORIGIN_VARIABLES)[number] | null; invalid: string[] } {
  const invalid: string[] = [];
  for (const name of ORIGIN_VARIABLES) {
    const raw = (env[name] ?? '').trim();
    if (!raw) continue;
    try {
      return { origin: new URL(raw).origin, variable: name, invalid };
    } catch {
      invalid.push(name);
    }
  }
  return { origin: null, variable: null, invalid };
}

const isLocalHostName = (h: string) => /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(h);

export function looksNonProductionHost(host: string): boolean {
  return PREPROD_HOST_RE.test(host) || isLocalHostName(host);
}

/** Contrôle de cohérence (pur : `env` injectable pour les tests). */
export function checkMfaCoherence(env: Env = process.env): MfaCoherenceReport {
  const environment = resolveAppEnvironment(env);
  const hosted = environment.key === 'preprod' || environment.key === 'production';
  const issues: CoherenceIssue[] = [];
  const add = (code: string, severity: CoherenceSeverity, message: string) => issues.push({ code, severity, message });

  if (!environment.key) {
    add('ENV_UNKNOWN', 'error', `${APP_ENV_VARIABLE} absente ou non reconnue : environnement applicatif inconnu (valeurs attendues : preprod, production, local).`);
  }
  const legacy = (env.VEREBONA_ENV ?? '').trim();
  if (legacy && parseEnvironment(legacy) !== environment.key) {
    add('VEREBONA_ENV_IGNORED', 'warning', `VEREBONA_ENV (variable des builds mobiles) n’est pas lue par le serveur : l’environnement vient de ${APP_ENV_VARIABLE}, et les deux diffèrent. À retirer de Scalingo ou aligner.`);
  }
  if (hosted && environment.nodeEnv !== 'production') {
    add('NODE_ENV_NOT_PRODUCTION', 'warning', 'Environnement hébergé avec NODE_ENV différent de « production » : des valeurs de développement (localhost, clé dérivée) peuvent s’appliquer.');
  }

  const app = appOriginOf(env);
  for (const name of app.invalid) add('APP_ORIGIN_INVALID', 'warning', `${name} n’est pas une adresse valide.`);
  let appHost: string | null = null;
  if (!app.origin) {
    add('APP_ORIGIN_MISSING', hosted ? 'error' : 'info', 'Origine applicative inconnue : APP_URL et NEXT_PUBLIC_APP_URL absentes ou invalides.');
  } else {
    const u = new URL(app.origin);
    appHost = u.hostname.toLowerCase();
    if (hosted && isLocalHostName(appHost)) add('APP_ORIGIN_LOCAL', 'error', `${app.variable} pointe sur ${appHost} dans un environnement hébergé.`);
    else if (hosted && u.protocol !== 'https:') add('APP_ORIGIN_NOT_HTTPS', 'error', `${app.variable} n’est pas en https.`);
    if (environment.key === 'production' && looksNonProductionHost(appHost)) {
      add('APP_ORIGIN_ENV_MISMATCH', 'error', `Production, mais l’origine applicative (${app.origin}) ressemble à un domaine hors production.`);
    }
  }

  const web = webAuthnStatus(env);
  if (!web.available || !web.rpID) {
    add('WEBAUTHN_NOT_CHECKED', hosted ? 'warning' : 'info', 'Contrôle RP ID / origines impossible tant que WEBAUTHN_RP_ID et WEBAUTHN_ORIGINS ne sont pas valides.');
  } else {
    const rp = web.rpID;
    if (appHost) {
      if (appHost !== rp && !appHost.endsWith(`.${rp}`)) {
        add('RP_ID_HOST_MISMATCH', 'error', `WEBAUTHN_RP_ID (${rp}) ne correspond pas à l’hôte de l’application (${appHost}) : aucune clé d’accès ne pourra être créée ni utilisée.`);
      } else if (appHost !== rp) {
        add('RP_ID_PARENT_DOMAIN', 'warning', `WEBAUTHN_RP_ID (${rp}) est un domaine parent de l’application (${appHost}) : les fichiers d’association iOS / Android devraient alors être publiés sur ${rp}. Conseillé : l’hôte de l’application.`);
      }
    }
    if (app.origin && !web.origins.includes(app.origin)) {
      add('APP_ORIGIN_NOT_ALLOWED', 'error', `L’origine applicative (${app.origin}) ne figure pas dans WEBAUTHN_ORIGINS.`);
    }
    const extra = web.origins.filter((o) => o !== app.origin && !o.startsWith('android:'));
    if (app.origin && extra.length) add('WEBAUTHN_EXTRA_ORIGINS', 'info', `Autres origines admises : ${extra.join(', ')}.`);
    if (hosted && isLocalHostName(rp)) {
      add('RP_ID_LOCAL', 'error', 'WEBAUTHN_RP_ID vaut localhost dans un environnement hébergé.');
    } else if (environment.key === 'production' && looksNonProductionHost(rp)) {
      add('RP_ID_ENV_MISMATCH', 'error', `Production, mais WEBAUTHN_RP_ID (${rp}) ressemble à un domaine hors production.`);
    } else if (environment.key === 'preprod' && !looksNonProductionHost(rp)) {
      add('RP_ID_ENV_TO_CHECK', 'warning', `Préproduction, mais WEBAUTHN_RP_ID (${rp}) ne ressemble pas à un domaine de préproduction : vérifiez qu’il n’est pas celui de la production.`);
    }
  }

  const keys = keyRingStatus(env);
  if (hosted && keys.problem === null && !keys.configured) {
    add('TOTP_DEV_KEY', 'error', 'Application d’authentification : clé de développement utilisée (MFA_ENCRYPTION_KEYS absente) dans un environnement hébergé.');
  }

  const verdict = issues.some((i) => i.severity === 'error') ? 'ko' : issues.some((i) => i.severity === 'warning') ? 'warn' : 'ok';
  return { verdict, environment, appOrigin: { origin: app.origin, variable: app.variable }, issues };
}
