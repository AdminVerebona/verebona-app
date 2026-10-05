import { apiClient } from '@/lib/api-client';

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

/**
 * Appel d'API du dépôt avec renouvellement de session.
 *
 * Le dialogue appelle `fetch` directement (signal d'annulation propre au
 * dépôt). Sans renouvellement, un jeton d'accès expiré — onglet ouvert depuis
 * un moment, application mobile reprise — faisait échouer le dépôt alors que
 * la session était encore valide. Un 401 déclenche donc UN renouvellement
 * partagé (`apiClient.refreshToken`) puis une seule nouvelle tentative.
 * Une coupure réseau devient un message explicite.
 */
export async function fetchDepot(url: string, init: RequestInit): Promise<Response> {
  const appel = async () => {
    try {
      return await fetch(url, { credentials: 'include', ...init });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      throw new Error('Connexion au serveur impossible. Vérifiez votre réseau puis réessayez.');
    }
  };
  const res = await appel();
  if (res.status !== 401) return res;
  const renouvele = await apiClient.refreshToken().catch(() => false);
  return renouvele === true ? appel() : res;
}
