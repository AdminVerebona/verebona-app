/**
 * CDC 15 §30, D-08, D-17 — corpus rejoué des prompts maîtres.
 *
 * Ce fichier est la GARDE CI (dans `test:run`) : le corpus des masters du
 * dépôt doit être 100 % vert, toutes branches couvertes. Il vérifie aussi que
 * la garde détecte un master cassé, une sortie non conforme et une branche
 * sans cas, et la garde d'activation (dépendances injectées).
 */
import { describe, it, expect } from 'vitest';

const { runMasterCorpus } = await import('../runner');
const { loadMasterCorpusCases, readMasterFileFromRepo } = await import('../cases');
const { checkMasterActivation } = await import('../activation-guard');
const { emptyTreatmentConfig } = await import('../../../config/config-types');
const { masterTextFingerprint } = await import('../../../prompts/prompt-loader');
const { listMasterPrompts } = await import('../../../registry/operations');
const { fingerprintDrift, readFingerprints } = await import('../fingerprints');

const read = readMasterFileFromRepo;

describe('corpus rejoué des masters du dépôt (garde CI, D-17)', () => {
  it('chaque master déclaré est VERT, toutes ses branches couvertes', async () => {
    const r = await runMasterCorpus({ readMasterFile: read });
    expect(r.map((m) => m.masterPromptCode).sort()).toEqual(listMasterPrompts().map((m) => m.masterPromptCode).sort());
    for (const m of r) {
      expect(m.failures, m.masterPromptCode).toEqual([]);
      expect(m.status).toBe('PASSED');
      expect([...m.branchesPassed].sort()).toEqual([...m.branchesRequired].sort());
      expect(m.textSha256).toBe(masterTextFingerprint(read(m.masterPromptCode)));
    }
  });

  it('les cas P-T* du §30 sont présents (P-T1-01…03, P-T2-01…04, P-T3-01/02, P-T4-01…03, P-T5-01/02, P-T6-01)', () => {
    const ids = loadMasterCorpusCases(read).map((c) => c.id);
    for (const id of ['P-T1-01', 'P-T1-02', 'P-T1-03', 'P-T2-01', 'P-T2-02', 'P-T2-03', 'P-T2-04',
      'P-T3-01', 'P-T3-02', 'P-T4-01', 'P-T4-02', 'P-T4-03', 'P-T5-01', 'P-T5-02', 'P-T6-01']) {
      expect(ids, id).toContain(id);
    }
  });
});

describe('le corpus détecte les régressions', () => {
  it('master cassé (section de branche supprimée) : rouge sur cette branche', async () => {
    const casse = read('t3_master_v1').replace(/BRANCHE TASK = LINK_AMBIGUITY/g, 'SECTION RETIRÉE');
    const [t3] = await runMasterCorpus({ readMasterFile: read, treatments: ['T3'], texts: { t3_master_v1: { text: casse, source: 'config' } } });
    expect(t3.status).toBe('FAILED');
    expect(t3.branchesPassed).toEqual(['VALUE_CONFLICT']);
    expect(t3.failures.join()).toMatch(/P-T3-02.*rendu/);
    expect(t3.textSource).toBe('config');
  });

  it('emplacement supprimé du master : rendu refusé', async () => {
    const casse = read('t4_master_v1').replace(/\{\{EVIDENCE\}\}/g, '(preuve)');
    const [t4] = await runMasterCorpus({ readMasterFile: read, treatments: ['T4'], texts: { t4_master_v1: { text: casse, source: 'config' } } });
    expect(t4.status).toBe('FAILED');
  });

  it('sortie enregistrée contraire au comportement attendu : rouge (contrôle serveur)', async () => {
    const cases = loadMasterCorpusCases(read).map((c) => (c.id === 'P-T4-01'
      ? { ...c, output: { ...(c.output as object), homeCategory: 'information' } } : c));
    const [t4] = await runMasterCorpus({ readMasterFile: read, treatments: ['T4'], cases });
    expect(t4.status).toBe('FAILED');
    expect(t4.failures.join()).toMatch(/P-T4-01.*catégorie information/);
  });

  it('sortie d’une autre branche : rejetée comme par la passerelle', async () => {
    const cases = loadMasterCorpusCases(read).map((c) => (c.id === 'P-T5-01'
      ? { ...c, output: { ...(c.output as object), mode: 'MODIFY' } } : c));
    const [t5] = await runMasterCorpus({ readMasterFile: read, treatments: ['T5'], cases });
    expect(t5.failures.join()).toMatch(/P-T5-01.*MODE=ANALYZE/);
  });

  it('branche sans cas : rouge, jamais « non testée donc acceptée »', async () => {
    const cases = loadMasterCorpusCases(read).filter((c) => c.task !== 'REVALIDATE');
    const [t2] = await runMasterCorpus({ readMasterFile: read, treatments: ['T2'], cases });
    expect(t2.status).toBe('FAILED');
    expect(t2.failures).toContain('branche REVALIDATE : aucun cas au corpus');
  });
});

