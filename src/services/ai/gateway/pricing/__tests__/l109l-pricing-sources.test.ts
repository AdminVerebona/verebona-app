/**
 * Lot 109L (ticket P1 « Tarifs Gemini », point B, tests §4) — priorité des
 * sources, validation globale de la page, grille du compte désactivée.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectApplicablePrices, sourceRank } from '../pricing.repository';
import { validatePricingSource, COVERAGE_DROP_RATIO } from '../pricing-sync.service';
import { parseGooglePricingMarkdown } from '../google-pricing-page.adapter';
import { billingSourceValidated, GeminiPricingSource } from '../gemini-pricing.source';

const fixture = (f: string) => readFileSync(join(__dirname, 'fixtures', f), 'utf8');
const NOV = new Date('2026-11-04T09:00:00Z');

describe('priorité explicite des sources', () => {
  it('manuel vérifié > compte vérifié > page officielle > manuel non vérifié > compte non vérifié', () => {
    expect([sourceRank('manual', true), sourceRank('billing_api', true), sourceRank('public_catalog', false), sourceRank('manual', false), sourceRank('billing_api', false)]).toEqual([0, 1, 2, 3, 4]);
  });
  it('une synchronisation publique plus récente n’écrase pas une saisie manuelle vérifiée', () => {
    const base = { provider: 'gemini', model: 'm', currency: 'USD', source_reference: null, fetched_at: '2026-11-04' };
    const [p] = selectApplicablePrices([
      { ...base, id: 1, input_micros: '0.5', output_micros: '2', source: 'manual', verified: true, effective_from: '2026-10-01T00:00:00Z' },
      { ...base, id: 2, input_micros: '0.75', output_micros: '3', source: 'public_catalog', verified: false, effective_from: '2026-11-04T00:00:00Z', stale: false },
    ]);
    expect(p).toMatchObject({ id: 1, source: 'manual', inputMicros: 0.5 });
  });
  it('à rang égal, la plus récente ; STALE porté sur un tarif public', () => {
    const base = { provider: 'gemini', model: 'm', currency: 'USD', source_reference: null, fetched_at: '2026-11-04', source: 'public_catalog', verified: false };
    const [p] = selectApplicablePrices([
      { ...base, id: 1, input_micros: '1', output_micros: '2', effective_from: '2026-10-01T00:00:00Z', stale: true },
      { ...base, id: 2, input_micros: '3', output_micros: '4', effective_from: '2026-11-01T00:00:00Z', stale: true },
    ]);
    expect(p).toMatchObject({ id: 2, inputMicros: 3, stale: true });
  });
});

describe('validation globale : jamais d’invalidation de masse', () => {
  const OK = parseGooglePricingMarkdown(fixture('google-pricing-2026-11-04.markdoc.md.txt'));
  it('page lisible : acceptée', () => {
    expect(validatePricingSource(OK, ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-pro'], NOV)).toBeNull();
  });
  it('HTML, vide, 0 prix : rejet global avec code', () => {
    expect(validatePricingSource(parseGooglePricingMarkdown(fixture('google-pricing-html-page.html')), [], NOV)).toMatchObject({ code: 'PAGE_HTML' });
    expect(validatePricingSource(parseGooglePricingMarkdown(''), [], NOV)).toMatchObject({ code: 'PAGE_EMPTY' });
    const sansPrix = '## X\n\n*`gemini-x`*\n\n{% tab title="Standard" %}\n{% table %}\n* \n* Free\n* Paid\n---\n* Input price\n* Free\n* Contact sales\n---\n* Output price\n* Free\n* Contact sales\n{% /table %}\n{% /tab %}\n';
    expect(validatePricingSource(parseGooglePricingMarkdown(sansPrix), [], NOV)).toMatchObject({ code: 'NO_PRICES' });
  });
  it(`couverture en chute (> ${COVERAGE_DROP_RATIO * 100} % des modèles tarifés) : rejet global`, () => {
    const partiel = fixture('google-pricing-2026-11-04.markdoc.md.txt').replace(/\* \$0\.30 \(text \/ image \/ video \/ audio\)/, '* see docs')
      .replace(/\* \$0\.25 \(text \/ image \/ video\)/, '* see docs').replace(/\* \$1\.25, prompts <= 200k tokens/, '* see docs');
    expect(validatePricingSource(parseGooglePricingMarkdown(partiel), ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash'], NOV))
      .toMatchObject({ code: 'COVERAGE_DROP' });
  });
});

describe('grille du compte (Cloud Billing) : désactivée par défaut, jamais Vertex', () => {
  it('lue seulement après validation explicite', () => {
    expect(billingSourceValidated({})).toBe(false);
    expect(billingSourceValidated({ AI_PRICING_BILLING_SOURCE: 'validated' })).toBe(true);
    const env = { ...process.env };
    process.env.GOOGLE_BILLING_API_KEY = 'k'; process.env.GOOGLE_BILLING_SERVICE_ID = 's';
    delete process.env.AI_PRICING_BILLING_SOURCE;
    try { expect(new GeminiPricingSource().isConfigured()).toBe(false); } finally { process.env = env; }
  });
});
