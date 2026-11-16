/**
 * Lot 115 (carte #784) — PASSERELLE DES MODÈLES : identité élargie d'un couple
 * (§A3), statut de routage réel d'un couple (§E1) et rattrapage reprenable des
 * alertes de compatibilité (§E2).
 *
 * Fonctions pures ou à dépendances injectées ; instants fixes (aucune
 * dépendance à la date du jour) ; AUCUN appel à un fournisseur d'IA.
 *
 * Ce que ces tests ne prouvent PAS : qu'un schéma donné est accepté par
 * Gemini. Aucun essai réel n'est possible depuis l'atelier — cela ne se
 * vérifiera qu'en préproduction (cf. `docs/exploitation/recette-115g-passerelle-ia.md`).
 */
import { describe, expect, it } from 'vitest';
import {
  applyServedVersion, applySchemaOutcome, coupleKeyId, generationProfileHashOf, GENERATION_PROFILE_KEYS,
  type GenerationProfile, type SchemaCoupleKey,
} from '../schema-compat/policy';
import { coupleRoutingStatus } from '../schema-compat/static-matrix';

const T0 = Date.UTC(2026, 10, 16, 8, 0, 0);
const key = (over: Partial<SchemaCoupleKey> = {}): SchemaCoupleKey => ({
  provider: 'gemini', model: 'modele-a', operationCode: 't1_analyze_document', contractId: 'T1_ANALYZE_DOCUMENT', contractVersion: 7,
  schemaHash: 'aaaaaaaaaaaa', providerSchemaHash: 'bbbbbbbbbbbb', adapterVersion: 'ps-test-1', ...over,
});
const REFUS = { kind: 'REJECTED', reason: 'GENERIC_400_ANSWERED_WITHOUT_SCHEMA' } as const;

describe('L784-ID — profil de génération dans l’identité du couple (§A3)', () => {
  it('L784-ID-01 — profil SANS paramètre matériel : clé historique INCHANGÉE (rétrocompatibilité exacte)', () => {
    // La carte exige une migration additive et rétrocompatible : les couples mémorisés avant ce lot
    // doivent garder leur identité, sinon toute la mémoire des refus serait perdue d'un coup.
    expect(generationProfileHashOf(null)).toBe('-');
    expect(generationProfileHashOf(undefined)).toBe('-');
    expect(generationProfileHashOf({})).toBe('-');
    expect(generationProfileHashOf({ maxOutputTokens: null, thinkingConfig: null, jsonResponse: false, generation: null })).toBe('-');
    // Même chaîne que dans la base avant ce lot (aucun segment ajouté).
    expect(coupleKeyId(key())).toBe('gemini|modele-a|t1_analyze_document|T1_ANALYZE_DOCUMENT@7|aaaaaaaaaaaa|bbbbbbbbbbbb|ps-test-1');
    expect(coupleKeyId({ ...key(), generationProfileHash: '-' })).toBe(coupleKeyId(key()));
  });

  it('L784-ID-02 — un AUTRE profil est un AUTRE couple : plafond, réflexion, mode JSON, température', () => {
    const base = generationProfileHashOf({ maxOutputTokens: 8192, thinkingConfig: 'budget 1024', jsonResponse: true, generation: { temperature: 0.2 } });
    expect(base).toMatch(/^[0-9a-f]{12}$/);
    const variantes: GenerationProfile[] = [
      { maxOutputTokens: 4096, thinkingConfig: 'budget 1024', jsonResponse: true, generation: { temperature: 0.2 } },
      { maxOutputTokens: 8192, thinkingConfig: 'budget 2048', jsonResponse: true, generation: { temperature: 0.2 } },
      { maxOutputTokens: 8192, thinkingConfig: 'budget 1024', jsonResponse: false, generation: { temperature: 0.2 } },
      { maxOutputTokens: 8192, thinkingConfig: 'budget 1024', jsonResponse: true, generation: { temperature: 1 } },
    ];
    const empreintes = variantes.map(generationProfileHashOf);
    for (const e of empreintes) expect(e).not.toBe(base);
    expect(new Set([...empreintes, base]).size).toBe(empreintes.length + 1);
    // Et chaque profil distinct donne bien une CLÉ distincte : aucune qualification n'est héritée.
    expect(coupleKeyId({ ...key(), generationProfileHash: base })).not.toBe(coupleKeyId(key()));
  });

  it('L784-ID-03 — empreinte STABLE : même profil → même empreinte, quel que soit l’ordre des paramètres ; pur (sans horloge)', () => {
    const a = generationProfileHashOf({ maxOutputTokens: 8192, generation: { temperature: 0.2, topP: 0.9, topK: 40 } });
    const b = generationProfileHashOf({ maxOutputTokens: 8192, generation: { topK: 40, topP: 0.9, temperature: 0.2 } });
    expect(a).toBe(b);
    expect(generationProfileHashOf({ maxOutputTokens: 8192, generation: { temperature: 0.2, topP: 0.9, topK: 40 } })).toBe(a);
  });

  it('L784-ID-04 — seuls les paramètres MATÉRIELLEMENT pertinents comptent : un paramètre hors liste ne change pas l’identité', () => {
    const sans = generationProfileHashOf({ maxOutputTokens: 1024 });
    // `maxOutputTokens` est déjà porté à part : un champ inconnu de la liste ne doit rien changer.
    const avec = generationProfileHashOf({ maxOutputTokens: 1024, generation: { parametreInconnu: 'xyz' } });
    expect(avec).toBe(sans);
    // … alors qu'un paramètre de la liste, lui, change bien l'identité.
    expect(generationProfileHashOf({ maxOutputTokens: 1024, generation: { seed: 7 } })).not.toBe(sans);
    expect(GENERATION_PROFILE_KEYS).toContain('temperature');
  });
});

