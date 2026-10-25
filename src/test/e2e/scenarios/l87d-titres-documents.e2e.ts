/**
 * Lot 87D — chantier 87D, sur PostgreSQL 16 :
 *   · ticket P1 « Documents — Uniformiser les titres des factures périodiques
 *     et fiabiliser leur affichage dans toute l'application » ;
 *   · ticket PO « Supprimer type en anglais / technique sur les documents ».
 *
 *   L87D-E2E-01  import (fin d'analyse T1 réelle) : « Facture Homiris — Février 2026 » ;
 *                données de nommage persistées ; MÊME titre liste / fiche / recherche ;
 *                numéro de facture recherchable (absent du titre) ;
 *   L87D-E2E-02  stock Homiris (titres v2 et noms T3 hétérogènes) repris par le contrôle
 *                COH-DOC-TITLES : à blanc sans écriture, correctif par le service de nommage,
 *                mois principal IA exploité quand il existe, période exacte sinon ; reprise
 *                IDEMPOTENTE (second passage : aucun renommage, aucun événement) ;
 *   L87D-E2E-03  titre manuel préservé (contrôle et nouvelle analyse) ; ses données de
 *                nommage sont tenues à jour (numéro recherchable) ;
 *   L87D-E2E-04  deux factures distinctes du même mois : titres distincts, déterministes,
 *                aucune fusion ;
 *   L87D-E2E-05  aucun rattachement, montant, date, candidat ni élément d'Agenda modifié ;
 *   L87D-E2E-06  période ambiguë (deux échéances), pluriannuelle, chevauchement d'année :
 *                aucun mois inventé ;
 *   L87D-E2E-07  aucun code technique visible (cas de la capture « BUILDING_PERMIT ») :
 *                fiche, Mes documents, recherche, aperçu du bien, fournisseur.
 *
 * Date de référence injectée (24/10/2026, jour > 12). Assertions bornées aux
 * comptes créés ici.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState } from '../chain';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow } from '../factories';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    tryGetSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const AUJOURDHUI = '2026-10-24';
const MAINTENANT = new Date('2026-10-24T09:30:00Z');
const CHECK = 'COH-DOC-TITLES';

/** Échéance d'abonnement Homiris (période facturée, portée INSTALLMENT). */
const echeance = (assetId: number, debut: string, fin: string, facture: string | null, montant = 3990) => cand({
  typeHint: 'INTERVENTION', provider: 'Homiris', summary: 'Abonnement télésurveillance', sourceRoleHint: 'INVOICE',
  targetHints: [cible(assetId)],
  businessReferences: (facture ? [ref('INVOICE', facture), ref('CUSTOMER', 'CL-778 812')] : [ref('CUSTOMER', 'CL-778 812')]) as never,
  temporalHints: { startDate: debut, endDate: fin },
  financialHints: [fh('REALIZED_COST', montant, { amountScope: 'INSTALLMENT', economicDate: debut, periodStart: debut, periodEnd: fin })],
});

