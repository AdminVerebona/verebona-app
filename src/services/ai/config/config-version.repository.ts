/**
 * Persistance des versions de configuration IA — lot 54 (54C), ticket
 * « BO-IA — Refonte de la gestion des versions, restauration et export ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MODÈLE
 *
 *   · `ai_config_versions` : une ligne par version, ACTIVE (une seule par
 *     environnement — index unique partiel) ou INACTIVE ; suppression
 *     logique (`deleted_at`, jamais sur l'active — contrainte 0376).
 *   · `ai_config_revisions` : chaque sauvegarde effective, restauration,
 *     création ou duplication écrit une révision IMMUABLE portant
 *     l'instantané COMPLET (`config-snapshot.ts`). `current_revision_*` de la
 *     version désigne le dernier état enregistré.
 *   · `ai_config_entries` : copie de travail de la révision courante, réécrite
 *     dans la MÊME transaction (lue par les écrans et rapports existants).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ATOMICITÉ ET CONCURRENCE
 *
 * Toute écriture est UNE transaction, sérialisée par environnement (verrou
 * consultatif `ai_config_versions:<env>`, toujours pris AVANT celui d'un
 * prompt maître — même ordre que `master-prompt.repository`, aucun
 * interblocage) :
 *   · sauvegarde : révision attendue (`expectedRevision`) comparée sous
 *     verrou — une sauvegarde plus récente n'est jamais écrasée en silence
 *     (refus `REVISION_CONFLICT`) ;
 *   · activation : ancienne active → INACTIVE PUIS cible → ACTIVE, prompts
 *     maîtres de la révision appliqués, clé de cache incrémentée — tout ou
 *     rien : jamais d'environnement sans active ni de mélange de versions ;
 *   · une erreur à n'importe quelle étape annule tout (aucune configuration
 *     partielle).
 */
import { probeCount, schemaNotReadyMessage } from '@/lib/schema-readiness-log';
import { pgClient } from '@/db';
import { getAiEnvironment, type AiEnvironment } from './environment';
import { TREATMENTS, isTreatment, isRetiredTreatment, type Treatment } from './treatments';
import {
  emptyTreatmentConfig, promptArchitectureOf, isPromptArchitecture, masterPromptOf,
  DEFAULT_PROMPT_ARCHITECTURE, defaultPromptArchitectureFor,
  type ConfigVersion, type ConfigVersionWithEntries, type PromptArchitecture, type TreatmentConfig,
} from './config-types';
import type { ConfigVersionStatus } from './version-state-machine';
import {
  buildSnapshot, normalizeSnapshot, snapshotSha256, snapshotsEqual, sha256,
  type ConfigSnapshot, type MasterPromptRef,
} from './config-snapshot';
import type { MasterExecutionConfig } from '../master-prompts/structured-context';
import { normalizeOperationProfiles } from './operation-profiles';

type Row = Record<string, unknown>;
/** Sous-ensemble du client `postgres` (connexion ou transaction). */
export type SqlLike = { unsafe: (query: string, params?: never[]) => Promise<unknown> };

const q = async (sql: SqlLike, text: string, params: unknown[] = []): Promise<Row[]> =>
  (await sql.unsafe(text, params as never[])) as Row[];

const dateOrNull = (v: unknown): Date | null => (v == null ? null : new Date(String(v)));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

/** Refus fonctionnel du dépôt (traduit en 409/404 par les routes). */
export class ConfigVersionRefused extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'ConfigVersionRefused';
  }
}

function toVersion(r: Row): ConfigVersion {
  return {
    id: Number(r.id),
    uid: String(r.uid),
    environment: String(r.environment) as AiEnvironment,
    status: String(r.status) as ConfigVersionStatus,
    active: String(r.status) === 'ACTIVE',
    visibleNumber: numOrNull(r.visible_number),
    label: r.label == null ? null : String(r.label),
    description: r.description == null ? null : String(r.description),
    baseVersionId: numOrNull(r.base_version_id),
    isStale: false,
    createdBy: numOrNull(r.created_by),
    createdAt: new Date(String(r.created_at)),
    updatedAt: dateOrNull(r.updated_at),
    updatedBy: numOrNull(r.updated_by),
    validatedAt: dateOrNull(r.validated_at),
    activatedAt: dateOrNull(r.activated_at),
    archivedAt: dateOrNull(r.archived_at),
    deletedAt: dateOrNull(r.deleted_at),
    currentRevisionId: numOrNull(r.current_revision_id),
    currentRevisionNumber: numOrNull(r.current_revision_number),
    legacyStatus: r.legacy_status == null ? null : String(r.legacy_status),
    // Lot 86A (0726) : origine et cycle de candidate ; colonnes absentes → manuel.
    origin: r.origin === 'auto' ? 'auto' : 'manual',
    candidateState: r.candidate_state == null ? null : String(r.candidate_state),
    candidateReason: r.candidate_reason == null ? null : String(r.candidate_reason),
  };
}

function toEntry(r: Row): TreatmentConfig {
  return {
    treatment: String(r.treatment) as Treatment,
    prompt: String(r.prompt ?? ''),
    primaryModel: r.primary_model == null ? null : String(r.primary_model),
    fallback1: r.fallback_1 == null ? null : String(r.fallback_1),
    fallback2: r.fallback_2 == null ? null : String(r.fallback_2),
    reasoningPrimary: (r.reasoning_primary ?? null) as TreatmentConfig['reasoningPrimary'],
    reasoningFallback1: (r.reasoning_fallback_1 ?? null) as TreatmentConfig['reasoningFallback1'],
    reasoningFallback2: (r.reasoning_fallback_2 ?? null) as TreatmentConfig['reasoningFallback2'],
    maxOutputTokens: r.max_output_tokens == null ? null : Number(r.max_output_tokens),
    guardrails: (r.guardrails ?? []) as TreatmentConfig['guardrails'],
    triggers: (r.triggers ?? []) as TreatmentConfig['triggers'],
    cascade: (r.cascade ?? null) as TreatmentConfig['cascade'],
    promptArchitecture: promptArchitectureOf({
      treatment: r.treatment as Treatment,
      promptArchitecture: isPromptArchitecture(r.prompt_architecture) ? r.prompt_architecture : DEFAULT_PROMPT_ARCHITECTURE,
    }),
    masterPrompt: r.master_prompt == null || String(r.master_prompt).trim() === '' ? null : String(r.master_prompt),
    // Lot 85C (0710) : profils par opération ; colonne absente → aucun profil.
    operationProfiles: normalizeOperationProfiles(r.operation_profiles ?? null),
  };
}

const COLS = `v.id, v.uid, v.environment, v.status, v.visible_number, v.label, v.description, v.base_version_id,
              v.created_by, v.created_at, v.updated_at, v.updated_by, v.validated_at, v.activated_at,
              v.archived_at, v.deleted_at, v.current_revision_id, v.current_revision_number, v.legacy_status,
              to_jsonb(v)->>'origin' AS origin, to_jsonb(v)->>'candidate_state' AS candidate_state,
              to_jsonb(v)->>'candidate_reason' AS candidate_reason`;

// ── Révisions ───────────────────────────────────────────────────────────────

export type RevisionKind = 'migration' | 'create' | 'duplicate' | 'save' | 'restore' | 'master_prompt';

export interface ConfigRevision {
  id: number;
  versionId: number;
  revisionNumber: number;
  kind: RevisionKind;
  comment: string | null;
  restoredFromRevisionId: number | null;
  /** Numéro de la révision d'origine d'une restauration (même version), sinon `null`. */
  restoredFromRevisionNumber: number | null;
  sourceVersionId: number | null;
  createdBy: number | null;
  createdByEmail: string | null;
  createdAt: Date;
  snapshotSha256: string;
}

export interface ConfigRevisionWithSnapshot extends ConfigRevision {
  snapshot: ConfigSnapshot;
}

const REV_COLS = `r.id, r.version_id, r.revision_number, r.kind, r.comment, r.restored_from_revision_id,
                  r.source_version_id, r.created_by, r.created_by_email, r.created_at, r.snapshot_sha256,
                  o.revision_number AS restored_from_number`;

