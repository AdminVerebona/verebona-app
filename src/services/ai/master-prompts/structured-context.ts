/**
 * Contexte d'exécution STRUCTURÉ d'un prompt maître — lot 34D (ticket « T4 :
 * découpler le contrat d'exécution du texte du prompt maître »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX MODES, EXPLICITES DANS LA CONFIGURATION
 *
 *   LEGACY_TEMPLATE      le texte porte `{{TASK}}`, `{{EVIDENCE}}`… ; le
 *                        serveur les substitue (`renderMasterPrompt`) —
 *                        comportement historique, inchangé.
 *   STRUCTURED_CONTEXT   le texte est LIBRE (aucun emplacement exigé, aucun
 *                        titre imposé) ; le serveur construit le contexte
 *                        depuis le CONTRAT D'ENTRÉE versionné, le valide
 *                        AVANT tout appel, puis l'ajoute une seule fois :
 *
 *                            <prompt maître, tel quel>
 *
 *                            EXECUTION_CONTEXT
 *                            {"task":"CLASSIFY_EVENT","event_catalog":[…],…}
 *
 * Le mode n'est JAMAIS déduit de la présence de `{{…}}` : il est porté par
 * la version du prompt maître (BO, colonnes 0290), par la déclaration du
 * fichier du dépôt (`defaults` du contrat), ou vaut LEGACY_TEMPLATE pour un
 * texte de version de configuration (historique D-03). Aucun repli
 * silencieux : en STRUCTURED_CONTEXT, un contexte impossible à construire
 * est un échec explicite, jamais une substitution d'emplacements.
 *
 * Seuls les prompts maîtres qui DÉCLARENT un contrat d'exécution
 * (`STRUCTURED_CONTEXT_SPECS`) connaissent ce mode — T4 au lot 34D. T1, T2,
 * T3, T5 et T6 restent LEGACY_TEMPLATE, sans aucun changement.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'crypto';
import type { ZodType } from 'zod';
import { T4_EXECUTION_SPEC } from '../agenda/master/t4-execution-contract';

export const MASTER_EXECUTION_MODES = ['LEGACY_TEMPLATE', 'STRUCTURED_CONTEXT'] as const;
export type MasterExecutionMode = (typeof MASTER_EXECUTION_MODES)[number];

/** Configuration d'exécution d'un prompt maître (version BO, fichier du dépôt). */
export interface MasterExecutionConfig {
  mode: MasterExecutionMode;
  /** `t4_input_v1` — `null` en LEGACY_TEMPLATE. */
  inputContractVersion: string | null;
  /** `t4_output_v1` — `null` en LEGACY_TEMPLATE. */
  outputContractVersion: string | null;
  /** TASK autorisées (hors du texte du prompt). `null` : toutes celles du registre. */
  allowedTasks: string[] | null;
}

export const LEGACY_EXECUTION: MasterExecutionConfig = Object.freeze({
  mode: 'LEGACY_TEMPLATE', inputContractVersion: null, outputContractVersion: null, allowedTasks: null,
}) as MasterExecutionConfig;

export interface InputFieldSpec {
  /** Variable historique (mode LEGACY_TEMPLATE) portant la même donnée. */
  legacyVariable: string;
  description: string;
  schema: ZodType;
}

export interface InputContract {
  version: string;
  fields: Readonly<Record<string, InputFieldSpec>>;
  /** Par TASK : champs requis, optionnels (absents ou nuls), et forme propre à la branche. */
  tasks: Readonly<Record<string, { required: readonly string[]; optional: readonly string[]; schemas?: Readonly<Record<string, ZodType>> }>>;
}

export interface OutputContractMap {
  version: string;
  /** Par TASK : contrat runtime de sortie (nom au registre, version). */
  byTask: Readonly<Record<string, { schemaName: string; contractVersion: number }>>;
}

export interface StructuredContextSpec {
  masterPromptCode: string;
  treatment: string;
  knownTasks: readonly string[];
  inputContracts: Readonly<Record<string, InputContract>>;
  outputContracts: Readonly<Record<string, OutputContractMap>>;
  defaults: MasterExecutionConfig;
  errorCodes: {
    missingField: string; invalidType: string; taskNotAllowed: string;
    outputMissing: string; versionNotFound: string; buildFailed: string;
  };
}

/** Contrats d'exécution déclarés (T4 seulement au lot 34D). */
export const STRUCTURED_CONTEXT_SPECS: Readonly<Record<string, StructuredContextSpec>> = {
  [T4_EXECUTION_SPEC.masterPromptCode]: T4_EXECUTION_SPEC,
};

export function structuredSpecFor(masterPromptCode: string | null | undefined): StructuredContextSpec | null {
  return masterPromptCode ? STRUCTURED_CONTEXT_SPECS[masterPromptCode] ?? null : null;
}

