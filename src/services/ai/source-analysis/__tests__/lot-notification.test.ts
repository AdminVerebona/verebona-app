/**
 * Notification de fin de lot — CDC notifications §7.2.
 *
 * L'ancien pipeline émettait cette notification, le nouveau l'avait perdue.
 * Ces tests figent la règle pour que la bascule ne rende pas l'analyse muette.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` est hissé en tête de fichier : la fabrique ne peut donc référencer
// aucune variable de portée supérieure. On expose l'espion via `vi.hoisted`.
const { emit } = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('@/lib/notifications', () => ({ emit }));

import {
  resolveLotNotificationType,
  notifyLotCompleted,
} from '@/services/ai/source-analysis/lot-notification';

describe('type de notification selon l’issue du lot', () => {
  it('annonce une réussite quand tout est analysé', () => {
    expect(resolveLotNotificationType(5, 0)).toBe('DOCUMENT_BATCH_COMPLETED');
  });

  it('annonce un échec partiel dès qu’un document échoue', () => {
    // Un lot « réussi » à 4 documents sur 5 ne l'est pas : l'utilisateur doit
    // savoir qu'il lui en manque un.
    expect(resolveLotNotificationType(4, 1)).toBe('DOCUMENT_BATCH_PARTIALLY_FAILED');
  });

  it('annonce un échec complet quand rien n’a été analysé', () => {
    expect(resolveLotNotificationType(0, 3)).toBe('DOCUMENT_BATCH_FAILED');
  });

  it('traite un lot sans échec ni succès comme un échec complet', () => {
    expect(resolveLotNotificationType(0, 0)).toBe('DOCUMENT_BATCH_FAILED');
  });
});

describe('émission', () => {
  beforeEach(() => emit.mockReset());

  const base = { accountId: 7, userId: 3, lotId: 42, analysedCount: 5, failedCount: 0 };

  it('émet une seule notification pour tout le lot (§7.2)', async () => {
    await notifyLotCompleted(base);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      type: 'DOCUMENT_BATCH_COMPLETED',
      entityType: 'document_lot',
      entityId: 42,
      recipientUserIds: [3],
    });
  });

  it('porte une clé de déduplication stable', async () => {
    // La route supprimée au lot 0 employait `Date.now()` : deux exécutions du
    // même lot produisaient deux notifications.
    await notifyLotCompleted(base);
    await notifyLotCompleted(base);
    const cles = emit.mock.calls.map((c) => c[0].dedupeKey);
    expect(cles[0]).toBe('document:lot-completed:42');
    expect(cles[0]).toBe(cles[1]);
  });

  it('n’émet rien sans destinataire', async () => {
    // Cas d'une analyse déclenchée par une tâche planifiée : il n'y a
    // personne à prévenir.
    await notifyLotCompleted({ ...base, userId: undefined });
    expect(emit).not.toHaveBeenCalled();
  });

  it('n’émet rien pour un lot vide', async () => {
    await notifyLotCompleted({ ...base, analysedCount: 0, failedCount: 0 });
    expect(emit).not.toHaveBeenCalled();
  });

  it('ne lève jamais si l’émission échoue', async () => {
    // L'analyse est terminée et les résultats écrits : une notification
    // perdue est un désagrément, une exception ici serait une régression.
    emit.mockRejectedValueOnce(new Error('file de notification indisponible'));
    await expect(notifyLotCompleted(base)).resolves.toBeUndefined();
  });

  it('transmet les compteurs à l’utilisateur', async () => {
    await notifyLotCompleted({ ...base, analysedCount: 4, failedCount: 1 });
    expect(emit.mock.calls[0][0].payload).toEqual({
      lotId: 42, analysedCount: 4, failedCount: 1,
    });
  });
});
