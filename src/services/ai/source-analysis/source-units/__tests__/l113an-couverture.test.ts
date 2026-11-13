/**
 * Lot 113AN (Trello #741) — faux UNRESOLVED de la couverture T1 et reprise
 * ciblée des vraies lacunes (unitaires, sans base).
 *
 *   A. Causes DÉMONTRÉES : `computeCoverage` seul (comportement d'avant)
 *      laisse `not_extracted` des unités réellement couvertes — décision de
 *      valeur, tableau transcrit, répétition, recouvrement de segments,
 *      valeur isolée, métadonnée ; la réconciliation les couvre SUR PREUVE et
 *      n'invente rien (champs proches, valeurs partielles, doublon de valeur
 *      sur une autre page).
 *   B. Chaîne réelle (`analyseGroupWithMaster`, passerelle réelle, fournisseur
 *      simulé) : scénario « type 388 » (unité `page:1:field:2` relue par la
 *      réparation — appel 2 — qui rend un fait IDENTIQUE à un fait existant
 *      et une décision de valeur : avant, `not_extracted` ; après, couverte),
 *      scénario « type 126 » (tableau transcrit, prose, coordonnées), coût
 *      borné (appels comptés, jamais de réparation inutile), politique des
 *      unités restantes, COMPLETE seulement si tout est démontré.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SourceInput, AnalysisContext } from '../../types';
import type { ProviderCallInput } from '@/services/ai/gateway/providers/provider.port';

vi.mock('@/services/account-capabilities.service', async (orig) => ({
  ...(await orig<object>()), getAccountCapabilities: async () => ({ rooms: true, equipments: true }),
}));
vi.mock('@/services/ai/telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/telemetry/ai-trace.service')>()),
  recordCallTrace: async () => {},
}));
vi.mock('../../identifier-verifier', () => ({
  verifyCandidates: async (_e: string, candidates: Array<{ entityId: number | null }>) => ({ candidates: candidates.map((c) => ({ ...c, verified: false })), warnings: [] }),
}));
vi.mock('../../master/rubric-rules', async (orig) => ({
  ...(await orig<typeof import('../../master/rubric-rules')>()),
  loadAssetFamilies: async () => ['IMMOBILIER', 'VEHICULE', 'MATERIEL_PRO', 'OBJECT'],
}));
vi.mock('../page-chunks', async (orig) => ({ ...(await orig<typeof import('../page-chunks')>()), fetchSourceBytes: async () => null }));
/** Contrat des décisions de valeur porté par le prompt effectif (bloc PO 91D appliqué en préproduction). */
const contrat = vi.hoisted(() => ({ carried: true }));
vi.mock('../../value-decisions/contract', async (orig) => ({
  ...(await orig<typeof import('../../value-decisions/contract')>()),
  valueDecisionsCapability: async () => (contrat.carried
    ? { carried: true, version: null, reason: 'CARRIED' as const } : { carried: false, version: null, reason: 'MARKER_MISSING' as const }),
}));

const { FakeProvider, setAiProvider } = await import('@/services/ai/gateway/providers');
const { __setConfigForTests } = await import('@/services/ai/config/config-resolver');
const { emptyTreatmentConfig } = await import('@/services/ai/config/config-types');
const { analyseGroupWithMaster } = await import('../../master/analyse-group-master');
const { emptyTrace } = await import('../../trace');
const { buildSourceUnits } = await import('../build-units');
const { computeCoverage, SourceUnitLinker } = await import('../coverage');
const { reconcileCoverage, residualPolicyOf, withResidualPolicies, unitValueForms } = await import('../coverage-reconciliation');
type Units = ReturnType<typeof buildSourceUnits>;

