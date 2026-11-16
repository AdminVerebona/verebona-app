/**
 * Passage 114Z3 (Trello #753, CDC T2 §7.6, §8.1, §8.2, §8.3 — D24, M11, M13) — LIEN TEXTUEL vers l'article d'aide
 * et RÉPONSES EN BLOCS (tableau de comparaison, titres), de bout en bout sur PostgreSQL réel.
 *
 * `runAssistant` + ports réels : corpus d'aide chargé par HTTP (`fetch` simulé, aucun réseau, aucun fournisseur
 * d'IA), actions résolues et contrôlées en base, réponse et actions persistées.
 *
 *   E01  question d'aide : l'action de l'article porte son TITRE (corpus serveur) ; la même demande rejouée
 *        restitue le même titre ; la recherche du Centre d'aide garde son bouton ;
 *   E02  réponse comparative validée : tableau et titre transmis en blocs, identiques au rejeu ; le texte de la
 *        réponse n'est pas modifié ; une réponse sans tableau reste présentée comme avant.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { demander, useTargetState } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Json = Record<string, any>;
const BRUT = JSON.parse(readFileSync(join(__dirname, '../fixtures/help-corpus-t2.snapshot.json'), 'utf8')) as Record<string, unknown>;
const publie = (environment: string, version: string) => JSON.stringify({ ...BRUT, environment, version });

scenario('L114Z3-AIDE-BLOCS', 'Passage 114Z3 — lien textuel vers l’article d’aide, tableau et titres en blocs', ({ sql, make, useRecordings: rejouerSortie }) => {
  useTargetState({ NEXT_PUBLIC_APP_ENV: 'preprod', NEXT_PUBLIC_PUBLIC_SITE_URL: 'https://preprod.verebona.fr' }, { masters: ['T1', 'T2'] });

  const env = { version: 0 };
  const fetchMock = vi.fn(async (..._a: unknown[]) =>
    new Response(publie('preprod', `v-z3-${env.version}`), { status: 200, headers: { 'content-type': 'application/json' } }));

  beforeEach(async () => {
    const hc = await import('@/services/verebona-assistant/core/help-corpus.service');
    hc.resetHelpCorpusCacheForTests();
    hc.setHelpCorpusStoreForTests(hc.dbHelpCorpusStore);
    env.version += 1;
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    const hc = await import('@/services/verebona-assistant/core/help-corpus.service');
    hc.setHelpCorpusStoreForTests(null);
    hc.resetHelpCorpusCacheForTests();
  });

  const compte = async (): Promise<Compte> => { const a = await make.account({ plan: 'premium' }); return { id: a.id, ownerUserId: a.ownerUserId }; };
  const voiture = async (c: Compte, name: string, prix: number) => {
    const b = await make.asset(c as never, { name, category: 'VEHICULE' });
    await sql`UPDATE assets SET status = 'EN_SERVICE', deleted_at = NULL, purchase_price_cents = ${prix * 100} WHERE id = ${b.id}`;
    return b.id as number;
  };

  it('E01 — question d’aide : l’article s’annonce par son titre, à la réponse et au rejeu', async () => {
    const c = await compte();
    const replay = await rejouerSortie([]);
    const clientRequestId = `l114z3-${Math.random()}`;
    const r = await demander(c, 'Comment ajouter un document ?', { clientRequestId, pageContext: { route: '/documents', platform: 'web' } });
    expect(replay.calls).toHaveLength(0);
    const article = r.actions.find((a) => a.type === 'OPEN_HELP');
    // Titre de l'article du corpus (serveur), adresse construite par le serveur, intitulé du bouton conservé.
    expect(article).toMatchObject({ linkTitle: 'Ajouter un document', href: '/aide?page=%2Faide%2Fajouter-un-document', label: 'Lire l’article' });

    // Le titre part au client avec l'action, et rien d'autre n'est ajouté à la réponse.
    const { toApiPayload } = await import('@/services/verebona-assistant/core/api-payload');
    const envoye = toApiPayload(r as never);
    expect(envoye.actions.find((a) => a.type === 'OPEN_HELP')).toMatchObject({ linkTitle: 'Ajouter un document' });
    expect(envoye.answer).toBe(r.answer);

    // Enregistré avec l'action : la MÊME demande rejouée restitue le même lien textuel.
    const [persistee] = await sql<Json[]>`
      SELECT a.payload_json AS p FROM verebona_message_actions a JOIN verebona_messages m ON m.id = a.message_id
       WHERE m.request_id = ${r.requestId} AND a.action_type = 'OPEN_HELP'`;
    expect(persistee.p).toMatchObject({ linkTitle: 'Ajouter un document' });
    const { findReplayedAnswer } = await import('@/services/verebona-assistant/core/conversation.service');
    const rejeu = await findReplayedAnswer(c.id, c.ownerUserId, clientRequestId);
    expect(rejeu!.actions.find((a) => a.type === 'OPEN_HELP')).toMatchObject({ linkTitle: 'Ajouter un document' });
  });

  it('E02 — une demande sans article précis ne porte aucun titre : l’action garde son bouton', async () => {
    const c = await compte();
    await rejouerSortie([]);
    const r = await demander(c, 'Ouvre le centre d’aide');
    for (const a of r.actions.filter((x) => x.type === 'OPEN_HELP')) {
      expect(a.linkTitle ?? null).toBeNull();
      expect(a.label).toBe('Ouvrir l’aide');
    }
  });

  it('E03 — texte validé portant un tableau et un titre : blocs rendus et rejoués à l’identique, rien de plus stocké', async () => {
    const c = await compte();
    await voiture(c, 'Clio', 12000);
    await voiture(c, 'Polo', 9500);
    const clientRequestId = `l114z3-cmp-${Math.random()}`;
    await rejouerSortie([]);
    const r = await demander(c, 'Compare mes deux voitures', { clientRequestId });
    expect(r.route.intent).toBe('ACCOUNT_COMPARISON');

    // Une comparaison rédigée en lignes « | … | » : le texte VALIDÉ et enregistré est la seule source de la
    // présentation (aucune colonne, aucun champ de plus). Il est écrit ici dans le message réellement persisté :
    // le modèle n'écrit un tel texte que si le prompt le lui demande (bloc PO n° 40, second passage).
    const TEXTE = '## Comparaison\n'
      + 'Voici les deux voitures.\n'
      + '| Caractéristique | Clio | Polo |\n'
      + '|---|---|---|\n'
      + '| Prix d’achat | 12 000 € | 9 500 € |';
    await sql`UPDATE verebona_messages SET content = ${TEXTE} WHERE request_id = ${r.requestId} AND role = 'assistant'`;

    const { answerBlocksForApi } = await import('@/services/verebona-assistant/core/api-payload');
    const { findReplayedAnswer } = await import('@/services/verebona-assistant/core/conversation.service');
    const rejeu = await findReplayedAnswer(c.id, c.ownerUserId, clientRequestId);
    expect(rejeu!.content).toBe(TEXTE);
    const blocs = answerBlocksForApi(rejeu!.content);
    expect(blocs?.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'table']);
    const table = blocs!.find((b) => b.kind === 'table');
    expect(table).toEqual({
      kind: 'table',
      header: [[{ text: 'Caractéristique' }], [{ text: 'Clio' }], [{ text: 'Polo' }]],
      rows: [[[{ text: 'Prix d’achat' }], [{ text: '12 000 €' }], [{ text: '9 500 €' }]]],
    });
    // Rien n'est enregistré en plus du texte : aucune colonne de blocs.
    const [col] = await sql<Json[]>`
      SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'verebona_messages' AND column_name LIKE '%block%'`;
    expect(col.n).toBe(0);
  });
});
