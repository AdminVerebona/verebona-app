/**
 * Export de la configuration IA active — lot 54 (54C), ticket « BO-IA —
 * Refonte de la gestion des versions, restauration et export », §4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE FAIT « EXPORTER LA CONFIGURATION »
 *
 *   1. lit, en UNE requête, la version active et sa dernière révision
 *      enregistrée à cet instant (aucun export préparé à l'avance) ;
 *   2. construit un fichier JSON autonome et versionné (format
 *      `verebona-ia-config-export` 1.0.0) : configuration de chaque
 *      traitement maintenu (T1, T2, T3, T4, T6 — jamais T5), prompts maîtres
 *      complets, modèles et chaînes de repli, paramètres d'exécution,
 *      déclencheurs, garde-fous, cascade, valeurs par défaut du code,
 *      réglages hors version (assistant, budgets) et liste des paramètres
 *      SENSIBLES ou propres à l'environnement à renseigner séparément ;
 *   3. le VALIDE (structure, champs obligatoires, références, empreintes,
 *      absence de secret) — un fichier invalide n'est jamais proposé ;
 *   4. enregistre le texte EXACT du fichier et son empreinte dans
 *      `ai_config_exports` (immuable), puis le rend au navigateur.
 *
 * Ne modifie ni ne fige la version active ; ne déclenche aucune opération en
 * production ; aucune clé API, aucun mot de passe.
 */
import { randomUUID } from 'node:crypto';
import { pgClient } from '@/db';
import { getAiEnvironment, type AiEnvironment } from './environment';
import { TREATMENTS, TREATMENT_DEFINITIONS, isTreatment, type Treatment } from './treatments';
import { TRIGGER_CATALOG, guardrailCodes } from './catalogs';
import { normalizeSnapshot, canonicalJson, sha256, type ConfigSnapshot, type MasterPromptRef } from './config-snapshot';
import { masterPromptOf, type TreatmentConfig } from './config-types';
import { ConfigOperationRefused } from './config-version.service';
import { executionConfigFor, structuredSpecFor, type MasterExecutionConfig } from '../master-prompts/structured-context';

export const EXPORT_FORMAT = 'verebona-ia-config-export' as const;
export const EXPORT_FORMAT_VERSION = '1.0.0' as const;

type Row = Record<string, unknown>;

// ── Forme du fichier ────────────────────────────────────────────────────────

export interface ExportedMasterPrompt {
  code: string;
  /**
   * D'où vient le texte : `revision` (figé dans la révision exportée),
   * `active` (prompt actif, non figé dans la révision), `configuration`
   * (texte de la ligne de configuration, D-03), `repository` (fichier du
   * dépôt, valeur initiale).
   */
  source: 'revision' | 'active' | 'configuration' | 'repository';
  versionId: number | null;
  versionNumber: number | null;
  sha256: string;
  content: string;
  execution: MasterExecutionConfig | null;
}

export interface ExportedTreatment {
  code: Treatment;
  label: string;
  execution: 'batch' | 'synchronous';
  models: {
    primary: string | null;
    fallbacks: string[];
    reasoning: { primary: string | null; fallback1: string | null; fallback2: string | null };
    maxOutputTokens: number | null;
  };
  /** Préambule administrable (champ « prompt » de la ligne), vide = aucun. */
  preamble: string;
  masterPrompt: ExportedMasterPrompt | null;
  guardrails: TreatmentConfig['guardrails'];
  triggers: TreatmentConfig['triggers'];
  cascade: TreatmentConfig['cascade'];
  /** Valeurs du code appliquées quand un champ n'est pas renseigné. */
  codeDefaults: Array<{ operationCode: string; primaryModel: string; fallbackModels: string[]; defaultMaxOutputTokens: number | null }>;
}

