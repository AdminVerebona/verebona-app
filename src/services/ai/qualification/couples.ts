/**
 * Couples d'une version de configuration et leur signature courante — lot
 * 86A (CDC Pilotage IA V2 P5 : QUAL-01, QUAL-07, CFG-03, ACT-02).
 *
 * Un COUPLE = (opération, rang dans la chaîne, modèle, profil effectif). Le
 * profil est celui que construit le constructeur de requête UNIQUE
 * (`profile-check.operationRequestPlan`, lot 85C) : mêmes paramètres qu'en
 * validation et en exécution. Le prompt est le prompt maître EFFECTIF de la
 * révision (même ordre que le résolveur : prompt figé dans l'instantané,
 * sinon version active administrée au BO, sinon texte de la configuration,
 * sinon fichier du dépôt).
 */
import { AI_OPERATIONS } from '../registry/operations';
import { profiledOperationsOf } from '../config/operation-profiles';
import { operationRequestPlan } from '../config/profile-check';
import type { ConfigVersionWithEntries, TreatmentConfig } from '../config/config-types';
import type { ConfigSnapshot, MasterPromptRef } from '../config/config-snapshot';
import type { Treatment } from '../config/treatments';
import type { MasterExecutionConfig } from '../master-prompts/structured-context';
import { coupleSignature, sha256, QUALIFICATION_ENGINE_VERSION, type CoupleSignatureParts } from './signature';
import { QUALIFICATION_THRESHOLDS } from './thresholds';

export interface CoupleProfile {
  reasoning: string | null;
  reasoningOrigin: string | null;
  maxOutputTokens: number | null;
  timeoutMs: number;
  timeoutOrigin: string | null;
  /** Paramètres effectivement construits (température, plafond, raisonnement). */
  params: Record<string, unknown> | null;
}

export interface CoupleDescriptor {
  treatment: Treatment;
  operationCode: string;
  rank: number;
  slot: 'primaryModel' | 'fallback1' | 'fallback2';
  model: string;
  versionId: number;
  revisionId: number | null;
  profile: CoupleProfile;
  technicalRefusal: { parameter: string | null; message: string } | null;
  parts: CoupleSignatureParts;
  signature: string;
}

export interface PromptContext {
  /** Prompts figés dans l'instantané de la révision. */
  snapshotPrompts: ConfigSnapshot['masterPrompts'];
  /** Prompts maîtres actifs administrés au BO (repli du résolveur). */
  activePrompts: ConfigSnapshot['masterPrompts'];
  readMasterFile: (code: string) => string;
}

/** Texte et configuration d'exécution du prompt maître effectif d'un traitement. */
export function effectivePrompt(entry: TreatmentConfig, masterPromptCode: string, ctx: PromptContext): { text: string; execution: MasterExecutionConfig | null; source: 'snapshot' | 'active' | 'config' | 'file' } {
  const ref: MasterPromptRef | null | undefined = ctx.snapshotPrompts[entry.treatment] ?? ctx.activePrompts[entry.treatment];
  if (ref && ref.masterPromptCode === masterPromptCode) {
    return { text: ref.content, execution: ref.execution ?? null, source: ctx.snapshotPrompts[entry.treatment] ? 'snapshot' : 'active' };
  }
  if (entry.promptArchitecture === 'master' && entry.masterPrompt) return { text: entry.masterPrompt, execution: null, source: 'config' };
  return { text: ctx.readMasterFile(masterPromptCode), execution: null, source: 'file' };
}

/** Empreinte du code d'évaluation d'une opération (contrôle serveur, comparateur T1, moteur). */
async function evaluatorFingerprint(operationCode: string): Promise<string> {
  const [{ MASTER_CORPUS_EVALUATORS }, cmp] = await Promise.all([import('../governance/master-corpus/evaluators'), import('../governance/corpus/corpus-comparator')]);
  const ev = (MASTER_CORPUS_EVALUATORS as Record<string, unknown>)[operationCode];
  const t1 = operationCode === 't1_analyze_document' ? `${cmp.compareField.toString()}${cmp.compareCase.toString()}` : '';
  return sha256(`${QUALIFICATION_ENGINE_VERSION}|${typeof ev === 'function' ? ev.toString() : 'schema-only'}|${t1}`);
}

