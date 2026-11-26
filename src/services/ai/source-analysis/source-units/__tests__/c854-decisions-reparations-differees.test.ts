/**
 * Carte #854 (P1-02 de #835) — décisions de valeur des réparations différées :
 * parties PURES (sans base) — contrat figé par appel, enveloppes de la passe,
 * résolution des références vers les faits persistés, validateur, libellés BO.
 * Les parcours PostgreSQL (persistance, relecture, reprise, pannes, deux
 * workers) sont dans `src/test/e2e/scenarios/c854-t1-decisions-reparations-differees.e2e.ts`.
 *
 *   C854-U01  R1 / AC05 / AC07 : contrat d'un appel d'après la preuve figée — porté, absent, version non
 *             supportée, preuve absente, coupure d'urgence ; JAMAIS la config active relue après coup ;
 *   C854-U02  R1 / AC06 / AC08 : une enveloppe par appel (contrat, identité, décisions brutes), décisions
 *             reliées à LEUR appel, rejets avant validation conservés, appel en échec ≠ zéro décision ;
 *   C854-U03  R2 / AC01 / AC03 : référence → fait persisté exact, ambigu jamais tranché, clé seule /
 *             valeur seule refusées, cible distincte respectée ;
 *   C854-U04  R3 : rang de réception porté par chaque ligne validée, doublons rendus (jamais perdus),
 *             `LINK_AMBIGUOUS` déclaré ;
 *   C854-U05  R4 / AC15 : bilan BO réconcilié (reçues = acceptées + rejetées + non évaluées), inconnu ≠ 0,
 *             contrat par appel, diagnostics antérieurs inchangés ;
 *   C854-U06  passerelle : marqueurs de contrat lus sur le texte brut.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../value-decisions/contract', async (orig) => {
  const m = await orig<typeof import('../../value-decisions/contract')>();
  // La config ACTIVE (relue après l'appel) dit le contraire de l'appel : elle ne doit JAMAIS être consultée.
  return { ...m, valueDecisionsCapability: vi.fn(async () => ({ carried: false, version: 'C@actif', reason: 'MARKER_MISSING' as const })) };
});

const contract = await import('../../value-decisions/contract');
const { decisionContractOfCall, SUPPORTED_VALUE_DECISIONS_CONTRACTS, T1_VALUE_DECISIONS_CONTRACT } = contract;
const { buildSourceUnits } = await import('../build-units');
const { computeCoverage } = await import('../coverage');
const { runRepairPass } = await import('../repair');
const { resolveFactReference } = await import('../repair-identity');
const { validateValueDecisions, VALUE_DECISION_REJECTIONS } = await import('../../value-decisions/validate');
const { promptContractMarkersOf } = await import('@/services/ai/prompts/prompt-loader');
const { decisionLedgerText, deferredRepairText } = await import('@/app/admin/ai-executions/_components/T1CompletenessUnits');

const preuve = (over: Record<string, unknown> = {}) => ({
  promptVersion: 't1_master_v1@pv12:abcdef012345', textFingerprint: '0123456789abcdef', configVersionId: 7, promptVersionId: 12,
  markers: [T1_VALUE_DECISIONS_CONTRACT, 't1-billing-period-v1'], source: 'version', ...over,
});

describe('C854-U01 — R1 : contrat figé PAR APPEL', () => {
  afterEach(() => { delete process.env.T1_VALUE_DECISIONS_ENABLED; });

  it('AC05 : appel sous B (porté) alors que la config active C ne le porte pas → CARRIED selon B, config active jamais lue', () => {
    const c = decisionContractOfCall(preuve());
    expect(c).toMatchObject({ state: 'CARRIED', contractVersion: 't1-value-decisions-v1', promptVersion: 't1_master_v1@pv12:abcdef012345', promptFingerprint: '0123456789abcdef', configVersionId: 7, persistenceSuspended: false });
    expect(contract.valueDecisionsCapability).not.toHaveBeenCalled();
  });

  it('AC07 : marqueur absent, version non supportée, preuve absente / illisible — états exacts, aucune version de repli', () => {
    expect(decisionContractOfCall(preuve({ markers: ['t1-billing-period-v1'] })).state).toBe('MARKER_MISSING');
    const v2 = decisionContractOfCall(preuve({ markers: ['t1-value-decisions-v2'] }));
    expect(v2).toMatchObject({ state: 'UNSUPPORTED_VERSION', contractVersion: null, markersFound: ['t1-value-decisions-v2'] });
    for (const absente of [null, undefined, preuve({ textFingerprint: null }), preuve({ markers: null }), preuve({ promptVersion: '' })]) {
      const c = decisionContractOfCall(absente as never);
      expect(c.state).toBe('EVIDENCE_MISSING');
      expect(c.contractVersion).toBeNull();
    }
    // Ancienne version supportée + nouvelle inconnue : jugée selon la version supportée qu'elle porte.
    expect(decisionContractOfCall(preuve({ markers: ['t1-value-decisions-v1', 't1-value-decisions-v2'] })).contractVersion).toBe('t1-value-decisions-v1');
    expect(SUPPORTED_VALUE_DECISIONS_CONTRACTS).toEqual(['t1-value-decisions-v1']);
  });

  it('AC07 : coupure d’urgence → persistance SUSPENDUE et dite, contrat inchangé', () => {
    const c = decisionContractOfCall(preuve(), { T1_VALUE_DECISIONS_ENABLED: '0' });
    expect(c).toMatchObject({ state: 'CARRIED', contractVersion: 't1-value-decisions-v1', persistenceSuspended: true });
  });
});

const unites = (text: string) => computeCoverage(buildSourceUnits({ segments: [{ text, pageOffset: 0, origin: 'PASS_1' }] }), { facts: [] });
const fait = (excerpt: string, value: string, ref: string, over: Record<string, unknown> = {}) => ({
  canonicalKey: null, rawKey: 'cotisation.annuelle', label: 'Cotisation annuelle', attribute: null, subject: null,
  rawValue: value, normalizedValue: value, valueType: 'amount', unit: 'EUR', confidence: 'certain',
  provenance: 'TEXT_EXTRACTION', evidence: { excerpt }, target: { type: 'DOCUMENT' }, t1FactRef: ref, ...over,
});
const decision = (value: string, over: Record<string, unknown> = {}) => ({
  value, kind: 'AMOUNT', normalizedValue: null, decision: 'STRUCTURED', reason: 'Rappel de la cotisation annuelle du contrat.',
  sourceUnitId: null, evidence: {}, relatedFactRefs: [], relatedCandidateKeys: [], confidence: 'certain', origin: 'CHUNK', ...over,
});

describe('C854-U02 — R1 / AC06 / AC08 : enveloppes par appel, décisions reliées à LEUR appel', () => {
  const texte = ['Rappel : cotisation annuelle de 412,00 EUR', 'Frais de gestion : 12,00 EUR'].join('\n\n');
  const passe = (u: ReturnType<typeof unites>, reponses: Array<() => Promise<unknown>>) => {
    let i = 0;
    return runRepairPass({
      input: { sourceType: 'file', sourceIds: [1], accountId: 1, userId: 1, mimeTypes: ['text/plain'], displayNames: ['doc'] } as never,
      groupIndices: [0], ctx: {} as never, capabilities: { rooms: true, equipments: true } as never, v2Families: [],
      units: u, maxCalls: 3, pass: 2, call: (() => reponses[i++]()) as never,
    });
  };

  it('deux appels, deux contrats : chacun garde le sien ; décision seule citant un fait HORS zone → fait cité conservé pour la résolution', async () => {
    const u = unites(texte);
    expect(u.length).toBeGreaterThanOrEqual(2);
    const ancien = fait('Cotisation annuelle : 412,00 EUR', '412.00', 'ref-ancien');
    const r = await passe(u, [async () => ({
      output: { facts: [ancien], entities: { rooms: [], equipments: [] } },
      valueDecisions: [{ ...decision('412,00 EUR', { sourceUnitId: `[${u[0].sourceUnitId}]`, relatedFactRefs: ['ref-ancien'] }) },
        { ...decision('99,99 EUR', { sourceUnitId: '[page:9:block:9]' }) }, { ...decision('', { schemaInvalid: true, kind: null }) }],
      res: { traceId: 'trace-B', promptContract: preuve(), providerRequests: 2, usedFallback: true, model: 'm2', fromCache: false, costMicros: 10 },
      valueDecisionsPass: { status: 'PRESENT' },
    })]);
    // Un seul lot (budget de caractères suffisant) : l'unique appel porte le contrat B de SA réponse.
    expect(r.envelopes).toHaveLength(1);
    expect(r.envelopes[0]).toMatchObject({ callIndex: 1, callRef: 'trace-B', providerRequests: 2, usedFallback: true, model: 'm2', rawDecisions: 3, failed: false, decisionsField: 'PRESENT' });
    expect(r.envelopes[0].contract.state).toBe('CARRIED');
    // Les trois décisions REÇUES sont conservées, dans l'ordre, avec leur rang et leur motif de rejet éventuel.
    expect(r.received.map((x) => [x.callIndex, x.ordinal, x.preRejected])).toEqual([[1, 0, null], [1, 1, 'UNIT_NOT_IN_TARGET_ZONE'], [1, 2, 'SCHEMA_INVALID']]);
    // Le fait ancien cité est HORS zone (écarté des faits à écrire) mais transmis pour la résolution vers le fait persisté.
    expect(r.facts).toHaveLength(0);
    expect(r.received[0].refFacts.map((f) => f.t1FactRef)).toEqual(['ref-ancien']);
    expect(r.received[0].decision).toMatchObject({ callIndex: 1, ordinal: 0, sourceUnitId: u[0].sourceUnitId });
    // Compteurs historiques inchangés.
    expect(r.decisionsDropped).toEqual({ schemaInvalid: 1, unitNotFound: 1 });
  });

  it('appels successifs : contrat B puis C (non porté) — aucun mélange ; appel en échec : décisions INCONNUES, jamais zéro', async () => {
    const long = 'x'.repeat(23_990);
    const u = unites(`Total : 120,00 EUR ${long}\n\nAcompte : 30,00 EUR ${long}\n\nSolde : 90,00 EUR ${long}`);
    expect(u.length).toBe(3);
    const r = await passe(u, [
      async () => ({ output: { facts: [], entities: { rooms: [], equipments: [] } }, valueDecisions: [decision('120,00 EUR', { sourceUnitId: `[${u[0].sourceUnitId}]` })], res: { traceId: 't1', promptContract: preuve() } }),
      async () => ({ output: { facts: [], entities: { rooms: [], equipments: [] } }, valueDecisions: [], res: { traceId: 't2', promptContract: preuve({ promptVersion: 't1_master_v1@pv13:ffff', markers: [] }) } }),
      async () => { throw new Error('503 indisponible'); },
    ]);
    expect(r.envelopes.map((e) => [e.callIndex, e.callRef, e.contract.state, e.rawDecisions, e.failed])).toEqual([
      [1, 't1', 'CARRIED', 1, false], [2, 't2', 'MARKER_MISSING', 0, false], [3, null, 'EVIDENCE_MISSING', null, true],
    ]);
    expect(r.envelopes[1].contract.promptVersion).toBe('t1_master_v1@pv13:ffff');
    expect(r.received).toHaveLength(1);
    expect(r.received[0].callIndex).toBe(1);
    // Identité de trace JAMAIS inventée : absente si la passerelle ne l'a pas rendue.
    const sansTrace = await passe(unites('Total : 120,00 EUR'), [async () => ({ output: { facts: [], entities: { rooms: [], equipments: [] } }, valueDecisions: null })]);
    expect(sansTrace.envelopes[0]).toMatchObject({ callRef: null, decisionsField: 'ABSENT', rawDecisions: 0 });
    expect(sansTrace.envelopes[0].contract.state).toBe('EVIDENCE_MISSING');
  });
});

describe('C854-U03 — R2 : référence → fait PERSISTÉ exact, jamais le premier résultat', () => {
  const persiste = (id: number, over: Record<string, unknown> = {}) => ({
    id, key: 'cotisation.annuelle', value: '412.00', excerpt: 'Cotisation annuelle : 412,00 EUR', targetType: 'DOCUMENT', targetEntityId: null, ...over,
  });
  const cite = { key: 'cotisation.annuelle', value: '412.00', excerpt: 'Cotisation annuelle : 412,00 EUR', targetType: 'DOCUMENT', targetEntityId: null };

  it('AC01 : identité exacte → ce fait ; même fait relu dans un autre passage (rappel) → résolu par clé + valeur + cible', () => {
    expect(resolveFactReference(cite, [persiste(5), persiste(6, { value: '12.00' })])).toEqual({ id: 5 });
    expect(resolveFactReference({ ...cite, excerpt: 'Rappel : 412,00 EUR' }, [persiste(5)])).toEqual({ id: 5 });
  });

  it('AC03 : deux faits candidats → AMBIGU (jamais FIFO) ; cible ou clé différente → inconnu ; valeur seule / clé seule refusées', () => {
    expect(resolveFactReference({ ...cite, excerpt: 'Autre passage' }, [persiste(5), persiste(9, { excerpt: 'Échéancier : 412,00 EUR' })])).toEqual({ ambiguous: [5, 9] });
    expect(resolveFactReference(cite, [persiste(5), persiste(3)])).toEqual({ ambiguous: [3, 5] });
    expect(resolveFactReference(cite, [persiste(5, { targetType: 'ASSET', targetEntityId: 4 })])).toBeNull();
    expect(resolveFactReference(cite, [persiste(5, { key: 'franchise' })])).toBeNull();
    expect(resolveFactReference({ ...cite, key: null }, [persiste(5)])).toBeNull();
    expect(resolveFactReference({ ...cite, value: '' }, [persiste(5)])).toBeNull();
  });
});

describe('C854-U04 — R3 : chaque ligne validée garde le rang de SA réception', () => {
  it('rang porté, doublon exact rendu (jamais perdu), `LINK_AMBIGUOUS` déclaré', () => {
    const u = unites('Rappel : cotisation annuelle de 412,00 EUR');
    const d = decision('412,00 EUR', { decision: 'NOT_RETAINED', reason: 'Rappel informatif de la cotisation déjà échue au contrat.', sourceUnitId: u[0].sourceUnitId });
    const doublons: unknown[] = [];
    const out = validateValueDecisions([d as never, d as never], { units: u, keptFactRefs: new Set(), candidateKeys: new Set() }, { duplicates: doublons as never });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ inputIndex: 0, validity: 'VALID' });
    expect(doublons).toEqual([expect.objectContaining({ inputIndex: 1, validity: 'VALID' })]);
    expect(VALUE_DECISION_REJECTIONS).toContain('LINK_AMBIGUOUS');
  });
});

describe('C854-U05 — R4 / AC15 : bilan BO réconcilié', () => {
  const bilan = {
    received: 6, valid: 2, invalid: 1, persisted: 1, rejected: 2, notEvaluated: 1, newlyWritten: 1, alreadyPresent: 1, confirmed: 2, missing: 0,
    divergent: 0, unconfirmed: 1, state: 'INCOMPLETE' as const, retryable: true, balanced: true,
    skipped: { 'INVALID:LINK_UNKNOWN': 1, CONTRACT_MARKER_MISSING: 1, SCHEMA_INVALID: 1, CONTEXT_UNAVAILABLE: 1 },
    calls: [
      { callIndex: 1, callRef: 'trace-1', contractState: 'CARRIED', contractVersion: 't1-value-decisions-v1', promptVersion: 't1_master_v1@pv12:abc', promptFingerprint: '0123', received: 5, failed: false },
      { callIndex: 2, callRef: null, contractState: 'MARKER_MISSING', contractVersion: null, promptVersion: 't1_master_v1@pv13:def', promptFingerprint: '4567', received: 1, failed: false },
      { callIndex: 3, callRef: null, contractState: 'EVIDENCE_MISSING', contractVersion: null, promptVersion: null, promptFingerprint: null, received: null, failed: true },
    ],
  };

  it('reçues = acceptées + rejetées (validation, avant validation) + non évaluées ; écritures et relecture distinctes ; contrat par appel', () => {
    const t = decisionLedgerText('Décisions', bilan);
    expect(t).toContain('6 reçue(s) = 2 acceptée(s) + 1 rejetée(s) à la validation + 2 rejetée(s) avant validation + 1 non évaluée(s) (incident)');
    expect(t).toContain('écriture : 1 nouvelle(s), 1 déjà présente(s)');
    expect(t).toContain('relecture exacte : 2 conforme(s), 0 manquante(s), 0 divergente(s), 1 non vérifiable(s)');
    expect(t).toContain('INCOMPLÈTE');
    expect(t).toContain('appel 1 : contrat porté t1-value-decisions-v1, prompt t1_master_v1@pv12:abc (empreinte 0123), 5 reçue(s), trace trace-1');
    expect(t).toContain('appel 2 : contrat absent du prompt');
    expect(t).toContain('appel 3 en échec (décisions inconnues)');
    expect(t).not.toContain('ÉCART DE RÉCONCILIATION');
    expect(decisionLedgerText('Décisions', { ...bilan, balanced: false })).toContain('ÉCART DE RÉCONCILIATION');
  });

  it('inconnu ≠ 0 ; diagnostic antérieur à la carte : aucune ligne inventée', () => {
    expect(decisionLedgerText('Décisions', { received: 1, valid: 1, invalid: 0, persisted: 1, state: 'CONFIRMED' })).toContain('+ inconnu rejetée(s) avant validation');
    expect(decisionLedgerText('Décisions', { received: 1, valid: 1, invalid: 0, persisted: 1 })).toBe('');
    const t = deferredRepairText({
      coverageRepair: null, sourceReread: null, retryAttempts: 1, lastRetryResult: 'NO_NEW_FACT',
      deferredRepair: { calls: 1, attemptedUnits: 1, newFacts: 0, decisions: { received: 1, valid: 1, invalid: 0, persisted: 1 } },
    });
    expect(t).not.toContain('journal');
  });
});

describe('C854-U06 — passerelle : marqueurs de contrat du texte brut', () => {
  it('marqueurs triés, dédoublonnés ; texte absent : aucun', () => {
    expect(promptContractMarkersOf('… (contrat t1-value-decisions-v1) … t1-billing-period-v1 … t1-value-decisions-v1')).toEqual(['t1-billing-period-v1', 't1-value-decisions-v1']);
    expect(promptContractMarkersOf('aucun marqueur ici')).toEqual([]);
    expect(promptContractMarkersOf(null)).toEqual([]);
  });
});