export interface EnvironmentParameter {
  name: string;
  kind: 'secret' | 'environment' | 'operational';
  /** Où le renseigner dans l'environnement cible. */
  where: string;
  /** Toujours `null` pour un secret : jamais exporté. */
  value: string | number | boolean | null;
  note: string;
}

export interface ConfigExportDocument {
  format: typeof EXPORT_FORMAT;
  formatVersion: typeof EXPORT_FORMAT_VERSION;
  exportId: string;
  exportedAt: string;
  exportedBy: { userId: number; email: string | null };
  source: { application: 'Verebona'; environment: AiEnvironment; appVersion: string | null };
  version: { id: number; uid: string; number: number | null; name: string | null; description: string | null; activatedAt: string | null };
  revision: { id: number | null; number: number; savedAt: string | null; savedBy: string | null; comment: string | null; kind: string | null };
  configuration: {
    snapshotFormat: ConfigSnapshot['format'];
    treatments: ExportedTreatment[];
  };
  settingsOutsideVersion: {
    note: string;
    assistant: Array<{ key: string; label: string; group: string; type: string; value: number | boolean; source: string; environmentVariable: string }>;
    costBudgets: { anomaliesEnabled: boolean; budgets: Array<{ scope: string; monthlyBudgetMicros: number | null }> } | null;
  };
  references: {
    provider: string;
    models: string[];
    masterPromptCodes: string[];
    guardrailCodes: string[];
    triggerCodes: string[];
  };
  environmentParameters: EnvironmentParameter[];
  integrity: { configurationSha256: string; algorithm: 'sha256' };
}

/** Entrées de construction (lues en base par `gatherExportInputs`). */
export interface ExportInputs {
  environment: AiEnvironment;
  appVersion: string | null;
  version: { id: number; uid: string; number: number | null; label: string | null; description: string | null; activatedAt: Date | null };
  revision: { id: number | null; number: number; savedAt: Date | null; savedBy: string | null; comment: string | null; kind: string | null };
  snapshot: ConfigSnapshot;
  /** Prompts maîtres actifs (repli si la révision ne fige pas un traitement). */
  activeMasterPrompts: ConfigSnapshot['masterPrompts'];
  /** Texte du fichier du dépôt (dernier repli), par code. */
  repositoryText: (masterPromptCode: string) => string | null;
  masterPromptCodeOf: (t: Treatment) => string | null;
  codeDefaults: (t: Treatment) => ExportedTreatment['codeDefaults'];
  assistant: ConfigExportDocument['settingsOutsideVersion']['assistant'];
  costBudgets: ConfigExportDocument['settingsOutsideVersion']['costBudgets'];
}

/** Empreinte d'un texte de prompt (fins de ligne normalisées, comme 0254). */
export function promptSha256(content: string): string {
  return sha256(content.replace(/\r\n?/g, '\n'));
}

function exportedMasterPrompt(t: Treatment, inputs: ExportInputs, entry: TreatmentConfig | undefined): ExportedMasterPrompt | null {
  const code = inputs.masterPromptCodeOf(t);
  const ref: MasterPromptRef | null | undefined = inputs.snapshot.masterPrompts[t];
  const actif = inputs.activeMasterPrompts[t];
  const depuis = (r: MasterPromptRef, source: 'revision' | 'active'): ExportedMasterPrompt => ({
    code: r.masterPromptCode || code || '', source, versionId: r.versionId, versionNumber: r.versionNumber,
    sha256: r.contentSha256, content: r.content,
    // Instantané de reprise sans exécution : celle de la version référencée.
    execution: r.execution !== undefined ? r.execution ?? null : (actif && actif.versionId === r.versionId ? actif.execution ?? null : null),
  });
  if (ref) return depuis(ref, 'revision');
  if (actif) return depuis(actif, 'active');
  if (!code) return null;
  const texte = masterPromptOf(entry);
  if (texte) return { code, source: 'configuration', versionId: null, versionNumber: null, sha256: promptSha256(texte), content: texte, execution: null };
  const fichier = inputs.repositoryText(code);
  if (fichier == null) return null;
  // Lot 54 : le texte du dépôt porte la configuration qu'il DÉCLARE (T4 :
  // contexte structuré t4_input_v2 / t4_output_v2), jamais « aucune ».
  return {
    code, source: 'repository', versionId: null, versionNumber: null, sha256: promptSha256(fichier), content: fichier,
    execution: structuredSpecFor(code) ? executionConfigFor({ masterPromptCode: code, source: 'file' }) : null,
  };
}

