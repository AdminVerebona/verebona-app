/**
 * Passage 114Z3 (Trello #753, CDC T2 §7.6, §8.1, §8.2, §8.3 — D24, M11, M13) — TABLEAU DE COMPARAISON,
 * TITRES DE SECTION et LIEN TEXTUEL vers l'article d'aide.
 *
 *   T01  tableau : lignes « | … | … | » du texte validé, en-tête reconnu, tableau irrégulier refusé ;
 *   T02  titres de section : « ## Titre » et ligne entièrement marquée ; une annonce de liste n'en est pas un ;
 *   T03  un seul contenu factuel : les blocs portent exactement le texte (barres, dièses et « ** » exceptés) ;
 *   T04  blocs reçus du serveur : forme contrôlée (tableau irrégulier, trop de colonnes → texte) ;
 *   T05  rendu : vrai tableau accessible, lisible sur mobile (défilement DANS la réponse), titres discrets, jetons ;
 *   T06  lien textuel vers l'article : titre du corpus serveur, bouton conservé sans titre connu.
 */
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

(globalThis as { React?: typeof React }).React = React;

vi.mock('@/services/verebona-assistant/config/assistant-flags.server', () => ({ isAssistantFlagOn: () => true }));

const { buildAnswerBlocks, answerBlocksText, parseAnswerBlocks, answerBlocksFor } = await import('../answer-blocks');
const { answerBlocksForApi } = await import('@/services/verebona-assistant/core/api-payload');
const { AnswerBlocks } = await import('@/components/verebona/space/AnswerBlocks');
const { withHelpArticleLinks, helpArticleTitle } = await import('@/services/verebona-assistant/core/help-article-link');

type Bloc = ReturnType<typeof buildAnswerBlocks>[number];
const cel = (...cells: string[]) => cells.map((t) => [{ text: t }]);

const COMPARAISON = 'Voici la comparaison des deux voitures.\n'
  + '| Caractéristique | Clio | Polo |\n'
  + '|---|---|---|\n'
  + '| Date d’achat | 25 mai 2021 | 3 mars 2019 |\n'
  + '| Prix d’achat | 12 000 € | 9 500 € |\n'
  + 'Le kilométrage n’est renseigné que pour la Clio.';

describe('L114Z3-T01 — tableau de comparaison', () => {
  it('lignes « | … | » : un tableau, première ligne en en-tête quand « |---| » suit', () => {
    const blocs = buildAnswerBlocks(COMPARAISON);
    expect(blocs.map((b) => b.kind)).toEqual(['paragraph', 'table', 'paragraph']);
    expect(blocs[1]).toEqual({
      kind: 'table',
      header: cel('Caractéristique', 'Clio', 'Polo'),
      rows: [cel('Date d’achat', '25 mai 2021', '3 mars 2019'), cel('Prix d’achat', '12 000 €', '9 500 €')],
    });
  });

  it('sans ligne de séparation : aucun en-tête, toutes les lignes sont des lignes', () => {
    const blocs = buildAnswerBlocks('| Clio | 12 000 € |\n| Polo | 9 500 € |');
    expect(blocs).toEqual([{ kind: 'table', header: null, rows: [cel('Clio', '12 000 €'), cel('Polo', '9 500 €')] }]);
  });

  it('dans un tableau, aucun montant n’est mis en évidence (ils le seraient tous) ; un passage marqué l’est', () => {
    const [table] = buildAnswerBlocks('| Clio | 12 000 € |\n| Polo | **9 500 €** |') as [Extract<Bloc, { kind: 'table' }>];
    expect(table.rows[0][1]).toEqual([{ text: '12 000 €' }]);
    expect(table.rows[1][1]).toEqual([{ text: '9 500 €', strong: true }]);
  });

  it.each([
    ['une seule ligne', '| Clio | 12 000 € |'],
    ['une seule colonne', '| Clio |\n| Polo |'],
    ['largeurs différentes', '| Clio | 12 000 € |\n| Polo | 9 500 € | 2019 |'],
    ['trop de colonnes', `| ${Array.from({ length: 7 }, (_, i) => `c${i}`).join(' | ')} |\n| ${Array.from({ length: 7 }, () => 'x').join(' | ')} |`],
  ])('ce n’est pas un tableau (%s) : les lignes restent du texte, rien n’est perdu', (_cas, texte) => {
    const blocs = buildAnswerBlocks(texte);
    expect(blocs.every((b) => b.kind === 'paragraph')).toBe(true);
    // Chaque ligne du texte est rendue telle quelle (barres comprises) : rien n'est perdu.
    expect(answerBlocksText(blocs).split('\n')).toEqual(texte.split('\n'));
  });
});

