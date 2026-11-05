/**
 * Lot 111O — P0 « inscription bloquée : CGUV en cours de publication ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DIAGNOSTIC DE LA CHAÎNE « SITE PUBLIC → MANIFESTE → RÉFÉRENTIEL → INSCRIPTION »
 *
 * L'inscription n'est possible que si la version EN VIGUEUR de l'application
 * a son texte VÉRIFIÉ sur le site public de l'environnement (lot 108L,
 * `assertCguvAcceptable`). Quand ce n'est pas le cas, le formulaire est
 * bloqué — à bon droit — mais il faut dire POURQUOI à l'exploitation :
 *
 *   · quelle adresse de manifeste est réellement lue (et d'où vient-elle :
 *     `LEGAL_CGUV_MANIFEST_URL`, `NEXT_PUBLIC_PUBLIC_SITE_URL`, défaut
 *     PRODUCTION) ;
 *   · le résultat de la dernière lecture (statut HTTP, motif stable
 *     `MANIFEST_*`, versions publiées, version désignée par le site) ;
 *   · la version en vigueur de l'application et la vérification de son texte ;
 *   · l'âge des caches.
 *
 * Ce module n'assouplit AUCUNE règle juridique : il lit, diagnostique et,
 * au plus, relance la MÊME synchronisation que la tâche planifiée.
 *
 * Reprise automatique (`refreshCguvIfBlocked`) : tant que l'inscription est
 * bloquée, l'ouverture d'un formulaire d'inscription relance la lecture du
 * manifeste — au plus une fois par intervalle (par instance ET d'après la
 * dernière tentative en base), attente bornée — pour qu'une publication
 * corrigée soit prise en compte sans attendre la tâche horaire ni vider le
 * navigateur.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { CGUV_MANIFEST_PATH } from '@/lib/legal/public-legal';
import {
  MANIFEST_FAILURE_LABELS, allowedLegalOrigins, manifestUrl, publicSiteBase, type FetchLike, type ManifestFailureReason,
} from './cguv-manifest';
import type { ManifestLastRead, ManifestSyncState, ReferentialAnomaly, SyncResult } from './cguv-referential.service';

type Env = Record<string, string | undefined>;

/** Réglages centralisés de la relecture à la demande (surcharge par variable). */
export const CGUV_ON_DEMAND_DEFAULTS = Object.freeze({
  /** Intervalle minimal entre deux relectures déclenchées par un formulaire bloqué. */
  minIntervalMs: 60_000,
  /** Attente maximale de la relecture par la requête qui la déclenche. */
  waitMs: 4_000,
});

/** Variables lues par la chaîne juridique (affichées par NOM ; leurs valeurs sont des URL publiques). */
export const CGUV_CHAIN_VARIABLES = Object.freeze([
  'NEXT_PUBLIC_PUBLIC_SITE_URL',
  'LEGAL_CGUV_MANIFEST_URL',
  'LEGAL_PUBLIC_EXTRA_ORIGINS',
  'LEGAL_PUBLIC_V2',
  'NEXT_PUBLIC_LEGAL_PUBLIC_V2',
  'NEXT_PUBLIC_APP_ENV',
] as const);

const PRODUCTION_HOSTS = new Set(['www.verebona.fr', 'verebona.fr']);

export type ManifestUrlSource = 'LEGAL_CGUV_MANIFEST_URL' | 'NEXT_PUBLIC_PUBLIC_SITE_URL' | 'default_production';

export interface CguvChainConfig {
  manifestUrl: string;
  manifestUrlSource: ManifestUrlSource;
  siteBase: string;
  siteBaseFromDefault: boolean;
  allowedOrigins: string[];
  environment: string | null;
  variables: Array<{ name: string; set: boolean; value: string | null }>;
}

