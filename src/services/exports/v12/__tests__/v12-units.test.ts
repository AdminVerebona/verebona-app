/**
 * Briques du moteur V12 : statuts et DTO d'historique (§2.1, DRH-003/006/008/010),
 * noms de fichiers (§14.2, ZIP-007), seuils (§6.3), carte des pages et
 * placement des pages sources (ANN-PDF-001/003/005), heure de Paris,
 * codes d'erreur (§17.3, §21).
 */
import { describe, it, expect } from 'vitest';
import { normalizeGenerationStatus, legacyStatus, toGenerationDto, outputKeys, PARTIAL_MESSAGE } from '../generation/status';
import { deliverableBaseName, fileSegment } from '../naming';
import { evaluateThresholds, estimatePages } from '../thresholds';
import { computePageMap } from '../render/render-pdf';
import { placeInFrame } from '../render/annexes';
import { parisDate, parisIso } from '../generation/clock';
import { ExportGenerationError, asGenerationError } from '../generation/errors';
import { generationReference, retryDelayMs } from '../generation/job';
import { attachmentDisposition } from '../storage';
import { makeZipNamer } from '../html/selection';

describe('Statuts de génération', () => {
  it('anciens statuts → V12 ; expiration constatée à la lecture', () => {
    const now = new Date('2026-09-28T10:00:00Z');
    expect(normalizeGenerationStatus('pending')).toBe('queued');
    expect(normalizeGenerationStatus('error')).toBe('failed');
    expect(normalizeGenerationStatus('ready', '2026-09-27T00:00:00Z', now)).toBe('expired');
    expect(normalizeGenerationStatus('partial', '2026-10-27T00:00:00Z', now)).toBe('partial');
    expect(legacyStatus('queued')).toBe('pending');
    expect(legacyStatus('partial')).toBe('ready');
    expect(legacyStatus('failed')).toBe('error');
  });

  it('DTO : liens vers /download (jamais d’URL signée), auteur, message partiel, pas de détail technique', () => {
    const row = {
      id: 7, publicId: '00000000-0000-4000-8000-000000000007', exportType: 'CIL_REGLEMENTAIRE', status: 'partial', userId: 2,
      outputPayload: JSON.stringify({ pdfS3Key: 'exports/1/2/7/a.pdf', zipS3Key: 'exports/1/2/7/a.zip' }),
      metricsJson: { 'items.excluded_count': 2, 'generation.pdf_pages': 14 }, createdAt: new Date(), expiresAt: new Date(Date.now() + 1e9),
      errorPayload: JSON.stringify({ technicalMessage: 'secret' }),
    };
    const dto = toGenerationDto(row, { authorName: 'Claire Martin' });
    expect(dto).toMatchObject({
      exportType: 'CIL', status: 'ready', generationStatus: 'partial', outputFormat: 'ZIP', partialMessage: PARTIAL_MESSAGE,
      excludedCount: 2, pageCount: 14, createdBy: { userId: 2, name: 'Claire Martin' },
      downloadUrl: '/api/export-generations/00000000-0000-4000-8000-000000000007/download?file=pdf',
      downloadZipUrl: '/api/export-generations/00000000-0000-4000-8000-000000000007/download?file=zip',
      errorMessage: null,
    });
    expect(JSON.stringify(dto)).not.toContain('secret');
    expect(JSON.stringify(dto)).not.toContain('exports/1/2/7');
  });

  it('échec : message générique du code (§17.3)', () => {
    const dto = toGenerationDto({ id: 1, publicId: 'p', exportType: 'VENTE', status: 'failed', userId: 1, createdAt: new Date(), errorCode: 'STORAGE_ERROR' });
    expect(dto.errorMessage).toBe('La génération a échoué lors du stockage.');
    expect(dto.downloadUrl).toBeNull();
  });

  it('clés de stockage lues dans output_payload (format historique compris)', () => {
    expect(outputKeys('{"pdfS3Key":"a","pdfSize":3}')).toEqual({ pdf: 'a', zip: null, pdfSize: 3, zipSize: null });
    expect(outputKeys('pas du json')).toEqual({ pdf: null, zip: null, pdfSize: null, zipSize: null });
  });
});

