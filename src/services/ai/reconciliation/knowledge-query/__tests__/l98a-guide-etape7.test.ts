/**
 * Lot 98A (P0-A) — guide du PO, étape 7 (T3 : constituants complets dans
 * KNOWLEDGE_QUERY). Les blocs 7-a et 7-b sont rejoués tels quels, comme le PO
 * les colle, SANS modifier aucun fichier de prompt du dépôt :
 *
 *  L98A-G01  les deux blocs s'appliquent une seule fois après l'étape 1, et aussi
 *            après les étapes 1 + 2 + 5 (lignes repères uniques) ;
 *  L98A-G02  contrôles d'activation du BO sans bloquant ; branche détectée ; aucun
 *            contrat d'entrée nouveau lu par le code (la capacité reste celle de
 *            l'étape 1) ; rendu réel de la branche avec la règle K6, sans
 *            l'ancien exemple « durée seule » ;
 *  L98A-G03  texte générique : chaque rôle de constituant du contrat est décrit,
 *            aucun nom de banque ni montant du cas réel ;
 *  L98A-G04  l'exemple JSON passe le schéma, la validation serveur réelle et la
 *            recette (P-T3-KQ-07 : réponse complète, NO_ACTION / UNDATED_NOT_NEEDED) ;
 *            l'ancien exemple « durée seule » serait une réponse INCOMPLÈTE.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { inspectMasterTemplate, renderMasterPrompt } = await import('@/services/ai/prompts/prompt-loader');
const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
const { listMasterTasks } = await import('@/services/ai/registry/operations');
const kq = await import('../contract');
const { knowledgeContractsIn } = await import('../model');
const { validateKnowledgeAnswer } = await import('../validate');
const svc = await import('../service');
const { MASTER_CORPUS_EVALUATORS } = await import('@/services/ai/governance/master-corpus/evaluators');
const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
const { getRule } = await import('@/services/to-process/rules-catalog');

const RACINE = process.cwd();
const GUIDE = readFileSync(join(RACINE, 'docs', 'exploitation', 'prompts-a-appliquer-par-le-po.md'), 'utf-8');
const LIVRE_T3 = readFileSync(join(RACINE, 'src', 'services', 'ai', 'prompts', 'reconciliation', 't3_master_v1.txt'), 'utf-8');

interface Bloc { id: string; attrs: Record<string, string>; text: string }
function bloc(id: string): Bloc {
  const re = new RegExp(`<!-- l89c:bloc ([^>]*?id="${id}"[^>]*?) -->\\s*\\n\`\`\`text\\n([\\s\\S]*?)\\n\`\`\``);
  const m = re.exec(GUIDE);
  if (!m) throw new Error(`bloc ${id} absent du guide`);
  return { id, attrs: Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]])), text: m[2] };
}
const occurrences = (texte: string, motif: string) => texte.split(motif).length - 1;
/** Applique un bloc comme le PO (mêmes actions que le test du lot 89C). */
function appliquer(texte: string, b: Bloc): string {
  if (b.attrs.action === 'replace-line' || b.attrs.action === 'insert-before') {
    expect(occurrences(texte, b.attrs.anchor), `${b.id} : ligne repère`).toBe(1);
    return b.attrs.action === 'replace-line' ? texte.replace(b.attrs.anchor, b.text) : texte.replace(b.attrs.anchor, `${b.text}\n\n${b.attrs.anchor}`);
  }
  expect(b.attrs.action).toBe('replace-from-to');
  expect(occurrences(texte, b.attrs.from), `${b.id} : ligne de début`).toBe(1);
  expect(occurrences(texte, b.attrs.to), `${b.id} : ligne de fin`).toBe(1);
  const i = texte.indexOf(b.attrs.from);
  const j = texte.indexOf(b.attrs.to);
  expect(i).toBeLessThan(j);
  return `${texte.slice(0, i)}${b.text}\n\n${texte.slice(j)}`;
}
function jsonsDe(texte: string): unknown[] {
  const out: unknown[] = [];
  const lignes = texte.split('\n');
  for (let k = 0; k < lignes.length; k++) {
    if (!lignes[k].startsWith('{')) continue;
    const reste = lignes.slice(k).join('\n');
    let prof = 0; let chaine = false; let echap = false; let fin = -1;
    for (let c = 0; c < reste.length; c++) {
      const ch = reste[c];
      if (chaine) { if (echap) echap = false; else if (ch === '\\') echap = true; else if (ch === '"') chaine = false; continue; }
      if (ch === '"') chaine = true; else if (ch === '{') prof += 1; else if (ch === '}') { prof -= 1; if (prof === 0) { fin = c; break; } }
    }
    const brut = reste.slice(0, fin + 1);
    out.push(JSON.parse(brut));
    k += brut.split('\n').length - 1;
  }
  return out;
}

const ETAPE1 = appliquer(appliquer(LIVRE_T3, bloc('t3-valeurs')), bloc('t3-knowledge-query-v1'));
const B7A = bloc('t3-knowledge-query-constituants');
const B7B = bloc('t3-knowledge-query-exemple-complet');
const ETAPE7 = appliquer(appliquer(ETAPE1, B7A), B7B);

