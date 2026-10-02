/**
 * Prérequis des rattrapages CDC 15 : tables, colonnes et fonctions, par étape.
 *
 * Le script n'appelle JAMAIS `ensureMigrations` (lancement manuel, sur une
 * base dont les migrations sont gérées par le démarrage de l'application) :
 * un prérequis absent est SIGNALÉ, avec la migration qui l'apporte, et rien
 * n'est exécuté.
 */
import type postgres from 'postgres';
import type { MigStep } from './types';

export interface Requirement {
  kind: 'table' | 'column' | 'function';
  name: string;
  migration: string;
}

const T = (name: string, migration: string): Requirement => ({ kind: 'table', name, migration });
const C = (name: string, migration: string): Requirement => ({ kind: 'column', name, migration });

/** Rapport de migration : toujours requis sauf `--no-db-report`. */
export const REPORT_REQUIREMENTS: Requirement[] = [
  T('cdc15_migration_report', '0225_cdc15_migration_report'),
  T('cdc15_migration_runs', '0225_cdc15_migration_report'),
];

export const STEP_REQUIREMENTS: Record<MigStep, Requirement[]> = {
  'MIG-01': [
    T('document_facts', '0139_document_knowledge'), C('document_facts.canonical_key', '0218'), C('document_facts.raw_key', '0218'),
    C('document_facts.raw_value', '0218'),
    T('field_evidence', '0102_field_evidence'), C('field_evidence.canonical_key', '0219'), C('field_evidence.raw_value', '0219'),
    T('to_process_actions', '0128'),
  ],
  'MIG-02': [
    T('field_evidence', '0102_field_evidence'), C('field_evidence.canonical_key', '0219'), C('field_evidence.lifecycle_status', '0219'),
    T('canonical_field_writes', '0216'), T('ai_field_updates', '0103'), T('document_asset_links', '0221'), T('to_process_actions', '0128'),
  ],
  'MIG-03': [T('canonical_field_writes', '0216'), T('ai_field_updates', '0103')],
  'MIG-04': [
    T('field_evidence', '0102_field_evidence'), C('field_evidence.lifecycle_status', '0219'), C('field_evidence.superseded_at', '0219'),
    C('field_evidence.superseded_by_evidence_id', '0219'), C('field_evidence.analysis_run_id', '0219'),
  ],
  // `agenda_item_sources` est facultative : le service la détecte lui-même.
  'MIG-05': [T('agenda_file_links', '0050_agenda_items')],
  'MIG-06': [C('agenda_items.functional_key', '0223_agenda_functional_key'), T('agenda_item_removals', '0223_agenda_functional_key_removals')],
  'MIG-07': [T('to_process_actions', '0128'), T('cdc15_migration_backups', '0225_cdc15_migration_report_backups'),
    T('canonical_field_writes', '0216'), T('ai_field_updates', '0103')],
  'MIG-08': [
    T('document_asset_links', '0221_document_asset_links'), C('document_asset_links.substructure_id', '0229_rooms_to_substructures'),
    { kind: 'function', name: 'document_asset_links_sync_file', migration: '0221_document_asset_links_trigger' },
  ],
};

/** Prérequis absents (liste vide : tout est là). */
export async function missingRequirements(sql: postgres.Sql, reqs: Requirement[]): Promise<Requirement[]> {
  const out: Requirement[] = [];
  for (const r of reqs) {
    let ok: boolean;
    if (r.kind === 'table') {
      ok = (await sql<{ ok: boolean }[]>`SELECT to_regclass(${r.name}) IS NOT NULL AS ok`)[0]?.ok ?? false;
    } else if (r.kind === 'function') {
      ok = (await sql<{ ok: boolean }[]>`SELECT to_regproc(${r.name}) IS NOT NULL AS ok`)[0]?.ok ?? false;
    } else {
      const [table, column] = r.name.split('.');
      ok = (await sql<{ ok: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = ${column}) AS ok`)[0]?.ok ?? false;
    }
    if (!ok) out.push(r);
  }
  return out;
}

/** Message clair (français) des prérequis absents. */
export function formatMissing(missing: Requirement[]): string {
  return [
    'Prérequis absents — rien n’a été exécuté :',
    ...missing.map((m) => `  · ${m.kind === 'table' ? 'table' : m.kind === 'column' ? 'colonne' : 'fonction'} ${m.name} (migration ${m.migration})`),
    'Appliquez les migrations (démarrage de l’application). Ce script n’appelle jamais ensureMigrations.',
  ].join('\n');
}
