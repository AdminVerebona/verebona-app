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
import { join } from 'path';
import type { AiUseCaseCode } from '../registry/use-cases';

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
  const hit = cache.get(promptCode);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const resolved = await loadFromFile(promptCode, useCaseCode);
  cache.set(promptCode, { value: resolved, expiresAt: Date.now() + CACHE_TTL_MS });
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

async function loadFromFile(
  promptCode: string,
  useCaseCode?: AiUseCaseCode,
): Promise<ResolvedPrompt> {
  const root = join(process.cwd(), PROMPTS_ROOT);
  const candidates: string[] = [];

  // 1. Répertoire de l'usage, lorsqu'il est connu — le cas nominal.
  if (useCaseCode) candidates.push(join(root, USE_CASE_DIRECTORY[useCaseCode], `${promptCode}.txt`));
  // 2. Racine des prompts.
  candidates.push(join(root, `${promptCode}.txt`));
  // 3. Tous les répertoires d'usage, au cas où un prompt aurait été déplacé.
  for (const dir of Object.values(USE_CASE_DIRECTORY)) {
    candidates.push(join(root, dir, `${promptCode}.txt`));
  }

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
  const root = join(process.cwd(), PROMPTS_ROOT);
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

/** Invalide le cache après activation d'une nouvelle version (lot 6). */
export function invalidatePromptCache(promptCode?: string): void {
  if (promptCode) cache.delete(promptCode);
  else cache.clear();
}
