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
 * des étapes, QUELLE QUE SOIT l'architecture : si une version `master` est
 * activée alors que le commutateur de déploiement (`AI_T1_ANALYSIS_MODE`)
 * n'est pas `enabled`, les étapes tournent avec leur préambule intact, et
 * l'écart est signalé (`promptArchitectureWarnings`, /api/health,
 * /admin/ai-flags).
 *
 * Ce module ne dépend que du code (registre, types) : fonctions pures,
 * testées sans base. La lecture de la version effective est dans
 * `config-resolver#getPromptArchitecture`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { listMasterPrompts } from '../registry/operations';
import { checkMasterTemplate, inspectMasterTemplate } from '../prompts/prompt-loader';
import { treatmentForUseCase, type Treatment } from './treatments';
import {
  promptArchitectureOf, masterPromptOf, type PromptArchitecture, type TreatmentConfig,
} from './config-types';
import type { ConfigVersionStatus } from './version-state-machine';
import { getRolloutMode } from '@/services/canonical/rollout';
import { getFlagMode } from '../flags/ai-feature-flags';

/**
 * Lecture de l'architecture effective d'un traitement pour l'appel courant
 * (version figée du job, sinon TO_TEST en préproduction / ACTIVE). Réexportée
 * ici pour que les pipelines n'aient qu'un point d'entrée.
 */
export { getPromptArchitecture } from './config-resolver';

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
  | { allowed: false; code: 'VERSION_NOT_EDITABLE' | 'NO_MASTER_FOR_TREATMENT'; message: string };

/**
 * Règle §29.1 / D-04 : un changement d'architecture est-il permis ?
 *
 *   · aucun changement → toujours permis ;
 *   · seule une version au statut Brouillon est modifiable (VER-002) : la
 *     version À tester qui en sera promue portera la bascule en préproduction,
 *     jamais une Active éditée en place ;
 *   · `master` exige un prompt maître déclaré au registre pour ce traitement.
 */