describe('L784-VS — version de modèle réellement servie (§A3)', () => {
  it('L784-VS-01 — fournisseur MUET : incertitude marquée, aucun état déduit, aucun délai touché', () => {
    const refuse = applySchemaOutcome(null, key(), REFUS, T0);
    // Le refus a été constaté sans version servie : l'incertitude est déjà portée par l'état.
    expect(refuse).toMatchObject({ versionUncertain: true, servedModelVersion: null, servedVersionAtState: null });
    const apres = applyServedVersion(refuse, null, T0 + 1000);
    // Rien à réécrire : l'incertitude est déjà marquée.
    expect(apres).toBeNull();
    // Et sur un état qui portait une version : seule l'incertitude est posée, l'échéance ne bouge pas.
    const avecVersion = applySchemaOutcome(null, key(), { ...REFUS, servedModelVersion: '2.5-001' }, T0);
    const muet = applyServedVersion(avecVersion, null, T0 + 1000)!;
    expect(muet).toMatchObject({ versionUncertain: true, state: 'REJECTED_CONFIRMED', nextRetestAt: avecVersion.nextRetestAt });
    expect(muet.reason).toBe(avecVersion.reason);
  });

  it('L784-VS-02 — version IDENTIQUE : simple mémorisation, aucune écriture inutile', () => {
    const refuse = applySchemaOutcome(null, key(), { ...REFUS, servedModelVersion: '2.5-001' }, T0);
    expect(refuse).toMatchObject({ servedModelVersion: '2.5-001', servedVersionAtState: '2.5-001', versionUncertain: false });
    expect(applyServedVersion(refuse, '2.5-001', T0 + 5000)).toBeNull();
  });

  it('L784-VS-03 — version DIFFÉRENTE d’un refus mémorisé : essai de nouveau DÛ, mais l’état reste « refusé » (rien n’est déclaré compatible)', () => {
    const refuse = applySchemaOutcome(null, key(), { ...REFUS, servedModelVersion: '2.5-001' }, T0);
    // Échéance initiale : loin devant.
    expect(refuse.nextRetestAt).toBeGreaterThan(T0);
    const t = T0 + 60_000;
    const next = applyServedVersion(refuse, '2.5-002', t)!;
    // Le refus portait sur une AUTRE version servie : il ne commande plus les appels d'aujourd'hui.
    expect(next).toMatchObject({ state: 'REJECTED_CONFIRMED', reason: 'SERVED_VERSION_CHANGED', servedModelVersion: '2.5-002', nextRetestAt: t });
    // Réservation remise à zéro pour que l'essai soit pris par UNE instance (jamais une rafale).
    expect(next.retestClaimedUntil).toBeNull();
    // Rien n'est QUALIFIÉ au passage : seul un appel réel accepté peut le faire.
    expect(next.state).not.toBe('QUALIFIED');
  });

  it('L784-VS-04 — couple QUALIFIÉ dont la version change : mémorisé, SANS requalification forcée ni perte de l’acquis', () => {
    const ok = applySchemaOutcome(null, key(), { kind: 'ACCEPTED', servedModelVersion: '2.5-001' }, T0);
    expect(ok).toMatchObject({ state: 'QUALIFIED', servedModelVersion: '2.5-001' });
    const next = applyServedVersion(ok, '2.5-002', T0 + 1000)!;
    // Un couple accepté reste accepté : la carte interdit d'inventer un état, dans un sens comme dans l'autre.
    expect(next).toMatchObject({ state: 'QUALIFIED', servedModelVersion: '2.5-002' });
    expect(next.reason).toBe('ACCEPTED_ON_REAL_CALL');
    expect(next.nextRetestAt).toBeNull();
  });

  it('L784-VS-05 — couple INCONNU : rien n’est créé (aucune ligne inventée)', () => {
    expect(applyServedVersion(null, '2.5-001', T0)).toBeNull();
    expect(applyServedVersion(null, null, T0)).toBeNull();
  });

  it('L784-VS-06 — version inconnue au moment du refus, observée ensuite : elle devient la RÉFÉRENCE de cet état, sans rendre l’essai dû', () => {
    const refuse = applySchemaOutcome(null, key(), REFUS, T0);
    const next = applyServedVersion(refuse, '2.5-001', T0 + 1000)!;
    // Le refus a été constaté sur cette version-là : aucun changement n'est allégué, l'échéance tient.
    expect(next).toMatchObject({ servedModelVersion: '2.5-001', servedVersionAtState: '2.5-001', versionUncertain: false, nextRetestAt: refuse.nextRetestAt });
    expect(next.reason).toBe('GENERIC_400_ANSWERED_WITHOUT_SCHEMA');
    // Un changement ULTÉRIEUR, lui, est bien détecté.
    expect(applyServedVersion(next, '2.5-002', T0 + 2000)).toMatchObject({ reason: 'SERVED_VERSION_CHANGED' });
  });
});

