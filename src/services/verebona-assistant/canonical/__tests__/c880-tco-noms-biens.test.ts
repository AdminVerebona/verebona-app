/**
 * Carte #880 — « Quel est le coût de possession de Maison ? » : noms des biens
 * préservés, besoin TCO conservé jusqu'à la réponse.
 *
 *   C880-REPRO  le défaut AVANT correction (regex exacte du commit audité) :
 *               « Maison » → « ison », « Mercedes » → « rce s »… ;
 *   C880-MATRIX matrice de noms × stratégies auditées (CA02) : le texte remis à
 *               la résolution du bien garde TOUS les mots du nom (coût de
 *               possession, sinistres, historique, contrats, « payé », données
 *               manquantes, thème de dépense, échéances, champ d'un bien) ;
 *   C880-TCO    issues de la branche TCO (CA03) : bien unique → moteur TCO
 *               partagé, ID exact ; Standard → message d'offre sans montant ;
 *               homonymes → clarification ; introuvable → « bien non
 *               identifié » ; sans bien désigné → bien unique ou
 *               clarification ; supprimé → « plus disponible » ; erreur →
 *               « lecture impossible » — tracés (`reading`, `diagnostic`) ;
 *   C880-BROAD  formes LARGES inchangées (barrière #419 → compréhension) ;
 *   C880-T2X    export BO : issue fonctionnelle et contenus selon l'habilitation.
 * Bout en bout (PostgreSQL, vraie route) : `src/test/e2e/scenarios/c880-tco-noms-biens.e2e.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { tryCanonicalStructured, ownershipCostAnswer, isExplicitOwnershipCostQuestion } = await import('../structured-answers');
const { wholeWords } = await import('../phrase-strip');
const { poloTco } = await import('./fixtures/c790b-polo');
const { TCO_PREMIUM_MESSAGE } = await import('@/services/business-operations/tco/dto');
const { functionalOutcome, readT2Exchange } = await import('@/services/ai/business-execution/t2-exchange');

type Bien = { id: number; name: string; category?: string; subtype?: string | null };
const MONTANT = /\d[\d\s  ]*(,\d{2})?\s?€/;
const NOMS = ['Maison', 'Clio', 'Mercedes', 'Chalet', 'Appartement de Lyon', 'Cupra', 'Polo', 'Résidence l’Étoile', 'L’Escale', 'Mona', 'Tesla', 'Lemans', 'Estafette', 'Medea', 'Villa Quelven', 'Statera', 'Ferme du Suivi'];
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const mots = (s: string) => plain(s).replace(/['’]/g, ' ').split(/[^a-z0-9-]+/).filter((w) => w.length >= 3);

/** Résolution simplifiée et fidèle : un bien est trouvé si TOUS les mots (≥ 3) de son nom figurent dans le texte. */
function resolveur(biens: Bien[], calls: string[] = []) {
  return async (texte: string) => {
    calls.push(texte);
    const m = new Set(mots(texte));
    const trouves = biens.filter((b) => mots(b.name).every((w) => m.has(w)));
    const candidats = [...m].filter((w) => !['quel', 'quelle', 'est', 'les', 'des', 'pour', 'mon', 'mes', 'sur', 'dans', 'qui', 'sont', 'fait', 'ete'].includes(w));
    return { assets: trouves, ambiguous: trouves.length > 1, unresolved: trouves.length === 0 && candidats.length > 0, label: trouves.length === 1 ? trouves[0].name : null, resolvedBy: trouves.length ? 'NAME' : null } as never;
  };
}

function port(o: { allowed?: boolean; biens?: Bien[]; tco?: (id: number) => Promise<unknown> } = {}) {
  const readOwnershipCost = vi.fn(o.tco ?? (async () => poloTco()));
  return {
    readOwnershipCost,
    p: {
      today: () => '2026-11-28',
      readOwnershipCost,
      ownershipCostAllowed: vi.fn(async () => o.allowed ?? true),
      listAssets: vi.fn(async () => o.biens ?? []),
      readClaims: vi.fn(async () => []), readAssetHistory: vi.fn(async () => null), readContracts: vi.fn(async () => []),
      readPayments: vi.fn(async () => ({ payments: [] })), readAcquisition: vi.fn(async () => null),
      listMissingInformation: vi.fn(async () => []), sumQualifiedExpenses: vi.fn(async () => null),
      listUpcomingAgenda: vi.fn(async () => []), readAssetField: vi.fn(async () => null),
    } as never,
  };
}

