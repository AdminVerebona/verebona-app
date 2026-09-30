/**
 * Corpus rejoué des prompts maîtres — CDC 15 §30, décisions D-08 (fixtures
 * SYNTHÉTIQUES seulement) et D-17 (100 % en CI sur sorties enregistrées).
 *
 * Un cas = un fichier JSON au format commun des fixtures P-T* :
 *   { case, description, context, recording: { operationCode, task, output }, expected? }
 * `recording.operationCode` désigne une opération MASTER active : c'est elle
 * qui fixe le master, la branche (TASK/MODE) et le schéma de sortie.
 *
 * Répertoires lus (ajouter ici tout nouveau répertoire de fixtures master ;
 * T6 : `home/mascot/__fixtures__`, s'il existe) :
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AI_OPERATIONS, isMasterOperation } from '../../registry/operations';
import { promptFileCandidates } from '../../prompts/prompt-loader';

const AI_ROOT = join(__dirname, '..', '..');

export const MASTER_CORPUS_DIRS: readonly string[] = [
  join(AI_ROOT, 'source-analysis', '__fixtures__', 't1'),
  join(AI_ROOT, 'reconciliation', 'master', '__fixtures__'),
  join(AI_ROOT, 'agenda', 'master', '__fixtures__'),
  join(__dirname, 'fixtures'),
  join(AI_ROOT, '..', 'home', 'mascot', '__fixtures__'),
];

export interface MasterCorpusCase {
  id: string;
  description: string;
  file: string;
  operationCode: string;
  masterPromptCode: string;
  task: string;
  taskField: 'task' | 'mode' | 'none';
  outputSchema: string;
  context: Record<string, unknown>;
  /** Sortie modèle enregistrée (synthétique, D-08). */
  output: unknown;
  expected: Record<string, unknown> | null;
}

/**
 * `@@MASTER_FILE:<code>@@` dans une chaîne de la sortie enregistrée : texte du
 * master du dépôt (un `proposedContent` T5 MODIFY doit être un master
 * COMPLET — le recopier dans la fixture la rendrait obsolète à la moindre
 * évolution du master).
 */
export type MasterFileReader = (masterPromptCode: string) => string;

function expand(v: unknown, read: MasterFileReader): unknown {
  if (typeof v === 'string') return v.replace(/@@MASTER_FILE:([a-z0-9_]+)@@/g, (_m, code: string) => read(code));
  if (Array.isArray(v)) return v.map((x) => expand(x, read));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x, read)]));
  return v;
}

/** Cas du corpus master, tous répertoires confondus (ordre stable). */
export function loadMasterCorpusCases(read: MasterFileReader, dirs: readonly string[] = MASTER_CORPUS_DIRS): MasterCorpusCase[] {
  const out: MasterCorpusCase[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const path = join(dir, f);
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        case?: string; description?: string; context?: Record<string, unknown>;
        recording?: { operationCode?: string; task?: string; output?: unknown }; expected?: Record<string, unknown>;
      };
      const op = raw.recording?.operationCode ? AI_OPERATIONS[raw.recording.operationCode] : undefined;
      if (!op || !op.active || !isMasterOperation(op)) continue;
      out.push({
        id: raw.case ?? f,
        description: raw.description ?? '',
        file: relative(join(AI_ROOT, '..', '..', '..'), path),
        operationCode: op.operationCode,
        masterPromptCode: op.masterPromptCode,
        task: op.task,
        taskField: op.taskField ?? 'task',
        outputSchema: op.outputSchema,
        context: raw.context ?? {},
        output: expand(raw.recording?.output, read),
        expected: raw.expected ?? null,
      });
    }
  }
  return out;
}

/** Lecture synchrone du fichier master du dépôt (valeur initiale D-03). */
export function readMasterFileFromRepo(masterPromptCode: string): string {
  const op = Object.values(AI_OPERATIONS).find((o) => o.masterPromptCode === masterPromptCode);
  for (const p of promptFileCandidates(masterPromptCode, op?.useCaseCode)) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  throw new Error(`[master-corpus] master « ${masterPromptCode} » introuvable dans le dépôt.`);
}