/** Paramètres jamais exportés ou propres à l'environnement, à renseigner séparément. */
export function environmentParameters(
  environment: AiEnvironment,
  assistant: ConfigExportDocument['settingsOutsideVersion']['assistant'],
): EnvironmentParameter[] {
  const out: EnvironmentParameter[] = [
    {
      name: 'Clé API du fournisseur IA (Google Gemini)', kind: 'secret', where: 'BO › Fournisseur IA (clé candidate, test, activation)',
      value: null, note: 'Secret : jamais exporté. À saisir dans l’environnement cible ; les modèles cités doivent y être disponibles et qualifiés.',
    },
    {
      name: 'NEXT_PUBLIC_APP_ENV', kind: 'environment', where: 'Variables d’environnement de l’hébergeur',
      value: null, note: `Environnement d’origine de ce fichier : ${environment}. En production : « production ».`,
    },
    {
      name: 'État opérationnel des traitements et arrêt d’urgence', kind: 'operational', where: 'BO › Configuration IA (état de chaque traitement), BO › File IA',
      value: null, note: 'Hors configuration versionnée (GEN-001) : non exporté, à régler dans l’environnement cible.',
    },
    {
      name: 'Budgets mensuels IA et détection d’anomalies', kind: 'operational', where: 'BO › Coûts IA',
      value: null, note: 'Paramètres locaux à l’environnement : valeurs de l’environnement d’origine données pour référence (settingsOutsideVersion.costBudgets).',
    },
  ];
  for (const s of assistant.filter((a) => a.source === 'env')) {
    out.push({
      name: s.environmentVariable, kind: 'environment', where: 'Variables d’environnement de l’hébergeur, ou BO › Configuration IA › Assistant',
      value: s.value, note: `« ${s.label} » est fixé par une variable d’environnement dans l’environnement d’origine.`,
    });
  }
  return out;
}

