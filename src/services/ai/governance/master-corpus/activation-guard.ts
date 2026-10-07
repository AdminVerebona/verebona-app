/**
 * État du corpus des prompts maîtres d'une version de configuration —
 * DIAGNOSTIC seulement (CDC 15 §30, D-17 ; ticket BO-IA-PROMPTS-01).
 *
 * ⚠️ Ce module N'EST PLUS une garde d'activation. Jusqu'au lot 26, aucune
 * version ne devenait ACTIVE sans corpus vert sur l'empreinte exacte de
 * chaque master (rejeu ci/préprod/prod, plus passage réel en préprod pour un
 * texte de version). Décision BO-IA-PROMPTS-01 : le corpus est un contrôle
 * qualité facultatif ; ni `config-version.service` ni l'administration des
 * prompts maîtres (`services/ai/master-prompts`) ne le consultent pour
 * autoriser une activation.
 *
 * Reste utilisé par les outils de développement et de diagnostic
 * (`ai:corpus` : `effectiveMasterText`) et décrit, pour une version, ce que
 * le corpus enregistré dit de chacun de ses masters.
 */
import { promptArchitectureOf, masterPromptOf, type ConfigVersionWithEntries, type TreatmentConfig } from '../../config/config-types';
import { masterPromptForTreatment } from '../../config/prompt-architecture';
import { isPromptAdministrable, type Treatment } from '../../config/treatments';
import { masterTextFingerprint } from '../../prompts/prompt-loader';
import type { CorpusRunMode, CorpusRunRow, CorpusRunSource } from './repository';

export type MasterGateStatus =
  | 'GREEN' | 'NO_RUN' | 'RUN_FAILED' | 'BRANCHES_MISSING' | 'LIVE_RUN_MISSING' | 'LIVE_RUN_FAILED'
  | 'CORPUS_TABLE_MISSING' | 'MASTER_FILE_MISSING';

type RunSummary = Pick<CorpusRunRow, 'id' | 'status' | 'branchesPassed' | 'casesTotal' | 'casesPassed' | 'source' | 'runMode' | 'createdAt'>;

export interface MasterGateEntry {
  treatment: Treatment;
  masterPromptCode: string;
  textSha256: string | null;
  textSource: 'config' | 'file';
  branchesRequired: string[];
  status: MasterGateStatus;
  message: string;
  lastRun: RunSummary | null;
  lastLiveRun: RunSummary | null;
}

export interface MasterGateResult {
  allowed: boolean;
  entries: MasterGateEntry[];
}

export interface MasterGateDeps {
  readMasterFile(masterPromptCode: string): string;
  latestRun(masterPromptCode: string, textSha256: string, opts: { mode: CorpusRunMode; sources: CorpusRunSource[] }): Promise<CorpusRunRow | null>;
  tableReady(): Promise<boolean>;
}

/** Sources admises par la garde (jamais `local`). */
export const GATE_REPLAY_SOURCES: CorpusRunSource[] = ['ci', 'preprod', 'prod'];
export const GATE_LIVE_SOURCES: CorpusRunSource[] = ['preprod'];

async function defaultDeps(): Promise<MasterGateDeps> {
  const [{ readMasterFileFromRepo }, repo] = await Promise.all([import('./cases'), import('./repository')]);
  return { readMasterFile: readMasterFileFromRepo, latestRun: repo.latestCorpusRun, tableReady: repo.corpusTableReady };
}

/** Texte master effectif d'une ligne en `master` (même règle que la passerelle). Lève si le fichier est illisible. */
export function effectiveMasterText(
  entry: TreatmentConfig, readMasterFile: (code: string) => string,
): { masterPromptCode: string; text: string; source: 'config' | 'file'; branches: string[] } | null {
  const master = masterPromptForTreatment(entry.treatment);
  if (!master || promptArchitectureOf(entry) !== 'master') return null;
  const configured = isPromptAdministrable(entry.treatment) ? masterPromptOf(entry) : null;
  // Texte de version identique au fichier : traité comme le fichier.
  const fichier = configured === null ? readMasterFile(master.masterPromptCode) : null;
  return {
    masterPromptCode: master.masterPromptCode,
    text: configured ?? fichier!,
    source: configured ? 'config' : 'file',
    branches: master.tasks,
  };
}

const resume = (r: CorpusRunRow | null): RunSummary | null => (r ? {
  id: r.id, status: r.status, branchesPassed: r.branchesPassed, casesTotal: r.casesTotal,
  casesPassed: r.casesPassed, source: r.source, runMode: r.runMode, createdAt: r.createdAt,
} : null);

