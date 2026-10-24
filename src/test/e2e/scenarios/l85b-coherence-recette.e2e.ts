/**
 * Lot 85B — contrôle de cohérence, lot C7 « recette préprod et exploitation »
 * et familles « À traiter » restantes, sur PostgreSQL 16 réel (toutes les
 * migrations, dont 0704). Arbitrages PO du 23/10/2026 C-Q1 à C-Q11 ; CDC
 * cohérence §4.6, §6.3, §6.4, §9.3, §10, §11.4, CA-07, CA-11, CA-12, CA-15.
 *
 *   L85B-E2E-01  familles « À traiter » : arbitrage T3 de champ devenu sans
 *                objet, revue de migration périmée, proposition d'agenda déjà
 *                planifiée → à blanc rien ; correctif : chaque carte fermée par
 *                SON producteur / service (tracé), recontrôle, cartes saines
 *                intactes ; second passage sans réparation ;
 *   L85B-E2E-02  questions de consolidation des Opérations dont la fermeture
 *                s'est perdue (« même réalité » ; montant contradictoire
 *                disparu) → consolidation du document / de l'Opération (sans
 *                M3), cartes closes par `syncOperationCards` ;
 *   L85B-E2E-03  résolutions non propagées : « même réalité » choisie mais
 *                consolidation d'après validation échouée ; document déplacé
 *                vers un autre bien sans ses liens → mêmes appels que la
 *                résolution ; geste ultérieur de l'utilisateur respecté ;
 *   L85B-E2E-04  réévaluation historique (§6.4) : version d'un contrôle changée
 *                → le stock ENTIER réexaminé par la campagne quotidienne
 *                suivante (preuve par objet, version des règles), anti-boucle
 *                levée une fois ; nouvelle version déployée EN COURS de
 *                campagne, en parcours puis en vérification : aucun objet
 *                déclaré contrôlé selon une version périmée ;
 *   L85B-E2E-05  CA-15 — taxe foncière découverte par le PASSAGE PÉRIODIQUE
 *                (campagne quotidienne, aucune action ni événement) avec les
 *                règles ACTUELLES : maillon T1 réparé (montant de l'extract
 *                oublié), constat TCO en attente du contrat IA
 *                82B-t3-decision-tco, Supervision ; aucune compensation codée ;
 *   L85B-E2E-06  mesures (C-Q1) sur un jeu volumineux : durée, objets,
 *                couverture, appels IA ; ordre de grandeur dans la fenêtre
 *                5 h → minuit ; campagne PARTIELLE et constats persistants
 *                visibles dans la Supervision existante (aucun onglet, C-Q3).
 *
 * Campagnes BORNÉES aux comptes créés ici (`scopeAccountIds`), assertions sur
 * ces comptes seuls. Aucun appel IA réel (sorties T1 rejouées).
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, useTargetState } from '../chain';
import type { RecordedOutput } from '../replay-gateway';
import { RECETTE_TODAY, cand, cible, fh, operationsKit, ref, type OperationsKit } from '../datasets/operations-v1';

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
type Kc = Record<string, unknown>;
type Fait = Record<string, unknown>;

const fait = (excerpt: string, value: string, over: Fait = {}): Fait => ({
  canonicalKey: null, rawKey: `info.${value}`, label: null, subject: null, attribute: null, rawValue: value, normalizedValue: value,
  valueType: 'string', target: { type: 'GENERIC', entityId: null, rawLabel: null, confidence: 'certain', evidenceSignals: [] },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt, page: 1 }, ...over,
});
const avisFoncier = (p: { transcription?: string; facts?: Fait[] }) => ({
  task: 'ANALYZE_DOCUMENT',
  document: {
    title: { value: 'Avis de taxe foncière 2025', confidence: 'certain', evidence: { excerpt: 'Avis de taxe foncière 2025', page: 1 } },
    documentDate: { value: '2025-09-01', confidence: 'certain', evidence: { excerpt: 'Date : 01/09/2025', page: 1 } },
    classification: { canonicalType: 'PROPERTY_TAX_NOTICE', rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: 'PROPERTY_TAX_NOTICE', confidence: 0.95, evidence: {} },
  },
  entities: { assets: [], rooms: [], equipments: [], suppliers: [], multiAsset: false },
  ...(p.transcription !== undefined ? { transcription: p.transcription } : {}),
  tables: [], facts: p.facts ?? [], hasExploitableContent: true,
});
const T1 = (output: unknown, over: Partial<RecordedOutput> = {}): RecordedOutput => ({ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output, ...over });
const REPARATION = (output: unknown, unit = '[page:1:field:') => T1(output, { promptIncludes: unit });
const AVIS = 'Avis de taxe foncière 2025\nDate : 01/09/2025\nMontant de votre impôt : 1 234,00 €';

scenario('L85B', 'Cohérence C7 : familles « À traiter », réévaluation historique, taxe foncière (CA-15), mesures', ({ sql, make, replay, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T4'] });
  let k: OperationsKit;
  let pageUnique: Uint8Array;
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    k = operationsKit(sql, make);
    const { PDFDocument } = await import('pdf-lib');
    const d = await PDFDocument.create();
    d.addPage();
    pageUnique = await d.save();
  });
  beforeEach(() => { pdf.bytes = pageUnique; });
  afterEach(async () => {
    (await import('@/services/business-operations/events')).resetBusinessOperationEventBusForTests();
    (await import('@/services/business-operations/consolidation/consolidator')).setT3FaultHookForTests(null);
  });

  // ── Outils ───────────────────────────────────────────────────────────────
  const orchestrateur = () => import('@/services/coherence/orchestrator');
  const compte = () => make.account({ plan: 'premium' });
  async function campagne(scope: number[], mode: 'DRY_RUN' | 'CORRECTIVE', o: { kind?: 'MANUAL' | 'DAILY'; now?: Date; trigger?: string } = {}) {
    const orch = await orchestrateur();
    const now = o.now ?? new Date();
    const id = await orch.startCampaign({ kind: o.kind ?? 'MANUAL', trigger: o.trigger ?? 'e2e', mode, scopeAccountIds: scope, now });
    for (let i = 0; i < 40; i++) {
      const r = await orch.runCampaignStep(id, { deadline: Date.now() + 120_000, now, today: RECETTE_TODAY });
      if (r.done) break;
    }
    return (await orch.getCampaign(id))!;
  }
  const preuve = async (accountId: number, check: string, objectId: number) => (await sql<Json[]>`
    SELECT last_result, last_mode, last_trigger, finding, finding_streak, rules_version, registry_version, last_campaign_id::int AS campaign,
           last_success_at, last_completed_at, requested_at
      FROM coherence_object_proofs WHERE account_id = ${accountId} AND check_id = ${check} AND object_id = ${objectId}`)[0];
  const reparations = (accountId: number, check?: string) => sql<Json[]>`
    SELECT check_id, check_version, object_id::int AS object_id, service, outcome, recheck_verdict, anomaly, faulty_link, result, rollback_ref, ai_calls
      FROM coherence_repairs WHERE account_id = ${accountId} AND (${check ?? null}::text IS NULL OR check_id = ${check ?? null}) ORDER BY id`;
  const carteEtat = async (id: number) => (await sql<Json[]>`SELECT resolved_at IS NULL AS open, resolution_reason, proposals_json FROM to_process_actions WHERE id = ${id}`)[0];
  const evenements = (id: number) => sql<Json[]>`SELECT event, details FROM to_process_action_events WHERE action_id = ${id} ORDER BY id`;

  // ══ L85B-E2E-01 ═══════════════════════════════════════════════════════════

  it('L85B-E2E-01 — familles « À traiter » (arbitrage T3, revue de migration, proposition d’agenda) : cartes périmées fermées par LEUR producteur, tracées, recontrôlées ; cartes saines intactes', async () => {
    const c = await compte();
    const evidence = await import('@/services/ai/evidence/field-evidence.service');
    const engine = await import('@/services/ai/reconciliation/reconciliation-engine');
    const kc: Kc = { acquisitionDate: '2021-05-06', acquisitionDate__origin: 'USER' };
    const a = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: kc, purchaseDate: '2021-05-06' });
    await sql`UPDATE assets SET subtype = 'Maison' WHERE id = ${a.id}`;
    const acte = await make.assetFile(c, { assetId: a.id });
    await sql`UPDATE asset_files SET document_type = 'ACTE_AUTHENTIQUE' WHERE id = ${acte.id}`;
    await evidence.recordEvidence({
      accountId: c.id, assetId: a.id, fieldKey: 'acquisitionDate', value: '2005-02-17', normalizedValue: '2005-02-17', sourceType: 'document', sourceId: acte.id,
      location: {}, excerpt: 'Date d’achat : 2005-02-17', confidence: 'certain', authorityScore: 60, canonicalKey: 'acquisitionDate',
      documentType: 'ACTE_AUTHENTIQUE', projectionOrigin: 'MODEL_CANONICAL', projectionRule: null,
      target: { type: 'ASSET', entityId: a.id, label: null, confidence: 'certain' },
    } as Parameters<typeof evidence.recordEvidence>[0]);
    await engine.reconcileAsset({ accountId: c.id, assetId: a.id, triggeredBy: 'manual', aiReview: false });
    const [arbitrage] = await sql<{ id: number }[]>`SELECT id FROM to_process_actions WHERE account_id = ${c.id} AND rule_code = 'DATA-ACQUISITION-DATE' AND resolved_at IS NULL`;
    expect(arbitrage).toBeTruthy();
    // État historique : l'utilisateur a depuis retenu la date de l'acte sur la fiche, mais la carte est restée ouverte.
    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify({ acquisitionDate: '2005-02-17', acquisitionDate__origin: 'USER' })}, purchase_date = '2005-02-17' WHERE id = ${a.id}`;

    // Revues de migration (producteur CDC 15) : l'une PÉRIMÉE (valeur changée depuis), l'autre saine.
    const mig = await import('@/services/to-process/migration-review-cards');
    await mig.upsertMigrationReviewCard({ step: 'MIG-02', accountId: c.id, assetId: a.id, key: 'acquisitionPrice', reason: 'AMOUNT_TIMES_100', current: 15000000, candidates: [{ value: 150000 }] });
    await mig.upsertMigrationReviewCard({ step: 'MIG-07', accountId: c.id, assetId: a.id, key: 'estimatedValue', reason: 'COLUMN_DIFFERS_FROM_AUTOMATIC', current: null, candidates: [{ value: 320000 }] });
    const [revuePerimee] = await sql<{ id: number }[]>`SELECT id FROM to_process_actions WHERE account_id = ${c.id} AND relation_key = 'mig:MIG-02:acquisitionPrice'`;
    const [revueSaine] = await sql<{ id: number }[]>`SELECT id FROM to_process_actions WHERE account_id = ${c.id} AND relation_key = 'mig:MIG-07:estimatedValue'`;
    const fiche = JSON.parse((await sql<{ kc: string }[]>`SELECT key_characteristics AS kc FROM assets WHERE id = ${a.id}`)[0].kc) as Kc;
    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify({ ...fiche, acquisitionPrice: 150000, acquisitionPrice__origin: 'USER' })} WHERE id = ${a.id}`;

    // Propositions d'agenda (producteur T4-04) : l'une déjà planifiée (même clé fonctionnelle), l'autre non.
    const prop = await import('@/services/to-process/agenda-proposal-cards');
    const devis = await make.assetFile(c, { assetId: a.id });
    const candidat = (title: string, date: string) => ({
      title, date, category: 'action' as const, originFieldKey: null, nature: 'DEADLINE' as const, businessType: null, assetId: a.id, target: null,
      sources: [{ fileId: devis.id, role: 'SOURCE' as const }], reasonCode: 'SOURCE_TYPE_NOT_AUTHORIZED', documentType: 'DEVIS',
    });
    await prop.proposeAgendaCreation({ accountId: c.id, sourceFileId: devis.id, functionalKey: `e2e-85b-ramonage-${c.id}`, candidate: candidat('Ramonage', '2026-12-01') });
    await prop.proposeAgendaCreation({ accountId: c.id, sourceFileId: devis.id, functionalKey: `e2e-85b-vidange-${c.id}`, candidate: candidat('Vidange', '2027-01-15') });
    const [propPlanifiee] = await sql<{ id: number }[]>`SELECT id FROM to_process_actions WHERE account_id = ${c.id} AND relation_key = ${`agenda:e2e-85b-ramonage-${c.id}`}`;
    const [propOuverte] = await sql<{ id: number }[]>`SELECT id FROM to_process_actions WHERE account_id = ${c.id} AND relation_key = ${`agenda:e2e-85b-vidange-${c.id}`}`;
    // Événement de même clé créé par un autre chemin, sans que la proposition soit fermée (état historique).
    await sql`INSERT INTO agenda_items (account_id, title, start_date, functional_key) VALUES (${c.id}, 'Ramonage', '2026-12-01', ${`e2e-85b-ramonage-${c.id}`})`;

    // À BLANC : constats WOULD_REPAIR, aucune carte touchée.
    await rejouer([]);
    const blanc = await campagne([c.id], 'DRY_RUN');
    expect(blanc.status).toBe('COMPLETE');
    expect(await preuve(c.id, 'COH-TODO-T3-FIELD-CARDS', arbitrage.id)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'FIELD_CARD_STALE' }) });
    expect(await preuve(c.id, 'COH-TODO-MIGRATION-REVIEW-CARDS', revuePerimee.id)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'MIGRATION_REVIEW_STALE' }) });
    expect(await preuve(c.id, 'COH-TODO-AGENDA-PROPOSAL-CARDS', propPlanifiee.id)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'AGENDA_PROPOSAL_ALREADY_SCHEDULED' }) });
    for (const id of [arbitrage.id, revuePerimee.id, revueSaine.id, propPlanifiee.id, propOuverte.id]) expect((await carteEtat(id)).open).toBe(true);
    expect(await reparations(c.id)).toEqual([]);

    // CORRECTIF : chaque carte périmée fermée par le producteur / service de SA famille, recontrôlée.
    const corr = await campagne([c.id], 'CORRECTIVE');
    expect(corr.status).toBe('COMPLETE');
    expect(replay.calls.filter((x) => !String(x.operationCode ?? '').startsWith('t6_'))).toEqual([]);
    expect(await carteEtat(arbitrage.id)).toMatchObject({ open: false, resolution_reason: 'OBSOLETE' });
    expect(await carteEtat(revuePerimee.id)).toMatchObject({ open: false, resolution_reason: 'OBSOLETE' });
    expect((await evenements(revuePerimee.id)).at(-1)).toMatchObject({ event: 'OBSOLETE', details: expect.objectContaining({ reason: 'CURRENT_VALUE_CHANGED' }) });
    expect(await carteEtat(propPlanifiee.id)).toMatchObject({ open: false, resolution_reason: 'OBSOLETE' });
    expect((await evenements(propPlanifiee.id)).at(-1)).toMatchObject({ event: 'OBSOLETE', details: expect.objectContaining({ reason: 'AGENDA_ITEM_EXISTS' }) });
    // Cartes saines : intactes.
    expect((await carteEtat(revueSaine.id)).open).toBe(true);
    expect((await carteEtat(propOuverte.id)).open).toBe(true);
    const j = await reparations(c.id);
    const par = (check: string) => j.filter((x) => x.check_id === check);
    expect(par('COH-TODO-T3-FIELD-CARDS')).toEqual([expect.objectContaining({ object_id: arbitrage.id, service: 'syncReconciliationToProcess', outcome: 'REPAIRED', recheck_verdict: 'GONE', anomaly: 'FIELD_CARD_STALE', ai_calls: 0 })]);
    expect(par('COH-TODO-MIGRATION-REVIEW-CARDS')).toEqual([expect.objectContaining({ object_id: revuePerimee.id, service: 'perimer', outcome: 'REPAIRED' })]);
    expect(par('COH-TODO-AGENDA-PROPOSAL-CARDS')).toEqual([expect.objectContaining({ object_id: propPlanifiee.id, service: 'closeObsoleteAgendaProposals', outcome: 'REPAIRED' })]);
    expect(await preuve(c.id, 'COH-TODO-T3-FIELD-CARDS', arbitrage.id)).toMatchObject({ last_result: 'REPAIRED', finding: null });
    // Fiche jamais écrite par le contrôle.
    expect(JSON.parse((await sql<{ kc: string }[]>`SELECT key_characteristics AS kc FROM assets WHERE id = ${a.id}`)[0].kc)).toMatchObject({ acquisitionDate: '2005-02-17', acquisitionPrice: 150000 });

    // Second passage : rien à réparer, aucune nouvelle ligne au journal.
    await campagne([c.id], 'CORRECTIVE');
    expect(await reparations(c.id)).toHaveLength(j.length);
  });

  // ══ L85B-E2E-02 ═══════════════════════════════════════════════════════════

  it('L85B-E2E-02 — questions de consolidation dont la fermeture s’est perdue (« même réalité », montant contradictoire disparu) : closes par la consolidation existante (sans M3), recontrôlées', async () => {
    const c = await compte();
    const clio = await make.asset(c);
    const { setT3FaultHookForTests } = await import('@/services/business-operations/consolidation/consolidator');
    // (a) Deux rapprochements exacts incompatibles → carte « même réalité ».
    await k.document(c, clio.id, [cand({ provider: 'Garage A', targetHints: [cible(clio.id)], businessReferences: [ref('QUOTE', 'D1')] })], { title: 'Devis A' });
    const b = await k.document(c, clio.id, [cand({ provider: 'Garage B', targetHints: [cible(clio.id)], businessReferences: [ref('WORK_ORDER', 'OT9')] })], { title: 'Ordre B' });
    await k.passer(c);
    const deux = await k.document(c, clio.id, [cand({ provider: null, targetHints: [cible(clio.id)], businessReferences: [ref('QUOTE', 'D1'), ref('WORK_ORDER', 'OT9')], financialHints: [fh('REALIZED_COST', 1000)] })]);
    await k.passer(c);
    const [meme] = await sql<{ id: number }[]>`SELECT id FROM to_process_actions WHERE account_id = ${c.id} AND rule_code = 'OPERATION-MATCH' AND resolved_at IS NULL`;
    expect(meme).toBeTruthy();
    // (c) Montant contradictoire de même rôle → carte « montant ».
    const facture = (montant: number) => [cand({ candidateKey: 'fa', targetHints: [cible(clio.id)], businessReferences: [ref('INVOICE', 'FA-1')], financialHints: [fh('REALIZED_COST', montant)] })];
    const d1 = await k.document(c, clio.id, facture(100000), { title: 'Facture garage' });
    await k.document(c, clio.id, facture(120000), { title: 'Facture garage (copie)' });
    await k.passer(c);
    const [montant] = await sql<{ id: number }[]>`SELECT id FROM to_process_actions WHERE account_id = ${c.id} AND rule_code = 'OPERATION-AMOUNT' AND resolved_at IS NULL`;
    expect(montant).toBeTruthy();

    // La situation se résout (documents supprimés) mais la synchronisation des cartes échoue (lot 54D E05) : fermetures perdues.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id IN (${b}, ${d1})`;
    setT3FaultHookForTests(async (stage) => { if (stage === 'cards') throw new Error('panne simulée du service des cartes'); });
    await k.passer(c);
    setT3FaultHookForTests(null);
    expect((await carteEtat(meme.id)).open).toBe(true);
    expect((await carteEtat(montant.id)).open).toBe(true);
    expect(await k.candidat(deux)).toEqual([expect.objectContaining({ t3_outcome: 'MATCH_AND_ENRICH' })]);
    // Carte « montant » vue pour la dernière fois AVANT le recalcul de son Opération (horodatage antérieur).
    await sql`UPDATE to_process_actions SET last_seen_at = now() - interval '10 minutes' WHERE id = ${montant.id}`;
    await sql`UPDATE document_operation_candidates SET t3_cards_pending = false WHERE account_id = ${c.id}`;

    const blanc = await campagne([c.id], 'DRY_RUN');
    expect(blanc.status).toBe('COMPLETE');
    expect(await preuve(c.id, 'COH-TODO-OPERATION-CARDS', meme.id)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'CARD_NOT_RECONDUCTED', faultyLink: 'T3' }) });
    expect(await preuve(c.id, 'COH-TODO-OPERATION-CARDS', montant.id)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'CARD_NOT_RECONDUCTED' }) });
    expect((await carteEtat(meme.id)).open).toBe(true);

    const appels = replay.calls.length;
    await campagne([c.id], 'CORRECTIVE');
    expect(replay.calls.length).toBe(appels);
    expect(await carteEtat(meme.id)).toMatchObject({ open: false, resolution_reason: 'OBSOLETE' });
    expect(await carteEtat(montant.id)).toMatchObject({ open: false, resolution_reason: 'OBSOLETE' });
    expect((await evenements(meme.id)).at(-1)).toMatchObject({ event: 'OBSOLETE', details: expect.objectContaining({ reason: 'RESOLVED_BY_T3' }) });
    const j = await reparations(c.id, 'COH-TODO-OPERATION-CARDS');
    expect(j.map((x) => [x.object_id, x.service, x.outcome])).toEqual([[meme.id, 'consolidateDocument', 'REPAIRED'], [montant.id, 'reconsolidateOperations', 'REPAIRED']]);
    expect(await preuve(c.id, 'COH-TODO-OPERATION-CARDS', meme.id)).toMatchObject({ last_result: 'REPAIRED' });
  });

  // ══ L85B-E2E-03 ═══════════════════════════════════════════════════════════

  it('L85B-E2E-03 — résolutions non propagées : « même réalité » sans consolidation d’après validation ; déplacement vers un autre bien sans ses liens → mêmes appels que la résolution ; geste ultérieur respecté', async () => {
    const c = await compte();
    const clio = await make.asset(c);
    const { setT3FaultHookForTests } = await import('@/services/business-operations/consolidation/consolidator');
    await k.document(c, clio.id, [cand({ provider: 'Garage A', targetHints: [cible(clio.id)], businessReferences: [ref('QUOTE', 'D1')] })], { title: 'Devis A' });
    await k.document(c, clio.id, [cand({ provider: 'Garage B', targetHints: [cible(clio.id)], businessReferences: [ref('WORK_ORDER', 'OT9')] })], { title: 'Ordre B' });
    await k.passer(c);
    const deux = await k.document(c, clio.id, [cand({ provider: null, targetHints: [cible(clio.id)], businessReferences: [ref('QUOTE', 'D1'), ref('WORK_ORDER', 'OT9')], financialHints: [fh('REALIZED_COST', 1000)] })]);
    await k.passer(c);
    const [carte] = await sql<{ id: number; public_id: string; trigger_context: Json }[]>`
      SELECT id, public_id, trigger_context FROM to_process_actions WHERE account_id = ${c.id} AND rule_code = 'OPERATION-MATCH' AND resolved_at IS NULL`;
    const choisie = Number(carte.trigger_context.operationIds[0]);
    // L'utilisateur répond « même réalité que … » ; la consolidation d'après validation échoue (panne simulée).
    setT3FaultHookForTests(async (stage) => { if (stage === 'document') throw new Error('panne simulée après validation'); });
    const owner = (await sql<{ o: number }[]>`SELECT owner_user_id AS o FROM accounts WHERE id = ${c.id}`)[0].o;
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    expect(await resolveArbitration(c.id, carte.public_id, `SAME:${choisie}`, { userId: owner })).toMatchObject({ ok: true });
    setT3FaultHookForTests(null);
    const rattachee = async () => (await sql`SELECT 1 FROM business_operation_sources WHERE operation_id = ${choisie} AND source_kind = 'DOCUMENT'
                                              AND source_entity_key = ${String(deux)} AND active`).length > 0;
    expect(await rattachee()).toBe(false);

    // Déplacement d'un document vers un autre bien : fiche écrite, liens jamais propagés (état historique).
    const studio = await make.asset(c, { category: 'IMMOBILIER', name: 'Studio' });
    const maison = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    const f = await make.assetFile(c, { assetId: studio.id });
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links/document-asset-links.service');
    await linkDocumentToAsset({ accountId: c.id, fileId: f.id, target: { assetId: studio.id }, role: 'PRIMARY', origin: 'AI' });
    const { proposeDocumentAssetConflict } = await import('@/services/to-process/document-asset-conflict');
    expect(await proposeDocumentAssetConflict({ accountId: c.id, fileId: f.id, currentAssetId: studio.id, suggestedAssetId: maison.id, basis: 'IDENTIFIER' as never }))
      .toMatchObject({ status: 'CREATED' });
    const [conflit] = await sql<{ id: number; public_id: string }[]>`SELECT id, public_id FROM to_process_actions WHERE account_id = ${c.id} AND rule_code = 'LINK-ASSET-CONFLICT' AND resolved_at IS NULL`;
    expect(await resolveArbitration(c.id, conflit.public_id, `MOVE:${maison.id}`, { userId: owner })).toMatchObject({ ok: true });
    await sql`UPDATE document_asset_links SET created_at = now() - interval '2 hours' WHERE file_id = ${f.id}`;
    await sql`UPDATE to_process_actions SET resolved_at = now() - interval '1 hour' WHERE id = ${conflit.id}`;
    // Propagation perdue : aucun lien vers la maison, l'ancien lien (analyse) vers le studio est resté actif.
    await sql`DELETE FROM document_asset_links WHERE file_id = ${f.id} AND asset_id = ${maison.id}`;
    await sql`UPDATE document_asset_links SET status = 'ACTIVE', removed_at = NULL WHERE file_id = ${f.id} AND asset_id = ${studio.id} AND origin = 'AI'`;

    const blanc = await campagne([c.id], 'DRY_RUN');
    expect(blanc.status).toBe('COMPLETE');
    expect(await preuve(c.id, 'COH-TODO-RESOLUTION-PROPAGATION', carte.id)).toMatchObject({ last_result: 'WOULD_REPAIR', rules_version: 2,
      finding: expect.objectContaining({ anomaly: 'RESOLUTION_NOT_PROPAGATED', faultyLink: 'T3' }) });
    expect(await preuve(c.id, 'COH-TODO-RESOLUTION-PROPAGATION', conflit.id)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ faultyLink: 'LINK' }) });
    expect(await rattachee()).toBe(false);

    await campagne([c.id], 'CORRECTIVE');
    expect(await rattachee()).toBe(true);
    const liens = await sql<Json[]>`SELECT asset_id, link_role, origin FROM document_asset_links WHERE file_id = ${f.id} AND status = 'ACTIVE' ORDER BY id`;
    expect(liens).toContainEqual({ asset_id: maison.id, link_role: 'PRIMARY', origin: 'USER' });
    expect(liens.filter((l) => l.asset_id === studio.id && l.origin !== 'LEGACY_COLUMN')).toEqual([]);
    const j = await reparations(c.id, 'COH-TODO-RESOLUTION-PROPAGATION');
    expect(j.map((x) => [x.object_id, x.service, x.outcome, x.check_version])).toEqual([
      [carte.id, 'consolidateDocument', 'REPAIRED', 2], [conflit.id, 'linkDocumentToAsset', 'REPAIRED', 2],
    ]);
    // Geste ultérieur de l'utilisateur : liens vers la maison retirés → respecté (aucune réparation).
    await sql`UPDATE document_asset_links SET status = 'REMOVED', removed_at = now() WHERE file_id = ${f.id} AND asset_id = ${maison.id} AND status = 'ACTIVE'`;
    await campagne([c.id], 'CORRECTIVE');
    expect(await reparations(c.id, 'COH-TODO-RESOLUTION-PROPAGATION')).toHaveLength(2);
    expect(await preuve(c.id, 'COH-TODO-RESOLUTION-PROPAGATION', conflit.id)).toMatchObject({ last_result: 'CONSISTENT' });
  });

  // ══ L85B-E2E-04 ═══════════════════════════════════════════════════════════

  it('L85B-E2E-04 — réévaluation historique (§6.4) : version changée → stock entier réexaminé par la campagne quotidienne, anti-boucle levée une fois ; version déployée EN COURS de campagne (parcours, vérification) : jamais de preuve d’une version périmée', async () => {
    const { getCheck, registryVersion } = await import('@/services/coherence/registry');
    const check = getCheck('COH-TODO-AGENDA-PROPOSAL-CARDS')!;
    const v0 = check.version;
    const prop = await import('@/services/to-process/agenda-proposal-cards');
    const comptes = [await compte(), await compte()];
    const cartes: number[] = [];
    for (const c of comptes) {
      const f = await make.assetFile(c, {});
      for (const t of ['A', 'B']) {
        const fk = `e2e-85b-v-${c.id}-${t}`;
        await prop.proposeAgendaCreation({ accountId: c.id, sourceFileId: f.id, functionalKey: fk, candidate: {
          title: `Échéance ${t}`, date: '2027-02-01', category: 'action', originFieldKey: null, nature: 'DEADLINE', businessType: null, assetId: 0,
          target: null, sources: [{ fileId: f.id, role: 'SOURCE' }], reasonCode: 'SOURCE_TYPE_NOT_AUTHORIZED', documentType: 'DEVIS' } });
        cartes.push((await sql<{ id: number }[]>`SELECT id FROM to_process_actions WHERE account_id = ${c.id} AND relation_key = ${`agenda:${fk}`}`)[0].id);
      }
    }
    const scope = comptes.map((c) => c.id);
    const preuvesDe = () => sql<Json[]>`SELECT account_id, object_id::int AS object_id, rules_version, last_success_at, last_result, registry_version
      FROM coherence_object_proofs WHERE check_id = ${check.id} AND account_id = ANY(${scope}::int[]) ORDER BY object_id`;
    const J = new Date('2031-03-03T06:00:00Z');
    const J1 = new Date('2031-03-04T06:00:00Z');
    const J2 = new Date('2031-03-05T06:00:00Z');
    try {
      // Jour J (version courante) : stock contrôlé, preuve par objet portant la version.
      const c1 = await campagne(scope, 'CORRECTIVE', { kind: 'DAILY', now: J });
      expect(c1.status).toBe('COMPLETE');
      expect((await preuvesDe()).map((p) => [p.object_id, p.rules_version, p.last_result])).toEqual(cartes.map((id) => [id, v0, 'CONSISTENT']));
      // Réparation INEFFICACE sous la version courante (service espionné) → suspendue au passage suivant (anti-boucle).
      await sql`INSERT INTO agenda_items (account_id, title, start_date, functional_key) VALUES (${comptes[0].id}, 'Échéance A', '2027-02-01', ${`e2e-85b-v-${comptes[0].id}-A`})`;
      const espion = vi.spyOn(check as { repair: NonNullable<typeof check.repair> }, 'repair').mockImplementation(async (_ctx, _a, items) =>
        new Map(items.map((x) => [x.id, { called: true, service: 'closeObsoleteAgendaProposals', result: { closed: 0 } }])));
      await campagne(scope, 'CORRECTIVE', { now: J });
      await campagne(scope, 'CORRECTIVE', { now: J });
      espion.mockRestore();
      expect(await preuve(comptes[0].id, check.id, cartes[0])).toMatchObject({ last_result: 'REPAIR_SUPPRESSED', rules_version: v0 });

      // NOUVELLE VERSION du contrôle (déploiement) : la campagne quotidienne suivante réexamine TOUT le stock.
      (check as { version: number }).version = v0 + 1;
      const r1 = registryVersion();
      const c2 = await campagne(scope, 'CORRECTIVE', { kind: 'DAILY', now: J1 });
      expect(c2.status).toBe('COMPLETE');
      const p2 = await preuvesDe();
      expect(p2.every((p) => p.rules_version === v0 + 1 && p.registry_version === r1)).toBe(true);
      expect(p2.every((p) => new Date(p.last_success_at).getTime() >= c2.startedAt.getTime())).toBe(true);
      // Anti-boucle levée UNE fois par la nouvelle version : la réparation (service réel) aboutit.
      expect(await preuve(comptes[0].id, check.id, cartes[0])).toMatchObject({ last_result: 'REPAIRED', rules_version: v0 + 1 });
      const [cov] = await sql<Json[]>`SELECT registry_version, coverage, rules_changes FROM coherence_campaigns WHERE id = ${c2.id}`;
      expect(cov.registry_version).toBe(r1);
      // Vérification : 3 cartes encore ouvertes (la 4e vient d'être close par la réparation), toutes contrôlées.
      expect(cov.coverage[check.id]).toMatchObject({ version: v0 + 1, expected: 3, remaining: 0 });
      expect(cov.rules_changes).toEqual([]);

      // Version déployée EN COURS de campagne — 1. pendant le PARCOURS (arrêt au 2e compte, redémarrage sur le nouveau code).
      const orch = await orchestrateur();
      const lister = check.listObjects!.bind(check);
      let appelsB = 0;
      let panne: 'TRAVERSE' | 'VERIFY' = 'TRAVERSE';
      const espionListe = vi.spyOn(check as { listObjects: NonNullable<typeof check.listObjects> }, 'listObjects').mockImplementation(async (ctx, accountId, afterId, limit) => {
        if (accountId === comptes[1].id && afterId === 0) {
          appelsB += 1;
          if ((panne === 'TRAVERSE' && appelsB === 1) || (panne === 'VERIFY' && appelsB === 2)) throw new Error(`redémarrage simulé (${panne})`);
        }
        return lister(ctx, accountId, afterId, limit);
      });
      try {
        for (const [phase, jour, versionApres] of [['TRAVERSE', J2, v0 + 2], ['VERIFY', new Date('2031-03-06T06:00:00Z'), v0 + 3]] as const) {
          panne = phase; appelsB = 0;
          const id = await orch.startCampaign({ kind: 'DAILY', trigger: 'e2e', mode: 'CORRECTIVE', scopeAccountIds: scope, now: jour });
          await expect(orch.runCampaignStep(id, { deadline: Date.now() + 120_000, now: jour, today: RECETTE_TODAY })).rejects.toThrow(/redémarrage simulé/);
          const avant = (await orch.getCampaign(id))!;
          expect(avant).toMatchObject({ status: 'RUNNING', phase });
          (check as { version: number }).version = versionApres;
          for (let i = 0; i < 40 && !(await orch.runCampaignStep(id, { deadline: Date.now() + 120_000, now: jour, today: RECETTE_TODAY })).done; i++) { /* reprise */ }
          const fin = (await orch.getCampaign(id))!;
          expect(fin.status).toBe('COMPLETE');
          expect(fin.rulesChanges).toEqual([expect.objectContaining({ phase, changed: [{ id: check.id, from: versionApres - 1, to: versionApres }], added: [], removed: [], verifyRestarted: phase === 'VERIFY' })]);
          expect(fin.registryVersion).toBe(registryVersion());
          // Aucun objet déclaré contrôlé selon la version périmée : TOUS ont une preuve réussie de la nouvelle version pendant la campagne.
          const p = (await preuvesDe()).filter((x) => x.object_id !== cartes[0]);
          expect(p.map((x) => x.rules_version)).toEqual(cartes.slice(1).map(() => versionApres));
          expect(p.every((x) => new Date(x.last_success_at).getTime() >= fin.startedAt.getTime())).toBe(true);
          const [x] = await sql<Json[]>`SELECT coverage FROM coherence_campaigns WHERE id = ${id}`;
          expect(x.coverage[check.id]).toMatchObject({ version: versionApres, expected: 3, remaining: 0 });
        }
      } finally {
        espionListe.mockRestore();
      }
    } finally {
      (check as { version: number }).version = v0;
    }
  });

  // ══ L85B-E2E-05 ═══════════════════════════════════════════════════════════

  it('L85B-E2E-05 (CA-15) — taxe foncière historique découverte par le PASSAGE PÉRIODIQUE : maillon T1 réparé sans action ni événement ; constat TCO en attente du contrat IA (aucune compensation codée) ; Supervision', async () => {
    const c = await compte();
    const maison = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    const f = await make.assetFile(c, { assetId: maison.id });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`avis-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    // Analyse T1 (point d'entrée de production) il y a plusieurs jours : le montant de l'avis (unité non couverte) est oublié.
    await rejouer([REPARATION(avisFoncier({ facts: [] })), T1(avisFoncier({ transcription: AVIS, facts: [fait('Date : 01/09/2025', '2025-09-01')] }))]);
    const owner = (await sql<{ o: number }[]>`SELECT owner_user_id AS o FROM accounts WHERE id = ${c.id}`)[0].o;
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    await analyzeFileSources([f.id], c.id, { userId: owner, billable: false, origin: 'e2e/l85b' });
    await drainQueues();
    // Aucune demande de contrôle CIBLÉ en attente : la découverte ne pourra venir que du passage périodique.
    await sql`UPDATE coherence_object_proofs SET requested_at = NULL, request_reason = NULL WHERE account_id = ${c.id}`;
    await sql`UPDATE asset_files SET updated_at = now() - interval '6 days' WHERE id = ${f.id}`;
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    const ligneAvant = (await readAssetTco(c.id, maison.id, { today: RECETTE_TODAY })).lines.find((l) => l.fileId === f.id);

    // J+6 — campagne QUOTIDIENNE (même code que la tâche planifiée), à blanc : découverte, aucune écriture, aucun appel IA.
    await rejouer([]);
    const jour = (n: number) => new Date(Date.UTC(2031, 4, n, 4, 0, 0));
    const blanc = await campagne([c.id], 'DRY_RUN', { kind: 'DAILY', now: jour(10), trigger: 'schedule' });
    expect(blanc).toMatchObject({ kind: 'DAILY', status: 'COMPLETE', trigger: 'schedule' });
    expect(replay.calls.filter((x) => !String(x.operationCode ?? '').startsWith('t6_'))).toEqual([]);
    const chaine = await preuve(c.id, 'COH-DOC-EXTRACT-CHAIN', f.id);
    expect(chaine).toMatchObject({ last_trigger: 'DAILY', last_result: 'WOULD_REPAIR', requested_at: null,
      finding: expect.objectContaining({ anomaly: 'FACT_OMITTED_BY_T1', faultyLink: 'T1', observed: [expect.objectContaining({ values: [{ kind: 'AMOUNT', value: '123400' }] })] }) });

    // J+7 — campagne quotidienne CORRECTIVE : relance T1 ciblée (passe de réparation existante), montant retrouvé et prouvé.
    await rejouer([REPARATION(avisFoncier({ facts: [fait('Montant de votre impôt : 1 234,00 €', '1234.00')] }), '[page:1:field:2]')]);
    const corr = await campagne([c.id], 'CORRECTIVE', { kind: 'DAILY', now: jour(11), trigger: 'schedule' });
    expect(corr.status).toBe('COMPLETE');
    expect(replay.calls.filter((x) => x.operationCode === 't1_analyze_document')).toHaveLength(1);
    expect((await sql<Json[]>`SELECT value_text FROM document_facts WHERE file_id = ${f.id} AND status = 'active' ORDER BY id`).map((x) => x.value_text)).toContain('1234.00');
    expect(await preuve(c.id, 'COH-DOC-EXTRACT-CHAIN', f.id)).toMatchObject({ last_trigger: 'DAILY', last_result: 'REPAIRED' });
    expect(await reparations(c.id, 'COH-DOC-EXTRACT-CHAIN')).toEqual([expect.objectContaining({ service: 'repairDocumentSourceUnits', outcome: 'REPAIRED', recheck_verdict: 'CONSISTENT', anomaly: 'FACT_OMITTED_BY_T1' })]);
    expect(corr.metrics.aiCalls).toBeGreaterThanOrEqual(1);

    // Ce qui reste en CONSTAT faute du contrat IA : la décision d'inclusion au TCO (C-Q6, demande 82B-t3-decision-tco).
    // Le moteur TCO n'a toujours AUCUNE ligne pour l'avis (montant connu de T1 sous forme de fait, sans indice financier) :
    // aucune compensation codée (C-Q6), le contrôle le CONSTATE — maillon T1, contrats IA attendus.
    const ligneApres = (await readAssetTco(c.id, maison.id, { today: RECETTE_TODAY })).lines.find((l) => l.fileId === f.id);
    expect(ligneAvant).toBeUndefined();
    expect(ligneApres).toBeUndefined();
    const tco = await preuve(c.id, 'COH-TCO-EXTRACTED-EXPENSES', maison.id);
    expect(tco).toMatchObject({ last_trigger: 'DAILY', last_result: 'FINDING', rules_version: 2, finding: expect.objectContaining({
      anomaly: 'SOURCE_AMOUNT_NOT_EXPLOITED', faultyLink: 'T1', observed: [{ fileId: f.id, amounts: [123400] }],
      detail: expect.objectContaining({ pendingContract: '82B-t1-omissions-extract', inclusionContract: '82B-t3-decision-tco', t1Relaunch: false }) }) });
    expect(await reparations(c.id, 'COH-TCO-EXTRACTED-EXPENSES')).toEqual([]);

    // Passages suivants : aucune relance, aucun doublon ; la Supervision existante porte les constats persistants.
    await rejouer([]);
    await campagne([c.id], 'CORRECTIVE', { kind: 'DAILY', now: jour(12), trigger: 'schedule' });
    await campagne([c.id], 'CORRECTIVE', { kind: 'DAILY', now: jour(13), trigger: 'schedule' });
    expect(replay.calls.filter((x) => !String(x.operationCode ?? '').startsWith('t6_'))).toEqual([]);
    expect(await reparations(c.id, 'COH-DOC-EXTRACT-CHAIN')).toHaveLength(1);
    expect(await preuve(c.id, 'COH-DOC-EXTRACT-CHAIN', f.id)).toMatchObject({ last_result: 'CONSISTENT' });
    expect(await preuve(c.id, 'COH-TCO-EXTRACTED-EXPENSES', maison.id)).toMatchObject({ last_result: 'FINDING', finding_streak: 4 });
    // Résultat tracé dans la Supervision existante (constat persistant agrégé, aucun onglet, aucune carte utilisateur).
    const { syncCoherenceSupervision } = await import('@/services/coherence/supervision');
    await syncCoherenceSupervision({ now: new Date() });
    const [alerte] = await sql<Json[]>`SELECT status, technical_detail AS detail FROM admin_anomalies WHERE fingerprint = 'other:coherence:coh-tco-extracted-expenses:persistent'`;
    expect(alerte).toMatchObject({ status: 'open' });
    expect(String(alerte.detail.accountIds)).toContain(String(c.id));
    expect(String(alerte.detail.anomalies)).toContain('SOURCE_AMOUNT_NOT_EXPLOITED');
    expect(await sql`SELECT id FROM to_process_actions WHERE account_id = ${c.id} AND target_type = 'DOCUMENT' AND target_id = ${f.id} AND resolved_at IS NULL AND rule_code LIKE 'COH%'`).toEqual([]);
  });

  // ══ L85B-E2E-06 ═══════════════════════════════════════════════════════════

  it('L85B-E2E-06 — mesures (C-Q1) sur un jeu volumineux : durée, objets, couverture, appels IA ; fenêtre 5 h → minuit ; campagne PARTIELLE et constats persistants dans la Supervision existante', async () => {
    const COMPTES = 6;
    const DOCS = 25;
    const scope: number[] = [];
    for (let i = 0; i < COMPTES; i++) {
      const c = await compte();
      scope.push(c.id);
      const bien = await make.asset(c, { category: 'IMMOBILIER', name: `Maison ${i}` });
      for (let d = 0; d < DOCS; d++) {
        // Avis d'exercices DIFFÉRENTS au MÊME montant (scénario 4 du CDC) : jamais confondus avec des doublons.
        if (d % 5 === 0) await k.vieuxDocument(c, bien.id, { type: 'PROPERTY_TAX_NOTICE', title: `Avis ${2000 + d}`, amountCents: 100_000, date: `${2000 + d}-09-01` });
        else await k.document(c, bien.id, [cand({ candidateKey: `c${d}`, provider: `Prestataire ${d}`, targetHints: [cible(bien.id)], businessReferences: [ref('INVOICE', `F-${i}-${d}`)], financialHints: [fh('REALIZED_COST', 1_000 + d)] })], { title: `Facture ${d}`, type: 'FACTURE', amountCents: 1_000 + d });
      }
      await k.passer(c);
    }
    await rejouer([]);
    const t0 = Date.now();
    const camp = await campagne(scope, 'DRY_RUN', { kind: 'DAILY', now: new Date('2031-06-02T03:00:00Z'), trigger: 'schedule' });
    const mur = Date.now() - t0;
    expect(camp.status).toBe('COMPLETE');
    const [row] = await sql<Json[]>`SELECT metrics, coverage, remaining, accounts FROM coherence_campaigns WHERE id = ${camp.id}`;
    const m = row.metrics;
    // Mesures rapportées par la campagne : durée, objets, couverture, appels IA, ressources.
    expect(m.objectsControlled).toBeGreaterThan(COMPTES * DOCS);
    expect(m.aiCalls).toBe(0);
    expect(m.durationMs).toBeGreaterThan(0);
    expect(m.wallClockMs).toBeGreaterThanOrEqual(0);
    expect(m.expectedObjects).toBeGreaterThan(0);
    expect(m.remainingObjects).toBe(0);
    expect(m.cpuUserMs + m.cpuSystemMs).toBeGreaterThan(0);
    expect(row.accounts.visited).toBe(COMPTES);
    const attendus = Object.values(row.coverage as Record<string, { expected: number; remaining: number }>);
    expect(attendus.reduce((n, x) => n + x.expected, 0)).toBe(m.expectedObjects);
    expect(attendus.every((x) => x.remaining === 0)).toBe(true);
    // Ordre de grandeur : objets contrôlés par seconde de calcul, capacité de la fenêtre 5 h → minuit
    // (passages de 12 min toutes les 15 min, un tiers réservé aux rattrapages et contrôles ciblés).
    const parObjetMs = m.durationMs / m.objectsControlled;
    const fenetreMs = 19 * 3_600_000 * (12 / 15) * (2 / 3);
    const capacite = Math.floor(fenetreMs / parObjetMs);
    console.info('[L85B-E2E-06] mesures :', JSON.stringify({ objets: m.objectsControlled, attendus: m.expectedObjects, calculMs: m.durationMs, murMs: mur, parObjetMs: Number(parObjetMs.toFixed(2)), capaciteFenetre: capacite, rssMo: m.rssPeakMb }));
    // Le jeu tient très largement dans la fenêtre (la capacité estimée dépasse 100 fois le volume du jeu).
    expect(capacite).toBeGreaterThan(m.objectsControlled * 100);

    // Scénario 4 : cinq exercices au même montant → cinq constats distincts (aucun doublon présumé, aucune valeur inventée).
    const [p0] = await sql<Json[]>`SELECT finding FROM coherence_object_proofs WHERE account_id = ${scope[0]} AND check_id = 'COH-TCO-EXTRACTED-EXPENSES'`;
    expect(p0.finding).toMatchObject({ anomaly: 'EXTRACTED_EXPENSE_NOT_EVALUATED' });
    expect(p0.finding.observed.map((x: Json) => x.amountMinor)).toEqual([100_000, 100_000, 100_000, 100_000, 100_000]);
    expect(new Set(p0.finding.observed.map((x: Json) => x.fileId)).size).toBe(5);

    // Supervision (C-Q3, sans onglet) : campagne quotidienne PARTIELLE et constats persistants (avis sans décision d'inclusion).
    const orch = await orchestrateur();
    const partielle = await orch.startCampaign({ kind: 'DAILY', trigger: 'schedule', mode: 'DRY_RUN', scopeAccountIds: scope, now: new Date('2031-06-03T03:00:00Z'), deadlineAt: new Date(Date.now() - 1000) });
    expect(await orch.runCampaignStep(partielle, { deadline: Date.now() + 60_000 })).toMatchObject({ status: 'PARTIAL', done: true });
    for (const d of [4, 5]) await campagne(scope, 'DRY_RUN', { now: new Date(`2031-06-0${d}T03:00:00Z`) });
    const { syncCoherenceSupervision } = await import('@/services/coherence/supervision');
    await syncCoherenceSupervision({ now: new Date() });
    const alertes = await sql<Json[]>`SELECT fingerprint, status, title FROM admin_anomalies WHERE fingerprint LIKE 'other:coherence:%' AND status = 'open' ORDER BY fingerprint`;
    expect(alertes.map((a) => a.fingerprint)).toEqual(expect.arrayContaining(['other:coherence:campaign:daily', 'other:coherence:coh-tco-extracted-expenses:persistent']));
    expect(alertes.find((a) => a.fingerprint === 'other:coherence:campaign:daily')!.title).toMatch(/partielle \(non exhaustive\)/);
  });
});
