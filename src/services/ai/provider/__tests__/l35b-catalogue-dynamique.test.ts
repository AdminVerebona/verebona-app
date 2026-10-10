/**
 * Lot 35B — ticket « Catalogue IA dynamique Google : modèles, tarifs, Preview
 * et alertes BO » : critères d'acceptation CAT-01 à CAT-16, partie PURE
 * (contexte injecté). Le parcours complet sur PostgreSQL réel est couvert par
 * `src/test/e2e/scenarios/l35b-catalogue-dynamique.e2e.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  usableModelsForTreatment, evaluateModelForTreatment, usableForAnyTreatment, type UsableModelsContext,
} from '../../registry/usable-models';
import { detectActiveModelAnomalies, anomalyMessage, type ActiveChainEntry } from '../active-model-anomalies';
import { bannerText } from '../new-models.service';
import { qualificationOrder } from '../ai-catalog-sync.service';
import { TREATMENTS } from '../../config/treatments';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) } }));

const OK = { generate: true, structured: true, multimodal: true, thinking: null };

function ctx(over: Partial<UsableModelsContext> = {}): UsableModelsContext {
  const listes: Array<[string, Partial<{ available: boolean; lifecycle: 'stable' | 'preview' | 'experimental' }>]> = [
    ['gemini-3.5-flash-lite', {}], ['gemini-3.1-flash-lite', {}], ['gemini-3.6-flash', {}],
    // Nouveaux modèles Google, inconnus du code.
    ['gemini-9-flash', {}], ['gemini-9-pro-preview', { lifecycle: 'preview' }], ['gemini-9-flash-exp', { lifecycle: 'experimental' }],
    ['gemini-9-texte', {}],
  ];
  return {
    environment: 'production',
    catalog: {
      refreshedAt: '2026-10-10T06:00:00Z',
      models: listes.map(([model, o]) => ({ model, available: o.available ?? true, supportsGeneration: true, lifecycle: o.lifecycle ?? 'stable' })),
    },
    codeCatalog: [],
    // gemini-9-flash : aucun tarif récupérable.
    price: (m) => (m.startsWith('gemini-9') ? null : { verified: false }),
    operational: new Map(),
    qualifications: new Map([
      ['gemini-9-flash', OK], ['gemini-9-pro-preview', OK], ['gemini-9-flash-exp', OK],
      // Qualifié sans multimodal : utilisable seulement là où l'image n'est pas requise.
      ['gemini-9-texte', { ...OK, multimodal: false }],
    ]),
    today: '2026-10-10',
    ...over,
  };
}
const noms = (t: (typeof TREATMENTS)[number], c = ctx()) => usableModelsForTreatment(t, c).map((m) => m.model);

describe('CAT-01 à CAT-04 — nouveau modèle découvert, qualifié, proposé sans commit', () => {
  it('CAT-01/CAT-02 — modèle inconnu du code, listé par Google : candidat sans aucune déclaration', () => {
    const e = evaluateModelForTreatment('T3', 'gemini-9-flash', ctx({ qualifications: new Map() }));
    expect(e.reasons).toEqual(['QUALIFICATION_PENDING']);
  });
  it('CAT-03/CAT-04 — qualification réussie : présent dans les sélecteurs des traitements compatibles', () => {
    for (const t of TREATMENTS) expect(noms(t), t).toContain('gemini-9-flash');
    expect(usableModelsForTreatment('T1', ctx()).find((m) => m.model === 'gemini-9-flash')).toMatchObject({ qualification: 'auto', status: 'stable' });
  });
  it('CAT-04 — éligibilité PAR CAPACITÉ : sans multimodal, absent de T1/T2 (images), présent pour T3/T4/T5', () => {
    expect(noms('T1')).not.toContain('gemini-9-texte');
    expect(noms('T2')).not.toContain('gemini-9-texte');
    for (const t of ['T3', 'T4', 'T5'] as const) expect(noms(t), t).toContain('gemini-9-texte');
    expect(evaluateModelForTreatment('T1', 'gemini-9-texte', ctx()).reasons).toEqual(['CAPABILITY_MISSING']);
  });
  it('CAT-03 — qualification en échec : absent partout', () => {
    const c = ctx({ qualifications: new Map([['gemini-9-flash', { ...OK, generate: false }]]) });
    for (const t of TREATMENTS) expect(noms(t, c)).not.toContain('gemini-9-flash');
    expect(evaluateModelForTreatment('T3', 'gemini-9-flash', c).reasons).toEqual(['NOT_QUALIFIED']);
  });
  it('transition : modèle du registre jamais qualifié automatiquement → qualification historique ; un résultat automatique prévaut', () => {
    expect(usableModelsForTreatment('T1', ctx()).find((m) => m.model === 'gemini-3.1-flash-lite')).toMatchObject({ qualification: 'historical' });
    const c = ctx({ qualifications: new Map([['gemini-3.1-flash-lite', { ...OK, structured: false }]]) });
    expect(noms('T1', c)).not.toContain('gemini-3.1-flash-lite');
  });
});

describe('CAT-05 à CAT-07 — Preview et tarif inconnu', () => {
  it('CAT-05 — preview qualifié : proposé, statut Preview visible (y compris en production, pour T2)', () => {
    expect(noms('T2')).toContain('gemini-9-pro-preview');
    expect(usableModelsForTreatment('T2', ctx()).find((m) => m.model === 'gemini-9-pro-preview')?.status).toBe('preview');
  });
  it('CAT-06/CAT-07 — sans tarif récupérable : proposé quand même, priced=false (UNKNOWN), aucun montant', () => {
    const m = usableModelsForTreatment('T2', ctx()).find((x) => x.model === 'gemini-9-flash');
    expect(m).toMatchObject({ priced: false, verified: false });
  });
});

describe('CAT-08 — bandeau', () => {
  it('un modèle : « Nouveau modèle Gemini disponible » ; plusieurs : « N nouveaux modèles Gemini sont disponibles »', () => {
    expect(bannerText([{ model: 'gemini-9-flash', displayName: 'Gemini 9 Flash' }])).toEqual({
      title: 'Nouveau modèle Gemini disponible',
      body: 'Gemini 9 Flash est désormais disponible et a été ajouté aux modèles utilisables.',
    });
    expect(bannerText([{ model: 'a', displayName: null }, { model: 'b', displayName: 'B' }, { model: 'c', displayName: null }])?.title)
      .toBe('3 nouveaux modèles Gemini sont disponibles');
    expect(bannerText([])).toBeNull();
  });
  it('un modèle annoncé doit être utilisable pour au moins un traitement (l’expérimental ne l’est jamais)', () => {
    expect(usableForAnyTreatment('gemini-9-flash', ctx())).toBe(true);
    expect(usableForAnyTreatment('gemini-9-flash-exp', ctx())).toBe(false);
  });
});

describe('CAT-12 à CAT-14 — expérimental, retrait, aucun remplacement automatique', () => {
  it('CAT-12 — expérimental (statut fournisseur), même qualifié : jamais proposé', () => {
    for (const t of TREATMENTS) expect(noms(t)).not.toContain('gemini-9-flash-exp');
    expect(evaluateModelForTreatment('T3', 'gemini-9-flash-exp', ctx()).reasons).toEqual(['EXPERIMENTAL']);
  });
  it('CAT-13 — modèle retiré du catalogue de la clé active : plus proposé', () => {
    const retire = ctx();
    retire.catalog = { ...retire.catalog, models: retire.catalog.models.map((m) => (m.model === 'gemini-3.6-flash' ? { ...m, available: false } : m)) };
    for (const t of TREATMENTS) expect(noms(t, retire)).not.toContain('gemini-3.6-flash');
    expect(evaluateModelForTreatment('T5', 'gemini-3.6-flash', retire).reasons).toContain('PROVIDER_UNAVAILABLE');
  });
  it('CAT-13/CAT-14 — modèle ACTIF retiré : anomalie (repli signalé), chaîne inchangée, aucun nouveau modèle substitué', () => {
    const chains: ActiveChainEntry[] = [
      { treatment: 'T5', rank: 'primaryModel', model: 'gemini-3.6-flash', source: 'version' },
      { treatment: 'T5', rank: 'fallback1', model: 'gemini-3.1-flash-lite', source: 'version' },
    ];
    const copie = JSON.parse(JSON.stringify(chains));
    const c = ctx();
    c.catalog = { ...c.catalog, models: c.catalog.models.map((m) => (m.model === 'gemini-3.6-flash' ? { ...m, available: false } : m)) };
    const a = detectActiveModelAnomalies(chains, c);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ treatment: 'T5', rank: 'primaryModel', model: 'gemini-3.6-flash', fallbackAvailable: true });
    expect(anomalyMessage(a[0])).toMatch(/La chaîne de repli prend le relais\. Aucun remplacement automatique/);
    expect(chains).toEqual(copie);
    // Un nouveau modèle utilisable n'est jamais proposé comme remplaçant.
    expect(JSON.stringify(a)).not.toContain('gemini-9-flash');
  });
  it('CAT-14 — un nouveau modèle disponible ne crée aucune anomalie et ne touche pas une chaîne saine', () => {
    const chains: ActiveChainEntry[] = [{ treatment: 'T2', rank: 'primaryModel', model: 'gemini-3.5-flash-lite', source: 'version' }];
    expect(detectActiveModelAnomalies(chains, ctx())).toEqual([]);
  });
  it('ordre de qualification : découverts à ce passage, actifs, registre, puis plus récents ; expérimentaux jamais qualifiés', () => {
    const ordre = qualificationOrder(
      [{ model: 'gemini-2.0-flash' }, { model: 'gemini-9-flash' }, { model: 'gemini-9-flash-exp', lifecycle: 'experimental' }, { model: 'gemini-3.1-flash-lite' }, { model: 'gemini-3.6-flash' }],
      { active: new Set(['gemini-3.6-flash']), declared: new Set(['gemini-3.1-flash-lite', 'gemini-3.6-flash']), discovered: new Set(['gemini-9-flash', 'gemini-9-flash-exp']) },
    );
    expect(ordre).toEqual(['gemini-9-flash', 'gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-2.0-flash']);
  });
});

describe('CAT-15/CAT-16 — coût au tarif de l’appel, jamais estimé', () => {
  afterEach(async () => (await import('../../gateway/pricing/pricing.repository')).clearPricingCache());
  it('tarif inconnu : coût non calculable (null), jetons toujours comptés par l’appelant', async () => {
    const { calcCostMicros } = await import('../../gateway/cost-catalog');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(calcCostMicros('gemini-9-flash', 1000, 100)).toBeNull();
  });
  it('palier de taille d’invite appliqué à toute la requête au-delà du seuil', async () => {
    const { primePricingCache } = await import('../../gateway/pricing/pricing.repository');
    const { calcCostMicros } = await import('../../gateway/cost-catalog');
    primePricingCache([{
      provider: 'gemini', model: 'gemini-2.5-pro', inputMicros: 1.25, outputMicros: 10, currency: 'USD', source: 'public_catalog', verified: false, fetchedAt: new Date(),
      tiers: [{ kind: 'prompt_tokens_above', thresholdTokens: 200_000, inputPerMillion: 2.5, outputPerMillion: 15 }],
    }]);
    expect(calcCostMicros('gemini-2.5-pro', 100_000, 1000)).toBe(Math.round(100_000 * 1.25 + 1000 * 10));
    expect(calcCostMicros('gemini-2.5-pro', 300_000, 1000)).toBe(Math.round(300_000 * 2.5 + 1000 * 15));
  });
});