scenario('L87D', 'Titres homogènes des factures périodiques, même titre partout, aucun code technique visible', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1'] });
  const kit = operationsKit(sql, make);

  // ── Outils ───────────────────────────────────────────────────────────────
  const compteAvecMaison = async () => {
    const c = await make.account();
    const maison = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    return { c, maison };
  };
  /** Facture du stock : connaissance T1 persistée (candidats, extraction), titre automatique historique. */
  const factureStock = async (c: AccountRow, assetId: number, o: {
    titre: string; debut: string; fin: string; facture: string | null; emise: string; source?: 'SYSTEM' | 'USER'; fournisseur?: string;
    echeances?: Array<[string, string]>;
  }) => {
    const candidats = (o.echeances ?? [[o.debut, o.fin]]).map(([d, f], i) => ({ ...echeance(assetId, d, f, o.facture), candidateKey: `op${i + 1}` }));
    const id = await kit.document(c, assetId, candidats, { type: 'INVOICE', title: o.titre, amountCents: 3990, date: o.emise });
    await sql`UPDATE asset_files SET supplier = ${o.fournisseur ?? 'HOMIRIS'}, document_type = 'FACTURE', title_source = ${o.source ?? 'SYSTEM'},
                     title_rule_version = 2, title_context_fingerprint = 'v2', title_checked_at = now() - interval '2 days',
                     last_analysis_at = now() - interval '3 days', original_filename = ${`facture-${o.facture ?? 'x'}.pdf`}
               WHERE id = ${id}`;
    await sql`UPDATE document_extractions SET title = 'Facture Homiris', supplier_name = ${o.fournisseur ?? 'HOMIRIS'},
                     document_date = ${o.emise}, metadata = ${JSON.stringify({ legacyDocumentType: 'FACTURE' })}::jsonb WHERE file_id = ${id}`;
    return id;
  };
  /** Sortie T1 future (demande 87D-mois-principal-factures) : mois principal décidé par l'IA. */
  const runAvecMoisPrincipal = async (c: AccountRow, fileId: number, mois: string, debut: string, fin: string) => {
    const raw = { task: 'ANALYZE_DOCUMENT', document: {
      title: { value: 'Facture Homiris', confidence: 'certain' }, supplier: { name: 'HOMIRIS', confidence: 'certain' },
      billingPeriod: { start: debut, end: fin, principalMonth: mois, principalMonthBasis: 'MAJORITY_OF_PERIOD', confidence: 'certain', evidence: { quote: `Abonnement du ${debut} au ${fin}`, page: 1 } },
    } };
    await sql`INSERT INTO document_analysis_runs (asset_file_id, input_file_hash, prompt_version, provider, model, status, is_current_reference, account_id, raw_response_json)
              VALUES (${fileId}, ${`h${fileId}`}, 't1_master_v1@file', 'replay', 'm', 'completed', true, ${c.id}, ${JSON.stringify(raw)})`;
  };
  const fichier = async (id: number) => (await sql<Json[]>`
    SELECT retained_title, title_source, title_basis, title_convention, title_canonical_key, title_rule_version,
           amount_cents, document_date::text AS document_date, asset_id, linked_asset_id
      FROM asset_files WHERE id = ${id}`)[0];
  const evenements = (id: number) => sql<Json[]>`SELECT origin, outcome, reason, old_title, new_title FROM document_title_events WHERE file_id = ${id} ORDER BY id`;
  async function campagne(c: AccountRow, mode: 'DRY_RUN' | 'CORRECTIVE') {
    const o = await import('@/services/coherence/orchestrator');
    const id = await o.startCampaign({ kind: 'MANUAL', trigger: 'e2e', mode, scopeAccountIds: [c.id], now: MAINTENANT });
    for (let i = 0; i < 30; i++) {
      const r = await o.runCampaignStep(id, { deadline: Date.now() + 120_000, now: MAINTENANT, today: AUJOURDHUI });
      if (r.done) break;
    }
    return (await o.getCampaign(id))!;
  }
  const reparations = (c: AccountRow) => sql<Json[]>`
    SELECT object_id::int AS object_id, service, outcome, anomaly FROM coherence_repairs WHERE account_id = ${c.id} AND check_id = ${CHECK} ORDER BY id`;
  const preuve = async (c: AccountRow, id: number) => (await sql<Json[]>`
    SELECT last_result FROM coherence_object_proofs WHERE account_id = ${c.id} AND check_id = ${CHECK} AND object_id = ${id}`)[0];

  /** Les quatre points d'affichage : liste (Mes documents), fiche (GET /api/files/:id), recherche globale (et ses suggestions). */
  const titreListe = async (c: AccountRow, id: number) => {
    const { getDocumentFeed } = await import('@/services/documents/rubric-query.service');
    const r = await getDocumentFeed({
      accountId: c.id, assetIds: [], sort: 'added', direction: 'desc', grouped: false,
      filters: { biens: [], rubrics: [], types: [] }, ids: null, limit: 100, cursor: null, withMeta: false,
    } as never);
    const items = ((r as Json).items ?? (r as Json).documents ?? (r as Json).groups?.flatMap((g: Json) => g.items) ?? []) as Json[];
    return items.find((d) => Number(d.id) === id) ?? null;
  };
  const fiche = async (c: AccountRow, id: number) => {
    session.userId = c.ownerUserId; session.currentAccountId = c.id;
    const { GET } = await import('@/app/api/files/[id]/route');
    const res = await GET(new NextRequest(`http://x/api/files/${id}`), { params: Promise.resolve({ id: String(id) }) });
    expect(res.status).toBe(200);
    return (await res.json()) as Json;
  };
  const recherche = async (c: AccountRow, q: string) => {
    const { globalSearch } = await import('@/services/search/global-search.service');
    return (await globalSearch(c.id, q)).results.filter((r: Json) => r.category === 'Document') as Json[];
  };
  const memeTitrePartout = async (c: AccountRow, id: number, attendu: string, requete: string) => {
    expect((await titreListe(c, id))?.title).toBe(attendu);
    expect((await fiche(c, id)).displayTitle).toBe(attendu);
    const r = (await recherche(c, requete)).find((x) => x.docId === id);
    expect(r?.label).toBe(attendu);
  };

  // ══ L87D-E2E-01 — import : fin d'analyse T1 réelle ══════════════════════
  it('L87D-E2E-01 — import (fin de T1) : « Facture Homiris — Février 2026 », données de nommage persistées, même titre liste / fiche / recherche, numéro de facture recherchable', async () => {
    const { c, maison } = await compteAvecMaison();
    const f = await make.assetFile(c, { assetId: maison.id });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = 'scan-0042.pdf', retained_title = 'scan-0042.pdf', analysis_state = NULL WHERE id = ${f.id}`;
    const sortie = sortieT1({
      title: 'Facture Homiris Alarme n° 94741358', date: '2026-02-06', documentTypeCode: 'INVOICE', canonicalType: 'FACTURE', rubricCode: 'PROPERTY_MANAGEMENT',
      supplier: 'HOMIRIS', amountCents: 3990, assets: [{ id: maison.id, label: 'Maison' }],
      facts: [{ canonicalKey: null, rawKey: 'montant', label: 'Montant TTC', value: 39.9, valueType: 'money_eur', excerpt: 'Montant TTC 39,90 €', assetId: maison.id }],
      texte: ['Facture n° 94741358', 'Période du 01/02/2026 au 28/02/2026'],
    });
    (sortie as Json).businessOperationCandidates = [{
      candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED',
      summary: 'Abonnement télésurveillance février 2026', sourceRoleHint: 'INVOICE', provider: 'Homiris',
      targetHints: [{ type: 'ASSET', entityId: maison.id, rawLabel: 'Maison', confidence: 'certain' }],
      businessReferences: [{ kind: 'INVOICE', value: '94741358' }],
      temporalHints: { startDate: '2026-02-01', endDate: '2026-02-28' },
      financialHints: [{ role: 'REALIZED_COST', amountMinor: 3990, currency: 'EUR', amountScope: 'INSTALLMENT', economicDate: '2026-02-06', periodStart: '2026-02-01', periodEnd: '2026-02-28', factIndex: 0 }],
      evidenceFactIndexes: [0],
    }];
    await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: sortie, repeat: true }]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([f.id], c.id, { userId: c.ownerUserId, linkedAssetId: maison.id, billable: false, origin: 'e2e/l87d' });
    expect(r?.results.length).toBe(1);
    await drainQueues();

    const d = await fichier(f.id);
    expect(d.retained_title).toBe('Facture Homiris — Février 2026');
    expect(d.title_source).toBe('SYSTEM');
    expect(d.title_convention).toBe('PERIODIC');
    expect(d.title_rule_version).toBe(3);
    expect(d.title_basis).toMatchObject({
      billedPeriod: { start: '2026-02-01', end: '2026-02-28', source: 'T1_INSTALLMENT' }, principalMonth: null,
      invoiceReferences: ['94741358'], issueDate: '2026-02-06', supplier: 'Homiris',
    });
    expect((await evenements(f.id)).at(-1)).toMatchObject({ origin: 'T1', outcome: 'UPDATED', new_title: 'Facture Homiris — Février 2026' });
    await memeTitrePartout(c, f.id, 'Facture Homiris — Février 2026', 'Homiris');
    // Numéro de facture : absent du titre, retrouvé par la recherche globale (données de nommage indexées).
    const parNumero = await recherche(c, '94741358');
    expect(parNumero.map((x) => x.docId)).toContain(f.id);
    expect(parNumero.find((x) => x.docId === f.id)?.label).toBe('Facture Homiris — Février 2026');
  });

  // ══ L87D-E2E-02 — stock Homiris : contrôle de cohérence ═════════════════
  it('L87D-E2E-02 — stock hétérogène repris par COH-DOC-TITLES : à blanc sans écriture ; correctif par le service de nommage ; mois IA exploité ; période exacte sinon ; reprise idempotente', async () => {
    const { c, maison } = await compteAvecMaison();
    const fev = await factureStock(c, maison.id, { titre: 'Facture Homiris _ Février à mars 2026', debut: '2026-02-05', fin: '2026-03-04', facture: '94741357', emise: '2026-02-06' });
    const mars = await factureStock(c, maison.id, { titre: 'Facture Homiris Alarme n° 94741358 – Mars à avril 2026', debut: '2026-03-05', fin: '2026-04-04', facture: '94741358', emise: '2026-03-06' });
    // Nom écrit par l'harmonisation T3 (DOCUMENT_NAMING) : la convention prévaut, T3 ne nomme plus ces documents.
    await sql`INSERT INTO document_rename_events (account_id, file_id, outcome, old_name, proposed_name, applied_name, idempotency_key)
              VALUES (${c.id}, ${mars}, 'APPLIED', 'x', 'Facture Homiris Alarme n° 94741358 – Mars à avril 2026',
                      'Facture Homiris Alarme n° 94741358 – Mars à avril 2026', ${`e2e-l87d-${mars}`})`;
    await runAvecMoisPrincipal(c, fev, '2026-02', '2026-02-05', '2026-03-04');

    // À blanc : diagnostic seulement.
    await campagne(c, 'DRY_RUN');
    expect((await fichier(fev)).retained_title).toBe('Facture Homiris _ Février à mars 2026');
    expect((await fichier(mars)).retained_title).toBe('Facture Homiris Alarme n° 94741358 – Mars à avril 2026');
    expect(await evenements(fev)).toHaveLength(0);
    expect((await preuve(c, fev))?.last_result).toBe('WOULD_REPAIR');

    // Correctif : réparation par le service de nommage (origine COHERENCE), traçable.
    await campagne(c, 'CORRECTIVE');
    expect((await fichier(fev)).retained_title).toBe('Facture Homiris — Février 2026');
    expect((await fichier(fev)).title_basis.principalMonth).toMatchObject({ value: '2026-02', basis: 'MAJORITY_OF_PERIOD', source: 'T1_BILLING_PERIOD' });
    // Sans mois principal décidé par l'IA : période exacte (jamais « Mars 2026 » déduit du premier jour).
    expect((await fichier(mars)).retained_title).toBe('Facture Homiris — 5 mars au 4 avril 2026');
    expect((await evenements(fev)).at(-1)).toMatchObject({ origin: 'COHERENCE', outcome: 'UPDATED', old_title: 'Facture Homiris _ Février à mars 2026' });
    const rep = await reparations(c);
    expect(rep.filter((x) => x.service === 'ensureBusinessTitle').map((x) => x.object_id)).toEqual(expect.arrayContaining([fev, mars]));
    await memeTitrePartout(c, mars, 'Facture Homiris — 5 mars au 4 avril 2026', 'Homiris');

    // Idempotence : second passage — aucun renommage, aucun nouvel événement, aucune réparation.
    const nEv = (await evenements(fev)).length + (await evenements(mars)).length;
    const nRep = (await reparations(c)).length;
    await campagne(c, 'CORRECTIVE');
    expect((await evenements(fev)).length + (await evenements(mars)).length).toBe(nEv);
    expect((await reparations(c)).length).toBe(nRep);
    expect((await preuve(c, fev))?.last_result).toBe('CONSISTENT');
    // Le service relancé à la main n'écrit rien non plus.
    const { ensureBusinessTitle } = await import('@/services/documents/document-title.service');
    expect((await ensureBusinessTitle({ fileId: mars, accountId: c.id, origin: 'COHERENCE', mode: 'repair' })).outcome).toBe('NO_CHANGE');
  });

  // ══ L87D-E2E-03 — titre manuel ═══════════════════════════════════════════
  it('L87D-E2E-03 — titre manuel préservé (contrôle correctif, nouvelle analyse) ; ses données de nommage sont tenues à jour (numéro recherchable)', async () => {
    const { c, maison } = await compteAvecMaison();
    const id = await factureStock(c, maison.id, { titre: 'Mon alarme — février', debut: '2026-02-01', fin: '2026-02-28', facture: '55500011', emise: '2026-02-06', source: 'USER' });
    await campagne(c, 'CORRECTIVE');
    const { ensureBusinessTitle } = await import('@/services/documents/document-title.service');
    const r = await ensureBusinessTitle({ fileId: id, accountId: c.id, origin: 'T1', mode: 'refresh' });
    expect(r.outcome).toBe('SKIP_USER_TITLE');
    const d = await fichier(id);
    expect(d.retained_title).toBe('Mon alarme — février');
    expect(d.title_source).toBe('USER');
    expect(d.title_basis.invoiceReferences).toEqual(['55500011']);
    expect((await evenements(id)).filter((e) => e.outcome === 'UPDATED')).toHaveLength(0);
    const trouve = (await recherche(c, '55500011')).find((x) => x.docId === id);
    expect(trouve?.label).toBe('Mon alarme — février');
  });

  // ══ L87D-E2E-04 — deux factures du même mois ════════════════════════════
  it('L87D-E2E-04 — deux factures distinctes du même mois : titres distincts et déterministes (n° de facture), aucune fusion, stables au second passage', async () => {
    const { c, maison } = await compteAvecMaison();
    const a = await factureStock(c, maison.id, { titre: 'Facture Homiris _ Juin 2026', debut: '2026-06-01', fin: '2026-06-30', facture: '94741361', emise: '2026-06-06' });
    const b = await factureStock(c, maison.id, { titre: 'Facture Homiris _ Juin 2026 (bis)', debut: '2026-06-01', fin: '2026-06-30', facture: '94741362', emise: '2026-06-20' });
    await campagne(c, 'CORRECTIVE');
    expect((await fichier(a)).retained_title).toBe('Facture Homiris — Juin 2026 (n° 94741361)');
    expect((await fichier(b)).retained_title).toBe('Facture Homiris — Juin 2026 (n° 94741362)');
    expect((await fichier(a)).title_canonical_key).toBe((await fichier(b)).title_canonical_key);
    expect(await sql`SELECT id FROM asset_files WHERE id IN (${a}, ${b}) AND deleted_at IS NULL AND grouped_into_file_id IS NULL`).toHaveLength(2);
    const n = (await evenements(a)).length + (await evenements(b)).length;
    await campagne(c, 'CORRECTIVE');
    expect((await evenements(a)).length + (await evenements(b)).length).toBe(n);
    await memeTitrePartout(c, b, 'Facture Homiris — Juin 2026 (n° 94741362)', '94741362');
  });

  // ══ L87D-E2E-05 — aucun impact métier ═══════════════════════════════════
  it('L87D-E2E-05 — renommage sans impact : montants, dates, rattachements, candidats T1, Agenda et Opérations inchangés', async () => {
    const { c, maison } = await compteAvecMaison();
    const id = await factureStock(c, maison.id, { titre: 'Facture Homiris _ Juillet 2026', debut: '2026-07-01', fin: '2026-07-31', facture: '94741370', emise: '2026-07-06' });
    const etat = async () => ({
      f: await fichier(id).then(({ amount_cents, document_date, asset_id, linked_asset_id }) => ({ amount_cents, document_date, asset_id, linked_asset_id })),
      cands: await sql`SELECT id, status, payload FROM document_operation_candidates WHERE file_id = ${id} ORDER BY id`,
      liens: await sql`SELECT asset_id, link_role, status FROM document_asset_links WHERE file_id = ${id} ORDER BY id`,
      agenda: await sql`SELECT agenda_item_id FROM agenda_file_links WHERE asset_file_id = ${id} ORDER BY agenda_item_id`,
      items: (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${c.id}`)[0].n,
      ops: await sql`SELECT operation_id, active FROM business_operation_documents WHERE file_id = ${id} ORDER BY operation_id`,
    });
    const avant = await etat();
    await campagne(c, 'CORRECTIVE');
    expect((await fichier(id)).retained_title).toBe('Facture Homiris — Juillet 2026');
    expect(await etat()).toEqual(avant);
  });

  // ══ L87D-E2E-06 — périodes difficiles ═══════════════════════════════════
  it('L87D-E2E-06 — période ambiguë (deux échéances) : aucun mois inventé ; pluriannuelle et chevauchement d’année présentées exactement', async () => {
    const { c, maison } = await compteAvecMaison();
    const ambigue = await factureStock(c, maison.id, {
      titre: 'Facture Homiris _ Avril 2026', debut: '2026-04-05', fin: '2026-05-04', facture: '94741380', emise: '2026-04-06',
      echeances: [['2026-04-05', '2026-05-04'], ['2026-05-05', '2026-06-04']],
    });
    const annuelle = await factureStock(c, maison.id, { titre: 'Avis d’échéance', debut: '2025-09-01', fin: '2026-08-31', facture: 'AE-2025', emise: '2025-08-20', fournisseur: 'MAIF' });
    const chevauchement = await factureStock(c, maison.id, { titre: 'Facture Homiris _ Décembre 2025', debut: '2025-12-15', fin: '2026-01-14', facture: '94741390', emise: '2025-12-16' });
    await campagne(c, 'CORRECTIVE');
    const a = await fichier(ambigue);
    expect(a.title_convention).toBeNull();
    expect(a.title_basis.billedPeriod).toBeNull();
    expect(a.retained_title).not.toMatch(/Avril 2026|Mai 2026/);
    expect((await fichier(annuelle)).retained_title).toBe('Facture MAIF — Septembre 2025 à août 2026');
    expect((await fichier(chevauchement)).retained_title).toBe('Facture Homiris — 15 décembre 2025 au 14 janvier 2026');
  });

  // ══ L87D-E2E-07 — aucun code technique visible ══════════════════════════
  it('L87D-E2E-07 — cas de la capture « BUILDING_PERMIT » : libellé français partout (fiche, Mes documents, recherche, aperçu du bien, fournisseur), jamais le code', async () => {
    const { c, maison } = await compteAvecMaison();
    const f = await make.assetFile(c, { assetId: maison.id });
    await sql`UPDATE asset_files SET retained_title = 'Déclaration préalable - Pose de fenêtres de toit Ville Caluire et Cuire',
                     document_type = 'BUILDING_PERMIT', document_type_code = 'BUILDING_PERMIT', rubric_code = 'PROPERTY_MANAGEMENT',
                     analysis_state = 'ANALYZED', supplier = 'Ville de Caluire-et-Cuire' WHERE id = ${f.id}`;
    const { documentTypeDisplayLabel } = await import('@/lib/referential/v2');
    const { documentTypeBadgeLabel } = await import('@/components/documents/DocumentTypeBadge');
    const libelle = documentTypeDisplayLabel('BUILDING_PERMIT');
    expect(libelle).not.toMatch(/BUILDING_PERMIT/);
    // Fiche : la pastille de l'en-tête lit ce code et rend le libellé.
    const fi = await fiche(c, f.id);
    expect(documentTypeBadgeLabel(fi.documentTypeCode)).toBe(libelle);
    // Mes documents.
    const l = await titreListe(c, f.id);
    expect(l?.documentTypeLabel).toBe(libelle);
    expect(JSON.stringify(l)).not.toMatch(/"(?:documentTypeLabel|rubricLabel|typeLabel|title)":"[^"]*BUILDING_PERMIT/);
    // Recherche globale : sous-titre (bien) et libellé, jamais un code.
    const r = (await recherche(c, 'Caluire')).find((x) => x.docId === f.id);
    expect(r).toBeTruthy();
    expect(`${r!.label} ${r!.sublabel ?? ''}`).not.toMatch(/BUILDING_PERMIT/);
    // Aperçu du bien.
    const { GET: overview } = await import('@/app/api/assets/[id]/overview/route');
    const ov = await (await overview(new NextRequest(`http://x/api/assets/${maison.id}/overview`), { params: Promise.resolve({ id: String(maison.id) }) })).json() as Json;
    const doc = (ov.documentsPreview as Json[]).find((d) => d.id === f.id);
    expect(doc?.documentTypeLabel).toBe(libelle);
    expect(doc?.title).toBe('Déclaration préalable - Pose de fenêtres de toit Ville Caluire et Cuire');
    // Fournisseur (page et tiroir) : libellé du Type, jamais le code.
    const [sup] = await sql<{ id: number }[]>`
      INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name) VALUES (${c.id}, ${c.ownerUserId}, 'Ville de Caluire-et-Cuire', 'ville de caluire et cuire') RETURNING id`;
    await sql`INSERT INTO document_suppliers (document_id, supplier_id, is_confirmed) VALUES (${f.id}, ${sup.id}, true)`;
    const { getSupplierDetail } = await import('@/services/suppliers/supplier-detail.service');
    const det = await getSupplierDetail(c.id, Number(sup.id));
    const ds = det?.documents.find((d) => d.id === f.id);
    expect(ds?.documentTypeLabel).toBe(libelle);
    expect(ds?.title).toBe('Déclaration préalable - Pose de fenêtres de toit Ville Caluire et Cuire');
  });
});
