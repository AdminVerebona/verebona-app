/**
 * BO-IA-PROMPTS-01 — AC09 : seuls les défauts qui empêchent RÉELLEMENT le
 * prompt de fonctionner bloquent l'activation ; les textes livrés passent.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { checkMasterPromptContent, MASTER_PROMPT_MAX_CHARS } from '../master-prompt-checks';
import { masterPromptForTreatment } from '../../config/prompt-architecture';
import { promptFileCandidates } from '../../prompts/prompt-loader';
import { existsSync } from 'node:fs';
import type { Treatment } from '../../config/treatments';
import { executionConfigFor } from '../structured-context';

const fichier = (t: Treatment) => {
  const code = masterPromptForTreatment(t)!.masterPromptCode;
  const p = promptFileCandidates(code, undefined, join(process.cwd(), 'src/services/ai/prompts')).find((x) => existsSync(x))!;
  return readFileSync(p, 'utf8');
};
const codes = (t: Treatment, texte: string) => checkMasterPromptContent(t, texte).blocking.map((i) => i.code);

describe('AC09 — contrôles techniques à l’activation', () => {
  it.each(['T1', 'T2', 'T3', 'T6'] as const)('%s : le texte livré passe sans blocage', (t) => {
    expect(checkMasterPromptContent(t, fichier(t))).toMatchObject({ ok: true, blocking: [] });
  });

  it('T4 : le texte livré (contexte structuré, lot 34D) passe sans blocage dans son mode déclaré', () => {
    const execution = executionConfigFor({ masterPromptCode: 't4_master_v1', source: 'file' });
    expect(execution.mode).toBe('STRUCTURED_CONTEXT');
    expect(checkMasterPromptContent('T4', fichier('T4'), execution)).toMatchObject({ ok: true, blocking: [], warnings: [] });
  });

  it('AC09 — prompt vide : bloquant, message clair', () => {
    for (const vide of ['', '   \n  ']) {
      const r = checkMasterPromptContent('T2', vide);
      expect(r.ok).toBe(false);
      expect(r.blocking).toEqual([expect.objectContaining({ code: 'PROMPT_EMPTY', message: 'Le prompt est vide.' })]);
    }
  });

  it('AC09 — placeholder inconnu du code : bloquant', () => {
    // Mode legacy (emplacements) : texte de référence legacy T4 livré à côté du fichier.
    const legacy = readFileSync(join(process.cwd(), 'src/services/ai/agenda/master/reference/t4_master_v1.legacy-template.txt'), 'utf8');
    expect(checkMasterPromptContent('T4', legacy).ok).toBe(true);
    const r = checkMasterPromptContent('T4', `${legacy}\n{{DONNEE_INEXISTANTE}}`);
    expect(r.blocking.map((i) => i.code)).toEqual(['UNKNOWN_PLACEHOLDER']);
    expect(r.blocking[0].message).toMatch(/\{\{DONNEE_INEXISTANTE\}\}.*inconnu/);
  });

  it('AC09 — variable fournie par le code mais sans emplacement (supprimée) : bloquant', () => {
    const t1 = fichier('T1');
    expect(t1).toContain('{{DOCUMENT_CATALOG}}');
    const r = checkMasterPromptContent('T1', t1.replace(/\{\{DOCUMENT_CATALOG\}\}/g, 'catalogue'));
    expect(r.blocking).toEqual([expect.objectContaining({ code: 'REQUIRED_PLACEHOLDER_MISSING', message: expect.stringMatching(/\{\{DOCUMENT_CATALOG\}\}/) })]);
  });

  it('AC09 — emplacement facultatif absent : avertissement, jamais bloquant', () => {
    const r = checkMasterPromptContent('T1', fichier('T1').replace(/\{\{ACCOUNT_CAPABILITIES\}\}/g, ''));
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(['OPTIONAL_PLACEHOLDER_MISSING']);
  });

  it('AC09 — configuration incohérente : branche ou emplacement de branche absent', () => {
    expect(codes('T3', fichier('T3').replace(/BRANCHE TASK = LINK_AMBIGUITY/g, 'SECTION'))).toEqual(['BRANCH_SECTION_MISSING']);
    expect(codes('T2', fichier('T2').replace(/\{\{MODE\}\}/g, 'MODE'))).toContain('BRANCH_PLACEHOLDER_MISSING');
  });

  it('AC09 — contenu invalide et dépassement de la limite technique', () => {
    expect(codes('T6', `${fichier('T6')}\u0007`)).toEqual(['INVALID_CONTENT']);
    expect(codes('T6', `${fichier('T6')}${' '.repeat(MASTER_PROMPT_MAX_CHARS)}`)).toEqual(['TOO_LONG']);
  });

  it('T5 n’est jamais vérifié comme prompt administrable (pas de master déclaré côté BO)', () => {
    // T5 a un master au registre, mais le BO ne l'administre pas (service) ;
    // le contrôle lui-même reste neutre : il ne dépend d'aucun autre prompt.
    expect(checkMasterPromptContent('T5', 'x').ok).toBe(false);
  });

  it('AC04 / AC05 — aucun contrôle ne porte sur le corpus : un texte valide passe sans aucune exécution', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/ai/master-prompts/master-prompt-checks.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/corpus|fingerprint|empreinte/i);
  });
});
