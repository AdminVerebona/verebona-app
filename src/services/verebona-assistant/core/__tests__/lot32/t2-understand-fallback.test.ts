/**
 * Lot 32 — T2 : UNDERSTAND, fallback général de compréhension après le
 * déterministe. Tests A à I du ticket (T2U-A … T2U-I), critères
 * d'acceptation (T2U-ACxx) et non-régression du lot 29 (SQL-first, 0 appel
 * LLM).
 *
 * Harnais du lot 29 : compte en mémoire, orchestrateur RÉEL, lectures et
 * résolution des cibles avec les MÊMES règles que la production
 * (disponibilité unique, bornage au compte), COMPTEUR d'appels modèle
 * (UNDERSTAND + ANSWER) et `cascade.aiCalls`.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({
  pgClient: { unsafe: vi.fn(async () => []) },
  db: { $client: { unsafe: vi.fn(async () => []) } }, ensureMigrations: vi.fn(async () => {}), ensureUnaccent: vi.fn(async () => {}),
}));

const H = await import('../lot29/harness');
const { routeDeterministic } = await import('../../intent-router.service');
const { targetsFromInput } = await import('../../assistant-targets');
const { assessUnderstanding, targetRequirement, threadAssetCandidates } = await import('../../understanding-status');
const { toIntentRoute } = await import('../../classification.adapter');
const { diagnosticMessage } = await import('../../t2-diagnostics');
import type { AssistantRequestInput, IntentRoute } from '../../../types/contracts';
import type { ThreadContext } from '../../reference-resolver';
import type { RetrievedSource } from '../../../types/sources';

const MAISON = { id: 10, name: 'Maison de Bourg', category: 'IMMOBILIER', subtype: 'Maison', city: 'Bourg-en-Bresse',
  fields: { address1: '12 rue des Lilas', postalCode: '01000', city: 'Bourg-en-Bresse' } };
const POLO = { id: 20, name: 'Polo', category: 'VEHICULE', subtype: 'Voiture', fields: { mileage: 82000 } };
const CUPRA = { id: 21, name: 'Cupra', category: 'VEHICULE', subtype: 'Voiture', fields: { mileage: 15000 } };
const ARCHIVEE = { id: 22, name: 'Clio', category: 'VEHICULE', subtype: 'Voiture', status: 'ARCHIVED' };

const RIEN_TROUVE = /rien trouvé|aucun résultat/i;

/** Appels modèle : compteur du client simulé ET trace de l'orchestrateur. */
const llm = (h: { llmCalls(): number }, r: { cascade?: { aiCalls: number } }, n: number) => {
  expect(h.llmCalls()).toBe(n);
  expect(r.cascade?.aiCalls).toBe(n);
};

/** Bien ciblé par la recherche réellement exécutée (entrée transmise au port `retrieve`). */
const bienRecherche = (h: { retrieve: ReturnType<typeof vi.fn> }): number | null => {
  const input = h.retrieve.mock.calls[0]?.[1] as AssistantRequestInput | undefined;
  return input ? targetsFromInput(input).asset?.id ?? null : null;
};

const fil = (p: Partial<ThreadContext>): ThreadContext => ({
  conversationId: 99, messages: [], presentedLists: [], lastPresentedEntities: [], lastSelected: null,
  currentAssetId: null, currentDocumentId: null, pendingClarification: null, ...p,
});

const ambigu = (intent: string, hints: Array<{ type: string; value: string }> = []): IntentRoute => ({
  ...toIntentRoute({ intent, confidence: 'ambiguous', entityHints: hints as never, reason: 'cible non identifiable de façon unique' }, 'PREMIUM'),
  understanding: { requestedFacts: [], filters: {} },
});

const doc = (id: number, title: string): RetrievedSource => ({ id: `doc_${id}`, type: 'document', title, content: title, relevanceScore: 0.9, meta: { fileId: id } });

