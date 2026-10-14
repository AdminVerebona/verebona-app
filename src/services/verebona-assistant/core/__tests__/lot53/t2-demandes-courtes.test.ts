/**
 * Lot 53 — 53H : « T2 : faire comprendre par l'IA les demandes courtes au
 * lieu de substituer une autre information ».
 *
 * Bug de préproduction reproduit (T2-SHORT-REPRO) : « date d'achat polo »
 * répondait « Motorisation de Polo : TSI BLUEMOTION. ». Parcours : routage
 * ACCOUNT_FACT_ASSET (« donnée d'un bien ») → étape des faits SQL-first
 * ignorée (`isFieldQuestion` faux : ni « ? » ni « quelle ») → niveau 1
 * structuré ignoré (même condition) → niveau 2 : termes de recherche réduits
 * à « polo » (« date », « achat » sont des mots de question) → premier fait
 * T1 trouvé sur « polo » = la motorisation de la carte grise → valeur
 * canonique `engine` lue et rendue (`retrieval.canonical_field`).
 *
 * UNDERSTAND est SIMULÉ (aucun appel réseau) : le harnais lot 29 compte les
 * appels modèle ; le niveau 2 RÉEL (`answerFromData`) tourne sur un port de
 * données en mémoire qui contient le PIÈGE (fait « Motorisation » de la Polo).
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: { $client: { unsafe: vi.fn(async () => []) } }, ensureMigrations: vi.fn(async () => {}), ensureUnaccent: vi.fn(async () => {}),
}));

const H = await import('../lot29/harness');
const { answerFromData } = await import('../../data-answer.service');
const { deterministicRequestedFacts, fieldPhrasesOf } = await import('../../../canonical/field-vocabulary');
const { fieldRequestForm, isFieldQuestion } = await import('../../../canonical/structured-answers');
const { substitutedFieldKeys, answeredFieldKeys } = await import('../../requested-facts-guard');
const { parseCommand } = await import('../../../commands/parser');
const { toIntentRoute } = await import('../../classification.adapter');
const { catalogForT2Read, getField } = await import('@/services/canonical/registry');
const { describeFieldCatalog } = await import('@/services/ai/assistant/master/t2-understand');

type Fx = Parameters<typeof H.account>[0];
type Asset = NonNullable<NonNullable<Fx>['assets']>[number];

const ENGINE = 'TSI BLUEMOTION';
const POLO: Asset = { id: 20, name: 'Polo', category: 'VEHICULE', subtype: 'Voiture', fields: { engine: ENGINE, fuelType: 'GASOLINE', mileage: 82000, acquisitionPrice: 18500, registrationNumber: 'AB-123-CD' } };
const POLO_ACHAT: Asset = { ...POLO, fields: { ...POLO.fields, acquisitionDate: '2022-09-12' } };
const CUPRA: Asset = { id: 21, name: 'Cupra', category: 'VEHICULE', subtype: 'Voiture', fields: { engine: 'VZ 300', mileage: 45000, acquisitionPrice: 41000 } };
const MAISON: Asset = { id: 10, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison' };
const CHAUDIERE = { kind: 'equipment' as const, id: 72, assetId: 10, name: 'Chaudière', type: 'BOILER', fields: { serialNumber: 'CH-001', brand: 'Viessmann' } };

/** Ce qui ne doit JAMAIS apparaître dans une réponse sur la date d'achat de la Polo. */
const AUTRES_CHAMPS_POLO = [/Motorisation/i, new RegExp(ENGINE, 'i'), /18[\s  ]?500/, /82[\s  ]?000/, /AB-123-CD/, /Carburant|Essence/i];
const sansSubstitution = (answer: string) => { for (const re of AUTRES_CHAMPS_POLO) expect(answer).not.toMatch(re); };

/**
 * Niveau 2 RÉEL (`answerFromData`) sur un port en mémoire : chaque bien
 * nommé dans les termes renvoie son fait T1 « Motorisation » (le piège de
 * la préproduction), enrichi de la valeur canonique `engine`.
 */
