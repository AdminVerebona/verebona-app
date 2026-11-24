/**
 * Lot 114Y (Trello #753, CDC T2 §8.1, §8.3, §8.5, §12.3, §12.4, §13.8 — D05, M11, M12) — RÉPONSES EN BLOCS.
 *
 *   B01  découpage : paragraphes, listes à puces, listes numérotées, annonce suivie de lignes ;
 *   B02  mise en évidence : montants en euros dans les paragraphes, passages marqués ; jamais dans une liste ;
 *   B03  un seul contenu factuel : les blocs portent exactement le texte de la réponse — rien d'ajouté, rien de perdu ;
 *   B04  API : blocs transmis seulement s'ils apportent quelque chose ; jamais pour une erreur ni une chronologie ;
 *        mêmes blocs pour le même texte (rejeu, historique) ;
 *   B05  client : blocs du serveur contrôlés ; forme invalide ou texte différent → blocs dérivés du texte ;
 *   B06  rendu : paragraphes, listes sémantiques, gras ; aucun HTML du texte n'est interprété ; jetons de la charte.
 */
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

(globalThis as { React?: typeof React }).React = React;

vi.mock('@/services/verebona-assistant/config/assistant-flags.server', () => ({ isAssistantFlagOn: () => true }));

const { buildAnswerBlocks, answerBlocksText, isPlainAnswer, parseAnswerBlocks, answerBlocksFor } = await import('../answer-blocks');
const { toApiPayload, answerBlocksForApi } = await import('@/services/verebona-assistant/core/api-payload');
const { AnswerBlocks } = await import('@/components/verebona/space/AnswerBlocks');

const p = (...spans: Array<string | [string]>) => ({ kind: 'paragraph' as const, spans: spans.map((s) => (Array.isArray(s) ? { text: s[0], strong: true as const } : { text: s })) });
const li = (...items: string[]) => items.map((t) => [{ text: t }]);

const AIDE = 'Pour ajouter un document :\n1. Ouvrez le bien.\n2. Choisissez « Ajouter un document ».\n3. Sélectionnez le fichier.\n\nÀ noter : les formats PDF et image sont acceptés.';
const RESULTATS = 'J’ai effectué 2 actions.\n• ✓ Bien « Clio » renommé en « Clio de Paul ».\n• ✗ Ce nom ne peut pas être enregistré tel quel : rien n’a été modifié.';
const PREMIUM = 'Votre vélo a coûté 2 023 € à l’achat. Son coût total de possession documenté est de 2 974,53 €, achat inclus.';

describe('L114Y-B01 — découpage en blocs', () => {
  it('étapes numérotées et réserve : paragraphe d’annonce, liste numérotée, paragraphe', () => {
    expect(buildAnswerBlocks(AIDE)).toEqual([
      p('Pour ajouter un document :'),
      { kind: 'list', ordered: true, items: li('Ouvrez le bien.', 'Choisissez « Ajouter un document ».', 'Sélectionnez le fichier.') },
      p('À noter : les formats PDF et image sont acceptés.'),
    ]);
  });

  it('résultat d’un plan : phrase puis liste à puces (une ligne par action)', () => {
    expect(buildAnswerBlocks(RESULTATS)).toEqual([
      p('J’ai effectué 2 actions.'),
      { kind: 'list', ordered: false, items: li('✓ Bien « Clio » renommé en « Clio de Paul ».', '✗ Ce nom ne peut pas être enregistré tel quel : rien n’a été modifié.') },
    ]);
  });

  it('annonce suivie de lignes sans puce : ces lignes forment une liste ; la note entre parenthèses reste un paragraphe', () => {
    expect(buildAnswerBlocks('Échéances à venir :\nVidange — 12 mars 2027\nContrôle technique — 20 mars 2027\n(et 3 autres)')).toEqual([
      p('Échéances à venir :'),
      { kind: 'list', ordered: false, items: li('Vidange — 12 mars 2027', 'Contrôle technique — 20 mars 2027') },
      p('(et 3 autres)'),
    ]);
  });

  it('paragraphes séparés par une ligne vide ; une seule ligne après une annonce reste un paragraphe', () => {
    expect(buildAnswerBlocks('Première phrase.\n\nSeconde phrase.')).toEqual([p('Première phrase.'), p('Seconde phrase.')]);
    expect(buildAnswerBlocks('À noter :\nle fichier doit être lisible.')).toEqual([p('À noter :'), p('le fichier doit être lisible.')]);
  });

  it('un « 1. » isolé, une date ou un numéro en début de ligne ne font pas une liste', () => {
    expect(buildAnswerBlocks('1. Ouvrez le bien.')).toEqual([p('1. Ouvrez le bien.')]);
    expect(buildAnswerBlocks('2026. Année de l’achat.\n12 mars 2027 : vidange.')).toEqual([p('2026. Année de l’achat.'), p('12 mars 2027 : vidange.')]);
  });

  it('texte vide ou absent : aucun bloc', () => {
    expect(buildAnswerBlocks('')).toEqual([]);
    expect(buildAnswerBlocks(null)).toEqual([]);
    expect(buildAnswerBlocks('  \n \n')).toEqual([]);
  });
});