describe('L114Z3-T02 — titres de section', () => {
  it('« ## Titre » : titre de section, marqueurs jamais affichés', () => {
    expect(buildAnswerBlocks('## Comparaison\nLes deux voitures sont proches.')).toEqual([
      { kind: 'heading', spans: [{ text: 'Comparaison' }] },
      { kind: 'paragraph', spans: [{ text: 'Les deux voitures sont proches.' }] },
    ]);
  });

  it('ligne entièrement marquée suivie de texte : titre de section', () => {
    const blocs = buildAnswerBlocks('**Dépenses documentées**\nVous avez 2 factures pour la Clio.');
    expect(blocs[0]).toEqual({ kind: 'heading', spans: [{ text: 'Dépenses documentées' }] });
  });

  it('une annonce de liste, une ligne marquée seule, ou une phrase longue ne sont pas des titres', () => {
    expect(buildAnswerBlocks('**Factures :**\n• Garage Martin — 120 €\n• Norauto — 89,90 €')[0].kind).toBe('paragraph');
    expect(buildAnswerBlocks('**Tout est à jour.**')[0].kind).toBe('paragraph');
    const longue = `**${'Un titre beaucoup trop long pour en être un, qui dépasse la borne de lecture rapide fixée par le module.'}**\nSuite.`;
    expect(buildAnswerBlocks(longue)[0].kind).toBe('paragraph');
  });

  it('un titre ne porte jamais de montant mis en évidence', () => {
    const [titre] = buildAnswerBlocks('## Coût total : 12 000 €\nDétail ci-dessous.');
    expect(titre).toEqual({ kind: 'heading', spans: [{ text: 'Coût total : 12 000 €' }] });
  });
});

