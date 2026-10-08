/**
 * Tests du validateur — CDC §5.3.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { extractJson, validateOutput } from '../output-validator';
import { AiOutputTaskMismatchError } from '../errors';

describe('extraction du JSON', () => {
  it('lit un objet nu', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('lit un objet encadré de balises de code', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('lit un objet précédé d\'un préambule bavard', () => {
    expect(extractJson('Voici le résultat :\n{"a":1}\nJ\'espère que cela convient.')).toEqual({ a: 1 });
  });

  it('lit un tableau de tableaux (regroupement de fichiers)', () => {
    expect(extractJson('[[0,1],[2]]')).toEqual([[0, 1], [2]]);
  });

  it('ne se laisse pas piéger par une accolade dans une chaîne', () => {
    expect(extractJson('{"a":"} texte {","b":2}')).toEqual({ a: '} texte {', b: 2 });
  });

  it('échoue proprement sans structure JSON', () => {
    expect(() => extractJson('désolé, je ne peux pas répondre')).toThrow();
  });
});

describe('validation de schéma', () => {
  const S = z.object({ n: z.number(), tag: z.enum(['a', 'b']) });

  it('renvoie la donnée typée', () => {
    expect(validateOutput('{"n":3,"tag":"a"}', S, 'op')).toEqual({ n: 3, tag: 'a' });
  });

  it('rejette un enum hors domaine avec un message exploitable', () => {
    expect(() => validateOutput('{"n":3,"tag":"z"}', S, 'op')).toThrow(/tag/);
  });
});

describe('validation discriminée par task — CDC 15 §22.2', () => {
  const Union = z.discriminatedUnion('task', [
    z.object({ task: z.literal('A'), a: z.number() }),
    z.object({ task: z.literal('B') }),
  ]);

  it('accepte la branche attendue', () => {
    expect(validateOutput('{"task":"A","a":1}', Union, 'op', 'json', { expectedTask: 'A' })).toEqual({ task: 'A', a: 1 });
  });

  it('refuse une autre branche, même valide pour le schéma : INVALID_OUTPUT récupérable et typée', () => {
    let err: unknown;
    try { validateOutput('{"task":"B"}', Union, 'op', 'json', { expectedTask: 'A' }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AiOutputTaskMismatchError);
    expect(err).toMatchObject({ code: 'INVALID_OUTPUT', recoverable: true, expectedTask: 'A', receivedTask: 'B' });
  });

  it('sortie sans task : branche rétablie par le serveur (lot 33D) ; sortie qui n’est pas un objet : refusée', () => {
    expect(validateOutput('{"a":1}', Union, 'op', 'json', { expectedTask: 'A' })).toEqual({ task: 'A', a: 1 });
    expect(() => validateOutput('[{"task":"A"}]', z.unknown(), 'op', 'json', { expectedTask: 'A' })).toThrow(AiOutputTaskMismatchError);
  });

  it('sans expectedTask : comportement historique', () => {
    expect(validateOutput('{"task":"B"}', Union, 'op')).toEqual({ task: 'B' });
  });
});
