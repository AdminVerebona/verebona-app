/**
 * Lot 109L (ticket P1 « Tarifs Gemini non reconnus », point A, tests §4) —
 * lecture des formats réels de la page officielle :
 *   · `google-pricing-2026-11-04.markdoc.md.txt` : montants relevés le
 *     04/11/2026 (WebFetch, page rendue), structure Markdoc ({% tab %},
 *     {% table %}, listes) reconstituée selon l'audit — provenance en tête ;
 *   · `google-pricing-2026-11-04.rendered.md` : vue rendue (tableaux à barres, <br>) ;
 *   · `google-pricing-2026-10.md.txt` : format historique (### Standard, tableaux).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseGooglePricingMarkdown, resolveModelPrice, detectPricingFormat, pageFingerprint, pageCoverage,
  GOOGLE_PRICING_REDIRECT_URL,
} from '../google-pricing-page.adapter';

const fixture = (f: string) => readFileSync(join(__dirname, 'fixtures', f), 'utf8');
const MARKDOC = fixture('google-pricing-2026-11-04.markdoc.md.txt');
const RENDERED = fixture('google-pricing-2026-11-04.rendered.md');
const HISTO = fixture('google-pricing-2026-10.md.txt');
const NOV = new Date('2026-11-04T09:00:00Z');

describe('format détecté sur le contenu, empreinte', () => {
  it('Markdoc, tableaux à barres, HTML, vide', () => {
    expect(detectPricingFormat(MARKDOC)).toBe('markdoc');
    expect(detectPricingFormat(HISTO)).toBe('pipe');
    expect(detectPricingFormat(fixture('google-pricing-html-page.html'))).toBe('html');
    expect(detectPricingFormat('   ')).toBe('empty');
    expect(detectPricingFormat('Hello world')).toBe('unknown');
    expect(pageFingerprint(MARKDOC)).toMatch(/^[0-9a-f]{64}$/);
    expect(pageFingerprint(MARKDOC)).not.toBe(pageFingerprint(RENDERED));
    expect(GOOGLE_PRICING_REDIRECT_URL).toBe('https://aistudio.google.com/docs/pricing');
  });
});

describe.each([
  ['Markdoc {% tab %} / {% table %} (04/11/2026)', MARKDOC],
  ['vue rendue (04/11/2026)', RENDERED],
])('%s', (_l, text) => {
  const page = parseGooglePricingMarkdown(text);

  it('sections et identifiants exacts (deux identifiants dans une section)', () => {
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const ids = page.sections.flatMap((s) => s.modelIds);
    expect(ids).toEqual(expect.arrayContaining(['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools', 'gemini-2.5-flash-lite']));
    // Aucun alias : `gemini-3.5-flash` n'est PAS publié (seul `gemini-3.5-flash-lite` l'est).
    expect(resolveModelPrice(page, 'gemini-3.5-flash', NOV)).toMatchObject({ status: 'UNKNOWN', code: 'ABSENT' });
  });

  it('Standard payant retenu — jamais Batch / Flex / Priority / Contributor ni gratuit', () => {
    expect(resolveModelPrice(page, 'gemini-3.5-flash-lite', NOV)).toMatchObject({ status: 'KNOWN', inputPerMillion: 0.3, outputPerMillion: 2.5, currency: 'USD' });
    expect(resolveModelPrice(page, 'gemini-3.1-flash-lite', NOV)).toMatchObject({ status: 'KNOWN', inputPerMillion: 0.25, outputPerMillion: 1.5 });
  });

  it('montants datés en vigueur, sortie « including thinking tokens »', () => {
    const r = resolveModelPrice(page, 'gemini-3.6-flash', NOV);
    expect(r).toMatchObject({ status: 'KNOWN', inputPerMillion: 0.75, outputPerMillion: 3.75, thinkingIncluded: true });
    expect(r.status === 'KNOWN' && r.tiers).toEqual([
      { kind: 'dated', from: null, to: '2026-12-31', inputPerMillion: 0.75, outputPerMillion: 3.75 },
      { kind: 'dated', from: '2027-01-01', to: null, inputPerMillion: 1.5, outputPerMillion: 7.5 },
    ]);
    expect(resolveModelPrice(page, 'gemini-3.8-flash', new Date('2027-01-05T00:00:00Z'))).toMatchObject({ inputPerMillion: 1.5, outputPerMillion: 7.5 });
  });

  it('long contexte : palier au-delà de 200k (Pro)', () => {
    expect(resolveModelPrice(page, 'gemini-2.5-pro', NOV)).toMatchObject({
      status: 'KNOWN', inputPerMillion: 1.25, outputPerMillion: 10,
      tiers: [{ kind: 'prompt_tokens_above', thresholdTokens: 200_000, inputPerMillion: 2.5, outputPerMillion: 15 }],
    });
    expect(resolveModelPrice(page, 'gemini-3.1-pro-preview-customtools', NOV)).toMatchObject({ status: 'KNOWN', inputPerMillion: 2, outputPerMillion: 12 });
  });

  it('texte/image/PDF : même prix exigé ; audio ignoré ; texte ≠ image → UNKNOWN', () => {
    expect(resolveModelPrice(page, 'gemini-2.5-flash', NOV)).toMatchObject({ status: 'KNOWN', inputPerMillion: 0.3 });
    expect(resolveModelPrice(page, 'gemini-3.8-live', NOV)).toMatchObject({ status: 'UNKNOWN', code: 'MODALITY_DEPENDENT' });
    // Sortie image facturée à l'image : jamais un montant au jeton deviné.
    expect(resolveModelPrice(page, 'gemini-3.1-flash-image', NOV)).toMatchObject({ status: 'UNKNOWN' });
  });

  it('couverture globale mesurée', () => {
    const c = pageCoverage(page, NOV);
    expect(c.sections).toBeGreaterThanOrEqual(10);
    expect(c.known).toBeGreaterThanOrEqual(9);
  });
});

describe('formats historiques et sources non conformes', () => {
  it('format historique toujours lu', () => {
    const p = parseGooglePricingMarkdown(HISTO);
    expect(resolveModelPrice(p, 'gemini-3.6-flash', new Date('2026-10-10T00:00:00Z'))).toMatchObject({ status: 'KNOWN', inputPerMillion: 1.5 });
  });

  it('Markdoc variante {% endtab %} / {% endtable %}, cellules sur plusieurs lignes', () => {
    const md = MARKDOC.replace(/\{% \/tab %\}/g, '{% endtab %}').replace(/\{% \/table %\}/g, '{% endtable %}');
    expect(resolveModelPrice(parseGooglePricingMarkdown(md), 'gemini-3.6-flash', NOV)).toMatchObject({ status: 'KNOWN', inputPerMillion: 0.75 });
  });

  it('onglet Standard absent (Batch seul) : UNKNOWN structuré, aucun montant Batch repris', () => {
    const md = '## X\n\n*`gemini-x`*\n\n{% tab title="Batch" %}\n{% table %}\n* \n* Free\n* Paid\n---\n* Input price\n* -\n* $1.00\n---\n* Output price\n* -\n* $2.00\n{% /table %}\n{% /tab %}\n';
    expect(resolveModelPrice(parseGooglePricingMarkdown(md), 'gemini-x', NOV)).toMatchObject({ status: 'UNKNOWN', code: 'NO_STANDARD_TIER' });
  });

  it('nouveau modèle publié : KNOWN dès sa lecture', () => {
    const md = `${MARKDOC}\n## Gemini 9 Flash\n\n*[\`gemini-9-flash\`](x)*\n\n{% tab title="Standard" %}\n{% table %}\n* \n* Free Tier\n* Paid Tier, per 1M tokens in USD\n---\n* Input price\n* Free of charge\n* $0.40\n---\n* Output price (including thinking tokens)\n* Free of charge\n* $1.60\n{% /table %}\n{% /tab %}\n`;
    expect(resolveModelPrice(parseGooglePricingMarkdown(md), 'gemini-9-flash', NOV)).toMatchObject({ status: 'KNOWN', inputPerMillion: 0.4, outputPerMillion: 1.6, thinkingIncluded: true });
  });

  it('devise autre que USD : refusée', () => {
    const md = MARKDOC.replace('* $0.30 (text / image / video / audio)', '* €0.30 (text / image / video / audio)');
    expect(resolveModelPrice(parseGooglePricingMarkdown(md), 'gemini-3.5-flash-lite', NOV)).toMatchObject({ status: 'UNKNOWN' });
  });

  it('HTML brut, vide, texte sans section : échec de lecture structuré (aucun tarif produit)', () => {
    expect(parseGooglePricingMarkdown('<!doctype html><html><body>x</body></html>')).toMatchObject({ ok: false, code: 'PAGE_HTML' });
    expect(parseGooglePricingMarkdown('')).toMatchObject({ ok: false, code: 'PAGE_EMPTY' });
    expect(parseGooglePricingMarkdown('Service unavailable')).toMatchObject({ ok: false, code: 'PAGE_UNRECOGNIZED' });
  });
});
