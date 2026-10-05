/**
 * Export des données brutes d'un bien — Centre d'aide GAP-14 / AID-TRANSFER-005.
 *
 * Contenu réel du ZIP, tel que l'article le décrit :
 *   - `recap_donnees.txt` à la racine ;
 *   - `documents/<type de document>/<titre>.<extension>` ;
 *   - `photos/photo_1_principale.jpg`, `photo_2.jpg`… si les photos sont demandées ;
 *   - uniquement les documents sélectionnés dans le tiroir ;
 *   - liens web cités dans le récapitulatif, jamais téléchargés ;
 *   - aucun PDF, aucun JSON.
 */
import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';

vi.mock('@/lib/s3-client', () => ({
  S3_BUCKET: 'b',
  s3Client: {
    send: async () => ({
      Body: (async function* body() { yield new TextEncoder().encode('contenu'); })(),
    }),
  },
}));

const { buildExportManifest } = await import('../export-manifest.service');
const { buildExportZip } = await import('../export-zip.service');
const { isPremiumPlan } = await import('@/types/domain');

const doc = (id: number, title: string, documentType: string, extra: Record<string, unknown> = {}) => ({
  id, s3Key: `k${id}`, s3Bucket: null, originalFilename: `${title}.pdf`, documentType, documentDate: null,
  description: null, retainedTitle: title, retainedFunctionCode: null, cilRubricCodes: null,
  mimeType: 'application/pdf', size: 10, isWebLink: false, webLinkUrl: null, webLinkTitle: null,
  substructureId: null, equipmentId: null, ...extra,
});

const snapshot = {
  id: 1, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison', status: 'EN_SERVICE',
  purchaseDate: null, purchasePriceCents: null, estimatedValueCents: null, generalCondition: null, notes: null,
  warrantyEndDate: null, mileageOrHours: null, lastMaintenanceDate: null, registrationNumber: null,
  address: null, city: null, postalCode: null, thumbnailUrl: null, description: null, keyCharacteristics: {},
  detailSections: { family: 'IMMOBILIER' }, equipmentList: [],
  documents: [
    doc(1, 'Facture chaudière', 'FACTURE'),
    doc(2, 'DPE 2024', 'DPE'),
    doc(3, 'Notice', 'NOTICE'),
    doc(4, 'Site du fabricant', 'LIEN', { isWebLink: true, s3Key: null, webLinkUrl: 'https://exemple.fr', webLinkTitle: 'Fabricant' }),
  ],
  photos: [
    { id: 7, fileId: null, s3Key: 'p7', s3Bucket: null, mimeType: 'image/jpeg', isPrimary: false, displayOrder: 2 },
    { id: 8, fileId: null, s3Key: 'p8', s3Bucket: null, mimeType: 'image/jpeg', isPrimary: true, displayOrder: 1 },
  ],
  substructures: [], equipments: [], events: [],
} as never;

async function files(options: Record<string, unknown>) {
  const manifest = buildExportManifest('EXPORT_BRUT', snapshot, { requestedOutputs: ['ZIP'], ...options });
  const zip = await JSZip.loadAsync(await buildExportZip(manifest, snapshot, null, true));
  return { names: Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort(), zip };
}

describe('export brut (ZIP structuré)', () => {
  it('toute offre connue reçoit le ZIP structuré', () => {
    for (const p of ['STANDARD', 'PREMIUM', 'PREMIUM_DUO']) expect(isPremiumPlan(p)).toBe(true);
  });

  it('récapitulatif, documents par type, photos numérotées ; ni PDF ni JSON', async () => {
    const { names, zip } = await files({ includePhotos: true });
    expect(names).toEqual([
      'documents/DPE/DPE 2024.pdf',
      'documents/FACTURE/Facture chaudière.pdf',
      'documents/NOTICE/Notice.pdf',
      'photos/photo_1_principale.jpg',
      'photos/photo_2.jpg',
      'recap_donnees.txt',
    ]);
    const recap = await zip.file('recap_donnees.txt')!.async('string');
    expect(recap).toContain('EXPORT DONNÉES BRUTES — VEREBONA');
    expect(recap).toContain('LIENS WEB (1)');
    expect(recap).toContain('https://exemple.fr');
    expect(names.some((n) => n.endsWith('.json'))).toBe(false);
  });

  it('respecte la sélection du tiroir : documents choisis, pas de photos si non demandées', async () => {
    const { names } = await files({ customDocIds: [2], includePhotos: false });
    expect(names).toEqual(['documents/DPE/DPE 2024.pdf', 'recap_donnees.txt']);
  });

  it('tout décoché : seul le récapitulatif', async () => {
    const { names } = await files({ customDocIds: [], includePhotos: false });
    expect(names).toEqual(['recap_donnees.txt']);
  });
});
