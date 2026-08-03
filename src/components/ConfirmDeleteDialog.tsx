"use client"

import { Trash2, X } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
} from '@/components/ui/alert-dialog';
import { SegmentedActionBar } from '@/components/ui/segmented-action-bar';

interface ConfirmDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Nom de l'élément, affiché entre guillemets français. */
  label: string;
  onConfirm: () => void | Promise<void>;
  /** Phrase de conséquence ; défaut adapté aux biens/documents/échéances. */
  description?: string;
}

/**
 * Confirmation de suppression — OBLIGATOIRE avant toute suppression
 * (bien, document, événement, élément à traiter).
 */
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  label,
  onConfirm,
  description = 'Cette action est définitive. Les documents et échéances liés ne seront plus suivis.',
}: ConfirmDeleteDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-[380px] rounded-[18px] p-6">
        <div className="w-11 h-11 rounded-[14px] mx-auto mb-3.5 flex items-center justify-center bg-red-500/15 border border-red-500/30 text-red-400">
          <Trash2 className="w-5 h-5" />
        </div>
        <p className="text-[15.5px] font-semibold text-center text-[color:var(--text-primary)] mb-1.5">
          Supprimer «&nbsp;{label}&nbsp;» ?
        </p>
        <p className="text-[12.5px] text-center leading-relaxed text-[color:var(--text-muted)] mb-4.5">
          {description}
        </p>
        <SegmentedActionBar
          items={[
            { icon: X, label: 'Annuler', onClick: () => onOpenChange(false) },
            {
              icon: Trash2,
              label: 'Supprimer',
              tone: 'danger',
              onClick: async () => {
                await onConfirm();
                onOpenChange(false);
              },
            },
          ]}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}
