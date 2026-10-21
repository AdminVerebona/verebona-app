/**
 * Lot 75L — ZIP d'export (export brut standard / premium, dossiers avec
 * documents joints) : nom affiché + extension réelle, doublons « (2) », aucun
 * écrasement, aucun nom technique.
 */
import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';

vi.mock('@/lib/s3-client', () => ({
  S3_BUCKET: 'b',
  s3Client: {
    send: async (cmd: { input: { Key: string } }) => ({
      Body: (async function* body() { yield new TextEncoder().encode(`contenu ${cmd.input.Key}`); })(),
    }),
  },
}));

const { buildExportManifest } = await import('../export-manifest.service');
const { buildExportZip } = await import('../export-zip.service');

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const doc = (id: number, title: string | null, extra: Record<string, unknown> = {}) => ({
  id, s3Key: `verebona/u_1/a7f82c91-4d23-4b1e-9c55-0d2f3e4a5b6${id}.pdf`, s3Bucket: null,
  originalFilename: `FACT_2026_00${id}.pdf`, documentType: 'FACTURE', documentDate: null,
  description: null, retainedTitle: title, retainedFunctionCode: null, cilRubricCodes: null,
  mimeType: 'application/pdf', size: 10, isWebLink: false, webLinkUrl: null, webLinkTitle: null,
  substructureId: null, equipmentId: null, ...extra,
});

const snapshot = (documents: unknown[]) => ({
  id: 1, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison', status: 'EN_SERVICE',
  purchaseDate: null, purchasePriceCents: null, estimatedValueCents: null, generalCondition: null, notes: null,
  warrantyEndDate: null, mileageOrHours: null, lastMaintenanceDate: null, registrationNumber: null,
  address: null, city: null, postalCode: null, thumbnailUrl: null, description: null, keyCharacteristics: {},
  detailSections: { family: 'IMMOBILIER' }, equipmentList: [], documents, photos: [],
  substructures: [], equipments: [], events: [],
}) as never;

const DOCS = [
  doc(1, 'Facture entretien chaudière'),
  doc(2, 'Facture entretien chaudière'),
  doc(3, 'facture entretien chaudière.pdf'),
  doc(4, "Devis d'été", { mimeType: DOCX, originalFilename: 'devis.docx' }),
  doc(5, null),
];

async function names(isPremium: boolean) {
  const snap = snapshot(DOCS);
  const manifest = buildExportManifest('EXPORT_BRUT', snap, { requestedOutputs: ['ZIP'] });
  const zip = await JSZip.loadAsync(await buildExportZip(manifest, snap, null, isPremium));
  const files = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
  return { files, zip };
}

describe('L75L — ZIP : noms affichés, uniques, sans écrasement', () => {
  it('L75L-AC8 export brut standard (ZIP à plat)', async () => {
    const { files, zip } = await names(false);
    expect(files).toEqual([
      "Devis d'été.docx",
      'FACT_2026_005.pdf',
      'Facture entretien chaudière (2).pdf',
      'Facture entretien chaudière.pdf',
      'facture entretien chaudière (3).pdf',
    ]);
    // Chaque fichier garde son propre contenu (aucun écrasement).
    const contents = await Promise.all(files.map((f) => zip.file(f)!.async('string')));
    expect(new Set(contents).size).toBe(5);
  });

  it('L75L-AC8 export brut premium (ZIP structuré par type)', async () => {
    const { files } = await names(true);
    const docs = files.filter((f) => f.startsWith('documents/'));
    expect(docs).toHaveLength(5);
    expect(docs).toContain('documents/FACTURE/Facture entretien chaudière (2).pdf');
    expect(docs.join('|')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|\.pdf\.pdf|wordprocessingml/);
  });
});
