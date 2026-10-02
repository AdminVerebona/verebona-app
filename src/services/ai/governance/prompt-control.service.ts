/**
 * Prompt Control (T5) — CDC BO IA SCR-06, WF-20, WF-39, T5-001 à T5-015.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE DEMANDE, ET T5 CHOISIT LUI-MÊME LES PROMPTS À FAIRE ÉVOLUER
 *
 * L'administrateur décrit un comportement attendu ou un problème constaté,
 * sans désigner de traitement. T5 lit les prompts administrables (T1, socle
 * T2, T3, T4, charte de voix T6), détermine lesquels sont en cause — aucun, un ou
 * plusieurs — et, sur demande de modification, les réécrit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX MODES, UN GESTE CHACUN — SCR-06, T5-005, T5-006, écart E-01
 *
 * · `analyze` : diagnostic seul, sur n'importe quelle version. Rien n'est
 *   écrit, aucun Brouillon créé.
 * · `modify`  : chaque prompt réécrit est écrit DIRECTEMENT dans le
 *   Brouillon, puis résumés et diffs sont rendus.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INTERDITS TENUS PAR LE SERVEUR, PAS PAR LE PROMPT
 *
 * · T5-002 — une cible T5 (ou inconnue) rendue par le modèle est écartée ;
 * · T5-003 — seul le socle commun de T2 est dans la configuration ;
 * · T5-004 — une modification s'écrit dans un Brouillon, jamais ailleurs ;
 * · T5-007 — plusieurs Brouillons sans contexte : T5 ne choisit pas ;
 * · T5-011 — verdict autre que « prompt » : rien n'est écrit ;
 * · T5-015 — IA bloquée : T5 n'opère pas ;
 * · T5-001 — seul le prompt change : modèles, replis et garde-fous restent.
 * · T5-009 — journaux lus SEULEMENT sur demande (`includeLogs`), en synthèse
 *   bornée (répartition des erreurs, indicateurs), jamais en masse ;
 * · T5-010 — comparaison avec une autre version (Active, À tester, anciennes,
 *   Brouillons) sur demande (`compareWithVersionId`) : diff déterministe rendu
 *   avec la réponse, et transmis au modèle pour l'analyse.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL MOTEUR : LE PROMPT MAÎTRE T5 (CDC 15 §27, lot 16b)
 *
 * T5 s'exécute par `t5_analyze` / `t5_modify` (`t5_master_v1`, fichier du
 * dépôt, jamais administrable). Les opérations d'étapes historiques
 * (`analyze_instruction`, `control_prompts`, `propose_change`) et leurs
 * prompts sont retirés : il n'y a plus d'architecture `steps` pour T5.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { AiGateway } from '../gateway/ai-gateway';
import { computeDiff, type DiffSummary } from './diff.service';
import { T5_TARGETS, type Treatment } from '../config/treatments';
import {
  getVersion, getActiveVersion, listVersions, createDraft, savePromptFieldIfUnchanged,
} from '../config/config-version.repository';
import type { ConfigVersionWithEntries } from '../config/config-types';
import { recordT5Modification } from './prompt-control.audit';
import { diffVersions, renderDiff, type ConfigDiff } from '../config/config-diff.service';
import { promptArchitectureOf, masterPromptOf, type TreatmentConfig } from '../config/config-types';
import { masterPromptForTreatment, checkMasterProposal } from '../config/prompt-architecture';
import { TREATMENT_DEFINITIONS } from '../config/treatments';
import { loadMasterTemplate, inspectMasterTemplate } from '../prompts/prompt-loader';
import { T5AnalyzeOutput, T5ModifyOutput, type T5MasterOutput } from './master/t5-contract';

/**
 * Verdicts. `mixed` (CDC 15 §27 R1) : plusieurs chantiers ; comme tout
 * verdict autre que « prompt », il n'écrit RIEN (T5-02, T5-011).
 */
