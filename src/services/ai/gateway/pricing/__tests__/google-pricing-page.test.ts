/**
 * Lot 35B — adaptateur de la page tarifaire officielle Gemini (export
 * Markdown de https://ai.google.dev/gemini-api/docs/pricing). La page n'est
 * pas joignable depuis l'environnement de développement : extraits
 * représentatifs relevés le 10/10/2026 (`fixtures/`).
 *
 * Ce qui est garanti : un tarif n'est KNOWN que si sa lecture est certaine ;
 * toute ambiguïté donne UNKNOWN avec sa raison ; une page dont la structure
 * n'est plus reconnue est un échec de lecture, jamais « tout UNKNOWN ».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseGooglePricingMarkdown, parsePriceCell, resolveModelPrice, parseEnglishDate,
  GOOGLE_PRICING_SOURCE_URL, GOOGLE_PRICING_PAGE_URL,
} from '../google-pricing-page.adapter';

const fixture = (f: string) => readFileSync(join(__dirname, 'fixtures', f), 'utf8');
const PAGE = parseGooglePricingMarkdown(fixture('google-pricing-2026-10.md.txt'));
const OCT = new Date('2026-10-10T08:00:00Z');

describe('source documentée', () => {
  it('page officielle et son export Markdown', () => {
    expect(GOOGLE_PRICING_PAGE_URL).toBe('https://ai.google.dev/gemini-api/docs/pricing');
    expect(GOOGLE_PRICING_SOURCE_URL).toBe('https://ai.google.dev/gemini-api/docs/pricing.md.txt');
  });
});

describe('structure de la page', () => {
  it('reconnaît les sections de modèles, leurs identifiants et le palier Standard', () => {
    expect(PAGE.ok).toBe(true);
    if (!PAGE.ok) return;
    const ids = PAGE.sections.flatMap((s) => s.modelIds);
    expect(ids).toEqual(expect.arrayContaining(['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.8-live', 'gemini-3.1-flash-live-preview', 'gemini-2.5-pro', 'gemini-embedding-2']));
    // Section sans identifiant (Gemma) ignorée.
    expect(PAGE.sections.some((s) => /Gemma/.test(s.heading))).toBe(false);
    // Palier Standard retenu, pas Batch / Flex.
    expect(PAGE.sections.find((s) => s.modelIds.includes('gemini-3.6-flash'))?.input).toBe('$1.50');
  });

  it('CAT-07 — page HTML (structure non reconnue) : échec de lecture, aucun tarif produit', () => {
    const html = parseGooglePricingMarkdown(fixture('google-pricing-html-page.html'));
    expect(html).toEqual({ ok: false, reason: expect.stringMatching(/structure de la page non reconnue/) });
    expect(resolveModelPrice(html, 'gemini-3.6-flash')).toMatchObject({ status: 'UNKNOWN' });
    expect(parseGooglePricingMarkdown('')).toMatchObject({ ok: false });
  });
});

describe('tarifs KNOWN : formes reconnues', () => {
  it('montant seul', () => {
    expect(resolveModelPrice(PAGE, 'gemini-3.6-flash', OCT)).toEqual({
      status: 'KNOWN', model: 'gemini-3.6-flash', inputPerMillion: 1.5, outputPerMillion: 7.5, currency: 'USD', tiers: [], section: 'Gemini 3.6 Flash',
    });
  });

  it('modalités : texte et image au même prix (audio ignoré) — y compris séparées par <br>', () => {
    expect(resolveModelPrice(PAGE, 'gemini-2.5-flash', OCT)).toMatchObject({ status: 'KNOWN', inputPerMillion: 0.3, outputPerMillion: 2.5 });
    expect(resolveModelPrice(PAGE, 'gemini-3.1-flash-lite', OCT)).toMatchObject({ status: 'KNOWN', inputPerMillion: 0.25, outputPerMillion: 1.5 });
  });

  it('paliers de taille d’invite : tarif de base ≤ 200k, palier au-delà conservé', () => {
    expect(resolveModelPrice(PAGE, 'gemini-2.5-pro', OCT)).toMatchObject({
      status: 'KNOWN', inputPerMillion: 1.25, outputPerMillion: 10,
      tiers: [{ kind: 'prompt_tokens_above', thresholdTokens: 200_000, inputPerMillion: 2.5, outputPerMillion: 15 }],
    });
    expect(resolveModelPrice(PAGE, 'gemini-3.1-pro-preview', OCT)).toMatchObject({ status: 'KNOWN', inputPerMillion: 2, outputPerMillion: 12 });
  });

  it('montants datés : celui en vigueur à la date du relevé, les autres conservés', () => {
    const oct = resolveModelPrice(PAGE, 'gemini-3.8-flash', OCT);
    expect(oct).toMatchObject({ status: 'KNOWN', inputPerMillion: 0.75, outputPerMillion: 3.75 });
    expect(oct.status === 'KNOWN' && oct.tiers).toEqual([
      { kind: 'dated', from: null, to: '2026-12-31', inputPerMillion: 0.75, outputPerMillion: 3.75 },
      { kind: 'dated', from: '2027-01-01', to: null, inputPerMillion: 1.5, outputPerMillion: 7.5 },
    ]);
    expect(resolveModelPrice(PAGE, 'gemini-3.8-flash', new Date('2027-01-02T00:00:00Z'))).toMatchObject({ inputPerMillion: 1.5, outputPerMillion: 7.5 });
    expect(parseEnglishDate('Dec 31, 2026')).toBe('2026-12-31');
    expect(parseEnglishDate('September 9, 2026')).toBe('2026-09-09');
  });

  it('tableau unique sans sous-titre de palier', () => {
    // Pas de ligne « Output price » : UNKNOWN (embedding, hors génération).
    expect(resolveModelPrice(PAGE, 'gemini-embedding-2', OCT)).toMatchObject({ status: 'UNKNOWN', reason: 'ligne « Output price » absente' });
  });
});

describe('CAT-07 — ambiguïté → UNKNOWN, jamais un tarif inventé', () => {
  it('modèle absent de la page', () => {
    expect(resolveModelPrice(PAGE, 'gemini-9-flash', OCT)).toEqual({ status: 'UNKNOWN', model: 'gemini-9-flash', reason: 'absent de la page tarifaire officielle' });
  });
  it('texte et image à des prix différents (modèles Live)', () => {
    expect(resolveModelPrice(PAGE, 'gemini-3.8-live', OCT)).toMatchObject({ status: 'UNKNOWN', reason: expect.stringMatching(/modalité/) });
  });
  it('sortie facturée à l’image', () => {
    expect(resolveModelPrice(PAGE, 'gemini-3.1-flash-image', OCT)).toMatchObject({ status: 'UNKNOWN', reason: expect.stringMatching(/unité ou à la durée/) });
  });
  it('modèle présent dans deux sections', () => {
    const md = fixture('google-pricing-2026-10.md.txt') + '\n## Doublon\n\n*[`gemini-3.6-flash`](x)*\n\n|  | Free | Paid |\n|---|---|---|\n| Input price | Free | $9.00 |\n| Output price | Free | $9.00 |\n';
    expect(resolveModelPrice(parseGooglePricingMarkdown(md), 'gemini-3.6-flash', OCT)).toMatchObject({ status: 'UNKNOWN', reason: expect.stringMatching(/plusieurs sections/) });
  });
  it('condition inconnue, plusieurs montants sans condition, combinaison, aucun montant, date non en vigueur', () => {
    expect(parsePriceCell('$1.00 for enterprise customers', OCT)).toMatchObject({ ok: false, reason: expect.stringMatching(/condition non reconnue/) });
    expect(parsePriceCell('$1.00 $2.00', OCT)).toMatchObject({ ok: false });
    expect(parsePriceCell('$1.00, prompts <= 200k tokens $2.00 (audio)', OCT)).toMatchObject({ ok: false, reason: expect.stringMatching(/combinaison/) });
    expect(parsePriceCell('Free of charge', OCT)).toMatchObject({ ok: false, reason: expect.stringMatching(/aucun montant/) });
    expect(parsePriceCell('$1.00 from Jan 1, 2027', OCT)).toMatchObject({ ok: false, reason: expect.stringMatching(/en vigueur/) });
    expect(parsePriceCell('$1.00 through Dec 31 2026x', OCT)).toMatchObject({ ok: false });
  });
  it('section sans palier Standard mais avec d’autres paliers : UNKNOWN', () => {
    const md = '## X\n\n*`gemini-x`*\n\n### Batch\n\n|  | Free | Paid |\n|---|---|---|\n| Input price | - | $1.00 |\n| Output price | - | $2.00 |\n';
    expect(resolveModelPrice(parseGooglePricingMarkdown(md), 'gemini-x', OCT)).toMatchObject({ status: 'UNKNOWN', reason: expect.stringMatching(/Standard/) });
  });
});
