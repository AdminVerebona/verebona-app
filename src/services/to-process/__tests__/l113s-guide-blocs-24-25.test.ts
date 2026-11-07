/**
 * Lot 113S — blocs 24-a, 24-b (T3) et 25 (T4) du guide du PO
 * (docs/exploitation/prompts-a-appliquer-par-le-po.md) : marqueurs lus par le
 * code, lignes repères UNIQUES des prompts livrés, exemples acceptés par les
 * schémas et validateurs réels. Le code ne modifie jamais un prompt : ce test
 * lit le guide et les fichiers livrés, rien d'autre.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { T3LinkAmbiguityOutput, T3OperationMatchOutput } from '@/services/ai/reconciliation/master/t3-contract';
import { translateOperationMatch } from '@/services/ai/reconciliation/master/operation-match';
import { decideAttachmentReview } from '@/services/ai/reconciliation/document-asset/attachment-review/model';
import { T4AgendaRepresentationOutput } from '@/services/business-operations/semantic/contract';
import { promptCarriesQuestionContract, T3_USER_QUESTION_CONTRACT, T4_USER_QUESTION_CONTRACT, validateAiUserQuestion } from '../ai-user-question';

const racine = process.cwd();
const guide = readFileSync(join(racine, 'docs/exploitation/prompts-a-appliquer-par-le-po.md'), 'utf8');
const section = guide.slice(guide.indexOf('Étape 24 — T3'), guide.indexOf('## 11. Qualification par couple'));
const bloc = (id: string) => new RegExp(`### Texte exact à coller \\(bloc ${id}\\)\\n\\n\`\`\`text\\n([\\s\\S]*?)\\n\`\`\``).exec(section)?.[1] ?? '';
const json = (b: string) => JSON.parse(b.slice(b.lastIndexOf('\n{') + 1).trim()) as Record<string, unknown>;
const t3 = readFileSync(join(racine, 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf8');
const t4 = readFileSync(join(racine, 'src/services/ai/prompts/agenda/t4_master_v1.txt'), 'utf8');
const lignes = (txt: string, l: string) => txt.split('\n').filter((x) => x.trim() === l).length;

describe('L113S — blocs 24 / 25 du guide (questions formulées par T3 / T4)', () => {
  it('G-01 — blocs présents, marqueurs lus par le code, absents des prompts livrés, lignes repères uniques', () => {
    for (const id of ['24-a', '24-b']) {
      expect(bloc(id).length, id).toBeGreaterThan(400);
      expect(promptCarriesQuestionContract(bloc(id), T3_USER_QUESTION_CONTRACT), id).toBe(true);
    }
    expect(promptCarriesQuestionContract(bloc('25'), T4_USER_QUESTION_CONTRACT)).toBe(true);
    expect(promptCarriesQuestionContract(t3, T3_USER_QUESTION_CONTRACT)).toBe(false);
    expect(promptCarriesQuestionContract(t4, T4_USER_QUESTION_CONTRACT)).toBe(false);
    expect(lignes(t3, 'SORTIE LINK_AMBIGUITY')).toBe(1);
    expect(lignes(t3, 'SORTIE OPERATION_MATCH')).toBe(1);
    expect(lignes(t4, 'CONTRÔLE FINAL')).toBe(1);
    // Étapes 22 (113L) et 23 (113P) inchangées, 24 et 25 dans le tableau de synthèse.
    expect(guide).toMatch(/\| 24 \| 113S \(#716\)/);
    expect(guide).toMatch(/\| 25 \| 113S \(#716\)/);
  });

  it('G-02 — exemple 24-a : revue du rattachement ARBITRATE acceptée, question acceptée par le contrôle', () => {
    const out = T3LinkAmbiguityOutput.parse(json(bloc('24-a')));
    const d = decideAttachmentReview(out, { currentAssetIds: [18], candidateIds: [14, 18], indexIds: [1], unitIds: ['page:1:block:3'], contract: true });
    expect(d).toMatchObject({ kind: 'ARBITRATE', suggestedAssetId: 14 });
    const q = (d as { userQuestion?: string }).userQuestion;
    expect(validateAiUserQuestion(q, { allowedLabels: ['Maison', 'Studio'] })).toEqual({ ok: true, question: q });
  });

  it('G-03 — exemple 24-b : arbitrage OPERATION_MATCH, sujet dans le monde fermé, question acceptée', () => {
    const out = T3OperationMatchOutput.parse(json(bloc('24-b')));
    const { verdict } = translateOperationMatch(out, new Set([12, 13]));
    expect(verdict).toMatchObject({ resolution: 'ARBITRATE', questionCandidateId: 12 });
    expect(validateAiUserQuestion(verdict.userQuestion, { allowedLabels: ['Devis freinage'] }).ok).toBe(true);
  });

  it('G-04 — exemple 25 : abstention T4 acceptée, question acceptée', () => {
    const out = T4AgendaRepresentationOutput.parse(json(bloc('25')));
    expect(out.outcome).toBe('ABSTAIN');
    expect(validateAiUserQuestion(out.userQuestion, { allowedLabels: ['Entretien chaudière'] }).ok).toBe(true);
  });

  it('G-05 — principes généraux, aucune exception codée ni règle métier propre à un cas', () => {
    for (const id of ['24-a', '24-b', '25']) {
      expect(bloc(id), id).not.toMatch(/APRIL|Fourche|compte 13/);
      expect(bloc(id), id).toMatch(/ne décide rien/i);
    }
  });
});