describe('Lot 32 — état de compréhension (pur)', () => {
  it('T2U-AC01 — statut explicite : COMPLETE, PARTIAL (motifs), UNKNOWN_INTENT', () => {
    expect(assessUnderstanding({ needsClassification: false, intent: 'ACCOUNT_SEARCH_DOCUMENT', message: 'Quels documents ai-je ?', targetResolved: false }))
      .toMatchObject({ status: 'COMPLETE', reasons: [], requirement: null });
    expect(assessUnderstanding({ needsClassification: false, intent: 'ACCOUNT_SEARCH_DOCUMENT', message: 'Quels documents sont liés à ce bien ?', targetResolved: false }))
      .toMatchObject({ status: 'PARTIAL', reasons: ['MISSING_TARGET'], exactGap: true });
    expect(assessUnderstanding({ needsClassification: false, intent: 'ACCOUNT_SEARCH_DOCUMENT', message: 'Quels documents lui sont liés ?', targetResolved: false, targetCandidates: 2 }))
      .toMatchObject({ status: 'PARTIAL', reasons: ['AMBIGUOUS_TARGET'], exactGap: true });
    expect(assessUnderstanding({ needsClassification: false, intent: 'ACCOUNT_SEARCH_DOCUMENT', message: 'Et les documents qui concernent l’autre ?', targetResolved: false, targetCandidates: 2 }))
      .toMatchObject({ status: 'PARTIAL', reasons: ['UNRESOLVED_REFERENCE'], exactGap: false });
    expect(assessUnderstanding({ needsClassification: false, intent: 'ACCOUNT_FACT_ASSET', message: 'Quand ai-je acheté la Polo et combien ?', targetResolved: true, unconsumed: ['combien'] }))
      .toMatchObject({ status: 'PARTIAL', reasons: ['UNCONSUMED_MEANING'], exactGap: false });
    expect(assessUnderstanding({ needsClassification: true, intent: 'UNKNOWN', message: 'Je voudrais y voir plus clair', targetResolved: false }))
      .toMatchObject({ status: 'UNKNOWN_INTENT', reasons: ['UNKNOWN_INTENT'], exactGap: false });
    // Une cible exigée RÉSOLUE (page, fil, nom…) : complète.
    expect(assessUnderstanding({ needsClassification: false, intent: 'ACCOUNT_SEARCH_DOCUMENT', message: 'Quels documents sont liés à ce bien ?', targetResolved: true }).status).toBe('COMPLETE');
  });

  it('T2U-AC02 — cible exigée : désignation sans nom (« ce bien », « lui », « ses ») vs recherche globale ou nom explicite', () => {
    expect(targetRequirement('Quels documents sont liés à ce bien ?')).toMatchObject({ kind: 'deictic' });
    expect(targetRequirement('Quels documents lui sont liés ?')).toMatchObject({ kind: 'deictic' });
    expect(targetRequirement('Montre-moi ses factures')).toMatchObject({ kind: 'deictic' });
    expect(targetRequirement('Et ceux qui concernent l’autre ?')).toMatchObject({ kind: 'anaphoric', detected: "l'autre" });
    expect(targetRequirement('Quels documents ai-je ?')).toBeNull();
    expect(targetRequirement('Quels documents sont liés à la Polo ?')).toBeNull();
    expect(targetRequirement('Quelle est l’adresse de la maison ?')).toBeNull();
  });

  it('T2U-AC03 — candidats du fil : référence ambiguë, dernière liste, dernier échange ; biens disponibles seulement', () => {
    const catalog = [POLO, CUPRA];
    expect(threadAssetCandidates({ ambiguous: [{ type: 'asset', id: 20 }, { type: 'document', id: 5 }, { type: 'asset', id: 21 }], catalog }).map((a) => a.id)).toEqual([20, 21]);
    expect(threadAssetCandidates({ presentedLists: [[{ type: 'asset', id: 21 }]], catalog }).map((a) => a.id)).toEqual([21]);
    expect(threadAssetCandidates({ messages: [{ content: 'Parle-moi de la Cupra' }, { content: 'Compare la Polo et la Cupra' }, { content: 'Voici la comparaison.' }], catalog }).map((a) => a.id)).toEqual([20, 21]);
    // Un bien indisponible (hors catalogue) n'est jamais candidat.
    expect(threadAssetCandidates({ presentedLists: [[{ type: 'asset', id: 22 }]], catalog })).toEqual([]);
  });
});

