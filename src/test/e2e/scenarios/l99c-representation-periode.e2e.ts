/**
 * Lot 99C — représentation temporelle des titres de documents, sur PostgreSQL 16,
 * avec la branche T3 DOCUMENT_NAMING SIMULÉE (aucun appel réel ; la décision
 * vient du « modèle » injecté, le reste est le code de production : phase T3
 * du compte, validation serveur, persistance, service de nommage unique,
 * diagnostic global).
 *
 *   L99C-E2E-A  mensualité Homiris du 05/02 au 04/03 : avant décision, période exacte (plus
 *               de mois majoritaire) ; décision T3 MONTH → « Facture Homiris — Février 2026 » ;
 *               décision, fondement et preuves au diagnostic global ; second passage sans appel ;
 *   L99C-E2E-B  période du 18/01 au 17/03 : jamais « Février 2026 » ; une décision fondée sur la
 *               date d'émission est REFUSÉE (R6), mémorisée, non rappelée sur la même version ;
 *               nouvelle version du prompt → nouvel examen → plage retenue ;
 *   L99C-E2E-C  semestre : « Janvier à juin 2026 » (MULTI_MONTH) ;
 *   L99C-E2E-D  « Abonnement février 2026 » (mois écrit, preuve T1) : « Février 2026 » sans même
 *               appeler T3 (prompt sans le contrat) ; aucun appel de représentation ;
 *   L99C-E2E-E  série de trois mensualités du 5 au 4 : titres Janvier / Février / Mars 2026,
 *               titres comparables de la série transmis à T3 ;
 *   L99C-E2E-F  titre corrigé par l'utilisateur : jamais transmis à décider, jamais écrit,
 *               jamais renommé (même si le modèle le cite) ;
 *   L99C-E2E-G  T1 conserve l'extraction de la période facturée (`document.billingPeriod`) :
 *               période lue à défaut d'échéance, titre exact sans contrat.
 *
 * Dates sans ambiguïté jour / mois. Assertions bornées aux comptes créés ici.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const MAINTENANT = new Date('2026-10-27T09:30:00Z');

/** Échéance (période facturée, portée INSTALLMENT) d'une facture d'abonnement. */
const echeance = (assetId: number, debut: string, fin: string, facture: string, fournisseur: string) => cand({
  typeHint: 'INTERVENTION', provider: fournisseur, summary: 'Abonnement', sourceRoleHint: 'INVOICE',
  targetHints: [cible(assetId)], businessReferences: [ref('INVOICE', facture)] as never,
  temporalHints: { startDate: debut, endDate: fin },
  financialHints: [fh('REALIZED_COST', 3990, { amountScope: 'INSTALLMENT', economicDate: debut, periodStart: debut, periodEnd: fin })],
});

