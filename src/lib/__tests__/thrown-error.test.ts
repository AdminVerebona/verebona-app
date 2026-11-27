/**
 * Lecture typée d'une valeur levée — `readThrownError`.
 *
 * Remplace les `catch (error: any)` : chaque champ doit être rendu à
 * l'identique de l'ancienne lecture `error?.champ` pour les erreurs réelles
 * (`ApiClientError`, `Error`, objet), et ignoré quand son type est inattendu.
 */
import { describe, it, expect } from 'vitest';
import { ApiClientError } from '@/lib/api-client';
import { readThrownError } from '@/lib/thrown-error';

describe('readThrownError', () => {
  it('rend statut, code, détails et message serveur d’une ApiClientError', () => {
    const details = { substructureIds: [1, 2] };
    const error = new ApiClientError(409, 'CONFLICT', details, 'req-1', 'Conflit de version');

    expect(readThrownError(error)).toEqual({
      message: 'Conflit de version',
      status: 409,
      code: 'CONFLICT',
      serverMessage: 'Conflit de version',
      details,
    });
  });

  it('rend le seul message d’une Error nue', () => {
    expect(readThrownError(new Error('INSUFFICIENT_PERMISSIONS'))).toEqual({
      message: 'INSUFFICIENT_PERMISSIONS',
      status: undefined,
      code: undefined,
      serverMessage: undefined,
      details: undefined,
    });
  });

  it('lit un objet levé tel quel (lecture structurelle, sans dépendre de la classe)', () => {
    const fields = readThrownError({ status: 404, code: 'NOT_FOUND', message: 'Introuvable' });

    expect(fields.status).toBe(404);
    expect(fields.code).toBe('NOT_FOUND');
    expect(fields.message).toBe('Introuvable');
  });

  it.each([undefined, null, 'panne réseau', 500])('ne rend aucun champ pour la valeur levée %p', (thrown) => {
    expect(readThrownError(thrown)).toEqual({});
  });

  it('ignore un champ dont le type n’est pas celui attendu', () => {
    const fields = readThrownError({ status: '404', code: 12, message: { texte: 'x' }, details: 'aucun' });

    expect(fields).toEqual({
      message: undefined,
      status: undefined,
      code: undefined,
      serverMessage: undefined,
      details: undefined,
    });
  });
});
