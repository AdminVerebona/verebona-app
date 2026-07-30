/**
 * Rendu HTML figé et règles de version — CDC 7 §7, §13, §16.2, §16.4.
 *
 * Ces fonctions sont pures : elles concentrent tout ce qui doit être
 * reproductible à l'octet près, puisqu'une empreinte SHA-256 en dépend.
 */
import { describe, it, expect } from 'vitest';
import {
  renderLegalVersionHtml,
  buildDownloadFilename,
  escapeHtml,
  formatFrenchDate,
} from '@/services/legal/legal-html.renderer';
import {
  isValidVersionCode,
  buildPermalink,
  computeSha256,
} from '@/services/legal/legal-versions.service';

const BASE = {
  versionCode: '2026-07-30-v1',
  title: 'Conditions générales de vente et d’utilisation',
  bodyHtml: '<h2>1. Objet</h2>\n<p>Texte contractuel.</p>',
  effectiveAt: new Date('2026-07-30T00:00:00Z'),
};

describe('code de version (§7)', () => {
  it('accepte le format AAAA-MM-JJ-vN', () => {
    expect(isValidVersionCode('2026-07-28-v1')).toBe(true);
    expect(isValidVersionCode('2026-07-28-v2')).toBe(true);
    expect(isValidVersionCode('2026-09-01-v12')).toBe(true);
  });

  it('rejette les formats approchants', () => {
    expect(isValidVersionCode('2026-07-28')).toBe(false);
    expect(isValidVersionCode('2026-7-28-v1')).toBe(false);
    expect(isValidVersionCode('2026-07-28-1')).toBe(false);
    expect(isValidVersionCode('v1')).toBe(false);
    expect(isValidVersionCode('')).toBe(false);
  });

  it('rejette une date qui n’existe pas', () => {
    // Le format seul laisserait passer un 31 février.
    expect(isValidVersionCode('2026-02-31-v1')).toBe(false);
    expect(isValidVersionCode('2026-13-01-v1')).toBe(false);
  });

  it('construit un permalien sans donnée personnelle (§12)', () => {
    expect(buildPermalink('2026-07-30-v1')).toBe('/cgvu/versions/2026-07-30-v1');
  });
});

describe('empreinte (§16.2)', () => {
  it('est stable pour un contenu identique', () => {
    expect(computeSha256('abc')).toBe(computeSha256('abc'));
  });

  it('change dès qu’un seul caractère change', () => {
    expect(computeSha256('abc')).not.toBe(computeSha256('abd'));
  });

  it('produit une empreinte SHA-256 hexadécimale', () => {
    expect(computeSha256('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rend le même document rigoureusement identique', () => {
    // Condition nécessaire pour qu'une empreinte ait un sens : le rendu ne
    // doit dépendre ni de l'horloge, ni du fuseau, ni d'un aléa.
    expect(computeSha256(renderLegalVersionHtml(BASE)))
      .toBe(computeSha256(renderLegalVersionHtml(BASE)));
  });
});

describe('rendu HTML figé (§13)', () => {
  const html = renderLegalVersionHtml({ ...BASE, changeSummary: 'Version initiale.' });

  it('est un document autonome et complet', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain('</html>');
  });

  it('est encodé en UTF-8', () => {
    expect(html).toContain('<meta charset="utf-8">');
  });

  it('ne dépend d’aucune ressource externe', () => {
    // §13 : « autonome et lisible hors ligne », « ne pas dépendre d'un appel
    // API pour afficher son contenu principal ».
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).not.toMatch(/<img/);
  });

  it('porte le titre, la version et la date d’entrée en vigueur', () => {
    expect(html).toContain('2026-07-30-v1');
    expect(html).toContain('30 juillet 2026');
    expect(html).toContain('Conditions générales de vente et d’utilisation');
  });

  it('contient le corps du document', () => {
    expect(html).toContain('<h2>1. Objet</h2>');
    expect(html).toContain('Texte contractuel.');
  });

  it('affiche le résumé des modifications quand il existe', () => {
    expect(html).toContain('Version initiale.');
    // Sans résumé, la section n'est pas émise. La classe reste présente dans
    // la feuille de style : c'est le bloc qu'on vérifie, pas le sélecteur.
    expect(renderLegalVersionHtml(BASE)).not.toContain('aria-label="Résumé des modifications"');
  });

  it('prévoit une impression propre (§13, §16.4)', () => {
    expect(html).toContain('@media print');
    expect(html).toContain('window.print()');
  });

  it('reste lisible sur mobile et au zoom (§16.4)', () => {
    expect(html).toContain('name="viewport"');
    // Tailles relatives : une taille en pixels fixes empêche le zoom.
    expect(html).toMatch(/font-size:\s*1rem/);
  });

  it('ne contient aucune donnée personnelle (§12)', () => {
    // `@` seul serait un mauvais témoin : `@media print` en contient un.
    expect(html).not.toMatch(/[\w.-]+@[\w.-]+\.\w{2,}/);
    expect(html).not.toMatch(/\buser_?id\b|\butilisateur_id\b|\bacceptance_id\b/i);
  });
});

describe('échappement', () => {
  it('neutralise le HTML dans le titre', () => {
    const html = renderLegalVersionHtml({ ...BASE, title: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('échappe les cinq caractères sensibles', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('laisse le corps intact, car il est du HTML voulu', () => {
    // Le corps est rédigé par un administrateur : c'est du contenu structuré,
    // pas une saisie utilisateur. L'échapper le rendrait illisible.
    const html = renderLegalVersionHtml({ ...BASE, bodyHtml: '<h2>Titre</h2>' });
    expect(html).toContain('<h2>Titre</h2>');
  });
});

describe('date et nom de fichier', () => {
  it('formate la date en français, en UTC', () => {
    expect(formatFrenchDate(new Date('2026-07-30T00:00:00Z'))).toBe('30 juillet 2026');
    expect(formatFrenchDate(new Date('2026-01-01T00:00:00Z'))).toBe('1 janvier 2026');
    expect(formatFrenchDate(new Date('2026-12-31T23:00:00Z'))).toBe('31 décembre 2026');
  });

  it('suit le nom recommandé au §13', () => {
    expect(buildDownloadFilename('2026-07-28-v1')).toBe('CGVU_Verebona_2026-07-28-v1.html');
  });
});