/** Empreinte du contrat de sortie de la branche pour la configuration d'exécution du prompt. */
async function contractFingerprint(operationCode: string, execution: MasterExecutionConfig | null): Promise<string | null> {
  const op = AI_OPERATIONS[operationCode];
  if (!op?.masterPromptCode) return op ? sha256(op.outputSchema) : null;
  const [{ schemaNameFor }, { activeContractVersion }, { executionConfigFor }] = await Promise.all([
    import('../governance/master-corpus/runner'), import('../gateway/output-resolution/runtime-contract'), import('../master-prompts/structured-context'),
  ]);
  const exec = execution ?? executionConfigFor({ masterPromptCode: op.masterPromptCode, source: 'file' });
  const schemaName = schemaNameFor({ masterPromptCode: op.masterPromptCode, task: op.task ?? '', outputSchema: op.outputSchema }, exec);
  return sha256(`${schemaName}|${exec?.mode ?? 'LEGACY_TEMPLATE'}|${exec?.outputContractVersion ?? ''}|v${activeContractVersion(schemaName) ?? 'na'}`);
}

/**
 * Couples d'une version (tous les rangs de chaque opération modèle des
 * traitements demandés) avec leur signature courante. `corpusFingerprints` :
 * empreinte du corpus de chaque opération (`cases.buildCaseSet`).
 */
export async function describeVersionCouples(version: Pick<ConfigVersionWithEntries, 'id' | 'entries' | 'currentRevisionId'>, opts: {
  prompts: PromptContext;
  corpusFingerprints: (operationCode: string) => Promise<string>;
  treatments?: readonly Treatment[];
  operationCodes?: readonly string[];
  capabilitiesSha?: (model: string) => string | null;
}): Promise<CoupleDescriptor[]> {
  const { capabilitiesOf, capabilitiesSha256 } = await import('../provider/model-capabilities');
  const capSha = opts.capabilitiesSha ?? ((m: string) => capabilitiesSha256(capabilitiesOf(m)));
  const out: CoupleDescriptor[] = [];
  for (const entry of version.entries) {
    if (opts.treatments && !opts.treatments.includes(entry.treatment)) continue;
    for (const op of profiledOperationsOf(entry.treatment)) {
      if (opts.operationCodes && !opts.operationCodes.includes(op.operationCode)) continue;
      const prompt = op.masterPromptCode ? effectivePrompt(entry, op.masterPromptCode, opts.prompts) : null;
      const promptFp = prompt ? sha256(`${prompt.text.replace(/\r\n?/g, '\n')}|${op.task ?? ''}`) : null;
      const contractFp = await contractFingerprint(op.operationCode, prompt?.execution ?? null);
      const corpusFp = await opts.corpusFingerprints(op.operationCode);
      const evalFp = await evaluatorFingerprint(op.operationCode);
      for (const p of operationRequestPlan(entry, op)) {
        const profile: CoupleProfile = {
          reasoning: p.profile.reasoning ?? null, reasoningOrigin: p.profile.reasoningOrigin,
          maxOutputTokens: p.result.ok ? (p.result.params.maxOutputTokens ?? null) : (p.profile.maxOutputTokens ?? null),
          timeoutMs: p.profile.timeoutMs, timeoutOrigin: p.profile.timeoutOrigin,
          params: p.result.ok ? (p.result.params as unknown as Record<string, unknown>) : null,
        };
        const parts: CoupleSignatureParts = {
          operationCode: op.operationCode, rank: p.rank, model: p.model,
          profile: { params: profile.params, timeoutMs: profile.timeoutMs, refused: p.result.ok ? null : p.result.refusal.parameter },
          promptFingerprint: promptFp, contractFingerprint: contractFp, corpusFingerprint: corpusFp, evaluatorFingerprint: evalFp,
          capabilitiesSha256: capSha(p.model), thresholdsVersion: QUALIFICATION_THRESHOLDS.version,
        };
        out.push({
          treatment: entry.treatment, operationCode: op.operationCode, rank: p.rank, slot: p.slot, model: p.model,
          versionId: version.id, revisionId: version.currentRevisionId ?? null, profile,
          technicalRefusal: p.result.ok ? null : { parameter: p.result.refusal.parameter, message: p.result.refusal.message },
          parts, signature: coupleSignature(parts),
        });
      }
    }
  }
  return out;
}
