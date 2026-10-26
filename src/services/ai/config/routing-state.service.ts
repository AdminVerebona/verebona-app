/**
 * État de routage SUBORDONNÉ — lot 86B (CDC Pilotage IA V2, phase P6 :
 * OPT-03, VER-08, ACT-03, ACT-04, DEC-03, R51, R55).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QU'EST UNE PROMOTION
 *
 * Pour UNE opération, placer en tête un modèle déjà présent dans la chaîne
 * CONFIGURÉE de son traitement (principal + replis de la configuration
 * active). Jamais un modèle hors de cette chaîne : la production ne fait
 * qu'ordonner les couples de la configuration importée (OPT-03, R51).
 * Mémorisée avec justification, origine, preuve et configuration de
 * référence ; réversible (retour à l'ordre configuré) ; remise à zéro par
 * le prochain import complet (VER-08). Une seule promotion active par
 * opération ; une nouvelle remplace l'ancienne (motif `superseded`).
 *
 * ORIGINES
 *   · `admin`  : geste manuel ; le couple n'a pas besoin de preuve (ACT-02)
 *                mais l'absence de preuve est mémorisée et affichée — il
 *                n'entre pas pour autant dans le vivier automatique (ACT-04) ;
 *   · `system` : point d'entrée de l'optimisation automatique de production
 *                (non planifiée dans ce lot) : refusée sans import appliqué,
 *                hors des couples du fichier importé, sans preuve
 *                `admissible` aux MÊMES empreintes, pendant un gel, ou pour
 *                un modèle exclu (DEC-01 : droits / intégrité, technique,
 *                qualité, puis gain).
 *
 * APPLICATION À L'EXÉCUTION
 *
 * `applyRoutingOverlay` (pur) est appliquée par `config-resolver` à la
 * configuration ACTIVE : exclusions retirées de la chaîne (jamais jusqu'à la
 * vider), puis promotion en tête. Le niveau de raisonnement et le profil
 * d'opération suivent leur modèle (emplacement d'origine).
 */
import { pgClient } from '@/db';
import { getAiEnvironment, type AiEnvironment } from './environment';
import { ConfigOperationRefused } from './config-version.service';
import { lockEnvironment, type SqlLike } from './config-version.repository';
import { getOperation } from '../registry/operations';
import { treatmentOfUseCase, type Treatment } from './treatments';
import { profiledOperationsOf } from './operation-profiles';
import { bumpRoutingCache, freezeFor, listActiveInterventions } from './config-interventions.service';
import { applyRoutingOverlay, configuredChain, isModelExcluded, type RoutingOverlay } from './routing-overlay';

export { applyRoutingOverlay, type RoutingOverlay,} from './routing-overlay';

type Row = Record<string, unknown>;
const q = async (sql: SqlLike, text: string, params: unknown[] = []): Promise<Row[]> => (await sql.unsafe(text, params as never[])) as Row[];

export interface RoutingPromotion {
  id: number;
  environment: string;
  operationCode: string;
  treatment: Treatment;
  model: string;
  chainBefore: string[];
  chainAfter: string[];
  origin: 'admin' | 'system';
  justification: string;
  evidence: Record<string, unknown>;
  baseImportId: number | null;
  baseVersionId: number | null;
  baseRevisionId: number | null;
  createdBy: number | null;
  createdByEmail: string | null;
  createdAt: string;
  revertedAt: string | null;
  revertedBy: number | null;
  revertReason: 'admin' | 'import' | 'superseded' | 'rollback' | null;
  revertImportId: number | null;
}

