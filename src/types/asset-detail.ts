export interface AssetDetail {
  id: number;
  name: string;
  category: string;
  subtype?: string | null;
  status: string;
  notes?: string | null;
  thumbnailUrl?: string | null;
  /** Lot 59 (point 2) : vignette affichée — choisie, sinon la première photo du bien. */
  effectiveThumbnailUrl?: string | null;
  assetTypeId?: number | null;
  assetTypeSubcategoryId?: number | null;
  duoId?: number | null;
  lockState: 'NONE' | 'PENDING_MOVE' | 'PENDING_DELETE';
  keyCharacteristics?: string | null;
  address?: string | null;
  city?: string | null;
  postalCode?: string | null;
  registrationNumber?: string | null;
  substructures: Array<{ id: number; name: string; orderIndex: number }>;
  equipments: Array<{ id: number; name: string; substructureId?: number | null; archivedAt?: string | null }>;
}
