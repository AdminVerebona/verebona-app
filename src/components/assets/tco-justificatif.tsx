"use client"

/**
 * Lot 80A — lien « Justificatif » d'une ligne du coût de possession.
 *
 * Bug corrigé (retour PO du 22/10/2026) : le lien menait à la page historique
 * `/documents/<id>`, qui lit `GET /api/documents/<id>` — route sans GET
 * (seul PUT existe) : TOUS les justificatifs finissaient sur « Erreur lors du
 * chargement du document ». L'identifiant était bien celui du fichier.
 *
 * Même mécanisme que la vignette « À traiter » (lot 76E) :
 *   · revalidation par la route existante de la mascotte (compte de la
 *     SESSION, document non supprimé) — aucun identifiant cru sur parole ;
 *   · tiroir document EXISTANT (`openDrawer` → DashboardLayout), au-dessus des
 *     sous-tiroirs du TCO, focus rendu au lien à la fermeture (`returnFocusTo`) ;
 *   · document disparu / autre compte : message existant, pas d'ouverture.
 * Clic modifié (nouvel onglet) : le lien profond du tiroir
 * (`/documents?tiroir=document:<id>`). Composant sans hook, desktop et mobile.
 */
import { toast } from 'sonner';
import { FileText } from 'lucide-react';
import { drawerHref, openDrawer } from '@/lib/drawers';
import { checkDocumentAccessible, DOCUMENT_GONE_MESSAGE, DOCUMENT_OPEN_FAILED_MESSAGE, type PreviewCheck } from '@/components/to-process/document-preview';

export type TcoJustificatifOutcome = 'opened' | 'gone' | 'error' | 'busy' | 'follow';

interface ClickLike {
  currentTarget: unknown;
  preventDefault(): void;
  stopPropagation?(): void;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  button?: number;
}

/** Ouvertures en cours (un double clic n'ouvre qu'un tiroir). */
const enCours = new Set<number>();

export async function openTcoJustificatif(
  e: ClickLike,
  fileId: number,
  deps: { check: (id: number) => Promise<PreviewCheck> } = { check: (id) => checkDocumentAccessible(id) },
): Promise<TcoJustificatifOutcome> {
  // Nouvel onglet / fenêtre : le lien profond fait foi (le tiroir s'ouvre sur « Mes documents »).
  if (e.metaKey || e.ctrlKey || e.shiftKey || (e.button ?? 0) !== 0) return 'follow';
  e.preventDefault();
  e.stopPropagation?.();
  if (enCours.has(fileId)) return 'busy';
  enCours.add(fileId);
  const el = (e.currentTarget ?? null) as HTMLElement | null;
  try {
    // Safari / iOS ne focalisent pas un lien au clic : focus d'abord, pour qu'il soit rendu à la fermeture.
    el?.focus?.({ preventScroll: true });
    const status = await deps.check(fileId);
    if (status === 'ok') {
      openDrawer({ kind: 'document', id: fileId }, { returnFocusTo: el });
      return 'opened';
    }
    if (status === 'gone') { toast.info(DOCUMENT_GONE_MESSAGE); return 'gone'; }
    toast.error(DOCUMENT_OPEN_FAILED_MESSAGE);
    return 'error';
  } finally {
    enCours.delete(fileId);
  }
}

/** Lien vers le justificatif d'une ligne TCO (tiroir document ; `title` : justificatif repris « Justificatif : … »). */
export function TcoJustificatif({ fileId, title }: { fileId: number | null | undefined; title?: string }) {
  if (!fileId) return null;
  const libelle = title ? `Justificatif : ${title}` : 'Justificatif';
  return (
    <a
      href={drawerHref({ kind: 'document', id: fileId }, '/documents')}
      onClick={(e) => { void openTcoJustificatif(e, fileId); }}
      className="inline-flex min-h-[32px] md:min-h-0 min-w-0 items-center gap-1 text-xs text-primary hover:underline"
      data-tco-doc-link={fileId}
      title={title}
      aria-label={title ? `Ouvrir le justificatif ${title}` : 'Ouvrir le justificatif'}
    >
      <FileText className="w-3 h-3 shrink-0" aria-hidden /> <span className="truncate max-w-[16rem]">{libelle}</span>
    </a>
  );
}
