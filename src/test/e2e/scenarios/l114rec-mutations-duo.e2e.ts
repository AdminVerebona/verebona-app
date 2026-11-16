/**
 * Carte Trello #744 — RECETTE du CDC « Opérations / Agenda V2.0 » :
 * ATOMICITÉ des mutations concurrentes et des pannes SQL sur la FUSION et la
 * SCISSION (§19, §20, §22 ; AC71), et isolation en offre DUO (§19, §23 ;
 * AC59, AC41). Sur PostgreSQL 16 réel, par les chemins de PRODUCTION :
 * façade d'écriture du graphe (`mergeOperations`, `splitOperation`), route
 * de la page (`GET /api/evenements-reference/:id/fiche`). Aucune IA.
 * Dates fixes : aucune dépendance au jour.
 *
 *   L114REC-E12  AC71 : deux FUSIONS simultanées de la même paire (dans les deux sens) → une seule s'applique,
 *                l'autre est refusée ; aucune demi-fusion (une seule identité canonique, liens et sources
 *                transférés une fois, aucun doublon), graphe sans anomalie
 *   L114REC-E13  AC71 : panne SQL au milieu d'une fusion → RIEN n'est appliqué (empreinte du compte identique,
 *                les deux événements de référence restent actifs) ; la même commande rejouée après réparation
 *                s'applique UNE fois
 *   L114REC-E14  AC71 : deux SCISSIONS simultanées du même événement de référence → une seule s'applique (version
 *                attendue) ; panne SQL au milieu d'une scission → rien d'écrit, reprise intègre
 *   L114REC-E16  AC46, AC13 : après une SCISSION, aucune inférence ne redemande de regrouper la paire séparée
 *                (mémoire `USER_SPLIT` lue par la passerelle de fusion) ; aucune carte posée ; une AUTRE paire
 *                reçoit bien la question
 *   L114REC-E15  AC59, AC41 : offre DUO — le second membre lit et corrige l'événement de référence de SON compte
 *                par la vraie route ; un membre d'un autre compte reçoit 404 ; un membre retiré est refusé sans
 *                qu'aucune écriture ait lieu
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';

const session = vi.hoisted(() => ({ currentAccountId: 0 as number | null, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    requireAdmin: async () => session.userId,
    tryGetSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const facade = () => import('@/services/business-operations/operation-write.facade');

scenario('L114REC-M', 'Opérations / Agenda CDC V2.0 — recette : fusion et scission devant la concurrence et la panne, isolation Duo', ({ sql, make }) => {
  const user = (c: AccountRow, userId = c.ownerUserId): OperationWriteContext =>
    ({ accountId: c.id, actor: { kind: 'USER', userId, channel: 'UI' } });
  const connecte = (accountId: number | null, userId: number) => { session.currentAccountId = accountId; session.userId = userId; };

  async function evenement(compte: AccountRow, type: string, over: { label?: string; fileId?: number; assetId?: number } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: { code: type } as never, status: 'REALIZED', technicalLabel: over.label ?? null,
      source: over.fileId
        ? { kind: 'DOCUMENT', entityKey: over.fileId, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain', locator: { e2e: 'recette' } }
        : { kind: 'MIGRATION', entityKey: `l114rec-m-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' },
      ...(over.assetId ? { assets: [{ assetId: over.assetId, role: 'PRIMARY' as const, authority: 'DOCUMENT' as const }] } : {}),
      reasonCode: 'L114REC_M_E2E',
    })).id);
  }
  const lier = async (compte: AccountRow, operationId: number, agendaItemId: number) =>
    (await facade()).linkAgendaItem(user(compte), { operationId, agendaItemId, reasonCode: 'L114REC_M' });
  const etats = (compte: AccountRow) => sql<Json[]>`
    SELECT id::int AS id, invalidated_at IS NOT NULL AS invalide, merged_into_operation_id::int AS fusionne_dans, version
      FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`;
  const audit = async (compte: AccountRow) => {
    const { auditOperationGraph } = await import('@/services/business-operations/graph/store');
    const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
    return auditOperationGraph(postgresRunner(sql as never), compte.id);
  };
  async function empreinte(compte: AccountRow): Promise<string> {
    const [r] = await sql<{ h: string }[]>`
      SELECT md5(concat_ws('#',
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_sources t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_relations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_agenda_links t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_documents t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM agenda_items t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM business_operation_graph_history t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM notification_outbox t WHERE t.account_id = ${compte.id}))) AS h`;
    return r.h;
  }
  /** Panne SQL injectée au milieu d'une commande : l'écriture du journal du graphe échoue. */
  async function avecPanne<T>(body: () => Promise<T>): Promise<T> {
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION l114rec_panne() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'panne e2e (recette #744)'; END $$;
      CREATE TRIGGER l114rec_panne BEFORE INSERT ON business_operation_graph_history FOR EACH ROW EXECUTE FUNCTION l114rec_panne();`);
    try {
      return await body();
    } finally {
      await sql.unsafe(`DROP TRIGGER l114rec_panne ON business_operation_graph_history; DROP FUNCTION l114rec_panne();`);
    }
  }

  // ══ AC71 : fusion devant la concurrence ════════════════════════════════════

  it('L114REC-E12 — deux fusions simultanées de la même paire : une seule s’applique, aucune demi-fusion, graphe sans anomalie (AC71)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const f1 = await make.assetFile(compte, { assetId: maison.id });
    const f2 = await make.assetFile(compte, { assetId: maison.id });
    const a = await evenement(compte, 'INTERVENTION', { label: 'Réparation de la toiture', fileId: f1.id, assetId: maison.id });
    const b = await evenement(compte, 'INTERVENTION', { label: 'Réparation toiture (doublon)', fileId: f2.id, assetId: maison.id });
    const element = await make.agendaItem(compte, { title: 'Passage du couvreur', startDate: '2026-05-04', assetIds: [maison.id] });
    expect(await lier(compte, b, element.id)).toMatchObject({ status: 'APPLIED' });

    const f = await facade();
    const resultats = await Promise.all([
      f.mergeOperations(user(compte), { absorbedOperationId: b, canonicalOperationId: a, reasonCode: 'L114REC_E12' }),
      f.mergeOperations(user(compte), { absorbedOperationId: a, canonicalOperationId: b, reasonCode: 'L114REC_E12' }),
    ]);
    // Une seule fusion appliquée ; la seconde est refusée (l'un des deux n'est plus actif) — jamais deux.
    const appliquees = resultats.filter((r) => r.status === 'APPLIED');
    expect(appliquees).toHaveLength(1);
    expect(resultats.filter((r) => r.status !== 'APPLIED').map((r) => r.status)).not.toContain('APPLIED');

    // Aucune demi-fusion : UNE identité active, l'autre redirigée vers elle (jamais supprimée).
    const apres = await etats(compte);
    const actifs = apres.filter((o) => !o.invalide && o.fusionne_dans === null);
    expect(actifs).toHaveLength(1);
    const canonique = Number(actifs[0].id);
    const absorbe = apres.find((o) => Number(o.id) !== canonique)!;
    expect(Number(absorbe.fusionne_dans)).toBe(canonique);
    // Liens et sources transférés UNE fois, sans doublon.
    expect(await sql<Json[]>`
      SELECT operation_id::int AS op, count(*)::int AS n FROM business_operation_agenda_links
       WHERE account_id = ${compte.id} AND state = 'ACTIVE' GROUP BY 1`).toEqual([{ op: canonique, n: 1 }]);
    expect((await sql<Json[]>`
      SELECT count(*)::int AS n FROM business_operation_sources
       WHERE operation_id = ${canonique} AND active AND source_kind = 'DOCUMENT'`)[0].n).toBe(2);
    expect(await audit(compte)).toEqual([]);
  });

  it('L114REC-E13 — panne SQL au milieu d’une fusion : rien n’est appliqué ; la même commande rejouée après réparation s’applique une fois (AC71)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const f1 = await make.assetFile(compte, { assetId: maison.id });
    const f2 = await make.assetFile(compte, { assetId: maison.id });
    const a = await evenement(compte, 'CONTRACT', { label: 'Contrat d’entretien', fileId: f1.id, assetId: maison.id });
    const b = await evenement(compte, 'CONTRACT', { label: 'Contrat d’entretien (doublon)', fileId: f2.id, assetId: maison.id });
    const avant = await empreinte(compte);
    const f = await facade();

    const echec = await avecPanne(() => f.mergeOperations(user(compte), { absorbedOperationId: b, canonicalOperationId: a, reasonCode: 'L114REC_E13' }));
    expect(echec.status).toBe('FAILED');
    // Aucune demi-fusion présentée comme réussie : les deux restent actifs, l'empreinte du compte est identique.
    expect((await etats(compte)).filter((o) => !o.invalide && o.fusionne_dans === null)).toHaveLength(2);
    expect(await empreinte(compte)).toBe(avant);

    const reprise = await f.mergeOperations(user(compte), { absorbedOperationId: b, canonicalOperationId: a, reasonCode: 'L114REC_E13' });
    expect(reprise).toMatchObject({ status: 'APPLIED', data: { canonicalOperationId: a, absorbedOperationId: b } });
    expect((await etats(compte)).filter((o) => !o.invalide && o.fusionne_dans === null).map((o) => Number(o.id))).toEqual([a]);
    expect(await audit(compte)).toEqual([]);
  });

  // ══ AC71 : scission devant la concurrence ══════════════════════════════════

  it('L114REC-E14 — deux scissions simultanées du même événement de référence : une seule s’applique ; panne SQL : rien d’écrit (AC71)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const f1 = await make.assetFile(compte, { assetId: maison.id });
    const f2 = await make.assetFile(compte, { assetId: maison.id });
    const op = await evenement(compte, 'INTERVENTION', { label: 'Travaux regroupés à tort', fileId: f1.id, assetId: maison.id });
    expect(await (await facade()).linkDocument(user(compte), { operationId: op, fileId: f2.id })).toMatchObject({ status: 'APPLIED' });
    const e1 = await make.agendaItem(compte, { title: 'Pose des fenêtres', startDate: '2026-03-02', assetIds: [maison.id] });
    const e2 = await make.agendaItem(compte, { title: 'Ravalement', startDate: '2026-09-14', assetIds: [maison.id] });
    for (const el of [e1, e2]) expect(await lier(compte, op, el.id)).toMatchObject({ status: 'APPLIED' });
    const [{ version }] = await sql<Json[]>`SELECT version FROM business_operations WHERE id = ${op}`;
    const f = await facade();

    // Panne SQL en cours de scission : rien n'est écrit.
    const avant = await empreinte(compte);
    const echec = await avecPanne(() => f.splitOperation(user(compte), {
      operationId: op, expectedVersion: Number(version), label: 'Ravalement de la façade', agendaItemIds: [e2.id], fileIds: [f2.id], reasonCode: 'L114REC_E14',
    }));
    expect(echec.status).toBe('FAILED');
    expect(await empreinte(compte)).toBe(avant);
    expect(await etats(compte)).toHaveLength(1);

    // Deux scissions simultanées qui réclament LE MÊME fait : une seule l'obtient ; l'autre est refusée
    // parce que le fait n'est plus rattaché à l'origine (la fiche lue est périmée) — jamais un fait en deux endroits.
    const concurrentes = await Promise.all([
      f.splitOperation(user(compte), { operationId: op, label: 'Ravalement de la façade', agendaItemIds: [e2.id], reasonCode: 'L114REC_E14' }),
      f.splitOperation(user(compte), { operationId: op, label: 'Ravalement (doublon)', agendaItemIds: [e2.id], reasonCode: 'L114REC_E14' }),
    ]);
    expect(concurrentes.filter((r) => r.status === 'APPLIED')).toHaveLength(1);
    expect(concurrentes.filter((r) => r.status === 'CONFLICT' && r.code === 'SPLIT_PART_NOT_LINKED')).toHaveLength(1);
    // Exactement DEUX événements de référence : l'origine et le nouveau (jamais trois).
    expect(await etats(compte)).toHaveLength(2);
    // Chaque événement de l'Agenda est rattaché UNE fois : aucun fait dupliqué, aucun fait perdu.
    expect((await sql<Json[]>`
      SELECT agenda_item_id::int AS el, count(*)::int AS n FROM business_operation_agenda_links
       WHERE account_id = ${compte.id} AND state = 'ACTIVE' GROUP BY 1 ORDER BY 1`).map((r) => Number(r.n))).toEqual([1, 1]);
    expect(await audit(compte)).toEqual([]);

    // CONSTAT (signalé au PO, voir la fiche de recette) : une scission ne fait PAS avancer la version de
    // l'événement scindé — une page ouverte avant la scission peut en demander une seconde avec la même
    // version attendue. La protection réelle est la vérification FAIT PAR FAIT ci-dessus.
    const [{ version: apres }] = await sql<Json[]>`SELECT version FROM business_operations WHERE id = ${op}`;
    expect(Number(apres)).toBe(Number(version));
  });

  // ══ AC46, AC13 : la séparation ne se rejoue pas ════════════════════════════

  it('L114REC-E16 — après une scission, aucune inférence ne redemande de regrouper la paire séparée ; une autre paire reçoit bien la question (AC46, AC13)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const f1 = await make.assetFile(compte, { assetId: maison.id });
    const op = await evenement(compte, 'INTERVENTION', { label: 'Travaux regroupés à tort', fileId: f1.id, assetId: maison.id });
    const element = await make.agendaItem(compte, { title: 'Ravalement', startDate: '2026-09-14', assetIds: [maison.id] });
    expect(await lier(compte, op, element.id)).toMatchObject({ status: 'APPLIED' });
    const f = await facade();
    const scission = await f.splitOperation(user(compte), { operationId: op, label: 'Ravalement de la façade', agendaItemIds: [element.id], reasonCode: 'L114REC_E16' });
    expect(scission).toMatchObject({ status: 'APPLIED' });
    const nouveau = scission.data!.newOperationId;
    const cartesOuvertes = () => sql<Json[]>`
      SELECT rule_code, relation_key FROM to_process_actions WHERE account_id = ${compte.id} AND resolved_at IS NULL ORDER BY id`;
    const avantCartes = await cartesOuvertes();

    // Un traitement croit avoir trouvé un doublon : la question n'est PAS posée sur la paire séparée.
    const { proposeReferenceEventMerge } = await import('@/services/business-operations/graph/merge-proposal');
    const t3 = { accountId: compte.id, actor: { kind: 'AI' as const, treatment: 'T3' as const } };
    expect(await proposeReferenceEventMerge(t3, {
      operationAId: op, operationBId: nouveau, evidence: [{ kind: 'DOCUMENT', ref: String(f1.id) }],
    })).toMatchObject({ status: 'NOT_ASKED', card: { status: 'NOT_APPLICABLE', reason: 'USER_SPLIT_APART' } });
    expect(await cartesOuvertes()).toEqual(avantCartes);
    // Dans l'autre sens non plus (la mémoire est symétrique).
    expect(await proposeReferenceEventMerge(t3, {
      operationAId: nouveau, operationBId: op, evidence: [{ kind: 'DOCUMENT', ref: String(f1.id) }],
    })).toMatchObject({ status: 'NOT_ASKED' });

    // Une AUTRE paire, jamais séparée, reçoit bien la question (la garde ne bloque pas tout).
    const f2 = await make.assetFile(compte, { assetId: maison.id });
    const autre = await evenement(compte, 'INTERVENTION', { label: 'Travaux (doublon probable)', fileId: f2.id, assetId: maison.id });
    const pose = await proposeReferenceEventMerge(t3, {
      operationAId: op, operationBId: autre, evidence: [{ kind: 'DOCUMENT', ref: String(f2.id) }],
    });
    expect(pose.status).toBe('ASKED');
    expect(await cartesOuvertes()).toHaveLength(avantCartes.length + 1);
  });

  // ══ AC59, AC41 : offre Duo ═════════════════════════════════════════════════

  it('L114REC-E15 — offre Duo : le second membre lit et corrige l’événement de référence de son compte ; un membre retiré ne peut plus écrire ; aucun accès à un autre compte (AC59, AC41)', async () => {
    const compte = await make.account({ plan: 'premium_duo' });
    const conjoint = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${compte.id}, ${conjoint.id}, 'member', 'active')`;
    const autre = await make.account({ plan: 'premium_duo' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const fichier = await make.assetFile(compte, { assetId: maison.id });
    const op = await evenement(compte, 'INTERVENTION', { label: 'Remplacement de la chaudière', fileId: fichier.id, assetId: maison.id });
    const opAutre = await evenement(autre, 'INTERVENTION', { label: 'Travaux d’un autre compte' });

    const { GET } = await import('@/app/api/evenements-reference/[id]/fiche/route');
    const lire = async (id: number) => GET(
      new NextRequest(`http://local/api/evenements-reference/${id}/fiche`),
      { params: Promise.resolve({ id: String(id) }) },
    );

    // Le second membre du compte Duo lit la fiche de SON compte.
    connecte(compte.id, conjoint.id);
    const vu = await lire(op);
    expect(vu.status).toBe(200);
    expect(await vu.json()).toMatchObject({ fiche: { id: op } });
    // Il ne voit RIEN de l'autre compte (404, sans distinguer « existe » de « interdit »).
    expect((await lire(opAutre)).status).toBe(404);

    // Il écrit légitimement dans son compte (Duo = deux membres de plein droit).
    const f = await facade();
    const correction = await f.correctOperation(user(compte, conjoint.id), { operationId: op, label: 'Remplacement de la chaudière (gaz)', reasonCode: 'L114REC_E15' });
    expect(correction).toMatchObject({ status: 'APPLIED' });
    expect((await sql<Json[]>`SELECT technical_label FROM business_operations WHERE id = ${op}`)[0].technical_label).toBe('Remplacement de la chaudière (gaz)');

    // Membre RETIRÉ : toute écriture est refusée et rien n'est écrit. (La LECTURE n'est pas testée ici : la
    // route lit le compte porté par la session, et la fin d'une adhésion passe par le registre des sessions —
    // mécanisme de la plateforme, hors du périmètre de cette carte ; voir la fiche de recette.)
    await sql`UPDATE account_memberships SET status = 'removed', removed_at = now() WHERE account_id = ${compte.id} AND user_id = ${conjoint.id}`;
    const avant = await empreinte(compte);
    expect(await f.correctOperation(user(compte, conjoint.id), { operationId: op, label: 'Tentative interdite', reasonCode: 'L114REC_E15' }))
      .toMatchObject({ status: 'FORBIDDEN', code: 'NOT_A_MEMBER' });
    expect(await empreinte(compte)).toBe(avant);
    expect(await audit(compte)).toEqual([]);
  });
});
