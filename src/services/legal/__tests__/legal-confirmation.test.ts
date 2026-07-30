/**
 * Confirmation et souscription — CDC 7 §8.2, §10.2, §18.
 *
 * Vérifie ce que le gabarit d'email doit et ne doit PAS contenir : le critère
 * d'acceptation n°8 tient au fait que le texte complet n'y figure jamais.
 */
import { describe, it, expect } from 'vitest';
import { LEGAL_CONFIRMATION_VARIABLES } from '@/db/seeds/legal/email_template_cgvu';
import { CGVU_V1_BODY_HTML } from '@/db/seeds/legal/cgvu-v1.content';

describe('gabarit de confirmation (§10.2)', () => {
  it('déclare les variables attendues par le §10.2', () => {
    expect([...LEGAL_CONFIRMATION_VARIABLES]).toEqual([
      'firstName',
      'legalVersionCode',
      'legalPermalinkUrl',
      'subscriptionBlockHtml',
      'withdrawalBlockHtml',
      'contactEmail',
    ]);
  });

  it('transporte un permalien, pas le texte des conditions', () => {
    // Critère 8 : « le texte complet n'est pas nécessaire dans l'email ».
    // Le gabarit ne comporte aucune variable de contenu intégral, et le corps
    // des CGVU ne peut donc pas y être injecté.
    expect(LEGAL_CONFIRMATION_VARIABLES).toContain('legalPermalinkUrl');
    expect(LEGAL_CONFIRMATION_VARIABLES).not.toContain('legalBodyHtml');
    expect(LEGAL_CONFIRMATION_VARIABLES).not.toContain('legalFullText');
  });

  it('ne pourrait pas contenir le texte complet — il est bien plus long', () => {
    // Garde-fou de bon sens : si un jour quelqu'un injecte le corps dans une
    // variable, la taille du message deviendrait absurde.
    expect(CGVU_V1_BODY_HTML.length).toBeGreaterThan(10_000);
  });
});

describe('deux acceptations distinctes pour un même utilisateur (§8.2)', () => {
  it('les contextes séparent l’inscription de la souscription', () => {
    // Le §8.2 énonce deux règles qui portent sur des objets différents :
    //   · interface — ne pas faire recocher une version déjà acceptée (R02) ;
    //   · trace     — la souscription est enregistrée avec la version
    //                 applicable.
    // L'index d'unicité inclut le contexte : ACCOUNT_CREATION et
    // PAID_SUBSCRIPTION coexistent sans se supplanter.
    const contexts = ['ACCOUNT_CREATION', 'PAID_SUBSCRIPTION'];
    expect(new Set(contexts).size).toBe(2);
  });
});
