/**
 * Exécutions du corpus master en base (migration 0224) — CDC 15 §30, HC-06.
 *
 * Ce que garantit chaque type d'exécution (voir aussi `activation-guard.ts`) :
 *   · `replay` (CI, préprod, prod) : le TEXTE évalué se rend sur chaque
 *     branche (discriminant, sections, emplacements), les sorties
 *     enregistrées (synthétiques, D-08) passent la validation discriminée et
 *     les contrôles SERVEUR de la branche. Aucun appel modèle : ne dit RIEN
 *     de la façon dont le modèle réagit au texte.
 *   · `live` (préprod) : le modèle est RÉELLEMENT appelé par la passerelle,
 *     sur la version effective, pour le sous-ensemble critique ; ses sorties
 *     passent les mêmes contrôles et sont comparées aux attentes (D-17,
 *     « passage réel en préprod »). Exigé pour un texte master de version
 *     différent du fichier du dépôt.
 * `local` est enregistrable (poste de développement) mais jamais accepté
 * par la garde.
 */
import { pgClient } from '@/db';
import type { MasterCorpusResult } from './runner';

export type CorpusRunSource = 'ci' | 'preprod' | 'prod' | 'local';
export type CorpusRunMode = 'replay' | 'live';

export interface CorpusRunRow {
  id: number;
  configVersionId: number | null;
  treatment: string;
  masterPromptCode: string;
  masterPromptVersion: string;
  textSha256: string;
  textSource: 'config' | 'file';
  branchesRequired: string[];
  branchesPassed: string[];
  casesTotal: number;
  casesPassed: number;
  status: 'PASSED' | 'FAILED';
  source: CorpusRunSource;
  runMode: CorpusRunMode;
  environment: string | null;
  gitSha: string | null;
  createdAt: Date;
}

type Row = Record<string, unknown>;
const toRow = (r: Row): CorpusRunRow => ({
  id: Number(r.id),
  configVersionId: r.config_version_id == null ? null : Number(r.config_version_id),
  treatment: String(r.treatment),
  masterPromptCode: String(r.master_prompt_code),
  masterPromptVersion: String(r.master_prompt_version),
  textSha256: String(r.text_sha256),
  textSource: String(r.text_source) as 'config' | 'file',
  branchesRequired: (r.branches_required as string[] | null) ?? [],
  branchesPassed: (r.branches_passed as string[] | null) ?? [],
  casesTotal: Number(r.cases_total),
  casesPassed: Number(r.cases_passed),
  status: String(r.status) as 'PASSED' | 'FAILED',
  source: String(r.source) as CorpusRunSource,
  runMode: (r.run_mode ? String(r.run_mode) : 'replay') as CorpusRunMode,
  environment: r.environment == null ? null : String(r.environment),
  gitSha: r.git_sha == null ? null : String(r.git_sha),
  createdAt: new Date(String(r.created_at)),
});

/** La table 0224 existe-t-elle dans le schéma courant ? (absente : garde fermée, jamais ouverte.) */
export async function corpusTableReady(): Promise<boolean> {
  const rows = (await pgClient.unsafe(
    `SELECT 1 AS ok FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'ai_master_corpus_runs' LIMIT 1`,
  )) as unknown as Row[];
  return rows.length > 0;
}

export async function recordCorpusRun(
  r: MasterCorpusResult,
  meta: {
    configVersionId: number | null; source: CorpusRunSource; environment: string | null; gitSha: string | null;
    createdBy?: number | null; runMode?: CorpusRunMode;
  },
): Promise<number> {
  const version = r.textSource === 'config'
    ? `${r.masterPromptCode}@cfg${meta.configVersionId ?? ''}:${r.textSha256.slice(0, 12)}`
    : `${r.masterPromptCode}@file`;
  const [row] = (await pgClient.unsafe(
    `INSERT INTO ai_master_corpus_runs
       (config_version_id, treatment, master_prompt_code, master_prompt_version, text_sha256, text_source,
        branches_required, branches_passed, cases_total, cases_passed, status, source, run_mode, environment, git_sha, details, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)
     RETURNING id`,
    [meta.configVersionId, r.treatment, r.masterPromptCode, version, r.textSha256, r.textSource,
     r.branchesRequired, r.branchesPassed, r.casesTotal, r.casesPassed, r.status, meta.source, meta.runMode ?? 'replay',
     meta.environment, meta.gitSha, JSON.stringify({ cases: r.cases, failures: r.failures }), meta.createdBy ?? null] as never[],
  )) as unknown as Row[];
  return Number(row.id);
}

/**
 * Dernière exécution pour un master, une empreinte exacte et un mode, parmi
 * les sources admises (jamais `local` pour la garde).
 */
export async function latestCorpusRun(
  masterPromptCode: string, textSha256: string,
  opts: { mode?: CorpusRunMode; sources?: CorpusRunSource[] } = {},
): Promise<CorpusRunRow | null> {
  const rows = (await pgClient.unsafe(
    `SELECT * FROM ai_master_corpus_runs
      WHERE master_prompt_code = $1 AND text_sha256 = $2 AND run_mode = $3 AND source = ANY($4::text[])
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [masterPromptCode, textSha256, opts.mode ?? 'replay', opts.sources ?? ['ci', 'preprod', 'prod']] as never[],
  )) as unknown as Row[];
  return rows[0] ? toRow(rows[0]) : null;
}

/** Exécutions récentes (BO), toutes versions confondues. */
export async function listCorpusRuns(limit = 50): Promise<CorpusRunRow[]> {
  const rows = (await pgClient.unsafe(
    `SELECT * FROM ai_master_corpus_runs ORDER BY created_at DESC, id DESC LIMIT $1`, [limit] as never[],
  )) as unknown as Row[];
  return rows.map(toRow);
}
