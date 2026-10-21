/**
 * Lot 76B — ticket « [P1] T3 — Corriger les défauts résiduels de reprise, de
 * réévaluation et de finalisation du lot 72B » (C1 à C6), de bout en bout sur
 * PostgreSQL 16 réel : vrai passage T3 du compte (`reconcileAccount`), vraie
 * passerelle IA, vrai journal, vrai rapport, vrai balayage planifié, vrais
 * échecs SQL (déclencheurs) et vraies interruptions (garde d'exécution).
 *
 * Modèle SIMULÉ (aucun réseau) : ces tests prouvent la MÉCANIQUE (reprise,
 * finalisation, revalidation, réactivation, recalage borné, indices,
 * fenêtres) — jamais la pertinence d'un nom réel, qui relève de la recette
 * préproduction avec le vrai modèle. Toutes les assertions portent sur les
 * comptes créés par ce fichier.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { scenario } from '../scenario';

interface DocIA {
  documentId: number; role: 'TO_EXAMINE' | 'REFERENCE'; currentName: string; nameOrigin: string; renameAllowed: boolean;
  documentDate: string | null; supplier: string | null;
  facts: Array<{ key: string; value: string; source?: string; factId?: number }>;
  excerpt: string | null; passages?: Array<{ text: string; offset: number; source: string }>;
  operations?: Array<{ id: number; status: string; type: string | null }>;
  matchHints?: Array<{ reference: string; source: string; sharedWithDocumentIds: number[] }>;
}
interface Lot { comparisonSet: { key: string; documentCount: number; part: { index: number; of: number } }; previousConventions: unknown[] }
type Decision = Record<string, unknown> | Error;

const modele = {
  decider: (_l: Lot, _d: DocIA[]): Decision | Promise<Decision> => ({ task: 'DOCUMENT_NAMING', document_renames: [] }),
  appels: [] as Array<{ lot: Lot; docs: DocIA[] }>,
};

function fournisseur() {
  return {
    name: 'simule-l76b',
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

/** Renommage proposé pour chaque document À EXAMINER présent dans `noms` (et dont le nom diffère). */
const proposer = (noms: Record<number, string>) => (_l: Lot, docs: DocIA[]) => ({
  task: 'DOCUMENT_NAMING',
  document_renames: docs.filter((d) => d.role === 'TO_EXAMINE' && noms[d.documentId] !== undefined && d.currentName !== noms[d.documentId]).map((d) => ({
    document_id: d.documentId, expected_current_name: d.currentName, proposed_name: noms[d.documentId],
    reference_document_ids: docs.filter((x) => x.documentId !== d.documentId).map((x) => x.documentId).slice(0, 2),
    reason: 'Convention de la famille', confidence: 'certain',
  })),
});
const cibles = (a: { docs: DocIA[] }) => a.docs.filter((d) => d.role === 'TO_EXAMINE').map((d) => d.documentId);

