"use client"

import { LogOut, X } from 'lucide-react';
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog';
import { SegmentedActionBar } from '@/components/ui/segmented-action-bar';

interface ConfirmLogoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Le vrai logout (celui de TopBar/DashboardLayout). */
  onConfirm: () => void | Promise<void>;
}

/** Confirmation avant déconnexion — toute déconnexion passe par elle. */
export function ConfirmLogoutDialog({ open, onOpenChange, onConfirm }: ConfirmLogoutDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-[380px] rounded-[18px] p-6">
        <div className="w-11 h-11 rounded-[14px] mx-auto mb-3.5 flex items-center justify-center bg-[color:var(--accent-soft)] border border-blue-500/30 text-[color:var(--accent)]">
          <LogOut className="w-5 h-5" />
        </div>
        <p className="text-[15.5px] font-semibold text-center text-[color:var(--text-primary)] mb-1.5">Se déconnecter ?</p>
        <p className="text-[12.5px] text-center leading-relaxed text-[color:var(--text-muted)] mb-4.5">
          Vos biens et documents restent en sécurité. Vous pourrez vous reconnecter à tout moment.
        </p>
        <SegmentedActionBar
          items={[
            { icon: X, label: 'Annuler', onClick: () => onOpenChange(false) },
            { icon: LogOut, label: 'Se déconnecter', tone: 'danger', onClick: async () => { onOpenChange(false); await onConfirm(); } },
          ]}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}
