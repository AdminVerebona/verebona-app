/**
 * Contenu de la version 1 et clé de stockage.
 *
 * Le contenu est repris du site vitrine : ces contrôles vérifient qu'il a
 * survécu à l'extraction, et qu'aucun résidu de mise en forme Vue ne s'y est
 * glissé — un attribut `:class` ou une interpolation `{{ }}` publiés dans un
 * document contractuel figé ne seraient plus corrigeables.
 */
import { describe, it, expect } from 'vitest';
import {
  CGVU_V1_VERSION_CODE,
  CGVU_V1_CHANGE_SUMMARY,
  CGVU_V1_BODY_HTML,
} from '@/db/seeds/legal/cgvu-v1.content';
import { isValidVersionCode } from '@/services/legal/legal-versions.service';
import { buildLegalStorageKey } from '@/services/legal/legal-storage';
import { renderLegalVersionHtml } from '@/services/legal/legal-html.renderer';

describe('contenu de la version 1', () => {
  it('porte un code de version valide', () => {
    expect(isValidVersionCode(CGVU_V1_VERSION_CODE)).toBe(true);
  });

  it('porte un résumé des modifications non vide (§14.1)', () => {
    expect(CGVU_V1_CHANGE_SUMMARY.trim().length).toBeGreaterThan(10);
  });

  it('contient un texte contractuel substantiel', () => {
    expect(CGVU_V1_BODY_HTML.length).toBeGreaterThan(10_000);
    expect(CGVU_V1_BODY_HTML).toContain('Objet');
    expect(CGVU_V1_BODY_HTML).toContain('Verebona');
  });

  it('est structuré par des titres de niveau 2 (§16.4)', () => {
    const headings = CGVU_V1_BODY_HTML.match(/<h2>/g) ?? [];
    expect(headings.length).toBeGreaterThanOrEqual(10);
  });

  it('ne contient aucun résidu de gabarit Vue', () => {
    expect(CGVU_V1_BODY_HTML).not.toMatch(/\{\{|\}\}/);
    expect(CGVU_V1_BODY_HTML).not.toMatch(/\sv-(if|for|else|bind|on)\b/);
    expect(CGVU_V1_BODY_HTML).not.toMatch(/\s:[a-zA-Z-]+="/);
    expect(CGVU_V1_BODY_HTML).not.toContain('<template');
  });

  it('ne contient ni style en ligne ni classe', () => {
    // Le rendu figé apporte sa propre feuille de style : des styles hérités du
    // site vitrine casseraient l'impression et le contraste.
    expect(CGVU_V1_BODY_HTML).not.toMatch(/\sstyle="/);
    expect(CGVU_V1_BODY_HTML).not.toMatch(/\sclass="/);
  });

  it('produit un document publiable', () => {
    const html = renderLegalVersionHtml({
      versionCode: CGVU_V1_VERSION_CODE,
      title: 'Conditions générales de vente et d’utilisation',
      bodyHtml: CGVU_V1_BODY_HTML,
      effectiveAt: new Date('2026-07-30T00:00:00Z'),
      changeSummary: CGVU_V1_CHANGE_SUMMARY,
    });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain(CGVU_V1_VERSION_CODE);
  });

  it('a des balises équilibrées — une extraction tronquée se verrait ici', () => {
    // Mesuré sur le corps seul : l'enveloppe de rendu ajoute ses propres
    // paragraphes, porteurs d'attributs.
    for (const tag of ['p', 'h2', 'ul', 'li']) {
      const open = (CGVU_V1_BODY_HTML.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
      const close = (CGVU_V1_BODY_HTML.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
      expect({ tag, open }).toEqual({ tag, open: close });
    }
  });
});

describe('clé de stockage (§14.1, §16.1)', () => {
  it('est déterministe et propre à une version', () => {
    expect(buildLegalStorageKey('CGVU', '2026-07-30-v1')).toBe('legal/cgvu/2026-07-30-v1.html');
    expect(buildLegalStorageKey('CGVU', '2026-07-30-v2')).toBe('legal/cgvu/2026-07-30-v2.html');
  });

  it('ne peut pas collisionner entre deux versions', () => {
    const a = buildLegalStorageKey('CGVU', '2026-07-30-v1');
    const b = buildLegalStorageKey('CGVU', '2026-08-01-v1');
    expect(a).not.toBe(b);
  });
});
