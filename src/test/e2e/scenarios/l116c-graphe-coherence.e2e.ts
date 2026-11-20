/**
 * Carte Trello #806 §4 — COHÉRENCE DU GRAPHE DES OPÉRATIONS (AC73) :
 * `auditOperationGraph` raccordé au contrôle de cohérence
 * (`COH-OPERATION-GRAPH`) et diagnostic lisible au BO. Sur PostgreSQL 16 réel,
 * par les chemins de PRODUCTION : orchestrateur du contrôle de cohérence
 * (campagne réelle, mode correctif), lecture du BO (`readOperationGraphDiagnostic`
 * et route `GET /api/admin/operations/graph`). Aucune IA.
 *
 *   L116C-G01  compte sain : avant toute campagne, « JAMAIS CONTRÔLÉ » (même si le calcul à la demande ne trouve
 *              aucun écart : jamais un faux « vérifié ») ; après la campagne : preuve datée, « contrôlé : aucun
 *              écart » ; un AUTRE compte, hors campagne, reste « jamais contrôlé »
 *   L116C-G02  écarts injectés HORS de la façade (écritures directes) : refus de l'utilisateur réactivé par un
 *              traitement, relation et lien déduits sans preuve, lien d'Agenda rétabli malgré un retrait, paire
 *              scindée refusionnée sans l'utilisateur, même fait d'un justificatif sur deux opérations, sinistre relié
 *              à une opération qui n'est pas un contrat → tous constatés, libellés ; la campagne en mode CORRECTIF
 *              ne répare RIEN par ce contrôle (relations et opérations identiques, aucune réparation journalisée) et signale immédiatement les écarts bloquants
 *   L116C-G03  lien ENTRE COMPTES (injecté en contournant les déclencheurs de garde) : constaté et bloquant dans le
 *              compte qui le porte ; aucune donnée de l'autre compte n'est rendue par les lectures du graphe
 *   L116C-G04  route du BO : administrateur seulement ; compte inconnu → 404 ; paramètre absent → 400
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';

const session = vi.hoisted(() => ({ refus: null as null | 'UNAUTHORIZED' | 'FORBIDDEN' }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    requireAdmin: async () => {
      if (session.refus === 'UNAUTHORIZED') throw new Error('AUTH_REQUIRED');
      if (session.refus === 'FORBIDDEN') throw new Error('INSUFFICIENT_PERMISSIONS');
      return 1;
    },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const AUJOURDHUI = '2026-10-12';
const CHECK = 'COH-OPERATION-GRAPH';
const facade = () => import('@/services/business-operations/operation-write.facade');

scenario('L116C-G', 'Opérations / Agenda #806 §4 — cohérence du graphe : contrôle raccordé, diagnostic lisible, aucune réparation, aucun faux « vérifié » (AC73)', ({ sql, make }) => {
  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });

  async function operation(compte: AccountRow, type: string, over: { label?: string; fileId?: number; assetId?: number; candidateKey?: string } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: { code: type } as never, status: 'REALIZED', technicalLabel: over.label ?? null,
      source: over.fileId
        ? { kind: 'DOCUMENT', entityKey: over.fileId, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain', locator: over.candidateKey ? { candidateKey: over.candidateKey } : { e2e: 'l116c' } }
        : { kind: 'MIGRATION', entityKey: `l116c-g-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' },
      ...(over.assetId ? { assets: [{ assetId: over.assetId, role: 'PRIMARY' as const, authority: 'DOCUMENT' as const }] } : {}),
      reasonCode: 'L116C_G_E2E',
    })).id);
  }
  const diagnostic = async (compte: AccountRow) => (await import('@/services/business-operations/graph/audit-read')).readOperationGraphDiagnostic(compte.id);
  const campagne = async (comptes: AccountRow[]) => {
    const { runCoherenceFor } = await import('../coherence-run');
    return runCoherenceFor(sql, comptes.map((c) => c.id), { mode: 'CORRECTIVE', today: AUJOURDHUI });
  };
  /** Relations entre opérations du compte : AUCUN autre contrôle de la campagne ne les écrit — ce qui change ici viendrait du contrôle du graphe. */
  const empreinteRelations = async (compte: AccountRow) => (await sql<Json[]>`
    SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') AS h FROM business_operation_relations t WHERE t.account_id = ${compte.id}`)[0].h;
  const etatsOperations = (compte: AccountRow) => sql<Json[]>`
    SELECT id::int AS id, invalidated_at IS NOT NULL AS invalide, merged_into_operation_id::int AS fusionne FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`;

  it('L116C-G01 — compte sain : « jamais contrôlé » avant la campagne (jamais un faux « vérifié »), « contrôlé : aucun écart » après, avec sa preuve datée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const horsCampagne = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const f = await facade();
    const a = await operation(compte, 'INTERVENTION', { label: 'Toiture', assetId: maison.id });
    const b = await operation(compte, 'CLAIM', { label: 'Dégât des eaux', assetId: maison.id });
    await operation(horsCampagne, 'INTERVENTION', { label: 'Travaux d’un autre compte' });
    const etape = await make.agendaItem(compte, { title: 'Passage de l’expert', startDate: '2026-07-08', assetIds: [maison.id] });
    expect(await f.linkAgendaItem(user(compte), { operationId: b, agendaItemId: etape.id })).toMatchObject({ status: 'APPLIED' });
    expect(await f.associateOperations(user(compte), { fromOperationId: b, toOperationId: a, nature: 'CLAIM_REPAIR' })).toMatchObject({ status: 'APPLIED' });

    // Avant toute campagne : le calcul à la demande est propre, mais RIEN ne dit que le compte est vérifié.
    const avant = await diagnostic(compte);
    expect(avant).toMatchObject({ accountFound: true, checkId: CHECK, control: { state: 'NEVER_CONTROLLED', stateLabel: 'Jamais contrôlé', proof: null }, live: { clean: true, blocking: 0, findings: [] } });
    expect(avant.volumes).toMatchObject({ operations: 2, relations: 1, agendaLinks: 1, splitPairs: 0 });

    const run = await campagne([compte]);
    expect(run.status).toBe('COMPLETE');
    expect(run.results[CHECK]).toEqual({ CONSISTENT: 1 });
    const apres = await diagnostic(compte);
    expect(apres.control).toMatchObject({ state: 'CONSISTENT', stateLabel: 'Contrôlé : aucun écart', proof: { result: 'CONSISTENT', rulesVersion: 1, mode: 'CORRECTIVE' } });
    expect(apres.control.proof!.completedAt).not.toBeNull();
    // Le compte resté hors de la campagne n'hérite d'aucun état : toujours « jamais contrôlé ».
    expect((await diagnostic(horsCampagne)).control).toMatchObject({ state: 'NEVER_CONTROLLED', proof: null });
  }, 180000);

  it('L116C-G02 — écarts injectés hors de la façade : tous constatés et libellés ; la campagne en mode correctif ne répare rien', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const f = await facade();
    const facture = await make.assetFile(compte, { assetId: maison.id });
    const a = await operation(compte, 'INTERVENTION', { label: 'Toiture', assetId: maison.id, fileId: facture.id, candidateKey: 'op1' });
    const b = await operation(compte, 'INTERVENTION', { label: 'Charpente', assetId: maison.id });
    const c = await operation(compte, 'INTERVENTION', { label: 'Gouttières', assetId: maison.id });
    const sinistre = await operation(compte, 'CLAIM', { label: 'Dégât des eaux', assetId: maison.id });

    // 1. REFUS RÉACTIVÉ : l'utilisateur refuse d'associer a et b ; une écriture directe remet la relation active au nom d'un traitement.
    expect(await f.associateOperations(user(compte), { fromOperationId: a, toOperationId: b, nature: 'ASSOCIATED' })).toMatchObject({ status: 'APPLIED' });
    expect(await f.dissociateOperations(user(compte), { operationAId: a, operationBId: b })).toMatchObject({ status: 'APPLIED' });
    const [refusee] = await sql<Json[]>`
      UPDATE business_operation_relations SET state = 'ACTIVE', origin = 'AI', ended_at = NULL, evidence = '[{"kind":"DOCUMENT","ref":"1"}]'::jsonb
       WHERE account_id = ${compte.id} AND LEAST(from_operation_id, to_operation_id) = ${Math.min(a, b)} AND GREATEST(from_operation_id, to_operation_id) = ${Math.max(a, b)} RETURNING id::int AS id`;
    // 2. PROVENANCE : une relation déduite sans aucune preuve.
    const [sansPreuve] = await sql<Json[]>`
      INSERT INTO business_operation_relations (account_id, from_operation_id, to_operation_id, nature, state, origin, reason_code, evidence)
      VALUES (${compte.id}, ${a}, ${c}, 'ASSOCIATED', 'ACTIVE', 'AI', 'L116C_G02', '[]'::jsonb) RETURNING id::int AS id`;
    // 3. RETRAIT CONTOURNÉ : l'utilisateur retire un événement de b ; une écriture directe le rattache de nouveau.
    const etape = await make.agendaItem(compte, { title: 'Pose de la charpente', startDate: '2026-04-02', assetIds: [maison.id] });
    expect(await f.linkAgendaItem(user(compte), { operationId: b, agendaItemId: etape.id })).toMatchObject({ status: 'APPLIED' });
    expect(await f.unlinkAgendaItem(user(compte), { operationId: b, agendaItemId: etape.id })).toMatchObject({ status: 'APPLIED' });
    const [lienRetabli] = await sql<Json[]>`
      UPDATE business_operation_agenda_links SET state = 'ACTIVE', ended_at = NULL, origin = 'AI', legacy_column = false
       WHERE account_id = ${compte.id} AND operation_id = ${b} AND agenda_item_id = ${etape.id} RETURNING id::int AS id`;
    // 4. SCISSION DÉFAITE sans l'utilisateur : c est scindée, puis la nouvelle opération est marquée fusionnée dans c par une écriture directe.
    const autre = await make.agendaItem(compte, { title: 'Nettoyage des gouttières', startDate: '2026-05-06', assetIds: [maison.id] });
    expect(await f.linkAgendaItem(user(compte), { operationId: c, agendaItemId: autre.id })).toMatchObject({ status: 'APPLIED' });
    const scission = await f.splitOperation(user(compte), { operationId: c, label: 'Nettoyage', agendaItemIds: [autre.id] });
    expect(scission).toMatchObject({ status: 'APPLIED' });
    await sql`UPDATE business_operations SET merged_into_operation_id = ${c}, invalidated_at = now(), invalidation_reason = 'MERGED' WHERE id = ${scission.data!.newOperationId}`;
    // 5. DOUBLE COMPTAGE : le même fait (candidat op1) de la facture fonde aussi b.
    await sql`
      INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, source_role, locator, authority, confidence, active)
      SELECT account_id, ${b}, source_kind, source_entity_key, source_role, locator, authority, confidence, true
        FROM business_operation_sources WHERE operation_id = ${a} AND source_kind = 'DOCUMENT' AND active`;
    // 6. LIEN ORPHELIN : le sinistre désigne comme « contrat d'assurance » une opération qui n'est pas un contrat.
    await sql`INSERT INTO business_operation_claim_details (operation_id, insurance_contract_operation_id) VALUES (${sinistre}, ${a})
              ON CONFLICT (operation_id) DO UPDATE SET insurance_contract_operation_id = EXCLUDED.insurance_contract_operation_id`;

    const avant = await empreinteRelations(compte);
    const avantEtats = await etatsOperations(compte);
    const d = await diagnostic(compte);
    const parCode = new Map(d.live.findings.map((x) => [x.code, x]));
    expect([...parCode.keys()].sort()).toEqual([
      'AGENDA_LINK_INFERRED_WITHOUT_EVIDENCE', 'AGENDA_LINK_ON_MERGED_OPERATION', 'AGENDA_LINK_REFUSAL_REACTIVATED', 'CLAIM_CONTRACT_LINK_ORPHAN',
      'DOCUMENT_CANDIDATE_ON_TWO_OPERATIONS', 'RELATION_INFERRED_WITHOUT_EVIDENCE', 'RELATION_ON_MERGED_OPERATION', 'RELATION_REFUSAL_REACTIVATED',
      'SPLIT_PAIR_REMERGED_AUTOMATICALLY',
    ]);
    expect(parCode.get('RELATION_REFUSAL_REACTIVATED')).toMatchObject({ severity: 'BLOCKING', family: 'REFUSAL_REACTIVATED', familyLabel: 'Décision de l’utilisateur contournée', count: 1, sample: [Number(refusee.id)] });
    expect(parCode.get('RELATION_INFERRED_WITHOUT_EVIDENCE')).toMatchObject({ severity: 'WARNING', family: 'PROVENANCE', sample: [Number(sansPreuve.id)] });
    expect(parCode.get('AGENDA_LINK_REFUSAL_REACTIVATED')).toMatchObject({ severity: 'BLOCKING', sample: [Number(lienRetabli.id)] });
    expect(parCode.get('SPLIT_PAIR_REMERGED_AUTOMATICALLY')).toMatchObject({ severity: 'BLOCKING', count: 1 });
    expect(parCode.get('DOCUMENT_CANDIDATE_ON_TWO_OPERATIONS')).toMatchObject({ family: 'DOUBLE_COUNTING', sample: [facture.id], objectLabel: 'justificatif' });
    expect(parCode.get('CLAIM_CONTRACT_LINK_ORPHAN')).toMatchObject({ family: 'ORPHAN', sample: [sinistre] });
    // Lisible : chaque ligne porte un libellé et une conduite à tenir, sans réparation automatique ; bloquants d'abord.
    for (const x of d.live.findings) {
      expect(x.label.length).toBeGreaterThan(20);
      expect(x.action).toMatch(/Aucune réparation automatique\./);
    }
    expect(d.live.findings.findIndex((x) => x.severity === 'WARNING')).toBeGreaterThanOrEqual(d.live.findings.filter((x) => x.severity === 'BLOCKING').length);
    expect(d.live).toMatchObject({ clean: false, blocking: 3 });
    expect(d.control.state).toBe('NEVER_CONTROLLED');

    // Campagne RÉELLE en mode CORRECTIF : constat, AUCUNE réparation du graphe.
    const run = await campagne([compte]);
    expect(run.status).toBe('COMPLETE');
    expect(run.results[CHECK]).toEqual({ FINDING: 1 });
    // Aucune relation n'est retirée, réactivée ni réorientée ; aucune opération n'est fusionnée, scindée ni rétablie ;
    // le contrôle du graphe n'a journalisé AUCUNE réparation (les autres contrôles de la campagne font leur métier).
    expect(await empreinteRelations(compte)).toBe(avant);
    expect(await etatsOperations(compte)).toEqual(avantEtats);
    expect(await sql`SELECT 1 FROM coherence_repairs WHERE account_id = ${compte.id} AND check_id = ${CHECK}`).toHaveLength(0);
    const apresCampagne = (await diagnostic(compte)).live.findings.map((x) => x.code);
    for (const code of ['RELATION_REFUSAL_REACTIVATED', 'RELATION_INFERRED_WITHOUT_EVIDENCE', 'SPLIT_PAIR_REMERGED_AUTOMATICALLY']) expect(apresCampagne).toContain(code);
    const { proofOf } = await import('../coherence-run');
    const preuve = await proofOf(sql, compte.id, CHECK, compte.id);
    expect(preuve).toMatchObject({ last_result: 'FINDING', finding: { expected: 'graphe des opérations sans écart' } });
    expect(['AGENDA_LINK_REFUSAL_REACTIVATED', 'RELATION_REFUSAL_REACTIVATED', 'SPLIT_PAIR_REMERGED_AUTOMATICALLY']).toContain((preuve!.finding as Json).anomaly);
    expect((await diagnostic(compte)).control).toMatchObject({ state: 'FINDINGS', stateLabel: 'Contrôlé : écarts constatés' });
    // Signalement IMMÉDIAT à la Supervision (dès le premier constat) : l'anomalie bloquante est déclarée par le contrôle.
    const { getCheck } = await import('@/services/coherence/registry');
    expect(getCheck(CHECK)!.immediateSupervision).toContain((preuve!.finding as Json).anomaly);
    expect(getCheck(CHECK)!.repair).toBeUndefined();
  }, 180000);

  it('L116C-G03 — lien entre comptes : constaté et bloquant dans le compte qui le porte ; rien de l’autre compte n’est lisible par le graphe', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const a = await operation(compte, 'INTERVENTION', { label: 'Toiture' });
    const etranger = await operation(autre, 'INTERVENTION', { label: 'Travaux confidentiels d’un autre compte' });
    const elementEtranger = await make.agendaItem(autre, { title: 'Rendez-vous confidentiel', startDate: '2026-06-01' });
    // Les déclencheurs de garde refusent ces écritures : on les contourne (rôle de réplication) pour prouver la DÉTECTION.
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`INSERT INTO business_operation_relations (account_id, from_operation_id, to_operation_id, nature, state, origin, reason_code, evidence)
               VALUES (${compte.id}, ${a}, ${etranger}, 'ASSOCIATED', 'ACTIVE', 'USER', 'L116C_G03', '[]'::jsonb)`;
      await tx`INSERT INTO business_operation_agenda_links (account_id, operation_id, agenda_item_id, state, origin, legacy_column, reason_code)
               VALUES (${compte.id}, ${a}, ${elementEtranger.id}, 'ACTIVE', 'USER', false, 'L116C_G03')`;
    });
    const d = await diagnostic(compte);
    expect(d.live.findings.map((x) => [x.code, x.severity, x.family])).toEqual([
      ['AGENDA_LINK_CROSS_ACCOUNT', 'BLOCKING', 'CROSS_ACCOUNT'], ['RELATION_CROSS_ACCOUNT', 'BLOCKING', 'CROSS_ACCOUNT'],
    ]);
    // Aucune fuite : les lectures du graphe de ce compte ne rendent NI l'opération NI l'événement de l'autre compte.
    const { readOperationGraph } = await import('@/services/business-operations/graph/read');
    const vue = await readOperationGraph(compte.id, a);
    expect(JSON.stringify(vue)).not.toMatch(/confidentiel/);
    expect(vue?.relations ?? []).toEqual([]);
    expect(vue?.agendaItems ?? []).toEqual([]);
    const run = await campagne([compte, autre]);
    expect(run.results[CHECK]).toEqual({ FINDING: 1, CONSISTENT: 1 });
    expect((await diagnostic(autre)).live).toMatchObject({ clean: true });
  }, 180000);

  it('L116C-G04 — route du BO : administrateur seulement, compte inconnu → 404, paramètre absent → 400', async () => {
    const compte = await make.account({ plan: 'premium' });
    await operation(compte, 'INTERVENTION', { label: 'Toiture' });
    const { GET } = await import('@/app/api/admin/operations/graph/route');
    const appel = (q: string) => GET(new NextRequest(`http://local/api/admin/operations/graph${q}`));
    session.refus = null;
    const ok = await appel(`?accountId=${compte.id}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Cache-Control')).toMatch(/no-store/);
    expect(await ok.json()).toMatchObject({ accountId: compte.id, control: { state: 'NEVER_CONTROLLED' }, live: { clean: true } });
    expect((await appel('')).status).toBe(400);
    expect((await appel('?accountId=999999999')).status).toBe(404);
    try {
      session.refus = 'FORBIDDEN';
      expect((await appel(`?accountId=${compte.id}`)).status).toBe(403);
      session.refus = 'UNAUTHORIZED';
      expect((await appel(`?accountId=${compte.id}`)).status).toBe(401);
    } finally {
      session.refus = null;
    }
  });
});