function trimmed(v: string | undefined): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Pur : configuration EFFECTIVE de la chaîne (ce que le serveur lit vraiment). */
export function cguvChainConfig(env: Env = process.env): CguvChainConfig {
  const override = trimmed(env.LEGAL_CGUV_MANIFEST_URL);
  const site = trimmed(env.NEXT_PUBLIC_PUBLIC_SITE_URL);
  return {
    manifestUrl: manifestUrl(env),
    manifestUrlSource: override ? 'LEGAL_CGUV_MANIFEST_URL' : site ? 'NEXT_PUBLIC_PUBLIC_SITE_URL' : 'default_production',
    siteBase: publicSiteBase(env),
    siteBaseFromDefault: !site,
    allowedOrigins: allowedLegalOrigins(env),
    environment: trimmed(env.NEXT_PUBLIC_APP_ENV)?.toLowerCase() ?? null,
    variables: CGUV_CHAIN_VARIABLES.map((name) => {
      const v = trimmed(env[name]);
      return { name, set: v !== null, value: v ? v.slice(0, 300) : null };
    }),
  };
}

export type CguvDiagnosisCode =
  | 'SIGNUP_OPEN'
  | 'NEVER_READ'
  | ManifestFailureReason
  | 'EXPECTED_VERSION_REFUSED'
  | 'EXPECTED_VERSION_NOT_CURRENT'
  | 'CURRENT_TEXT_NOT_VERIFIED'
  | 'NO_CURRENT_VERSION';

export interface CguvDiagnosis {
  code: CguvDiagnosisCode;
  tone: 'ok' | 'warn' | 'error';
  title: string;
  detail: string;
  action: string;
}

export interface DiagnoseInput {
  config: CguvChainConfig;
  lastRead: ManifestLastRead | null;
  state: Pick<ManifestSyncState, 'lastStatus' | 'lastError' | 'anomalies' | 'manifestUrl'>;
  app: { currentVersionCode: string | null; publicText: 'VERIFIED' | 'NOT_ON_PUBLIC_SITE' | null };
}

const RELIRE = 'puis BO › Exploitation › Santé › « CGUV publiées » › « Relire maintenant » (ou BO › CGUV › « Relire le manifeste »)';

function isNonProduction(env: string | null): boolean {
  return env !== null && env !== 'production';
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}

