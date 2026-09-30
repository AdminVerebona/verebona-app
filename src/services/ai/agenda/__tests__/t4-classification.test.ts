/**
 * CDC 15 T4-02, T4-10, T4-11, P-T4-01 — classification action / information :
 * registre avant tout, règles métier stables en un seul exemplaire, master à
 * trois valeurs, classification prudente, chemin `steps` inchangé.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const traces: Array<Record<string, unknown>> = [];
vi.mock('../../telemetry/ai-trace.service', async (orig) => ({
  ...(await orig<typeof import('../../telemetry/ai-trace.service')>()),
  recordCallTrace: async (t: Record<string, unknown>) => { traces.push(t); },
}));

const { classifyByRules, classifyByRulesDetailed, classifyByRulesLegacy } = await import('../rules/deterministic-classification');
const { classificationMode, classifyByRulesInMode } = await import('../rules/rules-engine');
const { applyBusinessRules } = await import('../rules/business-rules');
const { prudentCategory } = await import('../rules/prudent-category');
const { classifyAgendaEvent, classifyAgendaCategory } = await import('../agenda-intelligence.service');
const { classifyAgendaItem } = await import('@/services/agenda/AgendaClassificationService');
const { FakeProvider, setAiProvider } = await import('../../gateway/providers');
const { __setConfigForTests } = await import('../../config/config-resolver');
const { emptyTreatmentConfig } = await import('../../config/config-types');

const P1 = JSON.parse(readFileSync(join(__dirname, '..', 'master', '__fixtures__', 'p-t4-01-controle-technique-futur.json'), 'utf8'));
let fake: InstanceType<typeof FakeProvider>;
const T4 = (arch: 'steps' | 'master') => __setConfigForTests({
  versionId: 41, entries: [{ ...emptyTreatmentConfig('T4'), primaryModel: 'm-a', promptArchitecture: arch }],
});
const ctx = { accountId: 1 };

beforeEach(() => { traces.length = 0; fake = new FakeProvider(); setAiProvider(fake); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { __setConfigForTests(null); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('T4-02 : plus de « champ de bien ⇒ information »', () => {
  it('échéances futures issues d’un champ : action ; faits passés : information (registre)', () => {
    const f = (originFieldKey: string, title = 'Échéance') => classifyByRulesDetailed({ title, originType: 'asset_field', originFieldKey }, 'v2');
    expect(f('nextInspection')).toMatchObject({ category: 'action', source: 'registry' });
    expect(f('maintenanceDueDate')).toMatchObject({ category: 'action', source: 'registry' });
    expect(f('lastRevision')).toMatchObject({ category: 'information', source: 'registry' });
    expect(f('acquisitionDate')).toMatchObject({ category: 'information', source: 'registry' });
    expect(f('warrantyEndDate')).toMatchObject({ category: 'information', source: 'registry' });
  });

  it('`selon_evenement` (assurance) : l’événement concret décide, sinon ambigu', () => {
    expect(classifyByRules({ title: "Échéance d'assurance", originType: 'asset_field', originFieldKey: 'insuranceExpiry' }, 'v2')).toBeNull();
    expect(classifyByRules({ title: 'Entretien chaudière', originType: 'asset_field', originFieldKey: 'champInconnu' }, 'v2')).toBe('action');
  });

  it('type métier et nature fournis sans champ', () => {
    expect(classifyByRules({ title: 'X', originType: 'document', businessType: 'purchase', nature: 'HISTORICAL' }, 'v2')).toBe('information');
    expect(classifyByRules({ title: 'X', originType: 'document', businessType: 'inspection', nature: 'DEADLINE' }, 'v2')).toBe('action');
  });
});

describe('T4-11 : règles métier stables, un seul exemplaire', () => {
  it('reconduction tacite = information, sauf démarche explicite', () => {
    expect(applyBusinessRules('Échéance assurance habitation — reconduction tacite')).toEqual({ category: 'information', ruleCode: 'TACIT_RENEWAL_INFORMATION' });
    expect(applyBusinessRules('Échéance assurance — reconduction tacite, à résilier avant le 1er mars')).toBeNull();
    expect(classifyByRules({ title: "Échéance d'assurance", description: 'Contrat reconduit tacitement ; pour résilier, envoyez le formulaire avant le 1/03', originType: 'asset_field', originFieldKey: 'insuranceExpiry' }, 'v2')).toBeNull();
  });

  it('gardiennage / stockage / reprise : action', () => {
    expect(classifyByRules({ title: 'Fin de contrat de gardiennage', originType: 'document' }, 'v2')).toBe('action');
    expect(classifyByRules({ title: 'Pneus hiver en dépôt', originType: 'document' }, 'v2')).toBe('action');
  });

  it('plus de règle « assurance = information » par type de contrat', () => {
    expect(classifyByRules({ title: 'Fin assurance auto', originType: 'document' }, 'v2')).toBeNull();
  });

  it('AgendaClassificationService utilise la même source (aucun appel modèle sur un cas tranché)', async () => {
    vi.stubEnv('AI_T4_EFFECTS', 'enabled');
    fake.onAny(() => { throw new Error('ne doit pas être appelé'); });
    await expect(classifyAgendaItem("Échéance d'assurance", 'reconduction tacite', 'asset_field', 'insuranceExpiry', ctx)).resolves.toBe('information');
    await expect(classifyAgendaItem('Contrôle technique', null, 'asset_field', 'nextInspection', ctx)).resolves.toBe('action');
    expect(fake.calls).toHaveLength(0);
    const src = readFileSync(join(process.cwd(), 'src/services/agenda/AgendaClassificationService.ts'), 'utf8');
    // Plus de copie des règles en code ; le prompt inline historique est
    // conservé tel quel (parité legacy, arbitrage lead).
    expect(src).not.toMatch(/const actionPatterns/);
    vi.unstubAllEnvs();
  });
});

describe('T4-10 : unknown et classification prudente', () => {
  it('unknown futur → action à qualifier ; passé → information à qualifier', () => {
    const u = { category: 'unknown' as const, confidence: 'ambiguous' as const, source: 'model' as const };
    expect(prudentCategory(u, { date: '2027-01-01', today: '2026-09-29' })).toEqual({ category: 'action', requiresQualification: true });
    expect(prudentCategory(u, { date: '2025-01-01', today: '2026-09-29' })).toEqual({ category: 'information', requiresQualification: true });
    expect(prudentCategory({ category: 'information', confidence: 'certain', source: 'registry' }, { today: '2026-09-29' }))
      .toEqual({ category: 'information', requiresQualification: false });
  });
});

describe('P-T4-01 et aiguillage par architecture', () => {
  it('champ nextInspection : action par le registre, sans appel', async () => {
    T4('master');
    const c = await classifyAgendaEvent({ title: P1.context.field.title, originType: 'asset_field', originFieldKey: P1.context.field.originFieldKey }, ctx);
    expect(c).toMatchObject({ category: P1.expected.category, source: 'registry' });
    expect(fake.calls).toHaveLength(0);
  });

  it('master : cas ambigu → t4_classify_event, catalogue en données, action', async () => {
    T4('master');
    fake.onAny(() => ({ rawText: JSON.stringify(P1.recording.output), inputTokens: 1, outputTokens: 1 }));
    const cand = P1.context.candidate;
    const c = await classifyAgendaEvent({ title: cand.title, originType: 'document', description: null }, { ...ctx, excerpt: cand.excerpt, date: cand.date });
    expect(c).toMatchObject({ category: 'action', confidence: 'certain', source: 'model', businessType: 'inspection' });
    expect(fake.calls[0].prompt).toContain('TASK = CLASSIFY_EVENT');
    expect(fake.calls[0].prompt).toContain('"businessType":"inspection"');
    expect(traces[0]).toMatchObject({ operationCode: 't4_classify_event', task: 'CLASSIFY_EVENT', masterPromptCode: 't4_master_v1' });
  });

  it('master : unknown → catégorie prudente sur le chemin manuel', async () => {
    T4('master');
    fake.onAny(() => ({ rawText: JSON.stringify({ task: 'CLASSIFY_EVENT', homeCategory: 'unknown', confidence: 'ambiguous', reason: 'r' }), inputTokens: 1, outputTokens: 1 }));
    await expect(classifyAgendaCategory({ title: 'Truc', originType: 'manual' }, { ...ctx, date: '2020-01-01' })).resolves.toBe('information');
  });

  it('steps : classify_event historique, sortie binaire, aucune TASK', async () => {
    T4('steps');
    fake.onAny(() => ({ rawText: JSON.stringify({ category: 'information', reason: 'r' }), inputTokens: 1, outputTokens: 1 }));
    const c = await classifyAgendaEvent({ title: 'Truc', originType: 'manual' }, ctx);
    expect(c).toMatchObject({ category: 'information', source: 'model' });
    expect(traces[0]).toMatchObject({ operationCode: 'classify_event', task: null });
  });

  it('échec du modèle : repli historique « action », ambigu', async () => {
    T4('master');
    fake.onAny(() => { throw new Error('503'); });
    expect(await classifyAgendaEvent({ title: 'Truc', originType: 'manual' }, ctx)).toMatchObject({ category: 'action', source: 'fallback', confidence: 'ambiguous' });
  });
});

/**
 * Copie FIGÉE de la classification d'avant le lot 14 (tag lot13b,
 * `AgendaClassificationService.classifyByRules` ≡ `deterministic-classification`).
 */
