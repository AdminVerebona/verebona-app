/**
 * Lot 99B — MISE EN CONFORMITÉ AUTOMATIQUE DES PROMPTS IA (préproduction),
 * avec garantie de non-régression.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE ABSOLUE : la continuité fonctionnelle prime sur l'autocorrection. Une
 * incompatibilité non résolue vaut mieux qu'une activation non démontrée.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Un PASSAGE (`runPromptConformityPass`), sous bail partagé :
 *   1. DÉTECTION — chaque contrat du registre (`contracts.ts`) est vérifié sur
 *      le prompt EFFECTIF de son traitement (même résolution que la
 *      passerelle) : absent, obsolète, incomplet ou incompatible. Une ligne
 *      par incompatibilité, occurrences regroupées. Nature du défaut : PROMPT
 *      (texte), CODE (bloc officiel absent, correction officielle non
 *      compatible, propagation), DATA (contrat présent, constats persistants
 *      faute de preuve).
 *   2. CONTRÔLE POST-ACTIVATION des corrections activées (fenêtre de
 *      surveillance) : anomalie imputable au prompt (sorties refusées par le
 *      schéma, en hausse) → RETOUR ARRIÈRE automatique à la version
 *      précédente, candidate SUSPENDUE ; fin de fenêtre sans anomalie →
 *      RÉSOLUE.
 *   3. CORRECTION de la première incompatibilité actionnable (ordre conseillé
 *      du guide, un prompt à la fois, prérequis satisfaits) :
 *        · candidate créée à partir de la version ACTIVE réelle, bloc officiel
 *          du guide inséré à son ancre, reste du texte inchangé, diff ;
 *        · vérification de compatibilité effective ;
 *        · révision de prompt (origine `auto_conformity`) figée dans une
 *          candidate AUTOMATIQUE de configuration IA (86A) — non active ;
 *        · campagne CONFORMITY : ancienne version ↔ candidate, mêmes cas,
 *          toutes les opérations du prompt (`non-regression.ts`) ;
 *        · QUALIFIÉE et préproduction et mode `auto` → activation (mécanisme
 *          existant), journal avant / après, invalidation des caches,
 *          rattrapage des traitements bloqués, contrôle post-activation ;
 *        · sinon : candidate conservée NON active, diagnostic explicite.
 *   Un essai bloqué, en échec ou annulé n'est JAMAIS rejoué sur un contexte
 *   inchangé (empreinte : version active, bloc officiel, corpus, seuils,
 *   modèles) ; seul un nouvel essai demandé par un administrateur passe outre.
 *
 * Production : détection + candidate + diagnostic, jamais de campagne ni
 * d'activation (garde d'environnement stricte, en plus de celles de 86A).
 * Coupure : `AI_PROMPT_CONFORMITY=off` (rien), `detect` (diagnostic seul),
 * `candidate` (diagnostic + candidate, sans test ni activation), `auto`.
 * Claude (le développeur) ne modifie jamais un texte de prompt : le système
 * n'insère que les blocs officiels du guide, vérifiés par les tests du guide.
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import { getAiEnvironment, type AiEnvironment } from '../config/environment';
import type { Treatment } from '../config/treatments';
import type { MasterExecutionConfig } from '../master-prompts/structured-context';
import { promptContracts, type ContractCheck, type PromptContract, type PromptUnderCheck } from './contracts';
import { applyCorrection, verifyCandidate } from './correct';
import type { GuideBlock } from './guide-blocks';
import * as store from './repository';

/** Version du moteur de mise en conformité (entre dans l'empreinte d'un essai). */
export const CONFORMITY_ENGINE_VERSION = 'conformite-prompts-v1';

export type ConformityMode = 'off' | 'detect' | 'candidate' | 'auto';

/**
 * Mode effectif (pur). Défaut : `auto` en préproduction, `candidate` en
 * production (jamais d'activation), `detect` en local. La production ne
 * dépasse JAMAIS `candidate`, quelle que soit la variable.
 */
export function conformityMode(env: AiEnvironment, vars: Record<string, string | undefined> = process.env): { mode: ConformityMode; activationAllowed: boolean; note: string } {
  const brut = (vars.AI_PROMPT_CONFORMITY ?? '').trim().toLowerCase();
  const voulu: ConformityMode = (['off', 'detect', 'candidate', 'auto'] as const).find((m) => m === brut)
    ?? (env === 'preprod' ? 'auto' : env === 'production' ? 'candidate' : 'detect');
  const mode: ConformityMode = env === 'production' && voulu === 'auto' ? 'candidate' : voulu;
  const activationAllowed = mode === 'auto' && env === 'preprod';
  const note = mode === 'off' ? 'mise en conformité coupée (AI_PROMPT_CONFORMITY=off)'
    : env === 'production' ? 'production : candidate et diagnostic seulement, jamais d’activation automatique'
      : mode === 'auto' && !activationAllowed ? `environnement ${env} : activation automatique réservée à la préproduction`
        : mode === 'detect' ? 'diagnostic seulement (AI_PROMPT_CONFORMITY=detect)'
          : mode === 'candidate' ? 'candidate et diagnostic, sans test ni activation (AI_PROMPT_CONFORMITY=candidate)'
            : 'automatique (préproduction)';
  return { mode, activationAllowed, note };
}

