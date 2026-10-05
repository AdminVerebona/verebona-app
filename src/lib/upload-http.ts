import { apiClient, attemptSignal, untilAborted, HTTP_POLICIES, type HttpPolicy } from '@/lib/api-client';

/**
 * Motif lisible quand la réponse ne porte pas de message (page d'erreur du
 * routeur, corps vide). « Échec de la préparation du téléchargement » seul ne
 * permettait pas de distinguer une session expirée d'une panne serveur.
 */
export function messageSelonStatut(status: number, repli: string): string {
  if (status === 401) return 'Votre session a expiré. Reconnectez-vous puis réessayez.';
  if (status === 403) return `${repli} : action refusée. Rechargez la page puis réessayez.`;
  if (status === 413) return 'Le fichier est trop volumineux.';
  if (status === 429) return 'Trop de dépôts en peu de temps. Patientez une minute puis réessayez.';
  if (status >= 500) return `Le service de dépôt est momentanément indisponible (erreur ${status}). Réessayez dans quelques instants.`;
  return `${repli} (erreur ${status}).`;
}

/** Délai dépassé (distinct d'une annulation : la file ne le traite PAS comme un abandon). */
export class DelaiDepotDepasse extends Error {
  constructor() {
    super('Le serveur n’a pas répondu à temps. Réessayez dans quelques instants.');
    this.name = 'DelaiDepotDepasse';
  }
}

const erreurAnnulation = () => Object.assign(new Error('Upload annulé'), { name: 'AbortError' });
/** Statuts sans corps : `new Response(corps, …)` les refuse avec un corps. */
const SANS_CORPS = new Set([101, 204, 205, 304]);

/**
 * Appel d'API du dépôt (presign, confirm) — politique HTTP commune (lot 24, #12).
 *
 * · Budget de la politique `write` d'`api-client` (`HTTP_POLICIES.write`) :
 *   délai PAR TENTATIVE (en-têtes ET corps, lu ici sous le minuteur puis
 *   rendu dans une `Response` mémoire — corps JSON courts) et budget TOTAL
 *   où s'imputent le renouvellement de session et le rejeu. Il n'y avait
 *   aucun délai : un presign sans réponse laissait le fichier « en transfert »
 *   indéfiniment.
 * · Annulation de l'appelant respectée avant l'envoi, pendant l'attente et
 *   pendant la lecture : `AbortError` (la file la traite comme un abandon).
 *   Un délai dépassé est une erreur distincte (`DelaiDepotDepasse`).
 * · AUCUNE nouvelle tentative automatique ici (mutation). Les rejeux sont
 *   décidés par la file, avec la clé d'opération : presign et confirm sont
 *   idempotents par `operationId` (même opération ⇒ même document, 0242).
 * · Un 401 déclenche UN renouvellement partagé (`apiClient.refreshToken`)
 *   puis un seul rejeu — le serveur a refusé la première demande sans
 *   l'exécuter : ce n'est pas un doublon.
 * · Une coupure réseau devient un message explicite.
 * · Appels internes seulement (cookies de session) : le PUT vers l'URL S3
 *   signée ne passe JAMAIS par ici (`envoyerXhr`, sans cookie).
 */
export async function fetchDepot(
  url: string, init: RequestInit, politique: HttpPolicy = HTTP_POLICIES.write,
): Promise<Response> {
  const appelant = init.signal ?? null;
  const echeance = Date.now() + politique.totalBudgetMs;

  const appel = async (): Promise<Response> => {
    if (appelant?.aborted) throw erreurAnnulation();
    const reste = echeance - Date.now();
    if (reste <= 0) throw new DelaiDepotDepasse();
    const tentative = attemptSignal(appelant, Math.min(politique.attemptTimeoutMs, reste));
    try {
      const res = await fetch(url, { credentials: 'include', ...init, signal: tentative.signal });
      const corps = SANS_CORPS.has(res.status) ? null : await untilAborted(res.text(), tentative.signal);
      return new Response(corps, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) {
      const cause = tentative.cause();
      if (cause === 'caller') throw erreurAnnulation();
      if (cause === 'timeout') throw new DelaiDepotDepasse();
      if ((e as Error)?.name === 'AbortError') throw e;
      throw new Error('Connexion au serveur impossible. Vérifiez votre réseau puis réessayez.');
    } finally {
      tentative.dispose();
    }
  };

  const res = await appel();
  if (res.status !== 401) return res;
  // Le renouvellement (son propre délai, REFRESH_TIMEOUT_MS) s'impute au budget.
  const attente = attemptSignal(appelant, Math.max(0, echeance - Date.now()));
  let renouvele: boolean | 'server_error' = false;
  try {
    renouvele = await untilAborted(apiClient.refreshToken().catch(() => false as const), attente.signal);
  } catch {
    if (attente.cause() === 'caller') throw erreurAnnulation();
    return res; // budget épuisé pendant le renouvellement : le 401 d'origine
  } finally {
    attente.dispose();
  }
  return renouvele === true ? appel() : res;
}