describe('L114Y-B02 — mise en évidence', () => {
  it('montants en euros d’un paragraphe (exemple B du CDC §8.4)', () => {
    expect(buildAnswerBlocks(PREMIUM)).toEqual([
      p('Votre vélo a coûté ', ['2 023 €'], ' à l’achat. Son coût total de possession documenté est de ', ['2 974,53 €'], ', achat inclus.'),
    ]);
  });

  it('espaces insécables, montant sans séparateur, « EUR »', () => {
    expect(buildAnswerBlocks('Total : 1 250,50 €.')[0]).toEqual(p('Total : ', ['1 250,50 €'], '.'));
    expect(buildAnswerBlocks('Prix : 1500 € ou 12 EUR.')[0]).toEqual(p('Prix : ', ['1500 €'], ' ou ', ['12 EUR'], '.'));
  });

  it('ni une date, ni un kilométrage, ni un nombre collé à une lettre', () => {
    for (const t of ['Achetée le 12 mars 2025, 45 000 km au compteur.', 'Référence A12 € inconnue.', 'Taux de 1.5 € par unité.']) {
      expect(buildAnswerBlocks(t)[0].kind === 'paragraph' && buildAnswerBlocks(t)[0]).toEqual(p(t));
    }
  });

  it('passage marqué « **…** » : mis en évidence, marqueurs jamais affichés', () => {
    expect(buildAnswerBlocks('Le calcul du **coût de possession** est disponible avec Premium.')).toEqual([
      p('Le calcul du ', ['coût de possession'], ' est disponible avec Premium.'),
    ]);
    expect(answerBlocksText(buildAnswerBlocks('Un ** isolé reste sans effet.'))).toBe('Un  isolé reste sans effet.');
  });

  it('dans une liste, aucun montant n’est mis en évidence (ils le seraient tous)', () => {
    const blocs = buildAnswerBlocks('Factures :\n• Garage Martin — 120 €\n• Norauto — 89,90 €');
    expect(blocs[1]).toEqual({ kind: 'list', ordered: false, items: li('Garage Martin — 120 €', 'Norauto — 89,90 €') });
  });
});

