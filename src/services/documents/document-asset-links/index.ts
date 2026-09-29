/**
 * Relation N-N canonique document ↔ bien — CDC 15 X-01, §12, T1-05 ; D-11.
 * Voir la migration 0221 (table, index, déclencheur LEGACY_COLUMN).
 */
export * from './types';
export {
  linkDocumentToAsset,
  unlinkDocument,
  listDocumentAssets,
  listAssetDocuments,
  DocumentLinkOwnershipError,
  type LinkDocumentInput,
  type LinkOutcome,
  type UnlinkInput,
} from './document-asset-links.service';
