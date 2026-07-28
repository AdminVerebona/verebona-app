/**
 * Sujets réservés — CDC Assistant §4.3.3, CDC Refonte §13.
 *
 * L'enjeu est un équilibre : bloquer trop large rend l'assistant inutile sur la
 * moitié du patrimoine de l'utilisateur, bloquer trop peu l'expose à donner des
 * conseils qu'il n'a pas qualité à donner.
 */
import { describe, it, expect } from 'vitest';
import { checkBlockedTopic } from '../blocked-topics';

describe('questions sur les données — doivent passer', () => {
  it.each([
    'Quel est le montant de ma prime d\'assurance habitation ?',
    'Quand expire mon contrat d\'assurance ?',
    'Combien ai-je payé de taxe foncière l\'an dernier ?',
    'Où est le diagnostic amiante de mon appartement ?',
    'Quelle est la surface de ma maison ?',
    'Quel est le numéro de mon contrat AXA ?',
  ])('« %s » n\'est pas bloquée', (q) => {
    expect(checkBlockedTopic(q).blocked).toBe(false);
  });
});

describe('demandes de conseil — doivent être bloquées', () => {
  it.each([
    ['Dois-je changer d\'assurance habitation ?', 'insurance_advice'],
    ['Comment réduire mon impôt sur la plus-value ?', 'tax'],
    ['Ai-je le droit d\'expulser mon locataire ?', 'legal'],
    ['Que me conseillez-vous pour la défiscalisation ?', 'tax'],
    ['Suis-je bien couvert par mon assurance ?', 'insurance_advice'],
  ])('« %s » est bloquée (%s)', (q, reason) => {
    const r = checkBlockedTopic(q);
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe(reason);
    expect(r.message).toBeTruthy();
  });

  it('le message de refus reste factuel et oriente vers un professionnel', () => {
    const r = checkBlockedTopic('Dois-je contester ce litige au tribunal ?');
    expect(r.blocked).toBe(true);
    expect(r.message).toMatch(/professionnel/i);
    // Ni reproche, ni jargon d'erreur.
    expect(r.message).not.toMatch(/interdit|refus|erreur/i);
  });
});

describe('cas limites', () => {
  it('une demande de conseil hors domaine réservé n\'est pas bloquée', () => {
    expect(checkBlockedTopic('Dois-je faire réviser ma chaudière ?').blocked).toBe(false);
  });

  it('un mot-clé thématique seul ne suffit pas à bloquer', () => {
    // C'est le point de conception : le critère est la demande de conseil,
    // pas la présence du mot « fiscal » ou « juridique ».
    expect(checkBlockedTopic('Où est mon avis d\'impôt foncier ?').blocked).toBe(false);
  });
});
