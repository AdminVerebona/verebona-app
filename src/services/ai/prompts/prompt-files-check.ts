/**
 * Contrôle des fichiers de prompts du référentiel — CDC 15 §22.3, §29,
 * ARCH-02, ARCH-03 (script `prompts:check`, inclus dans `ai:verify`).
 *
 * Pour chaque opération déclarant un `promptCode` ou un `masterPromptCode` :
 *   · le fichier existe (opération active : erreur ; inactive : avertissement
 *     — ARCH-02, fichiers absents d'opérations désactivées) ;
 *   · un master contient `{{TASK}}` et une section `BRANCHE TASK = X` pour
 *     chaque TASK déclarée au registre ;
 *   · si l'opération déclare `promptVariables`, les emplacements `{{X}}` du
 *     fichier correspondent exactement (hors TASK) — sinon, non vérifiable,
 *     signalé en information.
 *
 * Lot 34D — master dont le FICHIER du dépôt est en contexte structuré (T4) :
 * ni `{{TASK}}`, ni section de branche, ni emplacement n'est exigé ; le
 * contrôle porte sur le contrat d'exécution (contrat d'entrée, TASK,
 * contrat de sortie reliés au registre des contrats runtime) et sur la
 * correspondance des variables des opérations avec les champs du contrat.
 *
 * Fonction pure sur un lecteur injecté : testable sur un répertoire de
 * fixtures, sans dépendre du master écrit en parallèle.
 */
import { existsSync, readFileSync } from 'fs';
import { sep } from 'path';
import type { AiOperationDefinition } from '../registry/operations';
import {
  promptFileCandidates, inspectMasterTemplate, checkMasterTemplate, MASTER_TASK_PLACEHOLDER,
} from './prompt-loader';
import { structuredSpecFor, checkExecutionConfig, type StructuredContextSpec } from '../master-prompts/structured-context';
import { contractVersionsOf } from '../gateway/output-resolution/runtime-contract';

/** Contrat d'exécution du fichier du dépôt, s'il est en contexte structuré. */
function structuredFileSpec(code: string): StructuredContextSpec | null {
  const spec = structuredSpecFor(code);
  return spec && spec.defaults.mode === 'STRUCTURED_CONTEXT' ? spec : null;
}

export interface PromptFilesReport {
  errors: string[];
  warnings: string[];
  infos: string[];
  checkedFiles: number;
}

export interface PromptFilesCheckInput {
  operations: readonly AiOperationDefinition[];
  /** Racine des prompts (`src/services/ai/prompts`). */
  root: string;
  /** Lecture d'un fichier ; `null` s'il est absent. */
  read?: (path: string) => string | null;
}

const defaultRead = (path: string): string | null => (existsSync(path) ? readFileSync(path, 'utf8') : null);

