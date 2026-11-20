/**
 * Carte Trello #744 — RECETTE du CDC « Opérations / Agenda V2.0 » : identité
 * d'un événement de référence devant les traitements T3 (§3, §6, §7, §11,
 * §24 SC-01 et SC-02 ; AC09, AC10, AC32, AC63). Sur PostgreSQL 16 réel, par
 * les chemins de PRODUCTION : T1 persisté (`replaceOperationCandidates`),
 * consolidation T3 d'un compte (`consolidateAccountOperations`), phase de
 * rapprochement sémantique M3 par sorties ENREGISTRÉES (aucun appel réseau,
 * aucun appel à un fournisseur d'IA), lecture de la page par le graphe.
 * Dates fixes : aucune dépendance au jour.
 *
 *   L114REC-E01  AC09, SC-01, AC32 : devis initial, devis alternatif, visite et facture finale d'une MÊME réparation
 *                → UN seul événement de référence portant les trois justificatifs ; pas un objet par document ;
 *                le repère reste au premier devis tant que rien n'est réalisé, puis passe à la réalisation ;
 *                la visite garde sa date propre ; un devis reste une PRÉVISION (aucun coût réalisé)
 *   L114REC-E02  AC10, SC-02 : deux réparations indépendantes chez le MÊME prestataire restent deux événements de
 *                référence — aucune fusion, aucun regroupement, aucune carte posée sur le seul prestataire
 *   L114REC-E03  AC63 : type non qualifié conservé par un passage T3 réel (jamais requalifié en OTHER), avec sa
 *                preuve ; les sept types structurels restent distincts après le passage
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';
import type { RecordedOutput } from '../replay-gateway';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
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
const AUJOURDHUI = '2026-10-12';
const consolidator = () => import('@/services/business-operations/consolidation/consolidator');
const bus = () => import('@/services/business-operations/events');
const facade = () => import('@/services/business-operations/operation-write.facade');

function cand(over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate {
  return {
    candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED',
    summary: 'Remplacement des plaquettes de frein', sourceRoleHint: 'INVOICE', provider: 'Garage Martin',
    targetHints: [], businessReferences: [], temporalHints: {}, financialHints: [], evidenceFactRefs: ['f1'],
    visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
  };
}
const fh = (role: string, amountMinor: number) =>
  ({ role, amountMinor, currency: 'EUR', amountScope: null, economicDate: null, periodStart: null, periodEnd: null, factRef: 'f1' }) as AnchoredOperationCandidate['financialHints'][number];
const cible = (entityId: number) => ({ type: 'ASSET' as const, entityId, rawLabel: null, confidence: 'certain' as const });
const m3 = (decision: 'SAME_OPERATION' | 'DISTINCT_OPERATION' | 'AMBIGUOUS', matchedCandidateId: number | null, confidence = 'certain'): RecordedOutput => ({
  operationCode: 't3_operation_match', task: 'OPERATION_MATCH',
  output: { task: 'OPERATION_MATCH', decision, matchedCandidateId, confidence, concordantSignals: ['même bien', 'même nature de travaux'], contradictions: [], reason: 'enregistré (recette #744)' },
});

scenario('L114REC', 'Opérations / Agenda CDC V2.0 — recette : identité devant T3 (devis, visite, facture d’une même réparation ; réparations distinctes ; type non qualifié)', ({ sql, make, useRecordings }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });

  /** Justificatif déposé puis analysé par T1 (candidats persistés par le chemin réel). */
  async function document(
    compte: AccountRow, assetId: number, candidats: AnchoredOperationCandidate[],
    over: { titre?: string; dateDocument?: string } = {},
  ): Promise<number> {
    const f = await make.assetFile(compte, { assetId });
    if (over.titre) await sql`UPDATE asset_files SET retained_title = ${over.titre} WHERE id = ${f.id}`;
    if (over.dateDocument) await sql`UPDATE asset_files SET document_date = ${over.dateDocument} WHERE id = ${f.id}`;
    const [x] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${f.id}) RETURNING id`;
    const { replaceOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/persist');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await replaceOperationCandidates(tx as never, {
        accountId: compte.id, fileId: f.id, extractionId: x.id, analysisRunId: null, reanalysis: false, candidates: candidats, facts: new Map(),
      });
    });
    return f.id;
  }

  type PasserOpts = Parameters<Awaited<ReturnType<typeof consolidator>>['consolidateAccountOperations']>[1];
  const passer = async (compte: AccountRow, opts: PasserOpts = {}) =>
    (await consolidator()).consolidateAccountOperations(compte.id, { today: AUJOURDHUI, ...opts });
  const actifs = (compte: AccountRow) => sql<Json[]>`
    SELECT id::int AS id, type_code, status, realized_date, planned_date
      FROM business_operations
     WHERE account_id = ${compte.id} AND invalidated_at IS NULL AND merged_into_operation_id IS NULL ORDER BY id`;
  const candidat = async (fileId: number) => (await sql<Json[]>`
    SELECT t3_outcome, t3_reason, t3_operation_id::int AS t3_operation_id, t3_detail
      FROM document_operation_candidates WHERE file_id = ${fileId} AND status = 'ACTIVE'`)[0];
  const justificatifs = (opId: number) => sql<Json[]>`
    SELECT source_entity_key AS cle, source_role AS role FROM business_operation_sources
     WHERE operation_id = ${opId} AND active AND source_kind = 'DOCUMENT' ORDER BY id`;
  const composantes = (opId: number) => sql<Json[]>`
    SELECT kind, amount_minor::int AS montant FROM business_operation_financial_components
     WHERE operation_id = ${opId} AND active ORDER BY kind, amount_minor`;
  const repere = async (compte: AccountRow, opId: number) => {
    const { readReferenceEventPage } = await import('@/services/business-operations/graph/reference-event-page');
    const vue = await readReferenceEventPage(compte.id, opId);
    return { date: vue?.presentation?.date ?? null, fondement: vue?.presentation?.basis ?? null, agenda: vue?.agendaItems ?? [], documents: vue?.documents ?? [] };
  };
  const cartes = (compte: AccountRow) => sql<Json[]>`
    SELECT rule_code, target_id FROM to_process_actions WHERE account_id = ${compte.id} AND resolved_at IS NULL ORDER BY id`;

  // ══ AC09 / SC-01 : devis, visite, devis ultérieur, facture = UNE réparation ══

  it('L114REC-E01 — devis initial, devis alternatif, visite et facture d’une même réparation : UNE seule opération (AC09, SC-01) ; repère au premier devis puis à la réalisation (AC32) ; la visite garde sa date', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });

    // 1) Devis initial du 10 mars : prévision, aucune réalisation.
    const devis1 = await document(compte, clio.id, [cand({
      statusHint: 'ENVISAGED', sourceRoleHint: 'QUOTE', summary: 'Devis : remplacement de l’embrayage',
      businessReferences: [{ kind: 'QUOTE', value: 'DEV-2026-114' }], temporalHints: { plannedDate: '2026-04-15' },
      financialHints: [fh('FORECAST_COST', 120000)], targetHints: [cible(clio.id)],
    })], { titre: 'Devis embrayage', dateDocument: '2026-03-10' });
    await passer(compte, { operationMatch: false });
    const apres1 = await actifs(compte);
    expect(apres1).toHaveLength(1);
    const op = Number(apres1[0].id);
    // CDC §11 : faute de réalisation, le repère est la PREMIÈRE date fiable de devis — jamais une date inventée.
    expect(await repere(compte, op)).toMatchObject({ date: '2026-03-10', fondement: 'FIRST_QUOTE' });

    // 2) Devis ALTERNATIF du 20 mars (même prestataire, même nature) : une autre proposition, pas une autre réalité.
    const devis2 = await document(compte, clio.id, [cand({
      statusHint: 'ENVISAGED', sourceRoleHint: 'QUOTE', summary: 'Devis révisé : remplacement de l’embrayage',
      businessReferences: [{ kind: 'QUOTE', value: 'DEV-2026-139' }], temporalHints: { plannedDate: '2026-04-15' },
      financialHints: [fh('FORECAST_COST', 98000)], targetHints: [cible(clio.id)],
    })], { titre: 'Devis embrayage révisé', dateDocument: '2026-03-20' });
    await passer(compte, { operationMatch: false });
    // Jamais un objet par document d'office : le candidat attend le rapprochement sémantique.
    expect(await actifs(compte)).toHaveLength(1);
    expect(await candidat(devis2)).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'M3_REQUIRED' });
    await useRecordings([m3('SAME_OPERATION', op)]);
    await passer(compte);
    expect((await actifs(compte)).map((r) => Number(r.id))).toEqual([op]);
    expect(await candidat(devis2)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_operation_id: op });
    // AC32 : un devis ULTÉRIEUR ne déplace pas le repère — c'est le plus ancien devis qui compte.
    expect(await repere(compte, op)).toMatchObject({ date: '2026-03-10', fondement: 'FIRST_QUOTE' });

    // 3) Visite du 20 mars : un événement réel de l'Agenda, à SA date, relié par le graphe N↔N.
    const visite = await make.agendaItem(compte, { title: 'Visite de l’atelier', startDate: '2026-03-20', assetIds: [clio.id] });
    expect(await (await facade()).linkAgendaItem(user(compte), { operationId: op, agendaItemId: visite.id, reasonCode: 'L114REC_E01' }))
      .toMatchObject({ status: 'APPLIED' });
    const avecVisite = await repere(compte, op);
    // La visite ne devient pas le repère et ne perd pas sa date.
    expect(avecVisite).toMatchObject({ date: '2026-03-10', fondement: 'FIRST_QUOTE' });
    expect(avecVisite.agenda).toEqual([{ id: visite.id, title: 'Visite de l’atelier', date: '2026-03-20', shared: false }]);

    // 4) Facture finale du 15 avril, qui CITE le devis initial : même réalité, prouvée par la référence commune.
    const facture = await document(compte, clio.id, [cand({
      statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', summary: 'Facture : remplacement de l’embrayage',
      businessReferences: [{ kind: 'INVOICE', value: 'FA-2026-551' }, { kind: 'QUOTE', value: 'DEV-2026-114' }],
      temporalHints: { realizedDate: '2026-04-15' }, financialHints: [fh('REALIZED_COST', 98000)], targetHints: [cible(clio.id)],
    })], { titre: 'Facture embrayage', dateDocument: '2026-04-15' });
    await passer(compte, { operationMatch: false });
    expect((await actifs(compte)).map((r) => Number(r.id))).toEqual([op]);
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_operation_id: op });

    // UN événement de référence, TROIS justificatifs actifs, aucune carte posée.
    const sources = await justificatifs(op);
    expect(sources.map((s) => Number(s.cle)).sort((a, b) => a - b)).toEqual([devis1, devis2, facture].sort((a, b) => a - b));
    expect(await cartes(compte)).toEqual([]);
    // AC32 : la réalisation attestée devient le repère ; les trois faits gardent leurs trois dates.
    const final = await repere(compte, op);
    expect(final).toMatchObject({ date: '2026-04-15', fondement: 'REALIZED' });
    expect(final.agenda).toEqual([{ id: visite.id, title: 'Visite de l’atelier', date: '2026-03-20', shared: false }]);
    expect(final.documents.map((d) => d.date).sort()).toEqual(['2026-03-10', '2026-03-20', '2026-04-15']);
    // §18 : deux devis concurrents ne sont jamais additionnés au coût final ; un devis reste une PRÉVISION.
    const lignes = await composantes(op);
    expect(lignes.filter((l) => l.kind === 'REALIZED_COST').map((l) => Number(l.montant))).toEqual([98000]);
    expect(lignes.filter((l) => l.kind === 'FORECAST_COST').map((l) => Number(l.montant))).toEqual([98000, 120000]);
  });

  // ══ AC10 / SC-02 : deux réparations chez le même prestataire ════════════════

  it('L114REC-E02 — deux réparations indépendantes chez le même prestataire : deux opérations, aucune fusion, aucune carte sur le seul prestataire (AC10, SC-02)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const f1 = await document(compte, clio.id, [cand({
      summary: 'Remplacement des plaquettes de frein', businessReferences: [{ kind: 'INVOICE', value: 'FA-100' }],
      temporalHints: { realizedDate: '2026-02-03' }, financialHints: [fh('REALIZED_COST', 18000)], targetHints: [cible(clio.id)],
    })], { titre: 'Facture freins', dateDocument: '2026-02-03' });
    await passer(compte, { operationMatch: false });
    const [premier] = await actifs(compte);

    // Autre nature de travaux, sept mois plus tard, même garage : une autre réalité.
    const f2 = await document(compte, clio.id, [cand({
      summary: 'Remplacement du pare-brise', businessReferences: [{ kind: 'INVOICE', value: 'FA-612' }],
      temporalHints: { realizedDate: '2026-09-18' }, financialHints: [fh('REALIZED_COST', 45000)], targetHints: [cible(clio.id)],
    })], { titre: 'Facture pare-brise', dateDocument: '2026-09-18' });
    await passer(compte);

    const ops = await actifs(compte);
    expect(ops).toHaveLength(2);
    expect(await candidat(f2)).toMatchObject({ t3_outcome: 'CREATE_NEW', t3_operation_id: Number(ops[1].id) });
    // Aucune fusion, aucun regroupement, aucune carte : le prestataire commun ne prouve rien.
    expect(await sql`SELECT 1 FROM business_operation_history WHERE account_id = ${compte.id} AND event_type = 'MERGED'`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM business_operations WHERE account_id = ${compte.id} AND merged_into_operation_id IS NOT NULL`).toHaveLength(0);
    expect(await cartes(compte)).toEqual([]);
    // Chaque réalité garde son justificatif et sa date.
    expect((await justificatifs(Number(premier.id))).map((s) => Number(s.cle))).toEqual([f1]);
    expect((await justificatifs(Number(ops[1].id))).map((s) => Number(s.cle))).toEqual([f2]);
    expect(ops.map((o) => o.realized_date && String(o.realized_date).slice(0, 10))).toEqual(['2026-02-03', '2026-09-18']);
  });

  // ══ AC63 : type non qualifié conservé, jamais OTHER d'office ════════════════

  it('L114REC-E03 — type non qualifié conservé par un passage T3 réel (jamais requalifié en OTHER) ; les sept types structurels restent distincts (AC63, AC06)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const f = await facade();
    const TYPES = ['ACQUISITION', 'INTERVENTION', 'CONTRACT', 'FINANCING', 'CLAIM', 'DISPOSAL', 'OTHER'] as const;
    const crees: Array<{ id: number; type: string | null }> = [];
    const ctx = { accountId: compte.id, actor: { kind: 'USER' as const, userId: compte.ownerUserId, channel: 'ASSISTANT' as const } };
    // OTHER sans qualification certaine est REFUSÉ : jamais un repli à l'absence de compréhension (CDC §3).
    expect(await f.createOperation(ctx, { declaration: 'Quelque chose d’autre, je ne sais pas quoi', type: { code: 'OTHER' } as unknown as Parameters<typeof f.createOperation>[1]['type'], status: 'ENVISAGED' }))
      .toMatchObject({ status: 'FORBIDDEN' });
    for (const code of TYPES) {
      const type = code === 'OTHER'
        ? { code, qualification: { confidence: 'certain' as const, reason: 'Acte qualifié par l’utilisateur, hors des six autres types' } }
        : { code };
      const r = await f.createOperation(ctx, { declaration: `Déclaration de recette pour un événement de type ${code}`, type, status: 'ENVISAGED' });
      expect(r).toMatchObject({ status: 'APPLIED' });
      crees.push({ id: r.data!.operationId, type: code });
    }
    // Qualification incertaine : le type reste NUL, avec sa preuve (déclaration).
    const nul = await f.createOperation(ctx,
      { declaration: 'Il s’est passé quelque chose avec la maison, je ne sais pas encore quoi', type: null, status: 'ENVISAGED' });
    expect(nul).toMatchObject({ status: 'APPLIED', data: { typeCode: null } });
    crees.push({ id: nul.data!.operationId, type: null });

    // Un passage T3 complet du compte ne requalifie rien et ne regroupe rien.
    await passer(compte);
    const apres = await sql<Json[]>`
      SELECT id::int AS id, type_code, invalidated_at, merged_into_operation_id
        FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`;
    expect(apres.map((r) => ({ id: Number(r.id), type: r.type_code ?? null }))).toEqual(crees);
    expect(apres.every((r) => r.invalidated_at === null && r.merged_into_operation_id === null)).toBe(true);
    // Le non qualifié garde sa preuve durable et reste consultable (page, « Sans date »).
    const { readReferenceEventPage } = await import('@/services/business-operations/graph/reference-event-page');
    const vue = await readReferenceEventPage(compte.id, nul.data!.operationId);
    expect(vue).toMatchObject({ typeCode: null, undated: true });
    expect(vue!.declarations).toHaveLength(1);
  });
});
