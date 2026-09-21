/**
 * Prompt Control — CDC BO IA T5-001 à T5-009, SCR-06.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * T5 DOIT POUVOIR DIRE « CE N'EST PAS LE PROMPT »
 *
 * Le T5-009 : « si le problème est code, données ou configuration, T5 doit le
 * dire et ne pas fabriquer une modification de prompt ».
 *
 * Ce n'est pas une consigne qu'on pose dans un texte en espérant qu'elle tienne.
 * Un modèle à qui l'on demande une modification de prompt en produira une —
 * toujours, et d'autant plus volontiers qu'il n'a pas d'autre issue. Il faut
 * donc lui en donner une : un verdict explicite, et un schéma qui accepte une
 * réponse sans proposition.
 *
 * C'est la même leçon que le 18/09/2026 au matin, vue de l'autre côté : un
 * modèle obéit au contrat qu'on lui donne. Si le contrat n'a qu'une sortie,
 * il la prendra même quand elle est fausse.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS INTERDITS TENUS PAR LE SERVEUR, PAS PAR LE PROMPT
 *
 * · T5-002 — T5 ne modifie jamais son propre prompt ;
 * · T5-003 — T5 ne touche pas aux prompts spécialisés de T2, seulement au socle ;
 * · T5-004 — une modification s'écrit dans un Brouillon, jamais dans l'Active.
 *
 * Un modèle à qui l'on demande de ne pas se modifier lui-même finira un jour
 * par le faire. Ces trois règles sont donc vérifiées avant toute écriture, et
 * refusent quelle que soit la sortie du modèle.
 */
import { z } from 'zod';
import { AiGateway } from '../gateway/ai-gateway';
import { computeDiff, type DiffSummary } from './diff.service';
import { isTreatment, type Treatment } from '../config/treatments';
import { getVersion, saveEntry } from '../config/config-version.repository';

/**
 * Verdict du diagnostic — SCR-06, zone « Diagnostic ».
 *
 * Les quatre causes n'appellent pas le même geste, et les confondre fait
 * chercher au mauvais endroit : retoucher un prompt quand c'est le code qui
 * cloche est le plus sûr moyen de dégrader les deux.
 */
export const VERDICTS = ['prompt', 'code', 'donnees', 'configuration'] as const;
export type Verdict = (typeof VERDICTS)[number];

const T5AnalysisOutput = z.object({
  verdict: z.enum(VERDICTS),
  /** Analyse destinée à l'administrateur, quel que soit le verdict. */
  analysis: z.string().min(20).max(3000),
  /**
   * Prompt complet proposé — uniquement si le verdict est « prompt ».
   *
   * Nullable par conception : c'est ce qui permet au modèle de conclure que le
   * problème est ailleurs sans avoir à inventer une modification.
   */
  proposedContent: z.string().min(50).max(50_000).nullable().default(null),
  risks: z.array(z.string().max(300)).max(10).default([]),
  /** Recommandations non appliquées : modèle, repli, réglage (SCR-06). */
  recommendations: z.array(z.string().max(300)).max(10).default([]),
});

export interface T5Analysis {
  verdict: Verdict;
  analysis: string;
  proposedContent: string | null;
  risks: string[];
  recommendations: string[];
  diff: DiffSummary | null;
  /** Refus motivé : la proposition est inexploitable en l'état. */
  rejected?: string;
}

export class T5Refused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'T5Refused';
  }
}

/**
 * Vérifie qu'une cible est modifiable par T5 — avant tout appel modèle.
 *
 * Avant, et non après : un appel est payé même quand son résultat sera refusé,
 * et refuser tôt évite de facturer une demande qui n'avait aucune chance.
 */
