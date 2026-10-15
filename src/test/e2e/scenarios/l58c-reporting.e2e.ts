/**
 * Lot 58C sur base réelle (PG16) — ticket « [P1] BO — Reporting exhaustif des
 * exécutions T1 et T3 : données BDD, champs alimentés et traçabilité ».
 *
 * Point d'entrée de production (`analyzeFileSources`), passerelle RÉELLE,
 * sorties modèle rejouées (aucun appel réseau), files T3 vidées par
 * l'exécutant de production. Chaque assertion compare le RAPPORT aux
 * enregistrements RÉELS (identifiants, valeurs, journal des écritures).
 */
import { afterEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState, type FaitT1 } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Entry = {
  seq: number; section: string; table_name: string | null; record_id: string | null; column_path: string | null; field_key: string | null;
  value: unknown; old_value: unknown; write_result: string; reason_code: string | null; reason: string | null; value_sha256: string | null;
  entity_type: string | null; entity_id: number | null; links: Record<string, unknown> | null;
};
type Rapport = {
  id: number; treatment: string; status: string; file_id: number | null; asset_id: number | null; origin_t1_report_id: number | null;
  analysis_run_id: number | null; extraction_id: number | null; reconciliation_run_id: number | null; report_complete: boolean;
  report_error: string | null; counters: Record<string, number>; steps: Array<{ step: string; status: string; error?: string | null }>;
  entry_count: number; trace_ids: string[]; job_id: number | null; sources: Record<string, unknown>;
};

