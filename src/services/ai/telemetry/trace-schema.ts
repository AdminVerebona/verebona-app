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
import { probeCount, schemaNotReadyMessage, type SchemaProbeOutcome } from '@/lib/schema-readiness-log';
const RECONTROLE_MS = 5 * 60_000;

/** Lecture d'une sonde : prêt ?, et ce qui a été constaté (comptage ou absents exacts, lot 75A). */
interface SchemaReading { ready: boolean; found?: number | null; missing?: readonly string[] | null }

/**
 * Sonde de schéma mémorisée : résultat positif gardé ; négatif relu toutes les
 * 5 min (migration appliquée à chaud) ; absence signalée UNE fois par
 * processus. Ne lève jamais : illisible = absent. `reset` est réservé aux tests.
 */
export function cachedSchemaProbe<A extends unknown[]>(
  read: (...args: A) => Promise<SchemaReading>,
  report: Omit<SchemaProbeOutcome, 'found' | 'missing' | 'error'>,
) {
  let etat: { ready: boolean; checkedAt: number } | null = null;
  let signale = false;
  const probe = async (...args: A): Promise<boolean> => {
    if (etat && (etat.ready || Date.now() - etat.checkedAt < RECONTROLE_MS)) return etat.ready;
    let lu: SchemaReading = { ready: false };
    let error: unknown;
    try {
      lu = await read(...args);
    } catch (e) {
      error = e;
    }
    etat = { ready: lu.ready, checkedAt: Date.now() };
    if (!lu.ready && !signale) {
      signale = true;
      console.error(schemaNotReadyMessage({ ...report, found: lu.found, missing: lu.missing, error }));
    }
    return lu.ready;
  };
  return Object.assign(probe, {
    reset(ready: boolean | null = null): void {
      etat = ready === null ? null : { ready, checkedAt: Date.now() };
      signale = false;
    },
  });
}

/** Colonnes attendues, par table. */
const TRACE_MASTER_COLUMNS = ['task', 'master_prompt_code', 'master_prompt_version'] as const;

const traceMasterProbe = cachedSchemaProbe(async () => {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('ai_usage_event', 'ai_pipeline_step')
        AND column_name = ANY($1::text[])`,
    [[...TRACE_MASTER_COLUMNS]] as never[],
  )) as unknown as Array<{ n: number }>;
  const found = probeCount(rows); // lot 75A : résultat inexploitable = inconnu, pas 0
  return { ready: found === TRACE_MASTER_COLUMNS.length * 2, found };
}, {
  scope: '[ai-trace]', migration: '0217',
  expected: ['ai_usage_event', 'ai_pipeline_step'].flatMap((t) => TRACE_MASTER_COLUMNS.map((c) => `${t}.${c}`)),
  consequence: 'Les traces IA continuent SANS ces champs (CDC 15 DP-05) ; appliquer src/db/migrations/0217_*.sql.',
});

/** Les colonnes 0217 existent-elles sur `ai_usage_event` ET `ai_pipeline_step` ? */
export async function traceMasterColumnsReady(): Promise<boolean> {
  return traceMasterProbe();
}

/** Réservé aux tests. */
export function __resetTraceSchemaForTests(ready: boolean | null = null): void {
  traceMasterProbe.reset(ready);
}

// ══════════════════════════════════════════════════════════════════════════
// Lot 83C — colonne `business_execution_id` (migration 0668) sur
// `ai_usage_event` et `ai_call_captures`. Même règle que la 0217 : écrite à
// part, seulement si présente ; absente, la trace part sans elle (signalé une
// fois), jamais en échec.
// ══════════════════════════════════════════════════════════════════════════

let etatExecution: { usage: boolean; captures: boolean; checkedAt: number } | null = null;
let signaleExecution = false;

/** Présence de `business_execution_id` sur chaque table. Ne lève jamais. */
export async function businessExecutionColumnsReady(): Promise<{ usage: boolean; captures: boolean }> {
  if (etatExecution && ((etatExecution.usage && etatExecution.captures) || Date.now() - etatExecution.checkedAt < RECONTROLE_MS)) {
    return { usage: etatExecution.usage, captures: etatExecution.captures };
  }
  let usage = false;
  let captures = false;
  let erreur: unknown;
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name = 'business_execution_id'
          AND table_name IN ('ai_usage_event', 'ai_call_captures')`,
    )) as unknown as Array<{ table_name: string }>;
    const tables = new Set((Array.isArray(rows) ? rows : []).map((r) => String(r.table_name)));
    usage = tables.has('ai_usage_event');
    captures = tables.has('ai_call_captures');
  } catch (e) {
    erreur = e;
  }
  etatExecution = { usage, captures, checkedAt: Date.now() };
  if ((!usage || !captures) && !signaleExecution) {
    signaleExecution = true;
    console.error(schemaNotReadyMessage({
      scope: '[ai-trace]', migration: '0668',
      expected: ['ai_usage_event.business_execution_id', 'ai_call_captures.business_execution_id'],
      found: Number(usage) + Number(captures), error: erreur,
      consequence: 'Les appels IA sont tracés SANS identifiant d’exécution métier (lot 83C) ; appliquer src/db/migrations/0668_*.sql.',
    }));
  }
  return { usage, captures };
}

