/**
 * Campagnes de qualification par couple — lot 86A (CDC Pilotage IA V2 P5 :
 * QUAL-01..09, OPT-01/02, DEC-01/02, ACT-01/02, VER-01, R04-R07, R12, R13,
 * R31, R32, R47-R50 ; décisions PO n° 06, 13 et 14).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉROULEMENT (§16.2, étapes 3 à 7)
 *
 *   0. Préproduction seulement : en production aucune campagne comparative
 *      (OPT-03, HORS-04) — refus motivé, aucun appel.
 *   1. POINT DE RESTAURATION 82E pris avant tout appel (décision 13) —
 *      sauvegarde existante (`runDatabaseBackup`), jamais un système
 *      parallèle ; impossible → campagne REFUSÉE (non concluante), rien
 *      n'est appelé.
 *   2. Plan : couple(s) demandé(s) (test manuel du BO), ou, en campagne
 *      automatique, les couples de la configuration ACTIVE jamais testés ou
 *      devenus obsolètes (requalification ciblée sur événement, R12, QUAL-06 :
 *      rien à faire → rien n'est lancé) et au plus une candidate par
 *      traitement (nouveau modèle utilisable, CANDIDATE NON ACTIVE — VER-01).
 *   3. Comptes existants éligibles VERROUILLÉS (une campagne à la fois par
 *      compte) ; leurs entrées capturées rejouées (décision 13, aucun compte
 *      dédié, aucune remise à zéro, aucune écriture métier).
 *   4. Chaque couple est exécuté sur les MÊMES cas que la référence (couple
 *      actif de rang 0 de l'opération, mesuré dans la même campagne : DEC-02,
 *      R50), verdict `verdict.ts`, preuve historisée.
 *   5. Candidate : activée AUTOMATIQUEMENT en préproduction seulement si tous
 *      ses couples sont admissibles ET qu'un gain est établi ; sinon l'active
 *      reste intacte, cause et résultats conservés (R04, R47). Aucune mise à
 *      jour automatique des DONNÉES : un rejeu sans attendu vérifiable n'est
 *      jamais une validation (décision 13 : non vérifiable = non concluant).
 *   6. Verrous libérés, résumé enregistré. Interruption (processus arrêté) :
 *      la campagne passe INTERROMPUE au prochain passage, preuves non
 *      concluantes, journaux conservés (R13) ; rien à restaurer côté métier
 *      (aucune écriture de données), le point de restauration reste
 *      disponible.
 * Aucun effet externe : seuls des appels modèle passent (passerelle) — ni
 * notification, ni e-mail, ni Stripe, ni travail de file.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { getAiEnvironment, type AiEnvironment } from '../config/environment';
import type { ConfigVersionWithEntries } from '../config/config-types';
import type { Treatment } from '../config/treatments';
import { treatmentOfUseCase } from '../config/treatments';
import { AI_OPERATIONS } from '../registry/operations';
import type { MasterCorpusCase, MasterFileReader } from '../governance/master-corpus/cases';
import { buildCaseSet, type CaptureRow, type CaseSet } from './cases';
import { couplesWithState, defaultMasterReader, masterTextReader, promptContextOf, type CoupleWithState } from './context';
import type { CoupleDescriptor } from './couples';
import * as repo from './repository';
import { runCoupleCases, type GatewayCall, type Observation } from './runner';
import { sha256 } from './signature';
import { optimizationPriority, QUALIFICATION_THRESHOLDS, type QualificationThresholds } from './thresholds';
import { chooseCandidate, decideCoupleVerdict, establishedGain, percentile, type CandidateAssessment, type Reason, type Verdict } from './verdict';
import { assessNonRegression, type NonRegressionAssessment, type OperationRun } from './non-regression';

export interface CampaignDeps {
  now?: () => Date;
  call?: GatewayCall;
  /** Point de restauration 82E (défaut : sauvegarde de la base, `runDatabaseBackup`). */
  takeRestorePoint?: (label: string, trigger: 'admin' | 'scheduler') => Promise<{ backupId: string; finishedAt: string }>;
  /** Compte technique de mesure des cas du corpus (défaut : `CORPUS_ACCOUNT_ID`). */
  technicalAccountId?: number | null;
  readMasterFile?: MasterFileReader;
  corpusCases?: MasterCorpusCase[];
  includeT1Reference?: boolean;
  environment?: AiEnvironment;
  /** Modèles proposés comme candidats pour un traitement (défaut : modèles utilisables hors chaîne). */
  proposeModels?: (treatment: Treatment, chain: string[]) => Promise<string[]>;
  /** Comptes existants éligibles (défaut : éligibilité 82A). */
  accounts?: () => Promise<number[]>;
  thresholds?: QualificationThresholds;
  log?: (m: string) => void;
}

