/**
 * Lot 14, volet A (suite de C) — sous AI_T4_EFFECTS=enabled :
 *   1. la sémantique des candidats enrichis de C est recopiée dans les
 *      décisions (clé fonctionnelle et liens côté B) ;
 *   2. T4-04 : une source non autoritaire ne crée jamais d'échéance tenue
 *      pour acquise, sur tout le chemin jusqu'à l'écriture ;
 *   3. assurance et fin de validité du DPE (registre « selon l'événement »,
 *      sans catégorie proposée par C) : règles v2, puis modèle, abstention
 *      possible.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: async () => {},
}));

const { processAgendaCandidates } = await import('../agenda-intelligence.service');
const { classifyByRulesDetailed } = await import('../rules/deterministic-classification');
const { FakeProvider, setAiProvider } = await import('../../gateway/providers');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');

/** Candidat tel que le produit `buildAgendaCandidatesT4` (C). */
const candidat = (over: Record<string, unknown> = {}) => ({
  title: 'Contrôle technique — Clio', date: '2027-05-12', confidence: 'certain', excerpt: 'prochain contrôle avant le 12/05/2027',
  originFieldKey: 'nextInspection', suggestedCategory: 'action',
  nature: 'DEADLINE', businessType: 'inspection', target: { type: 'ASSET', id: 3 }, occurrence: 'single',
  sourceFileId: 40, dateSource: 'FIELD', documentType: 'CONTROLE_TECHNIQUE', authority: 'AUTHORITATIVE', mayCreateAgenda: true,
  sources: [{ fileId: 40, role: 'SOURCE', evidenceId: 901 }],
  ...over,
});
const run = (candidates: unknown[], t4Effects: 'legacy' | 'shadow' | 'enabled', existing: unknown[] = []) => processAgendaCandidates({
  accountId: 1, assetId: 3, candidates: candidates as never, existing: existing as never, today: '2026-09-29', t4Effects, sourceFileId: 40,
});

