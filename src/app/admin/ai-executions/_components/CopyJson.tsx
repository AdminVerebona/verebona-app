"use client";

/**
 * Copie et téléchargement d'une exécution IA — BO, lot 32 (point 5).
 *
 * · « Copier » / « Télécharger .json » : l'export complet de l'exécution
 *   (lot 113T : fichier remis par `exportFileWithFeedback`, même parcours que
 *   tous les exports du BO)
 *   (`/api/admin/ai/executions/[id]/export`, construit côté serveur sur le
 *   même détail que le panneau : la rédaction en place s'applique) ;
 * · `CopyBlockButton` : copie d'un bloc JSON affiché (instantané d'entrée,
 *   sortie d'une étape), tel qu'il est affiché.
 */
import { useState } from 'react';
import { Check, Copy, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import { exportFileName } from '@/lib/files/export-file-name';
import { exportFileWithFeedback } from '@/components/admin/ExportFileButton';

/** Texte JSON lisible (indentation 2) ; une chaîne est copiée telle quelle. */
function jsonText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Contexte sans presse-papiers (http, permission refusée) : sélection + copie.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function exportUrl(callId: number): string {
  return `/api/admin/ai/executions/${callId}/export`;
}

/** Boutons d'en-tête du panneau : export complet copié ou téléchargé. */
export function ExecutionExportButtons({ callId }: { callId: number }) {
  const [busy, setBusy] = useState<'copy' | 'download' | null>(null);
  const [copied, setCopied] = useState(false);

  const charger = () => apiClient.get<unknown>(exportUrl(callId));

  const copier = async () => {
    setBusy('copy');
    try {
      const ok = await copyText(jsonText(await charger()));
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        toast.success('Exécution copiée (JSON).');
      } else toast.error('Copie impossible dans ce navigateur : utilisez « Télécharger .json ».');
    } catch {
      toast.error('Export indisponible.');
    } finally { setBusy(null); }
  };

  // Lot 113T : lecture contrôlée puis FICHIER remis (partage natif dans l'app,
  // Web Share sur mobile, téléchargement sur ordinateur) — plus de lien `blob:`
  // affiché en texte brut dans la vue de l'app iOS.
  const telecharger = async () => {
    setBusy('download');
    try {
      await exportFileWithFeedback(`${exportUrl(callId)}?download=1`, exportFileName('execution-ia-appel', callId), 'json');
    } finally { setBusy(null); }
  };

  return (
    <div className="flex items-center gap-1.5" data-testid="execution-export">
      <Button size="sm" variant="outline" onClick={copier} disabled={busy !== null}>
        {busy === 'copy' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : copied ? <Check className="w-3.5 h-3.5 mr-1.5" /> : <Copy className="w-3.5 h-3.5 mr-1.5" />}
        {copied ? 'Copié' : 'Copier'}
      </Button>
      <Button size="sm" variant="outline" onClick={telecharger} disabled={busy !== null}>
        {busy === 'download' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Download className="w-3.5 h-3.5 mr-1.5" />}
        {busy === 'download' ? 'Préparation…' : 'Télécharger .json'}
      </Button>
    </div>
  );
}

/** Petit bouton de copie d'un bloc affiché. */
export function CopyBlockButton({ value, label }: { value: unknown; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyText(jsonText(value))) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } else toast.error('Copie impossible dans ce navigateur.');
      }}
      aria-label={`Copier ${label}`}
      title={`Copier ${label}`}
      className="inline-flex h-6 w-6 items-center justify-center rounded text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-primary)]"
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}
