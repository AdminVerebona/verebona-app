/**
 * Libellés d'erreur de l'assistant — CDC §27.11, §4.2.
 *
 * « Jamais d'impasse » (§4.2) : une erreur n'affiche ni code technique ni
 * message fournisseur, mais une phrase Verebona et une suite possible
 * (réessayer, ouvrir l'aide). Module pur, partagé par le serveur
 * (orchestrateur, routes) et le client (drawer).
 */

/** Codes fonctionnels stables (§27.11) — miroir de `VEREBONA_ERROR_CODES`. */
export type AssistantErrorCode =
  | 'PLAN_NOT_ELIGIBLE'
  | 'RATE_LIMITED'
  | 'NO_RELEVANT_SOURCE'
  | 'CLARIFICATION_REQUIRED'
  | 'CLARIFICATION_EXPIRED'
  | 'ASSISTANT_UNAVAILABLE'
  | 'REQUEST_TIMEOUT'
  | 'REQUEST_CANCELLED'
  | 'INVALID_ACTION'
  | 'SOURCE_UNAVAILABLE'
  | 'CONVERSATION_EXPIRED'
  | 'VALIDATION_FAILED'
  | 'UNSAFE_REQUEST'
  | 'NETWORK_ERROR';

const MESSAGES: Record<AssistantErrorCode, string> = {
  PLAN_NOT_ELIGIBLE: 'Cette fonction n’est pas incluse dans votre offre actuelle. Vous pouvez consulter les offres pour en savoir plus.',
  RATE_LIMITED: 'Vous avez envoyé beaucoup de messages en peu de temps. Réessayez dans un instant.',
  NO_RELEVANT_SOURCE: 'Je n’ai pas trouvé d’information suffisamment précise pour répondre.',
  CLARIFICATION_REQUIRED: 'J’ai besoin d’une précision pour répondre.',
  CLARIFICATION_EXPIRED: 'Cette question de précision a expiré. Reposez votre question.',
  ASSISTANT_UNAVAILABLE: 'Je rencontre un souci technique. Vous pouvez réessayer dans un instant.',
  REQUEST_TIMEOUT: 'Votre demande a pris trop de temps. Vous pouvez réessayer.',
  REQUEST_CANCELLED: 'La demande a été annulée.',
  INVALID_ACTION: 'Cette action n’est plus disponible.',
  SOURCE_UNAVAILABLE: 'Cette source n’est plus disponible.',
  CONVERSATION_EXPIRED: 'Cette conversation n’existe plus. Démarrez-en une nouvelle.',
  VALIDATION_FAILED: 'Je n’ai pas pu vérifier la réponse. Vous pouvez réessayer.',
  UNSAFE_REQUEST: 'Je ne peux pas traiter cette demande.',
  NETWORK_ERROR: 'Connexion impossible pour le moment. Vérifiez votre réseau puis réessayez.',
};

/** Codes pour lesquels « Réessayer » a un sens. */
const NON_RECOVERABLE = new Set<AssistantErrorCode>(['PLAN_NOT_ELIGIBLE', 'UNSAFE_REQUEST', 'REQUEST_CANCELLED']);

export function isAssistantErrorCode(code: unknown): code is AssistantErrorCode {
  return typeof code === 'string' && code in MESSAGES;
}

/** Libellé Verebona d'un code ; code inconnu → indisponibilité générique. */
export function assistantErrorMessage(code: string | null | undefined): string {
  return isAssistantErrorCode(code) ? MESSAGES[code] : MESSAGES.ASSISTANT_UNAVAILABLE;
}

export interface AssistantUiError {
  code: AssistantErrorCode;
  message: string;
  recoverable: boolean;
}

/**
 * Normalise une réponse d'erreur de l'API (corps `{ error: { code, message,
 * recoverable } }` ou ancien `{ error: 'CODE' }`) et son statut HTTP en
 * erreur affichable. Le libellé vient TOUJOURS de ce module : un message
 * serveur éventuel n'est pas repris tel quel.
 */
export function toAssistantUiError(body: unknown, httpStatus?: number): AssistantUiError {
  const raw = (body as { error?: unknown } | null)?.error;
  let code: string | undefined =
    typeof raw === 'string' ? raw
      : raw && typeof raw === 'object' ? (raw as { code?: string }).code
        : undefined;
  if (!isAssistantErrorCode(code)) {
    code = httpStatus === 429 ? 'RATE_LIMITED'
      : httpStatus === 404 ? 'CONVERSATION_EXPIRED'
        : httpStatus === 504 ? 'REQUEST_TIMEOUT'
          : 'ASSISTANT_UNAVAILABLE';
  }
  const c = code as AssistantErrorCode;
  return { code: c, message: MESSAGES[c], recoverable: !NON_RECOVERABLE.has(c) };
}
