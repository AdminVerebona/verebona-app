/**
 * Templates V12 — fidélité au design validé et sûreté du HTML.
 *
 *  · parité : pour chaque cas de `data-example.json` (6 dossiers × minimal /
 *    nominal / riche), le portage TypeScript produit EXACTEMENT le HTML des
 *    maquettes (empreintes calculées depuis `maquettes/<dossier>/template.mjs`) ;
 *  · contrôles des maquettes (`render.mjs`) sur le texte rendu : chaînes
 *    interdites absentes (`mustNotAppear` : estimation, pièces sensibles non
 *    cochées, données d'occupant, n° de série en clair…) ;
 *  · XSS : toute donnée utilisateur est échappée (texte, attributs, CSS de
 *    l'en-tête), aucune balise ni gestionnaire injectable.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { TEMPLATES, renderDossierHtml } from '../templates';
import type { RenderContext } from '../types';
import type { DossierCode } from '@/services/exports/catalog';

const FIX = join(process.cwd(), 'src/services/exports/v12/__tests__/fixtures');
const DOSSIERS: Array<[string, DossierCode]> = [
  ['cil', 'CIL'], ['dossier-complet', 'DOSSIER_COMPLET'], ['vente', 'VENTE'], ['location', 'LOCATION'],
  ['assurance-souscription', 'ASSURANCE_SOUSCRIPTION'], ['assurance-sinistre', 'ASSURANCE_SINISTRE'],
];
const golden = JSON.parse(readFileSync(join(FIX, 'golden-html.json'), 'utf8')).hashes as Record<string, string>;
const load = (dir: string) => JSON.parse(readFileSync(join(FIX, `${dir}.json`), 'utf8')) as { cases: Record<string, Record<string, unknown>> };

const ctx = (pass: 1 | 2): RenderContext => ({
  sys: 'SYS/',
  asset: (p) => (p ? `SYS/assets/${p}` : null),
  stylesheets: ['SYS/tokens.css', 'SYS/components.css'],
  pageMap: pass === 1 ? null : { total: 17, annexStart: { A1: 9, A2: 10, A3: 11, A4: 12, A5: 13, A6: 14, A7: 15 } },
});

/** Texte visible approximatif (balises retirées, entités décodées, espaces normalisés). */
const visibleText = (html: string) => html
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .normalize('NFKC').replace(/[  ]/g, ' ').replace(/\s+/g, ' ');

describe('Parité avec les maquettes validées', () => {
  for (const [dir, code] of DOSSIERS) {
    for (const caseId of ['minimal', 'nominal', 'riche']) {
      it(`${dir} / ${caseId} : HTML identique aux deux passes`, () => {
        const c = load(dir).cases[caseId];
        for (const pass of [1, 2] as const) {
          const html = renderDossierHtml(code, structuredClone(c) as never, ctx(pass)).html;
          expect(createHash('sha256').update(html).digest('hex'), `${dir}/${caseId}/${pass}`).toBe(golden[`${dir}/${caseId}/${pass}`]);
        }
      });
    }
  }
});

describe('Contrôles de contenu des maquettes', () => {
  for (const [dir, code] of DOSSIERS) {
    it(`${dir} : chaînes interdites absentes, pied et pagination déclarés`, () => {
      for (const [caseId, c] of Object.entries(load(dir).cases)) {
        const html = renderDossierHtml(code, structuredClone(c) as never, ctx(2)).html;
        const text = visibleText(html);
        for (const s of (c.mustNotAppear as string[] | undefined) ?? []) {
          expect(text.includes(s.normalize('NFKC').replace(/[  ]/g, ' ')), `${dir}/${caseId} : « ${s} »`).toBe(false);
        }
        // PDF-TXT-008/009 : mention de pied et « Page X / Y » (boîtes de marge + couverture).
        expect(html).toContain('content: "Ce dossier a été préparé avec Verebona."');
        expect(html).toContain('content: "Page " counter(page) " / " counter(pages)');
        expect(text).toContain('Page 1 / 17');
        // PDF-TXT-002 : aucune valeur technique vide imprimée.
        expect(text).not.toMatch(/\b(undefined|null|NaN)\b/);
      }
    });
  }

  it('un template par dossier, versionné', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual(DOSSIERS.map(([, c]) => c).sort());
    for (const t of Object.values(TEMPLATES)) expect(t.version).toMatch(/^[a-z_]+-v\d+\.\d+\.\d+$/);
  });
});

describe('XSS : données utilisateur toujours échappées', () => {
  const PAYLOAD = '"><img src=x onerror=alert(1)><script>alert(2)</script></style>\\"';
  /** Remplace chaque chaîne des données (hors codes techniques) par une valeur piégée. */
  const poison = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') {
      // Codes structurants conservés (statuts, modes, formats, identifiants, dates) pour garder les branches de rendu.
      if (/^(status|mode|format|kind|tone|phase|section|id|docId|code|leaseType|date|dateLabel|triggerDate|validUntil|installed|generatedAt|deedDate|proofDate|availabilityDate|purchaseDate|mileageDate|declaredAt|file|focus)$/.test(key)) return v;
      return `${v}${PAYLOAD}`;
    }
    if (Array.isArray(v)) return v.map((x) => poison(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, poison(x, k)]));
    return v;
  };

  for (const [dir, code] of DOSSIERS) {
    it(`${dir} : aucune balise ni gestionnaire injecté`, () => {
      for (const c of Object.values(load(dir).cases)) {
        const html = renderDossierHtml(code, poison(structuredClone(c)) as never, ctx(2)).html;
        expect(html).not.toContain('<img src=x');
        expect(html).not.toContain('<script>');
        expect(html).not.toMatch(/<[^>]+\sonerror=/i);
        // Une seule fermeture de <style> : celle des règles @page.
        expect(html.match(/<\/style>/g)?.length).toBe(1);
        expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
      }
    });
  }
});