const COLS = `id, environment, operation_code, treatment, model, chain_before, chain_after, origin, justification, evidence,
              base_import_id, base_version_id, base_revision_id, created_by, created_by_email, created_at,
              reverted_at, reverted_by, revert_reason, revert_import_id`;

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function toPromotion(r: Row): RoutingPromotion {
  return {
    id: Number(r.id), environment: String(r.environment), operationCode: String(r.operation_code), treatment: String(r.treatment) as Treatment,
    model: String(r.model), chainBefore: strArr(r.chain_before), chainAfter: strArr(r.chain_after),
    origin: String(r.origin) as 'admin' | 'system', justification: String(r.justification ?? ''),
    evidence: (r.evidence && typeof r.evidence === 'object' ? r.evidence : {}) as Record<string, unknown>,
    baseImportId: r.base_import_id == null ? null : Number(r.base_import_id),
    baseVersionId: r.base_version_id == null ? null : Number(r.base_version_id),
    baseRevisionId: r.base_revision_id == null ? null : Number(r.base_revision_id),
    createdBy: r.created_by == null ? null : Number(r.created_by),
    createdByEmail: r.created_by_email == null ? null : String(r.created_by_email),
    createdAt: new Date(String(r.created_at)).toISOString(),
    revertedAt: r.reverted_at == null ? null : new Date(String(r.reverted_at)).toISOString(),
    revertedBy: r.reverted_by == null ? null : Number(r.reverted_by),
    revertReason: r.revert_reason == null ? null : String(r.revert_reason) as RoutingPromotion['revertReason'],
    revertImportId: r.revert_import_id == null ? null : Number(r.revert_import_id),
  };
}

// ── Lecture ─────────────────────────────────────────────────────────────────

async function tableReady(sql: SqlLike): Promise<boolean> {
  return Boolean((await q(sql, `SELECT to_regclass('ai_routing_promotions') IS NOT NULL AS ok`))[0]?.ok);
}

export async function listActivePromotions(environment: AiEnvironment | string = getAiEnvironment(), sql: SqlLike = pgClient as unknown as SqlLike): Promise<RoutingPromotion[]> {
  if (!(await tableReady(sql))) return [];
  return (await q(sql, `SELECT ${COLS} FROM ai_routing_promotions WHERE environment = $1 AND reverted_at IS NULL ORDER BY operation_code`, [environment])).map(toPromotion);
}

