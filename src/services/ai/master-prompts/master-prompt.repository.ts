/**
 * Persistance des versions de prompts maîtres (migrations 0254, 0255) —
 * ticket BO-IA-PROMPTS-01.
 *
 * Toutes les écritures qui touchent au statut d'une version passent par une
 * transaction verrouillée par (environnement, prompt) : deux administrateurs
 * qui activent en même temps sont sérialisés, et l'index unique « une seule
 * version active » n'est jamais heurté. L'immuabilité du texte d'une version
 * sortie de l'état Brouillon est garantie EN BASE (déclencheur 0254) en plus
 * des conditions `status = 'DRAFT'` des requêtes ci-dessous.
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';

export type MasterPromptStatus = 'DRAFT' | 'ACTIVE' | 'PREVIOUS';
export type MasterPromptOrigin = 'initial_file' | 'initial_config' | 'admin' | 'prompt_control';

export interface MasterPromptVersionRow {
  id: number;
  environment: string;
  treatment: string;
  masterPromptCode: string;
  versionNumber: number;
  status: MasterPromptStatus;
  content: string;
  contentSha256: string;
  origin: MasterPromptOrigin;
  basedOnId: number | null;
  createdBy: number | null;
  createdAt: Date;
  updatedBy: number | null;
  updatedAt: Date;
  activatedBy: number | null;
  activatedAt: Date | null;
  firstActivatedAt: Date | null;
}

export interface MasterPromptActivationRow {
  id: number;
  treatment: string;
  action: 'activate' | 'rollback';
  fromVersionId: number | null;
  fromVersionNumber: number | null;
  toVersionId: number;
  toVersionNumber: number;
  userId: number | null;
  userEmail: string | null;
  testSummary: string | null;
  createdAt: Date;
}

export interface TestFailure {
  scenario: string;
  description: string;
  branch: string;
  expected: string;
  obtained: string;
}

export interface MasterPromptTestRunRow {
  id: number;
  promptVersionId: number;
  treatment: string;
  contentSha256: string;
  status: 'RUNNING' | 'DONE' | 'ERROR';
  scenariosTotal: number;
  scenariosPassed: number;
  scenariosFailed: number;
  failures: TestFailure[];
  error: string | null;
  requestedBy: number | null;
  startedAt: Date;
  finishedAt: Date | null;
}

type Row = Record<string, unknown>;
type Sql = { unsafe: (query: string, params?: never[]) => Promise<unknown> };

const d = (v: unknown): Date | null => (v == null ? null : new Date(String(v)));
const n = (v: unknown): number | null => (v == null ? null : Number(v));

/** Empreinte du texte (fins de ligne normalisées, comme le corpus). */
export function contentSha256(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n?/g, '\n')).digest('hex');
}

const toVersion = (r: Row): MasterPromptVersionRow => ({
  id: Number(r.id),
  environment: String(r.environment),
  treatment: String(r.treatment),
  masterPromptCode: String(r.master_prompt_code),
  versionNumber: Number(r.version_number),
  status: String(r.status) as MasterPromptStatus,
  content: String(r.content ?? ''),
  contentSha256: String(r.content_sha256),
  origin: String(r.origin) as MasterPromptOrigin,
  basedOnId: n(r.based_on_id),
  createdBy: n(r.created_by),
  createdAt: new Date(String(r.created_at)),
  updatedBy: n(r.updated_by),
  updatedAt: new Date(String(r.updated_at)),
  activatedBy: n(r.activated_by),
  activatedAt: d(r.activated_at),
  firstActivatedAt: d(r.first_activated_at),
});

const toActivation = (r: Row): MasterPromptActivationRow => ({
  id: Number(r.id),
  treatment: String(r.treatment),
  action: String(r.action) as 'activate' | 'rollback',
  fromVersionId: n(r.from_version_id),
  fromVersionNumber: n(r.from_version_number),
  toVersionId: Number(r.to_version_id),
  toVersionNumber: Number(r.to_version_number),
  userId: n(r.user_id),
  userEmail: r.user_email == null ? null : String(r.user_email),
  testSummary: r.test_summary == null ? null : String(r.test_summary),
  createdAt: new Date(String(r.created_at)),
});

