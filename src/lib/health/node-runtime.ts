/**
 * Runtime Node.js réellement en service — lot 100C (CVE-2026-111497
 * « Node2Shell », bulletin Scalingo SSB-2026-007).
 *
 * Trois versions ne doivent pas être confondues :
 *   · CONFIGURÉE : `engines.node` de package.json (ce que le buildpack choisit) ;
 *   · INSTALLÉE  : ligne « Downloading and installing node … » du journal de build ;
 *   · EN SERVICE : `process.version` du processus qui répond — seule preuve
 *     que le conteneur actif tourne sur un runtime corrigé. C'est elle que ce
 *     module évalue.
 *
 * La « version » de `/api/health` est la version APPLICATIVE (APP_VERSION) ;
 * le runtime est une section distincte (`checks.runtime`). Un statut global
 * vert ou un déploiement GitHub réussi ne prouvent rien sur le runtime.
 *
 * Seuils corrigés par ligne majeure (avis Node.js d'octobre 2026). Une majeure
 * absente du tableau (20, 23, 25…) n'a pas de version corrigée connue : elle
 * est traitée comme non corrigée (branche abandonnée ou non prise en charge).
 *
 * Module pur, sans dépendance : partagé par l'amorçage (journal), la sonde de
 * santé et l'alerte de Supervision. `scripts/check-node-runtime.mjs` (pas de
 * CI) porte le même tableau — un test vérifie qu'ils restent identiques.
 */

/** Première version corrigée de chaque ligne majeure prise en charge. */
export const NODE_PATCHED_THRESHOLDS: Readonly<Record<number, string>> = Object.freeze({
  22: '22.23.4',
  24: '24.22.1',
  26: '26.12.1',
});

/**
 * Plage déclarée dans package.json (`engines.node`) et dans les métadonnées
 * racine de package-lock.json. Un test vérifie l'égalité avec package.json.
 */
export const NODE_ENGINES_RANGE = '>=24.22.1 <25';
/** Bornes de `NODE_ENGINES_RANGE` (minimum inclus, majeure maximale exclue). */
const ENGINES_MIN = '24.22.1';
const ENGINES_MAJOR_EXCLUDED = 25;

type Triplet = [number, number, number];

/** `v24.22.1` / `24.22.1` → [24, 22, 1] ; null si illisible. */
export function parseNodeVersion(raw: string | null | undefined): Triplet | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec((raw ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a: Triplet, b: Triplet): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * `patched` : au moins le seuil corrigé de sa majeure.
 * `vulnerable` : majeure prise en charge, mais sous le seuil corrigé.
 * `unsupported_major` : majeure sans seuil connu (abandonnée / non prise en charge).
 * `unknown` : version illisible.
 */
export type NodeRuntimeVerdict = 'patched' | 'vulnerable' | 'unsupported_major' | 'unknown';

export interface NodeRuntimeStatus {
  /** `ok` : corrigé et dans la plage déclarée ; `warning` : corrigé mais hors
   *  plage déclarée ; `error` : non corrigé ou indéterminé. */
  status: 'ok' | 'warning' | 'error';
  verdict: NodeRuntimeVerdict;
  /** `process.version` tel quel (ex. `v24.22.1`). */
  node: string;
  major: number | null;
  /** Seuil corrigé de la majeure (null : majeure sans seuil connu). */
  patchedThreshold: string | null;
  /** Plage déclarée dans package.json. */
  enginesRange: string;
  /** Le runtime respecte-t-il la plage déclarée ? */
  withinEngines: boolean;
  /** Phrase courte, en français simple. */
  message: string;
}

export function evaluateNodeRuntime(version: string): NodeRuntimeStatus {
  const v = parseNodeVersion(version);
  const base = { node: version, enginesRange: NODE_ENGINES_RANGE };
  if (!v) {
    return {
      ...base, status: 'error', verdict: 'unknown', major: null, patchedThreshold: null, withinEngines: false,
      message: `Version de Node illisible (« ${version} ») : impossible de prouver que le correctif est appliqué.`,
    };
  }
  const [major] = v;
  const withinEngines = compare(v, parseNodeVersion(ENGINES_MIN)!) >= 0 && major < ENGINES_MAJOR_EXCLUDED;
  const seuil = NODE_PATCHED_THRESHOLDS[major] ?? null;
  if (!seuil) {
    return {
      ...base, status: 'error', verdict: 'unsupported_major', major, patchedThreshold: null, withinEngines,
      message: `Node ${version} : ligne ${major} sans version corrigée connue (non prise en charge). Passer à Node ${ENGINES_MIN} ou plus récent en 24.x.`,
    };
  }
  if (compare(v, parseNodeVersion(seuil)!) < 0) {
    return {
      ...base, status: 'error', verdict: 'vulnerable', major, patchedThreshold: seuil, withinEngines,
      message: `Node ${version} est sous la version corrigée ${seuil} de sa ligne : runtime vulnérable (CVE-2026-111497). Redéployer complètement.`,
    };
  }
  return {
    ...base, status: withinEngines ? 'ok' : 'warning', verdict: 'patched', major, patchedThreshold: seuil, withinEngines,
    message: withinEngines
      ? `Node ${version} : corrigé (seuil ${seuil}) et conforme à la plage déclarée ${NODE_ENGINES_RANGE}.`
      : `Node ${version} : corrigé (seuil ${seuil}) mais hors de la plage déclarée ${NODE_ENGINES_RANGE}.`,
  };
}

/** Runtime du processus courant. */
export function currentNodeRuntime(): NodeRuntimeStatus & { execPath: string } {
  return { ...evaluateNodeRuntime(process.version), execPath: process.execPath };
}

/** Ligne de journal du démarrage : version, binaire, verdict. Jamais de variable d'environnement. */
export function formatRuntimeLogLine(r: NodeRuntimeStatus & { execPath: string }): string {
  return `[runtime] node=${r.node} execPath=${r.execPath} verdict=${r.verdict} seuil=${r.patchedThreshold ?? 'aucun'} `
    + `plage=${r.enginesRange} — ${r.message}`;
}
