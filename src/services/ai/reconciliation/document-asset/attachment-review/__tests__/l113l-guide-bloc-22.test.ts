/**
 * Lot 113L — le bloc 22 du guide du PO (docs/exploitation/prompts-a-appliquer-par-le-po.md)
 * porte le marqueur lu par le code, vise une ligne repère UNIQUE du prompt T3 livré, et son
 * exemple est accepté par le schéma et le validateur réels (rattachement confirmé, aucune carte).
 * Le code ne modifie jamais le prompt : ce test lit le guide et le fichier livré, rien d'autre.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { T3LinkAmbiguityOutput } from '../../../master/t3-contract';
import { promptCarriesAttachmentReview } from '../contract';
import { decideAttachmentReview } from '../model';

const racine = process.cwd();
const guide = readFileSync(join(racine, 'docs/exploitation/prompts-a-appliquer-par-le-po.md'), 'utf8');
const section = guide.slice(guide.indexOf('Étape 22 — T3'), guide.indexOf('## 11. Qualification par couple'));
const bloc = /### Texte exact à coller \(bloc 22\)\n\n```text\n([\s\S]*?)\n```/.exec(section)?.[1] ?? '';

describe('L113L — bloc 22 du guide (T3, revue du rattachement)', () => {
  it('L113L-G-01 — bloc présent, marqueur lu par le code, absent du prompt livré (le code ne l’ajoute jamais)', () => {
    expect(bloc.length).toBeGreaterThan(500);
    expect(promptCarriesAttachmentReview(bloc)).toBe(true);
    const livre = readFileSync(join(racine, 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf8');
    expect(promptCarriesAttachmentReview(livre)).toBe(false);
    expect(livre.split('\n').filter((l) => l.trim() === 'SORTIE LINK_AMBIGUITY')).toHaveLength(1);
  });

  it('L113L-G-02 — exemple accepté par le schéma réel et lu comme un rattachement confirmé', () => {
    const json = bloc.slice(bloc.indexOf('{"task"'));
    const out = T3LinkAmbiguityOutput.parse(JSON.parse(json.trim()));
    expect(decideAttachmentReview(out, { currentAssetIds: [18], candidateIds: [14, 18], indexIds: [1], unitIds: ['page:1:block:2'], contract: true }))
      .toMatchObject({ kind: 'CONFIRMED', source: 'AI' });
  });

  it('L113L-G-03 — aucune exception codée dans le bloc : principe général, aucune liste de cas', () => {
    expect(bloc).not.toMatch(/APRIL|Fourche/);
    expect(bloc).toMatch(/il n’y a pas de liste fermée/);
  });
});
