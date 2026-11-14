/**
 * Lot 113AD (Trello #725, D11 de #724, R13 / R14) — réexamen T3 par l'IA d'une divergence de périodes que les
 * documents ne déclarent pas (branche PERIOD_RELATION, contrat `t3-period-relation-v1`, bloc 29 du guide).
 * Sorties IA SIMULÉES (jamais d'appel Gemini), aucune base.
 *
 *   L113AD-U-REGISTRE   opération du registre IA, schéma au catalogue master, contrat runtime, branche FACULTATIVE dont le
 *                       texte est collé par le PO, diagnostic global ; aucun prompt du dépôt modifié ;
 *   L113AD-U-VALIDATION validation STRICTE : chaque classement, schéma, extrait inventé, remplacement sans preuve du document
 *                       qui remplace, période corrigée protégée, confiance insuffisante — toute sortie invalide = abstention ;
 *   L113AD-U-RESOLUTION intégration dans `resolvePeriods` : succession / même fait / natures différentes → aucune question ;
 *                       avenant / rectificatif → remplacement de la SEULE période concernée ; contradiction / abstention /
 *                       examen sans effet → comportement 113AA ; examen en attente → question différée ; décision de
 *                       l'utilisateur TOUJOURS prioritaire ; période corrigée jamais remplacée ;
 *   L113AD-U-MEMOIRE    lecture de la mémoire (états, preuve, délai d'attente) ; une demande n'est posée qu'une fois ;
 *   L113AD-U-GUIDE      bloc 29 balisé, applicable au T3 livré, rendu réel ; exemples validés contre les cas du corpus ;
 *                       diagnostic BO « absent » puis « satisfait » ; capacité (branche + marqueur, coupure d'urgence) ;
 *   L113AD-U-CORPUS     cas du corpus rejoués sur le texte T3 + bloc 29 par le contrôle serveur réel ; manifeste à jour.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const prc = await import('../relation-contract');
const res = await import('../resolution');
const dec = await import('../relation-decider');
const { loadRelationStates, requestRelationReviews, PERIOD_RELATION_MAX_WAIT_HOURS } = await import('../relation-review');
const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
const { evaluateCorpusOutput } = await import('@/services/ai/governance/master-corpus/runner');

const RACINE = process.cwd();
const lire = (p: string) => readFileSync(join(RACINE, p), 'utf8');
const GUIDE = lire('docs/exploitation/prompts-a-appliquer-par-le-po.md');
const LIVRE_T3 = lire('src/services/ai/prompts/reconciliation/t3_master_v1.txt');
const REPERE = 'Réponds uniquement par le JSON correspondant au TASK demandé.';
const FX = (n: string) => JSON.parse(lire(`src/services/ai/reconciliation/master/__fixtures__/${n}`)) as {
  case: string; context: { periodRelation: import('../relation-contract').RawRelationContext }; recording: { output: Record<string, unknown> }; expected: Record<string, unknown>;
};
const AVENANT = FX('p-t3-pr-01-avenant-non-declare.json');
const CONTRA = FX('p-t3-pr-02-contradiction-reelle.json');

const sortie = (o: Partial<import('../relation-contract').T3PeriodRelationOutput> = {}) => ({
  task: 'PERIOD_RELATION', relation: 'SUCCESSION', replacingPeriod: null, confidence: 'certain',
  evidence: [{ document: 'D1', excerpt: 'Période de garantie : du 01/04/2025 au 31/03/2026' }], reason: 'Les périodes se suivent.', ...o,
});
const scopeAvenant = () => prc.buildRelationInput(AVENANT.context.periodRelation).scope;

describe('L113AD-U-REGISTRE — opération, schéma, branche facultative, diagnostic', () => {
  it('opération master active du prompt T3 existant (six emplacements), non facturée ; schéma et contrat runtime', async () => {
    const { AI_OPERATIONS, listMasterTasks, T3_MASTER_VARIABLES } = await import('@/services/ai/registry/operations');
    const { masterOutputSchemaFor } = await import('@/services/ai/gateway/master-output-schemas');
    const { contractVersionsOf } = await import('@/services/ai/gateway/output-resolution/runtime-contract');
    const { DIAG_AI_OPERATION_COVERAGE } = await import('@/services/admin/diagnostics-export/coverage');
    expect(AI_OPERATIONS.t3_period_relation).toMatchObject({
      masterPromptCode: 't3_master_v1', task: 'PERIOD_RELATION', outputSchema: 'T3PeriodRelationOutput', active: true, billable: false,
      useCaseCode: 'DATA_RECONCILIATION', promptVariables: T3_MASTER_VARIABLES,
    });
    expect(listMasterTasks('t3_master_v1')).toContain('PERIOD_RELATION');
    expect(masterOutputSchemaFor('T3PeriodRelationOutput')).toBe(prc.T3PeriodRelationOutput);
    expect(contractVersionsOf('T3PeriodRelationOutput')).toContain(1);
    expect(DIAG_AI_OPERATION_COVERAGE.t3_period_relation.tables).toContain('business_period_relation_reviews');
    expect(Object.keys(prc.relationVariables(prc.buildRelationInput(AVENANT.context.periodRelation).input)).sort()).toEqual([...T3_MASTER_VARIABLES].sort());
  });
  it('branche FACULTATIVE (version BO antérieure valide), texte attendu du PO ; aucun prompt du dépôt ne la porte', async () => {
    const loader = await import('@/services/ai/prompts/prompt-loader');
    const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
    expect(loader.isOptionalMasterTask('t3_master_v1', 'PERIOD_RELATION')).toBe(true);
    expect(loader.isMasterTaskTextPending('t3_master_v1', 'PERIOD_RELATION')).toBe(true);
    expect(LIVRE_T3).not.toContain(prc.PERIOD_RELATION_CONTRACT_VERSION);
    expect(checkMasterPromptContent('T3', LIVRE_T3).blocking).toEqual([]);
    expect(checkMasterPromptContent('T3', LIVRE_T3).warnings.map((w) => w.message).join('\n')).toMatch(/BRANCHE TASK = PERIOD_RELATION/);
  });
  it('aucun texte de prompt dans le code : le module ne contient que le contrat (marqueur, schéma, validation)', () => {
    for (const f of ['relation-contract.ts', 'relation-decider.ts', 'relation-review.ts']) {
      const t = lire(`src/services/documents/business-periods/${f}`);
      expect(t, f).not.toMatch(/BRANCHE TASK = PERIOD_RELATION\n/);
      expect(t, f).not.toMatch(/R1 — MONDE FERMÉ/);
    }
  });
});

describe('L113AD-U-VALIDATION — sortie validée strictement, toute sortie invalide vaut abstention', () => {
  const s = () => prc.buildRelationInput(CONTRA.context.periodRelation).scope;
  it.each(['SUCCESSION', 'SAME_FACT', 'DIFFERENT_NATURES'] as const)('%s certain → effet sans question, preuve citée', (relation) => {
    const v = prc.validateRelation(sortie({ relation }), s());
    expect(v).toMatchObject({ ok: true, ignored: null, effect: { relation, replacingFileId: null, citation: { fileId: 9201 } } });
  });
  it.each(['AMENDMENT', 'RECTIFICATION'] as const)('%s certain → la période du document qui remplace, preuve de ce document', (relation) => {
    const v = prc.validateRelation(sortie({ relation, replacingPeriod: 'P2', evidence: [{ document: 'D2', excerpt: 'la période de garantie EST modifiée  à compter du 01/07/2025' }] }), scopeAvenant());
    expect(v).toMatchObject({ ok: true, effect: { relation, replacingFileId: 9102, citation: { fileId: 9102 } } });
  });
  it('CONTRADICTION et ABSTAIN : valides, sans effet (comportement 113AA)', () => {
    expect(prc.validateRelation(CONTRA.recording.output, s())).toMatchObject({ ok: true, effect: null, ignored: 'NOT_EXPLAINING' });
    expect(prc.validateRelation(sortie({ relation: 'ABSTAIN', evidence: [], confidence: 'ambiguous' }), s())).toMatchObject({ ok: true, effect: null });
  });
  it('confiance insuffisante : aucun effet', () => {
    expect(prc.validateRelation(sortie({ confidence: 'probable' }), s())).toMatchObject({ ok: true, effect: null, ignored: 'NOT_CERTAIN' });
  });
  it.each([
    ['tâche', { task: 'VALUE_CONFLICT' }],
    ['classement inconnu', { relation: 'LATEST_WINS' }],
    ['référence inconnue', { evidence: [{ document: 'D3', excerpt: 'x' }] }],
    ['remplacement sans période', { relation: 'AMENDMENT', replacingPeriod: null }],
    ['période pour un classement sans remplacement', { replacingPeriod: 'P1' }],
    ['aucune preuve', { evidence: [] }],
    ['raison absente', { reason: '' }],
    ['plus de 4 preuves', { evidence: Array.from({ length: 5 }, () => ({ document: 'D1', excerpt: 'Période de garantie' })) }],
  ] as const)('schéma : %s → refusé', (_n, o) => {
    const v = prc.validateRelation(sortie(o as never), s());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.problems[0].issue).toBe('SCHEMA');
  });
  it('sortie non JSON / nulle → refusée', () => {
    expect(prc.validateRelation(null, s()).ok).toBe(false);
    expect(prc.validateRelation('SUCCESSION', s()).ok).toBe(false);
  });
  it('extrait absent des textes fournis → EXCERPT_NOT_FOUND (jamais une preuve inventée)', () => {
    const v = prc.validateRelation(sortie({ evidence: [{ document: 'D2', excerpt: 'annule et remplace' }] }), s());
    expect(v).toMatchObject({ ok: false, problems: [{ issue: 'EXCERPT_NOT_FOUND' }] });
  });
  it('remplacement sans preuve du document qui remplace → REPLACING_EVIDENCE_MISSING', () => {
    const v = prc.validateRelation(sortie({ relation: 'AMENDMENT', replacingPeriod: 'P2' }), scopeAvenant());
    expect(v).toMatchObject({ ok: false, problems: [{ issue: 'REPLACING_EVIDENCE_MISSING' }] });
  });
  it('période corrigée par l’utilisateur jamais remplacée → PROTECTED_PERIOD', () => {
    const raw = structuredClone(AVENANT.context.periodRelation);
    raw.periods[0].userCorrected = true;
    const v = prc.validateRelation(AVENANT.recording.output, prc.buildRelationInput(raw).scope);
    expect(v).toMatchObject({ ok: false, problems: [{ issue: 'PROTECTED_PERIOD' }] });
  });
  it('contexte : ordre stable (symétrique), bornes, aucun identifiant technique transmis', () => {
    const raw = AVENANT.context.periodRelation;
    const inverse = { ...raw, periods: [raw.periods[1], raw.periods[0]], documents: [raw.documents[1], raw.documents[0]] };
    expect(prc.buildRelationInput(inverse)).toEqual(prc.buildRelationInput(raw));
    const vars = JSON.stringify(prc.relationVariables(prc.buildRelationInput(raw).input));
    expect(vars).not.toMatch(/9101|9102|"periodId"|"fileId"/);
    const long = { ...raw, documents: raw.documents.map((d) => ({ ...d, excerpts: Array.from({ length: 12 }, (_x, i) => `extrait ${i} ${'x'.repeat(500)}`) })) };
    const b = prc.buildRelationInput(long).input;
    expect(b.documents[0].excerpts).toHaveLength(prc.RELATION_CONTEXT_BOUNDS.maxExcerptsPerDocument);
    expect(b.documents[0].excerpts[0].length).toBe(prc.RELATION_CONTEXT_BOUNDS.maxExcerptLength);
    expect(b.bounds).toEqual({ complete: false, droppedExcerpts: 8 });
    expect(() => prc.buildRelationInput({ ...raw, periods: [raw.periods[0]] })).toThrow();
  });
});

describe('L113AD-U-RESOLUTION — intégration sous la décision de l’utilisateur', () => {
  const e = (id: number, fileId: number, start: string, end: string, o: Partial<import('../resolution').ResolutionEntry> = {}) =>
    ({ id, fileId, kind: 'COVERAGE' as const, start, end, userCorrected: false, qualified: true, relation: null, ...o });
  const A = e(1, 10, '2025-04-01', '2026-03-31');
  const B = e(2, 11, '2025-07-01', '2026-06-30');
  const fp = res.conflictFingerprint('COVERAGE', A, B);
  const decide = (relation: import('../relation-contract').ExplainingRelation, replacingFileId: number | null = null): import('../resolution').AiPeriodRelation =>
    ({ fingerprint: fp, state: 'DECIDED', relation, replacingFileId });

  it('sans examen : contradiction → question (113AA), état NONE', () => {
    const r = res.resolvePeriods([A, B]);
    expect(r.conflicts).toEqual([expect.objectContaining({ needsUser: true, review: 'NONE' })]);
  });
  it.each([['SUCCESSION', 'AI_SUCCESSION'], ['SAME_FACT', 'AI_SAME_FACT'], ['DIFFERENT_NATURES', 'AI_DIFFERENT_NATURE']] as const)(
    '%s → aucune question, les deux périodes restent établies', (relation, attendu) => {
      const r = res.resolvePeriods([A, B], [], [decide(relation)]);
      expect(r.conflicts).toEqual([]);
      expect(r.pairs).toEqual([{ a: 1, b: 2, relation: attendu }]);
      expect([...r.entries.values()].map((x) => x.status)).toEqual(['ESTABLISHED', 'ESTABLISHED']);
    });
  it.each([['AMENDMENT', 'AI_AMENDMENT'], ['RECTIFICATION', 'AI_RECTIFICATION']] as const)(
    '%s → la SEULE période concernée est remplacée (historique), empreinte conservée pour la preuve', (relation, basis) => {
      const r = res.resolvePeriods([A, B], [], [decide(relation, 11)]);
      expect(r.conflicts).toEqual([]);
      expect(r.entries.get(1)).toEqual({ status: 'REPLACED', byFileId: 11, basis, conflict: fp });
      expect(r.entries.get(2)).toEqual({ status: 'ESTABLISHED' });
    });
  it('un avenant reconnu par T3 n’explique pas un autre chevauchement (autre empreinte : question)', () => {
    const C = e(3, 12, '2025-09-01', '2026-08-31');
    const r = res.resolvePeriods([A, B, C], [], [decide('AMENDMENT', 11)]);
    expect(r.entries.get(1)).toMatchObject({ status: 'REPLACED', byFileId: 11 });
    expect(r.conflicts.map((c) => c.periodIds)).toEqual([[2, 3]]);
  });
  it('décision de l’utilisateur TOUJOURS prioritaire (même empreinte)', () => {
    const user = [{ fingerprint: fp, choice: 'KEEP' as const, retainedFileId: 10 }];
    const r = res.resolvePeriods([A, B], user, [decide('AMENDMENT', 11)]);
    expect(r.entries.get(2)).toMatchObject({ status: 'REPLACED', byFileId: 10, basis: 'USER_DECISION' });
    expect(r.entries.get(1)).toEqual({ status: 'ESTABLISHED' });
    const both = res.resolvePeriods([A, B], [{ fingerprint: fp, choice: 'BOTH', retainedFileId: null }], [decide('RECTIFICATION', 10)]);
    expect(both.pairs[0].relation).toBe('USER_DECISION');
    expect([...both.entries.values()].map((x) => x.status)).toEqual(['ESTABLISHED', 'ESTABLISHED']);
  });
  it('période corrigée par l’utilisateur : jamais remplacée par T3 → question', () => {
    const r = res.resolvePeriods([{ ...A, userCorrected: true }, B], [], [decide('AMENDMENT', 11)]);
    expect(r.conflicts).toEqual([expect.objectContaining({ needsUser: true, review: 'EXAMINED' })]);
    expect(r.entries.get(1)!.status).toBe('CONFLICT');
  });
  it('document remplaçant inconnu de la paire : aucune résolution inventée → question', () => {
    const r = res.resolvePeriods([A, B], [], [decide('AMENDMENT', 99)]);
    expect(r.conflicts).toEqual([expect.objectContaining({ needsUser: true, review: 'EXAMINED' })]);
  });
  it('examen EN ATTENTE → question différée (signalée sans question) ; examiné sans effet → question', () => {
    const attente = res.resolvePeriods([A, B], [], [{ fingerprint: fp, state: 'AWAITING' }]);
    expect(attente.conflicts).toEqual([expect.objectContaining({ needsUser: false, review: 'AWAITING' })]);
    expect(attente.entries.get(1)!.status).toBe('CONFLICT');
    const examine = res.resolvePeriods([A, B], [], [{ fingerprint: fp, state: 'EXAMINED' }]);
    expect(examine.conflicts).toEqual([expect.objectContaining({ needsUser: true, review: 'EXAMINED' })]);
  });
  it('document non qualifié : un classement certain explique aussi la divergence ; sinon signalement seul', () => {
    const nq = { ...B, qualified: false };
    expect(res.resolvePeriods([A, nq], [], [decide('SUCCESSION')]).conflicts).toEqual([]);
    expect(res.resolvePeriods([A, nq], [], [{ fingerprint: fp, state: 'EXAMINED' }]).conflicts).toEqual([expect.objectContaining({ needsUser: false, review: 'EXAMINED' })]);
  });
  it('symétrie : l’ordre des documents ne change rien (jamais « le dernier gagne »)', () => {
    const r1 = res.resolvePeriods([A, B], [], [decide('AMENDMENT', 11)]);
    const r2 = res.resolvePeriods([B, A], [], [decide('AMENDMENT', 11)]);
    expect([...r2.entries.entries()].sort()).toEqual([...r1.entries.entries()].sort());
  });
});

describe('L113AD-U-MEMOIRE — mémoire relue par la résolution, demande posée une seule fois', () => {
  const faux = (rows: Array<Record<string, unknown>>) => {
    const appels: Array<{ q: string; p: unknown[] }> = [];
    return { appels, sql: { unsafe: async (q: string, p: unknown[]) => { appels.push({ q, p }); return rows; } } as never };
  };
  // Règle remplacée (carte #766, E07) : une demande en attente depuis plus de 24 h devenait « EXAMINED » (donc une
  // question). Un incident technique n'est plus une ambiguïté métier : en attente → AWAITING quel que soit l'âge
  // (`late` : supervision) ; essais épuisés → FAILED ; seul un travail réel de T3 donne EXAMINED.
  it('états : classement certain → DECIDED (preuve) ; en attente → AWAITING (même en retard) ; T3 a travaillé → EXAMINED ; bornée au compte', async () => {
    const f = faux([
      { fingerprint: 'a', status: 'DECIDED', relation: 'AMENDMENT', confidence: 'certain', replacing_file_id: 11, evidence: [{ document: 'D2', fileId: 11, excerpt: 'modifiée' }], fresh: true },
      { fingerprint: 'b', status: 'DECIDED', relation: 'CONTRADICTION', confidence: 'certain', replacing_file_id: null, evidence: [], fresh: true },
      { fingerprint: 'c', status: 'PENDING', relation: null, confidence: null, replacing_file_id: null, evidence: [], fresh: true },
      { fingerprint: 'd', status: 'PENDING', relation: null, confidence: null, replacing_file_id: null, evidence: [], fresh: false },
      { fingerprint: 'e', status: 'REJECTED', relation: 'SUCCESSION', confidence: 'certain', replacing_file_id: null, evidence: [], fresh: true },
      { fingerprint: 'f', status: 'NOT_CERTAIN', relation: 'SUCCESSION', confidence: 'probable', replacing_file_id: null, evidence: [], fresh: true },
      { fingerprint: 'g', status: 'AI_FAILED', relation: null, confidence: null, replacing_file_id: null, evidence: [], fresh: true },
    ]);
    const s = await loadRelationStates(f.sql, 7, [10, 11, 11]);
    expect(s.map((x) => [x.fingerprint, x.state])).toEqual([['a', 'DECIDED'], ['b', 'EXAMINED'], ['c', 'AWAITING'], ['d', 'AWAITING'], ['e', 'EXAMINED'], ['f', 'EXAMINED'], ['g', 'AWAITING']]);
    expect(s[1]).toMatchObject({ contradiction: true });
    expect(s[2]).not.toHaveProperty('late');
    expect(s[3]).toMatchObject({ late: true });
    expect(s[0]).toMatchObject({ relation: 'AMENDMENT', replacingFileId: 11, citation: { fileId: 11, excerpt: 'modifiée' } });
    expect(f.appels[0].p).toEqual([7, '{10,11}']);
    expect(f.appels[0].q).toMatch(/account_id = \$1/);
    expect(f.appels[0].q).toMatch(/status NOT IN \('OBSOLETE', 'UNAVAILABLE'\)/);
    expect(f.appels[0].q).toContain(`hours => ${PERIOD_RELATION_MAX_WAIT_HOURS}`);
    expect(await loadRelationStates(f.sql, 7, [])).toEqual([]);
  });
  it('table absente (migration non appliquée) : aucun état, comportement 113AA', async () => {
    const sql = { unsafe: async () => { throw Object.assign(new Error('absent'), { code: '42P01' }); } } as never;
    expect(await loadRelationStates(sql, 7, [1])).toEqual([]);
  });
  it('demande : seulement pour une divergence jamais examinée ; une ligne classée n’est jamais rouverte', async () => {
    const f = faux([{ fingerprint: 'x' }]);
    const conflit = (fingerprint: string, review: import('../resolution').ReviewState) =>
      ({ fingerprint, kind: 'COVERAGE' as const, periodIds: [1, 2] as [number, number], fileIds: [10, 11] as [number, number], needsUser: true, review });
    expect(await requestRelationReviews(f.sql, 7, 3, [conflit('x', 'NONE'), conflit('y', 'AWAITING'), conflit('z', 'EXAMINED')])).toEqual(['x']);
    expect(f.appels).toHaveLength(1);
    expect(f.appels[0].q).toMatch(/ON CONFLICT \(account_id, fingerprint\) DO UPDATE/);
    expect(f.appels[0].q).toMatch(/WHERE business_period_relation_reviews\.status IN \('OBSOLETE', 'UNAVAILABLE'\)/);
    expect(f.appels[0].q).toMatch(/o\.account_id = \$1/);
  });
});

describe('L113AD-U-GUIDE — bloc 29, capacité, diagnostic BO', () => {
  const bloc = async () => {
    const { parseGuideBlocks } = await import('@/services/ai/prompt-conformity/guide-blocks');
    return parseGuideBlocks(GUIDE).find((x) => x.id === prc.PERIOD_RELATION_CONTRACT_VERSION)!;
  };
  const applique = async () => LIVRE_T3.replace(REPERE, `${(await bloc()).text}\n\n${REPERE}`);

  it('bloc officiel balisé (T3, insertion avant la ligne repère unique), branche + marqueur, aucun emplacement', async () => {
    const b = await bloc();
    expect(b).toMatchObject({ prompt: 't3', action: 'insert-before', anchor: REPERE });
    expect(LIVRE_T3.split(REPERE).length - 1).toBe(1);
    const { inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
    expect(inspectMasterTemplate(b.text).placeholders).toEqual([]);
    expect(inspectMasterTemplate(b.text).branches).toContain('PERIOD_RELATION');
    expect(b.text).toContain(prc.PERIOD_RELATION_CONTRACT_VERSION);
    for (const r of prc.PERIOD_RELATIONS) expect(b.text).toContain(`"${r}"`);
    expect(b.text).not.toMatch(/opération/i);
    expect(GUIDE).toContain('| 29 | 113AD (#725)');
  });
  it('T3 après collage : aucun bloquant, l’avertissement disparaît, rendu réel avec les variables de production', async () => {
    const { checkMasterPromptContent } = await import('@/services/ai/master-prompts/master-prompt-checks');
    const { renderMasterPrompt } = await import('@/services/ai/prompts/prompt-loader');
    const { listMasterTasks } = await import('@/services/ai/registry/operations');
    const t = await applique();
    expect(checkMasterPromptContent('T3', t).blocking).toEqual([]);
    expect(checkMasterPromptContent('T3', t).warnings.map((w) => w.message).join('\n')).not.toMatch(/PERIOD_RELATION/);
    const variables = prc.relationVariables(prc.buildRelationInput(AVENANT.context.periodRelation).input);
    const rendu = renderMasterPrompt(t, { masterPromptCode: 't3_master_v1', task: 'PERIOD_RELATION', variables, allowedTasks: listMasterTasks('t3_master_v1') });
    expect(rendu).toContain('BRANCHE TASK = PERIOD_RELATION');
    expect(rendu).toContain('La période de garantie est modifiée à compter du 01/07/2025');
  });
  it('les deux exemples du bloc sont acceptés par le validateur réel (cas P-T3-PR-01 et P-T3-PR-02)', async () => {
    const lignes = (await bloc()).text.split('\n').filter((l) => l.startsWith('{"task": "PERIOD_RELATION"'));
    expect(lignes).toHaveLength(2);
    const [ex1, ex2] = lignes.map((l) => JSON.parse(l));
    expect(ex1).toEqual(AVENANT.recording.output);
    expect(ex2).toEqual(CONTRA.recording.output);
    expect(prc.validateRelation(ex1, scopeAvenant())).toMatchObject({ ok: true, effect: { relation: 'AMENDMENT', replacingFileId: 9102 } });
    expect(prc.validateRelation(ex2, prc.buildRelationInput(CONTRA.context.periodRelation).scope)).toMatchObject({ ok: true, effect: null });
  });
  it('capacité : branche ET marqueur exigés ; coupure d’urgence ; décideur simulé en test', async () => {
    const { inspectMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
    const t = await applique();
    expect(dec.relationCapabilityOf({ text: LIVRE_T3, version: 'v', branches: inspectMasterTemplate(LIVRE_T3).branches })).toMatchObject({ available: false, contractState: 'BRANCH_MISSING' });
    expect(dec.relationCapabilityOf({ text: t, version: 'v9', branches: inspectMasterTemplate(t).branches })).toEqual({ available: true, version: 'v9', reason: 'AVAILABLE' });
    const sansMarqueur = t.replaceAll(prc.PERIOD_RELATION_CONTRACT_VERSION, 'autre-contrat');
    expect(dec.relationCapabilityOf({ text: sansMarqueur, version: 'v', branches: inspectMasterTemplate(sansMarqueur).branches })).toMatchObject({ available: false, contractState: 'MARKER_MISSING' });
    expect(dec.periodRelationEnabled({ T3_PERIOD_RELATION_ENABLED: '0' })).toBe(false);
    expect(dec.periodRelationEnabled({})).toBe(true);
    const faux = { capability: async () => ({ available: true, version: 'x', reason: 'AVAILABLE' as const }), decide: async () => ({ output: null, traceId: null }) };
    dec.__setRelationDeciderForTests(faux);
    expect(dec.relationDecider()).toBe(faux);
    dec.__setRelationDeciderForTests(null);
    expect(dec.relationDecider()).toBe(dec.productionRelationDecider);
  });
  it('diagnostic BO : contrat déclaré — « absent » sur le T3 livré (configuration incomplète), satisfait après collage', async () => {
    const { promptContracts } = await import('@/services/ai/prompt-conformity/contracts');
    const c = (await promptContracts()).find((x) => x.id === prc.PERIOD_RELATION_CONTRACT_VERSION)!;
    expect(c).toMatchObject({ treatment: 'T3', guideStep: 29, lot: '113AD', task: 'PERIOD_RELATION', operations: ['t3_period_relation'], killSwitch: 'T3_PERIOD_RELATION_ENABLED' });
    const execution = { mode: 'LEGACY_SLOTS' } as never;
    expect((await c.check({ text: LIVRE_T3, execution, referenceText: LIVRE_T3 })).state).toBe('ABSENT');
    expect((await c.check({ text: await applique(), execution, referenceText: LIVRE_T3 })).state).toBe('SATISFIED');
    expect((await c.plan({ text: LIVRE_T3, execution, referenceText: LIVRE_T3 })).ok).toBe(true);
    expect(c.impact).toMatch(/Configuration incomplète/);
  });
});

describe('L113AD-U-CORPUS — cas du corpus rejoués par le contrôle serveur réel', () => {
  const cas = loadMasterCorpusCases(readMasterFileFromRepo).filter((c) => c.operationCode === 't3_period_relation');
  it('six cas (quatre réponses de référence, deux gardes), tous au manifeste', () => {
    expect(cas.map((c) => c.id)).toEqual(['P-T3-PR-01', 'P-T3-PR-02', 'P-T3-PR-03', 'P-T3-PR-04', 'P-T3-PR-05', 'P-T3-PR-06']);
    expect(cas.filter((c) => c.qualificationRole === 'answer')).toHaveLength(4);
    const manifeste = lire('src/services/ai/governance/master-corpus/certification/corpus-manifest.json');
    for (const c of cas) expect(manifeste).toContain(c.file.replace(/\\/g, '/'));
  });
  it.each(cas.map((c) => [c.id, c] as const))('%s : attendu respecté sur le texte T3 + bloc 29', async (_id, c) => {
    const { parseGuideBlocks } = await import('@/services/ai/prompt-conformity/guide-blocks');
    const b = parseGuideBlocks(GUIDE).find((x) => x.id === prc.PERIOD_RELATION_CONTRACT_VERSION)!;
    const r = await evaluateCorpusOutput(c, c.output, LIVRE_T3.replace(REPERE, `${b.text}\n\n${REPERE}`), readMasterFileFromRepo, c.outputSchema);
    expect(r.errors).toEqual([]);
  });
});