/** Construit le document d'export (pur). */
export function buildExportDocument(inputs: ExportInputs, meta: {
  exportId: string; exportedAt: Date; userId: number; email: string | null;
}): ConfigExportDocument {
  const snapshot = normalizeSnapshot(inputs.snapshot);
  const treatments: ExportedTreatment[] = TREATMENTS.map((t) => {
    const e = snapshot.entries.find((x) => x.treatment === t);
    return {
      code: t,
      label: TREATMENT_DEFINITIONS[t].label,
      execution: TREATMENT_DEFINITIONS[t].batch ? 'batch' : 'synchronous',
      models: {
        primary: e?.primaryModel ?? null,
        fallbacks: [e?.fallback1, e?.fallback2].filter((m): m is string => Boolean(m)),
        reasoning: { primary: e?.reasoningPrimary ?? null, fallback1: e?.reasoningFallback1 ?? null, fallback2: e?.reasoningFallback2 ?? null },
        maxOutputTokens: e?.maxOutputTokens ?? null,
      },
      preamble: e?.prompt ?? '',
      masterPrompt: exportedMasterPrompt(t, inputs, e),
      guardrails: e?.guardrails ?? [],
      triggers: e?.triggers ?? [],
      cascade: e?.cascade ?? null,
      codeDefaults: inputs.codeDefaults(t),
    };
  });
  const settingsOutsideVersion: ConfigExportDocument['settingsOutsideVersion'] = {
    note: 'Réglages NON versionnés (hors version de configuration), valeurs de l’environnement d’origine au moment de l’export : '
      + 'à reporter dans l’environnement cible (BO › Configuration IA › Assistant ; BO › Coûts IA).',
    assistant: inputs.assistant,
    costBudgets: inputs.costBudgets,
  };
  const configuration = { snapshotFormat: snapshot.format, treatments };
  const models = [...new Set(treatments.flatMap((t) => [t.models.primary, ...t.models.fallbacks]).filter((m): m is string => Boolean(m)))].sort();
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportId: meta.exportId,
    exportedAt: meta.exportedAt.toISOString(),
    exportedBy: { userId: meta.userId, email: meta.email },
    source: { application: 'Verebona', environment: inputs.environment, appVersion: inputs.appVersion },
    version: {
      id: inputs.version.id, uid: inputs.version.uid, number: inputs.version.number,
      name: inputs.version.label, description: inputs.version.description,
      activatedAt: inputs.version.activatedAt ? inputs.version.activatedAt.toISOString() : null,
    },
    revision: {
      id: inputs.revision.id, number: inputs.revision.number,
      savedAt: inputs.revision.savedAt ? inputs.revision.savedAt.toISOString() : null,
      savedBy: inputs.revision.savedBy, comment: inputs.revision.comment, kind: inputs.revision.kind,
    },
    configuration,
    settingsOutsideVersion,
    references: {
      provider: 'gemini',
      models,
      masterPromptCodes: treatments.map((t) => t.masterPrompt?.code).filter((c): c is string => Boolean(c)),
      guardrailCodes: [...new Set(treatments.flatMap((t) => t.guardrails.map((g) => g.code)))].sort(),
      triggerCodes: [...new Set(treatments.flatMap((t) => t.triggers.map((g) => g.code)))].sort(),
    },
    environmentParameters: environmentParameters(inputs.environment, inputs.assistant),
    integrity: { configurationSha256: configurationSha256({ configuration, settingsOutsideVersion }), algorithm: 'sha256' },
  };
}

/**
 * Empreinte de la CONFIGURATION seule (sans horodatage, auteur, identifiant
 * d'export ni numéros) : deux exports d'une même configuration ont la même.
 */
export function configurationSha256(p: Pick<ConfigExportDocument, 'configuration' | 'settingsOutsideVersion'>): string {
  return sha256(canonicalJson({ configuration: p.configuration, settingsOutsideVersion: p.settingsOutsideVersion }));
}

// ── Validation avant téléchargement ─────────────────────────────────────────

export interface ExportIssue { path: string; message: string; blocking: boolean }

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/AIza[0-9A-Za-z_-]{30,}/, 'clé API Google'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'clé API'],
  [/\b[sr]k_(live|test)_[0-9A-Za-z]{10,}/, 'clé Stripe'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'clé privée'],
  [/postgres(?:ql)?:\/\/[^\s"':]+:[^\s"'@]+@/, 'chaîne de connexion avec mot de passe'],
];
const SECRET_KEYS = /^(api[_-]?key|apikey|password|passwd|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|credential)s?$/i;

/** Clés sensibles renseignées n'importe où dans le document (hors valeur `null`). */
function secretKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => secretKeys(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Row).flatMap(([k, v]) => [
    ...(SECRET_KEYS.test(k) && v != null && v !== '' ? [`${path}.${k}`] : []),
    ...secretKeys(v, `${path}.${k}`),
  ]);
}

