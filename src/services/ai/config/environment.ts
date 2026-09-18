/**
 * Environnement applicatif — CDC BO IA GEN-003.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI PAS L'URL DE LA REQUÊTE
 *
 * La question s'est posée, et la réponse tient en deux points.
 *
 * D'abord, derrière le proxy de l'hébergeur, `request.url` vaut
 * `http://localhost:26057/...` — c'est ce que documente déjà `lib/app-url.ts`,
 * après que des retours Stripe eurent renvoyé les clients vers une adresse
 * interne au conteneur.
 *
 * Ensuite et surtout, le versioning doit connaître l'environnement HORS de
 * toute requête : le contrôle de démarrage d'`instrumentation.ts`, les tâches
 * planifiées, la reprise d'analyse n'ont pas d'URL. Or c'est précisément au
 * démarrage qu'il faut savoir quelle version Active charger.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUNE VARIABLE NOUVELLE
 *
 * `NEXT_PUBLIC_APP_ENV` existe depuis la première ligne de `.env.example` et
 * est déjà renseignée sur chaque environnement hébergé. Elle décide déjà du
 * mode Stripe — test ou live —, ce qui est autrement plus risqué qu'un numéro
 * de version. S'en servir ici ne demande rien à l'exploitation.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEVINER EST INTERDIT
 *
 * Une valeur absente ou inconnue lève. Le repli silencieux serait ici le pire
 * choix possible : se croire en préproduction alors qu'on est en production,
 * c'est activer sans confirmation une version destinée aux tests. Mieux vaut un
 * démarrage refusé, bruyant et immédiat, qu'une bascule silencieuse.
 */

export type AiEnvironment = 'local' | 'preprod' | 'production';

/**
 * Valeurs acceptées, avec leurs synonymes rencontrés dans le dépôt.
 * `stripe-config.ts` accepte déjà `prod` comme `production` : refuser ici ce
 * qu'on accepte ailleurs produirait une incohérence invisible.
 */
const ALIAS: Readonly<Record<string, AiEnvironment>> = {
  local: 'local',
  dev: 'local',
  development: 'local',
  test: 'local',
  preprod: 'preprod',
  preproduction: 'preprod',
  staging: 'preprod',
  prod: 'production',
  production: 'production',
};

export function parseEnvironment(raw: string | undefined | null): AiEnvironment | null {
  if (!raw) return null;
  return ALIAS[raw.trim().toLowerCase()] ?? null;
}

/**
 * Environnement courant. Lève si la variable est absente ou illisible.
 *
 * En test, `local` par défaut : les tests unitaires n'ont pas à porter une
 * configuration d'exploitation, et aucun d'eux n'active de version.
 */
export function getAiEnvironment(): AiEnvironment {
  const resolved = parseEnvironment(process.env.NEXT_PUBLIC_APP_ENV);
  if (resolved) return resolved;

  if (process.env.NODE_ENV === 'test') return 'local';

  throw new Error(
    `[ai-env] NEXT_PUBLIC_APP_ENV absente ou illisible (« ${process.env.NEXT_PUBLIC_APP_ENV ?? ''} »). ` +
    `Valeurs attendues : ${[...new Set(Object.values(ALIAS))].join(', ')}. ` +
    "Sans elle, impossible de savoir quelle version de configuration IA activer — " +
    'et se tromper d\'environnement activerait en production une version destinée aux tests.',
  );
}

/** Contrôle de démarrage : échouer tôt plutôt que d'activer au mauvais endroit. */
export function assertAiEnvironment(): AiEnvironment {
  const env = getAiEnvironment();
  console.info(`[ai-env] Environnement de configuration IA : ${env}.`);
  return env;
}

/**
 * La promotion d'un Brouillon en « À tester » est réservée à la préproduction
 * (WF-02, préconditions). En production, une version arrive par import et
 * s'active explicitement (VER-012) — jamais par un cycle de test local.
 */
export function allowsTestVersions(env: AiEnvironment): boolean {
  return env !== 'production';
}
