/**
 * Lot 72B — ticket « [P1] T3 — Fiabiliser l’harmonisation documentaire et
 * corriger les écarts du lot 61 » (E1 à E9), de bout en bout sur
 * PostgreSQL 16 réel : vrai passage T3 du compte (`reconcileAccount`), vraie
 * passerelle IA, vrai journal, vrai rapport, vrai balayage planifié.
 *
 * Modèle SIMULÉ (aucun réseau) : ces tests prouvent la MÉCANIQUE
 * (exhaustivité, reprise, empreinte, garde-fous, reporting), jamais la
 * pertinence d'un nom réel — celle-ci relève de la recette préproduction avec
 * le vrai modèle.
 *
 * Volume « plus de 20 000 documents » (E1) : un compte réel de 20 003
 * documents est inséré (insertion ensembliste) ; la pagination à curseur
 * persistant est en plus démontrée avec une taille de page réduite
 * (`T3_NAMING_SCAN_PAGE_SIZE`, même code) pour forcer plusieurs pages et
 * plusieurs passages sur un petit jeu.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';

interface DocIA {
  documentId: number; role: 'TO_EXAMINE' | 'REFERENCE'; currentName: string; nameOrigin: string; renameAllowed: boolean;
  documentDate: string | null; supplier: string | null;
  facts: Array<{ key: string; value: string; source?: string; factId?: number }>;
  excerpt: string | null; passages?: Array<{ text: string; offset: number; source: string }>;
  contracts?: Array<{ reference: string; source: string }>; operations?: unknown[];
}
interface Lot { comparisonSet: { key: string; documentCount: number; part: { index: number; of: number } }; previousConventions: unknown[] }
type Decision = Record<string, unknown> | Error;

const modele = {
  decider: (_l: Lot, _d: DocIA[]): Decision | Promise<Decision> => ({ task: 'DOCUMENT_NAMING', document_renames: [] }),
  appels: [] as Array<{ lot: Lot; docs: DocIA[] }>,
};

function fournisseur() {
  return {
    name: 'simule-l72b',
    isConfigured: () => true,
    async call(input: { prompt: string; operationCode?: string }) {
      if (input.operationCode !== 't3_document_naming') throw new Error(`appel inattendu : ${input.operationCode}`);
      const lot = JSON.parse(/^Objet à rattacher : (.*)$/m.exec(input.prompt)![1]) as Lot;
      const docs = JSON.parse(/^Candidats : (.*)$/m.exec(input.prompt)![1]) as DocIA[];
      modele.appels.push({ lot, docs });
      const d = await modele.decider(lot, docs);
      if (d instanceof Error) throw Object.assign(d, { status: 500 });
      return { rawText: JSON.stringify(d), inputTokens: 300, outputTokens: 80 };
    },
  };
}

/** Renommage proposé pour chaque document À EXAMINER présent dans `noms`. */
const proposer = (noms: Record<number, string>) => (_l: Lot, docs: DocIA[]) => ({
  task: 'DOCUMENT_NAMING',
  document_renames: docs.filter((d) => d.role === 'TO_EXAMINE' && noms[d.documentId] !== undefined && d.currentName !== noms[d.documentId]).map((d) => ({
    document_id: d.documentId, expected_current_name: d.currentName, proposed_name: noms[d.documentId],
    reference_document_ids: docs.filter((x) => x.documentId !== d.documentId).map((x) => x.documentId).slice(0, 2),
    reason: 'Convention de la famille', confidence: 'certain',
  })),
});