describe('empreintes de référence (ai:verify, test:run)', () => {
  it('les masters du dépôt ont l’empreinte de référence : un master modifié exige de relancer le corpus', async () => {
    const r = await runMasterCorpus({ readMasterFile: read });
    expect(fingerprintDrift(r, readFingerprints()),
      'master modifié sans corpus : relancer `npm run ai:corpus -- --update-fingerprints`').toEqual([]);
  });

  it('écart détecté : texte modifié, master sans référence', async () => {
    const r = await runMasterCorpus({ readMasterFile: read, treatments: ['T4'] });
    expect(fingerprintDrift(r, { masters: { t4_master_v1: 'x'.repeat(64) } })[0]).toMatch(/t4_master_v1 : texte modifié/);
    expect(fingerprintDrift(r, { masters: {} })[0]).toMatch(/aucune empreinte de référence/);
  });
});

describe('l’évaluateur reçoit le TEXTE ÉVALUÉ (revue lot 16)', () => {
  it('texte de version : `masterText` rend CE texte pour le master du cas (le fichier pour les autres)', async () => {
    const { MASTER_CORPUS_EVALUATORS } = await import('../evaluators');
    const table = MASTER_CORPUS_EVALUATORS as Record<string, (typeof MASTER_CORPUS_EVALUATORS)[string]>;
    const orig = table.t6_formulate;
    const vus: Array<[string, string]> = [];
    table.t6_formulate = async (_c, _o, ctx) => { vus.push([ctx.masterText('t6_master_v1'), ctx.masterText('t1_master_v1')]); return []; };
    try {
      const texte = `${read('t6_master_v1')}\nRÈGLE DE VERSION.`;
      await runMasterCorpus({ readMasterFile: read, treatments: ['T6'], texts: { t6_master_v1: { text: texte, source: 'config' } } });
      expect(vus.length).toBeGreaterThan(0);
      expect(vus.every(([t6, t1]) => t6 === texte && t1 === read('t1_master_v1'))).toBe(true);
    } finally {
      table.t6_formulate = orig;
    }
  });
});

