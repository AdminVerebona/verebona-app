/**
 * Commutateurs de déploiement du CDC 15 — module unique (plan, § Déploiement).
 *
 * Variables d'environnement HORS `AI_FLAGS` : chacune passe de `legacy`
 * (comportement historique, défaut) à `shadow` (observation, sans écriture)
 * puis à `enabled`. Lot 16b : un commutateur retiré a pour comportement
 * définitif l'ancien `enabled`.
 * Tant qu'un commutateur n'est pas actionné, la production ne change pas.
 *
 * Lecture à CHAQUE appel (pas de cache) : un test ou un redémarrage avec une
 * autre valeur est pris en compte immédiatement ; le coût est négligeable.
 * Une valeur inconnue est lue `legacy` et signalée dans l'instantané : une
 * faute de frappe ne doit jamais activer un comportement nouveau.
 */

export type RolloutMode = 'legacy' | 'shadow' | 'enabled';

export const ROLLOUT_MODES: readonly RolloutMode[] = ['legacy', 'shadow', 'enabled'];

export interface RolloutSwitchDef {
  /** Nom de la variable d'environnement. */
  env: string;
  /** Lot du plan qui introduit le comportement piloté. */
  lot: string;
  description: string;
  /** Faux tant que le lot n'a pas branché le commutateur (réservé). */
  wired: boolean;
}

/** Catalogue des commutateurs (plan CDC 15, § Déploiement). */
export const ROLLOUT_SWITCHES = {
  CANONICAL_WRITE_MODE: {
    env: 'CANONICAL_WRITE_MODE', lot: 'L11', wired: true,
    description: 'Écritures des champs de bien par writeCanonicalAssetField (fiche, assistant, puis T3).',
  },
  AI_T1_ANALYSIS_MODE: {
    env: 'AI_T1_ANALYSIS_MODE', lot: 'L12', wired: true,
    // shadow : double appel T1 sur échantillon (AI_T1_SHADOW_SAMPLE_RATE),
    // préproduction seulement (D-18). enabled : chemin master seulement si la
    // version de configuration déclare T1 en architecture `master` (D-04).
    description: 'Prompt maître T1, contrat enrichi et projection déterministe (shadow : préprod seulement, sur échantillon — D-18).',
  },
  T3_NEGATIVE_RECONCILIATION: {
    env: 'T3_NEGATIVE_RECONCILIATION', lot: 'L13', wired: true,
    description: 'Cycle de vie des preuves (retrait à la suppression, au détachement, au déplacement, '
      + 'remplacement à la revalidation T2) et retrait des valeurs automatiques sans preuve active (T3-03, T3-04).',
  },
  // AI_T4_EFFECTS (L14) et ASSISTANT_CANONICAL_READ (L15) : SUPPRIMÉS au
  // lot 16b-2 — effets agenda T4 et lecture canonique de l'assistant
  // toujours actifs (comportement de l'ancien `enabled`).
  EXPORTS_CANONICAL_SOURCE: {
    env: 'EXPORTS_CANONICAL_SOURCE', lot: 'L16', wired: true,
    // shadow : source historique utilisée, source canonique calculée en plus
    // (données seulement, aucun rendu) et rapport d'écarts sans valeur.
    description: 'Dossiers V12 lus depuis CanonicalAssetView et document_asset_links (X-02) : champs du bien, '
      + 'pièces N-N (PRIMARY, SECONDARY ; MENTIONED exclus) avec repli sur les colonnes historiques, agenda D-14 / 4 états.',
  },
} as const satisfies Record<string, RolloutSwitchDef>;

export type RolloutSwitch = keyof typeof ROLLOUT_SWITCHES;

type Env = Record<string, string | undefined>;

function parse(raw: string | undefined): { mode: RolloutMode; invalid: boolean } {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return { mode: 'legacy', invalid: false };
  if ((ROLLOUT_MODES as readonly string[]).includes(v)) return { mode: v as RolloutMode, invalid: false };
  return { mode: 'legacy', invalid: true };
}

/** Mode courant d'un commutateur (`legacy` si absent ou invalide). */
export function getRolloutMode(name: RolloutSwitch, env: Env = process.env): RolloutMode {
  return parse(env[ROLLOUT_SWITCHES[name].env]).mode;
}

/**
 * Mode du cycle de vie des preuves et de la réconciliation négative (plan
 * L13, CDC 15 T3-03, T3-04, T2-29) : `legacy` rien ; `shadow` journal et
 * rapport de ce qui serait retiré, sans écriture ; `enabled` transitions,
 * retraits et réconciliation.
 */
export function t3NegativeMode(env: Env = process.env): RolloutMode {
  return getRolloutMode('T3_NEGATIVE_RECONCILIATION', env);
}

/** Mode des écritures canoniques (plan L11). */
export function canonicalWriteMode(env: Env = process.env): RolloutMode {
  return getRolloutMode('CANONICAL_WRITE_MODE', env);
}

export interface RolloutSnapshotEntry extends RolloutSwitchDef {
  name: RolloutSwitch;
  mode: RolloutMode;
  /** Valeur brute lue (null si absente) — jamais un secret. */
  raw: string | null;
  /** Valeur présente mais non reconnue : lue `legacy`. */
  invalid: boolean;
}

/** Instantané pour l'inventaire (`ai-inventory`) et la page d'administration. */
export function rolloutSnapshot(env: Env = process.env): RolloutSnapshotEntry[] {
  return (Object.keys(ROLLOUT_SWITCHES) as RolloutSwitch[]).map((name) => {
    const def = ROLLOUT_SWITCHES[name];
    const raw = env[def.env];
    const { mode, invalid } = parse(raw);
    return { name, ...def, mode, raw: raw ?? null, invalid };
  });
}
