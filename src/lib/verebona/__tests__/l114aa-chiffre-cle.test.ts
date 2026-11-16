/**
 * Passage 114AA (Trello #753, CDC T2 §8.1, §8.3, §13.8) — CHIFFRE CLÉ dans une réponse
 * (« chiffre clé si cela apporte de la clarté », dernière forme autorisée du §8.1 qui manquait).
 *
 *   C01  reconnaissance : une ligne « Chiffre clé : <valeur> — <légende> » du texte VALIDÉ ;
 *   C02  garde-fous : valeur courte et portant un chiffre, légende bornée, trois chiffres clés au plus —
 *        sinon la ligne reste un paragraphe et rien n'est perdu ;
 *   C03  rien d'ajouté, rien de retiré : le texte des blocs se relit mot pour mot (étiquette comprise) ;
 *   C04  blocs reçus du serveur : forme et bornes contrôlées avant affichage, sinon la réponse est
 *        présentée à partir de son texte ;
 *   C05  non-régression : les autres formes (paragraphe, liste, titre, tableau) sont inchangées.
 */
import { describe, expect, it } from 'vitest';
import {
  ETIQUETTE_CHIFFRE_CLE, answerBlocksFor, answerBlocksText, buildAnswerBlocks, isPlainAnswer, parseAnswerBlocks,
  type AnswerBlock,
} from '../answer-blocks';

const texte = (spans: Array<{ text: string }>) => spans.map((s) => s.text).join('');
const metric = (b: AnswerBlock) => (b.kind === 'metric' ? { valeur: texte(b.value), legende: b.caption ? texte(b.caption) : null } : null);

describe('L114AA-C01 — reconnaissance du chiffre clé', () => {
  it('valeur et légende', () => {
    const blocks = buildAnswerBlocks('Chiffre clé : 2 974,53 € — coût documenté de la Clio');
    expect(blocks).toHaveLength(1);
    expect(metric(blocks[0])).toEqual({ valeur: '2 974,53 €', legende: 'coût documenté de la Clio' });
  });

  it('valeur seule (aucune légende n’est inventée)', () => {
    expect(metric(buildAnswerBlocks('Chiffre clé : 52 000 km')[0])).toEqual({ valeur: '52 000 km', legende: null });
  });

  it('au milieu d’une réponse, entre paragraphes, listes et titres', () => {
    const blocks = buildAnswerBlocks([
      'Voici le coût de la Clio.',
      'Chiffre clé : 2 974,53 € — depuis l’achat',
      '## Détail',
      '- Entretien : 1 200 €',
      '- Assurance : 1 774,53 €',
    ].join('\n'));
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'metric', 'heading', 'list']);
  });

  it('casse et espaces libres (« chiffre  clé: … »)', () => {
    expect(metric(buildAnswerBlocks('chiffre  clé:  12 EUR — reste à payer')[0])).toEqual({ valeur: '12 EUR', legende: 'reste à payer' });
  });

  it('tirets acceptés comme séparateur de légende (— – -)', () => {
    for (const d of ['—', '–', '-']) {
      expect(metric(buildAnswerBlocks(`Chiffre clé : 3 biens ${d} dans votre compte`)[0])).toEqual({ valeur: '3 biens', legende: 'dans votre compte' });
    }
  });

  it('la valeur n’est jamais mise en gras en plus (la forme la met déjà en avant)', () => {
    const b = buildAnswerBlocks('Chiffre clé : 2 974,53 € — coût documenté')[0];
    expect(b.kind).toBe('metric');
    if (b.kind === 'metric') expect(b.value.some((s) => s.strong)).toBe(false);
  });

  it('un chiffre clé n’est pas une réponse « simple » : les blocs sont transmis', () => {
    expect(isPlainAnswer(buildAnswerBlocks('Chiffre clé : 52 000 km'))).toBe(false);
    expect(isPlainAnswer(buildAnswerBlocks('Le prix d’achat est de 12 500 €.'))).toBe(false); // montant mis en évidence
    expect(isPlainAnswer(buildAnswerBlocks('Je n’ai rien trouvé.'))).toBe(true);
  });
});

describe('L114AA-C02 — garde-fous : au moindre doute, la ligne reste un paragraphe', () => {
  it.each([
    ['sans aucun chiffre', 'Chiffre clé : beaucoup'],
    ['valeur trop longue', `Chiffre clé : ${'9'.repeat(41)}`],
    ['légende trop longue', `Chiffre clé : 12 € — ${'a'.repeat(81)}`],
    ['légende vide', 'Chiffre clé : 12 € — '],
    ['étiquette seule', 'Chiffre clé :'],
    ['étiquette au milieu d’une phrase', 'Le chiffre clé : 12 € est intéressant.'],
  ])('%s → paragraphe', (_cas, ligne) => {
    const blocks = buildAnswerBlocks(ligne);
    expect(blocks.every((b) => b.kind !== 'metric')).toBe(true);
    // Rien n'est perdu : le texte reste lisible tel qu'il a été validé.
    expect(answerBlocksText(blocks).replace(/\s+/g, ' ').trim()).toBe(ligne.replace(/\s+/g, ' ').trim());
  });

  it('trois chiffres clés au plus : au-delà, les lignes restent des paragraphes', () => {
    const blocks = buildAnswerBlocks([1, 2, 3, 4].map((n) => `Chiffre clé : ${n} €`).join('\n'));
    expect(blocks.map((b) => b.kind)).toEqual(['metric', 'metric', 'metric', 'paragraph']);
  });
});