function toRevision(r: Row, snapshot?: ConfigSnapshot): ConfigRevision {
  const s = snapshot ?? (r.snapshot !== undefined ? normalizeSnapshot(r.snapshot) : null);
  return {
    id: Number(r.id),
    versionId: Number(r.version_id),
    revisionNumber: Number(r.revision_number),
    kind: String(r.kind) as RevisionKind,
    comment: r.comment == null ? null : String(r.comment),
    restoredFromRevisionId: numOrNull(r.restored_from_revision_id),
    restoredFromRevisionNumber: numOrNull(r.restored_from_number),
    sourceVersionId: numOrNull(r.source_version_id),
    createdBy: numOrNull(r.created_by),
    createdByEmail: r.created_by_email == null ? null : String(r.created_by_email),
    createdAt: new Date(String(r.created_at)),
    // Révisions de reprise : empreinte calculée à la lecture.
    snapshotSha256: r.snapshot_sha256 ? String(r.snapshot_sha256) : (s ? snapshotSha256(s) : ''),
  };
}

export async function listRevisions(versionId: number): Promise<ConfigRevision[]> {
  const rows = await q(pgClient as unknown as SqlLike,
    `SELECT ${REV_COLS}, r.snapshot
       FROM ai_config_revisions r
       LEFT JOIN ai_config_revisions o ON o.id = r.restored_from_revision_id
      WHERE r.version_id = $1 ORDER BY r.revision_number DESC`, [versionId]);
  return rows.map((r) => toRevision(r));
}

export async function getRevision(revisionId: number, sql: SqlLike = pgClient as unknown as SqlLike): Promise<ConfigRevisionWithSnapshot | null> {
  const rows = await q(sql,
    `SELECT ${REV_COLS}, r.snapshot
       FROM ai_config_revisions r
       LEFT JOIN ai_config_revisions o ON o.id = r.restored_from_revision_id
      WHERE r.id = $1`, [revisionId]);
  if (!rows[0]) return null;
  const snapshot = normalizeSnapshot(rows[0].snapshot);
  return { ...toRevision(rows[0], snapshot), snapshot };
}

// ── Lectures ────────────────────────────────────────────────────────────────

async function readEntries(versionId: number, sql: SqlLike = pgClient as unknown as SqlLike): Promise<{ entries: TreatmentConfig[]; retired: string[] }> {
  const architecture = (await hasPromptArchitectureColumn())
    ? 'prompt_architecture, master_prompt'
    : 'NULL::text AS prompt_architecture, NULL::text AS master_prompt';
  const all = await q(sql,
    `SELECT treatment, prompt, primary_model, fallback_1, fallback_2,
            reasoning_primary, reasoning_fallback_1, reasoning_fallback_2,
            max_output_tokens, guardrails, triggers, to_jsonb(e) -> 'operation_profiles' AS operation_profiles, cascade, ${architecture}
       FROM ai_config_entries e WHERE version_id = $1 ORDER BY treatment`, [versionId]);
  return {
    entries: all.filter((r) => isTreatment(String(r.treatment))).map(toEntry),
    retired: all.map((r) => String(r.treatment)).filter((t) => isRetiredTreatment(t)),
  };
}

/** Lignes des traitements opérationnels d'une version (T5 historique écarté). */
export async function getEntries(versionId: number): Promise<TreatmentConfig[]> {
  return (await readEntries(versionId)).entries;
}

/**
 * Version + configuration de son dernier état enregistré : lignes de la copie
 * de travail (écrites dans la même transaction que la révision courante) et
 * prompts maîtres figés dans cette révision ; + traitements retirés encore
 * présents en base (lot 49 : T5 lisible, jamais appliqué).
 */
async function withConfiguration(r: Row, sql: SqlLike = pgClient as unknown as SqlLike): Promise<ConfigVersionWithEntries> {
  const version = toVersion(r);
  const { entries, retired } = await readEntries(version.id, sql);
  let snapshot: ConfigSnapshot | null = null;
  if (r.snapshot !== undefined && r.snapshot !== null) snapshot = normalizeSnapshot(r.snapshot);
  else if (version.currentRevisionId) snapshot = (await getRevision(version.currentRevisionId, sql))?.snapshot ?? null;
  return {
    ...version,
    entries,
    masterPrompts: snapshot?.masterPrompts ?? {},
    ...(retired.length ? { retiredTreatments: retired } : {}),
  };
}

export async function getVersion(id: number): Promise<ConfigVersionWithEntries | null> {
  const rows = await q(pgClient as unknown as SqlLike,
    `SELECT ${COLS}, cr.snapshot FROM ai_config_versions v
       LEFT JOIN ai_config_revisions cr ON cr.id = v.current_revision_id
      WHERE v.id = $1 LIMIT 1`, [id]);
  return rows[0] ? withConfiguration(rows[0]) : null;
}

/** Version active de l'environnement, s'il y en a une. */
export async function getActiveVersion(
  environment: AiEnvironment = getAiEnvironment(),
): Promise<ConfigVersionWithEntries | null> {
  const rows = await q(pgClient as unknown as SqlLike,
    `SELECT ${COLS}, cr.snapshot FROM ai_config_versions v
       LEFT JOIN ai_config_revisions cr ON cr.id = v.current_revision_id
      WHERE v.environment = $1 AND v.status = 'ACTIVE' LIMIT 1`, [environment]);
  return rows[0] ? withConfiguration(rows[0]) : null;
}

/**
 * Version appliquée aux nouveaux démarrages : l'ACTIVE, dans tous les
 * environnements (lot 54 : plus de version « À tester » effective).
 */
export async function getEffectiveVersion(
  environment: AiEnvironment = getAiEnvironment(),
): Promise<ConfigVersionWithEntries | null> {
  return getActiveVersion(environment);
}

/** Configuration lue à l'exécution : version active + révision courante, en UNE requête. */
export interface RuntimeConfiguration {
  versionId: number;
  visibleNumber: number | null;
  revisionId: number | null;
  revisionNumber: number | null;
  entries: TreatmentConfig[];
  masterPrompts: ConfigSnapshot['masterPrompts'];
}

/**
 * Lecture d'exécution. Une seule instruction (version, révision courante et
 * lignes de la copie de travail, écrites ensemble par chaque sauvegarde) :
 * jamais une version et la révision ou les lignes d'une autre. Schéma
 * antérieur à 0376 (migration en échec) : repli sur la lecture historique,
 * pour que le produit ne retombe jamais sur la configuration du code par
 * simple absence d'une colonne.
 */
export async function getRuntimeConfiguration(
  environment: AiEnvironment = getAiEnvironment(),
): Promise<RuntimeConfiguration | null> {
  try {
    const rows = await q(pgClient as unknown as SqlLike,
      `SELECT v.id, v.visible_number, v.current_revision_id, v.current_revision_number, cr.snapshot -> 'masterPrompts' AS master_prompts,
              COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.treatment) FROM ai_config_entries e WHERE e.version_id = v.id), '[]'::jsonb) AS lignes
         FROM ai_config_versions v
         LEFT JOIN ai_config_revisions cr ON cr.id = v.current_revision_id
        WHERE v.environment = $1 AND v.status = 'ACTIVE' LIMIT 1`, [environment]);
    const r = rows[0];
    if (!r) return null;
    const lignes = (Array.isArray(r.lignes) ? r.lignes : []) as Row[];
    return {
      versionId: Number(r.id), visibleNumber: numOrNull(r.visible_number),
      revisionId: numOrNull(r.current_revision_id), revisionNumber: numOrNull(r.current_revision_number),
      entries: lignes.filter((l) => isTreatment(String(l.treatment))).map(toEntry),
      masterPrompts: normalizeSnapshot({ entries: [], masterPrompts: r.master_prompts ?? {} }).masterPrompts,
    };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== '42703' && code !== '42P01') throw e;
    const rows = await q(pgClient as unknown as SqlLike,
      `SELECT id, visible_number FROM ai_config_versions
        WHERE environment = $1 AND status IN ('ACTIVE', 'TO_TEST')
        ORDER BY (status = 'TO_TEST') DESC LIMIT 1`, [environment]);
    if (!rows[0]) return null;
    return {
      versionId: Number(rows[0].id), visibleNumber: numOrNull(rows[0].visible_number), revisionId: null, revisionNumber: null,
      entries: await getEntries(Number(rows[0].id)), masterPrompts: {},
    };
  }
}

