/**
 * Santé détaillée pour la page BO « Exploitation » (lot 25, chantier B).
 *
 * Le diagnostic DÉTAILLÉ de `/api/health` (`buildHealthReport`, mêmes sondes
 * bornées `src/lib/health/probes.ts`) est rendu à l'administrateur connecté :
 * sa session suffit, aucun jeton (`x-health-token`) n'est demandé ni lu.
 *
 * Compléments propres au BO, bornés et en lecture seule :
 *   · schéma : fichiers critiques / optionnels en attente (noms), index
 *     INVALIDES, index en cours de construction, dernière migration
 *     appliquée, postdeploy en cours (session `verebona-migrate*`) ; la
 *     dernière exécution du postdeploy n'est PAS tracée en base (journal du
 *     conteneur postdeploy seulement) — c'est dit tel quel ;
 *   · variables retirées encore posées : NOMS seulement ;
 *   · identité du déploiement.
 *
 * AUCUNE valeur de variable : l'avertissement « variables IA retirées » de
 * `/api/health` cite la valeur posée ; il est remplacé ici par les noms.
 * Filet final : `redactDeep` (identifiants d'URL, URL signées).
 */
import { getMigrationStatus, pgClient } from '@/db';
import {
  listInvalidIndexes, migrationCatalog, readMigrationFiles, readSchemaState, type SqlRunner,
} from '@/db/migration-index';
import { buildHealthReport, type HealthCheckResult } from '@/lib/health/diagnostic';
import { withDeadline } from '@/lib/health/probes';
import { isSet, retiredEnvVariables } from './env-catalog';
import { redactDeep } from './redact';

const BUDGET_MS = 2_000;

export interface AdminSchemaDetail {
  /** État du passage des migrations de CE processus. */
  process: {
    phase: string; mode: string | null; startedAt: string | null; finishedAt: string | null; durationMs: number | null;
    failures: Array<{ filename: string; code?: string; criticality?: string; message: string }>;
  };
  /** Relu en base à l'instant (null : lecture impossible ou trop lente). */
  database: {
    tracked: boolean;
    pendingCritical: string[];
    pendingOptional: string[];
    appliedCount: number;
    lastApplied: { filename: string; appliedAt: string } | null;
    invalidIndexes: string[];
    buildingIndexes: Array<{ index: string; phase: string; progress: string | null }>;
    postdeployRunning: Array<{ applicationName: string; since: string | null }>;
  } | null;
  databaseError: string | null;
  postdeploy: { traced: false; note: string };
}

export interface AdminHealthReport {
  generatedAt: string;
  instance: string | null;
  health: Omit<HealthCheckResult, 'checks'> & { checks: Omit<HealthCheckResult['checks'], 'aiPromptArchitecture'> };
  httpStatus: number;
  schema: AdminSchemaDetail;
  retiredVariablesSet: Array<{ name: string; origin: string; now: string }>;
  runtime: { node: string; nodeEnv: string | null; appEnv: string | null };
}

async function lireSchemaEnBase(): Promise<AdminSchemaDetail['database']> {
  const runner = pgClient as unknown as SqlRunner;
  const fichiers = await readMigrationFiles();
  const st = await readSchemaState(runner, migrationCatalog(fichiers));
  const [appliquees, invalides, enConstruction, postdeploy] = await Promise.all([
    st.tracked
      ? pgClient<{ n: number; filename: string | null; applied_at: Date | null }[]>`
          SELECT (SELECT count(*)::int FROM _migrations) AS n, filename, applied_at
            FROM _migrations ORDER BY applied_at DESC, id DESC LIMIT 1`.catch(() => [])
      : Promise.resolve([]),
    listInvalidIndexes(runner),
    pgClient<{ index: string; phase: string; blocks_done: string | null; blocks_total: string | null }[]>`
      SELECT c.relname AS index, p.phase, p.blocks_done::text, p.blocks_total::text
        FROM pg_stat_progress_create_index p JOIN pg_class c ON c.oid = p.index_relid
       ORDER BY 1`.catch(() => []),
    pgClient<{ application_name: string; backend_start: Date | null }[]>`
      SELECT application_name, backend_start FROM pg_stat_activity
       WHERE application_name LIKE 'verebona-migrate%' AND datname = current_database()
       ORDER BY backend_start`.catch(() => []),
  ]);
  const derniere = appliquees[0];
  return {
    tracked: st.tracked,
    pendingCritical: st.pendingCritical,
    pendingOptional: st.pendingOptional,
    appliedCount: derniere?.n ?? 0,
    lastApplied: derniere?.filename ? { filename: derniere.filename, appliedAt: new Date(derniere.applied_at!).toISOString() } : null,
    invalidIndexes: invalides,
    buildingIndexes: enConstruction.map((b) => ({
      index: b.index, phase: b.phase,
      progress: b.blocks_total && Number(b.blocks_total) > 0 ? `${Math.round((Number(b.blocks_done ?? 0) / Number(b.blocks_total)) * 100)} %` : null,
    })),
    postdeployRunning: postdeploy.map((p) => ({ applicationName: p.application_name, since: p.backend_start ? new Date(p.backend_start).toISOString() : null })),
  };
}

export async function getAdminHealth(env: Record<string, string | undefined> = process.env): Promise<AdminHealthReport> {
  const [{ result, httpStatus }, base] = await Promise.all([
    buildHealthReport({ detailed: true }),
    withDeadline(lireSchemaEnBase(), BUDGET_MS).then(
      (d) => ({ d, err: null as string | null }),
      (e) => ({ d: null, err: `lecture impossible : ${(e as Error).message?.slice(0, 200) ?? 'erreur'}` }),
    ),
  ]);
  const s = getMigrationStatus();
  // Noms seulement : l'avertissement de /api/health cite la valeur posée.
  const { aiPromptArchitecture: _valeurs, ...checks } = result.checks;
  void _valeurs;
  const rapport: AdminHealthReport = {
    generatedAt: new Date().toISOString(),
    instance: (env.CONTAINER ?? env.HOSTNAME ?? '').trim() || null,
    health: { ...result, checks },
    httpStatus,
    schema: {
      process: {
        phase: s.phase, mode: s.mode, startedAt: s.startedAt, finishedAt: s.finishedAt, durationMs: s.durationMs,
        failures: s.failures.map((f) => ({ filename: f.filename, code: f.code, criticality: f.criticality, message: (f.message ?? '').slice(0, 300) })),
      },
      database: base.d,
      databaseError: base.err,
      postdeploy: {
        traced: false,
        note: 'Non tracée en base : le résultat du postdeploy (scripts/migrate.mjs) figure dans le journal du conteneur postdeploy '
          + '(Scalingo > Journaux, ligne « [migrate] {…} »). L’état du schéma ci-dessus est relu en base à l’instant.',
      },
    },
    retiredVariablesSet: retiredEnvVariables().filter((v) => isSet(env, v.name)),
    runtime: { node: process.version, nodeEnv: env.NODE_ENV ?? null, appEnv: env.NEXT_PUBLIC_APP_ENV ?? null },
  };
  return redactDeep(rapport);
}
