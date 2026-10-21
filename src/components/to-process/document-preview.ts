/**
 * Lot 76E — vignette d'aperçu d'une carte « À traiter » → tiroir du document.
 *
 * Retour PO du 21/10/2026 : « dans À traiter, le clic sur le preview doit
 * ouvrir le drawer ».
 *
 * · Même tiroir que partout ailleurs (`openDrawer({ kind: 'document' })`,
 *   écouté par DashboardLayout) : aucun nouveau tiroir.
 * · Le clic n'est PAS une action de la carte : il ne remonte pas, ne choisit
 *   rien, ne résout rien.
 * · Revalidation avant ouverture, par la route existante de la mascotte
 *   (`/api/home/mascot/check`, compte de la SESSION, document non supprimé) :
 *   document supprimé ou d'un autre compte → pas d'ouverture, message
 *   existant, file relue. Vérification impossible → pas d'ouverture non plus
 *   (variante prudente).
 * · Focus : le bouton est focalisé avant l'ouverture (Safari / iOS ne le font
 *   pas au clic) et transmis au tiroir (`returnFocusTo`), qui le lui rend à
 *   la fermeture.
 */
import { toast } from 'sonner';
import { openDrawer } from '@/lib/drawers';
import { notifyToProcessChanged } from './useToProcessResolution';
import type { ActionView } from './ActionCard';

export const PREVIEW_CHECK_URL = '/api/home/mascot/check';
/** Messages EXISTANTS (mascotte, revalidation au clic) — pas de nouveau libellé. */
export const DOCUMENT_GONE_MESSAGE = 'Cet élément n’est plus disponible.';
export const DOCUMENT_OPEN_FAILED_MESSAGE = 'Cette action n’a pas pu être ouverte. Réessayez.';

export type PreviewCheck = 'ok' | 'gone' | 'error';
export type PreviewOutcome = 'opened' | 'gone' | 'error' | 'busy';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Le document est-il encore ouvrable, dans le compte de la session ? */
export async function checkDocumentAccessible(id: number, fetchImpl: FetchLike = (i, init) => fetch(i, init)): Promise<PreviewCheck> {
  try {
    const res = await fetchImpl(PREVIEW_CHECK_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'drawer', drawer: 'document', id } }),
    });
    if (!res.ok) return 'error';
    const { status } = (await res.json()) as { status?: unknown };
    return status === 'ok' ? 'ok' : status === 'gone' ? 'gone' : 'error';
  } catch {
    return 'error';
  }
}

/** Nom accessible du bouton de vignette. */
export const previewAriaLabel = (action: Pick<ActionView, 'target'>) => `Ouvrir le document ${action.target.label}`;

/** Ouvertures en cours, par carte : un double clic n'ouvre qu'un tiroir. */
const opening = new Set<string>();

interface ClickLike {
  currentTarget: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}

export async function openCardDocumentPreview(
  e: ClickLike,
  action: Pick<ActionView, 'publicId' | 'targetType' | 'targetId'>,
  deps: { check: (id: number) => Promise<PreviewCheck> } = { check: (id) => checkDocumentAccessible(id) },
): Promise<PreviewOutcome> {
  // Jamais une action de la carte : le clic s'arrête au bouton.
  e.preventDefault();
  e.stopPropagation();
  if (action.targetType !== 'DOCUMENT') return 'error';
  if (opening.has(action.publicId)) return 'busy';
  opening.add(action.publicId);
  const el = (e.currentTarget ?? null) as HTMLElement | null;
  try {
    el?.focus?.({ preventScroll: true });
    const status = await deps.check(action.targetId);
    if (status === 'ok') {
      openDrawer({ kind: 'document', id: action.targetId }, { returnFocusTo: el });
      return 'opened';
    }
    if (status === 'gone') {
      toast.info(DOCUMENT_GONE_MESSAGE);
      // La carte d'un document disparu n'a plus lieu d'être : la file se relit.
      notifyToProcessChanged();
      return 'gone';
    }
    toast.error(DOCUMENT_OPEN_FAILED_MESSAGE);
    return 'error';
  } finally {
    opening.delete(action.publicId);
  }
}
