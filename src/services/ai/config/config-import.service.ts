/**
 * Import MANUEL, COMPLET et ATOMIQUE de la configuration IA globale — lot 86B
 * (CDC Pilotage IA V2, phase P6 : VER-04 à VER-09, ACT-03, DEC-03, RUN-05,
 * R14, R15, R52, R55, R68 ; décisions PO 02, 06, 07, 15).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE PARCOURS (décision 07)
 *
 *   1. PRÉVISUALISER (`previewImport`, aucune écriture) : lecture du format
 *      (2.0.0 seulement — l'ancien export 1.0.0 et l'ancien package
 *      `ai-config-package-v1` sont refusés avec un message explicite),
 *      contrôles sur LE MÊME fichier :
 *        · intégrité : signature, empreintes, structure, aucun secret ;
 *        · références : traitements, garde-fous, déclencheurs, prompts
 *          maîtres (code attendu par CE code, texte = empreinte) ;
 *        · compatibilité code / contrats : opérations du registre, contrats
 *          de sortie connus, configuration d'exécution des prompts ;
 *        · accès Gemini de la CLÉ CIBLE pour chaque modèle (catalogue de
 *          cette clé : absent, retiré, jamais vérifié → refus, R52) ;
 *        · chaque couple : constructeur de requête unique (combinaison
 *          connue comme incompatible → refus), registre des modèles ;
 *        · Preview : refusé (décision 02).
 *      Puis l'écart avec l'active, les MODIFICATIONS LOCALES écrasées
 *      (depuis le dernier import), les exclusions / gels levés, les
 *      promotions remises à zéro et les modèles RÉAUTORISÉS (DEC-03).
 *   2. CONFIRMER (`applyImport`) : mêmes contrôles ; la base prévisualisée
 *      doit être INCHANGÉE (empreinte `base`) — sinon refus « relancer la
 *      prévisualisation » : on n'écrase jamais ce qui n'a pas été montré.
 *      UNE transaction : prompts maîtres (version existante de même texte,
 *      sinon créée), nouvelle version complète, activation, levée de toutes
 *      les exclusions / gels, remise à zéro du routage, journal. Tout ou
 *      rien : un contrôle bloquant ou une erreur laisse l'active intacte.
 *   3. RÉIMPORTER le même fichier sur la configuration qu'il a produite :
 *      reconnu, aucune nouvelle version ni écriture (VER-04).
 *   4. REVENIR à la configuration antérieure (`rollbackImport`) : dernier
 *      import seulement ; réactive la version / révision remplacée (contrôles
 *      TECHNIQUES conservés, décision 06), rétablit les interventions levées
 *      et le routage remis à zéro par cet import ; historisé.
 *
 * Aucun appel fournisseur : les contrôles lisent le catalogue, les capacités
 * et la qualification déjà connus de la clé active (R08, R46).
 * Réglages hors version (assistant, budgets) : PROPRES à l'environnement,
 * jamais importés (certains exigent une double validation) — listés dans la
 * prévisualisation (VER-03).
 */
import { pgClient } from '@/db';
import { getAiEnvironment, type AiEnvironment } from './environment';
import { TREATMENTS, isTreatment, type Treatment } from './treatments';
import { ConfigOperationRefused } from './config-version.service';
import {
  lockEnvironment, getActiveVersion, getRevision, getVersion, activateVersionInTx, insertVersionWithSnapshotInTx,
  restoreRevisionInTx, findOrCreateMasterPromptVersionInTx, type SqlLike,
} from './config-version.repository';
import {
  EXPORT_FORMAT, EXPORT_FORMAT_VERSION, RETIRED_EXPORT_FORMAT_VERSIONS, validateExportDocument, compatibilityOperations, operationPolicies,
  allowedPairsOf, promptSha256,
  type ConfigExportDocument, type CompatibilityOperation, type OperationPolicy, type ExportedTreatment,
} from './config-export.service';
import { buildSnapshot, canonicalJson, sha256, snapshotEntry, type ConfigSnapshot, type MasterPromptRef } from './config-snapshot';
import { diffVersions, type ConfigDiff } from './config-diff.service';
import type { TreatmentConfig } from './config-types';
import type { MasterExecutionConfig } from '../master-prompts/structured-context';
import { isModelExcluded, liftAllForImportInTx, listActiveInterventions, restoreLiftedByImportInTx, type Intervention } from './config-interventions.service';
import { listActivePromotions, resetAllForImportInTx, restoreForRollbackInTx, type RoutingPromotion } from './routing-state.service';
import { evidenceSupportsAutomaticPromotion, qualificationThresholds, thresholdsSha256, type PairEvidence } from './qualification-evidence.adapter';

type Row = Record<string, unknown>;
const q = async (sql: SqlLike, text: string, params: unknown[] = []): Promise<Row[]> => (await sql.unsafe(text, params as never[])) as Row[];

// ── 1. Format ───────────────────────────────────────────────────────────────

export type DetectedFormat =
  | { ok: true; doc: ConfigExportDocument }
  | { ok: false; code: 'IMPORT_UNREADABLE' | 'LEGACY_PACKAGE_FORMAT' | 'LEGACY_EXPORT_FORMAT' | 'UNKNOWN_FORMAT_VERSION' | 'UNKNOWN_FORMAT'; message: string };

/** Taille maximale d'un fichier importé (prompts maîtres compris). */
export const IMPORT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Reconnaît le format (pur). Seul `verebona-ia-config-export` 2.0.0 est
 * accepté ; chaque format retiré reçoit un message qui dit quoi faire.
 */
