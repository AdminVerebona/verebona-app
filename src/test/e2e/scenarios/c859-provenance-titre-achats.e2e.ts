/**
 * Carte #859 — Achats : le titre USER est protégé AU NIVEAU DU CHAMP (Opération et Agenda) — PostgreSQL 16 réel.
 *
 * Cas de la carte : opération et événement automatiques « Achat », date corrigée à la main, puis justificatif qui
 * établit un nom d'achat fiable → les titres encore automatiques sont améliorés, la date choisie reste ; un titre
 * renommé par l'utilisateur est préservé, indépendamment de l'autre entité. Fournisseur d'IA SIMULÉ (sorties du
 * modèle écrites ici), aucun appel réseau.
 *
 * Chemins de PRODUCTION : barrière et persistance T1, titre du document, décision T4 du document et primitive
 * d'Agenda, consolidation T3 (`consolidateAccountOperations`, `reconsolidateOperations`), projection T4
 * (`projectAccountOperations`), commandes de l'utilisateur (`updateAgendaItem`, `correctOperation`), aperçu et
 * reprise (`previewAcquisitionNames`, `reprisePurchaseTitles`), écrivain `retitleAgendaItem`, restauration du
 * journal 0591, déclencheurs de la migration 2010.
 *
 *   C859-E2E-01  migrations 2010 / 2011 additives et idempotente ; déclencheurs : provenance tenue dans la même instruction
 *   C859-E2E-02  AC01 / AC02 / AC05 / AC09 / AC10 : date (et autres champs) corrigés, puis nom fiable — opération (T3
 *                ordinaire) et événements DOCUMENT + OPERATION (projection ordinaire) renommés SUR LE MÊME ID, date
 *                et autres données intactes ; aperçu = consolidation = reprise ; second passage sans effet
 *   C859-E2E-03  AC03 / AC06 / AC07 : titres USER (même égaux au résumé), événement saisi, provenance INCONNUE du
 *                stock — rien n'est réécrit (consolidation, projection, reprise) ; motif au diagnostic ; indépendance
 *                des deux entités ; sauvegarde d'un autre champ, titre renvoyé inchangé : aucune fausse provenance
 *   C859-E2E-04  AC08 : changement USER concurrent entre calcul et écriture (T3 et T4), restauration, rejeu, membre
 *                Duo, compte d'autrui, opération invalidée — aucun écrasement
 */
import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';
import { gateOperationCandidates, type AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { buildAgendaCandidatesT4 } from '@/services/ai/source-analysis/steps/build-agenda-candidates.step';
import type { ExtractedField } from '@/services/ai/source-analysis/types';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()),
  emitBusinessEvent: async () => undefined,
  emitBusinessEvents: async () => undefined,
}));

type Json = Record<string, any>;
const AUJ = '2026-11-20';
const NOM = 'Achat de carburant';