let fake: InstanceType<typeof FakeProvider>;
beforeEach(() => { fake = new FakeProvider(); setAiProvider(fake); vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { __setConfigForTests(null); vi.restoreAllMocks(); });

describe('1. sémantique recopiée dans les décisions (enabled)', () => {
  it('sources, occurrence, nature, type métier, champ, cible, type documentaire, autorité', async () => {
    const [d] = await run([candidat()], 'enabled');
    expect(d).toMatchObject({
      action: 'create', nature: 'DEADLINE', businessType: 'inspection', target: { type: 'ASSET', id: 3 },
      occurrenceIndex: 'single', dateSource: 'FIELD', sources: [{ fileId: 40, role: 'SOURCE', evidenceId: 901 }],
      documentType: 'CONTROLE_TECHNIQUE', authority: 'AUTHORITATIVE', mayCreateAgenda: true,
      originFieldKey: 'nextInspection', sourceFileId: 40,
    });
  });

  it('récurrence : recopiée, et chaque occurrence porte sa propre date comme index', async () => {
    const decisions = await run([candidat({
      title: 'Entretien chaudière', date: '2026-10-15', originFieldKey: 'maintenanceDueDate', businessType: 'maintenance',
      documentType: 'RAPPORT_ENTRETIEN', recurrence: { mode: 'EXPLICIT_SOURCE', frequency: 'yearly', interval: 1 },
    })], 'enabled');
    expect(decisions.length).toBeGreaterThan(1);
    expect(decisions[0]).toMatchObject({ occurrenceIndex: 'single', recurrence: { frequency: 'yearly' } });
    for (const d of decisions.slice(1)) {
      expect(d.occurrenceIndex).toBe(d.date);
      expect(d.sources).toEqual([{ fileId: 40, role: 'SOURCE', evidenceId: 901 }]);
    }
  });

  it('legacy et shadow : décisions inchangées (aucun champ recopié)', async () => {
    for (const mode of ['legacy', 'shadow'] as const) {
      const [d] = await run([candidat()], mode);
      expect(d.sources).toBeUndefined();
      expect(d.occurrenceIndex).toBeUndefined();
      expect(d.nature).toBeUndefined();
    }
  });
});

describe('2. T4-04 sur tout le chemin', () => {
  it('source non autoritaire : jamais `create` (base ni occurrences), proposition à qualifier', async () => {
    const decisions = await run([candidat({
      title: 'Entretien chaudière', date: '2026-10-15', originFieldKey: 'maintenanceDueDate', businessType: 'maintenance',
      documentType: 'DEVIS', authority: 'WEAK', mayCreateAgenda: false,
      recurrence: { mode: 'EXPLICIT_SOURCE', frequency: 'yearly', interval: 1 },
    })], 'enabled');
    expect(decisions.some((d) => d.action === 'create')).toBe(false);
    expect(decisions[0]).toMatchObject({ action: 'propose', reasonCode: 'SOURCE_TYPE_NOT_AUTHORIZED', mayCreateAgenda: false });
  });

  it('type inconnu (autorité null) : proposition, jamais création', async () => {
    const [d] = await run([candidat({ documentType: 'BROCHURE', authority: null, mayCreateAgenda: null })], 'enabled');
    expect(d).toMatchObject({ action: 'propose', reasonCode: 'SOURCE_TYPE_UNKNOWN' });
  });

  it('source non autoritaire face à un existant : aucun `create` ni `update` (doublon ou arbitrage seulement)', async () => {
    const existant = { id: 7, title: 'Contrôle technique — Clio', date: '2027-05-12', category: 'action', status: null, manual: false, originFieldKey: 'nextInspection' };
    const decisions = await run([candidat({ documentType: 'DEVIS', authority: 'WEAK', mayCreateAgenda: false })], 'enabled', [existant]);
    expect(decisions.every((d) => d.action !== 'create' && d.action !== 'update')).toBe(true);
  });
});

describe('3. assurance et fin de validité du DPE : règles v2, puis modèle', () => {
  it('registre « selon l’événement » : aucun motif de titre générique ne tranche', () => {
    const dpe = { title: 'Fin de validité du DPE', originType: 'asset_field', originFieldKey: 'dpeExpiryDate' };
    const assurance = { title: 'Échéance de l’assurance — Clio', originType: 'asset_field', originFieldKey: 'insuranceExpiry' };
    expect(classifyByRulesDetailed(dpe, 'v2')).toBeNull();
    expect(classifyByRulesDetailed(assurance, 'v2')).toBeNull();
    // Règle métier stable applicable à l'événement concret.
    expect(classifyByRulesDetailed({ ...assurance, description: 'reconduction tacite' }, 'v2'))
      .toMatchObject({ category: 'information', source: 'business_rule' });
    // Historique inchangé : « champ de bien ⇒ information ».
    expect(classifyByRulesDetailed(dpe, 'legacy')?.category).toBe('information');
  });

  it('enabled + master : le modèle classe ; abstention → catégorie prudente à qualifier', async () => {
    __setConfigForTests({ versionId: 44, entries: [{ ...emptyTreatmentConfig('T4'), primaryModel: 'm-a', promptArchitecture: 'master' }] });
    fake.onAny((input) => ({
      rawText: JSON.stringify(input.prompt.includes('dpeExpiryDate')
        ? { task: 'CLASSIFY_EVENT', businessType: 'dpe', homeCategory: 'unknown', confidence: 'ambiguous', reason: 'aucune démarche explicite' }
        : { task: 'CLASSIFY_EVENT', businessType: 'insurance', homeCategory: 'action', confidence: 'certain', reason: 'résiliation à envoyer avant l’échéance' }),
      inputTokens: 1, outputTokens: 1,
    }));
    const [dpe, assurance] = await run([
      candidat({ title: 'Fin de validité du DPE', date: '2031-01-01', originFieldKey: 'dpeExpiryDate', businessType: 'dpe', suggestedCategory: undefined, documentType: 'DPE', excerpt: 'valable jusqu’au 01/01/2031' }),
      candidat({ title: 'Échéance de l’assurance — Clio', date: '2027-01-01', originFieldKey: 'insuranceExpiry', businessType: 'insurance', suggestedCategory: undefined, documentType: 'CONTRAT_ASSURANCE', excerpt: 'pour résilier, envoyer le courrier avant le 01/12/2026' }),
    ], 'enabled');
    expect(fake.calls).toHaveLength(2);
    expect(dpe).toMatchObject({ category: 'action', classification: { category: 'unknown', source: 'model', requiresQualification: true } });
    expect(assurance).toMatchObject({ category: 'action', classification: { category: 'action', source: 'model', requiresQualification: false } });
  });

  it('enabled + steps : modèle historique (binaire) pour ces cas, sans règle « assurance = information »', async () => {
    fake.onAny(() => ({ rawText: JSON.stringify({ category: 'action', reason: 'démarche demandée' }), inputTokens: 1, outputTokens: 1 }));
    const [d] = await run([candidat({ title: 'Échéance de l’assurance — Clio', originFieldKey: 'insuranceExpiry', businessType: 'insurance', suggestedCategory: undefined, documentType: 'CONTRAT_ASSURANCE' })], 'enabled');
    expect(fake.calls).toHaveLength(1);
    expect(d.classification).toMatchObject({ category: 'action', source: 'model' });
  });
});
