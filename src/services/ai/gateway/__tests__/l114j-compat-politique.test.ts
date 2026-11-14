/**
 * Lot 114 (carte #776, cahier des charges §5 — AC06) — POLITIQUE de
 * compatibilité des schémas : états, clé d'un couple, réexamen borné,
 * idempotence. Fonctions pures ; instants fixes (aucune dépendance à la date).
 */
import { describe, expect, it } from 'vitest';
import {
  SCHEMA_COMPAT_POLICY as P, SCHEMA_COMPAT_STATES, applySchemaOutcome, claimRetestOf, coupleKeyId, nextRetestDelayMs, schemaUseOf,
  type SchemaCoupleKey,
} from '../schema-compat/policy';

const T0 = Date.UTC(2026, 10, 13, 8, 0, 0);
const key = (over: Partial<SchemaCoupleKey> = {}): SchemaCoupleKey => ({
  provider: 'gemini', model: 'modele-a', operationCode: 't1_analyze_document', contractId: 'T1_ANALYZE_DOCUMENT', contractVersion: 7,
  schemaHash: 'aaaaaaaaaaaa', providerSchemaHash: 'bbbbbbbbbbbb', adapterVersion: 'ps-test-1', ...over,
});
const REFUS = { kind: 'REJECTED', reason: 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA' } as const;

describe('L114J-POL — états et clé d’un couple', () => {
  it('L114J-POL-01 — les cinq états du cahier des charges', () => {
    expect([...SCHEMA_COMPAT_STATES]).toEqual(['NOT_TESTED', 'QUALIFIED', 'REJECTED_CONFIRMED', 'NEEDS_RECHECK', 'UNSUPPORTED_BY_CONTRACT']);
  });

  it('L114J-POL-02 — INVALIDATION : changer le modèle, l’opération, le contrat, le schéma projeté ou l’adaptateur donne une autre clé', () => {
    const base = coupleKeyId(key());
    const variantes: Array<Partial<SchemaCoupleKey>> = [
      { model: 'modele-b' }, { operationCode: 't3_document_naming' }, { contractVersion: 8 }, { schemaHash: 'cccccccccccc' },
      { providerSchemaHash: 'dddddddddddd' }, { adapterVersion: 'ps-test-2' }, { provider: 'autre' }, { providerSchemaHash: null },
    ];
    const cles = variantes.map((v) => coupleKeyId(key(v)));
    for (const c of cles) expect(c).not.toBe(base);
    expect(new Set(cles).size).toBe(cles.length);
    // Stable : même identité, même clé ; aucun contenu (identifiants, versions, empreintes).
    expect(coupleKeyId(key())).toBe(base);
    expect(base).toBe('gemini|modele-a|t1_analyze_document|T1_ANALYZE_DOCUMENT@7|aaaaaaaaaaaa|bbbbbbbbbbbb|ps-test-1');
  });
});

describe('L114J-POL — décision d’envoi', () => {
  it('L114J-POL-03 — couple inconnu ou qualifié : schéma transmis ; refus mémorisé : non transmis jusqu’à l’échéance', () => {
    expect(schemaUseOf(null, T0)).toEqual({ send: true, retest: false, why: 'not_tested' });
    const refuse = applySchemaOutcome(null, key(), REFUS, T0);
    expect(refuse).toMatchObject({ state: 'REJECTED_CONFIRMED', reason: 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA', rejectionCount: 1, consecutiveRejections: 1, nextRetestAt: T0 + P.firstRetestMs });
    expect(schemaUseOf(refuse, T0 + 1)).toEqual({ send: false, retest: false, why: 'recent_rejection' });
    expect(schemaUseOf(refuse, T0 + P.firstRetestMs - 1)).toMatchObject({ send: false });
    expect(schemaUseOf(refuse, T0 + P.firstRetestMs)).toEqual({ send: true, retest: true, why: 'retest_due' });
    const qualifie = applySchemaOutcome(null, key(), { kind: 'ACCEPTED' }, T0);
    expect(qualifie).toMatchObject({ state: 'QUALIFIED', reason: 'ACCEPTED_ON_REAL_CALL', acceptedCount: 1 });
    expect(schemaUseOf(qualifie, T0 + 1)).toEqual({ send: true, retest: false, why: 'qualified' });
  });

  it('L114J-POL-04 — réexamen RÉSERVÉ : un seul preneur, les autres attendent ; réservation caduque reprenable', () => {
    const refuse = applySchemaOutcome(null, key(), REFUS, T0);
    const du = T0 + P.firstRetestMs + 5;
    expect(claimRetestOf(refuse, du - 10)).toBeNull();
    const reserve = claimRetestOf(refuse, du)!;
    expect(reserve).toMatchObject({ state: 'NEEDS_RECHECK', retestClaimedUntil: du + P.retestLeaseMs, retestCount: 1 });
    // Tant que la réservation court : ni envoi ni seconde réservation.
    expect(schemaUseOf(reserve, du + 1)).toEqual({ send: false, retest: false, why: 'retest_in_progress' });
    expect(claimRetestOf(reserve, du + 1)).toBeNull();
    // Instance arrêtée en plein essai : la réservation expire, l'essai redevient prenable (jamais d'exclusion définitive).
    expect(claimRetestOf(reserve, du + P.retestLeaseMs + 1)).toMatchObject({ state: 'NEEDS_RECHECK', retestCount: 2 });
  });
});

describe('L114J-POL — transitions', () => {
  it('L114J-POL-05 — délai doublé à chaque refus consécutif, plafonné ; jamais nul', () => {
    expect(nextRetestDelayMs(1, false)).toBe(P.firstRetestMs);
    expect(nextRetestDelayMs(2, false)).toBe(2 * P.firstRetestMs);
    expect(nextRetestDelayMs(3, false)).toBe(4 * P.firstRetestMs);
    expect(nextRetestDelayMs(40, false)).toBe(P.maxRetestMs);
    expect(nextRetestDelayMs(0, false)).toBe(P.firstRetestMs);
    // Couple déjà accepté, premier refus : revu plus tôt (le refus peut tenir à une requête).
    expect(nextRetestDelayMs(1, true)).toBe(P.retestAfterQualifiedMs);
    expect(nextRetestDelayMs(2, true)).toBe(2 * P.firstRetestMs);
  });

  it('L114J-POL-06 — IDEMPOTENCE : des refus concurrents du même couple ne doublent pas le délai', () => {
    const un = applySchemaOutcome(null, key(), REFUS, T0);
    const deux = applySchemaOutcome(un, key(), REFUS, T0 + 50);
    const trois = applySchemaOutcome(deux, key(), { kind: 'REJECTED', reason: 'EXPLICIT_SCHEMA_REJECTION' }, T0 + 80);
    expect(trois).toMatchObject({ state: 'REJECTED_CONFIRMED', consecutiveRejections: 1, rejectionCount: 3, nextRetestAt: un.nextRetestAt, reason: 'EXPLICIT_SCHEMA_REJECTION' });
  });

  it('L114J-POL-07 — réexamen refusé : délai doublé ; réexamen accepté : qualifié, compteur remis à zéro', () => {
    const un = applySchemaOutcome(null, key(), REFUS, T0);
    const t1 = T0 + P.firstRetestMs + 1;
    const reserve = claimRetestOf(un, t1)!;
    const refuseEncore = applySchemaOutcome(reserve, key(), REFUS, t1 + 10);
    expect(refuseEncore).toMatchObject({ state: 'REJECTED_CONFIRMED', consecutiveRejections: 2, nextRetestAt: t1 + 10 + 2 * P.firstRetestMs, retestClaimedUntil: null });
    const accepte = applySchemaOutcome(reserve, key(), { kind: 'ACCEPTED' }, t1 + 10);
    expect(accepte).toMatchObject({ state: 'QUALIFIED', consecutiveRejections: 0, nextRetestAt: null, retestClaimedUntil: null, rejectionCount: 1 });
    // Refus d'un couple déjà accepté : revu après le délai court.
    const rechute = applySchemaOutcome(accepte, key(), REFUS, t1 + 1000);
    expect(rechute).toMatchObject({ state: 'REJECTED_CONFIRMED', consecutiveRejections: 1, nextRetestAt: t1 + 1000 + P.retestAfterQualifiedMs });
  });

  it('L114J-POL-08 — issue SANS CONCLUSION : rien n’est déduit ; un réexamen réservé est rendu avec un court report', () => {
    // Hors réexamen : aucun état créé ni modifié.
    expect(applySchemaOutcome(null, key(), { kind: 'INCONCLUSIVE' }, T0)).toMatchObject({ state: 'NOT_TESTED', rejectionCount: 0 });
    const qualifie = applySchemaOutcome(null, key(), { kind: 'ACCEPTED' }, T0);
    expect(applySchemaOutcome(qualifie, key(), { kind: 'INCONCLUSIVE' }, T0 + 5)).toBe(qualifie);
    const refuse = applySchemaOutcome(null, key(), REFUS, T0);
    const t1 = T0 + P.firstRetestMs;
    const rendu = applySchemaOutcome(claimRetestOf(refuse, t1)!, key(), { kind: 'INCONCLUSIVE' }, t1 + 20);
    expect(rendu).toMatchObject({ state: 'REJECTED_CONFIRMED', reason: 'RETEST_INCONCLUSIVE', consecutiveRejections: 1, retestClaimedUntil: null, nextRetestAt: t1 + 20 + P.inconclusiveRetestMs });
  });

  it('L114J-POL-09 — politique versionnée et bornée (paramètres centralisés)', () => {
    expect(P.version).toBe(1);
    expect(P.firstRetestMs).toBe(6 * 3_600_000);
    expect(P.maxRetestMs).toBeGreaterThan(P.firstRetestMs);
    expect(P.retestLeaseMs).toBeLessThan(P.firstRetestMs);
    expect(applySchemaOutcome(null, key(), REFUS, T0).policyVersion).toBe(P.version);
  });
});
