/**
 * Architecture des prompts par traitement — CDC 15 §22.3, §29 étape 14,
 * §29.1 ; décisions D-03 et D-04 (lot 12).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA BASCULE VERS LES MASTERS PASSE PAR LA VERSION DE CONFIGURATION
 *
 * D-04 : un traitement passe des étapes historiques (`steps`) à son prompt
 * maître (`master`) par sa ligne dans une version de configuration IA —
 * TO_TEST en préproduction, ACTIVE en production après validation. Jamais
 * par un drapeau d'environnement, et jamais en éditant une Active (VER-002,
 * §29.1) : la bascule suit le cycle Brouillon → À tester → Validée, comme
 * tout autre réglage, et le rollback la défait avec le reste.
 *
 * D-03 : le texte COMPLET du master est porté par un champ distinct,
 * `masterPrompt` (colonne `master_prompt`, 0220) ; vide, le fichier
 * `tN_master_vK.txt` du dépôt s'applique. Le préambule (`prompt`) reste celui
 * des étapes : la passerelle ne l'ajoute qu'aux opérations par étapes.
 *
 * Lot 16b : PLUS AUCUN traitement n'a d'architecture `steps`
 * (`MASTER_ONLY_TREATMENTS` = T1 à T6, migrations 0231 à 0234) : la valeur
 * n'est plus qu'une donnée héritée, refusée à l'enregistrement et à la
 * promotion. Plus aucun commutateur ni drapeau ne gouverne les masters.
 *
 * Ce module ne dépend que du code (registre, types) : fonctions pures,
 * testées sans base.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { listMasterPrompts, AI_OPERATIONS } from '../registry/operations';
import { checkMasterTemplate, inspectMasterTemplate, isOptionalMasterVariable } from '../prompts/prompt-loader';
import { treatmentForUseCase, isMasterOnlyTreatment, isPromptAdministrable, type Treatment } from './treatments';
import { retiredVariablesSet } from './retired-variables';
import {
  promptArchitectureOf, masterPromptOf, type PromptArchitecture, type TreatmentConfig,
} from './config-types';
import type { ConfigVersionStatus } from './version-state-machine';

/** Prompt maître d'un traitement et ses branches, tels que déclarés au registre. */
export interface TreatmentMaster {
  masterPromptCode: string;
  tasks: string[];
}

/** Master déclaré pour un traitement, ou `null` (bascule `master` impossible). */
export function masterPromptForTreatment(treatment: Treatment): TreatmentMaster | null {
  for (const m of listMasterPrompts()) {
    if (treatmentForUseCase(m.useCaseCode) === treatment) {
      return { masterPromptCode: m.masterPromptCode, tasks: [...m.tasks] };
    }
  }
  return null;
}

/** Traitements pour lesquels un master existe (lot 12 : T1). */
export function masterCapableTreatments(): Treatment[] {
  return listMasterPrompts().map((m) => treatmentForUseCase(m.useCaseCode));
}

export type PromptArchitectureDecision =
  | { allowed: true }
  | { allowed: false; code: 'VERSION_NOT_EDITABLE' | 'NO_MASTER_FOR_TREATMENT' | 'MASTER_ONLY_TREATMENT'; message: string };

/**
 * Règle §29.1 / D-04 : un changement d'architecture est-il permis ?
 *
 *   · aucun changement → toujours permis ;
 *   · seule une version au statut Brouillon est modifiable (VER-002) : la
 *     version À tester qui en sera promue portera la bascule en préproduction,
 *     jamais une Active éditée en place ;
 *   · `master` exige un prompt maître déclaré au registre pour ce traitement ;
 *   · aucun traitement n'a plus d'architecture `steps` (lot 16b) : la
 *     demander est refusé, quel que soit le statut de la version.
 */
export function checkPromptArchitectureChange(input: {
  status: ConfigVersionStatus;
  treatment: Treatment;
  from: PromptArchitecture | null | undefined;
  to: PromptArchitecture;
}): PromptArchitectureDecision {
  if (input.to === 'steps' && isMasterOnlyTreatment(input.treatment)) {
    return {
      allowed: false,
      code: 'MASTER_ONLY_TREATMENT',
      message:
        `Architecture des prompts de ${input.treatment} : « steps » n'existe plus. Les étapes historiques de `
        + `${input.treatment} ont été retirées ; son prompt maître est son seul moteur (lot 16b).`,
    };
  }
  // Une ligne est lue `master` même absente ou stockée `steps` —
  // l'enregistrer n'est pas une bascule.
  const from = promptArchitectureOf({ treatment: input.treatment, promptArchitecture: input.from ?? undefined });
  if (from === input.to) return { allowed: true };
  if (input.status !== 'DRAFT') {
    return {
      allowed: false,
      code: 'VERSION_NOT_EDITABLE',
      message:
        `Architecture des prompts de ${input.treatment} : changement refusé sur une version au statut ` +
        `« ${input.status} ». La bascule se fait dans un Brouillon, puis par sa promotion « À tester » ` +
        '(CDC 15 §29.1, D-04).',
    };
  }
  if (input.to === 'master' && !masterPromptForTreatment(input.treatment)) {
    return {
      allowed: false,
      code: 'NO_MASTER_FOR_TREATMENT',
      message: `Aucun prompt maître n'est encore déclaré pour ${input.treatment} : architecture « master » indisponible.`,
    };
  }
  return { allowed: true };
}

