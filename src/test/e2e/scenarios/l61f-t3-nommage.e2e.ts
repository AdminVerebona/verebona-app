/**
 * Lot 61 — ticket « [P2] T3 — Harmonisation intelligente du nommage
 * documentaire » — de bout en bout sur PostgreSQL 16 réel : vrai passage T3
 * du compte (`reconcileAccount`, toutes phases), vraie passerelle IA, vrai
 * journal, vrai rapport d'exécution. Modèle SIMULÉ (aucun réseau) : le
 * scénario dit ce que l'IA propose — le JUGEMENT (familles, convention,
 * noms) reste celui de l'IA simulée, jamais une règle du code.
 *
 * Lot 63 : le texte LIVRÉ du prompt T3 porte la branche DOCUMENT_NAMING —
 * la version BO de test est ce texte (le modèle simulé lit les emplacements
 * réels « Objet à rattacher » / « Candidats ») ; T3-NOM-15 active une
 * version antérieure, sans la branche (texte livré amputé de sa section).
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';

interface DocIA {
  documentId: number; role: 'TO_EXAMINE' | 'REFERENCE'; currentName: string; originalName: string | null; nameOrigin: string;
  renameAllowed: boolean; documentDate: string | null; supplier: string | null; facts: Array<{ key: string; value: string }>;
  excerpt: string | null; nameHistory: unknown[];
}
interface Lot { comparisonSet: { key: string; documentCount: number; part: { index: number; of: number } }; previousConventions: Array<{ label: string; convention: string }> }
type Decision = Record<string, unknown> | Error;

/** IA simulée : le scénario dit ce qu'elle décide, appel par appel. */
const modele = {
  decider: (_l: Lot, _d: DocIA[]): Decision | Promise<Decision> => ({ task: 'DOCUMENT_NAMING', document_renames: [] }),
  appels: [] as Array<{ accountId: number | null; lot: Lot; docs: DocIA[] }>,
};

function fournisseur() {
  return {
    name: 'simule-l61f',
    isConfigured: () => true,
    async call(input: { prompt: string; operationCode?: string }) {
      if (input.operationCode !== 't3_document_naming') throw new Error(`appel inattendu : ${input.operationCode}`);
      // Emplacements du texte livré (branche LINK_AMBIGUITY, réutilisés par DOCUMENT_NAMING).
      const lot = JSON.parse(/^Objet à rattacher : (.*)$/m.exec(input.prompt)![1]) as Lot;
      const docs = JSON.parse(/^Candidats : (.*)$/m.exec(input.prompt)![1]) as DocIA[];
      modele.appels.push({ accountId: null, lot, docs });
      const d = await modele.decider(lot, docs);
      if (d instanceof Error) throw Object.assign(d, { status: 500 });
      return { rawText: JSON.stringify(d), inputTokens: 300, outputTokens: 80 };
    },
  };
}

/** Propositions de l'IA simulée : nouveau nom par document À EXAMINER (les autres documents du lot en référence). */
const proposer = (noms: Record<number, string>, o: { confidence?: string; families?: unknown[]; reason?: string } = {}) => (_l: Lot, docs: DocIA[]) => ({
  task: 'DOCUMENT_NAMING',
  ...(o.families ? { families: o.families } : {}),
  document_renames: docs.filter((d) => d.role === 'TO_EXAMINE' && noms[d.documentId] !== undefined).map((d) => ({
    document_id: d.documentId, expected_current_name: d.currentName, proposed_name: noms[d.documentId],
    reference_document_ids: docs.filter((x) => x.documentId !== d.documentId).map((x) => x.documentId).slice(0, 3),
    reason: o.reason ?? 'Convention majoritaire de la famille (nature, émetteur, période)', confidence: o.confidence ?? 'certain',
  })),
});