/** Instantané d'une révision précise (exécution épinglée) ; immuable. */
export async function getRevisionConfiguration(revisionId: number): Promise<RuntimeConfiguration | null> {
  const rows = await q(pgClient as unknown as SqlLike,
    `SELECT r.id, r.revision_number, r.snapshot, v.id AS version_id, v.visible_number
       FROM ai_config_revisions r JOIN ai_config_versions v ON v.id = r.version_id
      WHERE r.id = $1`, [revisionId]);
  const r = rows[0];
  if (!r) return null;
  const s = normalizeSnapshot(r.snapshot);
  return {
    versionId: Number(r.version_id), visibleNumber: numOrNull(r.visible_number),
    revisionId: Number(r.id), revisionNumber: Number(r.revision_number),
    entries: s.entries, masterPrompts: s.masterPrompts,
  };
}

export interface VersionListItem extends ConfigVersion {
  /** Auteur de la dernière modification (e-mail), sinon de la création. */
  updatedByEmail: string | null;
}

export async function listVersions(
  environment: AiEnvironment = getAiEnvironment(),
  limit = 100,
  opts: { deleted?: 'exclude' | 'only' | 'include' } = {},
): Promise<VersionListItem[]> {
  const deleted = opts.deleted ?? 'exclude';
  const filtre = deleted === 'exclude' ? 'AND v.deleted_at IS NULL' : deleted === 'only' ? 'AND v.deleted_at IS NOT NULL' : '';
  const rows = await q(pgClient as unknown as SqlLike,
    `SELECT ${COLS}, u.email AS updated_by_email
       FROM ai_config_versions v
       LEFT JOIN users u ON u.id = COALESCE(v.updated_by, v.created_by)
      WHERE v.environment = $1 ${filtre}
      ORDER BY (v.status = 'ACTIVE') DESC, v.visible_number DESC NULLS LAST, v.created_at DESC
      LIMIT $2`, [environment, limit]);
  return rows.map((r) => ({ ...toVersion(r), updatedByEmail: r.updated_by_email == null ? null : String(r.updated_by_email) }));
}

// ── Prompts maîtres figés dans une révision ─────────────────────────────────

function executionOfRow(r: Row): MasterExecutionConfig | null {
  if (r.execution_mode == null) return null;
  return {
    mode: String(r.execution_mode) === 'STRUCTURED_CONTEXT' ? 'STRUCTURED_CONTEXT' : 'LEGACY_TEMPLATE',
    inputContractVersion: r.input_contract_version == null ? null : String(r.input_contract_version),
    outputContractVersion: r.output_contract_version == null ? null : String(r.output_contract_version),
    allowedTasks: Array.isArray(r.allowed_tasks) ? (r.allowed_tasks as unknown[]).map(String) : null,
  } as MasterExecutionConfig;
}

export function masterPromptRefOf(r: Row): MasterPromptRef {
  return {
    versionId: Number(r.id),
    versionNumber: Number(r.version_number),
    masterPromptCode: String(r.master_prompt_code),
    contentSha256: String(r.content_sha256),
    content: String(r.content ?? ''),
    execution: executionOfRow(r),
  };
}

async function masterPromptTablesExist(sql: SqlLike): Promise<boolean> {
  const r = await q(sql, `SELECT to_regclass('ai_master_prompt_versions') IS NOT NULL AS ok`);
  return Boolean(r[0]?.ok);
}

/** Prompts maîtres ACTIFS de l'environnement (dans la transaction donnée). */
export async function readActiveMasterPromptRefs(sql: SqlLike, environment: string): Promise<ConfigSnapshot['masterPrompts']> {
  if (!(await masterPromptTablesExist(sql))) return {};
  const rows = await q(sql,
    `SELECT * FROM ai_master_prompt_versions WHERE environment = $1 AND status = 'ACTIVE'`, [environment]);
  const out: ConfigSnapshot['masterPrompts'] = {};
  for (const r of rows) if (isTreatment(String(r.treatment))) out[String(r.treatment) as Treatment] = masterPromptRefOf(r);
  return out;
}

/** Versions de prompt maître sélectionnables (actives et anciennes, jamais un brouillon). */
export async function getMasterPromptVersionRef(versionId: number, sql: SqlLike = pgClient as unknown as SqlLike): Promise<(MasterPromptRef & { treatment: string; environment: string; status: string }) | null> {
  if (!(await masterPromptTablesExist(sql))) return null;
  const rows = await q(sql, `SELECT * FROM ai_master_prompt_versions WHERE id = $1`, [versionId]);
  if (!rows[0]) return null;
  return { ...masterPromptRefOf(rows[0]), treatment: String(rows[0].treatment), environment: String(rows[0].environment), status: String(rows[0].status) };
}

/**
 * Rend actives, dans la transaction, les versions de prompt maître figées dans
 * un instantané (activation d'une version, restauration d'une révision de la
 * version active). Même écriture que `switchActivePrompt` : ancienne active →
 * ancienne, cible → active, journal `ai_master_prompt_activations`. Une
 * référence absente ou dont l'empreinte diffère REFUSE tout (aucun mélange).
 * Rend les traitements effectivement basculés.
 */
export async function applyMasterPromptRefs(
  sql: SqlLike,
  environment: string,
  refs: ConfigSnapshot['masterPrompts'],
  actor: { userId: number | null; email: string | null; summary: string },
): Promise<Array<{ treatment: Treatment; versionNumber: number; masterPromptCode: string }>> {
  const voulus = Object.entries(refs).filter((e): e is [Treatment, MasterPromptRef] => Boolean(e[1]) && isTreatment(e[0]));
  if (voulus.length === 0 || !(await masterPromptTablesExist(sql))) return [];
  const bascules: Array<{ treatment: Treatment; versionNumber: number; masterPromptCode: string }> = [];
  for (const [treatment, ref] of voulus.sort(([a], [b]) => a.localeCompare(b))) {
    await sql.unsafe(`SELECT pg_advisory_xact_lock(hashtext('ai_master_prompt:' || $1 || ':' || $2))`, [environment, treatment] as never[]);
    const cible = (await q(sql,
      `SELECT * FROM ai_master_prompt_versions WHERE id = $1 AND environment = $2 AND treatment = $3 FOR UPDATE`,
      [ref.versionId, environment, treatment]))[0];
    if (!cible) {
      // Version de prompt disparue (base restaurée partiellement, nettoyage) :
      // l'instantané est AUTONOME — son texte est rétabli dans une nouvelle
      // version de prompt, rendue active, au lieu de bloquer le retour arrière.
      // Instantané incohérent (texte vide, code absent, empreinte fausse) : refus.
      if (!ref.content.trim() || !ref.masterPromptCode || sha256(ref.content.replace(/\r\n?/g, '\n')) !== ref.contentSha256) {
        throw new ConfigVersionRefused('MASTER_PROMPT_VERSION_MISSING',
          `Le prompt maître ${treatment} v${ref.versionNumber} figé dans cette configuration est introuvable : rien n'a été modifié.`);
      }
      const anciennes = await q(sql,
        `UPDATE ai_master_prompt_versions SET status = 'PREVIOUS', updated_at = now()
          WHERE environment = $1 AND treatment = $2 AND status = 'ACTIVE' RETURNING id, version_number`, [environment, treatment]);
      const exec = ref.execution && (await q(sql,
        `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
            AND table_name = 'ai_master_prompt_versions' AND column_name = 'execution_mode'`)).length > 0 ? ref.execution : null;
      const recree = (await q(sql,
        `INSERT INTO ai_master_prompt_versions
           (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin,
            created_by, updated_by, activated_by, activated_at, first_activated_at${exec ? ', execution_mode, input_contract_version, output_contract_version, allowed_tasks' : ''})
         VALUES ($1, $2, $3, (SELECT COALESCE(MAX(version_number), 0) + 1 FROM ai_master_prompt_versions WHERE environment = $1 AND treatment = $2),
                 'ACTIVE', $4, $5, 'admin', $6, $6, $6, now(), now()${exec ? ', $7, $8, $9, $10::jsonb' : ''})
         RETURNING id, version_number, master_prompt_code`,
        [environment, treatment, ref.masterPromptCode, ref.content, ref.contentSha256, actor.userId,
         ...(exec ? [exec.mode, exec.inputContractVersion, exec.outputContractVersion, exec.allowedTasks ? JSON.stringify(exec.allowedTasks) : null] : [])]))[0];
      await sql.unsafe(
        `INSERT INTO ai_master_prompt_activations
           (environment, treatment, action, from_version_id, from_version_number, to_version_id, to_version_number,
            user_id, user_email, test_summary)
         VALUES ($1, $2, 'rollback', $3, $4, $5, $6, $7, $8, $9)`,
        [environment, treatment, anciennes[0]?.id ?? null, anciennes[0]?.version_number ?? null, recree.id, recree.version_number,
         actor.userId, actor.email, `${actor.summary} — texte rétabli depuis l'instantané (v${ref.versionNumber} introuvable)`.slice(0, 500)] as never[],
      );
      bascules.push({ treatment, versionNumber: Number(recree.version_number), masterPromptCode: String(recree.master_prompt_code) });
      continue;
    }
    if (String(cible.content_sha256) !== ref.contentSha256) {
      throw new ConfigVersionRefused('MASTER_PROMPT_VERSION_MISMATCH',
        `Le texte du prompt maître ${treatment} v${ref.versionNumber} ne correspond plus à l'instantané : rien n'a été modifié.`);
    }
    if (String(cible.status) === 'ACTIVE') continue;
    if (String(cible.status) === 'DRAFT') {
      throw new ConfigVersionRefused('MASTER_PROMPT_IS_DRAFT',
        `Le prompt maître ${treatment} v${ref.versionNumber} est un brouillon : il ne peut pas être figé dans une configuration.`);
    }
    const anciennes = await q(sql,
      `UPDATE ai_master_prompt_versions SET status = 'PREVIOUS', updated_at = now()
        WHERE environment = $1 AND treatment = $2 AND status = 'ACTIVE' AND id <> $3 RETURNING id, version_number`,
      [environment, treatment, ref.versionId]);
    const promue = (await q(sql,
      `UPDATE ai_master_prompt_versions
          SET status = 'ACTIVE', activated_by = $2, activated_at = now(),
              first_activated_at = COALESCE(first_activated_at, now()), updated_at = now()
        WHERE id = $1 RETURNING id, version_number, master_prompt_code`, [ref.versionId, actor.userId]))[0];
    await sql.unsafe(
      `INSERT INTO ai_master_prompt_activations
         (environment, treatment, action, from_version_id, from_version_number, to_version_id, to_version_number,
          user_id, user_email, test_summary)
       VALUES ($1, $2, 'rollback', $3, $4, $5, $6, $7, $8, $9)`,
      [environment, treatment, anciennes[0]?.id ?? null, anciennes[0]?.version_number ?? null,
       promue.id, promue.version_number, actor.userId, actor.email, actor.summary.slice(0, 500)] as never[],
    );
    bascules.push({ treatment, versionNumber: Number(promue.version_number), masterPromptCode: String(promue.master_prompt_code) });
  }
  return bascules;
}

