/**
 * Lot 113O (carte #713 « Tarification IA : alertes persistantes après le lot
 * 109L ») — tests unitaires purs, sur les fixtures RÉELLES du dépôt
 * (`google-pricing-2026-11-04.markdoc.md.txt`, relevé du 04/11/2026) et leurs
 * variantes : sections perdues, identifiants sous un regroupement `###`,
 * identifiant présent mais non lu, chute de couverture, alias, multimodal.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mentionsModelId, parseGooglePricingMarkdown, resolveModelPrice, rateFor,
} from '../google-pricing-page.adapter';
import { COVERAGE_DROP_RATIO, redactSecrets, safeUrl, validatePricingSource } from '../pricing-sync.service';
import { modalityAwareCost, requiresModalityUsage } from '../../cost-catalog';
import { computeTracePricing, modalityUsageOf, servedModelOf } from '../../../telemetry/trace-pricing';
import {
  clearedReason, expectedPricingAlerts, summarizePricing, unpricedCauseText, PRICING_ALERT_CODES, type PricingConditions,
} from '../pricing-supervision';
import { decideCause, pageVerdict, reconciliationCsv, type ModelEvidence, type PricingReconciliationReport } from '../pricing-reconciliation';
import { tokensByModality } from '../../providers/gemini.provider';

const MARKDOC = readFileSync(join(__dirname, 'fixtures', 'google-pricing-2026-11-04.markdoc.md.txt'), 'utf8');
const NOV = new Date('2026-11-04T09:00:00Z');

/** Section « Gemini 2.5 Flash-Lite » de la fixture réelle. */
const SECTION_25_LITE = /## Gemini 2\.5 Flash-Lite\n[\s\S]*?(?=\n## |$)/;

