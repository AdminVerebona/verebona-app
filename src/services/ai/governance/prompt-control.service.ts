/**
 * Prompt Control (T5) — CDC BO IA SCR-06, WF-20, WF-39, T5-001 à T5-015.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE DEMANDE EN LANGAGE NATUREL, PAS UN PROMPT
 *
 * L'administrateur décrit un comportement attendu ou un problème constaté.
 * T5 comprend la demande, décide si le prompt est en cause et, sur demande de
 * modification, réécrit lui-même le prompt de T1, le socle commun de T2, ou le
 * prompt de T3 ou de T4. L'administrateur n'a jamais à rédiger de prompt.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX MODES, ET UN SEUL GESTE PAR MODE — SCR-06, T5-005, T5-006, écart E-01
 *
 * · `analyze` : diagnostic seul. Aucune écriture, aucun Brouillon créé, sur
 *   n'importe quelle version — y compris l'Active, qu'on veut souvent
 *   comprendre avant de la changer.
 * · `modify`  : le prompt proposé est écrit DIRECTEMENT dans le Brouillon,
 *   puis le résumé et le diff sont rendus. Pas de second bouton
 *   d'approbation : le filet de sécurité est le cycle de version (Brouillon →
 *   À tester → Active), pas une confirmation de plus.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * T5 DOIT POUVOIR DIRE « CE N'EST PAS LE PROMPT » — T5-009, T5-011, WF-39
 *
 * Un modèle à qui l'on demande une modification en produira une, d'autant plus
 * volontiers qu'il n'a pas d'autre issue. Il en a donc une : un verdict
 * explicite, et un schéma qui accepte une réponse sans proposition. Sur un
 * verdict autre que « prompt », rien n'est écrit, même en mode `modify`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INTERDITS TENUS PAR LE SERVEUR, PAS PAR LE PROMPT
 *
 * · T5-002 — T5 ne modifie jamais son propre prompt ;
 * · T5-003 — seul le socle commun de T2 est modifiable, pas ses instructions
 *   spécialisées, qui vivent dans le code et ne sont pas dans la config ;
 * · T5-004 — une modification s'écrit dans un Brouillon, jamais ailleurs ;
 * · T5-007 — plusieurs Brouillons sans contexte : T5 ne choisit pas ;
 * · T5-015 — IA bloquée : T5 n'opère pas ;
 * · T5-001 — seul le prompt change : modèles, replis et garde-fous restent.
 *
 * Un modèle à qui l'on demande de ne pas se modifier lui-même finira un jour
 * par le faire. Ces règles sont vérifiées avant toute écriture, et refusent
 * quelle que soit la sortie du modèle.
 */
import { z } from 'zod';
import { AiGateway } from '../gateway/ai-gateway';
import { computeDiff, type DiffSummary } from './diff.service';
import { isTreatment, isPromptAdministrable, type Treatment } from '../config/treatments';
import {
  getVersion, getActiveVersion, listVersions, createDraft, saveEntry,
} from '../config/config-version.repository';
import type { ConfigVersionWithEntries } from '../config/config-types';
import { recordT5Modification } from './prompt-control.audit';

/**
 * Verdict du diagnostic — SCR-06, zone « Diagnostic ».
 *
 * Les quatre causes n'appellent pas le même geste, et les confondre fait
 * chercher au mauvais endroit : retoucher un prompt quand c'est le code qui
 * cloche est le plus sûr moyen de dégrader les deux.
 */
