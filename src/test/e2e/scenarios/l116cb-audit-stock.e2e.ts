/**
 * Lot 116C, seconde partie (carte Trello #806 — migration et audit du stock ;
 * CDC « Opérations / Agenda V2.0 » §22, AC61 à AC66, AC73) — sur PostgreSQL 16
 * réel : l'audit du stock (`migration-744/stock-audit.ts`) sur un jeu qui
 * contient CHAQUE anomalie, injectée comme le stock ancien les a laissées
 * (hors de la façade). Aucune IA.
 *
 *   L116CB-M01  SIMULATION : chaque anomalie est constatée, avec son devenir (correction certaine, arbitrage, constat) ;
 *               les écarts du graphe sont ceux du contrôle `COH-OPERATION-GRAPH` ; RIEN n'est écrit (empreinte du compte
 *               identique, volumétrie avant = après) ; rapport anonymisé (aucun titre, aucun nom)
 *   L116CB-M02  APPLICATION : seul le cas certain est corrigé (lien du graphe manquant posé, journalisé) ; un événement
 *               retiré par l'utilisateur n'est jamais rattaché de nouveau ; aucune autre anomalie n'est « réparée » ;
 *               aucun justificatif, lien direct, événement, opération ni relation supprimé ; l'événement redevient visible
 *               sous son opération ; rejoué : rien (idempotent)
 *   L116CB-M03  COMPTES ISOLÉS et REPRISE : traiter un compte ne touche pas l'autre ; la série reprise à partir d'un
 *               compte ne traite que la suite ; la synthèse ne contient que des codes et des nombres
 *   L116CB-M04  LE SCRIPT lui-même (`scripts/audit-806-stock-operations.ts`), lancé comme en exploitation : sans
 *               `--apply` il n'écrit rien en base et produit le rapport ; avec `--apply` il pose le lien ; sans compte
 *               désigné il refuse
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const audit = () => import('@/services/business-operations/migration-744/stock-audit');
const facade = () => import('@/services/business-operations/operation-write.facade');
const SECRET = 'TITRE-CONFIDENTIEL-ZQX';

scenario('L116CB-M', 'Carte #806 — audit du stock : simulation, correction du seul cas certain, idempotence, isolation des comptes', ({ sql, make }) => {
  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });

  async function operation(compte: AccountRow, type: string | null, over: { realized?: string; status?: string; label?: string; source?: Json } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: (type ? { code: type } : null) as never, status: (over.status ?? 'REALIZED') as never, realizedDate: over.realized ?? null,
      technicalLabel: over.label ?? `${SECRET} opération`,
      source: (over.source ?? { kind: 'MIGRATION', entityKey: `l116cb-m-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' }) as never,
      reasonCode: 'L116CB_M_E2E',
    })).id);
  }
  const element = async (compte: AccountRow, date: string | null, assetIds: number[] = []): Promise<number> =>
    (await make.agendaItem(compte, { title: `${SECRET} événement`, ...(date ? { startDate: date } : {}), assetIds })).id;
  async function lier(compte: AccountRow, operationId: number, agendaItemId: number): Promise<void> {
    expect(await (await facade()).linkAgendaItem(user(compte), { operationId, agendaItemId })).toMatchObject({ status: 'APPLIED' });
  }
  /** Rattachement par la COLONNE HISTORIQUE (comme le stock d'avant le graphe) ; le déclencheur de compatibilité pose le lien du graphe. */
  async function rattacherAncien(compte: AccountRow, operationId: number, agendaItemId: number): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('verebona.grouping_write', 'on', true)`;
      await tx`UPDATE agenda_items SET business_operation_id = ${operationId} WHERE id = ${agendaItemId} AND account_id = ${compte.id}`;
    });
  }
  /** Empreinte de TOUT ce que l'audit pourrait toucher dans un compte. */
  async function empreinte(compte: AccountRow): Promise<string> {
    const tables = ['business_operations', 'business_operation_relations', 'business_operation_agenda_links', 'business_operation_sources',
      'business_operation_documents', 'business_operation_graph_history', 'business_operation_match_decisions', 'agenda_items', 'asset_files',
      'to_process_actions', 'notification_outbox'];
    const morceaux: string[] = [];
    for (const t of tables) {
      const [r] = await sql.unsafe(`SELECT COALESCE(md5(string_agg(x::text, '|' ORDER BY x.id)), '') AS h, count(*)::int AS n FROM ${t} x WHERE x.account_id = $1`, [compte.id]);
      morceaux.push(`${t}:${r.n}:${r.h}`);
    }
    const [l] = await sql`SELECT COALESCE(md5(string_agg(l::text, '|' ORDER BY l.id)), '') AS h, count(*)::int AS n
                            FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${compte.id}`;
    morceaux.push(`agenda_file_links:${l.n}:${l.h}`);
    return morceaux.join('#');
  }
  const liensGraphe = (compte: AccountRow, itemId: number) => sql<Json[]>`
    SELECT operation_id::int AS op, state, origin, legacy_column, reason_code FROM business_operation_agenda_links
     WHERE account_id = ${compte.id} AND agenda_item_id = ${itemId} ORDER BY id`;
  const parCode = (r: { anomalies: Array<{ code: string; count: number; sample: number[]; disposition: string }> }) =>
    Object.fromEntries(r.anomalies.map((a) => [a.code, a]));

  /** Un compte qui porte CHAQUE anomalie du stock ancien. */
  async function stockAncien() {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: `${SECRET} maison` });
    const fichier = async () => (await make.assetFile(compte, { assetId: bien.id, name: `${SECRET}-${Math.random().toString(36).slice(2)}.pdf` })).id;
    const lienBien = (op: number) => sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, authority, active) VALUES (${compte.id}, ${op}, ${bien.id}, 'USER', true)`;
    const fusionnerDeForce = (absorbee: number, conservee: number) => sql`
      UPDATE business_operations SET merged_into_operation_id = ${conservee}, invalidated_at = now(), invalidation_reason = 'MERGED' WHERE id = ${absorbee} AND account_id = ${compte.id}`;

    // 1. Opération née d'un simple lien document ↔ événement (comportement d'avant #806).
    const eLien = await element(compte, '2022-01-10', [bien.id]);
    const nee = await operation(compte, null, { status: 'ENVISAGED', source: { kind: 'AGENDA', entityKey: eLien, authority: 'USER', locator: { grouping: 'USER_DOCUMENT_LINK' } } });
    // 2. Deux opérations fusionnées par l'ancien geste d'association de deux événements.
    const absorbee = await operation(compte, null, { status: 'ENVISAGED' });
    const conservee = await operation(compte, null, { status: 'ENVISAGED' });
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(compte.id, async (repo) => { await repo.mergeOperations(absorbee, conservee, 'USER_AGENDA_LINK'); });
    // 3. Contrat et sinistre fusionnés ; financement et acquisition fusionnés (stock ancien : la garde de types le refuse aujourd'hui).
    const contrat = await operation(compte, 'CONTRACT');
    const sinistreFusionne = await operation(compte, 'CLAIM', { realized: '2021-02-02' });
    await fusionnerDeForce(sinistreFusionne, contrat);
    await sql`INSERT INTO business_operation_claim_details (operation_id) VALUES (${contrat})`;
    const achat = await operation(compte, 'ACQUISITION', { realized: '2019-05-05' });
    const pretFusionne = await operation(compte, 'FINANCING');
    await fusionnerDeForce(pretFusionne, achat);
    // 4. Liens directs : sans justification, vers un justificatif supprimé, propagé sans opération.
    const eDirect = await element(compte, '2020-03-03', [bien.id]);
    const fSans = await fichier();
    const fSupprime = await fichier();
    const fPropage = await fichier();
    const [lSans] = await sql<{ id: number }[]>`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${eDirect}, ${fSans}, '{}') RETURNING id`;
    const [lSupprime] = await sql<{ id: number }[]>`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${eDirect}, ${fSupprime}, ARRAY['MANUAL_DIRECT']) RETURNING id`;
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${fSupprime}`;
    const [lPropage] = await sql<{ id: number }[]>`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id, provenances) VALUES (${eDirect}, ${fPropage}, ARRAY['OPERATION_PRINCIPAL']) RETURNING id`;
    // 5. Relations manquantes : sinistre relié à son contrat par le seul lien du formulaire ; prêt et achat du même bien sans relation.
    const contrat2 = await operation(compte, 'CONTRACT');
    const sinistre2 = await operation(compte, 'CLAIM', { realized: '2023-06-06' });
    await sql`INSERT INTO business_operation_claim_details (operation_id, insurance_contract_operation_id) VALUES (${sinistre2}, ${contrat2})`;
    const pret = await operation(compte, 'FINANCING');
    const achat2 = await operation(compte, 'ACQUISITION', { realized: '2018-08-08' });
    await lienBien(pret);
    await lienBien(achat2);
    // 6. Dates : événement porteur du fait daté autrement que l'opération ; événement automatique présumé propagé.
    const divergente = await operation(compte, 'INTERVENTION', { realized: '2024-03-10' });
    const ePorteurDivergent = await element(compte, '2024-03-12', [bien.id]);
    await lier(compte, divergente, ePorteurDivergent);
    await sql`UPDATE business_operation_agenda_links SET fact_key = 'INTERVENTION' WHERE account_id = ${compte.id} AND operation_id = ${divergente} AND agenda_item_id = ${ePorteurDivergent}`;
    const propagee = await operation(compte, 'INTERVENTION', { realized: '2023-05-05' });
    const ePorteur = await element(compte, '2023-05-05', [bien.id]);
    const ePropage = await element(compte, '2023-05-05', [bien.id]);
    await lier(compte, propagee, ePorteur);
    await lier(compte, propagee, ePropage);
    await sql`UPDATE business_operation_agenda_links SET fact_key = 'INTERVENTION' WHERE account_id = ${compte.id} AND operation_id = ${propagee} AND agenda_item_id = ${ePorteur}`;
    await sql`UPDATE agenda_items SET is_automatic = true, is_automatic_modified = false WHERE id = ${ePropage}`;
    const [lDivergent] = await sql<{ id: number }[]>`SELECT id::int AS id FROM business_operation_agenda_links WHERE operation_id = ${divergente} AND agenda_item_id = ${ePorteurDivergent}`;
    const [lPropageDate] = await sql<{ id: number }[]>`SELECT id::int AS id FROM business_operation_agenda_links WHERE operation_id = ${propagee} AND agenda_item_id = ${ePropage}`;
    // 7. Colonne historique : lien du graphe PERDU (restaurable) ; lien RETIRÉ par l'utilisateur (jamais rétabli) ; ancien rôle encore stocké.
    const ancienne = await operation(compte, 'INTERVENTION', { realized: '2017-07-07' });
    const ePerdu = await element(compte, '2017-07-07', [bien.id]);
    const eRetire = await element(compte, '2017-07-08', [bien.id]);
    await rattacherAncien(compte, ancienne, ePerdu);
    await rattacherAncien(compte, ancienne, eRetire);
    await sql`DELETE FROM business_operation_agenda_links WHERE account_id = ${compte.id} AND operation_id = ${ancienne} AND agenda_item_id = ${ePerdu}`;
    await sql`UPDATE business_operation_agenda_links SET state = 'REMOVED', legacy_column = false, origin = 'USER', ended_at = now(), reason_code = 'USER_UNLINK'
               WHERE account_id = ${compte.id} AND operation_id = ${ancienne} AND agenda_item_id = ${eRetire}`;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('verebona.grouping_write', 'on', true)`;
      await tx`UPDATE agenda_items SET operation_role = 'PRINCIPAL' WHERE id = ${ePerdu}`;
    });
    // 8. Écart du GRAPHE (contrôle existant) : relation posée par un traitement sans preuve.
    await sql`INSERT INTO business_operation_relations (account_id, from_operation_id, to_operation_id, nature, state, origin, reason_code, evidence)
              VALUES (${compte.id}, ${divergente}, ${propagee}, 'ASSOCIATED', 'ACTIVE', 'AI', 'L116CB_M_E2E', '[]'::jsonb)`;
    return {
      compte, bien, nee, absorbee, conservee, contrat, sinistreFusionne, achat, pretFusionne, lSans: lSans.id, lSupprime: lSupprime.id, lPropage: lPropage.id,
      sinistre2, contrat2, pret, achat2, lDivergent: lDivergent.id, lPropageDate: lPropageDate.id, ancienne, ePerdu, eRetire, eDirect,
    };
  }

  it('L116CB-M01 — simulation : chaque anomalie constatée avec son devenir ; rien n’est écrit ; rapport anonymisé', async () => {
    const d = await stockAncien();
    const avant = await empreinte(d.compte);
    const { auditAccountStock, STOCK_ANOMALY_CODES } = await audit();
    const r = await auditAccountStock(d.compte.id);

    expect(r.mode).toBe('SIMULATION');
    const a = parCode(r);
    expect(Object.keys(a).sort()).toEqual([...STOCK_ANOMALY_CODES].sort());
    const attendu: Record<string, [number[], string]> = {
      OPERATION_CREATED_BY_SIMPLE_LINK: [[d.nee], 'ARBITRATION'],
      OPERATIONS_MERGED_BY_SIMPLE_LINK: [[d.absorbee], 'ARBITRATION'],
      INSURANCE_CLAIM_MERGED: [[d.sinistreFusionne], 'ARBITRATION'],
      FINANCING_ACQUISITION_MERGED: [[d.pretFusionne], 'ARBITRATION'],
      CLAIM_DETAILS_ON_NON_CLAIM: [[d.contrat], 'ARBITRATION'],
      DIRECT_LINK_WITHOUT_PROVENANCE: [[d.lSans], 'REPORT'],
      DIRECT_LINK_TARGET_UNAVAILABLE: [[d.lSupprime], 'REPORT'],
      DIRECT_LINK_PROPAGATED_WITHOUT_OPERATION: [[d.lPropage], 'REPORT'],
      CLAIM_CONTRACT_WITHOUT_RELATION: [[d.sinistre2], 'REPORT'],
      FINANCING_ACQUISITION_WITHOUT_RELATION: [[d.pret], 'ARBITRATION'],
      FACT_DATE_DIVERGENT: [[d.lDivergent], 'ARBITRATION'],
      DATE_PRESUMED_PROPAGATED: [[d.lPropageDate], 'REPORT'],
      LEGACY_LINK_RESTORABLE: [[d.ePerdu], 'CERTAIN_FIX'],
      LEGACY_LINK_BLOCKED_BY_DECISION: [[d.eRetire], 'ARBITRATION'],
      RELATION_PAIR_DUPLICATED: [[], 'REPORT'],
    };
    for (const [code, [ids, devenir]] of Object.entries(attendu)) {
      expect(a[code].sample, code).toEqual(ids);
      expect(a[code].count, code).toBe(ids.length);
      expect(a[code].disposition, code).toBe(devenir);
    }
    // Ancien rôle « principal » encore stocké : un NOMBRE (mesure de l'inventaire existant), sans identifiant.
    expect(a.LEGACY_ROLE_STILL_STORED).toMatchObject({ count: 1, sample: [], disposition: 'REPORT' });
    expect(r.fixes).toEqual({ legacyLinksToRestore: 1, legacyLinksRestored: 0 });
    expect(r.arbitration).toBe(8);

    // Les écarts du graphe sont CEUX du contrôle existant (même fonction, même résultat) — aucun second mécanisme.
    const { auditOperationGraph } = await import('@/services/business-operations/graph/store');
    const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
    expect(r.graphFindings).toEqual(await auditOperationGraph(postgresRunner(sql as never), d.compte.id));
    const graphe = Object.fromEntries(r.graphFindings.map((f) => [f.code, f.count]));
    expect(graphe.LEGACY_LINK_MISSING).toBe(2);
    expect(graphe.RELATION_INFERRED_WITHOUT_EVIDENCE).toBe(1);

    // RIEN n'est écrit par la simulation.
    expect(await empreinte(d.compte)).toBe(avant);
    expect(r.volumetryAfter).toEqual(r.volumetryBefore);
    expect(r.volumetryBefore).toMatchObject({ liens_directs: 3, operations: 14, relations: 1 });
    expect(r.volumetryBefore.evenements_colonne_historique).toBeGreaterThanOrEqual(2);
    // Rejouée : même rapport (stable).
    expect(await auditAccountStock(d.compte.id)).toEqual(r);

    // Rapport ANONYMISÉ : des codes, des nombres, des identifiants — aucun titre, aucun nom de bien ni de fichier.
    const texte = JSON.stringify(r);
    expect(texte).not.toContain(SECRET);
    expect(texte).not.toMatch(/\.pdf/);
  });

  it('L116CB-M02 — application : seul le cas certain est corrigé, journalisé ; rien n’est supprimé ; idempotent', async () => {
    const d = await stockAncien();
    const { auditAccountStock, STOCK_AUDIT_FIX_REASON } = await audit();
    const simulation = await auditAccountStock(d.compte.id);
    const { readAgendaItemsReferenceEvents } = await import('@/services/business-operations/graph/read');
    // Avant : l'événement dont le lien est perdu n'est plus vu sous son opération par les écrans récents.
    expect((await readAgendaItemsReferenceEvents(d.compte.id, [d.ePerdu])).size).toBe(0);

    const r = await auditAccountStock(d.compte.id, { apply: true });
    expect(r.mode).toBe('APPLIED');
    expect(r.fixes).toEqual({ legacyLinksToRestore: 1, legacyLinksRestored: 1 });
    // Le lien manquant est posé (origine « reprise », marqué « colonne historique ») et journalisé.
    expect(await liensGraphe(d.compte, d.ePerdu)).toEqual([{ op: d.ancienne, state: 'ACTIVE', origin: 'MIGRATION', legacy_column: true, reason_code: STOCK_AUDIT_FIX_REASON }]);
    const journal = await sql<Json[]>`SELECT relation_kind, action, origin, channel, reason_code, operation_id::int AS op, agenda_item_id::int AS item
                                        FROM business_operation_graph_history WHERE account_id = ${d.compte.id} AND reason_code = ${STOCK_AUDIT_FIX_REASON}`;
    expect(journal).toEqual([{ relation_kind: 'AGENDA_LINK', action: 'CREATED', origin: 'MIGRATION', channel: 'STOCK_AUDIT', reason_code: STOCK_AUDIT_FIX_REASON, op: d.ancienne, item: d.ePerdu }]);
    // L'événement redevient visible sous son opération (même lecture que l'Agenda, le tiroir et la Timeline).
    expect(((await readAgendaItemsReferenceEvents(d.compte.id, [d.ePerdu])).get(d.ePerdu) ?? []).map((e) => e.operationId)).toEqual([d.ancienne]);
    // L'événement RETIRÉ par l'utilisateur n'est jamais rattaché de nouveau.
    expect(await liensGraphe(d.compte, d.eRetire)).toMatchObject([{ op: d.ancienne, state: 'REMOVED', origin: 'USER' }]);
    expect((await readAgendaItemsReferenceEvents(d.compte.id, [d.eRetire])).size).toBe(0);

    // AUCUNE autre anomalie n'est « réparée » : mêmes constats qu'en simulation, sauf le lien posé.
    const apres = parCode(r);
    const avant = parCode(simulation);
    for (const code of Object.keys(avant)) {
      if (code === 'LEGACY_LINK_RESTORABLE') expect(apres[code].count).toBe(0);
      else expect(apres[code], code).toEqual(avant[code]);
    }
    expect(Object.fromEntries(r.graphFindings.map((f) => [f.code, f.count])).LEGACY_LINK_MISSING).toBe(1);
    // RIEN n'est supprimé : justificatifs, liens directs, événements, opérations, relations, refus — volumétrie avant / après.
    const v0 = r.volumetryBefore;
    const v1 = r.volumetryAfter;
    for (const k of ['operations', 'operations_actives', 'relations', 'relations_actives', 'evenements', 'evenements_colonne_historique', 'liens_directs', 'justificatifs',
      'justificatifs_operation', 'refus_utilisateur', 'rappels', 'cartes_ouvertes']) expect(v1[k], k).toBe(v0[k]);
    expect(v1.liens_agenda).toBe(v0.liens_agenda + 1);
    expect(v1.liens_agenda_actifs).toBe(v0.liens_agenda_actifs + 1);
    // Les trois liens directs anormaux sont toujours là (constatés, jamais retirés), le fichier supprimé aussi.
    expect((await sql`SELECT id FROM agenda_file_links WHERE id IN (${d.lSans}, ${d.lSupprime}, ${d.lPropage})`).length).toBe(3);
    // Aucune date, aucun titre, aucun rôle d'événement n'a été touché.
    const [ev] = await sql<Json[]>`SELECT start_date::text AS d, operation_role, business_operation_id::int AS op FROM agenda_items WHERE id = ${d.ePerdu}`;
    expect(ev).toEqual({ d: '2017-07-07', operation_role: 'PRINCIPAL', op: d.ancienne });

    // IDEMPOTENT : un second passage n'écrit rien.
    const empreinteApres = await empreinte(d.compte);
    const second = await auditAccountStock(d.compte.id, { apply: true });
    expect(second.fixes).toEqual({ legacyLinksToRestore: 0, legacyLinksRestored: 0 });
    expect(second.volumetryAfter).toEqual(second.volumetryBefore);
    expect(await empreinte(d.compte)).toBe(empreinteApres);
    expect(second.anomalies).toEqual(r.anomalies);
  });

  it('L116CB-M03 — comptes isolés et reprise : un compte traité ne touche pas l’autre ; la série reprend à partir d’un compte ; synthèse en nombres', async () => {
    const a = await stockAncien();
    const b = await stockAncien();
    const sain = await make.account({ plan: 'premium' });
    await operation(sain, 'INTERVENTION', { realized: '2020-01-01' });
    const { auditAccountStock, auditStock, stockAuditAccounts } = await audit();
    const empreinteB = await empreinte(b.compte);
    const empreinteSain = await empreinte(sain);

    // Traiter A ne lit ni n'écrit rien de B : B garde son lien perdu, son empreinte est intacte.
    const ra = await auditAccountStock(a.compte.id, { apply: true });
    expect(ra.fixes.legacyLinksRestored).toBe(1);
    expect(await empreinte(b.compte)).toBe(empreinteB);
    expect(await liensGraphe(b.compte, b.ePerdu)).toEqual([]);
    // Aucun identifiant de B dans le rapport de A (échantillons propres au compte).
    const idsDeB = new Set([b.nee, b.absorbee, b.sinistreFusionne, b.pretFusionne, b.contrat, b.sinistre2, b.pret]);
    for (const x of ra.anomalies.filter((y) => ['OPERATION'].includes((y as Json).object))) for (const id of x.sample) expect(idsDeB.has(id)).toBe(false);

    // Comptes à auditer : ordre stable ; reprise à partir d'un compte (passage interrompu).
    const tous = await stockAuditAccounts();
    expect(tous).toEqual([...tous].sort((x, y) => x - y));
    for (const c of [a.compte.id, b.compte.id, sain.id]) expect(tous).toContain(c);
    const suite = await stockAuditAccounts(b.compte.id);
    expect(suite).toContain(b.compte.id);
    expect(suite).not.toContain(a.compte.id);

    // Série reprise sur la suite seulement : B est corrigé, le compte sain reste sain et intact, A n'est pas retraité.
    const vus: number[] = [];
    const serie = await auditStock(suite.filter((c) => [b.compte.id, sain.id].includes(c)), { apply: true, onReport: (r) => { vus.push(r.accountId); } });
    expect(vus).toEqual([b.compte.id, sain.id].sort((x, y) => x - y));
    expect(serie.failed).toEqual([]);
    expect(serie.summary).toMatchObject({ mode: 'APPLIED', accounts: 2, accountsWithAnomalies: 1, failedAccounts: [], legacyLinksToRestore: 1, legacyLinksRestored: 1 });
    expect(await liensGraphe(b.compte, b.ePerdu)).toMatchObject([{ op: b.ancienne, state: 'ACTIVE', origin: 'MIGRATION' }]);
    expect(await empreinte(sain)).toBe(empreinteSain);
    const rapportSain = serie.reports.find((r) => r.accountId === sain.id)!;
    expect(rapportSain.anomalies.every((x) => x.count === 0)).toBe(true);
    expect(rapportSain.graphFindings).toEqual([]);
    // Série complète rejouée en SIMULATION : plus rien à corriger nulle part, rien d'écrit.
    const empreintes = [await empreinte(a.compte), await empreinte(b.compte), await empreinte(sain)];
    const relue = await auditStock([a.compte.id, b.compte.id, sain.id]);
    expect(relue.summary).toMatchObject({ mode: 'SIMULATION', accounts: 3, legacyLinksToRestore: 0, legacyLinksRestored: 0 });
    expect([await empreinte(a.compte), await empreinte(b.compte), await empreinte(sain)]).toEqual(empreintes);
    // Synthèse anonymisée : des codes et des nombres seulement.
    const texte = JSON.stringify(relue);
    expect(texte).not.toContain(SECRET);
    expect(Object.values(relue.summary.totals).every((v) => typeof v === 'number')).toBe(true);
    expect(relue.summary.totals.FACT_DATE_DIVERGENT).toBe(2);
    // Un compte inexistant ou invalide : aucune écriture, jamais un autre compte à sa place.
    await expect(auditAccountStock(0)).rejects.toThrow('INVALID_ACCOUNT_ID');
    const inconnu = await auditAccountStock(2_000_000_000, { apply: true });
    expect(inconnu.anomalies.every((x) => x.count === 0)).toBe(true);
    expect(inconnu.fixes).toEqual({ legacyLinksToRestore: 0, legacyLinksRestored: 0 });
  });

  it('L116CB-M04 — le script d’exploitation : simulation sans écriture, application, refus sans compte désigné', async () => {
    const d = await stockAncien();
    const dossier = await mkdtemp(join(tmpdir(), 'l116cb-audit-'));
    const racine = resolve(__dirname, '..', '..', '..', '..');
    const lancer = async (args: string[]) => {
      try {
        const r = await promisify(execFile)('npx', ['tsx', 'scripts/audit-806-stock-operations.ts', ...args], { cwd: racine, env: process.env, timeout: 120_000 });
        return { code: 0, sortie: `${r.stdout}${r.stderr}` };
      } catch (e) {
        const x = e as { code?: number; stdout?: string; stderr?: string };
        return { code: typeof x.code === 'number' ? x.code : 1, sortie: `${x.stdout ?? ''}${x.stderr ?? ''}` };
      }
    };
    const avant = await empreinte(d.compte);

    // Sans compte désigné : refus, rien n'est lu ni écrit.
    const refus = await lancer([]);
    expect(refus.code).toBe(2);
    expect(refus.sortie).toContain('Usage');

    // SIMULATION (défaut) : le rapport est produit, la base est intacte.
    const rapportSimulation = join(dossier, 'simulation.json');
    const sim = await lancer([`--account=${d.compte.id}`, `--report=${rapportSimulation}`]);
    expect(sim.code, sim.sortie).toBe(0);
    expect(sim.sortie).toContain('(simulation)');
    expect(await empreinte(d.compte)).toBe(avant);
    const lu = JSON.parse(await readFile(rapportSimulation, 'utf8')) as Json;
    expect(lu.summary).toMatchObject({ mode: 'SIMULATION', accounts: 1, legacyLinksToRestore: 1, legacyLinksRestored: 0 });
    expect(lu.reports).toHaveLength(1);
    expect(JSON.stringify(lu)).not.toContain(SECRET);
    // Une ligne par compte écrite au fil de l'eau (reprise après interruption).
    expect((await readFile(`${rapportSimulation}.ndjson`, 'utf8')).trim().split('\n')).toHaveLength(1);

    // APPLICATION : le lien manquant est posé ; rejoué, plus rien.
    const rapportApplication = join(dossier, 'application.json');
    const app = await lancer([`--account=${d.compte.id}`, '--apply', `--report=${rapportApplication}`]);
    expect(app.code, app.sortie).toBe(0);
    expect((JSON.parse(await readFile(rapportApplication, 'utf8')) as Json).summary).toMatchObject({ mode: 'APPLIED', legacyLinksRestored: 1 });
    expect(await liensGraphe(d.compte, d.ePerdu)).toMatchObject([{ op: d.ancienne, state: 'ACTIVE', origin: 'MIGRATION' }]);
    const apres = await empreinte(d.compte);
    const encore = await lancer([`--account=${d.compte.id}`, '--apply', `--report=${rapportApplication}`]);
    expect(encore.code, encore.sortie).toBe(0);
    expect((JSON.parse(await readFile(rapportApplication, 'utf8')) as Json).summary).toMatchObject({ legacyLinksToRestore: 0, legacyLinksRestored: 0 });
    expect(await empreinte(d.compte)).toBe(apres);
  }, 400_000);
});
