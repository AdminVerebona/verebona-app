/**
 * Feature flags de bascule — CDC §10.1 et §10.4.
 *
 * ⚠️ RÈGLE ABSOLUE (§10.4) : un flag active le nouveau moteur **à la place** de
 * l'ancien. Il ne doit JAMAIS déclencher les deux chaînes sur les mêmes objets,
 * sauf mode shadow sans écriture. Aucune double écriture n'est autorisée.
 *
 * À ne pas confondre avec `src/lib/feature-flags.ts`, qui gère les capacités
 * par offre commerciale (Standard, Premium…) et n'a aucun rapport.
 */
export const AI_FLAGS = [
  'AI_UNIFIED_SOURCE_ANALYSIS',
  'AI_RECONCILIATION_ENGINE',
  'AI_INTELLIGENT_ASSISTANT',
  'AI_AGENDA_ENGINE',
  'AI_PROMPT_GOVERNANCE',
  // T6 — mascotte d'accueil. `legacy` (défaut) : texte déterministe seul ;
  // `enabled` : formulation T6. Pas de mode observation (voir plus bas).
  'AI_HOME_MASCOT',
] as const;

// ⚠️ N'AJOUTEZ PAS DE DRAPEAU ICI QUI NE SOIT PAS UN USAGE IA.
//
// `AI_FLAGS` signifie « un drapeau par usage du référentiel », et deux tests en
// dépendent : la bijection usage ⇄ drapeau, et l'interprétation du rapport
// d'inventaire. Une bascule technique — la file durable, par exemple — se pilote
// par sa propre variable, lue là où elle sert.
//
// Essai du 18/09/2026 : y ajouter `AI_DURABLE_QUEUE` a fait tomber les deux
// tests, à juste titre.

export type AiFlag = (typeof AI_FLAGS)[number];

export type FlagMode =
  /** Ancien moteur seul. */
  | 'legacy'
  /** Nouveau moteur produit ses décisions sans les appliquer (§10.2). */
  | 'shadow'
  /** Nouveau moteur seul — l'ancien est hors du chemin d'exécution. */
  | 'enabled';

function readMode(flag: AiFlag): FlagMode {
  const raw = (process.env[flag] ?? 'legacy').toLowerCase();
  if (raw === 'enabled' || raw === 'true' || raw === '1') return 'enabled';
  if (raw === 'shadow') return 'shadow';
  return 'legacy';
}

export function getFlagMode(flag: AiFlag): FlagMode {
  return readMode(flag);
}

export function isEnabled(flag: AiFlag): boolean {
  return readMode(flag) === 'enabled';
}

export function isShadow(flag: AiFlag): boolean {
  return readMode(flag) === 'shadow';
}

/** Le nouveau moteur doit-il produire des décisions (appliquées ou non) ? */
export function shouldRunNewEngine(flag: AiFlag): boolean {
  const m = readMode(flag);
  return m === 'enabled' || m === 'shadow';
}

/** Les décisions du nouveau moteur doivent-elles être écrites ? */
export function shouldWrite(flag: AiFlag): boolean {
  return readMode(flag) === 'enabled';
}

/** L'ancien moteur doit-il encore s'exécuter ? */
export function shouldRunLegacy(flag: AiFlag): boolean {
  return readMode(flag) !== 'enabled';
}

/**
 * Drapeaux pour lesquels le mode observation n'a pas de sens — CDC §10.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI L'ASSISTANT N'A PAS DE MODE OBSERVATION
 *
 * Le §10.2 définit l'observation comme « le nouveau moteur produit ses
 * décisions, les décisions ne sont pas appliquées ». Cela suppose une décision
 * qu'on peut retenir : une valeur de champ, une échéance. Une réponse
 * d'assistant, elle, n'a pas d'autre destination que l'écran — la produire sans
 * l'afficher ne mesure rien, et l'afficher EST l'appliquer.
 *
 * Or les deux sémantiques se combinent mal ici : `shouldRunLegacy` laisse
 * l'ancien moteur en service tant que le mode n'est pas `enabled`, tandis que
 * `isUseCaseRunning` démarre le nouveau dès `shadow`. `AI_INTELLIGENT_ASSISTANT=shadow`
 * ferait donc répondre l'assistant ET la recherche sémantique historique aux
 * mêmes questions : exactement le double fonctionnement interdit par le §10.4.
 *
 * Le mode est refusé au démarrage plutôt que corrigé en silence : un
 * exploitant qui écrit `shadow` croit mesurer quelque chose, et doit apprendre
 * qu'il n'y a rien à mesurer.
 * ══════════════════════════════════════════════════════════════════════════
 */
const SANS_MODE_OBSERVATION: readonly AiFlag[] = ['AI_INTELLIGENT_ASSISTANT', 'AI_HOME_MASCOT'];

/** Lève si un drapeau porte un mode qu'il ne sait pas honorer. */
export function assertFlagModesSupported(): void {
  const fautifs = SANS_MODE_OBSERVATION.filter((f) => readMode(f) === 'shadow');
  if (fautifs.length === 0) return;

  throw new Error(
    `[ai-flags] Mode « shadow » non supporté pour : ${fautifs.join(', ')}. ` +
    "Une réponse d'assistant n'a pas d'existence séparée de son affichage : il n'y a " +
    'rien à observer sans appliquer. Utilisez `legacy` ou `enabled`.',
  );
}

/** Instantané pour l'administration et l'inventaire d'exécution. */
export function snapshotFlags(): Record<AiFlag, FlagMode> {
  return Object.fromEntries(AI_FLAGS.map((f) => [f, readMode(f)])) as Record<AiFlag, FlagMode>;
}
