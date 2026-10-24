/**
 * Lot 85E — acquisition RÉALISÉE sans date alors que la date d'acquisition
 * canonique du bien est connue (ticket PO P1 du 23/10/2026) — PostgreSQL 16
 * réel.
 *
 * Chaînes de PRODUCTION : fiche du bien (`updateAssetDetails`, origine
 * USER), primitive canonique (écriture automatique T1 « DOCUMENT_EXTRACTION »
 * et T3 « RECONCILIATION »), persistance T1 des candidats, consolidation T3
 * (`consolidateAssetData`, `consolidateAccountOperations`), migration
 * structurée (tâche interne), projection T4 (`projectAccountOperations`),
 * producteur « À traiter » DATA-AGENDA-DATE, orchestrateur de cohérence
 * (campagne à blanc puis corrective), diagnostic BO. Aucun appel IA.
 * Assertions limitées aux comptes créés ici ; date de référence injectée.
 *
 *   L85E-E2E-01  date USER + Opération existante sans date → datée, événement Achat existant daté, carte fermée
 *   L85E-E2E-02  date T1 (document) / T3 + Opération existante sans date → datée (provenance : origine conservée)
 *   L85E-E2E-03  Opération documentaire sans date + date T1 de la fiche → source d'enrichissement, un seul prix
 *   L85E-E2E-04  date automatique seule, sans Opération → aucune création (T3, migration, cohérence)
 *   L85E-E2E-05  Opération déjà datée → NO_CHANGE (aucune écriture, historique inchangé)
 *   L85E-E2E-06  date contradictoire → date conservée, contradiction tracée, arbitrage par la carte existante
 *   L85E-E2E-07  événement Achat modifié par l'utilisateur → jamais réécrit, aucun second événement
 *   L85E-E2E-08  reprise du stock par COH-OPS-ACQUISITION-DATE (à blanc puis correctif), diagnostic BO
 *   L85E-E2E-09  second passage strictement idempotent ; aucun doublon d'Opération, de montant, d'événement
 *   L85E-E2E-10  (ticket BO › Comptes) recherche par ID du compte sur la route réelle, aucun champ sensible ajouté
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { NextRequest } from 'next/server';
import { uid, type AccountRow, type AssetRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const AUJ = '2026-10-24';
const adc = () => import('@/services/business-operations/consolidation/asset-data-consolidator');
const consolidator = () => import('@/services/business-operations/consolidation/consolidator');
const facade = () => import('@/services/asset-details-write.service');
const projection = () => import('@/services/business-operations/agenda-projection/service');
const bus = () => import('@/services/business-operations/events');

function cand(over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate {
  return {
    candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'ACQUISITION', statusHint: 'REALIZED',
    summary: 'Achat du véhicule', sourceRoleHint: 'INVOICE', provider: 'Garage Exemple',
    targetHints: [], businessReferences: [], temporalHints: {}, financialHints: [], evidenceFactRefs: ['f1'],
    visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
  };
}
const fh = (role: string, amountMinor: number) =>
  ({ role, amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, factRef: 'f1' }) as AnchoredOperationCandidate['financialHints'][number];
const cible = (entityId: number) => ({ type: 'ASSET' as const, entityId, rawLabel: null, confidence: 'certain' as const });

scenario('L85E', 'Acquisition réalisée sans date : enrichissement par la date canonique du bien, T4, reprise du stock', ({ sql, make }) => {
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });

  // ── Outils ────────────────────────────────────────────────────────────────
  const fiche = async (compte: AccountRow, assetId: number, fields: Record<string, unknown>) =>
    (await facade()).updateAssetDetails({ assetId, accountId: compte.id, section: 'common', fields, actorUserId: compte.ownerUserId });
  const automatique = async (compte: AccountRow, assetId: number, value: string, origin: 'DOCUMENT_EXTRACTION' | 'RECONCILIATION') => {
    const canon = await import('@/services/canonical/asset-state');
    await canon.writeCanonicalAssetFields({
      assetId, accountId: compte.id, origin, source: { type: origin === 'RECONCILIATION' ? 'reconciliation' : 'document', id: 'e2e-85e' },
      writes: [{ key: 'acquisitionDate', value }],
    });
  };
  const reconcilier = async (compte: AccountRow, assetId: number) => (await adc()).consolidateAssetData(compte.id, assetId, { today: AUJ });
  const projeter = async (compte: AccountRow, ids?: number[]) => (await projection()).projectAccountOperations(compte.id,
    ids ? { operationIds: ids, correlationId: 'l85e', today: AUJ } : { all: true, correlationId: 'l85e', today: AUJ });
  async function document(compte: AccountRow, assetId: number, candidats: AnchoredOperationCandidate[]) {
    const f = await make.assetFile(compte, { assetId });
    const [x] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${f.id}) RETURNING id`;
    const { replaceOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/persist');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await replaceOperationCandidates(tx as never, {
        accountId: compte.id, fileId: f.id, extractionId: x.id, analysisRunId: null, reanalysis: false, candidates: candidats, facts: new Map(),
      });
    });
    await (await consolidator()).consolidateAccountOperations(compte.id, { today: AUJ, operationMatch: false });
    return f.id;
  }
  const acquisitions = (compte: AccountRow) => sql<Json[]>`
    SELECT id::int AS id, status, realized_date::text AS realized_date, invalidated_at IS NULL AS active,
           attribute_provenance -> 'fields' -> 'realizedDate' AS prov, attribute_provenance -> 'conflicts' AS conflicts
      FROM business_operations WHERE account_id = ${compte.id} AND type_code = 'ACQUISITION' ORDER BY id`;
  const toutesOps = async (compte: AccountRow) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${compte.id}`)[0].n;
  const composantes = (opId: number) => sql<Json[]>`
    SELECT kind, amount_minor::int AS amount_minor FROM business_operation_financial_components WHERE operation_id = ${opId} AND active ORDER BY id`;
  const sources = (opId: number) => sql<Json[]>`
    SELECT source_kind AS kind, authority, active, locator->>'nature' AS nature, match_reason FROM business_operation_sources WHERE operation_id = ${opId} ORDER BY id`;
  const historique = async (compte: AccountRow) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_history WHERE account_id = ${compte.id}`)[0].n;
  const evenements = (compte: AccountRow) => sql<Json[]>`
    SELECT id, title, start_date::text AS date, business_operation_id::int AS op, operation_role AS role, is_automatic_modified AS modified, projection_origin AS proj
      FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`;
  const cartesDate = (itemId: number) => sql<Json[]>`
    SELECT rule_code, action_kind, question, resolved_at IS NOT NULL AS resolu, resolution_reason, proposals_json AS proposals
      FROM to_process_actions WHERE target_type = 'AGENDA_ITEM' AND target_id = ${itemId} AND field_key = 'date' ORDER BY id`;

  /** Constat du ticket : ACQUISITION réalisée depuis le prix saisi, SANS date ; événement Achat sans date + carte « À quelle date… ». */
  async function achatSansDate(): Promise<{ compte: AccountRow; clio: AssetRow; op: number; achat: Json }> {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    await fiche(compte, clio.id, { acquisitionPrice: 18490.5 });
    await reconcilier(compte, clio.id);
    const [o] = await acquisitions(compte);
    expect(o).toMatchObject({ status: 'REALIZED', realized_date: null, active: true });
    await projeter(compte, [o.id]);
    const [achat, ...autres] = await evenements(compte);
    expect(autres).toEqual([]);
    expect(achat).toMatchObject({ op: o.id, role: 'PRINCIPAL', date: null, modified: false, proj: 'OPERATION' });
    expect(await cartesDate(achat.id)).toEqual([expect.objectContaining({ rule_code: 'DATA-AGENDA-DATE', action_kind: 'COMPLETE', resolu: false })]);
    expect((await cartesDate(achat.id))[0].question).toMatch(/^À quelle date « .+ » a-t-il lieu \?$/);
    return { compte, clio, op: o.id, achat };
  }

  /** Projection T4 puis contrôle : événement Achat EXISTANT daté, carte fermée comme obsolète, aucun autre événement. */
  async function attendreProjection(compte: AccountRow, op: number, achat: Json, date: string) {
    const r = await projeter(compte, [op]);
    expect(r).toMatchObject({ created: 0, updated: 1 });
    const tous = await evenements(compte);
    expect(tous).toEqual([expect.objectContaining({ id: achat.id, op, role: 'PRINCIPAL', date, modified: false })]);
    expect(await cartesDate(achat.id)).toEqual([expect.objectContaining({ rule_code: 'DATA-AGENDA-DATE', resolu: true, resolution_reason: 'OBSOLETE' })]);
  }

  // ══ 01 ═══════════════════════════════════════════════════════════════════

  it('L85E-E2E-01 — date USER + Opération existante sans date : date posée, événement Achat existant daté, carte fermée', async () => {
    const { compte, clio, op, achat } = await achatSansDate();
    await fiche(compte, clio.id, { acquisitionDate: '2021-03-01' });
    const r = await reconcilier(compte, clio.id);
    expect(r.natures.find((n) => n.nature === 'ACQUISITION')).toMatchObject({ outcome: 'LINKED', operationId: op });
    expect(await acquisitions(compte)).toEqual([expect.objectContaining({ id: op, realized_date: '2021-03-01' })]);
    expect((await acquisitions(compte))[0].prov).toMatchObject({ value: '2021-03-01' });
    await attendreProjection(compte, op, achat, '2021-03-01');
  });

  // ══ 02 ═══════════════════════════════════════════════════════════════════

  for (const origin of ['DOCUMENT_EXTRACTION', 'RECONCILIATION'] as const) {
    it(`L85E-E2E-02 — date automatique (${origin === 'DOCUMENT_EXTRACTION' ? 'T1 / document' : 'T3'}) + Opération existante sans date : datée, provenance et origine conservées`, async () => {
      const { compte, clio, op, achat } = await achatSansDate();
      await automatique(compte, clio.id, '2021-03-01', origin);
      const r = await reconcilier(compte, clio.id);
      expect(r.changes).toBeGreaterThan(0);
      const [o, ...autres] = await acquisitions(compte);
      expect(autres).toEqual([]);
      expect(o).toMatchObject({ id: op, realized_date: '2021-03-01' });
      // Provenance 78A : source ASSET_DATA de l'Opération + origine de la valeur canonique.
      const [s] = await sources(op);
      expect(o.prov).toMatchObject({ value: '2021-03-01', origin });
      expect(s).toMatchObject({ kind: 'ASSET_DATA', nature: 'ACQUISITION', active: true });
      // Un seul prix (le prix saisi), aucune autre réalité économique.
      expect(await composantes(op)).toEqual([{ kind: 'REALIZED_COST', amount_minor: 1849050 }]);
      // La fiche n'est jamais réécrite par l'Opération (B1).
      expect(await sql`SELECT 1 FROM canonical_field_writes WHERE asset_id = ${clio.id} AND origin = 'USER' AND canonical_key = 'acquisitionDate'`).toHaveLength(0);
      await attendreProjection(compte, op, achat, '2021-03-01');
    });
  }

  // ══ 03 ═══════════════════════════════════════════════════════════════════

  it('L85E-E2E-03 — Opération documentaire sans date + date T1 de la fiche : source d’enrichissement, date posée, un seul prix ; retrait du document → la date seule ne maintient rien', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const facture = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], financialHints: [fh('REALIZED_COST', 1900000)] })]);
    const [o] = await acquisitions(compte);
    expect(o).toMatchObject({ realized_date: null, status: 'REALIZED' });
    await automatique(compte, clio.id, '2021-03-02', 'DOCUMENT_EXTRACTION');
    const r = await reconcilier(compte, clio.id);
    expect(r.natures.find((n) => n.nature === 'ACQUISITION')).toMatchObject({ outcome: 'MATCH_AND_ENRICH', reason: 'ASSET_DATA_DATE_ENRICHMENT', operationId: o.id });
    expect(await acquisitions(compte)).toEqual([expect.objectContaining({ id: o.id, realized_date: '2021-03-02' })]);
    expect((await acquisitions(compte))[0].prov).toMatchObject({ value: '2021-03-02', origin: 'DOCUMENT_EXTRACTION' });
    expect((await sources(o.id)).map((s) => [s.kind, s.active])).toEqual([['DOCUMENT', true], ['ASSET_DATA', true]]);
    expect((await sources(o.id))[1]).toMatchObject({ authority: 'STRUCTURED', nature: 'ACQUISITION', match_reason: 'ASSET_DATA_DATE_ENRICHMENT' });
    expect(await composantes(o.id)).toEqual([{ kind: 'REALIZED_COST', amount_minor: 1900000 }]);
    expect(await toutesOps(compte)).toBe(1);
    // Rejouée : aucune écriture.
    expect((await reconcilier(compte, clio.id)).changes).toBe(0);
    // Document supprimé : la date automatique seule ne prouve pas l'achat (Opération invalidée, jamais recréée).
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${facture}`;
    await (await consolidator()).reconsolidateOperations(compte.id, [o.id], { today: AUJ });
    expect((await acquisitions(compte))[0]).toMatchObject({ id: o.id, active: false });
    expect((await sources(o.id)).every((s) => s.active === false)).toBe(true);
    await reconcilier(compte, clio.id);
    expect(await toutesOps(compte)).toBe(1);
    expect((await acquisitions(compte))[0]).toMatchObject({ active: false });
  });

  // ══ 04 ═══════════════════════════════════════════════════════════════════

  it('L85E-E2E-04 — date automatique seule, sans Opération : aucune création (T3, migration structurée, campagne de cohérence corrective)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    await automatique(compte, clio.id, '2021-03-01', 'DOCUMENT_EXTRACTION');
    const r = await reconcilier(compte, clio.id);
    expect(r.natures.find((n) => n.nature === 'ACQUISITION')).toMatchObject({ outcome: 'NONE', reason: 'AUTOMATIC_VALUE_NO_CREATION', operationId: null });
    const m = await (await adc()).runStructuredOperationsMigration({ apply: true, accountId: compte.id, today: AUJ });
    expect(m.changes).toBe(0);
    await campagne([compte.id], 'CORRECTIVE');
    expect(await toutesOps(compte)).toBe(0);
    expect(await evenements(compte)).toEqual([]);
  });

  // ══ 05 ═══════════════════════════════════════════════════════════════════

  it('L85E-E2E-05 — Opération déjà correctement datée : NO_CHANGE (aucune écriture, historique inchangé, passage T3 sans changement)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    await fiche(compte, clio.id, { acquisitionPrice: 18490.5, acquisitionDate: '2021-03-01' });
    await reconcilier(compte, clio.id);
    const [o] = await acquisitions(compte);
    expect(o).toMatchObject({ realized_date: '2021-03-01' });
    await projeter(compte);
    const h = await historique(compte);
    const avant = await evenements(compte);
    // Même date ensuite recopiée automatiquement par T1 : rien à enrichir.
    await automatique(compte, clio.id, '2021-03-01', 'DOCUMENT_EXTRACTION');
    expect((await reconcilier(compte, clio.id)).changes).toBe(0);
    const t3 = await (await consolidator()).consolidateAccountOperations(compte.id, { assetIds: [clio.id], today: AUJ, operationMatch: false });
    expect(t3.changes).toBe(0);
    expect(await historique(compte)).toBe(h);
    expect((await projeter(compte)).changes).toBe(0);
    expect(await evenements(compte)).toEqual(avant);
  });

  // ══ 06 ═══════════════════════════════════════════════════════════════════

  it('L85E-E2E-06 — date contradictoire : la date de l’achat est conservée, la contradiction est tracée et arbitrée par la carte de date existante', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], temporalHints: { realizedDate: '2019-06-01' }, financialHints: [fh('REALIZED_COST', 1849050)] })]);
    await fiche(compte, clio.id, { acquisitionPrice: 18490.5 });
    await reconcilier(compte, clio.id);
    const [o] = await acquisitions(compte);
    expect(o).toMatchObject({ realized_date: '2019-06-01' });
    await projeter(compte, [o.id]);
    // Date T3 de la fiche très éloignée (hors de la fenêtre de l'achat).
    await automatique(compte, clio.id, '2021-03-01', 'RECONCILIATION');
    await reconcilier(compte, clio.id);
    const [apres] = await acquisitions(compte);
    expect(apres.realized_date).toBe('2019-06-01');
    expect(apres.conflicts).toEqual([expect.objectContaining({ field: 'realizedDate', retained: '2019-06-01' })]);
    expect((apres.conflicts[0].values as Json[]).map((v) => v.value).sort()).toEqual(['2019-06-01', '2021-03-01']);
    // Arbitrage existant (83A) : date de l'événement de référence laissée vide, la carte de date propose les deux dates.
    await projeter(compte, [o.id]);
    const [achat, ...autres] = await evenements(compte);
    expect(autres).toEqual([]);
    expect(achat).toMatchObject({ op: o.id, role: 'PRINCIPAL', date: null });
    const [carte] = await cartesDate(achat.id);
    expect(carte).toMatchObject({ rule_code: 'DATA-AGENDA-DATE', action_kind: 'ARBITRATE', resolu: false });
    expect((carte.proposals as Json[]).map((p) => p.value).sort()).toEqual(['2019-06-01', '2021-03-01']);
    expect(await toutesOps(compte)).toBe(1);
  });

  // ══ 07 ═══════════════════════════════════════════════════════════════════

  it('L85E-E2E-07 — événement Achat modifié par l’utilisateur : jamais réécrit, aucun second événement', async () => {
    const { compte, clio, op, achat } = await achatSansDate();
    await sql`UPDATE agenda_items SET title = 'Achat de ma Clio', is_automatic_modified = true WHERE id = ${achat.id}`;
    await automatique(compte, clio.id, '2021-03-01', 'DOCUMENT_EXTRACTION');
    await reconcilier(compte, clio.id);
    expect((await acquisitions(compte))[0]).toMatchObject({ id: op, realized_date: '2021-03-01' });
    const r = await projeter(compte, [op]);
    expect(r.created).toBe(0);
    expect(await evenements(compte)).toEqual([expect.objectContaining({ id: achat.id, title: 'Achat de ma Clio', date: null, modified: true })]);
  });

  // ══ 08 ═══════════════════════════════════════════════════════════════════

  async function campagne(scope: number[], mode: 'DRY_RUN' | 'CORRECTIVE') {
    const o = await import('@/services/coherence/orchestrator');
    const id = await o.startCampaign({ kind: 'MANUAL', trigger: 'e2e', mode, scopeAccountIds: scope });
    for (let i = 0; i < 30; i++) {
      const r = await o.runCampaignStep(id, { deadline: Date.now() + 120_000, today: AUJ });
      if (r.done) break;
    }
    return (await o.getCampaign(id))!;
  }
  const CHECK = 'COH-OPS-ACQUISITION-DATE';
  const preuve = async (accountId: number, objectId: number) => (await sql<Json[]>`
    SELECT last_result, finding FROM coherence_object_proofs WHERE account_id = ${accountId} AND check_id = ${CHECK} AND object_id = ${objectId}`)[0];
  const reparations = (accountId: number) => sql<Json[]>`
    SELECT object_id::int AS object_id, service, outcome, recheck_verdict, ai_calls FROM coherence_repairs WHERE account_id = ${accountId} AND check_id = ${CHECK} ORDER BY id`;
  const diagnostic = async (op: number) => {
    const { OperationDiagnosticsService } = await import('@/services/business-operations/diagnostics/service');
    return (await new OperationDiagnosticsService().detail(op))!.reconciliation;
  };

  it('L85E-E2E-08 — reprise du stock : COH-OPS-ACQUISITION-DATE détecte (à blanc, sans écriture), répare (T3 puis T4), recontrôle ; diagnostic BO jamais « à jour » avant', async () => {
    // Stock : la date T1 est arrivée sur la fiche APRÈS la création de l'achat, sans passage T3 depuis.
    const { compte, clio, op, achat } = await achatSansDate();
    await automatique(compte, clio.id, '2021-03-01', 'DOCUMENT_EXTRACTION');
    expect(await diagnostic(op)).toMatchObject({ state: 'EN_ATTENTE' });
    expect((await diagnostic(op)).label).toContain('date d’acquisition connue sur la fiche du bien');

    const h = await historique(compte);
    await campagne([compte.id], 'DRY_RUN');
    expect(await preuve(compte.id, op)).toMatchObject({ last_result: 'WOULD_REPAIR' });
    expect(await historique(compte)).toBe(h);
    expect((await acquisitions(compte))[0].realized_date).toBeNull();
    expect(await reparations(compte.id)).toEqual([]);

    await campagne([compte.id], 'CORRECTIVE');
    expect(await preuve(compte.id, op)).toMatchObject({ last_result: 'REPAIRED' });
    expect(await reparations(compte.id)).toEqual([expect.objectContaining({ object_id: op, service: 'consolidateAssetData+projectAccountOperations', ai_calls: 0 })]);
    expect(await acquisitions(compte)).toEqual([expect.objectContaining({ id: op, realized_date: '2021-03-01' })]);
    expect((await acquisitions(compte))[0].prov).toMatchObject({ value: '2021-03-01', origin: 'DOCUMENT_EXTRACTION' });
    expect(await evenements(compte)).toEqual([expect.objectContaining({ id: achat.id, op, role: 'PRINCIPAL', date: '2021-03-01' })]);
    expect(await cartesDate(achat.id)).toEqual([expect.objectContaining({ resolu: true, resolution_reason: 'OBSOLETE' })]);
    expect(await diagnostic(op)).toMatchObject({ state: 'A_JOUR' });

    // Campagne suivante : rien à faire, aucune écriture.
    const h2 = await historique(compte);
    await campagne([compte.id], 'CORRECTIVE');
    expect(await reparations(compte.id)).toHaveLength(1);
    expect(await historique(compte)).toBe(h2);
  });

  it('L85E-E2E-08b — cas non déterministe (deux acquisitions du bien) : constat AMBIGUOUS, aucune écriture ; date inconnue : cohérent', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const creer = (fileId: number) => withBusinessOperationWrite(compte.id, (repo) => repo.create({
      type: { code: 'ACQUISITION' }, status: 'REALIZED', realizedDate: null, technicalLabel: 'Achat',
      source: { kind: 'DOCUMENT', entityKey: fileId, authority: 'DOCUMENT', confidence: 'certain' },
      assets: [{ assetId: clio.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E',
    }));
    const a = await creer((await make.assetFile(compte, { assetId: clio.id })).id);
    const b = await creer((await make.assetFile(compte, { assetId: clio.id })).id);
    await campagne([compte.id], 'CORRECTIVE');
    // Date inconnue : la question « À quelle date… » est la bonne.
    expect(await preuve(compte.id, a.id)).toMatchObject({ last_result: 'CONSISTENT' });
    await automatique(compte, clio.id, '2021-03-01', 'DOCUMENT_EXTRACTION');
    const h = await historique(compte);
    await campagne([compte.id], 'CORRECTIVE');
    expect(await preuve(compte.id, a.id)).toMatchObject({ last_result: 'AMBIGUOUS' });
    expect(await preuve(compte.id, b.id)).toMatchObject({ last_result: 'AMBIGUOUS' });
    expect((await acquisitions(compte)).map((o) => o.realized_date)).toEqual([null, null]);
    expect(await historique(compte)).toBe(h);
  });

  // ══ 09 ═══════════════════════════════════════════════════════════════════

  it('L85E-E2E-09 — second passage strictement idempotent ; aucun doublon d’Opération, de montant ni d’événement Achat', async () => {
    const { compte, clio, op, achat } = await achatSansDate();
    await automatique(compte, clio.id, '2021-03-01', 'DOCUMENT_EXTRACTION');
    // Le passage T3 du compte n'est plus « sans changement » tant que la date n'est pas reportée.
    const t3 = await (await consolidator()).consolidateAccountOperations(compte.id, { assetIds: [clio.id], today: AUJ, operationMatch: false });
    expect(t3.changes).toBeGreaterThan(0);
    await projeter(compte, [op]);
    const etat = async () => ({
      ops: await sql`SELECT id, type_code, status, realized_date, version, attribute_provenance FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`,
      sources: await sql`SELECT id, operation_id, active, source_version FROM business_operation_sources WHERE account_id = ${compte.id} ORDER BY id`,
      composantes: await sql`SELECT id, operation_id, kind, amount_minor, active FROM business_operation_financial_components WHERE account_id = ${compte.id} ORDER BY id`,
      agenda: await sql`SELECT id, title, start_date, updated_at, business_operation_id::int AS business_operation_id, operation_role FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`,
      cartes: await sql`SELECT id, resolved_at, updated_at FROM to_process_actions WHERE account_id = ${compte.id} ORDER BY id`,
      historique: await historique(compte),
    });
    const avant = await etat();
    expect((await reconcilier(compte, clio.id)).changes).toBe(0);
    expect((await (await consolidator()).consolidateAccountOperations(compte.id, { assetIds: [clio.id], today: AUJ, operationMatch: false })).changes).toBe(0);
    expect((await (await adc()).runStructuredOperationsMigration({ apply: true, accountId: compte.id, today: AUJ })).changes).toBe(0);
    expect((await projeter(compte, [op])).changes).toBe(0);
    expect(await etat()).toEqual(avant);
    expect(avant.ops).toHaveLength(1);
    expect(avant.composantes.filter((c) => c.active)).toHaveLength(1);
    expect(avant.agenda).toEqual([expect.objectContaining({ id: achat.id, business_operation_id: op })]);
  });

  // ══ 10 (ticket BO › Comptes : ID du compte) ═════════════════════════════

  it('L85E-E2E-10 — BO › Comptes : recherche par ID (« 42 », « #42 », « ID 42 ») sur la route réelle ; la recherche texte reste ; aucun champ sensible ajouté', async () => {
    const APP = 'https://app.e2e.verebona.test';
    const a = await make.user({ email: `${uid('adm85e')}@verebona.test`, role: 'ADMIN' });
    await sql`UPDATE users SET role = 'ADMIN', is_active = true, status = 'ACTIVE' WHERE id = ${a.id}`;
    const { generateAccessToken } = await import('@/lib/jwt');
    const tok = await generateAccessToken({ id: a.id, email: a.email, role: 'ADMIN' as never, planType: 'STANDARD' as never, status: 'ACTIVE' as never, hasActiveAccount: true });
    const cible = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const { GET } = await import('@/app/api/admin/accounts/route');
    const chercher = async (q: string) => {
      const r = await GET(new NextRequest(`${APP}/api/admin/accounts?q=${encodeURIComponent(q)}`, {
        headers: { cookie: `access_token=${tok}`, origin: APP, host: 'app.e2e.verebona.test' },
      }));
      expect(r.status).toBe(200);
      return (await r.json() as { accounts: Array<Record<string, unknown>> }).accounts;
    };
    for (const q of [String(cible.id), `#${cible.id}`, `ID ${cible.id}`]) {
      const ids = (await chercher(q)).map((x) => x.id);
      expect(ids, q).toContain(cible.id);
      expect(ids, q).not.toContain(autre.id);
    }
    const [ligne] = (await chercher(String(cible.id))).filter((x) => x.id === cible.id);
    expect(Object.keys(ligne).filter((k) => /stripe(Customer|Subscription)Id|password|token/i.test(k))).toEqual([]);
  });
});