describe('L784-RT — le couple est-il encore routé ? (§E1)', () => {
  const T1 = 't1_analyze_document';

  it('L784-RT-01 — modèle dans la chaîne configurée : ACTIVE (l’alerte garde son objet)', async () => {
    expect(await coupleRoutingStatus({ operationCode: T1, model: 'm-principal' }, async () => ['m-principal', 'm-repli'])).toBe('ACTIVE');
    expect(await coupleRoutingStatus({ operationCode: T1, model: 'm-repli' }, async () => ['m-principal', 'm-repli'])).toBe('ACTIVE');
  });

  it('L784-RT-02 — configuration ILLISIBLE : UNKNOWN — on ne ferme jamais sur une absence de preuve', async () => {
    const status = await coupleRoutingStatus({ operationCode: T1, model: 'm-principal' }, async () => { throw new Error('base indisponible'); });
    expect(status).toBe('UNKNOWN');
  });

  it('L784-RT-03 — hors chaîne mais TOUJOURS déclaré : UNKNOWN (retrait possiblement temporaire ou changement de rang)', async () => {
    const { DECLARED_MODELS } = await import('../../registry/models');
    const declare = DECLARED_MODELS[0]!.model;
    expect(await coupleRoutingStatus({ operationCode: T1, model: declare }, async () => ['un-autre-modele'])).toBe('UNKNOWN');
  });

  it('L784-RT-04 — hors chaîne ET hors référentiel : WITHDRAWN (preuve de retrait, clôture possible avec motif)', async () => {
    expect(await coupleRoutingStatus({ operationCode: T1, model: 'modele-qui-n-existe-plus' }, async () => ['un-autre-modele'])).toBe('WITHDRAWN');
  });

  it('L784-RT-05 — opération inconnue du registre : WITHDRAWN (preuve de code, pas une indisponibilité)', async () => {
    expect(await coupleRoutingStatus({ operationCode: 'operation_qui_n_existe_pas', model: 'm' }, async () => ['m'])).toBe('WITHDRAWN');
  });
});
