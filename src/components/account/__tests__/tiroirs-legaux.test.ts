/**
 * Mon compte — blocs « Droit de rétractation » et « Informations légales »
 * en tiroirs fermés par défaut.
 *
 * Garde-fou juridique : le lien « Renoncer au contrat ici » doit rester
 * visible tiroir fermé (CDC 6 §6.1 ; directive (UE) 2023/2673). Il est donc
 * passé en `headerExtra`, jamais dans le contenu repliable.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('tiroirs légaux de Mon compte', () => {
  it('le tiroir est fermé par défaut', () => {
    expect(read('src/components/ui/collapsible-card.tsx')).toMatch(/defaultOpen = false/);
  });

  it('les deux blocs utilisent le tiroir, sans forcer son ouverture', () => {
    for (const file of [
      'src/components/account/WithdrawalCard.tsx',
      'src/components/account/LegalInformationCard.tsx',
    ]) {
      const src = read(file);
      expect(src).toContain('<CollapsibleCard');
      expect(src).not.toMatch(/defaultOpen(\s*=\s*\{?\s*true)?[\s/>]/);
    }
  });

  it('le lien de rétractation reste hors du contenu repliable', () => {
    const src = read('src/components/account/WithdrawalCard.tsx');
    expect(src).toContain('headerExtra={lienRetractation}');
    const lien = src.slice(src.indexOf('const lienRetractation'), src.indexOf('return (', src.indexOf('const lienRetractation')));
    expect(lien).toContain('Renoncer au contrat ici');
    expect(lien).toContain('/retractation');
  });
});