describe('C880-REPRO — défaut AVANT correction (regex du commit 1553d0e, sans frontières de mot)', () => {
  const AVANT = /co[uû]ts? (total|totaux|global|globaux|complet|r[ée]el) de (possession|d[ée]tention)|co[uû]ts? annuels?( moyens?)?|co[uû]ts? nets?( estim[ée]s?)?|co[uû]ts? de (possession|d[ée]tention)|tco|co[uû]t total|co[uû]t global|au total|combien|m['’]?a|co[uû]t[ée]?|me|de|d['’]|poss[ée]der|avoir|quel|est|le|la|mon|ma/gi;
  const APRES = wholeWords(AVANT.source);
  const net = (s: string) => s.replace(/\s+/g, ' ').trim();
  it('« Quel est le coût de possession de Maison ? » devenait « ison ? » ; corrigé : « Maison ? »', () => {
    expect(net('Quel est le coût de possession de Maison ?'.replace(AVANT, ' '))).toBe('ison ?');
    expect(net('Quel est le coût de possession de Maison ?'.replace(APRES, ' '))).toBe('Maison ?');
  });
  it.each([['Mercedes', 'rce s'], ['Chalet', 'Cha t'], ['Tesla', 'Tes'], ['Lemans', 'ns'], ['Estafette', 'afette']])('%s : altéré avant (« %s »), intact après', (n, altere) => {
    expect(net(n.replace(AVANT, ' '))).toBe(altere);
    expect(net(n.replace(APRES, ' '))).toBe(n);
  });
  it('mots grammaticaux entiers toujours retirés ; « d’ » et « m’a » collés au mot suivant', () => {
    expect(net('Combien m’a coûté la Résidence l’Étoile au total ?'.replace(APRES, ' '))).toBe('Résidence l’Étoile ?');
    expect(net('Quel est le coût de possession d’Estafette ?'.replace(APRES, ' '))).toBe('Estafette ?');
  });
});

describe('C880-MATRIX — noms × stratégies auditées : la résolution du bien reçoit le nom intact (CA02)', () => {
  const GABARITS: Array<[string, (n: string) => string]> = [
    ['coût de possession', (n) => `Quel est le coût de possession de ${n} ?`],
    ['coût total de possession', (n) => `Quel est le coût total de possession de ${n} ?`],
    ['TCO', (n) => `Quel est le TCO de ${n} ?`],
    ['« de » + nom', (n) => `coût de possession de ${n}`],
    ['sinistres', (n) => `Où en est le sinistre de ${n} ?`],
    ['historique', (n) => `Qu’est-ce qui a été fait sur ${n} ?`],
    ['contrats', (n) => `Quel est mon contrat d’assurance pour ${n} ?`],
    ['payé', (n) => `Combien ai-je payé pour ${n} ?`],
    ['informations manquantes', (n) => `Quelles informations manquent pour ${n} ?`],
    ['thème de dépense', (n) => `Combien ai-je dépensé en entretien pour ${n} ?`],
    ['échéances', (n) => `Quelles sont les prochaines échéances de ${n} ?`],
  ];
  for (const [strategie, q] of GABARITS) {
    it.each(NOMS)(`${strategie} — %s`, async (nom) => {
      const calls: string[] = [];
      const { p } = port({ biens: [{ id: 1, name: nom }] });
      await tryCanonicalStructured({ port: p, accountId: 1, message: q(nom), resolveScope: resolveur([{ id: 1, name: nom }], calls) }).catch(() => null);
      expect(calls.length, q(nom)).toBeGreaterThan(0);
      const recu = new Set(mots(calls[0]));
      for (const w of mots(nom).filter((x) => !['les', 'des', 'du'].includes(x))) expect(recu.has(w), `${q(nom)} → « ${calls[0]} »`).toBe(true);
      // Nom ENTIER conservé à l'identique (zones protégées : aucune réécriture du nom).
      expect(calls[0].normalize('NFC').includes(nom.normalize('NFC')) || plain(calls[0]).includes(plain(nom)), `${q(nom)} → « ${calls[0]} »`).toBe(true);
    });
  }
  it('variantes « ma maison », « de Maison », « coût total de possession », « TCO » : même bien, même ID', async () => {
    const biens = [{ id: 41, name: 'Maison' }, { id: 42, name: 'Polo' }];
    for (const q of ['Quel est le coût de possession de ma maison ?', 'Quel est le coût de possession de Maison ?', 'Quel est le coût total de possession de Maison ?', 'Quel est le TCO de Maison ?', 'Combien me coûte de posséder Maison ?']) {
      const { p, readOwnershipCost } = port({ biens });
      const r = await tryCanonicalStructured({ port: p, accountId: 1, message: q, resolveScope: resolveur(biens) }) as unknown as { strategy?: string; reading?: { assetId: number } };
      expect(r?.strategy, q).toBe('structured.ownership_cost');
      expect(readOwnershipCost, q).toHaveBeenCalledWith(1, 41);
      expect(r.reading?.assetId, q).toBe(41);
    }
  });
});