/**
 * Emplacements `{{X}}` déclarés au registre pour un master (union des
 * `promptVariables` de ses opérations actives), hors discriminant.
 * Vide : aucune déclaration (pas de contrôle d'égalité possible).
 */
export function declaredMasterVariables(masterPromptCode: string): string[] {
  const vars = new Set<string>();
  for (const op of Object.values(AI_OPERATIONS)) {
    if (op.active && op.masterPromptCode === masterPromptCode) for (const v of op.promptVariables ?? []) vars.add(v);
  }
  return [...vars].sort();
}

/**
 * Contrôle COMPLET d'un texte master proposé pour un traitement (T5 MODIFY,
 * enregistrement d'une version) : structure (`checkMasterTemplate` :
 * discriminant + une section par branche) ET emplacements identiques à ceux
 * que le code fournit (registre) — un emplacement supprimé ou inventé ferait
 * échouer chaque appel (`UNDECLARED_VARIABLE` / `UNRESOLVED_PLACEHOLDER`).
 */
export function checkMasterProposal(treatment: Treatment, text: string): string[] {
  const master = masterPromptForTreatment(treatment);
  if (!master) return [`aucun prompt maître déclaré pour ${treatment}`];
  const out = checkMasterTemplate(text, master.tasks);
  const attendus = declaredMasterVariables(master.masterPromptCode);
  if (attendus.length) {
    const info = inspectMasterTemplate(text);
    const presents = info.placeholders.filter((p) => p !== info.discriminant);
    // Variable optionnelle absente (texte antérieur) : signalée sans bloquer
    // par `missingOptionalMasterVariables`, jamais un échec d'appel.
    const manquants = attendus.filter((v) => !presents.includes(v) && !isOptionalMasterVariable(master.masterPromptCode, v));
    const inconnus = presents.filter((v) => !attendus.includes(v));
    if (manquants.length) out.push(`emplacement(s) supprimé(s) : ${manquants.map((m) => `{{${m}}}`).join(', ')}`);
    if (inconnus.length) out.push(`emplacement(s) inconnu(s) du code : ${inconnus.map((m) => `{{${m}}}`).join(', ')}`);
  }
  return out;
}

/**
 * Emplacements OPTIONNELS (`OPTIONAL_MASTER_VARIABLES`) absents d'un texte
 * master proposé : le rendu les ignore, la règle reste appliquée par le
 * serveur — avertissement non bloquant au BO.
 */
export function missingOptionalMasterVariables(treatment: Treatment, text: string): string[] {
  const master = masterPromptForTreatment(treatment);
  if (!master) return [];
  const info = inspectMasterTemplate(text);
  return declaredMasterVariables(master.masterPromptCode)
    .filter((v) => isOptionalMasterVariable(master.masterPromptCode, v) && !info.placeholders.includes(v));
}

/**
 * Anomalies des textes d'une ligne, pour les contrôles de promotion (WF-02) :
 *
 *   · préambule (étapes) : ne doit pas contenir de master (`{{TASK}}`,
 *     `BRANCHE TASK =`) — un master collé dans le préambule serait préfixé à
 *     chaque prompt technique des étapes ;
 *   · texte master renseigné : seulement pour un traitement qui a un master,
 *     et complet (discriminant, une section par branche, emplacements du
 *     code) — BLOQUANT ;
 *   · master déclaré au registre ; texte vide ⇒ fichier du dépôt, signalé
 *     sans bloquer ;
 *   · ligne portant `steps` (valeur brute, ligne antérieure aux migrations
 *     0231 à 0234 ou client ancien) : BLOQUANT — l'architecture `steps` est
 *     retirée pour tous les traitements.
 */