export function structuredSpecForTreatment(treatment: string): StructuredContextSpec | null {
  return Object.values(STRUCTURED_CONTEXT_SPECS).find((s) => s.treatment === treatment) ?? null;
}

/** Libellé du bloc injecté (stable : identifiable dans le prompt et les traces). */
export const EXECUTION_CONTEXT_LABEL = 'EXECUTION_CONTEXT';

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * Configuration d'exécution APPLIQUÉE, selon la source du texte :
 *   · `version` : version de prompt maître du BO — sa configuration stockée
 *     (absente : LEGACY_TEMPLATE, cas des versions antérieures à 0290) ;
 *   · `config`  : texte d'une version de configuration (D-03) — LEGACY ;
 *   · `file`    : fichier du dépôt — mode déclaré par le contrat.
 * Un master sans contrat d'exécution est toujours LEGACY_TEMPLATE.
 */
export function executionConfigFor(p: {
  masterPromptCode: string; source: 'version' | 'config' | 'file'; stored?: Partial<MasterExecutionConfig> | null;
}): MasterExecutionConfig {
  const spec = structuredSpecFor(p.masterPromptCode);
  if (!spec) return LEGACY_EXECUTION;
  if (p.source === 'file') return { ...spec.defaults, allowedTasks: spec.defaults.allowedTasks ? [...spec.defaults.allowedTasks] : null };
  if (p.source === 'config') return LEGACY_EXECUTION;
  return normalizeExecutionConfig(p.stored ?? null);
}

/** Configuration stockée → configuration complète (mode absent ou inconnu : LEGACY_TEMPLATE). */
export function normalizeExecutionConfig(stored: Partial<MasterExecutionConfig> | null): MasterExecutionConfig {
  if (!stored || stored.mode !== 'STRUCTURED_CONTEXT') return LEGACY_EXECUTION;
  return {
    mode: 'STRUCTURED_CONTEXT',
    inputContractVersion: stored.inputContractVersion ?? null,
    outputContractVersion: stored.outputContractVersion ?? null,
    allowedTasks: Array.isArray(stored.allowedTasks) ? [...stored.allowedTasks] : null,
  };
}

/** Configuration d'une NOUVELLE version : celle de la version de départ, sinon le défaut du contrat. */
export function draftExecutionConfig(masterPromptCode: string, base: MasterExecutionConfig | null): MasterExecutionConfig | null {
  const spec = structuredSpecFor(masterPromptCode);
  if (!spec) return null;
  return base ?? { ...spec.defaults, allowedTasks: spec.defaults.allowedTasks ? [...spec.defaults.allowedTasks] : null };
}

/** Signature courte de la configuration (clé d'idempotence, traces). */
export function executionSignature(c: MasterExecutionConfig): string {
  if (c.mode === 'LEGACY_TEMPLATE') return 'legacy';
  return `ctx:${c.inputContractVersion ?? '?'}/${c.outputContractVersion ?? '?'}/${(c.allowedTasks ?? ['*']).join('+')}`;
}

export interface ExecutionConfigIssue {
  code: string;
  message: string;
  field: 'mode' | 'inputContractVersion' | 'outputContractVersion' | 'allowedTasks';
}

/**
 * Contrôle TECHNIQUE d'une configuration structurée (validateur d'activation
 * et passerelle) : contrat d'entrée présent et valide, TASK configurées,
 * contrat de sortie présent, chaque TASK reliée à un contrat runtime connu.
 * `contractExists` : le registre des contrats runtime (injecté, pur).
 */