/** Contrôle complet du document (pur). Bloquant : jamais proposé au téléchargement. */
export function validateExportDocument(doc: ConfigExportDocument): ExportIssue[] {
  const issues: ExportIssue[] = [];
  const err = (path: string, message: string) => issues.push({ path, message, blocking: true });
  const warn = (path: string, message: string) => issues.push({ path, message, blocking: false });

  if (doc.format !== EXPORT_FORMAT) err('format', 'Format inconnu.');
  if (doc.formatVersion !== EXPORT_FORMAT_VERSION) err('formatVersion', 'Version de format inconnue.');
  if (!/^[0-9a-f-]{36}$/.test(doc.exportId)) err('exportId', 'Identifiant d’export manquant.');
  if (Number.isNaN(Date.parse(doc.exportedAt))) err('exportedAt', 'Horodatage d’export manquant.');
  if (!(doc.version?.id > 0) || !doc.version.uid) err('version', 'Identifiant de version manquant.');
  if (!(Number(doc.version?.number) > 0)) err('version.number', 'Numéro de version manquant.');
  if (!(Number(doc.revision?.number) > 0)) err('revision.number', 'Numéro de révision manquant.');

  const codes = (doc.configuration?.treatments ?? []).map((t) => t.code);
  for (const t of TREATMENTS) if (!codes.includes(t)) err(`configuration.treatments`, `Traitement ${t} absent.`);
  if (new Set(codes).size !== codes.length) err('configuration.treatments', 'Traitement présent deux fois.');
  for (const c of codes) if (!isTreatment(String(c))) err('configuration.treatments', `Traitement « ${String(c)} » inconnu ou retiré.`);

  const gardes = guardrailCodes();
  for (const t of doc.configuration?.treatments ?? []) {
    const p = `configuration.treatments.${t.code}`;
    for (const m of [t.models.primary, ...t.models.fallbacks]) {
      if (m !== null && (typeof m !== 'string' || m.trim() === '')) err(`${p}.models`, 'Identifiant de modèle vide.');
    }
    if (!t.models.primary && t.codeDefaults.length === 0) err(`${p}.models.primary`, 'Aucun modèle principal ni valeur par défaut du code.');
    if (!t.masterPrompt) err(`${p}.masterPrompt`, 'Prompt maître introuvable.');
    else {
      if (!t.masterPrompt.content.trim()) err(`${p}.masterPrompt.content`, 'Texte du prompt maître vide.');
      if (promptSha256(t.masterPrompt.content) !== t.masterPrompt.sha256) err(`${p}.masterPrompt.sha256`, 'Empreinte du prompt maître incohérente avec son texte.');
      if (!t.masterPrompt.code) err(`${p}.masterPrompt.code`, 'Code du prompt maître manquant.');
    }
    for (const g of t.guardrails) if (!gardes.has(g.code)) err(`${p}.guardrails`, `Garde-fou inconnu du catalogue : « ${g.code} ».`);
    for (const tr of t.triggers) {
      const def = TRIGGER_CATALOG.find((d) => d.code === tr.code);
      if (!def) err(`${p}.triggers`, `Déclencheur inconnu du catalogue : « ${tr.code} ».`);
      else if (def.retired) warn(`${p}.triggers`, `Déclencheur « ${tr.code} » retiré : ignoré à l’exécution.`);
    }
  }
  const attendue = configurationSha256(doc);
  if (doc.integrity?.configurationSha256 !== attendue) err('integrity.configurationSha256', 'Empreinte de la configuration incohérente.');

  // Aucun secret : ni valeur reconnaissable, ni clé sensible renseignée.
  const texte = JSON.stringify(doc);
  for (const [re, quoi] of SECRET_PATTERNS) if (re.test(texte)) err('(document)', `Donnée sensible détectée (${quoi}) : export refusé.`);
  for (const k of secretKeys(doc)) err(k, 'Paramètre sensible renseigné : export refusé.');
  for (const p of doc.environmentParameters ?? []) {
    if (p.kind === 'secret' && p.value !== null) err('environmentParameters', `Valeur de « ${p.name} » présente : export refusé.`);
  }
  return issues;
}

/** Nom proposé : `verebona-ia-config-v5-r8-20261013-104500.json` (heure de Paris). */
export function exportFileName(versionNumber: number | null, revisionNumber: number, at: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  return `verebona-ia-config-v${versionNumber ?? 0}-r${revisionNumber}-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}.json`;
}

