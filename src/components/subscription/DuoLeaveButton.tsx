'use client';

/**
 * « Quitter le Duo » — second utilisateur d'un Premium Duo (AID-DUO-006, GAP-13).
 *
 * Le titulaire n'a pas ce bouton : il ne peut pas quitter son propre Duo
 * (le serveur le refuse aussi, 409 OWNER_CANNOT_LEAVE).
 *
 * Lot 72D (décisions PO Q2, Q16) : « Quitter l'espace » — les données
 * appartiennent au compte partagé et y restent ; avant de confirmer, l'export
 * existant des biens est proposé (aucune copie automatique). Même composant
 * sur ordinateur et sur mobile.
 */
import { useState } from 'react';
import Link from 'next/link';
import { Download, Loader2, LogOut } from 'lucide-react';
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
      toast.success('Vous avez quitté l’espace Premium Duo.');
      setOpen(false);
      // Offre, droits et menus dépendent du rattachement : rechargement complet.
      // Lot 72D : session rouverte par le serveur sur un autre espace (ou sans espace).
      window.location.assign('/accueil');
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
        Quitter l&apos;espace
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Quitter l&apos;espace Premium Duo ?</AlertDialogTitle>
            <AlertDialogDescription>
              Vous n&apos;aurez plus accès à cet espace partagé. Ses biens, documents et échéances — y compris
              ceux que vous y avez ajoutés — ne sont pas supprimés : ils restent dans l&apos;espace du titulaire.
              Votre identité Verebona et vos autres espaces sont conservés. Pour revenir, le titulaire devra vous
              inviter à nouveau.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="text-sm text-[color:var(--text-muted)]">
            Vous souhaitez garder une copie de certains biens ? Exportez-les avant de partir, depuis la fiche du bien.
          </p>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <Link href="/assets" onClick={() => setOpen(false)}>
              <Download className="mr-1.5 h-4 w-4" />
              Exporter mes biens d&apos;abord
            </Link>
          </Button>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={leaving}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void handleLeave(); }}
              disabled={leaving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {leaving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Quitter l&apos;espace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