function avantLot14(title: string, originType: string): 'action' | 'information' | null {
  if (originType === 'asset_field') return 'information';
  const t = title.toLowerCase();
  const actions = [
    /contrôle technique/i, /revision/i, /révision/i, /réparation/i, /reparation/i, /renouvellement/i,
    /rendez-vous/i, /rdv/i, /entretien/i, /intervention/i, /installation/i, /inspection/i, /visite/i,
    /nettoyage/i, /remplacement/i, /paiement/i, /facture/i,
    /reprise/i, /restitution/i, /récupération/i, /recuperation/i,
    /gardiennage/i, /stockage/i, /dépôt.*pneu/i, /pneu.*dépôt/i, /pneu.*hiver/i, /pneu.*été/i, /pneu.*saison/i,
    /fin.*contrat.*(gardiennage|stockage|dépôt|depot|pneu)/i, /(gardiennage|stockage|dépôt|depot|pneu).*fin.*contrat/i,
  ];
  for (const p of actions) if (p.test(t)) return 'action';
  const infos = [
    /fin de garantie/i, /garantie.*expir/i, /expir.*garantie/i, /fin.*(p[eé]riode|contrat).*assurance/i,
    /assurance.*fin/i, /assurance.*expir/i, /expiration.*assurance/i, /reconduction/i, /renouvellement.*auto/i,
    /date d['']achat/i, /^achat\b/i, /fabrication/i, /dpe/i, /diagnostic/i, /décennale/i, /échéance.*contrat/i, /fin.*contrat/i,
  ];
  for (const p of infos) if (p.test(t)) return 'information';
  return null;
}