describe('Noms de fichiers (§14.2, ZIP-006/007)', () => {
  it('Verebona_[Type]_[Nom]_[date]', () => {
    expect(deliverableBaseName('CIL', 'Appartement Lyon 2ᵉ', '2026-09-28')).toBe('Verebona_CIL_Appartement-Lyon-2e_2026-09-28');
    expect(deliverableBaseName('ASSURANCE_SINISTRE', 'Cœur d’Ainay / T3', '2026-09-28')).toBe('Verebona_Assurance-sinistre_Coeur-d-Ainay-T3_2026-09-28');
    expect(fileSegment('***')).toBe('bien');
  });
  it('collisions suffixées _2, _3 ; caractères normalisés', () => {
    const name = makeZipNamer();
    expect(name({ id: 1, fileName: 'Facture Été.PDF' })).toBe('documents/facture-ete.pdf');
    expect(name({ id: 2, fileName: 'facture ete.pdf' })).toBe('documents/facture-ete_2.pdf');
    expect(name({ id: 3, fileName: 'Facture-ete.pdf' })).toBe('documents/facture-ete_3.pdf');
    expect(name({ id: 4, fileName: 'ﾃｽﾄ.pdf' })).toBe('documents/document-4.pdf');
  });
  it('Content-Disposition sûr (ASCII + UTF-8)', () => {
    expect(attachmentDisposition('Dossier "Été".pdf')).toBe(`attachment; filename="Dossier __t__.pdf"; filename*=UTF-8''Dossier%20%22%C3%89t%C3%A9%22.pdf`);
  });
});

describe('Seuils (§6.3)', () => {
  it('avertissements et blocages', () => {
    expect(evaluateThresholds({ integratedDocuments: 21, photos: 10, totalBytes: 60e6, pages: 50 }).warnings.map((w) => w.code)).toEqual(['DOCS_WARNING', 'SIZE_WARNING']);
    const b = evaluateThresholds({ integratedDocuments: 51, photos: 101, totalBytes: 160 * 1024 * 1024, pages: 301 });
    expect(b.blocking.map((x) => x.code)).toEqual(['DOCS_BLOCKING', 'SIZE_BLOCKING', 'PAGES_BLOCKING', 'PHOTOS_BLOCKING']);
    expect(estimatePages({ integratedPdfBytes: [300 * 1024, 0], integratedImages: 2, photos: 9 })).toBe(5 + 3 + 3 + 2);
  });
});

describe('Pagination et annexes (ANN-PDF-001/003/005)', () => {
  it('début de chaque annexe déduit du total (annexes puis page Références)', () => {
    expect(computePageMap(15, [{ annexRef: 'A1', pageCount: 1 }, { annexRef: 'A2', pageCount: 1 }, { annexRef: 'A3', pageCount: 6 }]))
      .toEqual({ total: 15, annexStart: { A1: 7, A2: 8, A3: 9 } });
    expect(computePageMap(4, [])).toEqual({ total: 4, annexStart: {} });
  });

  it('page source placée dans le cadre : ratio conservé, centrée, rotation respectée', () => {
    const frame = { top: 70, left: 44, width: 706, height: 963 };
    const pw = 595.92;
    const k = pw / 793.7007874;
    const portrait = placeInFrame({ pageWidthPt: pw, pageHeightPt: 842.88, frame, srcWidth: 595, srcHeight: 842, rotation: 0 });
    expect(portrait.rotate).toBe(0);
    // Tient dans le cadre (marge intérieure de 6 px).
    expect(595 * portrait.scale).toBeLessThanOrEqual((706 - 12) * k + 1e-6);
    expect(842 * portrait.scale).toBeLessThanOrEqual((963 - 12) * k + 1e-6);
    const landscape = placeInFrame({ pageWidthPt: pw, pageHeightPt: 842.88, frame, srcWidth: 842, srcHeight: 595, rotation: 0 });
    // Largeur limitante, centrage vertical.
    expect(842 * landscape.scale).toBeCloseTo((706 - 12) * k, 5);
    const rotated = placeInFrame({ pageWidthPt: pw, pageHeightPt: 842.88, frame, srcWidth: 842, srcHeight: 595, rotation: 90 });
    expect(rotated.rotate).toBe(-90);
    // Affichée en portrait : hauteur affichée = largeur source.
    expect(842 * rotated.scale).toBeLessThanOrEqual((963 - 12) * k + 1e-6);
  });
});

