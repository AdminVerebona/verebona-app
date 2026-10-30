/**
 * Lot 89C — vérification du guide `docs/exploitation/prompts-a-appliquer-par-le-po.md`.
 *
 * Le guide donne au PO des blocs de texte à coller dans le BO (prompts
 * maîtres T3 et T6). Ce test les rejoue tels quels, SANS modifier aucun
 * fichier de prompt du dépôt :
 *
 *  L89C-U01  chaque bloc balisé s'applique au texte livré (ligne repère trouvée une seule fois) ;
 *  L89C-U02  T3 après bloc 1 : contrôles d'activation du BO sans bloquant, branche KNOWLEDGE_QUERY
 *            détectée, contrat v1 lu, v2 NON lu (88B reste prudent), rendu réel 85F ;
 *  L89C-U03  T3 après blocs 1 + 2 : marqueur `t3-knowledge-query-v2` lu, rendu réel 88B ;
 *  L89C-U04  T6 après bloc 3 : `promptSupportsSuggestionGrounds` vrai (faux sur le texte livré),
 *            EVALUATE et rappel informatif conservés, contrôles BO sans bloquant, rendu FORMULATE ;
 *  L89C-U05  chaque exemple JSON des blocs T3 passe le schéma `T3KnowledgeQueryOutput`, puis la
 *            validation serveur réelle (`validateFinding` pour v1, `decideProperties` pour v2) ;
 *  L89C-U06  chaque exemple JSON du bloc T6 passe `T6FormulateOutput` et chaque question passe
 *            `validateT6SuggestionsDetailed` sans rejet, sur un contexte construit par le code ;
 *  L89C-U07  le guide cite les marqueurs exacts du code (constantes, pas de copie divergente).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { inspectMasterTemplate, renderMasterPrompt } = await import('@/services/ai/prompts/prompt-loader');
const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
const { listMasterTasks } = await import('@/services/ai/registry/operations');
const kq = await import('@/services/ai/reconciliation/knowledge-query/contract');
const { knowledgeContractsIn } = await import('@/services/ai/reconciliation/knowledge-query/model');
const { validateFinding } = await import('@/services/ai/reconciliation/knowledge-query/validate');
const { defaultNormalizers } = await import('@/services/ai/reconciliation/knowledge-query/service');
const mp = await import('@/services/ai/reconciliation/missing-properties/contract');
const { decideProperties } = await import('@/services/ai/reconciliation/missing-properties/decide');
const { questionOf } = await import('@/services/ai/reconciliation/missing-properties/catalog');
const { getField } = await import('@/services/canonical/registry');
const t6s = await import('@/services/home/mascot/t6-suggestions');
const { T6FormulateOutput } = await import('@/services/home/mascot/t6-contract');
const { promptSupportsEvaluation, promptSupportsInformativeReminder } = await import('@/services/home/mascot/t6-runner');

const RACINE = process.cwd();
const GUIDE = readFileSync(join(RACINE, 'docs', 'exploitation', 'prompts-a-appliquer-par-le-po.md'), 'utf-8');
const LIVRE = {
  t3: readFileSync(join(RACINE, 'src', 'services', 'ai', 'prompts', 'reconciliation', 't3_master_v1.txt'), 'utf-8'),
  t6: readFileSync(join(RACINE, 'src', 'services', 'ai', 'prompts', 'mascot', 't6_master_v1.txt'), 'utf-8'),
} as const;

// ── Lecture des blocs balisés du guide ──────────────────────────────────────

interface Bloc { id: string; prompt: 't3' | 't6'; action: string; attrs: Record<string, string>; text: string }

function blocs(md: string): Bloc[] {
  const out: Bloc[] = [];
  const re = /<!-- l89c:bloc ([^>]*?) -->\s*\n```text\n([\s\S]*?)\n```/g;
  for (const m of md.matchAll(re)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    out.push({ id: attrs.id, prompt: attrs.prompt as 't3' | 't6', action: attrs.action, attrs, text: m[2] });
  }
  return out;
}

const occurrences = (texte: string, motif: string) => texte.split(motif).length - 1;

/** Applique un bloc comme le PO (édition dans la zone de texte du brouillon). */
function appliquer(texte: string, b: Bloc): string {
  if (b.action === 'replace-line') {
    expect(occurrences(texte, b.attrs.anchor), `${b.id} : ligne repère`).toBe(1);
    return texte.replace(b.attrs.anchor, b.text);
  }
  if (b.action === 'insert-before') {
    expect(occurrences(texte, b.attrs.anchor), `${b.id} : ligne repère`).toBe(1);
    return texte.replace(b.attrs.anchor, `${b.text}\n\n${b.attrs.anchor}`);
  }
  if (b.action === 'replace-from-to') {
    expect(occurrences(texte, b.attrs.from), `${b.id} : ligne de début`).toBe(1);
    expect(occurrences(texte, b.attrs.to), `${b.id} : ligne de fin`).toBe(1);
    const i = texte.indexOf(b.attrs.from);
    const j = texte.indexOf(b.attrs.to);
    expect(i).toBeLessThan(j);
    return `${texte.slice(0, i)}${b.text}\n\n${texte.slice(j)}`;
  }
  throw new Error(`action inconnue : ${b.action}`);
}

