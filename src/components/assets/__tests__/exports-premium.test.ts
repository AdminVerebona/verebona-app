/**
 * Exports réservés aux offres Premium : en Standard, les « Dossiers prêts à
 * l'usage » mènent à la fenêtre « Passer à Premium ou Premium Duo » ;
 * « Transfert et récupération » reste accessible.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('exports — offre Standard', () => {
  const tab = read('src/components/assets/AssetExportsTab.tsx');

  it('le verrou suit les droits effectifs, plus la comparaison à STANDARD', () => {
    expect(tab).toContain('entitlements.premiumFeatures');
    expect(tab).not.toContain("planType === 'STANDARD'");
  });

  it('un dossier verrouillé ouvre la fenêtre Premium au lieu du tiroir', () => {
    expect(tab).toMatch(/if \(premiumRefuse\) \{\s*signalerRefus\(\{\s*code: 'PREMIUM_REQUIRED'/);
  });

  it('transfert et récupération restent ouverts (premiumOnly: false)', () => {
    for (const type of ['EXPORT_BRUT', 'TRANSMISSION']) {
      const bloc = tab.slice(tab.indexOf(`type: '${type}'`), tab.indexOf('}', tab.indexOf(`type: '${type}'`)));
      expect(bloc).toContain("section: 'transfert'");
      expect(bloc).toContain('premiumOnly: false');
    }
  });

  it('la fenêtre nomme les deux offres', () => {
    expect(read('src/components/premium/WriteBlockedDialog.tsx')).toContain('Passer à Premium ou Premium Duo');
  });

  it('le serveur refuse un dossier Premium à un compte Standard, pas l’export brut', () => {
    const route = read('src/app/api/assets/[id]/exports/route.ts');
    expect(route).toContain('canUsePremiumFeature(accountId)');
    const liste = route.slice(route.indexOf('const PREMIUM_EXPORT_TYPES'), route.indexOf('];', route.indexOf('const PREMIUM_EXPORT_TYPES')));
    expect(liste).toContain("'DOSSIER_VENTE'");
    expect(liste).not.toContain('EXPORT_BRUT');
  });
});
