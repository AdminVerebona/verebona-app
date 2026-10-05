/**
 * Résolution des prompts techniques — CDC §4.5, §6.1 ; CDC BO IA GEN-015,
 * E-05, WF-41.
 *
 * Les prompts techniques sont les fichiers du dépôt, versionnés avec le code
 * et relus en revue : ils portent le contrat de sortie que le serveur valide.
 * Le texte administrable depuis le BO est le PRÉAMBULE de chaque traitement,
 * porté par la version de configuration (config-resolver) — c'est là, et
 * seulement là, que se font activation et retour arrière.
 *
 * Historique : les prompts ont été des données versionnées en base
 * (`ai_prompt_versions`, routes `prompt-changes`). Cette gouvernance
 * parallèle est retirée (lot IA 2) : voir `loadActiveVersion`.
 */
import { readFile, readdir } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import type { AiUseCaseCode } from '../registry/use-cases';
import { listMasterTasks } from '../registry/operations';

interface ResolvedPrompt {
  text: string;
  version: string;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: ResolvedPrompt; expiresAt: number }>();

export async function resolvePrompt(
  promptCode: string | undefined,
  variables: Record<string, unknown>,
  useCaseCode?: AiUseCaseCode,
): Promise<ResolvedPrompt> {
  if (!promptCode) return { text: '', version: 'none' };

  const base = await loadActiveVersion(promptCode, useCaseCode);
  return { text: substitute(base.text, variables), version: base.version };
}

/**
 * Prompt technique d'une opération : TOUJOURS le fichier du dépôt.
 *
 * CDC BO IA GEN-015, E-05, WF-41 (lot IA 2) — fin de la gouvernance
 * parallèle. `ai_prompt_versions` (routes `prompt-changes`, retirées) primait
 * sur le fichier : une version ancienne restée ACTIVE en base a déjà fait
 * échouer T5 (format « verdict » refusé) et obligé à renommer
 * `extract_source_v5` pour contourner une v4 active en base. Le partage est
 * désormais celui du CDC : le prompt TECHNIQUE (contrat de sortie) vient du
 * dépôt, versionné avec le code ; le PRÉAMBULE administrable vient de la
 * version de configuration du BO (config-resolver), modifiable par T5.
 * La table est conservée (historique), elle n'est plus lue.
 */
