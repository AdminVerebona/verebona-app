/**
 * Résolution des prompts — CDC §4.5 et §6.1.
 *
 * Les prompts sont des DONNÉES VERSIONNÉES en base (`ai_prompt_versions`), et
 * non plus des fichiers lus au moment de l'appel. C'est la seule façon d'obtenir
 * activation, retour arrière et coexistence de versions sur un hébergement au
 * système de fichiers immuable — l'ancienne route d'administration écrivait
 * directement dans les `.txt`, ce qui est à la fois interdit par le CDC §4.5.3
 * et non fiable en production.
 *
 * Les fichiers du dépôt restent la source d'amorçage (seed) et la trace en
 * revue de code ; ils servent aussi de repli si la table n'est pas encore seedée.
 */
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { pgClient } from '@/db';
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

async function loadActiveVersion(
  promptCode: string,
  useCaseCode?: AiUseCaseCode,
): Promise<ResolvedPrompt> {
  const hit = cache.get(promptCode);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let resolved: ResolvedPrompt | null = null;

  try {
    const rows = await pgClient.unsafe(
      `SELECT content, version FROM ai_prompt_versions
        WHERE prompt_code = $1 AND status = 'ACTIVE'
        ORDER BY created_at DESC LIMIT 1`,
      [promptCode] as never[],
    );
    const row = (rows as unknown as Array<{ content: string; version: string }>)[0];
    if (row) resolved = { text: row.content, version: row.version };
  } catch {
    // Table absente avant le lot 6 : on tombe sur le fichier.
  }

  if (!resolved) resolved = await loadFromFile(promptCode, useCaseCode);

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
    `[prompt-loader] Prompt « ${promptCode} » introuvable, ni en base ` +
    `(ai_prompt_versions, statut ACTIVE) ni sur disque (${searched}).`,
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
