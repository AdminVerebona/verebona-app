/**
 * Carte #813 (lot 116G) — bon de commande d'accessoire : nommage précis,
 * opération, absence d'Agenda et de questions inutiles — PostgreSQL 16 réel.
 *
 * Cas reproduit : bon de commande de l'accessoire « Polisport groovy coussin
 * gris », rattaché au vélo « Jean Fourche ». Fournisseur d'IA SIMULÉ : la
 * sortie du modèle est écrite ici (classification « bon de commande », titre,
 * candidat ACQUISITION de rôle « facture » réalisé — la sortie qui produit le
 * cas réel), aucun appel réseau.
 *
 * Chemins de PRODUCTION : barrière T1 (`gateOperationCandidates`), persistance
 * T1 (`replaceOperationCandidates`), titre (`ensureBusinessTitle`, données de
 * nommage persistées), consolidation T3 (`consolidateAccountOperations`, M3
 * coupé), projection T4 (`projectAccountOperations`), producteur « À traiter »
 * (`produceAgendaActions`), page de l'opération, Timeline du bien, coût de
 * possession (`readAssetTco`), rattachement explicite (`linkDocument`),
 * contrôles de cohérence (projection, titres), reprise du stock
 * (`repriseOrderOnlyPurchases`).
 *
 *   L116G-E2E-01  bon seul daté : noms exacts, bien associé, date de COMMANDE sourcée, aucun événement, aucune carte (critères 1, 2)
 *   L116G-E2E-02  bon sans date : opération et document conservés, « sans date », aucune question (critère 3)
 *   L116G-E2E-03  bon puis facture concordante : même opération enrichie, un seul coût, événement d'achat légitime au titre descriptif (critères 4, 7)
 *   L116G-E2E-04  photo et garantie rattachées : identité et nom propres, aucun événement, aucune opération nouvelle (critère 5)
 *   L116G-E2E-05  deux achats distincts pour le même vélo : aucune fusion, titres différenciés (critère 6)
 *   L116G-E2E-06  bon avec livraison programmée : aucun « Achat » ; l'événement de livraison décidé par T4 n'est ni absorbé ni renommé (critère 8)
 *   L116G-E2E-07  DIAGNOSTIC + stock : état « avant » (événement « Achat » sans date, carte), reprise à blanc puis réelle, idempotence, non-recréation (critère 9)
 *   L116G-E2E-08  titres et intitulés corrigés par l'utilisateur : jamais réécrits ; date et prix d'achat du vélo intacts (critère 10)
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';
import { gateOperationCandidates, type AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const AUJ = '2026-11-17';
const DESIGNATION = 'Polisport groovy coussin gris';
const TITRE_BON = `Bon de commande ${DESIGNATION}`;
const NOM_ACHAT = `Achat ${DESIGNATION}`;

scenario('L116G', 'Bon de commande d’accessoire : noms précis, opération, aucun événement « Achat », aucune question inutile (carte #813)', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const projection = () => import('@/services/business-operations/agenda-projection/service');

  // ── Outils ────────────────────────────────────────────────────────────────
  async function compteVelo(): Promise<{ compte: AccountRow & { owner: { id: number } }; velo: AssetRow }> {
    const compte = await make.account({ plan: 'premium' });
    const velo = await make.asset(compte, { category: 'OBJET', name: 'Jean Fourche' });
    await make.asset(compte, { category: 'OBJET', name: 'Tondeuse' }); // plusieurs biens : le nom du bien pourrait « discriminer » un titre
    return { compte, velo };
  }
  /** Sortie SIMULÉE du modèle pour un candidat, passée par la barrière serveur T1 réelle. */
  function barriere(typeDocument: string | null, brut: AnchoredOperationCandidate): AnchoredOperationCandidate[] {
    return gateOperationCandidates([brut], {
      hasExploitableContent: true, documentTypeCode: typeDocument,
      verifiedIds: { ASSET: new Set(brut.targetHints.flatMap((t) => (t.entityId ? [t.entityId] : []))), EQUIPMENT: new Set(), ROOM: new Set() },
      capabilities: { rooms: false, equipments: false }, keptFactRefs: new Set(['f1']),
    }).candidates;
  }
  /** Candidat tel que le modèle l'a rendu dans le cas réel : achat « réalisé », rôle « facture », sur un bon de commande. */
  const candidatModele = (veloId: number, over: Partial<AnchoredOperationCandidate> = {}) => cand({
    typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', summary: 'Coussin pour siège enfant', provider: 'Cycles Exemple',
    targetHints: [cible(veloId)], businessReferences: [ref('ORDER', 'CMD-2026-0042')] as never,
    financialHints: [fh('REALIZED_COST', 2490)], ...over,
  });
  /** Analyse T1 d'un document (modèle simulé) : type, date, titre proposé, candidats (barrière réelle sauf `brut`), puis titre métier. */
  async function analyser(compte: AccountRow, veloId: number | null, o: {
    type: string; titreModele: string; date: string | null; candidats: AnchoredOperationCandidate[]; brut?: boolean; montant?: number | null; fournisseur?: string | null;
  }): Promise<number> {
    const candidats = o.brut ? o.candidats : o.candidats.flatMap((c) => barriere(o.type, c));
    const id = await k.document(compte, veloId, candidats, { type: o.type, amountCents: o.montant ?? 2490, date: o.date ?? undefined });
    const fournisseur = o.fournisseur === undefined ? 'Cycles Exemple' : o.fournisseur;
    await sql`UPDATE asset_files SET supplier = ${fournisseur}, title_source = 'SYSTEM', last_analysis_at = now(), original_filename = ${`scan-${id}.pdf`} WHERE id = ${id}`;
    await sql`UPDATE document_extractions SET title = ${o.titreModele}, supplier_name = ${fournisseur}, document_date = ${o.date} WHERE file_id = ${id}`;
    const raw = { task: 'ANALYZE_DOCUMENT', document: {
      title: { value: o.titreModele, confidence: 'certain' }, type: { value: o.type, confidence: 'certain' },
      ...(fournisseur ? { supplier: { value: { name: fournisseur }, confidence: 'certain' } } : {}),
      ...(o.date ? { date: { value: o.date, confidence: 'certain' } } : {}),
    } };
    await sql`INSERT INTO document_analysis_runs (asset_file_id, input_file_hash, prompt_version, provider, model, status, is_current_reference, account_id, raw_response_json)
              VALUES (${id}, ${`h${id}`}, 't1_master_v1@file', 'replay', 'm', 'completed', true, ${compte.id}, ${JSON.stringify(raw)})`;
    await titrer(compte, id, 'refresh');
    return id;
  }
  async function titrer(compte: AccountRow, fileId: number, mode: 'refresh' | 'repair') {
    const { ensureBusinessTitle } = await import('@/services/documents/document-title.service');
    return ensureBusinessTitle({ fileId, accountId: compte.id, origin: mode === 'refresh' ? 'T1' : 'T3', mode });
  }
  const bon = (compte: AccountRow, veloId: number, o: { date?: string | null; candidat?: Partial<AnchoredOperationCandidate>; titre?: string; brut?: boolean } = {}) =>
    analyser(compte, veloId, { type: 'ACQUISITION_ORDER', titreModele: o.titre ?? TITRE_BON, date: o.date === undefined ? '2026-11-12' : o.date,
      candidats: [candidatModele(veloId, o.candidat)], brut: o.brut });
  const passer = (compte: AccountRow) => k.passer(compte, { today: AUJ });
  const projeter = async (compte: AccountRow, o: { dryRun?: boolean } = {}) =>
    (await projection()).projectAccountOperations(compte.id, { all: true, today: AUJ, correlationId: 'e2e-116g', ...o });
  const cartes = async (compte: AccountRow) => {
    const { produceAgendaActions } = await import('@/services/to-process/producers.service');
    await produceAgendaActions(compte.id, { trigger: 'SWEEP' });
    return sql<Json[]>`SELECT id::int AS id, target_id::int AS item, question, resolved_at IS NOT NULL AS resolu, resolution_reason
                         FROM to_process_actions WHERE account_id = ${compte.id} AND target_type = 'AGENDA_ITEM' ORDER BY id`;
  };
  /** Chaîne complète après analyse : T3, T4, « À traiter ». */
  async function chaine(compte: AccountRow) {
    await passer(compte);
    await projeter(compte);
    return cartes(compte);
  }
  const achats = (compte: AccountRow) => sql<Json[]>`
    SELECT o.id::int AS id, o.status, o.technical_label AS label, o.planned_date::text AS planned, o.start_date::text AS start,
           o.realized_date::text AS realized, o.end_date::text AS fin,
           (o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS active
      FROM business_operations o WHERE o.account_id = ${compte.id} AND o.type_code = 'ACQUISITION' ORDER BY o.id`;
  const actifs = async (compte: AccountRow) => (await achats(compte)).filter((o) => o.active);
  const evenements = (compte: AccountRow) => sql<Json[]>`
    SELECT ai.id, ai.title, ai.start_date::text AS date, ai.business_operation_id::int AS op, ai.event_nature AS nature, ai.business_type,
           ai.projection_origin AS origine, ai.is_automatic_modified AS modifie
      FROM agenda_items ai WHERE ai.account_id = ${compte.id} ORDER BY ai.id`;
  const document = async (id: number) => (await sql<Json[]>`
    SELECT retained_title AS titre, title_source, document_type_code AS type, document_date::text AS date, title_basis ->> 'subject' AS designation,
           deleted_at IS NULL AS present FROM asset_files WHERE id = ${id}`)[0];
  const periodes = async (compte: AccountRow) => (await sql<Json[]>`SELECT count(*)::int AS n FROM document_business_periods WHERE account_id = ${compte.id}`)[0].n;
  const page = async (compte: AccountRow, op: number) => {
    const { readReferenceEventPage } = await import('@/services/business-operations/graph/reference-event-page');
    return (await readReferenceEventPage(compte.id, op))!;
  };
  const timeline = async (compte: AccountRow, assetId: number) => {
    const { readAssetTimelineAll } = await import('@/services/agenda/timeline/read');
    return (await readAssetTimelineAll({ accountId: compte.id, assetId, today: AUJ })) as unknown as Json[];
  };
  const tco = async (compte: AccountRow, assetId: number) => {
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    return readAssetTco(compte.id, assetId, { today: AUJ }) as unknown as Promise<Json>;
  };
  const facture = (compte: AccountRow, veloId: number, o: { date?: string; candidat?: Partial<AnchoredOperationCandidate>; titre?: string } = {}) =>
    analyser(compte, veloId, { type: 'ACQUISITION_INVOICE', titreModele: o.titre ?? `Facture ${DESIGNATION}`, date: o.date ?? '2026-11-18',
      candidats: [candidatModele(veloId, { temporalHints: { realizedDate: o.date ?? '2026-11-18' }, financialHints: [fh('REALIZED_COST', 2490, { economicDate: o.date ?? '2026-11-18' })], ...o.candidat })] });

  // ══ 01 ═══════════════════════════════════════════════════════════════════

  it('L116G-E2E-01 — bon seul daté : « Bon de commande Polisport groovy coussin gris », « Achat Polisport groovy coussin gris », vélo associé, date de COMMANDE, aucun événement, aucune carte, aucune période', async () => {
    const { compte, velo } = await compteVelo();
    const f = await bon(compte, velo.id);
    // Document : type réel + désignation, exactement — ni date, ni fournisseur, ni nom du vélo.
    expect(await document(f)).toMatchObject({ titre: TITRE_BON, title_source: 'SYSTEM', type: 'ACQUISITION_ORDER', date: '2026-11-12', designation: DESIGNATION });
    const c = await chaine(compte);
    // Opération : une seule, envisagée (commande ≠ réalisation), nommée par la désignation ; aucune date de réalisation, de paiement ni de livraison.
    const [op, ...autres] = await actifs(compte);
    expect(autres).toEqual([]);
    expect(op).toMatchObject({ status: 'ENVISAGED', label: NOM_ACHAT, realized: null, planned: null, start: null, fin: null });
    // Le rôle proposé par le modèle (« facture ») est conservé tel quel : c'est le TYPE du document (bon de commande) qui fait la règle.
    expect((await k.sources(op.id)).filter((s) => s.active)).toEqual([expect.objectContaining({ source_kind: 'DOCUMENT', source_entity_key: String(f), source_role: 'INVOICE' })]);
    expect((await k.liens(op.id)).map((l) => l.asset_id)).toEqual([velo.id]);
    // Montant : tel que T1 l'a qualifié, une seule fois (le coût de possession existant n'est pas modifié par cette carte).
    expect((await k.composantes(op.id)).map((x) => [x.kind, x.amount_minor])).toEqual([['REALIZED_COST', 2490]]);
    // Agenda et « À traiter » : rien.
    expect(await evenements(compte)).toEqual([]);
    expect(c).toEqual([]);
    expect(await periodes(compte)).toBe(0);
    // Fiche de l'opération : titre, bien associé, date de commande SOURCÉE par le bon (repère), aucune date propre.
    const p = await page(compte, op.id);
    expect(p).toMatchObject({ title: NOM_ACHAT, ownLabel: NOM_ACHAT, dates: [], undated: false, agendaItems: [],
      presentation: { date: '2026-11-12', basis: 'FIRST_ORDER', label: 'Date de commande' } });
    expect(p.assets.map((a) => a.name)).toEqual(['Jean Fourche']);
    expect(p.documents).toEqual([expect.objectContaining({ fileId: f, title: TITRE_BON, date: '2026-11-12' })]);
    // Timeline du vélo : même titre, même repère ; aucun élément d'Agenda.
    const tl = await timeline(compte, velo.id);
    expect(tl.filter((e) => e.kind === 'group').map((e) => [e.title, e.effectiveDate, e.dateBasis])).toEqual([[NOM_ACHAT, '2026-11-12', 'FIRST_ORDER']]);
    // Le vélo lui-même : ni date ni prix d'achat touchés.
    const [fiche] = await sql<Json[]>`SELECT key_characteristics::jsonb ->> 'acquisitionDate' AS d, key_characteristics::jsonb ->> 'acquisitionPrice' AS p FROM assets WHERE id = ${velo.id}`;
    expect(fiche).toEqual({ d: null, p: null });
    // Repassages T3 / T4 / « À traiter » : rien ne change, rien n'est créé.
    const avant = await k.historique(compte);
    expect(await chaine(compte)).toEqual([]);
    expect(await evenements(compte)).toEqual([]);
    expect(await k.historique(compte)).toBe(avant);
    expect((await projeter(compte, { dryRun: true })).plans ?? []).toEqual([]);
  });

  // ══ 02 ═══════════════════════════════════════════════════════════════════

  it('L116G-E2E-02 — bon sans date : document et opération conservés, « sans date », aucune question, aucun événement', async () => {
    const { compte, velo } = await compteVelo();
    const f = await bon(compte, velo.id, { date: null });
    expect(await document(f)).toMatchObject({ titre: TITRE_BON, date: null, present: true });
    expect(await chaine(compte)).toEqual([]);
    const [op] = await actifs(compte);
    expect(op).toMatchObject({ status: 'ENVISAGED', label: NOM_ACHAT, realized: null, planned: null });
    expect(await evenements(compte)).toEqual([]);
    const p = await page(compte, op.id);
    expect(p).toMatchObject({ title: NOM_ACHAT, undated: true, dates: [] });
    expect(p.presentation?.date ?? null).toBeNull();
    const toutes = await sql<Json[]>`SELECT rule_code, question FROM to_process_actions WHERE account_id = ${compte.id} AND resolved_at IS NULL AND question ILIKE '%date%'`;
    expect(toutes).toEqual([]);
  });

  // ══ 03 ═══════════════════════════════════════════════════════════════════

  it('L116G-E2E-03 — bon puis facture concordante : MÊME opération enrichie, un seul coût, réalisée à la date de la facture ; événement légitime au titre descriptif, sans question', async () => {
    const { compte, velo } = await compteVelo();
    const fb = await bon(compte, velo.id);
    await chaine(compte);
    const [avant] = await actifs(compte);
    const ff = await facture(compte, velo.id);
    expect(await document(ff)).toMatchObject({ type: 'ACQUISITION_INVOICE' });
    expect((await document(ff)).titre).toMatch(/^Facture Polisport groovy coussin gris/);
    expect((await document(fb)).titre).toBe(TITRE_BON); // le bon garde son nom : il n'est pas renommé « Facture » ni « Achat »
    const c = await chaine(compte);
    const tous = await actifs(compte);
    expect(tous.map((o) => o.id)).toEqual([avant.id]);
    expect(tous[0]).toMatchObject({ status: 'REALIZED', realized: '2026-11-18', label: NOM_ACHAT });
    expect((await k.sources(avant.id)).filter((s) => s.active).map((s) => [s.source_entity_key, s.source_role])).toEqual([[String(fb), 'INVOICE'], [String(ff), 'INVOICE']]);
    // Une seule dépense : dès que la facture prouve la réalisation, le montant du bon est celui d'une commande (prévisionnel).
    expect((await k.composantes(avant.id)).map((x) => [x.kind, x.amount_minor]).sort()).toEqual([['FORECAST_COST', 2490], ['REALIZED_COST', 2490]]);
    expect(await k.coutNet(avant.id)).toBe(2490);
    expect(JSON.stringify(await tco(compte, velo.id)).match(/"includedCents":2490/g)?.length ?? 0).toBeLessThanOrEqual(1);
    // Achat réellement réalisé (preuve : facture) : UN événement historique, daté de la facture, titre descriptif — jamais « Achat » nu.
    const evts = await evenements(compte);
    expect(evts).toEqual([expect.objectContaining({ title: NOM_ACHAT, date: '2026-11-18', op: avant.id, nature: 'HISTORICAL', business_type: 'purchase' })]);
    expect(c).toEqual([]);
    // La date de commande reste lisible (document du bon) ; le repère de l'opération est désormais la réalisation.
    expect((await page(compte, avant.id)).presentation).toMatchObject({ date: '2026-11-18', basis: 'REALIZED' });
    // Idempotence.
    await chaine(compte);
    expect((await evenements(compte)).length).toBe(1);
    expect((await actifs(compte)).length).toBe(1);
  });

  // ══ 04 ═══════════════════════════════════════════════════════════════════

  it('L116G-E2E-04 — photo et garantie rattachées ensuite : mêmes fichiers, noms propres, aucune opération ni événement créés par elles', async () => {
    const { compte, velo } = await compteVelo();
    await bon(compte, velo.id);
    await chaine(compte);
    const [op] = await actifs(compte);
    // Photo et certificat de garantie analysés : types non métier → aucun candidat établi, aucune opération propre.
    const photo = await analyser(compte, velo.id, { type: 'PHOTO', titreModele: 'Photo coussin Polisport installé', date: null, fournisseur: null, montant: null,
      candidats: [candidatModele(velo.id, { summary: 'Photo du coussin' })] });
    const garantie = await analyser(compte, velo.id, { type: 'WARRANTY_CERTIFICATE', titreModele: 'Garantie Polisport groovy', date: '2026-11-18', montant: null,
      candidats: [candidatModele(velo.id, { summary: 'Garantie du coussin' })] });
    await chaine(compte);
    expect((await actifs(compte)).map((o) => o.id)).toEqual([op.id]);
    // Rattachement EXPLICITE par le geste existant de la fiche (aucune nouvelle mécanique).
    const { linkDocument } = await import('@/services/business-operations/operation-write.facade');
    const ctx = { accountId: compte.id, actor: { kind: 'USER' as const, userId: compte.owner.id, channel: 'UI' as const } };
    for (const fileId of [photo, garantie]) expect((await linkDocument(ctx, { operationId: op.id, fileId })).status).toBe('APPLIED');
    const p = await page(compte, op.id);
    expect(p.documents.map((d) => d.fileId).sort((a, b) => a - b)).toEqual([...p.documents.map((d) => d.fileId)].sort((a, b) => a - b));
    expect(p.documents.map((d) => d.fileId)).toEqual(expect.arrayContaining([photo, garantie]));
    expect(p.title).toBe(NOM_ACHAT);
    // Chaque document garde son identité et son nom (jamais « Achat… »), aucun fichier dupliqué.
    expect((await document(photo)).titre).not.toMatch(/^Achat/);
    expect((await document(garantie)).titre).toMatch(/^Garantie/);
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${compte.id} AND deleted_at IS NULL`)[0].n).toBe(3);
    // Toujours une commande seule comme PREUVE : ni statut réalisé, ni événement, ni carte.
    const c = await chaine(compte);
    expect((await actifs(compte))[0]).toMatchObject({ id: op.id, status: 'ENVISAGED', realized: null });
    expect(await evenements(compte)).toEqual([]);
    expect(c).toEqual([]);
  });

  // ══ 05 ═══════════════════════════════════════════════════════════════════

  it('L116G-E2E-05 — deux achats distincts pour le même vélo : aucune fusion sur le seul bien, titres différenciés par leur objet', async () => {
    const { compte, velo } = await compteVelo();
    const a = await bon(compte, velo.id);
    const b = await bon(compte, velo.id, { date: '2026-11-14', titre: 'Bon de commande Antivol Abus Bordo 6000',
      candidat: { summary: 'Antivol pliant', provider: 'Vélo Station', businessReferences: [ref('ORDER', 'VS-778')] as never, financialHints: [fh('REALIZED_COST', 8900)] } });
    expect(await chaine(compte)).toEqual([]);
    const ops = await actifs(compte);
    expect(ops.map((o) => o.label)).toEqual([NOM_ACHAT, 'Achat Antivol Abus Bordo 6000']);
    expect(ops.every((o) => o.status === 'ENVISAGED')).toBe(true);
    expect((await document(a)).titre).toBe(TITRE_BON);
    expect((await document(b)).titre).toBe('Bon de commande Antivol Abus Bordo 6000');
    expect(await evenements(compte)).toEqual([]);
    // La facture du coussin rejoint SON achat, pas l'autre.
    await facture(compte, velo.id);
    await chaine(compte);
    const apres = await actifs(compte);
    expect(apres.map((o) => [o.label, o.status])).toEqual([[NOM_ACHAT, 'REALIZED'], ['Achat Antivol Abus Bordo 6000', 'ENVISAGED']]);
    expect((await evenements(compte)).map((e) => e.title)).toEqual([NOM_ACHAT]);
  });

  // ══ 06 ═══════════════════════════════════════════════════════════════════

  it('L116G-E2E-06 — bon avec livraison programmée explicite : aucun « Achat » ; l’événement de livraison (décision T4 du document) reste seul, ni absorbé ni renommé', async () => {
    const { compte, velo } = await compteVelo();
    const f = await bon(compte, velo.id, { candidat: { temporalHints: { plannedDate: '2026-11-25' } } });
    // Événement de nature appropriée créé par T4 depuis le document (décision simulée : livraison annoncée le 25/11).
    const [liv] = await sql<Json[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, origin_ref_type, origin_ref_id, home_category)
      VALUES (${compte.id}, 'Livraison Polisport groovy coussin gris', '2026-11-25', true, 'qualified_document', 'asset_file', ${f}, 'action') RETURNING id`;
    await sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${liv.id}, ${velo.id})`;
    const c = await chaine(compte);
    const [op] = await actifs(compte);
    // La date de livraison annoncée est une date PRÉVUE distincte ; elle n'est ni la date de commande ni une réalisation.
    expect(op).toMatchObject({ status: 'ENVISAGED', planned: '2026-11-25', realized: null });
    expect((await page(compte, op.id)).presentation).toMatchObject({ date: '2026-11-12', basis: 'FIRST_ORDER' });
    const evts = await evenements(compte);
    expect(evts).toEqual([expect.objectContaining({ id: liv.id, title: 'Livraison Polisport groovy coussin gris', date: '2026-11-25', op: null })]);
    expect(evts.some((e) => /^Achat/.test(e.title) || e.business_type === 'purchase')).toBe(false);
    expect(c).toEqual([]);
    expect(await periodes(compte)).toBe(0);
  });

  // ══ 07 ═══════════════════════════════════════════════════════════════════

  it('L116G-E2E-07 — diagnostic et stock : candidat « facture réalisé » persisté sur un bon de commande → événement « Achat » sans date + carte ; reprise à blanc, puis réelle ; idempotente ; aucune recréation', async () => {
    const { compte, velo } = await compteVelo();
    // ÉTAT « AVANT » (compte réel) : le candidat a été persisté tel que le modèle l'a rendu (rôle « facture », réalisé, sans
    // date de réalisation ni montant daté) et T3 l'a consolidé AVANT que la règle de commande s'applique — reproduit en
    // consolidant pendant que le document n'est pas encore classé, puis en posant son type réel (bon de commande).
    const f = await analyser(compte, velo.id, { type: 'ACQUISITION_ORDER', titreModele: TITRE_BON, date: '2026-11-12', brut: true,
      candidats: [candidatModele(velo.id, { financialHints: [fh('REALIZED_COST', 2490)] })] });
    await sql`UPDATE asset_files SET document_type_code = NULL WHERE id = ${f}`;
    await passer(compte);
    const [stock] = await actifs(compte);
    expect(stock).toMatchObject({ status: 'REALIZED', realized: null }); // cause : réalisation admise sur la foi du seul rôle proposé
    // Second achat du stock (même cause), dont l'utilisateur modifiera l'événement : il devra être conservé.
    const f2 = await analyser(compte, velo.id, { type: 'ACQUISITION_ORDER', titreModele: 'Bon de commande Antivol Abus Bordo 6000', date: '2026-11-14', brut: true,
      candidats: [candidatModele(velo.id, { summary: 'Antivol pliant', provider: 'Vélo Station', businessReferences: [ref('ORDER', 'VS-778')] as never, financialHints: [fh('REALIZED_COST', 8900)] })] });
    await sql`UPDATE asset_files SET document_type_code = NULL WHERE id = ${f2}`;
    await passer(compte);
    await projeter(compte);
    const stock2 = (await actifs(compte)).find((o) => o.id !== stock.id)!;
    await sql`UPDATE agenda_items SET title = 'Achat' WHERE account_id = ${compte.id} AND business_operation_id = ${stock.id}`; // intitulé générique d'avant la carte
    await sql`UPDATE agenda_items SET title = 'Mon antivol', is_automatic_modified = true WHERE account_id = ${compte.id} AND business_operation_id = ${stock2.id}`;
    await sql`UPDATE asset_files SET document_type_code = 'ACQUISITION_ORDER' WHERE id IN ${sql([f, f2])}`;
    const evt = (await evenements(compte)).find((e) => e.op === stock.id)!;
    expect(evt).toMatchObject({ title: 'Achat', date: null, op: stock.id, nature: 'HISTORICAL', business_type: 'purchase', origine: 'OPERATION' });
    // Carte du cas réel : posée par le producteur EXISTANT dès la création de l'élément sans date (chemin : projection
    // d'opération → élément créé sans date → carte DATA-AGENDA-DATE). Sa question est remise au texte d'avant la carte.
    const carteStock = await sql<Json[]>`SELECT id::int AS id, rule_code, question FROM to_process_actions
      WHERE account_id = ${compte.id} AND target_type = 'AGENDA_ITEM' AND target_id = ${evt.id} AND resolved_at IS NULL`;
    expect(carteStock).toEqual([expect.objectContaining({ rule_code: 'DATA-AGENDA-DATE' })]);
    expect(carteStock[0].question).toMatch(/^À quelle date « .+ » a-t-il eu lieu \?$/);
    await sql`UPDATE to_process_actions SET question = 'À quelle date « Achat » a-t-il lieu ?' WHERE id = ${carteStock[0].id}`;
    const avantReprise = { docs: (await sql<Json[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${compte.id} AND deleted_at IS NULL`)[0].n, ops: (await actifs(compte)).length };

    // À BLANC : rapport, aucune écriture.
    const { repriseOrderOnlyPurchases } = await import('@/services/business-operations/agenda-projection/order-only-reprise');
    const blanc = await repriseOrderOnlyPurchases(compte.id, { today: AUJ });
    expect(blanc).toMatchObject({ applied: false, toRemove: 1, keptUserTouched: 1, openCards: 2, removed: 0, cardsClosed: 0, reconsolidationChanges: 0 });
    expect(blanc.operations.map((o) => o.operationId)).toEqual([stock.id, stock2.id]);
    expect(blanc.operations[0].items).toEqual([expect.objectContaining({ itemId: evt.id, title: 'Achat', date: null, action: 'REMOVE' })]);
    expect((await evenements(compte)).length).toBe(2);
    expect((await actifs(compte)).find((o) => o.id === stock.id)).toMatchObject({ status: 'REALIZED' });
    // Le contrôle de cohérence existant voit le même écart (projection rejouée à blanc).
    const sim = await projeter(compte, { dryRun: true });
    expect(sim.plans?.find((p) => p.operationId === stock.id)).toMatchObject({ decision: 'ORDER_ONLY_EVIDENCE', actions: [{ kind: 'REMOVE', itemId: evt.id, reason: 'ORDER_ONLY_EVIDENCE' }] });

    // RÉEL.
    const reel = await repriseOrderOnlyPurchases(compte.id, { apply: true, today: AUJ });
    expect(reel).toMatchObject({ applied: true, removed: 1, cardsClosed: 1 });
    const evts = await evenements(compte);
    expect(evts).toEqual([expect.objectContaining({ title: 'Mon antivol', op: stock2.id, modifie: true })]); // touché par l'utilisateur : conservé, lié
    // Retrait TRACÉ (restaurable), carte fermée comme obsolète — rien d'autre n'est perdu.
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_item_removals WHERE account_id = ${compte.id}`)[0].n).toBe(1);
    expect(await sql<Json[]>`SELECT resolved_at IS NOT NULL AS resolu, resolution_reason FROM to_process_actions WHERE account_id = ${compte.id} AND target_id = ${evt.id}`)
      .toEqual([{ resolu: true, resolution_reason: 'OBSOLETE' }]);
    const apres = await actifs(compte);
    expect(apres.length).toBe(avantReprise.ops);
    expect(apres.find((o) => o.id === stock.id)).toMatchObject({ status: 'ENVISAGED', realized: null, label: NOM_ACHAT });
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${compte.id} AND deleted_at IS NULL`)[0].n).toBe(avantReprise.docs);
    expect((await k.sources(stock.id)).filter((s) => s.active).length).toBe(1);
    expect((await k.liens(stock.id)).map((l) => l.asset_id)).toEqual([velo.id]);

    // IDEMPOTENCE et NON-RECRÉATION : second passage, T3, T4, « À traiter », projection simulée (contrôle de cohérence).
    const encore = await repriseOrderOnlyPurchases(compte.id, { apply: true, today: AUJ });
    expect(encore).toMatchObject({ toRemove: 0, removed: 0, reconsolidationChanges: 0 });
    const c = await chaine(compte);
    expect(c.filter((x) => !x.resolu && x.item !== evts[0].id)).toEqual([]);
    expect((await evenements(compte)).map((e) => e.id)).toEqual([evts[0].id]);
    expect((await projeter(compte, { dryRun: true })).plans?.some((p) => p.actions.some((a) => a.kind === 'CREATE')) ?? false).toBe(false);
  });

  // ══ 08 ═══════════════════════════════════════════════════════════════════

  it('L116G-E2E-08 — corrections de l’utilisateur respectées (titre du document, intitulé de l’opération) ; reprise d’un titre antérieur ; fiche du vélo intacte', async () => {
    const { compte, velo } = await compteVelo();
    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify({ acquisitionDate: '2024-05-02', acquisitionDate__origin: 'USER', acquisitionPrice: 1200, acquisitionPrice__origin: 'USER' })} WHERE id = ${velo.id}`;
    const f = await bon(compte, velo.id);
    await chaine(compte);
    const op = (await actifs(compte)).find((o) => o.label === NOM_ACHAT)!;
    // Titre antérieur (règles v4) : date du bon et fournisseur ajoutés par défaut → recomposé par le rattrapage (version des règles).
    await sql`UPDATE asset_files SET retained_title = ${`${TITRE_BON} Cycles Exemple — 12 novembre 2026`}, title_rule_version = 4 WHERE id = ${f}`;
    expect(await titrer(compte, f, 'repair')).toMatchObject({ outcome: 'UPDATED', reason: 'DESIGNATION_TITLE_APPLIED', newTitle: TITRE_BON });
    expect(await titrer(compte, f, 'repair')).toMatchObject({ outcome: 'NO_CHANGE' });
    // Titre corrigé par l'utilisateur : jamais réécrit.
    await sql`UPDATE asset_files SET retained_title = 'Commande coussin de Jean', title_source = 'USER' WHERE id = ${f}`;
    expect((await titrer(compte, f, 'repair')).outcome).toBe('SKIP_USER_TITLE');
    expect((await document(f)).titre).toBe('Commande coussin de Jean');
    // Intitulé de l'opération corrigé par l'utilisateur (geste existant de la fiche) : T3 ne le remplace pas.
    const { correctOperation } = await import('@/services/business-operations/operation-write.facade');
    const r = await correctOperation({ accountId: compte.id, actor: { kind: 'USER', userId: compte.owner.id, channel: 'UI' } }, { operationId: op.id, label: 'Coussin de Jean' });
    expect(r.status).toBe('APPLIED');
    const { reconsolidateOperations } = await import('@/services/business-operations/consolidation/consolidator');
    await reconsolidateOperations(compte.id, [op.id], { today: AUJ });
    await chaine(compte);
    expect((await actifs(compte)).find((o) => o.id === op.id)).toMatchObject({ label: 'Coussin de Jean', status: 'ENVISAGED' });
    expect((await page(compte, op.id)).title).toBe('Achat — Coussin de Jean');
    expect((await evenements(compte)).filter((e) => e.op === op.id)).toEqual([]);
    // Le vélo : date et prix d'achat saisis intacts ; la commande du coussin n'est pas l'achat du vélo.
    const [fiche] = await sql<Json[]>`SELECT key_characteristics::jsonb ->> 'acquisitionDate' AS d, key_characteristics::jsonb ->> 'acquisitionPrice' AS p FROM assets WHERE id = ${velo.id}`;
    expect(fiche).toEqual({ d: '2024-05-02', p: '1200' });
  });
});