describe('Lot 32 — tests A à I du ticket', () => {
  it('T2U-A — intention inconnue : needs_classification → t2_understand appelé → pipeline poursuivi avec l’intention rendue', async () => {
    const q = 'Je voudrais y voir plus clair avec tout ça';
    expect(routeDeterministic({ message: q, planType: 'PREMIUM', hasPendingClarification: false }).kind).toBe('needs_classification');
    const h = H.harness(H.account({ assets: [MAISON, POLO] }), {
      understand: H.understood('ACCOUNT_SUMMARY', []), retrieved: [doc(1, 'Facture entretien Polo')], generated: 'Voici le point sur vos biens.',
    });
    const r = await h.ask(q);
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(r.route.intent).toBe('ACCOUNT_SUMMARY');
    expect(h.retrieve).toHaveBeenCalledTimes(1);
    expect(r.answer).toBe('Voici le point sur vos biens.');
    expect(r.cascade?.understanding).toMatchObject({ initialStatus: 'UNKNOWN_INTENT', status: 'COMPLETE', resolvedBy: 'understand' });
    llm(h, r, 2); // UNDERSTAND + ANSWER (rédaction de la synthèse)
  });

  it('T2U-B — intention inconnue + IA ambiguë : aucune intention inventée → clarification ; IA en échec ou indisponible → repli prudent', async () => {
    const q = 'Je voudrais y voir plus clair avec tout ça';
    const h = H.harness(H.account({ assets: [MAISON, POLO] }), { understand: ambigu('ACCOUNT_SUMMARY'), retrieved: [doc(1, 'X')], generated: 'inventé' });
    const r = await h.ask(q);
    expect(r.clarification?.ambiguity?.reason).toBe('CLASSIFICATION_AMBIGUOUS');
    expect(h.retrieve).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(r.cascade?.understanding).toMatchObject({ status: 'UNKNOWN_INTENT', reasons: expect.arrayContaining(['AMBIGUOUS_INTENT']) });
    llm(h, r, 1);

    const echec = H.harness(H.account({ assets: [MAISON] }), { understand: null });
    const r2 = await echec.ask(q);
    expect(r2.answer).toBe(diagnosticMessage('UNDERSTANDING_FAILED'));
    expect(r2.cascade?.diagnostic).toBe('UNDERSTANDING_FAILED');
    expect(r2.answer).not.toMatch(RIEN_TROUVE);

    const standard = H.harness(H.account({ assets: [MAISON] }), { understand: H.understood('ACCOUNT_SUMMARY', []) });
    const r3 = await standard.ask(q, { planType: 'STANDARD' });
    expect(standard.classify).not.toHaveBeenCalled();
    expect(r3.route.intent).toBe('UNKNOWN');
    expect(r3.answer).not.toMatch(RIEN_TROUVE);
    llm(standard, r3, 0);
  });

  it('T2U-C — intention connue + cible manquante évidente : MISSING_TARGET → « De quel bien parlez-vous ? », 0 appel IA, aucune recherche globale', async () => {
    const h = H.harness(H.account({ assets: [MAISON, POLO, CUPRA, ARCHIVEE] }), { understand: H.understood('ACCOUNT_SEARCH_DOCUMENT', []), retrieved: [doc(1, 'Tout le compte')] });
    const r = await h.ask('Quels documents sont liés à ce bien ?');
    expect(r.route.intent).toBe('ACCOUNT_SEARCH_DOCUMENT');
    expect(r.answer).toBe('De quel bien parlez-vous ?');
    // Biens DISPONIBLES proposés (règle du lot 29 : l'archivée est exclue).
    expect(r.clarification?.candidates.map((c) => c.entityId)).toEqual([10, 20, 21]);
    expect(h.retrieve).not.toHaveBeenCalled();
    expect(r.answer).not.toMatch(RIEN_TROUVE);
    expect(r.cascade?.understanding).toMatchObject({ initialStatus: 'COMPLETE', status: 'PARTIAL', reasons: ['MISSING_TARGET'], resolvedBy: 'clarification' });
    llm(h, r, 0);
  });

  it('T2U-C bis — reprise après le choix : recherche exécutée sur le bien choisi', async () => {
    const h = H.harness(H.account({ assets: [MAISON, POLO, CUPRA] }), { retrieved: [doc(3, 'Carte grise Polo')] });
    const r = await h.ask('Quels documents sont liés à ce bien ?', {
      resume: { clarificationId: 'c1', intent: 'ACCOUNT_SEARCH_DOCUMENT', assetId: 20, choiceLabel: 'Polo', chainDepth: 1 } as never,
    });
    expect(r.clarification).toBeNull();
    expect(bienRecherche(h)).toBe(20);
    llm(h, r, 0);
  });

  it('T2U-D — intention connue + compréhension partielle (« l’autre ») : PARTIAL → UNDERSTAND → résolution serveur des indices', async () => {
    // Le fil ne lève pas « l'autre » (aucune liste de deux éléments présentée).
    const thread = fil({ messages: [{ role: 'user', content: 'Quels documents concernent la Polo ?' }, { role: 'assistant', content: 'Voici les documents de la Polo.' }] });
    const q = 'Et les documents qui concernent l’autre ?';

    // 1. L'IA comprend « l'autre » = Cupra (indice, jamais un id) → 1 cible → on continue.
    const h = H.harness(H.account({ assets: [POLO, CUPRA] }), { thread, understand: H.understood('ACCOUNT_SEARCH_DOCUMENT', [], [{ type: 'asset', value: 'Cupra' }]), retrieved: [] });
    const r = await h.ask(q);
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(bienRecherche(h)).toBe(21);
    expect(r.answer).toBe('Aucun document n’est lié à « Cupra » dans votre compte.');
    expect(r.cascade?.understanding).toMatchObject({ initialStatus: 'COMPLETE', status: 'COMPLETE', reasons: ['UNRESOLVED_REFERENCE'], resolvedBy: 'understand' });
    llm(h, r, 1);

    // 2. L'IA reste ambiguë (« l'autre ») → 0 cible → clarification Polo / Cupra.
    const h2 = H.harness(H.account({ assets: [POLO, CUPRA] }), { thread, understand: ambigu('ACCOUNT_SEARCH_DOCUMENT', [{ type: 'asset', value: 'l’autre' }]) });
    const r2 = await h2.ask(q);
    expect(r2.answer).toBe('Parlez-vous de « Polo » ou de « Cupra » ?');
    expect(r2.clarification?.candidates.map((c) => c.entityId)).toEqual([20, 21]);
    expect(r2.clarification?.originalIntent).toBe('ACCOUNT_SEARCH_DOCUMENT');
    expect(h2.retrieve).not.toHaveBeenCalled();
    llm(h2, r2, 1);

    // 3. Intention inconnue (« ceux ») + renvoi : UN SEUL appel UNDERSTAND.
    const q3 = 'Et ceux qui concernent l’autre ?';
    expect(routeDeterministic({ message: q3, planType: 'PREMIUM', hasPendingClarification: false }).kind).toBe('needs_classification');
    const h3 = H.harness(H.account({ assets: [POLO, CUPRA] }), { thread, understand: H.understood('ACCOUNT_SEARCH_DOCUMENT', [], [{ type: 'asset', value: 'Cupra' }]), retrieved: [doc(7, 'Assurance Cupra')] });
    const r3 = await h3.ask(q3);
    expect(h3.classify).toHaveBeenCalledTimes(1);
    expect(bienRecherche(h3)).toBe(21);
    expect(r3.route.intent).toBe('ACCOUNT_SEARCH_DOCUMENT');
    expect(r3.cascade?.understanding).toMatchObject({ initialStatus: 'UNKNOWN_INTENT', status: 'COMPLETE', resolvedBy: 'understand' });
    llm(h3, r3, 1);

    // 4. IA non autorisée (offre) : pas d'appel, clarification prudente — jamais de compréhension inventée.
    const h4 = H.harness(H.account({ assets: [POLO, CUPRA] }), { thread, understand: H.understood('ACCOUNT_SEARCH_DOCUMENT', [], [{ type: 'asset', value: 'Cupra' }]) });
    const r4 = await h4.ask(q, { planType: 'STANDARD' });
    expect(h4.classify).not.toHaveBeenCalled();
    expect(r4.clarification?.candidates.map((c) => c.entityId)).toEqual([20, 21]);
    expect(h4.retrieve).not.toHaveBeenCalled();
    llm(h4, r4, 0);
  });

  it('T2U-E — question complètement déterministe (« l’adresse de la maison », maison unique) : COMPLETE → SQL → 0 appel IA', async () => {
    const h = H.harness(H.account({ assets: [MAISON, POLO] }), { understand: H.understood('ACCOUNT_FACT_ASSET', ['address1']) });
    const r = await h.ask('Quelle est l’adresse de la maison ?');
    expect(r.answer).toContain('12 rue des Lilas');
    expect(h.readers.calls[0]).toEqual({ kind: 'asset', id: 10, key: 'address1' });
    expect(r.cascade?.understanding).toMatchObject({ initialStatus: 'COMPLETE', status: 'COMPLETE', resolvedBy: 'deterministic' });
    llm(h, r, 0);
    // Exemple 13 du ticket : « Quel est le kilométrage de la Polo ? ».
    const r2 = await h.ask('Quel est le kilométrage de la Polo ?');
    expect(r2.answer).toContain('82');
    expect(h.llmCalls()).toBe(0);
  });

  it('T2U-F — recherche globale explicite (« Quels documents ai-je ? ») : COMPLETE → recherche à l’échelle du compte, aucune clarification', async () => {
    const h = H.harness(H.account({ assets: [MAISON, POLO, CUPRA] }), { retrieved: [doc(1, 'Facture EDF'), doc(2, 'Carte grise Polo')] });
    const r = await h.ask('Quels documents ai-je ?');
    expect(r.clarification).toBeNull();
    expect(h.retrieve).toHaveBeenCalledTimes(1);
    expect(bienRecherche(h)).toBeNull();
    expect(r.cascade?.understanding).toMatchObject({ status: 'COMPLETE', reasons: [] });
    llm(h, r, 0);
  });

  it('T2U-G — référence résolue par le fil (« Parle-moi de la Polo » puis « ce bien ») : Polo, aucune clarification', async () => {
    // Liste présentée par la réponse précédente.
    const thread = fil({
      messages: [{ role: 'user', content: 'Parle-moi de la Polo' }, { role: 'assistant', content: 'Voici « Polo ».' }],
      presentedLists: [[{ position: 1, type: 'asset', id: 20, label: 'Polo' }]],
      lastPresentedEntities: [{ position: 1, type: 'asset', id: 20, label: 'Polo' }],
    });
    const h = H.harness(H.account({ assets: [MAISON, POLO, CUPRA] }), { thread, retrieved: [doc(3, 'Carte grise Polo')] });
    const r = await h.ask('Quels documents sont liés à ce bien ?');
    expect(r.clarification).toBeNull();
    expect(bienRecherche(h)).toBe(20);
    llm(h, r, 0);

    // Fil sans liste présentée : le DERNIER échange ne nomme que la Polo.
    const h2 = H.harness(H.account({ assets: [MAISON, POLO, CUPRA] }), {
      thread: fil({ messages: [{ role: 'user', content: 'Parle-moi de la Polo' }, { role: 'assistant', content: 'La Polo est une voiture.' }] }),
      retrieved: [doc(3, 'Carte grise Polo')],
    });
    const r2 = await h2.ask('Quels documents sont liés à ce bien ?');
    expect(r2.clarification).toBeNull();
    expect(bienRecherche(h2)).toBe(20);
    expect(r2.contextUpdate).toMatchObject({ type: 'asset', id: 20 });
    expect(r2.cascade?.understanding).toMatchObject({ status: 'COMPLETE', resolvedBy: 'thread' });
    llm(h2, r2, 0);
  });

  it('T2U-H — référence ambiguë (« Compare la Polo et la Cupra » puis « lui ») : aucune sélection arbitraire → clarification Polo / Cupra', async () => {
    const liste = [
      { position: 1, type: 'asset' as const, id: 20, label: 'Polo' },
      { position: 2, type: 'asset' as const, id: 21, label: 'Cupra' },
      { position: 3, type: 'document' as const, id: 5, label: 'Facture' },
    ];
    const thread = fil({
      messages: [{ role: 'user', content: 'Compare la Polo et la Cupra' }, { role: 'assistant', content: 'La Polo a 82 000 km, la Cupra 15 000 km.' }],
      presentedLists: [liste], lastPresentedEntities: liste,
    });
    const h = H.harness(H.account({ assets: [MAISON, POLO, CUPRA] }), { thread, understand: H.understood('ACCOUNT_SEARCH_DOCUMENT', [], [{ type: 'asset', value: 'Polo' }]), retrieved: [doc(3, 'X')] });
    const r = await h.ask('Quels documents lui sont liés ?');
    expect(r.answer).toBe('Parlez-vous de « Polo » ou de « Cupra » ?');
    expect(r.clarification?.candidates.map((c) => c.entityId)).toEqual([20, 21]);
    expect(h.retrieve).not.toHaveBeenCalled();
    expect(r.cascade?.understanding?.reasons).toEqual(['AMBIGUOUS_TARGET']);
    llm(h, r, 0);

    // Liste de biens seulement : clarification du fil, intention de la DEMANDE conservée.
    const biens = liste.slice(0, 2);
    const h2 = H.harness(H.account({ assets: [MAISON, POLO, CUPRA] }), { thread: fil({ ...thread, presentedLists: [biens], lastPresentedEntities: biens }) });
    const r2 = await h2.ask('Quels documents lui sont liés ?');
    expect(r2.clarification?.candidates.map((c) => c.entityId)).toEqual([20, 21]);
    expect(r2.clarification?.originalIntent).toBe('ACCOUNT_SEARCH_DOCUMENT');
    expect(h2.retrieve).not.toHaveBeenCalled();
    llm(h2, r2, 0);
  });

  it('T2U-I — aucun résultat véritable : recherche exécutée sur la Polo → « Aucun document… »', async () => {
    const h = H.harness(H.account({ assets: [MAISON, POLO, CUPRA] }), { retrieved: [] });
    const r = await h.ask('Quels documents sont liés à la Polo ?');
    expect(h.retrieve).toHaveBeenCalledTimes(1);
    const input = h.retrieve.mock.calls[0][1] as AssistantRequestInput;
    const { resolveAssistantTargets } = await import('../../assistant-targets');
    expect((await resolveAssistantTargets(input, null, h.lookup)).asset?.id).toBe(20);
    expect(r.answer).toBe('Aucun document n’est lié à « Polo » dans votre compte.');
    expect(r.cascade?.diagnostic).toBe('SEARCH_NO_RESULT');
    expect(r.clarification).toBeNull();
    llm(h, r, 0);
  });
});

