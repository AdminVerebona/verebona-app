/**
 * Limites de dépôt — CDC 2 §4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE CLIENT ANNONCE, LE SERVEUR TRANCHE
 *
 * Les mêmes valeurs vivent aux deux endroits : l'interface évite un
 * téléversement de 200 Mo voué au refus, le serveur empêche qu'un appel
 * direct à l'API contourne la validation.
 *
 * Deux copies qui divergent seraient pires qu'une seule : l'utilisateur
 * verrait passer un dépôt que le serveur refuserait ensuite.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const PRESIGN = read('src/app/api/files/presign/route.ts');
const CONFIRM = read('src/app/api/files/confirm/route.ts');
const DIALOGUE = read('src/components/documents/unified-document-dialog.tsx');

/** Valeur d'une constante numérique, tirets bas compris. */
function valeur(source: string, nom: string): number {
  const m = source.match(new RegExp(`${nom}\\s*=\\s*([0-9_]+)`));
  expect(m, `${nom} introuvable`).not.toBeNull();
  return Number(m![1].replace(/_/g, ''));
}

describe('les limites sont appliquées côté serveur', () => {
  it('un document dépassant 25 Mo est refusé avant le téléversement', () => {
    // Gemini plafonne autour de 20 Mo : au-delà, l'analyse échouerait après
    // que l'utilisateur a attendu.
    expect(valeur(PRESIGN, 'MAX_FILE_SIZE_DOCUMENT')).toBe(25_000_000);
    expect(PRESIGN).toMatch(/!isVideo && sizeInt > MAX_FILE_SIZE_DOCUMENT/);
  });

  it('les vidéos gardent leur propre plafond', () => {
    // Elles ne sont pas analysées : la contrainte du modèle ne s'applique pas.
    expect(valeur(PRESIGN, 'MAX_FILE_SIZE_VIDEO')).toBe(500_000_000);
  });

  it('le nombre et la taille du lot sont contrôlés', () => {
    expect(valeur(CONFIRM, 'MAX_DOCUMENTS_PAR_DEPOT')).toBe(10);
    expect(valeur(CONFIRM, 'MAX_TAILLE_LOT')).toBe(100_000_000);
    expect(CONFIRM).toMatch(/idsDemandes\.length > MAX_DOCUMENTS_PAR_DEPOT/);
    expect(CONFIRM).toMatch(/cumul > MAX_TAILLE_LOT/);
  });
});

describe('le client annonce les mêmes valeurs', () => {
  it('les trois limites concordent avec le serveur', () => {
    // Une divergence laisserait passer un dépôt que le serveur refuserait.
    expect(valeur(DIALOGUE, 'MAX_DOCUMENTS_PAR_DEPOT'))
      .toBe(valeur(CONFIRM, 'MAX_DOCUMENTS_PAR_DEPOT'));
    expect(valeur(DIALOGUE, 'MAX_TAILLE_LOT'))
      .toBe(valeur(CONFIRM, 'MAX_TAILLE_LOT'));
    expect(valeur(DIALOGUE, 'MAX_TAILLE_FICHIER'))
      .toBe(valeur(PRESIGN, 'MAX_FILE_SIZE_DOCUMENT'));
  });

  it('le dépassement est annoncé, pas silencieux', () => {
    // Écarter des fichiers sans le dire ferait croire à un dépôt complet.
    expect(DIALOGUE).toMatch(/toast\.error/);
    expect(DIALOGUE).toMatch(/ont été écartés|a été écarté/);
  });
});