// ── Lecture des entrées (base) ──────────────────────────────────────────────

/** Version active et sa dernière révision, lues ensemble ; `null` sans active. */
export async function gatherExportInputs(environment: AiEnvironment = getAiEnvironment()): Promise<ExportInputs | null> {
  const rows = (await pgClient.unsafe(
    `SELECT v.id, v.uid, v.visible_number, v.label, v.description, v.activated_at, v.current_revision_id,
            r.id AS rev_id, r.revision_number, r.created_at AS rev_at, r.created_by_email, r.comment, r.kind, r.snapshot
       FROM ai_config_versions v
       LEFT JOIN ai_config_revisions r ON r.id = v.current_revision_id
      WHERE v.environment = $1 AND v.status = 'ACTIVE' LIMIT 1`,
    [environment] as never[],
  )) as unknown as Row[];
  let r = rows[0];
  if (!r) return null;
  if (r.rev_id == null) {
    // Active sans révision (insérée hors application) : sa révision est
    // créée par une écriture neutre, puis relue — jamais exportée sans numéro.
    const repo = await import('./config-version.repository');
    await repo.ensureVersionRevision(Number(r.id));
    r = ((await pgClient.unsafe(
      `SELECT v.id, v.uid, v.visible_number, v.label, v.description, v.activated_at, v.current_revision_id,
              r.id AS rev_id, r.revision_number, r.created_at AS rev_at, r.created_by_email, r.comment, r.kind, r.snapshot
         FROM ai_config_versions v JOIN ai_config_revisions r ON r.id = v.current_revision_id
        WHERE v.id = $1`, [Number(r.id)] as never[],
    )) as unknown as Row[])[0];
    if (!r) throw new ConfigOperationRefused('EXPORT_INVALID', 'La version active n’a pas de révision enregistrée.');
  }
  const [{ readActiveMasterPromptRefs }, { masterPromptForTreatment }, { readMasterFileFromRepo }, { AI_OPERATIONS }, { getBuildIdentity }] = await Promise.all([
    import('./config-version.repository'), import('./prompt-architecture'),
    import('../governance/master-corpus/cases'), import('../registry/operations'), import('@/lib/runtime-identity'),
  ]);
  const activeMasterPrompts = await readActiveMasterPromptRefs(pgClient as never, environment);
  const { refreshAssistantSettings, effectiveAssistantSettings } = await import('@/services/verebona-assistant/config/assistant-settings');
  await refreshAssistantSettings(true).catch(() => undefined);
  const assistant = effectiveAssistantSettings().map((s) => ({
    key: s.key, label: s.label, group: s.group, type: s.type, value: s.value, source: s.source, environmentVariable: s.env,
  }));
  let costBudgets: ExportInputs['costBudgets'] = null;
  try {
    const { getCostSettings } = await import('../alerts/cost-evaluator');
    const c = await getCostSettings();
    costBudgets = { anomaliesEnabled: c.anomaliesEnabled, budgets: c.budgets.map((b) => ({ scope: b.scope, monthlyBudgetMicros: b.monthlyBudgetMicros })) };
  } catch { /* tables absentes : budgets non disponibles (signalé par `null`) */ }
  return {
    environment,
    appVersion: getBuildIdentity().commit,
    version: {
      id: Number(r.id), uid: String(r.uid), number: r.visible_number == null ? null : Number(r.visible_number),
      label: r.label == null ? null : String(r.label), description: r.description == null ? null : String(r.description),
      activatedAt: r.activated_at ? new Date(String(r.activated_at)) : null,
    },
    revision: {
      id: Number(r.rev_id), number: Number(r.revision_number), savedAt: r.rev_at ? new Date(String(r.rev_at)) : null,
      savedBy: r.created_by_email == null ? null : String(r.created_by_email),
      comment: r.comment == null ? null : String(r.comment), kind: r.kind == null ? null : String(r.kind),
    },
    snapshot: normalizeSnapshot(r.snapshot),
    activeMasterPrompts,
    repositoryText: (code) => { try { return readMasterFileFromRepo(code); } catch { return null; } },
    masterPromptCodeOf: (t) => masterPromptForTreatment(t)?.masterPromptCode ?? null,
    codeDefaults: (t) => Object.values(AI_OPERATIONS)
      .filter((op) => op.active && op.provider !== 'none' && TREATMENT_DEFINITIONS[t].useCaseCode === op.useCaseCode)
      .map((op) => ({
        operationCode: op.operationCode, primaryModel: op.primaryModel, fallbackModels: [...op.fallbackModels],
        defaultMaxOutputTokens: op.defaultMaxOutputTokens ?? null,
      })),
    assistant,
    costBudgets,
  };
}