describe('L114AA-C03 — rien d’ajouté, rien de retiré', () => {
  it.each([
    'Chiffre clé : 2 974,53 € — coût documenté de la Clio',
    'Chiffre clé : 52 000 km',
  ])('le texte des blocs se relit mot pour mot : %s', (ligne) => {
    expect(answerBlocksText(buildAnswerBlocks(ligne))).toBe(ligne);
  });

  it('l’étiquette affichée est celle de la ligne (aucun autre mot)', () => {
    expect(ETIQUETTE_CHIFFRE_CLE).toBe('Chiffre clé');
    expect(answerBlocksText(buildAnswerBlocks('Chiffre clé : 12 €'))).toContain(`${ETIQUETTE_CHIFFRE_CLE} : 12 €`);
  });

  it('réponse rejouée ou relue : mêmes blocs, rien de stocké en plus', () => {
    const t = 'Voici le bilan.\nChiffre clé : 2 974,53 € — coût documenté\nLe détail est dans la fiche.';
    const serveur = buildAnswerBlocks(t);
    // Le client retient les blocs du serveur parce qu'ils portent EXACTEMENT le texte enregistré.
    expect(answerBlocksFor(t, serveur)).toEqual(serveur);
    // Sans blocs transmis (ancienne réponse de l'historique) : les mêmes sont dérivés du texte.
    expect(answerBlocksFor(t)).toEqual(serveur);
  });

  it('des blocs qui ne portent pas le texte de la réponse sont écartés', () => {
    const faux: AnswerBlock[] = [{ kind: 'metric', value: [{ text: '9 999 €' }], caption: null }];
    expect(answerBlocksFor('Chiffre clé : 12 €', faux)).toEqual(buildAnswerBlocks('Chiffre clé : 12 €'));
  });
});

describe('L114AA-C04 — blocs reçus du serveur, contrôlés avant affichage', () => {
  it('forme valide : acceptée, avec ou sans légende', () => {
    expect(parseAnswerBlocks([{ kind: 'metric', value: [{ text: '12 €' }], caption: [{ text: 'reste' }] }]))
      .toEqual([{ kind: 'metric', value: [{ text: '12 €' }], caption: [{ text: 'reste' }] }]);
    expect(parseAnswerBlocks([{ kind: 'metric', value: [{ text: '12 €' }], caption: null }]))
      .toEqual([{ kind: 'metric', value: [{ text: '12 €' }], caption: null }]);
    expect(parseAnswerBlocks([{ kind: 'metric', value: [{ text: '12 €' }] }]))
      .toEqual([{ kind: 'metric', value: [{ text: '12 €' }], caption: null }]);
  });

  it.each([
    ['valeur vide', { kind: 'metric', value: [], caption: null }],
    ['valeur sans chiffre', { kind: 'metric', value: [{ text: 'beaucoup' }], caption: null }],
    ['valeur trop longue', { kind: 'metric', value: [{ text: '9'.repeat(41) }], caption: null }],
    ['légende trop longue', { kind: 'metric', value: [{ text: '12 €' }], caption: [{ text: 'a'.repeat(81) }] }],
    ['valeur absente', { kind: 'metric', caption: null }],
    ['fragment invalide', { kind: 'metric', value: [{ text: '12 €', strong: 'oui' }], caption: null }],
  ])('%s → rien n’est accepté (la réponse est présentée à partir de son texte)', (_cas, bloc) => {
    expect(parseAnswerBlocks([bloc])).toBeNull();
  });
});

describe('L114AA-C05 — non-régression des autres formes', () => {
  it('paragraphe, liste, titre, tableau : inchangés', () => {
    expect(buildAnswerBlocks('Le prix d’achat est de 12 500 €.').map((b) => b.kind)).toEqual(['paragraph']);
    expect(buildAnswerBlocks('- A\n- B').map((b) => b.kind)).toEqual(['list']);
    expect(buildAnswerBlocks('## Comparaison\nTexte.').map((b) => b.kind)).toEqual(['heading', 'paragraph']);
    expect(buildAnswerBlocks('| Clio | Polo |\n|---|---|\n| 12 | 13 |').map((b) => b.kind)).toEqual(['table']);
  });

  it('une ligne qui parle d’un chiffre sans l’étiquette reste un paragraphe', () => {
    expect(buildAnswerBlocks('Le chiffre à retenir est 2 974,53 €.').map((b) => b.kind)).toEqual(['paragraph']);
  });
});
