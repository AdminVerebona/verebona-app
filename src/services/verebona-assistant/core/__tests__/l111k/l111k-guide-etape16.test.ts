/**
 * Lot 111K — guide du PO, étape 17 (T2 `t2-evidence-relevance-v1`,
 * FACULTATIVE) : les trois blocs sont collés dans le texte T2 LIVRÉ comme le
 * ferait le PO (même fonction d'application que la mise en conformité
 * automatique, `prompt-conformity/correct.applyBlock`), puis vérifiés contre
 * le code réel : lignes repères, contrôles d'activation du BO, branches et
 * emplacements inchangés, exemples passés dans les schémas réels, la
 * validation de sortie et le contrôle final communs. Le code est sûr SANS
 * ces blocs (L111K-U*).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {}, ensureMigrations: vi.fn(), ensureUnaccent: vi.fn() }));

const { inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
const { guideBlock } = await import('@/services/ai/prompt-conformity/guide-blocks');
const { applyBlock } = await import('@/services/ai/prompt-conformity/correct');
const { MARKER_CONTRACT_DECLARATIONS } = await import('@/services/ai/prompt-conformity/contracts');
const { T2UnderstandOutput, T2AnswerOutput } = await import('@/services/ai/assistant/master/t2-contract');
const { toT2Understanding } = await import('@/services/ai/assistant/master/t2-understand');
const { t2AnswerLines } = await import('@/services/ai/assistant/master/t2-answer');
const { toGeneratedAnswer } = await import('../../generation.adapter');
const { validateGeneratedAnswer } = await import('../../response-validator.service');
const { controlFinalAnswer } = await import('../../final-answer-control');
const { analyzeQuestionFocus } = await import('../../question-focus');

const T2_LIVRE = readFileSync(join(process.cwd(), 'src', 'services', 'ai', 'prompts', 'assistant', 't2_master_v1.txt'), 'utf-8');
const occurrences = (t: string, ligne: string) => t.split('\n').filter((l) => l.trim() === ligne.trim()).length;
const IDS = ['t2-evidence-relevance-understand-v1', 't2-evidence-relevance-b12-v1', 't2-evidence-relevance-answer-v1'];
const blocs = IDS.map((id) => guideBlock(id)!);
const json = (texte: string) => JSON.parse(texte.slice(texte.indexOf('\n{') + 1, texte.lastIndexOf('}') + 1));

function coller(texte: string): string {
  let t = texte;
  for (const b of blocs) {
    const r = applyBlock(t, b, []);
    if (!r.ok) throw new Error(`${b.id} : ${r.code} ${r.message}`);
    t = r.text;
  }
  return t;
}

describe('L111K-U-GUIDE-17 — étape 17 : blocs T2 `t2-evidence-relevance-v1`', () => {
  it('trois blocs balisés (prompt t2), lignes repères présentes UNE fois dans le texte livré', () => {
    expect(blocs.map((b) => b && [b.prompt, b.action, b.anchor])).toEqual([
      ['t2', 'insert-before', 'SORTIE UNDERSTAND'],
      ['t2', 'replace-line', expect.stringMatching(/^B12 — PAYÉ ≠ COÛTÉ\./)],
      ['t2', 'insert-before', 'SORTIE ANSWER'],
    ]);
    for (const b of blocs) expect(occurrences(T2_LIVRE, b.anchor!), b.id).toBe(1);
    expect(blocs[0].text).toContain('t2-evidence-relevance-v1');
    expect(blocs[2].text).toContain('t2-evidence-relevance-v1');
  });

  it('collés comme le ferait le PO : B12 remplacée une fois, aucun bloquant BO, ni branche ni emplacement ajoutés', () => {
    const apres = coller(T2_LIVRE);
    expect(apres).not.toContain('sans preuve, dis que le règlement n’est pas confirmé. Une preuve');
    expect(apres.split('\n').filter((l) => l.startsWith('B12 — ')).length).toBe(1);
    expect(checkMasterPromptContent('T2', apres).blocking).toEqual(checkMasterPromptContent('T2', T2_LIVRE).blocking);
    expect(checkMasterPromptContent('T2', apres).warnings.map((w) => w.code)).toEqual(checkMasterPromptContent('T2', T2_LIVRE).warnings.map((w) => w.code));
    for (const b of blocs) expect(inspectMasterTemplate(b.text).placeholders, b.id).toEqual([]);
    expect(inspectMasterTemplate(apres).branches).toEqual(inspectMasterTemplate(T2_LIVRE).branches);
    expect(inspectMasterTemplate(apres).placeholders).toEqual(inspectMasterTemplate(T2_LIVRE).placeholders);
    // Aucune règle propre à une catégorie (assurance, franchise, facture) dans les règles elles-mêmes.
    const regles = blocs.map((b) => b.text.split('\nExemple')[0]).join('\n');
    expect(regles).not.toMatch(/\bSI (ASSURANCE|FACTURE)\b/i);
  });

  it('non déclaré pour l’application automatique (remplace une règle existante) : collage manuel seulement', () => {
    expect(MARKER_CONTRACT_DECLARATIONS.some((d) => IDS.includes(d.blockId))).toBe(false);
  });

  it('exemple 17-a : schéma réel UNDERSTAND, propriété hors catalogue conservée dans `requestedTopics`', () => {
    const u = toT2Understanding(T2UnderstandOutput.parse(json(blocs[0].text)) as never);
    expect(u.requestedFacts).toEqual([]);
    expect(u.requestedTopics).toEqual(['franchise']);
    expect(analyzeQuestionFocus('Quelle franchise s’applique sur l’assurance habitation de la maison ?', { requestedTopics: u.requestedTopics }).topics).toEqual(['franchise']);
  });

  it('exemple 17-c : schéma réel ANSWER, validation de sortie et contrôle final communs → réponse retenue telle quelle', () => {
    const sortie = T2AnswerOutput.parse(json(blocs[2].text));
    const sources = [{ id: 'doc_610', type: 'document_extraction' as const, title: 'Attestation assurance habitation', relevanceScore: 1,
      content: 'Assurance habitation · Prime annuelle : 480,00 € · Franchise : 300,00 € · Plafond mobilier : 20 000,00 €' }];
    const l = t2AnswerLines(sortie as never);
    const g = toGeneratedAnswer({ claims: l.lines as never, status: l.status }, sources, [], { verifySupport: true, supportEvents: [] })!;
    const v = validateGeneratedAnswer(g, 'ACCOUNT_FACT_ASSET')!;
    const fc = controlFinalAnswer({ focus: analyzeQuestionFocus('Quelle franchise s’applique sur l’assurance habitation de la maison ?'), path: 'generation',
      answer: v.answer, claims: v.claims, sources, rebuild: true });
    expect(fc.verdict).toBe('PASS');
    expect(v.answer).toBe('La franchise de l’assurance habitation est de 300,00 € par sinistre.');
  });
});