// ── Écritures (transactions) ────────────────────────────────────────────────

export async function lockEnvironment(sql: SqlLike, environment: string): Promise<void> {
  await sql.unsafe(`SELECT pg_advisory_xact_lock(hashtext('ai_config_versions:' || $1))`, [environment] as never[]);
}

/**
 * Clé de cache partagée incrémentée DANS la transaction (CFG-01) : toutes les
 * instances relisent la configuration dès le commit, jamais avant. Table
 * absente (0209) : rien (les instances suivent au TTL de 30 s).
 */
async function bumpCacheInTx(sql: SqlLike, reason: string): Promise<void> {
  const ok = (await q(sql, `SELECT to_regclass('verebona_cache_versions') IS NOT NULL AS ok`))[0]?.ok;
  if (!ok) return;
  await sql.unsafe(
    `INSERT INTO verebona_cache_versions (scope, version, last_reason, updated_at)
     VALUES ('ai-config', 1, $1, now())
     ON CONFLICT (scope) DO UPDATE
       SET version = verebona_cache_versions.version + 1, last_reason = EXCLUDED.last_reason, updated_at = now()`,
    [reason.slice(0, 60)] as never[],
  );
}

async function userEmail(sql: SqlLike, userId: number | null): Promise<string | null> {
  if (!userId) return null;
  const r = await q(sql, `SELECT email FROM users WHERE id = $1`, [userId]);
  return r[0]?.email == null ? null : String(r[0].email);
}

export async function lockedVersion(sql: SqlLike, versionId: number): Promise<Row> {
  const r = (await q(sql,
    `SELECT ${COLS} FROM ai_config_versions v WHERE v.id = $1 FOR UPDATE`, [versionId]))[0];
  if (!r) throw new ConfigVersionRefused('VERSION_NOT_FOUND', `Version ${versionId} introuvable.`);
  return r;
}

async function environmentOf(versionId: number): Promise<string> {
  const r = (await q(pgClient as unknown as SqlLike, `SELECT environment FROM ai_config_versions WHERE id = $1`, [versionId]))[0];
  if (!r) throw new ConfigVersionRefused('VERSION_NOT_FOUND', `Version ${versionId} introuvable.`);
  return String(r.environment);
}

/** Réécrit la copie de travail (`ai_config_entries`) d'après un instantané. */
async function materializeEntries(sql: SqlLike, versionId: number, entries: TreatmentConfig[], userId: number | null): Promise<void> {
  const presents = new Set(entries.map((e) => e.treatment));
  const absents = TREATMENTS.filter((t) => !presents.has(t));
  if (absents.length) {
    await sql.unsafe(`DELETE FROM ai_config_entries WHERE version_id = $1 AND treatment = ANY($2::text[])`,
      [versionId, absents] as never[]);
  }
  for (const e of entries) await upsertEntry(sql, versionId, e, userId);
}

/**
 * Révision courante d'une version, créée (n° suivant, « reprise ») d'après
 * ses lignes si elle n'en a pas encore (version insérée hors application).
 */
export async function ensureCurrentRevision(sql: SqlLike, r: Row): Promise<{ id: number; number: number; snapshot: ConfigSnapshot }> {
  const id = numOrNull(r.current_revision_id);
  if (id) {
    const rev = await getRevision(id, sql);
    if (rev) return { id, number: rev.revisionNumber, snapshot: rev.snapshot };
  }
  const versionId = Number(r.id);
  const { entries } = await readEntries(versionId, sql);
  const snapshot = buildSnapshot(entries,
    String(r.status) === 'ACTIVE' ? await readActiveMasterPromptRefs(sql, String(r.environment)) : {});
  const n = Number((await q(sql, `SELECT COALESCE(MAX(revision_number), 0) + 1 AS n FROM ai_config_revisions WHERE version_id = $1`, [versionId]))[0].n);
  const ins = (await q(sql,
    `INSERT INTO ai_config_revisions (version_id, revision_number, snapshot, snapshot_sha256, kind, comment, created_by)
     VALUES ($1, $2, $3::jsonb, $4, 'migration', 'Reprise automatique (version sans révision)', $5) RETURNING id`,
    [versionId, n, JSON.stringify(snapshot), snapshotSha256(snapshot), numOrNull(r.created_by)]))[0];
  await sql.unsafe(`UPDATE ai_config_versions SET current_revision_id = $2, current_revision_number = $3 WHERE id = $1`,
    [versionId, ins.id, n] as never[]);
  return { id: Number(ins.id), number: n, snapshot };
}

/** Révision courante garantie (créée « reprise » si absente). Rend son numéro. */
export async function ensureVersionRevision(versionId: number): Promise<number> {
  const environment = await environmentOf(versionId);
  return pgClient.begin(async (tx) => {
    const sql = tx as unknown as SqlLike;
    await lockEnvironment(sql, environment);
    return (await ensureCurrentRevision(sql, await lockedVersion(sql, versionId))).number;
  }) as never;
}