export function checkExecutionConfig(
  spec: StructuredContextSpec, c: MasterExecutionConfig,
  contractExists: (schemaName: string, version: number) => boolean,
): ExecutionConfigIssue[] {
  if (c.mode !== 'STRUCTURED_CONTEXT') return [];
  const out: ExecutionConfigIssue[] = [];
  const input = c.inputContractVersion ? spec.inputContracts[c.inputContractVersion] : undefined;
  if (!c.inputContractVersion) {
    out.push({ code: spec.errorCodes.versionNotFound, field: 'inputContractVersion', message: 'Aucun contrat d’entrée n’est configuré.' });
  } else if (!input) {
    out.push({ code: spec.errorCodes.versionNotFound, field: 'inputContractVersion', message: `Le contrat d’entrée « ${c.inputContractVersion} » n’existe pas.` });
  }
  const tasks = c.allowedTasks ?? [...spec.knownTasks];
  if (tasks.length === 0) {
    out.push({ code: spec.errorCodes.taskNotAllowed, field: 'allowedTasks', message: 'Aucune TASK n’est autorisée : aucun appel ne serait possible.' });
  }
  for (const t of tasks.filter((x) => !spec.knownTasks.includes(x))) {
    out.push({ code: spec.errorCodes.taskNotAllowed, field: 'allowedTasks', message: `La TASK « ${t} » est inconnue du code (connues : ${spec.knownTasks.join(', ')}).` });
  }
  if (input) {
    for (const t of tasks.filter((x) => spec.knownTasks.includes(x))) {
      const r = input.tasks[t];
      if (!r) { out.push({ code: spec.errorCodes.versionNotFound, field: 'inputContractVersion', message: `Le contrat d’entrée ${input.version} ne décrit pas la TASK ${t}.` }); continue; }
      for (const f of [...r.required, ...r.optional]) {
        if (!input.fields[f]) out.push({ code: spec.errorCodes.versionNotFound, field: 'inputContractVersion', message: `Contrat d’entrée ${input.version} invalide : champ « ${f} » non défini.` });
      }
    }
  }
  const output = c.outputContractVersion ? spec.outputContracts[c.outputContractVersion] : undefined;
  if (!c.outputContractVersion || !output) {
    out.push({
      code: c.outputContractVersion ? spec.errorCodes.versionNotFound : spec.errorCodes.outputMissing, field: 'outputContractVersion',
      message: c.outputContractVersion ? `Le contrat de sortie « ${c.outputContractVersion} » n’existe pas.` : 'Aucun contrat de sortie n’est configuré.',
    });
  } else {
    for (const t of tasks.filter((x) => spec.knownTasks.includes(x))) {
      const m = output.byTask[t];
      if (!m) out.push({ code: spec.errorCodes.outputMissing, field: 'outputContractVersion', message: `Le contrat de sortie ${output.version} ne couvre pas la TASK ${t}.` });
      else if (!contractExists(m.schemaName, m.contractVersion)) {
        out.push({ code: spec.errorCodes.outputMissing, field: 'outputContractVersion', message: `Contrat de sortie ${output.version} invalide : ${m.schemaName} v${m.contractVersion} introuvable.` });
      }
    }
  }
  return out;
}

// ── Construction du contexte ─────────────────────────────────────────────────

/** Étape où la construction a échoué (rapport : TASK, champ, contrat, étape). */
export type ContextStep = 'task' | 'input_contract' | 'output_contract' | 'required_fields' | 'types' | 'serialization';

export class StructuredContextError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: { task: string; field: string | null; contract: string | null; step: ContextStep },
  ) {
    super(message);
    this.name = 'StructuredContextError';
  }
}

export interface BuiltExecutionContext {
  task: string;
  /** Contexte construit (clés : champs du contrat applicables à la TASK). */
  context: Record<string, unknown>;
  /** Sérialisation DÉTERMINISTE (clés triées). */
  json: string;
  /** Empreinte (12) du contexte. */
  hash: string;
  inputContractVersion: string;
  outputContractVersion: string;
  /** Contrat runtime de sortie de la TASK. */
  output: { schemaName: string; contractVersion: number };
  /** Champs injectés, dans l'ordre. */
  fields: string[];
}

