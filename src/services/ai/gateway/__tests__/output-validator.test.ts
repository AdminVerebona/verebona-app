/**
 * Tests du validateur — CDC §5.3.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { extractJson, validateOutput } from '../output-validator';

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
