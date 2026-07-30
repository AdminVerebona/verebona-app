/**
 * Diagnostic des erreurs de base.
 *
 * Trois routes ont renvoyé un « 500 Internal Server Error » nu pour la même
 * cause — une table absente — sans qu'aucune ne la nomme. Ces tests figent le
 * comportement qui l'évite.
 */
import { describe, it, expect } from 'vitest';
import {
  extractPgCode,
  extractPgMessage,
  diagnoseDatabaseError,
} from '@/lib/database-diagnostic';

/** Erreur telle que Drizzle l'enveloppe : le code est dans `cause`. */
function drizzleError(code: string, message: string) {
  const e = new Error('Failed query: select ...') as Error & { cause?: unknown };
  e.cause = Object.assign(new Error(message), { code });
  return e;
}

describe('extraction du code PostgreSQL', () => {
  it('traverse l’enveloppe Drizzle', () => {
    // C'est précisément ce qui rendait « Failed query » indéchiffrable : le
    // code réel n'est jamais sur l'erreur, toujours sur sa cause.
    expect(extractPgCode(drizzleError('42P01', 'relation does not exist'))).toBe('42P01');
  });

  it('accepte un code posé directement', () => {
    expect(extractPgCode(Object.assign(new Error('x'), { code: '23505' }))).toBe('23505');
  });

  it('ignore un `code` qui n’est pas un code PostgreSQL', () => {
    // `ENOTFOUND`, `ECONNREFUSED` : codes réseau, pas SQL.
    expect(extractPgCode(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBeUndefined();
  });

  it('rend undefined sur une erreur ordinaire', () => {
    expect(extractPgCode(new Error('boom'))).toBeUndefined();
  });
});

describe('extraction du message', () => {
  it('privilégie la cause sur l’enveloppe', () => {
    expect(extractPgMessage(drizzleError('42P01', 'relation "x" does not exist')))
      .toBe('relation "x" does not exist');
  });

  it('retombe sur le message de l’erreur', () => {
    expect(extractPgMessage(new Error('boom'))).toBe('boom');
  });
});

describe('qualification', () => {
  it('nomme une table absente', () => {
    const d = diagnoseDatabaseError(drizzleError('42P01', 'relation does not exist'));
    expect(d.schemaHint).toBe('MISSING_TABLE');
    expect(d.explanation).toContain('migration');
  });

  it('nomme une colonne absente', () => {
    expect(diagnoseDatabaseError(drizzleError('42703', 'column x')).schemaHint)
      .toBe('MISSING_COLUMN');
  });

  it('nomme une fonction absente et cite gen_random_uuid', () => {
    // Cas d'un PostgreSQL antérieur à la version 13 : la piste doit être
    // donnée, pas devinée.
    const d = diagnoseDatabaseError(drizzleError('42883', 'function gen_random_uuid() does not exist'));
    expect(d.schemaHint).toBe('MISSING_FUNCTION');
    expect(d.explanation).toContain('gen_random_uuid');
  });

  it('nomme une authentification refusée et cite DATABASE_URL', () => {
    // L'erreur qui avait coûté deux allers-retours : le pilote se rabat sur
    // le compte système quand l'URL manque.
    const d = diagnoseDatabaseError(drizzleError('28P01', 'password authentication failed'));
    expect(d.schemaHint).toBe('AUTH_FAILED');
    expect(d.explanation).toContain('DATABASE_URL');
  });

  it('distingue contrainte, unicité et clé étrangère', () => {
    expect(diagnoseDatabaseError(drizzleError('23514', 'x')).schemaHint).toBe('CHECK_CONSTRAINT');
    expect(diagnoseDatabaseError(drizzleError('23505', 'x')).schemaHint).toBe('UNIQUE_VIOLATION');
    expect(diagnoseDatabaseError(drizzleError('23503', 'x')).schemaHint).toBe('FOREIGN_KEY');
  });

  it('conserve un code inconnu sans l’interpréter', () => {
    // Inventer une explication serait pire que n'en donner aucune.
    const d = diagnoseDatabaseError(drizzleError('99999', 'x'));
    expect(d.pgCode).toBe('99999');
    expect(d.schemaHint).toBeUndefined();
  });

  it('rend un objet vide sur une erreur non SQL', () => {
    expect(diagnoseDatabaseError(new Error('boom'))).toEqual({});
  });
});
