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
] as const;

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

/** Instantané pour l'administration et l'inventaire d'exécution. */
export function snapshotFlags(): Record<AiFlag, FlagMode> {
  return Object.fromEntries(AI_FLAGS.map((f) => [f, readMode(f)])) as Record<AiFlag, FlagMode>;
}
