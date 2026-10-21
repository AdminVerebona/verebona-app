/**
 * Lot 75L — BUG P1 « Téléchargement des documents : utiliser le nom affiché
 * dans Verebona ».
 *
 * Règle commune (`src/lib/download-filename.ts`) : nom affiché
 * (`displayDocumentTitle`) + extension du format réel, sans double extension,
 * repli sur le nom d'origine ; seuls les caractères refusés par Windows/macOS
 * sont retirés (accents, apostrophes, espaces conservés) ; Content-Disposition
 * `filename*` UTF-8 + `filename` ASCII ; noms uniques « (2) » dans les ZIP.
 */
import { describe, it, expect } from 'vitest';
import {
  downloadFilename, contentDisposition, asciiFallback, makeUniqueNamer, realExtension,
} from '@/lib/download-filename';
import { displayDocumentTitle } from '@/lib/documents/document-title-rules';

const UUID_KEY = 'verebona/u_12/a7f82c91-4d23-4b1e-9c55-0d2f3e4a5b6c.pdf';

describe('L75L — nom téléchargé = nom affiché dans Verebona', () => {
  it('L75L-AC1 exemple du ticket : titre métier + extension réelle', () => {
    expect(downloadFilename({
      retainedTitle: 'Facture entretien chaudière', originalFilename: 'FACT_2026_001.pdf',
      filename: 'a7f82c91-4d23-4b1e-9c55-0d2f3e4a5b6c.pdf', s3Key: UUID_KEY, mimeType: 'application/pdf',
    })).toBe('Facture entretien chaudière.pdf');
  });

  it('L75L-AC2 aucun UUID : titre technique écarté comme à l’écran (repli nom d’origine)', () => {
    const f = {
      retainedTitle: 'a7f82c91-4d23-4b1e-9c55-0d2f3e4a5b6c', originalFilename: 'Bail signé.pdf',
      filename: 'a7f82c91-4d23-4b1e-9c55-0d2f3e4a5b6c.pdf', s3Key: UUID_KEY, mimeType: 'application/pdf',
    };
    expect(displayDocumentTitle(f)).toBe('Bail signé.pdf');
    expect(downloadFilename(f)).toBe('Bail signé.pdf');
    expect(downloadFilename(f)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('L75L-AC3 renommage pris en compte (titre lu à chaque appel, aucun état)', () => {
    const f = { retainedTitle: 'Ancien nom', originalFilename: 'scan.pdf', mimeType: 'application/pdf' };
    expect(downloadFilename(f)).toBe('Ancien nom.pdf');
    expect(downloadFilename({ ...f, retainedTitle: 'Nouveau nom' })).toBe('Nouveau nom.pdf');
  });

  it('L75L-AC4 document historique sans titre : nom d’origine conservé', () => {
    expect(downloadFilename({ retainedTitle: null, originalFilename: 'FACT_2026_001.pdf', mimeType: 'application/pdf' }))
      .toBe('FACT_2026_001.pdf');
    expect(downloadFilename({ originalFilename: null, filename: null, mimeType: 'application/pdf' })).toBe('document.pdf');
  });

  it('L75L-AC5 extensions correctes et jamais dupliquées', () => {
    const pdf = { originalFilename: 'x.pdf', mimeType: 'application/pdf' };
    expect(downloadFilename({ ...pdf, retainedTitle: 'Facture.pdf' })).toBe('Facture.pdf');
    expect(downloadFilename({ ...pdf, retainedTitle: 'Facture.PDF.pdf' })).toBe('Facture.pdf');
    expect(downloadFilename({ ...pdf, retainedTitle: 'Facture.pdf ' })).toBe('Facture.pdf');
    // Un point dans le titre n'est pas une extension.
    expect(downloadFilename({ ...pdf, retainedTitle: 'Rapport v1.2' })).toBe('Rapport v1.2.pdf');
    expect(downloadFilename({ ...pdf, retainedTitle: 'Facture n° 12.2026' })).toBe('Facture n° 12.2026.pdf');
    // Format réel : MIME du fichier stocké, alias du nom d'origine respecté.
    expect(downloadFilename({ retainedTitle: 'Photo façade', originalFilename: 'IMG.JPEG', mimeType: 'image/jpeg' })).toBe('Photo façade.jpeg');
    expect(downloadFilename({ retainedTitle: 'Photo façade', originalFilename: 'IMG.heic', mimeType: 'image/jpeg' })).toBe('Photo façade.jpg');
    expect(downloadFilename({ retainedTitle: 'Devis', originalFilename: 'devis', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBe('Devis.docx');
    expect(downloadFilename({ retainedTitle: 'Tableau', originalFilename: 'T.xlsx', mimeType: 'application/octet-stream' })).toBe('Tableau.xlsx');
    expect(realExtension({ originalFilename: 'notes', mimeType: null })).toBeNull();
    expect(downloadFilename({ retainedTitle: 'Notes', originalFilename: 'notes', mimeType: null })).toBe('Notes');
  });

  it('L75L-AC6 accents, apostrophes et espaces conservés ; seuls les caractères interdits retirés', () => {
    const f = { originalFilename: 'a.pdf', mimeType: 'application/pdf' };
    expect(downloadFilename({ ...f, retainedTitle: "Attestation d’assurance l'été  2026" })).toBe("Attestation d’assurance l'été 2026.pdf");
    expect(downloadFilename({ ...f, retainedTitle: 'Facture 01/2026 : EDF* "gaz" <x>|?' })).toBe('Facture 01-2026 EDF gaz x.pdf');
    expect(downloadFilename({ ...f, retainedTitle: 'Ligne1\nLigne2\t' })).toBe('Ligne1 Ligne2.pdf');
    // Windows : points/espaces finaux, noms réservés ; Unix : point initial.
    expect(downloadFilename({ ...f, retainedTitle: '...Caché...' })).toBe('Caché.pdf');
    expect(downloadFilename({ ...f, retainedTitle: 'CON' })).toBe('CON_.pdf');
    // Forme décomposée (macOS) recomposée.
    expect(downloadFilename({ ...f, retainedTitle: 'Ete\u0301 chaudie\u0300re' })).toBe('Et\u00e9 chaudi\u00e8re.pdf');
  });

  it('L75L-AC6b longueur bornée en octets UTF-8, extension préservée', () => {
    const n = downloadFilename({ retainedTitle: 'é'.repeat(400), originalFilename: 'a.pdf', mimeType: 'application/pdf' });
    expect(n.endsWith('.pdf')).toBe(true);
    expect(Buffer.byteLength(n, 'utf8')).toBeLessThanOrEqual(200);
  });

  it('L75L-AC7 Content-Disposition : filename* UTF-8 (RFC 5987/6266) + repli ASCII', () => {
    const h = contentDisposition("Attestation d’assurance (été).pdf");
    expect(h).toBe(`attachment; filename="Attestation d_assurance (ete).pdf"; filename*=UTF-8''Attestation%20d%E2%80%99assurance%20%28%C3%A9t%C3%A9%29.pdf`);
    expect(contentDisposition('a.pdf', 'inline')).toMatch(/^inline; filename="a\.pdf"; filename\*=UTF-8''a\.pdf$/);
    expect(asciiFallback('Œuvre "x" \\ y.pdf')).not.toMatch(/["\\]/);
    expect(decodeURIComponent(h.split("''")[1])).toBe("Attestation d’assurance (été).pdf");
  });

  it('L75L-AC8 téléchargements multiples : noms uniques « (2) », insensibles à la casse, sans écrasement', () => {
    const name = makeUniqueNamer();
    expect(name('Facture.pdf')).toBe('Facture.pdf');
    expect(name('facture.pdf')).toBe('facture (2).pdf');
    expect(name('Facture.pdf')).toBe('Facture (3).pdf');
    expect(name('Facture (2).pdf')).toBe('Facture (2) (2).pdf');
    expect(name('Notes')).toBe('Notes');
    expect(name('Notes')).toBe('Notes (2)');
    expect(name('Facture.pdf', 'documents/FACTURE')).toBe('documents/FACTURE/Facture.pdf');
    expect(name('Facture.pdf', 'documents/FACTURE')).toBe('documents/FACTURE/Facture (2).pdf');
  });
});

// ─── Audit des points d'entrée : tous passent par le mécanisme commun ───────
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('L75L-AC7 tous les points d’entrée utilisent la règle commune', () => {
  it.each([
    'src/app/api/files/[id]/download/route.ts',
    'src/app/api/files/[id]/view/route.ts',
    'src/app/api/files/[id]/proxy/route.ts',
    'src/services/export-zip.service.ts',
    'src/services/exports/v12/html/selection.ts',
    'src/services/exports/v12/storage.ts',
    'src/services/gdpr/export-content.ts',
    'src/services/export-upload.service.ts',
  ])('%s importe @/lib/download-filename', (f) => {
    expect(read(f)).toContain("from '@/lib/download-filename'");
  });

  it('aucune lecture de fichier ne répond `inline` sans nom', () => {
    for (const f of ['view', 'proxy', 'download']) {
      const src = read(`src/app/api/files/[id]/${f}/route.ts`);
      expect(src, f).not.toMatch(/(responseContentDisposition|disposition):\s*'inline'/);
    }
  });

  it('aperçu PDF du tiroir : cadre de même origine nommé, plus de blob: anonyme', () => {
    const src = read('src/components/assets/DocumentDrawer.tsx');
    const preview = src.slice(src.indexOf('function PdfPreview'), src.indexOf('function DocPreview'));
    expect(preview).not.toContain('createObjectURL');
    expect(preview).toContain('/api/files/${fileId}/proxy');
  });
});