scenario('L72B-T3-NOM', 'Lot 72B — T3 : harmonisation documentaire exhaustive, reprenable et traçable', ({ sql, make }) => {
  const env0 = { ...process.env };
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(fournisseur() as never);
  });
  beforeEach(async () => {
    modele.decider = () => ({ task: 'DOCUMENT_NAMING', document_renames: [] });
    modele.appels.length = 0;
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests(null);
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('T3_NAMING_') && env0[k] === undefined) delete process.env[k];
  });
  afterAll(async () => {
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
  });

  async function document(c: { id: number; ownerUserId: number }, o: {
    nom: string; fournisseur?: string | null; type?: string | null; date?: string | null; texte?: string; bien?: number | null; source?: 'SYSTEM' | 'USER';
  }) {
    const fournisseurNom = o.fournisseur === undefined ? 'Orange' : o.fournisseur;
    const [f] = await sql<Array<{ id: number }>>`
      INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, mime_type, retained_title, supplier, document_type_code, document_date,
                               analysis_state, last_analysis_at, title_source, title_rule_version, title_context_fingerprint, title_checked_at)
      VALUES (${c.ownerUserId}, ${c.id}, ${o.bien ?? null}, ${`e2e/${c.id}/${Math.random().toString(36).slice(2)}.pdf`}, 'application/pdf', ${o.nom},
              ${fournisseurNom}, ${o.type === undefined ? 'INVOICE' : o.type}, ${o.date ?? null}, 'ANALYZED', now() - interval '1 hour', ${o.source ?? 'SYSTEM'}, 2, 'e2e', now())
      RETURNING id`;
    const [e] = await sql<Array<{ id: number }>>`
      INSERT INTO document_extractions (account_id, file_id, title, supplier_name, document_date, document_type_code, full_text, full_text_chars, extracted_at)
      VALUES (${c.id}, ${f.id}, ${o.nom}, ${fournisseurNom}, ${o.date ?? null}, ${o.type === undefined ? 'INVOICE' : o.type},
              ${o.texte ?? `Facture ${fournisseurNom ?? ''}`}, ${(o.texte ?? '').length}, now() - interval '1 hour')
      RETURNING id`;
    return { id: Number(f.id), extractionId: Number(e.id) };
  }
  async function fait(c: { id: number }, d: { id: number; extractionId: number }, key: string, value: string, o: { canonical?: string | null } = {}) {
    await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, confidence, excerpt, canonical_key)
              VALUES (${c.id}, ${d.id}, ${d.extractionId}, ${key}, ${key}, ${value}, 'high', ${value}, ${o.canonical === undefined ? key : o.canonical})`;
  }
  const nom = async (id: number) => (await sql<Array<{ t: string }>>`SELECT retained_title AS t FROM asset_files WHERE id = ${id}`)[0].t;
  const passer = async (accountId: number, type: 'manual' | 'scheduled' = 'scheduled', guard?: unknown) => {
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    return reconcileAccount(accountId, type === 'manual' ? { type: 'manual', requestedByUserId: null } : { type: 'scheduled' },
      { triggerCode: type === 'manual' ? 'manual' : 'schedule_hourly', ...(guard ? { guard: guard as never } : {}) });
  };
  const etat = async (accountId: number, key: string) => (await sql<Array<{ status: string; retry_after: Date | null; progress: Record<string, unknown> | null; last_error: string | null; attempts: number; prompt_version: string | null }>>`
    SELECT status, retry_after, progress, last_error, attempts, prompt_version FROM document_naming_groups WHERE account_id = ${accountId} AND group_key = ${key}`)[0];
  const evenements = (accountId: number) => sql<Array<{ id: number; file_id: number; outcome: string; reason_code: string | null; retry_status: string | null; retry_of: number | null; applied_name: string | null }>>`
    SELECT id, file_id, outcome, reason_code, retry_status, retry_of, applied_name FROM document_rename_events WHERE account_id = ${accountId} ORDER BY id`;
  const dansBalayage = async (accountId: number) => {
    const { listSweepAccountsFromDb } = await import('@/services/ai/reconciliation/t3-queue');
    return (await listSweepAccountsFromDb({ since: new Date(), afterAccountId: accountId - 1, limit: 1 })).includes(accountId);
  };
  const rapport = async (accountId: number) => {
    const [r] = await sql<Array<{ id: number; status: string; counters: Record<string, number>; sources: Record<string, unknown> }>>`
      SELECT id, status, counters, sources FROM ai_execution_reports
       WHERE account_id = ${accountId} AND treatment = 'T3' AND scope = 'DOCUMENT_NAMING' ORDER BY id DESC LIMIT 1`;
    const lignes = r ? await sql<Array<{ section: string; write_result: string; reason_code: string | null; record_id: string | null; links: Record<string, unknown> }>>`
      SELECT section, write_result, reason_code, record_id, links FROM ai_execution_report_entries
       WHERE report_id = COALESCE((SELECT entries_report_id FROM ai_execution_reports WHERE id = ${r.id}), ${r.id}) ORDER BY seq` : [];
    return { r, lignes };
  };
  const MOIS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];

  it('L72B-E1-01 — compte de plus de 20 000 documents : la famille dont les membres sont au-delà du 20 000e document est examinée, aucun document éligible oublié', async () => {
    const c = await make.account();
    // Un membre de la famille AVANT le stock, deux APRÈS (pages différentes).
    const premier = await document(c, { nom: 'orange janvier 2024', date: '2024-01-10' });
    await sql`
      INSERT INTO asset_files (user_id, account_id, s3_key, mime_type, retained_title, supplier, document_type_code, analysis_state, title_source)
      SELECT ${c.ownerUserId}, ${c.id}, 'e2e/l72b/' || ${c.id} || '/' || g || '.pdf', 'application/pdf', 'Pièce ' || g, 'Emetteur ' || g, 'INVOICE', 'ANALYZED', 'SYSTEM'
        FROM generate_series(1, 20000) g`;
    const fevrier = await document(c, { nom: 'Facture Orange 02/2024', date: '2024-02-10' });
    const mars = await document(c, { nom: 'Orange - mars 2024', date: '2024-03-10' });
    modele.decider = proposer({ [premier.id]: 'Facture Orange — janvier 2024', [fevrier.id]: 'Facture Orange — février 2024', [mars.id]: 'Facture Orange — mars 2024' });
    try {
    const debut = Date.now();
    const run = await passer(c.id, 'manual');
    const duree = Date.now() - debut;
    expect(run.documentNaming).toMatchObject({ status: 'DONE', documents: 20003, applied: 3, aiCalls: 1 });
    expect(run.documentNaming?.scan).toMatchObject({ complete: true, scanned: 20003 });
    expect(modele.appels).toHaveLength(1);
    expect(modele.appels[0].docs.map((d) => d.documentId).sort((a, b) => a - b)).toEqual([premier.id, fevrier.id, mars.id]);
    expect(await nom(mars.id)).toBe('Facture Orange — mars 2024');
    // Index persistant : chaque document éligible y figure (couverture complète), marqueur « terminé ».
    expect((await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM document_naming_members WHERE account_id = ${c.id}`)[0].n).toBe(20003);
    expect(await etat(c.id, '*')).toMatchObject({ status: 'DONE' });
    expect(await dansBalayage(c.id)).toBe(false);
    // Deuxième passage sans changement : zéro appel, zéro renommage.
    const run2 = await passer(c.id);
    expect(run2.documentNaming).toMatchObject({ status: 'DONE', aiCalls: 0, applied: 0 });
    expect(modele.appels).toHaveLength(1);
    console.info(`[L72B-E1-01] 20 003 documents : premier passage ${duree} ms`);
    } finally {
      // Base E2E partagée par les fichiers suivants : le stock de volume est retiré (sinon leurs rattrapages globaux le parcourent).
      await sql`DELETE FROM document_naming_members WHERE account_id = ${c.id}`;
      await sql`DELETE FROM asset_files WHERE account_id = ${c.id} AND s3_key LIKE 'e2e/l72b/%'`;
    }
  }, 300_000);

  it('L72B-E1-02 — pagination à curseur PERSISTANT (page réduite, même code) : famille répartie sur plusieurs pages et passages, stock déclaré terminé seulement après couverture complète, reprise exacte', async () => {
    process.env.T3_NAMING_SCAN_PAGE_SIZE = '4';
    process.env.T3_NAMING_SCAN_PAGES_PER_PASS = '2';
    const c = await make.account();
    const docs: Array<{ id: number; attendu: string }> = [];
    // Familles entremêlées (ids alternés) : Orange et Veolia, 7 documents chacune, plus 2 isolés.
    for (let i = 0; i < 7; i++) {
      const o = await document(c, { nom: `orange ${MOIS[i]} 2023`, date: `2023-${String(i + 1).padStart(2, '0')}-10` });
      docs.push({ id: o.id, attendu: `Facture Orange — ${MOIS[i]} 2023` });
      const v = await document(c, { nom: `veolia eau ${MOIS[i]} 2023`, fournisseur: 'Veolia', date: `2023-${String(i + 1).padStart(2, '0')}-20` });
      docs.push({ id: v.id, attendu: `Eau Veolia — ${MOIS[i]} 2023` });
    }
    await document(c, { nom: 'Attestation isolée', fournisseur: 'Mairie', type: 'CERTIFICATE' });
    await document(c, { nom: 'Contrat isolé', fournisseur: 'Notaire', type: 'CONTRACT' });
    const attendus = Object.fromEntries(docs.map((d) => [d.id, d.attendu]));
    modele.decider = proposer(attendus);
    // 16 documents, 4 par page, 2 pages par passage : passage 1 = 8 documents lus, stock incomplet → aucun appel.
    const p1 = await passer(c.id);
    expect(modele.appels).toHaveLength(0);
    expect(p1.documentNaming?.scan).toMatchObject({ complete: false, scanned: 8 });
    expect(p1.documentNaming?.status).toBe('PARTIAL');
    expect(p1.phases?.DOCUMENT_NAMING?.status).not.toBe('DONE');
    const m1 = await etat(c.id, '*');
    expect(m1.status).toBe('IN_PROGRESS');
    expect((m1.progress as { scan: { cursor: number } }).scan.cursor).toBeGreaterThan(0);
    expect(await dansBalayage(c.id)).toBe(true);
    // Passage 2 : la lecture reprend AU CURSEUR (8 documents restants), le stock est couvert, les deux familles examinées.
    const p2 = await passer(c.id);
    expect(p2.documentNaming?.scan).toMatchObject({ complete: true, scanned: 8 });
    expect(modele.appels.map((a) => a.lot.comparisonSet.key).sort()).toEqual(['s:orange', 's:veolia']);
    const examines = modele.appels.flatMap((a) => a.docs.filter((d) => d.role === 'TO_EXAMINE').map((d) => d.documentId));
    expect(examines.sort((a, b) => a - b)).toEqual(docs.map((d) => d.id).sort((a, b) => a - b));
    for (const d of docs) expect(await nom(d.id)).toBe(d.attendu);
    expect(p2.documentNaming?.status).toBe('DONE');
    expect(await etat(c.id, '*')).toMatchObject({ status: 'DONE' });
    // Passage 3 : nouveau cycle de lecture, rien de changé → aucun appel.
    const n = modele.appels.length;
    await passer(c.id);
    const p4 = await passer(c.id);
    expect(modele.appels.length).toBe(n);
    expect(p4.documentNaming).toMatchObject({ applied: 0, aiCalls: 0 });
  }, 120_000);

  it('L72B-E2-01 — compte sans bien : interruption pendant l’examen → réinscrit automatiquement au balayage, reprise exacte sans réexamen', async () => {
    process.env.T3_NAMING_MAX_DOCUMENTS_PER_CALL = '6';
    const c = await make.account();
    const docs = [];
    for (let i = 0; i < 10; i++) docs.push(await document(c, { nom: `orange ${MOIS[i]} 2022`, date: `2022-${String(i + 1).padStart(2, '0')}-05` }));
    modele.decider = proposer(Object.fromEntries(docs.map((d, i) => [d.id, `Facture Orange — ${MOIS[i]} 2022`])));
    // Garde : l'exécution est interrompue avant le 2e appel du lot (arrêt d'urgence, bail perdu…).
    const { ExecutionCancelledError } = await import('@/services/ai/queue/execution-control');
    let lots = 0;
    const garde = {
      jobId: 1, executionId: null, signal: new AbortController().signal,
      async assertActive(stage?: string) { if (stage?.includes('— lot ') && ++lots >= 3) throw new ExecutionCancelledError('test'); },
    };
    await expect(passer(c.id, 'scheduled', garde)).rejects.toThrow(/interrompue/);
    expect(modele.appels).toHaveLength(1);
    const premiers = modele.appels[0].docs.filter((d) => d.role === 'TO_EXAMINE').map((d) => d.documentId);
    expect(await etat(c.id, 's:orange')).toMatchObject({ status: 'IN_PROGRESS' });
    expect(await etat(c.id, '*')).toMatchObject({ status: 'IN_PROGRESS' });
    expect(await dansBalayage(c.id)).toBe(true);
    const run = await passer(c.id);
    const suite = modele.appels.slice(1).flatMap((a) => a.docs.filter((d) => d.role === 'TO_EXAMINE').map((d) => d.documentId));
    expect(suite.filter((id) => premiers.includes(id))).toEqual([]);
    expect([...premiers, ...suite].sort((a, b) => a - b)).toEqual(docs.map((d) => d.id).sort((a, b) => a - b));
    expect(run.documentNaming?.status).toBe('DONE');
    expect(await dansBalayage(c.id)).toBe(false);
  }, 120_000);

  it('L72B-E2-02 / L72B-E8-01 — compte sans bien, plafond journalier atteint : état non terminé, reprise datée, rapport exact ; repris automatiquement quand le plafond se libère', async () => {
    process.env.T3_NAMING_MAX_DOCUMENTS_PER_CALL = '6';
    process.env.T3_NAMING_MAX_CALLS_PER_DAY = '1';
    const c = await make.account();
    const docs = [];
    for (let i = 0; i < 10; i++) docs.push(await document(c, { nom: `orange ${MOIS[i]} 2021`, date: `2021-${String(i + 1).padStart(2, '0')}-05` }));
    modele.decider = proposer(Object.fromEntries(docs.map((d, i) => [d.id, `Facture Orange — ${MOIS[i]} 2021`])));
    const run = await passer(c.id);
    expect(modele.appels).toHaveLength(1);
    expect(run.documentNaming?.status).toBe('PARTIAL');
    expect(run.phases?.DOCUMENT_NAMING).toMatchObject({ status: 'PARTIAL', state: 'PARTIAL' });
    expect(run.documentNaming?.remaining).toMatchObject({ groups: 1, byReason: { DAILY_CAP: 1 } });
    expect(run.documentNaming?.remaining.documents).toBeGreaterThan(0);
    const g = await etat(c.id, 's:orange');
    expect(g.status).toBe('IN_PROGRESS');
    expect(g.retry_after).not.toBeNull();
    // Plafond atteint : pas de réinscription tant que la fenêtre de 24 h n'est pas libérée.
    expect(await dansBalayage(c.id)).toBe(false);
    const { r } = await rapport(c.id);
    expect(r.status).toBe('PARTIAL');
    expect(r.counters).toMatchObject({ remainingGroups: 1 });
    expect(r.sources).toMatchObject({ namingStatus: 'PARTIAL' });
    // Un passage pendant le plafond : aucun appel, état DEFERRED (jamais DONE).
    const bloque = await passer(c.id);
    expect(bloque.documentNaming?.status).toBe('DEFERRED');
    expect(bloque.phases?.DOCUMENT_NAMING?.status).toBe('DEFERRED');
    expect(modele.appels).toHaveLength(1);
    // 24 h plus tard (simulé : appels et dates de reprise vieillis) : réinscrit, repris jusqu'au bout.
    await sql`UPDATE ai_usage_event SET created_at = created_at - interval '25 hours' WHERE account_id = ${c.id}`;
    await sql`UPDATE document_naming_groups SET retry_after = now() - interval '1 minute' WHERE account_id = ${c.id} AND retry_after IS NOT NULL`;
    expect(await dansBalayage(c.id)).toBe(true);
    const fin = await passer(c.id);
    expect(fin.documentNaming?.status).toBe('DONE');
    for (const [i, d] of docs.entries()) expect(await nom(d.id)).toBe(`Facture Orange — ${MOIS[i]} 2021`);
  }, 120_000);

  it('L72B-E3-01 — nouveau fait T1 puis rattachement contractuel : réévaluation déclenchée sans relancer T1 ; contexte identique : aucun appel', async () => {
    const c = await make.account();
    const a = await document(c, { nom: 'Facture Orange — janvier 2024', date: '2024-01-10' });
    const b = await document(c, { nom: 'Facture Orange — février 2024', date: '2024-02-10' });
    await passer(c.id);
    expect(modele.appels).toHaveLength(1);
    await passer(c.id);
    expect(modele.appels).toHaveLength(1);
    const t1Avant = (await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM ai_job_queue WHERE account_id = ${c.id} AND treatment = 'T1'`)[0].n;
    // Nouveau fait structuré (période) sur un document : l'IA réexamine le lot et voit le fait.
    await fait(c, b, 'contractNumber', 'CT-2024-778899');
    await passer(c.id);
    expect(modele.appels).toHaveLength(2);
    expect(modele.appels[1].docs.find((d) => d.documentId === b.id)?.facts.map((f) => f.value)).toContain('CT-2024-778899');
    // Rattachement contractuel (Opération CONTRAT) : nouvelle information → réexamen.
    const [op] = await sql<Array<{ id: number }>>`INSERT INTO business_operations (account_id, type_code, status) VALUES (${c.id}, 'CONTRACT', 'REALIZED') RETURNING id`;
    await sql`INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, source_role, authority)
              VALUES (${c.id}, ${op.id}, 'DOCUMENT', ${String(a.id)}, 'INVOICE', 'DOCUMENT')`;
    await passer(c.id);
    expect(modele.appels).toHaveLength(3);
    expect(JSON.stringify(modele.appels[2].docs.find((d) => d.documentId === a.id)?.operations)).toContain(String(op.id));
    await passer(c.id);
    expect(modele.appels).toHaveLength(3);
    // T1 jamais relancé par T3.
    expect((await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM ai_job_queue WHERE account_id = ${c.id} AND treatment = 'T1'`)[0].n).toBe(t1Avant);
  }, 120_000);

  it('L72B-E4-01 — même contrat, fournisseurs formulés différemment ou absent : comparés ensemble ; deux contrats distincts : lots et conventions séparés ; isolation des comptes', async () => {
    const c = await make.account();
    const x1 = await document(c, { nom: 'EDF facture janvier 2025', fournisseur: 'EDF', date: '2025-01-10' });
    const x2 = await document(c, { nom: 'Électricité de France 02-2025', fournisseur: 'Électricité de France', date: '2025-02-10' });
    const x3 = await document(c, { nom: 'Échéancier électricité 2025', fournisseur: null, type: 'SCHEDULE', date: '2025-01-02' });
    await fait(c, x1, 'contractNumber', 'CT-778899');
    await fait(c, x2, 'contractNumber', 'ct 778899');
    await fait(c, x3, 'contractNumber', 'CT778899');
    // Un autre contrat, autre fournisseur : jamais mêlé.
    const y1 = await document(c, { nom: 'Gaz facture mars 2025', fournisseur: 'GRDF', date: '2025-03-10' });
    const y2 = await document(c, { nom: 'GRDF avril 2025', fournisseur: 'GRDF', date: '2025-04-10' });
    await fait(c, y1, 'contractNumber', 'GZ-445566');
    await fait(c, y2, 'contractNumber', 'GZ-445566');
    // Un autre COMPTE portant la même référence : jamais rapproché.
    const autre = await make.account();
    const z = await document(autre, { nom: 'EDF facture mars 2025', fournisseur: 'EDF', date: '2025-03-10' });
    await fait(autre, z, 'contractNumber', 'CT-778899');
    modele.decider = (lot, docs) => ({
      task: 'DOCUMENT_NAMING',
      families: [{ label: `Famille ${lot.comparisonSet.key}`, document_ids: docs.map((d) => d.documentId), convention: `Convention ${lot.comparisonSet.key}` }],
      document_renames: [],
    });
    await passer(c.id);
    expect(modele.appels).toHaveLength(2);
    const lots = modele.appels.map((a) => a.docs.map((d) => d.documentId).sort((p, q) => p - q));
    expect(lots).toContainEqual([x1.id, x2.id, x3.id].sort((p, q) => p - q));
    expect(lots).toContainEqual([y1.id, y2.id].sort((p, q) => p - q));
    expect(lots.flat()).not.toContain(z.id);
    const conv = await sql<Array<{ group_key: string; conventions: Array<{ convention: string }> }>>`
      SELECT group_key, conventions FROM document_naming_groups WHERE account_id = ${c.id} AND group_key <> '*' AND jsonb_array_length(conventions) > 0 ORDER BY group_key`;
    expect(conv).toHaveLength(2);
    expect(new Set(conv.map((g) => g.conventions[0].convention)).size).toBe(2);
    // L'autre compte : son document seul, jamais présenté avec ceux de c.
    await passer(autre.id);
    expect(modele.appels).toHaveLength(2);
  }, 120_000);

  it('L72B-E5-01 — information au-delà des anciennes limites (11e fait, texte après 300 caractères) : fournie au modèle avec sa provenance, et retenue par les garde-fous', async () => {
    const c = await make.account();
    const long = `${'Conditions générales de vente. '.repeat(60)}Référence client : RC-99887766. ${'Mentions légales. '.repeat(20)}`;
    const a = await document(c, { nom: 'Orange facture janvier', date: '2024-01-10', texte: long });
    const b = await document(c, { nom: 'Orange facture février 2024', date: '2024-02-10' });
    for (let i = 0; i < 11; i++) await fait(c, a, `ligne_${i}`, `valeur ${i}`, { canonical: null });
    await fait(c, a, 'contractNumber', 'CT-55443322');
    modele.decider = proposer({ [a.id]: 'Facture Orange — janvier 2024 — contrat CT-55443322 — client RC-99887766' });
    await passer(c.id);
    const vu = modele.appels[0].docs.find((d) => d.documentId === a.id)!;
    expect(vu.facts.find((f) => f.value === 'CT-55443322')).toMatchObject({ source: expect.any(String), factId: expect.any(Number) });
    expect(vu.facts.findIndex((f) => f.value === 'CT-55443322')).toBeLessThan(3);
    expect(vu.passages?.some((p) => p.text.includes('RC-99887766') && p.offset > 300 && p.source === 'EXTRACTION_FULL_TEXT')).toBe(true);
    expect(vu.contracts?.map((x) => x.reference)).toContain('CT-55443322');
    expect(await nom(a.id)).toBe('Facture Orange — janvier 2024 — contrat CT-55443322 — client RC-99887766');
    void b;
  }, 120_000);

  it('L72B-E6-01 — échec SQL temporaire à l’écriture : lot non terminé, décision persistée, reprise sans nouvel appel IA ni doublon ; renommage manuel concurrent : jamais forcé', async () => {
    const c = await make.account();
    const a = await document(c, { nom: 'orange janvier 2020', date: '2020-01-10' });
    const b = await document(c, { nom: 'orange février 2020', date: '2020-02-10' });
    const d = await document(c, { nom: 'orange mars 2020', date: '2020-03-10' });
    // Échec SQL RÉEL et temporaire : déclencheur qui refuse l'écriture des noms visés.
    await sql.unsafe(`CREATE OR REPLACE FUNCTION l72b_echec() RETURNS trigger AS $$
      BEGIN IF NEW.retained_title IN ('Facture Orange — janvier 2020', 'Facture Orange — mars 2020') THEN RAISE EXCEPTION 'échec temporaire l72b'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await sql.unsafe(`CREATE TRIGGER l72b_echec BEFORE UPDATE ON asset_files FOR EACH ROW WHEN (NEW.account_id = ${c.id}) EXECUTE FUNCTION l72b_echec()`);
    try {
      modele.decider = proposer({ [a.id]: 'Facture Orange — janvier 2020', [b.id]: 'Facture Orange — février 2020', [d.id]: 'Facture Orange — mars 2020' });
      const run = await passer(c.id);
      expect(run.documentNaming).toMatchObject({ applied: 1, failed: 2, pendingWrites: 2 });
      expect(run.documentNaming?.status).toBe('PARTIAL');
      expect(await etat(c.id, 's:orange')).toMatchObject({ status: 'WRITE_PENDING' });
      expect((await evenements(c.id)).filter((e) => e.outcome === 'FAILED').map((e) => e.retry_status)).toEqual(['PENDING', 'PENDING']);
    } finally {
      await sql.unsafe('DROP TRIGGER IF EXISTS l72b_echec ON asset_files');
    }
    // Pendant ce temps, l'utilisateur renomme le document de mars : jamais forcé.
    await sql`UPDATE asset_files SET retained_title = 'Mars — à la main', title_source = 'USER' WHERE id = ${d.id}`;
    await sql`UPDATE document_naming_groups SET retry_after = now() - interval '1 minute' WHERE account_id = ${c.id} AND group_key = 's:orange'`;
    expect(await dansBalayage(c.id)).toBe(true);
    const reprise = await passer(c.id);
    // Contexte changé par le renommage manuel : le lot est réexaminé ; la décision en attente de mars n'est pas forcée.
    expect(await nom(a.id)).toBe('Facture Orange — janvier 2020');
    expect(await nom(d.id)).toBe('Mars — à la main');
    const ev = await evenements(c.id);
    expect(ev.filter((e) => e.outcome === 'APPLIED' && e.file_id === a.id)).toHaveLength(1);
    expect(ev.some((e) => e.outcome === 'APPLIED' && e.file_id === d.id)).toBe(false);
    expect(ev.filter((e) => e.outcome === 'FAILED').every((e) => e.retry_status !== 'PENDING')).toBe(true);
    expect(reprise.documentNaming?.status).toBe('DONE');
  }, 120_000);

  it('L72B-E6-02 — reprise d’écriture à contexte inchangé : AUCUN nouvel appel IA, aucun doublon, corrélée à l’échec', async () => {
    const c = await make.account();
    const a = await document(c, { nom: 'orange janvier 2019', date: '2019-01-10' });
    const b = await document(c, { nom: 'Facture Orange — février 2019', date: '2019-02-10' });
    await sql.unsafe(`CREATE OR REPLACE FUNCTION l72b_echec2() RETURNS trigger AS $$
      BEGIN IF NEW.retained_title = 'Facture Orange — janvier 2019' THEN RAISE EXCEPTION 'échec temporaire l72b'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await sql.unsafe(`CREATE TRIGGER l72b_echec2 BEFORE UPDATE ON asset_files FOR EACH ROW WHEN (NEW.account_id = ${c.id}) EXECUTE FUNCTION l72b_echec2()`);
    try {
      modele.decider = proposer({ [a.id]: 'Facture Orange — janvier 2019' });
      await passer(c.id);
      expect(await nom(a.id)).toBe('orange janvier 2019');
      // Toujours en échec : la reprise échoue à nouveau, sans appel IA.
      await sql`UPDATE document_naming_groups SET retry_after = now() - interval '1 minute' WHERE account_id = ${c.id} AND group_key = 's:orange'`;
      await passer(c.id);
      expect(modele.appels).toHaveLength(1);
    } finally {
      await sql.unsafe('DROP TRIGGER IF EXISTS l72b_echec2 ON asset_files');
    }
    await sql`UPDATE document_naming_groups SET retry_after = now() - interval '1 minute' WHERE account_id = ${c.id} AND group_key = 's:orange'`;
    const run = await passer(c.id);
    expect(modele.appels).toHaveLength(1);
    expect(run.documentNaming).toMatchObject({ aiCalls: 0, writesRetried: 1, applied: 1, status: 'DONE' });
    expect(await nom(a.id)).toBe('Facture Orange — janvier 2019');
    const ev = await evenements(c.id);
    const applied = ev.filter((e) => e.outcome === 'APPLIED');
    expect(applied).toHaveLength(1);
    const echec = ev.find((e) => e.outcome === 'FAILED')!;
    expect(echec.retry_status).toBe('RESOLVED');
    expect(Number(applied[0].retry_of)).toBe(Number(echec.id));
    const { lignes } = await rapport(c.id);
    expect(lignes.find((l) => l.section === 'NAMING_RENAME' && Number(l.record_id) === a.id)).toMatchObject({ write_result: 'WRITTEN', links: expect.objectContaining({ retryOfEventId: Number(echec.id) }) });
    // Puis stable.
    await passer(c.id);
    expect(modele.appels).toHaveLength(1);
    expect((await evenements(c.id)).filter((e) => e.outcome === 'APPLIED')).toHaveLength(1);
    void b;
  }, 120_000);

  it('L72B-E7-01 — proposition visant un document REFERENCE : refusée et tracée (motif explicite), même si l’IA insiste ; nom personnalisé de référence protégé', async () => {
    process.env.T3_NAMING_MAX_DOCUMENTS_PER_CALL = '6';
    const c = await make.account();
    const docs = [];
    for (let i = 0; i < 8; i++) docs.push(await document(c, { nom: `orange ${MOIS[i]} 2018`, date: `2018-${String(i + 1).padStart(2, '0')}-10` }));
    const perso = await document(c, { nom: 'Ma facture préférée', date: '2018-12-10', source: 'USER' });
    // L'IA propose aussi de « réviser » chaque document fourni en RÉFÉRENCE.
    const cibles = proposer(Object.fromEntries([...docs.map((d, i) => [d.id, `Facture Orange — ${MOIS[i]} 2018`]), [perso.id, 'Facture Orange — décembre 2018']]));
    modele.decider = (lot, ds) => {
      const r = cibles(lot, ds);
      return { ...r, document_renames: [...r.document_renames, ...ds.filter((d) => d.role === 'REFERENCE').map((d) => ({
        document_id: d.documentId, expected_current_name: d.currentName, proposed_name: `${d.currentName} révisé`,
        reference_document_ids: [], reason: 'Révision de la convention', confidence: 'certain',
      }))] };
    };
    await passer(c.id);
    const refs = new Set(modele.appels.flatMap((a) => a.docs.filter((d) => d.role === 'REFERENCE').map((d) => `${modele.appels.indexOf(a)}:${d.documentId}`)));
    expect(refs.size).toBeGreaterThan(0);
    const ev = await evenements(c.id);
    expect(ev.some((e) => e.reason_code === 'REFERENCE_NOT_RENAMABLE' && e.outcome === 'REFUSED')).toBe(true);
    // Aucun document n'est renommé lors d'un appel où il n'était que référence.
    for (const e of ev.filter((x) => x.outcome === 'APPLIED')) {
      const appel = modele.appels.find((a) => a.docs.some((d) => d.documentId === e.file_id && d.role === 'TO_EXAMINE'));
      expect(appel).toBeDefined();
    }
    expect(await nom(perso.id)).toBe('Ma facture préférée');
    const { lignes } = await rapport(c.id);
    expect(lignes.some((l) => l.section === 'NAMING_RENAME' && l.reason_code === 'REFERENCE_NOT_RENAMABLE' && l.write_result === 'NOT_WRITTEN')).toBe(true);
  }, 120_000);

  it('L72B-E9-01 — sortie sans document_renames : anomalie, jamais lot terminé ; reprise bornée ; après 3 anomalies sur la même version, plus aucun rappel IA', async () => {
    const c = await make.account();
    const a = await document(c, { nom: 'orange janvier 2017', date: '2017-01-10' });
    const b = await document(c, { nom: 'orange février 2017', date: '2017-02-10' });
    modele.decider = () => ({ task: 'DOCUMENT_NAMING', families: [{ label: 'Factures', document_ids: [a.id, b.id] }] });
    const r1 = await passer(c.id);
    expect(r1.documentNaming).toMatchObject({ renamesSectionMissing: 1, applied: 0, groupsCompleted: 0 });
    expect(r1.documentNaming?.status).not.toBe('DONE');
    const g1 = await etat(c.id, 's:orange');
    expect(g1).toMatchObject({ status: 'ERROR', last_error: expect.stringContaining('RENAMES_SECTION_MISSING') });
    expect(g1.retry_after).not.toBeNull();
    const { r, lignes } = await rapport(c.id);
    expect(r.status).not.toBe('SUCCESS');
    expect(r.counters).toMatchObject({ renamesSectionMissing: 1 });
    expect(lignes.some((l) => l.section === 'NAMING_GROUP' && l.reason_code === 'RENAMES_SECTION_MISSING')).toBe(true);
    // Délai respecté : aucun rappel immédiat.
    await passer(c.id);
    expect(modele.appels).toHaveLength(1);
    // Deux nouvelles anomalies (délais échus) → version marquée inutilisable pour le nommage.
    for (let i = 0; i < 2; i++) {
      await sql`UPDATE document_naming_groups SET retry_after = now() - interval '1 minute' WHERE account_id = ${c.id} AND group_key = 's:orange'`;
      await passer(c.id);
    }
    expect(modele.appels).toHaveLength(3);
    expect(await etat(c.id, 's:orange')).toMatchObject({ status: 'PROMPT_UNAVAILABLE' });
    await sql`UPDATE document_naming_groups SET retry_after = now() - interval '1 minute' WHERE account_id = ${c.id}`;
    const r4 = await passer(c.id);
    expect(modele.appels).toHaveLength(3);
    expect(r4.documentNaming?.status).toBe('DEFERRED');
    // Une sortie complète vide (`document_renames: []`) : lot terminé, rien renommé.
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    const { readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    __setActiveMasterPromptsForTests([{ id: 97201, treatment: 'T3', versionNumber: 72, content: readMasterFileFromRepo('t3_master_v1') }]);
    modele.decider = () => ({ task: 'DOCUMENT_NAMING', document_renames: [] });
    const r5 = await passer(c.id);
    expect(modele.appels).toHaveLength(4);
    expect(r5.documentNaming?.status).toBe('DONE');
    expect(await etat(c.id, 's:orange')).toMatchObject({ status: 'DONE' });
  }, 120_000);

  it('L72B-E8-02 — prompt sans branche DOCUMENT_NAMING : phase DEFERRED (jamais DONE), travail restant chiffré, synthèse et rapport harmonisés', async () => {
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    const { readMasterFileFromRepo } = await import('@/services/ai/governance/master-corpus/cases');
    const fichier = readMasterFileFromRepo('t3_master_v1');
    const sansBranche = fichier.slice(0, fichier.indexOf('BRANCHE TASK = DOCUMENT_NAMING')).replace(' | DOCUMENT_NAMING', '') + 'Réponds uniquement par le JSON correspondant au TASK demandé.\n';
    __setActiveMasterPromptsForTests([{ id: 97200, treatment: 'T3', versionNumber: 70, content: sansBranche }]);
    const c = await make.account();
    await document(c, { nom: 'orange janvier 2016', date: '2016-01-10' });
    await document(c, { nom: 'orange février 2016', date: '2016-02-10' });
    const run = await passer(c.id);
    expect(modele.appels).toHaveLength(0);
    expect(run.documentNaming?.status).toBe('DEFERRED');
    expect(run.phases?.DOCUMENT_NAMING).toMatchObject({ status: 'DEFERRED', state: 'DEFERRED', counts: { promptUnavailable: 1, remainingGroups: 1, remainingDocuments: 2 } });
    expect(run.documentNaming?.remaining.byReason).toMatchObject({ PROMPT_WITHOUT_DOCUMENT_NAMING: 1 });
    const { r } = await rapport(c.id);
    expect(r.status).toBe('PARTIAL');
    expect(r.sources).toMatchObject({ namingStatus: 'DEFERRED', remaining: { groups: 1, documents: 2 } });
    // Synthèse T3 du job : même statut.
    const { summarizeT3Naming } = await import('@/services/ai/reconciliation/t3-queue');
    expect(summarizeT3Naming(run.documentNaming!)).toMatchObject({ status: 'DEFERRED', remainingGroups: 1 });
    // Réinscription datée (vérification quotidienne de la version), pas à chaque balayage.
    expect(await etat(c.id, '*')).toMatchObject({ status: 'IN_PROGRESS' });
    expect((await etat(c.id, '*')).retry_after).not.toBeNull();
    expect(await dansBalayage(c.id)).toBe(false);
  }, 120_000);

  it('L72B-E2-03 — nouvel import sur un compte terminé (sans bien) : réinscrit au balayage, le nouveau document est examiné ; sans changement : jamais réinscrit', async () => {
    const c = await make.account();
    await document(c, { nom: 'Facture Orange — janvier 2015', date: '2015-01-10' });
    await document(c, { nom: 'Facture Orange — février 2015', date: '2015-02-10' });
    await passer(c.id);
    expect(await etat(c.id, '*')).toMatchObject({ status: 'DONE' });
    expect(await dansBalayage(c.id)).toBe(false);
    // Délai minimal pour distinguer les horodatages.
    await sql`UPDATE document_naming_groups SET updated_at = now() - interval '1 minute' WHERE account_id = ${c.id}`;
    const n = await document(c, { nom: 'orange_mars.pdf', date: '2015-03-10' });
    expect(await dansBalayage(c.id)).toBe(true);
    modele.decider = proposer({ [n.id]: 'Facture Orange — mars 2015' });
    await passer(c.id);
    expect(await nom(n.id)).toBe('Facture Orange — mars 2015');
    expect(await dansBalayage(c.id)).toBe(false);
  }, 120_000);

  it('L72B-MIG-01 — migration 0513 rejouable ; lot examiné au lot 61 et inchangé : recalé SANS appel IA (aucune réanalyse de masse au déploiement) ; nouveauté ensuite : réexamen', async () => {
    const mig = readFileSync(join(process.cwd(), 'src/db/migrations/0513_l72b_t3_nommage_ecarts.sql'), 'utf8');
    await sql.begin(async (tx) => { await tx.unsafe(mig); });
    await sql.begin(async (tx) => { await tx.unsafe(mig); });
    const c = await make.account();
    const a = await document(c, { nom: 'Facture Orange — janvier 2014', date: '2014-01-10' });
    const b = await document(c, { nom: 'Facture Orange — février 2014', date: '2014-02-10' });
    // État tel qu'écrit par le lot 61 : empreinte v1, sans version de contexte, sans index.
    const repo = await import('@/services/ai/reconciliation/document-naming/repository');
    const ctx = await import('@/services/ai/reconciliation/document-naming/context');
    const docs = await repo.loadNamingDocsByIds(c.id, [a.id, b.id]);
    await sql`INSERT INTO document_naming_groups (account_id, group_key, status, fingerprint, document_count, conventions)
              VALUES (${c.id}, 's:orange', 'DONE', ${ctx.legacyGroupFingerprint(docs)}, 2, ${JSON.stringify([{ label: 'Factures', convention: 'Facture Orange — <mois> <année>' }])}::jsonb)`;
    await sql`INSERT INTO document_naming_groups (account_id, group_key, status, document_count) VALUES (${c.id}, '*', 'DONE', 2)`;
    const run = await passer(c.id);
    expect(modele.appels).toHaveLength(0);
    expect(run.documentNaming).toMatchObject({ status: 'DONE', rebaselined: 1, aiCalls: 0 });
    const [g] = await sql<Array<{ context_version: string; conventions: Array<{ label: string }> }>>`
      SELECT context_version, conventions FROM document_naming_groups WHERE account_id = ${c.id} AND group_key = 's:orange'`;
    expect(g).toMatchObject({ context_version: 'naming-v2', conventions: [{ label: 'Factures' }] });
    await passer(c.id);
    expect(modele.appels).toHaveLength(0);
    // Une vraie nouveauté (fait T1) : réexamen, conventions du lot 61 redonnées à l'IA.
    await fait(c, a, 'contractNumber', 'CT-14141414');
    await passer(c.id);
    expect(modele.appels).toHaveLength(1);
    expect(modele.appels[0].lot.previousConventions).toEqual([{ label: 'Factures', convention: 'Facture Orange — <mois> <année>' }]);
  }, 120_000);
});
