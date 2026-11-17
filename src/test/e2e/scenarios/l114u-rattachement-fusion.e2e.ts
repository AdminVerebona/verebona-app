/**
 * Carte Trello #744 — DÉCISION DU PO DU 16/11/2026 (rattachement d'Agenda
 * supplémentaire proposé sur un JUSTIFICATIF COMMUN) et CDC « Opérations /
 * Agenda V2.0 » §7, §8 (cartes de FUSION), sur PostgreSQL 16 réel, par les
 * chemins de PRODUCTION : façade d'écriture du graphe, passerelles
 * d'inférence, file « À traiter » (`getToProcessPage`, `resolveArbitration`),
 * fusion existante du dépôt, consolidation T3. Aucune IA, aucun appel réseau.
 * Dates fixes (aucune dépendance au jour).
 *
 *   L114U-E01  rien n'est proposé SANS pièce ; avec un justificatif commun, UNE carte portée par l'événement
 *              d'Agenda ; « Oui » appliqué par la façade : l'événement est PARTAGÉ (un seul objet, à sa date,
 *              colonne historique intacte) ; rejeu → la même carte
 *   L114U-E02  « Non » n'écrit rien ; même pièce rejouée → aucune carte ; pièce jamais présentée → nouvelle carte ;
 *              une provenance DÉRIVÉE du rattachement ne vaut pas preuve ; un refus de l'utilisateur n'est jamais
 *              contourné ; isolation du compte
 *   L114U-E03  fusion : carte neutre, « Oui » appliqué par la façade (identité canonique, sources et liens
 *              transférés sans doublon, ancien identifiant redirigé, journal) ; aucun événement, aucun rappel créé
 *   L114U-E04  fusion : « Non » n'écrit RIEN et la séparation tient face à la fusion automatique de T3 (AC12) ;
 *              même preuve → aucune carte ; deux types métier différents → refus clair ; isolation
 *   L114U-E05  fait contradictoire : deux événements ASSOCIÉS → carte ; non associés → aucune carte ; la valeur
 *              retenue est posée par la façade sur celui qui ne la portait pas ; version périmée → carte fermée
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
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
const pontRattachement = () => import('@/services/business-operations/graph/agenda-link-proposal');
const pontFusion = () => import('@/services/business-operations/graph/merge-proposal');

scenario('L114U', 'Opérations / Agenda CDC V2.0 — rattachement d’Agenda proposé sur pièce, et cartes de fusion entre deux événements de référence', ({ sql, make }) => {
  const user = (c: AccountRow, userId = c.ownerUserId): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId, channel: 'UI' } });
  const t3 = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'AI', treatment: 'T3' } });
  const doc = (ref: number | string) => ({ kind: 'DOCUMENT' as const, ref: String(ref) });

  /** Événement de référence créé par le dépôt (avec sa source : jamais d'événement sans fondement). */
  async function evenement(compte: AccountRow, type: string, label: string): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: { code: type } as never, status: 'REALIZED', technicalLabel: label,
      source: { kind: 'MIGRATION', entityKey: `l114u-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' }, reasonCode: 'L114U_E2E',
    })).id);
  }
  async function document(compte: AccountRow, titre: string, assetId: number | null = null): Promise<number> {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${titre} WHERE id = ${f.id}`;
    return f.id;
  }
  /** Lien document ↔ événement de l'Agenda avec SA provenance (jamais celle dérivée d'un rattachement). */
  const lierAuEvenement = (itemId: number, fileId: number, provenance = 'MANUAL_DIRECT') => sql`
    INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${itemId}, ${fileId}, ARRAY[${provenance}]::text[])
    ON CONFLICT (agenda_item_id, asset_file_id) DO UPDATE SET provenances = ARRAY[${provenance}]::text[]`;

  const cartes = (compte: AccountRow, regle: string) => sql<Json[]>`
    SELECT id, public_id::text AS public_id, target_type, target_id, relation_key, question, proposals_json, trigger_context,
           resolved_at IS NULL AS ouverte, resolution_reason
      FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = ${regle} ORDER BY id`;
  const resoudre = async (compte: AccountRow, publicId: string, value: string, userId: number | null = compte.ownerUserId) => {
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    return resolveArbitration(compte.id, publicId, value, { userId });
  };
  const file = async (compte: AccountRow) => {
    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    return (await getToProcessPage(compte.id, { withLinks: true })).actions as unknown as Json[];
  };
  const liens = (compte: AccountRow, itemId: number) => sql<Json[]>`
    SELECT operation_id::int AS op, legacy_column, state FROM business_operation_agenda_links
     WHERE account_id = ${compte.id} AND agenda_item_id = ${itemId} ORDER BY operation_id`;
  const journal = (compte: AccountRow) => sql<Json[]>`
    SELECT action, origin, channel, actor_user_id::int AS u, command FROM business_operation_graph_history
     WHERE account_id = ${compte.id} ORDER BY id`;
  const nbEvenementsAgenda = async (compte: AccountRow) =>
    (await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`)[0].n as number;
  const nbDocuments = async (compte: AccountRow) =>
    (await sql<Json[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${compte.id}`)[0].n as number;

  // ══ 1. Rattachement d'Agenda supplémentaire proposé, jamais écrit ══════════

  it('L114U-E01 — sans justificatif commun RIEN n’est proposé ; avec, une carte portée par l’événement d’Agenda, et « Oui » est appliqué par la façade', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const toiture = await evenement(compte, 'INTERVENTION', 'Réfection de la toiture');
    const sinistre = await evenement(compte, 'CLAIM', 'Dégât des eaux');
    const passage = await make.agendaItem(compte, { title: 'Passage du couvreur', startDate: '2040-03-01', assetIds: [maison.id] });

    const f = await facade();
    // Premier rattachement : porté par la colonne historique (les écrans actuels le voient).
    expect(await f.linkAgendaItem(user(compte), { operationId: toiture, agendaItemId: passage.id })).toMatchObject({ status: 'APPLIED', data: { support: 'LEGACY_COLUMN' } });

    const { proposeExtraAgendaLink } = await pontRattachement();
    // (a) AUCUNE pièce : rien n'est proposé, rien n'est écrit (décision du PO du 16/11/2026).
    expect(await proposeExtraAgendaLink(t3(compte), { operationId: sinistre, agendaItemId: passage.id }))
      .toMatchObject({ status: 'NOT_PROPOSED', proposal: { status: 'NO_SHARED_EVIDENCE', reason: 'NO_SHARED_DOCUMENT' } });
    expect(await cartes(compte, 'AGENDA-LINK')).toEqual([]);

    // (b) Un document rattaché au SINISTRE seulement : toujours pas de pièce COMMUNE.
    const devis = await document(compte, 'Devis toiture', maison.id);
    expect(await f.linkDocument(user(compte), { operationId: sinistre, fileId: devis })).toMatchObject({ status: 'APPLIED' });
    expect((await proposeExtraAgendaLink(t3(compte), { operationId: sinistre, agendaItemId: passage.id })).proposal)
      .toMatchObject({ status: 'NO_SHARED_EVIDENCE' });

    // (c) Le MÊME document est aussi lié à l'événement de l'Agenda, par sa propre provenance : la pièce est commune.
    await lierAuEvenement(passage.id, devis);
    expect(await proposeExtraAgendaLink(t3(compte), { operationId: sinistre, agendaItemId: passage.id }))
      .toMatchObject({ status: 'PROPOSED', proposal: { status: 'POSTED' } });
    const [carte, ...trop] = await cartes(compte, 'AGENDA-LINK');
    expect(trop).toEqual([]);
    // Portée par l'ÉVÉNEMENT D'AGENDA réel ; aucun objet n'a été créé pour la porter.
    expect(carte).toMatchObject({ target_type: 'AGENDA_ITEM', target_id: passage.id, ouverte: true, relation_key: `operationAgendaLink:${sinistre}:${passage.id}` });
    expect(await nbEvenementsAgenda(compte)).toBe(1);
    expect(await nbDocuments(compte)).toBe(1);
    expect(carte.question).toContain('« Passage du couvreur »');
    expect(carte.question).toContain('« Devis toiture »');
    expect(carte.question).not.toMatch(/op[ée]ration/i);
    expect((carte.proposals_json as Json[]).map((p) => p.value)).toEqual(['ATTACH', 'KEEP']);
    expect(carte.trigger_context).toMatchObject({ operationId: sinistre, agendaItemId: passage.id, currentOperationId: toiture, evidenceKeys: [`DOCUMENT|${devis}`] });
    // Elle est proposée dans la file du compte, avec la même question.
    expect((await file(compte)).find((a) => a.publicId === carte.public_id)).toMatchObject({ ruleCode: 'AGENDA-LINK', question: carte.question });
    // Rien n'a été écrit : aucun lien supplémentaire avant la réponse.
    expect(await liens(compte, passage.id)).toEqual([{ op: toiture, legacy_column: true, state: 'ACTIVE' }]);

    // Rejeu du traitement : la MÊME carte (jamais une seconde).
    expect((await proposeExtraAgendaLink(t3(compte), { operationId: sinistre, agendaItemId: passage.id })).proposal).toMatchObject({ status: 'UPDATED' });
    expect((await cartes(compte, 'AGENDA-LINK')).length).toBe(1);

    // « Oui » : appliqué PAR LA FAÇADE, canal « À traiter ». L'événement est PARTAGÉ, pas déplacé ni dupliqué.
    expect(await resoudre(compte, carte.public_id, 'ATTACH')).toMatchObject({ ok: true, undoable: false });
    expect(await liens(compte, passage.id)).toEqual(
      [{ op: toiture, legacy_column: true, state: 'ACTIVE' }, { op: sinistre, legacy_column: false, state: 'ACTIVE' }].sort((a, b) => a.op - b.op));
    // Un seul objet d'Agenda, à SA date, et la colonne historique est intacte.
    expect(await sql<Json[]>`SELECT count(*)::int AS n, min(start_date)::text AS d, min(business_operation_id)::int AS op FROM agenda_items WHERE account_id = ${compte.id}`)
      .toEqual([{ n: 1, d: '2040-03-01', op: toiture }]);
    // Aucun rôle « principal » posé par ce chemin.
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id} AND operation_role = 'PRINCIPAL'`).toEqual([{ n: 0 }]);
    // Journal : l'écriture est celle de l'utilisateur, par la carte.
    expect((await journal(compte)).filter((j) => j.command === 'linkAgendaItem' && j.channel === 'TO_PROCESS'))
      .toMatchObject([{ action: 'CREATED', origin: 'USER', u: compte.ownerUserId }]);
    // La carte est fermée par la décision de l'utilisateur.
    expect((await cartes(compte, 'AGENDA-LINK'))[0]).toMatchObject({ ouverte: false, resolution_reason: 'USER_ARBITRATED' });
  });

  it('L114U-E02 — « Non » n’écrit rien et ne se redemande pas ; une provenance dérivée du rattachement ne vaut pas preuve ; un refus de l’utilisateur n’est jamais contourné ; isolation du compte', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const contrat = await evenement(compte, 'CONTRACT', 'Contrat d’entretien');
    const diagnostic = await evenement(compte, 'INTERVENTION', 'Diagnostic de performance');
    const visite = await make.agendaItem(compte, { title: 'Visite d’entretien', startDate: '2040-05-04', assetIds: [maison.id] });
    const f = await facade();
    expect(await f.linkAgendaItem(user(compte), { operationId: contrat, agendaItemId: visite.id })).toMatchObject({ status: 'APPLIED' });

    const { proposeExtraAgendaLink } = await pontRattachement();
    // Une provenance DÉRIVÉE du rattachement (OPERATION_PRINCIPAL) serait circulaire : elle ne vaut pas preuve.
    const rapport = await document(compte, 'Rapport de visite', maison.id);
    expect(await f.linkDocument(user(compte), { operationId: diagnostic, fileId: rapport })).toMatchObject({ status: 'APPLIED' });
    await lierAuEvenement(visite.id, rapport, 'OPERATION_PRINCIPAL');
    expect((await proposeExtraAgendaLink(t3(compte), { operationId: diagnostic, agendaItemId: visite.id })).proposal)
      .toMatchObject({ status: 'NO_SHARED_EVIDENCE' });
    expect(await cartes(compte, 'AGENDA-LINK')).toEqual([]);

    // La même pièce, liée par sa PROPRE provenance : la question est posée.
    await lierAuEvenement(visite.id, rapport, 'AI_DIRECT');
    expect((await proposeExtraAgendaLink(t3(compte), { operationId: diagnostic, agendaItemId: visite.id })).proposal).toMatchObject({ status: 'POSTED' });
    const carte = (await cartes(compte, 'AGENDA-LINK'))[0];

    // Isolation : la carte d'un autre compte ne se résout pas, et le lien n'est pas écrit.
    expect(await resoudre(autre, carte.public_id, 'ATTACH')).toMatchObject({ ok: false });
    expect((await liens(compte, visite.id)).map((l) => l.op)).toEqual([contrat]);

    // « Non » : RIEN n'est écrit (ni lien, ni refus durable), la carte est fermée par la décision de l'utilisateur.
    expect(await resoudre(compte, carte.public_id, 'KEEP')).toMatchObject({ ok: true });
    expect((await liens(compte, visite.id)).map((l) => l.op)).toEqual([contrat]);
    expect((await journal(compte)).filter((j) => j.channel === 'TO_PROCESS')).toEqual([]);

    // Même pièce rejouée : la question n'est PAS reposée (AC14).
    expect((await proposeExtraAgendaLink(t3(compte), { operationId: diagnostic, agendaItemId: visite.id })).proposal).toMatchObject({ status: 'ALREADY_ANSWERED' });
    expect((await cartes(compte, 'AGENDA-LINK')).filter((c) => c.ouverte)).toEqual([]);

    // Une pièce JAMAIS présentée rouvre la question.
    const avenant = await document(compte, 'Avenant au contrat', maison.id);
    expect(await f.linkDocument(user(compte), { operationId: diagnostic, fileId: avenant })).toMatchObject({ status: 'APPLIED' });
    await lierAuEvenement(visite.id, avenant);
    expect((await proposeExtraAgendaLink(t3(compte), { operationId: diagnostic, agendaItemId: visite.id })).proposal).toMatchObject({ status: 'POSTED' });
    const seconde = (await cartes(compte, 'AGENDA-LINK')).filter((c) => c.ouverte);
    expect(seconde.length).toBe(1);

    // Un REFUS de l'utilisateur (détachement) n'est jamais contourné par une inférence.
    expect(await f.linkAgendaItem(user(compte), { operationId: diagnostic, agendaItemId: visite.id })).toMatchObject({ status: 'APPLIED', data: { support: 'EXTRA' } });
    expect(await f.unlinkAgendaItem(user(compte), { operationId: diagnostic, agendaItemId: visite.id })).toMatchObject({ status: 'APPLIED' });
    const troisieme = await document(compte, 'Second rapport', maison.id);
    expect(await f.linkDocument(user(compte), { operationId: diagnostic, fileId: troisieme })).toMatchObject({ status: 'APPLIED' });
    await lierAuEvenement(visite.id, troisieme);
    expect((await proposeExtraAgendaLink(t3(compte), { operationId: diagnostic, agendaItemId: visite.id })).proposal)
      .toMatchObject({ status: 'NOT_APPLICABLE', reason: 'USER_REJECTED' });

    // Le geste de l'utilisateur, lui, ne passe pas par ce détour.
    expect(await proposeExtraAgendaLink(user(compte), { operationId: diagnostic, agendaItemId: visite.id })).toEqual({ status: 'USER_ONLY' });
  });

  // ══ 2. « Même événement de référence, ou deux ? » ══════════════════════════

  it('L114U-E03 — fusion : carte neutre portée par un objet réel ; « Oui » appliqué par la façade (identité canonique, sources transférées, ancien identifiant redirigé, journal) et aucun événement créé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const a = await evenement(compte, 'INTERVENTION', 'Réparation de fuite');
    const b = await evenement(compte, 'INTERVENTION', 'Intervention plomberie');
    const f = await facade();
    const facture = await document(compte, 'Facture de plomberie', maison.id);
    expect(await f.linkDocument(user(compte), { operationId: b, fileId: facture })).toMatchObject({ status: 'APPLIED' });
    const rdv = await make.agendaItem(compte, { title: 'Passage du plombier', startDate: '2040-02-02', assetIds: [maison.id] });
    expect(await f.linkAgendaItem(user(compte), { operationId: b, agendaItemId: rdv.id })).toMatchObject({ status: 'APPLIED' });

    const { proposeReferenceEventMerge } = await pontFusion();
    expect(await proposeReferenceEventMerge(t3(compte), { operationAId: b, operationBId: a, evidence: [doc(facture)] }))
      .toMatchObject({ status: 'ASKED', card: { status: 'POSTED' } });
    const [carte, ...trop] = await cartes(compte, 'REFERENCE-EVENT-MERGE');
    expect(trop).toEqual([]);
    expect(carte).toMatchObject({ target_type: 'DOCUMENT', target_id: facture, ouverte: true, relation_key: `referenceEventMerge:${Math.min(a, b)}:${Math.max(a, b)}` });
    expect(carte.question).not.toMatch(/\bop[ée]ration/i);
    expect((carte.proposals_json as Json[]).map((p) => p.value)).toEqual(['MERGE', 'KEEP_DISTINCT']);
    // Identité canonique proposée : le plus ancien des deux (choix par défaut, à valider par le PO).
    expect(carte.trigger_context).toMatchObject({ canonicalOperationId: Math.min(a, b), absorbedOperationId: Math.max(a, b) });
    // Rien n'est écrit avant la réponse : les deux événements existent toujours.
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${compte.id} AND merged_into_operation_id IS NULL`).toEqual([{ n: 2 }]);
    const evenementsAvant = await nbEvenementsAgenda(compte);

    // « Oui » : fusion appliquée par la façade.
    expect(await resoudre(compte, carte.public_id, 'MERGE')).toMatchObject({ ok: true, undoable: false });
    const canon = Math.min(a, b);
    const absorbe = Math.max(a, b);
    expect(await sql<Json[]>`
      SELECT id::int AS id, merged_into_operation_id::int AS vers, invalidation_reason AS motif FROM business_operations
       WHERE account_id = ${compte.id} ORDER BY id`)
      .toEqual([{ id: canon, vers: null, motif: null }, { id: absorbe, vers: canon, motif: 'MERGED' }].sort((x, y) => x.id - y.id));
    // Sources et liens de l'absorbé rapatriés, sans doublon : le justificatif et l'événement d'Agenda suivent.
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_documents WHERE account_id = ${compte.id} AND operation_id = ${canon} AND active`).toEqual([{ n: 1 }]);
    expect((await liens(compte, rdv.id)).filter((l) => l.state === 'ACTIVE').map((l) => l.op)).toEqual([canon]);
    // Aucun événement d'Agenda, aucun rappel créé par la fusion.
    expect(await nbEvenementsAgenda(compte)).toBe(evenementsAvant);
    // Journal du graphe : la commande de la façade, canal « À traiter », acteur utilisateur.
    expect((await journal(compte)).filter((j) => j.command === 'mergeOperations'))
      .toMatchObject([{ action: 'REASSIGNED_ON_MERGE', origin: 'USER', channel: 'TO_PROCESS', u: compte.ownerUserId }]);
    expect((await cartes(compte, 'REFERENCE-EVENT-MERGE'))[0]).toMatchObject({ ouverte: false, resolution_reason: 'USER_ARBITRATED' });
  });

  it('L114U-E04 — fusion : « Non » n’écrit RIEN, la séparation tient face à la fusion automatique de T3 (AC12), la même preuve ne redemande rien, et deux types différents sont refusés', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const a = await evenement(compte, 'INTERVENTION', 'Entretien de la chaudière');
    const b = await evenement(compte, 'INTERVENTION', 'Contrôle de la chaudière');
    const f = await facade();
    const rapport = await document(compte, 'Rapport d’entretien', maison.id);
    expect(await f.linkDocument(user(compte), { operationId: a, fileId: rapport })).toMatchObject({ status: 'APPLIED' });

    const { proposeReferenceEventMerge } = await pontFusion();
    expect((await proposeReferenceEventMerge(t3(compte), { operationAId: a, operationBId: b, evidence: [doc(rapport)] })).card).toMatchObject({ status: 'POSTED' });
    const carte = (await cartes(compte, 'REFERENCE-EVENT-MERGE'))[0];

    // Isolation : un autre compte ne résout pas cette carte.
    expect(await resoudre(autre, carte.public_id, 'MERGE')).toMatchObject({ ok: false });

    // « Non » : RIEN n'est écrit ; les deux événements restent, la séparation est mémorisée.
    expect(await resoudre(compte, carte.public_id, 'KEEP_DISTINCT')).toMatchObject({ ok: true });
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${compte.id} AND merged_into_operation_id IS NULL`).toEqual([{ n: 2 }]);
    expect((await journal(compte)).filter((j) => j.command === 'mergeOperations')).toEqual([]);

    const { mergeRefusedByUser } = await import('@/services/to-process/operation-merge-cards');
    expect(await mergeRefusedByUser(compte.id, a, b)).toBe(true);
    expect(await mergeRefusedByUser(compte.id, b, a)).toBe(true);
    // Isolation de la mémoire : rien pour un autre compte.
    expect(await mergeRefusedByUser(autre.id, a, b)).toBe(false);

    // AC12 : la fusion AUTOMATIQUE de T3 voit cette paire comme non fusionnable (une seule porte).
    const { db } = await import('@/db');
    const { __loadNonMergeableForTests } = await import('@/services/business-operations/consolidation/consolidator');
    const nonFusionnables = await __loadNonMergeableForTests(db as never, compte.id, [a, b]);
    expect([...nonFusionnables]).toEqual([`${Math.min(a, b)}:${Math.max(a, b)}`]);

    // Même preuve rejouée : aucune carte (la décision est durable).
    expect((await proposeReferenceEventMerge(t3(compte), { operationAId: a, operationBId: b, evidence: [doc(rapport)] })).card).toMatchObject({ status: 'ALREADY_ANSWERED' });
    expect((await cartes(compte, 'REFERENCE-EVENT-MERGE')).filter((c) => c.ouverte)).toEqual([]);

    // Deux types métier différents : la fusion est refusée en clair par la façade (jamais une requalification).
    const sinistre = await evenement(compte, 'CLAIM', 'Dégât des eaux');
    expect(await f.mergeOperations(user(compte), { absorbedOperationId: sinistre, canonicalOperationId: a }))
      .toMatchObject({ status: 'FORBIDDEN', code: 'TYPE_MISMATCH' });
    // Une inférence ne fusionne jamais par la façade : elle demande.
    expect(await f.mergeOperations(t3(compte), { absorbedOperationId: b, canonicalOperationId: a })).toMatchObject({ status: 'FORBIDDEN', code: 'USER_ONLY' });
    // Isolation : un identifiant d'un autre compte est « introuvable ».
    expect(await f.mergeOperations(user(autre), { absorbedOperationId: b, canonicalOperationId: a })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_FOUND_IN_ACCOUNT' });
  });

  // ══ 3. « Quel fait est correct ? » ═════════════════════════════════════════

  it('L114U-E05 — fait contradictoire : aucune carte entre deux événements NON associés ; associés, la carte propose les deux valeurs et la réponse est posée par la façade ; version périmée → carte fermée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const sinistre = await evenement(compte, 'CLAIM', 'Tempête de février');
    const reparation = await evenement(compte, 'INTERVENTION', 'Réfection de la toiture');
    await sql`UPDATE business_operations SET realized_date = '2040-03-10' WHERE id = ${sinistre}`;
    await sql`UPDATE business_operations SET realized_date = '2040-03-12' WHERE id = ${reparation}`;
    const f = await facade();
    const constat = await document(compte, 'Constat de sinistre', maison.id);
    expect(await f.linkDocument(user(compte), { operationId: sinistre, fileId: constat })).toMatchObject({ status: 'APPLIED' });

    const { proposeReferenceEventFact } = await pontFusion();
    // Deux événements NON associés : deux dates de nature différente ne se contredisent pas (CDC §11, AC34).
    expect((await proposeReferenceEventFact(t3(compte), { operationAId: sinistre, operationBId: reparation, field: 'realizedDate' })).card)
      .toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NOT_ASSOCIATED' });
    expect(await cartes(compte, 'REFERENCE-EVENT-FACT')).toEqual([]);

    expect(await f.associateOperations(user(compte), { fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR' })).toMatchObject({ status: 'APPLIED' });
    expect((await proposeReferenceEventFact(t3(compte), { operationAId: sinistre, operationBId: reparation, field: 'realizedDate', evidence: [doc(constat)] })).card)
      .toMatchObject({ status: 'POSTED' });
    const [carte, ...trop] = await cartes(compte, 'REFERENCE-EVENT-FACT');
    expect(trop).toEqual([]);
    expect(carte).toMatchObject({ target_type: 'DOCUMENT', target_id: constat, ouverte: true });
    expect(carte.question).not.toMatch(/\bop[ée]ration/i);
    expect((carte.proposals_json as Json[]).map((p) => p.value).sort()).toEqual(['FACT:2040-03-10', 'FACT:2040-03-12']);
    // Aucune valeur n'est écrasée avant la réponse.
    expect(await sql<Json[]>`SELECT id::int AS id, realized_date::text AS d FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`)
      .toEqual([{ id: sinistre, d: '2040-03-10' }, { id: reparation, d: '2040-03-12' }].sort((x, y) => x.id - y.id));

    // Réponse : la valeur retenue est posée par la façade sur celui qui ne la portait pas.
    expect(await resoudre(compte, carte.public_id, 'FACT:2040-03-12')).toMatchObject({ ok: true, undoable: false });
    expect(await sql<Json[]>`SELECT id::int AS id, realized_date::text AS d FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`)
      .toEqual([{ id: sinistre, d: '2040-03-12' }, { id: reparation, d: '2040-03-12' }].sort((x, y) => x.id - y.id));
    expect((await journal(compte)).filter((j) => j.command === 'correctOperation'))
      .toMatchObject([{ origin: 'USER', channel: 'TO_PROCESS', u: compte.ownerUserId }]);
    // Plus de contradiction : la question ne revient pas.
    expect((await proposeReferenceEventFact(t3(compte), { operationAId: sinistre, operationBId: reparation, field: 'realizedDate' })).card)
      .toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_CONTRADICTION' });

    // Carte PÉRIMÉE (AC18) : la valeur de l'un des deux change entre la question et la réponse.
    await sql`UPDATE business_operations SET realized_date = '2040-04-01' WHERE id = ${reparation}`;
    expect((await proposeReferenceEventFact(t3(compte), { operationAId: sinistre, operationBId: reparation, field: 'realizedDate', evidence: [doc(constat)] })).card)
      .toMatchObject({ status: 'POSTED' });
    const perimee = (await cartes(compte, 'REFERENCE-EVENT-FACT')).filter((c) => c.ouverte)[0];
    await sql`UPDATE business_operations SET version = version + 1 WHERE id = ${reparation}`;
    expect(await resoudre(compte, perimee.public_id, 'FACT:2040-03-12')).toMatchObject({ ok: false });
    expect((await cartes(compte, 'REFERENCE-EVENT-FACT')).find((c) => c.public_id === perimee.public_id)).toMatchObject({ ouverte: false, resolution_reason: 'OBSOLETE' });
    // Rien n'a été réécrit par une carte périmée.
    expect(await sql<Json[]>`SELECT realized_date::text AS d FROM business_operations WHERE id = ${reparation}`).toEqual([{ d: '2040-04-01' }]);
  });
  // ══ 4. Lot 115 (#791, décision du PO du 16/11/2026) : le PRESTATAIRE ═══════

  it('L115F-E05 — prestataire contradictoire entre deux événements ASSOCIÉS : la question est posée comme pour les dates, jamais sur des désignations équivalentes ni sur des rôles de partie différents, et la réponse est écrite et protégée (#791)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const sinistre = await evenement(compte, 'CLAIM', 'Dégât des eaux');
    const reparation = await evenement(compte, 'INTERVENTION', 'Réfection de la salle de bains');
    const f = await facade();
    const factureA = await document(compte, 'Facture de plomberie', maison.id);
    const factureB = await document(compte, 'Facture de carrelage', maison.id);
    expect(await f.linkDocument(user(compte), { operationId: sinistre, fileId: factureA })).toMatchObject({ status: 'APPLIED' });
    expect(await f.linkDocument(user(compte), { operationId: reparation, fileId: factureB })).toMatchObject({ status: 'APPLIED' });

    /**
     * Prestataire en place de chaque côté, AVEC sa provenance : la source documentaire qui le justifie et son
     * rôle. C'est elle qui donne le rôle sémantique de la PARTIE (référentiel `semanticRoleOf`).
     */
    const poser = async (opId: number, fileId: number, provider: string, role = 'INVOICE') => {
      let [src] = await sql<Json[]>`
        SELECT id FROM business_operation_sources
         WHERE operation_id = ${opId} AND active AND source_kind = 'DOCUMENT' AND source_entity_key = ${String(fileId)} ORDER BY id LIMIT 1`;
      if (!src) {
        const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
        const id = await withBusinessOperationWrite(compte.id, async (repo) => repo.addSource(opId, {
          kind: 'DOCUMENT', entityKey: fileId, authority: 'DOCUMENT', confidence: 'certain', locator: {},
        }, 'L115F_E2E_PROVIDER'));
        src = { id };
      }
      await sql`UPDATE business_operation_sources SET source_role = ${role} WHERE id = ${src.id}`;
      await sql`
        UPDATE business_operations
           SET provider = ${provider},
               attribute_provenance = jsonb_build_object('provider', jsonb_build_object('sourceId', ${src.id}::bigint, 'value', ${provider}::text))
         WHERE id = ${opId}`;
      return Number(src.id);
    };
    await poser(sinistre, factureA, 'Plomberie Durand');
    await poser(reparation, factureB, 'Plomberie Durand SAS');

    const { proposeReferenceEventFact } = await pontFusion();
    const { factContradictionCandidates } = await import('@/services/to-process/operation-merge-cards');

    // (a) NON associés : la question n'a pas de sens (comme pour les dates).
    expect((await proposeReferenceEventFact(t3(compte), { operationAId: sinistre, operationBId: reparation, field: 'provider' })).card)
      .toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NOT_ASSOCIATED' });
    expect(await f.associateOperations(user(compte), { fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR' })).toMatchObject({ status: 'APPLIED' });

    // (b) Deux DÉSIGNATIONS ÉQUIVALENTES du même tiers : jamais une contradiction (aucune table d'enseignes).
    expect((await proposeReferenceEventFact(t3(compte), { operationAId: sinistre, operationBId: reparation, field: 'provider' })).card)
      .toMatchObject({ status: 'NOT_APPLICABLE', reason: 'EQUIVALENT_PROVIDER_DESIGNATIONS' });
    expect(await factContradictionCandidates(compte.id)).toEqual([]);

    // (c) Deux tiers différents, mais des RÔLES DE PARTIE différents (une banque de preuve de paiement face au
    //     fournisseur d'une facture) : ce n'est pas le même fait, donc aucune question.
    await poser(reparation, factureB, 'Banque de l’Ouest', 'PAYMENT_PROOF');
    expect((await proposeReferenceEventFact(t3(compte), { operationAId: sinistre, operationBId: reparation, field: 'provider' })).card)
      .toMatchObject({ status: 'NOT_APPLICABLE', reason: 'PROVIDER_ROLES_NOT_COMPARABLE' });
    expect(await factContradictionCandidates(compte.id)).toEqual([]);
    expect(await cartes(compte, 'REFERENCE-EVENT-FACT')).toEqual([]);

    // (d) MÊME rôle de partie, deux tiers réellement différents : la question est posée.
    await poser(reparation, factureB, 'Carrelages Bêta');
    expect(await factContradictionCandidates(compte.id)).toEqual([
      { operationAId: Math.min(sinistre, reparation), operationBId: Math.max(sinistre, reparation), field: 'provider' },
    ]);
    expect((await proposeReferenceEventFact(t3(compte), { operationAId: sinistre, operationBId: reparation, field: 'provider', evidence: [doc(factureA)] })).card)
      .toMatchObject({ status: 'POSTED' });
    const [carte, ...trop] = (await cartes(compte, 'REFERENCE-EVENT-FACT')).filter((c) => c.ouverte);
    expect(trop).toEqual([]);
    expect(carte.relation_key).toBe(`referenceEventFact:${Math.min(sinistre, reparation)}:${Math.max(sinistre, reparation)}:provider`);
    expect(carte.question).toBe('« Sinistre — Dégât des eaux » et « Intervention — Réfection de la salle de bains » '
      + 'indiquent des prestataires différents : lequel est le bon ?');
    expect(carte.question).not.toMatch(/\bop[ée]ration/i);
    expect((carte.proposals_json as Json[]).map((p) => p.value).sort()).toEqual(['FACT:Carrelages Bêta', 'FACT:Plomberie Durand']);
    // Aucune valeur n'est écrasée avant la réponse, et la file l'affiche (sujet de la mascotte compris).
    expect(await sql<Json[]>`SELECT provider FROM business_operations WHERE id = ${sinistre}`).toEqual([{ provider: 'Plomberie Durand' }]);
    const vue = (await file(compte)).find((a) => a.publicId === carte.public_id)!;
    expect(vue.proposals).toHaveLength(2);
    const { todoTitle } = await import('@/services/home/mascot/todo-items');
    expect(todoTitle('REFERENCE-EVENT-FACT', 'ARBITRATE', carte.relation_key as string)).toBe('Prestataire à confirmer');

    // (e) Réponse : la valeur retenue est écrite par la FAÇADE sur celui qui ne la portait pas, et PROTÉGÉE.
    expect(await resoudre(compte, carte.public_id, 'FACT:Carrelages Bêta')).toMatchObject({ ok: true, undoable: false });
    expect(await sql<Json[]>`SELECT id::int AS id, provider FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`)
      .toEqual([{ id: sinistre, provider: 'Carrelages Bêta' }, { id: reparation, provider: 'Carrelages Bêta' }].sort((x, y) => x.id - y.id));
    expect((await journal(compte)).filter((j) => j.command === 'updateOperation'))
      .toMatchObject([{ origin: 'USER', channel: 'TO_PROCESS', u: compte.ownerUserId }]);
    // La déclaration posée est TECHNIQUE : elle protège la valeur, et la fiche ne la montre pas.
    const { CARD_FACT_ARBITRATION_DECLARATION_TEXT, PAGE_TECHNICAL_DECLARATION_TEXTS } = await import('@/services/business-operations/graph/reference-event-page');
    expect(PAGE_TECHNICAL_DECLARATION_TEXTS.has(CARD_FACT_ARBITRATION_DECLARATION_TEXT)).toBe(true);
    expect(await sql<Json[]>`
      SELECT 1 FROM business_operation_sources s
        JOIN business_operation_declarations d ON d.id = s.source_entity_key::bigint
       WHERE s.operation_id = ${sinistre} AND s.active AND s.source_kind = 'USER_DECLARATION' AND s.authority = 'USER'
         AND d.declaration_text = ${CARD_FACT_ARBITRATION_DECLARATION_TEXT}`).toHaveLength(1);

    // (f) La question ne revient pas, et le détecteur ne la redonne plus.
    expect((await proposeReferenceEventFact(t3(compte), { operationAId: sinistre, operationBId: reparation, field: 'provider' })).card)
      .toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_CONTRADICTION' });
    expect(await factContradictionCandidates(compte.id)).toEqual([]);
    expect((await cartes(compte, 'REFERENCE-EVENT-FACT')).filter((c) => c.ouverte)).toEqual([]);
  });
});
