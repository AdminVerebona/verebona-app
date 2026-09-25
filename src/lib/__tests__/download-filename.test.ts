/** Nom du fichier téléchargé : titre du document, accents conservés. */
import { describe, it, expect } from 'vitest';
import { contentDisposition, downloadFilename, asciiFallback } from '../download-filename';

describe('nom du fichier téléchargé', () => {
  it('prend le titre du document et l’extension du fichier', () => {
    expect(downloadFilename({ retainedTitle: 'Facture Béquille draisienne', originalFilename: 'scan_0042.PDF' }))
      .toBe('Facture Béquille draisienne.pdf');
  });
  it('déduit l’extension du type quand le nom d’origine n’en a pas', () => {
    expect(downloadFilename({ retainedTitle: 'Notice Chaudière', originalFilename: 'notice', mimeType: 'application/pdf' }))
      .toBe('Notice Chaudière.pdf');
  });
  it('n’ajoute pas deux fois l’extension', () => {
    expect(downloadFilename({ retainedTitle: 'Devis toiture.pdf', originalFilename: 'x.pdf' })).toBe('Devis toiture.pdf');
  });
  it('à défaut de titre, garde le nom d’origine lisible', () => {
    expect(downloadFilename({ retainedTitle: null, originalFilename: 'Facture électricité.pdf' })).toBe('Facture électricité.pdf');
  });
  it('retire ce que le système de fichiers refuse', () => {
    expect(downloadFilename({ retainedTitle: 'Contrat 2026/2027 : "Clio"', originalFilename: 'a.pdf' })).toBe('Contrat 2026 2027 Clio.pdf');
  });
});

describe('en-tête Content-Disposition', () => {
  it('porte la version UTF-8 et un repli ASCII', () => {
    const h = contentDisposition('Facture Béquille draisienne.pdf');
    expect(h).toBe(`attachment; filename="Facture Bequille draisienne.pdf"; filename*=UTF-8''Facture%20B%C3%A9quille%20draisienne.pdf`);
  });
  it('le repli ne contient jamais de guillemet', () => {
    expect(asciiFallback('a"b')).toBe('a_b');
  });
});
