"use client"

/**
 * Activation globale d'un modèle d'export (dossier V12).
 *
 * Seule mutation admise sur un modèle. Effet immédiat : un modèle désactivé
 * n'est plus proposé ni généré pour aucun compte ; les exports déjà produits
 * restent intacts. La DÉSACTIVATION demande une confirmation explicite ;
 * l'activation est directe. État relu depuis le serveur après l'action.
 */
import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
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
import { toast } from 'sonner';

export function ExportTemplateActiveToggle({
  code,
  label,
  isActive,
  onChanged,
}: {
  code: string;
  label: string;
  isActive: boolean;
  onChanged: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const target = !isActive;

  const apply = async () => {
    setSaving(true);
    try {
      const response = await fetch(`/api/admin/export-templates/${encodeURIComponent(code)}`, {
        credentials: 'include',
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: target }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || payload.error || `Erreur ${response.status}`);
      toast.success(target ? 'Modèle activé' : 'Modèle désactivé');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setSaving(false);
      setConfirmOpen(false);
      onChanged();
    }
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Switch
          checked={isActive}
          disabled={saving}
          // Désactiver : confirmation explicite ; activer : direct.
          onCheckedChange={() => (isActive ? setConfirmOpen(true) : void apply())}
          aria-label={isActive ? `Désactiver ${label}` : `Activer ${label}`}
        />
        <span className="text-sm text-muted-foreground">{isActive ? 'Actif' : 'Inactif'}</span>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Désactiver « ${label} » ?`}</AlertDialogTitle>
            <AlertDialogDescription>
              Ce dossier ne sera plus proposé ni généré, pour tous les comptes, dès maintenant. Les exports déjà
              produits ne sont pas affectés. Action journalisée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={apply} disabled={saving}>Désactiver</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
