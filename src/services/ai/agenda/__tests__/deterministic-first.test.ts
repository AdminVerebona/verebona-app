/**
 * Déterminisme avant IA — CDC §4.4.3, critère d'acceptation n°17.
 *
 * « Aucun appel modèle n'est émis sur un cas que les règles tranchent. »
 *
 * Ces tests portent aussi la non-régression : les motifs sont repris à
 * l'identique de `AgendaClassificationService`. Si un cas qui fonctionnait
 * cesse de fonctionner, il échoue ici.
 */
import { describe, it, expect } from 'vitest';
import { classifyByRules } from '../rules/deterministic-classification';

function classify(title: string, originType = 'document') {
  return classifyByRules({ title, originType });
}

describe('cas tranchés par règle — aucun appel modèle', () => {
  it.each([
    'Contrôle technique Clio',
    'Révision des 60 000 km',
    'Rendez-vous garage',
    'Entretien chaudière',
    'Remplacement du chauffe-eau',
    'Paiement de la facture EDF',
    'Reprise des pneus hiver',
    'Récupération du véhicule en dépôt',
    'Fin de contrat de gardiennage pneus',
  ])('« %s » → action', (title) => {
    expect(classify(title)).toBe('action');
  });

  it.each([
    'Fin de garantie lave-linge',
    'Expiration assurance habitation',
    "Date d'achat du vélo",
    'Fabrication du véhicule',
    'Échéance DPE',
    'Diagnostic amiante',
    'Reconduction du contrat',
    'Garantie décennale',
  ])('« %s » → information', (title) => {
    expect(classify(title)).toBe('information');
  });

  it('un événement issu d\'un champ de bien est toujours informatif', () => {
    expect(classifyByRules({ title: 'Peu importe le titre', originType: 'asset_field' }))
      .toBe('information');
  });
});

describe('priorité des motifs — cas subtils repris de l\'existant', () => {
  it('« fin de contrat de gardiennage » est une action, pas une information', () => {
    // Le motif informatif /fin.*contrat/ existe, mais le motif d'action est
    // évalué en premier : il faut aller récupérer l'objet.
    expect(classify('Fin de contrat gardiennage')).toBe('action');
  });

  it('« Achat — Vélo » est informatif mais « Achat Pneus Discount → Reprise » est une action', () => {
    expect(classify('Achat — Vélo')).toBe('information');
    expect(classify('Achat Pneus Discount → Reprise')).toBe('action');
  });

  it('« renouvellement » seul est une action, « renouvellement automatique » une information', () => {
    expect(classify('Renouvellement du contrat')).toBe('action');
    // Le motif d'action /renouvellement/ étant prioritaire, ce cas reste
    // « action » — comportement conservé à l'identique de l'existant, sans
    // correction silencieuse.
    expect(classify('Renouvellement automatique assurance')).toBe('action');
  });
});

describe('cas réellement ambigus — seuls autorisés à appeler un modèle', () => {
  it.each([
    'Événement du 12 mars',
    'Suivi dossier',
    'Point avec le syndic',
  ])('« %s » reste indécis', (title) => {
    expect(classify(title)).toBeNull();
  });
});