export const VERDICTS = ['prompt', 'code', 'donnees', 'configuration'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const T5_MODES = ['analyze', 'modify'] as const;
export type T5Mode = (typeof T5_MODES)[number];

/**
 * Libellé transmis au prompt technique (`{{MODE}}`). Informatif seulement : la
 * règle « l'analyse n'écrit rien » est tenue par ce service, pas par le modèle.
 */
const MODE_PROMPT: Record<T5Mode, string> = {
  analyze: 'ANALYSE — diagnostic uniquement, ne propose aucun texte de prompt',
  modify: 'MODIFICATION — si le prompt est en cause, renvoie le prompt complet modifié',
};

/**
 * Désignation du prompt ciblé, telle que T5 la lit (`{{PROMPT_CODE}}`).
 *
 * Un code « T2 » seul ne dit rien au modèle ; il doit savoir quel traitement
 * il réécrit et, pour T2, qu'il ne tient que le socle commun (T5-003).
 */
const TARGET_PROMPT: Record<Exclude<Treatment, 'T5'>, string> = {
  T1: 'T1 — Sources : prompt maître de l’analyse des documents déposés',
  T2: 'T2 — Assistant : socle commun uniquement (les instructions spécialisées restent dans le code)',
  T3: 'T3 — Rationalisation : prompt de mise en cohérence des données du compte',
  T4: 'T4 — Échéances : prompt de détection et de suivi des échéances',
};

const T5Output = z.object({
  verdict: z.enum(VERDICTS),
  /** Résumé destiné à l'administrateur, quel que soit le verdict. */
  analysis: z.string().min(20).max(3000),
  /**
   * Prompt complet proposé — uniquement si le verdict est « prompt ».
   *
   * Nullable par conception : c'est ce qui permet au modèle de conclure que le
   * problème est ailleurs sans avoir à inventer une modification.
   */
  proposedContent: z.string().min(50).max(50_000).nullable().default(null),
  risks: z.array(z.string().max(300)).max(10).default([]),
  /** Recommandations non appliquées : modèle, repli, réglage (T5-012). */
  recommendations: z.array(z.string().max(300)).max(10).default([]),
});

type T5Output = z.infer<typeof T5Output>;

export interface T5Analysis {
  mode: T5Mode;
  treatment: Treatment;
  verdict: Verdict;
  analysis: string;
  /** Texte écrit dans le Brouillon (mode `modify` uniquement). */
  proposedContent: string | null;
  risks: string[];
  recommendations: string[];
  diff: DiffSummary | null;
  /** Raison pour laquelle aucune modification n'a été écrite, s'il y en a une. */
  rejected?: string;
  /** Vrai si le prompt a été écrit dans un Brouillon. */
  applied: boolean;
  /** Brouillon écrit (mode `modify`, `applied` vrai). */
  draftId: number | null;
  /** Le Brouillon a été créé depuis l'Active pour cette demande. */
  draftCreated: boolean;
  /** Trace de l'appel modèle, pour l'écran Exécutions & logs. */
  traceId: string;
}

export interface DraftChoice {
  id: number;
  label: string | null;
  isStale: boolean;
  createdAt: string;
}

export class T5Refused extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'T5Refused';
  }
}

// ── Contrôles préalables, avant tout appel modèle ──────────────────────────

/**
 * Cible modifiable par T5 : T1 à T4 (T5-001, T5-002).
 *
 * Vérifiée AVANT l'appel modèle : un appel est payé même quand son résultat
 * sera refusé, et aucune sortie du modèle ne peut contourner ce refus.
 */
export function assertTarget(treatment: string): Treatment {
  if (!isTreatment(treatment)) {
    throw new T5Refused('UNKNOWN_TREATMENT', `Traitement inconnu : « ${treatment} ».`);
  }
  if (!isPromptAdministrable(treatment)) {
    throw new T5Refused(
      'SELF_MODIFICATION',
      'Prompt Control ne peut pas modifier son propre comportement (T5-002) : '
      + 'il est défini dans le code. Choisissez T1, T2, T3 ou T4.',
    );
  }
  return treatment;
}

/**
 * T5-015 — T5 n'opère pas si l'IA globale est bloquée.
 *
 * L'état est lu à chaque demande. Si la table n'existe pas encore (base
 * antérieure à l'arrêt d'urgence), il n'y a pas d'arrêt à respecter.
 */
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

// ── Interprétation de la sortie du modèle ──────────────────────────────────

/**
 * Ramène la sortie du modèle à ce qui peut être écrit.
 *
 * Pure : aucune écriture. `proposedContent` n'est conservé que lorsqu'il est
 * réellement applicable — c'est la condition d'écriture en mode `modify`.
 */