scenario('L99C', 'Représentation temporelle des titres décidée par T3 DOCUMENT_NAMING (simulé), validée par le serveur', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1'] });
  const kit = operationsKit(sql, make);

  const compte = async () => {
    const c = await make.account();
    const maison = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    return { c, maison };
  };
  /** Facture analysée par T1 (connaissance persistée), titre automatique à reprendre par le service de nommage. */
  const facture = async (c: AccountRow, assetId: number, o: {
    debut: string; fin: string; numero: string; emise: string; fournisseur?: string; source?: 'SYSTEM' | 'USER'; titre?: string; sansEcheance?: boolean;
  }) => {
    const fournisseur = o.fournisseur ?? 'HOMIRIS';
    const candidats = o.sansEcheance ? [] : [{ ...echeance(assetId, o.debut, o.fin, o.numero, fournisseur), candidateKey: 'op1' }];
    const id = await kit.document(c, assetId, candidats as never, { type: 'INVOICE', title: o.titre ?? `facture-${o.numero}.pdf`, amountCents: 3990, date: o.emise });
    await sql`UPDATE asset_files SET supplier = ${fournisseur}, document_type = 'FACTURE', title_source = ${o.source ?? 'SYSTEM'},
                     title_rule_version = 2, title_context_fingerprint = 'v2', last_analysis_at = now() - interval '1 day',
                     original_filename = ${`facture-${o.numero}.pdf`}
               WHERE id = ${id}`;
    await sql`UPDATE document_extractions SET title = 'Facture', supplier_name = ${fournisseur}, document_date = ${o.emise},
                     metadata = ${JSON.stringify({ legacyDocumentType: 'FACTURE' })}::jsonb WHERE file_id = ${id}`;
    return id;
  };
  /** Sortie T1 persistée portant `document.billingPeriod` (contrat t1-billing-period-v1, lot 97A). */
  const runT1 = async (c: AccountRow, fileId: number, bp: Json) => {
    const raw = { task: 'ANALYZE_DOCUMENT', document: { title: { value: 'Facture', confidence: 'certain' }, billingPeriod: bp } };
    await sql`INSERT INTO document_analysis_runs (asset_file_id, input_file_hash, prompt_version, provider, model, status, is_current_reference, account_id, raw_response_json)
              VALUES (${fileId}, ${`h${fileId}`}, 't1_master_v1@file', 'replay', 'm', 'completed', true, ${c.id}, ${JSON.stringify(raw)})`;
  };
  const nommer = async (c: AccountRow, id: number) => {
    const { ensureBusinessTitle } = await import('@/services/documents/document-title.service');
    return ensureBusinessTitle({ fileId: id, accountId: c.id, origin: 'COHERENCE', mode: 'repair' });
  };
  const fichier = async (id: number) => (await sql<Json[]>`
    SELECT retained_title, title_source, title_basis, title_convention, title_period_decision FROM asset_files WHERE id = ${id}`)[0];

  /** T3 DOCUMENT_NAMING simulé : décisions fournies par le test ; appels mémorisés (variables reçues). */
  const t3 = (decisions: (vars: Json) => Json[] | null) => {
    const appels: Json[] = [];
    const callModel = async (p: { variables: Json; sourceIds: number[] }) => {
      appels.push({ ...p.variables, sourceIds: p.sourceIds });
      const d = decisions(p.variables);
      return { output: (d === null ? { task: 'DOCUMENT_NAMING', document_renames: [] } : { task: 'DOCUMENT_NAMING', document_renames: [], period_representations: d }) as never, traceId: `l99c-${appels.length}` };
    };
    return { appels, callModel };
  };
  const phase = async (c: AccountRow, sim: ReturnType<typeof t3>, o: { contrat?: boolean; version?: string } = {}) => {
    const { runDocumentNamingPhase } = await import('@/services/ai/reconciliation/document-naming/phase');
    return runDocumentNamingPhase(c.id, {
      promptStatus: async () => ({ available: true, version: o.version ?? 't3@v99c', periodContract: o.contrat ?? true }),
      callModel: sim.callModel as never, callsWindow: async () => ({ count: 0, oldestAt: null }), now: () => MAINTENANT,
    });
  };
  const candidats = (vars: Json): Json[] => vars.CANDIDATES as Json[];
  const mois = (id: number, m: string, extra: Json = {}) => ({
    document_id: id, representation: 'MONTH', month: m, basis: 'MONTHLY_INSTALLMENT',
    evidence: [{ source: 'BILLED_PERIOD', document_id: id, quote: 'Période facturée' }, { source: 'CONTRACT', document_id: id, quote: 'Abonnement mensuel' }],
    reason: 'Mensualité d’un abonnement mensuel.', confidence: 'certain', ...extra,
  });

  // ══ A — mensualité ══════════════════════════════════════════════════════
  it('L99C-E2E-A — mensualité du 05/02 au 04/03 : période exacte sans décision, « Février 2026 » avec la décision T3 ; diagnostic ; second passage sans appel', async () => {
    const { c, maison } = await compte();
    const id = await facture(c, maison.id, { debut: '2026-02-05', fin: '2026-03-04', numero: '94741357', emise: '2026-03-06' });
    // T1 donne un mois principal fondé sur la seule majorité de la période : indice seulement.
    await runT1(c, id, { start: '2026-02-05', end: '2026-03-04', principalMonth: '2026-02', principalMonthBasis: 'MAJORITY_OF_PERIOD', confidence: 'certain', evidence: { quote: 'Du 05/02/2026 au 04/03/2026', page: 1 } });
    await nommer(c, id);
    expect((await fichier(id)).retained_title).toBe('Facture Homiris — 5 février au 4 mars 2026');
    expect((await fichier(id)).title_basis).toMatchObject({ v: 2, statedMonth: null, periodRepresentation: { source: 'EXACT_PERIOD', decidedBy: 'RULE' } });

    const sim = t3((v) => candidats(v).map((x) => mois(x.documentId, '2026-02')));
    const r = await phase(c, sim);
    expect(sim.appels).toHaveLength(1);
    const [c0] = candidats(sim.appels[0]);
    expect(c0).toMatchObject({ documentId: id, billingPeriod: { start: '2026-02-05', end: '2026-03-04', source: 'T1_INSTALLMENT' }, issueDate: '2026-03-06', monthHint: { value: '2026-02', basis: 'MAJORITY_OF_PERIOD' } });
    expect(String(sim.appels[0].RELATION_TYPE)).toContain('PERIOD_REPRESENTATION');
    expect(r.periodRepresentation).toMatchObject({ calls: 1, accepted: 1, refused: 0, titlesUpdated: 1, remaining: 0 });

    const f = await fichier(id);
    expect(f.retained_title).toBe('Facture Homiris — Février 2026');
    expect(f.title_period_decision).toMatchObject({ contract: 't3-naming-period-v1', status: 'ACCEPTED', representation: 'MONTH', month: '2026-02', promptVersion: 't3@v99c', traceId: 'l99c-1',
      inputs: { start: '2026-02-05', end: '2026-03-04', statedMonth: null }, evidence: [{ source: 'BILLED_PERIOD' }, { source: 'CONTRACT' }] });
    expect(f.title_basis.periodRepresentation).toMatchObject({ source: 'T3_DECISION', representation: 'MONTH', decidedBy: 'T3', label: 'Février 2026', basis: 'MONTHLY_INSTALLMENT' });
    const ev = await sql<Json[]>`SELECT origin, outcome, new_title FROM document_title_events WHERE file_id = ${id} ORDER BY id`;
    expect(ev.at(-1)).toMatchObject({ origin: 'T3', outcome: 'UPDATED', new_title: 'Facture Homiris — Février 2026' });
    // Rapport du passage T3 : section dédiée, décision → issue en base.
    expect(r.reportId).not.toBeNull();
    const lignes = await sql<Json[]>`SELECT section, write_result, reason_code, links FROM ai_execution_report_entries
      WHERE report_id = COALESCE((SELECT entries_report_id FROM ai_execution_reports WHERE id = ${r.reportId}), ${r.reportId}) AND section = 'NAMING_PERIOD'`;
    expect(lignes).toEqual([expect.objectContaining({ write_result: 'WRITTEN', reason_code: 'UPDATED' })]);

    // Diagnostic global : décision retenue et preuves (asset_files exporté).
    const admin = await make.user({ role: 'ADMIN' });
    const { generateDiagnostic } = await import('@/services/admin/diagnostics-export/collect');
    const b = await generateDiagnostic({ scope: 'user', id: c.ownerUserId, reinforced: false }, { adminUserId: admin.id });
    const docs = JSON.parse(b.files.find((x) => x.path.endsWith('/asset_files.json'))!.content) as Json[];
    const d = docs.find((x) => Number(x.id) === id)!;
    const dec = typeof d.title_period_decision === 'string' ? JSON.parse(d.title_period_decision) : d.title_period_decision;
    const base = typeof d.title_basis === 'string' ? JSON.parse(d.title_basis) : d.title_basis;
    expect(dec).toMatchObject({ status: 'ACCEPTED', representation: 'MONTH', evidence: expect.arrayContaining([expect.objectContaining({ source: 'BILLED_PERIOD' })]) });
    expect(base.periodRepresentation).toMatchObject({ source: 'T3_DECISION', evidence: expect.any(Array) });

    // Second passage : rien à décider, aucun appel, aucun nouvel événement.
    const n = ev.length;
    await phase(c, sim);
    expect(sim.appels).toHaveLength(1);
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM document_title_events WHERE file_id = ${id}`)[0].n).toBe(n);
    expect((await nommer(c, id)).outcome).toBe('NO_CHANGE');
  });

  // ══ B — plage à cheval ══════════════════════════════════════════════════
  it('L99C-E2E-B — 18/01 au 17/03 : jamais « Février 2026 » ; date d’émission refusée (R6), mémorisée ; nouvelle version → plage retenue', async () => {
    const { c, maison } = await compte();
    const id = await facture(c, maison.id, { debut: '2026-01-18', fin: '2026-03-17', numero: 'JV-2026-03', emise: '2026-03-20', fournisseur: 'Jardins du Val' });
    await runT1(c, id, { start: '2026-01-18', end: '2026-03-17', principalMonth: '2026-02', principalMonthBasis: 'MAJORITY_OF_PERIOD', confidence: 'certain', evidence: { quote: 'Prestations du 18/01/2026 au 17/03/2026', page: 1 } });
    await nommer(c, id);
    expect((await fichier(id)).retained_title).toBe('Facture Jardins du Val — 18 janvier au 17 mars 2026');

    const fautif = t3((v) => candidats(v).map((x) => mois(x.documentId, '2026-03', { basis: 'ISSUE_DATE', evidence: [{ source: 'BILLED_PERIOD' }, { source: 'ISSUE_DATE', quote: 'Émise le 20/03/2026' }] })));
    const r = await phase(c, fautif, { version: 't3@v1' });
    expect(r.periodRepresentation).toMatchObject({ accepted: 0, refused: 1, titlesUpdated: 0 });
    expect((await fichier(id)).retained_title).toBe('Facture Jardins du Val — 18 janvier au 17 mars 2026');
    expect((await fichier(id)).title_period_decision).toMatchObject({ status: 'REFUSED', refusal: 'ARTIFICIAL_DATE', promptVersion: 't3@v1' });
    // Même version : aucun rappel.
    await phase(c, fautif, { version: 't3@v1' });
    expect(fautif.appels).toHaveLength(1);

    const plage = t3((v) => candidats(v).map((x) => ({ document_id: x.documentId, representation: 'DATE_RANGE', start: '2026-01-18', end: '2026-03-17', basis: 'EXACT_PERIOD',
      evidence: [{ source: 'BILLED_PERIOD', quote: 'Prestations du 18/01/2026 au 17/03/2026' }], reason: 'À cheval sur trois mois.', confidence: 'certain' })));
    await phase(c, plage, { version: 't3@v2' });
    expect(plage.appels).toHaveLength(1);
    const f = await fichier(id);
    expect(f.retained_title).toBe('Facture Jardins du Val — 18 janvier au 17 mars 2026');
    expect(f.retained_title).not.toContain('Février');
    expect(f.title_period_decision).toMatchObject({ status: 'ACCEPTED', representation: 'DATE_RANGE', promptVersion: 't3@v2' });
  });

  // ══ C — semestre ════════════════════════════════════════════════════════
  it('L99C-E2E-C — semestre : « Janvier à juin 2026 » (MULTI_MONTH)', async () => {
    const { c, maison } = await compte();
    const id = await facture(c, maison.id, { debut: '2026-01-15', fin: '2026-06-30', numero: 'AH-26-S1', emise: '2025-12-15', fournisseur: 'Assur Habitat' });
    await nommer(c, id);
    expect((await fichier(id)).retained_title).toBe('Facture Assur Habitat — 15 janvier au 30 juin 2026');
    const sim = t3((v) => candidats(v).map((x) => ({ document_id: x.documentId, representation: 'MULTI_MONTH', from_month: '2026-01', to_month: '2026-06', basis: 'MULTI_MONTH_SPAN',
      evidence: [{ source: 'BILLED_PERIOD' }], reason: 'Cotisation semestrielle.', confidence: 'probable' })));
    await phase(c, sim);
    expect((await fichier(id)).retained_title).toBe('Facture Assur Habitat — Janvier à juin 2026');
  });

  // ══ D — mois écrit ══════════════════════════════════════════════════════
  it('L99C-E2E-D — « Abonnement février 2026 » : « Février 2026 » par le repli prudent, sans contrat T3 ni appel de représentation', async () => {
    const { c, maison } = await compte();
    const id = await facture(c, maison.id, { debut: '2026-02-05', fin: '2026-03-04', numero: '94741999', emise: '2026-03-06' });
    await runT1(c, id, { start: '2026-02-05', end: '2026-03-04', principalMonth: '2026-02', principalMonthBasis: 'STATED_ON_DOCUMENT', confidence: 'certain', evidence: { quote: 'Abonnement février 2026', page: 1 } });
    await nommer(c, id);
    const f = await fichier(id);
    expect(f.retained_title).toBe('Facture Homiris — Février 2026');
    expect(f.title_basis.periodRepresentation).toMatchObject({ source: 'STATED_MONTH', evidence: [{ source: 'STATED_MONTH', quote: 'Abonnement février 2026' }] });
    const sim = t3(() => { throw new Error('aucun appel attendu'); });
    const r = await phase(c, sim, { contrat: false });
    expect(sim.appels).toHaveLength(0);
    expect(r.periodRepresentation).toBeUndefined();
    expect((await fichier(id)).title_period_decision).toBeNull();
  });

  // ══ E — série ═══════════════════════════════════════════════════════════
  it('L99C-E2E-E — série de trois mensualités du 5 au 4 : Janvier, Février, Mars 2026 ; titres comparables transmis', async () => {
    const { c, maison } = await compte();
    const periodes = [['2026-01-05', '2026-02-04', '2026-02-06', '2026-01'], ['2026-02-05', '2026-03-04', '2026-03-06', '2026-02'], ['2026-03-05', '2026-04-04', '2026-04-06', '2026-03']];
    const ids: number[] = [];
    for (const [i, [d, f, e]] of periodes.entries()) ids.push(await facture(c, maison.id, { debut: d, fin: f, numero: `9474200${i}`, emise: e }));
    for (const id of ids) await nommer(c, id);
    const parId = new Map(ids.map((id, i) => [id, periodes[i][3]]));
    const sim = t3((v) => candidats(v).map((x) => mois(x.documentId, parId.get(x.documentId)!, { basis: 'SERIES_CONSISTENCY' })));
    await phase(c, sim);
    expect(sim.appels).toHaveLength(1);
    const s = JSON.parse(String(sim.appels[0].SUBJECT_CONTEXT));
    expect(s.series.comparableTitles.map((t: Json) => t.documentId).sort()).toEqual([...ids].sort());
    expect(s.series.comparableTitles[0]).toMatchObject({ titleOrigin: 'SYSTEM', billedPeriod: { start: '2026-01-05', end: '2026-02-04' } });
    const titres = await Promise.all(ids.map(async (id) => (await fichier(id)).retained_title));
    expect(titres).toEqual(['Facture Homiris — Janvier 2026', 'Facture Homiris — Février 2026', 'Facture Homiris — Mars 2026']);
  });

  // ══ F — correction utilisateur ══════════════════════════════════════════
  it('L99C-E2E-F — titre corrigé par l’utilisateur : jamais à décider, jamais écrit, jamais renommé (même cité par le modèle)', async () => {
    const { c, maison } = await compte();
    const auto = await facture(c, maison.id, { debut: '2026-02-05', fin: '2026-03-04', numero: '55500010', emise: '2026-03-06' });
    const user = await facture(c, maison.id, { debut: '2026-03-05', fin: '2026-04-04', numero: '55500011', emise: '2026-04-06', source: 'USER', titre: 'Mon alarme — mars' });
    for (const id of [auto, user]) await nommer(c, id);
    expect((await fichier(user)).retained_title).toBe('Mon alarme — mars');
    // Le « modèle » décide aussi pour le document de l'utilisateur, hors des documents fournis.
    const sim = t3((v) => [...candidats(v).map((x) => mois(x.documentId, '2026-02')), mois(user, '2026-03')]);
    const r = await phase(c, sim);
    expect(sim.appels).toHaveLength(1);
    expect(candidats(sim.appels[0]).map((x) => x.documentId)).toEqual([auto]);
    expect(sim.appels[0].sourceIds).toEqual([auto]);
    // Le titre utilisateur figure parmi les titres comparables de la série (contexte R5), jamais à décider.
    expect(JSON.parse(String(sim.appels[0].SUBJECT_CONTEXT)).series.comparableTitles).toEqual(expect.arrayContaining([expect.objectContaining({ documentId: user, titleOrigin: 'USER', title: 'Mon alarme — mars' })]));
    expect(r.periodRepresentation).toMatchObject({ accepted: 1, refused: 1 });
    const u = await fichier(user);
    expect(u).toMatchObject({ retained_title: 'Mon alarme — mars', title_source: 'USER', title_period_decision: null });
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM document_title_events WHERE file_id = ${user} AND outcome = 'UPDATED'`)[0].n).toBe(0);
    // Un renommage manuel APRÈS la décision : le titre utilisateur n'est jamais remplacé (service unique, contrôle compris).
    await sql`UPDATE asset_files SET retained_title = 'Alarme février (perso)', title_source = 'USER' WHERE id = ${auto}`;
    expect((await nommer(c, auto)).outcome).toBe('SKIP_USER_TITLE');
    expect((await fichier(auto)).retained_title).toBe('Alarme février (perso)');
  });

  // ══ G — T1 conserve billingPeriod ═══════════════════════════════════════
  it('L99C-E2E-G — sans échéance structurée : la période facturée de T1 (`document.billingPeriod`) est lue, présentée exactement', async () => {
    const { c, maison } = await compte();
    const id = await facture(c, maison.id, { debut: '2026-04-01', fin: '2026-06-30', numero: 'T-2026-Q2', emise: '2026-07-02', fournisseur: 'Eau du Val', sansEcheance: true });
    await runT1(c, id, { start: '2026-04-01', end: '2026-06-30', principalMonth: null, principalMonthBasis: null, confidence: 'certain', evidence: { quote: 'Consommation du 01/04/2026 au 30/06/2026', page: 1 } });
    await nommer(c, id);
    const f = await fichier(id);
    expect(f.retained_title).toBe('Facture Eau du Val — Avril à juin 2026');
    expect(f.title_basis.billedPeriod).toEqual({ start: '2026-04-01', end: '2026-06-30', source: 'T1_BILLING_PERIOD' });
  });
});