/** Objets JSON d'un bloc : toute ligne qui COMMENCE par « { », jusqu'à l'accolade fermante équilibrée. */
function jsonsDe(texte: string): unknown[] {
  const out: unknown[] = [];
  const lignes = texte.split('\n');
  for (let k = 0; k < lignes.length; k++) {
    if (!lignes[k].startsWith('{')) continue;
    let prof = 0; let dansChaine = false; let echap = false; let fin = -1;
    const reste = lignes.slice(k).join('\n');
    for (let c = 0; c < reste.length; c++) {
      const ch = reste[c];
      if (dansChaine) { if (echap) echap = false; else if (ch === '\\') echap = true; else if (ch === '"') dansChaine = false; continue; }
      if (ch === '"') dansChaine = true;
      else if (ch === '{') prof += 1;
      else if (ch === '}') { prof -= 1; if (prof === 0) { fin = c; break; } }
    }
    expect(fin, `JSON non fermé à la ligne ${k + 1}`).toBeGreaterThan(0);
    const brut = reste.slice(0, fin + 1);
    out.push(JSON.parse(brut));
    k += brut.split('\n').length - 1;
  }
  return out;
}

const B = blocs(GUIDE);
const bloc = (id: string) => { const b = B.find((x) => x.id === id); expect(b, `bloc ${id}`).toBeTruthy(); return b!; };

const T3_ETAPE1 = appliquer(appliquer(LIVRE.t3, bloc('t3-valeurs')), bloc('t3-knowledge-query-v1'));
const T3_ETAPE2 = appliquer(T3_ETAPE1, bloc('t3-knowledge-query-v2'));
const T6_ETAPE3 = appliquer(LIVRE.t6, bloc('t6-suggestions-v3'));

const bloquants = (t: 'T3' | 'T6', texte: string) => checkMasterPromptContent(t, texte).blocking.map((i) => i.message);

describe('L89C-U01 — blocs du guide', () => {
  it('cinq blocs balisés, chacun applicable une seule fois au texte livré', () => {
    // Lot 91D : bloc T1 `t1-value-decisions-v1` (rejoué par l91d-decisions-valeurs.test.ts).
    // Lot 97A : blocs T3 `t3-operation-identity-v1` et T4 `t4-agenda-representation-v1` (rejoués par l97a-guide-t3-t4.test.ts).
    expect(B.map((b) => b.id)).toEqual(['t3-valeurs', 't3-knowledge-query-v1', 't3-knowledge-query-v2', 't6-suggestions-v3', 't1-value-decisions-v1', 't3-operation-identity-v1', 't4-agenda-representation-v1',
      // Lot 98A : étape 7 (T3, rejouée par l98a-guide-etape7.test.ts).
      't3-knowledge-query-constituants', 't3-knowledge-query-exemple-complet',
      // Lot 99C : étape 9 (T3 DOCUMENT_NAMING, rejouée par l99c-representation-periode.test.ts).
      't3-naming-period-v1',
      // Lot 101A : étapes 10 (T1) et 11 (T2), rejouées par l101a-guide-etapes-10-11.test.ts.
      't1-product-identity-v1', 't2-property-continuity-v1']);
    // Aucun bloc n'introduit un emplacement {{X}} (bloquant au BO : « emplacement inconnu »).
    for (const b of B) expect(inspectMasterTemplate(b.text).placeholders, b.id).toEqual([]);
  });
});