describe('garde d’activation (dépendances injectées)', () => {
  type Opts = { mode: 'replay' | 'live'; sources: string[] };
  const run = (over: Record<string, unknown> = {}) => ({
    id: 1, configVersionId: 7, treatment: 'T1', masterPromptCode: 't1_master_v1', masterPromptVersion: 'x',
    textSha256: masterTextFingerprint(read('t1_master_v1')), textSource: 'file' as const,
    branchesRequired: ['GROUP_UPLOAD', 'ANALYZE_DOCUMENT'], branchesPassed: ['GROUP_UPLOAD', 'ANALYZE_DOCUMENT'],
    casesTotal: 12, casesPassed: 12, status: 'PASSED' as const, source: 'ci' as const, runMode: 'replay' as const,
    environment: 'local', gitSha: null, createdAt: new Date(), ...over,
  });
  type Run = ReturnType<typeof run>;
  /** Base simulée : filtre par mode et sources comme la vraie requête. */
  const deps = (runs: Run[], ready = true) => ({
    readMasterFile: read,
    latestRun: async (_c: string, sha: string, o: Opts) =>
      runs.filter((r) => r.textSha256 === sha && r.runMode === o.mode && o.sources.includes(r.source)).at(-1) ?? null,
    tableReady: async () => ready,
  });
  const version = (t1: Record<string, unknown> = {}) => ({
    entries: [{ ...emptyTreatmentConfig('T1'), promptArchitecture: 'master' as const, ...t1 }, emptyTreatmentConfig('T2')],
  });
  const texte = `${read('t1_master_v1')}\nRègle ajoutée.`;
  const shaV = masterTextFingerprint(texte);

  it('traitement en steps : non concerné', async () => {
    const r = await checkMasterActivation({ entries: [emptyTreatmentConfig('T1')] }, deps([]));
    expect(r).toEqual({ allowed: true, entries: [] });
  });

  it('fichier du dépôt : un rejeu vert (ci/préprod/prod) suffit ; `local` jamais accepté', async () => {
    expect((await checkMasterActivation(version(), deps([run()]))).allowed).toBe(true);
    expect((await checkMasterActivation(version(), deps([run({ source: 'local' })]))).entries[0].status).toBe('NO_RUN');
  });

  it('aucun corpus / rouge / branche manquante / table absente : refus motivé', async () => {
    expect((await checkMasterActivation(version(), deps([]))).entries[0]).toMatchObject({ status: 'NO_RUN', textSource: 'file' });
    expect((await checkMasterActivation(version(), deps([run({ status: 'FAILED' })]))).entries[0].status).toBe('RUN_FAILED');
    expect((await checkMasterActivation(version(), deps([run({ branchesPassed: ['GROUP_UPLOAD'] })]))).entries[0])
      .toMatchObject({ status: 'BRANCHES_MISSING', message: expect.stringMatching(/ANALYZE_DOCUMENT/) });
    const t = await checkMasterActivation(version(), deps([run()], false));
    expect(t).toMatchObject({ allowed: false, entries: [expect.objectContaining({ status: 'CORPUS_TABLE_MISSING' })] });
  });

  it('texte de VERSION : rejeu vert ET passage réel vert en préprod exigés (D-17)', async () => {
    const v = version({ masterPrompt: texte });
    const rejeu = run({ textSha256: shaV, textSource: 'config' });
    expect((await checkMasterActivation(v, deps([rejeu]))).entries[0]).toMatchObject({ status: 'LIVE_RUN_MISSING', textSource: 'config' });
    // Un passage « réel » en CI ou en local ne compte pas.
    expect((await checkMasterActivation(v, deps([rejeu, run({ textSha256: shaV, runMode: 'live', source: 'ci' })]))).entries[0].status)
      .toBe('LIVE_RUN_MISSING');
    const liveKo = run({ textSha256: shaV, runMode: 'live', source: 'preprod', branchesPassed: ['GROUP_UPLOAD'] });
    expect((await checkMasterActivation(v, deps([rejeu, liveKo]))).entries[0].status).toBe('LIVE_RUN_FAILED');
    const liveOk = run({ textSha256: shaV, runMode: 'live', source: 'preprod' });
    expect((await checkMasterActivation(v, deps([rejeu, liveOk]))).allowed).toBe(true);
    // Sans rejeu : refus même avec le passage réel.
    expect((await checkMasterActivation(v, deps([liveOk]))).entries[0].status).toBe('NO_RUN');
  });

  it('texte de version IDENTIQUE au fichier : traité comme le fichier (rejeu seul)', async () => {
    const r = await checkMasterActivation(version({ masterPrompt: read('t1_master_v1') }), deps([run()]));
    expect(r).toMatchObject({ allowed: true, entries: [expect.objectContaining({ textSource: 'file' })] });
  });

  it('fichier master illisible : refus explicite, jamais un passage', async () => {
    const r = await checkMasterActivation(version(), { ...deps([run()]), readMasterFile: () => { throw new Error('introuvable'); } });
    expect(r).toMatchObject({ allowed: false, entries: [expect.objectContaining({ status: 'MASTER_FILE_MISSING' })] });
  });

  it('T5 : toujours le fichier du dépôt (non administrable), même si un texte traîne dans la ligne', async () => {
    const seen: string[] = [];
    await checkMasterActivation({ entries: [{ ...emptyTreatmentConfig('T5'), promptArchitecture: 'master', masterPrompt: 'texte pirate' }] }, {
      ...deps([]), latestRun: async (code: string, sha: string) => { seen.push(`${code}:${sha}`); return null; },
    });
    expect(seen).toEqual([`t5_master_v1:${masterTextFingerprint(read('t5_master_v1'))}`]);
  });
});

describe('empreinte des masters — fins de ligne', () => {
  it('CRLF (dépôt extrait sous Windows) et LF donnent la même empreinte', async () => {
    const { masterTextFingerprint } = await import('@/services/ai/prompts/prompt-loader');
    const lf = 'TASK = {{TASK}}\nBRANCHE TASK = A\nligne\n';
    expect(masterTextFingerprint(lf.replace(/\n/g, '\r\n'))).toBe(masterTextFingerprint(lf));
  });
});