scenario('L76B-T3-NOM', 'Lot 76B — T3 : défauts résiduels de reprise, de réévaluation et de finalisation', ({ sql, make }) => {
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
    const texte = o.texte ?? `Facture ${fournisseurNom ?? ''}`;
    const [f] = await sql<Array<{ id: number }>>`
      INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, mime_type, retained_title, supplier, document_type_code, document_date,
                               analysis_state, last_analysis_at, title_source, title_rule_version, title_context_fingerprint, title_checked_at)
      VALUES (${c.ownerUserId}, ${c.id}, ${o.bien ?? null}, ${`e2e/${c.id}/${Math.random().toString(36).slice(2)}.pdf`}, 'application/pdf', ${o.nom},
              ${fournisseurNom}, ${o.type === undefined ? 'INVOICE' : o.type}, ${o.date ?? null}, 'ANALYZED', now() - interval '1 hour', ${o.source ?? 'SYSTEM'}, 2, 'e2e', now())
      RETURNING id`;
    const [e] = await sql<Array<{ id: number }>>`
      INSERT INTO document_extractions (account_id, file_id, title, supplier_name, document_date, document_type_code, full_text, full_text_chars, extracted_at)
      VALUES (${c.id}, ${f.id}, ${o.nom}, ${fournisseurNom}, ${o.date ?? null}, ${o.type === undefined ? 'INVOICE' : o.type},
              ${texte}, ${texte.length}, now() - interval '1 hour')
      RETURNING id`;
    return { id: Number(f.id), extractionId: Number(e.id) };
  }
  async function fait(c: { id: number }, d: { id: number; extractionId: number }, key: string, value: string, o: { canonical?: string | null } = {}) {
    const [r] = await sql<Array<{ id: number }>>`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, confidence, excerpt, canonical_key)
              VALUES (${c.id}, ${d.id}, ${d.extractionId}, ${key}, ${key}, ${value}, 'high', ${value.slice(0, 200)}, ${o.canonical === undefined ? key : o.canonical})
              RETURNING id`;
    return Number(r.id);
  }
  const nom = async (id: number) => (await sql<Array<{ t: string }>>`SELECT retained_title AS t FROM asset_files WHERE id = ${id}`)[0].t;
  const passer = async (accountId: number, guard?: unknown) => {
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    return reconcileAccount(accountId, { type: 'scheduled' }, { triggerCode: 'schedule_hourly', ...(guard ? { guard: guard as never } : {}) });
  };
  const etat = async (accountId: number, key: string) => (await sql<Array<{ status: string; retry_after: Date | null; progress: Record<string, unknown> | null; last_error: string | null; upgrade_state: string | null; context_version: string | null }>>`
    SELECT status, retry_after, progress, last_error, upgrade_state, context_version FROM document_naming_groups WHERE account_id = ${accountId} AND group_key = ${key}`)[0];
  const evenements = (accountId: number) => sql<Array<{ id: number; file_id: number; outcome: string; reason_code: string | null; retry_status: string | null; retry_of: number | null; applied_name: string | null }>>`
    SELECT id, file_id, outcome, reason_code, retry_status, retry_of, applied_name FROM document_rename_events WHERE account_id = ${accountId} ORDER BY id`;
  const enAttente = async (accountId: number) => (await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM document_rename_events WHERE account_id = ${accountId} AND outcome IN ('FAILED', 'DECIDED') AND retry_status = 'PENDING'`)[0].n;
  const dansBalayage = async (accountId: number) => {
    const { listSweepAccountsFromDb } = await import('@/services/ai/reconciliation/t3-queue');
    return (await listSweepAccountsFromDb({ since: new Date(), afterAccountId: accountId - 1, limit: 1 })).includes(accountId);
  };
  const rapport = async (accountId: number) => {
    const [r] = await sql<Array<{ id: number; status: string; counters: Record<string, number>; sources: Record<string, unknown> }>>`
      SELECT id, status, counters, sources FROM ai_execution_reports
       WHERE account_id = ${accountId} AND treatment = 'T3' AND scope = 'DOCUMENT_NAMING' ORDER BY id DESC LIMIT 1`;
    const lignes = r ? await sql<Array<{ section: string; write_result: string; reason_code: string | null; reason: string | null; record_id: string | null }>>`
      SELECT section, write_result, reason_code, reason, record_id FROM ai_execution_report_entries
       WHERE report_id = COALESCE((SELECT entries_report_id FROM ai_execution_reports WHERE id = ${r.id}), ${r.id}) ORDER BY seq` : [];
    return { r, lignes };
  };
  const echu = (accountId: number) => sql`UPDATE document_naming_groups SET retry_after = now() - interval '1 minute' WHERE account_id = ${accountId} AND retry_after IS NOT NULL`;
  /** Déclencheur d'échec SQL réel sur l'écriture de certains noms (retiré par la fonction rendue). */
  async function echecEcriture(accountId: number, nomsRefuses: string[]) {
    const n = `l76b_echec_${accountId}`;
    const liste = nomsRefuses.map((x) => `'${x.replace(/'/g, "''")}'`).join(', ');
    await sql.unsafe(`CREATE OR REPLACE FUNCTION ${n}() RETURNS trigger AS $$
      BEGIN IF NEW.retained_title IN (${liste}) THEN RAISE EXCEPTION 'échec temporaire l76b'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await sql.unsafe(`CREATE TRIGGER ${n} BEFORE UPDATE ON asset_files FOR EACH ROW WHEN (NEW.account_id = ${accountId}) EXECUTE FUNCTION ${n}()`);
    return async () => { await sql.unsafe(`DROP TRIGGER IF EXISTS ${n} ON asset_files`); };
  }
  const MOIS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];

  it('L76B-C1-01 — échec d’écriture dans une 1re partie, plafond atteint, reprise puis fin d’examen : la décision reste due (jamais DONE) puis est reprise sans appel IA', async () => {
    process.env.T3_NAMING_MAX_DOCUMENTS_PER_CALL = '6';
    process.env.T3_NAMING_MAX_CALLS_PER_PASS = '1';
    const c = await make.account();
    const docs: Array<{ id: number; extractionId: number }> = [];
    for (let i = 0; i < 10; i++) docs.push(await document(c, { nom: `orange ${MOIS[i]} 2013`, date: `2013-${String(i + 1).padStart(2, '0')}-05` }));
    const attendus = Object.fromEntries(docs.map((d, i) => [d.id, `Facture Orange — ${MOIS[i]} 2013`]));
    modele.decider = proposer(attendus);
    const retirer = await echecEcriture(c.id, [attendus[docs[0].id]]);
    try {
      // Passage 1 : 1re partie examinée, l'écriture du document de janvier échoue, plafond du passage atteint.
      const p1 = await passer(c.id);
      expect(modele.appels).toHaveLength(1);
      expect(cibles(modele.appels[0])).toContain(docs[0].id);
      expect(p1.documentNaming).toMatchObject({ failed: 1 });
      expect(await enAttente(c.id)).toBe(1);
      expect(await etat(c.id, 's:orange')).toMatchObject({ status: 'IN_PROGRESS' });
      // Passage 2 : l'examen se termine dans un AUTRE passage — l'écriture restante interdit DONE (lot et compte).
      const p2 = await passer(c.id);
      expect(modele.appels).toHaveLength(2);
      expect(await enAttente(c.id)).toBe(1);
      expect(await etat(c.id, 's:orange')).toMatchObject({ status: 'WRITE_PENDING' });
      expect(p2.documentNaming?.status).not.toBe('DONE');
      expect(p2.documentNaming?.pendingWrites).toBe(1);
      expect(p2.documentNaming?.remaining.byReason).toMatchObject({ WRITE_RETRY: 1 });
      expect(await etat(c.id, '*')).toMatchObject({ status: 'IN_PROGRESS' });
      expect(p2.phases?.DOCUMENT_NAMING?.status).not.toBe('DONE');
    } finally {
      await retirer();
    }
    // Passage 3 (délai échu) : reprise de la décision d'origine SANS appel IA, puis terminé.
    await echu(c.id);
    expect(await dansBalayage(c.id)).toBe(true);
    const p3 = await passer(c.id);
    expect(modele.appels).toHaveLength(2);
    expect(p3.documentNaming).toMatchObject({ aiCalls: 0, writesRetried: 1, applied: 1, pendingWrites: 0, status: 'DONE' });
    for (const d of docs) expect(await nom(d.id)).toBe(attendus[d.id]);
    expect((await evenements(c.id)).filter((e) => e.outcome === 'APPLIED' && e.file_id === docs[0].id)).toHaveLength(1);
    // Passages successifs sans changement : aucun appel, aucun renommage.
    const p4 = await passer(c.id);
    expect(p4.documentNaming).toMatchObject({ aiCalls: 0, applied: 0, status: 'DONE' });
    expect(modele.appels).toHaveLength(2);
  }, 120_000);

  it('L76B-C1-02 — lot DONE laissé avec une décision PENDING (état antérieur au lot 76B) : ni lot ni compte terminés ; reprise automatique sans appel IA', async () => {
    const c = await make.account();
    const a = await document(c, { nom: 'orange janvier 2012', date: '2012-01-10' });
    const b = await document(c, { nom: 'Facture Orange — février 2012', date: '2012-02-10' });
    modele.decider = proposer({ [a.id]: 'Facture Orange — janvier 2012' });
    const retirer = await echecEcriture(c.id, ['Facture Orange — janvier 2012']);
    try {
      await passer(c.id);
    } finally {
      await retirer();
    }
    expect(await enAttente(c.id)).toBe(1);
    // Simulation de l'état produit par le défaut du lot 72B : lot et compte DONE malgré l'écriture restante.
    await sql`UPDATE document_naming_groups SET status = 'DONE', retry_after = NULL, last_error = NULL WHERE account_id = ${c.id}`;
    const run = await passer(c.id);
    expect(modele.appels).toHaveLength(1);
    expect(run.documentNaming).toMatchObject({ aiCalls: 0, applied: 1, writesRetried: 1, status: 'DONE' });
    expect(await nom(a.id)).toBe('Facture Orange — janvier 2012');
    expect(await enAttente(c.id)).toBe(0);
    void b;
  }, 120_000);

  it('L76B-C2-01 — échec d’écriture ET échec de journalisation : aucune écriture, état non terminé, motif explicite, aucun faux engagement de reprise ; réexamen IA ensuite', async () => {
    const c = await make.account();
    const a = await document(c, { nom: 'orange janvier 2011', date: '2011-01-10' });
    const b = await document(c, { nom: 'Facture Orange — février 2011', date: '2011-02-10' });
    modele.decider = proposer({ [a.id]: 'Facture Orange — janvier 2011' });
    const retirerEcriture = await echecEcriture(c.id, ['Facture Orange — janvier 2011']);
    // Incident SQL sur le JOURNAL : toute décision / tout échec refusé à l'insertion pour ce compte.
    await sql.unsafe(`CREATE OR REPLACE FUNCTION l76b_journal_${c.id}() RETURNS trigger AS $$
      BEGIN IF NEW.outcome IN ('FAILED', 'DECIDED') THEN RAISE EXCEPTION 'journal indisponible l76b'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await sql.unsafe(`CREATE TRIGGER l76b_journal_${c.id} BEFORE INSERT ON document_rename_events FOR EACH ROW WHEN (NEW.account_id = ${c.id}) EXECUTE FUNCTION l76b_journal_${c.id}()`);
    try {
      const run = await passer(c.id);
      expect(modele.appels).toHaveLength(1);
      expect(await nom(a.id)).toBe('orange janvier 2011');
      // Jamais un faux succès : ni lot ni compte terminés, motif explicite.
      expect(run.documentNaming?.status).not.toBe('DONE');
      expect(run.documentNaming).toMatchObject({ decisionsUnsaved: 1, applied: 0 });
      expect(await etat(c.id, 's:orange')).toMatchObject({ status: 'ERROR', last_error: expect.stringContaining('DECISION_NOT_PERSISTED') });
      expect(await etat(c.id, '*')).toMatchObject({ status: 'IN_PROGRESS' });
      const { r, lignes } = await rapport(c.id);
      expect(r.status).not.toBe('SUCCESS');
      expect(r.counters).toMatchObject({ decisionsUnsaved: 1 });
      const ligne = lignes.find((l) => l.section === 'NAMING_RENAME' && Number(l.record_id) === a.id)!;
      expect(ligne).toMatchObject({ write_result: 'FAILED', reason_code: 'DECISION_NOT_PERSISTED' });
      // Aucun engagement de reprise sans appel IA pour une décision non sauvegardée.
      expect(ligne.reason).not.toMatch(/reprise automatique sans nouvel appel/);
      expect(ligne.reason).toMatch(/réexaminé par l’IA/);
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS l76b_journal_${c.id} ON document_rename_events`);
      await retirerEcriture();
    }
    // Incident levé, délai échu : nouvel examen IA (annoncé), écriture faite une seule fois.
    await echu(c.id);
    const fin = await passer(c.id);
    expect(modele.appels).toHaveLength(2);
    expect(fin.documentNaming?.status).toBe('DONE');
    expect(await nom(a.id)).toBe('Facture Orange — janvier 2011');
    expect((await evenements(c.id)).filter((e) => e.outcome === 'APPLIED')).toHaveLength(1);
    void b;
  }, 120_000);

  it('L76B-C2-02 — interruption après persistance de la décision, puis après une application : reprise idempotente, sans nouvel appel IA ni doublon', async () => {
    const { ExecutionCancelledError } = await import('@/services/ai/queue/execution-control');
    const c = await make.account();
    const a = await document(c, { nom: 'orange janvier 2010', date: '2010-01-10' });
    const b = await document(c, { nom: 'orange février 2010', date: '2010-02-10' });
    const d = await document(c, { nom: 'orange mars 2010', date: '2010-03-10' });
    const attendus = { [a.id]: 'Facture Orange — janvier 2010', [b.id]: 'Facture Orange — février 2010', [d.id]: 'Facture Orange — mars 2010' };
    modele.decider = proposer(attendus);
    // 1. Interruption AVANT la première écriture (décisions déjà persistées).
    let ecritures = 0;
    const garde = (apres: number) => ({
      jobId: 1, executionId: null, signal: new AbortController().signal,
      async assertActive(stage?: string) {
        const ecriture = stage === 'T3 harmonisation documentaire — écriture' || stage === 'T3 harmonisation documentaire — reprise d’écriture';
        if (ecriture && ecritures++ >= apres) throw new ExecutionCancelledError('test');
      },
    });
    await expect(passer(c.id, garde(0))).rejects.toThrow(/interrompue/);
    expect(modele.appels).toHaveLength(1);
    expect(await enAttente(c.id)).toBe(3);
    for (const x of [a, b, d]) expect(await nom(x.id)).not.toBe(attendus[x.id]);
    // 2. Reprise interrompue APRÈS la première application.
    ecritures = 0;
    await expect(passer(c.id, garde(1))).rejects.toThrow(/interrompue/);
    expect(modele.appels).toHaveLength(1);
    // 3. Reprise complète : aucune nouvelle analyse IA, chaque document écrit exactement une fois.
    const fin = await passer(c.id);
    expect(modele.appels).toHaveLength(1);
    expect(fin.documentNaming).toMatchObject({ aiCalls: 0, status: 'DONE', pendingWrites: 0 });
    for (const x of [a, b, d]) expect(await nom(x.id)).toBe(attendus[x.id]);
    const ev = await evenements(c.id);
    for (const x of [a, b, d]) expect(ev.filter((e) => e.outcome === 'APPLIED' && e.file_id === x.id)).toHaveLength(1);
    expect(ev.some((e) => e.outcome === 'DECIDED')).toBe(false);
    // Stable.
    await passer(c.id);
    expect(modele.appels).toHaveLength(1);
  }, 120_000);

  it('L76B-C2-03 — renommage manuel concurrent d’une décision en attente : jamais forcé, décision close (proposition sur un document de RÉFÉRENCE : L72B-E7-01)', async () => {
    const c = await make.account();
    const a = await document(c, { nom: 'orange janvier 2009', date: '2009-01-10' });
    const b = await document(c, { nom: 'orange février 2009', date: '2009-02-10' });
    modele.decider = proposer({ [a.id]: 'Facture Orange — janvier 2009' });
    const retirer = await echecEcriture(c.id, ['Facture Orange — janvier 2009']);
    try { await passer(c.id); } finally { await retirer(); }
    expect(await enAttente(c.id)).toBe(1);
    await sql`UPDATE asset_files SET retained_title = 'Janvier — à la main', title_source = 'USER' WHERE id = ${a.id}`;
    // L'IA (réexamen après ce changement) propose aussi de renommer le document fourni en RÉFÉRENCE.
    modele.decider = (_l, docs) => ({ task: 'DOCUMENT_NAMING', document_renames: docs.map((x) => ({
      document_id: x.documentId, expected_current_name: x.currentName, proposed_name: `${x.currentName} révisé`, reference_document_ids: [],
      reason: 'r', confidence: 'certain' })) });
    await echu(c.id);
    await passer(c.id);
    expect(await nom(a.id)).toBe('Janvier — à la main');
    const ev = await evenements(c.id);
    expect(ev.some((e) => e.outcome === 'APPLIED' && e.file_id === a.id)).toBe(false);
    expect(ev.some((e) => e.file_id === a.id && e.reason_code === 'USER_NAME_PROTECTED')
      || ev.some((e) => e.file_id === a.id && e.outcome === 'CONFLICT')).toBe(true);
    expect(await enAttente(c.id)).toBe(0);
    void b;
  }, 120_000);

  it('L76B-C3-01 / L76B-C3-02 — nouvelle information sur un document déjà examiné pendant une interruption : réexaminé ; sans changement : progression conservée, aucun appel inutile', async () => {
    process.env.T3_NAMING_MAX_DOCUMENTS_PER_CALL = '6';
    process.env.T3_NAMING_MAX_CALLS_PER_PASS = '1';
    const fabriquer = async () => {
      const c = await make.account();
      const docs: Array<{ id: number; extractionId: number }> = [];
      for (let i = 0; i < 10; i++) docs.push(await document(c, { nom: `orange ${MOIS[i]} 2008`, date: `2008-${String(i + 1).padStart(2, '0')}-05` }));
      return { c, docs };
    };
    // Sans changement : 2 appels, chaque document examiné une seule fois.
    const t = await fabriquer();
    await passer(t.c.id);
    await passer(t.c.id);
    const r0 = await passer(t.c.id);
    expect(modele.appels).toHaveLength(2);
    expect(modele.appels.flatMap(cibles).sort((x, y) => x - y)).toEqual(t.docs.map((d) => d.id).sort((x, y) => x - y));
    expect(r0.documentNaming?.status).toBe('DONE');
    modele.appels.length = 0;
    // Avec une nouvelle information sur un document DÉJÀ examiné, reçue pendant l'interruption.
    const m = await fabriquer();
    await passer(m.c.id);
    const premiers = cibles(modele.appels[0]);
    const vise = m.docs.find((d) => premiers.includes(d.id))!;
    await fait(m.c, vise, 'contractNumber', 'CT-2008-445566');
    for (let i = 0; i < 4 && (await etat(m.c.id, 's:orange'))?.status !== 'DONE'; i++) await passer(m.c.id);
    expect(await etat(m.c.id, 's:orange')).toMatchObject({ status: 'DONE' });
    const revu = modele.appels.slice(1).find((a) => a.docs.some((d) => d.documentId === vise.id && d.role === 'TO_EXAMINE'));
    expect(revu).toBeDefined();
    expect(revu!.docs.find((d) => d.documentId === vise.id)!.facts.map((f) => f.value)).toContain('CT-2008-445566');
    // Les autres documents déjà examinés et inchangés gardent leur progression.
    const reexamines = modele.appels.slice(1).flatMap(cibles);
    expect(premiers.filter((id) => id !== vise.id && reexamines.includes(id))).toEqual([]);
    const { lignes } = await rapport(m.c.id);
    void lignes;
  }, 120_000);

  it('L76B-C4-01 — compte SANS bien terminé : modification d’un fait existant, d’un contrat, d’une Opération, d’une relation → réactivation automatique et réexamen ; sans changement : rien', async () => {
    const c = await make.account();
    const a = await document(c, { nom: 'Facture Orange — janvier 2007', date: '2007-01-10' });
    const b = await document(c, { nom: 'Facture Orange — février 2007', date: '2007-02-10' });
    const f = await fait(c, a, 'contractNumber', 'CT-2007-000111');
    await passer(c.id);
    expect(modele.appels).toHaveLength(1);
    expect(await etat(c.id, '*')).toMatchObject({ status: 'DONE' });
    // Horodatages de suivi (hors empreinte) des données préparées avant le passage, ramenés avant sa fin.
    const vieillir = async () => {
      await sql`UPDATE asset_files SET updated_at = now() - interval '10 minutes' WHERE account_id = ${c.id}`;
      await sql`UPDATE document_facts SET created_at = now() - interval '10 minutes' WHERE account_id = ${c.id}`;
      await sql`UPDATE account_knowledge_changes SET changed_at = now() - interval '10 minutes' WHERE account_id = ${c.id}`;
      await sql`UPDATE business_operations SET updated_at = now() - interval '10 minutes', created_at = now() - interval '10 minutes' WHERE account_id = ${c.id}`;
      await sql`UPDATE business_operation_history SET created_at = now() - interval '10 minutes' WHERE account_id = ${c.id}`;
      await sql`UPDATE business_operation_sources SET created_at = now() - interval '10 minutes',
                  superseded_at = CASE WHEN superseded_at IS NULL THEN NULL ELSE now() - interval '10 minutes' END WHERE account_id = ${c.id}`;
      await sql`UPDATE business_operation_contract_details SET updated_at = now() - interval '10 minutes'
                 WHERE operation_id IN (SELECT id FROM business_operations WHERE account_id = ${c.id})`;
    };
    const reactive = async (quoi: string, mutation: () => Promise<unknown>) => {
      await vieillir();
      expect(await dansBalayage(c.id)).toBe(false);
      await mutation();
      expect(await dansBalayage(c.id), quoi).toBe(true);
      const n = modele.appels.length;
      const run = await passer(c.id);
      expect(modele.appels.length, quoi).toBe(n + 1);
      expect(run.documentNaming?.status).toBe('DONE');
      expect(await dansBalayage(c.id)).toBe(false);
    };
    // 1. Modification d'un fait EXISTANT (valeur).
    await reactive('fait modifié', () => sql`UPDATE document_facts SET value_text = 'CT-2007-000222' WHERE id = ${f}`);
    expect(modele.appels.at(-1)!.docs.find((d) => d.documentId === a.id)!.facts.map((x) => x.value)).toContain('CT-2007-000222');
    // 2. Désactivation d'un fait.
    await reactive('fait désactivé', () => sql`UPDATE document_facts SET status = 'superseded' WHERE id = ${f}`);
    // 3. Opération (contrat) reliée au document.
    const [op] = await sql<Array<{ id: number }>>`
      INSERT INTO business_operations (account_id, type_code, status) VALUES (${c.id}, 'CONTRACT', 'REALIZED') RETURNING id`;
    await reactive('opération créée', async () => {
      await sql`INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, source_role, authority)
                VALUES (${c.id}, ${op.id}, 'DOCUMENT', ${String(b.id)}, 'CONTRACT_DOCUMENT', 'DOCUMENT')`;
      await sql`INSERT INTO business_operation_contract_details (operation_id, contract_reference) VALUES (${op.id}, 'GZ-2007-998877')`;
    });
    // 4. Modification du contrat.
    await reactive('contrat modifié', () => sql`UPDATE business_operation_contract_details SET contract_reference = 'GZ-2007-998878', updated_at = now() WHERE operation_id = ${op.id}`);
    // 5. Statut de l'Opération.
    await reactive('statut d’opération', () => sql`UPDATE business_operations SET status = 'CANCELLED', updated_at = now() WHERE id = ${op.id}`);
    expect(JSON.stringify(modele.appels.at(-1)!.docs.find((d) => d.documentId === b.id)!.operations)).toContain('CANCELLED');
    // 6. Relation retirée (source désactivée).
    await reactive('relation retirée', () => sql`UPDATE business_operation_sources SET active = false, superseded_at = now() WHERE operation_id = ${op.id}`);
    // Sans changement : jamais réinscrit, aucun appel.
    await vieillir();
    expect(await dansBalayage(c.id)).toBe(false);
    const n = modele.appels.length;
    await passer(c.id);
    expect(modele.appels.length).toBe(n);
    // T1 jamais relancé.
    expect((await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM ai_job_queue WHERE account_id = ${c.id} AND treatment = 'T1'`)[0].n).toBe(0);
  }, 180_000);

  it('L76B-C4-02 — même contexte métier relu (espaces, casse des titres de contexte) : empreinte stable, aucun appel ; titre de contexte réellement changé : réexamen', async () => {
    const c = await make.account();
    const a = await document(c, { nom: 'Facture Orange — janvier 2006', date: '2006-01-10' });
    await document(c, { nom: 'Facture Orange — février 2006', date: '2006-02-10' });
    await passer(c.id);
    expect(modele.appels).toHaveLength(1);
    await sql`UPDATE asset_files SET retained_title = '  Facture Orange —  janvier 2006 ' WHERE id = ${a.id}`;
    await sql`UPDATE document_extractions SET title = upper(title) WHERE file_id = ${a.id}`;
    await passer(c.id);
    expect(modele.appels).toHaveLength(1);
    await sql`UPDATE document_extractions SET title = 'Avoir Orange janvier 2006', updated_at = updated_at WHERE file_id = ${a.id}`;
    await passer(c.id);
    expect(modele.appels).toHaveLength(2);
  }, 120_000);

  it('L76B-C5-01 — lots du lot 61 (v1) : sans information nouvelle → migration technique ; avec information nouvellement exploitable → réexamen BORNÉ (1 par passage), reprenable, conventions redonnées ; reporting distinct', async () => {
    const c = await make.account();
    const repo = await import('@/services/ai/reconciliation/document-naming/repository');
    const ctx = await import('@/services/ai/reconciliation/document-naming/context');
    const historique = async (fournisseur: string, n: number, texte?: string) => {
      const docs: Array<{ id: number; extractionId: number }> = [];
      for (let i = 0; i < n; i++) docs.push(await document(c, { nom: `Facture ${fournisseur} — ${MOIS[i]} 2005`, fournisseur, date: `2005-${String(i + 1).padStart(2, '0')}-10`, texte }));
      return docs;
    };
    const simple = await historique('Veolia', 2);
    const riche = await historique('Engie', 2);
    for (let i = 0; i < 12; i++) await fait(c, riche[0], `ligne_${i}`, `valeur ${i}`, { canonical: null });
    const long = await historique('Suez', 2, `Facture Suez. ${'Conditions générales. '.repeat(40)}Référence client RC-55005500.`);
    const v1 = async (key: string, docs: Array<{ id: number }>) => {
      const lus = await repo.loadNamingDocsByIds(c.id, docs.map((d) => d.id));
      await sql`INSERT INTO document_naming_groups (account_id, group_key, status, fingerprint, document_count, conventions, last_reviewed_at)
                VALUES (${c.id}, ${key}, 'DONE', ${ctx.legacyGroupFingerprint(lus)}, ${docs.length},
                        ${JSON.stringify([{ label: `Factures ${key}`, convention: `Facture ${key} — <mois> <année>` }])}::jsonb, now())`;
    };
    await v1('s:veolia', simple);
    await v1('s:engie', riche);
    await v1('s:suez', long);
    await sql`INSERT INTO document_naming_groups (account_id, group_key, status, document_count) VALUES (${c.id}, '*', 'DONE', 6)`;
    // Passage 1 (déploiement) : aucune réanalyse massive — au plus UNE famille réexaminée.
    const p1 = await passer(c.id);
    expect(modele.appels).toHaveLength(1);
    expect(p1.documentNaming?.upgrade).toMatchObject({ technical: 1, expected: 2, reviewed: 1 });
    expect(p1.documentNaming?.status).not.toBe('DONE');
    expect(p1.documentNaming?.remaining.byReason).toMatchObject({ UPGRADE_PASS_CAP: 1 });
    expect(await etat(c.id, 's:veolia')).toMatchObject({ status: 'DONE', upgrade_state: 'TECHNICAL', context_version: 'naming-v3' });
    const enAttenteDeRevue = ['s:engie', 's:suez'].find((k) => !modele.appels[0].lot.comparisonSet.key.startsWith(k))!;
    expect(await etat(c.id, enAttenteDeRevue)).toMatchObject({ status: 'UPGRADE_REVIEW', upgrade_state: 'EXPECTED' });
    expect(modele.appels[0].lot.previousConventions).toHaveLength(1);
    const { r } = await rapport(c.id);
    expect(r.counters).toMatchObject({ upgradeTechnicalTotal: 1, upgradeExpectedTotal: 1, upgradeReviewedTotal: 1 });
    expect(r.sources).toMatchObject({ upgrade: { totals: { technical: 1, expected: 1, reviewed: 1 } } });
    expect(await dansBalayage(c.id)).toBe(true);
    // Passage 2 : la seconde famille ; passage 3 : plus rien.
    const p2 = await passer(c.id);
    expect(modele.appels).toHaveLength(2);
    expect(p2.documentNaming?.status).toBe('DONE');
    expect(p2.documentNaming?.upgrade?.totals).toEqual({ technical: 1, expected: 0, reviewed: 2 });
    await passer(c.id);
    expect(modele.appels).toHaveLength(2);
    // Noms existants conservés (aucune proposition) ; jamais renommés par le recalage lui-même.
    for (const d of [...simple, ...riche, ...long]) expect(await nom(d.id)).toMatch(/^Facture /);
  }, 120_000);

  it('L76B-C5-02 — plafond GLOBAL du programme de réexamen (24 h, tous comptes) : aucun appel, reprise datée, motif distinct', async () => {
    process.env.T3_NAMING_UPGRADE_REVIEWS_PER_DAY = '0';
    const c = await make.account();
    const repo = await import('@/services/ai/reconciliation/document-naming/repository');
    const ctx = await import('@/services/ai/reconciliation/document-naming/context');
    const docs: Array<{ id: number; extractionId: number }> = [];
    for (let i = 0; i < 2; i++) docs.push(await document(c, { nom: `Facture Saur ${MOIS[i]} 2004`, fournisseur: 'Saur', date: `2004-0${i + 1}-10`, texte: `x ${'texte long. '.repeat(60)}` }));
    const lus = await repo.loadNamingDocsByIds(c.id, docs.map((d) => d.id));
    await sql`INSERT INTO document_naming_groups (account_id, group_key, status, fingerprint, document_count, last_reviewed_at)
              VALUES (${c.id}, 's:saur', 'DONE', ${ctx.legacyGroupFingerprint(lus)}, 2, now())`;
    const run = await passer(c.id);
    expect(modele.appels).toHaveLength(0);
    expect(run.documentNaming?.remaining.byReason).toMatchObject({ UPGRADE_DAILY_CAP: 1 });
    expect((await etat(c.id, 's:saur')).retry_after).not.toBeNull();
    expect(run.documentNaming?.status).not.toBe('DONE');
  }, 120_000);

  it('L76B-C6-01 — référence commune présente seulement dans le texte : documents présentés ensemble (indice avec provenance) ; référence générique : aucun regroupement', async () => {
    const c = await make.account();
    const a = await document(c, { nom: 'Courrier cabinet', fournisseur: 'Cabinet Martin', type: 'LETTER', date: '2024-05-02', texte: 'Votre dossier n° DOS-2024-55667 est en cours de traitement.' });
    const b = await document(c, { nom: 'Relance', fournisseur: null, type: 'NOTICE', date: '2024-06-02', texte: 'Relance concernant le dossier DOS-2024-55667.' });
    const g1 = await document(c, { nom: 'Doc A', fournisseur: 'Alpha', type: 'INVOICE', texte: 'Référence partagée REF-777888 (générique).' });
    const g2 = await document(c, { nom: 'Doc B', fournisseur: 'Beta', type: 'INVOICE', texte: 'Référence partagée REF-777888 (générique).' });
    const g3 = await document(c, { nom: 'Doc C', fournisseur: 'Gamma', type: 'INVOICE', texte: 'Référence partagée REF-777888 (générique).' });
    await passer(c.id);
    const ensemble = modele.appels.find((x) => x.docs.some((d) => d.documentId === a.id));
    expect(ensemble).toBeDefined();
    expect(ensemble!.docs.map((d) => d.documentId).sort((x, y) => x - y)).toEqual([a.id, b.id].sort((x, y) => x - y));
    expect(ensemble!.docs.find((d) => d.documentId === b.id)!.matchHints).toEqual([{ reference: 'DOS202455667', source: 'EXTRACTION_FULL_TEXT', sharedWithDocumentIds: [a.id] }]);
    // Référence générique (trois émetteurs) : chacun seul, aucun appel les réunissant.
    expect(modele.appels.some((x) => x.docs.filter((d) => [g1.id, g2.id, g3.id].includes(d.documentId)).length > 1)).toBe(false);
    // L'IA reste seule juge : aucune proposition → rien renommé ; stable.
    await passer(c.id);
    expect(modele.appels).toHaveLength(1);
  }, 120_000);

  it('L76B-C6-02 — information après 60 000 et après 100 000 caractères, et au-delà de 240 caractères dans un fait : transmise ET acceptée par les garde-fous', async () => {
    const c = await make.account();
    const remplissage = (n: number) => 'Conditions générales de vente. '.repeat(Math.ceil(n / 31)).slice(0, n);
    const texte = `Contrat assurance habitation. ${remplissage(70_000)} Contrat n° CT-7070-7070. ${remplissage(60_000)} Police PL-130130. ${remplissage(5_000)}`;
    const a = await document(c, { nom: 'Contrat assurance', fournisseur: 'Assureur Nord', type: 'CONTRACT', date: '2024-01-01', texte });
    const b = await document(c, { nom: 'Avenant assurance 2024', fournisseur: 'Assureur Nord', type: 'CONTRACT', date: '2024-06-01' });
    await fait(c, a, 'description', `${'Garanties multirisques habitation, responsabilité civile et protection juridique. '.repeat(5)}Site assuré SITE-998877.`, { canonical: null });
    const cible = 'Contrat assurance CT-7070-7070 police PL-130130 site SITE-998877';
    modele.decider = proposer({ [a.id]: cible });
    await passer(c.id);
    const vu = modele.appels[0].docs.find((d) => d.documentId === a.id)!;
    expect(vu.passages?.some((p) => p.text.includes('CT-7070-7070') && p.offset > 60_000)).toBe(true);
    expect(vu.passages?.some((p) => p.text.includes('PL-130130') && p.offset > 100_000)).toBe(true);
    expect(vu.facts.find((f) => f.value.includes('SITE-998877'))).toBeDefined();
    expect(await nom(a.id)).toBe(cible);
    expect((await evenements(c.id)).filter((e) => e.file_id === a.id).map((e) => e.outcome)).toEqual(['APPLIED']);
    void b;
  }, 120_000);
});
