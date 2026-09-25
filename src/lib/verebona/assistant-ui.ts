/**
 * Logique d'affichage de l'assistant, sans React — CDC §4.2, §19.8, §27.9,
 * §27.11.
 *
 * Isolée des composants pour être testée (le harnais ne rend pas de TSX) :
 * message d'erreur avec ses suites, cible d'un « Réessayer », mise en forme
 * de l'explication « Pourquoi ? ».
 */
import type { VerebonaAction, VerebonaMessage } from './useVerebona';
import type { AssistantUiError } from './error-messages';

/**
 * Destination de « Ouvrir l'aide » quand le serveur n'a pas répondu : il
 * n'a donc pas pu fournir de href (§27.1). Route réelle de l'application
 * (`ROUTES.AIDE` côté serveur).
 */
export const HELP_HREF = '/aide';

/** Actions d'une erreur : « Réessayer » si l'erreur s'y prête, puis l'aide. */
export function errorActions(error: Pick<AssistantUiError, 'recoverable'>, idSeed: string): VerebonaAction[] {
  const actions: VerebonaAction[] = [];
  if (error.recoverable) {
    actions.push({
      actionId: `${idSeed}-retry`, type: 'RETRY_REQUEST', label: 'Réessayer', href: null,
      requiresConfirmation: false, analyticsCode: 'verebona.action.retry_request',
    });
  }
  actions.push({
    actionId: `${idSeed}-help`, type: 'OPEN_HELP', label: 'Ouvrir l’aide', href: HELP_HREF,
    requiresConfirmation: false, analyticsCode: 'verebona.action.open_help',
  });
  return actions;
}

/**
 * Message assistant affiché à la place d'une impasse (§4.2) : libellé
 * Verebona, jamais le texte technique, et une suite possible.
 */
export function errorAssistantMessage(error: AssistantUiError, id: string): VerebonaMessage {
  return {
    id,
    role: 'assistant',
    content: error.message,
    error,
    actions: errorActions(error, id),
  };
}

/**
 * Texte à renvoyer pour « Réessayer » (§27.11 `recoverable`) : la dernière
 * question de l'utilisateur précédant le message `fromMessageId` (ou la
 * dernière tout court). `null` s'il n'y en a pas.
 */
export function retryTarget(
  messages: VerebonaMessage[],
  fromMessageId?: string,
): { text: string; userMessageId: string } | null {
  const end = fromMessageId ? messages.findIndex((m) => m.id === fromMessageId) : messages.length;
  const limite = end < 0 ? messages.length : end;
  for (let i = limite - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.content.trim()) return { text: m.content, userMessageId: m.id };
  }
  return null;
}

// ── « Pourquoi ? » (§19.8, §27.9) ──────────────────────────────────────────

export interface ExplanationRow {
  claim_text: string;
  derivation?: string | null;
  sources?: Array<string | null> | null;
}

export interface ExplanationItem {
  text: string;
  derivation: string | null;
  sources: string[];
}

const DERIVATIONS: Record<string, string> = {
  direct: 'lu dans la source',
  calculated: 'calculé à partir des sources',
  synthesized: 'synthèse des sources',
};

/**
 * Justification synthétique : les faits utilisés, leur nature (lu, calculé,
 * synthétisé) et leurs sources — jamais un raisonnement interne (§19.8).
 */
export function formatExplanation(rows: ExplanationRow[] | null | undefined): ExplanationItem[] {
  return (rows ?? [])
    .filter((r) => r && typeof r.claim_text === 'string' && r.claim_text.trim())
    .map((r) => ({
      text: r.claim_text.trim(),
      derivation: r.derivation ? (DERIVATIONS[r.derivation] ?? null) : null,
      sources: [...new Set((r.sources ?? []).filter((s): s is string => typeof s === 'string' && s.trim() !== ''))],
    }));
}

/** Phrase affichée quand aucune affirmation n'est enregistrée pour la réponse. */
export const EXPLANATION_EMPTY =
  'Cette réponse a été produite par une règle de l’application, à partir des éléments affichés dans les sources.';