async function loadActiveVersion(
  promptCode: string,
  useCaseCode?: AiUseCaseCode,
): Promise<ResolvedPrompt> {
  const key = `${promptsRoot()}::${promptCode}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const resolved = await loadFromFile(promptCode, useCaseCode);
  cache.set(key, { value: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
  return resolved;
}

/**
 * Répertoire de prompts par usage.
 *
 * ⚠️ CORRECTION D'UN DÉFAUT SÉRIEUX. La première version dérivait le
 * répertoire du préfixe du code (`classify_document_v2` → `classify/`), qui ne
 * correspond à AUCUN répertoire réel. Le repli fichier ne fonctionnait donc
 * jamais : tant que la table `ai_prompt_versions` n'est pas amorcée — soit au
 * premier démarrage, avant le seed du lot 6 — tous les appels modèles auraient
 * échoué avec « prompt introuvable ». Le défaut ne se voyait pas en test tant
 * que la gateway n'était pas exercée de bout en bout.
 */
const USE_CASE_DIRECTORY: Record<AiUseCaseCode, string> = {
  SOURCE_ANALYSIS: 'source-analysis',
  DATA_RECONCILIATION: 'reconciliation',
  INTELLIGENT_ASSISTANT: 'assistant',
  AGENDA_INTELLIGENCE: 'agenda',
  AI_GOVERNANCE: 'governance',
  HOME_MASCOT: 'mascot',
};

const PROMPTS_ROOT = 'src/services/ai/prompts';

/** Racine des prompts ; remplaçable par les tests (répertoire de fixtures). */
let rootOverride: string | null = null;
function promptsRoot(): string {
  return rootOverride ?? join(process.cwd(), PROMPTS_ROOT);
}

/** Réservé aux tests : lit les prompts dans `root` (`null` : dépôt). Vide le cache. */
export function __setPromptsRootForTests(root: string | null): void {
  rootOverride = root;
  cache.clear();
}

/** Chemins candidats d'un prompt, du plus probable au moins probable. */
export function promptFileCandidates(promptCode: string, useCaseCode?: AiUseCaseCode, root = promptsRoot()): string[] {
  const candidates: string[] = [];
  if (useCaseCode) candidates.push(join(root, USE_CASE_DIRECTORY[useCaseCode], `${promptCode}.txt`));
  candidates.push(join(root, `${promptCode}.txt`));
  for (const dir of Object.values(USE_CASE_DIRECTORY)) {
    const c = join(root, dir, `${promptCode}.txt`);
    if (!candidates.includes(c)) candidates.push(c);
  }
  return candidates;
}

async function loadFromFile(
  promptCode: string,
  useCaseCode?: AiUseCaseCode,
): Promise<ResolvedPrompt> {
  // 1. Répertoire de l'usage, lorsqu'il est connu — le cas nominal ;
  // 2. racine des prompts ; 3. tous les répertoires d'usage, au cas où un
  // prompt aurait été déplacé.
  const candidates = promptFileCandidates(promptCode, useCaseCode);

  for (const path of candidates) {
    try {
      return { text: await readFile(path, 'utf8'), version: `${promptCode}@file` };
    } catch { /* essai suivant */ }
  }

  // Message actionnable : indiquer où le fichier était attendu.
  const searched = useCaseCode
    ? `${PROMPTS_ROOT}/${USE_CASE_DIRECTORY[useCaseCode]}/${promptCode}.txt`
    : `${PROMPTS_ROOT}/**/${promptCode}.txt`;
  throw new Error(
    `[prompt-loader] Prompt « ${promptCode} » introuvable sur disque (${searched}).`,
  );
}

/** Répertoires de prompts existants — utilisé par le seed du lot 6. */
export async function listPromptFiles(): Promise<Array<{ promptCode: string; path: string }>> {
  const root = promptsRoot();
  const found: Array<{ promptCode: string; path: string }> = [];
  for (const dir of Object.values(USE_CASE_DIRECTORY)) {
    try {
      for (const file of await readdir(join(root, dir))) {
        if (file.endsWith('.txt')) {
          found.push({ promptCode: file.replace(/\.txt$/, ''), path: join(root, dir, file) });
        }
      }
    } catch { /* répertoire absent */ }
  }
  return found;
}

/** Substitution `{{VARIABLE}}`, sans évaluation ni interpolation dynamique. */
function substitute(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) => {
    const v = variables[key];
    if (v === undefined || v === null) return match;
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/** Entrées du cache des prompts de cette instance (état des caches, lot 23). */
export function promptCacheSize(): number {
  return cache.size;
}

/** Invalide le cache après activation d'une nouvelle version (lot 6). */
export function invalidatePromptCache(promptCode?: string): void {
  if (!promptCode) { cache.clear(); return; }
  for (const key of cache.keys()) if (key.endsWith(`::${promptCode}`)) cache.delete(key);
}


// ══════════════════════════════════════════════════════════════════════════
// PROMPTS MAÎTRES — CDC 15 §22, §22.2, §22.3, §29.1 ; D-03 ; ARCH-03, DP-05
//
// Un traitement = UN prompt maître ; chaque appel choisit une branche TASK
// imposée par le serveur. Le texte vient :
//   1. de la version de configuration IA quand elle en porte un (D-03 : « la
//      version de configuration porte le master complet par traitement ») ;
//   2. sinon du fichier `tN_master_vK.txt` du dépôt, sa valeur initiale.
// Rien d'autre n'y est ajouté : ni préambule, ni consigne composée par le
// code (§22.3, « interdire la concaténation de règles naturelles cachées »).
// Le code ne fournit que `{{TASK}}` et des données structurées, et seulement
// dans les emplacements `{{X}}` que le master déclare lui-même.
// ══════════════════════════════════════════════════════════════════════════

/** Emplacement réservé à la branche, fixé par le serveur. */
export const MASTER_TASK_PLACEHOLDER = 'TASK';
/**
 * Mot-clé de branche d'un master : `TASK` (T1, T3, T4) ou `MODE` (T2, §24 :
 * « MODE = {{MODE}} », « BRANCHE MODE = ANSWER »). Un master n'en porte qu'un ;
 * c'est lui que le serveur fixe.
 */
export const MASTER_DISCRIMINANTS = ['TASK', 'MODE'] as const;
export type MasterDiscriminant = (typeof MASTER_DISCRIMINANTS)[number];

/** Marqueur de section d'une branche dans un master (`BRANCHE TASK = X`). */
export function masterBranchMarker(task: string, discriminant: MasterDiscriminant = 'TASK'): string {
  return `BRANCHE ${discriminant} = ${task}`;
}

const PLACEHOLDER_RE = /\{\{([A-Z0-9_]+)\}\}/g;
const BRANCH_RE = /BRANCHE\s+(?:TASK|MODE)\s*=\s*([A-Z0-9_]+)/g;

export type MasterPromptErrorCode =
  | 'MASTER_NOT_FOUND'
  | 'TASK_NOT_ALLOWED'
  | 'TASK_PLACEHOLDER_MISSING'
  | 'TASK_BRANCH_MISSING'
  | 'RESERVED_VARIABLE'
  | 'UNDECLARED_VARIABLE'
  | 'UNRESOLVED_PLACEHOLDER';

/** Refus explicite : aucun texte partiel ou non substitué n'est envoyé au modèle. */
export class MasterPromptError extends Error {
  constructor(
    readonly code: MasterPromptErrorCode,
    readonly masterPromptCode: string,
    message: string,
  ) {
    super(`[prompt-loader] ${masterPromptCode} : ${message}`);
    this.name = 'MasterPromptError';
  }
}

/** Anatomie d'un master : emplacements `{{X}}` et branches déclarées. */
export interface MasterTemplateInfo {
  placeholders: string[];
  branches: string[];
  hasTaskPlaceholder: boolean;
  /** Emplacement de branche du master (`TASK` ou `MODE`), ou null. */
  discriminant: MasterDiscriminant | null;
}

/**
 * Branches déclarées sans section dédiée (T5, §27) : la ligne
 * « Valeurs autorisées : ANALYZE | MODIFY » qui suit `MODE = {{MODE}}`. Les
 * règles de chaque mode sont alors dans le corps commun (R3/R4) — le texte
 * du CDC est transcrit tel quel, sans section « BRANCHE » ajoutée.
 */
const DECLARED_VALUES_RE = /(?:TASK|MODE)\s*=\s*\{\{(?:TASK|MODE)\}\}\s*\n+\s*Valeurs autorisées\s*:\s*([A-Z0-9_]+(?:\s*\|\s*[A-Z0-9_]+)*)/;

export function inspectMasterTemplate(text: string): MasterTemplateInfo {
  const placeholders = [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))];
  let branches = [...new Set([...text.matchAll(BRANCH_RE)].map((m) => m[1]))];
  if (branches.length === 0) {
    const declared = DECLARED_VALUES_RE.exec(text);
    if (declared) branches = declared[1].split('|').map((b) => b.trim()).filter(Boolean);
  }
  const discriminant = MASTER_DISCRIMINANTS.find((d) => placeholders.includes(d)) ?? null;
  return { placeholders, branches, hasTaskPlaceholder: discriminant !== null, discriminant };
}

/**
 * Contrôle de structure d'un master pour un jeu de branches (chargement,
 * promotion d'une version, `prompts:check`). Renvoie les anomalies, vide si
 * conforme.
 */
export function checkMasterTemplate(text: string, tasks: readonly string[]): string[] {
  const info = inspectMasterTemplate(text);
  const out: string[] = [];
  if (!info.hasTaskPlaceholder) out.push('emplacement {{TASK}} absent');
  for (const t of tasks) {
    if (!info.branches.includes(t)) out.push(`section « ${masterBranchMarker(t, info.discriminant ?? 'TASK')} » absente`);
  }
  return out;
}

/**
 * Variables OPTIONNELLES d'un master : ajoutées après coup au contrat d'un
 * prompt maître, elles peuvent manquer dans le texte d'une version de
 * configuration antérieure (D-03 : master porté par la version BO). Sans leur
 * emplacement, elles sont IGNORÉES au rendu (jamais concaténées, §22.3) au
 * lieu de faire échouer chaque appel ; le contrôle BO le signale sans bloquer
 * (`masterConfigIssues`). La règle métier correspondante reste appliquée par
 * le serveur (T1 : garde-fou de sortie `enforceT1Capabilities`, gardes T3/T4).
 * Toute autre variable sans emplacement reste refusée.
 */
export const OPTIONAL_MASTER_VARIABLES: Readonly<Record<string, readonly string[]>> = {
  // T1 : capacités du compte (pièces, équipements), lot 24.
  t1_master_v1: ['ACCOUNT_CAPABILITIES'],
};

/** Variable optionnelle pour ce master (`OPTIONAL_MASTER_VARIABLES`). */
export function isOptionalMasterVariable(masterPromptCode: string, name: string): boolean {
  return (OPTIONAL_MASTER_VARIABLES[masterPromptCode] ?? []).includes(name);
}

/**
 * Rendu PUR d'un master : injecte `{{TASK}}` et les variables structurées.
 *
 * Refuse :
 *   · une TASK hors des branches autorisées ou sans section dans le texte ;
 *   · une variable `TASK` fournie par l'appelant (elle est fixée ici) ;
 *   · une variable qui ne correspond à aucun emplacement du master — seul
 *     moyen de glisser des consignes hors du texte administré (§22.3) —
 *     sauf variable optionnelle (`OPTIONAL_MASTER_VARIABLES`), ignorée ;
 *   · un emplacement sans valeur (`undefined`) — jamais de `{{X}}` au modèle.
 * `null` est une valeur (JSON `null`) ; une chaîne est insérée telle quelle,
 * tout autre valeur sérialisée en JSON. Substitution en une passe : une
 * valeur contenant `{{Y}}` n'est jamais réinterprétée.
 */
export function renderMasterPrompt(
  template: string,
  opts: { masterPromptCode: string; task: string; variables: Record<string, unknown>; allowedTasks: readonly string[] },
): string {
  const { masterPromptCode: code, task, variables, allowedTasks } = opts;
  if (!allowedTasks.includes(task)) {
    throw new MasterPromptError('TASK_NOT_ALLOWED', code,
      `TASK « ${task} » non autorisée (branches déclarées : ${allowedTasks.join(', ') || 'aucune'}).`);
  }
  const info = inspectMasterTemplate(template);
  const cle = info.discriminant ?? MASTER_TASK_PLACEHOLDER;
  if (Object.prototype.hasOwnProperty.call(variables, cle) || Object.prototype.hasOwnProperty.call(variables, MASTER_TASK_PLACEHOLDER)) {
    throw new MasterPromptError('RESERVED_VARIABLE', code,
      `la variable ${cle} est fixée par le serveur, jamais par l’appelant (CDC 15 §22.2).`);
  }
  if (!info.hasTaskPlaceholder) {
    throw new MasterPromptError('TASK_PLACEHOLDER_MISSING', code, 'le master ne contient pas {{TASK}}.');
  }
  if (!info.branches.includes(task)) {
    throw new MasterPromptError('TASK_BRANCH_MISSING', code,
      `section « ${masterBranchMarker(task, cle)} » absente du master.`);
  }
  // Variable optionnelle sans emplacement (texte de version antérieur) :
  // ignorée — ni refusée, ni concaténée.
  const undeclared = Object.keys(variables).filter((k) => variables[k] !== undefined && !info.placeholders.includes(k)
    && !isOptionalMasterVariable(code, k));
  if (undeclared.length > 0) {
    throw new MasterPromptError('UNDECLARED_VARIABLE', code,
      `variable(s) sans emplacement dans le master : ${undeclared.join(', ')} — concaténation de consignes interdite (CDC 15 §22.3).`);
  }
  const missing = info.placeholders.filter((p) => p !== cle && variables[p] === undefined);
  if (missing.length > 0) {
    throw new MasterPromptError('UNRESOLVED_PLACEHOLDER', code,
      `emplacement(s) sans valeur : ${missing.map((m) => `{{${m}}}`).join(', ')}.`);
  }
  const values: Record<string, unknown> = { ...variables, [cle]: task };
  return template.replace(PLACEHOLDER_RE, (_m, key: string) => {
    const v = values[key];
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

export interface ResolveMasterPromptInput {
  masterPromptCode: string;
  /** Branche imposée par le serveur. */
  task: string;
  /** Données structurées, une par emplacement `{{X}}` du master (hors TASK). */
  variables: Record<string, unknown>;
  useCaseCode?: AiUseCaseCode;
  /**
   * D-03 : master complet porté par la version de configuration. Vide ou
   * absent : fichier du dépôt.
   */
  configuredText?: string | null;
  /** Version de configuration d'où vient `configuredText` (trace). */
  configVersionId?: number | null;
  /** Branches autorisées ; défaut : celles déclarées au registre pour ce master. */
  allowedTasks?: readonly string[];
}

export interface ResolvedMasterPrompt {
  text: string;
  /** `t1_master_v1@file`, ou `t1_master_v1@cfg<id>:<empreinte>` (texte de la version). */
  version: string;
  masterPromptCode: string;
  task: string;
  source: 'file' | 'config';
}

/**
 * Version d'un master, SANS le charger : `code@file`, ou
 * `code@cfg<id>:<empreinte>` pour le texte d'une version de configuration.
 * Sert aussi à la clé d'idempotence (un nouveau master ne doit jamais servir
 * une sortie mise en cache sous l'ancien).
 */
export function masterPromptVersionOf(input: {
  masterPromptCode: string; configuredText?: string | null; configVersionId?: number | null;
}): string {
  const configured = input.configuredText?.trim() ? input.configuredText : null;
  if (!configured) return `${input.masterPromptCode}@file`;
  const digest = createHash('sha256').update(configured).digest('hex').slice(0, 12);
  return `${input.masterPromptCode}@cfg${input.configVersionId ?? ''}:${digest}`;
}

/**
 * Texte BRUT d'un master (fichier du dépôt, sa valeur initiale D-03) — sans
 * rendu. Sert à T5 (lecture et diff d'un master complet, §29.1), au corpus
 * (empreinte, §30) et au contrôle de retrait. Lève `MasterPromptError`.
 */
export async function loadMasterTemplate(masterPromptCode: string, useCaseCode?: AiUseCaseCode): Promise<string> {
  try {
    return (await loadActiveVersion(masterPromptCode, useCaseCode)).text;
  } catch (e) {
    throw new MasterPromptError('MASTER_NOT_FOUND', masterPromptCode, (e as Error).message);
  }
}

/** Empreinte SHA-256 d'un texte master (garde d'activation §30). */
export function masterTextFingerprint(text: string): string {
  // Fins de ligne normalisées : un dépôt extrait sous Windows (CRLF) doit
  // produire la même empreinte que la CI et la production (LF).
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex');
}

/** Charge, contrôle et rend le prompt maître d'une branche. Lève `MasterPromptError`. */
export async function resolveMasterPrompt(input: ResolveMasterPromptInput): Promise<ResolvedMasterPrompt> {
  const { masterPromptCode, task } = input;
  const allowedTasks = input.allowedTasks ?? listMasterTasks(masterPromptCode);
  const configured = input.configuredText?.trim() ? input.configuredText : null;

  let base: { text: string; version: string; source: 'file' | 'config' };
  if (configured) {
    base = {
      text: configured,
      version: masterPromptVersionOf({ masterPromptCode, configuredText: configured, configVersionId: input.configVersionId }),
      source: 'config',
    };
  } else {
    try {
      const f = await loadActiveVersion(masterPromptCode, input.useCaseCode);
      base = { ...f, source: 'file' };
    } catch (e) {
      throw new MasterPromptError('MASTER_NOT_FOUND', masterPromptCode, (e as Error).message);
    }
  }

  const text = renderMasterPrompt(base.text, { masterPromptCode, task, variables: input.variables, allowedTasks });
  return { text, version: base.version, masterPromptCode, task, source: base.source };
}