describe('L89C-U02 — T3 après le bloc 1 (lot 85F)', () => {
  it('le texte livré ne porte pas la branche (constat actuel) ; le texte modifié la porte', () => {
    expect(inspectMasterTemplate(LIVRE.t3).branches).not.toContain(kq.KNOWLEDGE_QUERY_TASK);
    expect(inspectMasterTemplate(T3_ETAPE1).branches).toContain(kq.KNOWLEDGE_QUERY_TASK);
  });
  it('contrôles d’activation du BO : aucun bloquant, plus d’avertissement de branche absente', () => {
    expect(bloquants('T3', T3_ETAPE1)).toEqual([]);
    const avert = checkMasterPromptContent('T3', T3_ETAPE1).warnings.map((w) => w.message).join('\n');
    expect(avert).not.toMatch(/KNOWLEDGE_QUERY/);
    expect(checkMasterPromptContent('T3', LIVRE.t3).warnings.map((w) => w.message).join('\n')).toMatch(/BRANCHE TASK = KNOWLEDGE_QUERY/);
  });
  it('contrat v1 lu, v2 NON lu : 88B reste prudent après la seule étape 1', () => {
    expect(knowledgeContractsIn(T3_ETAPE1)).toEqual([kq.KNOWLEDGE_QUERY_CONTRACT_VERSION]);
    expect(knowledgeContractsIn(T3_ETAPE1)).not.toContain(mp.MISSING_PROPERTIES_CONTRACT_VERSION);
  });
  it('rendu réel de la branche avec les variables de production (85F)', () => {
    const variables = kq.knowledgeQueryVariables({
      question: { key: 'contractEndDate', label: 'Date de fin', valueType: 'date', businessQuestion: 'Quand le contrat se termine-t-il ?', ruleCode: 'DATA-CONTRACT-END', constituents: [] },
      documents: [{ ref: 'D1', fileId: 1, role: 'TARGET', relation: null, title: 'Contrat', documentType: null }],
      page: { index: 1, count: 1, elements: [] }, today: '2026-10-25',
    });
    const rendu = renderMasterPrompt(T3_ETAPE1, { masterPromptCode: 't3_master_v1', task: 'KNOWLEDGE_QUERY', variables, allowedTasks: listMasterTasks('t3_master_v1') });
    expect(rendu).toContain('BRANCHE TASK = KNOWLEDGE_QUERY');
    expect(rendu).toContain('t3-knowledge-query-v1');
    // Les autres branches restent rendables (aucun emplacement ajouté).
    for (const task of ['VALUE_CONFLICT', 'LINK_AMBIGUITY', 'OPERATION_MATCH', 'DOCUMENT_NAMING']) {
      expect(() => renderMasterPrompt(T3_ETAPE1, { masterPromptCode: 't3_master_v1', task, variables, allowedTasks: listMasterTasks('t3_master_v1') })).not.toThrow();
    }
  });
});

describe('L89C-U03 — T3 après les blocs 1 et 2 (lot 88B)', () => {
  it('marqueur v2 lu dans le texte effectif, contrôles BO sans bloquant', () => {
    expect(knowledgeContractsIn(T3_ETAPE2)).toEqual(['t3-knowledge-query-v1', mp.MISSING_PROPERTIES_CONTRACT_VERSION]);
    expect(inspectMasterTemplate(T3_ETAPE2).branches).toContain('KNOWLEDGE_QUERY');
    expect(bloquants('T3', T3_ETAPE2)).toEqual([]);
    expect(T3_ETAPE2.length).toBeLessThan(100_000);
  });
  it('rendu réel avec les variables du contrat d’entrée v2', () => {
    const variables = mp.missingPropertiesVariables({
      subject: { type: 'ASSET', category: 'IMMOBILIER', subtype: null, family: null },
      properties: [questionOf(getField('acquisitionPrice')!)],
      documents: [], page: { index: 1, count: 1, elements: [] }, today: '2026-10-25', truncated: false,
    });
    const rendu = renderMasterPrompt(T3_ETAPE2, { masterPromptCode: 't3_master_v1', task: 'KNOWLEDGE_QUERY', variables, allowedTasks: listMasterTasks('t3_master_v1') });
    expect(rendu).toContain('"contractVersion":"t3-knowledge-query-v2"');
  });
});