const toRun = (r: Row): MasterPromptTestRunRow => ({
  id: Number(r.id),
  promptVersionId: Number(r.prompt_version_id),
  treatment: String(r.treatment),
  contentSha256: String(r.content_sha256),
  status: String(r.status) as MasterPromptTestRunRow['status'],
  scenariosTotal: Number(r.scenarios_total),
  scenariosPassed: Number(r.scenarios_passed),
  scenariosFailed: Number(r.scenarios_failed),
  failures: (r.failures ?? []) as TestFailure[],
  error: r.error == null ? null : String(r.error),
  requestedBy: n(r.requested_by),
  startedAt: new Date(String(r.started_at)),
  finishedAt: d(r.finished_at),
});

const db = (): Sql => pgClient as unknown as Sql;
const rows = async (q: string, p: unknown[] = [], sql: Sql = db()) => (await sql.unsafe(q, p as never[])) as Row[];

// ── Lectures ────────────────────────────────────────────────────────────────

/** Tables 0254/0255 présentes ? (absentes : l'administration des prompts est indisponible, l'exécution retombe sur la configuration.) */
export async function masterPromptTablesReady(): Promise<boolean> {
  const r = await rows(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('ai_master_prompt_versions', 'ai_master_prompt_activations', 'ai_master_prompt_test_runs')`,
  );
  return Number(r[0]?.n ?? 0) === 3;
}

export async function getPromptVersion(id: number): Promise<MasterPromptVersionRow | null> {
  const r = await rows(`SELECT * FROM ai_master_prompt_versions WHERE id = $1`, [id]);
  return r[0] ? toVersion(r[0]) : null;
}

export async function listPromptVersions(environment: string, treatment: string): Promise<MasterPromptVersionRow[]> {
  return (await rows(
    `SELECT * FROM ai_master_prompt_versions WHERE environment = $1 AND treatment = $2 ORDER BY version_number DESC`,
    [environment, treatment],
  )).map(toVersion);
}

/** Versions ACTIVES de l'environnement (lecture d'exécution : une ligne par prompt). */
export async function listActivePromptVersions(environment: string): Promise<MasterPromptVersionRow[]> {
  return (await rows(
    `SELECT * FROM ai_master_prompt_versions WHERE environment = $1 AND status = 'ACTIVE'`,
    [environment],
  )).map(toVersion);
}

export async function listActivations(environment: string, treatment: string, limit = 50): Promise<MasterPromptActivationRow[]> {
  return (await rows(
    `SELECT * FROM ai_master_prompt_activations WHERE environment = $1 AND treatment = $2
      ORDER BY created_at DESC, id DESC LIMIT $3`,
    [environment, treatment, limit],
  )).map(toActivation);
}

export async function userEmails(ids: number[]): Promise<Map<number, string>> {
  const uniques = [...new Set(ids.filter((x) => Number.isInteger(x)))];
  if (uniques.length === 0) return new Map();
  const r = await rows(`SELECT id, email FROM users WHERE id = ANY($1::int[])`, [uniques]);
  return new Map(r.map((x) => [Number(x.id), String(x.email)]));
}

// ── Écritures de versions ───────────────────────────────────────────────────

async function lock(sql: Sql, environment: string, treatment: string): Promise<void> {
  await sql.unsafe(`SELECT pg_advisory_xact_lock(hashtext('ai_master_prompt:' || $1 || ':' || $2))`, [environment, treatment] as never[]);
}

const NEXT_NUMBER = `(SELECT COALESCE(MAX(version_number), 0) + 1 FROM ai_master_prompt_versions WHERE environment = $1 AND treatment = $2)`;

/**
 * Version initiale ACTIVE (v1) d'un prompt sans historique : le texte qui
 * s'exécute déjà (version de configuration effective, sinon fichier du
 * dépôt). Sans effet si une version existe déjà. Rend l'active.
 */
export async function ensureInitialVersion(p: {
  environment: string; treatment: string; masterPromptCode: string; content: string; origin: 'initial_file' | 'initial_config';
}): Promise<MasterPromptVersionRow> {
  return pgClient.begin(async (tx) => {
    const sql = tx as unknown as Sql;
    await lock(sql, p.environment, p.treatment);
    const existante = await rows(
      `SELECT * FROM ai_master_prompt_versions WHERE environment = $1 AND treatment = $2 AND status = 'ACTIVE'`,
      [p.environment, p.treatment], sql,
    );
    if (existante[0]) return toVersion(existante[0]);
    const r = await rows(
      `INSERT INTO ai_master_prompt_versions
         (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin,
          activated_at, first_activated_at)
       VALUES ($1, $2, $3, ${NEXT_NUMBER}, 'ACTIVE', $4, $5, $6, now(), now())
       RETURNING *`,
      [p.environment, p.treatment, p.masterPromptCode, p.content, contentSha256(p.content), p.origin], sql,
    );
    return toVersion(r[0]);
  }) as Promise<MasterPromptVersionRow>;
}

/** Brouillon du prompt (au plus un). */
export async function getDraft(environment: string, treatment: string): Promise<MasterPromptVersionRow | null> {
  const r = await rows(
    `SELECT * FROM ai_master_prompt_versions WHERE environment = $1 AND treatment = $2 AND status = 'DRAFT'`,
    [environment, treatment],
  );
  return r[0] ? toVersion(r[0]) : null;
}

export async function getActive(environment: string, treatment: string): Promise<MasterPromptVersionRow | null> {
  const r = await rows(
    `SELECT * FROM ai_master_prompt_versions WHERE environment = $1 AND treatment = $2 AND status = 'ACTIVE'`,
    [environment, treatment],
  );
  return r[0] ? toVersion(r[0]) : null;
}

/**
 * Crée LE brouillon d'un prompt (numéro suivant). `null` si un brouillon
 * existe déjà (création concurrente : l'appelant relit et le reprend).
 */
export async function insertDraft(p: {
  environment: string; treatment: string; masterPromptCode: string; content: string;
  origin: 'admin' | 'prompt_control'; basedOnId: number | null; userId: number;
}): Promise<MasterPromptVersionRow | null> {
  return pgClient.begin(async (tx) => {
    const sql = tx as unknown as Sql;
    await lock(sql, p.environment, p.treatment);
    const existant = await rows(
      `SELECT id FROM ai_master_prompt_versions WHERE environment = $1 AND treatment = $2 AND status = 'DRAFT'`,
      [p.environment, p.treatment], sql,
    );
    if (existant[0]) return null;
    const r = await rows(
      `INSERT INTO ai_master_prompt_versions
         (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin,
          based_on_id, created_by, updated_by)
       VALUES ($1, $2, $3, ${NEXT_NUMBER}, 'DRAFT', $4, $5, $6, $7, $8, $8)
       RETURNING *`,
      [p.environment, p.treatment, p.masterPromptCode, p.content, contentSha256(p.content), p.origin, p.basedOnId, p.userId], sql,
    );
    return toVersion(r[0]);
  }) as Promise<MasterPromptVersionRow | null>;
}

/**
 * Remplace le texte d'un BROUILLON. `expectedContent` (facultatif) : écriture
 * conditionnelle (Prompt Control) — 0 ligne si le texte a changé entre-temps.
 * Rend la ligne écrite, ou `null` (plus un brouillon, ou conflit).
 */
export async function updateDraftContent(p: {
  id: number; content: string; userId: number; expectedContent?: string;
}): Promise<MasterPromptVersionRow | null> {
  const conditionnel = p.expectedContent !== undefined;
  const r = await rows(
    `UPDATE ai_master_prompt_versions
        SET content = $2, content_sha256 = $3, updated_by = $4, updated_at = now()
      WHERE id = $1 AND status = 'DRAFT'${conditionnel ? ' AND content = $5' : ''}
      RETURNING *`,
    [p.id, p.content, contentSha256(p.content), p.userId, ...(conditionnel ? [p.expectedContent] : [])],
  );
  return r[0] ? toVersion(r[0]) : null;
}

/** Abandonne un brouillon (jamais activé, donc hors historique). */
export async function deleteDraft(id: number): Promise<boolean> {
  return (await rows(`DELETE FROM ai_master_prompt_versions WHERE id = $1 AND status = 'DRAFT' RETURNING id`, [id])).length === 1;
}

/**
 * Bascule de la version active d'un prompt — activation d'un brouillon
 * (`activate`) ou réactivation d'une ancienne version (`rollback`). Une
 * transaction ordonnée : verrou, contrôle du statut sous verrou, ancienne
 * active → ancienne (PREVIOUS), cible → active, journal. Rien n'est écrit
 * si la cible n'a pas (ou plus) le statut attendu.
 */
export async function switchActivePrompt(p: {
  environment: string; treatment: string; targetId: number; action: 'activate' | 'rollback';
  userId: number; userEmail: string | null; testSummary: string | null;
}): Promise<{ previous: MasterPromptVersionRow | null; current: MasterPromptVersionRow; activationId: number } | { refused: 'NOT_FOUND' | 'WRONG_STATUS'; status?: string }> {
  return pgClient.begin(async (tx) => {
    const sql = tx as unknown as Sql;
    await lock(sql, p.environment, p.treatment);
    const cible = (await rows(
      `SELECT * FROM ai_master_prompt_versions WHERE id = $1 AND environment = $2 AND treatment = $3 FOR UPDATE`,
      [p.targetId, p.environment, p.treatment], sql,
    ))[0];
    if (!cible) return { refused: 'NOT_FOUND' as const };
    const attendu = p.action === 'activate' ? 'DRAFT' : 'PREVIOUS';
    if (String(cible.status) !== attendu) return { refused: 'WRONG_STATUS' as const, status: String(cible.status) };

    const anciennes = await rows(
      `UPDATE ai_master_prompt_versions SET status = 'PREVIOUS', updated_at = now()
        WHERE environment = $1 AND treatment = $2 AND status = 'ACTIVE' AND id <> $3
        RETURNING *`,
      [p.environment, p.treatment, p.targetId], sql,
    );
    const promue = await rows(
      `UPDATE ai_master_prompt_versions
          SET status = 'ACTIVE', activated_by = $2, activated_at = now(),
              first_activated_at = COALESCE(first_activated_at, now()), updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [p.targetId, p.userId], sql,
    );
    const previous = anciennes[0] ? toVersion(anciennes[0]) : null;
    const current = toVersion(promue[0]);
    const journal = await rows(
      `INSERT INTO ai_master_prompt_activations
         (environment, treatment, action, from_version_id, from_version_number, to_version_id, to_version_number,
          user_id, user_email, test_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [p.environment, p.treatment, p.action, previous?.id ?? null, previous?.versionNumber ?? null,
       current.id, current.versionNumber, p.userId, p.userEmail, p.testSummary], sql,
    );
    return { previous, current, activationId: Number(journal[0].id) };
  }) as never;
}

// ── Tests du corpus ─────────────────────────────────────────────────────────

export async function insertTestRun(p: {
  promptVersionId: number; environment: string; treatment: string; contentSha256: string; requestedBy: number;
}): Promise<number> {
  const r = await rows(
    `INSERT INTO ai_master_prompt_test_runs (prompt_version_id, environment, treatment, content_sha256, status, requested_by)
     VALUES ($1, $2, $3, $4, 'RUNNING', $5) RETURNING id`,
    [p.promptVersionId, p.environment, p.treatment, p.contentSha256, p.requestedBy],
  );
  return Number(r[0].id);
}

export async function finishTestRun(id: number, r: {
  status: 'DONE' | 'ERROR'; total: number; passed: number; failed: number; failures: TestFailure[];
  details?: Record<string, unknown>; error?: string | null;
}): Promise<void> {
  await rows(
    `UPDATE ai_master_prompt_test_runs
        SET status = $2, scenarios_total = $3, scenarios_passed = $4, scenarios_failed = $5,
            failures = $6::jsonb, details = $7::jsonb, error = $8, finished_at = now()
      WHERE id = $1`,
    [id, r.status, r.total, r.passed, r.failed, JSON.stringify(r.failures), JSON.stringify(r.details ?? {}), r.error ?? null],
  );
}

export async function getTestRun(id: number): Promise<MasterPromptTestRunRow | null> {
  const r = await rows(`SELECT * FROM ai_master_prompt_test_runs WHERE id = $1`, [id]);
  return r[0] ? toRun(r[0]) : null;
}

/** Exécutions des versions demandées, la plus récente d'abord. */
export async function listTestRuns(versionIds: number[], limitPerVersion = 10): Promise<MasterPromptTestRunRow[]> {
  if (versionIds.length === 0) return [];
  return (await rows(
    `SELECT * FROM (
       SELECT r.*, ROW_NUMBER() OVER (PARTITION BY prompt_version_id ORDER BY started_at DESC, id DESC) AS rang
         FROM ai_master_prompt_test_runs r WHERE prompt_version_id = ANY($1::int[])
     ) x WHERE rang <= $2 ORDER BY started_at DESC, id DESC`,
    [versionIds, limitPerVersion],
  )).map(toRun);
}
