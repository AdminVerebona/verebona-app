/**
 * Lot 86E — ticket P1 « Documents — rubrique Équipements et mobilier et types
 * documentaires associés », sur PostgreSQL 16 réel. Analyses T1 par le point
 * d'entrée de PRODUCTION (`analyzeFileSources`, passerelle réelle, sorties
 * modèle rejouées), file T1 réelle (`runOne`), campagnes de l'orchestrateur
 * unique, routes réelles. Date de référence injectée (24/10/2026).
 *
 *   L86E-E2E-01  Tikamoon : nature BON_COMMANDE identifiée, rubrique
 *                « Équipements et mobilier » → type enregistré « Bon de
 *                commande » (= connaissance T1 = libellé affiché), Mes
 *                documents (rubrique, compteurs, filtres Rubrique et Type),
 *                tiroir d'équipement : même libellé ;
 *   L86E-E2E-02  les factures d'autres domaines restent dans leur rubrique ;
 *                une facture ambiguë en Entretien et travaux : aucun type
 *                deviné ;
 *   L86E-E2E-03  stock classé AVANT la rubrique (« Autres documents ») :
 *                constat à blanc sans écriture ni IA, réévaluation par la
 *                relance T1 existante (une seule, tracée), reclassement par
 *                T1, contrôle suivant REPAIRED ; carte DOC-TYP close ; aucune
 *                association Agenda / Opération créée ;
 *   L86E-E2E-04  choix de l'utilisateur conservé : rubrique validée jamais
 *                réévaluée, « Autre » choisi jamais remplacé ; une nouvelle
 *                analyse propose sans écraser (arbitrage) ;
 *   L86E-E2E-05  stock « nature identifiée, type non enregistré » : type
 *                enregistré par le moteur de décision, sans IA ; second
 *                passage idempotent (aucune écriture, aucune réparation) ;
 *   L86E-E2E-06  tiroir → PUT /api/documents/[id] : le code V1 historique
 *                n'est plus réécrit « AUTRE » ni marqué choix utilisateur ;
 *   L86E-E2E-07  rubrique et types disponibles partout : feed, BO
 *                référentiels, export de recette (référentiel), aucun
 *                doublon de type ;
 *   L86E-E2E-08  facture d'achat de mobilier : jamais le prix ni la date
 *                d'acquisition du bien (la rubrique porte le domaine).
 *
 * Campagnes BORNÉES aux comptes créés ici ; assertions sur ces comptes seuls.
 */
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { drainQueues, useTargetState } from '../chain';
import type { RecordedOutput } from '../replay-gateway';
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
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: async () => undefined,
}));
/** PDF servi au découpage et à la vérification : jamais de lecture S3 réelle. */
const pdf = vi.hoisted(() => ({ bytes: null as Uint8Array | null }));
vi.mock('@/services/ai/source-analysis/source-units/page-chunks', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/source-analysis/source-units/page-chunks')>()),
  fetchSourceBytes: async () => pdf.bytes,
}));

type Json = Record<string, any>;
const CHECK = 'COH-DOC-CLASSIFICATION';
/** Date de référence (jour > 12 : jamais ambiguë jour / mois). */
const AUJOURDHUI = '2026-10-24';
const MAINTENANT = new Date('2026-10-24T09:30:00Z');

interface Classement { canonicalType: string | null; rubricCode: string | null; documentTypeCode: string | null }
const sortie = (titre: string, c: Classement, assetId: number | null) => ({
  task: 'ANALYZE_DOCUMENT',
  document: {
    title: { value: titre, confidence: 'certain', evidence: { excerpt: titre, page: 1 } },
    documentDate: { value: '2026-03-14', confidence: 'certain', evidence: { excerpt: 'Date : 14/03/2026', page: 1 } },
    classification: { ...c, confidence: 0.95, evidence: { excerpt: titre, page: 1 } },
  },
  entities: {
    assets: assetId ? [{ entityId: assetId, rawLabel: 'Maison', score: 0.97, confidence: 'certain', evidenceSignals: ['Maison'], reason: 'désignation lue' }] : [],
    rooms: [], equipments: [], suppliers: [], multiAsset: false,
  },
  transcription: `${titre}\nDate : 14/03/2026`,
  tables: [], facts: [], hasExploitableContent: true,
});
const T1 = (output: unknown): RecordedOutput => ({ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output });
const TIKAMOON = 'Bon de commande Tikamoon — Chaises de jardin en teck';
const ANCIEN: Classement = { canonicalType: 'BON_COMMANDE', rubricCode: 'OTHER_DOCUMENTS', documentTypeCode: null };
const NOUVEAU: Classement = { canonicalType: 'BON_COMMANDE', rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: null };

