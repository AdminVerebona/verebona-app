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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UNE NOUVELLE OPÉRATION (`control_prompts`, prompt `prompt_control_v2`)
 *
 * L'ancienne opération `analyze_instruction` lit d'abord la version ACTIVE
 * de son prompt en base (`ai_prompt_versions`), qui prime sur le fichier. Une
 * version antérieure au format « verdict » y est restée active : le modèle
 * rendait l'ancien format, la validation le refusait, et « Analyser »
 * échouait à chaque fois. Le nouveau code de prompt n'a aucune version en
 * base : c'est le fichier du dépôt qui fait foi.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { z } from 'zod';
import { AiGateway } from '../gateway/ai-gateway';
import { computeDiff, type DiffSummary } from './diff.service';
import { T5_TARGETS, type Treatment } from '../config/treatments';
import {
  getVersion, getActiveVersion, listVersions, createDraft, saveEntry,
} from '../config/config-version.repository';
import type { ConfigVersionWithEntries } from '../config/config-types';
import { recordT5Modification } from './prompt-control.audit';

export const VERDICTS = ['prompt', 'code', 'donnees', 'configuration'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const T5_MODES = ['analyze', 'modify'] as const;
export type T5Mode = (typeof T5_MODES)[number];

const MODE_PROMPT: Record<T5Mode, string> = {
  analyze: 'ANALYSE — diagnostic uniquement : `proposedContent` vaut null pour chaque cible',
  modify: 'MODIFICATION — pour chaque cible, renvoie le prompt complet réécrit',
};

/** Libellé de chaque prompt, tel que T5 et l'écran le présentent. */
export const TARGET_LABELS: Record<string, string> = {
  T1: 'T1 — Sources (prompt maître)',
  T2: 'T2 — Assistant (socle commun)',
  T3: 'T3 — Rationalisation',
  T4: 'T4 — Échéances',
  // CDC Mascotte BO-008 : T5 peut faire évoluer la charte de voix de T6, pas
  // les règles du moteur de la mascotte, qui sont dans le code.
  T6: 'T6 — Mascotte (charte de voix)',
};

/**
 * Sortie du modèle, tolérante sur la forme : une valeur hors bornes ne doit
 * pas faire échouer tout l'appel quand elle peut être ramenée à une valeur
 * sûre. Seul le contenu d'un prompt reste strict (au moins 50 caractères).
 */
const TargetOut = z.object({
  treatment: z.string(),
  reason: z.string().default('').transform((s) => s.slice(0, 1000)),
  proposedContent: z.string().nullable().default(null),
});
const PromptControlOutput = z.object({
  verdict: z.enum(VERDICTS),
  analysis: z.string().min(1).transform((s) => s.slice(0, 4000)),
  targets: z.array(TargetOut).max(8).default([]),
  risks: z.array(z.string()).default([]).transform((a) => a.slice(0, 10).map((s) => s.slice(0, 400))),
  recommendations: z.array(z.string()).default([]).transform((a) => a.slice(0, 10).map((s) => s.slice(0, 400))),
});
type PromptControlOut = z.infer<typeof PromptControlOutput>;

export interface T5Change {
  treatment: Treatment;
  label: string;
  reason: string;
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
}

async function loadVersion(versionId: number): Promise<ConfigVersionWithEntries> {
  const version = await getVersion(versionId);
  if (!version) throw new T5Refused('VERSION_NOT_FOUND', `Version ${versionId} introuvable.`);
  return version;
}

function promptOf(version: ConfigVersionWithEntries | null, t: Treatment): string {
  return version?.entries.find((e) => e.treatment === t)?.prompt ?? '';
}

/** Les prompts administrables (T1–T4, T6), présentés au modèle. */
export function formatCurrentPrompts(version: ConfigVersionWithEntries | null): string {
  return T5_TARGETS.map((t) => {
    const content = promptOf(version, t).trim();
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
): { verdict: Verdict; analysis: string; changes: Array<T5Change & { proposedContent: string | null }>; risks: string[]; recommendations: string[] } {
  const seen = new Set<string>();
  const changes: Array<T5Change & { proposedContent: string | null }> = [];

  for (const t of d.targets) {
    const treatment = t.treatment.trim().toUpperCase();
    if (!(T5_TARGETS as readonly string[]).includes(treatment) || seen.has(treatment)) continue;
    seen.add(treatment);
    const tr = treatment as Treatment;
    const base = { treatment: tr, label: TARGET_LABELS[tr], reason: t.reason, applied: false };

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
    changes.push({ ...base, diff, proposedContent: text });
  }

  return { verdict: d.verdict, analysis: d.analysis, changes, risks: d.risks, recommendations: d.recommendations };
}

async function callModel(mode: T5Mode, version: ConfigVersionWithEntries | null, instruction: string, accountId: number, userId: number) {
  const res = await AiGateway.execute({
    useCaseCode: 'AI_GOVERNANCE',
    operationCode: 'control_prompts',
    accountId,
    userId,
    promptVariables: {
      MODE: MODE_PROMPT[mode],
      CURRENT_PROMPTS: formatCurrentPrompts(version),
      INSTRUCTION: instruction,
    },
    outputSchema: PromptControlOutput,
  });
  return { output: res.data, traceId: res.traceId };
}

// ── Analyse ─────────────────────────────────────────────────────────────────

export async function analyze(versionId: number, instruction: string, accountId: number, userId: number): Promise<T5Result> {
  await assertAiAvailable();
  const version = await loadVersion(versionId);
  const { output, traceId } = await callModel('analyze', version, instruction, accountId, userId);
  const r = interpret('analyze', output, (t) => promptOf(version, t));
  return {
    mode: 'analyze', ...r,
    changes: r.changes.map(({ proposedContent: _p, ...c }) => c),
    applied: false, draftId: null, draftCreated: false, traceId,
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
}

export async function modify(req: ModifyRequest): Promise<T5Result> {
  await assertAiAvailable();
  const target = await resolveWriteTarget(req.versionId, Boolean(req.createDraft));
  const source = target.kind === 'existing' ? target.draft : target.base;

  const { output, traceId } = await callModel('modify', source, req.instruction, req.accountId, req.userId);
  const r = interpret('modify', output, (t) => promptOf(source, t));
  const writable = r.changes.filter((c) => c.proposedContent);

  const result: T5Result = {
    mode: 'modify', verdict: r.verdict, analysis: r.analysis, risks: r.risks, recommendations: r.recommendations,
    changes: r.changes.map(({ proposedContent: _p, ...c }) => c),
    applied: false, draftId: null, draftCreated: false, traceId,
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
    if (entry.prompt !== promptOf(source, c.treatment)) {
      changed.rejected = `Le prompt ${c.treatment} a été modifié pendant l'analyse : il n'a pas été écrasé. Relancez la demande.`;
      continue;
    }
    // Seul le prompt change (T5-001).
    await saveEntry(draft.id, { ...entry, prompt: c.proposedContent! }, req.userId);
    changed.applied = true;
    try {
      await recordT5Modification({
        adminUserId: req.userId, instruction: req.instruction, treatment: c.treatment,
        versionId: draft.id, draftCreated: target.kind === 'create',
        before: entry.prompt, after: c.proposedContent!, traceId, verdict: r.verdict,
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
