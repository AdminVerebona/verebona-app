"use client"

/**
 * Activation globale d'un modèle d'export — CDC Back-Office V1 EXP-003,
 * EXP-004, UX-002.
 *
 * Seule mutation admise sur un modèle d'export. Effet immédiat : un modèle
 * désactivé n'est plus proposé à la génération ; les exports déjà produits
 * restent intacts (EXP-005). Confirmation explicite avant l'appel, état relu
 * depuis le serveur après l'action (ERR-003).
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
  templateId,
  label,
  isActive,
  onChanged,
}: {
  templateId: number;
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
      const response = await fetch(`/api/admin/export-templates/${templateId}`, {
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
          onCheckedChange={() => setConfirmOpen(true)}
          aria-label={isActive ? `Désactiver ${label}` : `Activer ${label}`}
        />
        <span className="text-sm text-muted-foreground">{isActive ? 'Actif' : 'Inactif'}</span>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{target ? `Activer « ${label} » ?` : `Désactiver « ${label} » ?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {target
                ? 'Le modèle sera de nouveau proposé pour la génération des exports, pour tous les comptes.'
                : "Le modèle ne sera plus proposé pour la génération des exports, pour tous les comptes, dès maintenant. Les exports déjà produits ne sont pas affectés."}
              {' '}Action journalisée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={apply} disabled={saving}>
              {target ? 'Activer' : 'Désactiver'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
