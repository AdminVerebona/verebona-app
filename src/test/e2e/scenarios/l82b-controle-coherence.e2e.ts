/**
 * Lot 82B — socle du contrôle de cohérence global, sur PostgreSQL 16 réel
 * (toutes les migrations, dont 0644). Arbitrages PO du 23/10/2026 C-Q1, C-Q2,
 * C-Q3, C-Q4, C-Q5, C-Q9, C-Q10.
 *
 *   L82B-E2E-01  objet INCHANGÉ couvert par la campagne du jour (preuve par
 *                objet, version des règles, couverture vérifiée, mesures) ;
 *   L82B-E2E-02  changement d'une DÉPENDANCE → contrôle ciblé → réparation ;
 *   L82B-E2E-03  réparation certaine par le SERVICE MÉTIER puis recontrôle
 *                (carte « À traiter », lien équipement, échéance orpheline) ;
 *   L82B-E2E-04  cas AMBIGU : aucune écriture, aucune sollicitation, aucun IA ;
 *   L82B-E2E-05  mode À BLANC : aucune écriture métier, constats consignés ;
 *   L82B-E2E-06  Agenda 76H : vraies occurrences identiques fusionnées par la
 *                projection (journal 0591), étapes distinctes conservées ;
 *   L82B-E2E-07  TCO : dépense déjà extraite absente du TCO → CONSTAT (sans
 *                relance T1 ni règle par type), persistant → Supervision ;
 *   L82B-E2E-08  idempotence : second passage sans réparation ni doublon ;
 *   L82B-E2E-09  campagne interrompue reprise ; échéance ou objet en échec →
 *                PARTIAL, jamais déclarée exhaustive ;
 *   L82B-E2E-10  maintenance remplacée : une seule chaîne corrige une anomalie
 *                d'agenda (retrait tracé, jamais le statut « annulé ») ;
 *   L82B-E2E-11  compte non éligible ignoré (essai échu / sans abonnement,
 *                suspendu) ; rattrapage exhaustif à la réactivation ;
 *   L82B-E2E-12  déclencheurs : bus métier → demande de contrôle ciblé durable.
 *
 * Toutes les campagnes sont BORNÉES aux comptes créés ici (`scopeAccountIds`)
 * et toutes les assertions portent sur ces comptes. Aucun appel IA réel.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import type { AccountRow } from '../factories';
import { cand, cible, operationsKit, ref, type OperationsKit } from '../datasets/operations-v1';

type Json = Record<string, any>;
const orchestrateur = () => import('@/services/coherence/orchestrator');
const PROCHE = new Date(Date.now() + 50 * 86_400_000).toISOString().slice(0, 10);
const AUTRE = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);

scenario('L82B', 'Contrôle de cohérence global : registre, orchestrateur, preuves, réparations par les services métier', ({ sql, make, replay }) => {
  useTargetState({}, { masters: ['T1', 'T4'] });
  let k: OperationsKit;
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    k = operationsKit(sql, make);
  });

  // ── Jeux de données ──────────────────────────────────────────────────────
  const compte = () => make.account({ plan: 'premium' });
  const maison = (c: AccountRow) => make.asset(c, { category: 'IMMOBILIER', name: `Maison ${c.id}` });
  const equipement = async (assetId: number, name: string, o: { brand?: string; model?: string; serial?: string } = {}) => {
    const [{ id }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${assetId}, ${name}) RETURNING id`;
    if (o.brand || o.model || o.serial) {
      await sql`INSERT INTO equipment_cil_specs (equipment_id, brand, model, serial_number) VALUES (${id}, ${o.brand ?? null}, ${o.model ?? null}, ${o.serial ?? null})`;
    }
    return id;
  };
  /** Document rattaché au bien, avec ses faits T1 persistés. */
  const documentFaits = async (c: AccountRow, assetId: number | null, title: string, faits: Array<{ key: string; value: string; label?: string }>, type: string | null = null) => {
    const f = await make.assetFile(c, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${title}, document_type_code = ${type}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    const [ext] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, title, document_type_code, full_text, full_text_chars)
                                              VALUES (${c.id}, ${f.id}, ${title}, ${type}, '', 0) RETURNING id`;
    for (const x of faits) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, canonical_key, label, value_text, normalized_value, confidence, excerpt)
                VALUES (${c.id}, ${f.id}, ${ext.id}, ${x.key}, ${x.key}, ${x.label ?? null}, ${x.value}, ${x.value}, 'certain', ${`${x.label ?? x.key} : ${x.value}`})`;
    }
    // Lot 87D : comme en fin d'analyse T1 réelle, le titre est contrôlé par le service de nommage
    // (sinon le contrôle COH-DOC-TITLES reprendrait ce document « jamais contrôlé »).
    const { ensureBusinessTitle } = await import('@/services/documents/document-title.service');
    await ensureBusinessTitle({ fileId: f.id, accountId: c.id, origin: 'T1', mode: 'refresh' });
    return f.id;
  };
  /** Carte « À traiter » ouverte sur la date de fin d'un contrat. */
  const carteFinContrat = async (c: AccountRow, fileId: number) => (await sql<{ id: number }[]>`
    INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
    VALUES (${c.id}, 'DOCUMENT', ${fileId}, 'contractEndDate', 'COMPLETE', 'DATA-CONTRACT-END', 'Quelle est la date de fin de ce contrat ?') RETURNING id`)[0].id;
  /** Échéance de fiche automatique sans plus aucun rattachement (résidu d'un bien supprimé). */
  const echeanceOrpheline = async (c: AccountRow) => (await sql<{ id: number }[]>`
    INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, origin_field_key)
    VALUES (${c.id}, 'Contrôle technique', ${PROCHE}, true, 'asset_field', 'nextInspection') RETURNING id`)[0].id;
  const liensEquipement = async (fileId: number) => (await sql<{ equipment_id: number }[]>`
    SELECT equipment_id FROM document_asset_links WHERE file_id = ${fileId} AND status = 'ACTIVE' AND equipment_id IS NOT NULL ORDER BY equipment_id`).map((r) => r.equipment_id);
  const carteOuverte = async (id: number) => (await sql<{ open: boolean }[]>`SELECT resolved_at IS NULL AS open FROM to_process_actions WHERE id = ${id}`)[0]?.open ?? null;
  const preuves = (accountId: number) => sql<Json[]>`
    SELECT check_id, object_id::int AS object_id, object_type, rules_version, registry_version, last_campaign_id::int AS campaign, last_trigger, last_mode,
           last_started_at, last_completed_at, last_success_at, last_result, finding, finding_streak, requested_at
      FROM coherence_object_proofs WHERE account_id = ${accountId} ORDER BY check_id, object_id`;
  const preuve = async (accountId: number, check: string, objectId: number) => (await preuves(accountId)).find((p) => p.check_id === check && p.object_id === objectId);
  // Lot 87D : les recontrôles de titre (COH-DOC-TITLES, service de nommage) sont couverts par
  // l87d-titres-documents.e2e.ts ; ce scénario porte sur les autres contrôles.
  const reparations = (accountId: number) => sql<Json[]>`
    SELECT check_id, object_id::int AS object_id, service, outcome, recheck_verdict, anomaly, rollback_ref, ai_calls, campaign_id::int AS campaign
      FROM coherence_repairs WHERE account_id = ${accountId} AND check_id <> 'COH-DOC-TITLES' ORDER BY id`;
  async function campagne(scope: number[], mode: 'DRY_RUN' | 'CORRECTIVE', kind: 'MANUAL' | 'DAILY' = 'MANUAL', now = new Date()) {
    const o = await orchestrateur();
    const id = await o.startCampaign({ kind, trigger: 'e2e', mode, scopeAccountIds: scope, now });
    for (let i = 0; i < 30; i++) {
      const r = await o.runCampaignStep(id, { deadline: Date.now() + 60_000, now });
      if (r.done) break;
    }
    return (await o.getCampaign(id))!;
  }
  const appelsT1 = () => replay.calls.filter((c) => String(c.operationCode ?? '').startsWith('t1'));

  // ══ L82B-E2E-01 ═══════════════════════════════════════════════════════════

  it('L82B-E2E-01 — objet INCHANGÉ couvert par la campagne du jour : preuve lancée / achevée / réussie, version des règles, couverture vérifiée, mesures', async () => {
    const c = await compte();
    const m = await maison(c);
    const f = await documentFaits(c, m.id, 'Notice de la maison', []);
    const { getCheck, registryVersion } = await import('@/services/coherence/registry');
    const camp = await campagne([c.id], 'CORRECTIVE', 'DAILY');
    expect(camp).toMatchObject({ kind: 'DAILY', status: 'COMPLETE', phase: 'DONE' });
    expect(camp.campaignDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Chaque objet attendu a sa preuve : document (classement — lot 86E —, liens), bien (TCO).
    const p = await preuves(c.id);
    // Lot 87D : + titres (COH-DOC-TITLES), titre déjà contrôlé en fin d'analyse → CONSISTENT.
    expect(p.map((x) => [x.check_id, x.object_id])).toEqual([['COH-DOC-CLASSIFICATION', f], ['COH-DOC-LINKS', f], ['COH-DOC-TITLES', f], ['COH-TCO-EXTRACTED-EXPENSES', m.id]]);
    for (const x of p) {
      expect(x).toMatchObject({ campaign: camp.id, last_trigger: 'DAILY', last_mode: 'CORRECTIVE', last_result: 'CONSISTENT', finding: null, registry_version: registryVersion() });
      expect(x.rules_version).toBe(getCheck(x.check_id)!.version);
      expect(new Date(x.last_started_at).getTime()).toBeLessThanOrEqual(new Date(x.last_completed_at).getTime());
      expect(new Date(x.last_success_at).getTime()).toBe(new Date(x.last_completed_at).getTime());
      expect(new Date(x.last_success_at).getTime()).toBeGreaterThanOrEqual(camp.startedAt.getTime());
    }
    // Couverture vérifiée (phase VERIFY : objets attendus recomptés, aucun restant) et mesures.
    const [row] = await sql<Json[]>`SELECT coverage, metrics, accounts, remaining FROM coherence_campaigns WHERE id = ${camp.id}`;
    expect(row.coverage['COH-DOC-LINKS']).toMatchObject({ expected: 1, remaining: 0, results: { CONSISTENT: 1 } });
    expect(row.coverage['COH-TCO-EXTRACTED-EXPENSES']).toMatchObject({ expected: 1, remaining: 0 });
    expect(row.remaining).toBeNull();
    expect(row.accounts).toMatchObject({ visited: 1, skipped: {} });
    // Lot 86E : + le document au contrôle de classement.
    expect(row.metrics).toMatchObject({ objectsControlled: 4, aiCalls: 0, repairsAttempted: 0 }); // lot 87D : + COH-DOC-TITLES
    expect(row.metrics.runs).toBeGreaterThanOrEqual(1);
    expect(row.metrics.durationMs).toBeGreaterThanOrEqual(0);
    // Le lendemain (nouvelle campagne exhaustive) : les MÊMES objets, inchangés, sont recontrôlés — sans doublon de preuve.
    const camp2 = await campagne([c.id], 'CORRECTIVE');
    const p2 = await preuves(c.id);
    expect(p2).toHaveLength(4); // lot 86E : + COH-DOC-CLASSIFICATION ; lot 87D : + COH-DOC-TITLES
    for (const x of p2) expect(x).toMatchObject({ campaign: camp2.id, last_result: 'CONSISTENT' });
  });

  // ══ L82B-E2E-02 ═══════════════════════════════════════════════════════════

  it('L82B-E2E-02 — changement d’une dépendance (équipement ajouté au bien) → contrôle CIBLÉ du document → lien certain réparé par le service commun', async () => {
    const o = await orchestrateur();
    const c = await compte();
    const m = await maison(c);
    const f = await documentFaits(c, m.id, 'Facture entretien chaudière', [{ key: 'serialNumber', value: 'FR-2020-77881', label: 'N° de série' }]);
    await campagne([c.id], 'CORRECTIVE');
    expect(await preuve(c.id, 'COH-DOC-LINKS', f)).toMatchObject({ last_result: 'CONSISTENT', requested_at: null });
    // Dépendance modifiée : l'équipement désigné apparaît sur le bien.
    const chaudiere = await equipement(m.id, 'Chaudière', { brand: 'Frisquet', serial: 'FR-2020-77881' });
    const t = new Date();
    const demandes = await o.requestTargetedChecks({ accountId: c.id, event: { type: 'ASSET_UPDATED', entityId: m.id }, now: t });
    expect(demandes['COH-DOC-LINKS']).toBe(1);
    expect((await preuve(c.id, 'COH-DOC-LINKS', f))!.requested_at).not.toBeNull();
    // Temporisation : rien avant le délai de regroupement.
    expect((await o.runTargetedChecks({ deadline: Date.now() + 60_000, now: t, mode: 'CORRECTIVE' })).processed).toBe(0);
    const apres = new Date(t.getTime() + o.TARGETED_DEBOUNCE_MS + 1000);
    const r = await o.runTargetedChecks({ deadline: Date.now() + 60_000, now: apres, mode: 'CORRECTIVE' });
    expect(r.results.REPAIRED).toBeGreaterThanOrEqual(1);
    expect(await liensEquipement(f)).toEqual([chaudiere]);
    expect(await preuve(c.id, 'COH-DOC-LINKS', f)).toMatchObject({ last_result: 'REPAIRED', last_trigger: 'TARGETED', requested_at: null, finding: null });
    expect((await reparations(c.id)).filter((x) => x.object_id === f)).toEqual([expect.objectContaining({
      check_id: 'COH-DOC-LINKS', service: 'syncDocumentEquipmentLinks', outcome: 'REPAIRED', recheck_verdict: 'CONSISTENT', ai_calls: 0, campaign: null,
    })]);
  });

  // ══ L82B-E2E-03 ═══════════════════════════════════════════════════════════

  it('L82B-E2E-03 — réparations CERTAINES par les services métier puis recontrôle : carte « À traiter » (réponse dans la connaissance T1), lien équipement, échéance orpheline', async () => {
    const c = await compte();
    const m = await maison(c);
    const chaudiere = await equipement(m.id, 'Chaudière', { brand: 'Frisquet', serial: 'FR-2021-11111' });
    const facture = await documentFaits(c, m.id, 'Facture chaudière', [{ key: 'serialNumber', value: 'FR-2021-11111', label: 'N° de série' }]);
    const contrat = await documentFaits(c, null, 'Contrat d’entretien', [{ key: 'contractEndDate', value: PROCHE }], 'SERVICE_CONTRACT');
    const carte = await carteFinContrat(c, contrat);
    const orpheline = await echeanceOrpheline(c);
    const t1Avant = appelsT1().length;
    const camp = await campagne([c.id], 'CORRECTIVE');
    expect(camp.status).toBe('COMPLETE');
    // Carte : valeur fiable écrite (décision centrale), carte fermée, T1 jamais relancé.
    expect(await carteOuverte(carte)).toBe(false);
    const [v] = await sql<{ v: string }[]>`SELECT value_text AS v FROM document_field_values WHERE file_id = ${contrat} AND field_key = 'contractEndDate'`;
    expect(v.v).toBe(PROCHE);
    expect(appelsT1().length).toBe(t1Avant);
    // Lien équipement certain posé ; échéance orpheline retirée avec TRACE restaurable (jamais « annulée »).
    expect(await liensEquipement(facture)).toEqual([chaudiere]);
    expect(await sql`SELECT id FROM agenda_items WHERE id = ${orpheline}`).toEqual([]);
    expect(await sql`SELECT reason FROM agenda_item_removals WHERE agenda_item_id = ${orpheline}`).toEqual([{ reason: 'ORPHAN_ASSET_FIELD' }]);
    // Preuves et journal : réparé PUIS recontrôlé conforme.
    expect(await preuve(c.id, 'COH-TODO-DOCUMENT-FIELDS', carte)).toMatchObject({ last_result: 'REPAIRED', finding: null });
    expect(await preuve(c.id, 'COH-DOC-LINKS', facture)).toMatchObject({ last_result: 'REPAIRED' });
    expect(await preuve(c.id, 'COH-AGENDA-ORPHANS', orpheline)).toMatchObject({ last_result: 'REPAIRED' });
    const j = await reparations(c.id);
    expect(j.map((x) => [x.check_id, x.service, x.outcome]).sort()).toEqual([
      ['COH-AGENDA-ORPHANS', 'removeAgendaItemsTraced', 'REPAIRED'],
      ['COH-DOC-LINKS', 'syncDocumentEquipmentLinks', 'REPAIRED'],
      ['COH-TODO-DOCUMENT-FIELDS', 'resolveDocumentRuleFromKnowledge', 'REPAIRED'],
    ]);
    expect(j.every((x) => x.campaign === camp.id && ['CONSISTENT', 'GONE'].includes(x.recheck_verdict) && x.rollback_ref)).toBe(true);
    // Aucune action manuelle créée par une correction (C-Q3).
    expect(await sql`SELECT id FROM to_process_actions WHERE account_id = ${c.id} AND resolved_at IS NULL`).toEqual([]);
  });

  // ══ L82B-E2E-04 ═══════════════════════════════════════════════════════════

  it('L82B-E2E-04 — cas AMBIGU (équipements en concurrence, valeurs contradictoires) : aucune écriture, aucune carte, aucun appel IA', async () => {
    const c = await compte();
    const m = await maison(c);
    await equipement(m.id, 'Robot aspirateur', { brand: 'iRobot', model: 'Roomba i7', serial: 'R7-1' });
    await equipement(m.id, 'Robot aspirateur', { brand: 'iRobot', model: 'Roomba i7', serial: 'R7-2' });
    const facture = await documentFaits(c, m.id, 'Facture robot aspirateur', [{ key: 'designation', value: 'Robot aspirateur', label: 'Désignation' }]);
    const contrat = await documentFaits(c, null, 'Contrat', [{ key: 'contractEndDate', value: PROCHE }, { key: 'contractEndDate', value: AUTRE }], 'SERVICE_CONTRACT');
    const carte = await carteFinContrat(c, contrat);
    const appels = replay.calls.length;
    await campagne([c.id], 'CORRECTIVE');
    expect(await liensEquipement(facture)).toEqual([]);
    expect(await sql`SELECT id FROM to_process_actions WHERE account_id = ${c.id} AND rule_code = 'LINK-ELT'`).toEqual([]);
    expect(await carteOuverte(carte)).toBe(true);
    expect(await sql`SELECT 1 FROM document_field_values WHERE file_id = ${contrat} AND field_key = 'contractEndDate'`).toEqual([]);
    expect(replay.calls.length).toBe(appels);
    expect(await preuve(c.id, 'COH-DOC-LINKS', facture)).toMatchObject({ last_result: 'AMBIGUOUS', finding: expect.objectContaining({ anomaly: 'EQUIPMENT_AMBIGUITY' }) });
    expect(await preuve(c.id, 'COH-TODO-DOCUMENT-FIELDS', carte)).toMatchObject({ last_result: 'AMBIGUOUS', finding: expect.objectContaining({ anomaly: 'CONFLICTING_VALUES' }) });
    expect(await reparations(c.id)).toEqual([]);
  });

  // ══ L82B-E2E-05 ═══════════════════════════════════════════════════════════

  it('L82B-E2E-05 — mode À BLANC : constats consignés (WOULD_REPAIR), AUCUNE écriture métier', async () => {
    const c = await compte();
    const m = await maison(c);
    await equipement(m.id, 'Chaudière', { brand: 'Frisquet', serial: 'FR-2022-22222' });
    const facture = await documentFaits(c, m.id, 'Facture chaudière', [{ key: 'serialNumber', value: 'FR-2022-22222', label: 'N° de série' }]);
    const contrat = await documentFaits(c, null, 'Contrat d’entretien', [{ key: 'contractEndDate', value: PROCHE }], 'SERVICE_CONTRACT');
    const carte = await carteFinContrat(c, contrat);
    const orpheline = await echeanceOrpheline(c);
    const photo = async () => ({
      liens: await sql`SELECT id, status FROM document_asset_links WHERE account_id = ${c.id} ORDER BY id`,
      colonnes: await sql`SELECT id, asset_id, equipment_id FROM asset_files WHERE account_id = ${c.id} ORDER BY id`,
      cartes: await sql`SELECT id, resolved_at, proposals_json FROM to_process_actions WHERE account_id = ${c.id} ORDER BY id`,
      valeurs: await sql`SELECT * FROM document_field_values WHERE account_id = ${c.id} ORDER BY id`,
      agenda: await sql`SELECT id, manual_status FROM agenda_items WHERE account_id = ${c.id} ORDER BY id`,
      retraits: await sql`SELECT id FROM agenda_item_removals WHERE account_id = ${c.id}`,
      evaluations: await sql`SELECT id FROM document_rule_evaluations WHERE account_id = ${c.id}`,
    });
    const avant = await photo();
    const camp = await campagne([c.id], 'DRY_RUN');
    expect(camp).toMatchObject({ mode: 'DRY_RUN', status: 'COMPLETE' });
    expect(await photo()).toEqual(avant);
    expect(await reparations(c.id)).toEqual([]);
    for (const [check, id, anomaly] of [['COH-DOC-LINKS', facture, 'CERTAIN_EQUIPMENT_LINK_MISSING'], ['COH-TODO-DOCUMENT-FIELDS', carte, 'ANSWER_AVAILABLE'],
      ['COH-AGENDA-ORPHANS', orpheline, 'ORPHAN_ASSET_FIELD_ITEM']] as const) {
      expect(await preuve(c.id, check, id), check).toMatchObject({ last_result: 'WOULD_REPAIR', last_mode: 'DRY_RUN', finding: expect.objectContaining({ anomaly }) });
    }
  });

  // ══ L82B-E2E-06 ═══════════════════════════════════════════════════════════

  it('L82B-E2E-06 — Agenda 76H : deux représentations de la MÊME occurrence — lot 87B : fusionnées sur décision T4 (journal 0591), jamais par la projection ; sans T4 : constat ; l’intervention distincte reste distincte', async () => {
    const c = await compte();
    const bien = await maison(c);
    const JOUR = '2021-07-07';
    const f = await k.document(c, bien.id, [cand({
      summary: 'Remplacement du ballon d’eau chaude', provider: 'Plomberie Durand', targetHints: [cible(bien.id)],
      businessReferences: [ref('INVOICE', 'F-2021-77')], temporalHints: { realizedDate: JOUR },
    })], { type: 'WORKS_INVOICE', title: 'Prestation', date: JOUR });
    // Autre intervention, autre document, autre date : jamais fusionnée.
    const g = await k.document(c, bien.id, [cand({
      summary: 'Ramonage', provider: 'Ramonage Martin', targetHints: [cible(bien.id)],
      businessReferences: [ref('INVOICE', 'R-2021-12')], temporalHints: { realizedDate: '2021-11-03' },
    })], { type: 'WORKS_INVOICE', title: 'Ramonage', date: '2021-11-03' });
    await k.passer(c);
    const decisions = (fileId: number, date: string) => [
      { action: 'create', title: 'Réparation — Maison', date, category: 'information', confidence: 'certain', reasonCode: 'NEW_EVENT', deterministic: true,
        sourceFileId: fileId, nature: 'HISTORICAL', businessType: 'repair', occurrenceIndex: date, target: { type: 'ASSET', id: bien.id }, sources: [{ fileId, role: 'SOURCE' }] },
      { action: 'create', title: 'Entretien réalisé — Prestation', date, category: 'information', confidence: 'certain', reasonCode: 'NEW_EVENT', deterministic: true,
        sourceFileId: fileId, nature: 'HISTORICAL', businessType: 'maintenance', originFieldKey: 'lastRevision', occurrenceIndex: 'single',
        target: { type: 'ASSET', id: bien.id }, sources: [{ fileId, role: 'SOURCE' }] },
    ] as never[];
    const { persistAgendaDecisions } = await import('@/services/agenda/agenda-persistence');
    await persistAgendaDecisions(decisions(f, JOUR), c.id, bien.id, { sourceFileId: f, analysisComplete: true });
    await persistAgendaDecisions([decisions(g, '2021-11-03')[0]] as never[], c.id, bien.id, { sourceFileId: g, analysisComplete: true });
    const evenements = () => sql<Json[]>`SELECT id, title, start_date::text AS d, business_operation_id::int AS op FROM agenda_items WHERE account_id = ${c.id} ORDER BY id`;
    expect((await evenements()).filter((e) => e.d === JOUR)).toHaveLength(2);
    // Lot 87B (test corrigé) : la fusion n'est plus décidée par la projection (provenance + type + date) — décision T4.
    // a) Contrat T4 multi-événements non livré (production) : constat qualifié, AUCUNE fusion, même en correctif.
    const [op] = (await k.actives(c)).filter((x) => x.realized_date === JOUR);
    await campagne([c.id], 'CORRECTIVE');
    expect(await preuve(c.id, 'COH-AGENDA-OCCURRENCES', op.id)).toMatchObject({ finding: expect.objectContaining({ anomaly: 'REPRESENTATION_DECISION_UNAVAILABLE' }) });
    expect((await evenements()).filter((e) => e.d === JOUR)).toHaveLength(2);
    // b) T4 disponible (fournisseur simulé : même occurrence) : constat à blanc d'abord, puis correction.
    const decideur = await import('@/services/business-operations/semantic/decider');
    decideur.__setRepresentationDeciderForTests({
      capability: async () => ({ available: true, version: 'simule-82b', reason: 'AVAILABLE' }),
      decide: async ({ input }) => {
        const items = input.agendaItems.filter((i) => i.inScope);
        return { traceId: null, output: { task: 'AGENDA_REPRESENTATION', outcome: 'DECIDED', reason: 'simulé', restorations: [],
          occurrences: [{ items: items.map((i) => i.ref), keep: items[0].ref, role: 'PRINCIPAL', confidence: 'certain', evidence: [], reason: 'même occurrence' }] } };
      },
    });
    try {
      await campagne([c.id], 'DRY_RUN');
      expect(await preuve(c.id, 'COH-AGENDA-OCCURRENCES', op.id)).toMatchObject({ last_result: 'WOULD_REPAIR', finding: expect.objectContaining({ anomaly: 'REPRESENTATION_DECISION_REQUIRED' }) });
      await campagne([c.id], 'CORRECTIVE');
      const ev = await evenements();
      expect(ev.filter((e) => e.d === JOUR)).toEqual([expect.objectContaining({ op: op.id })]);
      expect(ev.filter((e) => e.d === '2021-11-03')).toHaveLength(1);
      expect(await preuve(c.id, 'COH-AGENDA-OCCURRENCES', op.id)).toMatchObject({ last_result: 'REPAIRED' });
      const journal = await sql<Json[]>`SELECT kind, correlation_id FROM agenda_intervention_consolidations WHERE account_id = ${c.id} ORDER BY id`;
      expect(journal.map((x) => x.kind)).toContain('ABSORB');
      expect(journal.every((x) => String(x.correlation_id).startsWith('coherence:manual-'))).toBe(true);
      // Rejoué : rien de plus (idempotent), aucune nouvelle consolidation.
      await campagne([c.id], 'CORRECTIVE');
      expect(await sql`SELECT count(*)::int AS n FROM agenda_intervention_consolidations WHERE account_id = ${c.id}`).toEqual([{ n: journal.length }]);
      expect(await preuve(c.id, 'COH-AGENDA-OCCURRENCES', op.id)).toMatchObject({ last_result: 'CONSISTENT' });
    } finally {
      decideur.__setRepresentationDeciderForTests(null);
    }
  });

  // ══ L82B-E2E-07 ═══════════════════════════════════════════════════════════

  it('L82B-E2E-07 — TCO : avis déjà extrait (montant connu) absent du TCO → CONSTAT sans relance T1 ni écriture ; persistant → Supervision existante', async () => {
    const c = await compte();
    const bien = await maison(c);
    const avis = await k.vieuxDocument(c, bien.id, { type: 'PROPERTY_TAX_NOTICE', title: 'Avis d’impôt 2025', amountCents: 123_400, date: '2025-09-01' });
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    const ligne = (await readAssetTco(c.id, bien.id)).lines.find((l) => l.fileId === avis)!;
    expect(ligne).toMatchObject({ status: 'NOT_QUALIFIED', reason: 'THEME_UNKNOWN', amountMinor: 123_400 });
    const appels = replay.calls.length;
    for (let i = 0; i < 3; i++) await campagne([c.id], 'CORRECTIVE');
    expect(replay.calls.length).toBe(appels);
    expect(await preuve(c.id, 'COH-TCO-EXTRACTED-EXPENSES', bien.id)).toMatchObject({
      last_result: 'FINDING', finding_streak: 3,
      finding: expect.objectContaining({ anomaly: 'EXTRACTED_EXPENSE_NOT_EVALUATED', faultyLink: 'T3',
        observed: [expect.objectContaining({ fileId: avis, amountMinor: 123_400 })], detail: expect.objectContaining({ pendingContract: '82B-t3-decision-tco', t1Relaunch: false }) }),
    });
    expect(await reparations(c.id)).toEqual([]);
    // TCO inchangé (aucune écriture arbitraire).
    expect((await readAssetTco(c.id, bien.id)).lines.find((l) => l.fileId === avis)).toMatchObject({ status: 'NOT_QUALIFIED' });
    // Constat persistant : UNE anomalie agrégée par contrôle dans la Supervision existante, jamais une carte.
    const { syncCoherenceSupervision } = await import('@/services/coherence/supervision');
    await syncCoherenceSupervision({ now: new Date() });
    const [a] = await sql<Json[]>`SELECT domain, status, title, technical_detail AS detail FROM admin_anomalies WHERE fingerprint = 'other:coherence:coh-tco-extracted-expenses:persistent'`;
    expect(a).toMatchObject({ domain: 'other', status: 'open' });
    expect(String(a.detail.accountIds)).toContain(String(c.id));
    expect(await sql`SELECT id FROM to_process_actions WHERE account_id = ${c.id}`).toEqual([]);
  });

  // ══ L82B-E2E-08 ═══════════════════════════════════════════════════════════

  it('L82B-E2E-08 — idempotence : second passage correctif sans réparation, sans doublon de preuve ni de journal', async () => {
    const c = await compte();
    const m = await maison(c);
    await equipement(m.id, 'Chaudière', { brand: 'Frisquet', serial: 'FR-2023-33333' });
    await documentFaits(c, m.id, 'Facture chaudière', [{ key: 'serialNumber', value: 'FR-2023-33333', label: 'N° de série' }]);
    await echeanceOrpheline(c);
    await campagne([c.id], 'CORRECTIVE');
    const p1 = await preuves(c.id);
    const j1 = await reparations(c.id);
    expect(j1).toHaveLength(2);
    const liens1 = await sql`SELECT id, status FROM document_asset_links WHERE account_id = ${c.id} ORDER BY id`;
    await campagne([c.id], 'CORRECTIVE');
    expect(await reparations(c.id)).toEqual(j1);
    expect(await sql`SELECT id, status FROM document_asset_links WHERE account_id = ${c.id} ORDER BY id`).toEqual(liens1);
    const p2 = await preuves(c.id);
    // Une preuve par objet × contrôle, jamais de doublon ; l'échéance retirée garde sa preuve « réparée ».
    expect(p2.map((x) => [x.check_id, x.object_id])).toEqual(p1.map((x) => [x.check_id, x.object_id]));
    expect(p2.filter((x) => x.check_id !== 'COH-AGENDA-ORPHANS').every((x) => x.last_result === 'CONSISTENT')).toBe(true);
    expect(p2.find((x) => x.check_id === 'COH-AGENDA-ORPHANS')).toMatchObject({ last_result: 'REPAIRED' });
  });

  // ══ L82B-E2E-09 ═══════════════════════════════════════════════════════════

  it('L82B-E2E-09 — campagne interrompue reprise au curseur ; échéance dépassée ou objet en échec persistant : PARTIAL, jamais exhaustive', async () => {
    const o = await orchestrateur();
    const c = await compte();
    const biens = [await maison(c), await maison(c), await maison(c)];
    for (const b of biens) await documentFaits(c, b.id, `Notice ${b.id}`, []);
    // 1. Interruption : passage sans budget, puis reprise jusqu'au bout.
    const id = await o.startCampaign({ kind: 'MANUAL', trigger: 'e2e', mode: 'CORRECTIVE', scopeAccountIds: [c.id] });
    const r0 = await o.runCampaignStep(id, { deadline: Date.now() - 1 });
    expect(r0).toMatchObject({ status: 'RUNNING', done: false, controlled: 0 });
    for (let i = 0; i < 30 && !(await o.runCampaignStep(id, { deadline: Date.now() + 60_000 })).done; i++) { /* reprise */ }
    expect(await o.getCampaign(id)).toMatchObject({ status: 'COMPLETE' });
    // 3 documents × (liens, classement — lot 86E —, titres — lot 87D) + 3 biens (TCO).
    expect((await preuves(c.id)).filter((x) => x.campaign === id)).toHaveLength(12);
    // 2. Échéance dépassée avant la fin : PARTIAL (reste consigné), jamais COMPLETE.
    const passe = await o.startCampaign({ kind: 'MANUAL', trigger: 'e2e', mode: 'CORRECTIVE', scopeAccountIds: [c.id], deadlineAt: new Date(Date.now() - 1000) });
    const r1 = await o.runCampaignStep(passe, { deadline: Date.now() + 60_000 });
    expect(r1).toMatchObject({ status: 'PARTIAL', done: true });
    const [x1] = await sql<Json[]>`SELECT status, remaining FROM coherence_campaigns WHERE id = ${passe}`;
    expect(x1).toMatchObject({ status: 'PARTIAL', remaining: expect.objectContaining({ reason: 'DEADLINE_REACHED' }) });
    // 3. Un objet dont le contrôle échoue (lecture impossible) : jamais « conforme », repris en vérification, campagne PARTIAL.
    const { tcoExtractedExpensesCheck } = await import('@/services/coherence/registry/checks/tco');
    const original = tcoExtractedExpensesCheck.inspect!.bind(tcoExtractedExpensesCheck);
    type Inspect = NonNullable<typeof tcoExtractedExpensesCheck.inspect>;
    const espion = vi.spyOn(tcoExtractedExpensesCheck as { inspect: Inspect }, 'inspect').mockImplementation(async (ctx, accountId, ids) => {
      if (ids.includes(biens[1].id)) throw new Error('lecture TCO PARTIAL (e2e)');
      return original(ctx, accountId, ids);
    });
    try {
        const camp = await campagne([c.id], 'CORRECTIVE');
        expect(camp.status).toBe('PARTIAL');
        const [x2] = await sql<Json[]>`SELECT coverage, remaining FROM coherence_campaigns WHERE id = ${camp.id}`;
        expect(x2.remaining).toMatchObject({ reason: 'OBJECTS_STILL_FAILING', failingObjects: 1 });
        expect(x2.coverage['COH-TCO-EXTRACTED-EXPENSES']).toMatchObject({ expected: 3, remaining: 1 });
        const p = await preuve(c.id, 'COH-TCO-EXTRACTED-EXPENSES', biens[1].id);
        expect(p).toMatchObject({ last_result: 'ERROR', campaign: camp.id });
        // Lancé, achevé, mais PAS réussi pendant cette campagne.
        expect(new Date(p!.last_success_at).getTime()).toBeLessThan(camp.startedAt.getTime());
        expect(await preuve(c.id, 'COH-TCO-EXTRACTED-EXPENSES', biens[0].id)).toMatchObject({ last_result: 'CONSISTENT' });
    } finally {
      espion.mockRestore();
    }
  });

  // ══ L82B-E2E-10 ═══════════════════════════════════════════════════════════

  it('L82B-E2E-10 — maintenance remplacée : l’échéance orpheline n’est plus « annulée » par une maintenance horaire ; une seule chaîne la traite (retrait tracé)', async () => {
    const { dailyTasks } = await import('@/services/scheduling/daily-maintenance-scheduler');
    expect(dailyTasks({} as NodeJS.ProcessEnv).map((t) => t.lock)).not.toContain('hourly-coherence-maintenance');
    const { SCHEDULED_TASKS } = await import('@/services/scheduling/scheduled-tasks.catalog');
    expect(SCHEDULED_TASKS.filter((t) => /^coherence|agenda-intervention-duplicates/.test(t.code)).map((t) => t.code)).toEqual(['coherence-control']);
    const reprise = await import('@/services/business-operations/agenda-projection/duplicates-reprise');
    expect('runAutomaticAgendaDuplicatesReprise' in reprise).toBe(false);
    const c = await compte();
    const orpheline = await echeanceOrpheline(c);
    // Élément modifié par l'utilisateur : son choix — jamais retiré, jamais « annulé ».
    const [{ id: touche }] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, is_automatic_modified, origin_type) VALUES (${c.id}, 'Vidange', ${PROCHE}, true, true, 'asset_field') RETURNING id`;
    await campagne([c.id], 'CORRECTIVE');
    await campagne([c.id], 'CORRECTIVE');
    expect(await sql`SELECT agenda_item_id, reason FROM agenda_item_removals WHERE account_id = ${c.id}`).toEqual([{ agenda_item_id: orpheline, reason: 'ORPHAN_ASSET_FIELD' }]);
    expect(await sql`SELECT id, manual_status FROM agenda_items WHERE account_id = ${c.id}`).toEqual([{ id: touche, manual_status: null }]);
    expect((await reparations(c.id)).map((x) => x.check_id)).toEqual(['COH-AGENDA-ORPHANS']);
  });

  // ══ L82B-E2E-11 ═══════════════════════════════════════════════════════════

  it('L82B-E2E-11 — compte non éligible (sans abonnement / essai échu, suspendu) : jamais contrôlé, même en constat ; réactivation → rattrapage exhaustif', async () => {
    const o = await orchestrateur();
    const lectureSeule = await make.account({ plan: null });
    const essaiEchu = await make.account({ plan: null });
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at) VALUES (${essaiEchu.id}, 'premium', 'trialing', now() - interval '1 day')`;
    const suspendu = await compte();
    await sql`UPDATE accounts SET is_active = false WHERE id = ${suspendu.id}`;
    for (const x of [lectureSeule, essaiEchu, suspendu]) await echeanceOrpheline(x);
    const camp = await campagne([lectureSeule.id, essaiEchu.id, suspendu.id], 'CORRECTIVE');
    expect(camp.status).toBe('COMPLETE');
    expect(camp.accounts).toMatchObject({ visited: 0, skipped: { NO_SUBSCRIPTION: 1, TRIAL_EXPIRED: 1, ACCOUNT_SUSPENDED: 1 } });
    for (const x of [lectureSeule, essaiEchu, suspendu]) {
      expect(await preuves(x.id)).toEqual([]);
      expect(await sql`SELECT id FROM agenda_items WHERE account_id = ${x.id}`).toHaveLength(1);
      expect(await o.requestTargetedChecks({ accountId: x.id, event: { type: 'AGENDA_ITEM_CREATED', entityId: 1 } })).toEqual({});
    }
    // Réactivation (souscription) : rattrapage exhaustif du compte, prioritaire.
    await sql`UPDATE account_subscriptions SET status = 'active', first_billed_at = now() WHERE account_id = ${essaiEchu.id}`;
    // Étape de reprise au contrat de 82A (`registerAccountReactivationStep('catchup-control', …)` à l'intégration).
    const etape = await o.coherenceCatchupReactivationStep({ accountId: essaiEchu.id, source: 'e2e', now: new Date() });
    const ratt = Number(etape.coherenceCatchupCampaignId);
    expect(await o.requestCoherenceCatchup({ accountId: essaiEchu.id, reason: 'e2e-bis' })).toBe(ratt);
    for (let i = 0; i < 30 && !(await o.runCampaignStep(ratt!, { deadline: Date.now() + 60_000 })).done; i++) { /* reprise */ }
    expect(await o.getCampaign(ratt!)).toMatchObject({ kind: 'CATCHUP', status: 'COMPLETE', scope: [essaiEchu.id] });
    expect((await preuves(essaiEchu.id)).map((p) => p.check_id)).toEqual(['COH-AGENDA-ORPHANS']);
  });

  // ══ L82B-E2E-12 ═══════════════════════════════════════════════════════════

  it('L82B-E2E-12 — déclencheurs : un événement métier (bus existant) enregistre DURABLEMENT la demande de contrôle ciblé des objets dépendants', async () => {
    const c = await compte();
    const m = await maison(c);
    const f = await documentFaits(c, m.id, 'Facture', []);
    const { registerCoherenceTriggers, __resetCoherenceTriggersForTests } = await import('@/services/coherence/events');
    const bus = await import('@/services/verebona-assistant/events/business-events');
    await registerCoherenceTriggers();
    try {
        await bus.emitBusinessEvent({ type: 'DOCUMENT_UPDATED', accountId: c.id, entityId: f });
        let p: Json | undefined;
        for (let i = 0; i < 50 && !(p = await preuve(c.id, 'COH-DOC-LINKS', f))?.requested_at; i++) await new Promise((r) => setTimeout(r, 50));
        expect(p).toMatchObject({ object_type: 'document' });
        expect(p!.requested_at).not.toBeNull();
        expect((await preuve(c.id, 'COH-TCO-EXTRACTED-EXPENSES', m.id))?.requested_at).not.toBeNull();
    } finally {
      bus.resetBusinessEventsForTests();
      (await import('@/services/ai/source-analysis/events')).clearSourceAnalyzedHandlers();
      __resetCoherenceTriggersForTests();
    }
  });

  afterAll(() => { vi.restoreAllMocks(); });
});