/** Pur : le diagnostic, du plus précis au plus général. */
export function diagnoseCguvPublication(input: DiagnoseInput): CguvDiagnosis {
  const { config, lastRead, state, app } = input;
  const url = lastRead?.url ?? state.manifestUrl ?? config.manifestUrl;
  const readsProduction = PRODUCTION_HOSTS.has(hostOf(url) ?? '');
  const prodHint = isNonProduction(config.environment) && (readsProduction || config.manifestUrlSource === 'default_production')
    ? ` Attention : l'application « ${config.environment} » lit le site de PRODUCTION (${config.manifestUrlSource === 'default_production' ? 'NEXT_PUBLIC_PUBLIC_SITE_URL absente' : 'adresse de production configurée'}).`
    : '';

  if (app.currentVersionCode && app.publicText === 'VERIFIED') {
    return {
      code: 'SIGNUP_OPEN', tone: 'ok',
      title: `Inscriptions ouvertes — CGUV ${app.currentVersionCode} vérifiées sur le site public`,
      detail: lastRead?.manifestCurrent && lastRead.manifestCurrent !== app.currentVersionCode
        ? `Le site désigne ${lastRead.manifestCurrent} comme version en vigueur ; l'application présente ${app.currentVersionCode} (texte vérifié).`
        : `La version présentée à l'inscription est consultable sur ${config.siteBase}.`,
      action: 'Aucune action.',
    };
  }

  if (state.lastStatus === 'never' && !lastRead) {
    return {
      code: 'NEVER_READ', tone: 'error',
      title: 'Manifeste des CGUV jamais lu par cette application',
      detail: `Adresse qui sera lue : ${config.manifestUrl}.${prodHint}`,
      action: `Lancer une lecture : ${RELIRE}.`,
    };
  }

  const reason = lastRead?.reason ?? null;
  if (reason) {
    const http = lastRead?.httpStatus != null ? `HTTP ${lastRead.httpStatus}` : 'aucune réponse HTTP';
    const base: Omit<CguvDiagnosis, 'title' | 'action'> = {
      code: reason, tone: 'error',
      detail: `Lecture de ${url} : ${http} — ${MANIFEST_FAILURE_LABELS[reason]}${lastRead?.error ? ` (${lastRead.error.slice(0, 240)})` : ''}.${prodHint}`,
    };
    switch (reason) {
      case 'MANIFEST_ORIGIN_MISMATCH': {
        const foreign = lastRead?.foreignOrigins.join(', ') || 'une autre origine';
        return {
          ...base,
          title: 'Le manifeste a été construit pour un autre site',
          detail: `Le manifeste servi par ${url} (${http}, versions ${lastRead?.versions.join(', ') || '—'}) annonce ses permaliens et textes sur ${foreign}, alors que le site public de cet environnement est ${config.siteBase}. Les liens d'un manifeste doivent désigner le site qui le sert : il est refusé en bloc.${prodHint}`,
          action: `Si ${config.siteBase} est la bonne adresse : reconstruire et redéployer le site public avec VITE_PUBLIC_SITE_URL=${config.siteBase} (variable du SITE, lue au build), ${RELIRE}. Si l'application devait lire ${foreign} : corriger NEXT_PUBLIC_PUBLIC_SITE_URL de l'application et redémarrer.`,
        };
      }
      case 'MANIFEST_HTTP_UNAUTHORIZED':
        return {
          ...base, title: 'Le site public demande un mot de passe pour le manifeste',
          action: `Le site public doit servir ${CGUV_MANIFEST_PATH} et /legal/cguv/versions/<code>.html SANS authentification (exemption de server.cjs, livrée avec la publication légale). Vérifier la version du site déployée et BASIC_AUTH_*, ${RELIRE}.`,
        };
      case 'MANIFEST_HTTP_NOT_FOUND':
        return {
          ...base, title: 'Aucun manifeste à l’adresse lue',
          action: `Vérifier que le site public de cet environnement est livré à ${config.siteBase} (ouvrir ${url}). Si l'adresse est fausse : corriger NEXT_PUBLIC_PUBLIC_SITE_URL (ou LEGAL_CGUV_MANIFEST_URL) de l'application et redémarrer, ${RELIRE}.`,
        };
      case 'MANIFEST_REDIRECT_FOREIGN':
      case 'MANIFEST_REDIRECT_LOOP':
        return {
          ...base, title: 'L’adresse du manifeste redirige ailleurs',
          detail: `${base.detail}${lastRead?.location ? ` Destination : ${lastRead.location}.` : ''}`,
          action: `Renseigner l'adresse FINALE du site public de cet environnement dans NEXT_PUBLIC_PUBLIC_SITE_URL (sans redirection ; vérifier CANONICAL_HOST du site), redémarrer, ${RELIRE}.`,
        };
      case 'MANIFEST_NOT_JSON':
        return {
          ...base, title: 'Une page HTML a été servie à la place du manifeste',
          action: `Le site déployé à cette adresse ne publie pas encore le manifeste (version antérieure à la publication légale) ou l'adresse est fausse. Déployer le site public à jour, ${RELIRE}.`,
        };
      case 'MANIFEST_TIMEOUT':
      case 'MANIFEST_NETWORK':
        return {
          ...base, title: 'Site public injoignable depuis l’application',
          action: `Vérifier que ${hostOf(url) ?? url} répond (nom de domaine, certificat, conteneur du site), ${RELIRE}.`,
        };
      default:
        return { ...base, title: 'Manifeste des CGUV refusé', action: `Corriger la publication côté site public, ${RELIRE}.` };
    }
  }

  // Lecture réussie mais la version désignée par le site n'est pas en vigueur et vérifiée ici.
  const expected = lastRead?.manifestCurrent ?? null;
  if (expected && expected !== app.currentVersionCode) {
    const anomaly = (state.anomalies ?? []).find((a: ReferentialAnomaly) => a.code === expected && a.kind !== 'CURRENT_NOT_VERIFIED')
      ?? (state.anomalies ?? []).find((a: ReferentialAnomaly) => a.code === expected);
    if (lastRead?.refused.includes(expected) || anomaly) {
      return {
        code: 'EXPECTED_VERSION_REFUSED', tone: 'error',
        title: `Version ${expected} publiée par le site mais refusée (texte non vérifié)`,
        detail: `${anomaly ? `${anomaly.kind} : ${anomaly.detail}` : 'Texte figé non vérifié.'} Version présentée par l'application : ${app.currentVersionCode ?? 'aucune'} (texte non vérifié sur le site public).${prodHint}`,
        action: `Le texte figé de ${expected} doit être servi octet pour octet, sans redirection ni mot de passe, à l'adresse textUrl du manifeste, avec l'empreinte annoncée. Corriger côté site, ${RELIRE}.`,
      };
    }
    return {
      code: 'EXPECTED_VERSION_NOT_CURRENT', tone: 'error',
      title: `Le site désigne ${expected} ; l’application présente ${app.currentVersionCode ?? 'aucune version'}`,
      detail: `Dernière lecture réussie (${lastRead?.at ?? '—'}), mais la version désignée n'a pas été activée.${prodHint}`,
      action: `Consulter BO › CGUV (écarts de la dernière lecture), ${RELIRE}.`,
    };
  }

  if (!app.currentVersionCode) {
    return {
      code: 'NO_CURRENT_VERSION', tone: 'error',
      title: 'Aucune version des CGUV en vigueur dans l’application',
      detail: `Dernière lecture : ${state.lastStatus}.${prodHint}`,
      action: `Vérifier le manifeste du site public, ${RELIRE}.`,
    };
  }

  return {
    code: 'CURRENT_TEXT_NOT_VERIFIED', tone: 'error',
    title: `CGUV ${app.currentVersionCode} sans texte vérifié sur le site public`,
    detail: `La version en vigueur n'est pas (ou plus) consultable sur ${config.siteBase}${state.lastError ? ` — dernière erreur : ${state.lastError.slice(0, 200)}` : ''}.${prodHint}`,
    action: `Publier le texte de cette version sur le site public (ou une nouvelle version), ${RELIRE}.`,
  };
}

