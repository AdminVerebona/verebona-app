/**
 * Carte Trello #806 §3 — ASSURANCE / SINISTRE : deux opérations distinctes,
 * associables N↔N, jamais fusionnées ; à la création du sinistre, recherche de
 * l'assurance pertinente. Sur PostgreSQL 16 réel, par les chemins de
 * PRODUCTION : dépôt des opérations, recherche
 * (`claims/insurance-association.ts`), façade d'écriture du graphe, file « À
 * traiter » (`resolveArbitration`), consolidation T3 réelle pour le
 * branchement. Aucune IA. Dates fixes.
 *
 *   L116C-A01  UNE assurance sur le bien, dont une période établie couvre la date du sinistre → association
 *              AUTOMATIQUE (relation ASSOCIATED, origine IA, preuve = le justificatif d'assurance) ; les deux
 *              opérations restent distinctes et actives ; aucun montant, aucun événement, aucun rappel créé ; aucune
 *              carte ; rejoué : rien de plus
 *   L116C-A02  ZÉRO assurance candidate (aucun contrat ; contrat d'entretien, qui n'est pas une assurance ; assurance
 *              d'un AUTRE bien ; assurance dont la couverture exclut la date) → rien n'est associé, rien n'est demandé
 *   L116C-A03  PLUSIEURS assurances possibles → une question ciblée par contrat (carte « À traiter », jamais une
 *              sélection forcée) ; « oui » associe (utilisateur), « non » pose un refus durable ; repassé : ni carte
 *              reposée, ni association automatique ; un contrat peut couvrir plusieurs sinistres
 *   L116C-A04  une seule assurance mais couverture NON établie à la date → question (jamais une association
 *              automatique dans le doute) ; date de déclaration seule ≠ date de survenance
 *   L116C-A05  la POLICE citée par les pièces du sinistre désigne le contrat parmi deux → association automatique ;
 *              le contrat qui porte une autre police est écarté
 *   L116C-A06  isolation : l'assurance d'un autre compte n'est jamais candidate ; le refus de l'utilisateur n'est
 *              jamais contourné par un nouveau passage
 *   L116C-A07  branchement réel : une consolidation T3 qui réexamine le sinistre déclenche la recherche (après commit)
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const recherche = () => import('@/services/business-operations/claims/insurance-association');
const bus = () => import('@/services/business-operations/events');

scenario('L116C-A', 'Opérations / Agenda #806 §3 — sinistre et assurance : associés, jamais fusionnés ; une correspondance fiable, sinon question, sinon abstention', ({ sql, make }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  /** Justificatif du compte avec son Type documentaire (référentiel V2). */
  async function piece(compte: AccountRow, assetId: number, type: string): Promise<number> {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET document_type_code = ${type} WHERE id = ${f.id}`;
    return f.id;
  }
  async function operation(compte: AccountRow, type: 'CONTRACT' | 'CLAIM' | 'INTERVENTION', assetId: number, fileId: number, over: { label?: string; realized?: string | null; refs?: Array<{ kind: 'POLICY' | 'CONTRACT'; value: string }> } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => {
      const cree = await repo.create({
        type: { code: type }, status: 'REALIZED', technicalLabel: over.label ?? null, ...(over.realized ? { realizedDate: over.realized } : {}),
        source: { kind: 'DOCUMENT', entityKey: fileId, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain', locator: { e2e: 'l116c-a' } },
        assets: [{ assetId, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'L116C_A_E2E',
      });
      for (const r of over.refs ?? []) await repo.addReference(cree.id, { kind: r.kind, value: r.value, sourceId: cree.sourceId });
      return cree.id;
    });
  }
  const couverture = (compte: AccountRow, fileId: number, start: string | null, end: string | null) => sql`
    INSERT INTO document_business_periods (account_id, file_id, period_kind, segment_index, start_on, end_on, origin, basis)
    VALUES (${compte.id}, ${fileId}, 'COVERAGE', 0, ${start}, ${end}, 'T1', 'T1_PERIOD_FACT')`;
  /** Contrat d'assurance du bien : police (Type INSURANCE_POLICY) et, si demandé, sa période de couverture. */
  async function assurance(compte: AccountRow, assetId: number, over: { label?: string; periode?: [string | null, string | null]; police?: string; type?: string } = {}) {
    const fileId = await piece(compte, assetId, over.type ?? 'INSURANCE_POLICY');
    if (over.periode) await couverture(compte, fileId, over.periode[0], over.periode[1]);
    const id = await operation(compte, 'CONTRACT', assetId, fileId, { label: over.label ?? 'Assurance habitation', ...(over.police ? { refs: [{ kind: 'POLICY', value: over.police }] } : {}) });
    return { id, fileId };
  }
  async function sinistre(compte: AccountRow, assetId: number, over: { label?: string; survenance?: string | null; police?: string } = {}) {
    const fileId = await piece(compte, assetId, 'CLAIM_DECLARATION');
    const id = await operation(compte, 'CLAIM', assetId, fileId, {
      label: over.label ?? 'Dégât des eaux', realized: over.survenance === undefined ? '2026-03-12' : over.survenance,
      ...(over.police ? { refs: [{ kind: 'POLICY', value: over.police }] } : {}),
    });
    return { id, fileId };
  }
  const chercher = async (compte: AccountRow, ids: number[]) => (await recherche()).syncClaimInsuranceAssociations(compte.id, { operationIds: ids });
  const relations = (compte: AccountRow) => sql<Json[]>`
    SELECT LEAST(from_operation_id, to_operation_id)::int AS a, GREATEST(from_operation_id, to_operation_id)::int AS b, nature, state, origin, reason_code, evidence
      FROM business_operation_relations WHERE account_id = ${compte.id} ORDER BY id`;
  const cartes = (compte: AccountRow) => sql<Json[]>`
    SELECT public_id, rule_code, relation_key, question, target_type, target_id::int AS target_id, trigger_context
      FROM to_process_actions WHERE account_id = ${compte.id} AND resolved_at IS NULL ORDER BY id`;
  const actives = async (compte: AccountRow) => (await sql<Json[]>`
    SELECT id::int AS id FROM business_operations WHERE account_id = ${compte.id} AND invalidated_at IS NULL AND merged_into_operation_id IS NULL ORDER BY id`).map((o) => Number(o.id));
  const repondre = async (compte: AccountRow, publicId: string, value: string) => {
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    return resolveArbitration(compte.id, publicId, value, { userId: compte.ownerUserId });
  };
  const effets = async (compte: AccountRow) => (await sql<Json[]>`
    SELECT (SELECT count(*)::int FROM business_operation_financial_components WHERE account_id = ${compte.id}) AS composantes,
           (SELECT count(*)::int FROM agenda_items WHERE account_id = ${compte.id}) AS evenements,
           (SELECT count(*)::int FROM notification_outbox WHERE account_id = ${compte.id}) AS rappels,
           (SELECT count(*)::int FROM business_operation_claim_details d JOIN business_operations o ON o.id = d.operation_id
             WHERE o.account_id = ${compte.id} AND d.insurance_contract_operation_id IS NOT NULL) AS liens_specialises`)[0];

  it('L116C-A01 — UNE assurance fiable (même bien, période qui couvre la date) : association automatique, opérations distinctes, aucun effet dérivé, aucune carte ; idempotent', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const contrat = await assurance(compte, maison.id, { periode: ['2026-01-01', '2026-12-31'] });
    const s = await sinistre(compte, maison.id);
    const avant = await effets(compte);

    const r = await chercher(compte, [s.id]);
    expect(r.outcomes).toEqual([{ claimOperationId: s.id, outcome: 'ASSOCIATED', detail: 'ASSET_AND_PERIOD', contractOperationIds: [contrat.id] }]);
    expect(await relations(compte)).toEqual([{
      a: Math.min(s.id, contrat.id), b: Math.max(s.id, contrat.id), nature: 'ASSOCIATED', state: 'ACTIVE', origin: 'AI', reason_code: 'CLAIM_INSURANCE_SINGLE_MATCH',
      evidence: [{ kind: 'DOCUMENT', ref: String(contrat.fileId) }],
    }]);
    // Deux opérations distinctes, toujours actives, chacune avec son type et ses justificatifs : rien n'est fusionné ni copié.
    expect(await actives(compte)).toEqual([contrat.id, s.id].sort((x, y) => x - y));
    expect((await sql<Json[]>`SELECT operation_id::int AS op, file_id FROM business_operation_documents WHERE account_id = ${compte.id} AND active ORDER BY operation_id`))
      .toEqual([{ op: contrat.id, file_id: contrat.fileId }, { op: s.id, file_id: s.fileId }].sort((x, y) => x.op - y.op));
    // Une association ne prouve pas une prise en charge : aucun montant, aucune indemnité, aucun événement, aucun rappel.
    expect(await effets(compte)).toEqual(avant);
    expect(await cartes(compte)).toEqual([]);
    // Le contrat est consultable depuis le sinistre (lecture symétrique du graphe), sans copie.
    const { readOperationGraph } = await import('@/services/business-operations/graph/read');
    expect((await readOperationGraph(compte.id, s.id))!.relations.map((x) => [x.other.operationId, x.nature, x.origin])).toEqual([[contrat.id, 'ASSOCIATED', 'AI']]);
    expect((await readOperationGraph(compte.id, contrat.id))!.relations.map((x) => x.other.operationId)).toEqual([s.id]);

    // Rejoué (par le sinistre, puis par le contrat) : rien de plus.
    const journal = async () => (await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_graph_history WHERE account_id = ${compte.id}`)[0].n;
    const lignes = await journal();
    expect((await chercher(compte, [s.id])).outcomes).toEqual([{ claimOperationId: s.id, outcome: 'ABSTAINED', detail: 'ALREADY_ASSOCIATED', contractOperationIds: [] }]);
    expect((await chercher(compte, [contrat.id])).outcomes).toMatchObject([{ outcome: 'ABSTAINED', detail: 'ALREADY_ASSOCIATED' }]);
    expect(await relations(compte)).toHaveLength(1);
    expect(await journal()).toBe(lignes);
  });

  it('L116C-A02 — ZÉRO assurance candidate : aucun contrat, contrat qui n’est pas une assurance, assurance d’un autre bien, couverture qui exclut la date → ni association ni question', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const voiture = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const s = await sinistre(compte, maison.id);
    expect((await chercher(compte, [s.id])).outcomes).toEqual([{ claimOperationId: s.id, outcome: 'ABSTAINED', detail: 'NO_CONTRACT', contractOperationIds: [] }]);
    // Contrat d'entretien du même bien (aucun justificatif d'assurance) : ce n'est pas une assurance.
    const entretien = await operation(compte, 'CONTRACT', maison.id, await piece(compte, maison.id, 'MAINTENANCE_CONTRACT'), { label: 'Entretien de la chaudière' });
    // Assurance d'un AUTRE bien du compte.
    await assurance(compte, voiture.id, { label: 'Assurance auto', periode: ['2026-01-01', '2026-12-31'] });
    expect((await chercher(compte, [s.id, entretien])).outcomes).toEqual([{ claimOperationId: s.id, outcome: 'ABSTAINED', detail: 'NO_CONTRACT', contractOperationIds: [] }]);
    // Assurance du bien dont la couverture ÉTABLIE s'arrête avant le sinistre : écartée.
    const ancienne = await assurance(compte, maison.id, { label: 'Ancienne assurance', periode: ['2024-01-01', '2024-12-31'] });
    expect((await chercher(compte, [s.id])).outcomes).toEqual([{ claimOperationId: s.id, outcome: 'ABSTAINED', detail: 'NO_COMPATIBLE_CONTRACT', contractOperationIds: [] }]);
    expect(ancienne.id).toBeGreaterThan(0);
    expect(await relations(compte)).toEqual([]);
    expect(await cartes(compte)).toEqual([]);
  });

  it('L116C-A03 — PLUSIEURS assurances possibles : une question par contrat, réponse appliquée par la façade ; refus durable ; rien n’est reposé ni associé d’office ; un contrat couvre plusieurs sinistres', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const habitation = await assurance(compte, maison.id, { label: 'Assurance habitation', periode: ['2026-01-01', '2026-12-31'] });
    const proprietaire = await assurance(compte, maison.id, { label: 'Assurance propriétaire non occupant', periode: ['2025-07-01', '2026-06-30'] });
    const s = await sinistre(compte, maison.id);

    const r = await chercher(compte, [s.id]);
    expect(r.outcomes).toEqual([{ claimOperationId: s.id, outcome: 'ASKED', detail: 'SEVERAL_CONTRACTS', contractOperationIds: [habitation.id, proprietaire.id] }]);
    expect(await relations(compte)).toEqual([]);
    const posees = await cartes(compte);
    expect(posees).toHaveLength(2);
    for (const c of posees) {
      expect(c).toMatchObject({ rule_code: 'OPERATION-RELATION', target_type: 'DOCUMENT' });
      expect(c.trigger_context).toMatchObject({ kind: 'operation_relation', proposal: 'CLAIM_INSURANCE', relationId: null, fromOperationId: s.id, nature: 'ASSOCIATED' });
      // Question ciblée, neutre, qui ne promet aucune prise en charge.
      expect(c.question).toMatch(/^Faut-il associer « [^»]*Dégât des eaux » et « [^»]*Assurance [^»]*» \? /);
      expect(c.question).toMatch(/cela ne dit pas que l’assureur prend le sinistre en charge\.$/);
    }
    expect(posees.map((c) => Number(c.target_id)).sort()).toEqual([habitation.fileId, proprietaire.fileId].sort());

    // Repassé avant toute réponse : les mêmes cartes, aucune de plus.
    await chercher(compte, [s.id]);
    expect(await cartes(compte)).toHaveLength(2);

    // « Oui » pour l'habitation : associée par l'utilisateur. « Non » pour l'autre : refus durable.
    const carteDe = (contratId: number) => posees.find((c) => Number(c.trigger_context.toOperationId) === contratId)!;
    expect(await repondre(compte, carteDe(habitation.id).public_id, 'ASSOCIATE')).toMatchObject({ ok: true });
    expect(await repondre(compte, carteDe(proprietaire.id).public_id, 'KEEP_SEPARATE')).toMatchObject({ ok: true });
    expect((await relations(compte)).map((x) => [x.a === Math.min(s.id, habitation.id) && x.b === Math.max(s.id, habitation.id) ? 'habitation' : 'proprietaire', x.state, x.origin]).sort())
      .toEqual([['habitation', 'ACTIVE', 'USER'], ['proprietaire', 'REJECTED', 'USER']]);
    expect(await cartes(compte)).toEqual([]);
    // Nouveau passage : rien n'est reposé, le refus n'est pas contourné, aucune opération n'a fusionné.
    expect((await chercher(compte, [s.id, habitation.id, proprietaire.id])).outcomes).toMatchObject([{ claimOperationId: s.id, outcome: 'ABSTAINED', detail: 'ALREADY_ASSOCIATED' }]);
    expect(await cartes(compte)).toEqual([]);
    expect(await actives(compte)).toHaveLength(3);

    // Un SECOND sinistre du même bien : le même contrat peut le couvrir aussi (N↔N) — la question est reposée pour LUI.
    const second = await sinistre(compte, maison.id, { label: 'Bris de glace', survenance: '2026-05-20' });
    expect((await chercher(compte, [second.id])).outcomes).toMatchObject([{ claimOperationId: second.id, outcome: 'ASKED', contractOperationIds: [habitation.id, proprietaire.id] }]);
    const pourLeSecond = (await cartes(compte)).find((c) => Number(c.trigger_context.toOperationId) === habitation.id)!;
    expect(await repondre(compte, pourLeSecond.public_id, 'ASSOCIATE')).toMatchObject({ ok: true });
    expect((await relations(compte)).filter((x) => x.state === 'ACTIVE' && (x.a === habitation.id || x.b === habitation.id))).toHaveLength(2);
  });

  it('L116C-A04 — une seule assurance, couverture NON établie à la date : question, jamais d’association automatique ; la date de déclaration ne vaut pas date de survenance', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    // Aucune période connue pour ce contrat.
    const contrat = await assurance(compte, maison.id);
    const s = await sinistre(compte, maison.id);
    expect((await chercher(compte, [s.id])).outcomes).toEqual([{ claimOperationId: s.id, outcome: 'ASKED', detail: 'COVERAGE_NOT_ESTABLISHED', contractOperationIds: [contrat.id] }]);
    expect(await relations(compte)).toEqual([]);
    expect(await cartes(compte)).toHaveLength(1);

    // Autre compte de données : contrat avec période, mais sinistre SANS date de survenance (seulement déclaré) → question.
    const autre = await make.account({ plan: 'premium' });
    const appartement = await make.asset(autre, { category: 'IMMOBILIER', name: 'Appartement' });
    const c2 = await assurance(autre, appartement.id, { periode: ['2026-01-01', '2026-12-31'] });
    const s2 = await sinistre(autre, appartement.id, { survenance: null });
    await sql`INSERT INTO business_operation_claim_details (operation_id, declared_on) VALUES (${s2.id}, '2026-03-15')`;
    expect((await chercher(autre, [s2.id])).outcomes).toEqual([{ claimOperationId: s2.id, outcome: 'ASKED', detail: 'COVERAGE_NOT_ESTABLISHED', contractOperationIds: [c2.id] }]);
    expect(await relations(autre)).toEqual([]);
    // Période à fin INCONNUE (ni date de fin, ni durée indéterminée établie) : la couverture à la date n'est pas prouvée.
    const tiers = await make.account({ plan: 'premium' });
    const studio = await make.asset(tiers, { category: 'IMMOBILIER', name: 'Studio' });
    const c3 = await assurance(tiers, studio.id, { periode: ['2026-01-01', null] });
    const s3 = await sinistre(tiers, studio.id);
    expect((await chercher(tiers, [s3.id])).outcomes).toMatchObject([{ outcome: 'ASKED', detail: 'COVERAGE_NOT_ESTABLISHED', contractOperationIds: [c3.id] }]);
  });

  it('L116C-A05 — la police citée par le sinistre désigne le contrat parmi deux : association automatique ; l’autre police est écartée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const bonne = await assurance(compte, maison.id, { label: 'Assurance habitation', police: 'HAB-2026-001', periode: ['2026-01-01', '2026-12-31'] });
    const autre = await assurance(compte, maison.id, { label: 'Assurance prêt', police: 'EMP-77', periode: ['2026-01-01', '2026-12-31'] });
    const s = await sinistre(compte, maison.id, { police: 'hab-2026-001' });
    expect((await chercher(compte, [s.id])).outcomes).toEqual([{ claimOperationId: s.id, outcome: 'ASSOCIATED', detail: 'POLICY_REFERENCE', contractOperationIds: [bonne.id] }]);
    expect((await relations(compte)).map((x) => [x.a, x.b, x.state])).toEqual([[Math.min(s.id, bonne.id), Math.max(s.id, bonne.id), 'ACTIVE']]);
    expect(autre.id).not.toBe(bonne.id);
    expect(await cartes(compte)).toEqual([]);
  });

  it('L116C-A06 — isolation et refus : l’assurance d’un autre compte n’est jamais candidate ; un refus de l’utilisateur n’est jamais contourné', async () => {
    const compte = await make.account({ plan: 'premium' });
    const voisin = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const maisonVoisine = await make.asset(voisin, { category: 'IMMOBILIER', name: 'Maison' });
    const etrangere = await assurance(voisin, maisonVoisine.id, { periode: ['2026-01-01', '2026-12-31'] });
    const s = await sinistre(compte, maison.id);
    // Même en nommant l'opération de l'autre compte : rien.
    expect((await chercher(compte, [s.id, etrangere.id])).outcomes).toEqual([{ claimOperationId: s.id, outcome: 'ABSTAINED', detail: 'NO_CONTRACT', contractOperationIds: [] }]);
    expect((await chercher(voisin, [s.id, etrangere.id])).outcomes).toEqual([]);
    expect([...(await relations(compte)), ...(await relations(voisin))]).toEqual([]);

    // L'utilisateur refuse d'associer son sinistre à sa propre assurance : la recherche ne l'associe plus, ne demande plus.
    const mienne = await assurance(compte, maison.id, { periode: ['2026-01-01', '2026-12-31'] });
    const { dissociateOperations } = await import('@/services/business-operations/operation-write.facade');
    expect(await dissociateOperations({ accountId: compte.id, actor: { kind: 'USER', userId: compte.ownerUserId, channel: 'UI' } }, { operationAId: s.id, operationBId: mienne.id }))
      .toMatchObject({ status: 'APPLIED', data: { state: 'REJECTED' } });
    expect((await chercher(compte, [s.id])).outcomes).toEqual([{ claimOperationId: s.id, outcome: 'ABSTAINED', detail: 'USER_REFUSED', contractOperationIds: [] }]);
    expect((await relations(compte)).map((x) => x.state)).toEqual(['REJECTED']);
    expect(await cartes(compte)).toEqual([]);
  });

  it('L116C-A07 — branchement réel : la consolidation T3 qui réexamine le sinistre déclenche la recherche après commit', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const contrat = await assurance(compte, maison.id, { periode: ['2026-01-01', '2026-12-31'] });
    const s = await sinistre(compte, maison.id);
    const { syncCards } = await import('@/services/business-operations/consolidation/consolidator');
    const { emptyCardNeeds } = await import('@/services/business-operations/consolidation/card-needs');
    await syncCards(compte.id, { ...emptyCardNeeds(), reviewedOperations: [s.id] });
    expect((await relations(compte)).map((x) => [x.a, x.b, x.state, x.origin])).toEqual([[Math.min(s.id, contrat.id), Math.max(s.id, contrat.id), 'ACTIVE', 'AI']]);
    expect(await actives(compte)).toHaveLength(2);
  });
});
