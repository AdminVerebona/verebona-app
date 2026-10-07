/**
 * Lot 29 — ticket 8a : champ SENSIBLE restitué à son propriétaire par une
 * réponse déterministe (jamais envoyé au modèle, aux journaux, aux traces) ;
 * « la maison », « mon appartement », « ma voiture » → bien UNIQUE de la
 * catégorie, clarification sinon ; adresse complète composée par le serveur ;
 * champ vide → « non renseignée ».
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const unsafe = vi.fn(async (_sql: string, _params?: unknown[]) => [] as unknown[]);
vi.mock('@/db', () => ({ pgClient: { unsafe: (sql: string, params?: unknown[]) => unsafe(sql, params) }, db: {}, ensureMigrations: vi.fn(), ensureUnaccent: vi.fn() }));

const H = await import('./harness');
const { assetFieldSource } = await import('../../../canonical/field-reader');
const { formatConversationForPrompt, SENSITIVE_ANSWER_PLACEHOLDER } = await import('../../reference-resolver');
const { loadThreadContext } = await import('../../conversation.service');
const { buildT2ObservabilityTrace } = await import('@/services/ai/telemetry/t2-observability');
const { findReadableField } = await import('../../../canonical/structured-answers');

afterEach(() => { vi.restoreAllMocks(); unsafe.mockReset(); unsafe.mockResolvedValue([]); });

const ADRESSE = '12 rue des Lilas';
const MAISON = { id: 10, name: 'Maison', category: 'IMMOBILIER', subtype: 'Maison', fields: { address1: ADRESSE, postalCode: '01000', city: 'Bourg-en-Bresse' } };
const POLO = { id: 20, name: 'Polo', category: 'VEHICULE', fields: { mileage: 82000, registrationNumber: 'AB-123-CD' } };
const DRAISIENNE = { id: 30, name: 'Draisienne', category: 'OBJECT', fields: { acquisitionDate: '2026-04-24', warrantyEndDate: '2028-04-24' } };
const LYON = { ...MAISON, id: 11, name: 'Maison Lyon', fields: { address1: '1 quai Lyon', postalCode: '69001', city: 'Lyon' } };
const ANNECY = { ...MAISON, id: 12, name: 'Maison Annecy', fields: { address1: '2 rue Annecy', postalCode: '74000', city: 'Annecy' } };

describe('Ticket 8a — champ sensible et résolution par catégorie', () => {
  it('T2SENS-AC01 — adresse d’une maison unique : composée par le serveur, aucun appel ANSWER', async () => {
    const h = H.harness(H.account({ assets: [MAISON, POLO, DRAISIENNE] }));
    const r = await h.ask('À quelle adresse se situe la maison ?');
    expect(r.answer).toContain(`${ADRESSE}, 01000 Bourg-en-Bresse`);
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.llmCalls()).toBe(0);
    // Le champ sensible est lisible par le vocabulaire (plus d'exclusion « sensitive »).
    expect(findReadableField('À quelle adresse se situe la maison ?')?.def.key).toBe('address1');
  });

  it('T2SENS-AC02 — formulation possessive « ma maison » : même résultat', async () => {
    const h = H.harness(H.account({ assets: [MAISON, POLO] }));
    const r = await h.ask('Quelle est l’adresse de ma maison ?');
    expect(r.answer).toContain(`${ADRESSE}, 01000 Bourg-en-Bresse`);
    expect(h.llmCalls()).toBe(0);
  });

  it('T2SENS-AC03 — appartement unique : le bien immobilier de cette catégorie (pas la maison)', async () => {
    const appart = { id: 13, name: 'Studio Annecy', category: 'IMMOBILIER', subtype: 'Appartement', fields: { address1: '5 avenue du Lac', postalCode: '74000', city: 'Annecy' } };
    const h = H.harness(H.account({ assets: [MAISON, appart] }));
    const r = await h.ask('Quelle est l’adresse de mon appartement ?');
    expect(r.answer).toContain('5 avenue du Lac');
    expect(r.answer).not.toContain(ADRESSE);
  });

  it('T2SENS-AC04 — véhicule par catégorie : « ma voiture » résout le seul véhicule, même nommé « Polo »', async () => {
    const h = H.harness(H.account({ assets: [MAISON, POLO] }));
    const r = await h.ask('Quelle est l’immatriculation de ma voiture ?');
    expect(r.answer).toContain('AB-123-CD');
    expect(h.llmCalls()).toBe(0);
  });

  it('T2SENS-AC05 — plusieurs maisons : clarification, aucune adresse choisie arbitrairement', async () => {
    const h = H.harness(H.account({ assets: [LYON, ANNECY] }));
    const r = await h.ask('Quelle est l’adresse de la maison ?');
    expect(r.clarification?.question).toBe('De quel bien parlez-vous ?');
    expect(r.clarification?.candidates.map((c) => c.label)).toEqual(['Maison Lyon', 'Maison Annecy']);
    expect(r.answer).not.toMatch(/quai|rue/);
    expect(h.readers.calls).toEqual([]);
  });

  it('T2SENS-AC06 — nom explicite prioritaire : « Maison Lyon » → réponse directe, aucune clarification', async () => {
    const h = H.harness(H.account({ assets: [LYON, ANNECY] }));
    const r = await h.ask('Quelle est l’adresse de Maison Lyon ?');
    expect(r.clarification).toBeNull();
    expect(r.answer).toContain('1 quai Lyon, 69001 Lyon');
  });

  it('T2SENS-AC07 — contexte conversationnel : « Et son adresse ? » → Maison Lyon', async () => {
    const h = H.harness(H.account({ assets: [LYON, ANNECY] }), { thread: H.threadOn('asset', 11, 'Maison Lyon') });
    const r = await h.ask('Et son adresse ?');
    expect(r.answer).toContain('1 quai Lyon');
    expect(r.cascade?.reference?.entity).toEqual({ type: 'asset', id: 11 });
    expect(h.llmCalls()).toBe(0);
  });

  it('T2SENS-AC08 — contexte de page : « Quelle est son adresse ? » depuis la fiche Maison Lyon', async () => {
    const h = H.harness(H.account({ assets: [LYON, ANNECY] }));
    const r = await h.ask('Quelle est son adresse ?', { pageContext: { assetId: '11', route: '/assets/11' } });
    expect(r.answer).toContain('1 quai Lyon');
    expect(h.llmCalls()).toBe(0);
  });

  it('T2SENS-AC09 — adresse absente : « non renseignée », jamais « rien trouvé »', async () => {
    const h = H.harness(H.account({ assets: [{ ...MAISON, fields: { city: 'Bourg-en-Bresse' } }] }));
    const r = await h.ask('Quelle est l’adresse de la maison ?');
    expect(r.answer).toBe('L’information « Adresse » n’est pas renseignée pour Maison.');
    expect(r.answer).not.toMatch(/rien trouvé/);
    expect(r.cascade?.diagnostic).toBe('FIELD_NOT_SET');
  });

  it('T2SENS-AC10 — confidentialité : l’adresse est dans la réponse, jamais dans un prompt, un journal, un événement d’observabilité ni une source', async () => {
    const journaux: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { journaux.push(a.map(String).join(' ')); });
    }
    const h = H.harness(H.account({ assets: [MAISON] }));
    const r = await h.ask('À quelle adresse se situe la maison ?');
    expect(r.answer).toContain(ADRESSE);
    // Aucun appel modèle (donc aucun prompt) ; aucune trace, source ou journal ne la porte.
    expect(h.llmCalls()).toBe(0);
    expect(JSON.stringify(r.cascade)).not.toContain('Lilas');
    expect(JSON.stringify(r.sources)).not.toContain('Lilas');
    expect(JSON.stringify(buildT2ObservabilityTrace({ strategy: r.cascade?.strategy, sources: r.sources, target: null }))).not.toContain('Lilas');
    expect(journaux.join('\n')).not.toContain('Lilas');
    expect(r.claims.map((c) => c.claimKey)).toEqual(['field:address1']);
    // Tour suivant : la réponse restituant l'adresse n'est JAMAIS recopiée vers le modèle.
    unsafe.mockResolvedValueOnce([{ id: 99, context_json: {}, clarification_state_json: null }])
      .mockResolvedValueOnce([{ role: 'user', content: 'Adresse ?', sensitive: false }, { role: 'assistant', content: r.answer, sensitive: true }])
      .mockResolvedValueOnce([]);
    const ctx = await loadThreadContext(1, 7, 99);
    const requete = unsafe.mock.calls.find((c) => String(c[0]).includes('verebona_messages'))!;
    expect(String(requete[0])).toMatch(/claim_key = ANY\(\$2::text\[\]\)/);
    expect(requete[1]).toEqual([99, expect.arrayContaining(['field:address1', 'field:address2'])]);
    const prompt = formatConversationForPrompt(ctx, null);
    expect(prompt).toContain(SENSITIVE_ANSWER_PLACEHOLDER);
    expect(prompt).not.toContain('Lilas');
  });

  it('T2SENS-AC11 — source sensible : « Adresse : (donnée protégée) », meta.value et meta.display nuls, sensitive', () => {
    const src = assetFieldSource({
      assetId: 10, assetName: 'Maison', key: 'address1', label: 'Adresse', value: ADRESSE, display: ADRESSE, origin: 'USER',
      originLabel: 'saisie par vous', updatedAt: null, from: 'key', evidence: null, openConflict: null, sensitive: true,
    });
    expect(src.content.startsWith('Adresse : (donnée protégée)')).toBe(true);
    expect(src.meta).toMatchObject({ value: null, display: null, sensitive: true });
    expect(JSON.stringify(src)).not.toContain('Lilas');
  });

  it('T2SENS-AC12 — non-régression des champs non sensibles', async () => {
    const h = H.harness(H.account({ assets: [POLO, DRAISIENNE] }));
    expect((await h.ask('Quel est le kilométrage de la Polo ?')).answer).toMatch(/^Kilométrage de Polo : 82\s000 km\./);
    expect((await h.ask('Quand ai-je acheté la draisienne ?')).answer).toMatch(/^Vous avez acheté Draisienne le 24 avril 2026\./);
    expect((await h.ask('Quelle est la date de fin de garantie ?', { pageContext: { assetId: '30', route: '/assets/30' } })).answer).toContain('24 avril 2028');
    expect((await h.ask('Quelle est l’immatriculation de la voiture ?')).answer).toContain('AB-123-CD');
    expect(h.llmCalls()).toBe(0);
  });
});
