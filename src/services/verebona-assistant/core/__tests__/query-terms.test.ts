/**
 * CDC §9.4, §13.4 — reconnaissance des questions portant sur les biens.
 *
 * Deux défauts constatés en recette sur « j'ai quoi comme biens ? » :
 *   · le routeur n'avait aucun motif « bien », et `ACCOUNT_SEARCH_ASSET`
 *     n'était atteignable que par classification IA ;
 *   · le retrieval cherchait la phrase entière par correspondance de mots,
 *     ne trouvait rien, et l'assistant répondait qu'il manquait d'éléments.
 *
 * La question la plus naturelle du produit était celle à laquelle il répondait
 * le plus mal.
 */
import { describe, it, expect } from 'vitest';
import { extractSearchTerms, isInventoryQuery } from '../query-terms';
import { routeDeterministic } from '../intent-router.service';

const ctx = (message: string) => ({
  message, planType: 'PREMIUM', hasPendingClarification: false,
});

describe('extraction des termes discriminants', () => {
  it('ne retient rien dans une question purement générique', () => {
    expect(extractSearchTerms("j'ai quoi comme biens ?")).toEqual([]);
    expect(extractSearchTerms('quels sont mes biens')).toEqual([]);
    expect(extractSearchTerms('liste mes véhicules')).toEqual([]);
  });

  it("retient le nom d'un objet précis", () => {
    expect(extractSearchTerms('ma maison de Rennes')).toEqual(['rennes']);
    expect(extractSearchTerms('le DPE de la Clio')).toEqual(['dpe', 'clio']);
  });

  it('conserve les chiffres, qui distinguent souvent deux objets', () => {
    expect(extractSearchTerms('ma Clio 3')).toEqual(['clio', '3']);
  });

  it("ignore accents, apostrophes et ponctuation", () => {
    expect(extractSearchTerms("qu'est-ce que j'ai comme véhicules ?")).toEqual([]);
  });
});

describe('détection de la question d’inventaire', () => {
  it('reconnaît les formulations courantes', () => {
    for (const q of [
      "j'ai quoi comme biens ?",
      'quels sont mes biens',
      'liste mes véhicules',
      'montre-moi mes propriétés',
      'mes appartements',
      "qu'est-ce que je possède comme maisons",
    ]) {
      expect(isInventoryQuery(q), q).toBe(true);
    }
  });

  it("n'attrape pas une recherche d'objet précis", () => {
    // Un terme discriminant subsiste : c'est une recherche, pas un inventaire.
    for (const q of ['ma maison de Rennes', 'le bien rue des Lilas', 'ma Clio']) {
      expect(isInventoryQuery(q), q).toBe(false);
    }
  });

  it("n'attrape pas un message sans mot de catégorie", () => {
    // Sans cette seconde condition, « bonjour » et « merci » — qui ne laissent
    // eux non plus aucun terme discriminant — déclencheraient la liste.
    for (const q of ['bonjour', 'merci beaucoup', 'oui', '']) {
      expect(isInventoryQuery(q), q).toBe(false);
    }
  });
});

describe('routage déterministe des biens (§9.4)', () => {
  it('atteint ACCOUNT_SEARCH_ASSET sans appel modèle', () => {
    const out = routeDeterministic(ctx("j'ai quoi comme biens ?"));
    expect(out.kind).toBe('route');
    if (out.kind !== 'route') return;
    expect(out.route.intent).toBe('ACCOUNT_SEARCH_ASSET');
    expect(out.route.requiresRetrieval).toBe(true);
  });

  it('reconnaît les types de biens, pas seulement le mot générique', () => {
    for (const q of ['mes voitures', 'mon appartement', 'mes terrains', 'le bateau']) {
      const out = routeDeterministic(ctx(q));
      expect(out.kind, q).toBe('route');
      if (out.kind === 'route') expect(out.route.intent, q).toBe('ACCOUNT_SEARCH_ASSET');
    }
  });

  it('laisse la priorité au document quand les deux sont cités', () => {
    // « la facture de la maison » porte sur le document, pas sur le bien.
    const out = routeDeterministic(ctx('la facture de la maison'));
    expect(out.kind).toBe('route');
    if (out.kind === 'route') expect(out.route.intent).toBe('ACCOUNT_SEARCH_DOCUMENT');
  });

  it('escalade toujours en classification sur une question sans motif connu', () => {
    // La correction ne doit pas capturer ce qui relevait de l'IA.
    expect(routeDeterministic(ctx('et ça donne quoi tout ça')).kind).toBe('needs_classification');
  });
});