scenario('C859', 'Achats : titre USER protégé au niveau du champ, titre SYSTEM améliorable malgré une correction de date (carte #859)', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const projection = () => import('@/services/business-operations/agenda-projection/service');

  // ── Outils (mêmes chemins que le scénario L116I) ─────────────────────────
  async function compteCupra(plan: 'premium' | 'premium_duo' = 'premium'): Promise<{ compte: AccountRow & { owner: { id: number } }; cupra: AssetRow }> {
    const compte = await make.account({ plan });
    const cupra = await make.asset(compte, { category: 'VEHICULE', name: 'Cupra' });
    return { compte, cupra };
  }
  function barriere(typeDocument: string | null, brut: AnchoredOperationCandidate): AnchoredOperationCandidate[] {
    return gateOperationCandidates([brut], {
      hasExploitableContent: true, documentTypeCode: typeDocument,
      verifiedIds: { ASSET: new Set(brut.targetHints.flatMap((t) => (t.entityId ? [t.entityId] : []))), EQUIPMENT: new Set(), ROOM: new Set() },
      capabilities: { rooms: false, equipments: false }, keptFactRefs: new Set(['f1']),
    }).candidates;
  }
  async function titrer(compte: AccountRow, fileId: number) {
    const { ensureBusinessTitle } = await import('@/services/documents/document-title.service');
    return ensureBusinessTitle({ fileId, accountId: compte.id, origin: 'T1', mode: 'refresh' });
  }
  /** Ticket de carburant analysé (modèle simulé) SANS désignation encore disponible : l'opération naît « Achat ». */
  async function ticket(compte: AccountRow, assetId: number, o: { station: string; date: string; cents: number }): Promise<number> {
    const candidats = barriere('ACQUISITION_INVOICE', cand({
      typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', summary: 'Achat', provider: o.station,
      targetHints: [cible(assetId)], businessReferences: [ref('INVOICE', `TK-${o.station}-${o.date}`)] as never,
      temporalHints: { realizedDate: o.date }, financialHints: [fh('REALIZED_COST', o.cents, { economicDate: o.date })],
    }));
    const id = await k.document(compte, assetId, candidats, { type: 'ACQUISITION_INVOICE', amountCents: o.cents, date: o.date });
    await sql`UPDATE asset_files SET supplier = ${o.station}, title_source = 'SYSTEM', last_analysis_at = now(), original_filename = ${`IMG_${5000 + id}.jpg`} WHERE id = ${id}`;
    await sql`UPDATE document_extractions SET title = ${`Ticket de carburant ${o.station}`}, supplier_name = ${o.station}, document_date = ${o.date} WHERE file_id = ${id}`;
    const raw = { task: 'ANALYZE_DOCUMENT', document: {
      title: { value: `Ticket de carburant ${o.station}`, confidence: 'certain' }, type: { value: 'ACQUISITION_INVOICE', confidence: 'certain' },
      supplier: { value: { name: o.station }, confidence: 'certain' }, date: { value: o.date, confidence: 'certain' },
    } };
    await sql`INSERT INTO document_analysis_runs (asset_file_id, input_file_hash, prompt_version, provider, model, status, is_current_reference, account_id, raw_response_json)
              VALUES (${id}, ${`h${id}`}, 't1_master_v1@file', 'replay', 'm', 'completed', true, ${compte.id}, ${JSON.stringify(raw)})`;
    return id;
  }
  /** Événement de la décision T4 du DOCUMENT (« Achat — Cupra »), par la primitive d'Agenda de production. */
  async function evenementDuDocument(compte: AccountRow, assetId: number, fileId: number, date: string) {
    const fait: ExtractedField = {
      fieldKey: 'amount.total', value: 62.3, confidence: 'certain', excerpt: 'TOTAL TTC', canonicalKey: null,
      semanticEvent: { type: 'purchase', nature: 'HISTORICAL' },
      target: { targetType: 'ASSET', targetEntityId: assetId, targetEntityLabel: 'Cupra' } as never,
    };
    const [c] = buildAgendaCandidatesT4([fait], { sourceFileId: fileId, documentAssetId: assetId, multiAsset: false, documentTitle: null, documentDate: date, documentTypeCode: 'ACQUISITION_INVOICE' });
    const { persistAgendaDecisions } = await import('@/services/agenda/agenda-persistence');
    await persistAgendaDecisions([{
      action: 'create', title: c.title, date: c.date, category: 'information', confidence: 'certain', reasonCode: 'E2E', deterministic: true,
      sourceFileId: fileId, nature: c.nature ?? null, businessType: c.businessType ?? null, target: c.target ?? null,
      occurrenceIndex: c.occurrence ?? null, dateSource: c.dateSource ?? null, sources: c.sources,
    }], compte.id, assetId);
    const [e] = await sql<Json[]>`SELECT id::int AS id, title FROM agenda_items WHERE account_id = ${compte.id} AND origin_ref_type = 'asset_file' AND origin_ref_id = ${fileId} ORDER BY id DESC LIMIT 1`;
    return e as { id: number; title: string };
  }
  const projeter = async (compte: AccountRow, o: { dryRun?: boolean } = {}) =>
    (await projection()).projectAccountOperations(compte.id, { all: true, today: AUJ, correlationId: 'e2e-859', ...o });
  const chaine = async (compte: AccountRow) => { await k.passer(compte, { today: AUJ }); return projeter(compte); };
  const opDe = async (compte: AccountRow, fileId: number) => {
    const [s] = await sql<Json[]>`SELECT operation_id::int AS op FROM business_operation_sources WHERE account_id = ${compte.id} AND source_kind = 'DOCUMENT' AND source_entity_key = ${String(fileId)} AND active`;
    return Number(s.op);
  };
  const operation = async (id: number) => (await sql<Json[]>`
    SELECT id::int AS id, technical_label AS label, realized_date::text AS realized, status, to_jsonb(o) -> 'title_provenance' AS prov
      FROM business_operations o WHERE id = ${id}`)[0];
  const evenement = async (id: number) => (await sql<Json[]>`
    SELECT id::int AS id, title, start_date::text AS date, business_operation_id::int AS op, is_automatic AS auto, is_automatic_modified AS modifie,
           projection_origin AS origine, to_jsonb(i) -> 'title_provenance' AS prov
      FROM agenda_items i WHERE id = ${id}`)[0];
  const evtsDe = async (opId: number) => sql<Json[]>`SELECT id::int AS id FROM agenda_items WHERE business_operation_id = ${opId} ORDER BY id`;
  const user = (compte: AccountRow & { owner: { id: number } }, userId = compte.owner.id) => ({ accountId: compte.id, actor: { kind: 'USER' as const, userId, channel: 'UI' as const } });
  /** Tout ce qu'un renommage ne doit PAS changer (AC10) : identifiants, cardinalités, dates, liens, statuts, montants, sources, cartes, retraits. */
  const photo = async (compte: AccountRow) => JSON.stringify({
    evts: await sql`SELECT (to_jsonb(i) - 'title' - 'title_provenance' - 'updated_at' - 'projection_correlation_id') AS e FROM agenda_items i WHERE account_id = ${compte.id} ORDER BY id`,
    ops: await sql`SELECT (to_jsonb(o) - 'technical_label' - 'title_provenance' - 'version' - 'updated_at' - 'last_reconciled_at') #- '{attribute_provenance,fields,label}' AS o FROM business_operations o WHERE account_id = ${compte.id} ORDER BY id`,
    liens: await sql`SELECT to_jsonb(l) - 'updated_at' AS l FROM business_operation_agenda_links l WHERE account_id = ${compte.id} ORDER BY id`,
    biens: await sql`SELECT agenda_item_id, asset_id FROM agenda_asset_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${compte.id} ORDER BY 1, 2`,
    docs: await sql`SELECT agenda_item_id, asset_file_id FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${compte.id} ORDER BY 1, 2`,
    sources: await sql`SELECT id, operation_id, source_kind, active FROM business_operation_sources WHERE account_id = ${compte.id} ORDER BY id`,
    montants: await sql`SELECT c.id, c.amount_minor, c.active FROM business_operation_financial_components c JOIN business_operations o ON o.id = c.operation_id WHERE o.account_id = ${compte.id} ORDER BY c.id`,
    cartes: await sql`SELECT id, rule_code, resolved_at IS NOT NULL AS r FROM to_process_actions WHERE account_id = ${compte.id} ORDER BY id`,
    retraits: await sql`SELECT count(*)::int AS n FROM agenda_item_removals WHERE account_id = ${compte.id}`,
    fiche: await sql`SELECT key_characteristics FROM assets WHERE account_id = ${compte.id} ORDER BY id`,
  });

  // ══ 01 ═══════════════════════════════════════════════════════════════════

  it('C859-E2E-01 — migrations 2010 / 2011 additives et idempotente ; déclencheurs : provenance du titre tenue dans la même instruction, déclarée ou par défaut', async () => {
    const texte = (await Promise.all(['2010_c859_provenance_titre_operations.sql', '2011_c859_provenance_titre_agenda.sql']
      .map((f) => readFile(join(process.cwd(), 'src/db/migrations', f), 'utf-8')))).join('\n');
    await sql.begin(async (tx) => { await tx.unsafe(texte); });
    await sql.begin(async (tx) => { await tx.unsafe(texte); }); // rejouée : sans effet ni erreur
    expect(await sql`SELECT table_name, data_type FROM information_schema.columns WHERE column_name = 'title_provenance' AND table_name IN ('business_operations', 'agenda_items') ORDER BY 1`)
      .toEqual([{ table_name: 'agenda_items', data_type: 'jsonb' }, { table_name: 'business_operations', data_type: 'jsonb' }]);

    const { compte, cupra } = await compteCupra();
    const f = await ticket(compte, cupra.id, { station: 'TotalEnergies', date: AUJ, cents: 6230 });
    await chaine(compte);
    const opId = await opDe(compte, f);
    // Création T3 déclarée SYSTEM (motif, canal) ; création T4 déclarée SYSTEM.
    expect((await operation(opId)).prov).toMatchObject({ origin: 'SYSTEM', value: 'Achat', reason: 'T3_CREATE_NEW', channel: 'DOCUMENT' });
    const [{ id: evtId }] = await evtsDe(opId);
    expect((await evenement(evtId)).prov).toMatchObject({ origin: 'SYSTEM', value: 'Achat', reason: 'T4_PROJECTION_CREATED', channel: 'T4' });

    // Écriture NON déclarée de l'intitulé (ancienne version, SQL direct) : provenance EFFACÉE — jamais une provenance fausse.
    await sql`UPDATE business_operations SET technical_label = 'Saisie hors code' WHERE id = ${opId}`;
    expect((await operation(opId)).prov).toBeNull();
    // Déclarée dans la transaction : tracée ; la déclaration retirée ne vaut plus pour l'instruction suivante.
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('verebona.title_declaration', ${JSON.stringify({ origin: 'USER', reason: 'E2E', actorUserId: compte.owner.id })}, true)`;
      await tx`UPDATE business_operations SET technical_label = 'Mon plein' WHERE id = ${opId}`;
      await tx`SELECT set_config('verebona.title_declaration', '', true)`;
      await tx`UPDATE agenda_items SET title = 'Titre moteur' WHERE id = ${evtId}`;
    });
    expect((await operation(opId)).prov).toMatchObject({ origin: 'USER', value: 'Mon plein', previous: 'Saisie hors code', actorUserId: compte.owner.id });
    // Agenda : élément automatique intact, écriture non déclarée → SYSTEM (convention §14.6).
    expect((await evenement(evtId)).prov).toMatchObject({ origin: 'SYSTEM', value: 'Titre moteur', previous: 'Achat', reason: 'UNDECLARED_TITLE_WRITE' });
    // Première modification de l'utilisateur et titre changé dans la même écriture → USER ; élément déjà modifié, écriture non déclarée → INCONNU.
    await sql`UPDATE agenda_items SET title = 'Mon titre', is_automatic_modified = true WHERE id = ${evtId}`;
    expect((await evenement(evtId)).prov).toMatchObject({ origin: 'USER', value: 'Mon titre' });
    await sql`UPDATE agenda_items SET title = 'Autre' WHERE id = ${evtId}`;
    expect((await evenement(evtId)).prov).toMatchObject({ origin: 'UNKNOWN', value: 'Autre' });
    // Stock : provenance absente, PREMIÈRE modification de l'utilisateur sans toucher au titre → l'état prouvé (SYSTEM) est figé.
    const f2 = await ticket(compte, cupra.id, { station: 'Esso', date: '2026-10-02', cents: 5510 });
    await chaine(compte);
    const [{ id: e2 }] = await evtsDe(await opDe(compte, f2));
    await sql`UPDATE agenda_items SET title_provenance = NULL WHERE id = ${e2}`; // stock d'avant la migration
    expect((await evenement(e2)).prov).toBeNull();
    await sql`UPDATE agenda_items SET start_date = '2026-10-03', is_automatic_modified = true WHERE id = ${e2}`;
    expect((await evenement(e2)).prov).toMatchObject({ origin: 'SYSTEM', value: 'Achat', reason: 'SYSTEM_TITLE_BEFORE_FIRST_USER_EDIT' });

    // ── Revue : la déclaration est LOCALE à la transaction (set_config(…, true)) — jamais de fuite ─────────────
    const { declareTitleWritePg, TITLE_DECLARATION_SETTING } = await import('@/services/business-operations/title-provenance');
    const declUser = { origin: 'USER' as const, reason: 'E2E_FUITE', actorUserId: compte.owner.id };
    const lireReglages = async () => (await Promise.all(Array.from({ length: 12 }, () =>
      sql<Json[]>`SELECT COALESCE(current_setting(${TITLE_DECLARATION_SETTING}, true), '') AS v, pg_backend_pid() AS pid`))).map((r) => r[0]);
    // (b) déclaration posée puis JAMAIS retirée, transaction validée : elle meurt avec la transaction.
    await sql.begin(async (tx) => { await tx`SELECT set_config(${TITLE_DECLARATION_SETTING}, ${JSON.stringify(declUser)}, true)`; });
    // (a) aucune connexion du pool ne la porte (requêtes parallèles : plusieurs connexions).
    const reglages = await lireReglages();
    expect(reglages.every((r) => r.v === '')).toBe(true);
    await sql`UPDATE business_operations SET technical_label = 'Après fuite (b)' WHERE id = ${opId}`;
    expect((await operation(opId)).prov).toBeNull();
    // Hors transaction (autocommit) une déclaration locale ne survit pas à son instruction : c'est pourquoi le code
    // n'écrit un titre déclaré que DANS la transaction de l'écriture.
    await sql`SELECT set_config(${TITLE_DECLARATION_SETTING}, ${JSON.stringify(declUser)}, true)`;
    await sql`UPDATE business_operations SET technical_label = 'Autocommit' WHERE id = ${opId}`;
    expect((await operation(opId)).prov).toBeNull();
    // (c) exception entre la pose et le retrait : transaction annulée — rien ne reste, ni écriture ni déclaration.
    await expect(sql.begin(async (tx) => {
      await tx`SELECT set_config(${TITLE_DECLARATION_SETTING}, ${JSON.stringify(declUser)}, true)`;
      await tx`UPDATE business_operations SET technical_label = 'Annulée' WHERE id = ${opId}`;
      throw new Error('panne simulée');
    })).rejects.toThrow('panne simulée');
    expect(await operation(opId)).toMatchObject({ label: 'Autocommit', prov: null });
    expect((await lireReglages()).every((r) => r.v === '')).toBe(true);
    // (c bis) échec de l'écriture déclarée sous un point de reprise : retrait garanti (finally) — l'instruction
    // suivante de la MÊME transaction n'est pas déclarée.
    await sql.begin(async (tx) => {
      await tx.savepoint(async (sp) => {
        await declareTitleWritePg(sp as never, declUser, async () => { await sp`UPDATE business_operations SET technical_label = 'x' WHERE id = ${opId}`; throw new Error('écriture refusée'); });
      }).catch(() => undefined);
      expect((await tx<Json[]>`SELECT COALESCE(current_setting(${TITLE_DECLARATION_SETTING}, true), '') AS v`)[0].v).toBe('');
      await tx`UPDATE business_operations SET technical_label = 'Suivante' WHERE id = ${opId}`;
    });
    expect(await operation(opId)).toMatchObject({ label: 'Suivante', prov: null });
    // Déclaration retirée normalement : instruction suivante non déclarée.
    await sql.begin(async (tx) => {
      await declareTitleWritePg(tx as never, declUser, async () => { await tx`UPDATE business_operations SET technical_label = 'Déclarée' WHERE id = ${opId}`; });
      await tx`UPDATE business_operations SET technical_label = 'Non déclarée' WHERE id = ${opId}`;
    });
    expect((await operation(opId)).prov).toBeNull();
  });

  // ══ 02 ═══════════════════════════════════════════════════════════════════

  it('C859-E2E-02 — date (et autres champs) corrigés à la main, puis nom fiable : opération et événements DOCUMENT + OPERATION renommés sur le même ID, date et autres données intactes ; aperçu = consolidation = reprise ; second passage sans effet', async () => {
    const { compte, cupra } = await compteCupra();
    // A : opération + événement PROJETÉ « Achat » (chemin OPERATION).
    const fA = await ticket(compte, cupra.id, { station: 'TotalEnergies', date: AUJ, cents: 6230 });
    // B : événement du DOCUMENT « Achat — Cupra » (chemin DOCUMENT), relié à son opération.
    const fB = await ticket(compte, cupra.id, { station: 'Esso', date: '2026-10-02', cents: 5510 });
    const evtB = await evenementDuDocument(compte, cupra.id, fB, '2026-10-02');
    await chaine(compte);
    const opA = await opDe(compte, fA);
    const opB = await opDe(compte, fB);
    const [{ id: evtA }] = await evtsDe(opA);
    expect(await operation(opA)).toMatchObject({ label: 'Achat', realized: AUJ });
    expect(await evenement(evtA)).toMatchObject({ title: 'Achat', origine: 'OPERATION', modifie: false });
    expect(await evenement(evtB.id)).toMatchObject({ title: 'Achat — Cupra', op: opB, origine: null, modifie: false });

    // ── Corrections de l'UTILISATEUR, AUCUNE sur un titre ──
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    // A : date corrigée depuis l'Agenda, le formulaire renvoie le titre inchangé (fait reporté sur l'opération, #806).
    await updateAgendaItem(evtA, { title: 'Achat', startDate: '2026-11-19' }, compte.id, compte.owner.id);
    // B : date de l'opération corrigée depuis sa fiche (AC02 : autre attribut), description de l'événement modifiée.
    const { correctOperation } = await import('@/services/business-operations/operation-write.facade');
    expect((await correctOperation(user(compte), { operationId: opB, attributes: { realizedDate: '2026-10-03' } })).status).toBe('APPLIED');
    await updateAgendaItem(evtB.id, { description: 'Plein avant le départ' }, compte.id, compte.owner.id);
    expect(await operation(opA)).toMatchObject({ label: 'Achat', realized: '2026-11-19', prov: { origin: 'SYSTEM', value: 'Achat' } });
    expect(await operation(opB)).toMatchObject({ label: 'Achat', realized: '2026-10-03', prov: { origin: 'SYSTEM', value: 'Achat' } });
    // AC07 : sauvegarde d'un autre champ, titre renvoyé inchangé → aucune fausse provenance USER.
    expect(await evenement(evtA)).toMatchObject({ title: 'Achat', date: '2026-11-19', modifie: true, prov: { origin: 'SYSTEM', value: 'Achat' } });
    expect(await evenement(evtB.id)).toMatchObject({ title: 'Achat — Cupra', modifie: true, prov: { origin: 'SYSTEM', value: 'Achat — Cupra' } });
    // Les deux opérations portent maintenant une saisie de l'utilisateur (ancienne garde globale : intitulé figé à jamais).
    for (const op of [opA, opB]) expect((await k.sources(op)).filter((x) => x.active).map((x) => x.source_kind)).toContain('USER_DECLARATION');

    // ── Le justificatif établit enfin un nom fiable ──
    await titrer(compte, fA);
    await titrer(compte, fB);
    const avant = await photo(compte);

    // APERÇU (à blanc) : même décision que la consolidation — SYSTEM, à renommer.
    const { previewAcquisitionNames, reconsolidateOperations } = await import('@/services/business-operations/consolidation/consolidator');
    const apercu = await previewAcquisitionNames(compte.id, [opA, opB], AUJ);
    for (const op of [opA, opB]) {
      expect(apercu.get(op)).toMatchObject({ stored: 'Achat', expected: NOM, wouldChange: true, fullyManaged: false, systemLabel: true, titleAuthority: { authority: 'SYSTEM' }, blockedExpected: null });
    }
    // CONSOLIDATION T3 ORDINAIRE de A : intitulé amélioré, date de l'utilisateur intacte, même identifiant.
    await reconsolidateOperations(compte.id, [opA], { today: AUJ });
    expect(await operation(opA)).toMatchObject({ id: opA, label: NOM, realized: '2026-11-19', prov: { origin: 'SYSTEM', value: NOM, previous: 'Achat', reason: 'T3_ATTRIBUTES_CONSOLIDATED', channel: 'T3' } });
    expect((await sql`SELECT reason_code, before_json ->> 'technical_label' AS a, after_json ->> 'technical_label' AS b FROM business_operation_history WHERE operation_id = ${opA} AND after_json ? 'technical_label' ORDER BY id DESC LIMIT 1`))
      .toEqual([{ reason_code: 'T3_ATTRIBUTES_CONSOLIDATED', a: 'Achat', b: NOM }]);
    // PROJECTION T4 ORDINAIRE : la projection de A, dont seule la date a été corrigée, reçoit le TITRE SEUL (RETITLE).
    const simul = await projeter(compte, { dryRun: true });
    expect((simul.plans ?? []).find((p) => p.operationId === opA)?.actions).toEqual([{ kind: 'RETITLE', itemId: evtA, title: NOM, from: 'Achat' }]);
    await projeter(compte);
    expect(await evenement(evtA)).toMatchObject({ id: evtA, title: NOM, date: '2026-11-19', modifie: true, origine: 'OPERATION', prov: { origin: 'SYSTEM', value: NOM, reason: 'OPERATION_PRECISE_TITLE' } });
    // B : REPRISE ciblée (même décision) — intitulé, puis événement du document (RETITLE journalisé, restaurable).
    const { reprisePurchaseTitles } = await import('@/services/business-operations/agenda-projection/purchase-title-reprise');
    const blanc = await reprisePurchaseTitles(compte.id, { today: AUJ });
    expect(blanc.operations.find((o) => o.operationId === opB)).toMatchObject({
      label: { before: 'Achat', after: NOM, action: 'RENAME', titleAuthority: { authority: 'SYSTEM' } },
      events: [{ itemId: evtB.id, before: 'Achat — Cupra', after: NOM, action: 'RENAME', origin: 'DOCUMENT', titleAuthority: { authority: 'SYSTEM' } }],
    });
    expect(blanc).toMatchObject({ labelsToRename: 1, eventsToRename: 1, keptUnknown: 0 });
    const reel = await reprisePurchaseTitles(compte.id, { apply: true, today: AUJ });
    expect(reel).toMatchObject({ applied: true, labelsRenamed: 1, eventsRenamed: 1 });
    expect(await operation(opB)).toMatchObject({ label: NOM, realized: '2026-10-03', prov: { origin: 'SYSTEM', reason: 'T3_ACQUISITION_NAME_APPLIED', channel: 'REPRISE' } });
    expect(await evenement(evtB.id)).toMatchObject({ id: evtB.id, title: NOM, modifie: true, prov: { origin: 'SYSTEM', value: NOM, previous: 'Achat — Cupra', channel: 'REPRISE' } });
    expect((await sql`SELECT description FROM agenda_items WHERE id = ${evtB.id}`)[0].description).toBe('Plein avant le départ');
    expect(await sql`SELECT kind, detail ->> 'from' AS de, detail ->> 'to' AS vers FROM agenda_intervention_consolidations WHERE principal_item_id = ${evtB.id}`)
      .toEqual([{ kind: 'RETITLE', de: 'Achat — Cupra', vers: NOM }]);
    // AC10 : TOUT le reste identique (IDs, cardinalités, dates, liens, statuts, montants, sources, cartes, retraits, fiche du bien).
    expect(await photo(compte)).toEqual(avant);

    // AC09 : second passage — consolidation, projection, reprise : zéro modification.
    const historique = await k.historique(compte);
    await reconsolidateOperations(compte.id, [opA, opB], { today: AUJ });
    const encore = await projeter(compte);
    expect(encore.changes).toBe(0);
    expect(await reprisePurchaseTitles(compte.id, { apply: true, today: AUJ })).toMatchObject({ labelsToRename: 0, eventsToRename: 0, labelsRenamed: 0, eventsRenamed: 0 });
    expect(await k.historique(compte)).toBe(historique);
    expect(await photo(compte)).toEqual(avant);
  });

  // ══ 03 ═══════════════════════════════════════════════════════════════════

  it('C859-E2E-03 — titres USER (même égaux au résumé), événement saisi, provenance INCONNUE : rien n’est réécrit ; motif au diagnostic ; indépendance des deux entités', async () => {
    const { compte, cupra } = await compteCupra();
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    const { correctOperation } = await import('@/services/business-operations/operation-write.facade');
    const tickets = [
      await ticket(compte, cupra.id, { station: 'TotalEnergies', date: AUJ, cents: 6230 }),
      await ticket(compte, cupra.id, { station: 'Esso', date: '2026-10-02', cents: 5510 }),
      await ticket(compte, cupra.id, { station: 'Avia', date: '2026-09-05', cents: 4800 }),
      await ticket(compte, cupra.id, { station: 'Leclerc', date: '2026-08-11', cents: 3900 }),
    ];
    await chaine(compte);
    const [opC, opD, opE, opF] = await Promise.all(tickets.map((f) => opDe(compte, f)));
    const [[{ id: evtC }], [{ id: evtD }], [{ id: evtE }], [{ id: evtF }]] = await Promise.all([opC, opD, opE, opF].map((o) => evtsDe(o)));

    // C — opération : l'utilisateur CHOISIT « Achat » (égal au résumé) après l'avoir renommée ; événement : titre USER égal à la valeur générée.
    for (const label of ['Plein', 'Achat']) expect((await correctOperation(user(compte), { operationId: opC, label })).status).toBe('APPLIED');
    await updateAgendaItem(evtC, { title: 'Mon plein' }, compte.id, compte.owner.id);
    await updateAgendaItem(evtC, { title: 'Achat' }, compte.id, compte.owner.id);
    expect(await operation(opC)).toMatchObject({ label: 'Achat', prov: { origin: 'USER', value: 'Achat', reason: 'USER_PAGE_CORRECTION', actorUserId: compte.owner.id } });
    expect(await evenement(evtC)).toMatchObject({ title: 'Achat', prov: { origin: 'USER', value: 'Achat', reason: 'USER_AGENDA_TITLE_EDIT' } });
    // D — AC07 : opération USER, événement SYSTEM (seule sa date est corrigée) : la propagation existante vaut pour le titre SYSTEM.
    expect((await correctOperation(user(compte), { operationId: opD, label: 'Achat de pneus hiver' })).status).toBe('APPLIED');
    await updateAgendaItem(evtD, { startDate: '2026-10-04' }, compte.id, compte.owner.id);
    // E — AC07 inverse : opération SYSTEM, événement USER.
    await updateAgendaItem(evtE, { title: 'Plein de la Cupra' }, compte.id, compte.owner.id);
    // F — provenance INCONNUE : stock d'avant la migration, déjà modifié, sans trace du champ (ni l'opération ni l'événement).
    await sql`UPDATE agenda_items SET title_provenance = NULL, is_automatic_modified = true WHERE id = ${evtF}`;
    await sql`UPDATE business_operations SET title_provenance = NULL WHERE id = ${opF}`;
    await sql`UPDATE business_operation_history SET reason_code = 'LEGACY_IMPORT' WHERE operation_id = ${opF} AND after_json ? 'technical_label'`;
    // Événement SAISI par l'utilisateur rattaché à l'achat C : jamais éligible.
    await sql`UPDATE agenda_items SET is_automatic = false WHERE id = ${evtC}`;

    for (const f of tickets) await titrer(compte, f);
    const avant = await photo(compte);
    const titres = async () => [await operation(opC), await operation(opD), await operation(opE), await operation(opF), await evenement(evtC), await evenement(evtD), await evenement(evtE), await evenement(evtF)]
      .map((x) => x.label ?? x.title);

    // Diagnostic de la reprise : trois états distincts, motif précis, aucune carte « À traiter ».
    const { reprisePurchaseTitles } = await import('@/services/business-operations/agenda-projection/purchase-title-reprise');
    const cartes = (await sql`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${compte.id}`)[0].n;
    const blanc = await reprisePurchaseTitles(compte.id, { today: AUJ });
    const parOp = new Map(blanc.operations.map((o) => [o.operationId, o]));
    expect(parOp.get(opC)).toMatchObject({
      label: { action: 'KEEP_USER_LABEL', titleAuthority: { authority: 'USER', reason: 'USER_TITLE_RECORDED' }, blockedExpected: NOM },
      events: [{ itemId: evtC, action: 'KEEP_USER_TITLE', origin: 'USER', titleAuthority: { authority: 'USER', reason: 'MANUAL_ITEM' } }],
    });
    expect(parOp.get(opD)?.label).toMatchObject({ action: 'KEEP_USER_LABEL', titleAuthority: { authority: 'USER' } });
    expect(parOp.get(opE)).toMatchObject({ label: { action: 'RENAME', after: NOM }, events: [] }); // titre explicite de l'utilisateur : hors renommage
    expect(parOp.get(opF)).toMatchObject({
      label: { action: 'KEEP_UNKNOWN_PROVENANCE', titleAuthority: { authority: 'UNKNOWN', reason: 'HISTORY_TITLE_WRITE_UNCLASSIFIED' }, blockedExpected: NOM },
      events: [{ itemId: evtF, action: 'KEEP_UNKNOWN_PROVENANCE', titleAuthority: { authority: 'UNKNOWN', reason: 'MODIFIED_WITHOUT_TITLE_TRACE' } }],
    });
    expect(blanc).toMatchObject({ labelsToRename: 1, keptUnknown: 2 });

    // Nouvelle preuve, reconsolidation, réanalyse, projection, reprise : seul l'intitulé SYSTEM de E change.
    const { reconsolidateOperations } = await import('@/services/business-operations/consolidation/consolidator');
    await reconsolidateOperations(compte.id, [opC, opD, opE, opF], { today: AUJ });
    await chaine(compte);
    await reprisePurchaseTitles(compte.id, { apply: true, today: AUJ });
    await projeter(compte);
    expect(await titres()).toEqual(['Achat', 'Achat de pneus hiver', NOM, 'Achat', 'Achat', 'Achat de pneus hiver', 'Plein de la Cupra', 'Achat']);
    // D : l'événement SYSTEM a suivi l'intitulé choisi par l'utilisateur (propagation existante), sa date de l'utilisateur intacte.
    expect(await evenement(evtD)).toMatchObject({ date: '2026-10-04', prov: { origin: 'SYSTEM' } });
    expect((await evenement(evtE)).prov).toMatchObject({ origin: 'USER', value: 'Plein de la Cupra' });
    expect((await sql`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${compte.id}`)[0].n).toBe(cartes);
    // AC10 : hors titres, rien n'a changé.
    expect(await photo(compte)).toEqual(avant);
  });

  // ══ 04 ═══════════════════════════════════════════════════════════════════

  it('C859-E2E-04 — changement USER concurrent entre calcul et écriture (T3 et T4), restauration, rejeu, membre Duo, compte d’autrui, opération invalidée : aucun écrasement', async () => {
    const { compte, cupra } = await compteCupra('premium_duo');
    const second = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${compte.id}, ${second.id}, 'member', 'active')`;
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    const { correctOperation, invalidateOperation } = await import('@/services/business-operations/operation-write.facade');
    const { previewAcquisitionNames, applyAcquisitionNames } = await import('@/services/business-operations/consolidation/consolidator');
    const { retitleAgendaItem, restoreAgendaConsolidations } = await import('@/services/business-operations/agenda-projection/consolidation');
    const fG = await ticket(compte, cupra.id, { station: 'TotalEnergies', date: AUJ, cents: 6230 });
    const fH = await ticket(compte, cupra.id, { station: 'Esso', date: '2026-10-02', cents: 5510 });
    const fI = await ticket(compte, cupra.id, { station: 'Avia', date: '2026-09-05', cents: 4800 });
    const evtH = await evenementDuDocument(compte, cupra.id, fH, '2026-10-02');
    await chaine(compte);
    const [opG, opH, opI] = [await opDe(compte, fG), await opDe(compte, fH), await opDe(compte, fI)];
    for (const f of [fG, fH, fI]) await titrer(compte, f);
    // Opération invalidée par l'utilisateur (« créée à tort ») : ni l'aperçu, ni la reprise, ni T3 ne la renomment.
    const [{ version }] = await sql<Json[]>`SELECT version FROM business_operations WHERE id = ${opI}`;
    expect((await invalidateOperation(user(compte), { operationId: opI, expectedVersion: Number(version) })).status).toBe('APPLIED');
    expect((await previewAcquisitionNames(compte.id, [opI], AUJ)).has(opI)).toBe(false);
    expect(await applyAcquisitionNames(compte.id, [opI], { today: AUJ })).toEqual([]);

    // T3 : l'aperçu annonce le renommage ; le membre DUO corrige l'intitulé avant l'écriture → l'écriture (décision
    // recalculée sous le verrou du compte) ne l'écrase pas.
    expect((await previewAcquisitionNames(compte.id, [opG], AUJ)).get(opG)).toMatchObject({ wouldChange: true, expected: NOM });
    expect((await correctOperation(user(compte, second.id), { operationId: opG, label: 'Plein du membre' })).status).toBe('APPLIED');
    expect(await applyAcquisitionNames(compte.id, [opG], { today: AUJ })).toEqual([]);
    expect(await operation(opG)).toMatchObject({ label: 'Plein du membre', prov: { origin: 'USER', actorUserId: second.id } });

    // T4 : plan calculé (« Achat — Cupra » → nom précis), puis l'utilisateur renomme l'événement → écriture caduque.
    await applyAcquisitionNames(compte.id, [opH], { today: AUJ });
    const plan = (await projeter(compte, { dryRun: true })).plans?.find((p) => p.operationId === opH)?.actions ?? [];
    expect(plan).toEqual([{ kind: 'RETITLE', itemId: evtH.id, title: NOM, from: 'Achat — Cupra' }]);
    await updateAgendaItem(evtH.id, { title: 'Plein Esso' }, compte.id, second.id);
    const ecrire = (accountId = compte.id, from = 'Achat — Cupra') => retitleAgendaItem({ accountId, operationId: opH, itemId: evtH.id, title: NOM, from, origin: 'PROJECTION' });
    expect(await ecrire()).toBe(false);
    expect(await ecrire(compte.id, 'Plein Esso')).toBe(false); // valeur USER : jamais réécrite, même relue
    expect(await evenement(evtH.id)).toMatchObject({ title: 'Plein Esso', prov: { origin: 'USER', actorUserId: second.id } });
    // Rejeu de la projection et de la reprise : toujours rien.
    await projeter(compte);
    const { reprisePurchaseTitles } = await import('@/services/business-operations/agenda-projection/purchase-title-reprise');
    await reprisePurchaseTitles(compte.id, { apply: true, today: AUJ });
    expect((await evenement(evtH.id)).title).toBe('Plein Esso');

    // Concurrence sur un AUTRE champ (date seule) entre plan et écriture : le titre SYSTEM est renommé, la date de l'utilisateur reste.
    const fJ = await ticket(compte, cupra.id, { station: 'Leclerc', date: '2026-08-11', cents: 3900 });
    const evtJ = await evenementDuDocument(compte, cupra.id, fJ, '2026-08-11');
    await chaine(compte);
    await titrer(compte, fJ);
    const opJ = await opDe(compte, fJ);
    await applyAcquisitionNames(compte.id, [opJ], { today: AUJ });
    const planJ = (await projeter(compte, { dryRun: true })).plans?.find((p) => p.operationId === opJ)?.actions ?? [];
    expect(planJ).toEqual([{ kind: 'RETITLE', itemId: evtJ.id, title: NOM, from: 'Achat — Cupra' }]);
    await updateAgendaItem(evtJ.id, { startDate: '2026-08-12' }, compte.id, compte.owner.id);
    // Compte d'autrui : jamais (garde de compte dans l'écriture).
    const autre = await make.account({ plan: 'premium' });
    expect(await retitleAgendaItem({ accountId: autre.id, operationId: opJ, itemId: evtJ.id, title: NOM, from: 'Achat — Cupra', origin: 'PROJECTION', runId: '00000000-0000-4000-8000-000000000859' })).toBe(false);
    const runId = '00000000-0000-4000-8000-000000008590';
    expect(await retitleAgendaItem({ accountId: compte.id, operationId: opJ, itemId: evtJ.id, title: NOM, from: 'Achat — Cupra', origin: 'REPRISE', runId })).toBe(true);
    expect(await evenement(evtJ.id)).toMatchObject({ title: NOM, date: '2026-08-12', modifie: true });
    // Restauration du renommage : rétablit le titre SYSTEM précédent tant que l'utilisateur ne l'a pas changé…
    expect(await restoreAgendaConsolidations(sql as never, { runId, restoreRunId: '00000000-0000-4000-8000-00000000a859' })).toMatchObject({ restored: 1 });
    expect(await evenement(evtJ.id)).toMatchObject({ title: 'Achat — Cupra', date: '2026-08-12', prov: { origin: 'SYSTEM', reason: 'RETITLE_RESTORED' } });
    // Garde indépendante conservée : un élément dont la consolidation a été RESTAURÉE n'est plus renommé automatiquement.
    expect(await retitleAgendaItem({ accountId: compte.id, operationId: opJ, itemId: evtJ.id, title: NOM, from: 'Achat — Cupra', origin: 'PROJECTION' })).toBe(false);
    // …et la restauration ne passe jamais par-dessus un titre choisi entre-temps par l'utilisateur.
    const fK = await ticket(compte, cupra.id, { station: 'Intermarché', date: '2026-07-03', cents: 2700 });
    const evtK = await evenementDuDocument(compte, cupra.id, fK, '2026-07-03');
    await chaine(compte);
    await titrer(compte, fK);
    const opK = await opDe(compte, fK);
    await applyAcquisitionNames(compte.id, [opK], { today: AUJ });
    const runId2 = '00000000-0000-4000-8000-000000008591';
    expect(await retitleAgendaItem({ accountId: compte.id, operationId: opK, itemId: evtK.id, title: NOM, from: 'Achat — Cupra', origin: 'REPRISE', runId: runId2 })).toBe(true);
    await updateAgendaItem(evtK.id, { title: 'Mon titre' }, compte.id, compte.owner.id);
    await restoreAgendaConsolidations(sql as never, { runId: runId2, restoreRunId: '00000000-0000-4000-8000-00000000b859' });
    expect(await evenement(evtK.id)).toMatchObject({ title: 'Mon titre', prov: { origin: 'USER' } });

    // L'opération invalidée n'a jamais été renommée par les passages précédents (projection, reprise, consolidation).
    await chaine(compte);
    expect((await operation(opI)).label).toBe('Achat');
  });
});
