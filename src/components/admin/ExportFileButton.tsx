"use client";

/**
 * Bouton d'export de fichier du BO (JSON, CSV) — lot 113T (Trello #718).
 *
 * Un seul composant pour les exports du BO : lecture authentifiée et
 * contrôlée (`fetchExportFile`), puis remise du FICHIER (`deliverFile`) :
 * feuille de partage native dans l'app iOS / Android, Web Share API sur
 * mobile, téléchargement sur ordinateur. Jamais de navigation vers la route
 * d'API (plus de page de JSON brut), l'écran du BO reste en place.
 *
 *   · « Préparation… » pendant la lecture ;
 *   · échec (session expirée, droits, erreur serveur, réponse inattendue) :
 *     message sous le bouton, aucun fichier produit ;
 *   · feuille de partage fermée : rien (pas d'erreur) ;
 *   · navigateur qui exige un nouveau geste avant de partager (préparation
 *     longue) : bouton « Partager le fichier » sur le fichier déjà prêt.
 */
import { useCallback, useRef, useState } from 'react';
import { Download, Loader2, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  ExportError, EXPORT_MESSAGES, deliverFile, fetchExportFile,
  type DeliveryOutcome, type ExportFile, type ExportKind,
} from '@/lib/files/export-delivery';

/** Textes à valider par le PO (lot 113T). */
export const EXPORT_BUTTON_TEXTS = {
  preparing: 'Préparation…',
  shareReady: 'Partager le fichier',
  readyHint: 'Fichier prêt : touchez « Partager le fichier » pour l’enregistrer ou l’envoyer.',
  downloaded: (name: string) => `Fichier téléchargé : ${name}`,
  shared: (name: string) => `Fichier transmis : ${name}`,
} as const;

function feedback(outcome: DeliveryOutcome, name: string): void {
  if (outcome === 'downloaded') toast.success(EXPORT_BUTTON_TEXTS.downloaded(name));
  else if (outcome === 'shared') toast.success(EXPORT_BUTTON_TEXTS.shared(name));
}

/**
 * Remise d'un fichier déjà construit dans la page (rapport affiché, export
 * reçu en JSON) avec le même parcours que le bouton ; message d'échec en toast.
 */
export async function saveFileWithFeedback(blob: Blob, fileName: string, title?: string): Promise<DeliveryOutcome | null> {
  try {
    const { outcome } = await deliverFile(blob, fileName, { title, onNeedsGesture: 'download' });
    feedback(outcome, fileName);
    return outcome;
  } catch (e) {
    toast.error(e instanceof ExportError ? e.message : EXPORT_MESSAGES.SHARE_FAILED);
    return null;
  }
}

/**
 * Lecture contrôlée d'un export puis remise du fichier, message d'échec en
 * toast — pour les boutons existants qui gèrent eux-mêmes leur état.
 */
export async function exportFileWithFeedback(url: string, fallbackName: string, kind: ExportKind = 'json', title?: string): Promise<DeliveryOutcome | null> {
  let f: ExportFile;
  try {
    f = await fetchExportFile(url, { kind, fallbackName });
  } catch (e) {
    toast.error(e instanceof ExportError ? e.message : EXPORT_MESSAGES.SERVER_ERROR);
    return null;
  }
  return saveFileWithFeedback(f.blob, f.fileName, title);
}

interface Props {
  /** Route d'export (même origine ; session par cookie). */
  url: string;
  /** Nom de repli si la réponse n'en porte pas (Content-Disposition). */
  fallbackName: string;
  label: string;
  kind?: ExportKind;
  /** `link` : lien discret (en-têtes de panneau) ; `button` : bouton contour. */
  appearance?: 'link' | 'button';
  testId?: string;
  shareTitle?: string;
  className?: string;
}

export function ExportFileButton({ url, fallbackName, label, kind = 'json', appearance = 'button', testId, shareTitle, className }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState<ExportFile | null>(null);
  const running = useRef(false);

  const deliver = useCallback(async (f: ExportFile) => {
    const { outcome } = await deliverFile(f.blob, f.fileName, { title: shareTitle ?? f.fileName });
    if (outcome === 'needs-gesture') { setReady(f); return; }
    setReady(null);
    feedback(outcome, f.fileName);
  }, [shareTitle]);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true); setError(null); setReady(null);
    try {
      await deliver(await fetchExportFile(url, { kind, fallbackName }));
    } catch (e) {
      setError(e instanceof ExportError ? e.message : EXPORT_MESSAGES.SERVER_ERROR);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [url, kind, fallbackName, deliver]);

  const shareReady = useCallback(async () => {
    if (!ready) return;
    setError(null);
    try { await deliver(ready); } catch (e) { setError(e instanceof ExportError ? e.message : EXPORT_MESSAGES.SHARE_FAILED); }
  }, [ready, deliver]);

  const icon = busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Download className="w-3.5 h-3.5" aria-hidden />;
  const text = busy ? EXPORT_BUTTON_TEXTS.preparing : label;

  return (
    <span className={cn('inline-flex flex-col items-start gap-1 max-w-full', className)}>
      {appearance === 'link' ? (
        <button
          type="button" onClick={run} disabled={busy} aria-busy={busy} data-testid={testId}
          className="inline-flex min-h-11 sm:min-h-0 items-center gap-1 text-xs text-[color:var(--accent)] hover:underline disabled:opacity-60 disabled:no-underline"
        >
          {icon} {text}
        </button>
      ) : (
        <Button size="sm" variant="outline" type="button" onClick={run} disabled={busy} aria-busy={busy} data-testid={testId} className="min-h-11 sm:min-h-0">
          {icon} {text}
        </Button>
      )}
      {ready && (
        <span className="inline-flex flex-col items-start gap-1" role="status">
          <span className="text-xs text-[color:var(--text-secondary)]">{EXPORT_BUTTON_TEXTS.readyHint}</span>
          <Button size="sm" variant="default" type="button" onClick={shareReady} className="min-h-11 sm:min-h-0" data-testid={testId ? `${testId}-share` : undefined}>
            <Share2 className="w-3.5 h-3.5" aria-hidden /> {EXPORT_BUTTON_TEXTS.shareReady}
          </Button>
        </span>
      )}
      {error && <span role="alert" className="text-xs text-[color:var(--text-danger)] break-words">{error}</span>}
    </span>
  );
}