describe('Lot 32 — critères d’acceptation transverses', () => {
  it('T2U-AC04 — l’IA ne fabrique jamais d’identifiant : un indice qui ressemble à un id n’est jamais une cible', async () => {
    const thread = fil({ messages: [{ role: 'user', content: 'Parle-moi de la Polo' }, { role: 'assistant', content: 'La Polo.' }] });
    const h = H.harness(H.account({ assets: [POLO, CUPRA] }), { thread, understand: H.understood('ACCOUNT_SEARCH_DOCUMENT', [], [{ type: 'asset', value: '21' }, { type: 'asset', value: 'page:21' }]) });
    const r = await h.ask('Et les documents qui concernent l’autre ?');
    expect(h.retrieve).not.toHaveBeenCalled();
    expect(r.clarification?.candidates.map((c) => c.entityId)).toEqual([20, 21]);
  });

  it('T2U-AC05 — une compréhension incomplète ne produit jamais « aucun résultat », ni une rédaction ANSWER', async () => {
    // Intention inconnue, IA en échec, retrieval vide.
    const h = H.harness(H.account({ assets: [POLO] }), { understand: null, generated: 'inventé' });
    const r = await h.ask('Je voudrais y voir plus clair avec tout ça');
    expect(r.answer).not.toMatch(RIEN_TROUVE);
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('T2U-AC06 — cible désignée par la page : complète, sans IA ni clarification', async () => {
    const h = H.harness(H.account({ assets: [POLO, CUPRA] }), { retrieved: [doc(3, 'Carte grise Polo')] });
    const r = await h.ask('Quels documents sont liés à ce bien ?', { pageContext: { route: '/assets/20', assetId: '20' } });
    expect(r.clarification).toBeNull();
    expect(bienRecherche(h)).toBe(20);
    llm(h, r, 0);
  });

  it('T2U-AC07 — un seul bien disponible : pas de clarification inutile', async () => {
    const h = H.harness(H.account({ assets: [POLO, ARCHIVEE] }), { retrieved: [doc(3, 'Carte grise Polo')] });
    const r = await h.ask('Quels documents sont liés à ce bien ?');
    expect(r.clarification).toBeNull();
    expect(bienRecherche(h)).toBe(20);
    llm(h, r, 0);
  });

  it('T2U-AC08 — « cette maison » avec deux maisons : AMBIGUOUS_TARGET (candidats du compte), sans IA', async () => {
    const lyon = { ...MAISON, id: 11, name: 'Maison Lyon', city: 'Lyon' };
    const h = H.harness(H.account({ assets: [MAISON, lyon, POLO] }), { retrieved: [doc(1, 'X')] });
    const r = await h.ask('Quels documents concernent cette maison ?');
    expect(r.clarification?.candidates.map((c) => c.entityId)).toEqual([10, 11]);
    expect(h.retrieve).not.toHaveBeenCalled();
    llm(h, r, 0);
  });
});

describe('Lot 32 — non-régression lot 29 (SQL-first, 0 appel LLM)', () => {
  it('T2U-NR01 — lectures canoniques directes : 0 appel modèle', async () => {
    const h = H.harness(H.account({ assets: [MAISON, POLO, CUPRA] }), { understand: H.understood('ACCOUNT_FACT_ASSET', ['mileage']) });
    for (const q of ['Quelle est l’adresse de la maison ?', 'Quel est le kilométrage de la Polo ?', 'Quel est le kilométrage de la Cupra ?']) {
      const r = await h.ask(q);
      expect(r.cascade?.understanding?.status).toBe('COMPLETE');
      expect(r.cascade?.aiCalls).toBe(0);
    }
    expect(h.llmCalls()).toBe(0);
  });

  it('T2U-NR02 — fait sur le bien du fil (« son kilométrage ») : 0 appel modèle', async () => {
    const h = H.harness(H.account({ assets: [POLO, CUPRA] }), { thread: H.threadOn('asset', 20, 'Polo') });
    const r = await h.ask('Et son kilométrage ?');
    expect(r.answer).toContain('82');
    llm(h, r, 0);
  });
});
