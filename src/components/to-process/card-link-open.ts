/**
 * Lot 107E — ouverture d'un lien direct d'une carte « À traiter ».
 *
 * · Jamais une action de la carte : le clic s'arrête au lien (pas de choix,
 *   pas de « Autre », pas de résolution, pas d'écriture).
 * · Revalidation AU CLIC par la route de la carte
 *   (`POST /api/v2/to-process/:publicId/links`, compte de la SESSION, lien
 *   recalculé depuis les relations de preuve) : document supprimé, objet
 *   archivé, autre compte → rien ne s'ouvre, message existant, file relue
 *   (la carte affiche alors l'état explicite). Vérification impossible →
 *   rien ne s'ouvre non plus (variante prudente du lot 76E).
 * · Destinations NATIVES existantes : tiroir document (visionneuse), tiroirs
 *   équipement / pièce / échéance (consultation, jamais en édition), page du
 *   bien, fiche fournisseur. Aucun parcours externe, aucune URL de stockage.
 */
import { toast } from 'sonner';
import { openDrawer } from '@/lib/drawers';
import { supplierHref } from '@/lib/supplier-routes';
import { captureSupplierOrigin, navigateToSupplier } from '@/lib/suppliers/supplier-return';
import type { CardLinkRef } from '@/services/to-process/card-links';
import { DOCUMENT_GONE_MESSAGE, DOCUMENT_OPEN_FAILED_MESSAGE } from './document-preview';
import { notifyToProcessChanged } from './useToProcessResolution';
import { notifyLeaving } from './return-state';

/** Message existant (file « À traiter », carte déjà traitée). */
export const CARD_ALREADY_RESOLVED_MESSAGE = 'Cette action est déjà traitée.';

export type CardLinkCheckStatus = 'ok' | 'gone' | 'resolved' | 'error';
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function checkCardLinkRemote(
  publicId: string, ref: Pick<CardLinkRef, 'kind' | 'id'>, fetchImpl: FetchLike = (i, init) => fetch(i, init),
): Promise<CardLinkCheckStatus> {
  try {
    const res = await fetchImpl(`/api/v2/to-process/${encodeURIComponent(publicId)}/links`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { kind: ref.kind, id: ref.id } }),
    });
    if (!res.ok) return 'error';
    const { status } = (await res.json()) as { status?: unknown };
    return status === 'ok' || status === 'gone' || status === 'resolved' ? status : 'error';
  } catch {
    return 'error';
  }
}

/** Destination native d'un lien (pure) : tiroir ou page. */
export function cardLinkDestination(ref: CardLinkRef):
  | { type: 'drawer'; kind: 'document' | 'equipement' | 'piece' | 'echeance'; id: number }
  | { type: 'page'; href: string }
  | null {
  switch (ref.kind) {
    case 'document': return { type: 'drawer', kind: 'document', id: ref.id };
    case 'equipement': return { type: 'drawer', kind: 'equipement', id: ref.id };
    case 'piece': return { type: 'drawer', kind: 'piece', id: ref.id };
    case 'echeance':
    case 'reference': return { type: 'drawer', kind: 'echeance', id: ref.id };
    case 'asset': return ref.publicId && /^[0-9a-zA-Z-]{8,64}$/.test(ref.publicId) ? { type: 'page', href: `/assets/${ref.publicId}` } : null;
    case 'supplier': return { type: 'page', href: supplierHref(ref.id) };
  }
}

interface ClickLike { currentTarget: unknown; preventDefault(): void; stopPropagation(): void }

/** Ouvertures en cours (carte × lien) : un double tap n'ouvre qu'une fois. */
const opening = new Set<string>();

export async function openCardLink(
  e: ClickLike,
  cardId: string,
  ref: CardLinkRef,
  linkKey: string,
  deps: {
    check?: (publicId: string, ref: CardLinkRef) => Promise<CardLinkCheckStatus>;
    navigate?: (href: string) => void;
  } = {},
): Promise<'opened' | 'gone' | 'resolved' | 'error' | 'busy'> {
  e.preventDefault();
  e.stopPropagation();
  const key = `${cardId}|${linkKey}`;
  if (opening.has(key)) return 'busy';
  opening.add(key);
  const el = (e.currentTarget ?? null) as HTMLElement | null;
  try {
    el?.focus?.({ preventScroll: true });
    const dest = cardLinkDestination(ref);
    if (!dest) { toast.error(DOCUMENT_OPEN_FAILED_MESSAGE); return 'error'; }
    const status = await (deps.check ?? checkCardLinkRemote)(cardId, ref);
    if (status === 'gone') {
      toast.info(DOCUMENT_GONE_MESSAGE);
      notifyToProcessChanged();
      return 'gone';
    }
    if (status === 'resolved') {
      toast.info(CARD_ALREADY_RESOLVED_MESSAGE);
      notifyToProcessChanged();
      return 'resolved';
    }
    if (status !== 'ok') { toast.error(DOCUMENT_OPEN_FAILED_MESSAGE); return 'error'; }
    if (dest.type === 'drawer') {
      if (dest.kind === 'document') openDrawer({ kind: 'document', id: dest.id }, { returnFocusTo: el });
      else if (dest.kind === 'echeance') openDrawer({ kind: 'echeance', id: dest.id, initialMode: 'view' });
      else openDrawer({ kind: dest.kind, id: dest.id });
      return 'opened';
    }
    // Page : la file note son état pour le retour, puis on navigue (historique conservé).
    notifyLeaving(cardId, linkKey);
    // Lot 109B : fiche fournisseur ouverte dans l'application avec mémoire de la
    // carte quittée (« Retour à « À traiter » » la rétablit, défilement compris).
    if (ref.kind === 'supplier') {
      if (!deps.navigate) { navigateToSupplier(ref.id); return 'opened'; }
      captureSupplierOrigin(ref.id);
    }
    const go = deps.navigate ?? ((href: string) => { if (typeof window !== 'undefined') window.location.assign(href); });
    go(dest.href);
    return 'opened';
  } finally {
    opening.delete(key);
  }
}