describe('L114Y-B03 — un seul contenu factuel', () => {
  const serre = (t: string) => t.replace(/\s+/g, '');
  /** Texte de la réponse sans ses marques de présentation (puces, numéros de liste, « ** »). */
  const sansMarques = (t: string) => t.split('\n').map((l) => l.replace(/^\s*(?:[•·▪◦*]|[-–—]|\d{1,2}[.)])\s+/, '')).join('\n').replace(/\*\*/g, '');

  it.each([
    AIDE, RESULTATS, PREMIUM,
    'Je ne trouve pas de date d’expiration fiable pour cette assurance dans vos données.',
    'Chronologie pour la Clio :\n• 12/03/2025 — Vidange (120 €)\n• 14/05/2025 — Contrôle technique\n(2 événements plus anciens)',
    'Votre vélo a été acheté **2 023 €**. Le calcul de son **coût de possession** est disponible avec Premium.',
    'L’export « Export données brutes » de Clio est prêt. Il reste disponible 30 jours dans les exports de ce bien.',
    '<script>alert(1)</script> [lien](https://exemple.test) <b>gras</b>',
  ])('les blocs portent exactement le texte : %#', (texte) => {
    expect(serre(answerBlocksText(buildAnswerBlocks(texte)))).toBe(serre(sansMarques(texte)));
  });

  it('une liste numérotée garde ses éléments dans l’ordre du texte', () => {
    const b = buildAnswerBlocks(AIDE)[1];
    expect(b.kind === 'list' && b.items.map((i) => i[0].text)).toEqual(['Ouvrez le bien.', 'Choisissez « Ajouter un document ».', 'Sélectionnez le fichier.']);
  });
});

describe('L114Y-B04 — API', () => {
  const resultat = (over: Record<string, unknown>) => ({
    requestId: 'r', messageId: '1', finalState: 'READY', mode: 'deterministic', answer: '', claims: [], sources: [], actions: [],
    clarification: null, route: { intent: 'ACCOUNT_FACT_ASSET' }, ...over,
  }) as never;

  it('réponse en un paragraphe simple : aucun bloc transmis (contrat inchangé)', () => {
    expect(answerBlocksForApi('Votre Clio est assurée chez Allianz.')).toBeNull();
    expect(toApiPayload(resultat({ answer: 'Votre Clio est assurée chez Allianz.' }))).not.toHaveProperty('answerBlocks');
  });

  it('réponse structurée ou avec montant : blocs transmis, `answer` inchangé', () => {
    const api = toApiPayload(resultat({ answer: AIDE }));
    expect(api.answer).toBe(AIDE);
    expect(api.answerBlocks).toEqual(buildAnswerBlocks(AIDE));
    expect(toApiPayload(resultat({ answer: PREMIUM })).answerBlocks).toEqual(buildAnswerBlocks(PREMIUM));
  });

  it('jamais pour une erreur ni pour une chronologie', () => {
    expect(toApiPayload(resultat({ answer: AIDE, error: { code: 'ASSISTANT_UNAVAILABLE', message: 'x', recoverable: true } }))).not.toHaveProperty('answerBlocks');
    expect(toApiPayload(resultat({ answer: AIDE, events: [{ date: '2025-03-12', text: 'Vidange', href: null, ref: null }] }))).not.toHaveProperty('answerBlocks');
  });

  it('rejeu et historique : le même texte enregistré donne les mêmes blocs', () => {
    expect(answerBlocksForApi(AIDE)).toEqual(answerBlocksForApi(String(AIDE)));
    expect(answerBlocksFor(AIDE)).toEqual(toApiPayload(resultat({ answer: AIDE })).answerBlocks);
  });

  it('la route des messages rend les blocs au rejeu d’une demande', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/verebona/messages/route.ts'), 'utf8');
    // Règle inchangée, écriture déplacée (carte #790) : les blocs du rejeu sont calculés depuis le texte enregistré,
    // désormais par une variable locale posée avant la réponse.
    expect(route).toMatch(/const blocs = answerBlocksForApi\(deja\.content\)/);
    expect(route).toMatch(/answerBlocks: blocs/);
    expect(route).toMatch(/resultGroups: deja\.resultGroups/);
  });
});

