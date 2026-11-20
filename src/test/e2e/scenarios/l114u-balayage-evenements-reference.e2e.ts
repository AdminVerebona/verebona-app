/**
 * Carte Trello #744 — LE PASSAGE QUI POSE LES TROIS QUESTIONS du CDC §8
 * (rattachement proposé sur pièce, doublon probable, fait contradictoire) et
 * l'ABSTENTION TRACÉE quand l'IA n'a pas tranché (CDC §6, §7, §8, §16, §20 ;
 * AC04, AC09 à AC12, AC16, AC17, AC18, AC20), sur PostgreSQL 16 réel, par les
 * chemins de PRODUCTION : balayage « À traiter » (`runToProcessFullScan`,
 * `produceAccountActions`), sixième famille (`produceReferenceEventActions`),
 * passerelles d'inférence, façade d'écriture, file « À traiter ».
 * Aucun appel à un fournisseur d'IA (les verdicts M3 lus sont des traces déjà
 * enregistrées). Dates fixes (aucune dépendance au jour).
 *
 *   L114U-B-E01  le BALAYAGE pose la carte de rattachement (justificatif commun) ; sans pièce : rien ; rejoué : la
 *                même carte, aucune écriture ; après réponse : jamais reposée ; carte périmée fermée « sans objet »
 *   L114U-B-E02  le passage pose la carte du FAIT contradictoire entre deux événements ASSOCIÉS seulement ; rejeu
 *                sans doublon ; isolation du compte
 *   L114U-B-E03  le passage pose la carte de DOUBLON sur le verdict M3 déjà rendu par T3 ; verdict « distincts » :
 *                aucune carte ; rejeu sans doublon
 *   L114U-B-E04  AC20 — IA indisponible, en échec, ou qui refuse de trancher : AUCUNE carte, une trace d'abstention
 *                au journal du graphe, une seule par situation ; report de simple plafond : aucune trace
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, operationsKit } from '../datasets/operations-v1';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';

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
const facade = () => import('@/services/business-operations/operation-write.facade');
const balayage = () => import('@/services/to-process/reference-event-sweep');

scenario('L114U-B', 'Opérations / Agenda CDC V2.0 — le balayage pose les trois questions des opérations, et trace l’abstention', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });

  /** Événement de référence créé par le dépôt (avec sa source : jamais d'événement sans fondement). */
  async function evenement(compte: AccountRow, type: string, label: string): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: { code: type } as never, status: 'REALIZED', technicalLabel: label,
      source: { kind: 'MIGRATION', entityKey: `l114ub-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' }, reasonCode: 'L114UB_E2E',
    })).id);
  }
  async function document(compte: AccountRow, titre: string, assetId: number | null = null): Promise<number> {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${titre} WHERE id = ${f.id}`;
    return f.id;
  }
  const lierAuEvenement = (itemId: number, fileId: number, provenance = 'MANUAL_DIRECT') => sql`
    INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${itemId}, ${fileId}, ARRAY[${provenance}]::text[])
    ON CONFLICT (agenda_item_id, asset_file_id) DO UPDATE SET provenances = ARRAY[${provenance}]::text[]`;

  const cartes = (compte: AccountRow, regle: string) => sql<Json[]>`
    SELECT id, public_id::text AS public_id, target_type, target_id, relation_key, question, proposals_json, trigger_context,
           resolved_at IS NULL AS ouverte, resolution_reason
      FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = ${regle} ORDER BY id`;
  const liens = (compte: AccountRow, itemId: number) => sql<Json[]>`
    SELECT operation_id::int AS op, legacy_column, state FROM business_operation_agenda_links
     WHERE account_id = ${compte.id} AND agenda_item_id = ${itemId} ORDER BY operation_id`;
  const abstentions = (compte: AccountRow) => sql<Json[]>`
    SELECT action, origin, reason_code, operation_id::int AS op, file_id::int AS file, input_hash, after_json, command, idempotency_key
      FROM business_operation_graph_history WHERE account_id = ${compte.id} AND reason_code LIKE 'ABSTAIN%' ORDER BY id`;
  const resoudre = async (compte: AccountRow, publicId: string, value: string) =>
    (await import('@/services/to-process/resolve-action.service')).resolveArbitration(compte.id, publicId, value, { userId: compte.ownerUserId });
  /** LE PASSAGE : sixième famille du balayage, un compte à la fois. */
  const passer = async (compte: AccountRow) => (await balayage()).produceReferenceEventActions(compte.id);

  /** Trace M3 enregistrée par T3 sur le candidat T1 du document (aucun appel au modèle : une décision déjà prise). */
  async function traceM3(fileId: number, m3: Json): Promise<number> {
    const [c] = await sql<Json[]>`SELECT id FROM document_operation_candidates WHERE file_id = ${fileId} AND status = 'ACTIVE' ORDER BY id LIMIT 1`;
    await sql`UPDATE document_operation_candidates
                 SET t3_detail = jsonb_set(COALESCE(t3_detail, '{}'::jsonb), '{m3}', ${JSON.stringify(m3)}::jsonb)
               WHERE id = ${c.id}`;
    return c.id as number;
  }
  /** Document analysé, son candidat T1 réel, et la source du candidat sur un événement de référence. */
  async function documentSource(compte: AccountRow, assetId: number, opId: number, titre: string): Promise<number> {
    const fileId = await k.document(compte, assetId, [cand({ candidateKey: 'op1', targetHints: [cible(assetId)] })], { title: titre, type: 'INVOICE' });
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(compte.id, async (repo) => {
      const [c] = await sql<Json[]>`SELECT id, candidate_key FROM document_operation_candidates WHERE file_id = ${fileId} AND status = 'ACTIVE'`;
      const sid = await repo.addSource(opId, {
        kind: 'DOCUMENT', entityKey: fileId, version: `c${c.id}|v1`, role: 'INVOICE' as never,
        locator: { candidateKey: c.candidate_key }, authority: 'DOCUMENT', confidence: 'certain', matchMethod: 'M1', matchReason: 'E2E_L114UB',
      } as never, 'T3_MATCH_AND_ENRICH');
      await repo.refreshSourceVersion(sid, `c${c.id}|v1`);
    });
    return fileId;
  }
  const verdict = (over: Json = {}): Json => ({
    decision: 'SAME_OPERATION', matchedOperationId: null, confidence: 'certain',
    concordantSignals: ['même référence de dossier'], contradictions: [], reason: 'même réalité', resolution: 'ATTACH', ...over,
  });

  // ══ 1. Rattachement d'Agenda supplémentaire : posé par le balayage ═════════

  it('L114U-B-E01 — le balayage pose la carte de rattachement sur un justificatif commun, n’écrit rien, ne la repose jamais, et ferme la carte périmée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const toiture = await evenement(compte, 'INTERVENTION', 'Réfection de la toiture');
    const sinistre = await evenement(compte, 'CLAIM', 'Dégât des eaux');
    const passage = await make.agendaItem(compte, { title: 'Passage du couvreur', startDate: '2040-03-01', assetIds: [maison.id] });
    const f = await facade();
    expect(await f.linkAgendaItem(user(compte), { operationId: toiture, agendaItemId: passage.id })).toMatchObject({ status: 'APPLIED' });

    // (a) Aucun justificatif commun : le passage ne propose RIEN (décision du PO du 16/11/2026).
    expect(await passer(compte)).toMatchObject({ created: 0, updated: 0, abstentions: 0 });
    expect(await cartes(compte, 'AGENDA-LINK')).toEqual([]);

    // (b) Un document rattaché au SINISTRE et lié à l'événement de l'Agenda par sa propre provenance.
    const devis = await document(compte, 'Devis toiture', maison.id);
    expect(await f.linkDocument(user(compte), { operationId: sinistre, fileId: devis })).toMatchObject({ status: 'APPLIED' });
    await lierAuEvenement(passage.id, devis);

    // Le BALAYAGE COMPLET du compte (chemin de production) pose la question, une fois.
    const { runToProcessFullScan } = await import('@/services/to-process/to-process-scan.job');
    const scan = await runToProcessFullScan({ accountId: compte.id, trigger: 'manual' });
    expect(scan).not.toBeNull();
    expect(scan!.accounts).toBe(1);
    const [carte, ...trop] = await cartes(compte, 'AGENDA-LINK');
    expect(trop).toEqual([]);
    expect(carte).toMatchObject({ target_type: 'AGENDA_ITEM', target_id: passage.id, ouverte: true, relation_key: `operationAgendaLink:${sinistre}:${passage.id}` });
    expect(carte.question).toContain('« Passage du couvreur »');
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(carte.question).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
    expect(carte.trigger_context).toMatchObject({ operationId: sinistre, agendaItemId: passage.id, currentOperationId: toiture, evidenceKeys: [`DOCUMENT|${devis}`] });
    // RIEN n'a été écrit par le passage : aucun rattachement supplémentaire avant la réponse.
    expect(await liens(compte, passage.id)).toEqual([{ op: toiture, legacy_column: true, state: 'ACTIVE' }]);
    expect(await abstentions(compte)).toEqual([]);

    // (c) Rejoué : la MÊME carte (aucun doublon), et toujours aucune écriture.
    expect(await passer(compte)).toMatchObject({ created: 0, updated: 1 });
    expect((await cartes(compte, 'AGENDA-LINK')).map((c) => c.id)).toEqual([carte.id]);

    // (d) Réponse « non » : rien n'est écrit, et le passage ne repose plus la question sur la même pièce.
    expect(await resoudre(compte, carte.public_id, 'KEEP')).toMatchObject({ ok: true });
    expect(await liens(compte, passage.id)).toEqual([{ op: toiture, legacy_column: true, state: 'ACTIVE' }]);
    expect(await passer(compte)).toMatchObject({ created: 0, updated: 0 });
    expect((await cartes(compte, 'AGENDA-LINK')).filter((c) => c.ouverte)).toEqual([]);

    // (e) Carte PÉRIMÉE : une pièce jamais présentée rouvre la question, puis le rattachement est fait ailleurs
    //     (page) → le passage suivant ferme la carte « sans objet », sans rien appliquer.
    const facture = await document(compte, 'Facture toiture', maison.id);
    expect(await f.linkDocument(user(compte), { operationId: sinistre, fileId: facture })).toMatchObject({ status: 'APPLIED' });
    await lierAuEvenement(passage.id, facture);
    expect(await passer(compte)).toMatchObject({ created: 1 });
    const rouverte = (await cartes(compte, 'AGENDA-LINK')).filter((c) => c.ouverte)[0];
    expect(rouverte).toBeDefined();
    expect(await f.linkAgendaItem(user(compte), { operationId: sinistre, agendaItemId: passage.id })).toMatchObject({ status: 'APPLIED' });
    expect(await passer(compte)).toMatchObject({ closed: 1 });
    expect((await cartes(compte, 'AGENDA-LINK')).find((c) => c.id === rouverte.id)).toMatchObject({ ouverte: false, resolution_reason: 'OBSOLETE' });
    // L'événement de l'Agenda reste UN seul objet, à sa date (il est PARTAGÉ, ni déplacé ni dupliqué).
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`).toEqual([{ n: 1 }]);
  });

  // ══ 2. Fait contradictoire entre deux événements de référence ASSOCIÉS ═════

  it('L114U-B-E02 — le passage pose la carte du fait contradictoire entre deux événements ASSOCIÉS seulement ; rejeu sans doublon ; isolation', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const sinistre = await evenement(compte, 'CLAIM', 'Tempête de février');
    const reparation = await evenement(compte, 'INTERVENTION', 'Réfection de la toiture');
    await sql`UPDATE business_operations SET realized_date = '2040-03-10' WHERE id = ${sinistre}`;
    await sql`UPDATE business_operations SET realized_date = '2040-03-12' WHERE id = ${reparation}`;
    const constat = await document(compte, 'Constat de sinistre', maison.id);
    const f = await facade();
    expect(await f.linkDocument(user(compte), { operationId: sinistre, fileId: constat })).toMatchObject({ status: 'APPLIED' });

    // Deux événements NON associés : deux dates ne se contredisent pas (CDC §11).
    expect(await passer(compte)).toMatchObject({ created: 0 });
    expect(await cartes(compte, 'REFERENCE-EVENT-FACT')).toEqual([]);

    expect(await f.associateOperations(user(compte), { fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR' })).toMatchObject({ status: 'APPLIED' });
    expect(await passer(compte)).toMatchObject({ created: 1 });
    const [carte, ...trop] = await cartes(compte, 'REFERENCE-EVENT-FACT');
    expect(trop).toEqual([]);
    expect(carte).toMatchObject({ ouverte: true, relation_key: `referenceEventFact:${Math.min(sinistre, reparation)}:${Math.max(sinistre, reparation)}:realizedDate` });
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(carte.question).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
    expect((carte.proposals_json as Json[]).map((p) => p.value).sort()).toEqual(['FACT:2040-03-10', 'FACT:2040-03-12']);
    // Aucune valeur n'est écrasée avant la réponse.
    expect(await sql<Json[]>`SELECT id::int AS id, realized_date::text AS d FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`)
      .toEqual([{ id: sinistre, d: '2040-03-10' }, { id: reparation, d: '2040-03-12' }].sort((x, y) => x.id - y.id));

    // Rejeu : la même carte, jamais une seconde.
    expect(await passer(compte)).toMatchObject({ created: 0, updated: 1 });
    expect((await cartes(compte, 'REFERENCE-EVENT-FACT')).map((c) => c.id)).toEqual([carte.id]);

    // Réponse : la valeur retenue est posée PAR LA FAÇADE, et la contradiction disparaît.
    expect(await resoudre(compte, carte.public_id, 'FACT:2040-03-12')).toMatchObject({ ok: true });
    expect(await passer(compte)).toMatchObject({ created: 0, updated: 0 });

    // Isolation : le passage d'un autre compte ne voit rien de celui-ci.
    expect(await passer(autre)).toMatchObject({ created: 0, updated: 0, examined: 0 });
    expect(await cartes(autre, 'REFERENCE-EVENT-FACT')).toEqual([]);
  });

  // ══ 3. Doublon probable : le verdict M3 déjà rendu par T3 ══════════════════

  it('L114U-B-E03 — le passage pose la carte de doublon sur le verdict M3 déjà rendu ; « distincts » : aucune carte ; rejeu sans doublon', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const a = await evenement(compte, 'INTERVENTION', 'Réparation de la fuite');
    const b = await evenement(compte, 'INTERVENTION', 'Réparation fuite cuisine');
    const facture = await documentSource(compte, maison.id, a, 'Facture plomberie');

    // (a) Le modèle a jugé les deux réalités DISTINCTES : aucune question (la décision de T3 est respectée).
    await traceM3(facture, { status: 'DONE', fingerprint: 'fp-1', promptVersion: 't3_master_v1@e2e', verdict: verdict({ decision: 'DISTINCT_OPERATION', resolution: 'DISTINCT', contradictions: ['deux factures'] }) });
    expect(await passer(compte)).toMatchObject({ created: 0, abstentions: 0 });
    expect(await cartes(compte, 'REFERENCE-EVENT-MERGE')).toEqual([]);

    // (b) Le modèle a jugé que c'est la MÊME réalité, et les deux événements sont pourtant toujours vivants :
    //     la fusion automatique ne s'est pas faite (AC12) → on DEMANDE.
    await traceM3(facture, { status: 'DONE', fingerprint: 'fp-2', promptVersion: 't3_master_v1@e2e', verdict: verdict({ matchedOperationId: b }) });
    expect(await passer(compte)).toMatchObject({ created: 1, abstentions: 0 });
    const [carte, ...trop] = await cartes(compte, 'REFERENCE-EVENT-MERGE');
    expect(trop).toEqual([]);
    expect(carte).toMatchObject({ target_type: 'DOCUMENT', target_id: facture, ouverte: true, relation_key: `referenceEventMerge:${Math.min(a, b)}:${Math.max(a, b)}` });
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(carte.question).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
    expect((carte.proposals_json as Json[]).map((p) => p.value)).toEqual(['MERGE', 'KEEP_DISTINCT']);
    expect(carte.trigger_context).toMatchObject({ canonicalOperationId: Math.min(a, b), absorbedOperationId: Math.max(a, b), evidenceKeys: [`DOCUMENT|${facture}`] });
    // Rien n'est fusionné avant la réponse : les deux identités vivent.
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${compte.id} AND merged_into_operation_id IS NOT NULL`).toEqual([{ n: 0 }]);

    // (c) Rejoué : la même carte, jamais une seconde.
    expect(await passer(compte)).toMatchObject({ created: 0, updated: 1 });
    expect((await cartes(compte, 'REFERENCE-EVENT-MERGE')).map((c) => c.id)).toEqual([carte.id]);

    // (d) Réponse « non, ce sont deux événements différents » : rien n'est écrit, et la question ne revient pas.
    expect(await resoudre(compte, carte.public_id, 'KEEP_DISTINCT')).toMatchObject({ ok: true });
    expect(await passer(compte)).toMatchObject({ created: 0, updated: 0 });
    expect((await cartes(compte, 'REFERENCE-EVENT-MERGE')).filter((c) => c.ouverte)).toEqual([]);
  });

  // ══ 4. AC20 — abstention tracée, aucune carte fausse ══════════════════════

  it('L114U-B-E04 — AC20 : IA indisponible, en échec ou qui refuse de trancher → aucune carte, une trace d’abstention, une seule par situation', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const a = await evenement(compte, 'INTERVENTION', 'Réparation de la fuite');
    const facture = await documentSource(compte, maison.id, a, 'Facture plomberie');

    // (a) Prompt indisponible (version BO antérieure) : aucune carte, une trace, et rien d'inventé.
    await traceM3(facture, { status: 'PROMPT_UNAVAILABLE', fingerprint: 'fp-1', promptVersion: 't3_master_v1@ancienne', at: '2040-01-01T00:00:00.000Z' });
    expect(await passer(compte)).toMatchObject({ created: 0, updated: 0, abstentions: 1 });
    expect(await cartes(compte, 'REFERENCE-EVENT-MERGE')).toEqual([]);
    const [t1, ...autres1] = await abstentions(compte);
    expect(autres1).toEqual([]);
    expect(t1).toMatchObject({
      action: 'NO_CHANGE', origin: 'AI', reason_code: 'ABSTAIN_AI_PROMPT_UNAVAILABLE', op: a, file: facture, command: null, idempotency_key: null,
    });
    expect(t1.after_json).toMatchObject({ abstained: true, detail: { m3Status: 'PROMPT_UNAVAILABLE', promptVersion: 't3_master_v1@ancienne' } });

    // (b) Rejoué sur la MÊME situation : aucune seconde ligne (le journal ne se remplit pas d'un balayage horaire).
    expect(await passer(compte)).toMatchObject({ abstentions: 0 });
    expect(await abstentions(compte)).toHaveLength(1);

    // (c) Panne du fournisseur : une autre situation, donc une autre trace ; toujours aucune carte.
    await traceM3(facture, { status: 'ERROR', fingerprint: 'fp-2', promptVersion: 't3_master_v1@e2e', detail: 'PROVIDER_DOWN', at: '2040-01-02T00:00:00.000Z' });
    expect(await passer(compte)).toMatchObject({ abstentions: 1 });
    expect((await abstentions(compte)).map((x) => x.reason_code)).toEqual(['ABSTAIN_AI_PROMPT_UNAVAILABLE', 'ABSTAIN_AI_FAILED']);
    expect(await cartes(compte, 'REFERENCE-EVENT-MERGE')).toEqual([]);

    // (d) Plafond de coût du compte atteint : indisponibilité tracée, reprise plus tard.
    await traceM3(facture, { status: 'DEFERRED', fingerprint: 'fp-3', promptVersion: 't3_master_v1@e2e', detail: 'COST_CAP_REACHED', at: '2040-01-03T00:00:00.000Z' });
    expect(await passer(compte)).toMatchObject({ abstentions: 1 });
    expect((await abstentions(compte)).map((x) => x.reason_code)).toContain('ABSTAIN_AI_UNAVAILABLE');

    // (e) Report de simple plafond d'appels : aucune décision n'était attendue — AUCUNE trace.
    await traceM3(facture, { status: 'DEFERRED', fingerprint: 'fp-4', promptVersion: 't3_master_v1@e2e', detail: 'PASS_CAP', at: '2040-01-04T00:00:00.000Z' });
    expect(await passer(compte)).toMatchObject({ abstentions: 0 });
    expect(await abstentions(compte)).toHaveLength(3);

    // (f) Le modèle a répondu sans trancher : abstention, et AUCUNE carte fausse.
    await traceM3(facture, { status: 'DONE', fingerprint: 'fp-5', promptVersion: 't3_master_v1@e2e', verdict: verdict({ resolution: 'ARBITRATE', matchedOperationId: null, confidence: 'probable' }) });
    expect(await passer(compte)).toMatchObject({ created: 0, abstentions: 1 });
    expect((await abstentions(compte)).map((x) => x.reason_code)).toContain('ABSTAIN_AI_DECLINED');
    expect(await cartes(compte, 'REFERENCE-EVENT-MERGE')).toEqual([]);
    // Aucune écriture métier : ni fusion, ni relation, ni date.
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${compte.id} AND merged_into_operation_id IS NOT NULL`).toEqual([{ n: 0 }]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_relations WHERE account_id = ${compte.id}`).toEqual([{ n: 0 }]);
  });
});
