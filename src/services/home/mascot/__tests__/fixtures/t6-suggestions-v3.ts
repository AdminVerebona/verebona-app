/**
 * Lot 87C — outils de test du contrat des questions fondées
 * (`t6-suggestions-v3`). Aucun prompt n'est modifié : `masterV3` SIMULE la
 * version du prompt maître que l'équipe IA livrera (demande
 * 87C-t6-suggestions-fondees), en ajoutant au texte du dépôt les marqueurs
 * du contrat (`t6-suggestions-v3`, `"groundRefs"`).
 */
import type { T6SuggestionBundle, T6SuggestionNature, T6SuggestionSubject } from '../../t6-suggestions';

export const CONTRACT_MARKERS = '\nR12 (contrat t6-suggestions-v3) — simulé pour les tests : {"question":"…","subject":"…","purpose":"…","decision":{},"groundRefs":[],"informationNature":[]}\n';

/** Version BO simulée du prompt maître portant le contrat des questions fondées. */
export const masterV3 = (master: string) => `${master}${CONTRACT_MARKERS}`;

/**
 * Question conforme au contrat : sujet déduit des références (échéance, bien,
 * sinon premier indicateur du compte cité), natures = natures des fondements
 * cités, décision « pertinente et répondable ». `over` remplace n'importe quel
 * champ (y compris pour produire une sortie NON conforme).
 */
export function fonde(
  b: Pick<T6SuggestionBundle, 'grounds'>, question: string, groundRefs: string[],
  over: Partial<{
    subject: T6SuggestionSubject | string | null; purpose: string | null; assetRef: string | null; deadlineRef: string | null;
    decision: unknown; informationNature: Array<T6SuggestionNature | string> | null; groundRefs: unknown;
  }> = {},
): Record<string, unknown> {
  const deadlineRef = over.deadlineRef !== undefined ? over.deadlineRef : groundRefs.find((r) => /^D\d+$/.test(r)) ?? null;
  const assetRef = over.assetRef !== undefined ? over.assetRef : null;
  const premier = groundRefs.map((r) => b.grounds?.get(r)).find((g) => g && g.scope == null);
  const subject = over.subject !== undefined ? over.subject
    : deadlineRef ? 'DEADLINE' : assetRef ? 'ASSET' : (premier?.subjects[0] ?? 'DEADLINES');
  const purpose = over.purpose !== undefined ? over.purpose : 'CONSULT';
  const natures = [...new Set(groundRefs.map((r) => b.grounds?.get(r)?.nature).filter((n): n is T6SuggestionNature => !!n))];
  return {
    question, subject, purpose, assetRef, deadlineRef,
    decision: over.decision !== undefined ? over.decision : { relevant: true, answerable: true, preparationUseful: purpose === 'PREPARE' ? true : null },
    groundRefs: over.groundRefs !== undefined ? over.groundRefs : groundRefs,
    informationNature: over.informationNature !== undefined ? over.informationNature : natures,
  };
}

/** Décision T6 validée d'action, démarche établie ou non (fondements d'échéance). */
export const decisionAction = (action: string, actionEstablished: boolean, o: Record<string, unknown> = {}) => ({
  decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', uncertainties: [] as string[], action, actionEstablished, ...o,
});