export interface CguvPublicationReport {
  checkedAt: string;
  config: CguvChainConfig;
  state: ManifestSyncState;
  lastRead: ManifestLastRead | null;
  app: {
    currentVersionCode: string | null;
    source: string | null;
    publicText: 'VERIFIED' | 'NOT_ON_PUBLIC_SITE' | null;
    sha256: string | null;
    effectiveAt: string | null;
    consultationUrl: string | null;
  };
  /** Version désignée « en vigueur » par le site lors de la dernière lecture qui l'a lue. */
  expectedVersionCode: string | null;
  signupOpen: boolean;
  cache: {
    /** Âge de la dernière lecture réussie (le référentiel en base EST le cache du manifeste). */
    lastSuccessAgeMs: number | null;
    lastAttemptAgeMs: number | null;
    /** Cache du mode des liens sur l'instance qui répond (null : vide). */
    linksModeCacheAgeMs: number | null;
    linksModeCacheTtlMs: number;
    linksMode: string;
    /** La version en vigueur n'est jamais mise en cache (relue en base à chaque requête). */
    currentVersionCached: false;
  };
  diagnosis: CguvDiagnosis;
  /** Résultat de la relecture si le rapport suit un « Relire maintenant ». */
  resync?: SyncResult;
}

const ageMs = (d: Date | null, now: number) => (d ? Math.max(0, now - d.getTime()) : null);

/** Rapport complet de la carte BO « CGUV publiées ». Lit la base ; ne lève qu'en cas d'erreur de base. */
export async function getCguvPublicationReport(env: Env = process.env): Promise<CguvPublicationReport> {
  const svc = await import('./cguv-referential.service');
  const [state, current, mode] = await Promise.all([svc.getManifestSyncState(), svc.getPublicCurrentCguv(), svc.getLegalLinksMode(env)]);
  const config = cguvChainConfig(env);
  const now = Date.now();
  const app = {
    currentVersionCode: current?.versionCode ?? null,
    source: current?.source ?? null,
    publicText: current?.publicText ?? null,
    sha256: current?.sha256 ?? null,
    effectiveAt: current?.effectiveAt ? new Date(current.effectiveAt).toISOString() : null,
    consultationUrl: current?.permalinkUrl ?? null,
  };
  const lastRead = state.lastRead;
  return {
    checkedAt: new Date(now).toISOString(),
    config,
    state,
    lastRead,
    app,
    expectedVersionCode: lastRead?.manifestCurrent ?? null,
    signupOpen: !!current && current.publicText === 'VERIFIED',
    cache: {
      lastSuccessAgeMs: ageMs(state.lastSuccessAt, now),
      lastAttemptAgeMs: ageMs(state.lastAttemptAt, now),
      linksModeCacheAgeMs: svc.legalModeCacheAgeMs(now),
      linksModeCacheTtlMs: svc.LEGAL_MODE_CACHE_MS,
      linksMode: mode,
      currentVersionCached: false,
    },
    diagnosis: diagnoseCguvPublication({ config, lastRead, state, app }),
  };
}

