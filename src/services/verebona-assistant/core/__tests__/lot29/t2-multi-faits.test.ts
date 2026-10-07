/**
 * Lot 29 — ticket 12 : plusieurs `requestedFacts` dans la lecture ciblée
 * canonique. Cible résolue UNE fois, chaque champ lu par la couche
 * canonique, dédoublonnage (ordre conservé), statut par champ, cascade
 * documentaire par champ, une source et une affirmation PAR champ, ≤ 20
 * champs, aucun appel ANSWER quand tout est déterministe.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {}, ensureMigrations: vi.fn(), ensureUnaccent: vi.fn() }));

const H = await import('./harness');
const { answerFromTarget } = await import('../../target-answer');
const { targetsFromInput } = await import('../../assistant-targets');
const { inputDeReprise } = await import('../../clarification.service');
const { runAssistant } = await import('../../assistant-orchestrator.service');
const { listFields } = await import('@/services/canonical/registry');
const { unconsumedInformationWords } = await import('../../../canonical/field-vocabulary');

const POLO = { id: 20, name: 'Polo', category: 'VEHICULE', subtype: 'Voiture', fields: { acquisitionDate: '2021-06-15', acquisitionPrice: 18500, mileage: 82000 } };
const QUESTION = 'Quand ai-je acheté la Polo et combien l’ai-je payée ?';
const pageDe = (id: number) => targetsFromInput({ pageContext: { assetId: String(id) } });
const nb = (s: string) => s.replace(/[  ]/g, ' ');

describe('Ticket 12 — plusieurs champs demandés', () => {
  it('T2MULTI-AC01 — deux champs disponibles : lus, restitués, sans recherche documentaire ni appel ANSWER', async () => {
    expect(unconsumedInformationWords(QUESTION)).toEqual(['payee']);
    const h = H.harness(H.account({ assets: [POLO] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionDate', 'acquisitionPrice'], [{ type: 'asset', value: 'Polo' }]),
    });
    const r = await h.ask(QUESTION);
    expect(nb(r.answer)).toBe('Pour Polo : date d’achat : 15 juin 2021 ; prix d’achat : 18 500 €.');
    expect(h.readers.calls).toEqual([{ kind: 'asset', id: 20, key: 'acquisitionDate' }, { kind: 'asset', id: 20, key: 'acquisitionPrice' }]);
    expect(h.readers.calls.some((c) => c.kind === 'document')).toBe(false);
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('T2MULTI-AC02 — trois champs : les trois informations', async () => {
    const h = H.harness(H.account({ assets: [POLO] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionDate', 'acquisitionPrice', 'mileage'], [{ type: 'asset', value: 'Polo' }]),
    });
    const r = await h.ask('Donne-moi la date d’achat, le prix et le kilométrage de la Polo.');
    expect(nb(r.answer)).toBe('Pour Polo : date d’achat : 15 juin 2021 ; prix d’achat : 18 500 € ; kilométrage : 82 000 km.');
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('T2MULTI-AC03 — une valeur absente : date et kilométrage restitués, prix traité séparément', async () => {
    const h = H.harness(H.account({ assets: [{ ...POLO, fields: { acquisitionDate: '2021-06-15', mileage: 82000 } }] }));
    const lu = await answerFromTarget(1, 'x', { ...pageDe(20) }, h.readers, { requestedFacts: ['acquisitionDate', 'acquisitionPrice', 'mileage'], filters: {} });
    expect(nb(lu!.text)).toBe('Pour ce bien : date d’achat : 15 juin 2021 ; kilométrage : 82 000 km. Non renseigné : prix d’achat.');
    expect(lu!.facts!.map((f) => f.status)).toEqual(['VALUE_FOUND', 'MISSING_CANONICAL_VALUE', 'VALUE_FOUND']);
    expect(h.readers.calls).toContainEqual({ kind: 'document', id: 20, key: 'acquisitionPrice' });
  });

  it('T2MULTI-AC04 — valeur absente de la fiche mais présente dans un document : cascade PAR champ, réponse consolidée', async () => {
    const acc = H.account({
      assets: [{ ...POLO, fields: { acquisitionDate: '2021-06-15', mileage: 82000 } }],
      docFacts: [{ assetId: 20, key: 'acquisitionPrice', display: '18 500 €', fileId: 300, title: 'Facture achat Polo' }],
    });
    const h = H.harness(acc);
    const lu = await answerFromTarget(1, 'x', pageDe(20), h.readers, { requestedFacts: ['acquisitionDate', 'acquisitionPrice', 'mileage'], filters: {} });
    expect(lu!.text).toContain('date d’achat : 15 juin 2021');
    expect(lu!.text).toContain('Prix d’achat de Polo : 18 500 € (lu dans « Facture achat Polo »');
    expect(lu!.facts!.map((f) => [f.key, f.from])).toEqual([['acquisitionDate', 'canonical'], ['acquisitionPrice', 'document'], ['mileage', 'canonical']]);
    expect(lu!.sources.map((s) => s.id)).toEqual(['asset_field:20:acquisitionDate', 'doc_300', 'asset_field:20:mileage']);
    // Le document n'est consulté QUE pour le champ manquant.
    expect(h.readers.calls.filter((c) => c.kind === 'document')).toEqual([{ kind: 'document', id: 20, key: 'acquisitionPrice' }]);
  });

  it('T2MULTI-AC05 — aucun champ renseigné : absence explicite, jamais « aucun bien correspondant »', async () => {
    const h = H.harness(H.account({ assets: [{ ...POLO, fields: {} }] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionDate', 'acquisitionPrice'], [{ type: 'asset', value: 'Polo' }]),
    });
    const r = await h.ask(QUESTION);
    expect(r.answer).toBe('Ces informations ne sont pas renseignées pour Polo : date d’achat, prix d’achat.');
    expect(r.answer).not.toMatch(/Aucun bien|rien trouvé/);
    expect(r.cascade?.diagnostic).toBe('FIELD_NOT_SET');
  });

  it('T2MULTI-AC06 — dédoublonnage : [mileage, mileage, acquisitionDate] → 2 lectures, aucune répétition', async () => {
    const h = H.harness(H.account({ assets: [POLO] }));
    const lu = await answerFromTarget(1, 'x', pageDe(20), h.readers, { requestedFacts: ['mileage', 'mileage', 'acquisitionDate'], filters: {} });
    expect(h.readers.calls).toEqual([{ kind: 'asset', id: 20, key: 'mileage' }, { kind: 'asset', id: 20, key: 'acquisitionDate' }]);
    expect(lu!.text.match(/kilométrage/g)).toHaveLength(1);
    expect(lu!.requestedFacts).toEqual(['mileage', 'acquisitionDate']);
  });

  it('T2MULTI-AC07 — ordre conservé et valeurs corrélées malgré des lectures asynchrones désordonnées', async () => {
    const h = H.harness(H.account({ assets: [POLO] }));
    const lent = { mileage: 30, acquisitionPrice: 10, acquisitionDate: 0 } as Record<string, number>;
    const field = h.readers.field!;
    const readers = { ...h.readers, field: async (a: number, id: number, k: string) => { await new Promise((r) => setTimeout(r, lent[k] ?? 0)); return field(a, id, k); } };
    const lu = await answerFromTarget(1, 'x', pageDe(20), readers, { requestedFacts: ['mileage', 'acquisitionPrice', 'acquisitionDate'], filters: {} });
    expect(nb(lu!.text)).toBe('Pour ce bien : kilométrage : 82 000 km ; prix d’achat : 18 500 € ; date d’achat : 15 juin 2021.');
    expect(lu!.claims.map((c) => [c.claimKey, c.sourceIds])).toEqual([
      ['field:mileage', ['asset_field:20:mileage']], ['field:acquisitionPrice', ['asset_field:20:acquisitionPrice']], ['field:acquisitionDate', ['asset_field:20:acquisitionDate']],
    ]);
  });

  it('T2MULTI-AC08 — jusqu’à 20 champs : traitement générique et borné, aucune boucle d’appels IA', async () => {
    const vingtEtUn = listFields('VEHICULE').filter((d) => d.assistantReadable).slice(0, 21).map((d) => d.key);
    expect(vingtEtUn).toHaveLength(21);
    const h = H.harness(H.account({ assets: [POLO] }), { understand: H.understood('ACCOUNT_FACT_ASSET', vingtEtUn, [{ type: 'asset', value: 'Polo' }]) });
    const lu = await answerFromTarget(1, 'x', pageDe(20), h.readers, { requestedFacts: vingtEtUn, filters: {} });
    expect(lu!.facts).toHaveLength(20);
    expect(new Set(h.readers.calls.filter((c) => c.kind === 'asset').map((c) => c.key)).size).toBeLessThanOrEqual(20);
    const r = await h.ask('Donne-moi toutes les informations de prix et de date de la Polo');
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.classify.mock.calls.length).toBeLessThanOrEqual(1);
    expect(r.cascade?.aiCalls).toBeLessThanOrEqual(1);
  });

  it('T2MULTI-AC09 — une clé invalide : aucune exception, les autres champs restent traités', async () => {
    const h = H.harness(H.account({ assets: [POLO] }));
    const lu = await answerFromTarget(1, 'x', pageDe(20), h.readers, { requestedFacts: ['mileage', 'champInexistant', 'acquisitionDate'], filters: {} });
    expect(lu!.facts!.map((f) => [f.requested, f.status])).toEqual([
      ['mileage', 'VALUE_FOUND'], ['champInexistant', 'FIELD_UNAVAILABLE'], ['acquisitionDate', 'VALUE_FOUND'],
    ]);
    expect(nb(lu!.text)).toBe('Pour ce bien : kilométrage : 82 000 km ; date d’achat : 15 juin 2021.');
  });

  it('T2MULTI-AC10 — cible ambiguë : UNE clarification pour toute la demande, puis lecture de tous les champs', async () => {
    const acc = H.account({ assets: [{ ...POLO, id: 21, name: 'Polo perso' }, { ...POLO, id: 22, name: 'Polo conjoint', fields: { acquisitionDate: '2019-01-02', acquisitionPrice: 9000 } }] });
    const h = H.harness(acc, { understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionDate', 'acquisitionPrice'], [{ type: 'asset', value: 'Polo' }]) });
    const r = await h.ask(QUESTION);
    expect(h.saveClarification).toHaveBeenCalledTimes(1);
    expect(r.clarification?.candidates.map((c) => c.entityId)).toEqual([21, 22]);
    expect(r.clarification?.resolvedContext?.requestedFacts).toEqual(['acquisitionDate', 'acquisitionPrice']);
    expect(h.readers.calls).toEqual([]);
    const suite = await runAssistant(inputDeReprise({ accountId: 1, userId: 7, planType: 'PREMIUM', locale: 'fr-FR' }, r.clarification!, r.clarification!.candidates[1]), h.ports);
    expect(nb(suite.answer)).toBe('Pour Polo conjoint : date d’achat : 2 janvier 2019 ; prix d’achat : 9 000 €.');
    expect(h.saveClarification).toHaveBeenCalledTimes(1);
  });

  it('T2MULTI-AC11 — cible résolue UNE seule fois pour tous les champs', async () => {
    const h = H.harness(H.account({ assets: [POLO] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionDate', 'acquisitionPrice', 'mileage'], [{ type: 'asset', value: 'Polo' }]),
    });
    await h.ask('Donne-moi la date d’achat, le prix et le kilométrage de la Polo.');
    expect(h.lookup.calls.assets).toBe(1);
    expect(h.readers.calls.map((c) => c.key)).toEqual(['acquisitionDate', 'acquisitionPrice', 'mileage']);
  });

  it('T2MULTI-AC12 — sources séparées : une source asset_field par champ, chaque affirmation rattachée à la sienne', async () => {
    const h = H.harness(H.account({ assets: [POLO] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionDate', 'acquisitionPrice', 'mileage'], [{ type: 'asset', value: 'Polo' }]),
    });
    const r = await h.ask('Donne-moi la date d’achat, le prix et le kilométrage de la Polo.');
    expect(r.sources.map((s) => s.id).sort()).toEqual(['asset_field:20:acquisitionDate', 'asset_field:20:acquisitionPrice', 'asset_field:20:mileage']);
    for (const c of r.claims) expect(c.sourceIds).toEqual([`asset_field:20:${c.claimKey.replace('field:', '')}`]);
    expect(r.claims).toHaveLength(3);
  });

  it('T2MULTI-AC13 — non-régression mono-champ : « Quel est le kilométrage de la Polo ? » inchangé', async () => {
    const h = H.harness(H.account({ assets: [POLO] }));
    const r = await h.ask('Quel est le kilométrage de la Polo ?');
    expect(nb(r.answer)).toBe('Kilométrage de Polo : 82 000 km. Valeur saisie par vous.');
    expect(r.cascade?.strategy).toBe('target.asset_field');
    expect(r.sources.map((s) => s.id)).toEqual(['asset_field:20:mileage']);
    expect(h.llmCalls()).toBe(0);
  });

  it('T2MULTI-AC14 — cible trouvée et au moins une valeur : jamais « Je n’ai rien trouvé de correspondant »', async () => {
    const h = H.harness(H.account({ assets: [{ ...POLO, fields: { mileage: 82000 } }] }), {
      understand: H.understood('ACCOUNT_FACT_ASSET', ['acquisitionDate', 'acquisitionPrice', 'mileage'], [{ type: 'asset', value: 'Polo' }]),
    });
    const r = await h.ask('Donne-moi la date d’achat, le prix et le kilométrage de la Polo.');
    expect(r.answer).not.toMatch(/rien trouvé/);
    expect(nb(r.answer)).toBe('Pour Polo : kilométrage : 82 000 km. Non renseignés : date d’achat, prix d’achat.');
    expect(r.cascade?.diagnostic).toBeUndefined();
  });
});
