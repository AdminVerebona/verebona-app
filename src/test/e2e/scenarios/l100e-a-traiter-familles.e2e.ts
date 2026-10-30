/**
 * Lot 100E — décisions PO A7 (règles « À traiter » généralisées à TOUTES les
 * familles, deux conditions cumulatives), A6 (passage automatique au
 * correctif) et point D (nettoyage par le moteur de cohérence sans masquer le
 * technique ni écraser les modifications manuelles), sur PostgreSQL 16 réel.
 * Aucun appel IA : familles « état » (agenda, équipements, fournisseurs),
 * documents, événements de référence, règle non déclarée.
 *
 *  L100E-E2E-01  chaque famille : carte UTILE → visible ; carte techniquement bloquée → retenue (page, compteur), Supervision
 *  L100E-E2E-02  modification manuelle de l'utilisateur → carte masquée aussitôt, puis campagne À BLANC (rien d'écrit) puis
 *                CORRECTIVE : fermée par le service de sa famille, valeur de l'utilisateur intacte ; second passage : rien (idempotent) ;
 *                carte « Non applicable » jamais rouverte ; blocage technique jamais fermé ; création refusée si déjà inutile
 *  L100E-E2E-03  A6 — mode AUTO : nouveau contrôle À BLANC dans la première campagne corrective, correctif à la suivante
 */
import { afterEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { useTargetState } from '../chain';
import { proofOf, runCoherenceFor } from '../coherence-run';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
const CHECK = 'COH-TODO-PUBLISHABILITY';

scenario('L100E-A-TRAITER-FAMILLES', '« À traiter » : publiabilité de toutes les familles, nettoyage rétroactif (lot 100E, A6 / A7 / D)', ({ sql, make }) => {
  useTargetState({}, { masters: ['T1', 'T4'], t4Responder: null });
  afterEach(() => { delete process.env.COHERENCE_CAMPAIGN_MODE; });

  const producteurs = async () => import('@/services/to-process/producers.service');
  const carteDe = async (type: string, targetId: number, rule: string) => (await sql<Array<{ id: number; open: boolean; reason: string | null }>>`
    SELECT id, resolved_at IS NULL AS open, resolution_reason AS reason FROM to_process_actions
     WHERE target_type = ${type} AND target_id = ${targetId} AND rule_code = ${rule} ORDER BY id DESC LIMIT 1`)[0] ?? null;
  /** Ce que voit l'utilisateur : page, compteur, pastille (même définition « publiable »). */
  const vu = async (compte: Compte) => {
    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    const { countActiveActions } = await import('@/services/to-process/to-process-action.service');
    const page = await getToProcessPage(compte.id);
    return { regles: page.actions.map((a) => a.ruleCode).sort(), total: page.total, pastille: await countActiveActions(compte.id) };
  };
  /** Dernière décision de famille simulée (panne de lecture, report) — même table que la production (0516). */
  const decision = async (compte: Compte, type: string, targetId: number, rule: string, outcome: string, effect: string, reason = 'E2E') => {
    await sql`INSERT INTO to_process_decisions (account_id, target_type, target_id, rule_code, data_key, trigger_code, engine_version, outcome, reason_code, effect, signature)
              VALUES (${compte.id}, ${type}, ${targetId}, ${rule}, 'k', 'SWEEP', 'atp-admissibility-v1', ${outcome}, ${reason}, ${effect}, ${`e2e-${Date.now()}-${Math.random()}`})`;
  };
  const fournisseur = async (compte: Compte, nom: string) => (await sql<{ id: number }[]>`
    INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name) VALUES (${compte.id}, ${compte.ownerUserId}, ${nom}, ${nom.toLowerCase()}) RETURNING id`)[0].id;
  const revue = async (compte: Compte, nom: string) => (await sql<{ id: number }[]>`
    INSERT INTO supplier_review_items (account_id, item_type, status, supplier_id, detected_name, current_value, detected_value)
    VALUES (${compte.id}, 'identity', 'open', ${await fournisseur(compte, nom)}, ${`${nom} Services`}, ${nom}, ${`${nom} Services`}) RETURNING supplier_id AS id`)[0].id;
  /** Équipement resté sur un bien supprimé, le compte ayant un autre bien vivant : question utile (LINK-EQUIP-ASSET). */
  const equipementOrphelin = async (compte: Compte, nom: string) => {
    const supprime = await make.asset(compte);
    await sql`UPDATE assets SET deleted_at = now() WHERE id = ${supprime.id}`;
    return (await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${supprime.id}, ${nom}) RETURNING id`)[0].id;
  };
  const upsert = async (p: Record<string, unknown>) => (await import('@/services/to-process/to-process-action.service')).upsertAction(p as never);

  // ══════════════════════════════════════════════════════════════════════

  it('L100E-E2E-01 — chaque famille : carte utile visible ; blocage technique retenu (ni page, ni compteur) et signalé en Supervision', async () => {
    const compte = await make.account();
    await make.asset(compte); // bien vivant : un équipement orphelin peut y être rattaché
    const p = await producteurs();
    // Agenda : deux événements saisis sans date.
    const utile = await make.agendaItem(compte, { title: 'Révision chaudière' });
    const bloque = await make.agendaItem(compte, { title: 'Contrôle technique' });
    // Équipements, fournisseurs.
    const eqUtile = await equipementOrphelin(compte, 'Climatiseur');
    const eqBloque = await equipementOrphelin(compte, 'Pompe');
    const frUtile = await revue(compte, 'Acme');
    const frBloque = await revue(compte, 'Bolt');
    await p.produceAgendaActions(compte.id);
    await p.produceEquipmentActions(compte.id);
    await p.produceSupplierActions(compte.id);
    for (const [t, id, r] of [['AGENDA_ITEM', utile.id, 'DATA-AGENDA-DATE'], ['AGENDA_ITEM', bloque.id, 'DATA-AGENDA-DATE'], ['EQUIPMENT', eqUtile, 'LINK-EQUIP-ASSET'],
      ['EQUIPMENT', eqBloque, 'LINK-EQUIP-ASSET'], ['SUPPLIER', frUtile, 'SUPPLIER-IDENTITY'], ['SUPPLIER', frBloque, 'SUPPLIER-IDENTITY']] as const) {
      expect(await carteDe(t, id, r), `${r} ${id}`).toMatchObject({ open: true });
    }
    // Événement de référence : question de montant sur une réalité vivante (utile).
    const bien = await make.asset(compte);
    const f = await make.assetFile(compte, { assetId: bien.id });
    const [{ id: op }] = await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, status) VALUES (${compte.id}, 'REALIZED') RETURNING id`;
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, relation_key, action_kind, rule_code, question, trigger_context)
              VALUES (${compte.id}, 'DOCUMENT', ${f.id}, ${`operationAmount:${op}:e2e`}, 'ARBITRATE', 'OPERATION-AMOUNT', 'Quel montant retenir ?', ${JSON.stringify({ operationId: op })}::jsonb)`;
    expect((await vu(compte)).total).toBe(7);

    // Blocages TECHNIQUES : lecture en erreur (agenda, équipement), décision différée qui garde la carte (fournisseur).
    await decision(compte, 'AGENDA_ITEM', bloque.id, 'DATA-AGENDA-DATE', 'ERROR', 'ERROR', 'READ_FAILED:e2e');
    await decision(compte, 'EQUIPMENT', eqBloque, 'LINK-EQUIP-ASSET', 'AUTO_RESOLVED', 'ERROR');
    await decision(compte, 'SUPPLIER', frBloque, 'SUPPLIER-IDENTITY', 'DEFER', 'KEPT', 'QUALIFICATION_PENDING');
    // Code HORS catalogue (carte héritée) : contrat commun par défaut — montrée, sauf blocage technique tracé.
    // (Une règle DU catalogue sans contrat est signalée par L100E-U-CONTRACT et retenue : RULE_NOT_DECLARED.)
    const [{ id: futur }] = await sql<{ id: number }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
      VALUES (${compte.id}, 'DOCUMENT', ${f.id}, 'futur', 'COMPLETE', 'FUTURE-FAMILY-RULE', 'Question future ?') RETURNING id`;

    expect(await vu(compte)).toEqual({ regles: ['DATA-AGENDA-DATE', 'FUTURE-FAMILY-RULE', 'LINK-EQUIP-ASSET', 'OPERATION-AMOUNT', 'SUPPLIER-IDENTITY'], total: 5, pastille: 5 });
    // Les cartes retenues restent OUVERTES (rien de perdu).
    expect(await carteDe('AGENDA_ITEM', bloque.id, 'DATA-AGENDA-DATE')).toMatchObject({ open: true });
    // Supervision : une alerte par cause, familles nommées simplement.
    const { heldCardsOverview } = await import('@/services/to-process/publishability');
    const groupes = await heldCardsOverview({ accountId: compte.id });
    expect(groupes.find((g) => g.cause === 'EVALUATION_ERROR')).toMatchObject({ count: 2, families: ['agenda', 'équipements'] });
    expect(groupes.find((g) => g.cause === 'DECISION_DEFERRED')).toMatchObject({ count: 1, families: ['fournisseurs'] });
    expect(groupes.find((g) => g.cause === 'RULE_NOT_DECLARED')).toBeUndefined();
    const { computeCoherenceAlerts } = await import('@/services/coherence/supervision');
    const alertes = await computeCoherenceAlerts(new Date());
    for (const c of ['evaluation_error', 'decision_deferred']) {
      const a = alertes.find((x) => x.fingerprint === `other:coherence:a-traiter-retenues:${c}`);
      expect(a, c).toBeDefined();
      expect(String(a!.detail.accountIds)).toContain(String(compte.id));
    }
    // Campagne de cohérence : blocage technique délégué à la nouvelle tentative de la famille (jamais fermé).
    await runCoherenceFor(sql, [compte.id], { mode: 'DRY_RUN' });
    expect(await proofOf(sql, compte.id, CHECK, futur)).toMatchObject({ last_result: 'CONSISTENT' });
    const pb = await proofOf(sql, compte.id, CHECK, (await carteDe('AGENDA_ITEM', bloque.id, 'DATA-AGENDA-DATE'))!.id);
    expect(pb).toMatchObject({ last_result: 'CONSISTENT' });
    expect(await proofOf(sql, compte.id, 'COH-TODO-RELEVANCE-CARDS', (await carteDe('AGENDA_ITEM', bloque.id, 'DATA-AGENDA-DATE'))!.id))
      .toMatchObject({ last_result: 'WOULD_REPAIR' });
    // Nouvelle tentative BO (cause levée : la lecture réussit) : la carte d'agenda redevient visible ; le report persiste.
    const { retryHeldCards } = await import('@/services/to-process/publishability');
    const essai = await retryHeldCards({ accountId: compte.id });
    expect(essai.errors).toBe(0);
    expect((await vu(compte)).regles.filter((r) => r === 'DATA-AGENDA-DATE')).toHaveLength(2);
  });

  it('L100E-E2E-02 — modification manuelle : carte masquée aussitôt ; campagne à blanc puis corrective ; valeur de l’utilisateur intacte ; idempotent', async () => {
    const compte = await make.account();
    const vivant = await make.asset(compte);
    const p = await producteurs();
    const item = await make.agendaItem(compte, { title: 'Ramonage' });
    const statut = await make.agendaItem(compte, { title: 'Entretien annuel', startDate: '2026-09-01' });
    const eq = await equipementOrphelin(compte, 'Chauffe-eau');
    const fr = await revue(compte, 'Delta');
    const garde = await make.agendaItem(compte, { title: 'Vidange' });
    const technique = await make.agendaItem(compte, { title: 'Contrôle gaz' });
    await p.produceAgendaActions(compte.id);
    await p.produceEquipmentActions(compte.id);
    await p.produceSupplierActions(compte.id);
    // Carte de statut d'agenda (« réalisé ? ») et lien document → équipement proposé.
    const { proposeAgendaStatus } = await import('@/services/to-process/agenda-status-cards');
    expect((await proposeAgendaStatus({ accountId: compte.id, itemId: statut.id, kind: 'propose_done', sourceFileId: null })).status).toBe('CREATED');
    const f = await make.assetFile(compte, { assetId: vivant.id });
    // Statut du bien proposé (« vendu ? ») : l'utilisateur le change lui-même ensuite.
    expect((await upsert({ accountId: compte.id, targetType: 'ASSET', targetId: vivant.id, fieldKey: 'status', actionKind: 'ARBITRATE', ruleCode: 'ASSET-STATUS',
      proposals: [{ value: 'VENDU', label: 'Vendu', confidence: 0.8 }, { value: 'EN_SERVICE', label: 'Inchangé : en service', confidence: 0, isCurrentValue: true }] })).status).toBe('CREATED');
    // Événement de référence fusionné depuis : délégué au contrôle de sa famille.
    const [{ id: op }] = await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, status) VALUES (${compte.id}, 'REALIZED') RETURNING id`;
    const [{ id: op2 }] = await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, status) VALUES (${compte.id}, 'REALIZED') RETURNING id`;
    const [{ id: carteOp }] = await sql<{ id: number }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, relation_key, action_kind, rule_code, question, trigger_context)
      VALUES (${compte.id}, 'DOCUMENT', ${f.id}, ${`operationAmount:${op}:e2e`}, 'ARBITRATE', 'OPERATION-AMOUNT', 'Quel montant retenir ?', ${JSON.stringify({ operationId: op })}::jsonb) RETURNING id`;
    // L'utilisateur avait déclaré « Non applicable » une carte de « Vidange » : jamais rouverte par le nettoyage.
    const cGarde = (await carteDe('AGENDA_ITEM', garde.id, 'DATA-AGENDA-DATE'))!;
    await sql`UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'NOT_APPLICABLE' WHERE id = ${cGarde.id}`;
    // Blocage technique sur « Contrôle gaz » (lecture en erreur) PUIS date toujours absente : jamais fermé par ce contrôle.
    await decision(compte, 'AGENDA_ITEM', technique.id, 'DATA-AGENDA-DATE', 'ERROR', 'ERROR', 'READ_FAILED:e2e');
    expect((await vu(compte)).regles).toEqual(['AGENDA-DONE', 'ASSET-STATUS', 'DATA-AGENDA-DATE', 'LINK-EQUIP-ASSET', 'OPERATION-AMOUNT', 'SUPPLIER-IDENTITY']);

    // ── Modifications MANUELLES de l'utilisateur, ailleurs que sur la carte ──
    await sql`UPDATE agenda_items SET start_date = '2026-12-02' WHERE id = ${item.id}`;
    await sql`UPDATE agenda_items SET manual_status = 'realise' WHERE id = ${statut.id}`;
    await sql`UPDATE equipments SET asset_id = ${vivant.id} WHERE id = ${eq}`;
    await sql`UPDATE supplier_review_items SET status = 'resolved', resolved_at = now() WHERE supplier_id = ${fr}`;
    await sql`UPDATE assets SET status = 'VENDU' WHERE id = ${vivant.id}`;
    await sql`UPDATE business_operations SET merged_into_operation_id = ${op2}, invalidated_at = now(), invalidation_reason = 'MERGED' WHERE id = ${op}`;
    // Réévaluation AVANT AFFICHAGE : plus rien à demander (la carte « technique » reste retenue, invisible).
    expect(await vu(compte)).toEqual({ regles: [], total: 0, pastille: 0 });
    // Création / conservation refusées : la réponse est déjà connue.
    expect(await upsert({ accountId: compte.id, targetType: 'AGENDA_ITEM', targetId: item.id, fieldKey: 'date', actionKind: 'COMPLETE', ruleCode: 'DATA-AGENDA-DATE' }))
      .toMatchObject({ status: 'SKIPPED', code: 'NO_LONGER_USEFUL' });

    const cibles = {
      agenda: (await carteDe('AGENDA_ITEM', item.id, 'DATA-AGENDA-DATE'))!.id,
      statut: (await carteDe('AGENDA_ITEM', statut.id, 'AGENDA-DONE'))!.id,
      equipement: (await carteDe('EQUIPMENT', eq, 'LINK-EQUIP-ASSET'))!.id,
      fournisseur: (await carteDe('SUPPLIER', fr, 'SUPPLIER-IDENTITY'))!.id,
      bien: (await carteDe('ASSET', vivant.id, 'ASSET-STATUS'))!.id,
    };

    // ── Campagne À BLANC : détecté, rien d'écrit ──
    await runCoherenceFor(sql, [compte.id], { mode: 'DRY_RUN' });
    for (const [famille, id] of Object.entries(cibles)) {
      expect(await proofOf(sql, compte.id, CHECK, id), famille).toMatchObject({ last_result: 'WOULD_REPAIR' });
      expect((await sql<{ open: boolean }[]>`SELECT resolved_at IS NULL AS open FROM to_process_actions WHERE id = ${id}`)[0].open, famille).toBe(true);
    }
    // Événement de référence fusionné : délégué au contrôle de SA famille (une anomalie = une chaîne).
    expect(await proofOf(sql, compte.id, CHECK, carteOp)).toMatchObject({ last_result: 'CONSISTENT' });
    expect(await proofOf(sql, compte.id, 'COH-TODO-OPERATION-CARDS', carteOp)).toMatchObject({ last_result: 'WOULD_REPAIR' });

    // ── Campagne CORRECTIVE : fermées par le service de leur famille, tracées ──
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE' });
    const ferme = async (id: number) => (await sql<Array<{ open: boolean; reason: string | null }>>`
      SELECT resolved_at IS NULL AS open, resolution_reason AS reason FROM to_process_actions WHERE id = ${id}`)[0];
    expect(await ferme(cibles.agenda)).toEqual({ open: false, reason: 'OBSOLETE' });
    expect(await ferme(cibles.statut)).toEqual({ open: false, reason: 'USER_COMPLETED' });
    expect(await ferme(cibles.equipement)).toEqual({ open: false, reason: 'OBSOLETE' });
    expect(await ferme(cibles.fournisseur)).toEqual({ open: false, reason: 'OBSOLETE' });
    expect(await ferme(cibles.bien)).toEqual({ open: false, reason: 'OBSOLETE' });
    const reps = await sql<Array<{ object_id: number; outcome: string; service: string; recheck_verdict: string }>>`
      SELECT object_id, outcome, service, recheck_verdict FROM coherence_repairs WHERE account_id = ${compte.id} AND check_id = ${CHECK} ORDER BY id`;
    expect(reps.map((r) => r.service).sort()).toEqual(['closeAgendaStatusCards', 'closeCardsNoLongerUseful', 'produceAgendaActions', 'produceEquipmentActions', 'produceSupplierActions']);
    expect(reps.every((r) => r.outcome === 'REPAIRED' && ['GONE', 'CONSISTENT'].includes(r.recheck_verdict))).toBe(true);
    const [ev] = await sql<Array<{ details: Record<string, unknown> }>>`SELECT details FROM to_process_action_events WHERE action_id = ${cibles.bien} AND event = 'OBSOLETE'`;
    expect(ev.details).toMatchObject({ ruleCode: 'ASSET-STATUS', reason: 'STATUS_CHANGED_SINCE', source: 'A7_PUBLISHABILITY' });
    // Valeurs de l'UTILISATEUR intactes (aucune écriture de l'objet).
    expect((await sql`SELECT to_char(start_date, 'YYYY-MM-DD') AS d FROM agenda_items WHERE id = ${item.id}`)[0].d).toBe('2026-12-02');
    expect((await sql`SELECT manual_status AS s FROM agenda_items WHERE id = ${statut.id}`)[0].s).toBe('realise');
    expect((await sql`SELECT asset_id AS a FROM equipments WHERE id = ${eq}`)[0].a).toBe(vivant.id);
    expect((await sql`SELECT status AS s FROM assets WHERE id = ${vivant.id}`)[0].s).toBe('VENDU');
    // « Non applicable » jamais rouvert ; blocage technique jamais fermé par le nettoyage (retenté par sa famille).
    expect(await ferme(cGarde.id)).toEqual({ open: false, reason: 'NOT_APPLICABLE' });
    const cTechnique = (await carteDe('AGENDA_ITEM', technique.id, 'DATA-AGENDA-DATE'))!;
    expect(cTechnique.open).toBe(true);
    expect(reps.some((r) => Number(r.object_id) === cTechnique.id)).toBe(false);

    // ── Second passage : idempotent (aucune nouvelle réparation, rien rouvert) ──
    await runCoherenceFor(sql, [compte.id], { mode: 'CORRECTIVE' });
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM coherence_repairs WHERE account_id = ${compte.id} AND check_id = ${CHECK}`;
    expect(n).toBe(reps.length);
    for (const id of Object.values(cibles)) expect((await ferme(id)).open).toBe(false);
  });

  it('L100E-E2E-03 — A6, mode AUTO : nouveau contrôle à blanc dans la première campagne corrective, puis correctif', async () => {
    delete process.env.COHERENCE_CAMPAIGN_MODE;
    const orch = await import('@/services/coherence/orchestrator');
    const compte = await make.account();
    const item = await make.agendaItem(compte, { title: 'Purge radiateurs' });
    await (await producteurs()).produceAgendaActions(compte.id);
    const carte = (await carteDe('AGENDA_ITEM', item.id, 'DATA-AGENDA-DATE'))!;
    await sql`UPDATE agenda_items SET start_date = '2031-01-15' WHERE id = ${item.id}`;
    const quotidienne = async (jour: string, mode?: 'DRY_RUN') => {
      const now = new Date(`${jour}T10:00:00Z`);
      const id = await orch.startCampaign({ kind: 'DAILY', trigger: 'e2e-100e', ...(mode ? { mode } : {}), scopeAccountIds: [compte.id], now });
      for (let i = 0; i < 40; i++) if ((await orch.runCampaignStep(id, { deadline: Date.now() + 120_000, now })).done) break;
      return (await orch.getCampaign(id))!;
    };
    // Première campagne quotidienne À BLANC aboutie (C-Q5) — antérieure au contrôle du lot 100E (simulé : il n'y figurait pas).
    const blanc = await quotidienne('2031-03-01', 'DRY_RUN');
    expect(blanc.status).toBe('COMPLETE');
    await sql`UPDATE coherence_campaigns SET checks = (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements(checks) x WHERE x->>'id' <> ${CHECK})
               WHERE kind = 'DAILY'`;
    // Campagne suivante (AUTO → corrective) : le contrôle NON QUALIFIÉ reste À BLANC ; les autres sont correctifs.
    const j1 = await quotidienne('2031-03-02');
    expect(j1.mode).toBe('CORRECTIVE');
    expect(j1.status).toBe('COMPLETE');
    expect(j1.checks.find((c) => c.id === CHECK)).toMatchObject({ dryRun: true });
    expect(j1.checks.find((c) => c.id === 'COH-TODO-ORPHAN-CARDS')?.dryRun).toBeUndefined();
    expect(await proofOf(sql, compte.id, CHECK, carte.id)).toMatchObject({ last_result: 'WOULD_REPAIR', last_mode: 'DRY_RUN' });
    expect((await carteDe('AGENDA_ITEM', item.id, 'DATA-AGENDA-DATE'))!.open).toBe(true);
    // Campagne d'après : contrôle qualifié (passage à blanc complet) → correctif, carte fermée.
    const j2 = await quotidienne('2031-03-03');
    expect(j2.checks.find((c) => c.id === CHECK)?.dryRun).toBeUndefined();
    expect((await carteDe('AGENDA_ITEM', item.id, 'DATA-AGENDA-DATE'))).toMatchObject({ open: false, reason: 'OBSOLETE' });
    // Coupure d'urgence : retour à blanc sans validation quotidienne du PO.
    process.env.COHERENCE_CAMPAIGN_MODE = 'dry_run';
    expect(await orch.resolveCoherenceMode()).toBe('DRY_RUN');
  });
});
