/**
 * Réauthentification Google / Apple — branchement sur la preuve SERVEUR du
 * lot 92 (`src/lib/auth/reauth.ts`). CDC 18 §18, §10.2, §12.3, §25 ;
 * REAUTH-01/02/04/05/07.
 *
 * Intégration 92 + 93 (26/10/2026) : le cookie provisoire de preuve du
 * lot 93 est supprimé. Il n'existe plus qu'UNE preuve : la ligne
 * `reauth_proofs` liée à (utilisateur, `sid`), 5 minutes, émise par
 * `issueReauthProof` et exigée par `requireFreshReauth` / `getReauthState`.
 *
 * Ce module enregistre Google et Apple comme méthodes de réauthentification
 * « à redirection » (§18.2) : disponibles seulement si le fournisseur est
 * actif ET déjà lié au compte. `startUrl` est la route
 * `POST /api/users/me/auth-identities/<p>/reauth` (corps `{ resume }`,
 * réponse `{ redirectUrl }`) ; au retour, `flow.ts › completeReauth` vérifie
 * le MÊME subject puis appelle `issueReauthProof(userId, sid, '<p>')`.
 *
 * Importé pour son effet par tout module qui liste les méthodes
 * (`/api/users/me/security`, `account-security.ts`).
 */
import { registerReauthMethod, getReauthState, type ReauthMethodId } from '@/lib/auth/reauth';
import { getProviderConfig, OAUTH_PROVIDERS, type OAuthProvider } from './config';
import { listIdentities } from './identities';

const LABEL: Record<OAuthProvider, string> = { google: 'Google', apple: 'Apple' };

/** Route de démarrage de la réauthentification par ce fournisseur (POST). */
export const providerReauthStartUrl = (p: OAuthProvider): string => `/api/users/me/auth-identities/${p}/reauth`;

for (const p of OAUTH_PROVIDERS) {
  registerReauthMethod({
    id: p,
    label: `Confirmer avec ${LABEL[p]}`,
    kind: 'redirect',
    async isAvailableFor(userId) {
      if (!getProviderConfig(p)) return false;
      return (await listIdentities(userId)).some((i) => i.provider === p);
    },
    startUrl: () => providerReauthStartUrl(p),
  });
}

/** Forme lue par l'écran (« Identité confirmée pour quelques minutes »). */
export interface ReauthState {
  fresh: boolean;
  method: ReauthMethodId | null;
  expiresAt: string | null;
}

/** État de la preuve 92 de CETTE session (aucune écriture). */
export async function readReauthState(userId: number, sid: string | null | undefined): Promise<ReauthState> {
  const s = await getReauthState(userId, sid);
  return s.state === 'fresh'
    ? { fresh: true, method: s.proof.method, expiresAt: s.proof.expiresAt.toISOString() }
    : { fresh: false, method: null, expiresAt: null };
}