export const VERDICTS = ['prompt', 'code', 'donnees', 'configuration', 'mixed'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const T5_MODES = ['analyze', 'modify'] as const;
export type T5Mode = (typeof T5_MODES)[number];

/** Libellé de chaque prompt, tel que T5 et l'écran le présentent. */
export const TARGET_LABELS: Record<string, string> = {
  T1: 'T1 — Sources (prompt maître)',
  T2: 'T2 — Assistant (socle commun)',
  T3: 'T3 — Rationalisation',
  T4: 'T4 — Échéances',
  // CDC Mascotte BO-008 : T5 fait évoluer le prompt maître de T6 (charte de
  // voix comprise, T6-009), jamais les règles du moteur, qui sont dans le code.
  T6: 'T6 — Mascotte (prompt maître)',
};

/** Forme interne de la sortie du master T5, ramenée à ce que `interpret` lit. */
interface PromptControlOut {
  verdict: Verdict;
  analysis: string;
  targets: Array<{ treatment: string; reason: string; proposedContent: string | null }>;
  risks: string[];
  recommendations: string[];
  requiredCodeChanges?: string[];
  requiredSchemaChanges?: string[];
  requiredTests?: string[];
}

export interface T5Change {
  treatment: Treatment;
  label: string;
  reason: string;
  /**
   * Zone lue et réécrite : `prompt` (préambule des étapes) ou `masterPrompt`
   * (texte master COMPLET, branches comprises — traitement en `master`).
   */
  field?: 'prompt' | 'masterPrompt';
  diff: DiffSummary | null;
  /** Écrit dans le Brouillon. */
  applied: boolean;
  /** Raison pour laquelle cette cible n'a pas été écrite. */
  rejected?: string;
}

export interface T5Result {
  mode: T5Mode;
  verdict: Verdict;
  analysis: string;
  changes: T5Change[];
  risks: string[];
  recommendations: string[];
  /** Au moins un prompt écrit dans le Brouillon. */
  applied: boolean;
  draftId: number | null;
  draftCreated: boolean;
  traceId: string;
  /** T5-010 : comparaison demandée — version de référence et diff déterministe. */
  comparison?: { versionId: number; label: string; status: string; diff: ConfigDiff } | null;
  /** T5-009 : synthèse des journaux effectivement transmise à T5 (sur demande). */
  logsDigest?: string | null;
  /** §27 R6 : changements de code et de schéma requis (master T5). */
  requiredCodeChanges?: string[];
  requiredSchemaChanges?: string[];
  /** §27 R8 : tests minimums à ajouter au corpus. */
  requiredTests?: string[];
  /** Architecture de T5 qui a produit la réponse (toujours le master depuis le lot 16b). */
  architecture?: 'master';
}

/** Contexte complémentaire demandé par l'administrateur (T5-009, T5-010). */
export interface T5Options {
  compareWithVersionId?: number;
  includeLogs?: boolean;
  /** Traitement dont lire les journaux ; absent : T1 à T4. */
  logsTreatment?: Treatment;
  /** Fenêtre des journaux, 1 à 30 jours (7 par défaut). */
  logsDays?: number;
}

const MAX_CONTEXT_CHARS = 12_000;

function versionLabel(v: ConfigVersionWithEntries): string {
  return v.visibleNumber ? `v${v.visibleNumber}${v.label ? ` — ${v.label}` : ''}` : (v.label ?? `Brouillon ${v.id}`);
}

/**
 * T5-010 : diff entre la version analysée et une autre version du même
 * environnement. `base` = version de comparaison, `candidate` = version
 * affichée : le diff se lit « ce que la version affichée change ».
 */
export async function buildComparison(
  version: ConfigVersionWithEntries, otherId: number,
): Promise<{ versionId: number; label: string; status: string; diff: ConfigDiff; text: string }> {
  const other = await loadVersion(otherId);
  if (other.environment !== version.environment) {
    throw new T5Refused('VERSION_NOT_FOUND', `La version ${otherId} n'appartient pas au même environnement.`);
  }
  const diff = diffVersions(other.entries, version.entries);
  const text = `Comparaison demandée : version affichée (${versionLabel(version)}, ${version.status}) `
    + `par rapport à ${versionLabel(other)} (${other.status}).\n`
    + (diff.identical ? 'Aucune différence.' : renderDiff(diff));
  return { versionId: other.id, label: versionLabel(other), status: other.status, diff, text: text.slice(0, MAX_CONTEXT_CHARS) };
}

/**
 * T5-009 : synthèse BORNÉE des journaux, sur demande seulement — erreurs les
 * plus fréquentes et indicateurs du traitement. Aucun contenu utilisateur.
 */
export async function buildLogsDigest(treatment: Treatment | undefined, days: number): Promise<string> {
  const d = Math.min(Math.max(Math.round(days), 1), 30);
  const [{ getErrorBreakdown }, { getTreatmentMetrics }] = await Promise.all([
    import('../telemetry/execution-log.repository'),
    import('../config/treatment-metrics.repository'),
  ]);
  const cibles: Treatment[] = treatment ? [treatment] : ['T1', 'T2', 'T3', 'T4'];
  const erreurs = (await getErrorBreakdown(d))
    .filter((e) => e.treatment && cibles.includes(e.treatment))
    .slice(0, 15)
    .map((e) => `· ${e.treatment} ${e.errorCode ?? 'erreur'} — ${e.model ?? 'modèle ?'} : ${e.count} fois (dernière ${e.lastSeen.toISOString().slice(0, 10)})`);
  const indicateurs: string[] = [];
  for (const t of cibles) {
    const m = await getTreatmentMetrics(t, d);
    indicateurs.push(`${t} : ` + m.metrics
      .filter((x) => x.value !== null)
      .slice(0, 12)
      .map((x) => `${x.label} = ${x.value}${x.unit === 'percent' ? ' %' : ''}`)
      .join(' ; '));
  }
  return [
    `Journaux des ${d} derniers jours (synthèse, sur demande de l'administrateur) :`,
    'Erreurs les plus fréquentes :', ...(erreurs.length ? erreurs : ['· aucune']),
    'Indicateurs :', ...indicateurs,
  ].join('\n').slice(0, MAX_CONTEXT_CHARS);
}

async function extraContext(version: ConfigVersionWithEntries | null, o: T5Options): Promise<{
  text: string; comparison: T5Result['comparison']; logsDigest: string | null;
}> {
  const parts: string[] = [];
  let comparison: T5Result['comparison'] = null;
  let logsDigest: string | null = null;
  if (o.compareWithVersionId && version) {
    const c = await buildComparison(version, o.compareWithVersionId);
    comparison = { versionId: c.versionId, label: c.label, status: c.status, diff: c.diff };
    parts.push(c.text);
  }
  if (o.includeLogs) {
    logsDigest = await buildLogsDigest(o.logsTreatment, o.logsDays ?? 7);
    parts.push(logsDigest);
  }
  return { text: parts.length ? parts.join('\n\n') : '(aucun)', comparison, logsDigest };
}

export interface DraftChoice { id: number; label: string | null; isStale: boolean; createdAt: string }

export class T5Refused extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'T5Refused';
  }
}

