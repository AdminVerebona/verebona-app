/**
 * Présence des colonnes de la migration 0223 sur `agenda_items`
 * (`functional_key`, `event_nature`, `business_type`) — CDC 15 T4-08, D-14.
 *
 * Colonnes volontairement NON déclarées dans Drizzle (voir l'en-tête de la
 * 0223) : lues et écrites en SQL, seulement si ce contrôle confirme leur
 * présence. Absentes (migration non passée) : clé, nature et liens source
 * ne sont ni écrits ni lus, et l'absence est signalée une fois par
 * processus. Ne lève jamais.
 */
const RECONTROLE_MS = 5 * 60_000;
let etat: { ready: boolean; checkedAt: number } | null = null;
let signale = false;

export const AGENDA_0223_COLUMNS = ['functional_key', 'event_nature', 'business_type'] as const;

export async function agendaFunctionalColumnsReady(): Promise<boolean> {
  if (etat && (etat.ready || Date.now() - etat.checkedAt < RECONTROLE_MS)) return etat.ready;
  let ready = false;
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'agenda_items' AND column_name = ANY($1::text[])`,
      [[...AGENDA_0223_COLUMNS]] as never[],
    )) as unknown as Array<{ n: number }>;
    ready = Number(rows[0]?.n ?? 0) === AGENDA_0223_COLUMNS.length;
  } catch {
    ready = false;
  }
  etat = { ready, checkedAt: Date.now() };
  if (!ready && !signale) {
    signale = true;
    console.error(
      '[agenda] ⚠️ MIGRATION 0223 NON APPLIQUÉE : clé fonctionnelle et nature absentes de agenda_items. '
      + 'Effets T4 inopérants (clé, nature, liens source, synchronisation par source). Voir /api/health.',
    );
  }
  return ready;
}

/** Réservé aux tests. */
export function __resetAgendaColumnsForTests(ready: boolean | null = null): void {
  etat = ready === null ? null : { ready, checkedAt: Date.now() };
  signale = false;
}

// ── Liens source ↔ agenda (0223, `agenda_item_sources`) ─────────────────────

let etatSources: { ready: boolean; checkedAt: number } | null = null;
let signaleSources = false;

/**
 * Colonnes `source_role`, `evidence_id` présentes et `run_id` facultatif sur
 * `agenda_item_sources` ? Absentes : seuls les liens `agenda_file_links` sont
 * écrits (signalé une fois). Ne lève jamais.
 */
export async function agendaSourcesColumnsReady(): Promise<boolean> {
  if (etatSources && (etatSources.ready || Date.now() - etatSources.checkedAt < RECONTROLE_MS)) return etatSources.ready;
  let ready = false;
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT COUNT(*) FILTER (WHERE column_name IN ('source_role', 'evidence_id'))::int AS n,
              COUNT(*) FILTER (WHERE column_name = 'run_id' AND is_nullable = 'YES')::int AS r
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'agenda_item_sources'`,
    )) as unknown as Array<{ n: number; r: number }>;
    ready = Number(rows[0]?.n ?? 0) === 2 && Number(rows[0]?.r ?? 0) === 1;
  } catch {
    ready = false;
  }
  etatSources = { ready, checkedAt: Date.now() };
  if (!ready && !signaleSources) {
    signaleSources = true;
    console.error('[agenda] ⚠️ MIGRATION 0223 (agenda_item_sources) NON APPLIQUÉE : liens source ↔ agenda limités à agenda_file_links.');
  }
  return ready;
}

/** Réservé aux tests. */
export function __resetAgendaSourcesColumnsForTests(ready: boolean | null = null): void {
  etatSources = ready === null ? null : { ready, checkedAt: Date.now() };
  signaleSources = false;
}
