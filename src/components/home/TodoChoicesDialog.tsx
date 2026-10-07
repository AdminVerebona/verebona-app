'use client';

/**
 * Choix d'une action « À traiter » ouverts depuis la mascotte — lot 32,
 * ticket MASC2, cas 1 (OPEN_CHOICES).
 *
 * Aucune logique de choix propre à la mascotte : la carte est `ActionCard`
 * (celle de la file, mêmes propositions, même « Autre ») et la résolution
 * `useToProcessResolution` (même route, même annulation, mêmes messages).
 * Les propositions sont affichées immédiatement (données de la file portées
 * par l'élément) ; un refus serveur (déjà traitée…) est expliqué.
 * Même composant sur desktop et mobile.
 */
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ActionCard, type ActionView } from '@/components/to-process/ActionCard';
import { useToProcessResolution } from '@/components/to-process/useToProcessResolution';
import type { MascotTodoItem } from '@/services/home/mascot/types';

interface Props {
  item: MascotTodoItem | null;
  onClose: () => void;
  /** Retrait immédiat de l'élément de la bulle (résolu, ou retiré par le serveur). */
  onRemoved: (todoId: string) => void;
  /** Le serveur a refusé : l'élément revient. */
  onRestored: (todoId: string) => void;
}

export function TodoChoicesDialog({ item, onClose, onRemoved, onRestored }: Props) {
  const { busyId, choose, openTarget } = useToProcessResolution({
    onRemove: (a) => onRemoved(a.publicId),
    onRollback: (a) => onRestored(a.publicId),
  });
  const action = item?.card as ActionView | undefined;

  return (
    <Dialog open={!!item} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{item?.title ?? ''}</DialogTitle>
          <DialogDescription>{item?.subtitle ?? ''}</DialogDescription>
        </DialogHeader>
        {action && (
          <ActionCard
            action={action}
            busy={busyId === action.publicId}
            onChoose={(a, p) => {
              onClose();
              void choose(a, p);
            }}
            onOpenTarget={(a) => {
              onClose();
              openTarget(a);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
