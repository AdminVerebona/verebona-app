/**
 * Vérification des citations — CDC Assistant §4.3.6, critère d'acceptation n°15.
 *
 * « Toute affirmation factuelle est rattachée à au moins une source. »
 *
 * Le principe défendu ici : une citation invalide n'invalide pas seulement
 * l'affichage de la source, elle invalide L'AFFIRMATION.
 */
import { describe, it, expect } from 'vitest';
import { verifyClaims, composeVerifiedText } from '../claim-verifier.service';
import type { SourceRef } from '../tools/tool.port';

const sources: SourceRef[] = [
  { type: 'document', id: 10, label: 'Facture EDF', excerpt: 'Montant : 129,00 €' },
  { type: 'document', id: 11, label: 'Contrat AXA', excerpt: 'Prime annuelle : 480 €' },
];

describe('affirmations sourcées', () => {
  it('conserve une affirmation correctement citée', () => {
    const r = verifyClaims(
      [{ text: 'Votre facture EDF s\'élève à 129 €.', citedSourceIds: [10], factual: true }],
      sources,
    );
    expect(r.claims[0].verified).toBe(true);
    expect(r.status).toBe('answered');
    expect(r.displayedSources).toHaveLength(1);
  });

  it('RETIRE une affirmation citant une source inexistante', () => {
    const r = verifyClaims(
      [{ text: 'Votre prime est de 350 €.', citedSourceIds: [999], factual: true }],
      sources,
    );
    expect(r.claims[0].verified).toBe(false);
    expect(r.droppedClaims).toContain('Votre prime est de 350 €.');
    expect(composeVerifiedText(r)).toBe('');
  });

  it('retire une affirmation factuelle sans aucune citation', () => {
    const r = verifyClaims(
      [{ text: 'Votre maison vaut 300 000 €.', citedSourceIds: [], factual: true }],
      sources,
    );
    expect(r.claims[0].verified).toBe(false);
  });

  it('conserve une formulation non factuelle sans exiger de source', () => {
    const r = verifyClaims(
      [{ text: 'Voici ce que j\'ai trouvé :', citedSourceIds: [], factual: false }],
      sources,
    );
    expect(r.claims[0].verified).toBe(true);
  });

  it('bascule en « information insuffisante » si aucune affirmation ne tient', () => {
    const r = verifyClaims(
      [
        { text: 'Introduction.', citedSourceIds: [], factual: false },
        { text: 'Votre prime est de 350 €.', citedSourceIds: [42], factual: true },
      ],
      sources,
    );
    expect(r.status).toBe('insufficient_data');
  });

  it('conserve la réponse si une affirmation sur deux est valide', () => {
    const r = verifyClaims(
      [
        { text: 'Facture EDF : 129 €.', citedSourceIds: [10], factual: true },
        { text: 'Et votre taxe foncière est de 900 €.', citedSourceIds: [77], factual: true },
      ],
      sources,
    );
    expect(r.status).toBe('answered');
    expect(composeVerifiedText(r)).toBe('Facture EDF : 129 €.');
    expect(r.droppedClaims).toHaveLength(1);
  });
});

describe('plafonds du §31.2', () => {
  it('n\'affiche jamais plus de cinq sources', () => {
    const many: SourceRef[] = Array.from({ length: 12 }, (_, i) => ({
      type: 'document', id: i + 1, label: `Document ${i + 1}`,
    }));
    const r = verifyClaims(
      [{ text: 'Réponse.', citedSourceIds: many.map((s) => s.id), factual: true }],
      many,
    );
    expect(r.displayedSources.length).toBeLessThanOrEqual(5);
  });

  it('tronque les extraits affichés à 240 caractères', () => {
    const long: SourceRef[] = [{ type: 'document', id: 1, label: 'Long', excerpt: 'x'.repeat(900) }];
    const r = verifyClaims([{ text: 'Réponse.', citedSourceIds: [1], factual: true }], long);
    expect(r.displayedSources[0].excerpt!.length).toBeLessThanOrEqual(241);
  });

  it('n\'affiche que les sources réellement citées', () => {
    const r = verifyClaims([{ text: 'Facture.', citedSourceIds: [10], factual: true }], sources);
    expect(r.displayedSources.map((s) => s.id)).toEqual([10]);
  });
});