async function insertRevision(sql: SqlLike, p: {
  versionId: number; number: number; snapshot: ConfigSnapshot; kind: RevisionKind; comment: string | null;
  restoredFrom?: number | null; sourceVersionId?: number | null; userId: number | null; email: string | null;
}): Promise<number> {
  const r = (await q(sql,
    `INSERT INTO ai_config_revisions
       (version_id, revision_number, snapshot, snapshot_sha256, kind, comment, restored_from_revision_id,
        source_version_id, created_by, created_by_email)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [p.versionId, p.number, JSON.stringify(p.snapshot), snapshotSha256(p.snapshot), p.kind,
     p.comment ? p.comment.slice(0, 1000) : null, p.restoredFrom ?? null, p.sourceVersionId ?? null, p.userId, p.email]))[0];
  return Number(r.id);
}

export interface WriteOutcome {
  versionId: number;
  revisionId: number;
  revisionNumber: number;
  /** `false` : sauvegarde sans modification effective (aucune révision créée). */
  changed: boolean;
  active: boolean;
  /** Prompts maîtres basculés par l'écriture (invalidation de leurs caches). */
  masterPromptSwitches: Array<{ treatment: Treatment; versionNumber: number; masterPromptCode: string }>;
}

/**
 * Crée une version NON active : vide (configuration du code), copie d'une
 * version (sa révision courante) ou d'une révision précise (récupération
 * depuis l'historique, version supprimée comprise). Numéro suivant de
 * l'environnement, révision 1.
 */
export async function createVersion(p: {
  /** `null` : action du système (candidate automatique, lot 86A). */
  userId: number | null;
  label?: string | null;
  description?: string | null;
  environment?: AiEnvironment;
  source?: { versionId: number } | { revisionId: number } | { active: true } | null;
  /**
   * Lot 86A (VER-01) : candidate AUTOMATIQUE — créée non active, instantané
   * de la source modifié par `transform` dans la même transaction (aucune
   * version partielle visible), origine `auto`, état `CREATED`.
   */
  candidate?: { key: string; reason: string; campaignId: number | null; transform: (s: ConfigSnapshot) => ConfigSnapshot } | null;
}): Promise<ConfigVersionWithEntries> {
  const environment = p.environment ?? getAiEnvironment();
  const id = await pgClient.begin(async (tx) => {
    const sql = tx as unknown as SqlLike;
    await lockEnvironment(sql, environment);
    let snapshot: ConfigSnapshot = buildSnapshot(TREATMENTS.map((t) => emptyTreatmentConfig(t)));
    let kind: RevisionKind = 'create';
    let sourceVersionId: number | null = null;
    let restoredFrom: number | null = null;
    const src = p.source ?? null;
    if (src && 'versionId' in src) {
      const s = await lockedVersion(sql, src.versionId);
      if (String(s.environment) !== environment) throw new ConfigVersionRefused('VERSION_NOT_FOUND', `Version ${src.versionId} introuvable.`);
      const cur = await ensureCurrentRevision(sql, s);
      snapshot = cur.snapshot; kind = 'duplicate'; sourceVersionId = src.versionId; restoredFrom = cur.id;
    } else if (src && 'revisionId' in src) {
      const rev = await getRevision(src.revisionId, sql);
      if (!rev) throw new ConfigVersionRefused('REVISION_NOT_FOUND', `Révision ${src.revisionId} introuvable.`);
      if ((await environmentOf(rev.versionId)) !== environment) throw new ConfigVersionRefused('REVISION_NOT_FOUND', `Révision ${src.revisionId} introuvable.`);
      snapshot = rev.snapshot; kind = 'duplicate'; sourceVersionId = rev.versionId; restoredFrom = rev.id;
    } else if (src && 'active' in src) {
      const a = (await q(sql, `SELECT ${COLS} FROM ai_config_versions v WHERE v.environment = $1 AND v.status = 'ACTIVE' FOR UPDATE`, [environment]))[0];
      if (a) {
        const cur = await ensureCurrentRevision(sql, a);
        snapshot = cur.snapshot; kind = 'duplicate'; sourceVersionId = Number(a.id); restoredFrom = cur.id;
      }
    }
    if (p.candidate) snapshot = normalizeSnapshot(p.candidate.transform(snapshot));
    const n = Number((await q(sql,
      `SELECT COALESCE(MAX(visible_number), 0) + 1 AS n FROM ai_config_versions WHERE environment = $1`, [environment]))[0].n);
    const v = (await q(sql,
      `INSERT INTO ai_config_versions (environment, status, visible_number, label, description, base_version_id, created_by, updated_by)
       VALUES ($1, 'INACTIVE', $2, $3, $4, $5, $6, $6) RETURNING id`,
      [environment, n, p.label ?? null, p.description ?? null, sourceVersionId, p.userId]))[0];
    const versionId = Number(v.id);
    if (p.candidate) {
      await sql.unsafe(
        `UPDATE ai_config_versions SET origin = 'auto', candidate_state = 'CREATED', candidate_key = $2, candidate_reason = $3,
                candidate_campaign_id = $4, candidate_base_revision_id = $5 WHERE id = $1`,
        [versionId, p.candidate.key, p.candidate.reason, p.candidate.campaignId, restoredFrom] as never[]);
    }
    const email = await userEmail(sql, p.userId);
    const revId = await insertRevision(sql, {
      versionId, number: 1, snapshot, kind, userId: p.userId, email, sourceVersionId, restoredFrom,
      comment: p.candidate ? `Candidate automatique : ${p.candidate.reason}`.slice(0, 500)
        : kind === 'create' ? 'Création de la version' : `Copie de la version ${sourceVersionId}`,
    });
    await materializeEntries(sql, versionId, snapshot.entries, p.userId);
    await sql.unsafe(`UPDATE ai_config_versions SET current_revision_id = $2, current_revision_number = 1 WHERE id = $1`,
      [versionId, revId] as never[]);
    return versionId;
  });
  return (await getVersion(id))!;
}

/**
 * Compatibilité (tests, appelants antérieurs) : crée une version non active
 * copiée de l'active (ou vide sans active).
 */
export async function createDraft(
  userId: number,
  label: string | null = null,
  environment: AiEnvironment = getAiEnvironment(),
): Promise<ConfigVersionWithEntries> {
  return createVersion({ userId, label, environment, source: { active: true } });
}

/**
 * Enregistre un instantané COMPLET dans une version (sauvegarde ou
 * restauration). Sous verrou : version existante et non supprimée, révision
 * attendue respectée (`expectedRevision`, si fourni), puis révision n+1,
 * copie de travail, prompts maîtres et clé de cache si la version est
 * active. `kind = 'save'` sans modification effective : rien n'est écrit.
 */
export async function writeSnapshot(p: {
  versionId: number;
  /** Calcule l'instantané à écrire à partir de l'instantané courant (sous verrou). */
  next: (current: ConfigSnapshot) => ConfigSnapshot;
  kind: 'save' | 'restore' | 'master_prompt';
  expectedRevision?: number | null;
  comment?: string | null;
  restoredFrom?: number | null;
  userId: number;
  label?: string | null;
  description?: string | null;
  /** Contrôle final, sous verrou, de l'instantané à écrire (lève pour refuser). */
  check?: (next: ConfigSnapshot, current: ConfigSnapshot, active: boolean) => void;
}): Promise<WriteOutcome> {
  const environment = await environmentOf(p.versionId);
  return pgClient.begin(async (tx) => {
    const sql = tx as unknown as SqlLike;
    await lockEnvironment(sql, environment);
    const r = await lockedVersion(sql, p.versionId);
    if (r.deleted_at != null) {
      throw new ConfigVersionRefused('VERSION_DELETED', 'Cette version a été supprimée : restaurez-la dans la liste avant de la modifier.');
    }
    const cur = await ensureCurrentRevision(sql, r);
    if (p.expectedRevision != null && p.expectedRevision !== cur.number) {
      throw new ConfigVersionRefused('REVISION_CONFLICT',
        `La version a été enregistrée entre-temps (révision ${cur.number}, vous éditiez la révision ${p.expectedRevision}). `
        + 'Rechargez-la : vos modifications non enregistrées ne sont pas appliquées.',
        { currentRevision: cur.number, expectedRevision: p.expectedRevision });
    }
    const active = String(r.status) === 'ACTIVE';
    let next = normalizeSnapshot(p.next(cur.snapshot));
    // Version active : les prompts maîtres non pilotés explicitement suivent
    // ceux qui s'exécutent (l'instantané de l'active décrit ce qui tourne).
    if (active && p.kind !== 'restore') {
      const enService = await readActiveMasterPromptRefs(sql, environment);
      next = buildSnapshot(next.entries, { ...enService, ...next.masterPrompts });
    }
    p.check?.(next, cur.snapshot, active);
    const meta = (p.label !== undefined && p.label !== (r.label ?? null)) || (p.description !== undefined && p.description !== (r.description ?? null));
    if (p.kind === 'save' && snapshotsEqual(next, cur.snapshot)) {
      if (meta) {
        await sql.unsafe(`UPDATE ai_config_versions SET label = $2, description = $3, updated_at = now(), updated_by = $4 WHERE id = $1`,
          [p.versionId, p.label === undefined ? r.label : p.label, p.description === undefined ? r.description : p.description, p.userId] as never[]);
      }
      return { versionId: p.versionId, revisionId: cur.id, revisionNumber: cur.number, changed: false, active, masterPromptSwitches: [] };
    }
    const email = await userEmail(sql, p.userId);
    const number = cur.number + 1;
    const revisionId = await insertRevision(sql, {
      versionId: p.versionId, number, snapshot: next, kind: p.kind, comment: p.comment ?? null,
      restoredFrom: p.restoredFrom ?? null, userId: p.userId, email,
    });
    await materializeEntries(sql, p.versionId, next.entries, p.userId);
    await sql.unsafe(
      `UPDATE ai_config_versions
          SET current_revision_id = $2, current_revision_number = $3, updated_at = now(), updated_by = $4,
              label = $5, description = $6
        WHERE id = $1`,
      [p.versionId, revisionId, number, p.userId,
       p.label === undefined ? r.label : p.label, p.description === undefined ? r.description : p.description] as never[],
    );
    let switches: WriteOutcome['masterPromptSwitches'] = [];
    if (active) {
      switches = await applyMasterPromptRefs(sql, environment, next.masterPrompts, {
        userId: p.userId, email, summary: `Configuration IA v${r.visible_number ?? p.versionId} r${number} (${p.kind === 'restore' ? 'restauration' : 'enregistrement'})`,
      });
      await bumpCacheInTx(sql, `cfg:${p.kind}:${p.versionId}:r${number}`);
    }
    return { versionId: p.versionId, revisionId, revisionNumber: number, changed: true, active, masterPromptSwitches: switches };
  }) as Promise<WriteOutcome>;
}

/**
 * Prompt maître activé depuis « Prompts maîtres » : nouvelle révision de la
 * version ACTIVE (dans la transaction de la bascule du prompt), qui fige les
 * prompts désormais en service. Sans version active : rien.
 */
export async function recordMasterPromptRevisionInTx(sql: SqlLike, environment: string, p: {
  userId: number; comment: string;
}): Promise<{ versionId: number; revisionNumber: number } | null> {
  if (!(await q(sql, `SELECT to_regclass('ai_config_revisions') IS NOT NULL AS ok`))[0]?.ok) return null;
  const r = (await q(sql, `SELECT ${COLS} FROM ai_config_versions v WHERE v.environment = $1 AND v.status = 'ACTIVE' FOR UPDATE`, [environment]))[0];
  if (!r) return null;
  const cur = await ensureCurrentRevision(sql, r);
  const next = buildSnapshot(cur.snapshot.entries, { ...cur.snapshot.masterPrompts, ...(await readActiveMasterPromptRefs(sql, environment)) });
  if (snapshotsEqual(next, cur.snapshot)) return { versionId: Number(r.id), revisionNumber: cur.number };
  const number = cur.number + 1;
  const revisionId = await insertRevision(sql, {
    versionId: Number(r.id), number, snapshot: next, kind: 'master_prompt', comment: p.comment,
    userId: p.userId, email: await userEmail(sql, p.userId),
  });
  await sql.unsafe(
    `UPDATE ai_config_versions SET current_revision_id = $2, current_revision_number = $3, updated_at = now(), updated_by = $4 WHERE id = $1`,
    [Number(r.id), revisionId, number, p.userId] as never[],
  );
  await bumpCacheInTx(sql, `cfg:master_prompt:${String(r.id)}:r${number}`);
  return { versionId: Number(r.id), revisionNumber: number };
}

/**
 * Active une version (préproduction : « Activer en préproduction »). Une
 * transaction : verrou de l'environnement, ancienne active → INACTIVE, cible
 * → ACTIVE (dernier état enregistré), prompts maîtres de sa révision
 * appliqués, clé de cache. Les exécutions déjà démarrées gardent leur
 * révision (épinglée au démarrage).
 */
export async function activateVersion(
  versionId: number, userId: number | null, check?: (r: { snapshot: ConfigSnapshot; previouslyActivated: boolean }) => void,
  /** Lot 86A (VER-01) : activation AUTOMATIQUE d'une candidate qualifiée — vérifiée sous verrou, état ACTIVATED dans la transaction. */
  opts: { candidate?: boolean } = {},
): Promise<{
  previousId: number | null; alreadyActive: boolean; revisionNumber: number;
  masterPromptSwitches: WriteOutcome['masterPromptSwitches'];
}> {
  const environment = await environmentOf(versionId);
  return pgClient.begin(async (tx) => {
    const sql = tx as unknown as SqlLike;
    await lockEnvironment(sql, environment);
    return activateVersionInTx(sql, environment, versionId, userId, { check, candidate: opts.candidate });
  }) as never;
}

/**
 * Activation DANS une transaction déjà ouverte, verrou de l'environnement
 * déjà pris (lot 86B : import global et retour arrière atomiques — la
 * création de la version importée, son activation, la remise à zéro des
 * interventions et le journal tiennent dans la même transaction).
 */
export async function activateVersionInTx(sql: SqlLike, environment: string, versionId: number, userId: number | null, opts: {
  check?: (r: { snapshot: ConfigSnapshot; previouslyActivated: boolean }) => void;
  summary?: string;
  /** Lot 86A (VER-01) : activation AUTOMATIQUE d'une candidate qualifiée — vérifiée sous verrou, état ACTIVATED dans la transaction. */
  candidate?: boolean;
} = {}): Promise<{
  previousId: number | null; alreadyActive: boolean; revisionId: number; revisionNumber: number;
  masterPromptSwitches: WriteOutcome['masterPromptSwitches'];
}> {
  const r = await lockedVersion(sql, versionId);
  if (String(r.environment) !== environment) throw new ConfigVersionRefused('VERSION_NOT_FOUND', `Version ${versionId} introuvable.`);
  if (r.deleted_at != null) {
    throw new ConfigVersionRefused('VERSION_DELETED', 'Cette version a été supprimée : restaurez-la dans la liste avant de l’activer.');
  }
  const cur = await ensureCurrentRevision(sql, r);
  if (String(r.status) === 'ACTIVE') {
    return { previousId: null, alreadyActive: true, revisionId: cur.id, revisionNumber: cur.number, masterPromptSwitches: [] };
  }
  if (opts.candidate && (r.origin !== 'auto' || r.candidate_state !== 'QUALIFIED')) {
    throw new ConfigVersionRefused('CANDIDATE_NOT_QUALIFIED',
      `Version ${versionId} : seule une candidate automatique QUALIFIÉE peut être activée automatiquement (origine ${String(r.origin ?? 'manual')}, état ${String(r.candidate_state ?? 'aucun')}).`);
  }
  opts.check?.({ snapshot: cur.snapshot, previouslyActivated: r.activated_at != null });
  if (opts.candidate) await sql.unsafe(`UPDATE ai_config_versions SET candidate_state = 'ACTIVATED' WHERE id = $1`, [versionId] as never[]);
  const anciennes = await q(sql,
    `UPDATE ai_config_versions SET status = 'INACTIVE', updated_at = now()
      WHERE environment = $1 AND status = 'ACTIVE' AND id <> $2 RETURNING id`, [environment, versionId]);
  await sql.unsafe(
    `UPDATE ai_config_versions SET status = 'ACTIVE', activated_by = $2, activated_at = now(), updated_at = now() WHERE id = $1`,
    [versionId, userId] as never[],
  );
  const email = await userEmail(sql, userId);
  const switches = await applyMasterPromptRefs(sql, environment, cur.snapshot.masterPrompts, {
    userId, email, summary: opts.summary ?? `Activation de la configuration IA v${r.visible_number ?? versionId} r${cur.number}`,
  });
  await bumpCacheInTx(sql, `cfg:activate:${versionId}:r${cur.number}`);
  return {
    previousId: anciennes[0] ? Number(anciennes[0].id) : null, alreadyActive: false,
    revisionId: cur.id, revisionNumber: cur.number, masterPromptSwitches: switches,
  };
}

/** Lot 86A : état d'une candidate automatique (jamais sur une version manuelle). */
export async function setCandidateState(versionId: number, state: 'QUALIFYING' | 'QUALIFIED' | 'REFUSED' | 'INCONCLUSIVE' | 'NOT_CHOSEN', reason?: string | null): Promise<void> {
  await pgClient.unsafe(
    `UPDATE ai_config_versions SET candidate_state = $2, candidate_reason = COALESCE($3, candidate_reason), updated_at = now()
      WHERE id = $1 AND origin = 'auto' AND candidate_state IS DISTINCT FROM 'ACTIVATED'`,
    [versionId, state, reason ?? null] as never[]);
}

/** Lot 86A : dernière candidate automatique portant cette clé de proposition. */
export async function findCandidateByKey(environment: string, key: string): Promise<{ id: number; state: string | null; createdAt: Date } | null> {
  try {
    const r = (await q(pgClient as unknown as SqlLike,
      `SELECT id, candidate_state, created_at FROM ai_config_versions WHERE environment = $1 AND candidate_key = $2 ORDER BY id DESC LIMIT 1`, [environment, key]))[0];
    return r ? { id: Number(r.id), state: r.candidate_state == null ? null : String(r.candidate_state), createdAt: new Date(String(r.created_at)) } : null;
  } catch (e) {
    if ((e as { code?: string })?.code === '42703') return null;
    throw e;
  }
}

/**
 * Lot 86B — crée, DANS la transaction (verrou pris), une version NON active
 * portant un instantané complet (version importée) : numéro suivant de
 * l'environnement, révision 1 (`create`, commentaire explicite), copie de
 * travail. Rend la version et sa révision.
 */
export async function insertVersionWithSnapshotInTx(sql: SqlLike, p: {
  environment: string; label: string | null; description: string | null; snapshot: ConfigSnapshot; userId: number; comment: string;
}): Promise<{ versionId: number; revisionId: number; visibleNumber: number }> {
  const n = Number((await q(sql,
    `SELECT COALESCE(MAX(visible_number), 0) + 1 AS n FROM ai_config_versions WHERE environment = $1`, [p.environment]))[0].n);
  const v = (await q(sql,
    `INSERT INTO ai_config_versions (environment, status, visible_number, label, description, created_by, updated_by)
     VALUES ($1, 'INACTIVE', $2, $3, $4, $5, $5) RETURNING id`,
    [p.environment, n, p.label, p.description, p.userId]))[0];
  const versionId = Number(v.id);
  const snapshot = normalizeSnapshot(p.snapshot);
  const revisionId = await insertRevision(sql, {
    versionId, number: 1, snapshot, kind: 'create', userId: p.userId, email: await userEmail(sql, p.userId), comment: p.comment,
  });
  await materializeEntries(sql, versionId, snapshot.entries, p.userId);
  await sql.unsafe(`UPDATE ai_config_versions SET current_revision_id = $2, current_revision_number = 1 WHERE id = $1`,
    [versionId, revisionId] as never[]);
  return { versionId, revisionId, visibleNumber: n };
}

/**
 * Lot 86B — ramène, DANS la transaction, une version à l'instantané d'une de
 * ses révisions (retour arrière d'un import : la configuration antérieure
 * exacte). Révision courante déjà identique : rien. Sinon révision n+1
 * `restore` (l'historique n'est jamais réécrit). Rend la révision courante.
 */
export async function restoreRevisionInTx(sql: SqlLike, versionId: number, revisionId: number, userId: number, comment: string): Promise<{ revisionId: number; revisionNumber: number; restored: boolean }> {
  const r = await lockedVersion(sql, versionId);
  const cur = await ensureCurrentRevision(sql, r);
  if (cur.id === revisionId) return { revisionId: cur.id, revisionNumber: cur.number, restored: false };
  const rev = await getRevision(revisionId, sql);
  if (!rev || rev.versionId !== versionId) throw new ConfigVersionRefused('REVISION_NOT_FOUND', `Révision ${revisionId} introuvable pour cette version.`);
  if (snapshotsEqual(rev.snapshot, cur.snapshot)) return { revisionId: cur.id, revisionNumber: cur.number, restored: false };
  const number = cur.number + 1;
  const id = await insertRevision(sql, {
    versionId, number, snapshot: rev.snapshot, kind: 'restore', comment, restoredFrom: rev.id, userId, email: await userEmail(sql, userId),
  });
  await materializeEntries(sql, versionId, rev.snapshot.entries, userId);
  await sql.unsafe(
    `UPDATE ai_config_versions SET current_revision_id = $2, current_revision_number = $3, updated_at = now(), updated_by = $4 WHERE id = $1`,
    [versionId, id, number, userId] as never[],
  );
  return { revisionId: id, revisionNumber: number, restored: true };
}

/**
 * Lot 86B — version de prompt maître de l'environnement portant EXACTEMENT
 * ce texte (empreinte) et cette configuration d'exécution, sinon créée
 * (statut « ancienne », origine `admin`, numéro suivant) DANS la transaction.
 * L'activation de la configuration la rend active (`applyMasterPromptRefs`).
 */
export async function findOrCreateMasterPromptVersionInTx(sql: SqlLike, environment: string, treatment: Treatment, ref: {
  masterPromptCode: string; content: string; contentSha256: string; execution: MasterExecutionConfig | null;
}, userId: number): Promise<MasterPromptRef> {
  if (!(await masterPromptTablesExist(sql))) {
    throw new ConfigVersionRefused('MASTER_PROMPT_TABLES_MISSING', 'Les tables des prompts maîtres sont absentes : import impossible.');
  }
  await sql.unsafe(`SELECT pg_advisory_xact_lock(hashtext('ai_master_prompt:' || $1 || ':' || $2))`, [environment, treatment] as never[]);
  const execCol = (await q(sql,
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
        AND table_name = 'ai_master_prompt_versions' AND column_name = 'execution_mode'`)).length > 0;
  const candidats = await q(sql,
    `SELECT * FROM ai_master_prompt_versions
      WHERE environment = $1 AND treatment = $2 AND content_sha256 = $3 AND status <> 'DRAFT'
      ORDER BY (status = 'ACTIVE') DESC, version_number DESC`, [environment, treatment, ref.contentSha256]);
  const signature = (e: MasterExecutionConfig | null) => JSON.stringify(e ? { m: e.mode, i: e.inputContractVersion, o: e.outputContractVersion, t: e.allowedTasks } : null);
  const voulu = ref.execution && ref.execution.mode === 'STRUCTURED_CONTEXT' ? ref.execution : null;
  const trouve = candidats.find((c) => String(c.master_prompt_code) === ref.masterPromptCode
    && (!execCol || signature(executionOfRow(c)?.mode === 'STRUCTURED_CONTEXT' ? executionOfRow(c) : null) === signature(voulu)));
  if (trouve) return masterPromptRefOf(trouve);
  const exec = execCol && voulu ? voulu : null;
  const cree = (await q(sql,
    `INSERT INTO ai_master_prompt_versions
       (environment, treatment, master_prompt_code, version_number, status, content, content_sha256, origin,
        created_by, updated_by${exec ? ', execution_mode, input_contract_version, output_contract_version, allowed_tasks' : ''})
     VALUES ($1, $2, $3, (SELECT COALESCE(MAX(version_number), 0) + 1 FROM ai_master_prompt_versions WHERE environment = $1 AND treatment = $2),
             'PREVIOUS', $4, $5, 'admin', $6, $6${exec ? ', $7, $8, $9, $10::jsonb' : ''})
     RETURNING *`,
    [environment, treatment, ref.masterPromptCode, ref.content, ref.contentSha256, userId,
     ...(exec ? [exec.mode, exec.inputContractVersion, exec.outputContractVersion, exec.allowedTasks ? JSON.stringify(exec.allowedTasks) : null] : [])]))[0];
  return masterPromptRefOf(cree);
}

