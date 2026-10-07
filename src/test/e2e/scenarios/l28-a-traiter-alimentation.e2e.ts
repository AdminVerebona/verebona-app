/**
 * Lot 28 (ticket P0) — alimentation fiable de « À traiter », sur base réelle.
 *
 * Chaîne de production : `analyzeFileSources` (T1 master, sortie rejouée) →
 * classement V2 → liens N-N → pont documentaire générique piloté par
 * `PROCESSING_RULES` → `to_process_actions` ; corrections depuis d'autres
 * écrans (colonnes, liens N-N, valeur validée) ; balayage
 * `/api/cron/to-process/scan` et tâche planifiée `to-process-scan` avec leur
 * trace (`to_process_scan_runs`).
 *
 * TEST-ATP-01 à TEST-ATP-12 du ticket + non-régression (compteur = page,
 * annulation d'un arbitrage, DOC-RUB, disparition après résolution).
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { analyserDocument, sortieT1, useTargetState, type FaitT1 } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
// La base E2E est déjà migrée par le harnais : la route n'a rien à rejouer.
vi.mock('@/db', async (o) => ({ ...(await o<object>()), ensureMigrations: async () => {} }));

interface Ligne {
  id: number; public_id: string; rule_code: string; action_kind: string; active: boolean;
  resolution_reason: string | null; cycle_number: number; proposals: Array<{ value: unknown; label: string; isCurrentValue?: boolean }>;
}

scenario('L28-ATP', 'À traiter : production réelle, déduplication, résolution depuis tous les écrans, balayage tracé', ({ sql, make, useRecordings }) => {
  useTargetState();

  type Compte = { id: number; ownerUserId: number };
  // Lot 31B : sans bien certain, T3 DOCUMENT_ASSET reprend (file vidée par
  // `analyserDocument`) ; la question LINK-ASSET naît de son abstention.
  const T3_ABSTENTION = { operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [] }, repeat: true };
  const analyser = (compte: Compte, fileId: number, output: Record<string, unknown>, linkedAssetId: number | null = null) =>
    analyserDocument(sql, useRecordings, { accountId: compte.id, userId: compte.ownerUserId, fileId, linkedAssetId, output, extra: [T3_ABSTENTION] });

  const actions = async (fileId: number, rule?: string): Promise<Ligne[]> => (await sql<Ligne[]>`
    SELECT id, public_id, rule_code, action_kind, resolved_at IS NULL AS active, resolution_reason, cycle_number,
           proposals_json AS proposals
      FROM to_process_actions
     WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND (${rule ?? null}::text IS NULL OR rule_code = ${rule ?? null})
     ORDER BY id`).map((l) => ({ ...l, proposals: (typeof l.proposals === 'string' ? JSON.parse(l.proposals) : l.proposals) ?? [] }));
  const actives = async (fileId: number, rule?: string) => (await actions(fileId, rule)).filter((a) => a.active);
  const compteur = async (accountId: number) => {
    const { countActiveActions } = await import('@/services/to-process/to-process-action.service');
    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    const page = await getToProcessPage(accountId);
    return { pastille: await countActiveActions(accountId), page: page.total, cartes: page.actions };
  };
  const valeurDoc = async (fileId: number, key: string) => (await sql<{ v: string | null; u: boolean; o: string }[]>`
    SELECT value_text AS v, user_validated AS u, origin AS o FROM document_field_values WHERE file_id = ${fileId} AND field_key = ${key}`)[0];

  /** Sortie T1 d'un document (classement certain : DOC-RUB / DOC-TYP écrits). */
  const sortie = (p: { type: string; rubric: string; assets?: Array<{ id: number; label: string }>; facts?: FaitT1[]; supplier?: string; multiAsset?: boolean }) =>
    sortieT1({
      title: `Document ${p.type}`, date: '2026-03-14', documentTypeCode: p.type, rubricCode: p.rubric,
      assets: p.assets ?? [], facts: p.facts ?? [], supplier: p.supplier ?? null, multiAsset: p.multiAsset ?? false,
    });
  const dateFait = (canonicalKey: string, value: string, assetId: number, excerpt: string): FaitT1 =>
    ({ canonicalKey, value, valueType: 'date', excerpt, assetId });

  // ── LINK-ASSET ──────────────────────────────────────────────────────────

  it('TEST-ATP-01 — document sans bien et sans candidat : 1 action active LINK-ASSET / COMPLETE (compteur = page)', async () => {
    const compte = await make.account();
    await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison non citée' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ type: 'MAINTENANCE_INVOICE', rubric: 'MAINTENANCE_WORKS' }));

    const a = await actives(doc.id, 'LINK-ASSET');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action_kind: 'COMPLETE', cycle_number: 1 });
    const c = await compteur(compte.id);
    expect(c.pastille).toBe(c.page);
    expect(c.cartes.map((x) => x.ruleCode)).toContain('LINK-ASSET');
  });

  it('TEST-ATP-02 / TEST-ATP-05 — deux biens plausibles : ARBITRATE, propositions exploitables ; réanalyse = une seule action', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const studio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio' });
    const doc = await make.assetFile(compte, { assetId: null });
    const out = sortie({ type: 'MAINTENANCE_INVOICE', rubric: 'MAINTENANCE_WORKS', assets: [{ id: maison.id, label: 'Maison' }, { id: studio.id, label: 'Studio' }] });
    await analyser(compte, doc.id, out);

    const [a] = await actives(doc.id, 'LINK-ASSET');
    expect(a).toMatchObject({ action_kind: 'ARBITRATE' });
    expect(a.proposals.map((p) => Number(p.value)).sort()).toEqual([maison.id, studio.id].sort());
    expect(a.proposals.map((p) => p.label).sort()).toEqual(['Maison', 'Studio']);
    // Jamais écrit automatiquement.
    expect((await sql`SELECT asset_id FROM asset_files WHERE id = ${doc.id}`)[0].asset_id).toBeNull();

    // TEST-ATP-05 : la même analyse rejouée deux fois → toujours UNE action active, mise à jour.
    const vu = async () => new Date((await sql<{ t: string }[]>`SELECT last_seen_at AS t FROM to_process_actions WHERE id = ${a.id}`)[0].t).getTime();
    const vuAvant = await vu();
    await new Promise((r) => setTimeout(r, 20));
    await analyser(compte, doc.id, out);
    await analyser(compte, doc.id, out);
    const toutes = await actions(doc.id, 'LINK-ASSET');
    expect(toutes).toHaveLength(1);
    expect(toutes[0]).toMatchObject({ id: a.id, active: true, cycle_number: 1 });
    expect(await vu()).toBeGreaterThan(vuAvant); // mise à jour, pas duplication
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${doc.id} AND resolved_at IS NULL`;
    expect(n).toBe(1);

    // Les deux biens cités restent des liens MENTIONED : ils ne rattachent pas.
    const cites = await sql<{ link_role: string }[]>`
      SELECT link_role FROM document_asset_links WHERE file_id = ${doc.id} AND status = 'ACTIVE'`;
    expect(cites.every((l) => l.link_role === 'MENTIONED')).toBe(true);

    // Non-régression : arbitrage depuis la carte, puis annulation (même action rouverte, même cycle).
    const { resolveArbitration, undoArbitration } = await import('@/services/to-process/resolve-action.service');
    const res = await resolveArbitration(compte.id, a.public_id, studio.id, { userId: compte.ownerUserId });
    expect(res).toMatchObject({ ok: true, previousValue: null });
    const [apres] = await actions(doc.id, 'LINK-ASSET');
    expect(apres).toMatchObject({ active: false, resolution_reason: 'USER_ARBITRATED' });
    expect((await sql`SELECT asset_id FROM asset_files WHERE id = ${doc.id}`)[0].asset_id).toBe(studio.id);
    expect(await undoArbitration(compte.id, a.public_id, res.previousValue)).toMatchObject({ ok: true });
    expect((await actions(doc.id, 'LINK-ASSET'))).toEqual([expect.objectContaining({ id: a.id, active: true, cycle_number: 1 })]);
    expect((await sql`SELECT asset_id FROM asset_files WHERE id = ${doc.id}`)[0].asset_id).toBeNull();

    // TEST-ATP-04 (bien seulement cité, choisi depuis un autre écran) : la
    // colonne seule suffit à fermer l'action, à l'instant.
    await sql`UPDATE asset_files SET asset_id = ${maison.id} WHERE id = ${doc.id}`;
    expect(await actives(doc.id, 'LINK-ASSET')).toEqual([]);
  });

  it('TEST-ATP-03 — bien identifié avec certitude : rattachement automatique, 0 action LINK-ASSET', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ type: 'MAINTENANCE_INVOICE', rubric: 'MAINTENANCE_WORKS', assets: [{ id: clio.id, label: 'Clio' }] }));

    expect((await sql`SELECT asset_id FROM asset_files WHERE id = ${doc.id}`)[0].asset_id).toBe(clio.id);
    expect(await actions(doc.id, 'LINK-ASSET')).toEqual([]);
    const liens = await sql<{ asset_id: number; link_role: string }[]>`
      SELECT asset_id, link_role FROM document_asset_links WHERE file_id = ${doc.id} AND status = 'ACTIVE'`;
    expect(liens.map((l) => [Number(l.asset_id), l.link_role])).toEqual([[clio.id, 'PRIMARY']]);
  });

  it('TEST-ATP-04 — rattachement depuis un autre écran : action fermée immédiatement, page et compteur à jour ; réapparition au détachement', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ type: 'MAINTENANCE_INVOICE', rubric: 'MAINTENANCE_WORKS' }));
    const [a] = await actives(doc.id, 'LINK-ASSET');
    expect(a).toBeDefined();
    const avant = await compteur(compte.id);

    // Tiroir document (PUT /api/documents/[id]) : écriture de la colonne
    // asset_id. Le déclencheur 0257 ferme l'action dans la même instruction.
    await sql`UPDATE asset_files SET asset_id = ${maison.id} WHERE id = ${doc.id}`;
    expect((await actions(doc.id, 'LINK-ASSET'))[0]).toMatchObject({ active: false, resolution_reason: 'USER_COMPLETED' });
    const apres = await compteur(compte.id);
    expect(apres.pastille).toBe(avant.pastille - 1);
    expect(apres.page).toBe(apres.pastille);
    expect(apres.cartes.map((x) => x.publicId)).not.toContain(a.public_id);

    // Détachement par l'utilisateur, puis réévaluation (même chemin que le tiroir) :
    // le problème réapparaît — nouveau cycle, jamais deux cartes.
    await sql`UPDATE asset_files SET asset_id = NULL WHERE id = ${doc.id}`;
    const { onDocumentEditedByUser } = await import('@/services/to-process/document-rule-bridge');
    await onDocumentEditedByUser(compte.id, doc.id);
    const cycle2 = await actives(doc.id, 'LINK-ASSET');
    expect(cycle2).toEqual([expect.objectContaining({ action_kind: 'COMPLETE', cycle_number: 2 })]);

    // Autre écran : lien N-N posé par le service des liens (fiche équipement,
    // assistant…) — fermé aussi.
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    await linkDocumentToAsset({ accountId: compte.id, fileId: doc.id, target: { assetId: maison.id }, role: 'PRIMARY', origin: 'USER' });
    expect(await actives(doc.id, 'LINK-ASSET')).toEqual([]);
  });

  // ── Données documentaires ───────────────────────────────────────────────

  it('TEST-ATP-06 — contrat sans date de fin (COMPLETE), puis preuve fiable : donnée écrite, action fermée', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: maison.id });
    const assets = [{ id: maison.id, label: 'Maison' }];
    await analyser(compte, doc.id, sortie({ type: 'MAINTENANCE_CONTRACT', rubric: 'CONTRACTS_WARRANTIES_DOCS', assets }), maison.id);
    expect(await actives(doc.id, 'DATA-CONTRACT-END')).toEqual([expect.objectContaining({ action_kind: 'COMPLETE' })]);

    await analyser(compte, doc.id, sortie({
      type: 'MAINTENANCE_CONTRACT', rubric: 'CONTRACTS_WARRANTIES_DOCS', assets,
      facts: [dateFait('contractEndDate', '2027-06-30', maison.id, 'Fin du contrat : 30/06/2027')],
    }), maison.id);
    expect(await valeurDoc(doc.id, 'contractEndDate')).toMatchObject({ v: '2027-06-30', u: false });
    expect(await actives(doc.id, 'DATA-CONTRACT-END')).toEqual([]);
    expect((await actions(doc.id, 'DATA-CONTRACT-END'))[0]).toMatchObject({ resolution_reason: 'OBSOLETE' });
  });

  it('TEST-ATP-07 — valeur utilisateur contredite : jamais écrasée, ARBITRATE ; résolution depuis la carte', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: maison.id });
    const { recordUserDocumentValue } = await import('@/services/to-process/document-rule-bridge');
    expect(await recordUserDocumentValue(compte.id, doc.id, 'warrantyEndDate', '2027-12-31')).toBe(true);

    await analyser(compte, doc.id, sortie({
      type: 'WARRANTY_CERTIFICATE', rubric: 'CONTRACTS_WARRANTIES_DOCS', assets: [{ id: maison.id, label: 'Maison' }],
      facts: [dateFait('warrantyEndDate', '2028-01-31', maison.id, 'Garantie valable jusqu’au 31/01/2028')],
    }), maison.id);
    expect(await valeurDoc(doc.id, 'warrantyEndDate')).toMatchObject({ v: '2027-12-31', u: true, o: 'USER' });
    const [a] = await actives(doc.id, 'DATA-WARRANTY-END');
    expect(a).toMatchObject({ action_kind: 'ARBITRATE' });
    expect(a.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: '2028-01-31' }),
      expect.objectContaining({ value: '2027-12-31', isCurrentValue: true }),
    ]));

    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    expect(await resolveArbitration(compte.id, a.public_id, '2028-01-31', { userId: compte.ownerUserId }))
      .toMatchObject({ ok: true, previousValue: '2027-12-31' });
    expect(await valeurDoc(doc.id, 'warrantyEndDate')).toMatchObject({ v: '2028-01-31', u: true });
    expect(await actives(doc.id, 'DATA-WARRANTY-END')).toEqual([]);
  });

  it('TEST-ATP-08 / TEST-ATP-09 — champs optionnels absents, completePriority = null : aucune action', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const doc = await make.assetFile(compte, { assetId: clio.id });
    await analyser(compte, doc.id, sortie({ type: 'MAINTENANCE_INVOICE', rubric: 'MAINTENANCE_WORKS', assets: [{ id: clio.id, label: 'Clio' }] }), clio.id);
    // Facture : ni fin de contrat, ni fin de garantie attendues ; fournisseur
    // absent sans proposition ; rattachement secondaire facultatif.
    expect(await actions(doc.id)).toEqual([]);
    // Le balayage n'en crée pas davantage.
    const { runToProcessFullScan } = await import('@/services/to-process/to-process-scan.job');
    await runToProcessFullScan({ accountId: compte.id, trigger: 'manual' });
    expect(await actions(doc.id)).toEqual([]);
  });

  it('TEST-ATP-10 — contrat à deux dates de fin plausibles : ARBITRATE / DATA-CONTRACT-END, rien n’est écrit', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: maison.id });
    await analyser(compte, doc.id, sortie({
      type: 'MAINTENANCE_CONTRACT', rubric: 'CONTRACTS_WARRANTIES_DOCS', assets: [{ id: maison.id, label: 'Maison' }],
      facts: [
        dateFait('contractEndDate', '2027-06-30', maison.id, 'Échéance du contrat : 30/06/2027'),
        dateFait('contractEndDate', '2028-06-30', maison.id, 'Fin de l’engagement : 30/06/2028'),
      ],
    }), maison.id);
    const [a] = await actives(doc.id, 'DATA-CONTRACT-END');
    expect(a).toMatchObject({ action_kind: 'ARBITRATE', rule_code: 'DATA-CONTRACT-END' });
    expect(a.proposals.map((p) => p.value).sort()).toEqual(['2027-06-30', '2028-06-30']);
    expect(await valeurDoc(doc.id, 'contractEndDate')).toBeUndefined();
  });

  it('TEST-ATP-11 — garantie sans date exploitable : COMPLETE / DATA-WARRANTY-END, complétée sur la carte', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: maison.id });
    await analyser(compte, doc.id, sortie({ type: 'WARRANTY_CERTIFICATE', rubric: 'CONTRACTS_WARRANTIES_DOCS', assets: [{ id: maison.id, label: 'Maison' }] }), maison.id);
    const [a] = await actives(doc.id, 'DATA-WARRANTY-END');
    expect(a).toMatchObject({ action_kind: 'COMPLETE' });
    // La carte offre la saisie directe d'une date.
    const c = await compteur(compte.id);
    expect(c.cartes.find((x) => x.publicId === a.public_id)?.inputType).toBe('date');

    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    expect(await resolveArbitration(compte.id, a.public_id, 'pas une date')).toMatchObject({ ok: false, error: 'INVALID_VALUE' });
    expect(await resolveArbitration(compte.id, a.public_id, '2029-05-01', { userId: compte.ownerUserId })).toMatchObject({ ok: true });
    expect(await valeurDoc(doc.id, 'warrantyEndDate')).toMatchObject({ v: '2029-05-01', u: true, o: 'USER' });
    expect(await actives(doc.id)).toEqual([]);

    // Une réanalyse sans date ne rouvre rien : la valeur utilisateur répond.
    await analyser(compte, doc.id, sortie({ type: 'WARRANTY_CERTIFICATE', rubric: 'CONTRACTS_WARRANTIES_DOCS', assets: [{ id: maison.id, label: 'Maison' }] }), maison.id);
    expect((await sql`SELECT analysis_state FROM asset_files WHERE id = ${doc.id}`)[0].analysis_state).toBe('ANALYZED');
    expect(await actives(doc.id, 'DATA-WARRANTY-END')).toEqual([]);
  });

  it('DATA-SUPPLIER — fournisseur saisi dans le tiroir puis contredit : arbitrage, fermé quand l’utilisateur corrige', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const doc = await make.assetFile(compte, { assetId: clio.id });
    await sql`UPDATE asset_files SET supplier = 'Garage Martin', user_edited_fields = '{"supplier": true}'::jsonb WHERE id = ${doc.id}`;
    await analyser(compte, doc.id, sortie({ type: 'MAINTENANCE_INVOICE', rubric: 'MAINTENANCE_WORKS', assets: [{ id: clio.id, label: 'Clio' }], supplier: 'Garage Dupont' }), clio.id);
    expect((await sql`SELECT supplier FROM asset_files WHERE id = ${doc.id}`)[0].supplier).toBe('Garage Martin');
    const [a] = await actives(doc.id, 'DATA-SUPPLIER');
    expect(a).toMatchObject({ action_kind: 'ARBITRATE' });

    // Correction depuis le tiroir (même valeur que la proposition) → fermée.
    await sql`UPDATE asset_files SET supplier = 'Garage Dupont' WHERE id = ${doc.id}`;
    const { onDocumentEditedByUser } = await import('@/services/to-process/document-rule-bridge');
    await onDocumentEditedByUser(compte.id, doc.id);
    expect(await actives(doc.id, 'DATA-SUPPLIER')).toEqual([]);
  });

  it('Valeur corrigée dans le tiroir (propositions d’analyse) : enregistrée comme saisie utilisateur, action fermée', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: maison.id });
    await analyser(compte, doc.id, sortie({ type: 'MAINTENANCE_CONTRACT', rubric: 'CONTRACTS_WARRANTIES_DOCS', assets: [{ id: maison.id, label: 'Maison' }] }), maison.id);
    expect(await actives(doc.id, 'DATA-CONTRACT-END')).toHaveLength(1);
    const { recordUserDocumentValue, onDocumentEditedByUser } = await import('@/services/to-process/document-rule-bridge');
    // Clé d'écran alias (« dateFinContrat ») ramenée à la clé canonique.
    expect(await recordUserDocumentValue(compte.id, doc.id, 'dateFinContrat', '2030-01-15')).toBe(true);
    await onDocumentEditedByUser(compte.id, doc.id);
    expect(await actives(doc.id, 'DATA-CONTRACT-END')).toEqual([]);
    expect((await actions(doc.id, 'DATA-CONTRACT-END'))[0]).toMatchObject({ resolution_reason: 'USER_COMPLETED' });
  });

  // ── Balayage ────────────────────────────────────────────────────────────

  it('TEST-ATP-12 — /api/cron/to-process/scan : état détecté → action créée ; état corrigé → action fermée ; passage tracé', async () => {
    process.env.CRON_SECRET = 'e2e-cron';
    const compte = await make.account();
    // État créé DIRECTEMENT en base, sans analyse : document terminé sans bien,
    // échéance sans date.
    const doc = await make.assetFile(compte, { assetId: null });
    await sql`UPDATE asset_files SET analysis_state = 'ANALYZED' WHERE id = ${doc.id}`;
    const evt = await make.agendaItem(compte, { title: 'Ramonage' });
    expect(await actions(doc.id)).toEqual([]);

    const { GET } = await import('@/app/api/cron/to-process/scan/route');
    const appeler = async () => {
      const res = await GET(new NextRequest(`http://localhost/api/cron/to-process/scan?account=${compte.id}`, {
        headers: { authorization: 'Bearer e2e-cron' },
      }));
      expect(res.status).toBe(200);
      return res.json() as Promise<{ accounts: number; created: number; closed: number; errors: number; runId: number }>;
    };
    expect((await GET(new NextRequest('http://localhost/api/cron/to-process/scan'))).status).toBe(401);

    const r1 = await appeler();
    expect(r1).toMatchObject({ accounts: 1, errors: 0 });
    expect(r1.created).toBeGreaterThanOrEqual(2);
    expect(await actives(doc.id, 'LINK-ASSET')).toEqual([expect.objectContaining({ action_kind: 'COMPLETE' })]);
    const agendaActif = async () => (await sql`
      SELECT 1 FROM to_process_actions WHERE target_type = 'AGENDA_ITEM' AND target_id = ${evt.id} AND resolved_at IS NULL`).length;
    expect(await agendaActif()).toBe(1);

    // Rejouer sans changement : rien de neuf (déduplication).
    const r2 = await appeler();
    expect(r2.created).toBe(0);

    // Correction de l'état, puis relance : actions fermées.
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    await sql`UPDATE asset_files SET asset_id = ${maison.id} WHERE id = ${doc.id}`;
    await sql`UPDATE agenda_items SET start_date = '2026-11-02' WHERE id = ${evt.id}`;
    const r3 = await appeler();
    expect(r3.closed).toBeGreaterThanOrEqual(1);
    expect(await actives(doc.id, 'LINK-ASSET')).toEqual([]);
    expect(await agendaActif()).toBe(0);

    // Trace consultable (BO Exploitation) : dernier scan, comptes, créées, fermées, erreurs.
    const { listToProcessScanRuns } = await import('@/services/to-process/to-process-scan.job');
    const runs = await listToProcessScanRuns(50);
    const trace = runs.find((r) => r.id === r1.runId);
    expect(trace).toMatchObject({ trigger: 'route', status: 'ok', accounts: 1, errors: 0, created: r1.created });
    expect(trace?.finishedAt).not.toBeNull();
    expect(runs.find((r) => r.id === r3.runId)?.closed).toBe(r3.closed);
  });

  it('TEST-ATP-12 bis — tâche planifiée interne `to-process-scan` : exécutée, tracée, distincte des notifications', async () => {
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const tache = SCHEDULED_TASKS.find((t) => t.code === 'to-process-scan')!;
    const notif = SCHEDULED_TASKS.find((t) => t.code === 'notifications-to-process-scan')!;
    expect(tache.schedule).toEqual({ kind: 'interval', everyMs: 3_600_000 });
    expect(tache.critical).toBeDefined();
    expect(notif).toBeDefined();
    expect(notif.code).not.toBe(tache.code);

    // Ne balayer que les comptes de ce scénario : le passage complet partage la
    // base avec les autres fichiers ; on borne au délai.
    const r = await tache.run({ deadline: Date.now() + 20_000, trigger: 'manual' });
    expect(r && 'note' in r ? r.note : '').toMatch(/"accounts":\d+/);
    const { listToProcessScanRuns } = await import('@/services/to-process/to-process-scan.job');
    const [dernier] = await listToProcessScanRuns(1);
    expect(dernier).toMatchObject({ trigger: 'manual' });
    expect(['ok', 'partial']).toContain(dernier.status);
    expect(dernier.finishedAt).not.toBeNull();
  });

  // ── Non-régression ──────────────────────────────────────────────────────

  it('non-régression DOC-RUB : document que l’analyse ne sait pas classer → À compléter (rubrique), compteur = page', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const doc = await make.assetFile(compte, { assetId: clio.id });
    const out = sortie({ type: 'MAINTENANCE_INVOICE', rubric: 'MAINTENANCE_WORKS', assets: [{ id: clio.id, label: 'Clio' }] });
    delete ((out.document as Record<string, unknown>).classification);
    await analyser(compte, doc.id, out, clio.id);
    const regles = (await actives(doc.id)).map((a) => a.rule_code);
    expect(regles).toContain('DOC-RUB');
    expect(regles).not.toContain('LINK-ASSET');
    const c = await compteur(compte.id);
    expect(c.pastille).toBe(c.page);
  });

  it('document supprimé : ses actions se ferment (TARGET_DELETED) au balayage', async () => {
    const compte = await make.account();
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, sortie({ type: 'MAINTENANCE_INVOICE', rubric: 'MAINTENANCE_WORKS' }));
    expect(await actives(doc.id, 'LINK-ASSET')).toHaveLength(1);
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${doc.id}`;
    const { runToProcessFullScan } = await import('@/services/to-process/to-process-scan.job');
    await runToProcessFullScan({ accountId: compte.id, trigger: 'manual' });
    expect(await actives(doc.id)).toEqual([]);
    expect((await actions(doc.id, 'LINK-ASSET'))[0].resolution_reason).toBe('TARGET_DELETED');
  });
});