scenario('L58C', 'Reporting exhaustif T1 / T3 : écritures confirmées, non-persistances motivées, corrélation, export, isolation', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();
  afterEach(async () => {
    const { simulateReportWriteFailure } = await import('@/services/ai/execution-report/repository');
    simulateReportWriteFailure(false);
    await sql.unsafe('DROP TRIGGER IF EXISTS e2e_l58c_facts ON document_facts');
    await sql.unsafe('DROP TRIGGER IF EXISTS e2e_l58c_assets ON assets');
  });

  const fait = (canonicalKey: string | null, value: string, assetId: number | null, excerpt: string, rawKey?: string): FaitT1 =>
    ({ canonicalKey, rawKey, value, valueType: 'string', excerpt, assetId });
  const assurance = (bien: { id: number; label: string } | null, facts: FaitT1[], texte: string[] = []) => {
    const out = sortieT1({
      title: 'Contrat d’assurance habitation', date: '2026-09-01', documentTypeCode: 'INSURANCE_POLICY', rubricCode: 'INSURANCE_CLAIMS',
      assets: bien ? [bien] : [], facts, texte, multiAsset: false,
    });
    (out as { tables: unknown[] }).tables = [{
      title: 'Garanties', pageStart: 1, columns: [{ header: 'Garantie' }, { header: 'Plafond' }],
      rows: [{ cells: [{ column: 0, value: 'Incendie' }, { column: 1, value: '300 000 €' }] }, { cells: [{ column: 0, value: 'Dégâts des eaux' }, { column: 1, value: '50 000 €' }] }],
    }];
    return out;
  };
  const analyser = async (compte: Compte, fileId: number, output: Record<string, unknown>, opts: { drain?: boolean } = {}) => {
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = coalesce(original_filename, ${`doc-${fileId}.pdf`}),
                analysis_state = NULL WHERE id = ${fileId}`;
    await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output }]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l58c' });
    if (!r) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    if (opts.drain !== false) await drainQueues();
    return r;
  };
  const rapports = (where: { fileId?: number; assetId?: number; treatment: 'T1' | 'T3' }) => sql<Rapport[]>`
    SELECT * FROM ai_execution_reports
     WHERE treatment = ${where.treatment}
       AND (${where.fileId ?? null}::int IS NULL OR file_id = ${where.fileId ?? null})
       AND (${where.assetId ?? null}::int IS NULL OR asset_id = ${where.assetId ?? null})
     ORDER BY id`;
  const lignes = (reportId: number) => sql<Entry[]>`SELECT * FROM ai_execution_report_entries WHERE report_id = ${reportId} ORDER BY seq`;
  const bienAssure = async (compte: Compte) => {
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison de Rennes' });
    const f = await make.assetFile(compte, { assetId: bien.id });
    return { bien, f };
  };

  it('REP-01 — document d’assurance : extraction, faits canoniques et génériques, tableaux, preuves et champ T3 relus à l’identique en base ; information absente de la fiche expliquée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { bien, f } = await bienAssure(compte);
    await analyser(compte, f.id, assurance({ id: bien.id, label: 'Maison de Rennes' }, [
      fait('insurer', 'Allianz', bien.id, 'Assureur : Allianz'),
      // Cas du ticket : information d'assurance lue SANS clé canonique → jamais sur la fiche.
      fait(null, 'POL-778', null, 'Police n° POL-778', 'numero_police'),
      fait(null, '150 €', null, 'Franchise : 150 €', 'franchise'),
    ]));

    const [t1] = await rapports({ fileId: f.id, treatment: 'T1' });
    expect(t1).toBeDefined();
    expect(t1.steps.find((s) => s.step === 'KNOWLEDGE')).toMatchObject({ status: 'OK' });
    expect(t1.report_complete).toBe(true);
    const e1 = await lignes(t1.id);
    expect(e1).toHaveLength(t1.entry_count);

    // C. Persistance réelle : chaque fait actif est rapporté avec SON identifiant et SA valeur.
    const facts = await sql<{ id: string; fact_key: string; canonical_key: string | null; value_text: string | null }[]>`
      SELECT id::text, fact_key, canonical_key, value_text FROM document_facts WHERE file_id = ${f.id} AND status = 'active' ORDER BY id`;
    const rFacts = e1.filter((e) => e.section === 'FACT');
    expect(rFacts.map((e) => e.record_id).sort()).toEqual(facts.map((x) => x.id).sort());
    expect(rFacts.every((e) => e.write_result === 'WRITTEN' && e.table_name === 'document_facts')).toBe(true);
    const assureur = rFacts.find((e) => e.field_key === 'insurer')!;
    expect(assureur.value).toMatchObject({ valueText: 'Allianz' });
    expect(assureur.reason_code).toBe('CANONICAL');
    // B. Faits génériques : conservés, sans champ.
    expect(rFacts.find((e) => e.reason_code === 'GENERIC' && e.field_key === 'franchise')?.value).toMatchObject({ valueText: '150 €' });
    expect(t1.counters.factsPersisted).toBe(facts.length);
    expect(t1.counters.factsNotPersisted ?? 0).toBe(0);

    // A. Extraction brute : texte intégral à son emplacement exact.
    const texte = e1.find((e) => e.section === 'EXTRACTION' && e.column_path === 'full_text')!;
    const [ext] = await sql<{ id: number; full_text: string }[]>`SELECT id, full_text FROM document_extractions WHERE file_id = ${f.id}`;
    expect(texte.record_id).toBe(String(ext.id));
    expect(texte.value).toBe(ext.full_text);
    expect(t1.extraction_id).toBe(ext.id);

    // Tableaux et cellules.
    expect(e1.filter((e) => e.section === 'TABLE')).toHaveLength(1);
    const cells = e1.filter((e) => e.section === 'CELL');
    expect(cells.map((c) => c.value)).toEqual(expect.arrayContaining(['Incendie', '300 000 €', 'Dégâts des eaux', '50 000 €']));

    // Projection : preuve écrite pour l'assureur, motif pour le numéro de police sans cible.
    const preuve = e1.find((e) => e.section === 'EVIDENCE' && e.field_key === 'insurer')!;
    const [fe] = await sql<{ id: number }[]>`SELECT id FROM field_evidence WHERE source_id = ${f.id} AND field_key = 'insurer' AND lifecycle_status = 'ACTIVE'`;
    expect(preuve).toMatchObject({ record_id: String(fe.id), write_result: 'WRITTEN', entity_id: bien.id });
    const police = e1.find((e) => e.section === 'PROJECTION' && e.field_key === 'numero_police')!;
    expect(police).toMatchObject({ write_result: 'NOT_WRITTEN', reason_code: 'GENERIC_KNOWLEDGE', value: 'POL-778' });

    // T3 : champ alimenté, écriture confirmée par le journal transactionnel.
    const t3 = (await rapports({ assetId: bien.id, treatment: 'T3' })).at(-1)!;
    expect(Number(t3.origin_t1_report_id)).toBe(Number(t1.id));
    const e3 = await lignes(t3.id);
    const champ = e3.find((e) => e.section === 'FIELD' && e.field_key === 'insurer')!;
    const [cw] = await sql<{ id: string; new_value: unknown }[]>`
      SELECT id::text, new_value FROM canonical_field_writes WHERE asset_id = ${bien.id} AND canonical_key = 'insurer' AND outcome = 'written' ORDER BY id DESC LIMIT 1`;
    expect(champ).toMatchObject({ write_result: 'WRITTEN', record_id: cw.id, value: cw.new_value, table_name: 'canonical_field_writes' });
    expect(champ.column_path).toContain('assets.key_characteristics.insurer');
    expect(champ.links).toMatchObject({ decision: 'apply', evidence: { id: fe.id, sourceFileId: f.id }, t1ReportId: Number(t1.id) });
    const [kc] = await sql<{ v: string }[]>`SELECT (key_characteristics::jsonb)->>'insurer' AS v FROM assets WHERE id = ${bien.id}`;
    expect(kc.v).toBe('Allianz');
    // Information présente dans le document, absente de la fiche : cause identifiée (projection T1, pas de cible).
    const absente = e3.find((e) => e.section === 'NOT_EXAMINED' && e.field_key === 'numero_police')!;
    expect(absente).toMatchObject({ write_result: 'NOT_EXAMINED', reason_code: 'GENERIC_KNOWLEDGE', value: 'POL-778', table_name: 'document_facts' });
    expect(absente.links).toMatchObject({ sourceFileId: f.id, t1ReportId: Number(t1.id) });
    expect(absente.reason).toContain('sans clé canonique');
    // Compteurs = écritures confirmées.
    const [run] = await sql<{ applied_count: number }[]>`SELECT applied_count FROM reconciliation_runs WHERE id = ${t3.reconciliation_run_id}`;
    expect(run.applied_count).toBe(t3.counters.written);
    expect(t3.counters.written).toBe(e3.filter((e) => e.section === 'FIELD' && e.write_result === 'WRITTEN').length);
    // Sources de connaissance consultées / non consultées.
    expect(t3.sources).toMatchObject({ fieldEvidence: { consulted: true }, genericFacts: { consulted: false, available: 2 } });
  });

  it('REP-02 — faits génériques sans champ (document sans bien) : tous enregistrés, motif de non-projection explicite', async () => {
    const compte = await make.account();
    const f = await make.assetFile(compte, { assetId: null });
    await analyser(compte, f.id, assurance(null, [
      fait(null, 'Garage fermé', null, 'Stationnement : Garage fermé', 'stationnement'),
      fait(null, '2 ans', null, 'Ancienneté du permis : 2 ans', 'anciennete_permis'),
    ]));
    const [t1] = await rapports({ fileId: f.id, treatment: 'T1' });
    const e = await lignes(t1.id);
    expect(e.filter((x) => x.section === 'FACT' && x.reason_code === 'GENERIC' && x.write_result === 'WRITTEN')).toHaveLength(2);
    const proj = e.filter((x) => x.section === 'PROJECTION');
    expect(proj.length).toBeGreaterThanOrEqual(2);
    expect(proj.every((x) => x.reason_code === 'GENERIC_KNOWLEDGE' && x.write_result === 'NOT_WRITTEN')).toBe(true);
  });

  it('REP-03 — erreurs d’écriture simulées : affichées en échec, jamais en réussite ; échec du rapport visible sans annuler l’écriture métier', async () => {
    const compte = await make.account({ plan: 'premium' });
    // (a) T1 : la transaction de la base de connaissance échoue.
    const { bien, f } = await bienAssure(compte);
    await sql.unsafe(`CREATE OR REPLACE FUNCTION e2e_l58c_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'e2e : écriture refusée (%)', TG_TABLE_NAME; END $$`);
    await sql.unsafe(`CREATE TRIGGER e2e_l58c_facts BEFORE INSERT ON document_facts FOR EACH ROW WHEN (NEW.file_id = ${f.id}) EXECUTE FUNCTION e2e_l58c_fail()`);
    await analyser(compte, f.id, assurance({ id: bien.id, label: 'Maison de Rennes' }, [fait('insurer', 'Allianz', bien.id, 'Assureur : Allianz')]), { drain: false });
    const [t1] = await rapports({ fileId: f.id, treatment: 'T1' });
    expect(t1.status).toBe('PARTIAL');
    expect(t1.steps.find((s) => s.step === 'KNOWLEDGE')).toMatchObject({ status: 'FAILED' });
    const e = await lignes(t1.id);
    expect(e.filter((x) => x.section === 'FACT')).toHaveLength(0);
    const nonEcrit = e.find((x) => x.section === 'DECLARED' && x.field_key === 'insurer')!;
    expect(nonEcrit).toMatchObject({ write_result: 'NOT_PERSISTED', reason_code: 'KNOWLEDGE_TRANSACTION_FAILED' });
    expect(nonEcrit.reason).toContain('écriture refusée');
    expect(await sql`SELECT 1 FROM document_facts WHERE file_id = ${f.id}`).toHaveLength(0);
    await sql.unsafe('DROP TRIGGER IF EXISTS e2e_l58c_facts ON document_facts');

    // (b) T3 : l'écriture de la fiche échoue — champ FAILED, rapport FAILED, fiche intacte.
    await sql.unsafe(`CREATE TRIGGER e2e_l58c_assets BEFORE UPDATE ON assets FOR EACH ROW WHEN (NEW.id = ${bien.id}) EXECUTE FUNCTION e2e_l58c_fail()`);
    const { reconcileAsset } = await import('@/services/ai/reconciliation/reconciliation-engine');
    // La preuve « Allianz » projetée par T1 (a) est active : T3 décide d'écrire, l'écriture échoue.
    await expect(reconcileAsset({ accountId: compte.id, assetId: bien.id, triggeredBy: 'manual' })).rejects.toThrow(/écriture refusée/);
    await sql.unsafe('DROP TRIGGER IF EXISTS e2e_l58c_assets ON assets');
    const t3 = (await rapports({ assetId: bien.id, treatment: 'T3' })).at(-1)!;
    expect(t3.status).toBe('FAILED');
    const champ = (await lignes(t3.id)).find((x) => x.section === 'FIELD' && x.field_key === 'insurer')!;
    expect(champ.write_result).toBe('FAILED');
    expect(champ.reason).toContain('écriture refusée');
    expect((await lignes(t3.id)).some((x) => x.write_result === 'WRITTEN')).toBe(false);
    expect(t3.counters.written).toBe(0);

    // (c) Rapport en échec : écriture métier acquise, rapport réduit VISIBLE.
    const { simulateReportWriteFailure } = await import('@/services/ai/execution-report/repository');
    const f2 = await make.assetFile(compte, { assetId: bien.id });
    simulateReportWriteFailure(true);
    await analyser(compte, f2.id, assurance({ id: bien.id, label: 'Maison de Rennes' }, [fait(null, '150 €', null, 'Franchise : 150 €', 'franchise')]), { drain: false });
    const [r2] = await rapports({ fileId: f2.id, treatment: 'T1' });
    expect(r2).toMatchObject({ report_complete: false, entry_count: 0 });
    expect(r2.report_error).toContain('simulée');
    expect(await sql`SELECT 1 FROM document_facts WHERE file_id = ${f2.id} AND status = 'active'`).toHaveLength(1);
  });

  it('REP-04 — réanalyse : l’ancien rapport reste intact ; contenu long remplacé → « non tracé », jamais reconstitué', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { bien, f } = await bienAssure(compte);
    const long = (m: string) => Array.from({ length: 60 }, (_, i) => `${m} ligne ${i} des conditions générales du contrat d’assurance`);
    await analyser(compte, f.id, assurance({ id: bien.id, label: 'Maison de Rennes' }, [fait('insurer', 'Allianz', bien.id, 'Assureur : Allianz')], long('Version A')));
    await analyser(compte, f.id, assurance({ id: bien.id, label: 'Maison de Rennes' }, [fait('insurer', 'AXA', bien.id, 'Assureur : AXA')], long('Version B')));
    const [ancien, nouveau] = await rapports({ fileId: f.id, treatment: 'T1' });
    expect(Number(nouveau.id)).toBeGreaterThan(Number(ancien.id));
    const avant = await lignes(ancien.id);
    expect(avant).toHaveLength(ancien.entry_count);
    expect(avant.find((e) => e.section === 'FACT' && e.field_key === 'insurer')?.value).toMatchObject({ valueText: 'Allianz' });
    expect((await lignes(nouveau.id)).find((e) => e.section === 'FACT' && e.field_key === 'insurer')?.value).toMatchObject({ valueText: 'AXA' });
    const { resolveRef, correlatedReports, getExecutionReport } = await import('@/services/ai/execution-report/repository');
    const txt = (rows: Entry[]) => rows.find((e) => e.section === 'EXTRACTION' && e.column_path === 'full_text')!;
    const ref = (e: Entry) => ({ tableName: e.table_name, recordId: e.record_id, columnPath: e.column_path, ref: { sha256: e.value_sha256!, chars: 0 } });
    expect(txt(avant).value_sha256).not.toBeNull();
    expect(await resolveRef(compte.id, ref(txt(avant)))).toMatchObject({ state: 'NOT_TRACED' });
    const r = await resolveRef(compte.id, ref(txt(await lignes(nouveau.id))));
    expect(r.state).toBe('TRACED');
    expect(String((r as { content: unknown }).content)).toContain('Version B');
    const corr = await correlatedReports((await getExecutionReport(nouveau.id))!);
    expect(corr.previousForSameDocument.map((x) => x.id)).toContain(Number(ancien.id));
  });

  it('REP-05 — corrélation T1 → T3 et rattachement au détail d’exécution (même trace / job, même compte)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { bien, f } = await bienAssure(compte);
    await analyser(compte, f.id, assurance({ id: bien.id, label: 'Maison de Rennes' }, [fait('insurer', 'Generali', bien.id, 'Assureur : Generali')]));
    const [t1] = await rapports({ fileId: f.id, treatment: 'T1' });
    const { correlatedReports, getExecutionReport, reportsForExecution } = await import('@/services/ai/execution-report/repository');
    const corr = await correlatedReports((await getExecutionReport(t1.id))!);
    expect(corr.followups.some((x) => x.treatment === 'T3' && x.assetId === bien.id)).toBe(true);
    expect(t1.trace_ids.length).toBeGreaterThan(0);
    // Appel modèle de l'exécution (BO › Exécutions IA) : même trace.
    const [ev] = await sql<{ account_id: number; job_id: number | null; trace_id: string }[]>`
      SELECT account_id, job_id, metadata->>'traceId' AS trace_id FROM ai_usage_event WHERE metadata->>'traceId' = ANY(${t1.trace_ids}) ORDER BY id LIMIT 1`;
    expect(ev?.trace_id).toBeTruthy();
    expect(Number(ev.account_id)).toBe(compte.id);
    const lies = await reportsForExecution({ accountId: ev.account_id, jobId: ev.job_id, traceId: ev.trace_id, fileId: f.id });
    expect(lies.map((x) => x.id)).toContain(Number(t1.id));
  });

  it('REP-06 — export JSON exhaustif : toutes les lignes, sans troncature, contenus référencés relus', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { bien, f } = await bienAssure(compte);
    const beaucoup = Array.from({ length: 40 }, (_, i) => fait(null, `valeur ${i}`, null, `Clause ${i} : valeur ${i}`, `clause_${i}`));
    await analyser(compte, f.id, assurance({ id: bien.id, label: 'Maison de Rennes' }, beaucoup, Array.from({ length: 80 }, (_, i) => `Article ${i} des conditions générales applicables au contrat`)));
    const [t1] = await rapports({ fileId: f.id, treatment: 'T1' });
    expect(t1.entry_count).toBeGreaterThan(100);
    const { exportReportChunks, getExecutionReport } = await import('@/services/ai/execution-report/repository');
    let json = '';
    for await (const c of exportReportChunks((await getExecutionReport(t1.id))!, new Date())) json += c;
    const doc = JSON.parse(json) as { entries: Array<{ seq: number; content?: { state: string } }>; entriesExported: number; entriesExpected: number; complete: boolean; report: { id: number } };
    expect(doc.report.id).toBe(Number(t1.id));
    expect(doc.entries).toHaveLength(t1.entry_count);
    expect(doc).toMatchObject({ entriesExported: t1.entry_count, entriesExpected: t1.entry_count, complete: true });
    expect(doc.entries.map((e) => e.seq)).toEqual(Array.from({ length: t1.entry_count }, (_, i) => i + 1));
    expect(doc.entries.some((e) => e.content?.state === 'TRACED')).toBe(true);
  });

  it('REP-07 — isolation des comptes et accès : aucune donnée d’un autre compte, routes réservées aux administrateurs, consultation journalisée', async () => {
    const a = await make.account({ plan: 'premium' });
    const b = await make.account({ plan: 'premium' });
    const { bien, f } = await bienAssure(a);
    await analyser(a, f.id, assurance({ id: bien.id, label: 'Maison de Rennes' }, [fait('insurer', 'Allianz', bien.id, 'Assureur : Allianz')], Array.from({ length: 80 }, (_, i) => `Article ${i} des conditions générales applicables au contrat`)));
    const [t1] = await rapports({ fileId: f.id, treatment: 'T1' });
    const { reportsForExecution, resolveRef, listExecutionReports } = await import('@/services/ai/execution-report/repository');
    expect(await reportsForExecution({ accountId: b.id, jobId: t1.job_id, traceId: t1.trace_ids[0], fileId: f.id })).toEqual([]);
    expect((await listExecutionReports({ accountId: b.id })).rows).toEqual([]);
    const txt = (await lignes(t1.id)).find((e) => e.section === 'EXTRACTION' && e.column_path === 'full_text')!;
    const ref = { tableName: txt.table_name, recordId: txt.record_id, columnPath: txt.column_path, ref: { sha256: txt.value_sha256!, chars: 0 } };
    expect(await resolveRef(b.id, ref)).toMatchObject({ state: 'NOT_TRACED' });
    expect(await resolveRef(a.id, ref)).toMatchObject({ state: 'TRACED' });
    // Lignes portées par le compte du rapport uniquement.
    expect(await sql`SELECT 1 FROM ai_execution_report_entries WHERE report_id = ${t1.id} AND account_id <> ${a.id}`).toHaveLength(0);
    // Routes : sans session administrateur → refus.
    const { NextRequest } = await import('next/server');
    const { GET } = await import('@/app/api/admin/ai/execution-reports/[id]/route');
    const res = await GET(new NextRequest(`http://localhost/api/admin/ai/execution-reports/${t1.id}`), { params: Promise.resolve({ id: String(t1.id) }) });
    expect([401, 403]).toContain(res.status);
    // Consultation sensible journalisée.
    const { readReportDetailForAdmin } = await import('@/services/ai/execution-report/admin-access');
    const d = await readReportDetailForAdmin({ adminUserId: a.ownerUserId, reportId: t1.id, limit: 5 });
    expect(d?.entries).toHaveLength(5);
    const audit = await sql`SELECT details FROM admin_audit_log WHERE action_type = 'AI_EXECUTION_REPORT_READ' AND target_id = ${t1.id}`;
    expect(audit.length).toBeGreaterThanOrEqual(1);
    // Aucun secret dans le rapport.
    const brut = JSON.stringify(await sql`SELECT * FROM ai_execution_reports WHERE id = ${t1.id}`);
    expect(brut).not.toMatch(/postgres:\/\/|api[_-]?key|sk-[a-z0-9]/i);
  });

  it('REP-08 — exécution antérieure sans rapport : « non tracé » explicite, rien de reconstitué', async () => {
    const compte = await make.account();
    const { reportsForExecution } = await import('@/services/ai/execution-report/repository');
    expect(await reportsForExecution({ accountId: compte.id, jobId: 2_000_000_000, traceId: 'trace-anterieure-58c', fileId: null })).toEqual([]);
    const { GET } = await import('@/app/api/admin/ai/executions/[id]/reports/route');
    const { NextRequest } = await import('next/server');
    // Sans session : refus (la page n'expose jamais de données sans administrateur).
    const res = await GET(new NextRequest('http://localhost/api/admin/ai/executions/1/reports'), { params: Promise.resolve({ id: '1' }) });
    expect([401, 403]).toContain(res.status);
  });

  it('REP-09 — valeur utilisateur protégée : décision non écrite, motif normalisé, APPLIED / decisionsApplied = écritures confirmées', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { bien, f } = await bienAssure(compte);
    const { writeCanonicalAssetField } = await import('@/services/canonical/asset-state');
    await writeCanonicalAssetField({ assetId: bien.id, accountId: compte.id, key: 'insurer', value: 'MAAF', origin: 'USER' });
    await analyser(compte, f.id, assurance({ id: bien.id, label: 'Maison de Rennes' }, [fait('insurer', 'Allianz', bien.id, 'Assureur : Allianz')]));
    const t3 = (await rapports({ assetId: bien.id, treatment: 'T3' })).at(-1)!;
    const champ = (await lignes(t3.id)).find((e) => e.section === 'FIELD' && e.field_key === 'insurer')!;
    expect(champ.write_result).toBe('NOT_WRITTEN');
    expect(champ.reason_code).toBe('USER_VALUE_PROTECTED');
    expect(champ.old_value).toBe('MAAF');
    expect(t3.counters.written).toBe(0);
    const [kc] = await sql<{ v: string }[]>`SELECT (key_characteristics::jsonb)->>'insurer' AS v FROM assets WHERE id = ${bien.id}`;
    expect(kc.v).toBe('MAAF');
    // Passage T3 du compte : compteurs = écritures confirmées des rapports.
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    const run = await reconcileAccount(compte.id, { type: 'manual' }, { scope: 'full' });
    const lies = await sql<Rapport[]>`SELECT * FROM ai_execution_reports WHERE account_run_id = ${run.runId}`;
    expect(lies.length).toBeGreaterThan(0);
    expect(run.decisionsApplied).toBe(lies.reduce((n, r) => n + (r.counters.written ?? 0), 0));
    expect(run.objectsModified).toBe(lies.filter((r) => (r.counters.written ?? 0) > 0).length);
  });
});