/** JSON à clés triées (même entrée ⇒ même texte, quel que soit l'ordre de construction). */
export function stableStringify(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

function issueText(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues.slice(0, 3).map((i) => `${i.path.map(String).join('.') || '(racine)'} : ${i.message}`).join(' | ');
}

/**
 * Construit et VALIDE le contexte d'une TASK. Pur. Ordre des contrôles :
 * TASK autorisée → contrat d'entrée → contrat de sortie → champs requis →
 * types → sérialisation. Lève `StructuredContextError` (code du contrat :
 * `T4_TASK_NOT_ALLOWED`, `T4_INPUT_CONTRACT_MISSING_FIELD`…).
 *
 * `variables` : données fournies par l'appelant sous leurs noms historiques
 * (`EVIDENCE`, `AGENDA_ITEM`…) — les appelants T4 ne changent pas. Une
 * variable qui ne correspond à aucun champ du contrat est refusée (jamais de
 * donnée cachée hors contrat).
 */
export function buildExecutionContext(
  spec: StructuredContextSpec, c: MasterExecutionConfig, task: string, variables: Record<string, unknown>,
): BuiltExecutionContext {
  const err = (code: string, step: ContextStep, message: string, field: string | null = null, contract: string | null = null) =>
    new StructuredContextError(code, message, { task, field, contract, step });

  const allowed = c.allowedTasks ?? [...spec.knownTasks];
  if (!spec.knownTasks.includes(task) || !allowed.includes(task)) {
    throw err(spec.errorCodes.taskNotAllowed, 'task', `TASK « ${task} » non autorisée (autorisées : ${allowed.join(', ') || 'aucune'}).`);
  }
  const input = c.inputContractVersion ? spec.inputContracts[c.inputContractVersion] : undefined;
  if (!input) {
    throw err(spec.errorCodes.versionNotFound, 'input_contract', `Contrat d’entrée « ${c.inputContractVersion ?? '(aucun)'} » introuvable.`, null, c.inputContractVersion);
  }
  const regles = input.tasks[task];
  if (!regles) throw err(spec.errorCodes.versionNotFound, 'input_contract', `Le contrat d’entrée ${input.version} ne décrit pas la TASK ${task}.`, null, input.version);
  if (!c.outputContractVersion) throw err(spec.errorCodes.outputMissing, 'output_contract', 'Aucun contrat de sortie configuré.', null, null);
  const output = spec.outputContracts[c.outputContractVersion];
  if (!output) throw err(spec.errorCodes.versionNotFound, 'output_contract', `Contrat de sortie « ${c.outputContractVersion} » introuvable.`, null, c.outputContractVersion);
  const sortie = output.byTask[task];
  if (!sortie) throw err(spec.errorCodes.outputMissing, 'output_contract', `Le contrat de sortie ${output.version} ne couvre pas la TASK ${task}.`, null, output.version);

  // Variables hors contrat : refusées (aucune donnée transmise hors contrat).
  const parVariable = new Map(Object.entries(input.fields).map(([name, f]) => [f.legacyVariable, name]));
  for (const k of Object.keys(variables)) {
    if (variables[k] !== undefined && !parVariable.has(k)) {
      throw err(spec.errorCodes.buildFailed, 'input_contract', `Donnée « ${k} » sans champ dans le contrat d’entrée ${input.version}.`, k, input.version);
    }
  }

  const context: Record<string, unknown> = { task };
  const fields: string[] = [];
  const applicable = [...regles.required, ...regles.optional];
  for (const name of applicable) {
    const f = input.fields[name];
    if (!f) throw err(spec.errorCodes.buildFailed, 'input_contract', `Contrat d’entrée ${input.version} invalide : champ « ${name} » non défini.`, name, input.version);
    const value = variables[f.legacyVariable];
    const requis = regles.required.includes(name);
    if (value === undefined || value === null) {
      if (requis) {
        throw err(spec.errorCodes.missingField, 'required_fields',
          `Champ obligatoire « ${name} » absent pour TASK=${task} (contrat ${input.version}).`, name, input.version);
      }
      continue;
    }
    const schema = regles.schemas?.[name] ?? f.schema;
    const r = schema.safeParse(value);
    if (!r.success) {
      throw err(spec.errorCodes.invalidType, 'types',
        `Champ « ${name} » non conforme au contrat ${input.version} (TASK=${task}) : ${issueText(r.error.issues)}.`, name, input.version);
    }
    context[name] = value;
    fields.push(name);
  }

  let json: string;
  try {
    json = stableStringify(context);
  } catch (e) {
    throw err(spec.errorCodes.buildFailed, 'serialization', `Contexte non sérialisable : ${(e as Error).message}.`, null, input.version);
  }
  return {
    task, context, json, hash: createHash('sha256').update(json).digest('hex').slice(0, 12),
    inputContractVersion: input.version, outputContractVersion: output.version, output: sortie, fields,
  };
}

/** Prompt envoyé : texte maître INCHANGÉ + bloc de contexte (une seule fois). */
export function renderStructuredPrompt(masterText: string, ctx: Pick<BuiltExecutionContext, 'json'>): string {
  return `${masterText.replace(/\s+$/, '')}\n\n${EXECUTION_CONTEXT_LABEL}\n${ctx.json}\n`;
}

/** Empreinte (12) d'un texte de prompt (traces). */
export function promptHash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex').slice(0, 12);
}

/** Liste INFORMATIVE du contexte disponible (éditeur BO). */
export function availableContextOf(spec: StructuredContextSpec, inputVersion: string | null): Array<{
  field: string; description: string; tasks: Array<{ task: string; requirement: 'requis' | 'optionnel' }>;
}> {
  const input = inputVersion ? spec.inputContracts[inputVersion] : undefined;
  if (!input) return [];
  return [
    { field: 'task', description: 'Branche demandée par le serveur.', tasks: spec.knownTasks.map((t) => ({ task: t, requirement: 'requis' as const })) },
    ...Object.entries(input.fields).map(([field, f]) => ({
      field, description: f.description,
      tasks: Object.entries(input.tasks).flatMap(([t, r]): Array<{ task: string; requirement: 'requis' | 'optionnel' }> => (r.required.includes(field)
        ? [{ task: t, requirement: 'requis' }]
        : r.optional.includes(field) ? [{ task: t, requirement: 'optionnel' }] : [])),
    })),
  ];
}
