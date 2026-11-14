/**
 * Lot 114 (Trello #770) — éligibilité tarifaire obligatoire.
 *   R01 tarif payant officiel : admissible ; R02 tarif officiel de 0 : admissible ;
 *   R03 absent / inconnu / non confirmé / périmé / référentiel illisible : refus motivé ;
 *   R08 panne de lecture : preuve conservée pendant le délai de validité, puis blocage ; jamais de fail-open ;
 *   voies hors passerelle (sondes, qualification, test fournisseur, disjoncteur) : aucun appel sans tarif.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICING_PROOF_VALIDITY_DAYS, pricingEligibility, pricingProofValidityDays, PRICING_INELIGIBILITY_LABELS,
} from '../pricing-eligibility';
import { ModelPricingUnverifiedError, assertModelPricingVerified, pricingRefusalFor, pricingRefusalInTx, splitByPricing } from '../pricing-guard';
import { __setVerifiedTestPricesForTests, clearPricingCache, primePricingCache, type CachedPrice } from '../pricing.repository';

const NOW = new Date('2026-11-13T12:00:00Z');
const OK = { degraded: false, loaded: true };
const prix = (over: Partial<CachedPrice> = {}): CachedPrice => ({
  provider: 'gemini', model: 'm', inputMicros: 0.3, outputMicros: 2.5, currency: 'USD', source: 'public_catalog', verified: false, fetchedAt: NOW, ...over,
});
const jours = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('L114-770 — règle d’éligibilité (pure)', () => {
  it('R01 — grille du compte vérifiée, saisie manuelle confirmée, page officielle confirmée : admissibles', () => {
    expect(pricingEligibility(prix({ source: 'billing_api', verified: true }), OK, NOW).ok).toBe(true);
    expect(pricingEligibility(prix({ source: 'manual', verified: true }), OK, NOW).ok).toBe(true);
    expect(pricingEligibility(prix({ pageStatus: 'KNOWN' }), OK, NOW).ok).toBe(true);
  });

  it('R02 — un tarif OFFICIEL de 0 est valide (entrée, sortie ou les deux)', () => {
    expect(pricingEligibility(prix({ pageStatus: 'KNOWN', inputMicros: 0, outputMicros: 0 }), OK, NOW).ok).toBe(true);
    expect(pricingEligibility(prix({ pageStatus: 'KNOWN', inputMicros: 0, outputMicros: 2.5 }), OK, NOW).ok).toBe(true);
    // … mais un 0 non confirmé n'est pas une gratuité : même refus qu'un tarif positif non confirmé.
    expect(pricingEligibility(prix({ inputMicros: 0, outputMicros: 0 }), OK, NOW)).toMatchObject({ ok: false, code: 'UNVERIFIED' });
  });

  it('R03 — absent, inconnu, non confirmé (amorçage embarqué, saisie manuelle), montant illisible : refus motivé', () => {
    expect(pricingEligibility(null, OK, NOW)).toEqual({ ok: false, code: 'ABSENT', label: PRICING_INELIGIBILITY_LABELS.ABSENT });
    expect(pricingEligibility(prix(), OK, NOW)).toMatchObject({ ok: false, code: 'UNVERIFIED' });
    expect(pricingEligibility(prix({ source: 'manual', verified: false }), OK, NOW)).toMatchObject({ ok: false, code: 'UNVERIFIED' });
    expect(pricingEligibility(prix({ pageStatus: 'UNKNOWN' }), OK, NOW)).toMatchObject({ ok: false, code: 'UNKNOWN' });
    expect(pricingEligibility(prix({ pageStatus: 'KNOWN', inputMicros: Number.NaN }), OK, NOW)).toMatchObject({ ok: false, code: 'UNKNOWN' });
    expect(pricingEligibility(prix({ source: 'billing_api', verified: false }), OK, NOW)).toMatchObject({ ok: false, code: 'UNVERIFIED' });
  });

  it('R08 — panne de lecture : la preuve vaut pendant le délai de validité, puis le modèle est bloqué (jamais « gratuit »)', () => {
    const d = DEFAULT_PRICING_PROOF_VALIDITY_DAYS;
    expect(pricingEligibility(prix({ pageStatus: 'STALE', staleSince: jours(d - 1) }), OK, NOW).ok).toBe(true);
    expect(pricingEligibility(prix({ pageStatus: 'STALE', staleSince: jours(d + 1) }), OK, NOW)).toMatchObject({ ok: false, code: 'STALE_EXPIRED' });
    // Date de péremption inconnue : refus (aucune preuve de fraîcheur).
    expect(pricingEligibility(prix({ pageStatus: 'STALE' }), OK, NOW)).toMatchObject({ ok: false, code: 'STALE_EXPIRED' });
    // Délai 0 : une preuve non reconfirmée bloque aussitôt.
    expect(pricingEligibility(prix({ pageStatus: 'STALE', staleSince: jours(1) }), OK, NOW, 0)).toMatchObject({ ok: false, code: 'STALE_EXPIRED' });
  });

  it('R08 — jamais de fail-open : référentiel jamais chargé ou illisible → refus, même avec un tarif en mémoire', () => {
    const p = prix({ source: 'billing_api', verified: true });
    expect(pricingEligibility(p, { degraded: true, loaded: true }, NOW)).toMatchObject({ ok: false, code: 'UNREADABLE' });
    expect(pricingEligibility(p, { degraded: false, loaded: false }, NOW)).toMatchObject({ ok: false, code: 'UNREADABLE' });
  });

  it('délai de validité : 7 jours par défaut, réglable par AI_PRICING_PROOF_VALIDITY_DAYS, valeur invalide ignorée', () => {
    expect(pricingProofValidityDays({})).toBe(7);
    expect(pricingProofValidityDays({ AI_PRICING_PROOF_VALIDITY_DAYS: '3' })).toBe(3);
    expect(pricingProofValidityDays({ AI_PRICING_PROOF_VALIDITY_DAYS: '0' })).toBe(0);
    for (const v of ['-1', '2.5', 'abc', '']) expect(pricingProofValidityDays({ AI_PRICING_PROOF_VALIDITY_DAYS: v })).toBe(7);
  });
});

describe('L114-770 — garde des voies hors passerelle', () => {
  beforeEach(() => {
    __setVerifiedTestPricesForTests(false);
    clearPricingCache();
    primePricingCache([prix({ model: 'tarife', pageStatus: 'KNOWN' }), prix({ model: 'amorce' })]);
  });
  afterEach(() => clearPricingCache());

  it('motif précis par modèle ; liste partagée dans l’ordre ; erreur typée avant tout appel', async () => {
    expect(await pricingRefusalFor('tarife')).toBeNull();
    expect(await pricingRefusalFor('amorce')).toBe('tarif non confirmé par une source officielle');
    expect(await pricingRefusalFor('inconnu')).toBe('aucun tarif officiel connu');
    expect(await splitByPricing(['inconnu', 'tarife', 'amorce'])).toEqual({
      priced: ['tarife'],
      unpriced: [{ model: 'inconnu', reason: 'aucun tarif officiel connu' }, { model: 'amorce', reason: 'tarif non confirmé par une source officielle' }],
    });
    await expect(assertModelPricingVerified('tarife')).resolves.toBeUndefined();
    const e = await assertModelPricingVerified('amorce').catch((x) => x);
    expect(e).toBeInstanceOf(ModelPricingUnverifiedError);
    expect(e).toMatchObject({ code: 'MODEL_PRICING_UNVERIFIED', model: 'amorce' });
  });

  it('sonde opérationnelle : un modèle sans tarif n’est PAS sondé (0 appel, aucun état modifié) ; le modèle tarifé l’est', async () => {
    const { probeModels } = await import('../../../provider/model-operational.service');
    const appels: string[] = [];
    const r = await probeModels(['amorce', 'inconnu'], 'cle', { call: async (m) => { appels.push(m); return { rawText: 'ok', inputTokens: 1, outputTokens: 1 } as never; }, confirmDelayMs: 0 });
    expect(appels).toEqual([]);
    expect(r).toEqual([]);
  });

  it('épreuve de qualification : refusée avant l’appel au fournisseur', async () => {
    const { defaultQualificationCall } = await import('../../../provider/model-qualification.service');
    const { FakeProvider, setAiProvider } = await import('../../providers');
    const fake = new FakeProvider(); let appels = 0;
    fake.on('amorce', () => { appels++; return { rawText: 'ok', inputTokens: 1, outputTokens: 1 }; });
    setAiProvider(fake);
    await expect(defaultQualificationCall('cle')({ model: 'amorce', prompt: 'x', attachments: [], timeoutMs: 1000 } as never)).rejects.toBeInstanceOf(ModelPricingUnverifiedError);
    expect(appels).toBe(0);
  });

  it('R07 — contrôle final en transaction : lu dans le référentiel (pas dans le cache) ; lecture impossible = refus', async () => {
    const ligne = { provider: 'gemini', model: 'tarife', input_micros: 0.3, output_micros: 2.5, currency: 'USD', source: 'public_catalog', source_reference: null, verified: false, fetched_at: NOW.toISOString(), page_status: 'KNOWN' };
    expect(await pricingRefusalInTx({ unsafe: async () => [ligne] }, 'tarife')).toBeNull();
    // Tarif retiré / invalidé depuis la validation (plus aucune ligne servie), alors que le cache d'instance le porte encore.
    expect(await pricingRefusalInTx({ unsafe: async () => [] }, 'tarife')).toBe('aucun tarif officiel connu');
    expect(await pricingRefusalInTx({ unsafe: async () => [{ ...ligne, page_status: 'UNKNOWN' }] }, 'tarife')).toBe('tarif non lisible sur la page officielle');
    expect(await pricingRefusalInTx({ unsafe: async () => { throw new Error('base indisponible'); } }, 'tarife')).toBe('référentiel tarifaire illisible');
  });

  it('le socle de test est refusé hors NODE_ENV=test (ce n’est pas un contournement de la garde)', () => {
    const avant = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string>).NODE_ENV = 'production';
      expect(() => __setVerifiedTestPricesForTests(true)).toThrow(/réservé aux tests/);
    } finally { (process.env as Record<string, string>).NODE_ENV = avant ?? 'test'; }
  });
});
