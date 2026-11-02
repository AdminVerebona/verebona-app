/**
 * Lot 105C (ticket « BO T4 : un prompt maître, une activation ») — les
 * QUATRE fonctions T4 et leur disponibilité TECHNIQUE pour une version
 * donnée. Module PUR (aucune base, aucun appel modèle).
 *
 *   CLASSIFY_EVENT         existence / catégorie / récurrence + intervention « À traiter »
 *   VERIFY_COMPLETION      preuve de réalisation d'une occurrence
 *   TEMPORAL_AMBIGUITY     arbitrage temporel
 *   AGENDA_REPRESENTATION  représentation multi-événements (étapes, principaux,
 *                          doublons, restaurations, réexamen T3)
 *
 * Disponibilité TECHNIQUE ≠ qualité : une fonction « disponible » est
 * exécutable par le moteur (contrats, TASK, sortie stricte) ; sa qualité se
 * juge par « Tester T4 » (rejeu du corpus) et la recette, jamais ici.
 *
 * Version à BUNDLE COMPLET : les quatre fonctions découlent du bundle validé.
 * Version HISTORIQUE (restaurée) : mêmes règles qu'à l'époque (mode
 * historique, contrat de sortie antérieur, TASK non cochée, marqueur de la
 * représentation) — ses limites sont dites clairement, jamais masquées.
 */
import { isBundleExecution, structuredTaskSupport, type MasterExecutionConfig } from '../../master-prompts/structured-context';
import { T4_EXECUTION_SPEC } from './t4-execution-contract';
import { t4ExecutionInterventionCapable } from './t4-compatibility';
import { representationCapabilityOf } from '@/services/business-operations/semantic/decider';

export interface T4FunctionState {
  task: string;
  /** Libellé en français simple (écran BO). */
  label: string;
  available: boolean;
  /** Fonction disponible mais partielle (ex. classement sans intervention « À traiter »). */
  partial: boolean;
  /** Pourquoi la fonction est indisponible ou partielle (mots simples), sinon `null`. */
  reason: string | null;
}

/** Libellés des fonctions, dans l'ordre d'affichage (TASK connues du contrat d'exécution). */
export const T4_FUNCTION_LABELS: Readonly<Record<string, string>> = {
  CLASSIFY_EVENT: 'Classement des événements et intervention « À traiter »',
  VERIFY_COMPLETION: 'Preuve de réalisation d’une occurrence',
  TEMPORAL_AMBIGUITY: 'Arbitrage des dates ambiguës',
  AGENDA_REPRESENTATION: 'Représentation Agenda multi-événements',
};

/** Fonctions T4 d'une version (texte + configuration d'exécution EXACTS). Pure. */
export function t4FunctionsOf(p: { text: string; execution: MasterExecutionConfig | null }): T4FunctionState[] {
  const e = p.execution;
  const bundle = isBundleExecution(e);
  return T4_EXECUTION_SPEC.knownTasks.map((task) => {
    const label = T4_FUNCTION_LABELS[task] ?? task;
    const etat = (available: boolean, reason: string | null, partial = false): T4FunctionState => ({ task, label, available, partial, reason });
    if (!e || e.mode !== 'STRUCTURED_CONTEXT') {
      // Mode historique à emplacements : les trois branches d'origine, sans intervention ni représentation.
      if (task === 'AGENDA_REPRESENTATION') return etat(false, 'Version au mode historique : fonction absente.');
      if (task === 'CLASSIFY_EVENT') return etat(true, 'Version au mode historique : sans évaluation de l’intervention « À traiter ».', true);
      return etat(true, null);
    }
    if (task === 'AGENDA_REPRESENTATION') {
      const c = representationCapabilityOf({ text: p.text, version: '', execution: e });
      if (c.available) return etat(true, null);
      const pourquoi: Record<string, string> = {
        MARKER_MISSING: 'Version antérieure : la fonction n’y était pas activée.',
        TASK_NOT_ALLOWED: 'Version antérieure : la fonction n’y était pas activée.',
        CONTRACTS_MISSING: bundle ? 'Configuration du moteur incompatible avec cette version.' : 'Version antérieure : la fonction n’y était pas prévue.',
        LEGACY_TEMPLATE: 'Version au mode historique : fonction absente.',
      };
      return etat(false, pourquoi[c.contractState ?? ''] ?? 'Fonction indisponible pour cette version.');
    }
    const s = structuredTaskSupport(T4_EXECUTION_SPEC, e, task);
    if (!s.supported) {
      return etat(false, bundle ? 'Configuration du moteur incompatible avec cette version.' : 'Version antérieure : la fonction n’y était pas activée.');
    }
    if (task === 'CLASSIFY_EVENT' && !t4ExecutionInterventionCapable(e)) {
      return etat(true, 'Version antérieure : sans évaluation de l’intervention « À traiter ».', true);
    }
    return etat(true, null);
  });
}

/** Les quatre fonctions sont-elles pleinement disponibles ? Pure. */
export function t4FunctionsComplete(f: T4FunctionState[]): boolean {
  return f.every((x) => x.available && !x.partial);
}

/** Résumé court des limites (notices de réactivation, historique). `null` : aucune limite. Pure. */
export function t4LimitationsText(f: T4FunctionState[]): string | null {
  const limites = f.filter((x) => !x.available || x.partial);
  if (limites.length === 0) return null;
  return `Fonctions limitées : ${limites.map((x) => `${x.label} — ${x.available ? 'partielle' : 'indisponible'}${x.reason ? ` (${x.reason})` : ''}`).join(' ; ')}`;
}
