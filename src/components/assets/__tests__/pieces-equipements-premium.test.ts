/**
 * Pièces et équipements : Premium / Premium Duo uniquement (essai compris).
 * Un compte Standard qui clique sur « Ajouter une pièce » ou « Ajouter un
 * équipement » obtient la fenêtre « Passer à Premium ou Premium Duo ».
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe.each([
  ['pièces', 'src/components/assets/asset-substructures-panel.tsx', 'src/app/api/assets/[id]/substructures/route.ts'],
  ['équipements', 'src/components/assets/asset-equipments-panel.tsx', 'src/app/api/assets/[id]/equipments/route.ts'],
])('%s', (_label, panel, route) => {
  it('le bouton d’ajout ouvre la fenêtre Premium pour un compte Standard', () => {
    const src = read(panel);
    const handler = src.slice(src.indexOf('const handleAdd'), src.indexOf('}, [garder, signalerRefus, premiumRefuse]);'));
    expect(src).toContain('!entitlements.premiumFeatures');
    expect(handler).toContain("code: 'PREMIUM_REQUIRED'");
    // Le refus précède l'ouverture du formulaire.
    expect(handler.indexOf('PREMIUM_REQUIRED')).toBeLessThan(handler.indexOf('setIsDrawerOpen(true)'));
  });

  it('le serveur refuse la création hors Premium (403 PREMIUM_REQUIRED)', () => {
    const src = read(route);
    const post = src.slice(src.indexOf('export async function POST'));
    expect(post).toContain('canUsePremiumFeature(session.currentAccountId)');
    expect(post.indexOf('canUsePremiumFeature')).toBeLessThan(post.indexOf('request.json()'));
  });
});

it('la fenêtre Premium nomme les deux offres', () => {
  const dlg = read('src/components/premium/WriteBlockedDialog.tsx');
  expect(dlg).toContain("premiumRequis ? 'Passer à Premium ou Premium Duo'");
});
