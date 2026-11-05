/**
 * Lot 111N — contenu des cartes tarifaires (décision PO du 05/11/2026), identique
 * au site public (src/sections/PricingSection.vue du dépôt verebona-public).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const bloc = (src: string, id: string, suivant: string) => src.slice(src.indexOf(`id: '${id}'`), src.indexOf(`id: '${suivant}'`));

describe('L111N — cartes Standard et Premium', () => {
  const offres = lire('src/app/(dashboard)/mon-compte/offres/page.tsx');
  const standard = bloc(offres, 'STANDARD', 'PREMIUM');
  const premium = bloc(offres, 'PREMIUM', 'PREMIUM_DUO');
  it('Standard présente l’Assistant', () => {
    expect(standard).toContain('Posez vos questions sur vos biens : Verebona s’appuie sur vos documents pour vous répondre.');
  });
  it('Premium : plus d’« Interrogez Verebona… » ni de « 1 utilisateur » ; coût de possession exact', () => {
    expect(premium).not.toMatch(/Interrogez Verebona|1 utilisateur/);
    expect(premium).toContain("'Calcul automatique du coût de possession de vos biens'");
  });
  it('fenêtre de passage à Premium alignée (l’Assistant n’y est plus un avantage Premium)', () => {
    const d = lire('src/components/premium/WriteBlockedDialog.tsx');
    expect(d).not.toMatch(/Interrogez Verebona/);
    expect(d).toContain('Calcul automatique du coût de possession de vos biens');
  });
});