// ── Export ──────────────────────────────────────────────────────────────────

export interface ExportRecord {
  id: number;
  exportUid: string;
  environment: string;
  versionId: number | null;
  versionNumber: number;
  revisionId: number | null;
  revisionNumber: number;
  fileName: string;
  formatVersion: string;
  contentSha256: string;
  configurationSha256: string;
  exportedBy: number | null;
  exportedByEmail: string | null;
  exportedAt: Date;
}

function toRecord(r: Row): ExportRecord {
  return {
    id: Number(r.id), exportUid: String(r.export_uid), environment: String(r.environment),
    versionId: r.version_id == null ? null : Number(r.version_id), versionNumber: Number(r.version_number),
    revisionId: r.revision_id == null ? null : Number(r.revision_id), revisionNumber: Number(r.revision_number),
    fileName: String(r.file_name), formatVersion: String(r.format_version),
    contentSha256: String(r.content_sha256), configurationSha256: String(r.configuration_sha256),
    exportedBy: r.exported_by == null ? null : Number(r.exported_by),
    exportedByEmail: r.exported_by_email == null ? null : String(r.exported_by_email),
    exportedAt: new Date(String(r.exported_at)),
  };
}

const EXPORT_COLS = `id, export_uid, environment, version_id, version_number, revision_id, revision_number, file_name,
                     format_version, content_sha256, configuration_sha256, exported_by, exported_by_email, exported_at`;

/**
 * « Exporter la configuration » : fichier construit à l'instant, validé,
 * enregistré (texte exact + empreinte), puis rendu. Un fichier invalide ou
 * non enregistré n'est JAMAIS rendu.
 */
export async function exportActiveConfiguration(userId: number, deps: {
  /** Réservé aux tests : altère le document avant validation. */
  tamper?: (doc: ConfigExportDocument) => void;
} = {}): Promise<{ record: ExportRecord; content: string; document: ConfigExportDocument; warnings: string[] }> {
  const environment = getAiEnvironment();
  const inputs = await gatherExportInputs(environment);
  if (!inputs) {
    throw new ConfigOperationRefused('NO_ACTIVE_VERSION',
      'Aucune version n’est active : il n’y a pas de configuration à exporter. Activez d’abord une version.');
  }
  const emailRows = (await pgClient.unsafe(`SELECT email FROM users WHERE id = $1`, [userId] as never[])) as unknown as Row[];
  const email = emailRows[0]?.email == null ? null : String(emailRows[0].email);
  const exportedAt = new Date();
  const doc = buildExportDocument(inputs, { exportId: randomUUID(), exportedAt, userId, email });
  deps.tamper?.(doc);
  const issues = validateExportDocument(doc);
  const bloquants = issues.filter((i) => i.blocking);
  if (bloquants.length > 0) {
    throw new ConfigOperationRefused('EXPORT_INVALID',
      `Export impossible : le fichier ne passe pas les contrôles (${bloquants.map((i) => `${i.path} — ${i.message}`).join(' ; ')}). Aucun fichier n’a été produit.`,
      bloquants);
  }
  const content = `${JSON.stringify(doc, null, 2)}\n`;
  const fileName = exportFileName(inputs.version.number, inputs.revision.number, exportedAt);
  const rows = (await pgClient.unsafe(
    `INSERT INTO ai_config_exports
       (export_uid, environment, version_id, version_uid, version_number, revision_id, revision_number, file_name,
        format_version, content, content_sha256, configuration_sha256, exported_by, exported_by_email, exported_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING ${EXPORT_COLS}`,
    [doc.exportId, environment, inputs.version.id, inputs.version.uid, inputs.version.number ?? 0,
     inputs.revision.id, inputs.revision.number, fileName, EXPORT_FORMAT_VERSION, content, sha256(content),
     doc.integrity.configurationSha256, userId, email, exportedAt.toISOString()] as never[],
  )) as unknown as Row[];
  const { recordConfigAudit } = await import('./config-entry.audit');
  await recordConfigAudit('ai_config_export', userId, null, {
    exportUid: doc.exportId, versionId: inputs.version.id, version: inputs.version.number, revision: inputs.revision.number,
    contentSha256: sha256(content),
  });
  return { record: toRecord(rows[0]), content, document: doc, warnings: issues.filter((i) => !i.blocking).map((i) => i.message) };
}