interface ManualCoupleRequest { versionId?: number | null; treatment: Treatment; operationCode: string; rank: number }

export class QualificationRefused extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'QualificationRefused'; }
}

/** Environnement autorisé pour une campagne (jamais la production). */
export function campaignAllowed(env: AiEnvironment): { allowed: boolean; reason: string | null } {
  return env === 'production'
    ? { allowed: false, reason: 'Campagnes de qualification réservées à la préproduction : la production n’expérimente aucun couple et ne lance aucun appel comparatif (OPT-03, HORS-04, décision 06).' }
    : { allowed: true, reason: null };
}

function technicalAccount(deps: CampaignDeps): number | null {
  if (deps.technicalAccountId !== undefined) return deps.technicalAccountId;
  const n = Number(process.env.CORPUS_ACCOUNT_ID);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function defaultRestorePoint(label: string, trigger: 'admin' | 'scheduler'): Promise<{ backupId: string; finishedAt: string }> {
  const { isS3Configured } = await import('@/lib/s3-config');
  if (!isS3Configured()) throw new Error('stockage objet non configuré : aucune sauvegarde possible');
  const { runDatabaseBackup } = await import('@/services/backup/database-backup.service');
  const m = await runDatabaseBackup(trigger, { label });
  return { backupId: m.backupId, finishedAt: m.finishedAt };
}

/** Propositions par défaut : modèles UTILISABLES pour le traitement (qualifiés techniquement, stables), hors chaîne courante. */
async function defaultProposals(treatment: Treatment, chain: string[]): Promise<string[]> {
  const { loadUsableModelsContext, evaluateModelForTreatment } = await import('../registry/usable-models');
  const { selectableModels } = await import('../provider/model-catalog.service');
  const ctx = await loadUsableModelsContext();
  return [...selectableModels(ctx.codeCatalog, ctx.catalog as never)]
    .filter((m) => !chain.includes(m) && evaluateModelForTreatment(treatment, m, ctx).usable)
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
}

// ══════════════════════════════════════════════════════════════════════════
// Demandes
// ══════════════════════════════════════════════════════════════════════════

/**
 * Test MANUEL d'un couple depuis le BO (ACT-02, R06, BO-10) : facultatif,
 * jamais exigé pour une activation manuelle ; aucune activation automatique
 * n'en découle. La campagne est créée (PENDING) puis exécutée en tâche de fond.
 */
export async function requestManualCoupleTest(p: { adminUserId: number; reason?: string | null; couple: ManualCoupleRequest }, deps: CampaignDeps & { await?: boolean } = {}): Promise<{ campaignId: number }> {
  const env = deps.environment ?? getAiEnvironment();
  const ok = campaignAllowed(env);
  if (!ok.allowed) throw new QualificationRefused('PRODUCTION_REFUSED', ok.reason!);
  const op = AI_OPERATIONS[p.couple.operationCode];
  if (!op || op.provider === 'none' || !op.active || treatmentOfUseCase(op.useCaseCode) !== p.couple.treatment) {
    throw new QualificationRefused('UNKNOWN_OPERATION', `Opération modèle « ${p.couple.operationCode} » inconnue pour ${p.couple.treatment}.`);
  }
  if (!Number.isInteger(p.couple.rank) || p.couple.rank < 0 || p.couple.rank > 2) throw new QualificationRefused('INVALID_RANK', 'Rang invalide (0 principal, 1 et 2 replis).');
  const id = await repo.createCampaign({
    kind: 'MANUAL', environment: env, trigger: 'admin', reason: p.reason ?? null, adminUserId: p.adminUserId,
    configVersionId: p.couple.versionId ?? null, thresholdsVersion: (deps.thresholds ?? QUALIFICATION_THRESHOLDS).version, request: { couple: p.couple },
  });
  const run = runCampaign(id, deps);
  if (deps.await) await run;
  else void run.catch((e) => console.error(`[qualification] campagne ${id} :`, (e as Error).message));
  return { campaignId: id };
}

/** Campagne AUTOMATIQUE de préproduction (tâche planifiée). Production : refus motivé, rien de créé. */
export async function requestAutomaticCampaign(p: { trigger: string }, deps: CampaignDeps = {}): Promise<{ campaignId: number | null; note: string }> {
  const env = deps.environment ?? getAiEnvironment();
  const ok = campaignAllowed(env);
  if (!ok.allowed) return { campaignId: null, note: ok.reason! };
  const th = deps.thresholds ?? QUALIFICATION_THRESHOLDS;
  await repo.interruptStaleCampaigns(th.campaign.staleAfterMs, (deps.now ?? (() => new Date()))());
  if ((await repo.runningCampaigns(env)).some((c) => c.kind === 'AUTO')) return { campaignId: null, note: 'campagne automatique déjà en cours' };
  const id = await repo.createCampaign({
    kind: 'AUTO', environment: env, trigger: p.trigger, reason: 'optimisation automatique de préproduction', adminUserId: null,
    configVersionId: null, thresholdsVersion: th.version, request: { auto: true },
  });
  const r = await runCampaign(id, deps);
  return { campaignId: id, note: `${r.status}${r.refusal ? ` : ${r.refusal}` : ''} — ${r.couplesTested} couple(s) testé(s)${r.activatedVersionId ? `, candidate v${r.activatedVersionId} activée` : ''}` };
}

/**
 * Lot 99B — campagne de NON-RÉGRESSION d'une révision de prompt
 * (`CONFORMITY`) : ancienne version active (référence) et candidate de
 * configuration (même configuration, seul le prompt maître du traitement
 * change) exécutées sur les MÊMES cas, pour TOUTES les opérations du prompt.
 * Préproduction seulement (même refus motivé en production). Point de
 * restauration avant tout appel, comptes verrouillés, rejeu sans écriture
 * métier : le déroulement 86A est réutilisé tel quel. AUCUNE activation ici :
 * l'état de la candidate (QUALIFIED / REFUSED / INCONCLUSIVE) et l'évaluation
 * de non-régression sont rendus à l'appelant (`prompt-conformity`).
 */
export async function requestConformityCampaign(p: {
  treatment: Treatment; candidateVersionId: number; contractId: string; reason: string;
  /** Prédicat des cas qui exercent la NOUVELLE branche (couverture exigée). */
  coverage: { label: string; matches(c: { variables: Record<string, unknown>; operationCode: string }): boolean } | null;
  /** Opérations dont la branche est absente des DEUX versions (fonction inactive) : hors périmètre, signalées. */
  excludedOperations?: Array<{ operationCode: string; reason: string }>;
  /**
   * Cas qui exercent un contrat absent des DEUX versions (fonction inactive des deux côtés, ex. étape suivante du
   * guide pas encore faite) : retirés AVANT exécution — ni réussis, ni bloquants —, signalés « hors périmètre ».
   */
  excludedCases?: Array<{ contractId: string; reason: string; matches(c: { variables: Record<string, unknown>; operationCode: string }): boolean }>;
}, deps: CampaignDeps = {}): Promise<{ campaignId: number | null; status: repo.CampaignStatus | 'NOT_ALLOWED'; refusal: string | null; assessment: NonRegressionAssessment | null }> {
  const env = deps.environment ?? getAiEnvironment();
  const ok = campaignAllowed(env);
  if (!ok.allowed) return { campaignId: null, status: 'NOT_ALLOWED', refusal: ok.reason, assessment: null };
  const th = deps.thresholds ?? QUALIFICATION_THRESHOLDS;
  await repo.interruptStaleCampaigns(th.campaign.staleAfterMs, (deps.now ?? (() => new Date()))());
  const id = await repo.createCampaign({
    kind: 'CONFORMITY', environment: env, trigger: 'prompt-conformity', reason: p.reason.slice(0, 1000), adminUserId: null,
    configVersionId: null, candidateVersionId: p.candidateVersionId, thresholdsVersion: th.version,
    request: { conformity: { treatment: p.treatment, candidateVersionId: p.candidateVersionId, contractId: p.contractId, coverage: p.coverage?.label ?? null, excluded: p.excludedOperations ?? [] } },
  });
  conformityCoverage.set(id, p.coverage);
  conformityExcludedCases.set(id, p.excludedCases ?? []);
  try {
    const r = await runCampaign(id, deps);
    return { campaignId: id, status: r.status, refusal: r.refusal, assessment: r.conformity ?? null };
  } finally {
    conformityCoverage.delete(id);
    conformityExcludedCases.delete(id);
  }
}

/** Lot 99B : cas hors périmètre des campagnes CONFORMITY en cours (contrat absent des deux versions). */
const conformityExcludedCases = new Map<number, NonNullable<Parameters<typeof requestConformityCampaign>[0]['excludedCases']>>();

/** Prédicats de couverture des campagnes CONFORMITY en cours (fonctions : jamais sérialisées en base). */
const conformityCoverage = new Map<number, { label: string; matches(c: { variables: Record<string, unknown>; operationCode: string }): boolean } | null>();

// ══════════════════════════════════════════════════════════════════════════
// Exécution
// ══════════════════════════════════════════════════════════════════════════

interface PlannedCouple {
  couple: CoupleDescriptor;
  role: 'CANDIDATE' | 'REFERENCE';
  /** Clé du couple de référence de son opération (même campagne). */
  referenceKey: string | null;
  candidateVersionId: number | null;
}

interface CampaignResult {
  campaignId: number;
  status: repo.CampaignStatus;
  refusal: string | null;
  couplesTested: number;
  evidenceIds: number[];
  activatedVersionId: number | null;
  /** Lot 99B : évaluation de non-régression (campagne CONFORMITY). */
  conformity?: NonRegressionAssessment;
}

const keyOf = (c: CoupleDescriptor) => `${repo.coupleKey(c.operationCode, c.model, c.rank)}|${c.signature}`;

async function runCampaign(campaignId: number, deps: CampaignDeps = {}): Promise<CampaignResult> {
  const th = deps.thresholds ?? QUALIFICATION_THRESHOLDS;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const campaign = await repo.getCampaignRow(campaignId);
  if (!campaign) throw new QualificationRefused('CAMPAIGN_NOT_FOUND', `Campagne ${campaignId} introuvable.`);
  const env = campaign.environment as AiEnvironment;
  const result: CampaignResult = { campaignId, status: 'RUNNING', refusal: null, couplesTested: 0, evidenceIds: [], activatedVersionId: null };
  const refuse = async (reason: string) => {
    result.status = 'REFUSED';
    result.refusal = reason;
    await repo.updateCampaign(campaignId, { status: 'REFUSED', refusal: reason, finishedAt: now() });
    log(`refusée : ${reason}`);
    return result;
  };
  // 0. Préproduction seulement.
  const ok = campaignAllowed(deps.environment ?? getAiEnvironment());
  if (!ok.allowed) return refuse(ok.reason!);
  await repo.updateCampaign(campaignId, { status: 'RUNNING', startedAt: now() });

  try {
    // 1. Point de restauration AVANT tout appel.
    try {
      const rp = await (deps.takeRestorePoint ?? defaultRestorePoint)(`Qualification IA — campagne ${campaignId} (${campaign.kind === 'AUTO' ? 'automatique' : campaign.kind === 'CONFORMITY' ? 'mise en conformité d’un prompt' : 'test manuel'})`, campaign.kind === 'MANUAL' ? 'admin' : 'scheduler');
      await repo.updateCampaign(campaignId, { restorePointId: rp.backupId, restorePointAt: rp.finishedAt });
      log(`point de restauration ${rp.backupId} (${rp.finishedAt})`);
    } catch (e) {
      return await refuse(`Point de restauration impossible (${(e as Error).message}) : aucun appel effectué (décision 13).`);
    }

    const readMasterFile = deps.readMasterFile ?? await defaultMasterReader();
    const cfg = await import('../config/config-version.repository');
    const active = await cfg.getActiveVersion(env);
    const caseOpts = { readMasterFile, corpusCases: deps.corpusCases, includeT1Reference: deps.includeT1Reference };

    // 2. Plan.
    const plan: PlannedCouple[] = [];
    const candidates: Array<{ versionId: number; treatment: Treatment; model: string }> = [];
    const refOf = new Map<string, CoupleWithState>();
    const referenceCouples = async (ops: string[]) => {
      if (!active) return;
      const manquantes = ops.filter((o) => !refOf.has(o));
      if (!manquantes.length) return;
      for (const c of await couplesWithState(active, { ...caseOpts, operationCodes: manquantes })) if (c.rank === 0) refOf.set(c.operationCode, c);
    };
    const addRef = (op: string) => {
      const r = refOf.get(op);
      if (r && !plan.some((x) => keyOf(x.couple) === keyOf(r))) plan.push({ couple: r, role: 'REFERENCE', referenceKey: keyOf(r), candidateVersionId: null });
      return r ? keyOf(r) : null;
    };

    if (campaign.kind === 'MANUAL') {
      const want = campaign.request.couple as ManualCoupleRequest;
      const version = want.versionId ? await cfg.getVersion(want.versionId) : active;
      if (!version) return await refuse(want.versionId ? `Version ${want.versionId} introuvable.` : 'Aucune configuration active : précisez la version à tester.');
      const couples = await couplesWithState(version, { ...caseOpts, treatments: [want.treatment], operationCodes: [want.operationCode] });
      const cible = couples.find((c) => c.rank === want.rank);
      if (!cible) return await refuse(`Rang ${want.rank} absent de la chaîne de ${want.treatment} dans la version ${version.visibleNumber ?? version.id}.`);
      await referenceCouples([want.operationCode]);
      const ref = refOf.get(want.operationCode);
      if (ref && keyOf(ref) === keyOf(cible)) plan.push({ couple: cible, role: 'REFERENCE', referenceKey: keyOf(cible), candidateVersionId: null });
      else {
        const rk = addRef(want.operationCode);
        plan.push({ couple: cible, role: 'CANDIDATE', referenceKey: rk, candidateVersionId: null });
      }
    } else if (campaign.kind === 'CONFORMITY') {
      // Lot 99B : toutes les opérations du prompt modifié, ancienne version (référence) et candidate, rang 0, mêmes cas.
      const want = campaign.request.conformity as { treatment: Treatment; candidateVersionId: number; excluded?: Array<{ operationCode: string }> };
      const exclues = new Set((want.excluded ?? []).map((x) => x.operationCode));
      if (!active) return await refuse('Aucune configuration active : aucune référence à comparer.');
      const cand = await cfg.getVersion(want.candidateVersionId);
      if (!cand) return await refuse(`Candidate ${want.candidateVersionId} introuvable.`);
      for (const c of await couplesWithState(active, { ...caseOpts, treatments: [want.treatment] })) if (c.rank === 0) refOf.set(c.operationCode, c);
      for (const c of (await couplesWithState(cand, { ...caseOpts, treatments: [want.treatment] })).filter((x) => x.rank === 0 && !exclues.has(x.operationCode))) {
        plan.push({ couple: c, role: 'CANDIDATE', referenceKey: addRef(c.operationCode), candidateVersionId: cand.id });
      }
      if (!plan.length) return await refuse(`Aucune opération modèle pour ${want.treatment} : rien à comparer.`);
    } else {
      if (!active) return await refuse('Aucune configuration active : rien à qualifier ni à optimiser.');
      const actifs = await couplesWithState(active, caseOpts);
      for (const c of actifs) if (c.rank === 0) refOf.set(c.operationCode, c);
      const retry = (c: CoupleWithState) => c.state.state === 'INCONCLUSIVE' && c.state.verdictAt != null && now().getTime() - Date.parse(c.state.verdictAt) >= th.campaign.inconclusiveRetryAfterMs;
      // Requalification ciblée : jamais testés / obsolètes (événement), non concluants anciens ; rang 0 d'abord.
      const aRequalifier = actifs.filter((c) => !c.technicalRefusal && (c.state.state === 'NEVER_TESTED' || c.state.state === 'OBSOLETE' || retry(c)))
        .sort((a, b) => a.rank - b.rank).slice(0, th.campaign.maxCouplesPerCampaign);
      for (const c of aRequalifier) {
        if (c.rank === 0) { if (!plan.some((x) => keyOf(x.couple) === keyOf(c))) plan.push({ couple: c, role: 'REFERENCE', referenceKey: keyOf(c), candidateVersionId: null }); }
        else plan.push({ couple: c, role: 'CANDIDATE', referenceKey: addRef(c.operationCode), candidateVersionId: null });
      }
      // Candidates (VER-01) : au plus N par traitement, jamais une proposition identique déjà jugée.
      const svc = await import('../config/config-version.service');
      const { capabilitiesOf, capabilitiesSha256 } = await import('../provider/model-capabilities');
      for (const e of active.entries) {
        if (!e.primaryModel) continue;
        const chain = [e.primaryModel, e.fallback1, e.fallback2].filter((m): m is string => Boolean(m));
        const proposes = (await (deps.proposeModels ?? defaultProposals)(e.treatment, chain).catch(() => [] as string[])).filter((m) => !chain.includes(m));
        let pris = 0;
        for (const model of proposes) {
          if (pris >= th.campaign.maxCandidatesPerTreatment) break;
          const key = sha256(`${e.treatment}|${model}|${active.currentRevisionId}|${capabilitiesSha256(capabilitiesOf(model))}|${th.version}`);
          const deja = await cfg.findCandidateByKey(env, key);
          if (deja && !(deja.state === 'INCONCLUSIVE' && now().getTime() - deja.createdAt.getTime() >= th.campaign.inconclusiveRetryAfterMs)) continue;
          const v = await svc.createAutomaticCandidate({
            treatment: e.treatment, primaryModel: model, key, campaignId,
            reason: `Optimisation de préproduction : ${model} proposé en principal de ${e.treatment} à la place de ${e.primaryModel} (modèle utilisable, non testé sur ce couple).`,
          });
          await cfg.setCandidateState(v.id, 'QUALIFYING');
          candidates.push({ versionId: v.id, treatment: e.treatment, model });
          pris += 1;
          for (const c of (await couplesWithState(v, { ...caseOpts, treatments: [e.treatment] })).filter((x) => x.rank === 0)) {
            plan.push({ couple: c, role: 'CANDIDATE', referenceKey: addRef(c.operationCode), candidateVersionId: v.id });
          }
        }
      }
      if (!plan.length) {
        // R46 / QUAL-06 : aucun événement, aucune candidate — rien n'est lancé.
        await repo.updateCampaign(campaignId, { status: 'COMPLETED', finishedAt: now(), summary: { couples: [], candidates: [], note: 'rien à qualifier : aucun couple jamais testé ou obsolète, aucune candidate' } });
        result.status = 'COMPLETED';
        return result;
      }
    }
    await repo.updateCampaign(campaignId, {
      candidateVersionId: candidates[0]?.versionId ?? null,
      request: { ...campaign.request, coupleKeys: plan.map((x) => keyOf(x.couple)), candidates: candidates.map((c) => c.versionId) },
    });

    // 3. Comptes existants éligibles, verrouillés ; entrées capturées.
    const tech = technicalAccount(deps);
    const ops = [...new Set(plan.map((x) => x.couple.operationCode))];
    const comptes = await (deps.accounts ?? (() => repo.eligibleAccountIds(tech)))();
    const captures = new Map<string, CaptureRow[]>();
    for (const op of ops) {
      captures.set(op, await repo.loadReplayCaptures({ operationCode: op, accountIds: comptes, perAccount: th.campaign.replayPerAccount, max: th.campaign.replayMaxPerOperation }));
    }
    const aVerrouiller = [...new Set([...captures.values()].flat().map((c) => c.accountId))];
    const { busy } = await repo.lockAccounts(campaignId, aVerrouiller);
    const occupes = new Set(busy);

    // 4. Cas (une fois par opération), exécution des couples.
    const caseSets = new Map<string, CaseSet>();
    const runs = new Map<string, { observations: Observation[]; p95: number | null; evidenceId: number; verdict: Verdict; reasons: Reason[] }>();
    const ordre = [...plan].sort((a, b) => (a.role === b.role ? 0 : a.role === 'REFERENCE' ? -1 : 1));
    for (const item of ordre) {
      const c = item.couple;
      let set = caseSets.get(c.operationCode);
      if (!set) {
        set = await buildCaseSet(c.operationCode, {
          ...caseOpts, captures: (captures.get(c.operationCode) ?? []).filter((x) => !occupes.has(x.accountId)),
        });
        for (const x of (captures.get(c.operationCode) ?? []).filter((y) => occupes.has(y.accountId))) {
          set.skipped.push({ caseId: `replay:${x.id}`, source: 'PREPROD_REPLAY', reason: 'compte verrouillé par une autre campagne (QUAL-04)' });
        }
        // Lot 99B : cas d'un contrat absent des DEUX versions — retirés avant exécution (ni réussis, ni bloquants).
        const horsPerimetre = conformityExcludedCases.get(campaignId) ?? [];
        if (campaign.kind === 'CONFORMITY' && horsPerimetre.length) {
          set.cases = set.cases.filter((x) => {
            const e = horsPerimetre.find((h) => h.matches({ variables: x.variables, operationCode: x.operationCode }));
            if (e) set!.skipped.push({ caseId: x.caseId, source: x.source, reason: `hors périmètre : ${e.reason}` });
            return !e;
          });
        }
        caseSets.set(c.operationCode, set);
      }
      const version = c.versionId === active?.id ? active : await cfg.getVersion(c.versionId);
      const prompts = await promptContextOf(version as ConfigVersionWithEntries, readMasterFile);
      const run = c.technicalRefusal ? null : await runCoupleCases({
        couple: c, cases: set.cases, observations: campaign.kind === 'AUTO' ? th.campaign.observationsAuto : th.campaign.observationsManual,
        campaignId, technicalAccountId: tech, masterText: masterTextReader(version as ConfigVersionWithEntries, prompts), call: deps.call, thresholds: th,
      });
      await repo.heartbeat(campaignId);
      const obs = run?.observations ?? [];
      const decisives = obs.filter((o) => !o.advisory);
      const isSelf = item.role === 'REFERENCE';
      const ref = item.referenceKey && !isSelf ? runs.get(item.referenceKey) : null;
      const preconditions = !tech && set.cases.every((x) => x.accountId === null) ? ['Compte technique de mesure absent (CORPUS_ACCOUNT_ID) : les cas du corpus ne peuvent pas être exécutés.'] : [];
      const v = decideCoupleVerdict({
        observations: decisives, preconditions, technicalRefusal: c.technicalRefusal ?? run?.requestRejected ?? null,
        reference: { p95Ms: isSelf ? null : ref?.p95 ?? null, isSelf }, concurrency: run?.concurrency ?? null, thresholds: th,
      });
      const servedModel = run?.servedModels.length === 1 ? run.servedModels[0] : run?.servedModels.join(',') || null;
      const evidenceId = await repo.recordEvidence({
        campaignId, environment: env, treatment: c.treatment, operationCode: c.operationCode, model: c.model, servedModel,
        servedModelVersion: await repo.servedModelVersionOf(run?.firstTraceId ?? null), rank: c.rank,
        configVersionId: c.versionId, configRevisionId: c.revisionId, role: item.role, profile: c.profile as unknown as Record<string, unknown>,
        signature: c.signature, parts: c.parts, verdict: v.verdict, reasons: v.reasons,
        metrics: {
          ...v.metrics,
          skipped: { count: set.skipped.length, reasons: [...new Set(set.skipped.map((s) => s.reason))].slice(0, 10) },
          advisory: { observations: obs.length - decisives.length, defects: obs.filter((o) => o.advisory).reduce((n, o) => n + o.defects.length, 0) },
          sources: Object.fromEntries(['CORPUS_FIXTURE', 'T1_REFERENCE', 'PREPROD_REPLAY'].map((s) => [s, new Set(obs.filter((o) => o.source === s).map((o) => o.caseId)).size])),
          campaignKind: campaign.kind,
        },
        referenceEvidenceId: ref?.evidenceId ?? null,
      }, obs);
      result.evidenceIds.push(evidenceId);
      result.couplesTested += 1;
      runs.set(keyOf(c), { observations: decisives, p95: percentile(decisives.filter((o) => o.durationMs != null).map((o) => o.durationMs!), th.latency.percentile), evidenceId, verdict: v.verdict, reasons: v.reasons });
      log(`${c.operationCode} · ${c.model} · rang ${c.rank} (${item.role}) : ${v.verdict}`);
    }

    // 4 bis (lot 99B). Non-régression ancienne version ↔ candidate : aucune activation ici.
    if (campaign.kind === 'CONFORMITY') {
      const want = campaign.request.conformity as { candidateVersionId: number };
      const opRuns: OperationRun[] = [...new Set(plan.map((x) => x.couple.operationCode))].map((op) => {
        const c = plan.find((x) => x.couple.operationCode === op && x.role === 'CANDIDATE');
        const r = c?.referenceKey ? runs.get(c.referenceKey) : null;
        const k = c ? runs.get(keyOf(c.couple)) : null;
        return {
          operationCode: op,
          reference: r ? { verdict: r.verdict, reasons: r.reasons, observations: r.observations, evidenceId: r.evidenceId } : null,
          candidate: k ? { verdict: k.verdict, reasons: k.reasons, observations: k.observations, evidenceId: k.evidenceId } : null,
        };
      });
      const couverture = conformityCoverage.get(campaignId) ?? null;
      const caseIds = couverture ? [...caseSets.values()].flatMap((set) => set.cases.filter((x) => couverture.matches({ variables: x.variables, operationCode: x.operationCode })).map((x) => x.caseId)) : [];
      const assessment = assessNonRegression({ runs: opRuns, coverage: couverture ? { label: couverture.label, caseIds } : null, thresholds: th });
      await cfg.setCandidateState(want.candidateVersionId, assessment.decision === 'QUALIFIED' ? 'QUALIFIED' : assessment.decision === 'REFUSED' ? 'REFUSED' : 'INCONCLUSIVE',
        [...assessment.refusalReasons, ...assessment.blockingReasons].join(' · ').slice(0, 1000) || 'non-régression démontrée');
      const casExclus = [...caseSets.values()].flatMap((set) => set.skipped.filter((x) => x.reason.startsWith('hors périmètre : ')).map((x) => ({ caseId: x.caseId, reason: x.reason.slice('hors périmètre : '.length) })));
      result.conformity = { ...assessment, excluded: (campaign.request.conformity as { excluded?: Array<{ operationCode: string; reason: string }> }).excluded ?? [], excludedCases: casExclus };
    }

    // 5. Candidates : activation automatique en préproduction si qualifiée et gain établi.
    const summaryCandidates: Array<Record<string, unknown>> = [];
    if (candidates.length) {
      const assessments: CandidateAssessment[] = candidates.map((cand) => {
        const items = plan.filter((x) => x.candidateVersionId === cand.versionId);
        const verdicts = items.map((x) => runs.get(keyOf(x.couple))?.verdict ?? 'INCONCLUSIVE');
        const gains = items.map((x) => {
          const mine = runs.get(keyOf(x.couple))?.observations ?? [];
          const theirs = (x.referenceKey ? runs.get(x.referenceKey)?.observations : null) ?? [];
          return { operationCode: x.couple.operationCode, outcome: establishedGain(theirs, mine, optimizationPriority(x.couple.operationCode)).outcome };
        });
        const ratios = items.map((x) => {
          const pri = optimizationPriority(x.couple.operationCode);
          const moy = (l: Observation[]) => { const v = l.map((o) => (pri === 'LATENCY' ? o.durationMs : o.costMicros)).filter((n): n is number => n != null); return v.length ? v.reduce((s, n) => s + n, 0) / v.length : null; };
          const a = moy(runs.get(keyOf(x.couple))?.observations ?? []);
          const b = moy((x.referenceKey ? runs.get(x.referenceKey)?.observations : null) ?? []);
          return a != null && b ? a / b : null;
        }).filter((n): n is number => n != null);
        return { key: String(cand.versionId), verdicts, gains, score: ratios.length ? ratios.reduce((s, n) => s + n, 0) / ratios.length : null };
      });
      const choix = chooseCandidate(assessments);
      for (const a of assessments) {
        const cand = candidates.find((c) => String(c.versionId) === a.key)!;
        const etat = a.verdicts.includes('REFUSED') ? 'REFUSED' : a.verdicts.every((v) => v === 'ADMISSIBLE') ? (choix.chosen === a.key ? 'QUALIFIED' : 'NOT_CHOSEN') : 'INCONCLUSIVE';
        await cfg.setCandidateState(cand.versionId, etat, choix.reasons[a.key] ?? null);
        summaryCandidates.push({ versionId: cand.versionId, treatment: cand.treatment, model: cand.model, state: etat, reason: choix.reasons[a.key] ?? null, gains: a.gains });
      }
      if (choix.chosen) {
        const { activateQualifiedCandidate } = await import('../config/config-version.service');
        try {
          await activateQualifiedCandidate(Number(choix.chosen));
          result.activatedVersionId = Number(choix.chosen);
          const s = summaryCandidates.find((x) => String(x.versionId) === choix.chosen);
          if (s) s.state = 'ACTIVATED';
          log(`candidate ${choix.chosen} activée (préproduction)`);
        } catch (e) {
          const s = summaryCandidates.find((x) => String(x.versionId) === choix.chosen);
          if (s) { s.state = 'QUALIFIED'; s.activationRefused = (e as Error).message; }
          log(`activation refusée : ${(e as Error).message}`);
        }
      }
    }

    // 6. Résumé.
    result.status = 'COMPLETED';
    await repo.updateCampaign(campaignId, {
      status: 'COMPLETED', finishedAt: now(),
      summary: {
        couples: plan.map((x) => ({
          operationCode: x.couple.operationCode, model: x.couple.model, rank: x.couple.rank, role: x.role, candidateVersionId: x.candidateVersionId,
          verdict: runs.get(keyOf(x.couple))?.verdict ?? null, evidenceId: runs.get(keyOf(x.couple))?.evidenceId ?? null,
        })),
        candidates: summaryCandidates, activatedVersionId: result.activatedVersionId,
        ...(result.conformity ? { conformity: result.conformity } : {}),
        accounts: { eligible: comptes.length, locked: aVerrouiller.length - busy.length, busy: busy.length },
        dataUpdates: 'aucune : rejeu sans écriture métier (un rejeu sans attendu vérifiable n’autorise aucune mise à jour automatique)',
      },
    });
    return result;
  } catch (e) {
    result.status = 'FAILED';
    await repo.updateCampaign(campaignId, { status: 'FAILED', error: (e as Error).message.slice(0, 2000), finishedAt: now() }).catch(() => undefined);
    throw e;
  } finally {
    await repo.releaseAccounts(campaignId).catch(() => undefined);
  }
}
