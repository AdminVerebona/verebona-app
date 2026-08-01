/**
 * Reprise de clarification — CDC §20.3, §20.4, §20.5.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE RÈGLE DE SÉCURITÉ NE SE TESTE PAS DE BOUT EN BOUT
 *
 * La route recevait un identifiant de clarification et le traitait, sans
 * vérifier à qui il appartenait. Un identifiant deviné aurait suffi à
 * répondre à la place d'un autre compte.
 *
 * Rien n'aurait échoué. La réponse serait simplement partie au mauvais
 * endroit — c'est pourquoi ces contrôles vivent dans une fonction pure, et
 * sont éprouvés un par un.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import {
  verifierClarification,
  messageEchec,
} from '@/services/verebona-assistant/core/clarification.service';
import type { ClarificationState } from '@/services/verebona-assistant/types/machine';

const MAINTENANT = new Date('2026-07-31T12:00:00Z');

const etat = (o: Partial<ClarificationState> = {}): ClarificationState => ({
  clarificationId: 'cl_1',
  originalMessageId: 'm_1',
  originalIntent: 'asset_info' as ClarificationState['originalIntent'],
  candidateType: 'asset',
  candidates: [
    { id: 'asset_42', label: 'Maison de Fleury' },
    { id: 'asset_43', label: 'Appartement Bordeaux' },
  ],
  question: 'De quel bien parlez-vous ?',
  expiresAt: '2026-07-31T12:20:00Z',
  attemptCount: 0,
  ...o,
});

describe('§20.5 — propriété et identité', () => {
  it('refuse un identifiant qui n’est pas celui de l’état trouvé', () => {
    // L'état chargé est déjà borné au compte. Un autre identifiant, même
    // valide ailleurs, ne s'applique pas ici.
    const v = verifierClarification(etat(), 'cl_999', 'asset_42', MAINTENANT);
    expect(v).toEqual({ ok: false, motif: 'INTROUVABLE' });
  });

  it('refuse quand aucune clarification n’est en attente', () => {
    expect(verifierClarification(null, 'cl_1', 'asset_42', MAINTENANT))
      .toEqual({ ok: false, motif: 'INTROUVABLE' });
  });

  it('ne distingue pas « inexistante » de « pas la vôtre » dans le message', () => {
    // Les distinguer renseignerait un appelant sur l'existence de
    // clarifications qui ne sont pas les siennes.
    expect(messageEchec('INTROUVABLE')).toBe(messageEchec('CHOIX_INVALIDE'));
  });
});

describe('§20.4 — expiration à trente minutes', () => {
  it('accepte avant l’échéance', () => {
    const v = verifierClarification(etat(), 'cl_1', 'asset_42', MAINTENANT);
    expect(v.ok).toBe(true);
  });

  it('refuse après', () => {
    // Le contexte a pu changer : répondre à une clarification d'hier
    // produirait une réponse sur un état périmé.
    const tard = new Date('2026-07-31T12:21:00Z');
    expect(verifierClarification(etat(), 'cl_1', 'asset_42', tard))
      .toEqual({ ok: false, motif: 'EXPIREE' });
  });

  it('refuse À l’échéance exacte', () => {
    const pile = new Date('2026-07-31T12:20:00Z');
    expect(verifierClarification(etat(), 'cl_1', 'asset_42', pile).ok).toBe(false);
  });
});

describe('§20.3 — deux tentatives au plus', () => {
  it('accepte la seconde', () => {
    expect(verifierClarification(etat({ attemptCount: 1 }), 'cl_1', 'asset_42', MAINTENANT).ok)
      .toBe(true);
  });

  it('refuse la troisième', () => {
    // L'assistant rend la main plutôt que d'enfermer l'utilisateur dans une
    // boucle de questions.
    expect(verifierClarification(etat({ attemptCount: 2 }), 'cl_1', 'asset_42', MAINTENANT))
      .toEqual({ ok: false, motif: 'TROP_DE_TENTATIVES' });
  });
});

describe('le choix vient de la liste proposée', () => {
  it('accepte un candidat proposé, et rend son libellé', () => {
    const v = verifierClarification(etat(), 'cl_1', 'asset_43', MAINTENANT);
    expect(v).toEqual({ ok: true, choix: { id: 'asset_43', label: 'Appartement Bordeaux' } });
  });

  it('refuse un identifiant arbitraire', () => {
    // L'accepter laisserait l'appelant désigner n'importe quelle entité, y
    // compris hors de son compte.
    expect(verifierClarification(etat(), 'cl_1', 'asset_9999', MAINTENANT))
      .toEqual({ ok: false, motif: 'CHOIX_INVALIDE' });
  });
});

describe('l’ordre des contrôles', () => {
  it('l’expiration prime sur le choix invalide', () => {
    // Une clarification expirée est écartée quoi qu'on réponde : inutile de
    // renseigner l'appelant sur la validité de son choix.
    const tard = new Date('2026-07-31T13:00:00Z');
    expect(verifierClarification(etat(), 'cl_1', 'inexistant', tard))
      .toEqual({ ok: false, motif: 'EXPIREE' });
  });

  it('l’identité prime sur tout le reste', () => {
    const tard = new Date('2026-07-31T13:00:00Z');
    expect(verifierClarification(etat({ attemptCount: 5 }), 'cl_autre', 'x', tard))
      .toEqual({ ok: false, motif: 'INTROUVABLE' });
  });
});