export function masterConfigIssues(
  c: TreatmentConfig,
): Array<{ field: 'prompt' | 'promptArchitecture' | 'masterPrompt'; message: string; blocking: boolean }> {
  const out: Array<{ field: 'prompt' | 'promptArchitecture' | 'masterPrompt'; message: string; blocking: boolean }> = [];
  // Prompt non administrable (T5) : ses textes stockés sont ignorés à
  // l'exécution — ils ne sont pas inspectés comme des textes actifs. Seuls
  // l'architecture et le master du DÉPÔT sont contrôlés.
  const administrable = isPromptAdministrable(c.treatment);
  if (!administrable) c = { ...c, prompt: '', masterPrompt: null };
  const pre = inspectMasterTemplate(c.prompt ?? '');
  if (pre.hasTaskPlaceholder || /BRANCHE\s+(?:TASK|MODE)\s*=/.test(c.prompt ?? '')) {
    // Lot 16b : le préambule n'est plus appliqué (aucune opération par étapes)
    // ni éditable au BO. Le laisser BLOQUANT enfermait l'administrateur : un
    // paramètre qui bloque doit être corrigeable depuis l'écran (ticket BO IA).
    // Signalé, non bloquant : le master se saisit dans sa zone dédiée.
    out.push({
      field: 'prompt',
      message: 'Un ancien préambule contient un prompt maître ({{TASK}} ou « BRANCHE TASK = ») : il n’est plus '
        + 'utilisé. Le texte master se saisit dans sa zone dédiée (CDC 15 D-03).',
      blocking: false,
    });
  }

  if (isMasterOnlyTreatment(c.treatment) && c.promptArchitecture === 'steps') {
    out.push({
      field: 'promptArchitecture',
      message: `Architecture « steps » retirée pour ${c.treatment} : seul son prompt maître existe (lot 16b, migrations 0231 à 0234).`,
      blocking: true,
    });
  }

  const master = masterPromptForTreatment(c.treatment);
  const texte = masterPromptOf(c);
  if (texte && !master) {
    out.push({ field: 'masterPrompt', message: `Aucun prompt maître n'est déclaré pour ${c.treatment} : texte master sans objet.`, blocking: true });
  }
  if (texte && master) {
    for (const a of checkMasterProposal(c.treatment, texte)) {
      out.push({ field: 'masterPrompt', message: `Prompt maître incomplet (${a}) : le master doit être complet (D-03).`, blocking: true });
    }
    const optionnels = missingOptionalMasterVariables(c.treatment, texte);
    if (optionnels.length) {
      out.push({
        field: 'masterPrompt',
        message: `Emplacement(s) ${optionnels.map((v) => `{{${v}}}`).join(', ')} absent(s) du texte master : la donnée n’est pas `
          + `transmise au modèle, mais la règle reste appliquée par le serveur. Reprenez le texte du dépôt `
          + `(${master.masterPromptCode}) pour l’ajouter.`,
        blocking: false,
      });
    }
  }

  if (!master) {
    out.push({ field: 'promptArchitecture', message: `Architecture « master » sans prompt maître déclaré pour ${c.treatment}.`, blocking: true });
  } else if (!texte && isPromptAdministrable(c.treatment)) {
    // T5 : fichier du dépôt par construction (non administrable), rien à signaler.
    out.push({
      field: 'masterPrompt',
      message: `Texte master vide : le fichier ${master.masterPromptCode} du dépôt s'appliquera (valeur initiale, D-03).`,
      blocking: false,
    });
  }
  return out;
}

// ── Variables retirées encore posées (CDC 15 T2-43 ; lot 16b) ──────────────

export interface PromptArchitectureWarning {
  treatment: Treatment | null;
  /** `RETIRED_ENV_VARIABLE` : variable retirée encore posée, ignorée par le code. */
  code: 'RETIRED_ENV_VARIABLE';
  switchName: string;
  switchMode: string;
  message: string;
}

/**
 * CDC 15 T2-43 : `VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS` est RETIRÉE et
 * ignorée (source unique : configuration IA, bornée à 500). Encore posée,
 * elle est signalée dans /api/health : un environnement qui s'en servait pour
 * abaisser le plafond doit le voir.
 */
export function retiredOutputTokensWarning(env: Record<string, string | undefined>): PromptArchitectureWarning | null {
  const v = env.VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS;
  if (v === undefined || v.trim() === '') return null;
  return {
    treatment: 'T2', code: 'RETIRED_ENV_VARIABLE', switchName: 'VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS', switchMode: v,
    message: `T2 : VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS=${v} est posée mais IGNORÉE (CDC 15 T2-43). `
      + 'Le plafond de sortie de l’assistant vient de la seule configuration IA (traitement T2), borné à 500 : '
      + 'régler la version de configuration si une valeur inférieure est voulue, puis supprimer la variable.',
  };
}

/**
 * Avertissements de configuration (ne lève jamais), pour /api/health : chaque
 * variable RETIRÉE (drapeau `AI_*`, commutateur de déploiement, réglage
 * historique — `retired-variables.ts`) encore posée dans l'environnement. Le
 * code l'ignore ; elle est à supprimer chez l'hébergeur. Lot 16b : plus aucun
 * écart « version master / commutateur » possible, il n'existe plus de
 * commutateur.
 */
export async function promptArchitectureWarnings(opts: {
  env?: Record<string, string | undefined>;
} = {}): Promise<PromptArchitectureWarning[]> {
  const env = opts.env ?? process.env;
  const out: PromptArchitectureWarning[] = [];
  const tokens = retiredOutputTokensWarning(env);
  if (tokens) out.push(tokens);
  for (const v of retiredVariablesSet(env)) {
    if (v.name === 'VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS') continue;
    out.push({
      treatment: null, code: 'RETIRED_ENV_VARIABLE', switchName: v.name, switchMode: v.value,
      message: `${v.name}=${v.value} est posée mais IGNORÉE (retirée au ${v.lot} : ${v.now}). À supprimer chez l'hébergeur.`,
    });
  }
  return out;
}