export async function listPromotionHistory(environment: AiEnvironment | string = getAiEnvironment(), limit = 50): Promise<RoutingPromotion[]> {
  const sql = pgClient as unknown as SqlLike;
  if (!(await tableReady(sql))) return [];
  return (await q(sql, `SELECT ${COLS} FROM ai_routing_promotions WHERE environment = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [environment, limit])).map(toPromotion);
}

/**
 * Surcouche de routage de l'environnement (exclusions actives, promotions
 * actives) — lue par le résolveur avec la configuration, sous la même clé
 * de cache. Tables absentes : surcouche vide.
 */
export async function loadRoutingOverlay(environment: AiEnvironment | string = getAiEnvironment()): Promise<RoutingOverlay> {
  const [interventions, promotions] = await Promise.all([listActiveInterventions(environment), listActivePromotions(environment)]);
  return {
    exclusions: interventions.filter((i) => i.kind === 'EXCLUSION'),
    promotions: new Map(promotions.map((p) => [p.operationCode, { model: p.model, promotionId: p.id }])),
  };
}

// ── Promotion ───────────────────────────────────────────────────────────────

interface PromoteInput {
  operationCode: string;
  model: string;
  justification: string;
  origin: 'admin' | 'system';
}

function treatmentOfOperation(operationCode: string): Treatment {
  let op;
  try { op = getOperation(operationCode); } catch { op = null; }
  let t: Treatment | null = null;
  try { t = op ? treatmentOfUseCase(op.useCaseCode) : null; } catch { t = null; }
  if (!op || !t || !profiledOperationsOf(t).some((o) => o.operationCode === operationCode)) {
    throw new ConfigOperationRefused('UNKNOWN_OPERATION', `« ${operationCode} » n’est pas une opération modèle d’un traitement.`);
  }
  return t;
}

/**
 * Promeut un modèle de la chaîne configurée en tête pour UNE opération.
 * Contrôles dans l'ordre DEC-01 ; refus explicite à chaque étape.
 */
export async function promote(input: PromoteInput, userId: number, deps: {
  /** Réservé aux tests : preuve admissible pour la promotion automatique. */
  automaticEvidence?: (p: { operationCode: string; model: string; importId: number }) => Promise<{ admissible: boolean; detail: Record<string, unknown> }>;
} = {}): Promise<RoutingPromotion> {
  const justification = String(input.justification ?? '').trim();
  if (!justification) throw new ConfigOperationRefused('PROMOTION_INVALID', 'Justification obligatoire (historisée).');
  if (input.origin !== 'admin' && input.origin !== 'system') throw new ConfigOperationRefused('PROMOTION_INVALID', 'Origine inconnue.');
  const treatment = treatmentOfOperation(input.operationCode);
  const environment = getAiEnvironment();
  const { getActiveVersion } = await import('./config-version.repository');
  const { lastAppliedImport, automaticPromotionEvidence } = await import('./config-import.service');

  const r = await pgClient.begin(async (tx) => {
    const sql = tx as unknown as SqlLike;
    await lockEnvironment(sql, environment);
    if (!(await tableReady(sql))) throw new ConfigOperationRefused('SCHEMA_NOT_READY', 'Migration 0730 non appliquée : routage indisponible.');
    const active = await getActiveVersion(environment as AiEnvironment);
    const entry = active?.entries.find((e) => e.treatment === treatment);
    if (!active || !entry?.primaryModel) {
      throw new ConfigOperationRefused('NO_ACTIVE_CONFIGURATION', `Aucune configuration active de ${treatment} : rien à ordonner.`);
    }
    const interventions = await listActiveInterventions(environment, sql);
    const exclusions = interventions.filter((i) => i.kind === 'EXCLUSION');
    if (isModelExcluded(input.model, treatment, exclusions)) {
      throw new ConfigOperationRefused('MODEL_EXCLUDED', `« ${input.model} » est exclu par un administrateur : levez l’exclusion avant de le promouvoir (ACT-03).`);
    }
    const chaine = configuredChain(entry);
    if (!chaine.some((c) => c.model === input.model)) {
      throw new ConfigOperationRefused('MODEL_NOT_IN_CHAIN',
        `« ${input.model} » ne fait pas partie de la chaîne configurée de ${treatment} (${chaine.map((c) => c.model).join(', ')}) : `
        + 'une promotion n’ordonne que les couples de la configuration active (OPT-03).');
    }
    const actuelles = await listActivePromotions(environment, sql);
    const enPlace = actuelles.find((p) => p.operationCode === input.operationCode);
    const avant = applyRoutingOverlay(chaine, treatment, input.operationCode, { exclusions, promotions: new Map(actuelles.map((p) => [p.operationCode, { model: p.model, promotionId: p.id }])) });
    if (avant.chain[0]?.model === input.model) {
      throw new ConfigOperationRefused('ALREADY_FIRST', `« ${input.model} » est déjà le premier modèle exécuté pour ${input.operationCode}.`);
    }
    const dernierImport = await lastAppliedImport(environment, sql);
    let evidence: Record<string, unknown> = { qualified: false, note: 'Geste administrateur : aucune preuve exigée (ACT-02) ; hors vivier automatique (ACT-04).' };
    if (input.origin === 'system') {
      const gel = freezeFor(treatment, interventions);
      if (gel) throw new ConfigOperationRefused('CONFIGURATION_FROZEN', `Configuration gelée${gel.treatment ? ` (${gel.treatment})` : ''} par un administrateur : aucun changement automatique (ACT-03).`);
      if (!dernierImport) throw new ConfigOperationRefused('NO_IMPORTED_REFERENCE', 'Aucune configuration importée : la production n’optimise que parmi les couples d’un import complet (VER-08).');
      const preuve = deps.automaticEvidence
        ? await deps.automaticEvidence({ operationCode: input.operationCode, model: input.model, importId: dernierImport.id })
        : await automaticPromotionEvidence(dernierImport.id, input.operationCode, input.model, entry, sql);
      if (!preuve.admissible) {
        throw new ConfigOperationRefused('PAIR_NOT_QUALIFIED',
          `Promotion automatique refusée : le couple ${input.operationCode} × « ${input.model} » n’a pas de preuve admissible aux empreintes actuelles dans le fichier importé (R51).`, preuve.detail);
      }
      evidence = { qualified: true, ...preuve.detail };
    }
    if (enPlace) {
      await sql.unsafe(`UPDATE ai_routing_promotions SET reverted_at = now(), reverted_by = $2, revert_reason = 'superseded' WHERE id = $1`, [enPlace.id, userId] as never[]);
    }
    const apres = applyRoutingOverlay(chaine, treatment, input.operationCode, { exclusions, promotions: new Map([[input.operationCode, { model: input.model, promotionId: 0 }]]) });
    const email = (await q(sql, `SELECT email FROM users WHERE id = $1`, [userId]))[0]?.email ?? null;
    const row = (await q(sql,
      `INSERT INTO ai_routing_promotions
         (environment, operation_code, treatment, model, chain_before, chain_after, origin, justification, evidence,
          base_import_id, base_version_id, base_revision_id, created_by, created_by_email)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb, $10, $11, $12, $13, $14) RETURNING ${COLS}`,
      [environment, input.operationCode, treatment, input.model, JSON.stringify(avant.chain.map((c) => c.model)), JSON.stringify(apres.chain.map((c) => c.model)),
       input.origin, justification.slice(0, 1000), JSON.stringify(evidence), dernierImport?.id ?? null, active.id, active.currentRevisionId, userId, email]))[0];
    await bumpRoutingCache(sql, `cfg:promotion:${input.operationCode}`);
    return { p: toPromotion(row), supersededId: enPlace?.id ?? null };
  }) as { p: RoutingPromotion; supersededId: number | null };

  const { afterCommit } = await import('./config-version.service');
  await afterCommit(`promotion:${r.p.id}`);
  const { recordConfigAudit } = await import('./config-entry.audit');
  await recordConfigAudit('ai_routing_promotion', userId, r.supersededId ? { promotionId: r.supersededId } : null, {
    promotionId: r.p.id, operationCode: r.p.operationCode, model: r.p.model, origin: r.p.origin, chainBefore: r.p.chainBefore, chainAfter: r.p.chainAfter,
  });
  return r.p;
}

/** Annule une promotion : retour à l'ordre configuré. Déjà annulée : rendue telle quelle. */
export async function revertPromotion(id: number, userId: number): Promise<RoutingPromotion> {
  const environment = getAiEnvironment();
  const r = await pgClient.begin(async (tx) => {
    const sql = tx as unknown as SqlLike;
    await lockEnvironment(sql, environment);
    if (!(await tableReady(sql))) throw new ConfigOperationRefused('SCHEMA_NOT_READY', 'Migration 0730 non appliquée.');
    const cur = (await q(sql, `SELECT ${COLS} FROM ai_routing_promotions WHERE id = $1 AND environment = $2 FOR UPDATE`, [id, environment]))[0];
    if (!cur) throw new ConfigOperationRefused('PROMOTION_NOT_FOUND', `Promotion ${id} introuvable.`);
    if (cur.reverted_at != null) return { p: toPromotion(cur), reverted: false };
    const row = (await q(sql, `UPDATE ai_routing_promotions SET reverted_at = now(), reverted_by = $2, revert_reason = 'admin' WHERE id = $1 RETURNING ${COLS}`, [id, userId]))[0];
    await bumpRoutingCache(sql, `cfg:promotion-revert:${id}`);
    return { p: toPromotion(row), reverted: true };
  }) as { p: RoutingPromotion; reverted: boolean };
  if (r.reverted) {
    const { afterCommit } = await import('./config-version.service');
    await afterCommit(`promotion-revert:${id}`);
    const { recordConfigAudit } = await import('./config-entry.audit');
    await recordConfigAudit('ai_routing_promotion_revert', userId, { promotionId: id, model: r.p.model, operationCode: r.p.operationCode }, { promotionId: id, reverted: true });
  }
  return r.p;
}

/** Import complet : remet à zéro toutes les promotions actives (dans la transaction de l'import). */
export async function resetAllForImportInTx(sql: SqlLike, environment: string, importId: number, userId: number): Promise<RoutingPromotion[]> {
  if (!(await tableReady(sql))) return [];
  return (await q(sql,
    `UPDATE ai_routing_promotions SET reverted_at = now(), reverted_by = $3, revert_reason = 'import', revert_import_id = $2
      WHERE environment = $1 AND reverted_at IS NULL RETURNING ${COLS}`, [environment, importId, userId])).map(toPromotion);
}

/**
 * Retour arrière d'un import : annule les promotions faites DEPUIS (elles
 * ordonnaient la configuration importée) et rétablit celles que l'import
 * avait remises à zéro. Dans la transaction.
 */
export async function restoreForRollbackInTx(sql: SqlLike, environment: string, importId: number, userId: number): Promise<{ reverted: RoutingPromotion[]; restored: RoutingPromotion[] }> {
  if (!(await tableReady(sql))) return { reverted: [], restored: [] };
  const reverted = (await q(sql,
    `UPDATE ai_routing_promotions SET reverted_at = now(), reverted_by = $2, revert_reason = 'rollback'
      WHERE environment = $1 AND reverted_at IS NULL RETURNING ${COLS}`, [environment, userId])).map(toPromotion);
  const restored = (await q(sql,
    `UPDATE ai_routing_promotions SET reverted_at = NULL, reverted_by = NULL, revert_reason = NULL, revert_import_id = NULL
      WHERE environment = $1 AND revert_import_id = $2 AND revert_reason = 'import' RETURNING ${COLS}`, [environment, importId])).map(toPromotion);
  return { reverted, restored };
}

// ── Vue du BO ───────────────────────────────────────────────────────────────

interface RoutingOperationView {
  operationCode: string;
  treatment: Treatment;
  /** Chaîne configurée (version active). */
  configured: string[];
  /** Chaîne exécutée (après exclusions et promotion). */
  effective: string[];
  excluded: string[];
  exclusionIgnored: boolean;
  promotion: RoutingPromotion | null;
  /** Statut de preuve importée par modèle de la chaîne configurée (`null` : aucun import). */
  importedEvidence: Record<string, string | null>;
}

/**
 * État de routage lisible au BO : pour chaque opération modèle, chaîne
 * configurée, chaîne exécutée, promotion active et preuves du dernier import
 * (lecture seule, aucun appel).
 */
export async function routingView(environment: AiEnvironment | string = getAiEnvironment()): Promise<{
  operations: RoutingOperationView[]; lastImportId: number | null;
}> {
  const [{ getActiveVersion }, { lastAppliedImport, detectImportFormat }] = await Promise.all([
    import('./config-version.repository'), import('./config-import.service'),
  ]);
  const [active, interventions, promotions, imp] = await Promise.all([
    getActiveVersion(environment as AiEnvironment), listActiveInterventions(environment), listActivePromotions(environment), lastAppliedImport(environment),
  ]);
  let preuves: Map<string, string> | null = null;
  if (imp) {
    const row = (await q(pgClient as unknown as SqlLike, `SELECT file_content FROM ai_config_imports WHERE id = $1`, [imp.id]))[0];
    const d = row?.file_content ? detectImportFormat(String(row.file_content)) : null;
    if (d?.ok) {
      preuves = new Map();
      d.doc.allowedPairs.forEach((p, i) => {
        const k = `${p.operationCode}|${p.model}`;
        const st = d.doc.qualification.evidence[i]?.status ?? 'never_tested';
        // Plusieurs profils pour un même couple : le meilleur statut l'emporte à l'affichage.
        if (!preuves!.has(k) || st === 'admissible') preuves!.set(k, st);
      });
    }
  }
  const overlay: RoutingOverlay = {
    exclusions: interventions.filter((i) => i.kind === 'EXCLUSION'),
    promotions: new Map(promotions.map((p) => [p.operationCode, { model: p.model, promotionId: p.id }])),
  };
  const operations: RoutingOperationView[] = [];
  for (const e of active?.entries ?? []) {
    if (!e.primaryModel) continue;
    const chaine = configuredChain(e);
    for (const op of profiledOperationsOf(e.treatment)) {
      const r = applyRoutingOverlay(chaine, e.treatment, op.operationCode, overlay);
      operations.push({
        operationCode: op.operationCode, treatment: e.treatment,
        configured: chaine.map((c) => c.model), effective: r.chain.map((c) => c.model),
        excluded: r.excluded, exclusionIgnored: r.exclusionIgnored,
        promotion: promotions.find((p) => p.operationCode === op.operationCode) ?? null,
        importedEvidence: Object.fromEntries(chaine.map((c) => [c.model, preuves ? preuves.get(`${op.operationCode}|${c.model}`) ?? 'never_tested' : null])),
      });
    }
  }
  return { operations, lastImportId: imp?.id ?? null };
}
