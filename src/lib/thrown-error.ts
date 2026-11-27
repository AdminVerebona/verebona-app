/**
 * Lecture typée d'une valeur levée (`catch (error: unknown)`).
 *
 * Une valeur levée n'est pas forcément une `Error` : `apiClient` lève une
 * `ApiClientError` (statut, code, détails, message du serveur), d'autres
 * chemins lèvent une `Error` nue, un objet ou une chaîne. La lecture est donc
 * STRUCTURELLE — un champ n'est rendu que s'il a le type attendu — pour que
 * les `catch` n'aient plus besoin de `any` et ne dépendent pas de la classe
 * de l'erreur.
 */

export interface ThrownErrorFields {
  message?: string;
  /** Statut HTTP (`ApiClientError`). */
  status?: number;
  /** Code métier (`ApiClientError`, erreurs de service). */
  code?: string;
  /** Message rédigé par le serveur, affichable tel quel. */
  serverMessage?: string;
  details?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export function readThrownError(error: unknown): ThrownErrorFields {
  if (!isRecord(error)) return {};
  const { message, status, code, serverMessage, details } = error;
  return {
    message: typeof message === 'string' ? message : undefined,
    status: typeof status === 'number' ? status : undefined,
    code: typeof code === 'string' ? code : undefined,
    serverMessage: typeof serverMessage === 'string' ? serverMessage : undefined,
    details: isRecord(details) ? details : undefined,
  };
}