function avecNiveau2(h: ReturnType<typeof H.harness>) {
  const acc = h.acc;
  const row = (a: Asset) => ({ id: a.id, name: a.name, category: a.category ?? 'VEHICULE', subtype: null, purchaseDate: null, isRented: false, matched: 1 });
  const searchFacts = vi.fn(async (_acc: number, terms: string[]) => acc.assets
    .filter((a) => a.fields?.engine && terms.some((t) => a.name.toLowerCase().includes(t.toLowerCase())))
    .map((a, i) => ({
      id: 100 + i, fileId: 500 + a.id, factKey: 'engine', subject: a.name, attribute: 'Motorisation', label: 'Motorisation',
      valueText: String(a.fields!.engine), valueNumber: null, valueUnit: null, confidence: 'certain', excerpt: `${a.name} ${a.fields!.engine}`,
      documentTitle: `Carte grise ${a.name}`, matchedTerms: 1,
      canonical: { assetId: a.id, key: 'engine', label: 'Motorisation', value: String(a.fields!.engine), origin: 'USER', originLabel: null, openConflict: null },
    })));
  const port = {
    today: () => '2026-10-13',
    findAssets: async (_a: number, words: string[]) => acc.assets.filter((a) => words.some((w) => a.name.toLowerCase().includes(w.toLowerCase()))).map(row),
    listAssets: async () => acc.assets.map(row),
    countDocuments: async () => 0, countAgenda: async () => 0, upcomingAgenda: async () => [],
    sumDocumentAmounts: async () => ({ sumCents: 0, count: 0 }),
    searchFacts, searchDocuments: async () => [],
    readAssetField: (a: number, id: number, k: string) => h.readers.field!(a, id, k),
  };
  h.ports.answerFromData = (route, input, thresholds) => answerFromData({
    port: port as never, accountId: input.accountId, message: input.message, thresholds, intent: route.intent,
    resolvedAssetId: input.resume?.assetId ?? (input.reference?.type === 'asset' ? input.reference.id : null),
  });
  return { searchFacts };
}

const lectures = (h: ReturnType<typeof H.harness>) => h.readers.calls.filter((c) => c.kind !== 'document').map((c) => c.key);

describe('53H — reproduction du bug de préproduction', () => {
  it('T2-SHORT-REPRO — le parcours exact : champ détecté par le registre, forme non interrogative', () => {
    expect(deterministicRequestedFacts("date d'achat polo")).toEqual(['acquisitionDate']);
    expect(isFieldQuestion("date d'achat polo")).toBe(false);
    expect(fieldRequestForm("date d'achat polo")).toBe('undetermined');
  });

  it('T2-SHORT-REPRO — sans UNDERSTAND disponible, plus jamais « Motorisation de Polo »', async () => {
    const h = H.harness(H.account({ assets: [POLO] }), { understand: null });
    avecNiveau2(h);
    const r = await h.ask("date d'achat polo");
    sansSubstitution(r.answer);
    expect(r.cascade?.strategy).not.toBe('retrieval.canonical_field');
    expect(lectures(h)).toEqual(['acquisitionDate']);
  });
});