export function interpret(
  mode: T5Mode,
  d: T5Output,
  currentContent: string,
): Pick<T5Analysis, 'verdict' | 'analysis' | 'proposedContent' | 'risks' | 'recommendations' | 'diff' | 'rejected'> {
  const base = {
    verdict: d.verdict,
    analysis: d.analysis,
    risks: d.risks,
    recommendations: d.recommendations,
  };

  // Analyse seule : jamais de texte à appliquer, quoi que le modèle ait rendu
  // (T5-006). Le mode `modify` existe pour cela.
  if (mode === 'analyze') return { ...base, proposedContent: null, diff: null };

  // Verdict autre que « prompt » : T5-011, on n'écrit rien, même si le modèle a
  // proposé un texte.
  if (d.verdict !== 'prompt') {
    return {
      ...base, proposedContent: null, diff: null,
      rejected: "Le prompt n'est pas en cause : aucune modification n'a été écrite.",
    };
  }

  // Verdict « prompt » sans proposition : le modèle s'est contredit. On ne
  // devine pas ce qu'il voulait dire — on le rend visible.
  if (!d.proposedContent) {
    return {
      ...base, proposedContent: null, diff: null,
      rejected: 'Le diagnostic conclut au prompt mais ne propose aucun texte : reformulez la demande.',
    };
  }

  const diff = computeDiff(currentContent, d.proposedContent);
  if (diff.identical) {
    return {
      ...base, proposedContent: null, diff,
      rejected: 'La proposition est identique au prompt actuel : rien à écrire.',
    };
  }

  return { ...base, proposedContent: d.proposedContent, diff };
}

async function callModel(
  mode: T5Mode,
  treatment: Treatment,
  currentContent: string,
  instruction: string,
  accountId: number,
  userId: number,
): Promise<{ output: T5Output; traceId: string }> {
  const res = await AiGateway.execute({
    useCaseCode: 'AI_GOVERNANCE',
    operationCode: 'analyze_instruction',
    accountId,
    userId,
    promptVariables: {
      PROMPT_CODE: TARGET_PROMPT[treatment as Exclude<Treatment, 'T5'>] ?? treatment,
      CURRENT_CONTENT: currentContent,
      INSTRUCTION: instruction,
      MODE: MODE_PROMPT[mode],
    },
    outputSchema: T5Output,
  });
  return { output: res.data, traceId: res.traceId };
}

// ── Analyse ─────────────────────────────────────────────────────────────────

/**
 * Analyse une demande en langage naturel, sans rien modifier (T5-006).
 *
 * Possible sur toute version, y compris l'Active : comprendre ce qui tourne
 * est le premier usage de T5, et n'engage aucune écriture.
 */
export async function analyze(
  versionId: number,
  treatment: string,
  instruction: string,
  accountId: number,
  userId: number,
): Promise<T5Analysis> {
  const cible = assertTarget(treatment);
  await assertAiAvailable();
  const version = await loadVersion(versionId);
  const actuel = promptOf(version, cible);

  const { output, traceId } = await callModel('analyze', cible, actuel, instruction, accountId, userId);
  return {
    mode: 'analyze',
    treatment: cible,
    ...interpret('analyze', output, actuel),
    applied: false,
    draftId: null,
    draftCreated: false,
    traceId,
  };
}

// ── Modification ────────────────────────────────────────────────────────────

type WriteTarget =
  | { kind: 'existing'; draft: ConfigVersionWithEntries }
  | { kind: 'create'; base: ConfigVersionWithEntries | null };

/**
 * Brouillon dans lequel écrire — T5-004 et « plusieurs Brouillons » (§14 T5-006/T5-007, §26 T5-007/T5-008).
 *
 * · version affichée au statut Brouillon : c'est le contexte, on y écrit ;
 * · sinon, création explicitement demandée : nouveau Brouillon depuis l'Active ;
 * · sinon, aucun Brouillon : T5 en crée un depuis l'Active ;
 * · sinon : refus, avec la liste. Même avec un seul Brouillon — il peut
 *   préparer une autre évolution, et y écrire sans qu'on l'ait ouvert serait
 *   un choix fait à la place de l'administrateur.
 *
 * La création elle-même est différée après l'appel modèle : une demande dont
 * le verdict n'est pas « prompt » ne doit pas laisser un Brouillon vide.
 */
