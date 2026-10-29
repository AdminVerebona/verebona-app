/**
 * Ouverture du portail Stripe (factures, moyen de paiement) — côté client.
 *
 * Extraite de `SubscriptionSummary` : l'impayé doit proposer le MÊME geste
 * (« mettre à jour le moyen de paiement ») depuis le bandeau, la fenêtre de
 * refus d'écriture et la page des offres. Recopier la séquence ci-dessous
 * dans chacun garantissait qu'une copie oublie le contournement du bloqueur
 * de fenêtres.
 *
 * L'onglet est ouvert tout de suite, au clic : ouvert après la réponse du
 * serveur, il serait bloqué comme fenêtre surgissante (Safari, Firefox). Il
 * reçoit ensuite l'adresse du portail, ou se referme en cas d'échec.
 */
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { NATIVE_COMMERCE_MESSAGE, nativeCommerceHidden } from '@/lib/native/commerce';

export async function openBillingPortal(): Promise<boolean> {
  // Lot 97B (COM-01/05) : jamais de portail de paiement depuis l'application
  // (filet : les boutons y sont déjà masqués).
  if (nativeCommerceHidden()) { toast.message(NATIVE_COMMERCE_MESSAGE); return false; }
  const onglet = typeof window !== 'undefined' ? window.open('', '_blank') : null;
  try {
    const res = await apiClient.post<{ portal_url?: string; message?: string }>(
      '/api/billing/create-customer-portal-session',
      {},
    );
    if (res.portal_url) {
      if (onglet) {
        onglet.opener = null;
        onglet.location.href = res.portal_url;
      } else {
        // Fenêtre refusée par le navigateur : dernier recours, même onglet.
        window.location.href = res.portal_url;
      }
      return true;
    }
    onglet?.close();
    toast.error(res.message || 'Portail indisponible pour le moment.');
    return false;
  } catch {
    onglet?.close();
    toast.error('Impossible d\'ouvrir le portail de facturation.');
    return false;
  }
}
