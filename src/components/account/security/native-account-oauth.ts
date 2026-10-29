/**
 * Mon compte › Sécurité dans l'APPLICATION — « Connecter » (associer) et
 * « Confirmer avec Google / Apple » (lot 97B, PO M1 ; CDC 18 §12.3, §18.2).
 *
 * Sur le Web : rien ne change (la page part chez le fournisseur). Dans l'app,
 * l'OAuth n'est JAMAIS fait dans la vue : le serveur rend une adresse
 * d'ouverture à usage unique, ouverte dans le navigateur système
 * (`lib/native/oauth`), puis l'échange PKCE applique l'action à la session de
 * la vue. Module chargé seulement dans l'app (import dynamique).
 */
import { toast } from 'sonner';
import { isNativeApp } from '@/lib/native/bridge';

type Provider = 'google' | 'apple';

/** Corps à ajouter à la demande au serveur, ou `{}` sur le Web. `null` : préparation impossible dans l'app. */
export async function accountOAuthBody(provider: Provider, purpose: 'link' | 'reauth'): Promise<Record<string, string> | null> {
  if (!isNativeApp()) return {};
  const { prepareNativeAccountOAuth } = await import('@/lib/native/oauth');
  return prepareNativeAccountOAuth(provider, purpose);
}

/**
 * Suite d'une réponse `{ redirectUrl }` : Web → navigation ; app → navigateur
 * système. Rend `true` si la page est quittée (ou le parcours en cours).
 */
export async function followAccountOAuth(redirectUrl: string): Promise<boolean> {
  if (!isNativeApp()) { window.location.assign(redirectUrl); return true; }
  const { openNativeAccountOAuth } = await import('@/lib/native/oauth');
  const r = await openNativeAccountOAuth(redirectUrl);
  if (r.status === 'account_done' || r.status === 'signed_in') { window.location.assign(r.redirectTo); return true; }
  if (r.status === 'failed') toast.error(r.message);
  // Android : le retour arrive par lien (hôte natif) ; annulation : rien.
  return r.status === 'pending_return';
}
