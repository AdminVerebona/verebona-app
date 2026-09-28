/**
 * Mascotte Verebona — CDC §34.3.
 *
 * Les trois règles du §34.3 sont invisibles au compilateur : une mascotte
 * réduite à une tête, ou pointant le texte du doigt, s'afficherait
 * parfaitement.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(
  join(process.cwd(), 'src/components/verebona/VerebonaMascot.tsx'),
  'utf-8',
);

describe('§34.3 — mascotte entière', () => {
  it('possède un corps, des bras et des jambes', () => {
    // « Pas d'avatar tête seule » : le corps est le carré du logo, les
    // membres l'entourent.
    expect(SOURCE).toMatch(/Jambes/);
    expect(SOURCE).toMatch(/Bras/);
    expect(SOURCE).toMatch(/Corps/);
  });

  it('n’emploie aucun émoji', () => {
    // Le placeholder rendait un hibou, sans rapport avec la marque.
    expect(SOURCE).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('reprend le bleu du logo', () => {
    expect(SOURCE).toContain('#3B82F6');
  });
});

describe('contrat de poses préservé', () => {
  it('les cinq poses d’origine existent', () => {
    for (const pose of ['idle', 'thinking', 'success', 'empty', 'error']) {
      expect(SOURCE).toMatch(new RegExp(`'${pose}'`));
    }
  });

  it('chaque pose porte un libellé accessible', () => {
    expect(SOURCE).toContain('POSE_LABEL');
    expect(SOURCE).toContain('aria-label={POSE_LABEL[pose]}');
  });

  it('la signature du composant est inchangée', () => {
    // Les appelants existants — drawer, déclencheur, en-tête — ne doivent
    // rien avoir à modifier.
    expect(SOURCE).toMatch(/pose\?: MascotPose/);
    expect(SOURCE).toMatch(/size\?: number/);
  });
});

describe('cohérence avec le logo', () => {
  it('reprend l’inclinaison de 18° pour la pose de réflexion', () => {
    // C'est l'angle exact du carré bleu dans Logo.tsx.
    expect(SOURCE).toMatch(/thinking:.*tilt: 18/);
  });

  it('le regard reste droit quand le corps s’incline', () => {
    // Contre-rotation : c'est ce décalage qui fait un être plutôt qu'une forme.
    expect(SOURCE).toMatch(/rotate\(\$\{-p\.tilt\}/);
  });
});