let fake: InstanceType<typeof FakeProvider>;
const ctx: AnalysisContext = { accountId: 1, userId: 1, assets: [], rooms: [], equipments: [], existingTitles: [], linkedAssetId: null };
const input = (over: Partial<SourceInput> = {}): SourceInput => ({
  sourceType: 'file', sourceIds: [1000], accountId: 1, userId: 1, mimeTypes: ['application/pdf'], displayNames: ['document.pdf'], ...over,
});
type Fait = Record<string, unknown>;
const fait = (excerpt: string, value: string, over: Fait = {}): Fait => ({
  canonicalKey: null, rawKey: `info.${value}`, label: null, subject: null, attribute: null, rawValue: value, normalizedValue: value,
  valueType: 'string', target: { type: 'GENERIC', entityId: null, rawLabel: null, confidence: 'certain', evidenceSignals: [] },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt, page: 1 }, ...over,
});
const sortie = (p: { transcription?: string; facts?: Fait[]; tables?: unknown[]; valueDecisions?: Fait[] }) => ({
  task: 'ANALYZE_DOCUMENT',
  document: { title: { value: 'Facture d’eau', confidence: 'certain', evidence: { excerpt: 'Facture d’eau', page: 1 } } },
  entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false },
  ...(p.transcription !== undefined ? { transcription: p.transcription } : {}),
  tables: p.tables ?? [], facts: p.facts ?? [], hasExploitableContent: true,
  ...(p.valueDecisions ? { valueDecisions: p.valueDecisions } : {}),
});
const repondre = (fn: (i: ProviderCallInput) => { output: unknown }) => {
  fake.on('m-a', (i) => ({ rawText: JSON.stringify(fn(i).output), inputTokens: 100, outputTokens: 50 }));
};
const estReparation = (i: ProviderCallInput) => /\[page:\d+:(?:field|block|form):\d+\]/.test(i.prompt);
const analyser = () => analyseGroupWithMaster(input(), [0], ctx, emptyTrace());

beforeEach(() => {
  fake = new FakeProvider();
  setAiProvider(fake);
  __setConfigForTests({ versionId: 1, entries: [{ ...emptyTreatmentConfig('T1'), primaryModel: 'm-a', fallback1: null, fallback2: null, promptArchitecture: 'master' }] });
  contrat.carried = true;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  delete process.env.T1_MAX_REPAIR_PASSES;
  delete process.env.T1_REPAIR_MIN_UNITS;
});
afterEach(() => { __setConfigForTests(null); vi.restoreAllMocks(); });

// ── Outils purs ─────────────────────────────────────────────────────────────
const unites = (text: string, extra: Partial<Parameters<typeof buildSourceUnits>[0]> = {}) =>
  buildSourceUnits({ segments: [{ text, pageOffset: 0, origin: 'PASS_1' }], ...extra });
/** Fait réduit (preuve + valeurs) tel que le voit la couverture. */
const lien = (units: Units, excerpt: string, values: unknown[], page: number | null = 1, labels: string[] = []) => ({
  excerpt, page, values, labels,
  unitIds: new SourceUnitLinker(units).link({ excerpt, page, values: values as string[], labels }),
});
const avant = (units: Units, facts: Array<ReturnType<typeof lien>>) =>
  computeCoverage(units, { facts: facts.map((f) => ({ unitIds: f.unitIds, confidence: 'certain' as const, values: f.values as string[] })) });
const apres = (units: Units, facts: Array<ReturnType<typeof lien>>, extra: Partial<Parameters<typeof reconcileCoverage>[1]> = {}) =>
  reconcileCoverage(avant(units, facts), { stage: 'ANALYSIS', facts: facts.map((f, i) => ({ ref: `f${i}`, ...f })), ...extra });
const etat = (cov: ReturnType<typeof avant>, id: string) => {
  const u = cov.find((x) => x.sourceUnitId === id);
  return u ? `${u.status}/${u.reason}` : 'absente';
};

