'use client';

/**
 * « Quitter le Duo » — second utilisateur d'un Premium Duo (AID-DUO-006, GAP-13).
 *
 * Le titulaire n'a pas ce bouton : il ne peut pas quitter son propre Duo
 * (le serveur le refuse aussi, 409 OWNER_CANNOT_LEAVE).
 */
import { useState } from 'react';
import { Loader2, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export function DuoLeaveButton() {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const handleLeave = async () => {
    setLeaving(true);
    try {
      await apiClient.post('/api/duo/leave', {});
      toast.success('Vous avez quitté le Duo.');
      setOpen(false);
      // Offre, droits et menus dépendent du rattachement : rechargement complet.
      window.location.assign('/mon-compte');
    } catch (error: unknown) {
      toast.error((error as { message?: string })?.message || 'Une erreur est survenue.');
    } finally {
      setLeaving(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="outline" className="gap-1 text-destructive hover:text-destructive" onClick={() => setOpen(true)}>
        <LogOut className="h-3.5 w-3.5" />
        Quitter le Duo
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Quitter le Duo ?</AlertDialogTitle>
            <AlertDialogDescription>
              Vous n&apos;aurez plus accès à l&apos;espace partagé du titulaire. Ses biens, documents et
              échéances ne sont pas supprimés et restent dans son espace. Vos demandes de déplacement ou de
              suppression en attente sont annulées. Pour revenir, le titulaire devra vous inviter à nouveau.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={leaving}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void handleLeave(); }}
              disabled={leaving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {leaving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Quitter le Duo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