// ── Contrôles préalables ────────────────────────────────────────────────────

/** T5-015 — T5 n'opère pas si l'IA globale est bloquée. */
export async function assertAiAvailable(): Promise<void> {
  let active = false;
  let reason: string | null = null;
  try {
    const { getEmergencyStop } = await import('../queue/job-queue.repository');
    ({ active, reason } = await getEmergencyStop());
  } catch {
    return;
  }
  if (active) {
    throw new T5Refused(
      'AI_BLOCKED',
      "L'arrêt d'urgence IA est engagé : Prompt Control est indisponible (T5-015)."
      + (reason ? ` Motif : ${reason}.` : ''),
    );
  }

  // T5-015 (suite) : T5 désactivé ou suspendu est lui aussi indisponible.
  // L'arrêt d'urgence seul était vérifié. La garde de la passerelle le
  // refuserait de toute façon, mais seulement APRÈS le chargement de la
  // version : refuser ici donne un message clair, sans travail inutile.
  const { isTreatmentRunnable } = await import('../queue/runnable-guard');
  if (!(await isTreatmentRunnable('T5'))) {
    throw new T5Refused(
      'AI_BLOCKED',
      'Prompt Control (T5) est désactivé ou suspendu : réactivez-le depuis la configuration IA (T5-015).',
    );
  }
}

async function loadVersion(versionId: number): Promise<ConfigVersionWithEntries> {
  const version = await getVersion(versionId);
  if (!version) throw new T5Refused('VERSION_NOT_FOUND', `Version ${versionId} introuvable.`);
  return version;
}

function promptOf(version: ConfigVersionWithEntries | null, t: Treatment): string {
  return version?.entries.find((e) => e.treatment === t)?.prompt ?? '';
}

/**
 * Texte ADMINISTRABLE d'une cible, selon l'architecture de sa ligne
 * (lot 16, CDC 15 §29.1, MP-16) :
 *   · `steps`  : le préambule (`prompt`) — comportement historique inchangé ;
 *   · `master` : le texte master COMPLET (`masterPrompt`, ou le fichier du
 *     dépôt, sa valeur initiale D-03), avec ses branches TASK/MODE. T5 le lit
 *     et le réécrit en entier ; il ne le traite jamais comme un préambule.
 */
