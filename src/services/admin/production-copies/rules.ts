/**
 * Copies de données réelles (production) hors production — règles PURES.
 * Lot 102C (ticket conformité légale, P1 « Garantir suppression/expiration
 * des copies de production en préproduction »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INVENTAIRE DES MÉCANISMES (code au tag lot101sept) — voir
 * docs/exploitation/copies-donnees-reelles-preproduction.md :
 *
 *   · points de restauration (lot 82E, BO › Exploitation › Sauvegardes et
 *     recette, rattrapage `database-restore-point`) : SEUL mécanisme de
 *     l'application capable d'injecter des données d'un autre environnement
 *     (un point déposé dans le bucket depuis la production). → GARDÉ ici :
 *     refus par défaut si le point vient d'un autre environnement ;
 *   · copie de base hors application (pg_dump / restauration d'un addon
 *     Scalingo de production vers la préproduction) : non empêchable par le
 *     code → DÉTECTÉE au démarrage (`environment_identity` porte le nom de
 *     l'environnement qui a initialisé la base), tracée, expirée ;
 *   · imports BO : seuls des imports de CONFIGURATION IA existent (sans
 *     donnée personnelle) ; aucun import de compte ;
 *   · compte corpus / qualification IA : jeux de données SYNTHÉTIQUES
 *     (fixtures) et rejeu de documents DE LA PRÉPRODUCTION ;
 *   · exports BO (diagnostic global, export de recette, exports de compte) :
 *     sortants, jamais réimportés par l'application.
 *
 * Ce module ne lit aucune base : environnement, origine d'un point,
 * expiration et décision d'autorisation.
 * ══════════════════════════════════════════════════════════════════════════
 */

type Env = Record<string, string | undefined>;

/** Noms d'environnement considérés comme PRODUCTION (liste paramétrable). */
export function productionEnvironmentNames(env: Env = process.env): string[] {
  const raw = (env.PRODUCTION_ENVIRONMENT_NAMES ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return raw.length ? raw : ['production', 'prod', 'live'];
}

/** Nom normalisé de l'environnement courant (`NEXT_PUBLIC_APP_ENV`), ou null s'il est inconnu. */
export function currentEnvironmentName(env: Env = process.env): string | null {
  const v = (env.NEXT_PUBLIC_APP_ENV ?? '').trim().toLowerCase();
  return v && v !== 'unknown' ? v : null;
}

export function isProductionEnvironment(name: string | null | undefined, env: Env = process.env): boolean {
  return !!name && productionEnvironmentNames(env).includes(name.trim().toLowerCase());
}

/** Durée de vie d'une copie de données réelles (jours, défaut 30, bornée 1..90). */
export function copyRetentionDays(env: Env = process.env): number {
  const n = Number(env.PRODUCTION_COPY_RETENTION_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= 90 ? n : 30;
}

/** Durée de validité d'une AUTORISATION d'import non utilisée (heures, défaut 24). */
export function authorizationValidityHours(env: Env = process.env): number {
  const n = Number(env.PRODUCTION_COPY_AUTHORIZATION_HOURS);
  return Number.isInteger(n) && n >= 1 && n <= 168 ? n : 24;
}

export type RestoreOrigin = 'same_environment' | 'foreign_production' | 'foreign_other' | 'unknown_origin';

/**
 * Origine d'un point de restauration par rapport à l'environnement courant.
 * `unknown_origin` : manifeste sans environnement (`unknown`, vide) —
 * traité comme étranger (prudence) sauf si l'environnement courant est
 * lui-même inconnu (poste de développement).
 */
export function classifyRestoreOrigin(manifestEnvironment: string | null | undefined, env: Env = process.env): RestoreOrigin {
  const current = currentEnvironmentName(env);
  const source = (manifestEnvironment ?? '').trim().toLowerCase();
  if (!source || source === 'unknown') return current ? 'unknown_origin' : 'same_environment';
  if (current && source === current) return 'same_environment';
  if (!current) return 'same_environment';
  return isProductionEnvironment(source, env) ? 'foreign_production' : 'foreign_other';
}

export interface OpenAuthorization {
  id: number;
  backupId: string;
  authorizedAt: Date;
}

export type RestoreOriginDecision =
  | { allowed: true; origin: RestoreOrigin; copyId: number | null }
  | { allowed: false; origin: RestoreOrigin; reason: string };

/**
 * Décision de restauration au regard de l'origine du point :
 *   · même environnement → permis (mécanisme 82E inchangé) ;
 *   · environnement courant de PRODUCTION → permis (une production ne
 *     reçoit pas « une copie de la production ») ;
 *   · sinon → permis UNIQUEMENT avec une autorisation BO ouverte, encore
 *     valable, pour CE point ; la copie importée est alors tracée.
 */
export function decideRestoreOrigin(input: {
  manifestEnvironment: string | null | undefined;
  backupId: string;
  authorization: OpenAuthorization | null;
  now: Date;
  env?: Env;
}): RestoreOriginDecision {
  const env = input.env ?? process.env;
  const origin = classifyRestoreOrigin(input.manifestEnvironment, env);
  if (origin === 'same_environment') return { allowed: true, origin, copyId: null };
  if (isProductionEnvironment(currentEnvironmentName(env), env)) return { allowed: true, origin, copyId: null };
  const a = input.authorization;
  const validMs = authorizationValidityHours(env) * 3_600_000;
  if (!a || a.backupId !== input.backupId) {
    return {
      allowed: false, origin,
      reason: `Ce point de restauration provient d’un autre environnement (${(input.manifestEnvironment || 'inconnu').trim()}) : `
        + 'import de données réelles refusé par défaut. Un administrateur doit d’abord l’autoriser explicitement '
        + '(BO › Exploitation › Copies de données réelles, motif obligatoire, action journalisée).',
    };
  }
  if (input.now.getTime() - a.authorizedAt.getTime() > validMs) {
    return { allowed: false, origin, reason: `L’autorisation d’import de ce point a expiré (${authorizationValidityHours(env)} h) : renouvelez-la.` };
  }
  return { allowed: true, origin, copyId: a.id };
}

/** Détection au démarrage : base initialisée par un environnement de production, servie ailleurs. */
export function detectDatabaseCopy(input: { storedEnvironment: string | null; env?: Env }): { copy: boolean; source: string | null; target: string | null } {
  const env = input.env ?? process.env;
  const target = currentEnvironmentName(env);
  const source = (input.storedEnvironment ?? '').trim().toLowerCase() || null;
  const copy = !!source && !!target && source !== target && isProductionEnvironment(source, env) && !isProductionEnvironment(target, env);
  return { copy, source, target };
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}