/** Suppression LOGIQUE d'une version non active (révisions conservées). */
export async function deleteVersion(versionId: number, userId: number): Promise<{ alreadyDeleted: boolean }> {
  const environment = await environmentOf(versionId);
  return pgClient.begin(async (tx) => {
    const sql = tx as unknown as SqlLike;
    await lockEnvironment(sql, environment);
    const r = await lockedVersion(sql, versionId);
    if (String(r.status) === 'ACTIVE') {
      throw new ConfigVersionRefused('ACTIVE_VERSION_UNDELETABLE',
        'La version active ne peut pas être supprimée : activez d’abord une autre version.');
    }
    if (r.deleted_at != null) return { alreadyDeleted: true };
    await ensureCurrentRevision(sql, r);
    await sql.unsafe(`UPDATE ai_config_versions SET deleted_at = now(), deleted_by = $2, updated_at = now() WHERE id = $1`,
      [versionId, userId] as never[]);
    return { alreadyDeleted: false };
  }) as never;
}

/** Remet une version supprimée dans la liste (NON active : aucune activation implicite). */
export async function undeleteVersion(versionId: number, userId: number): Promise<void> {
  const environment = await environmentOf(versionId);
  await pgClient.begin(async (tx) => {
    const sql = tx as unknown as SqlLike;
    await lockEnvironment(sql, environment);
    await lockedVersion(sql, versionId);
    await sql.unsafe(`UPDATE ai_config_versions SET deleted_at = NULL, deleted_by = NULL, updated_at = now(), updated_by = $2 WHERE id = $1`,
      [versionId, userId] as never[]);
  });
}

