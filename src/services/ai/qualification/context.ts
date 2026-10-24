/**
 * Contexte partagé de la qualification par couple — lot 86A : prompts
 * effectifs d'une version, empreintes de corpus (mémorisées : les cas du
 * corpus sont des fichiers du dépôt, figés pour la durée du processus),
 * couples et états courants d'une version.
 */
import { pgClient } from '@/db';
import type { ConfigVersionWithEntries } from '../config/config-types';
import type { Treatment } from '../config/treatments';
import type { MasterCorpusCase, MasterFileReader } from '../governance/master-corpus/cases';
import { describeVersionCouples, effectivePrompt, type CoupleDescriptor, type PromptContext } from './couples';
import { coupleKey, evidenceRefsFor, runningCampaigns } from './repository';
import { stateOfCouple, type CoupleState } from './states';

const corpusFp = new Map<string, Promise<string>>();

/** Empreinte du corpus d'une opération (mémorisée par processus ; tests : `corpusCases` non mémorisé). */
export function corpusFingerprintOf(operationCode: string, opts: { readMasterFile: MasterFileReader; corpusCases?: MasterCorpusCase[]; includeT1Reference?: boolean }): Promise<string> {
  const build = async () => (await (await import('./cases')).buildCaseSet(operationCode, {
    readMasterFile: opts.readMasterFile, corpusCases: opts.corpusCases, includeT1Reference: opts.includeT1Reference,
  })).corpusFingerprint;
  if (opts.corpusCases || opts.includeT1Reference === false) return build();
  const hit = corpusFp.get(operationCode);
  if (hit) return hit;
  const p = build().catch((e) => { corpusFp.delete(operationCode); throw e; });
  corpusFp.set(operationCode, p);
  return p;
}

export function __resetQualificationContextForTests(): void {
  corpusFp.clear();
}

/** Lecture du fichier master du dépôt (valeur par défaut). */
export async function defaultMasterReader(): Promise<MasterFileReader> {
  return (await import('../governance/master-corpus/cases')).readMasterFileFromRepo;
}

/** Prompts effectifs d'une version (instantané de sa révision, actifs du BO, fichier). */
export async function promptContextOf(version: Pick<ConfigVersionWithEntries, 'currentRevisionId' | 'environment'>, readMasterFile: MasterFileReader): Promise<PromptContext> {
  const repo = await import('../config/config-version.repository');
  const rev = version.currentRevisionId ? await repo.getRevision(version.currentRevisionId).catch(() => null) : null;
  const active = await repo.readActiveMasterPromptRefs(pgClient as unknown as import('../config/config-version.repository').SqlLike, version.environment).catch(() => ({}));
  return { snapshotPrompts: rev?.snapshot.masterPrompts ?? {}, activePrompts: active, readMasterFile };
}

/** Lecteur des textes master EFFECTIFS d'une version (évaluateurs). */
export function masterTextReader(version: Pick<ConfigVersionWithEntries, 'entries'>, prompts: PromptContext): MasterFileReader {
  return (code: string) => {
    for (const e of version.entries) {
      const p = effectivePrompt(e, code, prompts);
      if (p.source !== 'file') return p.text;
    }
    return prompts.readMasterFile(code);
  };
}

export interface CoupleWithState extends CoupleDescriptor { state: CoupleState }

/** Couples d'une version et leur état courant (calculé, aucune écriture). */
export async function couplesWithState(version: ConfigVersionWithEntries, opts: {
  readMasterFile: MasterFileReader; treatments?: readonly Treatment[]; operationCodes?: readonly string[];
  corpusCases?: MasterCorpusCase[]; includeT1Reference?: boolean;
}): Promise<CoupleWithState[]> {
  await (await import('../provider/model-capabilities.repository')).ensureModelCapabilitiesLoaded().catch(() => undefined);
  const prompts = await promptContextOf(version, opts.readMasterFile);
  const couples = await describeVersionCouples(version, {
    prompts, treatments: opts.treatments, operationCodes: opts.operationCodes,
    corpusFingerprints: (op) => corpusFingerprintOf(op, opts),
  });
  const refs = await evidenceRefsFor(version.environment, couples);
  const enTest = new Set<string>();
  for (const c of await runningCampaigns(version.environment)) {
    for (const k of (c.request.coupleKeys as string[] | undefined) ?? []) enTest.add(k);
  }
  return couples.map((c) => ({
    ...c,
    state: stateOfCouple({ evidences: refs.get(coupleKey(c.operationCode, c.model, c.rank)) ?? [], current: { signature: c.signature, parts: c.parts }, testing: enTest.has(`${coupleKey(c.operationCode, c.model, c.rank)}|${c.signature}`) }),
  }));
}
