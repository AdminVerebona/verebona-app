import { describe, expect, it } from 'vitest';
import { CGVU_V1_BODY_HTML } from '@/db/seeds/legal/cgvu-v1.content';
import {
  CGVU_2026_09_25_BODY_HTML, CGVU_2026_09_25_VERSION_CODE, CGVU_2026_09_25_CHANGE_SUMMARY,
} from '@/db/seeds/legal/cgvu-2026-09-25.content';
import { isValidVersionCode } from '@/services/legal/legal-versions.service';

describe('CGVU du 25/09/2026 — médiation', () => {
  it('nouvelle version valide, résumé renseigné', () => {
    expect(isValidVersionCode(CGVU_2026_09_25_VERSION_CODE)).toBe(true);
    expect(CGVU_2026_09_25_CHANGE_SUMMARY).toContain('18.3');
  });

  it('§18.3 remplacé par le médiateur désigné', () => {
    const b = CGVU_2026_09_25_BODY_HTML;
    expect(b).toContain('18.3. Litige – Médiation de la consommation');
    expect(b).toContain('La Société Médiation Professionnelle');
    expect(b).toContain('http://www.mediateur-consommation-smp.fr');
    expect(b).toContain('Alteritae, 5 rue Salvaing, 12000 Rodez');
    expect(b).not.toContain('[Nom du médiateur de la consommation]');
    expect(b).not.toMatch(/\{\{|\}\}/);
  });

  it('le reste du texte est inchangé, la version 1 n’est pas modifiée', () => {
    const avant = CGVU_V1_BODY_HTML.slice(0, CGVU_V1_BODY_HTML.indexOf('<h3>18.3.'));
    const apres = CGVU_V1_BODY_HTML.slice(CGVU_V1_BODY_HTML.indexOf('<h2>19.'));
    expect(CGVU_2026_09_25_BODY_HTML.startsWith(avant.slice(0, avant.lastIndexOf('\n') + 1))).toBe(true);
    expect(CGVU_2026_09_25_BODY_HTML.endsWith(apres)).toBe(true);
    expect(CGVU_V1_BODY_HTML).toContain('[Nom du médiateur de la consommation]');
    expect(CGVU_2026_09_25_BODY_HTML.match(/<h2>19\./g)).toHaveLength(1);
  });
});
