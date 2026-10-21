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
import { missingFromPresenceFlags, probeCount, schemaNotReadyMessage } from '@/lib/schema-readiness-log';
const RECONTROLE_MS = 5 * 60_000;
let etat: { ready: boolean; checkedAt: number } | null = null;
let signale = false;

export const AGENDA_0223_COLUMNS = ['functional_key', 'event_nature', 'business_type'] as const;

export async function agendaFunctionalColumnsReady(): Promise<boolean> {
  if (etat && (etat.ready || Date.now() - etat.checkedAt < RECONTROLE_MS)) return etat.ready;
  let ready = false;
  let trouvees: number | null = null;
  let erreur: unknown;
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'agenda_items' AND column_name = ANY($1::text[])`,
      [[...AGENDA_0223_COLUMNS]] as never[],
    )) as unknown as Array<{ n: number }>;
    trouvees = probeCount(rows); // lot 75A : résultat inexploitable = inconnu, pas 0
    ready = trouvees === AGENDA_0223_COLUMNS.length;
  } catch (e) {
    ready = false;
    erreur = e;
  }
  etat = { ready, checkedAt: Date.now() };
  if (!ready && !signale) {
    signale = true;
    // Lot 69 : seules les colonnes constatées absentes sont dites absentes.
    console.error(schemaNotReadyMessage({
      scope: '[agenda]', migration: '0223', expected: AGENDA_0223_COLUMNS.map((c) => `agenda_items.${c}`),
      found: trouvees, error: erreur,
      consequence: 'Effets T4 inopérants (clé, nature, liens source, synchronisation par source).',
    }));
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
const AGENDA_SOURCES_EXPECTED = ['agenda_item_sources.source_role', 'agenda_item_sources.evidence_id', 'agenda_item_sources.run_id (facultatif)'] as const;

/**
 * Colonnes `source_role`, `evidence_id` présentes et `run_id` facultatif sur
 * `agenda_item_sources` ? Absentes : seuls les liens `agenda_file_links` sont
 * écrits (signalé une fois). Ne lève jamais.
 */
export async function agendaSourcesColumnsReady(): Promise<boolean> {
  if (etatSources && (etatSources.ready || Date.now() - etatSources.checkedAt < RECONTROLE_MS)) return etatSources.ready;
  let ready = false;
  let absents: string[] | null = null;
  let erreur: unknown;
  try {
    const { pgClient } = await import('@/db');
    // Lot 75A : un drapeau par élément attendu (liste exacte des absents).
    const rows = (await pgClient.unsafe(
      `SELECT COALESCE(bool_or(column_name = 'source_role'), false) AS a,
              COALESCE(bool_or(column_name = 'evidence_id'), false) AS b,
              COALESCE(bool_or(column_name = 'run_id' AND is_nullable = 'YES'), false) AS c
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'agenda_item_sources'`,
    )) as unknown as Array<{ a: boolean; b: boolean; c: boolean }>;
    absents = rows[0] ? missingFromPresenceFlags(AGENDA_SOURCES_EXPECTED, [rows[0].a, rows[0].b, rows[0].c]) : null;
    ready = absents !== null && absents.length === 0;
  } catch (e) {
    ready = false;
    erreur = e;
  }
  etatSources = { ready, checkedAt: Date.now() };
  if (!ready && !signaleSources) {
    signaleSources = true;
    console.error(schemaNotReadyMessage({
      scope: '[agenda]', migration: '0223 (agenda_item_sources)', expected: AGENDA_SOURCES_EXPECTED, missing: absents, error: erreur,
      consequence: 'Liens source ↔ agenda limités à agenda_file_links.',
    }));
  }
  return ready;
}

/** Réservé aux tests. */
export function __resetAgendaSourcesColumnsForTests(ready: boolean | null = null): void {
  etatSources = ready === null ? null : { ready, checkedAt: Date.now() };
  signaleSources = false;
}
