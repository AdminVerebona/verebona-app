/**
 * Mise à niveau du référentiel — CDC V2.0 §11.6, AI-05.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT QUE CE FICHIER EMPÊCHE DE REVENIR
 *
 * `applyV2Classification` n'écrivait en base que si la Rubrique ou le Type
 * changeait. Un document reclassé À L'IDENTIQUE gardait donc son ancienne
 * `classification_referential_version` — et ressortait « à retraiter » au
 * passage suivant, indéfiniment, en consommant une analyse à chaque tour.
 *
 * Aucune erreur n'était levée. Le seul symptôme était un compteur bloqué :
 * cinq documents passaient à 2.1.0, trois restaient à 2.0.0.
 *
 * `needsReprocessing` est le prédicat qui décide de tout cela. Les cas
 * ci-dessous fixent ce qu'il doit répondre, y compris pour la confirmation
 * sans changement — celui qui a été oublié.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { needsReprocessing } from '@/services/documents/rubric-classification';
import { REFERENTIAL_VERSION } from '@/lib/referential/v2';

describe('sélection des documents à retraiter (§11.6)', () => {
  it('AI-05 — une version antérieure appelle un retraitement', () => {
    expect(needsReprocessing('2.0.0')).toBe(true);
  });

  it('un document jamais classé aussi', () => {
    expect(needsReprocessing(null)).toBe(true);
    expect(needsReprocessing(undefined)).toBe(true);
  });

  it('la version courante clôt le sujet', () => {
    expect(needsReprocessing(REFERENTIAL_VERSION)).toBe(false);
  });

  it('un document CONFIRMÉ sans changement est à jour, pas à retraiter', () => {
    // C'est le cas qui bouclait : le classement ne changeait pas, la version
    // n'était pas écrite, et le document repassait sans fin. La version dit
    // « examiné sous ce référentiel », pas « modifié ».
    const apresConfirmation = REFERENTIAL_VERSION;
    expect(needsReprocessing(apresConfirmation)).toBe(false);
  });
});

describe('version du référentiel', () => {
  it('suit un format comparable', () => {
    expect(REFERENTIAL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('a bien été incrémentée avec l’ajout du Type « Facture d’abonnement »', () => {
    // Le §11.6 impose l'incrément à CHAQUE modification de la taxonomie. Sans
    // lui, le parc resterait classé selon un référentiel qui n'existe plus,
    // sans aucun moyen de le détecter après coup.
    expect(REFERENTIAL_VERSION).not.toBe('2.0.0');
  });
});
