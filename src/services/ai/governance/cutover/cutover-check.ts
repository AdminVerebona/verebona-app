/**
 * GARDE de l'architecture cible — CDC 15 §29 étape 15, §32 (« anciens
 * prompts supprimés »), D-02, D-17, HC-06 ; lot 16b (retrait de l'ancien
 * moteur IA).
 *
 * Jusqu'au lot 16b, ce calcul listait les préconditions du RETRAIT des
 * opérations dépréciées. Le retrait est fait : il devient un garde, qui
 * échoue si l'ancien moteur réapparaît.
 *
 * Calcul PUR : les entrées (registre, fichiers de prompt, gabarits
 * historiques, base, environnement) sont lues par le script
 * `check-master-cutover.ts`. Contrôles :
 *
 *   · NON_TARGET_OPERATION   (bloquant) une opération ACTIVE appelle un
 *     modèle hors prompt maître (étape historique, relais legacy) — seule
 *     exception : l'évaluation d'une version candidate (`dynamicPrompt`) ;
 *   · ORPHAN_PROMPT_FILE     (bloquant) un fichier `ai/prompts/**` qu'aucune
 *     opération active ne cite (prompt d'étape oublié) ;
 *   · LEGACY_TEMPLATE        (bloquant) un gabarit historique
 *     `document-ai/prompts/*.txt` subsiste ;
 *   · STORED_STEPS           (bloquant en base, « à vérifier » sans base)
 *     une ligne de configuration stockée `steps` (migrations 0231 à 0234 non
 *     appliquées) ;
 *   · RETIRED_VARIABLE       (avertissement) drapeau `AI_*` ou commutateur
 *     retiré encore posé : ignoré par le code, à supprimer chez l'hébergeur ;
 *   · RETIRED_OPERATION_CALL (avertissement) appel récent, dans
 *     `ai_usage_event`, à une opération qui n'existe plus au registre
 *     (historique d'avant le déploiement, ou ancien code encore en service).
 */
import type { AiOperationDefinition } from '../../registry/operations';

export type Check = 'ok' | 'bloquant' | 'avertissement' | 'à vérifier';

export interface GuardCheck { code: string; status: Check; detail: string }

export interface CutoverReport {
  mode: 'base' | 'statique';
  days: number;
  checks: GuardCheck[];
  nonTargetOperations: string[];
  orphanPromptFiles: string[];
  legacyTemplates: string[];
  /** Lignes stockées `steps` ; null : base non lue. */
  storedSteps: Array<{ versionId: number; treatment: string }> | null;
  retiredVariables: string[];
  /** Opérations hors registre appelées sur la fenêtre ; null : non lu. */
  retiredOperationCalls: Array<{ operationCode: string; calls: number }> | null;
  /** Aucun contrôle bloquant. */
  ready: boolean;
}

export interface CutoverInputs {
  operations: AiOperationDefinition[];
  isTarget(op: AiOperationDefinition): boolean;
  /** Tous les fichiers de prompt du dépôt (relatifs), et leur code. */
  promptFiles: Array<{ promptCode: string; path: string }>;
  /** Gabarits historiques encore présents (chemins relatifs). */
  legacyTemplates: string[];
  /** Lignes de configuration stockées `steps` ; null : base indisponible. */
  storedSteps: Array<{ versionId: number; treatment: string }> | null;
  /** Variables retirées encore posées (nom). */
  retiredVariables: string[];
  /** Appels observés par opération sur la fenêtre ; null : non lu. */
  usage: Record<string, number> | null;
  days: number;
}

export function computeCutover(i: CutoverInputs): CutoverReport {
  const checks: GuardCheck[] = [];
  const actives = i.operations.filter((o) => o.active);

  const nonTarget = actives.filter((o) => !i.isTarget(o)).map((o) => o.operationCode);
  checks.push(nonTarget.length
    ? { code: 'NON_TARGET_OPERATION', status: 'bloquant', detail: `opération(s) hors prompt maître : ${nonTarget.join(', ')}.` }
    : { code: 'NON_TARGET_OPERATION', status: 'ok', detail: 'toutes les opérations modèle passent par un prompt maître.' });

  const cites = new Set(actives.flatMap((o) => [o.promptCode, o.masterPromptCode]).filter((x): x is string => Boolean(x)));
  const orphelins = i.promptFiles.filter((f) => !cites.has(f.promptCode)).map((f) => f.path).sort();
  checks.push(orphelins.length
    ? { code: 'ORPHAN_PROMPT_FILE', status: 'bloquant', detail: `prompt(s) cité(s) par aucune opération : ${orphelins.join(', ')}.` }
    : { code: 'ORPHAN_PROMPT_FILE', status: 'ok', detail: `${i.promptFiles.length} fichier(s) de prompt, tous cités.` });

  const gabarits = [...i.legacyTemplates].sort();
  checks.push(gabarits.length
    ? { code: 'LEGACY_TEMPLATE', status: 'bloquant', detail: `gabarit(s) historique(s) : ${gabarits.join(', ')}.` }
    : { code: 'LEGACY_TEMPLATE', status: 'ok', detail: 'aucun gabarit historique.' });

  checks.push(i.storedSteps === null
    ? { code: 'STORED_STEPS', status: 'à vérifier', detail: 'configuration IA non lue (base indisponible).' }
    : i.storedSteps.length
      ? {
        code: 'STORED_STEPS', status: 'bloquant',
        detail: `${i.storedSteps.length} ligne(s) de configuration encore stockée(s) « steps » `
          + `(${i.storedSteps.map((s) => `v${s.versionId}/${s.treatment}`).join(', ')}) : appliquer les migrations 0231 à 0234.`,
      }
      : { code: 'STORED_STEPS', status: 'ok', detail: 'aucune ligne de configuration en « steps ».' });

  checks.push(i.retiredVariables.length
    ? { code: 'RETIRED_VARIABLE', status: 'avertissement', detail: `variable(s) retirée(s) encore posée(s), ignorée(s) : ${i.retiredVariables.join(', ')}.` }
    : { code: 'RETIRED_VARIABLE', status: 'ok', detail: 'aucune variable retirée posée.' });

  const connues = new Set(i.operations.map((o) => o.operationCode));
  const appels = i.usage === null
    ? null
    : Object.entries(i.usage)
      .filter(([code, n]) => n > 0 && !connues.has(code))
      .map(([operationCode, calls]) => ({ operationCode, calls }))
      .sort((a, b) => a.operationCode.localeCompare(b.operationCode));
  checks.push(appels === null
    ? { code: 'RETIRED_OPERATION_CALL', status: 'à vérifier', detail: `appels des ${i.days} derniers jours non lus.` }
    : appels.length
      ? {
        code: 'RETIRED_OPERATION_CALL', status: 'avertissement',
        detail: `opération(s) hors registre appelée(s) sur ${i.days} jours : `
          + `${appels.map((a) => `${a.operationCode} (${a.calls})`).join(', ')} — historique antérieur au déploiement ?`,
      }
      : { code: 'RETIRED_OPERATION_CALL', status: 'ok', detail: `aucun appel hors registre sur ${i.days} jours.` });

  return {
    mode: i.storedSteps === null ? 'statique' : 'base',
    days: i.days,
    checks,
    nonTargetOperations: nonTarget,
    orphanPromptFiles: orphelins,
    legacyTemplates: gabarits,
    storedSteps: i.storedSteps,
    retiredVariables: [...i.retiredVariables],
    retiredOperationCalls: appels,
    ready: !checks.some((c) => c.status === 'bloquant'),
  };
}