scenario('L61F-T3-NOM', 'Lot 61 — T3 : harmonisation intelligente du nommage documentaire', ({ sql, make }) => {
  const fichier = readFileSync(join(process.cwd(), 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf8');
  // Version BO antérieure au lot 63 : texte livré sans la section DOCUMENT_NAMING.
  const sansBranche = fichier.slice(0, fichier.indexOf('BRANCHE TASK = DOCUMENT_NAMING')).replace(' | DOCUMENT_NAMING', '')
    + 'Réponds uniquement par le JSON correspondant au TASK demandé.\n';
  if (!fichier.includes('BRANCHE TASK = DOCUMENT_NAMING') || sansBranche.includes('DOCUMENT_NAMING')) throw new Error('texte T3 livré inattendu');
  const avecBranche = async (on: boolean) => {
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests([{ id: on ? 9611 : 9610, treatment: 'T3', versionNumber: on ? 11 : 10, content: on ? fichier : sansBranche }]);
  };
  const env0 = { ...process.env };
  beforeAll(async () => {
    const { setAiProvider } = await import('@/services/ai/gateway/providers');
    setAiProvider(fournisseur() as never);
  });
  beforeEach(async () => {
    modele.decider = () => ({ task: 'DOCUMENT_NAMING', document_renames: [] });
    modele.appels.length = 0;
    await avecBranche(true);
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('T3_NAMING_') && env0[k] === undefined) delete process.env[k];
  });
  afterAll(async () => {
    (await import('@/services/ai/master-prompts/master-prompt-runtime')).__setActiveMasterPromptsForTests(null);
  });

  async function document(c: { id: number; ownerUserId: number }, o: {
    nom: string; fournisseur?: string | null; type?: string | null; date?: string | null; texte?: string; bien?: number | null;
    source?: 'SYSTEM' | 'USER'; original?: string | null; montant?: number | null;
  }) {
    const [f] = await sql<Array<{ id: number; public_id: string; s3_key: string }>>`
      INSERT INTO asset_files (user_id, account_id, asset_id, s3_key, mime_type, retained_title, original_filename, supplier,
                               document_type_code, document_date, analysis_state, last_analysis_at, title_source,
                               title_rule_version, title_context_fingerprint, title_checked_at, amount_cents)
      VALUES (${c.ownerUserId}, ${c.id}, ${o.bien ?? null}, ${`e2e/${c.id}/${Math.random().toString(36).slice(2)}.pdf`}, 'application/pdf',
              ${o.nom}, ${o.original ?? null}, ${o.fournisseur === undefined ? 'Orange' : o.fournisseur}, ${o.type === undefined ? 'INVOICE' : o.type},
              ${o.date ?? null}, 'ANALYZED', now() - interval '1 hour', ${o.source ?? 'SYSTEM'}, 2, 'e2e', now(), ${o.montant ?? null})
      RETURNING id, public_id::text, s3_key`;
    await sql`INSERT INTO document_extractions (account_id, file_id, title, supplier_name, document_date, document_type_code, full_text, extracted_at)
              VALUES (${c.id}, ${f.id}, ${o.nom}, ${o.fournisseur === undefined ? 'Orange' : o.fournisseur}, ${o.date ?? null},
                      ${o.type === undefined ? 'INVOICE' : o.type}, ${o.texte ?? `Facture ${o.fournisseur ?? 'Orange'}`}, now() - interval '1 hour')`;
    return f;
  }
  const nom = async (id: number) => (await sql<Array<{ t: string }>>`SELECT retained_title AS t FROM asset_files WHERE id = ${id}`)[0].t;
  const passer = async (accountId: number, type: 'manual' | 'scheduled' = 'manual') => {
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    return reconcileAccount(accountId, type === 'manual' ? { type: 'manual', requestedByUserId: null } : { type: 'scheduled' },
      { triggerCode: type === 'manual' ? 'manual' : 'schedule_hourly' });
  };
  const evenements = (accountId: number) => sql<Array<{ file_id: number; outcome: string; reason_code: string | null; old_name: string | null; applied_name: string | null; proposed_name: string; name_origin: string; ai_reason: string; reference_document_ids: number[]; account_run_id: number | null }>>`
    SELECT file_id, outcome, reason_code, old_name, applied_name, proposed_name, name_origin, ai_reason, reference_document_ids, account_run_id
      FROM document_rename_events WHERE account_id = ${accountId} ORDER BY id`;
  const rapport = async (accountId: number) => {
    const [r] = await sql<Array<{ id: number; status: string; counters: Record<string, number>; sources: Record<string, unknown>; account_run_id: number | null }>>`
      SELECT id, status, counters, sources, account_run_id FROM ai_execution_reports
       WHERE account_id = ${accountId} AND treatment = 'T3' AND scope = 'DOCUMENT_NAMING' ORDER BY id DESC LIMIT 1`;
    const lignes = r ? await sql<Array<{ section: string; write_result: string; reason_code: string | null; old_value: unknown; value: unknown; record_id: string | null; links: Record<string, unknown> }>>`
      SELECT section, write_result, reason_code, old_value, value, record_id, links FROM ai_execution_report_entries
       WHERE report_id = COALESCE((SELECT entries_report_id FROM ai_execution_reports WHERE id = ${r.id}), ${r.id}) ORDER BY seq` : [];
    return { r, lignes };
  };

  /** Quatre factures Orange historiques aux noms incohérents, aucune Opération. */
  async function stockOrange() {
    const c = await make.account();
    const maison = await make.asset(c, { category: 'LOGEMENT', name: 'Maison Lilas' });
    const d = {
      mars: await document(c, { nom: 'Facture_Orange_03-2024.pdf', original: 'Facture_Orange_03-2024.pdf', date: '2024-03-12', bien: maison.id }),
      avril: await document(c, { nom: 'Orange facture avril 2024', date: '2024-04-12', bien: maison.id }),
      mai: await document(c, { nom: 'Facture Orange Internet 12 rue des Lilas mai 2024', date: '2024-05-12', bien: maison.id }),
      juin: await document(c, { nom: 'Facture Orange du 12/06/2024', date: '2024-06-12', bien: maison.id }),
    };
    return { c, maison, d };
  }
  const CONVENTION = [{ label: 'Factures Internet Orange', document_ids: [] as number[], convention: 'Facture Orange — <mois> <année>', inconsistent: true }];

  it('T3-NOM-01 / T3-NOM-08 / T3-NOM-09 — rétroactivité : factures Orange historiques harmonisées, sans Opération ; visible dans le rapport et en base', async () => {
    const { c, d } = await stockOrange();
    const opsAvant = (await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${c.id}`)[0].n;
    modele.decider = proposer({
      [d.mars.id]: 'Facture Orange — mars 2024', [d.avril.id]: 'Facture Orange — avril 2024',
      [d.mai.id]: 'Facture Orange — mai 2024 — 12 rue des Lilas', [d.juin.id]: 'Facture Orange — juin 2024',
    }, { families: [{ ...CONVENTION[0], document_ids: Object.values(d).map((x) => x.id) }] });
    const run = await passer(c.id);
    expect(run.phases?.DOCUMENT_NAMING).toMatchObject({ status: 'DONE', counts: { applied: 4, refused: 0 } });
    expect(run.phases).toMatchObject({ ASSETS: { status: 'DONE' }, OPEN_KNOWLEDGE: { status: 'DONE' }, OPEN_ACTIONS: { status: 'DONE' } });
    expect(await nom(d.mars.id)).toBe('Facture Orange — mars 2024');
    expect(await nom(d.avril.id)).toBe('Facture Orange — avril 2024');
    expect(await nom(d.mai.id)).toBe('Facture Orange — mai 2024 — 12 rue des Lilas');
    expect(await nom(d.juin.id)).toBe('Facture Orange — juin 2024');
    // Contexte fourni à T3 : noms actuel et original, origine du nom, données T1 — sans Opération.
    expect(modele.appels).toHaveLength(1);
    const vus = modele.appels[0].docs;
    expect(vus.map((x) => x.documentId).sort()).toEqual(Object.values(d).map((x) => x.id).sort());
    expect(vus.find((x) => x.documentId === d.mars.id)).toMatchObject({ originalName: 'Facture_Orange_03-2024.pdf', nameOrigin: 'UPLOAD', renameAllowed: true, documentDate: '2024-03-12' });
    expect(vus.find((x) => x.documentId === d.avril.id)).toMatchObject({ nameOrigin: 'UNKNOWN' });
    // Historique en base : ancien / nouveau nom, origine, justification, références, passage.
    const ev = await evenements(c.id);
    expect(ev).toHaveLength(4);
    expect(ev.every((e) => e.outcome === 'APPLIED' && e.account_run_id === run.runId && e.ai_reason.length > 0 && e.reference_document_ids.length > 0)).toBe(true);
    expect(ev.find((e) => e.file_id === d.juin.id)).toMatchObject({ old_name: 'Facture Orange du 12/06/2024', applied_name: 'Facture Orange — juin 2024', name_origin: 'UNKNOWN' });
    // Fichier, identifiants et relations intacts ; aucune Opération créée.
    const [f] = await sql<Array<{ public_id: string; s3_key: string; asset_id: number }>>`SELECT public_id::text, s3_key, asset_id FROM asset_files WHERE id = ${d.mars.id}`;
    expect(f).toMatchObject({ public_id: d.mars.public_id, s3_key: d.mars.s3_key });
    expect((await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${c.id}`)[0].n).toBe(opsAvant);
    // Rapport « Harmonisation documentaire » : propositions IA ≠ écritures confirmées.
    const { r, lignes } = await rapport(c.id);
    expect(r).toMatchObject({ status: 'SUCCESS', account_run_id: run.runId, sources: { section: 'Harmonisation documentaire' } });
    expect(r.counters).toMatchObject({ proposals: 4, written: 4, families: 1, inconsistentFamilies: 1, groupsExamined: 1 });
    const renommages = lignes.filter((l) => l.section === 'NAMING_RENAME');
    expect(renommages).toHaveLength(4);
    expect(renommages.every((l) => l.write_result === 'WRITTEN' && (l.links as { proposal?: string }).proposal === 'IA')).toBe(true);
    expect(renommages.find((l) => Number(l.record_id) === d.juin.id)).toMatchObject({ old_value: 'Facture Orange du 12/06/2024', value: 'Facture Orange — juin 2024' });
    expect(renommages[0].links).toMatchObject({ aiReason: expect.any(String), confidence: 'certain', referenceDocumentIds: expect.any(Array), finalName: expect.any(String) });
    expect(lignes.filter((l) => l.section === 'NAMING_FAMILY')).toHaveLength(1);
  }, 120_000);

  it('T3-NOM-04 / T3-NOM-12 — stabilité : relancer T3 sans nouvelle information ne modifie aucun nom, n’appelle pas l’IA ; le rattrapage déterministe ne défait rien', async () => {
    const { c, d } = await stockOrange();
    modele.decider = proposer({ [d.mars.id]: 'Facture Orange — mars 2024', [d.avril.id]: 'Facture Orange — avril 2024', [d.juin.id]: 'Facture Orange — juin 2024' });
    await passer(c.id);
    expect(modele.appels).toHaveLength(1);
    const noms = await Promise.all(Object.values(d).map((x) => nom(x.id)));
    // Une IA qui proposerait autre chose ne serait de toute façon pas appelée.
    modele.decider = proposer({ [d.mars.id]: 'Orange — 2024-03' });
    for (const type of ['manual', 'scheduled'] as const) {
      const run = await passer(c.id, type);
      expect(run.phases?.DOCUMENT_NAMING).toMatchObject({ status: 'DONE', counts: { groupsDue: 0, aiCalls: 0, applied: 0 } });
    }
    expect(modele.appels).toHaveLength(1);
    expect(await Promise.all(Object.values(d).map((x) => nom(x.id)))).toEqual(noms);
    expect((await evenements(c.id)).filter((e) => e.outcome === 'APPLIED')).toHaveLength(3);
    // Non-régression T3 : le rattrapage déterministe des titres (lot 34E) ne remplace pas un nom harmonisé.
    await sql`UPDATE asset_files SET title_context_fingerprint = NULL, title_checked_at = NULL WHERE account_id = ${c.id}`;
    // Données exploitables par le moteur déterministe : il aurait un candidat à proposer.
    await sql`UPDATE document_extractions SET title = 'Facture Internet Orange' WHERE account_id = ${c.id}`;
    const { ensureBusinessTitle } = await import('@/services/documents/document-title.service');
    const r = await ensureBusinessTitle({ fileId: d.mars.id, accountId: c.id, origin: 'T3', mode: 'repair' });
    expect(r).toMatchObject({ outcome: 'NO_CHANGE', reason: 'HARMONIZED_TITLE' });
    const { sweepDocumentTitles } = await import('@/services/ai/reconciliation/document-title-sweep');
    await sweepDocumentTitles({ accountId: c.id });
    expect(await nom(d.mars.id)).toBe('Facture Orange — mars 2024');
    expect(await nom(d.juin.id)).toBe('Facture Orange — juin 2024');
  }, 120_000);

  it('T3-NOM-02 — continuité : une nouvelle facture adopte la convention existante au passage de T3 (conventions mémorisées redonnées à l’IA)', async () => {
    const { c, d } = await stockOrange();
    const ids = Object.values(d).map((x) => x.id);
    modele.decider = proposer({
      [d.mars.id]: 'Facture Orange — mars 2024', [d.avril.id]: 'Facture Orange — avril 2024',
      [d.mai.id]: 'Facture Orange — mai 2024 — 12 rue des Lilas', [d.juin.id]: 'Facture Orange — juin 2024',
    }, { families: [{ ...CONVENTION[0], document_ids: ids }] });
    await passer(c.id);
    const nouveau = await document(c, { nom: 'scan_0042.pdf', original: 'scan_0042.pdf', date: '2024-07-15', texte: 'Orange — votre facture de juillet 2024' });
    modele.decider = (lot, docs) => {
      // L'IA voit la convention mémorisée et les documents harmonisés en référence.
      expect(lot.previousConventions[0]).toMatchObject({ label: 'Factures Internet Orange', convention: 'Facture Orange — <mois> <année>' });
      return proposer({ [nouveau.id]: 'Facture Orange — juillet 2024' }, { families: [{ ...CONVENTION[0], document_ids: [...ids, nouveau.id], inconsistent: false }] })(lot, docs);
    };
    const run = await passer(c.id, 'scheduled');
    expect(run.phases?.DOCUMENT_NAMING).toMatchObject({ counts: { applied: 1, aiCalls: 1 } });
    expect(await nom(nouveau.id)).toBe('Facture Orange — juillet 2024');
    expect(await nom(d.mars.id)).toBe('Facture Orange — mars 2024');
    expect(modele.appels[1].docs.find((x) => x.documentId === d.mars.id)).toMatchObject({ nameOrigin: 'T3_HARMONIZATION', currentName: 'Facture Orange — mars 2024' });
    expect((await evenements(c.id)).filter((e) => e.outcome === 'APPLIED')).toHaveLength(5);
  }, 120_000);

  it('T3-NOM-05 / T3-NOM-13 — protection : nom personnalisé jamais écrasé ; renommage manuel entre l’analyse IA et l’écriture : conservé (conflit tracé)', async () => {
    const { c, d } = await stockOrange();
    const perso = await document(c, { nom: 'Ma box — facture préférée', date: '2024-08-12', source: 'USER' });
    modele.decider = async (lot, docs) => {
      // Pendant l'analyse IA : l'utilisateur renomme la facture de juin (effet de PUT /api/documents/:id).
      await sql`UPDATE asset_files SET retained_title = 'Juin — renommée à la main', title_source = 'USER' WHERE id = ${d.juin.id}`;
      return proposer({
        [d.mars.id]: 'Facture Orange — mars 2024', [d.juin.id]: 'Facture Orange — juin 2024', [perso.id]: 'Facture Orange — août 2024',
      })(lot, docs);
    };
    await passer(c.id);
    expect(modele.appels[0].docs.find((x) => x.documentId === perso.id)).toMatchObject({ nameOrigin: 'USER', renameAllowed: false });
    expect(await nom(perso.id)).toBe('Ma box — facture préférée');
    expect(await nom(d.juin.id)).toBe('Juin — renommée à la main');
    expect(await nom(d.mars.id)).toBe('Facture Orange — mars 2024');
    const ev = await evenements(c.id);
    expect(ev.find((e) => e.file_id === perso.id)).toMatchObject({ outcome: 'REFUSED', reason_code: 'USER_NAME_PROTECTED', applied_name: null });
    expect(ev.find((e) => e.file_id === d.juin.id)).toMatchObject({ outcome: 'CONFLICT', reason_code: 'CONCURRENT_USER_RENAME', applied_name: null });
    const { lignes } = await rapport(c.id);
    expect(lignes.find((l) => l.section === 'NAMING_RENAME' && Number(l.record_id) === d.juin.id)).toMatchObject({ write_result: 'NOT_WRITTEN', reason_code: 'CONCURRENT_USER_RENAME' });
  }, 120_000);

  it('T3-NOM-03 / T3-NOM-06 — aucune nomenclature fixe : deux contrats d’un même fournisseur et un autre fournisseur gardent des conventions distinctes', async () => {
    const c = await make.account();
    const a1 = await document(c, { nom: 'EDF facture contrat 111 janvier 2025', fournisseur: 'EDF', date: '2025-01-10', texte: 'Contrat n° 111 — résidence principale' });
    const a2 = await document(c, { nom: 'Facture EDF 02/2025 (111)', fournisseur: 'EDF', date: '2025-02-10', texte: 'Contrat n° 111' });
    const b1 = await document(c, { nom: 'EDF 222 - mars 2025', fournisseur: 'EDF SA', date: '2025-03-05', texte: 'Contrat n° 222 — maison de vacances' });
    const b2 = await document(c, { nom: 'Électricité vacances contrat 222 avril 2025', fournisseur: 'EDF', date: '2025-04-05', texte: 'Contrat n° 222' });
    const v1 = await document(c, { nom: 'Veolia eau T1 2025', fournisseur: 'Veolia', date: '2025-03-31', texte: 'Facture eau 1er trimestre 2025' });
    const v2 = await document(c, { nom: 'facture veolia 2e trimestre 2025', fournisseur: 'Veolia', date: '2025-06-30', texte: 'Facture eau 2e trimestre 2025' });
    modele.decider = (lot, docs) => {
      if (lot.comparisonSet.key === 's:edf') {
        return proposer({
          [a1.id]: 'EDF résidence principale — contrat 111 — janvier 2025', [a2.id]: 'EDF résidence principale — contrat 111 — février 2025',
          [b1.id]: 'Électricité vacances (contrat 222) — 2025-03', [b2.id]: 'Électricité vacances (contrat 222) — 2025-04',
        }, { families: [
          { label: 'EDF contrat 111', document_ids: [a1.id, a2.id], convention: 'EDF résidence principale — contrat 111 — <mois> <année>', inconsistent: true },
          { label: 'EDF contrat 222', document_ids: [b1.id, b2.id], convention: 'Électricité vacances (contrat 222) — <AAAA-MM>', inconsistent: true },
        ] })(lot, docs);
      }
      return proposer({ [v1.id]: 'Eau Veolia · T1 2025', [v2.id]: 'Eau Veolia · T2 2025' })(lot, docs);
    };
    await passer(c.id);
    expect(modele.appels.map((a) => a.lot.comparisonSet.key).sort()).toEqual(['s:edf', 's:veolia']);
    expect([await nom(a1.id), await nom(a2.id)]).toEqual(['EDF résidence principale — contrat 111 — janvier 2025', 'EDF résidence principale — contrat 111 — février 2025']);
    expect([await nom(b1.id), await nom(b2.id)]).toEqual(['Électricité vacances (contrat 222) — 2025-03', 'Électricité vacances (contrat 222) — 2025-04']);
    expect([await nom(v1.id), await nom(v2.id)]).toEqual(['Eau Veolia · T1 2025', 'Eau Veolia · T2 2025']);
    const [g] = await sql<Array<{ conventions: Array<{ label: string }> }>>`SELECT conventions FROM document_naming_groups WHERE account_id = ${c.id} AND group_key = 's:edf'`;
    expect(g.conventions.map((x) => x.label).sort()).toEqual(['EDF contrat 111', 'EDF contrat 222']);
  }, 120_000);

  it('T3-NOM-07 — fiabilité : information supprimée ou inventée, nom trop long, confiance insuffisante — refusés, noms intacts, motifs au rapport', async () => {
    const { c, d } = await stockOrange();
    modele.decider = proposer({
      [d.mars.id]: 'Facture Orange', // date supprimée
      [d.avril.id]: 'Facture Orange — avril 2024 — contrat 998877', // référence inventée
      [d.mai.id]: 'Facture Orange — mai 2024', // adresse supprimée
      [d.juin.id]: `Facture Orange — juin 2024 ${'détail '.repeat(20)}`,
    });
    await passer(c.id);
    expect(await nom(d.mars.id)).toBe('Facture_Orange_03-2024.pdf');
    expect(await nom(d.avril.id)).toBe('Orange facture avril 2024');
    expect(await nom(d.mai.id)).toBe('Facture Orange Internet 12 rue des Lilas mai 2024');
    expect(await nom(d.juin.id)).toBe('Facture Orange du 12/06/2024');
    const parFichier = new Map((await evenements(c.id)).map((e) => [e.file_id, e.reason_code]));
    expect(parFichier.get(d.mars.id)).toBe('DISCRIMINANT_REMOVED');
    expect(parFichier.get(d.avril.id)).toBe('INFORMATION_INVENTED');
    expect(parFichier.get(d.mai.id)).toBe('DISCRIMINANT_REMOVED');
    expect(parFichier.get(d.juin.id)).toBe('TOO_LONG');
    const { r, lignes } = await rapport(c.id);
    expect(r).toMatchObject({ status: 'NO_CHANGE' });
    expect(r.counters).toMatchObject({ proposals: 4, written: 0, refused: 4 });
    expect(lignes.filter((l) => l.section === 'NAMING_RENAME').every((l) => l.write_result === 'NOT_WRITTEN')).toBe(true);
    // Nom historique d'origine inconnue : « probable » ne suffit pas.
    const c2 = await stockOrange();
    modele.decider = proposer({ [c2.d.avril.id]: 'Facture Orange — avril 2024' }, { confidence: 'probable' });
    await passer(c2.c.id);
    expect(await nom(c2.d.avril.id)).toBe('Orange facture avril 2024');
    expect((await evenements(c2.c.id))[0]).toMatchObject({ reason_code: 'UNKNOWN_ORIGIN_LOW_CONFIDENCE' });
  }, 120_000);

  it('T3-NOM-14 — isolation : l’IA ne voit que le compte ; un document d’un autre compte proposé est refusé, jamais lu ni modifié', async () => {
    const { c, d } = await stockOrange();
    const autre = await stockOrange();
    modele.decider = (lot, docs) => ({
      ...proposer({ [d.mars.id]: 'Facture Orange — mars 2024' })(lot, docs),
      document_renames: [
        ...(proposer({ [d.mars.id]: 'Facture Orange — mars 2024' })(lot, docs).document_renames),
        { document_id: autre.d.juin.id, expected_current_name: 'Facture Orange du 12/06/2024', proposed_name: 'Piraté', reference_document_ids: [], reason: 'x', confidence: 'certain' },
      ],
    });
    await passer(c.id);
    const vus = modele.appels.flatMap((a) => a.docs.map((x) => x.documentId));
    expect(vus.some((id) => Object.values(autre.d).some((x) => x.id === id))).toBe(false);
    expect(await nom(autre.d.juin.id)).toBe('Facture Orange du 12/06/2024');
    expect(await nom(d.mars.id)).toBe('Facture Orange — mars 2024');
    expect(await evenements(autre.c.id)).toEqual([]);
    expect((await evenements(c.id)).some((e) => e.file_id === autre.d.juin.id)).toBe(false);
    const { lignes } = await rapport(c.id);
    expect(lignes.find((l) => l.section === 'NAMING_RENAME' && Number(l.record_id) === autre.d.juin.id)).toMatchObject({ write_result: 'NOT_WRITTEN', reason_code: 'UNKNOWN_DOCUMENT' });
  }, 120_000);

  it('T3-NOM-11 — historique : le stock d’un lot volumineux est traité en plusieurs passages, sans perte ni double examen, puis stable', async () => {
    process.env.T3_NAMING_MAX_DOCUMENTS_PER_CALL = '6';
    process.env.T3_NAMING_MAX_CALLS_PER_PASS = '2';
    const c = await make.account();
    const mois = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
    const docs = [];
    for (let i = 0; i < 12; i++) docs.push(await document(c, { nom: `orange ${mois[i]} 2023`, date: `2023-${String(i + 1).padStart(2, '0')}-10` }));
    const attendu = Object.fromEntries(docs.map((x, i) => [x.id, `Facture Orange — ${mois[i]} 2023`]));
    // L'IA tente aussi de « réviser » les références déjà harmonisées (même passage ou passage précédent) : refusé.
    modele.decider = (lot, ds) => {
      const r = proposer(attendu)(lot, ds);
      const revisions = ds.filter((x) => x.role === 'REFERENCE' && x.nameOrigin === 'T3_HARMONIZATION').map((x) => ({
        document_id: x.documentId, expected_current_name: x.currentName, proposed_name: `${x.currentName} (révisé)`, reference_document_ids: [], reason: 'révision', confidence: 'certain',
      }));
      return { ...r, document_renames: [...r.document_renames, ...revisions] };
    };
    const examines: number[] = [];
    let passages = 0;
    for (; passages < 6; passages++) {
      const avant = modele.appels.length;
      const run = await passer(c.id, 'scheduled');
      const nouveaux = modele.appels.slice(avant);
      expect(nouveaux.length).toBeLessThanOrEqual(2);
      for (const a of nouveaux) {
        expect(a.docs.length).toBeLessThanOrEqual(6);
        expect(a.docs.some((x) => x.role === 'REFERENCE')).toBe(true);
        examines.push(...a.docs.filter((x) => x.role === 'TO_EXAMINE').map((x) => x.documentId));
      }
      if (run.documentNaming?.groupsCompleted) break;
      expect(run.documentNaming?.deferred).toBeGreaterThan(0);
    }
    expect(passages).toBeGreaterThan(0);
    // Lot 72B (E7) : un document fourni en RÉFÉRENCE n'est jamais renommé — motif explicite, avant même le délai de stabilité.
    expect((await evenements(c.id)).filter((e) => e.reason_code === 'REFERENCE_NOT_RENAMABLE').length).toBeGreaterThan(0);
    expect(examines.sort((a, b) => a - b)).toEqual(docs.map((x) => x.id).sort((a, b) => a - b));
    for (const x of docs) expect(await nom(x.id)).toBe(attendu[x.id]);
    const [g] = await sql<Array<{ status: string; progress: unknown }>>`SELECT status, progress FROM document_naming_groups WHERE account_id = ${c.id} AND group_key = 's:orange'`;
    expect(g).toMatchObject({ status: 'DONE', progress: null });
    const n = modele.appels.length;
    await passer(c.id, 'scheduled');
    expect(modele.appels.length).toBe(n);
    // Rapport d'un passage partiel : lot non terminé signalé (reprise au passage suivant).
    const partiels = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM ai_execution_report_entries e JOIN ai_execution_reports r ON r.id = e.report_id
       WHERE r.account_id = ${c.id} AND e.section = 'NAMING_GROUP' AND e.reason_code = 'PASS_CAP'`;
    expect(partiels[0].n).toBeGreaterThan(0);
  }, 180_000);

  it('T3-NOM-15 / T3-NOM-16 — version active du prompt sans la branche, ou sortie sans document_renames : aucun renommage, signalé ; repris dès qu’une version complète est active', async () => {
    await avecBranche(false);
    const { c, d } = await stockOrange();
    modele.decider = proposer({ [d.mars.id]: 'Facture Orange — mars 2024' });
    const run = await passer(c.id);
    expect(modele.appels).toHaveLength(0);
    // Lot 72B (E8) : travail non fait = DEFERRED, jamais DONE.
    expect(run.phases?.DOCUMENT_NAMING).toMatchObject({ status: 'DEFERRED', counts: { promptUnavailable: 1, applied: 0 } });
    expect(await nom(d.mars.id)).toBe('Facture_Orange_03-2024.pdf');
    const { r, lignes } = await rapport(c.id);
    expect(r.counters).toMatchObject({ promptUnavailable: 1, written: 0 });
    expect(lignes.find((l) => l.section === 'NAMING_GROUP')).toMatchObject({ write_result: 'NOT_EXAMINED', reason_code: 'PROMPT_WITHOUT_DOCUMENT_NAMING' });
    // Même version : aucun nouveau rapport à chaque passage.
    await passer(c.id, 'scheduled');
    expect((await rapport(c.id)).r.id).toBe(r.id);
    // Version complète, sortie SANS document_renames : aucune proposition, signalé.
    await avecBranche(true);
    modele.decider = () => ({ task: 'DOCUMENT_NAMING', families: [{ label: 'Factures Orange', document_ids: Object.values(d).map((x) => x.id) }] });
    const run2 = await passer(c.id);
    expect(run2.documentNaming).toMatchObject({ aiCalls: 1, renamesSectionMissing: 1, applied: 0 });
    expect((await rapport(c.id)).r.counters).toMatchObject({ renamesSectionMissing: 1, written: 0 });
    // Lot 72B (E9) : sortie incomplète = anomalie, lot NON clôturé, reprise bornée (délai).
    expect(run2.documentNaming?.status).not.toBe('DONE');
    expect((await sql<Array<{ status: string }>>`SELECT status FROM document_naming_groups WHERE account_id = ${c.id} AND group_key = 's:orange'`)[0].status).toBe('ERROR');
    // Puis, délai de reprise échu, une sortie complète sur un nouveau document : harmonisé.
    const neuf = await document(c, { nom: 'orange_juillet.pdf', original: 'orange_juillet.pdf', date: '2024-07-12' });
    modele.decider = proposer({ [neuf.id]: 'Facture Orange — juillet 2024' });
    await sql`UPDATE document_naming_groups SET retry_after = now() - interval '1 minute' WHERE account_id = ${c.id} AND group_key = 's:orange'`;
    await passer(c.id);
    expect(await nom(neuf.id)).toBe('Facture Orange — juillet 2024');
  }, 120_000);

  it('T3-NOM-12 / T3-NOM-17 — erreur isolée : une panne IA ou une phase en échec n’interrompt aucune autre mission T3 ; aucune Opération créée', async () => {
    const { c, d } = await stockOrange();
    modele.decider = () => new Error('fournisseur indisponible (e2e)');
    const run = await passer(c.id);
    expect(run.phases).toMatchObject({ ASSETS: { status: 'DONE' }, OPEN_KNOWLEDGE: { status: 'DONE' }, OPEN_ACTIONS: { status: 'DONE' }, JOURNAL: { status: 'DONE' } });
    // Lot 72B (E8) : lot en erreur sans aucun progrès = FAILED (le passage reste PARTIAL_SUCCESS : phase facultative).
    expect(run.phases?.DOCUMENT_NAMING?.status).toBe('FAILED');
    expect(run.outcome).toBe('PARTIAL_SUCCESS');
    expect(await nom(d.mars.id)).toBe('Facture_Orange_03-2024.pdf');
    const [g] = await sql<Array<{ status: string; retry_after: Date | null }>>`SELECT status, retry_after FROM document_naming_groups WHERE account_id = ${c.id} AND group_key = 's:orange'`;
    expect(g.status).toBe('ERROR');
    expect(g.retry_after).not.toBeNull();
    // Orchestrateur : une phase de nommage qui lève n'empêche pas les autres phases.
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    const engine = await import('@/services/ai/reconciliation/reconciliation-engine');
    const ok = await import('@/services/ai/reconciliation/continuous/open-knowledge.service');
    const oa = await import('@/services/ai/reconciliation/continuous/open-actions.service');
    const ko = await reconcileAccount(c.id, { type: 'scheduled' }, {}, {
      reconcile: (i) => engine.reconcileAsset(i), reconcileOpenKnowledge: ok.reconcileOpenKnowledge, reconcileOpenActions: oa.reconcileOpenToProcessActions,
      reconcileDocumentNaming: async () => { throw new Error('nommage en panne (e2e)'); },
    });
    expect(ko.phases).toMatchObject({ OPEN_KNOWLEDGE: { status: 'DONE' }, OPEN_ACTIONS: { status: 'DONE' }, DOCUMENT_NAMING: { status: 'FAILED' } });
    expect(ko.outcome).toBe('PARTIAL_SUCCESS');
    expect(ko.status).toBe('partial');
    expect((await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${c.id}`)[0].n).toBe(0);
  }, 120_000);

  it('T3-NOM-10 — cohérence : le nom harmonisé apparaît dans Documents, le bien, la recherche et les Opérations ; liens documentaires intacts', async () => {
    const { c, maison, d } = await stockOrange();
    // Lien document ↔ bien : créé avec le document (colonne `asset_id`), il doit rester intact.
    expect((await sql`SELECT 1 FROM document_asset_links WHERE file_id = ${d.mars.id} AND asset_id = ${maison.id} AND status = 'ACTIVE'`).length).toBe(1);
    const [op] = await sql<Array<{ id: number }>>`INSERT INTO business_operations (account_id, type_code, status) VALUES (${c.id}, 'CONTRACT', 'REALIZED') RETURNING id`;
    await sql`INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, source_role, authority)
              VALUES (${c.id}, ${op.id}, 'DOCUMENT', ${String(d.mars.id)}, 'INVOICE', 'DOCUMENT')`;
    const liens = async () => ({
      a: await sql`SELECT file_id, asset_id, status FROM document_asset_links WHERE file_id = ${d.mars.id} ORDER BY id`,
      o: await sql`SELECT operation_id, source_entity_key, active FROM business_operation_sources WHERE account_id = ${c.id} ORDER BY id`,
      ops: await sql`SELECT id, status, version, updated_at FROM business_operations WHERE account_id = ${c.id} ORDER BY id`,
    });
    const avant = await liens();
    modele.decider = proposer({ [d.mars.id]: 'Facture Orange — mars 2024' });
    await passer(c.id);
    expect(await nom(d.mars.id)).toBe('Facture Orange — mars 2024');
    expect(await liens()).toEqual(avant);
    const { listDocumentsGrouped } = await import('@/services/documents/document-query.service');
    expect(JSON.stringify(await listDocumentsGrouped({ accountId: c.id }))).toContain('Facture Orange — mars 2024');
    expect(JSON.stringify(await listDocumentsGrouped({ accountId: c.id, assetIds: [maison.id] }))).toContain('Facture Orange — mars 2024');
    const { globalSearch } = await import('@/services/search/global-search.service');
    const recherche = JSON.stringify(await globalSearch(c.id, 'Facture Orange mars'));
    expect(recherche).toContain('Facture Orange — mars 2024');
    const { BusinessOperationReadService } = await import('@/services/business-operations/read-service');
    const lus = JSON.stringify(await new BusinessOperationReadService().listForAssistant(c.id, { ids: [Number(op.id)], includeUntargeted: true }));
    expect(lus).toContain('Facture Orange — mars 2024');
  }, 120_000);

  it('T3-NOM-12 — migration 0450 rejouable ; balayage planifié : compte à documents sans bien repris pour son stock une seule fois', async () => {
    const mig = readFileSync(join(process.cwd(), 'src/db/migrations/0450_t3_document_naming.sql'), 'utf8');
    await sql.begin(async (tx) => { await tx.unsafe(mig); });
    await sql.begin(async (tx) => { await tx.unsafe(mig); });
    const c = await make.account();
    await document(c, { nom: 'Orange janvier 2024', date: '2024-01-10' });
    await document(c, { nom: 'Facture Orange 02/2024', date: '2024-02-10' });
    const { listSweepAccountsFromDb } = await import('@/services/ai/reconciliation/t3-queue');
    // Balayage planifié réel : un compte sans bien, avec des documents jamais examinés, est repris.
    const lister = async () => (await listSweepAccountsFromDb({ since: new Date(), afterAccountId: c.id - 1, limit: 1 })).filter((id) => id === c.id);
    expect(await lister()).toEqual([c.id]);
    modele.decider = (lot, docs) => proposer(Object.fromEntries(docs.map((x) => [x.documentId, `Facture Orange — ${x.documentDate === '2024-01-10' ? 'janvier' : 'février'} 2024`])))(lot, docs);
    await passer(c.id, 'scheduled');
    // Stock examiné (marqueur du compte) : le compte n'est plus repris à ce titre.
    expect((await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM document_naming_groups WHERE account_id = ${c.id} AND group_key = '*'`)[0].n).toBe(1);
    expect(await lister()).toEqual([]);
  }, 120_000);
});
