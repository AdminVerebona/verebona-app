/**
 * Lot 113AA (Trello #725) — conformité des périodes métier au CDC #724 : règles pures, guide, registres.
 *
 *   L113AA-U-V2          contrat T1 v2 : pertinence à 4 états (connue / inconnue / non pertinente / indéterminée)
 *                        décidée par T1, effet contractuel ≠ couverture, réalisation ≠ devis, durée indéterminée ≠ fin inconnue ;
 *   L113AA-U-STOCK       stock antérieur : empreintes inchangées (aucune réécriture par la reprise) ;
 *   L113AA-U-T4          sens d'une date de fin : qualification T1 > Type (113W2) > 86C ; police, document sans type,
 *                        échéance fondée rétablie ;
 *   L113AA-U-RESOLUTION  D11 : succession, même fait, natures différentes, avenant, rectificatif, décision de l'utilisateur,
 *                        contradiction, divergence non qualifiée ; jamais « le dernier document gagne » ;
 *   L113AA-U-CARD        carte PERIOD-CONFLICT : catalogue, publiabilité, choix bornés à la carte ;
 *   L113AA-U-GUIDE       bloc 28 balisé, applicable au T1 livré, exemples acceptés par le schéma réel ; diagnostic BO
 *                        « configuration incomplète » (registre de conformité) ;
 *   L113AA-U-COH         COH-OPS-PERIOD-RESOLUTION en fin de registre, couvert ; COH-OPS-CONTRACT-DATES v3 ; catalogues.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const lib = await import('@/lib/documents/business-periods');
const m = await import('../model');
const v2 = await import('../t1-v2');
const res = await import('../resolution');

type Inputs = Parameters<typeof m.deriveDocumentPeriods>[0];
type Cand = Inputs['candidates'][number];
const cand = (over: Partial<Cand> & { payload?: Record<string, unknown> } = {}): Cand => ({
  candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'CONTRACT', ...over,
  payload: { sourceRoleHint: 'CONTRACT_DOCUMENT', temporalHints: {}, financialHints: [], ...(over.payload ?? {}) },
});
const SANS_FACTURATION = { billedPeriod: null, statedMonth: null, hasBillingBlock: false };
let nextId = 1;
const fait = (rawKey: string, normalizedValue: string | null, over: Partial<Inputs['facts'][number]> = {}) => ({
  factId: over.factId ?? nextId++, rawKey, normalizedValue, periodStart: null, periodEnd: null, attribute: null, confidence: 'certain',
  excerpt: 'extrait', page: 1, ...over,
});
const pert = (v: string) => fait('period.relevance', v);
const derive = (p: Partial<Inputs>) => m.deriveDocumentPeriods({ candidates: [], facts: [], billing: SANS_FACTURATION, ...p });
const kinds = (d: ReturnType<typeof derive>) => d.map((x) => [x.kind, x.start, x.end, x.basis]);

describe('L113AA-U-V2 — pertinence et natures décidées par T1 (contrat t1-business-periods-v2)', () => {
  it('lecture de la pertinence : 4 états, nature absente = indéterminée, contradiction = indéterminée, illisible = non évalué', () => {
    const r = v2.parseRelevance([pert('coverage=known; billing=not_relevant;contract=unknown')])!;
    expect(r.get('COVERAGE')).toBe('KNOWN');
    expect(r.get('BILLING')).toBe('NOT_RELEVANT');
    expect(r.get('CONTRACT')).toBe('UNKNOWN');
    expect(r.get('VALIDITY')).toBe('UNDETERMINED');
    expect(v2.parseRelevance([pert('coverage=known'), pert('coverage=not_relevant')])!.get('COVERAGE')).toBe('UNDETERMINED');
    expect(v2.parseRelevance([pert('n importe quoi')])).toBeNull();
    expect(v2.parseRelevance([])).toBeNull();
    expect(v2.parseRelevance([{ ...pert('coverage=known'), confidence: 'conflictual' }])).toBeNull();
  });

  it('R02 — couverture pertinente mais inconnue : « Période couverte : non renseignée » (même sans rôle contractuel)', () => {
    const d = derive({ candidates: [cand({ typeHint: null, payload: { sourceRoleHint: 'OTHER' } })], facts: [pert('coverage=unknown')] });
    expect(kinds(d)).toEqual([['COVERAGE', null, null, 'T1_RELEVANT_UNKNOWN']]);
    expect(lib.periodLine('COVERAGE', d[0])).toBe('Période couverte : non renseignée');
    expect(d[0].evidence.qualified).toBe(true);
  });

  it('R03 — non pertinente : aucun champ, aucun repli déterministe (même une facture ou une pièce contractuelle)', () => {
    const facture = cand({ typeHint: 'CONTRACT', payload: { sourceRoleHint: 'INVOICE' } });
    expect(derive({ candidates: [facture], facts: [pert('billing=not_relevant;coverage=not_relevant')],
      billing: { billedPeriod: { start: '2026-01-01', end: '2026-01-31', source: 'T1_INSTALLMENT' }, statedMonth: null, hasBillingBlock: true } })).toEqual([]);
    // Un fait de période d'une nature déclarée non pertinente par T1 lui-même est écarté (cohérence de sa sortie).
    expect(derive({ facts: [pert('warranty=not_relevant'), fait('period.warranty', '/2028-06-30')] })).toEqual([]);
  });

  it('indéterminée : aucune obligation fictive — ni « non renseignée », ni couverture tirée des dates contractuelles', () => {
    const contrat = cand({ payload: { sourceRoleHint: 'CONTRACT_DOCUMENT', temporalHints: { startDate: '2025-01-01', endDate: '2025-12-31' } } });
    expect(derive({ candidates: [contrat], facts: [pert('coverage=undetermined;contract=undetermined')] })).toEqual([]);
    // Sans le bloc (113W inchangé) : la même pièce donne une couverture (dépend du bloc prompt, documenté).
    expect(kinds(derive({ candidates: [contrat] }))).toEqual([['COVERAGE', '2025-01-01', '2025-12-31', 'T1_CONTRACT_DATES']]);
    // Connue : repli daté autorisé.
    expect(kinds(derive({ candidates: [contrat], facts: [pert('coverage=known')] }))).toEqual([['COVERAGE', '2025-01-01', '2025-12-31', 'T1_CONTRACT_DATES']]);
  });

  it('effet contractuel ≠ couverture ; durée indéterminée ÉTABLIE ≠ fin inconnue', () => {
    const d = derive({ facts: [pert('contract=known;coverage=known'), fait('period.contract', '2024-07-05/INDEFINITE'), fait('period.coverage', '2025-04-01/2026-03-31')] });
    expect(d.map((x) => [x.kind, x.start, x.end, x.openEnded ?? false])).toEqual([
      ['COVERAGE', '2025-04-01', '2026-03-31', false], ['CONTRACT', '2024-07-05', null, true]]);
    expect(lib.periodLine('CONTRACT', d[1])).toBe('Date d’effet du contrat : 05/07/2024 (durée indéterminée)');
    // Fin inconnue (borne vide) : début seul, jamais « durée indéterminée ».
    const inconnue = derive({ facts: [fait('period.contract', '2024-07-05/')] });
    expect(inconnue[0]).toMatchObject({ kind: 'CONTRACT', start: '2024-07-05', end: null });
    expect(inconnue[0].openEnded).toBeUndefined();
    expect(lib.periodLine('CONTRACT', inconnue[0])).toBe('Date d’effet du contrat : 05/07/2024');
    expect(m.parsePeriodValue({ normalizedValue: '2024-07-05/INDEFINITE', periodStart: null, periodEnd: null })).toEqual({ start: '2024-07-05', end: null, openEnded: true });
  });

  it('R12 — réalisation : seulement un fait T1 ; un devis daté ne crée jamais de réalisation', () => {
    const devis = cand({ typeHint: 'INTERVENTION', payload: { sourceRoleHint: 'QUOTE', temporalHints: { plannedDate: '2026-11-03' } } });
    expect(derive({ candidates: [devis] })).toEqual([]);
    expect(derive({ candidates: [devis], facts: [pert('realization=not_relevant;validity=known'), fait('period.validity', '2026-11-03/2026-12-03')] })
      .map((x) => x.kind)).toEqual(['VALIDITY']);
    const pv = derive({ facts: [pert('realization=known'), fait('period.realization', '2026-03-14')] });
    expect(lib.periodLine('REALIZATION', pv[0])).toBe('Période de réalisation : 14/03/2026');
  });

  it('relation déclarée (avenant, rectificatif) conservée dans les preuves ; contradictoire → ignorée', () => {
    const d = derive({ facts: [pert('coverage=known'), fait('period.relation', 'amendment', { rawValue: 'Avenant n° 2 à la police P-1' }), fait('period.coverage', '2024-04-15/2025-04-14')] });
    expect(d[0].evidence).toMatchObject({ qualified: true, relation: 'AMENDMENT', relationQuote: 'Avenant n° 2 à la police P-1' });
    expect(v2.parseRelation([fait('period.relation', 'amendment'), fait('period.relation', 'rectification')])).toBeNull();
    expect(v2.parseRelation([fait('period.relation', 'none')])).toBeNull();
  });

  it('priorité : arbitrage 113W2 inchangé pour les cinq natures ; effet contractuel et réalisation ensuite (à valider par le PO)', () => {
    expect(lib.PRIORITY_ARBITRATION_113W2).toEqual(['COVERAGE', 'VALIDITY', 'WARRANTY', 'SERVICE', 'BILLING']);
    expect(lib.BUSINESS_PERIOD_KINDS.slice(0, 5)).toEqual([...lib.PRIORITY_ARBITRATION_113W2]);
    const p = (kind: (typeof lib.BUSINESS_PERIOD_KINDS)[number]) => ({ kind, principalHint: false });
    expect(m.principalKind([p('CONTRACT'), p('BILLING')])).toBe('BILLING');
    expect(m.principalKind([p('REALIZATION'), p('CONTRACT')])).toBe('CONTRACT');
    expect(m.principalKind([p('COVERAGE'), { kind: 'CONTRACT', principalHint: true }])).toBe('CONTRACT');
  });
});

describe('L113AA-U-STOCK — reprise : empreintes du stock inchangées', () => {
  it('un fait sans marque v2 garde exactement l’empreinte du lot 113W', () => {
    const p = { kind: 'COVERAGE' as const, segment: 0, start: '2025-04-01', end: '2026-03-31', principalHint: false, basis: 'T1_CONTRACT_DATES', evidence: { candidateKeys: ['op1'] } };
    const ancienne = JSON.stringify([p.kind, p.segment, p.start, p.end, p.principalHint, p.basis, { quote: null, page: null, factIds: [], candidateKeys: ['op1'] }]);
    expect(m.periodSignature(p)).toBe(ancienne);
    expect(m.periodSignature({ ...p, openEnded: true })).not.toBe(ancienne);
  });
});

describe('L113AA-U-T4 — sens d’une date de fin : qualification T1, puis Type (113W2), puis 86C', async () => {
  const cm = await import('@/services/business-operations/consolidation/model');
  const rec = (id: number, start: string | null, end: string | null) => ({
    id, accountId: 1, fileId: 100 + id, candidateKey: 'op1', established: true, confidence: 'certain' as const, typeHint: 'CONTRACT', statusHint: 'REALIZED',
    summary: 'Assurance', payload: { sourceRoleHint: 'CONTRACT_DOCUMENT', provider: 'Assureur', businessReferences: [{ kind: 'POLICY', value: 'P-1' }], temporalHints: { startDate: start, endDate: end } },
  });
  const q = (facts: Array<[string, string]>) => v2.termQualificationOf(facts.map(([k, v]) => ({ rawKey: k, normalizedValue: v, confidence: 'certain' })));
  const ident = (id: number, start: string | null, end: string | null, type: string | null, tq: ReturnType<typeof q> | null = null) =>
    cm.buildCandidateIdentity(rec(id, start, end) as never, { fileAssetId: 14, fileDocumentTypeCode: type, fileTermQualification: tq, liveAssetIds: new Set([14]), equipmentAssets: new Map() });
  const etat = (ids: ReturnType<typeof ident>[]) => cm.consolidateOperationState('CONTRACT', ids.map((identity, i) => ({ sourceId: i + 1, identity })), '2026-11-08');

  it('qualification : seuls des faits v2 (pertinence rendue) ; un bloc v1 seul ne qualifie rien', () => {
    expect(q([['period.coverage', '2025-04-01/2026-03-31']]).evaluated).toBe(false);
    expect(q([['period.relevance', 'coverage=known;contract=undetermined'], ['period.coverage', '2025-04-01/2026-03-31']])).toEqual({ evaluated: true, contractTerms: [] });
  });

  it('contrat / police dont la fin écrite n’est qu’une couverture : aucune fin de contrat (le Type « police » ne prouve rien)', () => {
    const police = ident(1, '2025-04-01', '2026-03-31', 'INSURANCE_POLICY', q([['period.relevance', 'coverage=known;contract=undetermined'], ['period.coverage', '2025-04-01/2026-03-31']]));
    expect(police.coverageDocument).toBeUndefined();
    expect(cm.contractualEndSource(police)).toBe(false);
    expect(etat([police]).contract).toMatchObject({ effectiveTo: null });
    // Aucun transfert mécanique de la date d'effet de la couverture vers l'effet contractuel.
    expect(cm.contractualStartSource(police)).toBe(false);
    expect(etat([police]).contract).toMatchObject({ effectiveFrom: null });
  });

  it('police dont T1 qualifie l’effet contractuel : date d’effet et fin de contrat fondées', () => {
    const police = ident(1, '2025-04-01', '2027-03-31', 'INSURANCE_POLICY', q([['period.relevance', 'contract=known;coverage=known'], ['period.contract', '2025-04-01/2027-03-31']]));
    expect(etat([police]).contract).toMatchObject({ effectiveFrom: '2025-04-01', effectiveTo: '2027-03-31' });
    // Durée indéterminée établie : aucune fin, jamais une échéance.
    const cdi = ident(2, '2025-04-01', null, 'SUBSCRIPTION_CONTRACT', q([['period.relevance', 'contract=known'], ['period.contract', '2025-04-01/INDEFINITE']]));
    expect(etat([cdi]).contract).toMatchObject({ effectiveFrom: '2025-04-01', effectiveTo: null });
  });

  it('échéance réellement fondée jamais supprimée : une pièce d’un Type de couverture dont T1 qualifie la fin contractuelle la garde', () => {
    const avis = ident(1, '2025-01-01', '2026-12-31', 'INSURANCE_DUE_NOTICE', q([['period.relevance', 'contract=known'], ['period.contract', '2025-01/2026-12']]));
    expect(avis.coverageDocument).toBe(true);
    expect(cm.contractualEndSource(avis)).toBe(true);
    expect(etat([avis]).contract).toMatchObject({ effectiveTo: '2026-12-31' });
  });

  it('document sans Type : sans qualification, règle 86C (prudence documentée) ; qualifié couverture seule : aucune fin', () => {
    const brut = ident(1, '2025-04-01', '2026-03-31', null);
    expect(cm.contractualEndSource(brut)).toBe(true);
    expect(etat([brut]).contract).toMatchObject({ effectiveTo: '2026-03-31' });
    const qualifie = ident(2, '2025-04-01', '2026-03-31', null, q([['period.relevance', 'coverage=known;contract=not_relevant'], ['period.coverage', '2025-04-01/2026-03-31']]));
    expect(etat([qualifie]).contract).toMatchObject({ effectiveTo: null });
  });

  it('sans qualification : arbitrage 113W2 conservé (attestation : date d’effet seule) ; une facture ne date jamais un contrat', () => {
    const att = ident(1, '2025-04-01', '2026-03-31', 'INSURANCE_CERTIFICATE');
    expect(etat([att]).contract).toMatchObject({ effectiveFrom: '2025-04-01', effectiveTo: null });
    const facture = cm.buildCandidateIdentity({ ...rec(3, '2026-01-01', '2026-01-31'), payload: { ...rec(3, '2026-01-01', '2026-01-31').payload, sourceRoleHint: 'INVOICE' } } as never, {
      fileAssetId: 14, fileTermQualification: q([['period.relevance', 'contract=known'], ['period.contract', '2026-01-01/2026-01-31']]), liveAssetIds: new Set([14]), equipmentAssets: new Map() });
    expect(cm.contractualEndSource(facture)).toBe(false);
  });
});

describe('L113AA-U-RESOLUTION — D11 : résolution contextuelle des périodes d’un événement de référence', () => {
  const e = (id: number, fileId: number, start: string | null, end: string | null, o: Partial<import('../resolution').ResolutionEntry> = {}) =>
    ({ id, fileId, kind: 'COVERAGE' as const, start, end, userCorrected: false, qualified: true, relation: null, ...o });
  const statuts = (r: ReturnType<typeof res.resolvePeriods>) => [...r.entries.entries()].map(([id, x]) => [id, x.status, x.byFileId ?? null]);

  it('R06 — succession normale (jour de bascule partagé toléré) : trois périodes établies, aucune question', () => {
    const r = res.resolvePeriods([e(1, 10, '2023-04-01', '2024-04-01'), e(2, 11, '2024-04-01', '2025-03-31'), e(3, 12, '2025-04-01', '2026-03-31')]);
    expect(r.pairs.every((p) => p.relation === 'SUCCESSION')).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(statuts(r).every(([, s]) => s === 'ESTABLISHED')).toBe(true);
  });

  it('même fait (duplicata) : un seul fait, sources réunies ; borne inconnue : chevauchement non établi = succession', () => {
    const r = res.resolvePeriods([e(1, 10, '2024-04-01', '2025-03-31'), e(2, 11, '2024-04-01', '2025-03-31'), e(3, 12, '2024-06-01', null)]);
    expect(statuts(r)).toEqual([[1, 'ESTABLISHED', null], [2, 'SAME_AS', 10], [3, 'ESTABLISHED', null]]);
    expect(r.conflicts).toEqual([]);
  });

  it('natures différentes : jamais une contradiction', () => {
    expect(res.classifyPair(e(1, 10, '2024-01-01', '2024-12-31'), { ...e(2, 11, '2024-03-01', '2025-02-28'), kind: 'CONTRACT' }, new Map()).relation).toBe('DIFFERENT_NATURE');
  });

  it('R13 — avenant déclaré par T1 : la période est actualisée, l’ancienne reste dans l’historique (quel que soit l’ordre des documents)', () => {
    for (const [a, b] of [[10, 11], [11, 10]]) {
      const r = res.resolvePeriods([e(1, a, '2024-04-01', '2025-03-31'), e(2, b, '2024-04-15', '2025-04-14', { relation: 'AMENDMENT' })]);
      expect(r.entries.get(1)).toMatchObject({ status: 'REPLACED', byFileId: b, basis: 'AMENDMENT' });
      expect(r.entries.get(2)).toMatchObject({ status: 'ESTABLISHED' });
      expect(r.conflicts).toEqual([]);
    }
    const rect = res.resolvePeriods([e(1, 10, '2024-04-01', '2025-03-31', { relation: 'RECTIFICATION' }), e(2, 11, '2024-01-01', '2024-12-31')]);
    expect(rect.entries.get(2)).toMatchObject({ status: 'REPLACED', byFileId: 10, basis: 'RECTIFICATION' });
  });

  it('R14 — contradiction réelle (documents qualifiés, rien ne l’explique) : question ; jamais « le dernier document gagne »', () => {
    const a = e(1, 10, '2024-04-01', '2025-03-31');
    const b = e(2, 11, '2024-07-01', '2025-06-30');
    const r = res.resolvePeriods([a, b]);
    expect(r.conflicts).toEqual([{ fingerprint: res.conflictFingerprint('COVERAGE', a, b), kind: 'COVERAGE', periodIds: [1, 2], fileIds: [10, 11], needsUser: true, review: 'NONE' }]);
    expect(statuts(r)).toEqual([[1, 'CONFLICT', null], [2, 'CONFLICT', null]]);
    // Symétrique : l'ordre d'import ne tranche rien (même empreinte).
    expect(res.conflictFingerprint('COVERAGE', b, a)).toBe(r.conflicts[0].fingerprint);
    // Une période corrigée par l'utilisateur n'est jamais remplacée automatiquement par un avenant : il décide.
    const protege = res.resolvePeriods([{ ...a, userCorrected: true }, { ...b, relation: 'AMENDMENT' }]);
    expect(protege.conflicts).toHaveLength(1);
    expect(protege.entries.get(1)!.status).toBe('CONFLICT');
  });

  it('arbitrage déjà tranché : jamais redemandé (KEEP → l’autre remplacée ; BOTH → les deux établies)', () => {
    const a = e(1, 10, '2024-04-01', '2025-03-31');
    const b = e(2, 11, '2024-07-01', '2025-06-30');
    const fp = res.conflictFingerprint('COVERAGE', a, b);
    const keep = res.resolvePeriods([a, b], [{ fingerprint: fp, choice: 'KEEP', retainedFileId: 11 }]);
    expect(keep.conflicts).toEqual([]);
    expect(keep.entries.get(1)).toMatchObject({ status: 'REPLACED', byFileId: 11, basis: 'USER_DECISION' });
    const both = res.resolvePeriods([a, b], [{ fingerprint: fp, choice: 'BOTH', retainedFileId: null }]);
    expect(both.conflicts).toEqual([]);
    expect(statuts(both).every(([, s]) => s === 'ESTABLISHED')).toBe(true);
    // Une nouvelle divergence (bornes changées) est une autre empreinte : nouvelle question.
    expect(res.resolvePeriods([a, { ...b, end: '2025-07-31' }], [{ fingerprint: fp, choice: 'BOTH', retainedFileId: null }]).conflicts).toHaveLength(1);
  });

  it('divergence avec un document non qualifié (bloc 28 absent) : signalée, aucune question, aucune résolution inventée', () => {
    const r = res.resolvePeriods([e(1, 10, '2024-04-01', '2025-03-31', { qualified: false }), e(2, 11, '2024-07-01', '2025-06-30')]);
    expect(r.conflicts).toEqual([expect.objectContaining({ needsUser: false })]);
    expect(r.entries.get(1)!.status).toBe('CONFLICT');
  });
});

describe('L113AA-U-CARD — carte « À traiter » PERIOD-CONFLICT', async () => {
  const cards = await import('../conflict-cards');
  it('catalogue, publiabilité, producteur, mascotte ; question sans le mot « Opération »', async () => {
    const { PROCESSING_RULES, RULE_PRODUCERS } = await import('@/services/to-process/rules-catalog');
    const { PUBLISHABILITY_CONTRACTS } = await import('@/services/to-process/publishability');
    const r = PROCESSING_RULES.find((x) => x.code === cards.PERIOD_CONFLICT_RULE)!;
    expect(r).toMatchObject({ targetType: 'DOCUMENT', relationKey: 'periodConflict', producer: 'T3_PERIOD_RESOLUTION', question: cards.PERIOD_CONFLICT_QUESTION });
    expect(RULE_PRODUCERS.T3_PERIOD_RESOLUTION.module).toBe('src/services/documents/business-periods/conflict-cards.ts');
    expect(PUBLISHABILITY_CONTRACTS[cards.PERIOD_CONFLICT_RULE]).toMatchObject({ family: 'EVENEMENTS_DE_REFERENCE', cleanup: { by: 'COH-OPS-PERIOD-RESOLUTION' } });
    expect(readFileSync(join(process.cwd(), 'src/services/home/mascot/todo-items.ts'), 'utf8')).toContain("'PERIOD-CONFLICT'");
    expect(`${cards.PERIOD_CONFLICT_QUESTION} ${cards.PERIOD_CONFLICT_BOTH_LABEL}`).not.toMatch(/Opération/);
  });
  it('propositions : chaque période avec SON justificatif, puis « les deux sont justes » ; choix hors carte refusé', () => {
    const docs = [{ fileId: 10, title: 'Attestation A', line: 'Période couverte : du 01/04/2024 au 31/03/2025' }, { fileId: 11, title: 'Attestation B', line: 'Période couverte : du 01/07/2024 au 30/06/2025' }];
    const p = cards.periodConflictProposals(docs);
    expect(p.map((x) => x.value)).toEqual(['KEEP:10', 'KEEP:11', 'BOTH']);
    expect(p[0]).toMatchObject({ label: 'Période couverte : du 01/04/2024 au 31/03/2025 — « Attestation A »', evidenceIds: ['file:10'] });
    const ctx = { kind: 'period_conflict' as const, operationId: 5, fingerprint: 'x', periodKind: 'COVERAGE', fileIds: [10, 11] as [number, number], periodIds: [1, 2] as [number, number], documents: docs };
    expect(cards.parsePeriodConflictChoice('KEEP:11', ctx)).toEqual({ choice: 'KEEP', fileId: 11 });
    expect(cards.parsePeriodConflictChoice('BOTH', ctx)).toEqual({ choice: 'BOTH' });
    expect(cards.parsePeriodConflictChoice('KEEP:99', ctx)).toBeNull();
    expect(cards.periodConflictRelationKey(5, 'a')).toBe(cards.periodConflictRelationKey(5, 'a'));
    expect(cards.periodConflictRelationKey(5, 'a')).not.toBe(cards.periodConflictRelationKey(5, 'b'));
  });
});

describe('L113AA-U-GUIDE — bloc 28 (T1 v2) et diagnostic BO de la configuration', () => {
  const racine = process.cwd();
  const guide = readFileSync(join(racine, 'docs/exploitation/prompts-a-appliquer-par-le-po.md'), 'utf8');
  const livre = readFileSync(join(racine, 'src/services/ai/prompts/source-analysis/t1_master_v1.txt'), 'utf8');
  const REPERE = 'Réponds uniquement par le JSON de la branche TASK demandée, sans texte autour.';

  it('bloc officiel balisé, marqueur et clés lus par le code, absent du prompt livré (aucun prompt modifié par le code)', async () => {
    const { parseGuideBlocks } = await import('@/services/ai/prompt-conformity/guide-blocks');
    const b = parseGuideBlocks(guide).find((x) => x.id === v2.T1_BUSINESS_PERIODS_V2_CONTRACT)!;
    expect(b).toMatchObject({ prompt: 't1', action: 'insert-before', anchor: REPERE });
    expect(b.text).toContain(v2.T1_BUSINESS_PERIODS_V2_CONTRACT);
    for (const k of [...Object.keys(m.PERIOD_FACT_KEYS), v2.RELEVANCE_FACT_KEY, v2.RELATION_FACT_KEY, v2.OPEN_END_TOKEN]) expect(b.text).toContain(k);
    for (const n of Object.values(v2.KIND_FACT_NAMES)) expect(b.text).toContain(n);
    expect(b.text).toMatch(/tacite reconduction/);
    expect(livre).not.toContain(v2.T1_BUSINESS_PERIODS_V2_CONTRACT);
    expect(guide).toContain('| 28 | 113AA (#725)');
  });

  it('T1 après collage : aucun contrôle bloquant, aucun emplacement ; exemples acceptés par le schéma réel et lus comme prévu', async () => {
    const { parseGuideBlocks } = await import('@/services/ai/prompt-conformity/guide-blocks');
    const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
    const { inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
    const { t1Fact } = await import('@/services/ai/source-analysis/master/t1-contract');
    const b = parseGuideBlocks(guide).find((x) => x.id === v2.T1_BUSINESS_PERIODS_V2_CONTRACT)!;
    const applique = livre.replace(REPERE, `${b.text}\n\n${REPERE}`);
    expect(checkMasterPromptContent('T1', applique).blocking).toEqual([]);
    expect(inspectMasterTemplate(b.text).placeholders).toEqual([]);
    const exemples = b.text.split('\n').filter((l) => l.startsWith('{"canonicalKey"')).map((l) => t1Fact.parse(JSON.parse(l)));
    expect(exemples).toHaveLength(2);
    const d = derive({ facts: exemples.map((x, i) => ({ factId: i + 1, rawKey: x.rawKey ?? null, normalizedValue: String(x.normalizedValue), periodStart: x.periodStart ?? null,
      periodEnd: x.periodEnd ?? null, attribute: x.attribute ?? null, confidence: x.confidence, excerpt: x.evidence.excerpt ?? null, page: null })) });
    expect(d).toEqual([expect.objectContaining({ kind: 'COVERAGE', start: '2025-04-01', end: '2026-03-31', principalHint: true, evidence: expect.objectContaining({ qualified: true }) })]);
  });

  it('diagnostic BO : contrat déclaré au registre de conformité — « absent » sur le T1 livré (configuration incomplète), satisfait après collage', async () => {
    const { promptContracts } = await import('@/services/ai/prompt-conformity/contracts');
    const { parseGuideBlocks } = await import('@/services/ai/prompt-conformity/guide-blocks');
    const c = (await promptContracts()).find((x) => x.id === v2.T1_BUSINESS_PERIODS_V2_CONTRACT)!;
    expect(c).toMatchObject({ treatment: 'T1', guideStep: 28, lot: '113AA', blockIds: [v2.T1_BUSINESS_PERIODS_V2_CONTRACT] });
    const execution = { mode: 'LEGACY_SLOTS' } as never;
    expect((await c.check({ text: livre, execution, referenceText: livre })).state).toBe('ABSENT');
    const b = parseGuideBlocks(guide).find((x) => x.id === v2.T1_BUSINESS_PERIODS_V2_CONTRACT)!;
    expect((await c.check({ text: livre.replace(REPERE, `${b.text}\n\n${REPERE}`), execution, referenceText: livre })).state).toBe('SATISFIED');
    expect((await c.plan({ text: livre, execution, referenceText: livre })).ok).toBe(true);
    expect(c.impact).toMatch(/Configuration incomplète/);
  });
});

describe('L113AA-U-COH — registres et catalogues', () => {
  it('COH-OPS-PERIOD-RESOLUTION en fin de registre, couvert ; interdits explicites ; COH-OPS-CONTRACT-DATES en version 3', async () => {
    const { COHERENCE_REGISTRY } = await import('@/services/coherence/registry');
    const { COVERAGE_INVENTORY } = await import('@/services/coherence/registry/coverage');
    const ids = COHERENCE_REGISTRY.map((x) => x.id);
    expect(ids.slice(ids.indexOf('COH-DOC-DESCRIPTION-T1'), ids.indexOf('COH-OPS-PERIOD-RESOLUTION') + 1)).toEqual(['COH-DOC-DESCRIPTION-T1', 'COH-OPS-PERIOD-RESOLUTION']);
    const c = COHERENCE_REGISTRY.find((x) => x.id === 'COH-OPS-PERIOD-RESOLUTION')!;
    // Lot 113AD : version 2 (réexamen T3 demandé pour le stock quand le bloc 29 est actif).
    expect(c).toMatchObject({ status: 'ACTIVE', version: 2, objectType: 'business_operation' });
    expect(c.forbiddenRepairs.join(' ')).toMatch(/appeler l’IA/);
    expect(c.forbiddenRepairs.join(' ')).toMatch(/dernier document/);
    expect(COVERAGE_INVENTORY.some((d) => d.checks.includes('COH-OPS-PERIOD-RESOLUTION'))).toBe(true);
    const dates = COHERENCE_REGISTRY.find((x) => x.id === 'COH-OPS-CONTRACT-DATES')!;
    expect(dates.version).toBe(3);
    expect(dates.invariant).toMatch(/qualifié le sens des dates/);
  });
  it('nouvelle table déclarée : diagnostic, recette, transfert (reste au compte)', async () => {
    const { ACCOUNT_OWNED_TABLES } = await import('@/services/assets/asset-account-transfer.service');
    expect(ACCOUNT_OWNED_TABLES.business_period_decisions).toMatch(/113AA/);
    for (const f of ['src/services/admin/diagnostics-export/coverage.ts', 'src/services/admin/diagnostics-export/recette-catalog.ts']) {
      expect(readFileSync(join(process.cwd(), f), 'utf8')).toContain('business_period_decisions:');
    }
  });
  it('textes : nouvelles natures et durée indéterminée ; jamais « Opération » ni « expiré »', () => {
    expect(lib.BUSINESS_PERIOD_LABELS.CONTRACT).toEqual({ period: 'Période contractuelle', start: 'Date d’effet du contrat', end: 'Fin du contrat' });
    expect(lib.periodLine('CONTRACT', { start: null, end: null, openEnded: true })).toBe('Période contractuelle : durée indéterminée');
    const svc = readFileSync(join(process.cwd(), 'src/services/documents/business-periods/service.ts'), 'utf8');
    const notes = svc.slice(svc.indexOf('export const RESOLUTION_NOTES'), svc.indexOf('} as const;', svc.indexOf('export const RESOLUTION_NOTES')));
    expect(notes).not.toMatch(/Opération|expiré/);
  });
});

describe('L113AA-U-RESOLUTION-AVENANT — un avenant n’explique que la période qu’il modifie', () => {
  const e = (id: number, fileId: number, start: string, end: string, o: Partial<import('../resolution').ResolutionEntry> = {}) =>
    ({ id, fileId, kind: 'COVERAGE' as const, start, end, userCorrected: false, qualified: true, relation: null, ...o });
  it('cible = la période la plus recouverte ; un autre chevauchement de l’avenant reste une question', () => {
    const r = res.resolvePeriods([
      e(1, 10, '2024-04-01', '2025-03-31'), e(2, 11, '2025-04-01', '2026-03-31'),
      e(3, 12, '2024-04-15', '2025-04-14', { relation: 'AMENDMENT' }),
    ]);
    expect(r.entries.get(1)).toMatchObject({ status: 'REPLACED', byFileId: 12 });
    expect(r.conflicts.map((c) => c.periodIds)).toEqual([[2, 3]]);
  });
  it('égalité de recouvrement : aucune cible, aucune résolution inventée', () => {
    expect(res.amendmentTargets([e(1, 10, '2024-01-01', '2024-06-30'), e(2, 11, '2024-07-01', '2024-12-31'), e(3, 12, '2024-06-01', '2024-07-30', { relation: 'AMENDMENT' })]).size).toBe(0);
  });
});