export function detectImportFormat(content: string): DetectedFormat {
  if (typeof content !== 'string' || content.trim() === '') {
    return { ok: false, code: 'IMPORT_UNREADABLE', message: 'Fichier vide : aucune configuration à importer. Rien n’a été modifié.' };
  }
  if (Buffer.byteLength(content, 'utf8') > IMPORT_MAX_BYTES) {
    return { ok: false, code: 'IMPORT_UNREADABLE', message: `Fichier trop volumineux (plus de ${IMPORT_MAX_BYTES / 1024 / 1024} Mio) : ce n’est pas un export de configuration IA. Rien n’a été modifié.` };
  }
  let raw: unknown;
  try { raw = JSON.parse(content); } catch {
    return { ok: false, code: 'IMPORT_UNREADABLE', message: 'Fichier illisible : ce n’est pas un JSON valide. Rien n’a été modifié.' };
  }
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Row;
  if (o.schemaVersion === 'ai-config-package-v1') {
    return {
      ok: false, code: 'LEGACY_PACKAGE_FORMAT',
      message: 'Ancien « package de mise en production » (ai-config-package-v1) : ce format est retiré et n’est plus importable (décision PO 07). '
        + 'En préproduction, utilisez « Exporter la configuration » (format 2.0.0), puis importez ce nouveau fichier. Rien n’a été modifié.',
    };
  }
  if (o.format !== EXPORT_FORMAT) {
    return { ok: false, code: 'UNKNOWN_FORMAT', message: `Ce fichier n’est pas une configuration IA Verebona (format attendu : ${EXPORT_FORMAT} ${EXPORT_FORMAT_VERSION}). Rien n’a été modifié.` };
  }
  if ((RETIRED_EXPORT_FORMAT_VERSIONS as readonly string[]).includes(String(o.formatVersion))) {
    return {
      ok: false, code: 'LEGACY_EXPORT_FORMAT',
      message: `Fichier exporté dans l’ancien format ${String(o.formatVersion)} : il ne contient ni couples autorisés, ni preuves de qualification, ni signature d’intégrité, `
        + `et ne peut pas être importé. Réexportez la configuration depuis la préproduction à jour (format ${EXPORT_FORMAT_VERSION}). Rien n’a été modifié.`,
    };
  }
  if (o.formatVersion !== EXPORT_FORMAT_VERSION) {
    return {
      ok: false, code: 'UNKNOWN_FORMAT_VERSION',
      message: `Version de format « ${String(o.formatVersion)} » inconnue de cette application (attendue : ${EXPORT_FORMAT_VERSION}). `
        + 'Le fichier vient sans doute d’une version plus récente : déployez la même version de l’application avant d’importer. Rien n’a été modifié.',
    };
  }
  return { ok: true, doc: raw as ConfigExportDocument };
}

// ── 2. Contrôles (purs) ─────────────────────────────────────────────────────

export type ImportIssueCategory = 'integrity' | 'references' | 'compatibility' | 'access' | 'preview' | 'pair' | 'information';

export interface ImportIssue {
  category: ImportIssueCategory;
  path: string;
  message: string;
  blocking: boolean;
  treatment?: string;
  model?: string;
}

export const IMPORT_ISSUE_CATEGORY_LABELS: Readonly<Record<ImportIssueCategory, string>> = {
  integrity: 'Intégrité du fichier',
  references: 'Références',
  compatibility: 'Compatibilité avec le code',
  access: 'Accès Gemini de la clé de cet environnement',
  preview: 'Modèle Preview (exclu en V1)',
  pair: 'Couple modèle / paramètres',
  information: 'Information',
};

/** Contexte de l'environnement CIBLE (injectable, pur côté contrôles). */
export interface ImportTargetContext {
  environment: string;
  operations: CompatibilityOperation[];
  contractKnown: (schemaName: string, version: number) => boolean;
  masterPromptCodeOf: (t: Treatment) => string | null;
  executionIssues: (masterPromptCode: string, execution: MasterExecutionConfig | null) => string[];
  modelEligibility: (t: Treatment, model: string) => { reasons: string[]; reasonText: string };
  pairIssues: (entry: TreatmentConfig) => Array<{ message: string; blocking: boolean }>;
  registryErrors: (entries: TreatmentConfig[]) => string[];
  thresholdsSha256: string;
  policies: OperationPolicy[];
}

const ACCESS_REASONS = new Set(['NOT_LISTED', 'PROVIDER_UNAVAILABLE', 'NOT_VERIFIED', 'NOT_OPERATIONAL', 'NO_GENERATE_CONTENT']);

/** Lignes de configuration du fichier (pur) ; le texte des prompts maîtres est porté à part. */
export function incomingEntries(doc: ConfigExportDocument): TreatmentConfig[] {
  return (doc.configuration?.treatments ?? []).filter((t) => isTreatment(String(t.code))).map((t: ExportedTreatment) => snapshotEntry({
    treatment: t.code,
    prompt: t.preamble ?? '',
    primaryModel: t.models?.primary ?? null,
    fallback1: t.models?.fallbacks?.[0] ?? null,
    fallback2: t.models?.fallbacks?.[1] ?? null,
    reasoningPrimary: (t.models?.reasoning?.primary ?? null) as TreatmentConfig['reasoningPrimary'],
    reasoningFallback1: (t.models?.reasoning?.fallback1 ?? null) as TreatmentConfig['reasoningFallback1'],
    reasoningFallback2: (t.models?.reasoning?.fallback2 ?? null) as TreatmentConfig['reasoningFallback2'],
    maxOutputTokens: t.models?.maxOutputTokens ?? null,
    guardrails: t.guardrails ?? [],
    triggers: t.triggers ?? [],
    cascade: t.cascade ?? null,
    promptArchitecture: 'master',
    // Le texte retenu voyage en version de prompt maître (référence de l'instantané).
    masterPrompt: null,
    operationProfiles: t.operationProfiles ?? {},
  }));
}