describe('gemini-2.5-flash-lite : absence VÉRIFIÉE ≠ défaut d’extraction', () => {
  it('fixture réelle du 04/11 : KNOWN 0,10 $ / 0,40 $ (Standard payant)', () => {
    expect(resolveModelPrice(parseGooglePricingMarkdown(MARKDOC), 'gemini-2.5-flash-lite', NOV, MARKDOC))
      .toMatchObject({ status: 'KNOWN', inputPerMillion: 0.1, outputPerMillion: 0.4 });
  });

  it('regroupement « ## Gemini 2.5 » › « ### Gemini 2.5 Flash-Lite » : lu (l’ancien lecteur s’arrêtait au premier ###)', () => {
    const groupe = MARKDOC.replace('## Gemini 2.5 Flash-Lite\n', '## Gemini 2.5 models\n\nOlder generation.\n\n### Gemini 2.5 Flash-Lite\n');
    const r = resolveModelPrice(parseGooglePricingMarkdown(groupe), 'gemini-2.5-flash-lite', NOV, groupe);
    expect(r).toMatchObject({ status: 'KNOWN', inputPerMillion: 0.1, outputPerMillion: 0.4 });
    expect(r.status === 'KNOWN' && r.section).toMatch(/Gemini 2\.5 models › Gemini 2\.5 Flash-Lite/);
  });

  it('identifiant en gras, sous {% tabs %} ou en lien simple : lu', () => {
    const variantes = [
      MARKDOC.replace('*[`gemini-2.5-flash-lite`](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite)*', '**`gemini-2.5-flash-lite`**'),
      MARKDOC.replace(/(## Gemini 2\.5 Flash-Lite\n\n)(\*\[`gemini-2\.5-flash-lite`\][^\n]*\n\n)(\{% tabs %\}\n\n)/, '$1$3$2'),
      MARKDOC.replace('*[`gemini-2.5-flash-lite`](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite)*', '[gemini-2.5-flash-lite](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite)'),
    ];
    for (const v of variantes) {
      expect(resolveModelPrice(parseGooglePricingMarkdown(v), 'gemini-2.5-flash-lite', NOV, v)).toMatchObject({ status: 'KNOWN', inputPerMillion: 0.1 });
    }
  });

  it('identifiant présent sur la page mais rattaché à aucun tableau lisible : NOT_PARSED, jamais ABSENT', () => {
    const perdu = MARKDOC.replace(SECTION_25_LITE, '## Deprecated models\n\nThe model `gemini-2.5-flash-lite` will be shut down soon; see the models page.\n');
    expect(resolveModelPrice(parseGooglePricingMarkdown(perdu), 'gemini-2.5-flash-lite', NOV, perdu)).toMatchObject({ status: 'UNKNOWN', code: 'NOT_PARSED' });
    // Sans le texte reçu (ancien appel) : comportement 109L inchangé.
    expect(resolveModelPrice(parseGooglePricingMarkdown(perdu), 'gemini-2.5-flash-lite', NOV)).toMatchObject({ code: 'ABSENT' });
  });

  it('section réellement retirée (identifiant exact nulle part) : ABSENT vérifié', () => {
    const retire = MARKDOC.replace(SECTION_25_LITE, '');
    expect(resolveModelPrice(parseGooglePricingMarkdown(retire), 'gemini-2.5-flash-lite', NOV, retire)).toMatchObject({ status: 'UNKNOWN', code: 'ABSENT' });
  });

  it('recherche EXACTE : jamais par ressemblance de nom', () => {
    expect(mentionsModelId('see `gemini-2.5-flash-lite-preview-09-2025`', 'gemini-2.5-flash-lite')).toBe(false);
    expect(mentionsModelId('gemini-2.5-flash-lite.', 'gemini-2.5-flash-lite')).toBe(true);
    expect(mentionsModelId('models/gemini-2.5-flash-lite)', 'gemini-2.5-flash-lite')).toBe(true);
    expect(mentionsModelId('gemini-2.5-flash-lite', 'gemini-2.5-flash')).toBe(false);
    expect(mentionsModelId('gemini-flash-latest', 'gemini-flash')).toBe(false);
    // Un alias n'est jamais rattaché à un modèle tarifé par son nom.
    expect(resolveModelPrice(parseGooglePricingMarkdown(MARKDOC), 'gemini-flash-lite-latest', NOV, MARKDOC)).toMatchObject({ status: 'UNKNOWN', code: 'ABSENT' });
  });

  it('une phrase de description citant un modèle n’en fait pas un identifiant de section', () => {
    const md = MARKDOC.replace('Our most intelligent Flash model,', 'Replaces `gemini-3.1-flash-lite` as our most intelligent Flash model,');
    const p = parseGooglePricingMarkdown(md);
    expect(p.ok && p.sections.find((s) => s.heading === 'Gemini 3.8 Flash')?.modelIds).toEqual(['gemini-3.8-flash']);
    expect(resolveModelPrice(p, 'gemini-3.1-flash-lite', NOV, md)).toMatchObject({ status: 'KNOWN', inputPerMillion: 0.25 });
  });
});

describe('chute de couverture : échec documenté, jamais suppression massive', () => {
  const page = parseGooglePricingMarkdown(MARKDOC);
  const ids = page.ok ? [...new Set(page.sections.flatMap((s) => s.modelIds))] : [];

  it('sections perdues au-delà du seuil par rapport à la dernière lecture saine : COVERAGE_DROP', () => {
    // Page « lisible globalement » : seules les 3 premières sections subsistent.
    const sections = MARKDOC.split(/\n(?=## )/);
    const tronquee = sections.slice(0, 4).join('\n');
    const p = parseGooglePricingMarkdown(tronquee);
    expect(p.ok).toBe(true);
    expect(validatePricingSource(p, [], NOV)).toBeNull(); // sans référence : contrôle 109L seul (rien de connu)
    expect(validatePricingSource(p, [], NOV, { logId: 1, modelIds: ids, sections: 11 })).toMatchObject({ code: 'COVERAGE_DROP' });
  });

  it('une seule section retirée : lecture acceptée (absence vérifiée ciblée)', () => {
    const p = parseGooglePricingMarkdown(MARKDOC.replace(SECTION_25_LITE, ''));
    expect(validatePricingSource(p, [], NOV, { logId: 1, modelIds: ids, sections: 11 })).toBeNull();
    expect(COVERAGE_DROP_RATIO).toBe(0.5);
  });
});

describe('prix par modalité (images, voix) : mesurés, sinon inconnus', () => {
  const page = parseGooglePricingMarkdown(MARKDOC);
  const image = resolveModelPrice(page, 'gemini-3.1-flash-image', NOV, MARKDOC);

  it('sortie image : taux texte+raisonnement 3 $ et image 60 $, « Equivalent to… » ignoré', () => {
    expect(image).toMatchObject({ status: 'KNOWN', inputPerMillion: 0.5, outputPerMillion: 3 });
    expect(image.status === 'KNOWN' && image.tiers).toEqual([{ kind: 'modality', side: 'output', rates: { text: 3, thinking: 3, image: 60 }, requiresBreakdown: true }]);
  });

  it('sans consommation par modalité : coût INCONNU (jamais le tarif texte appliqué aux images)', () => {
    if (image.status !== 'KNOWN') throw new Error('KNOWN attendu');
    const prix = { inputMicros: image.inputPerMillion, outputMicros: image.outputPerMillion, tiers: image.tiers };
    expect(requiresModalityUsage(prix)).toBe(true);
    expect(modalityAwareCost(prix, 1000, 1290, 0, NOV, null)).toMatchObject({ ok: false, code: 'MODALITY_USAGE_UNMEASURED' });
    // Mesurée : 1 000 jetons texte en entrée, 1 290 jetons image + 10 texte en sortie, 50 de raisonnement.
    const c = modalityAwareCost(prix, 1000, 1300, 50, NOV, { input: { text: 1000 }, output: { image: 1290, text: 10 } });
    expect(c.ok && c.exact).toBeCloseTo(1000 * 0.5 + 1290 * 60 + 10 * 3 + 50 * 3);
    // Mesure incohérente avec le total : refusée.
    expect(modalityAwareCost(prix, 1000, 1300, 0, NOV, { output: { image: 100 } })).toMatchObject({ ok: false });
  });

  it('entrée texte = image (audio différent) : base sans mesure, audio chiffré à son prix si mesuré ; PDF au prix image', () => {
    const r = resolveModelPrice(page, 'gemini-2.5-flash', NOV, MARKDOC);
    if (r.status !== 'KNOWN') throw new Error('KNOWN attendu');
    const prix = { inputMicros: r.inputPerMillion, outputMicros: r.outputPerMillion, tiers: r.tiers };
    expect(requiresModalityUsage(prix)).toBe(false);
    expect(modalityAwareCost(prix, 1000, 100, 0, NOV, null)).toEqual({ ok: true, exact: 1000 * 0.3 + 100 * 2.5 });
    const c = modalityAwareCost(prix, 1000, 100, 0, NOV, { input: { text: 600, audio: 100, pdf: 300 }, output: { text: 100 } });
    expect(c.ok && c.exact).toBeCloseTo(600 * 0.3 + 100 * 1 + 300 * 0.3 + 100 * 2.5);
    expect(rateFor({ image: 0.3 }, 'pdf')).toBe(0.3);
  });

  it('jetons par modalité relevés de la réponse Gemini (DOCUMENT → pdf)', () => {
    expect(tokensByModality({
      promptTokenCount: 30, promptTokensDetails: [{ modality: 'TEXT' as never, tokenCount: 10 }, { modality: 'DOCUMENT' as never, tokenCount: 20 }],
      candidatesTokensDetails: [{ modality: 'IMAGE' as never, tokenCount: 1290 }],
    } as never)).toEqual({ input: { text: 10, pdf: 20 }, output: { image: 1290 } });
    expect(tokensByModality(undefined)).toBeNull();
  });
});

describe('trace : alias résolu par l’API, modalité, coût inconnu jamais converti en zéro', () => {
  const tarifs: Record<string, number> = { 'gemini-3.5-flash-lite': 0.3 };
  const priceCall = (p: { model: string; inputTokens: number; outputTokens: number }) => (tarifs[p.model] !== undefined
    ? { costMicros: Math.round(p.inputTokens * tarifs[p.model] + p.outputTokens * 2.5), exactMicros: p.inputTokens * tarifs[p.model] + p.outputTokens * 2.5, price: {} }
    : { costMicros: null, exactMicros: null, price: null });
  const base = { provider: 'gemini', status: 'success' as const, inputTokens: 10_000, outputTokens: 100, costMicros: null };

  it('`gemini-flash-lite-latest` servi par `gemini-3.5-flash-lite` (modelVersion) : tarif du modèle servi, base tracée', () => {
    const r = computeTracePricing({ ...base, model: 'gemini-flash-lite-latest', providerMeta: { modelVersion: 'models/gemini-3.5-flash-lite' } }, { priceCall });
    expect(r).toMatchObject({ status: 'applied', costMicros: 3250, pricedModel: 'gemini-3.5-flash-lite', pricingBasis: 'served_model' });
  });

  it('sans modelVersion (résolution non prouvée) : coût NULL, statut missing — jamais un prix supposé', () => {
    expect(computeTracePricing({ ...base, model: 'gemini-flash-lite-latest' }, { priceCall })).toMatchObject({ status: 'missing', costMicros: null, pricedModel: null });
    expect(computeTracePricing({ ...base, model: 'gemini-flash-lite-latest', providerMeta: { modelVersion: 'gemini-9-inconnu' } }, { priceCall })).toMatchObject({ status: 'missing', costMicros: null });
    expect(servedModelOf({ modelVersion: 'gemini-x' }, 'gemini-x')).toBeNull();
  });

  it('tarif par modalité sans consommation mesurée : insufficient_usage + motif précis', () => {
    const r = computeTracePricing({ ...base, model: 'img' }, { priceCall: () => ({ costMicros: null, exactMicros: null, price: {}, unknownCode: 'MODALITY_USAGE_UNMEASURED' }) });
    expect(r).toMatchObject({ status: 'insufficient_usage', costMicros: null, reasonCode: 'MODALITY_USAGE_UNMEASURED' });
    expect(modalityUsageOf({ tokensByModality: { input: { text: 3, bad: 'x' } } })).toEqual({ input: { text: 3 } });
  });

  it('coût connu arrondi à 0 : zero_or_rounded (pas un tarif manquant)', () => {
    const r = computeTracePricing({ ...base, model: 'gemini-3.5-flash-lite', inputTokens: 1, outputTokens: 0, costMicros: 0 }, { priceCall });
    expect(r.status).toBe('zero_or_rounded');
  });
});

describe('supervision : trois risques séparés, une alerte par condition, libellés factuels', () => {
  const vide: PricingConditions = { evaluatedAt: NOV.toISOString(), activeUnpriced: [], unpricedCalls: [], stale: [], source: null, absenceVerifiable: true };

  it('historique seul : aucune fausse alerte « chaîne active » ; appels signalés au bon endroit', () => {
    const c: PricingConditions = { ...vide, unpricedCalls: [{ model: 'gemini-omni-1.1-flash', calls: 4, firstAt: '2026-10-20T00:00:00Z', lastAt: '2026-10-28T00:00:00Z', byStatus: { missing: 4 }, priceNow: false, inActiveChain: false }] };
    const a = expectedPricingAlerts(c);
    expect(a.map((x) => x.code)).toEqual([PRICING_ALERT_CODES.calls]);
    expect(a[0]).toMatchObject({ conditionKey: 'pricing:calls:gemini-omni-1.1-flash', severity: 'warning' });
    expect(a[0].message).toMatch(/4 appel\(s\) de gemini-omni-1\.1-flash/);
    const s = summarizePricing(c, 1, []);
    expect(s.counters).toMatchObject({ activeUnpriced: 0, unpricedCalls: 4, unpricedCallModels: 1 });
  });

  it('tarif redevenu applicable : appels à régulariser en information, plus d’alerte « chaîne active »', () => {
    const c: PricingConditions = { ...vide, unpricedCalls: [{ model: 'm', calls: 2, firstAt: '2026-11-01T00:00:00Z', lastAt: '2026-11-02T00:00:00Z', byStatus: { missing: 2 }, priceNow: true, inActiveChain: true }] };
    expect(expectedPricingAlerts(c)[0]).toMatchObject({ severity: 'info', message: expect.stringMatching(/simulation de régularisation possible/) });
    expect(clearedReason(PRICING_ALERT_CODES.active, 'm', c)).toMatch(/tarif applicable ou modèle absent des chaînes actives/);
  });

  it('ABSENT affiché seulement si l’absence est vérifiée ; sinon « tarif non confirmé / modèle à vérifier »', () => {
    const a = { reasonCode: 'ABSENT', reason: 'absent', pageStatus: 'UNKNOWN', servedModels: [] };
    expect(unpricedCauseText(a, true)).toMatch(/absence vérifiée/);
    expect(unpricedCauseText(a, false)).toMatch(/tarif non confirmé : modèle à vérifier/);
    expect(unpricedCauseText({ ...a, reasonCode: 'NOT_PARSED' }, true)).toMatch(/défaut d’extraction/);
    expect(unpricedCauseText({ ...a, servedModels: ['gemini-3.5-flash'] }, true)).toMatch(/alias servi par gemini-3\.5-flash/);
  });

  it('17 identifiants signalés → une synthèse groupée, pas 17 bandeaux', () => {
    const modeles = Array.from({ length: 17 }, (_x, i) => `gemini-l113o-${i}`);
    const c: PricingConditions = {
      ...vide,
      activeUnpriced: modeles.slice(0, 2).map((m) => ({ model: m, usages: [{ treatment: 'T1', rank: 'fallback2' }], pageStatus: 'UNKNOWN', reasonCode: 'ABSENT', reason: null, servedModels: [] })),
      unpricedCalls: modeles.map((m) => ({ model: m, calls: 3, firstAt: '2026-11-01T00:00:00Z', lastAt: '2026-11-05T00:00:00Z', byStatus: { missing: 3 }, priceNow: false, inActiveChain: false })),
    };
    const s = summarizePricing(c, 19, []);
    expect(s.severity).toBe('warning');
    expect(s.title).toBe('Tarification IA : 2 modèle(s) de chaînes actives sans tarif · 51 appel(s) historiques non chiffrés (17 modèle(s))');
    expect(summarizePricing(vide, 0, []).severity).toBe('ok');
  });
});

describe('réconciliation : cause prouvée par catégorie', () => {
  const ev = (o: Partial<ModelEvidence>): ModelEvidence => ({
    model: 'm', flaggedBy: ['alerte'], catalog: null,
    page: { verdict: 'KNOWN', code: null, reason: null, mentioned: true, section: 'S', inputPerMillion: 0.1, outputPerMillion: 0.4, modalityDependent: false },
    status: null, applied: null, cacheThisInstance: { present: false, rowId: null }, activeUsages: [],
    calls: { total: 0, success: 0, error: 0, inputTokens: 0, outputTokens: 0, lastAt: null, byStatus: {}, corrected: 0, unknownCost: 0, servedModels: {} },
    unpricedCauses: {}, regularizable: 0, alerts: { open: 1, resolved: 0, codes: [] }, ...o,
  });
  const no = () => false;
  const applied = { rowId: 9, source: 'public_catalog', verified: false, inputPerMillion: 0.1, outputPerMillion: 0.4, effectiveFrom: null, stale: false, reference: null };

  it('page reçue lisible par le parseur courant mais tarif non synchronisé : non couvert par le parseur', () => {
    expect(decideCause(ev({}), no).primaryCause).toBe('NOT_COVERED_BY_PARSER');
  });
  it('absence vérifiée, alias, cache, STALE, consommation, arrondi, résolue', () => {
    expect(decideCause(ev({ page: { ...ev({}).page, verdict: 'ABSENT', mentioned: false } }), no).primaryCause).toBe('ABSENT_VERIFIED');
    expect(decideCause(ev({ page: { ...ev({}).page, verdict: 'ABSENT' }, calls: { ...ev({}).calls, servedModels: { 'gemini-3.5-flash': 3 } } }), (m) => m === 'gemini-3.5-flash').primaryCause).toBe('ALIAS_RESOLVED');
    expect(decideCause(ev({ page: { ...ev({}).page, verdict: 'ABSENT' }, calls: { ...ev({}).calls, servedModels: { x: 3 } } }), no).primaryCause).toBe('ALIAS_UNRESOLVED');
    expect(decideCause(ev({ applied, unpricedCauses: { CACHE_NOT_LOADED: 4 }, cacheThisInstance: { present: true, rowId: 9 } }), no).primaryCause).toBe('CACHE_MISSING');
    expect(decideCause(ev({ applied: { ...applied, stale: true }, cacheThisInstance: { present: true, rowId: 9 } }), no).primaryCause).toBe('STALE');
    expect(decideCause(ev({ applied, cacheThisInstance: { present: true, rowId: 9 }, unpricedCauses: { USAGE_MISSING: 2 } }), no).primaryCause).toBe('USAGE_INSUFFICIENT');
    expect(decideCause(ev({ applied, cacheThisInstance: { present: true, rowId: 9 }, calls: { ...ev({}).calls, byStatus: { zero_or_rounded: 5 } } }), no).primaryCause).toBe('ZERO_OR_ROUNDED');
    expect(decideCause(ev({ applied, cacheThisInstance: { present: true, rowId: 9 }, alerts: { open: 0, resolved: 3, codes: [] } }), no).primaryCause).toBe('ALERT_RESOLVED');
    expect(decideCause(ev({ page: { ...ev({}).page, verdict: 'NO_SNAPSHOT' } }), no).primaryCause).toBe('SOURCE_NOT_CAPTURED');
  });
  it('verdict de la page réellement reçue et export CSV sans secret', () => {
    const p = parseGooglePricingMarkdown(MARKDOC);
    expect(pageVerdict(p, MARKDOC, 'gemini-2.5-flash-lite', NOV)).toMatchObject({ verdict: 'KNOWN', mentioned: true, inputPerMillion: 0.1 });
    expect(pageVerdict(null, null, 'x', NOV).verdict).toBe('NO_SNAPSHOT');
    const r = { models: [{ ...ev({}), ...decideCause(ev({}), no), model: 'gemini-a;b' }] } as unknown as PricingReconciliationReport;
    const csv = reconciliationCsv(r);
    expect(csv.split('\r\n')[0]).toMatch(/^﻿model;primary_cause;cause_label/);
    expect(csv).toContain('"gemini-a;b"');
  });
});

describe('contenu reçu conservé sans secret', () => {
  it('motifs de clé masqués, URL sans paramètres', () => {
    const r = redactSecrets(`x AIza${'a'.repeat(35)} y https://h/p?key=abcdefghijkl&z=1 Bearer ${'b'.repeat(30)}`);
    expect(r.redactions).toBe(3);
    expect(r.text).not.toMatch(/AIza|abcdefghijkl|bbbbbbbb/);
    expect(safeUrl('https://aistudio.google.com/docs/pricing?authuser=1#x')).toBe('https://aistudio.google.com/docs/pricing');
  });
});