describe('L98A-G01 — blocs de l’étape 7 applicables', () => {
  it('après l’étape 1 seule, et après les étapes 1 + 2 + 5', () => {
    expect(ETAPE7).toContain('K6 — CONSTITUANTS COMPLETS');
    const tout = appliquer(appliquer(ETAPE1, bloc('t3-knowledge-query-v2')), bloc('t3-operation-identity-v1'));
    const avec7 = appliquer(appliquer(tout, B7A), B7B);
    expect(avec7).toContain('kq-constituants-complets-v1');
    expect(checkMasterPromptContent('T3', avec7).blocking).toEqual([]);
  });
  it('les lignes repères n’existent pas dans le texte livré (étape 1 obligatoire)', () => {
    expect(occurrences(LIVRE_T3, B7A.attrs.anchor)).toBe(0);
    expect(occurrences(LIVRE_T3, B7B.attrs.from)).toBe(0);
  });
});

describe('L98A-G02 — contrôles BO, capacité inchangée, rendu réel', () => {
  it('aucun bloquant, branche détectée, contrat d’entrée v1 seul (aucun marqueur nouveau lu par le code)', () => {
    expect(checkMasterPromptContent('T3', ETAPE7).blocking).toEqual([]);
    expect(inspectMasterTemplate(ETAPE7).branches).toContain(kq.KNOWLEDGE_QUERY_TASK);
    expect(inspectMasterTemplate(B7A.text).placeholders).toEqual([]);
    expect(inspectMasterTemplate(B7B.text).placeholders).toEqual([]);
    expect(knowledgeContractsIn(ETAPE7)).toEqual([kq.KNOWLEDGE_QUERY_CONTRACT_VERSION]);
  });
  it('rendu de la branche : règle K6, nouvel exemple complet, plus d’exemple « durée seule »', () => {
    const variables = kq.knowledgeQueryVariables({
      question: { key: 'contractEndDate', label: 'Date de fin', valueType: 'date', businessQuestion: 'Quelle est la date de fin de ce contrat ?', ruleCode: 'DATA-CONTRACT-END', constituents: [] },
      documents: [{ ref: 'D0', fileId: 1, role: 'TARGET', relation: null, title: 'Contrat', documentType: null }],
      page: { index: 1, count: 1, elements: [] }, today: '2026-10-27',
    });
    const rendu = renderMasterPrompt(ETAPE7, { masterPromptCode: 't3_master_v1', task: 'KNOWLEDGE_QUERY', variables, allowedTasks: listMasterTasks('t3_master_v1') });
    expect(rendu).toContain('K6 — CONSTITUANTS COMPLETS');
    expect(rendu).toContain('"target": "repayment"');
    expect(rendu).not.toContain('Exemple avec un constituant seulement');
  });
});

describe('L98A-G03 — texte générique, selon le contrat', () => {
  it('chaque rôle de constituant du contrat est décrit ; aucune référence au cas réel', () => {
    for (const role of Object.keys(kq.CONSTITUENT_VALUE_TYPES)) expect(B7A.text, role).toMatch(new RegExp(`\\n  · [^\\n]*\\b${role}\\b[^\\n]* — `));
    expect(`${B7A.text}\n${B7B.text}`).not.toMatch(/BNP|490000|22 ans/);
  });
});

describe('L98A-G04 — exemple validé par le serveur et par la recette', async () => {
  const norm = await svc.defaultNormalizers();
  const question = await svc.buildKnowledgeQuestion(getRule('DATA-CONTRACT-END')!, 'contractEndDate');
  const kq07 = loadMasterCorpusCases(readMasterFileFromRepo).find((c) => c.id === 'P-T3-KQ-07')!;
  const elements = (kq07.context as { knowledgeQuery: { elements: import('../contract').KnowledgeElement[] } }).knowledgeQuery.elements;
  const kq01 = loadMasterCorpusCases(readMasterFileFromRepo).find((c) => c.id === 'P-T3-KQ-01')!;

  it('schéma + validation réelle : durée 60 mois et indice de remboursement retenus, aucun refus', () => {
    const [exemple] = jsonsDe(B7B.text);
    const v = validateKnowledgeAnswer(kq.T3KnowledgeQueryOutput.parse(exemple), question, elements, norm);
    expect(v.rejected).toEqual([]);
    expect(v.outcome).toBe('CONSTITUENTS');
    expect(v.findings.map((f) => [f.target, f.normalized])).toEqual([['duration', '60'], ['repayment', null]]);
  });
  it('recette : l’exemple réussit P-T3-KQ-07 (complet, date de fin non nécessaire)', async () => {
    const [exemple] = jsonsDe(B7B.text);
    expect(await MASTER_CORPUS_EVALUATORS.t3_knowledge_query(kq07, exemple, { masterText: readMasterFileFromRepo })).toEqual([]);
  });
  it('l’ancien exemple « durée seule » (bloc 1) appliqué au cas réel : réponse INCOMPLÈTE', async () => {
    const ancien = jsonsDe(bloc('t3-knowledge-query-v1').text)[1] as { findings: Array<Record<string, unknown>> };
    const sortie = { ...ancien, findings: ancien.findings.map((f) => ({ ...f, evidenceRefs: ['U-1'] })) };
    const e = await MASTER_CORPUS_EVALUATORS.t3_knowledge_query(kq01, sortie, { masterText: readMasterFileFromRepo });
    expect(e.join(' ; ')).toMatch(/constituant\(s\) manquant\(s\) repayment/);
  });
});
