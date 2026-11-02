/**
 * Lot 103G — compte technique de qualification (ticket P1) : évaluation pure du
 * précontrôle (R1, R2, R3), auto-provisionnement borné à la préproduction (R10),
 * contexte serveur d'exemption, classement des refus d'éligibilité dans le
 * moteur de qualification (cause ÉTABLIE, jamais « non établie »).
 * La base réelle est couverte par l'e2e `l103g-compte-technique`.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

import {
  assessCorpusAccount, autoProvisionAllowed, corpusAccountDefects, CORPUS_TECHNICAL_KIND, type CorpusAccountFacts, type CorpusAccountSnapshot,
} from '../technical-account';
import { currentTechnicalAccountContext, runWithTechnicalAccount, technicalAccountInContext } from '../technical-context';
import { runCoupleCases } from '../runner';

const corpus = (o: Partial<CorpusAccountFacts> = {}): CorpusAccountFacts => ({
  accountId: 120, userId: 300, technicalKind: CORPUS_TECHNICAL_KIND, ownerIsCorpusIdentity: true, accountActive: true, archived: false,
  subscriptionStatus: 'NONE', hasStripe: false, billableSubscription: false, userActive: false, passwordLocked: true, userRole: 'USER',
  ownerPendingDeletion: false, ownerAccounts: 1, otherMembers: 0, ...o,
});
const client = (id: number, o: Partial<CorpusAccountFacts> = {}): CorpusAccountFacts => corpus({
  accountId: id, userId: id + 1000, technicalKind: null, ownerIsCorpusIdentity: false, subscriptionStatus: 'ACTIVE', billableSubscription: true, userActive: true, passwordLocked: false, ...o,
});
const snap = (configuredRaw: string | null, accounts: CorpusAccountFacts[], markerColumn = true): CorpusAccountSnapshot => ({ configuredRaw, markerColumn, accounts });

describe('L103G-U01 — précontrôle du compte technique (pur)', () => {
  it('R1 : CORPUS_ACCOUNT_ID=8 inexistant, aucun compte technique → CORPUS_ACCOUNT_MISSING, motif précis, prochain geste BO', () => {
    const st = assessCorpusAccount(snap('8', []));
    expect(st).toMatchObject({ ok: false, code: 'CORPUS_ACCOUNT_MISSING', accountId: null, security: false });
    expect(st.reasons.join()).toMatch(/CORPUS_ACCOUNT_ID=8 : aucun compte technique correspondant \(compte introuvable\)/);
    expect(st.nextAction).toMatch(/BO › Configuration IA › Compte technique de qualification/);
  });

  it('R2 : variable absente ou obsolète (copie prod → préprod) → compte reconnu par son MARQUEUR, avertissement, aucune duplication', () => {
    const absente = assessCorpusAccount(snap(null, [corpus()]));
    expect(absente).toMatchObject({ ok: true, code: 'CORPUS_ACCOUNT_OK', accountId: 120, resolvedBy: 'marker' });
    const obsolete = assessCorpusAccount(snap('8', [corpus()]));
    expect(obsolete).toMatchObject({ ok: true, accountId: 120, resolvedBy: 'marker', variable: { value: 8, stale: true, matches: false } });
    expect(obsolete.warnings.join()).toMatch(/CORPUS_ACCOUNT_ID=8 est obsolète/);
    expect(assessCorpusAccount(snap('120', [corpus()]))).toMatchObject({ ok: true, resolvedBy: 'variable', variable: { matches: true, stale: false } });
  });

  it('R3 : variable pointant vers un compte CLIENT (actif, expiré, suspendu) → MISMATCH + anomalie de sécurité, même si un compte technique existe', () => {
    for (const c of [client(77), client(77, { subscriptionStatus: 'EXPIRED', billableSubscription: false }), client(77, { accountActive: false })]) {
      for (const comptes of [[c], [c, corpus()]]) {
        const st = assessCorpusAccount(snap('77', comptes));
        expect(st).toMatchObject({ ok: false, code: 'CORPUS_ACCOUNT_MISMATCH', security: true, accountId: null });
        expect(st.reasons[0]).toMatch(/compte CLIENT/);
      }
    }
  });

  it('compte technique non conforme (connectable, facturable, suspendu, membre…) → CORPUS_ACCOUNT_INVALID, jamais utilisé', () => {
    const cas: Array<Partial<CorpusAccountFacts>> = [
      { userActive: true }, { passwordLocked: false }, { userRole: 'ADMIN' }, { subscriptionStatus: 'ACTIVE' }, { hasStripe: true },
      { billableSubscription: true }, { accountActive: false }, { archived: true }, { otherMembers: 1 }, { ownerAccounts: 2 }, { ownerIsCorpusIdentity: false },
    ];
    for (const o of cas) {
      expect(corpusAccountDefects(corpus(o)).length).toBeGreaterThan(0);
      expect(assessCorpusAccount(snap(null, [corpus(o)]))).toMatchObject({ ok: false, code: 'CORPUS_ACCOUNT_INVALID', accountId: null });
    }
    expect(corpusAccountDefects(corpus())).toEqual([]);
  });

  it('doublon, identité non marquée, migration absente, variable incohérente ou illisible', () => {
    expect(assessCorpusAccount(snap(null, [corpus(), corpus({ accountId: 121, userId: 301 })])).code).toBe('CORPUS_ACCOUNT_INVALID');
    const nonMarque = assessCorpusAccount(snap(null, [corpus({ technicalKind: null })]));
    expect(nonMarque).toMatchObject({ code: 'CORPUS_ACCOUNT_INVALID' });
    expect(nonMarque.reasons[0]).toMatch(/sans marqueur technique/);
    expect(assessCorpusAccount(snap('120', [corpus()], false)).code).toBe('CORPUS_ACCOUNT_INVALID');
    expect(assessCorpusAccount(snap('abc', [corpus()]))).toMatchObject({ code: 'CORPUS_ACCOUNT_MISMATCH', security: false });
  });

  it('empreinte d’état : change à la réparation, stable sinon (reprise une fois par état réparé)', () => {
    const avant = assessCorpusAccount(snap('8', []));
    expect(assessCorpusAccount(snap('8', [])).stateFingerprint).toBe(avant.stateFingerprint);
    expect(assessCorpusAccount(snap('8', [corpus()])).stateFingerprint).not.toBe(avant.stateFingerprint);
  });

  it('R10 : auto-provisionnement — préproduction par défaut, local sur demande, JAMAIS en production', () => {
    expect(autoProvisionAllowed('preprod', {})).toBe(true);
    expect(autoProvisionAllowed('preprod', { AI_CORPUS_ACCOUNT_AUTO_PROVISION: 'off' })).toBe(false);
    expect(autoProvisionAllowed('local', {})).toBe(false);
    expect(autoProvisionAllowed('local', { AI_CORPUS_ACCOUNT_AUTO_PROVISION: 'on' })).toBe(true);
    expect(autoProvisionAllowed('production', { AI_CORPUS_ACCOUNT_AUTO_PROVISION: 'on' })).toBe(false);
  });
});

describe('L103G-U02 — contexte serveur d’exemption', () => {
  it('ouvert seulement après un contrôle réussi, limité au compte vérifié et à la continuation asynchrone', async () => {
    expect(technicalAccountInContext(120)).toBe(false);
    expect(() => runWithTechnicalAccount({ ok: false, accountId: 120 }, 'x', () => 1)).toThrow();
    expect(() => runWithTechnicalAccount({ ok: true, accountId: null }, 'x', () => 1)).toThrow();
    await runWithTechnicalAccount({ ok: true, accountId: 120 }, 'campagne 9', async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(technicalAccountInContext(120)).toBe(true);
      expect(technicalAccountInContext(77)).toBe(false);
      expect(currentTechnicalAccountContext()).toEqual({ accountId: 120, purpose: 'campagne 9' });
    });
    expect(technicalAccountInContext(120)).toBe(false);
  });
});

describe('L103G-U03 — moteur de qualification : ACCOUNT_INELIGIBLE = cause établie (prérequis), jamais « cause non établie »', () => {
  const couple = {
    treatment: 'T2', operationCode: 't2_answer', model: 'gemini-x', rank: 0, versionId: 1, revisionId: 1, signature: 'a'.repeat(64),
    profile: { timeoutMs: 1000 }, parts: {},
  } as never;
  const cas = (o: Record<string, unknown> = {}) => ({
    caseId: 'corpus:P-T2-06', source: 'CORPUS_FIXTURE', expectedSource: 'REFERENCE', mandatory: true, advisory: false, accountId: null, captureId: null,
    operationCode: 't2_answer', treatment: 'T2', variables: {}, outputSchema: {}, historicalOutput: null, evaluate: async () => ({ defects: [] }), ...o,
  }) as never;
  const refus = (reason: string) => Object.assign(new Error(`Appel IA refusé : compte 8 non éligible aux traitements (compte introuvable)`), { code: 'ACCOUNT_INELIGIBLE', reason });

  it('cas du corpus (compte technique) : blockedBy TECHNICAL_ACCOUNT, motif structuré, une seule tentative', async () => {
    let appels = 0;
    const r = await runCoupleCases({ couple, cases: [cas()], observations: 1, campaignId: 9, technicalAccountId: 8, masterText: () => '', call: (async () => { appels += 1; throw refus('ACCOUNT_NOT_FOUND'); }) as never });
    const o = r.observations[0];
    expect(o).toMatchObject({ outcome: 'INCONCLUSIVE', blockedBy: 'TECHNICAL_ACCOUNT', attempts: 1 });
    expect(o.inconclusiveReason).toMatch(/^prérequis d’exploitation : compte technique de qualification 8 non éligible \(ACCOUNT_INELIGIBLE : ACCOUNT_NOT_FOUND\)/);
    expect(o.inconclusiveReason).not.toMatch(/cause non établie/);
    expect(appels).toBeGreaterThanOrEqual(1);
  });

  it('cas d’un rejeu (compte de données) : blockedBy REPLAY_ACCOUNT ; compte technique absent : CORPUS_ACCOUNT_MISSING sans appel', async () => {
    const r = await runCoupleCases({ couple, cases: [cas({ caseId: 'replay:5', source: 'PREPROD_REPLAY', accountId: 55 })], observations: 1, campaignId: 9, technicalAccountId: 8, masterText: () => '', call: (async () => { throw refus('READ_ONLY'); }) as never });
    expect(r.observations[0]).toMatchObject({ blockedBy: 'REPLAY_ACCOUNT' });
    expect(r.observations[0].inconclusiveReason).toMatch(/compte de données du rejeu non éligible \(ACCOUNT_INELIGIBLE : READ_ONLY, C-Q10\)/);
    let appels = 0;
    const sans = await runCoupleCases({ couple, cases: [cas()], observations: 1, campaignId: 9, technicalAccountId: null, masterText: () => '', call: (async () => { appels += 1; throw new Error('x'); }) as never });
    expect(appels).toBe(0);
    expect(sans.observations[0]).toMatchObject({ blockedBy: 'TECHNICAL_ACCOUNT' });
    expect(sans.observations[0].inconclusiveReason).toMatch(/CORPUS_ACCOUNT_MISSING/);
  });
});
