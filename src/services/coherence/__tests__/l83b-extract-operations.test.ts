/**
 * Lot 83B — contrôle de cohérence : chaîne document → extract → T1 → aval
 * (C-Q7), rattachements et séparation bien / équipement (C3), Opérations
 * (invariants O-1 branchés, identité 78A en détection — C4), relance
 * asynchrone tracée et coût IA du moteur. Sans base (voir le scénario e2e
 * `l83b-coherence-extract-operations.e2e.ts` pour l'exécution réelle).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { significantValues } from '@/services/ai/source-analysis/source-units/text';
import { OPERATIONS_GROUPING_INVARIANTS, type GroupingInvariant } from '@/services/business-operations/grouping/invariants';
import { COHERENCE_REGISTRY, activeChecks, getCheck } from '../registry';
import { COVERAGE_INVENTORY } from '../registry/coverage';
import {
  diagnoseExtractChain, t1RelaunchDailyMax, T1_OMISSIONS_CONTRACT, type ExtractChainInput, type ExtractUnit,
} from '../registry/checks/extract-chain';
import { groupingInvariantCheck, operationsGroupingChecks, reviewOperationMembers } from '../registry/checks/operations';
import { recheckOutcome, repairAllowed, stillAwaitingRepair, type ProofState } from '../engine';

const ROOT = join(__dirname, '../../../..');
const code = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const unite = (o: Partial<ExtractUnit> & { unitId: string; text: string | null }): ExtractUnit => ({
  kind: 'LABEL_VALUE', ordinal: 1, status: 'COVERED', reason: 'fact', salient: true, repairAttempts: 0, repairState: null, retryable: null, updatedAt: '2026-10-01T00:00:00', ...o,
});
const k = (o: { amounts?: number[]; dates?: string[]; ids?: string[] } = {}) => ({ amounts: new Set(o.amounts ?? []), dates: new Set(o.dates ?? []), identifiers: new Set(o.ids ?? []) });
const entree = (o: Partial<ExtractChainInput> = {}): ExtractChainInput => ({
  fileId: 7, extractionId: 70, coverage: { retryAttempts: 0, nextRetryAt: null, pagesMissing: [] }, units: [], t1: k(), t1Unstructured: k(),
  projection: null, repairableUnitIds: new Set(), maxRetries: 2, pendingHashes: new Set(), triedHashes: new Set(), ...o,
});

describe('L83B-U-EXTRACT — valeurs significatives de l’extract (déterministe, sans jugement de pertinence)', () => {
  it('L83B-U-EXTRACT-01 — montants AVEC devise, dates numériques et littérales, identifiants d’un couple libellé / valeur', () => {
    const v = significantValues('Montant TTC : 1 234,56 € — échéance le 1er mars 2027, avoir 87.5 EUR ; réf FAC-2026-0042 ; total 490 000 €', { identifiers: true });
    expect(v.map((x) => [x.kind, x.normalized])).toEqual([
      ['DATE', '2027-03-01'], ['AMOUNT', '123456'], ['AMOUNT', '8750'], ['AMOUNT', '49000000'], ['IDENTIFIER', 'FAC20260042'],
    ]);
    // Une quantité « HT » sans devise, une date impossible, un nombre seul : rien.
    expect(significantValues('1 200 HT ; 31/02/2026 ; 42')).toEqual([]);
    // Identifiants seulement si demandés (valeur d'un couple libellé / valeur).
    expect(significantValues('N° de série : SN-424242').map((x) => x.kind)).toEqual([]);
  });
});

describe('L83B-U-EXTRACT — diagnostic de la chaîne (C-Q7 : premier maillon défaillant)', () => {
  const montant = unite({ unitId: 'page:1:field:2', text: 'Montant TTC : 1 234,00 €', status: 'UNRESOLVED', reason: 'not_extracted', repairAttempts: 1 });

  it('L83B-U-EXTRACT-02 — (b) valeur de l’extract absente de T1, unité NON couverte et réparable → passe T1 ciblée (une seule relance)', () => {
    const i = diagnoseExtractChain(entree({ units: [montant], repairableUnitIds: new Set([montant.unitId]) }));
    expect(i).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'FACT_OMITTED_BY_T1', faultyLink: 'T1', detail: expect.objectContaining({ repair: 'T1_REPAIR', t1Relaunch: true }) });
    expect(i.observed).toEqual([{ unit: 'page:1:field:2', status: 'UNRESOLVED', values: [{ kind: 'AMOUNT', value: '123400' }] }]);
    // Même diagnostic déjà relancé (journal) : plus jamais relancé.
    const encore = diagnoseExtractChain(entree({ units: [montant], repairableUnitIds: new Set([montant.unitId]), triedHashes: new Set([i.inputHash!]) }));
    expect(encore).toMatchObject({ verdict: 'FINDING', anomaly: 'RELAUNCH_ALREADY_TRIED', inputHash: i.inputHash });
    // Reprise déjà programmée par la chaîne existante, ou plafond de reprises atteint : constat, jamais de doublon.
    expect(diagnoseExtractChain(entree({ units: [montant], repairableUnitIds: new Set([montant.unitId]), coverage: { retryAttempts: 0, nextRetryAt: '2026-10-24T00:00:00Z', pagesMissing: [] } })))
      .toMatchObject({ verdict: 'FINDING', anomaly: 'FACT_OMITTED_RETRY_SCHEDULED' });
    expect(diagnoseExtractChain(entree({ units: [montant], repairableUnitIds: new Set([montant.unitId]), coverage: { retryAttempts: 2, nextRetryAt: null, pagesMissing: [] } })))
      .toMatchObject({ verdict: 'FINDING', anomaly: 'FACT_OMITTED_REPAIR_EXHAUSTED' });
    // Unité épuisée (plafond de tentatives par unité).
    expect(diagnoseExtractChain(entree({ units: [montant] }))).toMatchObject({ verdict: 'FINDING', anomaly: 'FACT_OMITTED_REPAIR_EXHAUSTED' });
  });

  it('L83B-U-EXTRACT-03 — (b) unité COUVERTE : constat tracé (disposition T1 attendue), aucune relance, aucune règle de pertinence', () => {
    const u = unite({ unitId: 'page:1:block:3', kind: 'TEXT_BLOCK', text: 'Total 120,00 € dont frais 34,00 €' });
    const i = diagnoseExtractChain(entree({ units: [u], t1: k({ amounts: [12000] }) }));
    expect(i).toMatchObject({ verdict: 'FINDING', anomaly: 'FACT_OMITTED_COVERED_UNIT', detail: expect.objectContaining({ pendingContract: T1_OMISSIONS_CONTRACT, t1Relaunch: false, matched: { AMOUNT: 1, DATE: 0, IDENTIFIER: 0 } }) });
  });

  it('L83B-U-EXTRACT-04 — (a) valeur déjà dans T1 : aucune omission ; valeur vue par T1 mais non structurée : aucune omission ; aval signalé', () => {
    const u = unite({ unitId: 'page:1:field:1', text: 'Date : 12/03/2026 — Montant : 99,90 €' });
    const i = diagnoseExtractChain(entree({ units: [u], t1: k({ dates: ['2026-03-12'] }), t1Unstructured: k({ amounts: [9990] }) }));
    expect(i).toMatchObject({ verdict: 'CONSISTENT', detail: expect.objectContaining({ t1Unstructured: 1, matched: { AMOUNT: 0, DATE: 1, IDENTIFIER: 0 } }) });
    expect((i.detail as { downstreamOwners: string[] }).downstreamOwners).toContain('COH-TODO-DOCUMENT-FIELDS');
  });

  it('L83B-U-EXTRACT-05 — (a) faits T1 jamais projetés sur le bien → réparation AVAL seule (sans T1), prioritaire sur un constat T1', () => {
    const couverte = unite({ unitId: 'page:1:block:3', kind: 'TEXT_BLOCK', text: 'Sous-total 12,00 €' });
    const i = diagnoseExtractChain(entree({ units: [couverte], projection: { assetId: 5, expectedKeys: ['acquisitionDate'], evidenceCount: 0 } }));
    expect(i).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'FACTS_NOT_PROJECTED', faultyLink: 'PERSISTENCE', detail: expect.objectContaining({ repair: 'PROJECT', t1Relaunch: false }) });
    expect((i.detail as { diagnostics: Array<{ anomaly: string }> }).diagnostics.map((d) => d.anomaly)).toEqual(['FACT_OMITTED_COVERED_UNIT', 'FACTS_NOT_PROJECTED']);
    // Preuves présentes, ou rien d'attendu : cohérent.
    expect(diagnoseExtractChain(entree({ projection: { assetId: 5, expectedKeys: ['acquisitionDate'], evidenceCount: 2 } })).verdict).toBe('CONSISTENT');
    expect(diagnoseExtractChain(entree({ projection: { assetId: 5, expectedKeys: [], evidenceCount: 0 } })).verdict).toBe('CONSISTENT');
  });

  it('L83B-U-EXTRACT-06 — (c) extract incomplet FIABLE → nouvelle extraction ; relance en attente reconnue ; sinon constat', () => {
    const lacune = unite({ unitId: 'page:3:gap:4', kind: 'PAGE_GAP', text: null, status: 'FAILED', reason: 'chunk_failed', retryable: true });
    const i = diagnoseExtractChain(entree({ units: [lacune] }));
    expect(i).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'EXTRACT_INCOMPLETE', faultyLink: 'EXTRACT', detail: expect.objectContaining({ repair: 'REEXTRACT', reextract: true }) });
    // La relance a consommé une reprise : tant qu'elle est en attente, même diagnostic (le moteur attend, ne relance pas).
    const attente = diagnoseExtractChain(entree({ units: [lacune], coverage: { retryAttempts: 2, nextRetryAt: null, pagesMissing: [] }, pendingHashes: new Set([i.inputHash!]) }));
    expect(attente).toMatchObject({ verdict: 'REPAIRABLE', inputHash: i.inputHash, detail: expect.objectContaining({ awaiting: true }) });
    expect(diagnoseExtractChain(entree({ units: [lacune], triedHashes: new Set([i.inputHash!]) }))).toMatchObject({ verdict: 'FINDING', anomaly: 'RELAUNCH_ALREADY_TRIED' });
    expect(diagnoseExtractChain(entree({ units: [lacune], coverage: { retryAttempts: 2, nextRetryAt: null, pagesMissing: [] } }))).toMatchObject({ anomaly: 'EXTRACT_INCOMPLETE_FINAL' });
    expect(diagnoseExtractChain(entree({ units: [{ ...lacune, retryable: false }] }))).toMatchObject({ anomaly: 'EXTRACT_INCOMPLETE_UNRECOVERABLE', verdict: 'FINDING' });
    expect(diagnoseExtractChain(entree({ coverage: { retryAttempts: 0, nextRetryAt: '2026-10-24T00:00:00Z', pagesMissing: [2] } }))).toMatchObject({ anomaly: 'EXTRACT_RETRY_SCHEDULED' });
    // Premier maillon : l'extract passe avant T1.
    const montant = unite({ unitId: 'page:1:field:2', text: 'Montant : 10,00 €', status: 'UNRESOLVED' });
    expect(diagnoseExtractChain(entree({ units: [lacune, montant], repairableUnitIds: new Set(['page:1:field:2']) })).anomaly).toBe('EXTRACT_INCOMPLETE');
  });

  it('L83B-U-EXTRACT-08 — budget des relances IA sur 24 h : 200 par défaut, 0 = aucune relance, valeur illisible → défaut', () => {
    expect(t1RelaunchDailyMax({})).toBe(200);
    expect(t1RelaunchDailyMax({ COHERENCE_T1_RELAUNCH_DAILY_MAX: '0' })).toBe(0);
    expect(t1RelaunchDailyMax({ COHERENCE_T1_RELAUNCH_DAILY_MAX: '35' })).toBe(35);
    expect(t1RelaunchDailyMax({ COHERENCE_T1_RELAUNCH_DAILY_MAX: 'beaucoup' })).toBe(200);
    expect(t1RelaunchDailyMax({ COHERENCE_T1_RELAUNCH_DAILY_MAX: '-4' })).toBe(0);
  });

  it('L83B-U-EXTRACT-07 — détail sans contenu de document : identifiant tracé par empreinte seulement', () => {
    const u = unite({ unitId: 'page:1:field:4', text: 'IBAN : FR7630006000011234567890189', status: 'UNRESOLVED' });
    const i = diagnoseExtractChain(entree({ units: [u], repairableUnitIds: new Set([u.unitId]) }));
    expect(JSON.stringify(i)).not.toContain('FR7630006000011234567890189');
    expect((i.observed as Array<{ values: Array<{ value: string }> }>)[0].values[0].value).toMatch(/^#[0-9a-f]{10}$/);
  });
});

describe('L83B-U-ENGINE — relance asynchrone, recontrôle à plusieurs constats (C-Q2, C-Q7)', () => {
  const prev = (o: Partial<ProofState>): ProofState => ({ last_result: null, last_repair_hash: null, repair_attempts: 0, finding_streak: 0, consecutive_errors: 0, first_detected_at: null, ...o });

  it('L83B-U-ENGINE-01 — relance en attente : jamais relancée sur le même diagnostic ; diagnostic changé → permise', () => {
    const p = prev({ last_result: 'REPAIR_PENDING', last_repair_hash: 'h1' });
    expect(repairAllowed(p, 'h1')).toBe(false);
    expect(repairAllowed(p, 'h2')).toBe(true);
    expect(stillAwaitingRepair(p, { verdict: 'REPAIRABLE', inputHash: 'h1' })).toBe(true);
    expect(stillAwaitingRepair(p, { verdict: 'CONSISTENT' })).toBe(false);
    expect(stillAwaitingRepair(p, { verdict: 'REPAIRABLE', inputHash: 'h2' })).toBe(false);
  });

  it('L83B-U-ENGINE-02 — recontrôle : cohérent → réparé ; anomalie réparée disparue mais autre constat → réparé au journal, constat restant en preuve ; même anomalie → inefficace', () => {
    expect(recheckOutcome({ verdict: 'REPAIRABLE', anomaly: 'A' }, { verdict: 'CONSISTENT' })).toEqual({ journal: 'REPAIRED', result: 'REPAIRED' });
    expect(recheckOutcome({ verdict: 'REPAIRABLE', anomaly: 'FACTS_NOT_PROJECTED' }, { verdict: 'FINDING', anomaly: 'FACT_OMITTED_COVERED_UNIT' })).toEqual({ journal: 'REPAIRED', result: 'FINDING' });
    expect(recheckOutcome({ verdict: 'REPAIRABLE', anomaly: 'A' }, { verdict: 'REPAIRABLE', anomaly: 'B' })).toEqual({ journal: 'REPAIRED', result: 'FINDING' });
    expect(recheckOutcome({ verdict: 'REPAIRABLE', anomaly: 'A' }, { verdict: 'REPAIRABLE', anomaly: 'A' })).toEqual({ journal: 'INEFFECTIVE', result: 'REPAIR_INEFFECTIVE' });
  });

  it('L83B-U-ENGINE-03 — coût IA mesuré par le moteur (journal d’usage), relance asynchrone journalisée PENDING puis close', () => {
    const src = code('src/services/coherence/engine.ts');
    expect(src).toMatch(/FROM ai_usage_event WHERE id > \$1 AND account_id = \$2/);
    expect(src).toMatch(/outcome: 'PENDING'/);
    expect(src).toMatch(/SET outcome = \$4, recheck_verdict = \$5, settled_at = now\(\)/);
    expect(readFileSync(join(ROOT, 'src/db/migrations/0664_l83b_coherence_relance_en_attente.sql'), 'utf8')).toMatch(/'REPAIRED', 'INEFFECTIVE', 'FAILED', 'PENDING'/);
  });
});

describe('L83B-U-OPS — Opérations : invariants O-1 BRANCHÉS (liste entière), identité 78A en détection', () => {
  it('L83B-U-OPS-01 — un contrôle du registre par invariant de grouping/invariants.ts, même version ; « constat seul » jamais réparé', () => {
    expect(operationsGroupingChecks.map((c) => c.id)).toEqual(OPERATIONS_GROUPING_INVARIANTS.map((i) => `COH-${i.id}`));
    for (const inv of OPERATIONS_GROUPING_INVARIANTS) {
      const c = getCheck(`COH-${inv.id}`)!;
      expect(c, inv.id).toBeTruthy();
      expect(c.version).toBe(inv.version);
      expect(c.level).toBe(inv.level);
      expect(c.status).toBe('ACTIVE');
      expect(!!c.repair, inv.id).toBe(inv.repair === 'DETERMINISTIC');
      expect(c.triggers).toContain('BUSINESS_OPERATION_CHANGED');
    }
    expect(getCheck('COH-O1-ANTI-CARTESIAN')!.repair).toBeUndefined();
  });

  it('L83B-U-OPS-02 — aucun invariant recopié : un invariant AJOUTÉ (ex. chantier 83A) devient un contrôle sans autre changement', () => {
    const nouveau = { ...OPERATIONS_GROUPING_INVARIANTS[0], id: 'O7-AGENDA-PROJECTION' as never, version: 3, repair: 'DETECT_ONLY', repairFinding: undefined } as GroupingInvariant;
    const c = groupingInvariantCheck(nouveau);
    expect(c).toMatchObject({ id: 'COH-O7-AGENDA-PROJECTION', version: 3, domain: 'operations', objectType: 'account' });
    expect(c.repair).toBeUndefined();
    // Le registre construit sa liste depuis le tableau exporté (pas de liste d'identifiants écrite à la main).
    const src = code('src/services/coherence/registry/checks/operations.ts');
    expect(src).toMatch(/OPERATIONS_GROUPING_INVARIANTS\.map\(groupingInvariantCheck\)/);
    expect(src).not.toMatch(/'O1-PRINCIPAL-UNIQUE'|'O1-ANTI-CARTESIAN'/);
  });

  it('L83B-U-OPS-03 — identité 78A : contradiction face à la fondatrice → constat « contredite » ; rattachement de l’utilisateur ou de l’IA → doute seulement', async () => {
    const fp = (amountMinor: number) => ({
      type: 'ACQUISITION', providerKey: null, assetIds: [1], equipmentIds: [], refs: [], date: '2021-03-01',
      principal: [{ amountMinor, currency: 'EUR', direction: 'COST' }], payments: [], periodic: false, structured: false, summary: null,
    });
    const membres = [{ sourceId: 10, footprint: fp(49_000_000), anchor: true }, { sourceId: 11, footprint: fp(27_735), anchor: false }];
    const r = await reviewOperationMembers(membres, new Map());
    expect(r).toEqual([expect.objectContaining({ sourceId: 11, outcome: 'SEPARATE', against: [10] })]);
    expect(r[0].signals.some((s) => s.startsWith('!'))).toBe(true);
    expect(await reviewOperationMembers(membres, new Map([[11, 'M3']]))).toEqual([expect.objectContaining({ sourceId: 11, outcome: 'SUSPECT', protectedMethod: 'M3' })]);
    expect(await reviewOperationMembers([membres[0], { sourceId: 12, footprint: fp(49_000_000), anchor: false }], new Map())).toEqual([]);
  });

  it('L83B-U-OPS-04 — contrôles Opérations et séparation : aucune écriture SQL directe (réparation par les services métier seulement)', () => {
    for (const f of ['operations.ts', 'equipment-separation.ts', 'extract-chain.ts']) {
      expect(code(`src/services/coherence/registry/checks/${f}`), f).not.toMatch(/\b(UPDATE|DELETE FROM|INSERT INTO)\b/);
    }
    // Lot 86C (test corrigé, ticket P1 « doublons de contrats ») : COH-OPS-IDENTITY v2 RÉPARE les doublons
    // ENTRE Opérations par le réexamen T3 ciblé (service métier) ; l'identité 78A interne reste un constat.
    expect(getCheck('COH-OPS-IDENTITY')).toMatchObject({ version: 2 });
    expect(code('src/services/coherence/registry/checks/operations.ts')).toMatch(/reconsolidateRecurringDocuments/);
  });
});

describe('L83B-U-REG — registre et couverture', () => {
  it('L83B-U-REG-01 — C-Q7 branché (ACTIVE), contrôles 83B présents, lignes 82B conservées dans leur ordre', () => {
    const ids = activeChecks().map((c) => c.id);
    expect(ids.slice(0, 6)).toEqual(['COH-TODO-DOCUMENT-FIELDS', 'COH-DOC-LINKS', 'COH-AGENDA-OCCURRENCES', 'COH-AGENDA-ORPHANS', 'COH-TCO-EXTRACTED-EXPENSES', 'COH-DOC-EXTRACT-CHAIN']);
    for (const id of ['COH-ASSET-EQUIPMENT-SEPARATION', 'COH-OPS-IDENTITY', ...OPERATIONS_GROUPING_INVARIANTS.map((i) => `COH-${i.id}`)]) expect(ids, id).toContain(id);
    expect(getCheck('COH-DOC-EXTRACT-CHAIN')).toMatchObject({ status: 'ACTIVE', version: 1 });
    // Lot 84E : COH-DOC-LINKS v3 (réparation de premier rang par la reconsolidation ciblée O-6).
    expect(getCheck('COH-DOC-LINKS')!.version).toBe(3);
    expect(new Set(COHERENCE_REGISTRY.map((c) => c.id)).size).toBe(COHERENCE_REGISTRY.length);
  });

  it('L83B-U-REG-02 — couverture : documents-t1 et opérations couverts par des contrôles actifs ; lacunes restantes déclarées', () => {
    const e = (d: string) => COVERAGE_INVENTORY.find((x) => x.domain === d)!;
    expect(e('documents-t1').checks).toEqual(['COH-DOC-EXTRACT-CHAIN']);
    expect(e('documents-t1').gap?.planned).toMatch(/82B-t1-omissions-extract/);
    expect(e('operations').checks).toEqual(expect.arrayContaining(['COH-OPS-IDENTITY', 'COH-O1-PRINCIPAL-UNIQUE']));
    expect(e('equipements').checks).toContain('COH-ASSET-EQUIPMENT-SEPARATION');
  });

  it('L83B-U-REG-03 (C-Q6) — aucune règle par type de document, aucun mot-clé de pertinence dans la chaîne C-Q7', () => {
    const src = code('src/services/coherence/registry/checks/extract-chain.ts') + code('src/services/ai/source-analysis/source-units/text.ts');
    expect(src).not.toMatch(/PROPERTY_TAX|TAXE_FONCIERE|taxe fonci|sous-total|frais de gestion/i);
  });
});