describe('A — causes démontrées des faux UNRESOLVED et réconciliation sur preuve', () => {
  it('A1 décision de valeur VALIDE sur page:1:field:2 (identifiant transmis) : avant not_extracted, après couverte avec provenance', () => {
    const units = unites('Facture d’eau\nN° client : 556677889\nDate de relevé : 12/03/2026');
    expect(units.map((u) => u.sourceUnitId)).toEqual(['page:1:block:1', 'page:1:field:1', 'page:1:field:2']);
    const f = [lien(units, 'N° client : 556677889', ['556677889'])];
    expect(etat(avant(units, f), 'page:1:field:2')).toBe('UNRESOLVED/not_extracted');
    const cov = apres(units, f, { decisions: [{ ref: 'r1', sourceUnitId: 'page:1:field:2', kind: 'DATE', normalizedValue: '2026-03-12', decision: 'STRUCTURED' }] });
    const u = cov.find((x) => x.sourceUnitId === 'page:1:field:2')!;
    expect(`${u.status}/${u.reason}`).toBe('COVERED/value_decision');
    expect(u.coverageProvenance).toMatchObject({ rule: 'value_decision', sources: ['VALUE_DECISION'], previous: { status: 'UNRESOLVED', reason: 'not_extracted' }, stage: 'ANALYSIS' });
    // NOT_RETAINED justifié : couverte avec son motif (jamais masquée à T2/T3) ; UNDETERMINED : incertaine, jamais couverte.
    const nr = apres(units, f, { decisions: [{ ref: 'r', sourceUnitId: 'page:1:field:2', kind: 'DATE', normalizedValue: '2026-03-12', decision: 'NOT_RETAINED' }] });
    expect(etat(nr, 'page:1:field:2')).toBe('COVERED/value_decision_not_retained');
    const ind = apres(units, f, { decisions: [{ ref: 'r', sourceUnitId: 'page:1:field:2', kind: 'DATE', normalizedValue: '2026-03-12', decision: 'UNDETERMINED' }] });
    expect(etat(ind, 'page:1:field:2')).toBe('UNCERTAIN/value_undetermined');
    expect(residualPolicyOf(ind.find((x) => x.sourceUnitId === 'page:1:field:2')!)).toBe('T3_REINTERPRETATION');
  });

  it('A2 tableau transcrit dans le texte ET structuré : les lignes du texte étaient not_extracted ; couvertes par la MÊME ligne (valeurs + mots)', () => {
    const units = unites('Détail\n\nConsommation eau 45 m3 120,00 €\n\nAbonnement trimestriel 18,40 €\n\nPénalité de retard 9,99 €', {
      tables: [{ index: 0, title: 'Détail', pageStart: 1, pageEnd: 1, columns: [{ header: 'Poste', path: ['Poste'] }, { header: 'Qté', path: ['Qté'] }, { header: 'Montant', path: ['Montant'] }],
        rowCount: 2, columnCount: 3, confidence: 'certain', uncertain: false, issues: [],
        cells: [
          { row: 0, column: 0, rowHeader: null, columnHeader: 'Poste', columnPath: ['Poste'], value: 'Consommation eau', normalized: null, valueType: null, colspan: 1, rowspan: 1, page: 1, confidence: 'certain' },
          { row: 0, column: 1, rowHeader: null, columnHeader: 'Qté', columnPath: ['Qté'], value: '45 m3', normalized: '45', valueType: null, colspan: 1, rowspan: 1, page: 1, confidence: 'certain' },
          { row: 0, column: 2, rowHeader: null, columnHeader: 'Montant', columnPath: ['Montant'], value: '120,00 €', normalized: '120.00', valueType: null, colspan: 1, rowspan: 1, page: 1, confidence: 'certain' },
          { row: 1, column: 0, rowHeader: null, columnHeader: 'Poste', columnPath: ['Poste'], value: 'Abonnement trimestriel', normalized: null, valueType: null, colspan: 1, rowspan: 1, page: 1, confidence: 'certain' },
          { row: 1, column: 2, rowHeader: null, columnHeader: 'Montant', columnPath: ['Montant'], value: '18,40 €', normalized: '18.40', valueType: null, colspan: 1, rowspan: 1, page: 1, confidence: 'certain' },
        ] }],
    });
    const blocs = units.filter((u) => u.kind === 'TEXT_BLOCK').map((u) => u.sourceUnitId);
    const a = avant(units, []);
    expect(blocs.slice(1).map((id) => etat(a, id))).toEqual(['UNRESOLVED/not_extracted', 'UNRESOLVED/not_extracted', 'UNRESOLVED/not_extracted']);
    const b = apres(units, []);
    expect(blocs.slice(1).map((id) => etat(b, id))).toEqual(['COVERED/table_transcription', 'COVERED/table_transcription', 'UNRESOLVED/not_extracted']);
    expect(b.find((u) => u.sourceUnitId === blocs[1])!.coverageProvenance!.refs).toEqual(['unit:page:1:table:1:row:1']);
    // Lecture déterministe de « 45 m3 120,00 € » (montant lu « 3 120,00 € ») : la ligne transcrite est reconnue par ses cellules.
    expect(b.find((u) => u.sourceUnitId === blocs[1])!.coverageProvenance!.rule).toBe('table_transcription');
  });

  it('A3 doublon : même ligne répétée en page 2 (en-tête) — couverte comme répétition ; une valeur identique au libellé différent ne l’est pas', () => {
    const units = buildSourceUnits({ segments: [{ text: '--- page 1 ---\nRéférence client : 556677889\n--- page 2 ---\nRéférence client : 556677889\nN° de compteur : 556677889', pageOffset: 0, origin: 'PASS_1' }] });
    const f = [lien(units, 'Référence client : 556677889', ['556677889'], 1)];
    const a = avant(units, f);
    expect(etat(a, 'page:2:field:1')).toBe('UNRESOLVED/not_extracted');
    const b = apres(units, f);
    expect(etat(b, 'page:2:field:1')).toBe('COVERED/duplicate');
    // Même valeur, autre libellé, autre page, fait de la page 1 : AUCUNE correspondance abusive.
    expect(etat(b, 'page:2:field:2')).toBe('UNRESOLVED/not_extracted');
  });

  it('A4 recouvrement de deux segments (page relue par le lot suivant) : l’unité citée par l’extrait du fait est couverte', () => {
    const units = buildSourceUnits({ segments: [
      { text: '--- page 1 ---\nIndex relevé : 1234\nIndex précédent : 1180', pageOffset: 0, origin: 'PASS_1' },
      { text: 'Index relevé 1234 Index précédent 1180 Consommation 54', pageOffset: 0, origin: 'CHUNK' },
    ] });
    const ex = 'Index relevé 1234 Index précédent 1180 Consommation 54';
    // Trois faits, chacun cité par la ligne ENTIÈRE (extrait multi-unités) lue dans le 2e segment.
    const f = [lien(units, ex, ['1234'], 1, ['index_releve']), lien(units, ex, ['1180'], 1, ['index_precedent']), lien(units, ex, ['54'], 1, ['consommation'])];
    // L'extrait est retrouvé dans le bloc du 2e segment : les deux couples du 1er segment restaient non couverts.
    expect(f[0].unitIds).toEqual(['page:1:block:1']);
    const a = avant(units, f);
    expect([etat(a, 'page:1:field:1'), etat(a, 'page:1:field:2')]).toEqual(['UNRESOLVED/not_extracted', 'UNRESOLVED/not_extracted']);
    const b = apres(units, f);
    expect([etat(b, 'page:1:field:1'), etat(b, 'page:1:field:2')]).toEqual(['COVERED/overlap', 'COVERED/overlap']);
    // Un seul fait (consommation) : les index ne sont PAS structurés — aucune promotion par simple recouvrement.
    const seul = apres(units, [lien(units, ex, ['54'], 1, ['consommation'])]);
    expect([etat(seul, 'page:1:field:1'), etat(seul, 'page:1:field:2')]).toEqual(['UNRESOLVED/not_extracted', 'UNRESOLVED/not_extracted']);
  });

  it('A5 champs proches : seul le TTC est structuré — le HT reste non résolu ; valeurs partielles : motif précis', () => {
    const units = unites('Montant HT : 100,00 €\nMontant TTC : 120,00 €\nPériode du 01/01/2026 au 31/03/2026');
    const f = [lien(units, 'Montant TTC : 120,00 €', ['120.00'], 1, ['montant_ttc']), lien(units, 'Période du 01/01/2026', ['2026-01-01'], 1, ['periode_debut'])];
    const b = apres(units, f);
    expect(etat(b, 'page:1:field:1')).toBe('UNRESOLVED/not_extracted');
    expect(etat(b, 'page:1:field:2')).toBe('COVERED/fact');
    // « Période du … au … » : bloc lié au fait de début (extrait inclus) — fin non représentée : couverte par le lien existant.
    expect(etat(b, 'page:1:block:1')).toBe('COVERED/fact');
  });

  it('A6 valeur isolée : seule unité de la page qui porte la valeur, fait de la même page → couverte ; deux porteurs → non', () => {
    const units = unites('Total à payer\n\n45,20 €\n\nMerci');
    const f = [lien(units, 'Total à payer', ['45.20'], 1, ['total'])];
    expect(etat(apres(units, f), 'page:1:block:2')).toBe('COVERED/values_structured');
    const deux = unites('Total à payer\n\n45,20 €\n\nDéjà réglé 45,20 €');
    const f2 = [lien(deux, 'Total à payer', ['45.20'], 1, ['total'])];
    expect(etat(apres(deux, f2), 'page:1:block:2')).toBe('UNRESOLVED/not_extracted');
  });

  it('A7 métadonnée du document (montant) sans extrait : unité unique du document couverte', () => {
    const units = unites('Facture\n\nNet à payer 132,00 €');
    const b = apres(units, [], { values: [{ ref: 'amount', source: 'METADATA', values: [132], page: null }] });
    expect(etat(b, 'page:1:block:2')).toBe('COVERED/values_structured');
    expect(b.find((u) => u.sourceUnitId === 'page:1:block:2')!.coverageProvenance!.refs).toEqual(['meta:amount']);
  });

  it('A8 idempotente (même entrée → même sortie, état d’origine conservé) ; jamais d’effet sur une unité couverte, incertaine ou en échec', () => {
    const units = unites('N° client : 556677889\nDate de relevé : 12/03/2026');
    const d = { decisions: [{ ref: 'r1', sourceUnitId: 'page:1:field:2', kind: 'DATE', normalizedValue: '2026-03-12', decision: 'STRUCTURED' }] };
    const une = apres(units, [], d);
    const deux = reconcileCoverage(une, { stage: 'STORED', facts: [], ...d });
    expect(deux.map((u) => [u.sourceUnitId, u.status, u.reason, u.coverageProvenance?.previous])).toEqual(une.map((u) => [u.sourceUnitId, u.status, u.reason, u.coverageProvenance?.previous]));
    const echec = avant(units, []).map((u) => (u.sourceUnitId === 'page:1:field:2' ? { ...u, status: 'FAILED' as const, reason: 'repair_failed:retryable' } : u));
    expect(etat(reconcileCoverage(echec, { stage: 'ANALYSIS', facts: [], ...d }), 'page:1:field:2')).toBe('FAILED/repair_failed:retryable');
  });

  it('A9 politique explicite de chaque unité restante (jamais une clôture silencieuse)', () => {
    const base = { kind: 'TEXT_BLOCK' as const, salient: true, payload: {}, repairAttempts: 0, repairState: null };
    expect(residualPolicyOf({ ...base, status: 'COVERED', reason: 'fact' })).toBeNull();
    expect(residualPolicyOf({ ...base, status: 'UNRESOLVED', reason: 'not_structured', salient: false })).toBe('PRESERVED_UNSTRUCTURED');
    expect(residualPolicyOf({ ...base, status: 'UNRESOLVED', reason: 'not_extracted', repairAttempts: 1, repairState: 'ATTEMPTED_FAILED' })).toBe('REPAIR_ATTEMPTED_NO_RESULT');
    expect(residualPolicyOf({ ...base, status: 'UNRESOLVED', reason: 'not_extracted' }, { repairSkipped: 'DISABLED' })).toBe('REPAIR_NOT_RUN:DISABLED');
    expect(residualPolicyOf({ ...base, status: 'UNRESOLVED', reason: 'not_extracted', repairState: 'PENDING' })).toBe('REPAIR_PENDING');
    expect(residualPolicyOf({ ...base, status: 'FAILED', reason: 'repair_failed:retryable' })).toBe('REPAIR_RETRY_SCHEDULED');
    expect(residualPolicyOf({ ...base, kind: 'PAGE_GAP', status: 'FAILED', reason: 'x', payload: { retryable: false } })).toBe('TECHNICAL_FAILURE_FINAL');
    expect(withResidualPolicies(avant(unites('Merci de votre confiance et à bientôt'), [])).map((u) => u.residualPolicy)).toEqual(['PRESERVED_UNSTRUCTURED']);
    expect(unitValueForms('Index 1 234 le 12/03/2026 : 45,20 €').sort()).toEqual(['AMOUNT:4520', 'DATE:2026-03-12', 'NUM:1234']);
  });
});

