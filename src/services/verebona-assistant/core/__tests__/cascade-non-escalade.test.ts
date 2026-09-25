/**
 * T2 — cascade de non-escalade (critères de recette du ticket).
 *
 *   Niveau 1 — données structurées / calcul déterministe
 *   Niveau 2 — données T1 / recherche interne
 *   Niveau 3 — LLM, seulement après insuffisance constatée, avec motif
 *
 * Les tests passent par `runAssistant` (orchestrateur réel) et
 * `answerFromData` (moteur réel), avec un port de données simulé : aucune
 * base, aucun modèle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../source-availability.service', () => ({
  marquerDisponibilite: async (s: unknown) => s,
}));

const { runAssistant } = await import('../assistant-orchestrator.service');
const { answerFromData } = await import('../data-answer.service');
import type { OrchestratorPorts } from '../assistant-orchestrator.service';
import type { AccountDataPort, AssetRow, FactHit, DocumentHit, AgendaRow } from '../data-answer.service';
import type { AssistantRequestInput } from '../../types/contracts';

// ── Données du compte simulées ─────────────────────────────────────────────

const ASSETS: AssetRow[] = [
  { id: 1, name: 'Appartement Lyon', category: 'IMMOBILIER', subtype: 'Appartement', purchaseDate: '2019-06-01', isRented: true },
  { id: 2, name: 'Maison Caen', category: 'IMMOBILIER', subtype: 'Maison', purchaseDate: null, isRented: false },
  { id: 3, name: 'Clio', category: 'VEHICULE', subtype: 'Voiture', purchaseDate: '2021-03-15', isRented: false },
];
let AGENDA: AgendaRow[] = [];
let FACTS: FactHit[] = [];
let DOCS: DocumentHit[] = [];

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const port: AccountDataPort = {
  today: () => '2026-09-25',
  async findAssets(_a, words) {
    return ASSETS.map((a) => ({
      ...a,
      matched: words.reduce((n, w) => n + (plain(a.name).includes(w) || plain(a.subtype ?? '') === w ? 2 : 0), 0),
    })).filter((a) => a.matched! > 0);
  },
  async listAssets(_a, o = {}) {
    return ASSETS.filter((a) => (!o.family || a.category === o.family) && (o.rented === undefined || a.isRented === o.rented));
  },
  async countDocuments(_a, o = {}) {
    if (!o.assetIds?.length) return 84;
    return o.assetIds.includes(1) ? 37 : 5;
  },
  async countAgenda() { return AGENDA.length; },
  async upcomingAgenda(_a, o = {}) {
    const t = o.terms ?? [];
    return AGENDA.filter((r) => t.every((w) => plain(r.title).includes(w))).slice(0, o.limit ?? 3);
  },
  async sumDocumentAmounts() { return { sumCents: 489000, count: 3 }; },
  async searchFacts(_a, terms) {
    return FACTS.map((f) => ({
      ...f,
      matchedTerms: terms.filter((t) => plain(`${f.factKey} ${f.subject} ${f.attribute} ${f.valueText}`).includes(t)).length,
    })).filter((f) => f.matchedTerms > 0);
  },
  async searchDocuments(_a, terms) {
    return DOCS.map((d) => ({ ...d, matchedTerms: terms.filter((t) => plain(`${d.title} ${d.snippet ?? ''}`).includes(t)).length }))
      .filter((d) => d.matchedTerms > 0);
  },
};

// ── Ports de l'orchestrateur ───────────────────────────────────────────────

function ports(over: Partial<OrchestratorPorts> = {}) {
  const generateWithAI = vi.fn(async () => ({
    answer: 'Réponse rédigée par le modèle.', claims: [], actions: [], supportLevel: 'supported' as const, model: 'gemini-test',
  }));
  const classifyWithAI = vi.fn(async () => null);
  const persist = vi.fn(async () => {});
  const p: OrchestratorPorts = {
    retrieve: vi.fn(async () => []),
    resolveSources: async (s) => s.map((x) => ({ id: x.id, type: x.type, typeLabel: x.type, title: x.title, excerpt: x.content, isAvailable: true })),
    resolveActions: async () => [],
    persist,
    hasPendingClarification: async () => false,
    classifyWithAI,
    generateWithAI,
    answerFromData: (route, input, thresholds) =>
      answerFromData({ port, accountId: input.accountId, message: input.message, thresholds, intent: route.intent }),
    loadThresholds: async () => ({ database: 0.5, text: 0.6, source: 'test' }),
    ...over,
  };
  return { p, generateWithAI, classifyWithAI, persist };
}

const ask = (message: string, planType = 'PREMIUM'): AssistantRequestInput => ({
  accountId: 1, userId: 1, planType, message, clientRequestId: 'c', locale: 'fr-FR',
});

beforeEach(() => {
  AGENDA = [
    { id: 11, title: 'Renouvellement assurance habitation', date: '2026-11-14', assetNames: ['Appartement Lyon'] },
    { id: 12, title: 'Contrôle technique Clio', date: '2027-01-10', assetNames: ['Clio'] },
  ];
  FACTS = [
    { id: 1, fileId: 7, factKey: 'boilerPower', subject: 'Chaudière', attribute: 'puissance', label: null, valueText: '24', valueNumber: 24, valueUnit: 'kW', confidence: 'certain', excerpt: 'Puissance nominale : 24 kW', documentTitle: 'Facture remplacement chaudière', matchedTerms: 0 },
    { id: 2, fileId: 7, factKey: 'boiler.serialNumber', subject: 'boiler', attribute: 'serialNumber', label: 'Numéro de série', valueText: '7723001', valueNumber: 7723001, valueUnit: null, confidence: 'certain', excerpt: 'N° de série 7723001', documentTitle: 'Facture remplacement chaudière', matchedTerms: 0 },
  ];
  DOCS = [
    { fileId: 7, title: 'Facture remplacement chaudière', date: '2026-03-14', assetName: 'Maison Caen', matchedTerms: 0 },
    { fileId: 8, title: 'Contrat assurance habitation', date: '2025-11-14', assetName: 'Appartement Lyon', matchedTerms: 0 },
  ];
});

// ── Critères de recette ────────────────────────────────────────────────────

describe('niveau 1 — données structurées, 0 appel IA', () => {
  it('date stockée : échéance de l’assurance habitation', async () => {
    const { p, generateWithAI } = ports();
    const r = await runAssistant(ask('Quelle est la date d’échéance de mon assurance habitation ?'), p);
    expect(r.answer).toContain('14 novembre 2026');
    expect(r.cascade?.aiCalls).toBe(0);
    expect(r.cascade?.answeredBy).toBe('structured');
    expect(generateWithAI).not.toHaveBeenCalled();
  });

  it('nombre de documents d’un bien, calculé par le code', async () => {
    const { p } = ports();
    const r = await runAssistant(ask('Combien ai-je de documents liés à mon appartement ?'), p);
    expect(r.answer).toBe('Vous avez 37 documents liés à Appartement Lyon.');
    expect(r.cascade?.aiCalls).toBe(0);
    expect(r.cascade?.strategy).toBe('structured.count_documents');
  });

  it('nombre total de documents', async () => {
    const { p } = ports();
    expect((await runAssistant(ask('Combien ai-je de documents ?'), p)).answer).toBe('Vous avez 84 documents.');
  });

  it('prochaine échéance : tri des dates sur l’agenda', async () => {
    const { p, generateWithAI } = ports();
    const r = await runAssistant(ask('Quelle est ma prochaine échéance ?'), p);
    expect(r.answer).toContain('Renouvellement assurance habitation');
    expect(r.answer).toContain('14 novembre 2026');
    expect(r.answer).toContain('dans 50 jours');
    expect(r.cascade?.aiCalls).toBe(0);
    expect(generateWithAI).not.toHaveBeenCalled();
  });

  it('date d’achat de la voiture (champ exact)', async () => {
    const { p } = ports();
    const r = await runAssistant(ask('Quelle est la date d’achat de ma voiture ?'), p);
    expect(r.answer).toBe('Vous avez acheté Clio le 15 mars 2021.');
    expect(r.cascade?.aiCalls).toBe(0);
  });

  it('liste des biens mis en location', async () => {
    const { p } = ports();
    const r = await runAssistant(ask('Quels sont mes biens mis en location ?'), p);
    expect(r.answer).toBe('Vous avez 1 bien mis en location : Appartement Lyon.');
  });

  it('absence de résultat : réponse déterministe, pas de modèle', async () => {
    AGENDA = [];
    const { p, generateWithAI } = ports();
    const r = await runAssistant(ask('Quelle est ma prochaine échéance ?'), p);
    expect(r.answer).toBe('Je n’ai trouvé aucune échéance à venir.');
    expect(generateWithAI).not.toHaveBeenCalled();
  });

  it('bien désigné mais introuvable : jamais de réponse à l’échelle du compte', async () => {
    const { p } = ports();
    const r = await runAssistant(ask('Combien ai-je de documents pour ma Twingo ?'), p);
    expect(r.answer).not.toBe('Vous avez 84 documents.');
    expect(r.cascade?.strategy).not.toBe('structured.count_documents');
    const s = await runAssistant(ask('Combien ai-je dépensé pour le chalet en 2025 ?'), p);
    expect(s.cascade?.strategy).not.toBe('structured.sum_amounts');
  });
});

describe('niveau 2 — données T1, 0 appel IA si suffisant', () => {
  it('fait extrait par T1 et non projeté : puissance de la chaudière', async () => {
    const { p, generateWithAI, classifyWithAI } = ports();
    const r = await runAssistant(ask('Quelle est la puissance de ma chaudière ?'), p);
    expect(r.answer).toContain('24 kW');
    expect(r.answer).toContain('Facture remplacement chaudière');
    expect(r.cascade?.answeredBy).toBe('retrieval');
    expect(r.cascade?.aiCalls).toBe(0);
    // Pas même la classification : les niveaux gratuits passent avant.
    expect(classifyWithAI).not.toHaveBeenCalled();
    expect(generateWithAI).not.toHaveBeenCalled();
  });

  it('recherche textuelle clairement suffisante : le document est rendu sans génération', async () => {
    const { p, generateWithAI } = ports();
    const r = await runAssistant(ask('Retrouve la facture de remplacement de ma chaudière.'), p);
    expect(r.answer).toContain('« Facture remplacement chaudière »');
    expect(r.sources[0]?.id).toBe('doc_7');
    expect(generateWithAI).not.toHaveBeenCalled();
  });

  it('valeurs contradictoires : conflit signalé, aucune valeur choisie', async () => {
    FACTS.push({ ...FACTS[0], id: 3, fileId: 9, valueText: '28', valueNumber: 28, documentTitle: 'Notice chaudière' });
    const { p, generateWithAI } = ports();
    const r = await runAssistant(ask('Quelle est la puissance de ma chaudière ?'), p);
    expect(r.answer).toMatch(/deux valeurs différentes/);
    expect(r.answer).toContain('24 kW');
    expect(r.answer).toContain('28 kW');
    expect(r.cascade?.sufficiency).toBe('CONFLICTING');
    expect(generateWithAI).not.toHaveBeenCalled();
  });

  it('cinq sources identiques confirment la même donnée : réponse directe', async () => {
    for (let i = 0; i < 4; i++) FACTS.push({ ...FACTS[0], id: 10 + i, fileId: 20 + i, confidence: 'probable' });
    FACTS[0].confidence = 'probable';
    const { p } = ports();
    const r = await runAssistant(ask('Quelle est la puissance de ma chaudière ?'), p);
    expect(r.cascade?.answeredBy).toBe('retrieval');
    expect(r.answer).toContain('24 kW');
  });
});

describe('niveau 3 — modèle seulement après insuffisance, avec motif', () => {
  it('une vraie synthèse escalade vers le modèle', async () => {
    const retrieve = vi.fn(async () => [{ id: 'doc_7', type: 'document' as const, title: 'Facture', content: 'Entretien 2024', relevanceScore: 0.7 }]);
    const { p, generateWithAI } = ports({ retrieve });
    const r = await runAssistant(ask('Explique-moi l’évolution des dépenses d’entretien de cette maison sur les trois dernières années.'), p);
    expect(generateWithAI).toHaveBeenCalledTimes(1);
    expect(r.mode).toBe('ai');
    expect(r.cascade?.answeredBy).toBe('llm');
    expect(r.cascade?.model).toBe('gemini-test');
    expect(r.cascade?.escalationReasons.some((m) => m.includes('SYNTHESIS_REQUIRED'))).toBe(true);
  });

  it('chaque escalade porte un motif explicite', async () => {
    const retrieve = vi.fn(async () => [{ id: 'doc_7', type: 'document' as const, title: 'Facture', content: 'x', relevanceScore: 0.7 }]);
    const { p } = ports({ retrieve });
    const r = await runAssistant(ask('Analyse la tendance de mes dépenses'), p);
    expect(r.cascade?.escalationReasons.length).toBeGreaterThan(0);
    for (const a of r.cascade!.attempts.filter((x) => x.status === 'INSUFFICIENT')) expect(a.reason).toBeTruthy();
  });

  it('un seuil de gouvernance à 1 force l’escalade (les seuils participent à la décision)', async () => {
    const retrieve = vi.fn(async () => [{ id: 'doc_7', type: 'document' as const, title: 'Facture', content: 'x', relevanceScore: 0.9 }]);
    // Classification IA simulée : la question ne correspond à aucune règle.
    const classifyWithAI = vi.fn(async () => ({
      intent: 'UNKNOWN' as const, confidence: 'probable' as const, accountScope: 'server-enforced', entityHints: [],
      requiresRetrieval: true, aiEligible: true, clarificationRequired: false, allowedActionTypes: [], routeReason: 'test',
    }));
    const { p, generateWithAI } = ports({ retrieve, classifyWithAI, loadThresholds: async () => ({ database: 1, text: 1, source: 'governance' }) });
    const r = await runAssistant(ask('Quelle est la puissance de ma chaudière ?'), p);
    expect(r.cascade?.attempts.some((a) => a.reason === 'THRESHOLD_FORCES_ESCALATION')).toBe(true);
    expect(r.cascade?.thresholds.source).toBe('governance');
    expect(generateWithAI).toHaveBeenCalled();
  });
});

describe('aiEligible n’impose jamais un appel IA', () => {
  it('plan éligible + réponse exacte disponible : aucun appel', async () => {
    const { p, generateWithAI, classifyWithAI } = ports();
    const r = await runAssistant(ask('Combien ai-je de documents ?', 'PREMIUM_DUO'), p);
    expect(r.cascade?.aiCalls).toBe(0);
    expect(generateWithAI).not.toHaveBeenCalled();
    expect(classifyWithAI).not.toHaveBeenCalled();
  });
});

describe('IA totalement indisponible', () => {
  it('les mêmes réponses déterministes sont produites', async () => {
    const questions = [
      'Quelle est la date d’échéance de mon assurance habitation ?',
      'Combien ai-je de documents liés à mon appartement ?',
      'Quelle est ma prochaine échéance ?',
      'Quelle est la puissance de ma chaudière ?',
    ];
    for (const q of questions) {
      const avec = await runAssistant(ask(q), ports().p);
      const sans = await runAssistant(ask(q, 'STANDARD'), ports({ generateWithAI: undefined, classifyWithAI: undefined }).p);
      expect(sans.answer).toBe(avec.answer);
      expect(sans.cascade?.aiCalls).toBe(0);
    }
  });
});

describe('traçabilité', () => {
  it('la trace est persistée avec la réponse', async () => {
    const { p, persist } = ports();
    await runAssistant(ask('Combien ai-je de documents ?'), p);
    const persisted = (persist.mock.calls as unknown as unknown[][])[0][0] as { cascade: { intent: string; strategy: string; aiCalls: number; sufficiency: string } };
    expect(persisted.cascade).toMatchObject({ aiCalls: 0, strategy: 'structured.count_documents', sufficiency: 'SUFFICIENT_STRUCTURED' });
    expect(persisted.cascade.intent).toBeTruthy();
  });
});