describe('53H — critères d’acceptation', () => {
  it('T2-SHORT-AC01 — « date d’achat polo » → UNDERSTAND → requestedFacts = acquisitionDate → réponse sur la date d’achat seulement', async () => {
    const h = H.harness(H.account({ assets: [POLO_ACHAT, CUPRA] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionDate'], [{ type: 'asset', value: 'polo' }]),
    });
    const { searchFacts } = avecNiveau2(h);
    const r = await h.ask("date d'achat polo");
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.classify.mock.calls[0][0]).toBe("date d'achat polo");
    expect(r.answer).toBe('Vous avez acheté Polo le 12 septembre 2022.');
    sansSubstitution(r.answer);
    // Le serveur résout la cible (bien réel) et lit CE champ, rien d'autre.
    expect(h.readers.calls).toEqual([{ kind: 'asset', id: 20, key: 'acquisitionDate' }]);
    expect(searchFacts).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(r.cascade?.understanding).toMatchObject({ initialStatus: 'COMPLETE', status: 'COMPLETE', resolvedBy: 'understand' });
    expect(r.cascade?.understanding?.reasons).toContain('UNDETERMINED_FIELD_REQUEST');
    expect(r.cascade?.escalationReasons).toContain('UNDERSTANDING:REQUESTED_FACTS:acquisitionDate');
  });

  it('T2-SHORT-AC01 — un champ proposé par le modèle hors registre / non lisible n’est jamais lu', async () => {
    const h = H.harness(H.account({ assets: [POLO_ACHAT] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionDate', 'champInventé'], [{ type: 'asset', value: 'polo' }]),
    });
    avecNiveau2(h);
    const r = await h.ask("date d'achat polo");
    expect(r.answer).toContain('12 septembre 2022');
    expect(lectures(h)).toEqual(['acquisitionDate']);
  });

  it('T2-SHORT-AC02 — « kilométrage cupra » → compréhension T2 → mileage, jamais une autre caractéristique', async () => {
    const h = H.harness(H.account({ assets: [POLO, CUPRA] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['mileage'], [{ type: 'asset', value: 'cupra' }]),
    });
    avecNiveau2(h);
    const r = await h.ask('kilométrage cupra');
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(r.answer).toMatch(/^Kilométrage de Cupra : 45[\s  ]?000 km\.$/);
    expect(r.answer).not.toMatch(/VZ 300|Motorisation|41[\s  ]?000/);
    expect(h.readers.calls).toEqual([{ kind: 'asset', id: 21, key: 'mileage' }]);
  });

  it('T2-SHORT-AC03 — « numéro de série chaudière » → cible equipment + fait demandé → serialNumber de la chaudière', async () => {
    const h = H.harness(H.account({ assets: [MAISON, POLO], entities: [CHAUDIERE] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['serialNumber'], [{ type: 'equipment', value: 'chaudière' }]),
    });
    avecNiveau2(h);
    const r = await h.ask('numéro de série chaudière');
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(r.answer).toContain('CH-001');
    expect(r.answer).not.toMatch(/Viessmann|Motorisation/);
    expect(h.readers.calls).toEqual([{ kind: 'EQUIPMENT', id: 72, key: 'serialNumber' }]);
  });

  it('T2-SHORT-AC04 — date d’achat absente : absence explicite, aucune autre donnée (Motorisation, prix, année…)', async () => {
    const h = H.harness(H.account({ assets: [POLO] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionDate'], [{ type: 'asset', value: 'polo' }]),
    });
    avecNiveau2(h);
    const r = await h.ask("date d'achat polo");
    expect(r.answer).toBe('L’information « Date d’achat » n’est pas renseignée pour Polo.');
    sansSubstitution(r.answer);
    expect(r.cascade?.diagnostic).toBe('FIELD_NOT_SET');
    // Cascade documentaire CIBLÉE sur ce champ, puis rien d'autre.
    expect(h.readers.calls).toEqual([{ kind: 'asset', id: 20, key: 'acquisitionDate' }, { kind: 'document', id: 20, key: 'acquisitionDate' }]);
  });

  it('T2-SHORT-AC04 — date d’achat absente de la fiche mais prouvée par un document : cascade documentaire ciblée', async () => {
    const h = H.harness(H.account({
      assets: [POLO], docFacts: [{ assetId: 20, key: 'acquisitionDate', display: '12 septembre 2022', fileId: 9, title: 'Facture d’achat' }],
    }), { understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionDate'], [{ type: 'asset', value: 'polo' }]) });
    avecNiveau2(h);
    const r = await h.ask("date d'achat polo");
    expect(r.answer).toContain('12 septembre 2022');
    expect(r.answer).toContain('pas encore enregistré sur la fiche');
    sansSubstitution(r.answer);
  });

  it('T2-SHORT-AC04 — sans IA (compte sans IA, ou UNDERSTAND en échec) : même absence, jamais une autre donnée', async () => {
    for (const extra of [{ planType: 'FREE' }, {}] as const) {
      const h = H.harness(H.account({ assets: [POLO] }), { understand: null });
      avecNiveau2(h);
      const r = await h.ask("date d'achat polo", extra as never);
      expect(r.answer).toBe('L’information « Date d’achat » n’est pas renseignée pour Polo.');
      sansSubstitution(r.answer);
      expect(r.cascade?.escalationReasons).toContain('UNDERSTANDING:REGISTRY_FALLBACK');
    }
  });

  it('T2-SHORT-AC05 — « Mets le kilométrage de la Polo à 45 000 km » : fast-path d’écriture déterministe conservé', async () => {
    expect(fieldRequestForm('Mets le kilométrage de la Polo à 45 000 km')).toBe('command');
    expect(parseCommand('Mets le kilométrage de la Polo à 45 000 km', '2026-10-13'))
      .toMatchObject({ command: 'UPDATE_ASSET_FIELD', field: 'mileage', value: 45000, assetWords: ['polo'] });
    const h = H.harness(H.account({ assets: [POLO] }), { understand: H.understood('ACCOUNT_FACT_ASSET', ['mileage']) });
    const prepareCommand = vi.fn(async (input: { message: string }) => (parseCommand(input.message, '2026-10-13')
      ? { kind: 'plan' as const, preview: { planId: 'p1', summary: 'Mettre le kilométrage de Polo à 45 000 km.' } } : null));
    h.ports.prepareCommand = prepareCommand as never;
    const r = await h.ask('Mets le kilométrage de la Polo à 45 000 km');
    expect(prepareCommand).toHaveBeenCalledTimes(1);
    expect(r.commandPlan).toMatchObject({ planId: 'p1' });
    expect(r.answer).toBe('Mettre le kilométrage de Polo à 45 000 km.');
    expect(h.llmCalls()).toBe(0);
    expect(h.readers.calls).toEqual([]);
    // Une commande n'est jamais traitée comme une demande de lecture incomplète.
    const h2 = H.harness(H.account({ assets: [POLO] }), { understand: H.understood('ACCOUNT_FACT_ASSET', ['mileage']) });
    const r2 = await h2.ask('Mets le kilométrage de la Polo à 45 000 km');
    expect(r2.cascade?.escalationReasons ?? []).not.toContain('UNDERSTANDING:UNDETERMINED_FIELD_REQUEST');
  });

  it('T2-SHORT-AC06 — « Quelle est la date d’achat de la Polo ? » : parcours déterministe, 0 appel modèle', async () => {
    const h = H.harness(H.account({ assets: [POLO_ACHAT] }), { understand: H.understood('ACCOUNT_FACT_ASSET', ['engine']) });
    avecNiveau2(h);
    const r = await h.ask('Quelle est la date d’achat de la Polo ?');
    expect(fieldRequestForm('Quelle est la date d’achat de la Polo ?')).toBe('question');
    expect(r.answer).toBe('Vous avez acheté Polo le 12 septembre 2022.');
    expect(h.llmCalls()).toBe(0);
    expect(r.cascade?.aiCalls).toBe(0);
    expect(h.readers.calls).toEqual([{ kind: 'asset', id: 20, key: 'acquisitionDate' }]);
  });

  it('T2-SHORT-AC07 — « date polo » (ambiguë) : aucun champ choisi par le registre ni par le niveau 2', async () => {
    expect(deterministicRequestedFacts('date polo')).toEqual([]);
    const ambigu = { ...toIntentRoute({ intent: 'ACCOUNT_FACT_ASSET', confidence: 'ambiguous', entityHints: [{ type: 'asset', value: 'polo' }] as never, reason: 't' }, 'PREMIUM'), understanding: { requestedFacts: [], filters: {} } };
    const h = H.harness(H.account({ assets: [POLO] }), { understand: ambigu });
    const { searchFacts } = avecNiveau2(h);
    const r = await h.ask('date polo');
    sansSubstitution(r.answer);
    expect(searchFacts).not.toHaveBeenCalled();
    expect(h.classify).toHaveBeenCalledTimes(1);
    // UNDERSTAND ambigu : clarification (choix d'intention), jamais une valeur.
    expect(h.saveClarification).toHaveBeenCalledTimes(1);
    expect(r.clarification).not.toBeNull();
    expect(lectures(h)).toEqual([]);
  });

  it('T2-SHORT-AC07 — « date polo » sans IA, ou compris sans champ : jamais une caractéristique prise au hasard', async () => {
    for (const understand of [null, H.understood('ACCOUNT_FACT_ASSET', [], [{ type: 'asset', value: 'polo' }])]) {
      const h = H.harness(H.account({ assets: [POLO] }), { understand });
      avecNiveau2(h);
      const r = await h.ask('date polo');
      sansSubstitution(r.answer);
      expect(lectures(h)).not.toContain('engine');
    }
  });

  it('T2-SHORT-AC07 — compris par UNDERSTAND comme un champ précis : lecture de CE champ seulement', async () => {
    const h = H.harness(H.account({ assets: [POLO_ACHAT] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionDate'], [{ type: 'asset', value: 'polo' }]),
    });
    avecNiveau2(h);
    const r = await h.ask('date polo');
    expect(r.answer).toBe('Vous avez acheté Polo le 12 septembre 2022.');
    expect(lectures(h)).toEqual(['acquisitionDate']);
  });

  it('T2-SHORT-AC08 — aucun mapping lexical ajouté : vocabulaire des champs figé (empreinte lot 52)', () => {
    // Empreinte de TOUTES les formulations reconnues par le matcher
    // déterministe (registre `assistantPhrases` + libellés + pluriels) : un
    // ajout (« date achat », « km », « moteur »…) la change.
    const lignes = catalogForT2Read().fields.flatMap((f) => fieldPhrasesOf(getField(f.key)!).map((p) => `${f.key}:${p}`)).sort();
    expect(lignes).toHaveLength(241);
    expect(createHash('sha256').update(lignes.join('\n')).digest('hex')).toBe('9fd6c942c3d925ea2dfaa775dface57cebcd5be0e228f19134792d3377f275ea');
    // FIELD_CATALOG transmis à UNDERSTAND (catalogue de capacités) : inchangé, prompt non modifié.
    expect(createHash('sha256').update(describeFieldCatalog()).digest('hex')).toBe('ea5f3a8af2385094bad17c262cae986a5dba3c2d7553fe8fa9443b93ba6a0edd');
    // Les formulations du ticket ne sont PAS devenues des règles déterministes.
    for (const m of ['km polo', 'moteur cupra', 'date polo', 'assurance maison']) expect(deterministicRequestedFacts(m)).toEqual([]);
    // La forme d'une demande reste décidée par les SEULS motifs du lot 52.
    const formes: Array<[string, string]> = [
      ['Quelle est la date d’achat de la Polo ?', 'question'], ['date d’achat polo', 'undetermined'], ['kilométrage cupra', 'undetermined'],
      ['Mets le kilométrage de la Polo à 45 000 km', 'command'], ['combien de documents pour la polo', 'count'],
      ['quand ai-je acheté la polo', 'question'], ['donne le kilométrage de la polo', 'question'], ['kilométrage de la polo stp', 'undetermined'],
    ];
    for (const [m, f] of formes) expect([m, fieldRequestForm(m)]).toEqual([m, f]);
  });

  it('T2-SHORT-AC09 — garde-fou (pur) : une réponse exclusivement sur un autre champ est substituée', () => {
    const engine = [{ claimKey: 'field:engine', sourceIds: ['asset_field:20:engine'] }];
    expect(answeredFieldKeys(engine)).toEqual(['engine']);
    expect(substitutedFieldKeys(['acquisitionDate'], engine)).toEqual(['engine']);
    for (const k of ['fuelType', 'mileage', 'registrationNumber', 'acquisitionPrice']) {
      expect(substitutedFieldKeys(['acquisitionDate'], [{ claimKey: 'answer', sourceIds: [`asset_field:20:${k}`] }])).toEqual([k]);
    }
    expect(substitutedFieldKeys(['acquisitionDate'], [{ claimKey: 'field:acquisitionDate', sourceIds: ['asset_field:20:acquisitionDate'] }])).toEqual([]);
    // Composants d'une valeur composée (adresse complète) : fidèles.
    expect(substitutedFieldKeys(['address1'], [{ claimKey: 'field:address1', sourceIds: ['asset_field:10:address1', 'asset_field:10:postalCode'] }])).toEqual([]);
    // Aucun fait exigé, ou réponse sans champ : non concernée.
    expect(substitutedFieldKeys([], engine)).toEqual([]);
    expect(substitutedFieldKeys(['acquisitionDate'], [{ claimKey: 'document', sourceIds: ['doc_5'] }])).toEqual([]);
  });

  it('T2-SHORT-AC09 — orchestrateur : réponse de données sur un autre champ rejetée, remplacée par l’absence', async () => {
    const h = H.harness(H.account({ assets: [POLO] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionDate'], [{ type: 'asset', value: 'polo' }]),
    });
    // Lecture ciblée impossible au premier passage (cible non lue) : la
    // cascade continue, et une étape plus large produit « Motorisation ».
    let n = 0;
    const lire = h.ports.readTarget!;
    h.ports.readTarget = async (...a) => (n++ === 0 ? null : lire(...a));
    h.ports.answerFromData = async () => ({
      handled: true, answer: `Motorisation de Polo : ${ENGINE}.`,
      sources: [{ id: 'asset_field:20:engine', type: 'asset_field', title: 'Motorisation — Polo', content: ENGINE, relevanceScore: 1 }],
      claims: [{ claimKey: 'field:engine', text: `Motorisation de Polo : ${ENGINE}.`, sourceIds: ['asset_field:20:engine'], derivation: 'direct' }],
      decision: { status: 'SUFFICIENT_STRUCTURED', level: 2, score: 1, threshold: 0.6 }, strategy: 'retrieval.canonical_field', attempts: [], contextSources: [],
    }) as never;
    const r = await h.ask("date d'achat polo");
    sansSubstitution(r.answer);
    expect(r.answer).toBe('L’information « Date d’achat » n’est pas renseignée pour Polo.');
    expect(r.cascade?.escalationReasons).toContain('FIDELITY:REJECTED_OTHER_FIELD:retrieval.canonical_field:engine');
  });

  it('T2-SHORT-AC09 — orchestrateur : résultats de recherche ou réponse rédigée sur un autre champ rejetés (absence explicite sans cible)', async () => {
    const h = H.harness(H.account({ assets: [POLO] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionDate']),
      retrieved: [{ id: 'asset_field:20:engine', type: 'asset_field', title: 'Motorisation — Polo', content: ENGINE, relevanceScore: 0.9, meta: { assetId: 20 } }],
    });
    h.ports.readTarget = async () => null;
    h.generate.mockResolvedValue({
      answer: `Motorisation de Polo : ${ENGINE}.`, actions: [], supportLevel: 'supported',
      claims: [{ claimKey: 'c1', text: 'Motorisation', sourceIds: ['asset_field:20:engine'], derivation: 'direct' }],
    } as never);
    // Résultats de recherche (cartes) : la carte « Motorisation » ne répond pas.
    const r = await h.ask("date d'achat polo");
    sansSubstitution(r.answer);
    expect(r.cascade?.escalationReasons.some((x) => /^FIDELITY:REJECTED_OTHER_FIELD:(retrieval\.adapters|fallback\.sources):engine$/.test(x))).toBe(true);
    expect(r.answer).toBe('Je n’ai pas trouvé l’information demandée (date d’achat).');
    // Réponse RÉDIGÉE par le modèle (cartes trop peu pertinentes : génération) : même rejet.
    const h2 = H.harness(H.account({ assets: [POLO] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionDate']),
      retrieved: [{ id: 'asset_field:20:engine', type: 'asset_field', title: 'Motorisation — Polo', content: ENGINE, relevanceScore: 0.2, meta: { assetId: 20 } }],
    });
    h2.ports.readTarget = async () => null;
    // Route rendue éligible à la rédaction (le registre ne l'autorise pas pour ce fait).
    h2.classify.mockResolvedValue({ ...H.understood('ACCOUNT_FACT_ASSET', ['acquisitionDate']), aiEligible: true });
    h2.generate.mockResolvedValue({
      answer: `Motorisation de Polo : ${ENGINE}.`, actions: [], supportLevel: 'supported',
      claims: [{ claimKey: 'c1', text: 'Motorisation', sourceIds: ['asset_field:20:engine'], derivation: 'direct' }],
    } as never);
    const r2 = await h2.ask("date d'achat polo");
    expect(h2.generate).toHaveBeenCalledTimes(1);
    sansSubstitution(r2.answer);
    expect(r2.cascade?.escalationReasons).toContain('FIDELITY:REJECTED_OTHER_FIELD:llm.generate_answer:engine');
    expect(r2.answer).toBe('Je n’ai pas trouvé l’information demandée (date d’achat).');
  });
});