scenario('L86E', 'Rubrique « Équipements et mobilier », type identifié = type enregistré = type affiché, reprise du stock', ({ sql, make, replay, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T4'] });
  let pageUnique: Uint8Array;
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    const { PDFDocument } = await import('pdf-lib');
    const d = await PDFDocument.create();
    d.addPage();
    pageUnique = await d.save();
  });
  beforeEach(() => { pdf.bytes = pageUnique; });

  // ── Outils ───────────────────────────────────────────────────────────────
  const compteAvecMaison = async () => {
    const c = await make.account();
    const maison = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    return { c, maison };
  };
  const fichier = async (compte: AccountRow, assetId: number) => {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`document-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f.id;
  };
  const analyser = async (compte: AccountRow, fileId: number, records: RecordedOutput[], assetId: number) => {
    await rejouer(records);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const owner = (await sql<{ o: number }[]>`SELECT owner_user_id AS o FROM accounts WHERE id = ${compte.id}`)[0].o;
    const r = await analyzeFileSources([fileId], compte.id, { userId: owner, linkedAssetId: assetId, billable: false, origin: 'e2e/l86e' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
  };
  const appelsT1 = () => replay.calls.filter((c) => c.operationCode === 't1_analyze_document').length;
  async function campagne(scope: number[], mode: 'DRY_RUN' | 'CORRECTIVE') {
    const o = await import('@/services/coherence/orchestrator');
    const id = await o.startCampaign({ kind: 'MANUAL', trigger: 'e2e', mode, scopeAccountIds: scope, now: MAINTENANT });
    for (let i = 0; i < 30; i++) {
      const r = await o.runCampaignStep(id, { deadline: Date.now() + 120_000, now: MAINTENANT, today: AUJOURDHUI });
      if (r.done) break;
    }
    return (await o.getCampaign(id))!;
  }
  const preuve = async (accountId: number, objectId: number) => (await sql<Json[]>`
    SELECT last_result, last_mode, finding FROM coherence_object_proofs
     WHERE account_id = ${accountId} AND check_id = ${CHECK} AND object_id = ${objectId}`)[0];
  const reparations = (accountId: number) => sql<Json[]>`
    SELECT object_id::int AS object_id, service, outcome, recheck_verdict, anomaly, result, settled_at
      FROM coherence_repairs WHERE account_id = ${accountId} AND check_id = ${CHECK} ORDER BY id`;
  const classement = async (fileId: number) => (await sql<Json[]>`
    SELECT rubric_code, document_type_code, rubric_origin, type_origin, rubric_user_validated, type_user_validated,
           classification_referential_version AS version, document_type AS v1, classification_updated_at
      FROM asset_files WHERE id = ${fileId}`)[0];
  const connaissance = async (fileId: number) => (await sql<Json[]>`
    SELECT rubric_code, document_type_code, metadata ->> 'legacyDocumentType' AS identifie FROM document_extractions WHERE file_id = ${fileId}`)[0];
  const cartes = async (fileId: number, rule: string) => (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND rule_code = ${rule} AND resolved_at IS NULL`)[0].n;
  const travauxT1 = async (accountId: number, fileId: number) => (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ai_job_queue WHERE treatment = 'T1' AND account_id = ${accountId} AND target_id = ${String(fileId)}`)[0].n;
  /** Associations Agenda / Opération du document (un reclassement n'en crée jamais). */
  const associations = async (fileId: number) => {
    const [o] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_documents WHERE file_id = ${fileId}`;
    const [a] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_file_links WHERE asset_file_id = ${fileId}`;
    return { operations: Number(o.n), agenda: Number(a.n) };
  };
  const feed = async (accountId: number, filters: { rubrics?: string[]; types?: string[] } = {}) => {
    const { getDocumentFeed } = await import('@/services/documents/rubric-query.service');
    return getDocumentFeed({
      accountId, assetIds: [], sort: 'added', direction: 'desc', grouped: true,
      filters: { biens: [], rubrics: filters.rubrics ?? [], types: filters.types ?? [] }, ids: null, limit: 50, cursor: null, withMeta: true,
    });
  };

  // ══ L86E-E2E-01 ════════════════════════════════════════════════════════════

  it('L86E-E2E-01 — Tikamoon : rubrique Équipements et mobilier, type « Bon de commande » enregistré, connu de T1 et affiché partout', async () => {
    const { c, maison } = await compteAvecMaison();
    const f = await fichier(c, maison.id);
    await analyser(c, f, [T1(sortie(TIKAMOON, NOUVEAU, maison.id))], maison.id);

    expect(await classement(f)).toMatchObject({
      rubric_code: 'EQUIPMENT_FURNITURE', document_type_code: 'ACQUISITION_ORDER', type_origin: 'DOCUMENT_EXTRACTION', version: '2.2.0',
      // Le code V1 historique garde la nature identifiée (plus jamais « AUTRE »).
      v1: 'BON_COMMANDE',
    });
    // Type identifié = type enregistré = type de la connaissance T1.
    expect(await connaissance(f)).toMatchObject({ rubric_code: 'EQUIPMENT_FURNITURE', document_type_code: 'ACQUISITION_ORDER', identifie: 'BON_COMMANDE' });
    expect(await cartes(f, 'DOC-TYP')).toBe(0);
    expect(await cartes(f, 'DOC-RUB')).toBe(0);

    // Mes documents : rubrique, compteur, libellé, filtres Rubrique et Type.
    const page = await feed(c.id);
    const doc = page.documents.find((d) => d.id === f)!;
    expect(doc).toMatchObject({ rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: 'ACQUISITION_ORDER', documentTypeLabel: 'Bon de commande' });
    expect(page.meta!.rubrics.find((r) => r.code === 'EQUIPMENT_FURNITURE')).toMatchObject({ label: 'Équipements et mobilier', count: 1 });
    // Option de filtre Rubrique (son libellé est lu dans le référentiel par l'écran).
    expect(page.meta!.facets.rubrics.find((r) => r.value === 'EQUIPMENT_FURNITURE')).toMatchObject({ count: 1 });
    expect(page.meta!.facets.types.find((t) => t.value === 'ACQUISITION_ORDER')).toMatchObject({ label: 'Bon de commande', count: 1 });
    expect((await feed(c.id, { rubrics: ['EQUIPMENT_FURNITURE'] })).documents.map((d) => d.id)).toEqual([f]);
    expect((await feed(c.id, { types: ['ACQUISITION_ORDER'] })).documents.map((d) => d.id)).toEqual([f]);
    expect((await feed(c.id, { rubrics: ['OTHER_DOCUMENTS'] })).documents).toEqual([]);

    // Tiroir d'un équipement : même libellé (plus le code V1 brut « BON_COMMANDE »).
    const [eq] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type) VALUES (${maison.id}, 'Chaises de jardin', 'OTHER') RETURNING id`;
    await sql`UPDATE asset_files SET equipment_id = ${eq.id} WHERE id = ${f}`;
    session.userId = c.ownerUserId; session.currentAccountId = c.id;
    const { GET } = await import('@/app/api/equipments/[id]/documents/route');
    const r = await GET(new NextRequest(`http://localhost/api/equipments/${eq.id}/documents`), { params: Promise.resolve({ id: String(eq.id) }) });
    const corps = await r.json() as { documents: Json[] };
    expect(corps.documents.find((d) => d.id === f)).toMatchObject({ documentTypeCode: 'ACQUISITION_ORDER', documentTypeLabel: 'Bon de commande' });
  });

  // ══ L86E-E2E-02 ════════════════════════════════════════════════════════════

  it('L86E-E2E-02 — les factures d’autres domaines restent dans leur rubrique ; une facture ambiguë n’est jamais typée au hasard', async () => {
    const { c, maison } = await compteAvecMaison();
    const travaux = await fichier(c, maison.id);
    await analyser(c, travaux, [T1(sortie('Facture de travaux — réfection toiture', { canonicalType: 'FACTURE', rubricCode: 'MAINTENANCE_WORKS', documentTypeCode: 'WORKS_INVOICE' }, maison.id))], maison.id);
    const assurance = await fichier(c, maison.id);
    await analyser(c, assurance, [T1(sortie('Avis d’échéance assurance habitation', { canonicalType: 'AVIS_ECHEANCE', rubricCode: 'INSURANCE_CLAIMS', documentTypeCode: 'INSURANCE_DUE_NOTICE' }, maison.id))], maison.id);
    const ambigue = await fichier(c, maison.id);
    await analyser(c, ambigue, [T1(sortie('Facture prestataire', { canonicalType: 'FACTURE', rubricCode: 'MAINTENANCE_WORKS', documentTypeCode: null }, maison.id))], maison.id);

    expect(await classement(travaux)).toMatchObject({ rubric_code: 'MAINTENANCE_WORKS', document_type_code: 'WORKS_INVOICE' });
    expect(await classement(assurance)).toMatchObject({ rubric_code: 'INSURANCE_CLAIMS', document_type_code: 'INSURANCE_DUE_NOTICE' });
    // Entretien, réparation ou travaux : trois natures possibles — rien n'est deviné.
    expect(await classement(ambigue)).toMatchObject({ rubric_code: 'MAINTENANCE_WORKS', document_type_code: null });
    await campagne([c.id], 'CORRECTIVE');
    for (const f of [travaux, assurance, ambigue]) expect((await preuve(c.id, f)).last_result, String(f)).toBe('CONSISTENT');
    expect(await classement(ambigue)).toMatchObject({ document_type_code: null });
    expect(await reparations(c.id)).toEqual([]);
  });

  // ══ L86E-E2E-03 ════════════════════════════════════════════════════════════

  it('L86E-E2E-03 — stock classé avant la rubrique : constat à blanc, une réévaluation T1 tracée, reclassé, aucune association créée', async () => {
    const { c, maison } = await compteAvecMaison();
    const f = await fichier(c, maison.id);
    // Analyse d'avant le lot 86E : faute de rubrique, « Autres documents ».
    await analyser(c, f, [T1(sortie(TIKAMOON, ANCIEN, maison.id))], maison.id);
    await sql`UPDATE asset_files SET classification_referential_version = '2.1.0' WHERE id = ${f}`;
    expect(await classement(f)).toMatchObject({ rubric_code: 'OTHER_DOCUMENTS', document_type_code: null, rubric_user_validated: false });
    expect(await cartes(f, 'DOC-TYP')).toBe(1);
    const liens = await associations(f);
    const t0 = await travauxT1(c.id, f);
    const ia0 = appelsT1();

    // À blanc : constat, aucune écriture, aucune relance, aucun appel IA.
    await campagne([c.id], 'DRY_RUN');
    expect(appelsT1()).toBe(ia0);
    expect(await preuve(c.id, f)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'CLASSIFIED_BEFORE_RUBRIC', faultyLink: 'T1' }) });
    expect(await travauxT1(c.id, f)).toBe(t0);
    expect(await classement(f)).toMatchObject({ rubric_code: 'OTHER_DOCUMENTS', version: '2.1.0' });

    // Correctif : UNE relance par la file T1 existante, tracée et journalisée.
    await campagne([c.id], 'CORRECTIVE');
    expect(await travauxT1(c.id, f)).toBe(t0 + 1);
    expect(await preuve(c.id, f)).toMatchObject({ last_result: 'REPAIR_PENDING' });
    expect(await reparations(c.id)).toEqual([expect.objectContaining({
      object_id: f, service: 'requeueDocumentForReread', outcome: 'PENDING', anomaly: 'CLASSIFIED_BEFORE_RUBRIC',
      result: expect.objectContaining({ evaluatedWith: ['EQUIPMENT_FURNITURE'], before: expect.objectContaining({ rubricCode: 'OTHER_DOCUMENTS' }) }),
    })]);
    expect((await sql<Json[]>`SELECT last_retry_result FROM document_extraction_coverage WHERE file_id = ${f}`)[0]?.last_retry_result ?? 'REQUEUED_T1_CLASSIFICATION')
      .toBe('REQUEUED_T1_CLASSIFICATION');
    // En attente : jamais de seconde relance.
    await campagne([c.id], 'CORRECTIVE');
    expect(await travauxT1(c.id, f)).toBe(t0 + 1);
    expect(await reparations(c.id)).toHaveLength(1);

    // La file T1 exécute la réévaluation : T1 reçoit la nomenclature courante et classe.
    await rejouer([T1(sortie(TIKAMOON, NOUVEAU, maison.id))]);
    const { runOne } = await import('@/services/ai/queue/queue-worker');
    (await import('@/services/ai/source-analysis/queue/t1-handler')).registerSourceAnalysisHandler();
    expect(await runOne('T1')).toBe(true);
    await drainQueues();
    expect(appelsT1()).toBe(1);
    expect(await classement(f)).toMatchObject({ rubric_code: 'EQUIPMENT_FURNITURE', document_type_code: 'ACQUISITION_ORDER', version: '2.2.0' });
    expect(await cartes(f, 'DOC-TYP')).toBe(0);
    expect(await associations(f)).toEqual(liens);

    await campagne([c.id], 'CORRECTIVE');
    expect(await preuve(c.id, f)).toMatchObject({ last_result: 'REPAIRED', finding: null });
    const [j] = await reparations(c.id);
    expect(j).toMatchObject({ outcome: 'REPAIRED', recheck_verdict: 'CONSISTENT' });
    expect(j.settled_at).not.toBeNull();
  });

  // ══ L86E-E2E-04 ════════════════════════════════════════════════════════════

  it('L86E-E2E-04 — choix de l’utilisateur conservé : aucune réévaluation, aucun remplacement ; une nouvelle analyse propose sans écraser', async () => {
    const { c, maison } = await compteAvecMaison();
    const rangeParUtilisateur = await fichier(c, maison.id);
    await analyser(c, rangeParUtilisateur, [T1(sortie(TIKAMOON, ANCIEN, maison.id))], maison.id);
    await sql`UPDATE asset_files SET rubric_origin = 'USER', rubric_user_validated = true, classification_referential_version = '2.1.0' WHERE id = ${rangeParUtilisateur}`;
    const autreChoisi = await fichier(c, maison.id);
    await analyser(c, autreChoisi, [T1(sortie(TIKAMOON, NOUVEAU, maison.id))], maison.id);
    await sql`UPDATE asset_files SET document_type_code = 'OTHER_EQUIPMENT_FURNITURE', type_origin = 'USER', type_user_validated = true WHERE id = ${autreChoisi}`;
    const t0 = await travauxT1(c.id, rangeParUtilisateur);

    await campagne([c.id], 'CORRECTIVE');
    expect((await preuve(c.id, rangeParUtilisateur)).last_result).toBe('CONSISTENT');
    expect((await preuve(c.id, autreChoisi)).last_result).toBe('CONSISTENT');
    expect(await travauxT1(c.id, rangeParUtilisateur)).toBe(t0);
    expect(await reparations(c.id)).toEqual([]);
    expect(await classement(rangeParUtilisateur)).toMatchObject({ rubric_code: 'OTHER_DOCUMENTS', rubric_user_validated: true });
    expect(await classement(autreChoisi)).toMatchObject({ rubric_code: 'EQUIPMENT_FURNITURE', document_type_code: 'OTHER_EQUIPMENT_FURNITURE', type_user_validated: true });

    // Nouvelle analyse proposant la nouvelle rubrique : jamais écrite par-dessus le choix (§12.2).
    await analyser(c, rangeParUtilisateur, [T1(sortie(TIKAMOON, NOUVEAU, maison.id))], maison.id);
    expect(await classement(rangeParUtilisateur)).toMatchObject({ rubric_code: 'OTHER_DOCUMENTS', rubric_user_validated: true });
    const [arbitrage] = await sql<Json[]>`
      SELECT action_kind FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${rangeParUtilisateur} AND rule_code = 'DOC-RUB' AND resolved_at IS NULL`;
    expect(arbitrage?.action_kind).toBe('ARBITRATE');
  });

  // ══ L86E-E2E-05 ════════════════════════════════════════════════════════════

  it('L86E-E2E-05 — nature identifiée mais type non enregistré : type enregistré sans IA, idempotent, aucune association', async () => {
    const { c, maison } = await compteAvecMaison();
    const f = await fichier(c, maison.id);
    await analyser(c, f, [T1(sortie(TIKAMOON, NOUVEAU, maison.id))], maison.id);
    // Stock d'avant la correction : la nature BON_COMMANDE identifiée n'avait pas donné de type.
    await sql`UPDATE asset_files SET document_type_code = NULL, type_origin = NULL WHERE id = ${f}`;
    await sql`UPDATE document_extractions SET document_type_code = NULL WHERE file_id = ${f}`;
    const liens = await associations(f);
    const ia0 = replay.calls.length;

    await campagne([c.id], 'DRY_RUN');
    expect(await preuve(c.id, f)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'IDENTIFIED_TYPE_NOT_RECORDED' }) });
    expect(await classement(f)).toMatchObject({ document_type_code: null });

    await campagne([c.id], 'CORRECTIVE');
    expect(await classement(f)).toMatchObject({ rubric_code: 'EQUIPMENT_FURNITURE', document_type_code: 'ACQUISITION_ORDER', type_origin: 'SYSTEM_RULE', type_user_validated: false });
    expect(await preuve(c.id, f)).toMatchObject({ last_result: 'REPAIRED' });
    expect(await reparations(c.id)).toEqual([expect.objectContaining({
      object_id: f, service: 'applyV2Classification', outcome: 'REPAIRED', recheck_verdict: 'CONSISTENT', anomaly: 'IDENTIFIED_TYPE_NOT_RECORDED',
      result: expect.objectContaining({ proposed: { documentTypeCode: 'ACQUISITION_ORDER' }, before: { rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: null } }),
    })]);
    expect(replay.calls.filter((x, i) => i >= ia0 && !String(x.operationCode ?? '').startsWith('t6_'))).toEqual([]);
    expect(await associations(f)).toEqual(liens);

    // Second passage : aucune écriture, aucune réparation.
    const avant = await classement(f);
    await campagne([c.id], 'CORRECTIVE');
    expect(await preuve(c.id, f)).toMatchObject({ last_result: 'CONSISTENT' });
    expect(await reparations(c.id)).toHaveLength(1);
    expect(await classement(f)).toEqual(avant);
  });

  // ══ L86E-E2E-06 ════════════════════════════════════════════════════════════

  it('L86E-E2E-06 — tiroir → PUT : la nature reconnue n’est plus réécrite « AUTRE » ni marquée choix utilisateur', async () => {
    const { c, maison } = await compteAvecMaison();
    const f = await fichier(c, maison.id);
    await analyser(c, f, [T1(sortie(TIKAMOON, NOUVEAU, maison.id))], maison.id);
    session.userId = c.ownerUserId; session.currentAccountId = c.id;
    const { PUT } = await import('@/app/api/documents/[id]/route');
    const put = (body: Json) => PUT(new NextRequest(`http://localhost/api/documents/${f}`, {
      method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }), { params: Promise.resolve({ id: String(f) }) });

    // Ce qu'envoie le tiroir : plus de code V1.
    let r = await put({ fileName: TIKAMOON, retainedTitle: TIKAMOON, notes: 'Livraison prévue au printemps', userEditedFields: {} });
    expect(r.status).toBe(200);
    const [x] = await sql<Json[]>`SELECT document_type, user_edited_fields, notes FROM asset_files WHERE id = ${f}`;
    expect(x.document_type).toBe('BON_COMMANDE');
    expect(x.notes).toBe('Livraison prévue au printemps');
    expect((x.user_edited_fields ?? {}).retainedFunctionCode).toBeUndefined();
    // Un client ancien qui renvoie la valeur inchangée : acceptée telle quelle (avant : refusée ou « AUTRE »).
    r = await put({ fileName: TIKAMOON, documentType: 'BON_COMMANDE' });
    expect(r.status).toBe(200);
    // Une MODIFICATION reste validée par le référentiel V1.
    r = await put({ fileName: TIKAMOON, documentType: 'CODE_INEXISTANT' });
    expect(r.status).toBe(400);
    expect(await classement(f)).toMatchObject({ v1: 'BON_COMMANDE', rubric_code: 'EQUIPMENT_FURNITURE', document_type_code: 'ACQUISITION_ORDER' });
  });

  // ══ L86E-E2E-08 ════════════════════════════════════════════════════════════

  it('L86E-E2E-08 — facture d’achat de mobilier : jamais le prix ni la date d’acquisition de la maison', async () => {
    const { c, maison } = await compteAvecMaison();
    const f = await fichier(c, maison.id);
    const out = sortie('Facture Tikamoon — Chaises de jardin en teck', { canonicalType: 'FACTURE', rubricCode: 'EQUIPMENT_FURNITURE', documentTypeCode: 'ACQUISITION_INVOICE' }, maison.id) as Json;
    // Le modèle attribue (à tort) le total au prix d'acquisition du bien.
    out.facts = [{
      canonicalKey: 'acquisitionPrice', rawKey: 'acquisitionPrice', label: 'Total TTC', subject: null, attribute: null,
      rawValue: '277,35', normalizedValue: 27735, valueType: 'money_eur', canonicalUnit: 'EUR',
      target: { type: 'ASSET', entityId: maison.id, rawLabel: null, confidence: 'certain', evidenceSignals: [] },
      provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: 'Total TTC 277,35 €', page: 1 },
    }];
    out.transcription = `${out.transcription}\nTotal TTC 277,35 €`;
    await analyser(c, f, [T1(out)], maison.id);
    expect(await classement(f)).toMatchObject({ rubric_code: 'EQUIPMENT_FURNITURE', document_type_code: 'ACQUISITION_INVOICE' });
    const preuves = await sql<Json[]>`
      SELECT field_key FROM field_evidence WHERE source_id = ${f} AND asset_id = ${maison.id} AND field_key IN ('acquisitionPrice', 'acquisitionDate')`;
    expect(preuves).toEqual([]);
    const [bien] = await sql<Json[]>`SELECT purchase_price_cents FROM assets WHERE id = ${maison.id}`;
    expect(bien.purchase_price_cents).toBeNull();
  });

  // ══ L86E-E2E-07 ════════════════════════════════════════════════════════════

  it('L86E-E2E-07 — rubrique et types disponibles partout (BO référentiels, export de recette), aucun doublon', async () => {
    const { c, maison } = await compteAvecMaison();
    const f = await fichier(c, maison.id);
    await analyser(c, f, [T1(sortie(TIKAMOON, NOUVEAU, maison.id))], maison.id);
    const { buildCodeReferentials } = await import('@/app/api/admin/referentials/referentials-data');
    const bo = buildCodeReferentials(new Map([['EQUIPMENT_FURNITURE', 1]]), new Map([['ACQUISITION_ORDER', 1]]));
    expect(bo.rubrics.find((r) => r.code === 'EQUIPMENT_FURNITURE')).toMatchObject({ label: 'Équipements et mobilier', usage: 1 });
    expect(bo.documentTypes.find((t) => t.code === 'ACQUISITION_ORDER')).toMatchObject({
      label: 'Bon de commande', usage: 1, details: expect.stringContaining('Propriété et gestion · Équipements et mobilier'),
    });
    const codesV2 = bo.documentTypes.filter((t) => !String(t.details).startsWith('Type V1')).map((t) => t.code);
    expect(new Set(codesV2).size).toBe(codesV2.length);
    // Le classement du document part dans l'export de recette (table asset_files exportée).
    const { RECETTE_TABLES } = await import('@/services/admin/diagnostics-export/recette-catalog');
    expect(RECETTE_TABLES.asset_files).toBeDefined();
    expect(await classement(f)).toMatchObject({ rubric_code: 'EQUIPMENT_FURNITURE', document_type_code: 'ACQUISITION_ORDER' });
  });
});
