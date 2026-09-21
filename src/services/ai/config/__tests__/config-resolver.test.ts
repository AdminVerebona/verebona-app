/**
 * CDC BO IA GEN-001, §2.1, T1-013 — la configuration rencontre le code.
 *
 * Ce module est le pont entre le Back-Office et la passerelle. Deux propriétés
 * comptent plus que tout le reste :
 *
 *   · il ne doit JAMAIS faire échouer un appel — une console d'administration
 *     ne peut pas casser le produit qu'elle administre ;
 *   · le préambule administrable ne doit pas remplacer le prompt technique,
 *     qui porte le contrat de sortie validé par le serveur.
 */
import { describe, it, expect } from 'vitest';
import { composePrompt, resolveOperationConfig } from '../config-resolver';
import { AI_OPERATIONS } from '../../registry/operations';

describe('composition du prompt (T1-013, SCR-03)', () => {
  it('place le préambule AVANT le prompt technique', () => {
    // Le prompt technique donne le format et doit rester la dernière
    // instruction lue : l'inverse laisserait un préambule mal rédigé
    // contredire le contrat de sortie.
    const out = composePrompt('Cadre commun.', 'Réponds en JSON.');
    expect(out.indexOf('Cadre commun.')).toBeLessThan(out.indexOf('Réponds en JSON.'));
  });

  it('rend le prompt technique intact quand il n’y a pas de préambule', () => {
    expect(composePrompt(null, 'Réponds en JSON.')).toBe('Réponds en JSON.');
  });

  it('ne perd jamais le prompt technique', () => {
    // Le remplacer priverait l'opération de son contrat de sortie — le défaut
    // exact qui a cassé la classification le 18/09/2026.
    for (const preamble of ['Cadre.', '   ', 'a'.repeat(5000)]) {
      expect(composePrompt(preamble, 'TECHNIQUE')).toContain('TECHNIQUE');
    }
  });

  it('normalise l’espacement autour du préambule', () => {
    expect(composePrompt('  Cadre.  ', 'Format.')).toBe('Cadre.\n\nFormat.');
  });
});

describe('repli sur le référentiel', () => {
  it('rend la configuration du code quand aucune version n’est effective', async () => {
    // En test, aucune base : c'est exactement la situation d'un environnement
    // où le BO n'a jamais servi, et le produit doit s'y comporter comme avant.
    const op = AI_OPERATIONS.understand_request;
    const r = await resolveOperationConfig('understand_request');

    expect(r.primaryModel).toBe(op.primaryModel);
    expect(r.fallbackModels).toEqual(op.fallbackModels);
    expect(r.promptPreamble).toBeNull();
    expect(r.configVersionId).toBeNull();
  });

  it('ne lève pas sur une opération inconnue du BO', async () => {
    // `getOperation` lève si l'opération n'existe pas au référentiel : c'est
    // une erreur de programmation, pas un défaut de configuration.
    await expect(resolveOperationConfig('understand_request')).resolves.toBeDefined();
  });

  it('n’altère pas les tableaux du référentiel', async () => {
    // Un `fallbackModels` rendu par référence pourrait être muté par un
    // appelant et modifier le référentiel pour tout le processus.
    const r = await resolveOperationConfig('understand_request');
    r.fallbackModels.push('intrus');
    const r2 = await resolveOperationConfig('understand_request');
    expect(r2.fallbackModels).not.toContain('intrus');
  });
});
