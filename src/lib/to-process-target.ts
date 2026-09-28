/**
 * Ouverture de la cible d'une action « À traiter » — resolver commun.
 *
 * CDC Mascotte ATP-005 : la mascotte et la page « À traiter » ouvrent la MÊME
 * cible, sur le MÊME champ. Une seule fonction, utilisée par les deux.
 *   · document, équipement, échéance : en tiroir, sans quitter l'écran ;
 *   · bien : sa page, sur le champ concerné ;
 *   · fournisseur : sa fiche `/fournisseurs/[id]` (ATP-03), à condition que
 *     le serveur ait résolu le VRAI fournisseur (`supplierId`) — `targetId`
 *     peut être l'identifiant d'une revue fournisseur. Sans fournisseur
 *     résolu, `onUnsupported` décide (repli sûr, jamais une fiche au hasard).
 */
import { openDrawer } from '@/lib/drawers';
import { supplierHref } from '@/lib/supplier-routes';

export interface ToProcessTargetRef {
  targetType: 'DOCUMENT' | 'ASSET' | 'EQUIPMENT' | 'AGENDA_ITEM' | 'SUPPLIER';
  targetId: number;
  targetPublicId?: string | null;
  field?: string | null;
  /** Fournisseur résolu côté serveur (cible SUPPLIER), sinon absent/null. */
  supplierId?: number | null;
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
    case 'SUPPLIER':
      if (ref.supplierId != null && Number.isSafeInteger(ref.supplierId) && ref.supplierId > 0) {
        nav.push(supplierHref(ref.supplierId));
        return;
      }
      break;
    default:
      break;
  }
  onUnsupported();
}
