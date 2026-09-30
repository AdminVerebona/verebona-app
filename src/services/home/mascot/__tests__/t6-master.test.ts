/**
 * T6 — prompt maître `t6_master_v1` (CDC 15 §28), contrat `t6-output-v2`,
 * règles serveur R8 (non-répétition), R9 (nuances, pose graduée), R11
 * (repli par sujet), branchement master / étapes, corpus P-T6-01 (§30).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const unsafe = vi.fn(async (_sql: string, _p?: unknown[]): Promise<unknown[]> => []);
vi.mock('@/db', () => ({ pgClient: { unsafe: (s: string, p: unknown[]) => unsafe(s, p) } }));

const C = await import('../t6-contract');
const R = await import('../t6-runner');
const { renderMasterPrompt, checkMasterTemplate } = await import('@/services/ai/prompts/prompt-loader');
const { AI_OPERATIONS } = await import('@/services/ai/registry/operations');
type Input = import('../t6-contract').T6Input;

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const MASTER = read('src/services/ai/prompts/mascot/t6_master_v1.txt');
const FIX = join(process.cwd(), 'src/services/home/mascot/__fixtures__');
const fixtures = readdirSync(FIX).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(FIX, f), 'utf8')));
const P = fixtures.find((f) => f.case === 'P-T6-01');
const INPUT: Input = P.context.input;
const KINDS = P.context.kinds;
const OK = P.recording.output;

describe('prompt maître t6_master_v1 (§28) et registre', () => {
  it('transcription du §28 : MODE imposé par le serveur, R1 à R11, sortie t6-output-v2', () => {
    expect(checkMasterTemplate(MASTER, ['FORMULATE'])).toEqual([]);
    for (let i = 1; i <= 11; i++) expect(MASTER).toContain(`R${i} — `);
    expect(MASTER).toContain('"schemaVersion":"t6-output-v2"');
    expect(MASTER).toContain('R8 — Évite les répétitions mécaniques entre sujets successifs.');
    expect(MASTER).toContain('un sujet `deadline` conserve la nature confirmée/prévisionnelle de la date');
    const rendu = renderMasterPrompt(MASTER, {
      masterPromptCode: 't6_master_v1', task: 'FORMULATE', allowedTasks: ['FORMULATE'], variables: { INPUT_JSON: '{"x":1}' },
    });
    expect(rendu).toContain('MODE = FORMULATE');
    expect(rendu).toContain('Entrée structurée : {"x":1}');
    expect(() => renderMasterPrompt(MASTER, { masterPromptCode: 't6_master_v1', task: 'FORMULATE', allowedTasks: ['FORMULATE'], variables: { INPUT_JSON: 'x', MODE: 'AUTRE' } })).toThrow();
  });

  it('opération t6_formulate : déclaration attendue cohérente (8 s, INPUT_JSON) ; conforme au registre dès qu’elle y figure', () => {
    const spec = C.T6_MASTER_OPERATION_SPEC;
    expect(spec).toMatchObject({ masterPromptCode: 't6_master_v1', task: 'FORMULATE', timeoutMs: 8_000, outputSchema: 'T6FormulateOutput' });
    expect(spec.timeoutMs).toBe(AI_OPERATIONS.formulate_mascot.timeoutMs);
    // Emplacements du master = variables déclarées (hors MODE, fixé par le serveur).
    const places = [...new Set([...MASTER.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))].filter((p) => p !== 'MODE');
    expect(places).toEqual([...spec.promptVariables]);
    const op = (AI_OPERATIONS as Record<string, unknown>).t6_formulate;
    if (op) expect(op).toMatchObject(spec);
    expect(AI_OPERATIONS.formulate_mascot).toMatchObject({ timeoutMs: 8_000, promptCode: 'mascot_t6_v1', active: true });
  });
});

describe('contrat t6-output-v2 et règles serveur', () => {
  it('schemaVersion v2 obligatoire ; sortie fidèle acceptée', () => {
    expect(C.validateT6MasterOutput(INPUT, OK, { kinds: KINDS })).toMatchObject({ ok: true, adjustments: [], fallbackSubjects: [] });
    expect(C.validateT6MasterOutput(INPUT, { ...OK, schemaVersion: 't6-output-v1' })).toEqual({ ok: false, reason: 'schema_v2' });
    expect(C.validateT6MasterOutput(INPUT, { messages: OK.messages })).toEqual({ ok: false, reason: 'schema_v2' });
  });

  it('R8 : le paragraphe qui répète le précédent reprend SON texte de secours ; l’autre reste formulé', () => {
    const rep = { ...OK, messages: [
      OK.messages[0],
      { subjectId: 'ATP:5f1c', text: 'Le contrôle technique de la Clio : pouvez-vous indiquer son kilométrage actuel ?', highlight: null },
    ] };
    const r = C.validateT6MasterOutput(INPUT, rep, { kinds: KINDS });
    expect(r).toMatchObject({ ok: true, fallbackSubjects: [1], adjustments: ['r8_fallback:1'] });
    if (r.ok) {
      expect(r.messages[0].text).toBe(OK.messages[0].text);
      expect(r.messages[1].text).toBe(INPUT.subjects[1].fallbackText);
    }
    expect(C.mechanicalRepetition([{ text: 'Votre échéance du 3 mars.' }, { text: 'Votre document est prêt.' }])).toBeNull();
  });

  it('R9 : un sujet d’information n’enjoint rien ; pas de retard sans retard ; jamais alarmiste ; confirmé ≠ estimé ; pas d’interface', () => {
    const s = INPUT.subjects[0];
    const confirme = { ...s, facts: { ...s.facts, dateNature: 'confirmée' }, fallbackText: 'Votre prochaine échéance est « Contrôle technique » pour Clio, le 14 novembre 2026.' };
    const info = { ...s, intent: 'inform' as const };
    expect(C.nuanceViolation('Le contrôle technique de la Clio est prévu le 14 novembre 2026.', confirme, 'info')).toBeNull();
    expect(C.nuanceViolation('Le contrôle technique de la Clio est estimé au 14 novembre 2026.', confirme, 'info')).toBe('confirmed_as_forecast');
    expect(C.nuanceViolation('Pensez à prévoir le contrôle technique du 14 novembre 2026.', info, 'info')).toBe('inform_injunction');
    expect(C.nuanceViolation('Le contrôle technique du 14 novembre 2026 est en retard.', s, 'info')).toBe('overdue_wording');
    expect(C.nuanceViolation('Le contrôle technique du 14 novembre 2026 est en retard.', s, 'overdue')).toBeNull();
    expect(C.nuanceViolation('Urgent : contrôle technique le 14 novembre 2026.', s, 'overdue')).toBe('alarmist');
    expect(C.nuanceViolation('Cliquez sur le bouton pour le contrôle du 14 novembre 2026.', s, 'action')).toBe('interface');
    // Un mot repris des faits n'est pas un ajout.
    const titre = { ...s, facts: { ...s.facts, title: 'Contrôle urgence gaz' } };
    expect(C.nuanceViolation('Le contrôle urgence gaz est prévu autour du 14 novembre 2026.', titre, 'info')).toBeNull();
  });

  it('R11 : un paragraphe qui perd la date absolue ou l’objet reprend fallbackText pour CE sujet', () => {
    const perd = { ...OK, messages: [
      { subjectId: 'DATE-NEXT:12', text: 'Votre prochaine visite au garage est estimée, la date sera confirmée.', highlight: null },
      OK.messages[1],
    ] };
    const r = C.validateT6MasterOutput(INPUT, perd, { kinds: KINDS });
    expect(r).toMatchObject({ ok: true, adjustments: ['r11_fallback:0'], fallbackSubjects: [0] });
    if (r.ok) {
      expect(r.messages[0]).toEqual({ subjectId: 'DATE-NEXT:12', text: INPUT.subjects[0].fallbackText, highlight: '14 novembre 2026' });
      expect(r.messages[1].text).toBe(OK.messages[1].text);
    }
    expect(C.keepsEssentialFacts('Échéance le 14/11/2026 pour le contrôle technique.', INPUT.subjects[0].facts)).toBe(true);
  });

  it('R9 : repli sujet par sujet ; une violation qui touche TOUS les sujets rejette la bulle', () => {
    const un = { ...OK, messages: [OK.messages[0], { subjectId: 'ATP:5f1c', text: 'Urgent : indiquez sans tarder le kilométrage actuel de la Clio.', highlight: null }] };
    const r = C.validateT6MasterOutput(INPUT, un, { kinds: KINDS });
    expect(r).toMatchObject({ ok: true, fallbackSubjects: [1], adjustments: ['r9_fallback:1'] });
    if (r.ok) expect(r.messages.map((m) => m.text)).toEqual([OK.messages[0].text, INPUT.subjects[1].fallbackText]);
    const tous = { ...un, messages: [{ ...OK.messages[0], text: 'Alerte : le contrôle technique de la Clio, estimé autour du 14 novembre 2026, approche.' }, un.messages[1]] };
    expect(C.validateT6MasterOutput(INPUT, tous, { kinds: KINDS })).toEqual({ ok: false, reason: 'r9_alarmist:0' });
    // Structure invalide : toujours la bulle entière.
    expect(C.validateT6MasterOutput(INPUT, { ...OK, messages: [OK.messages[0]] })).toEqual({ ok: false, reason: 'count' });
  });

  it('R8 dans le temps : sujets figés recollés AVANT la validation (et contrôlés comme les autres)', () => {
    const fige = { subjectId: 'DATE-NEXT:12', text: 'Pour la Clio, le contrôle technique reste estimé autour du 14 novembre 2026.', highlight: null };
    const r = C.validateT6MasterOutput(INPUT, OK, { kinds: KINDS, pinned: new Map([[0, fige]]) });
    expect(r).toMatchObject({ ok: true, adjustments: ['r8_pinned:0'], fallbackSubjects: [] });
    if (r.ok) expect(r.messages[0].text).toBe(fige.text);
    // Un texte figé devenu fautif (ici alarmiste) reprend lui aussi son secours.
    const fautif = { ...fige, text: 'Alerte : contrôle technique de la Clio autour du 14 novembre 2026.' };
    const r2 = C.validateT6MasterOutput(INPUT, OK, { kinds: KINDS, pinned: new Map([[0, fautif]]) });
    expect(r2).toMatchObject({ ok: true, fallbackSubjects: [0] });
    // Répétition entre un sujet figé et un nouveau : le NOUVEAU cède.
    const neuf = { ...OK, messages: [OK.messages[0], { subjectId: 'ATP:5f1c', text: 'Le contrôle technique de la Clio : pouvez-vous indiquer son kilométrage actuel ?', highlight: null }] };
    const r3 = C.validateT6MasterOutput(INPUT, neuf, { kinds: KINDS, pinned: new Map([[1, neuf.messages[1]]]) });
    expect(r3).toMatchObject({ ok: true, fallbackSubjects: [0] });
  });

  it('taux de repli mesuré sur les fixtures P-T6-01 (sujets affichant leur texte de secours)', () => {
    const res = fixtures.map((f) => ({
      subjects: f.context.input.subjects.length,
      validation: C.validateT6MasterOutput(f.context.input, f.recording.output, { kinds: f.context.kinds }),
    }));
    // 01 : 0/2 ; 01b, 01c, 01e : bulle entière (3 × 2) ; 01d : 1/2 → 7/10.
    expect(C.t6FallbackRate(res)).toBeCloseTo(0.7, 5);
    // Avant le repli par sujet, 01d aurait coûté toute la bulle : 8/10.
    expect(res.filter((r) => r.validation.ok && r.validation.fallbackSubjects.length > 0)).toHaveLength(1);
  });

  it('corpus P-T6-01 (§30) : aucun fait supplémentaire, mêmes subjectId et ordre ; cas limites rejetés', () => {
    expect(fixtures.map((f) => f.case).sort()).toEqual(['P-T6-01', 'P-T6-01b', 'P-T6-01c', 'P-T6-01d', 'P-T6-01e']);
    for (const f of fixtures) {
      expect(f.recording).toMatchObject({ operationCode: 't6_formulate', task: 'FORMULATE' });
      expect(JSON.parse(f.context.variables.INPUT_JSON)).toEqual(f.context.input);
      expect(C.evaluateT6CorpusCase(f.context, f.recording.output, f.expected), f.case).toEqual([]);
    }
  });
});

describe('branchement : master si la configuration le déclare, sinon chemin historique inchangé', () => {
  const execute = vi.fn();
  const base = {
    flagEnabled: () => true, treatmentAvailable: async () => true,
    promptVersion: async () => 'mascot_t6_v1@file|cfg:3|voix:x',
    masterPromptVersion: async () => 't6_master_v1@file|cfg:3',
    previousBubbles: async () => [] as import('../t6-runner').T6PreviousBubble[],
    execute: (r: unknown) => execute(r),
  };
  const res = (data: unknown) => ({ data, model: 'm', usedFallback: false, fromCache: false, costMicros: 1, traceId: 't' });
  beforeEach(() => { execute.mockReset(); unsafe.mockClear(); R.resetT6Breaker(); });

  it('master : opération t6_formulate, sortie validée (v2 + R8/R9/R11), cache sous une clé v2', async () => {
    execute.mockResolvedValue(res(OK));
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h1', mode: 'display', kinds: KINDS },
      { ...base, architecture: async () => 'master' });
    expect(o).toMatchObject({ status: 'generated', architecture: 'master', promptVersion: 't6_master_v1@file|cfg:3' });
    expect(execute.mock.calls[0][0]).toMatchObject({ operationCode: 't6_formulate', callerMode: 'displayed', promptVariables: { INPUT_JSON: JSON.stringify(INPUT) } });
    expect(execute.mock.calls[0][0].promptVariables).not.toHaveProperty('MODE');
    const ecriture = unsafe.mock.calls.find((c) => String(c[0]).includes('INSERT INTO home_mascot_cache'));
    expect(ecriture?.[1]?.[4]).toBe('t6-output-v2');
    expect(R.t6CacheKey({ accountId: 7, input: INPUT, promptVersion: 'v', outputSchema: 't6-output-v2' }))
      .not.toBe(R.t6CacheKey({ accountId: 7, input: INPUT, promptVersion: 'v' }));
  });

  it('master : sortie v1 ou R9 violée → texte de secours (messages null)', async () => {
    execute.mockResolvedValue(res({ ...OK, schemaVersion: 't6-output-v1' }));
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h2', mode: 'pregen', kinds: KINDS }, { ...base, architecture: async () => 'master' });
    expect(o).toMatchObject({ status: 'validation_failed', messages: null, error: 'schema_v2' });
  });

  it('étapes (défaut) : prompt historique, jamais le master', async () => {
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h3', mode: 'display' },
      { ...base, architecture: async () => 'steps' });
    expect(execute).not.toHaveBeenCalled();
    expect(o.architecture).toBeUndefined();
    expect(R.T6_DISPLAY_BUDGET_MS).toBe(6_000);
  });

  it('R8 dans le temps : même état qu’une bulle précédente → mêmes textes, sans appel ; sujet inchangé → formulation conservée', async () => {
    const prev = [{ input: INPUT, output: OK }];
    const o = await R.formulateWithT6({ accountId: 7, input: INPUT, contextHash: 'h4', mode: 'display', kinds: KINDS },
      { ...base, architecture: async () => 'master', previousBubbles: async () => prev });
    expect(o).toMatchObject({ status: 'cache_hit', adjustments: ['r8_reused'] });
    expect(o.messages?.map((m) => m.text)).toEqual(OK.messages.map((m: { text: string }) => m.text));
    expect(execute).not.toHaveBeenCalled();

    // Un seul sujet change : l'autre garde son texte.
    const change: Input = { ...INPUT, subjects: [INPUT.subjects[0], { ...INPUT.subjects[1], subjectId: 'ATP:autre', facts: { ...INPUT.subjects[1].facts, question: 'Quelle est la couleur de la Clio ?' }, fallbackText: 'Quelle est la couleur de la Clio ? Cela concerne Clio.' }] };
    execute.mockResolvedValue(res({ schemaVersion: 't6-output-v2', messages: [
      { subjectId: 'DATE-NEXT:12', text: 'Pour la Clio, le contrôle technique est estimé autour du 14 novembre 2026.', highlight: null },
      { subjectId: 'ATP:autre', text: 'Pouvez-vous préciser la couleur de la Clio pour compléter sa fiche ?', highlight: null },
    ] }));
    const w = R.previousWording(change, prev, KINDS);
    expect(w.reuse).toBeNull();
    expect([...w.pinned.keys()]).toEqual([0]);
    const o2 = await R.formulateWithT6({ accountId: 7, input: change, contextHash: 'h5', mode: 'display', kinds: KINDS },
      { ...base, architecture: async () => 'master', previousBubbles: async () => prev });
    expect(o2.status).toBe('generated');
    expect(o2.messages?.[0].text).toBe(OK.messages[0].text);
    expect(o2.adjustments).toContain('r8_pinned:0');
  });

  it('mémoire bornée : lue dans le journal existant (5 lignes, 30 jours, même version du master)', async () => {
    await R.readPreviousBubbles(7, 't6_master_v1@file|cfg:3');
    const [sql, params] = unsafe.mock.calls.at(-1)!;
    expect(sql).toMatch(/FROM home_mascot_generations/);
    expect(sql).toMatch(/LIMIT 5/);
    expect(sql).toMatch(/30 days/);
    expect(params).toEqual([7, 't6_master_v1@file|cfg:3']);
  });
});