/**
 * « Relire maintenant » (BO) : invalide les caches juridiques de l'instance,
 * relit le manifeste (même fonction que la tâche planifiée), renvoie le
 * rapport à jour.
 */
export async function resyncCguvNow(actorUserId: number | null, opts: { fetchImpl?: FetchLike; env?: Env } = {}): Promise<CguvPublicationReport> {
  const svc = await import('./cguv-referential.service');
  await svc.invalidateLegalCaches();
  const resync = await svc.syncCguvManifest({ trigger: 'bo', actorUserId, fetchImpl: opts.fetchImpl, env: opts.env });
  await svc.invalidateLegalCaches();
  return { ...(await getCguvPublicationReport(opts.env)), resync };
}

/* ── Relecture à la demande (formulaire d'inscription bloqué) ───────────── */

let inflight: Promise<SyncResult | null> | null = null;
let lastOnDemandAt = 0;

/** Tests uniquement. */
export function resetCguvOnDemandForTests(): void {
  inflight = null;
  lastOnDemandAt = 0;
}

function numberEnv(env: Env, name: string, fallback: number, max: number): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : fallback;
}

export type OnDemandOutcome = 'not_blocked' | 'throttled' | 'refreshed' | 'pending';

/**
 * Inscription bloquée ? Relance UNE lecture du manifeste (single-flight par
 * instance ; au plus une par intervalle, d'après la dernière tentative EN BASE
 * pour ne pas multiplier les lectures entre conteneurs) et l'attend au plus
 * `waitMs`. Ne lève jamais ; ne change aucune règle : seule une lecture
 * réussie ET vérifiée débloque l'inscription.
 */
export async function refreshCguvIfBlocked(opts: { fetchImpl?: FetchLike; env?: Env; now?: number } = {}): Promise<OnDemandOutcome> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  try {
    const svc = await import('./cguv-referential.service');
    const current = await svc.getPublicCurrentCguv();
    if (current && current.publicText === 'VERIFIED') return 'not_blocked';
    const minInterval = numberEnv(env, 'LEGAL_MANIFEST_ON_DEMAND_INTERVAL_MS', CGUV_ON_DEMAND_DEFAULTS.minIntervalMs, 3_600_000);
    const waitMs = numberEnv(env, 'LEGAL_MANIFEST_ON_DEMAND_WAIT_MS', CGUV_ON_DEMAND_DEFAULTS.waitMs, 20_000);
    if (!inflight) {
      const state = await svc.getManifestSyncState();
      const lastAttempt = Math.max(lastOnDemandAt, state.lastAttemptAt?.getTime() ?? 0);
      if (now - lastAttempt < minInterval) return 'throttled';
      lastOnDemandAt = now;
      inflight = svc.syncCguvManifest({ trigger: 'on_demand', fetchImpl: opts.fetchImpl, env })
        .catch((e) => { console.error('[legal] relecture à la demande impossible :', (e as Error).message); return null; })
        .finally(() => { inflight = null; });
    }
    const running = inflight;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = await Promise.race([
      running.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), waitMs); }),
    ]);
    if (timer) clearTimeout(timer);
    return done ? 'refreshed' : 'pending';
  } catch (e) {
    console.error('[legal] relecture à la demande impossible :', (e as Error).message);
    return 'throttled';
  }
}