export interface TargetText {
  treatment: Treatment;
  field: 'prompt' | 'masterPrompt';
  text: string;
  masterPromptCode: string | null;
  branches: string[];
  discriminant: string | null;
  /** Texte master vide dans la version : fichier du dépôt présenté. */
  fromFile: boolean;
}

export async function targetTexts(version: ConfigVersionWithEntries | null): Promise<Map<Treatment, TargetText>> {
  const out = new Map<Treatment, TargetText>();
  for (const t of T5_TARGETS) {
    const entry = version?.entries.find((e) => e.treatment === t) as TreatmentConfig | undefined;
    const master = masterPromptForTreatment(t);
    if (entry && master && promptArchitectureOf(entry) === 'master') {
      const configured = masterPromptOf(entry);
      const text = configured ?? await loadMasterTemplate(master.masterPromptCode, TREATMENT_DEFINITIONS[t].useCaseCode);
      out.set(t, {
        treatment: t, field: 'masterPrompt', text, masterPromptCode: master.masterPromptCode,
        branches: master.tasks, discriminant: inspectMasterTemplate(text).discriminant, fromFile: configured === null,
      });
    } else {
      out.set(t, {
        treatment: t, field: 'prompt', text: entry?.prompt ?? '', masterPromptCode: null, branches: [], discriminant: null, fromFile: false,
      });
    }
  }
  return out;
}

/** Les prompts administrables (T1–T4, T6), présentés au modèle. */
export function formatCurrentPrompts(
  version: ConfigVersionWithEntries | null,
  texts?: Map<Treatment, TargetText>,
): string {
  return T5_TARGETS.map((t) => {
    const x = texts?.get(t);
    if (x && x.field === 'masterPrompt') {
      return `──── ${TARGET_LABELS[t].replace(/ \(.*\)$/, '')} — PROMPT MAÎTRE ${x.masterPromptCode} `
        + `(branches ${x.discriminant ?? 'TASK'} : ${x.branches.join(', ')}) — à réécrire EN ENTIER ────\n${x.text.trim()}`;
    }
    const content = (x?.text ?? promptOf(version, t)).trim();
    return `──── ${TARGET_LABELS[t]} ────\n${content || '(vide)'}`;
  }).join('\n\n');
}

// ── Interprétation ──────────────────────────────────────────────────────────

/**
 * Ramène la sortie du modèle à ce qui peut être écrit. Pure.
 *
 * Écarte : T5 ou tout traitement inconnu (T5-002), les doublons, et en mode
 * `modify` tout texte vide, trop court ou identique. En analyse, aucun texte
 * n'est jamais retenu.
 */
export function interpret(
  mode: T5Mode,
  d: PromptControlOut,
  current: (t: Treatment) => string,
  fieldOf: (t: Treatment) => 'prompt' | 'masterPrompt' = () => 'prompt',
): { verdict: Verdict; analysis: string; changes: Array<T5Change & { proposedContent: string | null }>; risks: string[]; recommendations: string[] } {
  const seen = new Set<string>();
  const changes: Array<T5Change & { proposedContent: string | null }> = [];

  for (const t of d.targets) {
    const treatment = t.treatment.trim().toUpperCase();
    if (!(T5_TARGETS as readonly string[]).includes(treatment) || seen.has(treatment)) continue;
    seen.add(treatment);
    const tr = treatment as Treatment;
    const field = fieldOf(tr);
    const base = { treatment: tr, label: TARGET_LABELS[tr], reason: t.reason, applied: false, field };

    if (mode === 'analyze' || d.verdict !== 'prompt') {
      changes.push({ ...base, diff: null, proposedContent: null });
      continue;
    }
    const text = t.proposedContent?.trim() ?? '';
    if (text.length < 50) {
      changes.push({ ...base, diff: null, proposedContent: null, rejected: 'Aucun texte de prompt exploitable n’a été proposé.' });
      continue;
    }
    const diff = computeDiff(current(tr), text);
    if (diff.identical) {
      changes.push({ ...base, diff, proposedContent: null, rejected: 'La proposition est identique au prompt actuel.' });
      continue;
    }
    // Traitement en `master` : la proposition est un master COMPLET — même
    // discriminant, une section par branche, emplacements identiques à ceux
    // du code (§22, §29.1). Sinon elle n'est pas écrite.
    if (field === 'masterPrompt') {
      const anomalies = checkMasterProposal(tr, text);
      if (anomalies.length) {
        changes.push({ ...base, diff, proposedContent: null, rejected: `Prompt maître proposé incomplet : ${anomalies.join(' ; ')}.` });
        continue;
      }
    }
    changes.push({ ...base, diff, proposedContent: text });
  }

  return { verdict: d.verdict, analysis: d.analysis, changes, risks: d.risks, recommendations: d.recommendations };
}