// ── Compatibilité : écriture d'une ligne (route historique par traitement) ──

/**
 * Enregistre la configuration d'UN traitement (route historique) : une
 * révision, comme toute sauvegarde. Plus aucune restriction de statut : la
 * version active est modifiable (lot 54).
 */
export async function saveEntry(
  versionId: number,
  config: TreatmentConfig,
  userId: number,
  expectedRevision?: number | null,
): Promise<WriteOutcome> {
  if (!isTreatment(String(config.treatment))) {
    throw new Error(`[config] Traitement « ${String(config.treatment)} » inconnu ou retiré : aucune ligne de configuration n'est créée.`);
  }
  const architecture = promptArchitectureOf(config);
  await promptArchitectureInsert(architecture, masterPromptOf(config), undefined, config.treatment);
  return writeSnapshot({
    versionId, userId, kind: 'save', expectedRevision: expectedRevision ?? null,
    comment: `Enregistrement ${config.treatment}`,
    next: (cur) => buildSnapshot([...cur.entries.filter((e) => e.treatment !== config.treatment), config], cur.masterPrompts),
  });
}

// ── Architecture et texte master (CDC 15 D-03, D-04, migration 0220) ────────

/** Colonnes de la migration 0220. */
export const CONFIG_MASTER_COLUMNS = ['prompt_architecture', 'master_prompt'] as const;