const JEU: Array<[string, string, string | null]> = [
  ['Contrôle technique', 'asset_field', 'nextInspection'],
  ['Entretien chaudière', 'asset_field', 'maintenanceDueDate'],
  ['Échéance d\'assurance', 'asset_field', 'insuranceExpiry'],
  ['Fin de garantie', 'asset_field', 'warrantyEndDate'],
  ['Achat — Vélo', 'asset_field', 'acquisitionDate'],
  ['Fin assurance auto', 'document', null],
  ['Expiration assurance habitation', 'manual', null],
  ['Reconduction contrat box', 'document', null],
  ['Renouvellement automatique abonnement', 'document', null],
  ['Fin de contrat de gardiennage', 'document', null],
  ['Pneus hiver en dépôt', 'document', null],
  ['Achat Pneus Discount → Reprise', 'document', null],
  ['Rendez-vous notaire', 'manual', null],
  ['DPE', 'document', null],
  ['Truc à vérifier', 'manual', null],
  ['Fin de contrat', 'document', null],
];

describe('parité legacy (arbitrage lead, lot 14)', () => {
  it('moteur legacy strictement identique à avant, sur titres et champs', () => {
    for (const [title, originType, originFieldKey] of JEU) {
      expect(classifyByRulesLegacy({ title, originType, originFieldKey }), title).toBe(avantLot14(title, originType));
      expect(classifyByRules({ title, originType, originFieldKey, description: 'reconduction tacite ; stockage' }, 'legacy'), title)
        .toBe(avantLot14(title, originType));
      expect(classifyByRulesInMode({ title, originType, originFieldKey }, 'legacy')?.category ?? null, title)
        .toBe(avantLot14(title, originType));
    }
  });

  it('AgendaClassificationService en legacy : même sortie qu’avant, sans commutateur', async () => {
    fake.onAny(() => ({ rawText: 'action', inputTokens: 1, outputTokens: 1 }));
    for (const [title, originType, originFieldKey] of JEU) {
      const attendu = avantLot14(title, originType) ?? 'action';
      await expect(classifyAgendaItem(title, null, originType, originFieldKey, ctx), title).resolves.toBe(attendu);
    }
  });

  it('mode : v2 sous enabled ou master, shadow journalise, legacy sinon', () => {
    expect(classificationMode('legacy', 'steps')).toBe('legacy');
    expect(classificationMode('shadow', 'steps')).toBe('shadow');
    expect(classificationMode('enabled', 'steps')).toBe('v2');
    expect(classificationMode('legacy', 'master')).toBe('v2');
  });

  it('shadow : résultat historique, divergence journalisée', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const r = classifyByRulesInMode({ title: 'Contrôle technique', originType: 'asset_field', originFieldKey: 'nextInspection' }, 'shadow');
    expect(r?.category).toBe('information');
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/divergente .*historique=information, v2=action/));
  });

  it('classifyAgendaEvent : legacy par défaut, v2 sous enabled', async () => {
    fake.onAny(() => { throw new Error('ne doit pas être appelé'); });
    const champ = { title: 'Contrôle technique', originType: 'asset_field', originFieldKey: 'nextInspection' };
    expect((await classifyAgendaEvent(champ, ctx)).category).toBe('information');
    vi.stubEnv('AI_T4_EFFECTS', 'enabled');
    expect((await classifyAgendaEvent(champ, ctx)).category).toBe('action');
  });
});