describe('L114Y-B05 — blocs reçus par le client', () => {
  it('blocs du serveur valides et de même texte : repris', () => {
    const recus = JSON.parse(JSON.stringify(buildAnswerBlocks(AIDE)));
    expect(answerBlocksFor(AIDE, recus)).toEqual(buildAnswerBlocks(AIDE));
    expect(parseAnswerBlocks(recus)).toEqual(buildAnswerBlocks(AIDE));
  });

  it.each([
    [[{ kind: 'html', html: '<b>x</b>' }]],
    [[{ kind: 'paragraph', spans: [{ text: 'x', href: 'https://exemple.test' , strong: 'oui' }] }]],
    [[{ kind: 'list', ordered: 'non', items: [] }]],
    [[{ kind: 'paragraph', spans: 'texte' }]],
    ['texte'],
    [[]],
  ])('forme invalide : refusée (%#)', (brut) => {
    expect(parseAnswerBlocks(brut)).toBeNull();
    expect(answerBlocksFor(AIDE, brut)).toEqual(buildAnswerBlocks(AIDE));
  });

  it('blocs valides mais d’un AUTRE texte : ignorés — seul le texte de la réponse est affiché', () => {
    const autres = [{ kind: 'paragraph', spans: [{ text: 'Votre vélo a coûté 9 999 €.' }] }];
    expect(parseAnswerBlocks(autres)).not.toBeNull();
    expect(answerBlocksFor('Votre vélo a coûté 2 023 €.', autres)).toEqual(buildAnswerBlocks('Votre vélo a coûté 2 023 €.'));
  });

  it('paragraphe simple', () => {
    expect(isPlainAnswer(buildAnswerBlocks('Bonjour.'))).toBe(true);
    expect(isPlainAnswer(buildAnswerBlocks(PREMIUM))).toBe(false);
    expect(isPlainAnswer(buildAnswerBlocks(AIDE))).toBe(false);
  });
});

describe('L114Y-B06 — rendu', () => {
  const rendre = (texte: string, variant: 'desktop' | 'mobile' = 'desktop') =>
    renderToStaticMarkup(h(AnswerBlocks, { blocks: buildAnswerBlocks(texte), variant }));

  it('paragraphes, liste numérotée sémantique, réserve', () => {
    const html = rendre(AIDE);
    expect(html).toContain('<p class="m-0"><span>Pour ajouter un document :</span></p>');
    // Règle remplacée (carte #790, relance du 21/11) : la liste porte en plus le NOM de son annonce pour un lecteur d'écran
    // (`aria-label`), et un repère de bloc ; sa classe, ses éléments et son texte sont inchangés.
    expect(html).toMatch(/<ol class="[^"]*list-decimal[^"]*" data-answer-block="list" aria-label="Pour ajouter un document"><li class="pl-0\.5"><span>Ouvrez le bien\.<\/span><\/li>/);
    expect(html.match(/<li /g)).toHaveLength(3);
    expect(html).toContain('À noter : les formats PDF et image sont acceptés.');
  });

  it('liste à puces et montants en gras', () => {
    // Règle remplacée (carte #790, relance du 21/11) : la balise de la liste porte aussi son repère de bloc (et son nom s'il y a une annonce).
    expect(rendre(RESULTATS)).toMatch(/<ul class="[^"]*list-disc[^"]*" data-answer-block="list"[^>]*>/);
    const html = rendre(PREMIUM);
    expect(html.match(/<strong /g)).toHaveLength(2);
    expect(html).toContain('>2 023 €</strong>');
  });

  it('aucun HTML du texte n’est interprété', () => {
    const html = rendre('<script>alert(1)</script> <a href="https://exemple.test">lien</a>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<a ');
    expect(html).toContain('&lt;script&gt;');
  });

  it('ordinateur et mobile : mêmes blocs, taille de texte de chaque variante', () => {
    expect(rendre(AIDE, 'desktop')).toContain('text-[14.5px]');
    expect(rendre(AIDE, 'mobile')).toContain('text-[15px]');
    expect(rendre(AIDE, 'mobile').replace('text-[15px]', 'text-[14.5px]')).toBe(rendre(AIDE, 'desktop'));
  });

  it('charte : jetons seulement, aucune couleur brute ; l’espace de réponse utilise ce rendu', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/verebona/space/AnswerBlocks.tsx'), 'utf8');
    // Code seul : le commentaire d'en-tête cite le numéro de la carte.
    expect(src.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
    expect(src).toContain('var(--text-primary)');
    const espace = readFileSync(join(process.cwd(), 'src/components/verebona/space/SpaceContent.tsx'), 'utf8');
    expect(espace).toContain('<AnswerBlocks');
    expect(espace).toContain('answerBlocksFor(msg.content, msg.answerBlocks)');
  });
});