export function checkPromptArchitectureChange(input: {
  status: ConfigVersionStatus;
  treatment: Treatment;
  from: PromptArchitecture | null | undefined;
  to: PromptArchitecture;
}): PromptArchitectureDecision {
  const from = promptArchitectureOf({ promptArchitecture: input.from ?? undefined });
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
 * Anomalies des textes d'une ligne, pour les contrôles de promotion (WF-02) :
 *
 *   · préambule (étapes) : ne doit pas contenir de master (`{{TASK}}`,
 *     `BRANCHE TASK =`) — un master collé dans le préambule serait préfixé à
 *     chaque prompt technique des étapes ;
 *   · texte master renseigné : seulement pour un traitement qui a un master,
 *     et complet (`{{TASK}}` + une section par TASK), quelle que soit
 *     l'architecture (il peut être préparé avant la bascule) ;
 *   · architecture `master` : master déclaré au registre ; texte vide ⇒
 *     fichier du dépôt, signalé sans bloquer.
 */
export function masterConfigIssues(
  c: TreatmentConfig,
): Array<{ field: 'prompt' | 'promptArchitecture' | 'masterPrompt'; message: string; blocking: boolean }> {
  const out: Array<{ field: 'prompt' | 'promptArchitecture' | 'masterPrompt'; message: string; blocking: boolean }> = [];
  const pre = inspectMasterTemplate(c.prompt ?? '');
  if (pre.hasTaskPlaceholder || /BRANCHE\s+TASK\s*=/.test(c.prompt ?? '')) {
    out.push({
      field: 'prompt',
      message: 'Le préambule des étapes contient un prompt maître ({{TASK}} ou « BRANCHE TASK = ») : '
        + 'le texte master va dans sa zone dédiée (CDC 15 D-03).',
      blocking: true,
    });
  }

  const master = masterPromptForTreatment(c.treatment);
  const texte = masterPromptOf(c);
  if (texte && !master) {
    out.push({ field: 'masterPrompt', message: `Aucun prompt maître n'est déclaré pour ${c.treatment} : texte master sans objet.`, blocking: true });
  }
  if (texte && master) {
    for (const a of checkMasterTemplate(texte, master.tasks)) {
      out.push({ field: 'masterPrompt', message: `Prompt maître incomplet (${a}) : le master doit être complet (D-03).`, blocking: true });
    }
  }

  if (promptArchitectureOf(c) === 'master') {
    if (!master) {
      out.push({ field: 'promptArchitecture', message: `Architecture « master » sans prompt maître déclaré pour ${c.treatment}.`, blocking: true });
    } else if (!texte) {
      out.push({
        field: 'masterPrompt',
        message: `Texte master vide : le fichier ${master.masterPromptCode} du dépôt s'appliquera (valeur initiale, D-03).`,
        blocking: false,
      });
    }
  }
  return out;
}

// ── Cohérence configuration / commutateur de déploiement ────────────────────

/**
 * Commutateur de déploiement qui ouvre le chemin master d'un traitement
 * (plan CDC 15, § Déploiement ; `canonical/rollout.ts`). Lot 12 : T1.
 * Seul ce type de commutateur conditionne le master LUI-MÊME (affiché au BO).
 *
 * T3 (lot 13) n'en a pas : sa bascule vers le master se fait par la seule
 * version de configuration (D-04).
 */
export const MASTER_ROLLOUT_SWITCH: Partial<Record<Treatment, 'AI_T1_ANALYSIS_MODE'>> = {
  T1: 'AI_T1_ANALYSIS_MODE',
};

/**
 * Drapeau `AI_*` du MOTEUR qui porte le chemin master (arbitrage lead,
 * lot 13) : T3 en `master` mais `AI_RECONCILIATION_ENGINE` ≠ `enabled` ⇒ le
 * moteur de réconciliation qui appelle l'arbitrage de valeur ne tourne pas
 * (`legacy`) ou n'applique rien (`shadow`) — le master VALUE_CONFLICT n'a
 * donc aucun effet. Le départage des liens, lui, passe par le master dans
 * tous les cas.
 */
export const MASTER_ENGINE_FLAG: Partial<Record<Treatment, 'AI_RECONCILIATION_ENGINE' | 'AI_AGENDA_ENGINE'>> = {
  T3: 'AI_RECONCILIATION_ENGINE',
  // Lot 14 : T4 en `master` mais `AI_AGENDA_ENGINE` ≠ `enabled` ⇒ le moteur
  // agenda qui appelle CLASSIFY_EVENT ne tourne pas (`legacy`) ou n'écrit
  // rien (`shadow`), et le chemin manuel garde le classifieur historique. `AI_T4_EFFECTS` ne conditionne PAS le master (il gouverne
  // les effets d'écriture T4-04/07/08) : aucune alerte sur lui.
  T4: 'AI_AGENDA_ENGINE',
};

export type MasterSwitchName = 'AI_T1_ANALYSIS_MODE' | 'AI_RECONCILIATION_ENGINE' | 'AI_AGENDA_ENGINE';

export interface PromptArchitectureWarning {
  treatment: Treatment;
  code: 'MASTER_NOT_APPLIED' | 'MASTER_ENGINE_NOT_ENABLED';
  switchName: string;
  switchMode: string;
  message: string;
}

/**
 * Écart pur : version en `master` mais commutateur (T1) ou drapeau moteur
 * (T3) ≠ `enabled`.
 */
export function promptArchitectureWarning(
  treatment: Treatment, architecture: PromptArchitecture, switchMode: string,
): PromptArchitectureWarning | null {
  if (architecture !== 'master' || switchMode === 'enabled') return null;
  const sw = MASTER_ROLLOUT_SWITCH[treatment];
  if (sw) {
    return {
      treatment, code: 'MASTER_NOT_APPLIED', switchName: sw, switchMode,
      message:
        `${treatment} : la version de configuration effective déclare l'architecture « master », mais ${sw}=${switchMode}. `
        + 'Le prompt maître n\'est PAS appliqué : les étapes historiques tournent avec leur préambule '
        + `(passer ${sw}=enabled, ou remettre la ligne ${treatment} en « steps »).`,
    };
  }
  const flag = MASTER_ENGINE_FLAG[treatment];
  if (flag) {
    const effet = switchMode === 'shadow'
      ? 'tourne en observation, sans rien appliquer'
      : 'ne tourne pas (moteur historique)';
    const portee = treatment === 'T3'
      ? `L'arbitrage de valeur (VALUE_CONFLICT) ${effet} ; seul le départage des liens passe par le prompt maître `
        + `(passer ${flag}=enabled pour appliquer l'arbitrage).`
      : `La classification des échéances par le prompt maître (CLASSIFY_EVENT) ${effet}, et la création manuelle `
        + `reste sur le classifieur historique (passer ${flag}=enabled).`;
    return {
      treatment, code: 'MASTER_ENGINE_NOT_ENABLED', switchName: flag, switchMode,
      message:
        `${treatment} : la version de configuration effective déclare l'architecture « master », mais ${flag}=${switchMode}. `
        + portee,
    };
  }
  return null;
}

/**
 * Écarts de la version effective (ne lève jamais). `readMode` et
 * `readArchitecture` injectables pour les tests.
 */
export async function promptArchitectureWarnings(opts: {
  readMode?: (name: MasterSwitchName) => string;
  readArchitecture?: (t: Treatment) => Promise<PromptArchitecture>;
} = {}): Promise<PromptArchitectureWarning[]> {
  const out: PromptArchitectureWarning[] = [];
  try {
    const readMode = opts.readMode
      ?? ((name: MasterSwitchName) => (name === 'AI_T1_ANALYSIS_MODE' ? getRolloutMode(name) : getFlagMode(name)));
    const readArchitecture = opts.readArchitecture
      ?? (async (t: Treatment) => (await import('./config-resolver')).getPromptArchitecture(t));
    const surveilles = [
      ...Object.entries(MASTER_ROLLOUT_SWITCH),
      ...Object.entries(MASTER_ENGINE_FLAG),
    ] as Array<[Treatment, MasterSwitchName]>;
    for (const [t, sw] of surveilles) {
      const w = promptArchitectureWarning(t, await readArchitecture(t), readMode(sw));
      if (w) out.push(w);
    }
  } catch {
    /* configuration illisible : rien à affirmer */
  }
  return out;
}