async function callModel(
  mode: T5Mode, version: ConfigVersionWithEntries | null, instruction: string, accountId: number, userId: number,
  extra = '(aucun)', texts?: Map<Treatment, TargetText>,
): Promise<{ output: PromptControlOut; traceId: string; architecture: 'master' }> {
  // T5 = t5_master_v1 seul (fichier du dépôt, jamais administrable).
  const res = await AiGateway.execute<T5MasterOutput>({
    useCaseCode: 'AI_GOVERNANCE',
    operationCode: mode === 'analyze' ? 't5_analyze' : 't5_modify',
    accountId,
    userId,
    promptVariables: {
      CURRENT_MASTER_PROMPTS: formatCurrentPrompts(version, texts),
      // T5-009 / T5-010 : le contexte demandé suit la demande, délimité —
      // le §27 n'a pas d'emplacement dédié.
      INSTRUCTION: extra && extra !== '(aucun)'
        ? `${instruction}\n\nContexte complémentaire demandé par l'administrateur :\n${extra}`
        : instruction,
    },
    outputSchema: (mode === 'analyze' ? T5AnalyzeOutput : T5ModifyOutput) as never,
  });
  const o = res.data;
  return {
    output: {
      verdict: o.verdict, analysis: o.analysis, targets: o.targets, risks: o.risks,
      recommendations: o.configurationRecommendations,
      requiredCodeChanges: o.requiredCodeChanges, requiredSchemaChanges: o.requiredSchemaChanges, requiredTests: o.requiredTests,
    },
    traceId: res.traceId,
    architecture: 'master',
  };
}

/** Champs §27 transmis au résultat. */
function extras(o: PromptControlOut, architecture: 'master') {
  return {
    requiredCodeChanges: o.requiredCodeChanges ?? [], requiredSchemaChanges: o.requiredSchemaChanges ?? [],
    requiredTests: o.requiredTests ?? [], architecture,
  };
}

// ── Analyse ─────────────────────────────────────────────────────────────────

export async function analyze(
  versionId: number, instruction: string, accountId: number, userId: number, options: T5Options = {},
): Promise<T5Result> {
  await assertAiAvailable();
  const version = await loadVersion(versionId);
  const extra = await extraContext(version, options);
  const texts = await targetTexts(version);
  const { output, traceId, architecture } = await callModel('analyze', version, instruction, accountId, userId, extra.text, texts);
  const r = interpret('analyze', output, (t) => texts.get(t)?.text ?? '', (t) => texts.get(t)?.field ?? 'prompt');
  return {
    mode: 'analyze', ...r, ...extras(output, architecture),
    changes: r.changes.map(({ proposedContent: _p, ...c }) => c),
    applied: false, draftId: null, draftCreated: false, traceId,
    comparison: extra.comparison, logsDigest: extra.logsDigest,
  };
}

// ── Modification ────────────────────────────────────────────────────────────

type WriteTarget =
  | { kind: 'existing'; draft: ConfigVersionWithEntries }
  | { kind: 'create'; base: ConfigVersionWithEntries | null };

/**
 * Brouillon dans lequel écrire (T5-004, T5-007) :
 * version affichée au statut Brouillon → elle ; création demandée → nouveau
 * Brouillon depuis l'Active ; aucun Brouillon → création ; sinon refus avec
 * la liste, même pour un seul Brouillon existant.
 */
export async function resolveWriteTarget(versionId: number, createNewDraft: boolean): Promise<WriteTarget> {
  const version = await loadVersion(versionId);
  if (version.status === 'DRAFT') return { kind: 'existing', draft: version };

  const base = await getActiveVersion(version.environment);
  if (createNewDraft) return { kind: 'create', base };

  const drafts = (await listVersions(version.environment)).filter((v) => v.status === 'DRAFT');
  if (drafts.length === 0) return { kind: 'create', base };

  const choices: DraftChoice[] = drafts.map((d) => ({
    id: d.id, label: d.label, isStale: d.isStale, createdAt: d.createdAt.toISOString(),
  }));
  throw new T5Refused(
    'DRAFT_SELECTION_REQUIRED',
    `La version affichée est en lecture seule et ${drafts.length} brouillon(s) existe(nt) déjà : `
    + 'ouvrez celui dans lequel écrire, ou créez-en un nouveau depuis l’Active. '
    + 'Prompt Control ne choisit pas à votre place (T5-007).',
    { drafts: choices },
  );
}