// ══ B — chaîne T1 réelle, sorties Gemini simulées ═════════════════════════════

/** Facture « type 388 » : référence répétée, date de relevé en page 1 ET dans le récapitulatif de la page 2. */
const T388 = [
  '--- page 1 ---', 'Facture d’eau', 'N° client : 556677889', 'Date de relevé : 12/03/2026', 'Total à payer : 132,00 €',
  '--- page 2 ---', 'N° client : 556677889', 'Relevé effectué le 12/03/2026 par télérelève',
].join('\n');
const faits388 = () => [
  fait('N° client : 556677889', '556677889', { rawKey: 'client.numero' }),
  fait('Total à payer : 132,00 €', '132.00', { rawKey: 'total.ttc' }),
  // Fait de la date lu sur le récapitulatif (page 2), extrait = la date seule.
  fait('12/03/2026', '2026-03-12', { rawKey: 'releve.date', evidence: { excerpt: '12/03/2026', page: 2 } }),
];

describe('B — chaîne T1 (scénarios « type 388 » et « type 126 »)', () => {
  it('type 388 : page:1:field:2 transcrit par l’appel de réparation (fait identique + décision) → COUVERTE, sans doublon de fait, coût mesuré', async () => {
    repondre((i) => (estReparation(i)
      ? { output: sortie({
        transcription: '[page:1:field:2]\nDate de relevé : 12/03/2026',
        // La réparation relit la date — MÊME fait (clé, valeur, cible, extrait) que celui de la passe principale.
        facts: [fait('12/03/2026', '2026-03-12', { rawKey: 'releve.date' })],
        valueDecisions: [{ value: '12/03/2026', kind: 'DATE', normalizedValue: '2026-03-12', decision: 'STRUCTURED', reason: 'Date du relevé du compteur reprise dans le fait de relevé.',
          sourceUnitId: '[page:1:field:2]', evidence: { excerpt: '12/03/2026', page: 1 }, relatedFactIndexes: [0], relatedCandidateKeys: [], confidence: 'certain' }],
      }) }
      : { output: sortie({ transcription: T388, facts: faits388() }) }));
    const m = await analyser();
    // 1 analyse + 1 réparation ciblée (appel « analysis » de la passerelle, jamais compté en `repairCalls` JSON).
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].prompt).toContain('[page:1:field:2]');
    const u = m.sourceLayer!.units.find((x) => x.sourceUnitId === 'page:1:field:2')!;
    expect(u).toMatchObject({ status: 'COVERED', reason: 'fact', repairAttempts: 1, repairState: 'SUCCEEDED', residualPolicy: null });
    // Aucun doublon : 3 faits, comme la passe principale.
    expect(m.facts).toHaveLength(3);
    // Répétition de la page 2 couverte sur preuve (texte identique à une unité couverte).
    expect(m.sourceLayer!.units.find((x) => x.sourceUnitId === 'page:2:field:1')).toMatchObject({ status: 'COVERED', reason: 'duplicate' });
    const d = m.sourceLayer!.report.diagnostics!;
    expect(d.coverageRepair).toMatchObject({ passes: 1, calls: 1, selected: 1, attempted: 1, resolved: 1, factsAdded: 0, factsConfirmed: 1, decisions: 1, skipped: null });
    // Décision de la réparation validée et transmise à la persistance (ancrée sur l'unité citée).
    expect(m.valueDecisions?.filter((x) => x.validity === 'VALID').map((x) => [x.sourceUnitId, x.decision])).toEqual([['page:1:field:2', 'STRUCTURED']]);
    expect(m.sourceLayer!.report.qualityState).toBe('COMPLETE');
  });

  it('type 388 — décision seule (aucun fait) NOT_RETAINED : couverte avec son motif ; contrat non porté : rien n’est supposé', async () => {
    const reparation = sortie({ transcription: '[page:1:field:2]\nDate de relevé : 12/03/2026', facts: [], valueDecisions: [{
      value: '12/03/2026', kind: 'DATE', normalizedValue: '2026-03-12', decision: 'NOT_RETAINED', reason: 'Date de télérelève du compteur, distincte de la date de facture.',
      sourceUnitId: 'page:1:field:2', evidence: {}, relatedFactIndexes: [], relatedCandidateKeys: [], confidence: 'certain' }] });
    const premiere = sortie({ transcription: T388.split('\n').slice(0, 5).join('\n'), facts: faits388().slice(0, 2) });
    repondre((i) => ({ output: estReparation(i) ? reparation : premiere }));
    const m = await analyser();
    expect(m.sourceLayer!.units.find((x) => x.sourceUnitId === 'page:1:field:2')).toMatchObject({ status: 'COVERED', reason: 'value_decision_not_retained' });
    contrat.carried = false;
    const m2 = await analyser();
    expect(m2.sourceLayer!.units.find((x) => x.sourceUnitId === 'page:1:field:2')).toMatchObject({
      status: 'UNRESOLVED', reason: 'not_extracted', repairState: 'ATTEMPTED_FAILED', residualPolicy: 'REPAIR_ATTEMPTED_NO_RESULT',
    });
    expect(m2.sourceLayer!.report.qualityState).toBe('COMPLETE_WITH_UNRESOLVED');
  });

  it('type 126 : tableau transcrit couvert SANS appel ; vraie omission (coordonnée) réparée ; prose conservée avec politique ; jamais COMPLETE', async () => {
    const texte = [
      'Avis d’échéance assurance moto', 'Contrat n° : MOTO-778899', '',
      'Garantie responsabilité civile 210,00 €', '', 'Garantie vol incendie 95,50 €', '',
      'Votre conseiller reste à votre écoute pour toute question sur vos garanties.', '',
      'Contact : service.client@assureur-exemple.fr',
    ].join('\n');
    const tables = [{ title: 'Garanties', pageStart: 1, pageEnd: 1, columns: [{ header: 'Garantie' }, { header: 'Prime' }],
      rows: [{ cells: [{ column: 0, value: 'Garantie responsabilité civile' }, { column: 1, value: '210,00 €' }] },
        { cells: [{ column: 0, value: 'Garantie vol incendie' }, { column: 1, value: '95,50 €' }] }] }];
    repondre((i) => (estReparation(i)
      ? { output: sortie({ facts: [fait('Contact : service.client@assureur-exemple.fr', 'service.client@assureur-exemple.fr', { rawKey: 'contact.email' })] }) }
      : { output: sortie({ transcription: texte, tables, facts: [fait('Contrat n° : MOTO-778899', 'MOTO-778899', { rawKey: 'contrat.numero' })] }) }));
    const m = await analyser();
    expect(fake.calls).toHaveLength(2);
    // Seule la vraie lacune est envoyée (jamais les lignes du tableau déjà structuré, ni la prose).
    expect(fake.calls[1].prompt).toContain('service.client@assureur-exemple.fr');
    expect(fake.calls[1].prompt).not.toContain('210,00');
    expect(fake.calls[1].prompt).not.toContain('Votre conseiller');
    const par = (t: string) => m.sourceLayer!.units.find((u) => u.text?.startsWith(t))!;
    expect(par('Garantie responsabilité civile')).toMatchObject({ kind: 'TEXT_BLOCK', status: 'COVERED', reason: 'table_transcription' });
    expect(par('Garantie vol incendie')).toMatchObject({ status: 'COVERED', reason: 'table_transcription' });
    expect(par('Contact')).toMatchObject({ status: 'COVERED', reason: 'fact', repairState: 'SUCCEEDED' });
    expect(par('Votre conseiller')).toMatchObject({ status: 'UNRESOLVED', reason: 'not_structured', residualPolicy: 'PRESERVED_UNSTRUCTURED' });
    const r = m.sourceLayer!.report;
    expect(r.qualityState).toBe('COMPLETE_WITH_UNRESOLVED');
    // Prose et intitulé sans valeur : conservés, lisibles par T2 / T3.
    expect(r.diagnostics!.residualPolicies).toEqual({ PRESERVED_UNSTRUCTURED: 2 });
    expect(par('Avis d’échéance')).toMatchObject({ residualPolicy: 'PRESERVED_UNSTRUCTURED' });
    expect(r.diagnostics!.reconciliation).toMatchObject({ byRule: { table_transcription: 2 } });
    expect(r.coveredUnits + r.nonInformationalUnits + r.unresolvedUnits + r.uncertainUnits + r.failedUnits).toBe(r.totalSourceUnits);
  });

  it('coût borné : document entièrement couvert par la réconciliation → AUCUNE réparation (motif consigné) ; réparation désactivée → politique explicite', async () => {
    repondre(() => ({ output: sortie({ transcription: 'Facture d’eau\nN° client : 556677889\n\nN° client : 556677889', facts: [fait('N° client : 556677889', '556677889')] }) }));
    const m = await analyser();
    expect(fake.calls).toHaveLength(1);
    expect(m.sourceLayer!.report.diagnostics!.coverageRepair).toMatchObject({ calls: 0, skipped: 'NO_TARGET' });
    process.env.T1_MAX_REPAIR_PASSES = '0';
    repondre(() => ({ output: sortie({ transcription: 'Facture d’eau\nDate de relevé : 12/03/2026', facts: [] }) }));
    const m2 = await analyser();
    expect(m2.sourceLayer!.units.find((u) => u.sourceUnitId === 'page:1:field:1')).toMatchObject({ status: 'UNRESOLVED', residualPolicy: 'REPAIR_NOT_RUN:DISABLED' });
    expect(m2.sourceLayer!.report.diagnostics!.coverageRepair).toMatchObject({ calls: 0, skipped: 'DISABLED' });
  });
});