/** État du corpus pour chaque traitement en `master` de la version. Ne lève pas pour un refus. */
export async function checkMasterActivation(
  version: Pick<ConfigVersionWithEntries, 'entries'>, deps?: MasterGateDeps,
): Promise<MasterGateResult> {
  const d = deps ?? await defaultDeps();
  const entries: MasterGateEntry[] = [];
  let ready: boolean | null = null;
  for (const e of version.entries) {
    const master = masterPromptForTreatment(e.treatment);
    if (!master || promptArchitectureOf(e) !== 'master') continue;
    let m: ReturnType<typeof effectiveMasterText>;
    try {
      m = effectiveMasterText(e, d.readMasterFile);
    } catch (err) {
      entries.push({
        treatment: e.treatment, masterPromptCode: master.masterPromptCode, textSha256: null, textSource: 'file',
        branchesRequired: master.tasks, status: 'MASTER_FILE_MISSING', lastRun: null, lastLiveRun: null,
        message: `${e.treatment} : fichier master ${master.masterPromptCode} illisible (${(err as Error).message}).`,
      });
      continue;
    }
    if (!m) continue;
    // Texte de version rigoureusement égal au fichier : c'est le fichier.
    let source = m.source;
    if (source === 'config') {
      try { if (d.readMasterFile(m.masterPromptCode) === m.text) source = 'file'; } catch { /* fichier illisible : reste config */ }
    }
    const sha = masterTextFingerprint(m.text);
    const base = {
      treatment: e.treatment, masterPromptCode: m.masterPromptCode, textSha256: sha, textSource: source, branchesRequired: m.branches,
    };
    ready ??= await d.tableReady().catch(() => false);
    if (!ready) {
      entries.push({ ...base, status: 'CORPUS_TABLE_MISSING', lastRun: null, lastLiveRun: null,
        message: `${e.treatment} : table des exécutions de corpus (0224) absente.` });
      continue;
    }
    const empreinte = `empreinte ${sha.slice(0, 12)} (${source === 'config' ? 'texte de la version' : 'fichier du dépôt'})`;
    const run = await d.latestRun(m.masterPromptCode, sha, { mode: 'replay', sources: GATE_REPLAY_SOURCES });
    const live = source === 'config'
      ? await d.latestRun(m.masterPromptCode, sha, { mode: 'live', sources: GATE_LIVE_SOURCES })
      : null;
    const avec = { lastRun: resume(run), lastLiveRun: resume(live) };
    const manquantes = (r: CorpusRunRow) => m!.branches.filter((b) => !r.branchesPassed.includes(b));

    if (!run) {
      entries.push({ ...base, ...avec, status: 'NO_RUN',
        message: `${e.treatment} : aucun corpus rejoué (ci/préprod/prod) pour ${m.masterPromptCode}, ${empreinte}. `
          + 'Lancer `npm run ai:corpus -- --version <id> --record` (CDC 15 §30).' });
      continue;
    }
    if (run.status !== 'PASSED') {
      entries.push({ ...base, ...avec, status: 'RUN_FAILED',
        message: `${e.treatment} : corpus rejoué en échec pour ${m.masterPromptCode} (${run.casesPassed}/${run.casesTotal} cas), ${empreinte}.` });
      continue;
    }
    if (manquantes(run).length) {
      entries.push({ ...base, ...avec, status: 'BRANCHES_MISSING',
        message: `${e.treatment} : branche(s) ${manquantes(run).join(', ')} sans corpus vert pour ${m.masterPromptCode}, ${empreinte}.` });
      continue;
    }
    if (source === 'config') {
      if (!live) {
        entries.push({ ...base, ...avec, status: 'LIVE_RUN_MISSING',
          message: `${e.treatment} : texte master modifié dans la version — passage RÉEL en préproduction exigé (D-17). `
            + 'Lancer en préprod `npm run ai:corpus -- --live --record --account <id>` sur cette version effective.' });
        continue;
      }
      if (live.status !== 'PASSED' || manquantes(live).length) {
        entries.push({ ...base, ...avec, status: 'LIVE_RUN_FAILED',
          message: `${e.treatment} : passage réel en préprod non vert (${live.casesPassed}/${live.casesTotal} cas`
            + `${manquantes(live).length ? `, branche(s) ${manquantes(live).join(', ')} manquante(s)` : ''}), ${empreinte}.` });
        continue;
      }
    }
    entries.push({ ...base, ...avec, status: 'GREEN',
      message: `${e.treatment} : corpus vert (${run.casesPassed}/${run.casesTotal} cas, ${run.source}`
        + `${live ? ` ; réel préprod ${live.casesPassed}/${live.casesTotal}` : ''}), ${empreinte}.` });
  }
  return { allowed: entries.every((x) => x.status === 'GREEN'), entries };
}