describe('L89C-U04 — T6 après le bloc 3 (lot 87C)', () => {
  it('le texte livré ne porte pas le contrat ; le texte modifié le porte', () => {
    expect(t6s.promptSupportsSuggestionGrounds(LIVRE.t6)).toBe(false);
    expect(t6s.promptSupportsSuggestionGrounds(T6_ETAPE3)).toBe(true);
    expect(T6_ETAPE3).toContain(t6s.T6_SUGGESTION_CONTRACT);
  });
  it('EVALUATE et rappel informatif conservés ; contrôles BO sans bloquant ni avertissement', async () => {
    expect(await promptSupportsEvaluation(T6_ETAPE3)).toBe(true);
    expect(promptSupportsInformativeReminder(T6_ETAPE3)).toBe(true);
    expect(bloquants('T6', T6_ETAPE3)).toEqual([]);
    expect(checkMasterPromptContent('T6', T6_ETAPE3).warnings).toEqual([]);
  });
  it('rendu réel FORMULATE', () => {
    const rendu = renderMasterPrompt(T6_ETAPE3, {
      masterPromptCode: 't6_master_v1', task: 'FORMULATE', allowedTasks: listMasterTasks('t6_master_v1'),
      variables: { INPUT_JSON: { subjects: [] }, SUGGESTION_CONTEXT: { schemaVersion: 't6-suggestions-v3' }, INTERPELLATION_CONTEXT: null },
    });
    expect(rendu).toContain('"groundRefs"');
  });
});

describe('L89C-U05 — exemples JSON T3 contre le validateur serveur', async () => {
  const norm = await defaultNormalizers();

  it('bloc 1 : trois exemples, schéma + validation de chaque constat (monde fermé, extrait recopié, valeur normalisée)', () => {
    const exemples = jsonsDe(bloc('t3-knowledge-query-v1').text);
    expect(exemples).toHaveLength(3);
    const elements = new Map([
      ['U-12', { ref: 'U-12', document: 'D1', fileId: 1, layer: 'SOURCE_UNIT', kind: 'TEXT_BLOCK', label: null, value: null, text: 'Conditions particulières. Date d’effet : 15/03/2024. Durée : un an.', confidence: 'certain', page: 1 }],
      ['U-7', { ref: 'U-7', document: 'D1', fileId: 1, layer: 'SOURCE_UNIT', kind: 'TEXT_BLOCK', label: null, value: null, text: 'Le montant du prêt est de 490000,00 euros. La durée est égale à 22 ans', confidence: 'certain', page: 2 }],
    ] as Array<[string, import('@/services/ai/reconciliation/knowledge-query/contract').KnowledgeElement]>);
    const q = { valueType: 'date' as const, constituents: [{ role: 'start' as const, key: 'contractStartDate', label: null, valueType: 'date' as const }, { role: 'duration' as const, key: 'contractDuration', label: null, valueType: 'duration' as const }] };
    const issues: string[] = [];
    for (const brut of exemples) {
      const sortie = kq.T3KnowledgeQueryOutput.parse(brut);
      issues.push(sortie.outcome);
      for (const f of sortie.findings) {
        const r = validateFinding(f, q, elements, norm);
        expect(r.ok, `${sortie.outcome} / ${f.target} : ${r.ok ? '' : r.rejection.code}`).toBe(true);
        if (r.ok && f.target === 'FIELD') expect(r.finding.normalized).toBe('2024-03-15');
        if (r.ok && f.target === 'duration') expect(r.finding.normalized).toBe('264');
      }
    }
    expect(issues).toEqual(['FOUND', 'CONSTITUENTS', 'NOT_FOUND']);
  });

  it('bloc 2 : l’exemple v2 est accepté et la propriété est ÉTABLIE par la décision serveur réelle', () => {
    const [exemple] = jsonsDe(bloc('t3-knowledge-query-v2').text);
    const sortie = kq.T3KnowledgeQueryOutput.parse(exemple);
    const prop = questionOf(getField('acquisitionPrice')!);
    const page = {
      index: 1, count: 1,
      elements: [{
        ref: 'F-88', document: 'D1', fileId: 5, layer: 'FACT' as const, kind: 'prixVente', label: 'Acte de vente', value: '245 000 €',
        text: 'Prix de vente : 245 000 € payé comptant.', confidence: 'certain' as const, page: 3, provenance: { fileIds: [5], agendaItemIds: [] },
      }],
    };
    const [d] = decideProperties({ properties: [prop], answers: [{ page, output: sortie }], complete: true, norm });
    expect(d).toMatchObject({ key: 'acquisitionPrice', decision: 'ESTABLISHED', value: 245000 });
  });

  it('garde du schéma : « FOUND » sans cible FIELD est refusé (raison de l’issue CONSTITUENTS imposée en v2)', () => {
    const [exemple] = jsonsDe(bloc('t3-knowledge-query-v2').text) as Array<Record<string, unknown>>;
    expect(kq.T3KnowledgeQueryOutput.safeParse({ ...exemple, outcome: 'FOUND' }).success).toBe(false);
  });
});

