import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * Barre haute mobile sous la barre d'état iOS (préprod, 4 oct. 2026) : le
 * champ Verebona et l'avatar passaient sous l'heure et la batterie.
 */
describe('barre d’état iOS — encart haut réservé', () => {
  it('la PWA s’étend sous la barre d’état avec un encart renseigné', () => {
    const layout = read('src/app/layout.tsx');
    expect(layout).toMatch(/statusBarStyle: 'black-translucent'/);
    expect(layout).toMatch(/viewportFit: 'cover'/);
  });

  it('la barre haute, le panneau du compte et l’espace Verebona réservent l’encart', () => {
    expect(read('src/components/DashboardLayout.tsx')).toMatch(/pt-\[max\(8px,env\(safe-area-inset-top\)\)\]/);
    expect(read('src/components/mobile/mobile-account-panel.tsx')).toMatch(/env\(safe-area-inset-top\)/);
    expect(read('src/components/verebona/space/VerebonaField.tsx')).toMatch(/env\(safe-area-inset-top\)/);
  });
});
