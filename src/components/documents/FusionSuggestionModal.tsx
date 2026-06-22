"use client"

/**
 * FusionSuggestionModal — V4 Chantier 8
 * Apparaît après upload si un doublon est détecté.
 * Propose : Ignorer / Fusionner (supprimer l'ancien) / Remplacer (supprimer le nouveau)
 */

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FileText, Copy, ArrowRight, X, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { FusionCandidate } from '@/services/document-ai/fusion-detector';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  newFileId: number;
  newFilename: string;
  candidate: FusionCandidate;
  onAction: (action: 'dismiss' | 'merge' | 'replace') => void;
}

export function FusionSuggestionModal({ open, onOpenChange, newFileId, newFilename, candidate, onAction }: Props) {
  const [loading, setLoading] = useState(false);

  const handleAction = async (action: 'dismiss' | 'merge' | 'replace') => {
    setLoading(true);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('bearer_token') : null;
      const res = await fetch(`/api/documents/${newFileId}/fusion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, candidateFileId: candidate.fileId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Erreur lors de la fusion');
      }
      const labels: Record<string, string> = {
        dismiss: 'Suggestion ignorée',
        merge: 'Ancien document supprimé — fichier récent conservé',
        replace: 'Nouveau fichier supprimé — document existant conservé',
      };
      toast.success(labels[action]);
      onAction(action);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message ?? 'Erreur lors de l\'action de fusion');
    } finally {
      setLoading(false);
    }
  };

  const reasonLabel = candidate.reason === 'exact_duplicate'
    ? 'Doublon exact (même contenu)'
    : 'Doublon probable (même titre, bien et date)';

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <Copy className="w-4 h-4 text-amber-600" />
            </div>
            <AlertDialogTitle className="text-base">Document potentiellement en doublon</AlertDialogTitle>
          </div>
          <AlertDialogDescription className="text-sm">
            Le document que vous venez d&apos;uploader ressemble à un document existant.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 py-2">
          <Badge variant="outline" className="text-amber-600 border-amber-500/40 bg-amber-500/5">
            {reasonLabel}
          </Badge>

          {/* Comparison */}
          <div className="rounded-xl border bg-muted/20 p-3 space-y-3">
            {/* New file */}
            <div className="flex items-start gap-2">
              <div className="w-6 h-6 rounded bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <FileText className="w-3.5 h-3.5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">Nouveau fichier uploadé</p>
                <p className="text-sm font-medium truncate">{newFilename}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 px-2">
              <div className="flex-1 h-px bg-border" />
              <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
              <div className="flex-1 h-px bg-border" />
            </div>

            {/* Candidate */}
            <div className="flex items-start gap-2">
              <div className="w-6 h-6 rounded bg-muted flex items-center justify-center shrink-0 mt-0.5">
                <FileText className="w-3.5 h-3.5 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">Document existant</p>
                <p className="text-sm font-medium truncate">
                  {candidate.retainedTitle ?? candidate.originalFilename ?? `Document #${candidate.fileId}`}
                </p>
                {candidate.documentDate && (
                  <p className="text-xs text-muted-foreground">
                    {new Date(candidate.documentDate).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Actions explanation */}
          <div className="space-y-1.5 text-xs text-muted-foreground">
            <p><span className="font-semibold text-foreground">Fusionner</span> → supprimer l&apos;ancien, conserver le nouveau fichier</p>
            <p><span className="font-semibold text-foreground">Conserver l&apos;existant</span> → supprimer le nouveau fichier</p>
            <p><span className="font-semibold text-foreground">Ignorer</span> → conserver les deux documents séparément</p>
          </div>
        </div>

        <AlertDialogFooter className="flex-col sm:flex-row gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleAction('dismiss')}
            disabled={loading}
            className="sm:mr-auto"
          >
            <X className="w-3.5 h-3.5 mr-1.5" />
            Ignorer
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleAction('replace')}
            disabled={loading}
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
            Conserver l&apos;existant
          </Button>
          <Button
            size="sm"
            onClick={() => handleAction('merge')}
            disabled={loading}
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
            Fusionner
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