/** Liste blanche facultative des contrats traités (`AI_PROMPT_CONFORMITY_CONTRACTS=a,b`). Pur. */
export function contractAllowlist(vars: Record<string, string | undefined> = process.env): Set<string> | null {
  const l = (vars.AI_PROMPT_CONFORMITY_CONTRACTS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return l.length ? new Set(l) : null;
}

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
/** Fenêtre de surveillance après activation (heures). */
const watchHours = () => num(process.env.AI_PROMPT_CONFORMITY_WATCH_HOURS, 24);
/** Nombre maximal de corrections tentées par passage (chacune lance une campagne). */
const maxPerPass = () => num(process.env.AI_PROMPT_CONFORMITY_MAX_PER_PASS, 1);

export interface PassDeps {
  now?: () => Date;
  environment?: AiEnvironment;
  /** Dépendances de la campagne 86A (tests : fournisseur simulé, point de restauration, comptes). */
  campaign?: import('../qualification/campaign').CampaignDeps;
  /** Pas de bail partagé (tests appelant le passage directement). */
  skipLease?: boolean;
  log?: (m: string) => void;
}

export interface PassReport {
  disabled?: string;
  mode: ConformityMode;
  environment: AiEnvironment;
  detected: Array<{ contractId: string; state: string; status: string }>;
  resolved: string[];
  processed: Array<{ contractId: string; status: string; decision: string | null }>;
  postChecks: Array<{ contractId: string; outcome: string }>;
  note: string;
}

type Row = Record<string, unknown>;
const q = async (text: string, params: unknown[] = []): Promise<Row[]> => (await pgClient.unsafe(text, params as never[])) as unknown as Row[];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const normText = (t: string) => t.replace(/\r\n?/g, '\n');

// ══════════════════════════════════════════════════════════════════════════
// Prompts effectifs
// ══════════════════════════════════════════════════════════════════════════

interface TreatmentPrompt extends PromptUnderCheck {
  treatment: Treatment;
  masterPromptCode: string;
  /** Version BO active (null : texte initial — configuration ou fichier). */
  versionId: number | null;
  sha256: string;
  readError: string | null;
}

async function effectivePrompts(env: AiEnvironment, treatments: readonly Treatment[]): Promise<Map<Treatment, TreatmentPrompt>> {
  const [{ masterPromptForTreatment }, { AI_OPERATIONS }, { effectivePromptOf }, { readMasterFileFromRepo }, repo] = await Promise.all([
    import('../config/prompt-architecture'), import('../registry/operations'), import('../master-prompts/effective-prompt'),
    import('../governance/master-corpus/cases'), import('../master-prompts/master-prompt.repository'),
  ]);
  const out = new Map<Treatment, TreatmentPrompt>();
  for (const t of treatments) {
    const code = masterPromptForTreatment(t)!.masterPromptCode;
    let reference: string | null = null;
    try { reference = readMasterFileFromRepo(code); } catch { /* fichier absent */ }
    const op = Object.values(AI_OPERATIONS).find((o) => o.active && o.provider !== 'none' && o.masterPromptCode === code);
    const actif = await repo.getActive(env, t).catch(() => null);
    try {
      const e = await effectivePromptOf(op!.operationCode);
      out.set(t, { treatment: t, masterPromptCode: code, text: normText(e.text), execution: e.execution, referenceText: reference, versionId: actif?.id ?? null, sha256: sha(normText(e.text)), readError: null });
    } catch (e) {
      out.set(t, {
        treatment: t, masterPromptCode: code, text: '', execution: { mode: 'LEGACY_TEMPLATE', inputContractVersion: null, outputContractVersion: null, allowedTasks: null },
        referenceText: reference, versionId: actif?.id ?? null, sha256: '', readError: (e as Error).message,
      });
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// Passage
// ══════════════════════════════════════════════════════════════════════════

export async function runPromptConformityPass(p: { trigger: string }, deps: PassDeps = {}): Promise<PassReport> {
  const env = deps.environment ?? getAiEnvironment();
  const m = conformityMode(env);
  const report: PassReport = { mode: m.mode, environment: env, detected: [], resolved: [], processed: [], postChecks: [], note: m.note };
  if (m.mode === 'off') return { ...report, disabled: m.note };
  if (!(await store.conformityTablesReady())) return { ...report, disabled: 'migration 0860 absente : mise en conformité des prompts inactive' };
  const travail = () => pass(p.trigger, env, m, deps, report);
  if (deps.skipLease) return travail();
  const { withJobLock } = await import('@/lib/job-lock');
  const r = await withJobLock(`ai-prompt-conformity:${env}`, 3 * 3_600_000, travail);
  return r ?? { ...report, note: 'passage déjà en cours sur une autre instance' };
}

async function pass(trigger: string, env: AiEnvironment, m: ReturnType<typeof conformityMode>, deps: PassDeps, report: PassReport): Promise<PassReport> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const allow = contractAllowlist();
  const all = await promptContracts();
  const contracts = all.filter((c) => !allow || allow.has(c.id));
  const prompts = await effectivePrompts(env, [...new Set(all.map((c) => c.treatment))]);

  // 1. Détection (tous les contrats sont vérifiés : prérequis ; seuls ceux de la liste blanche sont suivis).
  const checks = new Map<string, ContractCheck>();
  for (const c of all) {
    const pr = prompts.get(c.treatment)!;
    const chk: ContractCheck = pr.readError
      ? { state: 'INCOMPATIBLE', cause: `Prompt ${c.treatment} effectif illisible : ${pr.readError}`, missing: [] }
      : await c.check(pr).catch((e) => ({ state: 'INCOMPATIBLE' as const, cause: `Contrôle du contrat en erreur : ${(e as Error).message}`, missing: [] }));
    checks.set(c.id, chk);
  }
  for (const c of contracts) {
    const pr = prompts.get(c.treatment)!;
    const chk = checks.get(c.id)!;
    const existant = await store.getIssueByContract(env, c.id);
    if (chk.state === 'SATISFIED') {
      if (existant && !['RESOLVED', 'ACTIVATED'].includes(existant.status)) {
        await store.transition(existant, 'RESOLVED', { kind: 'RESOLVED', message: `Contrat ${c.id} satisfait par le prompt ${c.treatment} actif.` }, { resolvedAt: now(), defect: 'NONE' });
        report.resolved.push(c.id);
      }
      continue;
    }
    const plan = pr.readError ? null : await c.plan(pr).catch(() => null);
    const fault: store.FaultKind = pr.readError || (plan && !plan.ok && plan.code === 'BLOCK_UNAVAILABLE') ? 'CODE' : 'PROMPT';
    const { issue, created, reopened } = await store.upsertDetection({
      environment: env, contractId: c.id, treatment: c.treatment, masterPromptCode: c.masterPromptCode, defect: chk.state as store.Defect,
      faultKind: fault, cause: chk.cause, impact: c.impact, trigger, activePromptVersionId: pr.versionId, activePromptSha256: pr.sha256 || null, now: now(),
    });
    if (created || reopened) await store.addEvent(issue, { kind: 'DETECTED', statusAfter: issue.status, message: `${created ? 'Incompatibilité détectée' : 'Incompatibilité réapparue'} : ${chk.cause}`, payload: { trigger, missing: chk.missing, state: chk.state, promptVersionId: pr.versionId } });
    let suivi = issue;
    // Socle (aucun bloc officiel) : surveillé, jamais corrigé automatiquement — bloqué avec diagnostic explicite.
    if (c.rank === 0 && issue.status === 'DETECTED') {
      const motif = plan && !plan.ok ? plan.message : 'aucune correction automatique sûre';
      suivi = await store.transition(issue, 'BLOCKED', { kind: 'CORRECTION_REFUSED', message: motif }, { refusalReasons: [motif], decision: `Pas de correction automatique : ${motif}` });
    }
    report.detected.push({ contractId: c.id, state: chk.state, status: suivi.status });
  }

  // 1 bis. Essai interrompu (processus arrêté au milieu) : remis en détection, sans compter comme un échec.
  for (const i of (await store.listIssues(env)).filter((x) => ['CORRECTING', 'TESTING'].includes(x.status) && now().getTime() - Date.parse(x.updatedAt) > 3.5 * 3_600_000)) {
    await store.transition(i, 'DETECTED', { kind: 'INTERRUPTED', message: 'Essai interrompu (aucun signe de vie) : aucune activation, nouvel essai au passage suivant.' }, { contextFingerprint: null });
  }

  // 2. Contrôle post-activation des corrections activées.
  for (const issue of (await store.listIssues(env)).filter((i) => i.status === 'ACTIVATED')) {
    const c = all.find((x) => x.id === issue.contractId);
    if (!c) continue;
    const outcome = await postActivationCheck(issue, c, env, now(), log);
    report.postChecks.push({ contractId: c.id, outcome });
  }

  // 3. Corrections.
  if (m.mode === 'detect') return report;
  const issues = await store.listIssues(env);
  const occupe = new Set(issues.filter((i) => ['CORRECTING', 'TESTING', 'ACTIVATED'].includes(i.status)).map((i) => i.treatment));
  let faits = 0;
  for (const c of contracts.filter((x) => x.rank > 0)) {
    if (faits >= maxPerPass()) break;
    const issue = issues.find((i) => i.contractId === c.id);
    if (!issue || issue.status === 'RESOLVED' || issue.status === 'ACTIVATED' || occupe.has(c.treatment)) continue;
    const prerequis = c.requires.filter((r) => checks.has(r) ? checks.get(r)!.state !== 'SATISFIED' : false);
    if (prerequis.length) {
      if (issue.decision !== `En attente du contrat ${prerequis.join(', ')}.`) await store.updateIssue(issue.id, { decision: `En attente du contrat ${prerequis.join(', ')}.` });
      continue;
    }
    const r = await correctIssue(issue, c, all, prompts.get(c.treatment)!, env, m, deps, now, log);
    if (r === 'SKIPPED_UNCHANGED') continue;
    occupe.add(c.treatment);
    faits += 1;
    const apres = (await store.getIssue(issue.id))!;
    report.processed.push({ contractId: c.id, status: apres.status, decision: apres.decision });
  }
  return report;
}

// ══════════════════════════════════════════════════════════════════════════
// Correction, qualification, activation
// ══════════════════════════════════════════════════════════════════════════

/** Empreinte du contexte d'un essai : un essai non abouti n'est jamais rejoué sans changement. */
async function contextFingerprint(c: PromptContract, base: { text: string; execution: MasterExecutionConfig }, blocks: readonly GuideBlock[], env: AiEnvironment): Promise<string> {
  const [{ qualificationCorpus }, { readMasterFileFromRepo }, { QUALIFICATION_THRESHOLDS }, cfg] = await Promise.all([
    import('../qualification/cases'), import('../governance/master-corpus/cases'), import('../qualification/thresholds'), import('../config/config-version.repository'),
  ]);
  const corpus = (await qualificationCorpus(readMasterFileFromRepo)).filter((x) => x.masterPromptCode === c.masterPromptCode)
    .map((x) => ({ id: x.id, file: x.file, expected: x.expected, role: x.qualificationRole ?? null, contract: x.outputContract ?? null }))
    .sort((a, b) => `${a.file}#${a.id}`.localeCompare(`${b.file}#${b.id}`));
  const active = await cfg.getActiveVersion(env).catch(() => null);
  const entry = active?.entries.find((e) => e.treatment === c.treatment) ?? null;
  return sha(JSON.stringify({
    engine: CONFORMITY_ENGINE_VERSION, contract: c.id, text: sha(normText(base.text)), execution: base.execution,
    blocks: blocks.map((b) => b.sha256), corpus: sha(JSON.stringify(corpus)), thresholds: QUALIFICATION_THRESHOLDS.version,
    chain: entry ? [entry.primaryModel, entry.fallback1, entry.fallback2, entry.reasoningPrimary] : null,
  }));
}

const FINAL_UNCHANGED: readonly store.IssueStatus[] = ['BLOCKED', 'FAILED', 'ROLLED_BACK'];

async function correctIssue(
  issue0: store.IssueRow, c: PromptContract, all: readonly PromptContract[], effective: TreatmentPrompt, env: AiEnvironment,
  m: ReturnType<typeof conformityMode>, deps: PassDeps, now: () => Date, log: (s: string) => void,
): Promise<'DONE' | 'SKIPPED_UNCHANGED'> {
  let issue = issue0;
  const svc = await import('../master-prompts/master-prompt.service');
  const repo = await import('../master-prompts/master-prompt.repository');
  const cfg = await import('../config/config-version.repository');

  // a. Point de départ : la version ACTIVE réelle (créée v1 depuis le texte en service si besoin).
  let active: import('../master-prompts/master-prompt.repository').MasterPromptVersionRow;
  try {
    active = await svc.ensureActivePromptVersion(c.treatment, env);
  } catch (e) {
    const fp = sha(`unavailable|${(e as Error).message}`);
    if (FINAL_UNCHANGED.includes(issue.status) && issue.contextFingerprint === fp && !issue.retryRequestedAt) return 'SKIPPED_UNCHANGED';
    await store.transition(issue, 'BLOCKED', { kind: 'CORRECTION_REFUSED', message: `Version active du prompt ${c.treatment} illisible : ${(e as Error).message}` }, { faultKind: 'CODE', contextFingerprint: fp, decision: 'Correction impossible : version active illisible.' });
    return 'DONE';
  }
  const base = { text: normText(active.content), execution: svc.executionOfVersion(active) ?? { mode: 'LEGACY_TEMPLATE' as const, inputContractVersion: null, outputContractVersion: null, allowedTasks: null } };
  const pr: PromptUnderCheck = { text: base.text, execution: base.execution, referenceText: effective.referenceText };
  const plan = await c.plan(pr);
  const blocs = plan.ok ? plan.steps.flatMap((s) => (s.kind === 'block' ? [s.block] : [])) : [];
  const fp = await contextFingerprint(c, base, blocs, env);
  if (FINAL_UNCHANGED.includes(issue.status) && issue.contextFingerprint === fp && !issue.retryRequestedAt) return 'SKIPPED_UNCHANGED';
  const relance = issue.retryRequestedAt ? { retryRequestedAt: null, retryRequestedBy: null } : {};
  issue = await store.transition(issue, 'CORRECTING', { kind: 'CORRECTION_STARTED', message: `Correction à partir de la version active v${active.versionNumber} du prompt ${c.treatment}.`, payload: { activeVersionId: active.id, activeSha256: active.contentSha256, fingerprint: fp } },
    { contextFingerprint: fp, activePromptVersionId: active.id, activePromptSha256: active.contentSha256, refusalReasons: [], ...relance });

  // b. Effectif ≠ version active (propagation) : défaut du code, jamais corrigé à l'aveugle.
  const surActive = await c.check(pr);
  if (surActive.state === 'SATISFIED') {
    await store.transition(issue, 'FAILED', { kind: 'CORRECTION_REFUSED', message: `La version active v${active.versionNumber} porte déjà le contrat, mais le prompt effectif non : défaut de propagation (cache, configuration épinglée).` },
      { faultKind: 'CODE', decision: 'Aucune correction : le texte actif est conforme, le prompt effectif ne l’est pas (défaut du code).' });
    return 'DONE';
  }
  if (!plan.ok) {
    await store.transition(issue, 'BLOCKED', { kind: 'CORRECTION_REFUSED', message: plan.message, payload: { code: plan.code } },
      { faultKind: plan.code === 'BLOCK_UNAVAILABLE' ? 'CODE' : 'PROMPT', refusalReasons: [plan.message], decision: `Pas de correction automatique (${plan.code}) : ${plan.message}` });
    return 'DONE';
  }

  // c. Correction minimale déterministe + diff.
  const autres = all.filter((x) => x.id !== c.id && x.treatment === c.treatment).flatMap((x) => x.markers);
  const corr = applyCorrection({ text: base.text, execution: base.execution, steps: plan.steps, protectedMarkers: autres });
  if (!corr.ok) {
    const message = corr.code === 'ANCHOR_NOT_FOUND' || corr.code === 'ANCHOR_AMBIGUOUS'
      ? `Ancre introuvable ou ambiguë dans le texte actif : ${corr.message}` : corr.message;
    await store.transition(issue, 'BLOCKED', { kind: 'CORRECTION_REFUSED', message, payload: { code: corr.code, steps: corr.steps } },
      { faultKind: 'PROMPT', refusalReasons: [message], decision: `Pas de correction automatique : texte actif trop divergent (${corr.code}).`, correction: { code: corr.code, steps: corr.steps } });
    return 'DONE';
  }
  const verif = await verifyCandidate({ treatment: c.treatment, contract: c, contracts: all, before: base, after: { text: corr.text, execution: corr.execution }, referenceText: effective.referenceText, insertedBlocks: blocs });
  const correction = {
    basedOnVersionId: active.id, basedOnVersionNumber: active.versionNumber, steps: corr.steps,
    diff: { added: corr.diff.added, removed: corr.diff.removed, unified: corr.diff.unified.slice(0, 60_000) },
    executionBefore: base.execution, executionAfter: corr.execution, verification: verif,
  };
  if (verif.length) {
    await store.transition(issue, 'FAILED', { kind: 'VERIFICATION_FAILED', message: `Correction officielle non compatible : ${verif.map((v) => v.message).join(' ')}`.slice(0, 1500), payload: { verification: verif } },
      { faultKind: 'CODE', correction, refusalReasons: verif.map((v) => v.message), decision: 'Aucune activation : la révision corrigée échoue à la vérification de compatibilité (défaut du code ou du bloc officiel).' });
    return 'DONE';
  }

  // d. Révision de prompt candidate + candidate de configuration (86A), non actives.
  const activeCfg = await cfg.getActiveVersion(env).catch(() => null);
  if (!activeCfg) {
    await store.transition(issue, 'BLOCKED', { kind: 'CORRECTION_REFUSED', message: 'Aucune configuration IA active : une candidate ne peut pas être préparée ni comparée.' },
      { faultKind: 'CODE', correction, decision: 'Pas de candidate : aucune configuration IA active dans cet environnement.' });
    return 'DONE';
  }
  const version = await repo.insertConformityCandidateVersion({
    environment: env, treatment: c.treatment, masterPromptCode: active.masterPromptCode, content: corr.text, basedOnId: active.id,
    execution: svc.executionOfVersion(active) === null ? null : corr.execution,
  });
  const ref = { versionId: version.id, versionNumber: version.versionNumber, masterPromptCode: version.masterPromptCode, contentSha256: version.contentSha256, content: version.content, execution: version.execution ?? null };
  const key = sha(`${CONFORMITY_ENGINE_VERSION}|${c.id}|${version.contentSha256}|${JSON.stringify(ref.execution)}|${activeCfg.currentRevisionId ?? activeCfg.id}`);
  const reason = `Mise en conformité automatique : contrat ${c.id} (${c.label}) — prompt ${c.treatment} v${active.versionNumber} → v${version.versionNumber}, bloc officiel du guide (étape ${c.guideStep ?? '—'}).`;
  const deja = await cfg.findCandidateByKey(env, key);
  const candidate = deja && ['CREATED', 'QUALIFYING', 'QUALIFIED', 'INCONCLUSIVE'].includes(String(deja.state)) ? await cfg.getVersion(deja.id) : await cfg.createVersion({
    userId: null, environment: env, label: `Conformité ${c.treatment} · ${c.id}`.slice(0, 200), description: reason.slice(0, 1000), source: { active: true },
    candidate: { key, reason, campaignId: null, transform: (s) => ({ ...s, masterPrompts: { ...s.masterPrompts, [c.treatment]: ref } }) },
  });
  issue = await store.updateIssue(issue.id, { candidatePromptVersionId: version.id, candidateConfigVersionId: candidate!.id, correction });
  await store.addEvent(issue, {
    kind: 'CANDIDATE_CREATED', message: `Candidate préparée : prompt ${c.treatment} v${version.versionNumber} (à partir de v${active.versionNumber}), configuration candidate v${candidate!.visibleNumber ?? candidate!.id} non active. +${corr.diff.added} / −${corr.diff.removed} ligne(s).`,
    payload: { promptVersionId: version.id, configVersionId: candidate!.id, diff: correction.diff, steps: corr.steps },
  });
  log(`${c.id} : candidate v${version.versionNumber} (configuration ${candidate!.id})`);

  if (m.mode === 'candidate' || env === 'production') {
    await store.transition(issue, 'BLOCKED', { kind: 'ACTIVATION_REFUSED', message: `${m.note} : candidate préparée et diagnostiquée, aucune campagne ni activation.` },
      { decision: `${env === 'production' ? 'Production' : 'Mode candidate'} : candidate préparée, non active — qualification et activation en préproduction seulement.` });
    return 'DONE';
  }

  // e. Non-régression : campagne CONFORMITY (préproduction).
  issue = await store.transition(issue, 'TESTING', { kind: 'QUALIFICATION_STARTED', message: `Qualification de non-régression de toutes les opérations de ${c.treatment} (ancienne version ↔ candidate, mêmes cas).` });
  const { requestConformityCampaign } = await import('../qualification/campaign');
  // Branches absentes de l'ancienne version ET de la candidate : fonction inactive des deux côtés (capacité « en
  // attente »), aucun appel de production possible — hors périmètre, signalées (jamais comptées comme réussies).
  const [{ inspectMasterTemplate }, { AI_OPERATIONS }] = await Promise.all([import('../prompts/prompt-loader'), import('../registry/operations')]);
  const avantB = inspectMasterTemplate(base.text).branches;
  const apresB = inspectMasterTemplate(corr.text).branches;
  const excludedOperations = Object.values(AI_OPERATIONS)
    .filter((o) => o.active && o.masterPromptCode === c.masterPromptCode && o.task && !avantB.includes(o.task) && !apresB.includes(o.task))
    .map((o) => ({ operationCode: o.operationCode, reason: `branche ${o.task} absente de l’ancienne version et de la candidate : fonction inactive des deux côtés, hors périmètre de la comparaison` }));
  // Cas qui exercent un contrat ABSENT des deux versions (étape suivante du guide pas encore faite) : ils citent
  // l'identifiant du contrat dans leurs variables de production (même convention que la couverture) — hors
  // périmètre, retirés avant exécution : jamais comptés réussis, jamais bloquants.
  const excludedCases: Array<{ contractId: string; reason: string; matches(q: { variables: Record<string, unknown>; operationCode: string }): boolean }> = [];
  for (const k of all.filter((x) => x.treatment === c.treatment && x.rank > 0 && x.id !== c.id)) {
    const ctxAvant = { text: base.text, execution: base.execution, referenceText: effective.referenceText };
    const ctxApres = { text: corr.text, execution: corr.execution, referenceText: effective.referenceText };
    if ((await k.check(ctxAvant)).state === 'SATISFIED' || (await k.check(ctxApres)).state === 'SATISFIED') continue;
    excludedCases.push({
      contractId: k.id, reason: `contrat ${k.id} absent de l’ancienne version et de la candidate (fonction inactive des deux côtés)`,
      matches: (q) => JSON.stringify(q.variables ?? {}).includes(k.version),
    });
  }
  let camp: Awaited<ReturnType<typeof requestConformityCampaign>>;
  try {
    camp = await requestConformityCampaign({ treatment: c.treatment, candidateVersionId: candidate!.id, contractId: c.id, reason, coverage: c.coverage, excludedOperations, excludedCases }, deps.campaign ?? {});
  } catch (e) {
    await store.transition(issue, 'FAILED', { kind: 'QUALIFICATION_RESULT', message: `Campagne en échec : ${(e as Error).message}`.slice(0, 1500) },
      { faultKind: 'CODE', refusalReasons: [(e as Error).message.slice(0, 500)], decision: 'Aucune activation : campagne de qualification en échec technique.' });
    return 'DONE';
  }
  const a = camp.assessment;
  const qualification = {
    campaignId: camp.campaignId, campaignStatus: camp.status, refusal: camp.refusal, decision: a?.decision ?? null,
    coverage: a?.coverage ?? null, refusalReasons: a?.refusalReasons ?? [], blockingReasons: a?.blockingReasons ?? [], excluded: a?.excluded ?? excludedOperations, excludedCases: a?.excludedCases ?? [],
    operations: (a?.operations ?? []).map((o) => ({
      operationCode: o.operationCode, referenceVerdict: o.referenceVerdict, candidateVerdict: o.candidateVerdict, decision: o.decision, cases: o.cases,
      regressions: o.regressions.map((x) => x.caseId), improvements: o.improvements.map((x) => x.caseId),
      inconclusive: o.inconclusive.map((x) => `${x.caseId} : ${x.inconclusive ?? 'non exécuté'}`).slice(0, 10),
      defects: o.defects.map((x) => `${x.caseId} : ${x.defects.join(' ; ')}`).slice(0, 10), cost: o.cost, reasons: o.reasons,
    })),
  };
  issue = await store.updateIssue(issue.id, { campaignId: camp.campaignId, qualification });
  if (!a || camp.status !== 'COMPLETED') {
    const motif = camp.refusal ?? `campagne ${camp.status}`;
    await store.transition(issue, 'BLOCKED', { kind: 'QUALIFICATION_RESULT', message: `Qualification non concluante : ${motif}`, payload: { campaignId: camp.campaignId } },
      { refusalReasons: [motif], decision: `Activation refusée : qualification non concluante (${motif}).` });
    return 'DONE';
  }
  if (a.decision !== 'QUALIFIED') {
    const motifs = [...a.refusalReasons, ...a.blockingReasons];
    await store.transition(issue, a.decision === 'REFUSED' ? 'FAILED' : 'BLOCKED', {
      kind: 'QUALIFICATION_RESULT', message: `${a.decision === 'REFUSED' ? 'Régression ou erreur constatée' : 'Non concluant'} : ${motifs.slice(0, 6).join(' · ')}`.slice(0, 1800),
      payload: { campaignId: camp.campaignId, decision: a.decision },
    }, {
      refusalReasons: motifs.slice(0, 50),
      decision: a.decision === 'REFUSED'
        ? 'Activation refusée : la candidate dégrade un résultat ou viole un critère éliminatoire. L’ancienne version reste active.'
        : 'Activation refusée : non-régression non démontrée (cas non concluant ou couverture insuffisante). L’ancienne version reste active.',
    });
    return 'DONE';
  }
  if (!m.activationAllowed) {
    await store.transition(issue, 'BLOCKED', { kind: 'ACTIVATION_REFUSED', message: `Candidate qualifiée, activation automatique non autorisée : ${m.note}.` },
      { decision: `Candidate qualifiée, non activée (${m.note}).` });
    return 'DONE';
  }

  // f. Activation (préproduction seulement : garde ici ET dans activateQualifiedCandidate).
  const { activateQualifiedCandidate } = await import('../config/config-version.service');
  let previousId: number | null = null;
  try {
    const r = await activateQualifiedCandidate(candidate!.id, { summary: `Mise en conformité automatique ${c.id} : ${c.treatment} v${active.versionNumber} → v${version.versionNumber}` });
    previousId = r.previousId;
  } catch (e) {
    await store.transition(issue, 'BLOCKED', { kind: 'ACTIVATION_REFUSED', message: `Activation refusée par les contrôles de configuration : ${(e as Error).message}`.slice(0, 1500) },
      { refusalReasons: [(e as Error).message.slice(0, 500)], decision: 'Candidate qualifiée mais activation refusée par les contrôles techniques : l’ancienne version reste active.' });
    return 'DONE';
  }
  const caches = await invalidateAll();
  const t = now();
  issue = await store.transition(issue, 'ACTIVATED', {
    kind: 'ACTIVATED',
    message: `Activée en préproduction : prompt ${c.treatment} v${active.versionNumber} → v${version.versionNumber} (configuration ${previousId ?? '—'} → ${candidate!.id}). Caches invalidés : ${caches.join(', ')}.`,
    payload: { before: { promptVersionId: active.id, configVersionId: previousId }, after: { promptVersionId: version.id, configVersionId: candidate!.id }, campaignId: camp.campaignId, caches },
  }, {
    previousConfigVersionId: previousId, activatedAt: t, watchUntil: new Date(t.getTime() + watchHours() * 3_600_000), rolledBackAt: null, resolvedAt: null,
    decision: 'Activée automatiquement en préproduction après qualification concluante sans régression.', faultKind: 'PROMPT',
  });

  // g. Rattrapage des traitements bloqués, puis contrôle post-activation immédiat.
  if (c.anomaly) {
    const catchup = await catchUp(c, t, log).catch((e) => ({ error: (e as Error).message }));
    issue = await store.updateIssue(issue.id, { catchup: catchup as Record<string, unknown> });
    await store.addEvent(issue, { kind: 'CATCHUP', message: `Rattrapage : ${JSON.stringify((catchup as { summary?: unknown }).summary ?? catchup).slice(0, 600)}`, payload: catchup as Record<string, unknown> });
  }
  await postActivationCheck(issue, c, env, now(), log);
  return 'DONE';
}

async function invalidateAll(): Promise<string[]> {
  const [{ invalidateCapabilityCaches }, { invalidateConfigCache }, { invalidateConfigVersionCache }] = await Promise.all([
    import('./caches'), import('../config/config-resolver'), import('../telemetry/execution-context'),
  ]);
  invalidateConfigCache();
  invalidateConfigVersionCache();
  return ['configuration', 'version tracée', ...(await invalidateCapabilityCaches())];
}

// ══════════════════════════════════════════════════════════════════════════
// Rattrapage et contrôle post-activation
// ══════════════════════════════════════════════════════════════════════════

const OUVERTS = ['FINDING', 'REPAIR_PENDING', 'REPAIR_SUPPRESSED', 'REPAIR_INEFFECTIVE'];

async function openFindings(c: PromptContract): Promise<Array<{ accountId: number; checkId: string; objectId: number }>> {
  if (!c.anomaly) return [];
  try {
    return (await q(`SELECT account_id, check_id, object_id FROM coherence_object_proofs
                      WHERE check_id = ANY($1::text[]) AND last_result = ANY($2::text[]) AND finding->>'anomaly' = $3 ORDER BY account_id, object_id`,
    [c.anomaly.checkIds, OUVERTS, c.anomaly.anomaly])).map((r) => ({ accountId: Number(r.account_id), checkId: String(r.check_id), objectId: Number(r.object_id) }));
  } catch {
    return [];
  }
}

/**
 * Rattrapage après activation : les objets en constat lié au contrat
 * (ex. MISSING_PROPERTY_ARBITRATION_PENDING) et les objets jamais contrôlés
 * reçoivent un contrôle ciblé immédiat — mécanisme 91B existant (règles de
 * cohérence, comptes éligibles, idempotence, anti-boucle). Résultats réels
 * relevés : décisions écrites (avec preuve) et abstentions (avec cause).
 */
async function catchUp(c: PromptContract, since: Date, log: (s: string) => void): Promise<Record<string, unknown>> {
  const orch = await import('@/services/coherence/orchestrator');
  const avant = await openFindings(c);
  const demandes = await q(
    `UPDATE coherence_object_proofs SET requested_at = $4::timestamptz, request_reason = $5
      WHERE check_id = ANY($1::text[]) AND last_result = ANY($2::text[]) AND finding->>'anomaly' = $3
      RETURNING account_id, check_id, object_id`,
    [c.anomaly!.checkIds, OUVERTS, c.anomaly!.anomaly, new Date(since.getTime() - 86_400_000).toISOString(), `PROMPT_CONFORMITY:${c.id}`.slice(0, 120)]).catch(() => [] as Row[]);
  const jamais = await orch.requestCatchupChecks({ apply: true, checkIds: c.anomaly!.checkIds, limit: 2_000 });
  const controles = await orch.runTargetedChecks({ deadline: Date.now() + 15 * 60_000 });
  const apres = await openFindings(c);
  const objets = avant.map((o) => `${o.checkId}:${o.objectId}`);
  let decisions: Row[] = [];
  try {
    decisions = await q(
      `SELECT account_id, object_type, object_id, field_key, decision, cause, value_after IS NOT NULL AS written, array_length(evidence_ids, 1) AS proofs
         FROM property_recovery_decisions WHERE created_at >= $1::timestamptz ORDER BY id`, [since.toISOString()]);
  } catch { /* table absente : contrat sans reprise de propriétés */ }
  const summary = {
    objectsInFinding: avant.length, requested: demandes.length, neverControlled: jamais.requested, controlled: controles.processed,
    /** Propriétés écrites avec preuve / laissées vides avec une abstention justifiée (cause). */
    written: decisions.filter((d) => d.decision === 'WRITTEN').length,
    abstained: decisions.filter((d) => d.decision === 'ABSTAINED').length,
    /** Objets rattrapés : au moins une propriété écrite, ou seulement des abstentions justifiées. */
    objectsWithWrite: new Set(decisions.filter((d) => d.decision === 'WRITTEN').map((d) => `${d.object_type}:${d.object_id}`)).size,
    objectsAbstainedOnly: new Set(decisions.map((d) => `${d.object_type}:${d.object_id}`)).size
      - new Set(decisions.filter((d) => d.decision === 'WRITTEN').map((d) => `${d.object_type}:${d.object_id}`)).size,
    residualFindings: apres.length,
  };
  log(`rattrapage ${c.id} : ${JSON.stringify(summary)}`);
  return {
    summary, objects: objets.slice(0, 200), residual: apres.slice(0, 200),
    decisions: decisions.slice(0, 200).map((d) => ({
      accountId: Number(d.account_id), objectType: String(d.object_type), objectId: Number(d.object_id), field: String(d.field_key),
      decision: String(d.decision), cause: d.cause == null ? null : String(d.cause), written: Boolean(d.written), proofs: Number(d.proofs ?? 0),
    })),
  };
}

/** Sorties refusées par le schéma (hors appels de qualification) pour les opérations du contrat, sur une période. */
async function invalidOutputs(operations: readonly string[], from: Date, to: Date): Promise<{ total: number; invalid: number }> {
  try {
    const [r] = await q(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status <> 'success' AND error_code = 'INVALID_OUTPUT')::int AS invalid
         FROM ai_usage_event
        WHERE operation_code = ANY($1::text[]) AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
          AND COALESCE(metadata->>'trigger', '') <> 'qualification'`,
      [operations, from.toISOString(), to.toISOString()]);
    return { total: Number(r?.total ?? 0), invalid: Number(r?.invalid ?? 0) };
  } catch {
    return { total: 0, invalid: 0 };
  }
}

/**
 * Contrôle des résultats réels après activation. Anomalie IMPUTABLE AU PROMPT
 * (sorties refusées par le schéma depuis l'activation, à un taux supérieur à
 * celui d'avant) → retour arrière automatique et candidate suspendue.
 * Version remplacée entre-temps par un administrateur → respectée, aucun
 * nouvel essai sur ce contexte. Fenêtre écoulée sans anomalie → résolue.
 */
async function postActivationCheck(issue0: store.IssueRow, c: PromptContract, env: AiEnvironment, now: Date, log: (s: string) => void): Promise<string> {
  let issue = issue0;
  const repo = await import('../master-prompts/master-prompt.repository');
  const actif = await repo.getActive(env, c.treatment).catch(() => null);
  if (!actif || actif.id !== issue.candidatePromptVersionId) {
    await store.transition(issue, 'BLOCKED', { kind: 'POST_CHECK', message: `La version active du prompt ${c.treatment} a été remplacée (v${actif?.versionNumber ?? '—'}) : choix de l’administrateur respecté, aucun nouvel essai automatique sur ce contexte.` },
      { decision: 'Correction remplacée manuellement : pas de nouvel essai automatique tant que le contexte ne change pas.' });
    return 'REPLACED';
  }
  const depuis = issue.activatedAt ? new Date(issue.activatedAt) : now;
  const duree = Math.max(60_000, now.getTime() - depuis.getTime());
  const apres = await invalidOutputs(c.operations, depuis, new Date(now.getTime() + 1000));
  const avant = await invalidOutputs(c.operations, new Date(depuis.getTime() - Math.max(duree, 7 * 86_400_000)), depuis);
  const tauxAvant = avant.total ? avant.invalid / avant.total : 0;
  const tauxApres = apres.total ? apres.invalid / apres.total : 0;
  const residuels = await openFindings(c);
  const postCheck = { at: now.toISOString(), after: apres, before: avant, residualFindings: residuels.length };
  if (apres.invalid > 0 && tauxApres > tauxAvant) {
    log(`${c.id} : anomalie après activation (${apres.invalid}/${apres.total} sorties refusées) → retour arrière`);
    await rollback(issue, c, env, now, `${apres.invalid} sortie(s) refusée(s) par le schéma sur ${apres.total} appel(s) depuis l’activation (avant : ${avant.invalid}/${avant.total})`, postCheck);
    return 'ROLLED_BACK';
  }
  issue = await store.updateIssue(issue.id, { postCheck });
  if (issue.watchUntil && now.getTime() >= new Date(issue.watchUntil).getTime()) {
    const data = residuels.length > 0;
    await store.transition(issue, 'RESOLVED', {
      kind: 'RESOLVED', message: `Fenêtre de surveillance écoulée sans anomalie imputable au prompt.${data ? ` ${residuels.length} constat(s) restant(s) : insuffisance de données (abstentions justifiées ou sources absentes), pas un défaut du prompt.` : ''}`,
      payload: postCheck,
    }, { resolvedAt: now, faultKind: data ? 'DATA' : 'NONE', defect: 'NONE' });
    return 'RESOLVED';
  }
  return 'OK';
}

/**
 * Retour arrière automatique : configuration précédente réactivée si la
 * candidate est toujours la configuration active (état exact d'avant),
 * sinon seul le prompt du traitement revient à sa version précédente (un
 * autre changement fait entre-temps est conservé). Candidate SUSPENDUE,
 * diagnostics et résultats des tests conservés, empreinte gardée : aucun
 * nouvel essai sur ce contexte.
 */
async function rollback(issue: store.IssueRow, c: PromptContract, env: AiEnvironment, now: Date, motif: string, postCheck: Record<string, unknown>): Promise<void> {
  const cfg = await import('../config/config-version.repository');
  const active = await cfg.getActiveVersion(env).catch(() => null);
  let methode = '';
  try {
    if (active && active.id === issue.candidateConfigVersionId && issue.previousConfigVersionId) {
      const r = await cfg.activateVersion(issue.previousConfigVersionId, null, undefined, { summary: `Retour arrière automatique ${c.id} : ${motif}`.slice(0, 300) });
      const { afterCommit } = await import('../config/config-version.service');
      await afterCommit(`rollback-conformity:${issue.previousConfigVersionId}`, r.masterPromptSwitches);
      methode = `configuration ${issue.previousConfigVersionId} réactivée`;
    } else if (issue.activePromptVersionId) {
      const repo = await import('../master-prompts/master-prompt.repository');
      const r = await repo.switchActivePrompt({
        environment: env, treatment: c.treatment, targetId: issue.activePromptVersionId, action: 'rollback', userId: null as unknown as number, userEmail: null,
        testSummary: `Retour arrière automatique (mise en conformité ${c.id}) : ${motif}`.slice(0, 500),
      }, {
        before: async (sql) => { await cfg.lockEnvironment(sql, env); },
        after: async (sql, current) => { await cfg.recordMasterPromptRevisionInTx(sql, env, { userId: null as unknown as number, comment: `Prompt maître ${c.treatment} v${current.versionNumber} réactivé (retour arrière automatique)` }); },
      });
      if ('refused' in r) throw new Error(`réactivation refusée (${r.refused})`);
      const { afterCommit } = await import('../config/config-version.service');
      await afterCommit(`rollback-conformity-prompt:${c.treatment}`, [{ treatment: c.treatment, versionNumber: r.current.versionNumber, masterPromptCode: r.current.masterPromptCode }]);
      methode = `prompt ${c.treatment} v${r.current.versionNumber} réactivé`;
    } else {
      throw new Error('aucune version précédente connue');
    }
  } catch (e) {
    await store.transition(issue, 'FAILED', { kind: 'ROLLBACK_FAILED', message: `Retour arrière automatique impossible (${(e as Error).message}) : intervention manuelle requise (BO › Prompts maîtres › Réactiver).`, payload: postCheck },
      { postCheck, decision: `Anomalie après activation (${motif}) et retour arrière impossible : réactiver la version précédente à la main.` });
    return;
  }
  if (issue.candidateConfigVersionId) await cfg.suspendCandidate(issue.candidateConfigVersionId, `Retour arrière automatique : ${motif}`);
  const caches = await invalidateAll();
  await store.transition(issue, 'ROLLED_BACK', {
    kind: 'ROLLED_BACK', message: `Retour arrière automatique (${methode}) : ${motif}. Candidate suspendue ; caches invalidés (${caches.join(', ')}).`,
    payload: { ...postCheck, method: methode },
  }, { postCheck, rolledBackAt: now, decision: `Retour arrière automatique : ${motif}. Pas de nouvel essai tant que le contexte ne change pas.`, refusalReasons: [motif] });
}

// ══════════════════════════════════════════════════════════════════════════
// Administration (BO)
// ══════════════════════════════════════════════════════════════════════════

/** « Nouvel essai » demandé par un administrateur : lève la garde d'empreinte au prochain passage. */
export async function requestRetry(issueId: number, adminUserId: number): Promise<store.IssueRow> {
  const i = await store.getIssue(issueId);
  if (!i) throw Object.assign(new Error('Incompatibilité introuvable.'), { status: 404 });
  if (!['BLOCKED', 'FAILED', 'ROLLED_BACK', 'DETECTED'].includes(i.status)) throw Object.assign(new Error(`Statut ${i.status} : aucun nouvel essai possible.`), { status: 409 });
  const r = await store.updateIssue(i.id, { retryRequestedBy: adminUserId, retryRequestedAt: new Date() });
  await store.addEvent(i, { kind: 'RETRY_REQUESTED', message: 'Nouvel essai demandé par un administrateur (la garde d’empreinte est levée pour le prochain passage).', payload: { adminUserId } });
  return r;
}

const STATUS_LABELS: Record<store.IssueStatus, string> = {
  DETECTED: 'détectée', CORRECTING: 'correction en cours', TESTING: 'tests', BLOCKED: 'bloquée', ACTIVATED: 'activée',
  FAILED: 'échec', ROLLED_BACK: 'retour arrière', RESOLVED: 'résolue',
};
const FAULT_LABELS: Record<store.FaultKind, string> = { PROMPT: 'défaut de prompt', CODE: 'défaut du code', DATA: 'insuffisance de données', NONE: '—' };

/** Vue Configuration IA › Conformité des prompts. */
export async function conformityOverview(environment: AiEnvironment = getAiEnvironment()) {
  const m = conformityMode(environment);
  const contracts = await promptContracts();
  const issues = await store.listIssues(environment);
  const prompts = await effectivePrompts(environment, [...new Set(contracts.map((c) => c.treatment))]).catch(() => new Map<Treatment, TreatmentPrompt>());
  const registre = [];
  for (const c of contracts) {
    const pr = prompts.get(c.treatment);
    const chk = pr && !pr.readError ? await c.check(pr).catch(() => null) : null;
    registre.push({
      id: c.id, treatment: c.treatment, label: c.label, lot: c.lot, guideStep: c.guideStep, rank: c.rank, version: c.version, task: c.task,
      operations: c.operations, inputs: c.inputs, outputs: c.outputs, capabilities: c.capabilities, markers: c.markers, validations: c.validations,
      requires: c.requires, blockIds: c.blockIds, expectedExecution: c.expectedExecution, killSwitch: c.killSwitch, autoCorrectable: c.rank > 0,
      state: chk?.state ?? 'UNKNOWN', cause: chk?.cause ?? (pr?.readError ?? null),
    });
  }
  const vues = [];
  for (const i of issues) {
    vues.push({
      ...i, statusLabel: STATUS_LABELS[i.status], faultLabel: FAULT_LABELS[i.faultKind],
      contract: registre.find((r) => r.id === i.contractId) ?? null,
      events: (await store.listEvents(i.id, 20)).map((e) => ({ kind: e.kind, message: e.message, at: e.createdAt, statusAfter: e.statusAfter })),
    });
  }
  return { readAt: new Date().toISOString(), environment, mode: m.mode, note: m.note, activationAllowed: m.activationAllowed, registry: registre, issues: vues };
}