describe('C880-TCO — issues explicites de la branche coût de possession (CA03)', () => {
  const MAISON = { id: 41, name: 'Maison' };
  const POLO = { id: 42, name: 'Polo' };
  const q = 'Quel est le coût de possession de Maison ?';

  it('Premium / Duo / essai : moteur TCO partagé, ID exact, réponse IDENTIQUE à celle de la fiche, sans IA', async () => {
    const { p, readOwnershipCost } = port({ biens: [MAISON, POLO] });
    const r = await tryCanonicalStructured({ port: p, accountId: 9, message: q, resolveScope: resolveur([MAISON, POLO]) }) as unknown as Record<string, unknown> & { answer: string; reading: Record<string, unknown> };
    expect(readOwnershipCost).toHaveBeenCalledTimes(1);
    expect(readOwnershipCost).toHaveBeenCalledWith(9, 41);
    const attendu = ownershipCostAnswer(MAISON as never, poloTco()) as { answer: string; sources: unknown[] };
    expect(r.answer).toBe(attendu.answer);
    expect(r.sources).toEqual(attendu.sources);
    expect(r.reading).toEqual({
      reading: 'OWNERSHIP_COST', strategyCandidate: 'structured.ownership_cost', strategyExecuted: 'structured.ownership_cost', phrasing: 'EXPLICIT',
      assetResolution: 'NAME', assetId: 41, outcome: 'ANSWERED', aiCall: 'NOT_NEEDED_DETERMINISTIC',
    });
    expect(r.diagnostic).toBeUndefined();
  });
  it('Standard : message Premium / Premium Duo, AUCUN montant, TCO jamais lu', async () => {
    const { p, readOwnershipCost } = port({ allowed: false, biens: [MAISON] });
    const r = await tryCanonicalStructured({ port: p, accountId: 9, message: q, resolveScope: resolveur([MAISON]) }) as unknown as { answer: string; reading: Record<string, unknown> };
    expect(r.answer.startsWith(TCO_PREMIUM_MESSAGE)).toBe(true);
    expect(r.answer).not.toMatch(MONTANT);
    expect(readOwnershipCost).not.toHaveBeenCalled();
    expect(r.reading).toMatchObject({ outcome: 'LOCKED', assetId: 41 });
  });
  it('homonymes : clarification (aucun bien choisi, aucune lecture)', async () => {
    const biens = [{ id: 1, name: 'Maison' }, { id: 2, name: 'Maison' }];
    const { p, readOwnershipCost } = port({ biens });
    const r = await tryCanonicalStructured({ port: p, accountId: 9, message: q, resolveScope: resolveur(biens) }) as unknown as { ambiguous: Bien[]; reason: string; reading: Record<string, unknown> };
    expect(r.ambiguous.map((b) => b.id)).toEqual([1, 2]);
    expect(r.reason).toBe('TCO_MULTIPLE_ASSETS');
    expect(r.reading).toMatchObject({ outcome: 'CLARIFICATION', assetResolution: 'AMBIGUOUS' });
    expect(readOwnershipCost).not.toHaveBeenCalled();
  });
  it('bien introuvable : « bien non identifié » avec la désignation intacte et les biens du compte — jamais « rien trouvé »', async () => {
    const { p, readOwnershipCost } = port({ biens: [MAISON, POLO] });
    const r = await tryCanonicalStructured({ port: p, accountId: 9, message: 'Quel est le coût de possession de Maisonnette ?', resolveScope: resolveur([MAISON, POLO]) }) as unknown as { strategy: string; answer: string; diagnostic: string; reading: Record<string, unknown>; kind: string };
    expect(r.strategy).toBe('structured.ownership_cost');
    expect(r.diagnostic).toBe('TARGET_NOT_FOUND');
    expect(r.answer).toMatch(/^Je n’ai pas identifié le bien « Maisonnette » parmi vos biens actifs\./);
    expect(r.answer).toContain('Vos biens : Maison et Polo.');
    expect(r.answer).not.toMatch(/rien trouvé|MONTANT/);
    expect(r.answer).not.toMatch(MONTANT);
    expect(r.reading).toMatchObject({ outcome: 'TARGET_NOT_FOUND', assetResolution: 'NOT_FOUND', assetId: null });
    expect(readOwnershipCost).not.toHaveBeenCalled();
  });
  it('question explicite sans bien désigné : bien unique lu ; plusieurs biens → clarification ; aucun bien → diagnostic', async () => {
    const q0 = 'Quel est le coût de possession ?';
    const un = port({ biens: [MAISON] });
    const r1 = await tryCanonicalStructured({ port: un.p, accountId: 9, message: q0, resolveScope: resolveur([MAISON]) }) as unknown as { reading: Record<string, unknown> };
    expect(un.readOwnershipCost).toHaveBeenCalledWith(9, 41);
    expect(r1.reading).toMatchObject({ outcome: 'ANSWERED', assetResolution: 'SINGLE_ASSET', assetId: 41 });
    const deux = port({ biens: [MAISON, POLO] });
    const r2 = await tryCanonicalStructured({ port: deux.p, accountId: 9, message: q0, resolveScope: resolveur([MAISON, POLO]) }) as unknown as { ambiguous: Bien[]; reason: string };
    expect(r2.reason).toBe('TCO_ASSET_REQUIRED');
    expect(r2.ambiguous.map((b) => b.id)).toEqual([41, 42]);
    expect(deux.readOwnershipCost).not.toHaveBeenCalled();
    const zero = port({ biens: [] });
    const r3 = await tryCanonicalStructured({ port: zero.p, accountId: 9, message: q0, resolveScope: resolveur([]) }) as unknown as { answer: string; reading: Record<string, unknown> };
    expect(r3.answer).toMatch(/Aucun bien actif/);
    expect(r3.reading).toMatchObject({ outcome: 'NO_ASSET' });
  });
  it('bien supprimé / d’un autre compte : « plus disponible » ; erreur de lecture : « lecture impossible » — aucun montant, états distincts', async () => {
    const supprime = port({ biens: [MAISON], tco: async () => { const e = new Error('Bien introuvable.'); e.name = 'AssetNotFoundForTcoError'; throw e; } });
    const r1 = await tryCanonicalStructured({ port: supprime.p, accountId: 9, message: q, resolveScope: resolveur([MAISON]) }) as unknown as { answer: string; diagnostic: string; reading: Record<string, unknown> };
    expect(r1.diagnostic).toBe('TARGET_UNAVAILABLE');
    expect(r1.answer).toMatch(/plus disponible/);
    expect(r1.reading).toMatchObject({ outcome: 'TARGET_UNAVAILABLE', assetId: 41 });
    const panne = port({ biens: [MAISON], tco: async () => { throw new Error('ECONNRESET'); } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r2 = await tryCanonicalStructured({ port: panne.p, accountId: 9, message: q, resolveScope: resolveur([MAISON]) }) as unknown as { answer: string; diagnostic: string; reading: Record<string, unknown>; kind: string };
    err.mockRestore();
    expect(r2.diagnostic).toBe('TECHNICAL_READ_FAILURE');
    expect(r2.answer).toMatch(/^Une erreur technique m’empêche de lire cette information/);
    expect(r2.answer).toContain('Le coût de possession de Maison reste consultable depuis sa fiche.');
    expect(r2.answer).not.toMatch(MONTANT);
    expect(r2.reading).toMatchObject({ outcome: 'READ_ERROR', strategyExecuted: 'structured.ownership_cost' });
  });
});

describe('C880-BROAD — formes larges : parcours inchangé (barrière #419, compréhension)', () => {
  it('question explicite vs large', () => {
    expect(isExplicitOwnershipCostQuestion('Quel est le coût de possession de Maison ?')).toBe(true);
    expect(isExplicitOwnershipCostQuestion('Quel est le TCO de Maison ?')).toBe(true);
    expect(isExplicitOwnershipCostQuestion('Quel est le coût total de possession de Maison ?')).toBe(true);
    expect(isExplicitOwnershipCostQuestion('Combien m’a coûté internet au total ?')).toBe(false);
  });
  it('« combien m’a coûté internet au total ? » : jamais un « bien non identifié » (la compréhension reprend)', async () => {
    const { p, readOwnershipCost } = port({ biens: [{ id: 41, name: 'Maison' }] });
    const r = await tryCanonicalStructured({ port: p, accountId: 9, message: 'Combien m’a coûté internet au total ?', resolveScope: resolveur([{ id: 41, name: 'Maison' }]) }) as unknown as Record<string, unknown> | null;
    expect(r && 'diagnostic' in r ? r.diagnostic : null).not.toBe('TARGET_NOT_FOUND');
    expect(readOwnershipCost).not.toHaveBeenCalled();
  });
});

describe('C880-T2X — export BO d’une exécution T2 : trace, issue fonctionnelle, contenus selon l’habilitation', () => {
  it('issue fonctionnelle : lecture métier, puis diagnostic, puis état technique', () => {
    expect(functionalOutcome({ status: 'ok', errorCode: null }, { businessReading: { outcome: 'READ_ERROR' }, answeredBy: 'structured' })).toBe('READ_ERROR');
    expect(functionalOutcome({ status: 'ok', errorCode: null }, { diagnostic: 'SEARCH_NO_RESULT', answeredBy: 'retrieval' })).toBe('SEARCH_NO_RESULT');
    expect(functionalOutcome({ status: 'ok', errorCode: null }, { diagnostic: 'TECHNICAL_READ_FAILURE' })).toBe('READ_ERROR');
    expect(functionalOutcome({ status: 'error', errorCode: 'ASSISTANT_UNAVAILABLE' }, {})).toBe('TECHNICAL_ERROR');
    expect(functionalOutcome({ status: 'ok', errorCode: null }, { answeredBy: 'structured' })).toBe('ANSWERED');
  });
  const q = async (sql: string) => sql.includes('verebona_request_runs')
    ? [{ intent: 'ACCOUNT_FACT_ASSET', mode: 'deterministic', machine_final_state: 'READY', status: 'ok', error_code: null, source_count: 1, latency_ms: 40,
      retrieval_methods_json: { strategy: 'structured.ownership_cost', answeredBy: 'structured', aiCalls: 0, attempts: [{ level: 1, strategy: 'structured.ownership_cost', status: 'SUFFICIENT_STRUCTURED', reason: 'ANSWERED' }],
        businessReading: { reading: 'OWNERSHIP_COST', assetId: 41, outcome: 'ANSWERED' }, semantic: { secretIgnored: true } } }]
    : [{ id: 1, role: 'user', status: 'ready', created_at: '2026-11-28T13:58:43Z', len: 42, sha: 'aa', content: 'Quel est le coût de possession de Maison ?' },
      { id: 2, role: 'assistant', status: 'ready', mode: 'deterministic', created_at: '2026-11-28T13:58:44Z', len: 120, sha: 'bb', content: 'Chiffre clé : …' }];
  it('non habilité : question et réponse MASQUÉES (longueur + SHA-256), trace restituée, absences dites', async () => {
    const x = await readT2Exchange(q as never, 'f194e631', false);
    expect(x.outcome).toBe('ANSWERED');
    expect(x.question).toEqual({ $etat: 'masqué', messageId: 1, statut: 'ready', longueur: 42, sha256: 'aa', at: '2026-11-28T13:58:43.000Z' });
    expect(JSON.stringify(x)).not.toContain('Maison ?');
    expect((x.cascade as Record<string, unknown>).businessReading).toMatchObject({ assetId: 41 });
    expect((x.cascade as Record<string, unknown>).semantic).toBeUndefined();
    expect(x.absent).toContain('Aucun appel IA : réponse produite sans modèle (aiCalls = 0) — aucun échange modèle à restituer.');
  });
  it('habilité : texte inclus ; concordance demande / réponse / mode / issue / ID', async () => {
    const x = await readT2Exchange(q as never, 'f194e631', true) as Record<string, any>;
    expect(x.question).toMatchObject({ $etat: 'inclus', texte: 'Quel est le coût de possession de Maison ?' });
    expect(x.answer).toMatchObject({ $etat: 'inclus', texte: 'Chiffre clé : …' });
    expect(x.answerMode).toBe('deterministic');
    expect(x.run).toMatchObject({ intent: 'ACCOUNT_FACT_ASSET', mode: 'deterministic', status: 'ok' });
  });
  it('demande purgée : absences explicites, aucune valeur devinée', async () => {
    const x = await readT2Exchange((async () => []) as never, 'inconnue', true);
    expect(x).toMatchObject({ run: null, cascade: null, outcome: 'UNKNOWN', question: { $etat: 'absent' }, answer: { $etat: 'absent' } });
    expect((x.absent as string[]).length).toBeGreaterThanOrEqual(3);
  });
});