describe('C — BO : libellés du rapport de complétude (compteurs seulement)', () => {
  it('politiques, motif d’absence de réparation, ligne de réparation de couverture', async () => {
    const { policyLabel, coverageRepairText } = await import('@/app/admin/ai-executions/_components/T1CompletenessUnits');
    expect(policyLabel('REPAIR_NOT_RUN:DISABLED')).toBe('réparation non exécutée (réparation désactivée (T1_MAX_REPAIR_PASSES=0))');
    expect(policyLabel('PRESERVED_UNSTRUCTURED')).toBe('texte sans valeur structurable — conservé');
    expect(coverageRepairText(null)).toContain('non consignée');
    expect(coverageRepairText({ passes: 0, calls: 0, selected: 0, attempted: 0, resolved: 0, factsAdded: 0, factsConfirmed: 0, decisions: 0, skipped: 'NO_TARGET' }))
      .toBe('Réparation ciblée de couverture : non exécutée — aucune unité à réparer (0 unité(s) sélectionnée(s)).');
    expect(coverageRepairText({ passes: 1, calls: 1, selected: 2, attempted: 2, resolved: 1, factsAdded: 1, factsConfirmed: 0, decisions: 1, skipped: null }))
      .toContain('1 passe(s), 1 appel(s), 2 unité(s) sélectionnée(s), 2 soumise(s), 1 couverte(s)');
  });
});
