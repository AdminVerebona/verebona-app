/**
 * Ouverture de la cible d'une action « À traiter » — resolver commun.
 *
 * CDC Mascotte ATP-005 : la mascotte et la page « À traiter » ouvrent la MÊME
 * cible, sur le MÊME champ. Une seule fonction, utilisée par les deux.
 *   · document, équipement, échéance : en tiroir, sans quitter l'écran ;
 *   · bien : sa page, sur le champ concerné ;
 *   · fournisseur : pas encore d'écran propre — `onUnsupported` décide.
 */
import { openDrawer } from '@/lib/drawers';

export interface ToProcessTargetRef {
  targetType: 'DOCUMENT' | 'ASSET' | 'EQUIPMENT' | 'AGENDA_ITEM' | 'SUPPLIER';
  targetId: number;
  targetPublicId?: string | null;
  field?: string | null;
}

export function openToProcessTarget(
  ref: ToProcessTargetRef,
  nav: { push: (href: string) => void },
  onUnsupported: () => void,
): void {
  switch (ref.targetType) {
    case 'DOCUMENT':
      openDrawer({ kind: 'document', id: ref.targetId });
      return;
    case 'EQUIPMENT':
      openDrawer({ kind: 'equipement', id: ref.targetId });
      return;
    case 'AGENDA_ITEM':
      openDrawer({ kind: 'echeance', id: ref.targetId, initialMode: 'edit' });
      return;
    case 'ASSET':
      if (ref.targetPublicId) {
        nav.push(`/assets/${ref.targetPublicId}?field=${encodeURIComponent(ref.field ?? '')}`);
        return;
      }
      break;
    default:
      break;
  }
  onUnsupported();
}