/** Tous les contrôles d'un fichier contre l'environnement cible (pur). */
export function checkImportDocument(doc: ConfigExportDocument, ctx: ImportTargetContext): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const add = (i: ImportIssue) => issues.push(i);

  // a) Intégrité et références (même validation qu'à l'export).
  for (const v of validateExportDocument(doc)) {
    const cat: ImportIssueCategory = /integrity|format|exportId|exportedAt|document|environmentParameters|allowedPairs|qualification|thresholds|policies|registrySha/.test(v.path)
      ? 'integrity' : v.path.startsWith('compatibility') ? 'compatibility' : 'references';
    add({ category: cat, path: v.path, message: v.message, blocking: v.blocking });
  }
  if (issues.some((i) => i.blocking && i.category === 'integrity')) return issues; // fichier altéré : rien d'autre n'a de sens

  const entries = incomingEntries(doc);
  const cible = new Map(ctx.operations.map((o) => [o.operationCode, o]));
  const source = new Map((doc.compatibility?.operations ?? []).map((o) => [o.operationCode, o]));

  // b) Compatibilité code / contrats.
  for (const o of doc.compatibility?.operations ?? []) {
    const c = cible.get(o.operationCode);
    const profilee = entries.some((e) => e.operationProfiles && o.operationCode in e.operationProfiles);
    if (!c) {
      add({ category: 'compatibility', path: `compatibility.operations.${o.operationCode}`, blocking: profilee,
        message: profilee
          ? `Opération « ${o.operationCode} » inconnue du code de cet environnement alors que le fichier lui donne un profil : versions d’application différentes.`
          : `Opération « ${o.operationCode} » inconnue du code de cet environnement (ignorée : aucun profil ne la vise).` });
      continue;
    }
    if (c.treatment !== o.treatment) {
      add({ category: 'compatibility', path: `compatibility.operations.${o.operationCode}`, blocking: true, message: `Opération « ${o.operationCode} » rattachée à ${o.treatment} dans le fichier, à ${c.treatment} ici.` });
    }
    if (o.contractVersion != null && !ctx.contractKnown(o.outputSchema, o.contractVersion)) {
      add({ category: 'compatibility', path: `compatibility.operations.${o.operationCode}.contractVersion`, blocking: true,
        message: `Contrat de sortie ${o.outputSchema} v${o.contractVersion} (fichier) inconnu du code de cet environnement : déployez la même version de l’application.` });
    } else if (o.contractVersion != null && c.contractVersion != null && o.contractVersion !== c.contractVersion) {
      add({ category: 'compatibility', path: `compatibility.operations.${o.operationCode}.contractVersion`, blocking: false,
        message: `Contrat de sortie ${o.outputSchema} : v${o.contractVersion} dans le fichier, v${c.contractVersion} actif ici (preuves importées non applicables à ce couple).` });
    }
  }
  for (const c of ctx.operations) {
    if (!source.has(c.operationCode)) {
      add({ category: 'compatibility', path: `compatibility.operations.${c.operationCode}`, blocking: false,
        message: `Opération « ${c.operationCode} » (${c.treatment}) absente du fichier : la référence du traitement s’appliquera, sans preuve importée.` });
    }
  }
  for (const t of doc.configuration?.treatments ?? []) {
    if (!isTreatment(String(t.code)) || !t.masterPrompt) continue;
    const attendu = ctx.masterPromptCodeOf(t.code);
    if (attendu && t.masterPrompt.code !== attendu) {
      add({ category: 'compatibility', path: `configuration.treatments.${t.code}.masterPrompt.code`, blocking: true, treatment: t.code,
        message: `Prompt maître « ${t.masterPrompt.code} » pour ${t.code} : ce code attend « ${attendu} ».` });
      continue;
    }
    for (const m of ctx.executionIssues(t.masterPrompt.code, t.masterPrompt.execution ?? null)) {
      add({ category: 'compatibility', path: `configuration.treatments.${t.code}.masterPrompt.execution`, blocking: true, treatment: t.code, message: `${t.code} · ${m}` });
    }
  }

  // c) Accès Gemini de la clé cible et Preview, modèle par modèle.
  for (const e of entries) {
    for (const model of [e.primaryModel, e.fallback1, e.fallback2]) {
      if (!model) continue;
      const r = ctx.modelEligibility(e.treatment, model);
      if (r.reasons.length === 0) continue;
      const cat: ImportIssueCategory = r.reasons.includes('PREVIEW') ? 'preview' : r.reasons.some((x) => ACCESS_REASONS.has(x)) ? 'access' : 'pair';
      add({ category: cat, path: `configuration.treatments.${e.treatment}.models`, blocking: true, treatment: e.treatment, model,
        message: `${e.treatment} · « ${model} » : ${r.reasonText}.` });
    }
    // d) Chaque couple (constructeur de requête unique).
    for (const p of ctx.pairIssues(e)) {
      add({ category: 'pair', path: `configuration.treatments.${e.treatment}`, blocking: p.blocking, treatment: e.treatment, message: `${e.treatment} · ${p.message}` });
    }
  }
  for (const m of ctx.registryErrors(entries)) add({ category: 'pair', path: 'configuration', blocking: true, message: m });

  // e) Seuils et politiques : définis par le code (information).
  if (doc.thresholds?.sha256 && doc.thresholds.sha256 !== ctx.thresholdsSha256) {
    add({ category: 'information', path: 'thresholds', blocking: false,
      message: 'Seuils de qualification différents de ceux de ce code : les seuils de cet environnement s’appliquent ; les preuves importées sont informatives.' });
  }
  if (canonicalJson(doc.policies?.perOperation ?? []) !== canonicalJson(ctx.policies)) {
    add({ category: 'information', path: 'policies', blocking: false, message: 'Politiques de routage du fichier différentes de celles de ce code : celles de cet environnement s’appliquent.' });
  }
  return issues;
}

// ── 3. État courant et prévisualisation ─────────────────────────────────────

export interface ImportRecord {
  id: number;
  environment: string;
  action: 'import' | 'rollback';
  status: 'applied' | 'refused';
  formatVersion: string | null;
  fileSignature: string | null;
  configurationSha256: string | null;
  sourceEnvironment: string | null;
  sourceVersionNumber: number | null;
  sourceRevisionNumber: number | null;
  sourceExportedAt: string | null;
  sourceAppVersion: string | null;
  previousVersionId: number | null;
  previousRevisionId: number | null;
  newVersionId: number | null;
  newRevisionId: number | null;
  rollbackOf: number | null;
  rolledBackAt: string | null;
  rolledBackBy: number | null;
  summary: Record<string, unknown>;
  diagnostics: ImportIssue[];
  createdBy: number | null;
  createdByEmail: string | null;
  createdAt: string;
}

const COLS = `id, environment, action, status, format_version, file_signature, configuration_sha256, source_environment,
              source_version_number, source_revision_number, source_exported_at, source_app_version,
              previous_version_id, previous_revision_id, new_version_id, new_revision_id, rollback_of, rolled_back_at, rolled_back_by,
              summary, diagnostics, created_by, created_by_email, created_at`;

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const iso = (v: unknown): string | null => (v == null ? null : new Date(String(v)).toISOString());