export function checkPromptFiles(input: PromptFilesCheckInput): PromptFilesReport {
  const read = input.read ?? defaultRead;
  const report: PromptFilesReport = { errors: [], warnings: [], infos: [], checkedFiles: 0 };
  const lus = new Map<string, { text: string | null; path: string | null }>();

  const lire = (code: string, op: AiOperationDefinition) => {
    const cle = `${op.useCaseCode}:${code}`;
    const deja = lus.get(cle);
    if (deja) return deja;
    let found: { text: string | null; path: string | null } = { text: null, path: null };
    for (const path of promptFileCandidates(code, op.useCaseCode, input.root)) {
      const text = read(path);
      if (text !== null) { found = { text, path }; break; }
    }
    lus.set(cle, found);
    if (found.text !== null) report.checkedFiles++;
    return found;
  };

  // Branches déclarées par master, toutes opérations actives confondues.
  const tachesParMaster = new Map<string, Set<string>>();
  for (const op of input.operations) {
    if (op.active && op.masterPromptCode && op.task) {
      const s = tachesParMaster.get(op.masterPromptCode) ?? new Set<string>();
      s.add(op.task);
      tachesParMaster.set(op.masterPromptCode, s);
    }
  }

  const mastersVus = new Set<string>();
  for (const op of input.operations) {
    const codes = [...new Set([op.promptCode, op.masterPromptCode].filter((c): c is string => Boolean(c)))];
    for (const code of codes) {
      const { text } = lire(code, op);
      if (text === null) {
        const msg = `${op.operationCode} : fichier introuvable (attendu : ${promptFileCandidates(code, op.useCaseCode, '')[0].split(sep).join('/')})`;
        if (op.active) report.errors.push(msg);
        else report.warnings.push(`${msg} — opération inactive (ARCH-02)`);
        continue;
      }
      if (op.promptVariables && structuredFileSpec(code)) {
        // Contexte structuré : chaque variable de l'opération doit être un champ du contrat d'entrée.
        const spec = structuredFileSpec(code)!;
        const champs = new Set(Object.values(spec.inputContracts[spec.defaults.inputContractVersion ?? '']?.fields ?? {}).map((f) => f.legacyVariable));
        for (const v of op.promptVariables) {
          if (!champs.has(v)) report.errors.push(`${op.operationCode} : variable ${v} sans champ dans le contrat d’entrée ${spec.defaults.inputContractVersion}`);
        }
      } else if (op.promptVariables) {
        const attendus = new Set(op.promptVariables);
        const info = inspectMasterTemplate(text);
        const presents = info.placeholders.filter((p) => p !== (info.discriminant ?? MASTER_TASK_PLACEHOLDER));
        for (const p of presents) {
          if (!attendus.has(p)) report.errors.push(`${op.operationCode} : emplacement {{${p}}} de « ${code} » sans variable déclarée`);
        }
        for (const v of attendus) {
          if (!presents.includes(v)) report.errors.push(`${op.operationCode} : variable ${v} déclarée sans emplacement dans « ${code} »`);
        }
      }
    }

    if (op.masterPromptCode && !mastersVus.has(op.masterPromptCode)) {
      mastersVus.add(op.masterPromptCode);
      const { text } = lire(op.masterPromptCode, op);
      const structure = structuredFileSpec(op.masterPromptCode);
      if (text !== null && structure) {
        const d = structure.defaults;
        for (const i of checkExecutionConfig(structure, d, (name, v) => contractVersionsOf(name).includes(v))) {
          report.errors.push(`master « ${op.masterPromptCode} » (contexte structuré) : ${i.message}`);
        }
        const taches = [...(tachesParMaster.get(op.masterPromptCode) ?? [])];
        for (const t of taches.filter((x) => !(d.allowedTasks ?? structure.knownTasks).includes(x))) {
          report.errors.push(`master « ${op.masterPromptCode} » : TASK ${t} déclarée au registre mais non autorisée par la configuration d’exécution`);
        }
        const restes = inspectMasterTemplate(text).placeholders;
        if (restes.length) report.warnings.push(`master « ${op.masterPromptCode} » (contexte structuré) : emplacement(s) ${restes.map((p) => `{{${p}}}`).join(', ')} jamais remplacé(s)`);
        report.infos.push(`master « ${op.masterPromptCode} » : contexte structuré (${d.inputContractVersion} / ${d.outputContractVersion}), aucun emplacement exigé`);
      } else if (text !== null) {
        const taches = [...(tachesParMaster.get(op.masterPromptCode) ?? [])];
        for (const a of checkMasterTemplate(text, taches)) {
          report.errors.push(`master « ${op.masterPromptCode} » : ${a}`);
        }
        const inconnues = inspectMasterTemplate(text).branches.filter((b) => !taches.includes(b));
        if (inconnues.length > 0) {
          report.warnings.push(`master « ${op.masterPromptCode} » : branche(s) sans opération déclarée : ${inconnues.join(', ')}`);
        }
        if (!input.operations.some((o) => o.masterPromptCode === op.masterPromptCode && o.promptVariables)) {
          report.infos.push(`master « ${op.masterPromptCode} » : variables non déclarées au registre (\`promptVariables\`), emplacements non vérifiés`);
        }
      }
    }
  }
  return report;
}
