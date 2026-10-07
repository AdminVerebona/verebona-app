/**
 * Types de documents du SÉLECTEUR V1 — lot 32 (décision PO Q13).
 * Voir `src/app/api/document-types/route.ts`. Module PUR (client et serveur).
 */
import { DOCUMENT_TYPE_LIST } from '@/lib/document-type-constants';
import { resolveDocumentCode } from './document-codes';

export interface PickerDocumentTypeDto {
  id: number;
  code: string;
  label: string;
  description: string | null;
  displayOrder: number;
  isActive: true;
  /** `true` : lisible mais jamais proposé à la création. */
  hideFromPicker: boolean;
  status: 'ACTIVE' | 'LEGACY_SUPPORTED';
}

/**
 * Liste du référentiel du code, ordre d'affichage puis code. `ACTIVE` :
 * proposé à la création ; `LEGACY_SUPPORTED` : lisible (libellé d'un document
 * existant), jamais proposé.
 */
export function documentTypesForPicker(): PickerDocumentTypeDto[] {
  return [...DOCUMENT_TYPE_LIST]
    .sort((a, b) => (a.displayOrder - b.displayOrder) || a.code.localeCompare(b.code))
    .map((t, i) => {
      const status = resolveDocumentCode(t.code).status === 'ACTIVE' && !t.hideFromPicker ? 'ACTIVE' : 'LEGACY_SUPPORTED';
      return {
        id: i + 1,
        code: t.code,
        label: t.label,
        description: t.description ?? null,
        displayOrder: t.displayOrder,
        isActive: true as const,
        hideFromPicker: status !== 'ACTIVE',
        status,
      };
    });
}
