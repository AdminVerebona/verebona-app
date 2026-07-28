/**
 * Diff — CDC §4.5.3.
 *
 * « L'aperçu des modifications doit être affiché avant validation. »
 * Sans diff fiable, la validation humaine est une formalité : l'administrateur
 * approuve ce qu'il ne voit pas.
 */
import { describe, it, expect } from 'vitest';
import { computeDiff, renderDiff } from '../diff.service';

describe('production du diff', () => {
  it('détecte une ligne ajoutée', () => {
    const d = computeDiff('R1 — première règle', 'R1 — première règle\nR2 — nouvelle règle');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(0);
    expect(d.identical).toBe(false);
  });

  it('détecte une ligne supprimée', () => {
    const d = computeDiff('R1\nR2\nR3', 'R1\nR3');
    expect(d.removed).toBe(1);
    expect(d.lines.find((l) => l.op === 'removed')?.text).toBe('R2');
  });

  it('détecte une modification comme une suppression suivie d\'un ajout', () => {
    const d = computeDiff('R3 — ne rien proposer', 'R3 — extraire tout');
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
  });

  it('signale une proposition identique — cas à refuser d\'emblée', () => {
    const content = 'R1 — règle inchangée\nR2 — autre règle';
    expect(computeDiff(content, content).identical).toBe(true);
  });

  it('conserve les numéros de ligne des deux versions', () => {
    const d = computeDiff('A\nB\nC', 'A\nX\nC');
    const removed = d.lines.find((l) => l.op === 'removed');
    const added = d.lines.find((l) => l.op === 'added');
    expect(removed?.baseLine).toBe(2);
    expect(removed?.candidateLine).toBeNull();
    expect(added?.candidateLine).toBe(2);
    expect(added?.baseLine).toBeNull();
  });

  it('ne perd aucune ligne du contenu candidat', () => {
    const candidate = 'A\nB\nC\nD';
    const d = computeDiff('A\nX\nC', candidate);
    const reconstructed = d.lines
      .filter((l) => l.op !== 'removed')
      .map((l) => l.text)
      .join('\n');
    expect(reconstructed).toBe(candidate);
  });

  it('gère un prompt vide au départ', () => {
    const d = computeDiff('', 'R1\nR2');
    expect(d.added).toBeGreaterThan(0);
    expect(d.identical).toBe(false);
  });
});

describe('rendu du diff', () => {
  it('n\'affiche que les lignes modifiées, préfixées', () => {
    const rendered = renderDiff(computeDiff('A\nB\nC', 'A\nX\nC'));
    expect(rendered).toContain('- B');
    expect(rendered).toContain('+ X');
    expect(rendered).not.toContain('A');
  });
});