const RECONTROLE_MS = 5 * 60_000;
let architectureColumn: { ready: boolean; checkedAt: number } | null = null;
let absenceSignalee = false;

/** Les colonnes 0220 existent-elles (toutes) ? Ne lève jamais : illisible = absentes. */
export async function hasPromptArchitectureColumn(sql: SqlLike = pgClient as unknown as SqlLike): Promise<boolean> {
  const e = architectureColumn;
  if (e && (e.ready || Date.now() - e.checkedAt < RECONTROLE_MS)) return e.ready;
  let ready = false;
  let trouvees: number | null = null;
  let erreur: unknown;
  try {
    const rows = (await sql.unsafe(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'ai_config_entries' AND column_name = ANY($1::text[])`,
      [[...CONFIG_MASTER_COLUMNS]] as never[],
    )) as Array<{ n: number }>;
    trouvees = probeCount(rows); // lot 75A : résultat inexploitable = inconnu, pas 0
    ready = trouvees === CONFIG_MASTER_COLUMNS.length;
  } catch (e) {
    ready = false;
    erreur = e;
  }
  architectureColumn = { ready, checkedAt: Date.now() };
  if (!ready && !absenceSignalee) {
    absenceSignalee = true;
    console.error(schemaNotReadyMessage({
      scope: '[config]', migration: '0220', expected: CONFIG_MASTER_COLUMNS.map((c) => `ai_config_entries.${c}`),
      found: trouvees, error: erreur,
      consequence: 'Toutes les lignes sont lues en « steps » sans texte master ; bascule et texte master refusés (CDC 15 D-03, D-04) ; appliquer src/db/migrations/0220_*.sql.',
    }));
  }
  return ready;
}

/** Réservé aux tests. */
export function __resetPromptArchitectureColumnForTests(): void {
  architectureColumn = null;
  absenceSignalee = false;
}

/**
 * Les colonnes 0220 doivent-elles figurer dans l'INSERT ? Refuse `master` ou
 * un texte master si elles manquent — AVANT toute écriture.
 */
export async function promptArchitectureInsert(
  arch: PromptArchitecture, masterPrompt: string | null, sql: SqlLike = pgClient as unknown as SqlLike,
  treatment?: Treatment,
): Promise<{ column: boolean }> {
  const column = await hasPromptArchitectureColumn(sql);
  const parDefaut = treatment ? defaultPromptArchitectureFor(treatment) : DEFAULT_PROMPT_ARCHITECTURE;
  if (!column && (arch !== parDefaut || masterPrompt !== null)) {
    throw new Error(
      '[config] Architecture « master » ou texte master impossible à enregistrer : les colonnes '
      + '`ai_config_entries.prompt_architecture` / `master_prompt` n\'existent pas (migration 0220 non appliquée, CDC 15 D-04).',
    );
  }
  return { column };
}

/** Écriture d'une ligne de la copie de travail (exportée pour les tests de schéma 0220). */
export async function writeEntryRow(sql: SqlLike, versionId: number, config: TreatmentConfig, userId: number | null): Promise<void> {
  return upsertEntry(sql, versionId, config, userId);
}

async function upsertEntry(sql: SqlLike, versionId: number, config: TreatmentConfig, userId: number | null): Promise<void> {
  // Lot 49 : un traitement retiré (T5) ou inconnu n'entre jamais dans une version.
  if (!isTreatment(String(config.treatment))) {
    throw new Error(`[config] Traitement « ${String(config.treatment)} » inconnu ou retiré : aucune ligne de configuration n'est créée.`);
  }
  const c = config;
  const architecture = promptArchitectureOf(c);
  const masterPrompt = masterPromptOf(c);
  const { column } = await promptArchitectureInsert(architecture, masterPrompt, sql, c.treatment);
  await sql.unsafe(
    `INSERT INTO ai_config_entries (
       version_id, treatment, prompt, primary_model, fallback_1, fallback_2,
       reasoning_primary, reasoning_fallback_1, reasoning_fallback_2,
       max_output_tokens, guardrails, triggers, cascade, updated_by, updated_at${column ? ', prompt_architecture, master_prompt' : ''})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, NOW()${column ? ', $15, $16' : ''})
     ON CONFLICT (version_id, treatment) DO UPDATE SET
       prompt = EXCLUDED.prompt,
       primary_model = EXCLUDED.primary_model,
       fallback_1 = EXCLUDED.fallback_1,
       fallback_2 = EXCLUDED.fallback_2,
       reasoning_primary = EXCLUDED.reasoning_primary,
       reasoning_fallback_1 = EXCLUDED.reasoning_fallback_1,
       reasoning_fallback_2 = EXCLUDED.reasoning_fallback_2,
       max_output_tokens = EXCLUDED.max_output_tokens,
       guardrails = EXCLUDED.guardrails,
       triggers = EXCLUDED.triggers,
       cascade = EXCLUDED.cascade,${column ? '\n       prompt_architecture = EXCLUDED.prompt_architecture,\n       master_prompt = EXCLUDED.master_prompt,' : ''}
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [
      versionId, c.treatment, c.prompt, c.primaryModel, c.fallback1, c.fallback2,
      c.reasoningPrimary, c.reasoningFallback1, c.reasoningFallback2,
      c.maxOutputTokens, JSON.stringify(c.guardrails), JSON.stringify(c.triggers),
      c.cascade === null ? null : JSON.stringify(c.cascade), userId,
      ...(column ? [architecture, masterPrompt] : []),
    ] as never[],
  );
  // Lot 85C (0710) : profils par opération, dans la même transaction.
  const profils = normalizeOperationProfiles(c.operationProfiles);
  const avecProfils = Object.keys(profils).length > 0;
  if (await hasOperationProfilesColumn(sql)) {
    await sql.unsafe(
      `UPDATE ai_config_entries SET operation_profiles = $3::jsonb WHERE version_id = $1 AND treatment = $2`,
      [versionId, c.treatment, JSON.stringify(profils)] as never[],
    );
  } else if (avecProfils) {
    throw new Error('[config] Profils par opération impossibles à enregistrer : colonne `ai_config_entries.operation_profiles` absente (migration 0710 non appliquée).');
  }
}

let profilesColumn: { ready: boolean; checkedAt: number } | null = null;

/** Colonne 0710 présente ? (cache ; recontrôle tant qu'absente). */
export async function hasOperationProfilesColumn(sql: SqlLike = pgClient as unknown as SqlLike): Promise<boolean> {
  const e = profilesColumn;
  if (e && (e.ready || Date.now() - e.checkedAt < RECONTROLE_MS)) return e.ready;
  let ready = false;
  try {
    const rows = (await sql.unsafe(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'ai_config_entries' AND column_name = 'operation_profiles'`,
      [] as never[],
    )) as Array<{ n: number }>;
    ready = probeCount(rows) === 1;
  } catch {
    ready = false;
  }
  profilesColumn = { ready, checkedAt: Date.now() };
  return ready;
}

/** Réservé aux tests. */
export function __resetOperationProfilesColumnForTests(): void {
  profilesColumn = null;
}
