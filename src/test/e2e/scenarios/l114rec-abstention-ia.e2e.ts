/**
 * Carte Trello #744 — RECETTE du CDC « Opérations / Agenda V2.0 » :
 * ABSTENTION quand le fournisseur d'IA est indisponible (§6 « si IA
 * indisponible ou contexte tronqué, abstention tracée et reprise ; jamais
 * règle dangereuse de secours », §16, §20 ; AC20). Sur PostgreSQL 16 réel,
 * par le chemin de PRODUCTION : passage T3 complet d'un compte
 * (`consolidateAccountOperations`) dont la phase de rapprochement sémantique
 * M3 reçoit un appel qui ÉCHOUE (`AiGatewayError`) — aucun appel réseau,
 * aucun fournisseur réel. Dates fixes : aucune dépendance au jour.
 *
 *   L114REC-E04  AC20 : panne du fournisseur pendant le rapprochement M3 → abstention TRACÉE (motif, date de
 *                reprise), AUCUNE écriture métier (empreinte du compte identique : événements de référence,
 *                sources, coûts, Agenda, rappels), aucune création ni fusion « de secours » ; le candidat reste
 *                en attente ; rejouer le passage pendant la panne ne change rien
 *   L114REC-E05  AC20 : rétablissement → le verdict est obtenu UNE fois, appliqué par la reconsolidation, et le
 *                passage rejoué n'écrit rien de plus (reprise idempotente)
 *   L114REC-E06  AC20 : branche de prompt indisponible → aucun appel, aucune erreur, aucune écriture ; le cas
 *                reste en attente jusqu'à une version qui la porte
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import type { T3OperationMatchOutput } from '@/services/ai/reconciliation/master/t3-contract';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const AUJOURDHUI = '2026-10-12';
const consolidator = () => import('@/services/business-operations/consolidation/consolidator');
const bus = () => import('@/services/business-operations/events');

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

scenario('L114REC-IA', 'Opérations / Agenda CDC V2.0 — recette : fournisseur d’IA indisponible pendant T3 → abstention tracée, aucune écriture, reprise idempotente (AC20)', ({ sql, make }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  async function document(compte: AccountRow, assetId: number, candidats: AnchoredOperationCandidate[], titre: string): Promise<number> {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${titre} WHERE id = ${f.id}`;
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
    SELECT id::int AS id FROM business_operations
     WHERE account_id = ${compte.id} AND invalidated_at IS NULL AND merged_into_operation_id IS NULL ORDER BY id`;
  const candidat = async (fileId: number) => (await sql<Json[]>`
    SELECT t3_outcome, t3_reason, t3_operation_id::int AS t3_operation_id, t3_detail
      FROM document_operation_candidates WHERE file_id = ${fileId} AND status = 'ACTIVE'`)[0];

  /** Tout ce qu'une abstention ne doit JAMAIS toucher : identités, sources, coûts, Agenda, liens, rappels, journal. */
  async function empreinte(compte: AccountRow): Promise<string> {
    const [r] = await sql<{ h: string }[]>`
      SELECT md5(concat_ws('#',
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_sources t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_financial_components t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_relations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_agenda_links t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM agenda_items t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM business_operation_history t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM to_process_actions t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM notification_outbox t WHERE t.account_id = ${compte.id}))) AS h`;
    return r.h;
  }

  /** Compte avec un candidat en attente de rapprochement sémantique (M3_REQUIRED), sans aucun appel d'IA. */
  async function compteEnAttenteDeM3() {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    await document(compte, clio.id, [cand({
      businessReferences: [{ kind: 'INVOICE', value: 'FA-1' }], temporalHints: { realizedDate: '2026-06-02' },
      financialHints: [fh('REALIZED_COST', 18000)], targetHints: [cible(clio.id)],
    })], 'Facture plaquettes');
    await passer(compte, { operationMatch: false });
    const [premier] = await actifs(compte);
    const second = await document(compte, clio.id, [cand({
      businessReferences: [{ kind: 'INVOICE', value: 'FA-2' }], temporalHints: { realizedDate: '2026-06-03' },
      financialHints: [fh('REALIZED_COST', 6000)], targetHints: [cible(clio.id)],
    })], 'Facture main d’œuvre');
    await passer(compte, { operationMatch: false });
    expect(await actifs(compte)).toHaveLength(1);
    expect(await candidat(second)).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'M3_REQUIRED' });
    return { compte, operationId: Number(premier.id), fileId: second };
  }

  const PROMPT_DISPONIBLE = async () => ({ available: true, version: 'recette-744-m3' });

  it('L114REC-E04 — panne du fournisseur pendant le rapprochement M3 : abstention tracée, AUCUNE écriture métier, aucune création ni fusion de secours ; rejeu pendant la panne sans effet (AC20)', async () => {
    const { compte, fileId } = await compteEnAttenteDeM3();
    const avant = await empreinte(compte);
    const { AiGatewayError } = await import('@/services/ai/gateway/errors');
    let appels = 0;
    const enPanne = async (): Promise<T3OperationMatchOutput> => {
      appels++;
      throw new AiGatewayError('PROVIDER_UNAVAILABLE', 't3_operation_match', 'fournisseur indisponible (recette #744)', { recoverable: true });
    };

    const r1 = await passer(compte, { operationMatch: { callModel: enPanne, promptStatus: PROMPT_DISPONIBLE, callsLastDay: async () => 0 } });
    expect(appels).toBe(1);
    expect(r1.m3).toMatchObject({ examined: 1, calls: 1, errors: 1, files: [] });
    // Abstention TRACÉE : motif de la panne et date de reprise, sur le candidat lui-même.
    const trace = (await candidat(fileId)).t3_detail?.m3 as Json;
    expect(trace).toMatchObject({ status: 'ERROR', detail: 'PROVIDER_UNAVAILABLE' });
    expect(typeof trace.retryAfter).toBe('string');
    expect(Date.parse(String(trace.retryAfter))).toBeGreaterThan(Date.now());
    // Aucune règle dangereuse de secours : ni création, ni fusion, ni rattachement, ni carte, ni rappel.
    expect(await actifs(compte)).toHaveLength(1);
    expect(await candidat(fileId)).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'M3_REQUIRED', t3_operation_id: null });
    expect(await empreinte(compte)).toBe(avant);

    // Rejouer le passage PENDANT la panne : la date de reprise n'est pas échue — aucun nouvel appel, rien d'écrit.
    const r2 = await passer(compte, { operationMatch: { callModel: enPanne, promptStatus: PROMPT_DISPONIBLE, callsLastDay: async () => 0 } });
    expect(appels).toBe(1);
    expect(r2.m3).toMatchObject({ examined: 0, calls: 0, errors: 0 });
    expect(await empreinte(compte)).toBe(avant);
  });

  it('L114REC-E05 — rétablissement : le verdict est obtenu UNE fois, appliqué par la reconsolidation, et le passage rejoué n’écrit rien de plus (AC20)', async () => {
    const { compte, operationId, fileId } = await compteEnAttenteDeM3();
    const { AiGatewayError } = await import('@/services/ai/gateway/errors');
    const enPanne = async (): Promise<T3OperationMatchOutput> => {
      throw new AiGatewayError('PROVIDER_UNAVAILABLE', 't3_operation_match', 'fournisseur indisponible (recette #744)', { recoverable: true });
    };
    // La panne est datée SEPT HEURES plus tôt (horloge injectée, décalage RELATIF : aucune dépendance au jour) :
    // la date de reprise que l'abstention a posée (panne + 6 h) est donc échue au passage suivant.
    const pendantLaPanne = () => new Date(Date.now() - 7 * 3600 * 1000);
    await passer(compte, { operationMatch: { callModel: enPanne, promptStatus: PROMPT_DISPONIBLE, callsLastDay: async () => 0, now: pendantLaPanne } });
    expect((await candidat(fileId)).t3_detail?.m3).toMatchObject({ status: 'ERROR', detail: 'PROVIDER_UNAVAILABLE' });

    // Rétablissement : le passage suivant reprend le cas une seule fois.
    let appels = 0;
    const retabli = async (): Promise<T3OperationMatchOutput> => {
      appels++;
      return {
        task: 'OPERATION_MATCH', decision: 'SAME_OPERATION', matchedCandidateId: operationId, confidence: 'certain',
        concordantSignals: ['même bien', 'même nature de travaux'], contradictions: [], reason: 'rétabli (recette #744)',
      } as T3OperationMatchOutput;
    };
    const r = await passer(compte, { operationMatch: { callModel: retabli, promptStatus: PROMPT_DISPONIBLE, callsLastDay: async () => 0 } });
    expect(appels).toBe(1);
    expect(r.m3).toMatchObject({ examined: 1, calls: 1, errors: 0 });
    expect(await candidat(fileId)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_operation_id: operationId });
    expect((await actifs(compte)).map((x) => Number(x.id))).toEqual([operationId]);
    const apresReprise = await empreinte(compte);
    const sources = await sql<Json[]>`
      SELECT count(*)::int AS n FROM business_operation_sources WHERE operation_id = ${operationId} AND active AND source_kind = 'DOCUMENT'`;
    expect(Number(sources[0].n)).toBe(2);

    // Reprise IDEMPOTENTE : le même passage rejoué ne rappelle pas le modèle et n'écrit rien de plus.
    const r2 = await passer(compte, { operationMatch: { callModel: retabli, promptStatus: PROMPT_DISPONIBLE, callsLastDay: async () => 0 } });
    expect(appels).toBe(1);
    expect(r2.m3).toMatchObject({ examined: 0, calls: 0, errors: 0 });
    expect(await empreinte(compte)).toBe(apresReprise);
  });

  it('L114REC-E06 — branche de prompt indisponible : aucun appel, aucune erreur, aucune écriture ; le cas reste en attente (AC20)', async () => {
    const { compte, fileId } = await compteEnAttenteDeM3();
    const avant = await empreinte(compte);
    let appels = 0;
    const jamaisAppele = async (): Promise<T3OperationMatchOutput> => {
      appels++;
      throw new Error('le modèle ne doit pas être appelé sans la branche du prompt');
    };
    const r = await passer(compte, {
      operationMatch: { callModel: jamaisAppele, promptStatus: async () => ({ available: false, version: null }), callsLastDay: async () => 0 },
    });
    expect(appels).toBe(0);
    expect(r.m3).toMatchObject({ examined: 1, calls: 0, errors: 0, unavailable: 1 });
    expect((await candidat(fileId)).t3_detail?.m3).toMatchObject({ status: 'PROMPT_UNAVAILABLE' });
    expect(await candidat(fileId)).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'M3_REQUIRED' });
    expect(await actifs(compte)).toHaveLength(1);
    expect(await empreinte(compte)).toBe(avant);
  });
});
