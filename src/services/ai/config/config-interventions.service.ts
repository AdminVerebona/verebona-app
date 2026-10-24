/**
 * Exclusions de modèles et gels de configuration MANUELS — lot 86B (CDC
 * Pilotage IA V2, phase P6 : ACT-03, DEC-03, VER-06, R55 ; décision PO 06).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PRIORITÉ DES INTERVENTIONS HUMAINES (ACT-03)
 *
 *   · EXCLUSION d'un modèle (tous les traitements ou un seul) : le modèle est
 *     retiré de la chaîne EXÉCUTÉE (`config-resolver`, surcouche de routage)
 *     et de tout routage automatique, jusqu'à sa levée ou au prochain import
 *     complet. Refusée si elle laissait une opération sans aucun modèle
 *     (jamais d'exécution impossible par effet de bord : changer d'abord la
 *     configuration) ;
 *   · GEL (global ou un traitement) : aucun changement AUTOMATIQUE
 *     (promotion `system` de routage, activation automatique de candidate —
 *     `isAutomaticChangeFrozen`, à lire par la qualification 86A) ; les
 *     gestes manuels restent possibles.
 *
 * Le système ne lève jamais silencieusement une intervention : seules la
 * levée par un administrateur et l'import complet (DEC-03, VER-06 : liste
 * présentée AVANT la confirmation) la lèvent ; tout est historisé (aucune
 * suppression) et tracé au journal d'administration IA.
 */
import { pgClient } from '@/db';
import { getAiEnvironment, type AiEnvironment } from './environment';
import { isTreatment, type Treatment } from './treatments';
import { ConfigOperationRefused } from './config-version.service';
import { lockEnvironment, type SqlLike } from './config-version.repository';
import type { TreatmentConfig } from './config-types';
import { isModelExcluded } from './routing-overlay';

export { isModelExcluded } from './routing-overlay';

type Row = Record<string, unknown>;
const q = async (sql: SqlLike, text: string, params: unknown[] = []): Promise<Row[]> => (await sql.unsafe(text, params as never[])) as Row[];

export type InterventionKind = 'EXCLUSION' | 'FREEZE';

export interface Intervention {
  id: number;
  environment: string;
  kind: InterventionKind;
  model: string | null;
  /** `null` : tous les traitements. */
  treatment: Treatment | null;
  reason: string;
  createdBy: number | null;
  createdByEmail: string | null;
  createdAt: string;
  liftedAt: string | null;
  liftedBy: number | null;
  liftReason: 'admin' | 'import' | null;
  importId: number | null;
}

const COLS = `id, environment, kind, model, treatment, reason, created_by, created_by_email, created_at, lifted_at, lifted_by, lift_reason, import_id`;

export function toIntervention(r: Row): Intervention {
  return {
    id: Number(r.id), environment: String(r.environment), kind: String(r.kind) as InterventionKind,
    model: r.model == null ? null : String(r.model),
    treatment: r.treatment == null ? null : String(r.treatment) as Treatment,
    reason: String(r.reason ?? ''),
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdByEmail: r.created_by_email == null ? null : String(r.created_by_email),
    createdAt: new Date(String(r.created_at)).toISOString(),
    liftedAt: r.lifted_at == null ? null : new Date(String(r.lifted_at)).toISOString(),
    liftedBy: r.lifted_by == null ? null : Number(r.lifted_by),
    liftReason: r.lift_reason == null ? null : String(r.lift_reason) as 'admin' | 'import',
    importId: r.import_id == null ? null : Number(r.import_id),
  };
}

/** Table 0729 présente ? (absente : aucune intervention, jamais une erreur d'exécution). */
async function tableReady(sql: SqlLike): Promise<boolean> {
  return Boolean((await q(sql, `SELECT to_regclass('ai_config_interventions') IS NOT NULL AS ok`))[0]?.ok);
}

/** Interventions ACTIVES de l'environnement (lecture ; table absente : aucune). */
export async function listActiveInterventions(environment: AiEnvironment | string = getAiEnvironment(), sql: SqlLike = pgClient as unknown as SqlLike): Promise<Intervention[]> {
  if (!(await tableReady(sql))) return [];
  return (await q(sql, `SELECT ${COLS} FROM ai_config_interventions WHERE environment = $1 AND lifted_at IS NULL ORDER BY created_at, id`, [environment])).map(toIntervention);
}