export async function assertTargetWritable(versionId: number, treatment: string): Promise<Treatment> {
  if (!isTreatment(treatment)) {
    throw new T5Refused('UNKNOWN_TREATMENT', `Traitement inconnu : « ${treatment} ».`);
  }

  // T5-002 : T5 ne modifie jamais son propre prompt. Vérifié par le serveur,
  // parce qu'une consigne de prompt ne tient pas dans la durée.
  if (treatment === 'T5') {
    throw new T5Refused(
      'SELF_MODIFICATION',
      "Prompt Control ne peut pas modifier son propre prompt (T5-002). "
      + 'Passez par une modification de code.',
    );
  }

  const version = await getVersion(versionId);
  if (!version) {
    throw new T5Refused('VERSION_NOT_FOUND', `Version ${versionId} introuvable.`);
  }

  // T5-004 : une modification s'écrit dans un Brouillon. Une version « À
  // tester » est déjà en cours d'évaluation ; la modifier changerait ce qu'on
  // est en train de mesurer.
  if (version.status !== 'DRAFT') {
    throw new T5Refused(
      'NOT_A_DRAFT',
      `Cette version est au statut « ${version.status} » : Prompt Control n'écrit que dans un `
      + 'brouillon (T5-004). Créez-en un depuis la version active.',
    );
  }

  return treatment;
}

/**
 * Analyse une demande en langage naturel.
 *
 * Ne modifie rien : rend un verdict, et une proposition seulement si le
 * problème vient bien du prompt.
 */
export async function analyze(
  versionId: number,
  treatment: string,
  instruction: string,
  accountId: number,
  userId: number,
): Promise<T5Analysis> {
  const cible = await assertTargetWritable(versionId, treatment);

  const version = await getVersion(versionId);
  const entry = version?.entries.find((e) => e.treatment === cible);
  const contenuActuel = entry?.prompt ?? '';

  const res = await AiGateway.execute({
    useCaseCode: 'AI_GOVERNANCE',
    operationCode: 'analyze_instruction',
    accountId,
    userId,
    promptVariables: {
      PROMPT_CODE: cible,
      CURRENT_CONTENT: contenuActuel,
      INSTRUCTION: instruction,
    },
    outputSchema: T5AnalysisOutput,
  });

  const d = res.data;

  // Verdict « prompt » sans proposition : le modèle s'est contredit. On ne
  // devine pas ce qu'il voulait dire — on le rend visible.
  if (d.verdict === 'prompt' && !d.proposedContent) {
    return {
      ...d,
      diff: null,
      rejected: "Le diagnostic conclut au prompt mais ne propose aucun texte : demande à reformuler.",
    };
  }

  // Verdict autre que « prompt » avec une proposition : le T5-009 veut que T5
  // s'abstienne dans ce cas. On conserve l'analyse et on écarte la proposition
  // plutôt que de l'offrir à l'application.
  if (d.verdict !== 'prompt' && d.proposedContent) {
    return { ...d, proposedContent: null, diff: null };
  }

  if (d.verdict !== 'prompt') return { ...d, diff: null };

  const diff = computeDiff(contenuActuel, d.proposedContent!);

  // Une proposition qui ne change rien n'a pas à encombrer le circuit.
  if (diff.identical) {
    return { ...d, diff, rejected: 'La proposition est identique au prompt actuel.' };
  }

  return { ...d, diff };
}

/**
 * Applique une proposition dans le brouillon.
 *
 * Geste séparé de l'analyse, et c'est délibéré : le SCR-06 veut que
 * l'administrateur voie le diff avant que quoi que ce soit ne bouge. Analyser
 * et écrire d'un même mouvement, c'est ce que faisait l'ancienne route
 * `admin/ai-instructions/apply`, qui appliquait les patchs dans la requête qui
 * les produisait.
 */
export async function applyProposal(
  versionId: number,
  treatment: string,
  proposedContent: string,
  userId: number,
): Promise<void> {
  const cible = await assertTargetWritable(versionId, treatment);

  const version = await getVersion(versionId);
  const entry = version?.entries.find((e) => e.treatment === cible);
  if (!entry) {
    throw new T5Refused('ENTRY_NOT_FOUND', `Configuration ${cible} absente de la version ${versionId}.`);
  }

  await saveEntry(versionId, { ...entry, prompt: proposedContent }, userId);
}