export async function listExports(environment: AiEnvironment = getAiEnvironment(), limit = 20): Promise<ExportRecord[]> {
  const rows = (await pgClient.unsafe(
    `SELECT ${EXPORT_COLS} FROM ai_config_exports WHERE environment = $1 ORDER BY exported_at DESC, id DESC LIMIT $2`,
    [environment, limit] as never[],
  )) as unknown as Row[];
  return rows.map(toRecord);
}

/** Fichier d'un export passé, octet pour octet (immuable). */
export async function getExportFile(id: number, environment: AiEnvironment = getAiEnvironment()): Promise<{ record: ExportRecord; content: string } | null> {
  const rows = (await pgClient.unsafe(
    `SELECT ${EXPORT_COLS}, content FROM ai_config_exports WHERE id = $1 AND environment = $2`,
    [id, environment] as never[],
  )) as unknown as Row[];
  return rows[0] ? { record: toRecord(rows[0]), content: String(rows[0].content) } : null;
}

export interface ExportStatus {
  active: { versionId: number; versionNumber: number | null; name: string | null; revisionNumber: number } | null;
  lastExport: ExportRecord | null;
  /** `null` : jamais exporté, ou aucune active. */
  changedSinceLastExport: boolean | null;
  /** Ce qui a changé : version, révision, contenu (réglages hors version compris). */
  changes: Array<'version' | 'revision' | 'content'>;
}

/** La configuration active a-t-elle changé depuis le dernier export ? */
export async function exportStatus(environment: AiEnvironment = getAiEnvironment()): Promise<ExportStatus> {
  const [last] = await listExports(environment, 1);
  const inputs = await gatherExportInputs(environment);
  if (!inputs) return { active: null, lastExport: last ?? null, changedSinceLastExport: null, changes: [] };
  const active = { versionId: inputs.version.id, versionNumber: inputs.version.number, name: inputs.version.label, revisionNumber: inputs.revision.number };
  if (!last) return { active, lastExport: null, changedSinceLastExport: null, changes: [] };
  const courant = buildExportDocument(inputs, { exportId: randomUUID(), exportedAt: new Date(), userId: 0, email: null });
  const changes: ExportStatus['changes'] = [];
  if (last.versionId !== inputs.version.id) changes.push('version');
  if (last.revisionNumber !== inputs.revision.number || last.revisionId !== inputs.revision.id) changes.push('revision');
  if (last.configurationSha256 !== courant.integrity.configurationSha256) changes.push('content');
  return { active, lastExport: last, changedSinceLastExport: changes.length > 0, changes };
}