/** Historique récent (actives et levées). */
export async function listInterventionHistory(environment: AiEnvironment | string = getAiEnvironment(), limit = 50): Promise<Intervention[]> {
  const sql = pgClient as unknown as SqlLike;
  if (!(await tableReady(sql))) return [];
  return (await q(sql, `SELECT ${COLS} FROM ai_config_interventions WHERE environment = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [environment, limit])).map(toIntervention);
}

// ── Règles pures ────────────────────────────────────────────────────────────

/** Gel applicable à ce traitement (global ou propre), sinon `null`. */
export function freezeFor(treatment: Treatment | null, interventions: ReadonlyArray<Intervention>): Intervention | null {
  return interventions.find((x) => x.kind === 'FREEZE' && (x.treatment === null || x.treatment === treatment)) ?? null;
}

/**
 * Traitements dont la chaîne configurée serait VIDÉE par ces exclusions
 * (pur) : principal + replis tous exclus. Sert au refus de création.
 */
export function chainsEmptiedBy(
  entries: ReadonlyArray<Pick<TreatmentConfig, 'treatment' | 'primaryModel' | 'fallback1' | 'fallback2'>>,
  exclusions: ReadonlyArray<Pick<Intervention, 'kind' | 'model' | 'treatment'>>,
): Treatment[] {
  return entries.filter((e) => {
    const chaine = [e.primaryModel, e.fallback1, e.fallback2].filter((m): m is string => Boolean(m));
    return chaine.length > 0 && chaine.every((m) => isModelExcluded(m, e.treatment, exclusions));
  }).map((e) => e.treatment);
}

// ── Écritures ───────────────────────────────────────────────────────────────

/** Incrémente la clé de configuration partagée DANS la transaction (surcouche relue par toutes les instances). */
async function bumpRoutingCache(sql: SqlLike, reason: string): Promise<void> {
  if (!(await q(sql, `SELECT to_regclass('verebona_cache_versions') IS NOT NULL AS ok`))[0]?.ok) return;
  await sql.unsafe(
    `INSERT INTO verebona_cache_versions (scope, version, last_reason, updated_at) VALUES ('ai-config', 1, $1, now())
     ON CONFLICT (scope) DO UPDATE SET version = verebona_cache_versions.version + 1, last_reason = EXCLUDED.last_reason, updated_at = now()`,
    [reason.slice(0, 60)] as never[],
  );
}

export { bumpRoutingCache };

async function emailOf(sql: SqlLike, userId: number): Promise<string | null> {
  const r = await q(sql, `SELECT email FROM users WHERE id = $1`, [userId]);
  return r[0]?.email == null ? null : String(r[0].email);
}

async function afterWrite(reason: string): Promise<void> {
  const { afterCommit } = await import('./config-version.service');
  await afterCommit(reason);
}

/**
 * Exclut un modèle (tous les traitements si `treatment` est nul).
 * Idempotente : une exclusion active de même portée est rendue telle quelle.
 */
export async function createExclusion(p: { model: string; treatment?: string | null; reason: string }, userId: number): Promise<{ intervention: Intervention; created: boolean }> {
  const model = String(p.model ?? '').trim();
  const reason = String(p.reason ?? '').trim();
  const treatment = p.treatment == null || p.treatment === '' ? null : String(p.treatment);
  if (!model) throw new ConfigOperationRefused('INTERVENTION_INVALID', 'Modèle à exclure manquant.');
  if (!reason) throw new ConfigOperationRefused('INTERVENTION_INVALID', 'Motif obligatoire : il est historisé et montré avant tout import.');
  if (treatment !== null && !isTreatment(treatment)) throw new ConfigOperationRefused('UNKNOWN_TREATMENT', `Traitement « ${treatment} » inconnu ou retiré.`);
  const environment = getAiEnvironment();
  const r = await pgClient.begin(async (tx) => {
    const sql = tx as unknown as SqlLike;
    await lockEnvironment(sql, environment);
    if (!(await tableReady(sql))) throw new ConfigOperationRefused('SCHEMA_NOT_READY', 'Migration 0729 non appliquée : exclusions indisponibles.');
    const actives = await listActiveInterventions(environment, sql);
    const deja = actives.find((x) => x.kind === 'EXCLUSION' && x.model === model && x.treatment === treatment);
    if (deja) return { intervention: deja, created: false };
    const { getActiveVersion } = await import('./config-version.repository');
    const active = await getActiveVersion(environment as AiEnvironment);
    const vides = chainsEmptiedBy(active?.entries ?? [], [...actives, { kind: 'EXCLUSION', model, treatment: treatment as Treatment | null }]);
    if (vides.length) {
      throw new ConfigOperationRefused('EXCLUSION_EMPTIES_CHAIN',
        `Exclusion refusée : ${vides.join(', ')} n’aurai${vides.length > 1 ? 'en' : ''}t plus aucun modèle exécutable. `
        + 'Modifiez d’abord la configuration (autre modèle principal ou de repli), puis excluez ce modèle.', { treatments: vides });
    }
    const row = (await q(sql,
      `INSERT INTO ai_config_interventions (environment, kind, model, treatment, reason, created_by, created_by_email)
       VALUES ($1, 'EXCLUSION', $2, $3, $4, $5, $6) RETURNING ${COLS}`,
      [environment, model, treatment, reason.slice(0, 1000), userId, await emailOf(sql, userId)]))[0];
    await bumpRoutingCache(sql, `cfg:exclusion:${model}`);
    return { intervention: toIntervention(row), created: true };
  }) as { intervention: Intervention; created: boolean };
  if (r.created) {
    await afterWrite(`exclusion:${r.intervention.id}`);
    const { recordConfigAudit } = await import('./config-entry.audit');
    await recordConfigAudit('ai_model_exclusion_create', userId, null, { interventionId: r.intervention.id, model, treatment, reason });
  }
  return r;
}

/** Gèle la configuration (globale si `treatment` est nul). Idempotente. */
export async function createFreeze(p: { treatment?: string | null; reason: string }, userId: number): Promise<{ intervention: Intervention; created: boolean }> {
  const reason = String(p.reason ?? '').trim();
  const treatment = p.treatment == null || p.treatment === '' ? null : String(p.treatment);
  if (!reason) throw new ConfigOperationRefused('INTERVENTION_INVALID', 'Motif obligatoire : il est historisé et montré avant tout import.');
  if (treatment !== null && !isTreatment(treatment)) throw new ConfigOperationRefused('UNKNOWN_TREATMENT', `Traitement « ${treatment} » inconnu ou retiré.`);
  const environment = getAiEnvironment();
  const r = await pgClient.begin(async (tx) => {
    const sql = tx as unknown as SqlLike;
    await lockEnvironment(sql, environment);
    if (!(await tableReady(sql))) throw new ConfigOperationRefused('SCHEMA_NOT_READY', 'Migration 0729 non appliquée : gels indisponibles.');
    const deja = (await listActiveInterventions(environment, sql)).find((x) => x.kind === 'FREEZE' && x.treatment === treatment);
    if (deja) return { intervention: deja, created: false };
    const row = (await q(sql,
      `INSERT INTO ai_config_interventions (environment, kind, model, treatment, reason, created_by, created_by_email)
       VALUES ($1, 'FREEZE', NULL, $2, $3, $4, $5) RETURNING ${COLS}`,
      [environment, treatment, reason.slice(0, 1000), userId, await emailOf(sql, userId)]))[0];
    return { intervention: toIntervention(row), created: true };
  }) as { intervention: Intervention; created: boolean };
  if (r.created) {
    const { recordConfigAudit } = await import('./config-entry.audit');
    await recordConfigAudit('ai_config_freeze_create', userId, null, { interventionId: r.intervention.id, treatment, reason });
  }
  return r;
}

/** Lève une intervention (administrateur). Déjà levée : rendue telle quelle. */
export async function liftIntervention(id: number, userId: number): Promise<Intervention> {
  const environment = getAiEnvironment();
  const r = await pgClient.begin(async (tx) => {
    const sql = tx as unknown as SqlLike;
    await lockEnvironment(sql, environment);
    if (!(await tableReady(sql))) throw new ConfigOperationRefused('SCHEMA_NOT_READY', 'Migration 0729 non appliquée.');
    const cur = (await q(sql, `SELECT ${COLS} FROM ai_config_interventions WHERE id = $1 AND environment = $2 FOR UPDATE`, [id, environment]))[0];
    if (!cur) throw new ConfigOperationRefused('INTERVENTION_NOT_FOUND', `Intervention ${id} introuvable.`);
    if (cur.lifted_at != null) return { i: toIntervention(cur), lifted: false };
    const row = (await q(sql,
      `UPDATE ai_config_interventions SET lifted_at = now(), lifted_by = $2, lift_reason = 'admin' WHERE id = $1 RETURNING ${COLS}`, [id, userId]))[0];
    if (String(row.kind) === 'EXCLUSION') await bumpRoutingCache(sql, `cfg:exclusion-lift:${id}`);
    return { i: toIntervention(row), lifted: true };
  }) as { i: Intervention; lifted: boolean };
  if (r.lifted) {
    if (r.i.kind === 'EXCLUSION') await afterWrite(`exclusion-lift:${id}`);
    const { recordConfigAudit } = await import('./config-entry.audit');
    await recordConfigAudit(r.i.kind === 'EXCLUSION' ? 'ai_model_exclusion_lift' : 'ai_config_freeze_lift', userId,
      { interventionId: id, kind: r.i.kind, model: r.i.model, treatment: r.i.treatment }, { interventionId: id, lifted: true });
  }
  return r.i;
}

/**
 * Import complet (VER-06) : lève TOUTES les interventions actives, DANS la
 * transaction de l'import, en les rattachant à l'import. Rend celles levées.
 */
export async function liftAllForImportInTx(sql: SqlLike, environment: string, importId: number, userId: number): Promise<Intervention[]> {
  if (!(await tableReady(sql))) return [];
  return (await q(sql,
    `UPDATE ai_config_interventions SET lifted_at = now(), lifted_by = $3, lift_reason = 'import', import_id = $2
      WHERE environment = $1 AND lifted_at IS NULL RETURNING ${COLS}`, [environment, importId, userId])).map(toIntervention);
}

/**
 * Retour arrière d'un import : rétablit les interventions que CET import a
 * levées (celles créées depuis restent en place). Dans la transaction.
 */
export async function restoreLiftedByImportInTx(sql: SqlLike, environment: string, importId: number): Promise<Intervention[]> {
  if (!(await tableReady(sql))) return [];
  const out: Intervention[] = [];
  for (const r of await q(sql, `SELECT ${COLS} FROM ai_config_interventions WHERE environment = $1 AND import_id = $2 AND lift_reason = 'import' ORDER BY id`, [environment, importId])) {
    // Une intervention de même portée créée depuis l'import reste la seule active.
    const conflit = (await q(sql,
      `SELECT 1 FROM ai_config_interventions WHERE environment = $1 AND kind = $2 AND COALESCE(model, '') = COALESCE($3, '')
          AND COALESCE(treatment, '') = COALESCE($4, '') AND lifted_at IS NULL`, [environment, r.kind, r.model, r.treatment])).length > 0;
    if (conflit) continue;
    const row = (await q(sql,
      `UPDATE ai_config_interventions SET lifted_at = NULL, lifted_by = NULL, lift_reason = NULL, import_id = NULL WHERE id = $1 RETURNING ${COLS}`, [r.id]))[0];
    out.push(toIntervention(row));
  }
  return out;
}

/**
 * Un changement AUTOMATIQUE est-il gelé pour ce traitement (gel global ou
 * propre) ? Point de lecture pour toute automatisation (routage `system`,
 * activation automatique de candidate — qualification 86A). Ne lève jamais :
 * illisible = gelé par prudence.
 */
export async function isAutomaticChangeFrozen(treatment: Treatment | null, environment: AiEnvironment | string = getAiEnvironment()): Promise<boolean> {
  try {
    return freezeFor(treatment, await listActiveInterventions(environment)) !== null;
  } catch {
    return true;
  }
}