describe('L89C-U06 — exemples JSON T6 contre le validateur serveur', () => {
  const ligne = (id: number, title: string, date: string, assetId: number | null) => ({
    id, title, date, forecast: false, requiresQualification: false, assetId, assetName: null,
  }) as unknown as import('@/services/home/mascot/signals').MascotAgendaRow;
  const bundle = t6s.buildT6SuggestionContext({
    speech: 'Un entretien de chaudière arrive bientôt.', attentionToday: true,
    state: { documentsTotal: 4, documentsInAnalysis: 1, deadlinesUpcoming: 2 },
    operations: 0,
    assets: [{ id: 11, name: 'Clio', documents: 1 }, { id: 12, name: 'Maison', documents: 3 }],
    agenda: [ligne(101, 'Contrôle technique', '2026-12-10', 11), ligne(102, 'Entretien de la chaudière', '2026-11-05', 12)],
    labelOf: (r) => r.title, formatDate: (d) => d, today: '2026-10-25',
    signaledIds: new Set([102]),
    grounds: new Map([[102, {
      description: 'Entretien annuel obligatoire de la chaudière gaz.',
      decision: { decision: 'SHOW_NOW', category: 'ACTION_NOW', reasonCode: 'ACTION_REQUIRED_SOON', uncertainties: [], action: 'Prendre rendez-vous avec le chauffagiste', actionEstablished: true },
    }]]),
  });

  it('le contexte construit par le code expose les références citées par les exemples', () => {
    for (const ref of ['D1', 'D2', 'D2.ACTION', 'D2.DESC', 'ACC.DOCUMENTS_IN_ANALYSIS']) expect(bundle.grounds!.has(ref), ref).toBe(true);
    expect(bundle.context.schemaVersion).toBe('t6-suggestions-v3');
  });

  it('sortie FORMULATE : schéma de la bulle, puis chaque question acceptée sans rejet', () => {
    const exemples = jsonsDe(bloc('t6-suggestions-v3').text);
    expect(exemples).toHaveLength(2);
    const [prepare, sortieBrute] = exemples as [Record<string, unknown>, Record<string, unknown>];
    const sortie = T6FormulateOutput.parse(sortieBrute);
    expect(sortie.schemaVersion).toBe('t6-output-v2');
    const v = t6s.validateT6SuggestionsDetailed(sortie.suggestions, bundle.assetIds, bundle);
    expect(v.rejected).toEqual([]);
    expect(v.accepted.map((s) => [s.subject, s.purpose])).toEqual([['DEADLINE', 'CONSULT'], ['DOCUMENTS', 'CONSULT']]);
    const p = t6s.validateT6SuggestionsDetailed([prepare], bundle.assetIds, bundle);
    expect(p.rejected).toEqual([]);
    expect(p.accepted[0]).toMatchObject({ subject: 'DEADLINE', purpose: 'PREPARE', deadlineRef: 'D2' });
  });

  it('sans le contrat (texte livré), les mêmes questions ne seraient jamais publiées', () => {
    const [, sortieBrute] = jsonsDe(bloc('t6-suggestions-v3').text) as Array<Record<string, unknown>>;
    const v = t6s.validateT6SuggestionsDetailed((sortieBrute as { suggestions: unknown }).suggestions, bundle.assetIds, { ...bundle, contract: undefined });
    expect(v.accepted).toEqual([]);
    expect(new Set(v.rejected.map((r) => r.reason))).toEqual(new Set(['contract_unsupported']));
  });
});

describe('L89C-U07 — le guide cite les marqueurs exacts du code', () => {
  it('constantes du code présentes dans le guide', () => {
    for (const m of [
      kq.KNOWLEDGE_QUERY_CONTRACT_VERSION, mp.MISSING_PROPERTIES_CONTRACT_VERSION, t6s.T6_SUGGESTION_CONTRACT,
      kq.KNOWLEDGE_QUERY_PENDING_CONTRACT, mp.MISSING_PROPERTIES_PENDING_CONTRACT, 'BRANCHE TASK = KNOWLEDGE_QUERY', '"groundRefs"', '{{SUGGESTION_CONTEXT}}',
      'MISSING_PROPERTY_ARBITRATION_PENDING', 'INTERPRETATION_PENDING',
    ]) expect(GUIDE, m).toContain(m);
  });
});