function toRecord(r: Row): ImportRecord {
  return {
    id: Number(r.id), environment: String(r.environment), action: String(r.action) as ImportRecord['action'], status: String(r.status) as ImportRecord['status'],
    formatVersion: r.format_version == null ? null : String(r.format_version),
    fileSignature: r.file_signature == null ? null : String(r.file_signature),
    configurationSha256: r.configuration_sha256 == null ? null : String(r.configuration_sha256),
    sourceEnvironment: r.source_environment == null ? null : String(r.source_environment),
    sourceVersionNumber: num(r.source_version_number), sourceRevisionNumber: num(r.source_revision_number),
    sourceExportedAt: iso(r.source_exported_at), sourceAppVersion: r.source_app_version == null ? null : String(r.source_app_version),
    previousVersionId: num(r.previous_version_id), previousRevisionId: num(r.previous_revision_id),
    newVersionId: num(r.new_version_id), newRevisionId: num(r.new_revision_id),
    rollbackOf: num(r.rollback_of), rolledBackAt: iso(r.rolled_back_at), rolledBackBy: num(r.rolled_back_by),
    summary: (r.summary && typeof r.summary === 'object' ? r.summary : {}) as Record<string, unknown>,
    diagnostics: (Array.isArray(r.diagnostics) ? r.diagnostics : []) as ImportIssue[],
    createdBy: num(r.created_by), createdByEmail: r.created_by_email == null ? null : String(r.created_by_email),
    createdAt: new Date(String(r.created_at)).toISOString(),
  };
}

async function tableReady(sql: SqlLike): Promise<boolean> {
  return Boolean((await q(sql, `SELECT to_regclass('ai_config_imports') IS NOT NULL AS ok`))[0]?.ok);
}