export async function resolveWriteTarget(
  versionId: number,
  createNewDraft: boolean,
): Promise<WriteTarget> {
  const version = await loadVersion(versionId);
  if (version.status === 'DRAFT') return { kind: 'existing', draft: version };

  const base = await getActiveVersion(version.environment);
  if (createNewDraft) return { kind: 'create', base };

  const drafts = (await listVersions(version.environment)).filter((v) => v.status === 'DRAFT');
  if (drafts.length === 0) return { kind: 'create', base };

  const choices: DraftChoice[] = drafts.map((d) => ({
    id: d.id,
    label: d.label,
    isStale: d.isStale,
    createdAt: d.createdAt.toISOString(),
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
  treatment: string;
  instruction: string;
  /** Créer un nouveau Brouillon depuis l'Active même si d'autres existent. */
  createDraft?: boolean;
  accountId: number;
  userId: number;
}

/**
 * Modifie un prompt à partir d'une demande en langage naturel (WF-20).
 *
 * Le texte proposé est écrit directement dans le Brouillon, puis rendu avec
 * son diff (T5-005, E-01). Seul le champ `prompt` change (T5-001).
 */
export async function modify(req: ModifyRequest): Promise<T5Analysis> {
  const cible = assertTarget(req.treatment);
  await assertAiAvailable();
  const target = await resolveWriteTarget(req.versionId, Boolean(req.createDraft));

  const source = target.kind === 'existing' ? target.draft : target.base;
  const actuel = promptOf(source, cible);

  const { output, traceId } = await callModel(
    'modify', cible, actuel, req.instruction, req.accountId, req.userId,
  );
  const result = interpret('modify', output, actuel);

  const sansEcriture: T5Analysis = {
    mode: 'modify', treatment: cible, ...result,
    applied: false, draftId: null, draftCreated: false, traceId,
  };
  if (!result.proposedContent) return sansEcriture;

  // ── Écriture ──────────────────────────────────────────────────────────
  const draft = target.kind === 'existing'
    ? target.draft
    : await createDraft(req.userId, `Prompt Control — ${cible}`);

  // Relu juste avant l'écriture : un autre enregistrement a pu passer pendant
  // l'appel modèle. Écraser un texte que T5 n'a pas lu effacerait ce travail
  // sans que le diff affiché le montre.
  const frais = await getVersion(draft.id);
  const entry = frais?.entries.find((e) => e.treatment === cible);
  if (!frais || frais.status !== 'DRAFT' || !entry) {
    throw new T5Refused(
      'NOT_A_DRAFT',
      `La version ${draft.id} n'est plus un brouillon modifiable : rien n'a été écrit (T5-004).`,
    );
  }
  if (entry.prompt !== actuel) {
    throw new T5Refused(
      'PROMPT_CHANGED',
      `Le prompt ${cible} a été modifié pendant l'analyse : rien n'a été écrit. Relancez la demande.`,
    );
  }

  // Seul le prompt change : modèles, replis, garde-fous et déclencheurs
  // restent ceux du Brouillon (T5-001, T5-012).
  await saveEntry(draft.id, { ...entry, prompt: result.proposedContent }, req.userId);

  // T5-014. Un échec du journal ne défait pas une écriture déjà faite — il est
  // signalé, et la trace de l'appel modèle reste dans les exécutions IA.
  try {
    await recordT5Modification({
      adminUserId: req.userId,
      instruction: req.instruction,
      treatment: cible,
      versionId: draft.id,
      draftCreated: target.kind === 'create',
      before: actuel,
      after: result.proposedContent,
      traceId,
      verdict: result.verdict,
    });
  } catch (e) {
    console.error('[T5] Journal de modification non écrit', { traceId, versionId: draft.id, e });
  }

  return {
    ...sansEcriture,
    applied: true,
    draftId: draft.id,
    draftCreated: target.kind === 'create',
  };
}
