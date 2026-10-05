/**
 * Présence des colonnes de la migration 0217 (CDC 15 DP-05, ARCH-03).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN CONTRÔLE, ET PAS UNE DÉCLARATION DRIZZLE
 *
 * `ensureMigrations()` poursuit après une migration en échec (le produit ne
 * s'arrête pas pour une colonne de trace). Or Drizzle cite TOUTES les colonnes
 * déclarées dans chaque INSERT : déclarer `task` & co. aurait fait échouer
 * toutes les traces IA — et l'ancien suivi d'usage (retiré au lot 16b-3) —
 * si la 0217 manquait.
 *
 * Les trois colonnes sont donc écrites à part, en SQL, uniquement quand ce
 * contrôle confirme leur présence. Absentes : les traces partent sans elles,
 * et l'absence est signalée BRUYAMMENT — au démarrage (`instrumentation-node`)
 * puis une fois par processus au premier appel concerné — en plus de l'échec
 * de migration déjà exposé par `/api/health`.
 * ══════════════════════════════════════════════════════════════════════════
 */
const RECONTROLE_MS = 5 * 60_000;
let etat: { ready: boolean; checkedAt: number } | null = null;
let signale = false;

/** Colonnes attendues, par table. */
export const TRACE_MASTER_COLUMNS = ['task', 'master_prompt_code', 'master_prompt_version'] as const;

/**
 * Les colonnes 0217 existent-elles sur `ai_usage_event` ET `ai_pipeline_step` ?
 * Résultat positif gardé ; négatif relu toutes les 5 min (migration appliquée
 * à chaud). Ne lève jamais : illisible = absent.
 */
export async function traceMasterColumnsReady(): Promise<boolean> {
  if (etat && (etat.ready || Date.now() - etat.checkedAt < RECONTROLE_MS)) return etat.ready;
  let ready = false;
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('ai_usage_event', 'ai_pipeline_step')
          AND column_name = ANY($1::text[])`,
      [[...TRACE_MASTER_COLUMNS]] as never[],
    )) as unknown as Array<{ n: number }>;
    ready = Number(rows[0]?.n ?? 0) === TRACE_MASTER_COLUMNS.length * 2;
  } catch {
    ready = false;
  }
  etat = { ready, checkedAt: Date.now() };
  if (!ready && !signale) {
    signale = true;
    console.error(
      '[ai-trace] ⚠️ MIGRATION 0217 NON APPLIQUÉE : colonnes task / master_prompt_code / '
      + 'master_prompt_version absentes. Les traces IA continuent SANS ces champs (CDC 15 DP-05). '
      + 'Voir /api/health (migrations) et appliquer src/db/migrations/0217_*.sql.',
    );
  }
  return ready;
}

/** Réservé aux tests. */
export function __resetTraceSchemaForTests(ready: boolean | null = null): void {
  etat = ready === null ? null : { ready, checkedAt: Date.now() };
  signale = false;
}
