/**
 * Lot 113W (Trello #724) — périodes métier : règles pures, libellés, guide du PO, registre.
 *
 *   L113W-U-LABELS  libellés repris à l'identique du ticket, dates partielles, aucun statut présumé ;
 *   L113W-U-MODEL   qualification depuis la connaissance T1 persistée (couverture, facturation, achat,
 *                   non renseignée, bornes partielles, mois seul, discontinue, reconduction, devis, titre) ;
 *   L113W-U-PLAN    reprise idempotente, correction de l'utilisateur protégée ;
 *   L113W-U-GUIDE   bloc 26 du guide applicable au prompt T1 livré, exemple accepté par le schéma réel ;
 *   L113W-U-COH     contrôle COH-DOC-BUSINESS-PERIODS en fin de registre, couvert, interdits explicites.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const lib = await import('@/lib/documents/business-periods');
const m = await import('../model');

type Cand = Parameters<typeof m.deriveDocumentPeriods>[0]['candidates'][number];
const cand = (over: Partial<Cand> & { payload?: Record<string, unknown> } = {}): Cand => ({
  candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'CONTRACT', ...over,
  payload: { sourceRoleHint: 'CONTRACT_DOCUMENT', temporalHints: {}, financialHints: [], ...(over.payload ?? {}) },
});
const SANS_FACTURATION = { billedPeriod: null, statedMonth: null, hasBillingBlock: false };
const fait = (rawKey: string, normalizedValue: string | null, over: Partial<Parameters<typeof m.deriveDocumentPeriods>[0]['facts'][number]> = {}) => ({
  factId: over.factId ?? 1, rawKey, normalizedValue, periodStart: null, periodEnd: null, attribute: null, confidence: 'certain',
  excerpt: 'extrait', page: 1, ...over,
});
const derive = (p: Partial<Parameters<typeof m.deriveDocumentPeriods>[0]>) =>
  m.deriveDocumentPeriods({ candidates: [], facts: [], billing: SANS_FACTURATION, ...p });

describe('L113W-U-LABELS — libellés et dates partielles', () => {
  it('textes du ticket à l’identique', () => {
    expect(lib.periodLine('COVERAGE', { start: '2025-04-01', end: '2026-03-31' })).toBe('Période couverte : du 01/04/2025 au 31/03/2026');
    expect(lib.periodLine('COVERAGE', { start: '2024-07-05', end: null })).toBe('Début de couverture : 05/07/2024');
    expect(lib.periodLine('COVERAGE', { start: null, end: '2026-06-30' })).toBe('Fin de couverture : 30/06/2026');
    expect(lib.periodLine('COVERAGE', { start: null, end: null })).toBe('Période couverte : non renseignée');
    expect(lib.principalLine('COVERAGE', [{ start: '2024-01-01', end: '2024-03-31' }, { start: '2024-07-01', end: '2024-09-30' }])).toBe('Plusieurs périodes concernées');
    expect(lib.SEVERAL_PERIODS_LABEL).toBe('Plusieurs périodes concernées');
  });
  it('mois seul et bornes au mois : aucune borne inventée', () => {
    expect(lib.periodLine('BILLING', { start: '2026-02', end: '2026-02' })).toBe('Période facturée : février 2026');
    expect(lib.periodLine('COVERAGE', { start: '2026-03', end: '2026-06' })).toBe('Période couverte : de mars 2026 à juin 2026');
    expect(lib.periodLine('WARRANTY', { start: null, end: '2028' })).toBe('Fin de garantie : 2028');
    expect(lib.periodLine('COVERAGE', { start: '2026-03', end: '2026-03' })).not.toMatch(/01\/03|31\/03/);
  });
  it('période passée affichée telle quelle : jamais « expiré », « dernière période connue » ni statut', () => {
    const textes = [
      lib.periodLine('COVERAGE', { start: '2020-01-01', end: '2021-01-01' }),
      ...Object.values(lib.BUSINESS_PERIOD_LABELS).flatMap((l) => Object.values(l)),
      lib.COVERAGE_HISTORY_TITLE, lib.COVERAGE_HISTORY_EMPTY, lib.PERIOD_USER_MENTION,
    ].join(' ');
    expect(textes).not.toMatch(/expir|dernière période connue|en cours|active|Opération|déduit|estimé/i);
  });
  it('dates partielles : validation calendaire, ordre, saisie française', () => {
    expect(lib.isPartialDate('2026-02-30')).toBe(false);
    expect(lib.isPartialDate('2024-02-29')).toBe(true);
    expect(lib.isPartialDate('2026-13')).toBe(false);
    expect(lib.orderedBounds('2026-03', '2026-03-15')).toBe(true);
    expect(lib.orderedBounds('2026-04', '2026-03-31')).toBe(false);
    expect(lib.parsePartialInput('05/07/2026')).toBe('2026-07-05');
    expect(lib.parsePartialInput('7/2026')).toBe('2026-07');
    expect(lib.parsePartialInput('2026')).toBe('2026');
    expect(lib.parsePartialInput('')).toBeNull();
    expect(lib.parsePartialInput('31/02/2026')).toBeUndefined();
    expect(lib.partialToInput('2026-07')).toBe('07/2026');
  });
});

describe('L113W-U-MODEL — qualification depuis la connaissance T1 persistée', () => {
  it('attestation d’assurance (pièce contractuelle datée) → une couverture, preuve = candidat', () => {
    const d = derive({ candidates: [cand({ payload: { temporalHints: { startDate: '2025-04-01', endDate: '2026-03-31' } } })] });
    expect(d).toEqual([expect.objectContaining({ kind: 'COVERAGE', segment: 0, start: '2025-04-01', end: '2026-03-31', basis: 'T1_CONTRACT_DATES', evidence: { candidateKeys: ['op1'] } })]);
  });
  it('facture mensuelle d’une assurance annuelle → période facturée seule, jamais une couverture', () => {
    const d = derive({
      candidates: [cand({ payload: { sourceRoleHint: 'INVOICE', temporalHints: { startDate: '2026-02-01', endDate: '2026-02-28' },
        financialHints: [{ role: 'REALIZED_COST', amountMinor: 3500, currency: 'EUR', amountScope: 'INSTALLMENT', periodStart: '2026-02-01', periodEnd: '2026-02-28' }] } })],
      billing: { billedPeriod: { start: '2026-02-01', end: '2026-02-28', source: 'T1_INSTALLMENT' }, statedMonth: null, hasBillingBlock: false },
    });
    expect(d.map((x) => [x.kind, x.start, x.end])).toEqual([['BILLING', '2026-02-01', '2026-02-28']]);
  });
  it('achat ponctuel : aucun champ période', () => {
    expect(derive({ candidates: [cand({ typeHint: 'ACQUISITION', payload: { sourceRoleHint: 'INVOICE', temporalHints: { realizedDate: '2026-03-06' },
      financialHints: [{ role: 'REALIZED_COST', amountMinor: 202300, currency: 'EUR', amountScope: 'TOTAL', economicDate: '2026-03-06' }] } })] })).toEqual([]);
  });
  it('pièce contractuelle sans date → « non renseignée » ; autre pièce sans date : pertinence indéterminée → rien', () => {
    expect(derive({ candidates: [cand()] })).toEqual([expect.objectContaining({ kind: 'COVERAGE', start: null, end: null, basis: 'T1_CONTRACT_UNDATED' })]);
    expect(derive({ candidates: [cand({ payload: { sourceRoleHint: 'OTHER_EVIDENCE' } })] })).toEqual([]);
    expect(derive({ candidates: [cand({ payload: { sourceRoleHint: null } })] })).toEqual([]);
  });
  it('reconduction tacite (début seul) : début de couverture, aucune fin ni période future déduite', () => {
    const d = derive({ candidates: [cand({ payload: { temporalHints: { startDate: '2024-07-05' } } })] });
    expect(d).toEqual([expect.objectContaining({ kind: 'COVERAGE', start: '2024-07-05', end: null })]);
    expect(lib.periodLine('COVERAGE', d[0])).toBe('Début de couverture : 05/07/2024');
  });
  it('devis daté sans réalisation attestée : aucune période de prestation déduite', () => {
    expect(derive({ candidates: [cand({ typeHint: 'INTERVENTION', confidence: 'probable', payload: { sourceRoleHint: 'QUOTE', temporalHints: { plannedDate: '2026-11-03' } } })] })).toEqual([]);
  });
  it('faits de période T1 : nature décidée par T1, bornes partielles, mois seul, discontinues, principale', () => {
    const d = derive({
      candidates: [cand({ payload: { temporalHints: { startDate: '2025-01-01', endDate: '2025-12-31' } } })],
      facts: [
        fait('period.coverage', '2024-01/2024-03', { factId: 3 }), fait('period.coverage', '2024-07-01/2024-09-30', { factId: 2 }),
        fait('period.warranty', '/2028', { factId: 5, attribute: 'principal' }), fait('period.validity', '2026-03', { factId: 6 }),
        fait('period.service', 'n importe quoi', { factId: 7 }), fait('period.billing', '/', { factId: 8, confidence: 'conflictual' }),
      ],
    });
    // T1 a parlé de la couverture : les dates du candidat ne sont pas ajoutées (pas de période globale artificielle).
    expect(d.filter((x) => x.kind === 'COVERAGE').map((x) => [x.segment, x.start, x.end])).toEqual([[0, '2024-01', '2024-03'], [1, '2024-07-01', '2024-09-30']]);
    expect(d.find((x) => x.kind === 'VALIDITY')).toMatchObject({ start: '2026-03', end: '2026-03' });
    expect(d.find((x) => x.kind === 'WARRANTY')).toMatchObject({ start: null, end: '2028', principalHint: true });
    expect(d.some((x) => x.kind === 'SERVICE' || x.kind === 'BILLING')).toBe(false);
    expect(m.principalKind(d)).toBe('WARRANTY');
    expect(m.principalKind(d.filter((x) => x.kind !== 'WARRANTY'))).toBe('COVERAGE');
  });
  it('« / » : période pertinente non datée ; mois écrit sur une facture : mois seul', () => {
    expect(derive({ facts: [fait('period.coverage', '/')] })).toEqual([expect.objectContaining({ kind: 'COVERAGE', start: null, end: null, basis: 'T1_PERIOD_FACT' })]);
    expect(derive({
      candidates: [cand({ typeHint: 'CONTRACT', payload: { sourceRoleHint: 'INVOICE' } })],
      billing: { billedPeriod: null, statedMonth: { value: '2026-02', quote: 'Abonnement février 2026' }, hasBillingBlock: true },
    })).toEqual([expect.objectContaining({ kind: 'BILLING', start: '2026-02', end: '2026-02', basis: 'T1_STATED_MONTH' })]);
  });
  it('échéance d’un contrat sans période lisible → « non renseignée » ; couverture = facturation identique : la couverture seule', () => {
    expect(derive({ candidates: [cand({ payload: { sourceRoleHint: 'INVOICE' } })] }))
      .toEqual([expect.objectContaining({ kind: 'BILLING', start: null, end: null, basis: 'T1_BILLING_UNDATED' })]);
    const d = derive({
      candidates: [cand({ payload: { temporalHints: { startDate: '2025-04-01', endDate: '2026-03-31' } } }),
        cand({ candidateKey: 'op2', payload: { sourceRoleHint: 'INVOICE' } })],
      billing: { billedPeriod: { start: '2025-04-01', end: '2026-03-31', source: 'T1_COST_PERIOD' }, statedMonth: null, hasBillingBlock: false },
    });
    expect(d.map((x) => x.kind)).toEqual(['COVERAGE']);
  });
  it('le titre ne définit jamais la période (aucune entrée titre) ; période des faits génériques ≠ période facturée', () => {
    expect(derive({
      candidates: [cand({ payload: { sourceRoleHint: 'INVOICE' }, typeHint: 'ACQUISITION' })],
      billing: { billedPeriod: { start: '2026-01-01', end: '2026-06-30', source: 'T1_FACT' }, statedMonth: null, hasBillingBlock: false },
    })).toEqual([]);
  });
  it('valeurs illisibles ou désordonnées ignorées, jamais devinées', () => {
    expect(m.parsePeriodValue({ normalizedValue: '2026-05/2026-01', periodStart: null, periodEnd: null })).toBeUndefined();
    expect(m.parsePeriodValue({ normalizedValue: 'a/b/c', periodStart: null, periodEnd: null })).toBeUndefined();
    expect(m.parsePeriodValue({ normalizedValue: null, periodStart: '2025-01-01', periodEnd: '2025-12-31' })).toEqual({ start: '2025-01-01', end: '2025-12-31' });
  });
});

describe('L113W-U-PLAN — reprise idempotente, correction protégée', () => {
  const voulu = derive({ candidates: [cand({ payload: { temporalHints: { startDate: '2025-04-01', endDate: '2026-03-31' } } })] });
  const stocke = (over: Partial<Parameters<typeof m.planRefresh>[0][number]> = {}) => ({
    id: 10, origin: 'T1' as const, userLocked: false, ...voulu[0], ...over,
  });
  it('mêmes faits → aucune écriture (rejouée deux fois : stable)', () => {
    expect(m.planRefresh([stocke()], voulu)).toEqual({ keep: [10], supersede: [], insert: [] });
  });
  it('fait changé → remplacé ; plus voulu → retiré', () => {
    expect(m.planRefresh([stocke({ end: '2026-04-30' })], voulu)).toMatchObject({ keep: [], supersede: [10], insert: [voulu[0]] });
    expect(m.planRefresh([stocke()], [])).toEqual({ keep: [], supersede: [10], insert: [] });
  });
  it('nature corrigée par l’utilisateur : rien n’est écrit ni retiré pour elle, même après réanalyse', () => {
    const corrige = stocke({ id: 11, origin: 'USER', userLocked: true, basis: 'USER', start: '2025-05-01' });
    expect(m.planRefresh([corrige], voulu)).toEqual({ keep: [], supersede: [], insert: [] });
    expect(m.planRefresh([corrige], [])).toEqual({ keep: [], supersede: [], insert: [] });
    // Une autre nature reste requalifiée normalement.
    const factu = { ...voulu[0], kind: 'BILLING' as const, basis: 'T1_INSTALLMENT' as const };
    expect(m.planRefresh([corrige], [...voulu, factu]).insert).toEqual([factu]);
  });
});

describe('L113W-U-GUIDE — bloc 26 du guide (T1, périodes métier)', () => {
  const racine = process.cwd();
  const guide = readFileSync(join(racine, 'docs/exploitation/prompts-a-appliquer-par-le-po.md'), 'utf8');
  const section = guide.slice(guide.indexOf('Étape 26 — T1'), guide.indexOf('## 11. Qualification par couple'));
  const bloc = /### Texte exact à coller \(bloc 26\)\n\n```text\n([\s\S]*?)\n```/.exec(section)?.[1] ?? '';
  const livre = readFileSync(join(racine, 'src/services/ai/prompts/source-analysis/t1_master_v1.txt'), 'utf8');
  const REPERE = 'Réponds uniquement par le JSON de la branche TASK demandée, sans texte autour.';

  it('marqueur et clés du code, absent du prompt livré (le code ne modifie aucun prompt), ligne repère unique', () => {
    expect(bloc).toContain(m.T1_BUSINESS_PERIODS_CONTRACT);
    for (const k of Object.keys(m.PERIOD_FACT_KEYS)) expect(bloc).toContain(k);
    expect(livre).not.toContain(m.T1_BUSINESS_PERIODS_CONTRACT);
    expect(livre.split(REPERE)).toHaveLength(2);
    expect(bloc).toMatch(/tacite reconduction/);
  });
  it('T1 après collage : aucun contrôle bloquant du BO, aucun emplacement inconnu', async () => {
    const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
    const { inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
    const applique = livre.replace(REPERE, `${bloc}\n\n${REPERE}`);
    expect(checkMasterPromptContent('T1', applique).blocking).toEqual([]);
    expect(inspectMasterTemplate(bloc).placeholders).toEqual([]);
  });
  it('exemple accepté par le schéma réel du fait T1 et lu comme une couverture principale', async () => {
    const { t1Fact } = await import('@/services/ai/source-analysis/master/t1-contract');
    const ex = t1Fact.parse(JSON.parse(bloc.slice(bloc.indexOf('{"canonicalKey"')).trim()));
    const d = derive({ facts: [{ factId: 1, rawKey: ex.rawKey ?? null, normalizedValue: String(ex.normalizedValue), periodStart: ex.periodStart ?? null,
      periodEnd: ex.periodEnd ?? null, attribute: ex.attribute ?? null, confidence: ex.confidence, excerpt: ex.evidence.excerpt ?? null, page: null }] });
    expect(d).toEqual([expect.objectContaining({ kind: 'COVERAGE', start: '2025-04-01', end: '2026-03-31', principalHint: true })]);
  });
});

describe('L113W-U-COH — contrôle de cohérence (reprise de l’historique)', () => {
  it('en fin de registre, couvert, sans IA ni écriture contractuelle', async () => {
    const { COHERENCE_REGISTRY } = await import('@/services/coherence/registry');
    const { COVERAGE_INVENTORY } = await import('@/services/coherence/registry/coverage');
    const c = COHERENCE_REGISTRY.at(-1)!;
    expect(c).toMatchObject({ id: 'COH-DOC-BUSINESS-PERIODS', status: 'ACTIVE', version: 1, objectType: 'document' });
    expect(c.forbiddenRepairs.join(' ')).toMatch(/appeler l’IA/);
    expect(c.forbiddenRepairs.join(' ')).toMatch(/reconduction/);
    expect(c.forbiddenRepairs.join(' ')).toMatch(/corrigée par l’utilisateur/);
    expect(COVERAGE_INVENTORY.some((d) => d.checks.includes('COH-DOC-BUSINESS-PERIODS'))).toBe(true);
  });
  it('catalogues : diagnostic, recette, transfert Duo (suit le document)', async () => {
    const { FILE_SCOPED_TABLES } = await import('@/services/assets/asset-account-transfer.service');
    expect(FILE_SCOPED_TABLES).toContainEqual(['document_business_periods', 'file_id']);
    const racine = process.cwd();
    for (const f of ['src/services/admin/diagnostics-export/coverage.ts', 'src/services/admin/diagnostics-export/recette-catalog.ts']) {
      expect(readFileSync(join(racine, f), 'utf8')).toContain('document_business_periods:');
    }
  });
  it('interface : jamais le mot « Opération » ni un statut présumé dans les composants et routes', () => {
    const racine = process.cwd();
    for (const f of ['src/components/documents/BusinessPeriods.tsx', 'src/app/api/agenda/[id]/periodes/route.ts', 'src/app/api/documents/[id]/periodes/route.ts']) {
      const visibles = [...readFileSync(join(racine, f), 'utf8').matchAll(/(['"`])((?:(?!\1).)*)\1/g)].map((x) => x[2]).join(' ');
      expect(visibles, f).not.toMatch(/\bOpération\b|expiré/);
    }
  });
});