export interface ModifyRequest {
  versionId: number;
  instruction: string;
  createDraft?: boolean;
  accountId: number;
  userId: number;
  options?: T5Options;
}

export async function modify(req: ModifyRequest): Promise<T5Result> {
  await assertAiAvailable();
  const target = await resolveWriteTarget(req.versionId, Boolean(req.createDraft));
  const source = target.kind === 'existing' ? target.draft : target.base;

  const extra = await extraContext(source, req.options ?? {});
  const texts = await targetTexts(source);
  const { output, traceId, architecture } = await callModel('modify', source, req.instruction, req.accountId, req.userId, extra.text, texts);
  const r = interpret('modify', output, (t) => texts.get(t)?.text ?? '', (t) => texts.get(t)?.field ?? 'prompt');
  const writable = r.changes.filter((c) => c.proposedContent);

  const result: T5Result = {
    mode: 'modify', verdict: r.verdict, analysis: r.analysis, risks: r.risks, recommendations: r.recommendations,
    ...extras(output, architecture),
    changes: r.changes.map(({ proposedContent: _p, ...c }) => c),
    applied: false, draftId: null, draftCreated: false, traceId,
    comparison: extra.comparison, logsDigest: extra.logsDigest,
  };
  if (writable.length === 0) return result;

  const draft = target.kind === 'existing' ? target.draft : await createDraft(req.userId, 'Prompt Control');

  // Relu juste avant l'écriture : un enregistrement concurrent pendant l'appel
  // modèle ne doit pas être écrasé par un texte que T5 n'a pas lu.
  const fresh = await getVersion(draft.id);
  if (!fresh || fresh.status !== 'DRAFT') {
    throw new T5Refused('NOT_A_DRAFT', `La version ${draft.id} n'est plus un brouillon modifiable : rien n'a été écrit (T5-004).`);
  }

  for (const c of writable) {
    const entry = fresh.entries.find((e) => e.treatment === c.treatment);
    const changed = result.changes.find((x) => x.treatment === c.treatment)!;
    if (!entry) { changed.rejected = `Configuration ${c.treatment} absente du brouillon.`; continue; }
    const cible = texts.get(c.treatment)!;
    const sourceEntry = source?.entries.find((e) => e.treatment === c.treatment);
    // Contrôle de concurrence sur la zone réellement lue par T5.
    const inchange = cible.field === 'masterPrompt'
      ? promptArchitectureOf(entry) === 'master' && masterPromptOf(entry) === masterPromptOf(sourceEntry)
      : entry.prompt === promptOf(source, c.treatment);
    if (!inchange) {
      changed.rejected = `Le prompt ${c.treatment} a été modifié pendant l'analyse : il n'a pas été écrasé. Relancez la demande.`;
      continue;
    }
    // Seul le prompt change (T5-001) : le préambule en `steps`, le texte
    // master complet en `master` — jamais le préambule d'un master. Écriture
    // CONDITIONNELLE (revue lot 16) : si la zone a changé depuis la lecture,
    // 0 ligne ⇒ conflit explicite, rien n'est écrasé.
    const ecrit = await savePromptFieldIfUnchanged({
      versionId: draft.id, treatment: c.treatment, field: cible.field,
      expected: cible.field === 'masterPrompt' ? masterPromptOf(sourceEntry) : promptOf(source, c.treatment),
      next: c.proposedContent!, userId: req.userId,
    });
    if (!ecrit) {
      changed.rejected = `Conflit : le prompt ${c.treatment} a été modifié (ou le brouillon validé) pendant l'analyse — rien n'a été écrasé. Relancez la demande.`;
      continue;
    }
    changed.applied = true;
    try {
      await recordT5Modification({
        adminUserId: req.userId, instruction: req.instruction, treatment: c.treatment,
        versionId: draft.id, draftCreated: target.kind === 'create',
        before: cible.text, after: c.proposedContent!, traceId, verdict: r.verdict, field: cible.field,
      });
    } catch (e) {
      console.error('[T5] Journal de modification non écrit', { traceId, versionId: draft.id, e });
    }
  }

  result.applied = result.changes.some((c) => c.applied);
  result.draftId = result.applied || target.kind === 'create' ? draft.id : null;
  result.draftCreated = target.kind === 'create';
  return result;
}