export async function listImports(environment: AiEnvironment | string = getAiEnvironment(), limit = 30): Promise<ImportRecord[]> {
  const sql = pgClient as unknown as SqlLike;
  if (!(await tableReady(sql))) return [];
  return (await q(sql, `SELECT ${COLS} FROM ai_config_imports WHERE environment = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [environment, limit])).map(toRecord);
}

/**
 * Dernier import APPLIQUÉ et non annulé : référence de la production
 * (VER-08) et seul import qu'un retour arrière peut annuler. Après le retour
 * arrière d'un import, l'import précédent (dont la configuration est
 * rétablie) redevient la référence.
 */
export async function lastAppliedImport(environment: AiEnvironment | string = getAiEnvironment(), sql: SqlLike = pgClient as unknown as SqlLike): Promise<ImportRecord | null> {
  if (!(await tableReady(sql))) return null;
  const r = (await q(sql,
    `SELECT ${COLS} FROM ai_config_imports WHERE environment = $1 AND action = 'import' AND status = 'applied' AND rolled_back_at IS NULL
      ORDER BY id DESC LIMIT 1`, [environment]))[0];
  return r ? toRecord(r) : null;
}

interface CurrentState {
  active: Awaited<ReturnType<typeof getActiveVersion>>;
  interventions: Intervention[];
  promotions: RoutingPromotion[];
  lastImport: ImportRecord | null;
  base: string;
}

/** Empreinte de ce qu'un import remplacerait (pure). */
export function baseFingerprint(p: { activeVersionId: number | null; activeRevisionId: number | null; interventionIds: number[]; promotionIds: number[]; lastImportId: number | null }): string {
  return sha256(canonicalJson({
    v: p.activeVersionId, r: p.activeRevisionId, i: [...p.interventionIds].sort((a, b) => a - b),
    p: [...p.promotionIds].sort((a, b) => a - b), l: p.lastImportId,
  }));
}

async function currentState(environment: string, sql: SqlLike = pgClient as unknown as SqlLike): Promise<CurrentState> {
  const [active, interventions, promotions, lastImport] = await Promise.all([
    getActiveVersion(environment as AiEnvironment), listActiveInterventions(environment, sql), listActivePromotions(environment, sql), lastAppliedImport(environment, sql),
  ]);
  return {
    active, interventions, promotions, lastImport,
    base: baseFingerprint({
      activeVersionId: active?.id ?? null, activeRevisionId: active?.currentRevisionId ?? null,
      interventionIds: interventions.map((i) => i.id), promotionIds: promotions.map((p) => p.id), lastImportId: lastImport?.id ?? null,
    }),
  };
}

export interface MasterPromptChange { treatment: Treatment; before: string | null; after: string | null; beforeVersion: number | null }

/** Empreintes des prompts maîtres : instantané (ou actifs) → fichier. */
function masterPromptChanges(before: ConfigSnapshot['masterPrompts'], after: Partial<Record<Treatment, string | null>>): MasterPromptChange[] {
  return TREATMENTS.flatMap((t) => {
    const b = before[t]?.contentSha256 ?? null;
    const a = after[t] ?? null;
    return b === a ? [] : [{ treatment: t, before: b, after: a, beforeVersion: before[t]?.versionNumber ?? null }];
  });
}

export interface ImportPreview {
  /** Aucun contrôle bloquant : l'import peut être confirmé. */
  ok: boolean;
  file: {
    signature: string; configurationSha256: string; formatVersion: string; sourceEnvironment: string;
    exportedAt: string; exportedBy: string | null; version: { number: number | null; name: string | null }; revision: number;
    appVersion: string | null; exportId: string;
  };
  target: {
    environment: string;
    active: { versionId: number; versionNumber: number | null; name: string | null; revisionNumber: number | null } | null;
    lastImport: { id: number; at: string; signature: string | null; versionId: number | null } | null;
  };
  /** Empreinte de l'état remplacé : à renvoyer à la confirmation. */
  base: string;
  /** Même fichier déjà appliqué, configuration inchangée depuis : la confirmation ne fera rien. */
  alreadyApplied: boolean;
  treatments: Treatment[];
  diff: ConfigDiff;
  masterPromptChanges: MasterPromptChange[];
  localChanges: { sinceImportId: number | null; otherVersionActivated: boolean; diff: ConfigDiff | null; masterPromptChanges: MasterPromptChange[]; note: string };
  lostExclusions: Intervention[];
  liftedFreezes: Intervention[];
  resetPromotions: RoutingPromotion[];
  reauthorizedModels: Array<{ model: string; treatment: Treatment | null; exclusionId: number }>;
  settingsNotImported: string[];
  pairs: { total: number; admissible: number; technicalOnly: number; withoutEvidence: number };
  issues: ImportIssue[];
}

/** Contexte réel de l'environnement cible (catalogue de la clé active, capacités, registre). */
export async function buildTargetContext(): Promise<ImportTargetContext> {
  const [{ buildCatalogs }, { capabilityIssues }, { masterPromptForTreatment }, { contractVersionsOf }, sc, { checkModelUses }, { AI_OPERATIONS }, { treatmentForUseCase }] = await Promise.all([
    import('./config-version.service'), import('./config-validation.service'), import('./prompt-architecture'),
    import('../gateway/output-resolution/runtime-contract'), import('../master-prompts/structured-context'),
    import('../registry/models'), import('../registry/operations'), import('./treatments'),
  ]);
  const catalogs = await buildCatalogs();
  const masterDe = new Map<string, string>();
  for (const op of Object.values(AI_OPERATIONS)) {
    if (!op.masterPromptCode) continue;
    try { const t = treatmentForUseCase(op.useCaseCode); if (!masterDe.has(t)) masterDe.set(t, op.masterPromptCode); } catch { /* usage technique */ }
  }
  return {
    environment: getAiEnvironment(),
    operations: compatibilityOperations(),
    contractKnown: (name, v) => contractVersionsOf(name).includes(v),
    masterPromptCodeOf: (t) => masterPromptForTreatment(t)?.masterPromptCode ?? null,
    executionIssues: (code, execution) => {
      const spec = sc.structuredSpecFor(code);
      if (!spec || !execution) return [];
      return sc.checkExecutionConfig(spec, sc.normalizeExecutionConfig(execution), (name, v) => contractVersionsOf(name).includes(v)).map((i) => i.message);
    },
    modelEligibility: (t, model) => {
      const r = catalogs.modelEligibility!(t, model);
      return { reasons: r.reasons, reasonText: r.reasonText };
    },
    pairIssues: (entry) => capabilityIssues(entry, catalogs).map((i) => ({ message: i.message, blocking: i.blocking })),
    registryErrors: (entries) => checkModelUses(entries.flatMap((e) => [e.primaryModel, e.fallback1, e.fallback2]
      .filter((m): m is string => Boolean(m)).map((model) => ({ where: e.treatment, model, promptCode: masterDe.get(e.treatment) ?? null }))))
      .filter((i) => i.level === 'error').map((i) => i.message),
    thresholdsSha256: thresholdsSha256(qualificationThresholds()),
    policies: operationPolicies(),
  };
}

function fileOf(doc: ConfigExportDocument): ImportPreview['file'] {
  return {
    signature: doc.integrity?.signature ?? '', configurationSha256: doc.integrity?.configurationSha256 ?? '', formatVersion: String(doc.formatVersion),
    sourceEnvironment: String(doc.source?.environment ?? ''), exportedAt: String(doc.exportedAt ?? ''), exportedBy: doc.exportedBy?.email ?? null,
    version: { number: doc.version?.number ?? null, name: doc.version?.name ?? null }, revision: Number(doc.revision?.number ?? 0),
    appVersion: doc.source?.appVersion ?? null, exportId: String(doc.exportId ?? ''),
  };
}

/** Prévisualisation pure (état courant et contrôles fournis). */
export function computePreview(doc: ConfigExportDocument, state: CurrentState, issues: ImportIssue[], importSnapshot: ConfigSnapshot | null): ImportPreview {
  const entries = incomingEntries(doc);
  const apres: Partial<Record<Treatment, string | null>> = {};
  for (const t of doc.configuration?.treatments ?? []) if (isTreatment(String(t.code))) apres[t.code] = t.masterPrompt?.sha256 ?? null;
  const active = state.active;
  const activeSnapshot = active ? buildSnapshot(active.entries, active.masterPrompts) : null;
  const diff = diffVersions(active?.entries ?? [], entries);
  const imp = state.lastImport;
  const otherVersionActivated = Boolean(imp && active && imp.newVersionId !== active.id);
  const localDiff = imp && importSnapshot && activeSnapshot ? diffVersions(importSnapshot.entries, activeSnapshot.entries) : null;
  const localPrompts = imp && importSnapshot && activeSnapshot
    ? masterPromptChanges(importSnapshot.masterPrompts, Object.fromEntries(TREATMENTS.map((t) => [t, activeSnapshot.masterPrompts[t]?.contentSha256 ?? null])))
    : [];
  const note = !active ? 'Aucune configuration active : rien de local n’est écrasé.'
    : !imp ? `Aucun import précédent dans cet environnement : toute la configuration active (v${active.visibleNumber ?? active.id} r${active.currentRevisionNumber ?? '?'}) est locale et sera entièrement remplacée.`
      : otherVersionActivated ? `Une autre version (v${active.visibleNumber ?? active.id}) a été activée depuis le dernier import : elle sera remplacée.`
        : (localDiff && !localDiff.identical) || localPrompts.length ? 'Modifications faites dans cet environnement depuis le dernier import : elles seront écrasées.'
          : 'Aucune modification locale depuis le dernier import.';
  const exclusions = state.interventions.filter((i) => i.kind === 'EXCLUSION');
  const reauthorizedModels = exclusions.flatMap((x) => {
    const visees = entries.filter((e) => (x.treatment === null || x.treatment === e.treatment)
      && [e.primaryModel, e.fallback1, e.fallback2].includes(x.model) && isModelExcluded(x.model!, e.treatment, [x]));
    return visees.length ? [{ model: x.model!, treatment: x.treatment, exclusionId: x.id }] : [];
  });
  const evidence = (doc.qualification?.evidence ?? []) as PairEvidence[];
  const settingsNotImported = [
    ...(doc.settingsOutsideVersion?.assistant ?? []).map((s) => `Assistant · ${s.label}`),
    ...(doc.settingsOutsideVersion?.costBudgets ? ['Budgets mensuels IA et détection d’anomalies (Coûts IA)'] : []),
    'Clé API du fournisseur, état opérationnel des traitements, arrêt d’urgence',
  ];
  const alreadyApplied = Boolean(imp && active && imp.fileSignature === doc.integrity?.signature
    && imp.newVersionId === active.id && imp.newRevisionId === active.currentRevisionId
    && state.interventions.length === 0 && state.promotions.length === 0);
  return {
    ok: !issues.some((i) => i.blocking),
    file: fileOf(doc),
    target: {
      environment: active?.environment ?? '',
      active: active ? { versionId: active.id, versionNumber: active.visibleNumber, name: active.label, revisionNumber: active.currentRevisionNumber } : null,
      lastImport: imp ? { id: imp.id, at: imp.createdAt, signature: imp.fileSignature, versionId: imp.newVersionId } : null,
    },
    base: state.base,
    alreadyApplied,
    treatments: entries.map((e) => e.treatment),
    diff,
    masterPromptChanges: masterPromptChanges(activeSnapshot?.masterPrompts ?? {}, apres),
    localChanges: { sinceImportId: imp?.id ?? null, otherVersionActivated, diff: localDiff, masterPromptChanges: localPrompts, note },
    lostExclusions: exclusions,
    liftedFreezes: state.interventions.filter((i) => i.kind === 'FREEZE'),
    resetPromotions: state.promotions,
    reauthorizedModels,
    settingsNotImported,
    pairs: {
      total: doc.allowedPairs?.length ?? 0,
      admissible: evidence.filter((e) => e.status === 'admissible').length,
      technicalOnly: evidence.filter((e) => e.status === 'technical_only').length,
      withoutEvidence: evidence.filter((e) => e.status === 'never_tested').length,
    },
    issues,
  };
}

async function importSnapshotOf(imp: ImportRecord | null): Promise<ConfigSnapshot | null> {
  if (!imp?.newRevisionId) return null;
  return (await getRevision(imp.newRevisionId))?.snapshot ?? null;
}

function refusalOf(d: Extract<DetectedFormat, { ok: false }>): never {
  throw new ConfigOperationRefused(d.code, d.message, [{ category: 'integrity', path: 'format', message: d.message, blocking: true }]);
}

/** Prévisualise un import (aucune écriture). Format refusé : refus explicite. */
export async function previewImport(content: string, deps: { target?: ImportTargetContext } = {}): Promise<ImportPreview> {
  const d = detectImportFormat(content);
  if (!d.ok) refusalOf(d);
  const environment = getAiEnvironment();
  const ctx = deps.target ?? await buildTargetContext();
  const issues = checkImportDocument(d.doc, ctx);
  const state = await currentState(environment);
  const preview = computePreview(d.doc, state, issues, await importSnapshotOf(state.lastImport));
  preview.target.environment = environment;
  return preview;
}

// ── 4. Application ──────────────────────────────────────────────────────────

export interface ApplyOptions {
  /** Empreinte `base` de la prévisualisation confirmée (obligatoire). */
  expectedBase: string;
  /** Console de production : confirmation explicite de l'environnement. */
  confirmProduction?: boolean;
}

export interface ApplyResult {
  outcome: 'applied' | 'recognized';
  importId: number | null;
  versionId: number;
  visibleNumber: number | null;
  revisionNumber: number | null;
  previousVersionId: number | null;
  liftedInterventions: number;
  resetPromotions: number;
}

async function recordRefusal(environment: string, doc: ConfigExportDocument | null, issues: ImportIssue[], userId: number): Promise<void> {
  try {
    const sql = pgClient as unknown as SqlLike;
    if (!(await tableReady(sql))) return;
    const email = (await q(sql, `SELECT email FROM users WHERE id = $1`, [userId]))[0]?.email ?? null;
    await q(sql,
      `INSERT INTO ai_config_imports (environment, action, status, format_version, file_signature, configuration_sha256, source_environment,
         source_export_id, source_version_number, source_revision_number, source_exported_at, source_app_version, diagnostics, created_by, created_by_email)
       VALUES ($1, 'import', 'refused', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)`,
      [environment, doc?.formatVersion ?? null, doc?.integrity?.signature ?? null, doc?.integrity?.configurationSha256 ?? null,
       doc?.source?.environment ?? null, doc?.exportId ?? null, doc?.version?.number ?? null, doc?.revision?.number ?? null,
       doc?.exportedAt && !Number.isNaN(Date.parse(doc.exportedAt)) ? doc.exportedAt : null, doc?.source?.appVersion ?? null,
       JSON.stringify(issues.filter((i) => i.blocking).slice(0, 200)), userId, email]);
  } catch (e) {
    console.error('[config-import] refus non journalisé (non bloquant) :', (e as Error).message);
  }
  const { recordConfigAudit } = await import('./config-entry.audit');
  await recordConfigAudit('ai_config_import_refused', userId, null, {
    signature: doc?.integrity?.signature ?? null, blocking: issues.filter((i) => i.blocking).map((i) => i.message).slice(0, 20),
  });
}

/**
 * Confirme l'import : contrôles sur le même fichier, base inchangée depuis la
 * prévisualisation, puis UNE transaction (tout ou rien).
 */
export async function applyImport(content: string, opts: ApplyOptions, userId: number, deps: {
  target?: ImportTargetContext;
  /** Réservé aux tests : panne simulée à une étape de la transaction. */
  failAt?: 'after_version' | 'after_activation' | 'after_interventions';
} = {}): Promise<ApplyResult> {
  const environment = getAiEnvironment();
  if (environment === 'production' && opts.confirmProduction !== true) {
    throw new ConfigOperationRefused('PRODUCTION_CONFIRMATION_REQUIRED', 'Environnement de PRODUCTION : saisissez « production » pour confirmer l’import.');
  }
  if (!opts.expectedBase) throw new ConfigOperationRefused('PREVIEW_REQUIRED', 'Prévisualisez l’import avant de le confirmer.');
  const d = detectImportFormat(content);
  if (!d.ok) {
    await recordRefusal(environment, null, [{ category: 'integrity', path: 'format', message: d.message, blocking: true }], userId);
    refusalOf(d);
  }
  const doc = d.doc;
  const ctx = deps.target ?? await buildTargetContext();
  const issues = checkImportDocument(doc, ctx);
  const bloquants = issues.filter((i) => i.blocking);
  if (bloquants.length) {
    await recordRefusal(environment, doc, issues, userId);
    throw new ConfigOperationRefused('IMPORT_REFUSED',
      `Import refusé : ${bloquants.length} contrôle(s) bloquant(s) — ${bloquants.slice(0, 5).map((i) => i.message).join(' ; ')}${bloquants.length > 5 ? ' ; …' : ''} La configuration active est inchangée.`,
      bloquants);
  }
  const entries = incomingEntries(doc);
  const prompts = new Map<Treatment, { masterPromptCode: string; content: string; contentSha256: string; execution: MasterExecutionConfig | null }>();
  for (const t of doc.configuration.treatments) {
    if (!isTreatment(String(t.code)) || !t.masterPrompt) continue;
    prompts.set(t.code, { masterPromptCode: t.masterPrompt.code, content: t.masterPrompt.content, contentSha256: promptSha256(t.masterPrompt.content), execution: t.masterPrompt.execution ?? null });
  }

  const r = await pgClient.begin(async (tx) => {
    const sql = tx as unknown as SqlLike;
    await lockEnvironment(sql, environment);
    if (!(await tableReady(sql))) throw new ConfigOperationRefused('SCHEMA_NOT_READY', 'Migration 0728 non appliquée : import indisponible.');
    const state = await currentState(environment, sql);
    if (state.base !== opts.expectedBase) {
      throw new ConfigOperationRefused('PREVIEW_STALE',
        'La configuration de cet environnement a changé depuis la prévisualisation (version, révision, exclusion, gel ou routage) : relancez la prévisualisation. Rien n’a été modifié.');
    }
    const preview = computePreview(doc, state, issues, await importSnapshotOf(state.lastImport));
    if (preview.alreadyApplied && state.active) {
      return { outcome: 'recognized' as const, importId: state.lastImport!.id, versionId: state.active.id, visibleNumber: state.active.visibleNumber,
        revisionNumber: state.active.currentRevisionNumber, previousVersionId: null, liftedInterventions: 0, resetPromotions: 0, switches: [] as Array<{ treatment: Treatment; versionNumber: number; masterPromptCode: string }> };
    }
    // Prompts maîtres : version existante de même texte, sinon créée (jamais active ici).
    const masterPrompts: ConfigSnapshot['masterPrompts'] = {};
    for (const [t, p] of prompts) masterPrompts[t] = await findOrCreateMasterPromptVersionInTx(sql, environment, t, p, userId) as MasterPromptRef;
    const snapshot = buildSnapshot(entries, masterPrompts);
    const label = `Import ${doc.source?.environment ?? '?'} v${doc.version?.number ?? '?'} r${doc.revision?.number ?? '?'}`;
    const v = await insertVersionWithSnapshotInTx(sql, {
      environment, label: label.slice(0, 120), snapshot, userId,
      description: `Import du fichier ${doc.integrity.signature.slice(0, 12)}… exporté le ${doc.exportedAt}${doc.exportedBy?.email ? ` par ${doc.exportedBy.email}` : ''}.`,
      comment: `Import complet du fichier ${doc.integrity.signature.slice(0, 12)}… (${doc.source?.environment ?? '?'} v${doc.version?.number ?? '?'} r${doc.revision?.number ?? '?'})`,
    });
    if (deps.failAt === 'after_version') throw new Error('panne simulée après création de la version');
    const act = await activateVersionInTx(sql, environment, v.versionId, userId, { summary: `Import de la configuration IA (${label})` });
    if (deps.failAt === 'after_activation') throw new Error('panne simulée après activation');
    const email = (await q(sql, `SELECT email FROM users WHERE id = $1`, [userId]))[0]?.email ?? null;
    const summary = {
      label, treatments: preview.treatments, changeCount: preview.diff.changeCount, masterPromptChanges: preview.masterPromptChanges.map((m) => m.treatment),
      localChangesNote: preview.localChanges.note, lostExclusions: preview.lostExclusions.map((x) => ({ id: x.id, model: x.model, treatment: x.treatment })),
      liftedFreezes: preview.liftedFreezes.map((x) => ({ id: x.id, treatment: x.treatment })),
      resetPromotions: preview.resetPromotions.map((p) => ({ id: p.id, operationCode: p.operationCode, model: p.model })),
      reauthorizedModels: preview.reauthorizedModels, pairs: preview.pairs,
      warnings: issues.filter((i) => !i.blocking).map((i) => i.message).slice(0, 50),
    };
    const row = (await q(sql,
      `INSERT INTO ai_config_imports (environment, action, status, format_version, file_signature, configuration_sha256, file_content,
         source_environment, source_export_id, source_version_number, source_revision_number, source_exported_at, source_app_version,
         previous_version_id, previous_revision_id, new_version_id, new_revision_id, summary, created_by, created_by_email)
       VALUES ($1, 'import', 'applied', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18) RETURNING id`,
      [environment, doc.formatVersion, doc.integrity.signature, doc.integrity.configurationSha256, content,
       doc.source?.environment ?? null, doc.exportId, doc.version?.number ?? null, doc.revision?.number ?? null, doc.exportedAt, doc.source?.appVersion ?? null,
       state.active?.id ?? null, state.active?.currentRevisionId ?? null, v.versionId, act.revisionId, JSON.stringify(summary), userId, email]))[0];
    const importId = Number(row.id);
    const levees = await liftAllForImportInTx(sql, environment, importId, userId);
    if (deps.failAt === 'after_interventions') throw new Error('panne simulée après levée des interventions');
    const remises = await resetAllForImportInTx(sql, environment, importId, userId);
    return {
      outcome: 'applied' as const, importId, versionId: v.versionId, visibleNumber: v.visibleNumber, revisionNumber: act.revisionNumber,
      previousVersionId: state.active?.id ?? null, liftedInterventions: levees.length, resetPromotions: remises.length, switches: act.masterPromptSwitches,
    };
  });

  const { switches, ...result } = r as ApplyResult & { switches: Array<{ treatment: Treatment; versionNumber: number; masterPromptCode: string }> };
  const { recordConfigAudit } = await import('./config-entry.audit');
  if (result.outcome === 'applied') {
    const { afterCommit } = await import('./config-version.service');
    await afterCommit(`import:${result.importId}`, switches);
    await recordConfigAudit('ai_config_import', userId, { activeVersionId: result.previousVersionId }, {
      importId: result.importId, activeVersionId: result.versionId, signature: doc.integrity.signature,
      source: `${doc.source?.environment ?? '?'} v${doc.version?.number ?? '?'} r${doc.revision?.number ?? '?'}`,
      liftedInterventions: result.liftedInterventions, resetPromotions: result.resetPromotions,
    });
  } else {
    await recordConfigAudit('ai_config_import_recognized', userId, null, { importId: result.importId, signature: doc.integrity.signature });
  }
  return result;
}

// ── 5. Retour à la configuration antérieure ─────────────────────────────────

export interface RollbackResult {
  rollbackId: number;
  importId: number;
  versionId: number;
  revisionNumber: number;
  restoredInterventions: number;
  restoredPromotions: number;
  revertedPromotions: number;
}

/**
 * Annule le DERNIER import appliqué : la version et la révision qu'il avait
 * remplacées redeviennent actives (contrôles techniques de réactivation,
 * décision 06 ; pas de test métier), les interventions qu'il avait levées
 * et les promotions qu'il avait remises à zéro sont rétablies. RUN-05 : les
 * exécutions suivantes seulement ; aucune donnée métier n'est modifiée.
 */
export async function rollbackImport(importId: number, opts: { confirmProduction?: boolean }, userId: number): Promise<RollbackResult> {
  const environment = getAiEnvironment();
  if (environment === 'production' && opts.confirmProduction !== true) {
    throw new ConfigOperationRefused('PRODUCTION_CONFIRMATION_REQUIRED', 'Environnement de PRODUCTION : saisissez « production » pour confirmer le retour arrière.');
  }
  const imp = (await listImports(environment, 500)).find((x) => x.id === importId);
  if (!imp || imp.action !== 'import' || imp.status !== 'applied') throw new ConfigOperationRefused('IMPORT_NOT_FOUND', `Import ${importId} introuvable (ou non appliqué).`);
  if (imp.rolledBackAt) throw new ConfigOperationRefused('ALREADY_ROLLED_BACK', 'Cet import a déjà été annulé.');
  if (imp.previousVersionId == null || imp.previousRevisionId == null) {
    throw new ConfigOperationRefused('NO_PREVIOUS_CONFIGURATION', 'Aucune configuration n’était active avant cet import : il n’y a rien à rétablir.');
  }
  const previous = await getVersion(imp.previousVersionId);
  if (!previous) throw new ConfigOperationRefused('VERSION_NOT_FOUND', `La version remplacée (${imp.previousVersionId}) est introuvable.`);
  if (previous.deletedAt) throw new ConfigOperationRefused('VERSION_DELETED', `La version remplacée v${previous.visibleNumber ?? previous.id} a été supprimée : restaurez-la dans la liste avant le retour arrière.`);
  const rev = await getRevision(imp.previousRevisionId);
  if (!rev) throw new ConfigOperationRefused('REVISION_NOT_FOUND', 'La révision remplacée est introuvable.');
  // Décision 06 / RUN-05 : contrôles TECHNIQUES de réactivation sur la configuration rétablie.
  const { assertVersionTechnicallyCompatible } = await import('./config-version.service');
  await assertVersionTechnicallyCompatible({ entries: rev.snapshot.entries });

  const r = await pgClient.begin(async (tx) => {
    const sql = tx as unknown as SqlLike;
    await lockEnvironment(sql, environment);
    const dernier = await lastAppliedImport(environment, sql);
    if (!dernier || dernier.id !== importId) throw new ConfigOperationRefused('NOT_LAST_IMPORT', 'Seul le dernier import appliqué peut être annulé.');
    const restaure = await restoreRevisionInTx(sql, imp.previousVersionId!, imp.previousRevisionId!, userId,
      `Retour à la configuration antérieure à l’import n°${importId}`);
    const act = await activateVersionInTx(sql, environment, imp.previousVersionId!, userId, { summary: `Retour arrière de l’import n°${importId}` });
    const interventions = await restoreLiftedByImportInTx(sql, environment, importId);
    const routage = await restoreForRollbackInTx(sql, environment, importId, userId);
    const email = (await q(sql, `SELECT email FROM users WHERE id = $1`, [userId]))[0]?.email ?? null;
    await sql.unsafe(`UPDATE ai_config_imports SET rolled_back_at = now(), rolled_back_by = $2 WHERE id = $1`, [importId, userId] as never[]);
    const row = (await q(sql,
      `INSERT INTO ai_config_imports (environment, action, status, format_version, file_signature, configuration_sha256, previous_version_id, previous_revision_id,
         new_version_id, new_revision_id, rollback_of, summary, created_by, created_by_email)
       VALUES ($1, 'rollback', 'applied', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12) RETURNING id`,
      [environment, imp.formatVersion, imp.fileSignature, imp.configurationSha256, imp.newVersionId, imp.newRevisionId,
       imp.previousVersionId, restaure.revisionId, importId,
       JSON.stringify({ restoredInterventions: interventions.map((i) => i.id), restoredPromotions: routage.restored.map((p) => p.id), revertedPromotions: routage.reverted.map((p) => p.id), revisionRestored: restaure.restored }),
       userId, email]))[0];
    return {
      rollbackId: Number(row.id), importId, versionId: imp.previousVersionId!, revisionNumber: act.revisionNumber,
      restoredInterventions: interventions.length, restoredPromotions: routage.restored.length, revertedPromotions: routage.reverted.length,
      switches: act.masterPromptSwitches,
    };
  });
  const { switches, ...result } = r as RollbackResult & { switches: Array<{ treatment: Treatment; versionNumber: number; masterPromptCode: string }> };
  const { afterCommit } = await import('./config-version.service');
  await afterCommit(`import-rollback:${importId}`, switches);
  const { recordConfigAudit } = await import('./config-entry.audit');
  await recordConfigAudit('ai_config_import_rollback', userId, { importId, activeVersionId: imp.newVersionId }, { rollbackId: result.rollbackId, activeVersionId: result.versionId });
  return result;
}

// ── 6. Preuves importées pour le routage automatique ────────────────────────

/**
 * La preuve importée (fichier du dernier import) autorise-t-elle une
 * promotion AUTOMATIQUE de ce couple, aux empreintes ACTUELLES (profil
 * effectif du modèle dans la configuration active, prompt maître en
 * service, contrat de sortie, seuils) ? Lecture seule.
 */
export async function automaticPromotionEvidence(importId: number, operationCode: string, model: string, entry: TreatmentConfig, sql: SqlLike = pgClient as unknown as SqlLike): Promise<{ admissible: boolean; detail: Record<string, unknown> }> {
  const row = (await q(sql, `SELECT file_content FROM ai_config_imports WHERE id = $1`, [importId]))[0];
  const d = row?.file_content ? detectImportFormat(String(row.file_content)) : null;
  if (!d || !d.ok) return { admissible: false, detail: { reason: 'fichier importé illisible' } };
  const { getActiveVersion: active } = await import('./config-version.repository');
  const a = await active(getAiEnvironment());
  const promptSha = a?.masterPrompts?.[entry.treatment]?.contentSha256 ?? null;
  const courant = allowedPairsOf([entry], () => promptSha).find((p) => p.operationCode === operationCode && p.model === model);
  if (!courant) return { admissible: false, detail: { reason: 'couple absent de la configuration active' } };
  const i = d.doc.allowedPairs.findIndex((p) => p.operationCode === operationCode && p.model === model && p.profileSha256 === courant.profileSha256);
  if (i < 0) return { admissible: false, detail: { reason: 'couple (profil effectif) absent du fichier importé' } };
  const e = d.doc.qualification.evidence[i];
  const ok = evidenceSupportsAutomaticPromotion(e, {
    profileSha256: courant.profileSha256, promptSha256: promptSha,
    contractRef: courant.contractRef, thresholdsSha256: thresholdsSha256(qualificationThresholds()),
  });
  return { admissible: ok, detail: { importId, status: e?.status ?? null, testedAt: e?.testedAt ?? null, profileSha256: courant.profileSha256 } };
}