describe('Heure de Paris, références, erreurs', () => {
  it('date et ISO avec décalage (été / hiver)', () => {
    expect(parisIso(new Date('2026-09-28T07:14:00Z'))).toBe('2026-09-28T09:14:00+02:00');
    expect(parisIso(new Date('2026-01-10T23:30:00Z'))).toBe('2026-01-11T00:30:00+01:00');
    expect(parisDate(new Date('2026-01-10T23:30:00Z'))).toBe('2026-01-11');
  });

  it('référence imprimée et délais de nouvelle tentative', () => {
    expect(generationReference('CIL', 123, '2026-09-28')).toBe('VBN-CIL-20260928-000123');
    expect([1, 2, 3].map(retryDelayMs)).toEqual([30_000, 120_000, 480_000]);
  });

  it('codes distincts par étape, catégorie, message sûr', () => {
    expect(asGenerationError(new Error('x'), 'store_result')).toMatchObject({ code: 'STORAGE_ERROR', category: 'storage' });
    expect(asGenerationError(new Error('x'), 'render_html').code).toBe('TEMPLATE_ERROR');
    expect(asGenerationError(Object.assign(new Error('t'), { exportErrorCode: 'RENDER_TIMEOUT' }), 'render_pdf')).toMatchObject({ code: 'RENDER_TIMEOUT', permanent: true });
    const e = new ExportGenerationError('FILE_UNAVAILABLE', 'resolve_files', 'S3 500');
    expect(e.permanent).toBe(false);
    expect(e.safeMessage).toBe('Un fichier sélectionné n’est plus disponible.');
  });
});

describe('limitation de débit des demandes de génération', () => {
  it('429 en français avec Retry-After au-delà du quota par utilisateur', async () => {
    const { exportRateLimitResponse } = await import('../generation/rate-limit');
    const userId = 987_654;
    let blocked = null;
    for (let i = 0; i < 50 && !blocked; i++) blocked = exportRateLimitResponse(userId);
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
    expect(Number(blocked!.headers.get('Retry-After'))).toBeGreaterThan(0);
    const body = await blocked!.json();
    expect(body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(body.message).toMatch(/Patientez/);
    // Quota propre à chaque utilisateur.
    expect(exportRateLimitResponse(userId + 1)).toBeNull();
  });
});

describe('inspection isolée des PDF sources (worker)', () => {
  it('page blanche (sans contenu) acceptée ; fichier illisible → corrupted ; worker absent → corrupted', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { PDFDocument } = await import('pdf-lib');
    const { inspectPdfFile } = await import('../render/annexes');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v12-insp-'));
    try {
      const d = await PDFDocument.create();
      d.addPage([595, 842]);
      d.addPage([842, 595]).drawText('contenu');
      fs.writeFileSync(path.join(dir, 'blanc.pdf'), await d.save());
      expect(await inspectPdfFile(path.join(dir, 'blanc.pdf'), { strict: true })).toMatchObject({
        status: 'ok', pages: 2, boxes: [{ width: 595, height: 842, rotation: 0 }, { width: 842, height: 595, rotation: 0 }],
      });
      fs.writeFileSync(path.join(dir, 'casse.pdf'), '%PDF-1.7\nrien');
      expect((await inspectPdfFile(path.join(dir, 'casse.pdf'), { strict: true })).status).toBe('corrupted');
      process.env.EXPORTS_V12_ANNEX_WORKER = path.join(dir, 'absent.cjs');
      expect((await inspectPdfFile(path.join(dir, 'blanc.pdf'), { strict: true })).status).toBe('corrupted');
    } finally {
      delete process.env.EXPORTS_V12_ANNEX_WORKER;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
