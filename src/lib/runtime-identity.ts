/**
 * Identité de build et d'exécution — SOURCE UNIQUE (APP-PERF-37).
 *
 * `/api/health` lisait `VERCEL_GIT_COMMIT_SHA` ou `GIT_COMMIT`, la télémétrie
 * IA `APP_COMMIT` puis `SOURCE_VERSION` : deux réponses possibles à « quel
 * code tourne ? ». Les deux lisent désormais `getBuildIdentity()`.
 *
 * Ordre de lecture du commit (premier valide) :
 *   1. APP_COMMIT        valeur explicite posée par l'exploitation ;
 *   2. SOURCE_VERSION    commit Git du build Scalingo ;
 *   3. APP_BUILD_COMMIT  SOURCE_VERSION figée dans le build par
 *                        `next.config.mjs` (suit l'image, y compris un
 *                        retour arrière vers un build antérieur) ;
 *   4. CONTAINER_VERSION version déployée exposée par Scalingo à l'exécution.
 * Aucune variable Vercel. Une valeur hors format (`[A-Za-z0-9._-]`, 4 à 64
 * caractères) est IGNORÉE : un commit inventé ou tronqué serait cru.
 * Absence = `null`, jamais une valeur de remplacement.
 */

export type CommitSource = 'APP_COMMIT' | 'SOURCE_VERSION' | 'APP_BUILD_COMMIT' | 'CONTAINER_VERSION';

export interface BuildIdentity {
  /** Commit déployé (40 caractères au plus), ou null. */
  commit: string | null;
  commitSource: CommitSource | null;
  /** Version applicative déclarée (APP_VERSION), défaut historique `1.0.0`. */
  version: string;
  /** Conteneur Scalingo (`web-1`…), ou null. */
  container: string | null;
}

const SOURCES: readonly CommitSource[] = ['APP_COMMIT', 'SOURCE_VERSION', 'APP_BUILD_COMMIT', 'CONTAINER_VERSION'];
const FORMAT = /^[A-Za-z0-9._-]{4,64}$/;

/** Repli de APP_VERSION, inchangé pour les consommateurs de la sonde. */
const DEFAULT_VERSION = '1.0.0';

type Env = Record<string, string | undefined>;

function buildCommitInline(): string | undefined {
  // Référence LITTÉRALE : remplacée au build par Next (`env` de next.config).
  return process.env.APP_BUILD_COMMIT;
}

export function getBuildIdentity(env: Env = process.env): BuildIdentity {
  let commit: string | null = null;
  let commitSource: CommitSource | null = null;
  for (const nom of SOURCES) {
    const brut = (nom === 'APP_BUILD_COMMIT' && env === process.env ? buildCommitInline() : env[nom])?.trim();
    if (!brut) continue;
    if (!FORMAT.test(brut)) continue;
    commit = brut.slice(0, 40);
    commitSource = nom;
    break;
  }
  const version = (env.APP_VERSION ?? '').trim();
  const container = (env.CONTAINER ?? '').trim();
  return {
    commit,
    commitSource,
    version: version && FORMAT.test(version) ? version : DEFAULT_VERSION,
    container: container && FORMAT.test(container) ? container : null,
  };
}