describe('L114Z3-T03 — un seul contenu factuel', () => {
  const serre = (t: string) => t.replace(/\s+/g, '');
  /** Texte sans ses marques de présentation (barres du tableau, dièses du titre, « ** »). */
  const sansMarques = (t: string) => t.split('\n')
    .map((l) => l.replace(/^\s*#{1,4}\s+/, '').replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\|/g, ' '))
    .filter((l) => !/^[\s|:-]+$/.test(l))
    .join('\n').replace(/\*\*/g, '');

  it.each([
    COMPARAISON,
    '## Comparaison\n| Clio | 12 000 € |\n| Polo | 9 500 € |\n**Écart** : 2 500 €.',
  ])('les blocs portent exactement le texte : %#', (texte) => {
    expect(serre(answerBlocksText(buildAnswerBlocks(texte)))).toBe(serre(sansMarques(texte)));
  });

  it('API : mêmes blocs pour le même texte (rejeu, historique) ; le client retient ceux du serveur', () => {
    const envoyes = answerBlocksForApi(COMPARAISON);
    expect(envoyes).toEqual(buildAnswerBlocks(COMPARAISON));
    expect(answerBlocksFor(COMPARAISON, envoyes)).toEqual(envoyes);
    expect(answerBlocksForApi(COMPARAISON)).toEqual(envoyes);
  });
});

describe('L114Z3-T04 — blocs reçus du serveur', () => {
  it('tableau valide accepté ; en-tête facultatif', () => {
    expect(parseAnswerBlocks([{ kind: 'table', header: cel('A', 'B'), rows: [cel('1', '2')] }]))
      .toEqual([{ kind: 'table', header: cel('A', 'B'), rows: [cel('1', '2')] }]);
    expect(parseAnswerBlocks([{ kind: 'table', rows: [cel('1', '2')] }]))
      .toEqual([{ kind: 'table', header: null, rows: [cel('1', '2')] }]);
    expect(parseAnswerBlocks([{ kind: 'heading', spans: [{ text: 'Comparaison' }] }]))
      .toEqual([{ kind: 'heading', spans: [{ text: 'Comparaison' }] }]);
  });

  it.each([
    ['sans ligne', { kind: 'table', header: cel('A', 'B'), rows: [] }],
    ['ligne de largeur différente', { kind: 'table', header: cel('A', 'B'), rows: [cel('1', '2'), cel('1', '2', '3')] }],
    ['une seule colonne', { kind: 'table', header: null, rows: [[[{ text: '1' }]]] }],
    ['cellule qui n’est pas un fragment', { kind: 'table', header: null, rows: [['1', '2']] }],
    ['titre sans fragment', { kind: 'heading', spans: 'Comparaison' }],
  ])('forme refusée (%s) : le client présente la réponse à partir de son texte', (_cas, bloc) => {
    expect(parseAnswerBlocks([bloc])).toBeNull();
    expect(answerBlocksFor(COMPARAISON, [bloc])).toEqual(buildAnswerBlocks(COMPARAISON));
  });
});

describe('L114Z3-T05 — rendu', () => {
  const rendre = (texte: string, variant: 'desktop' | 'mobile' = 'desktop') =>
    renderToStaticMarkup(h(AnswerBlocks, { blocks: buildAnswerBlocks(texte), variant }));

  it('un vrai tableau, avec son en-tête de colonnes et sa première colonne en en-tête de ligne', () => {
    const html = rendre(COMPARAISON);
    expect(html).toContain('<table');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html.match(/<tr>/g)).toHaveLength(3);
    expect(html).toContain('25 mai 2021');
  });

  it('lisible sur mobile : le tableau défile dans la réponse, jamais la page', () => {
    const mobile = rendre(COMPARAISON, 'mobile');
    expect(mobile).toContain('overflow-x-auto');
    expect(mobile).toContain('max-w-full');
    expect(mobile).toContain('text-[14px]');
    expect(rendre(COMPARAISON, 'desktop')).toContain('text-[13.5px]');
  });

  it('titre de section discret, et aucun HTML du texte interprété dans un tableau', () => {
    expect(rendre('## Comparaison\nSuite.')).toMatch(/<h4 class="[^"]*text-\[13px\][^"]*">/);
    const html = rendre('| <b>gras</b> | <script>alert(1)</script> |\n| a | b |');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('charte : jetons seulement, aucune couleur brute', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/verebona/space/AnswerBlocks.tsx'), 'utf8');
    expect(src.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
    expect(src).toContain('var(--border)');
  });
});

describe('L114Z3-T06 — lien textuel vers l’article d’aide', () => {
  const article = (id: string, titre: string, path: string) => ({
    id: `help_${id}`, type: 'help_entry' as const, title: titre, content: '…', relevanceScore: 1,
    meta: { articleId: id, path },
  });
  const action = (payload: Record<string, string | number | boolean | null>, href = '/aide?page=/aide/ajouter-un-document') => ({
    actionId: 'a1', type: 'OPEN_HELP' as const, label: 'Lire l’article', href,
    requiresConfirmation: false, expiresAt: null, analyticsCode: 'verebona.action.open_help', payload,
  });

  it('titre de l’article pris sur la source du serveur (section ignorée)', () => {
    expect(helpArticleTitle({ title: 'Ajouter un document — Procédure' })).toBe('Ajouter un document');
    const [a] = withHelpArticleLinks([action({ path: '/aide/ajouter-un-document' })], [article('AID-DOC-001', 'Ajouter un document — Procédure', '/aide/ajouter-un-document')]);
    expect(a.linkTitle).toBe('Ajouter un document');
  });

  it('rapprochement par le CHEMIN seulement : un autre article ne donne jamais son titre', () => {
    const [a] = withHelpArticleLinks([action({ path: '/aide/ajouter-un-document' })], [article('AID-EXP-002', 'Préparer un export — Procédure', '/aide/preparer-un-export')]);
    expect(a.linkTitle).toBeUndefined();
  });

  it('recherche du Centre d’aide, aucune source d’aide, ou action sans adresse : le bouton est conservé', () => {
    expect(withHelpArticleLinks([action({ path: '/aide', search: true }, '/aide')], [article('A', 'Accueil — x', '/aide')])[0].linkTitle).toBeUndefined();
    expect(withHelpArticleLinks([action({ path: '/aide/ajouter-un-document' })], [])[0].linkTitle).toBeUndefined();
    expect(withHelpArticleLinks([{ ...action({ path: '/aide/ajouter-un-document' }), href: null }], [article('A', 'Ajouter un document — x', '/aide/ajouter-un-document')])[0].linkTitle).toBeUndefined();
  });

  it('une Ressource donne son titre ; une autre action n’est jamais transformée en lien', () => {
    const res = { ...article('RES-C01', 'Révision de voiture — Périodicité', '/ressources/revision-voiture'), id: 'help_RES-C01' };
    expect(withHelpArticleLinks([action({ path: '/ressources/revision-voiture' }, '/ressources/revision-voiture')], [res])[0].linkTitle)
      .toBe('Révision de voiture');
    const autre = { ...action({ path: '/aide/ajouter-un-document' }), type: 'OPEN_DOCUMENT' as const };
    expect(withHelpArticleLinks([autre], [article('A', 'Ajouter un document — x', '/aide/ajouter-un-document')])[0].linkTitle).toBeUndefined();
  });

  it('l’espace de réponse affiche ce lien sous la réponse, et ne le met pas dans les boutons', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/verebona/space/SpaceContent.tsx'), 'utf8');
    expect(src).toContain('data-help-link');
    expect(src).toContain('{a.linkTitle}');
    expect(src).toContain('!helpLinks.includes(a)');
    // Jamais de bouton de source : le renvoi à l'article n'est pas une pastille d'action.
    expect(src).not.toMatch(/pillClass\([^)]*\)[^\n]*linkTitle/);
  });
});
