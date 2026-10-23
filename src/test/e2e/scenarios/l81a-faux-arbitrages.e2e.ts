/**
 * Lot 81A — faux arbitrages « À traiter » entre valeurs identiques (ticket
 * « [P1] T3 / À traiter — Corriger les faux arbitrages entre valeurs
 * identiques »), sur PostgreSQL 16 réel : chemin complet T3 → « À traiter »,
 * cycle de vie des cartes, contrôle de création, rattrapage des cartes
 * existantes (campagne automatique et BO), traçabilité.
 *
 * Aucun appel modèle (moteur appelé sans revue IA). Assertions limitées aux
 * comptes créés ici.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Kc = Record<string, unknown>;
type Card = { id: number; rule_code: string; field_key: string; action_kind: string; resolved_at: Date | null; resolution_reason: string | null; cycle_number: number; proposals_json: Array<{ value: unknown; isCurrentValue?: boolean; evidenceIds?: string[] }> };

scenario('L81A', 'À traiter — faux arbitrages entre valeurs identiques', ({ sql, make }) => {
  let engine: typeof import('@/services/ai/reconciliation/reconciliation-engine');
  let evidence: typeof import('@/services/ai/evidence/field-evidence.service');
  let reprise: typeof import('@/services/to-process/arbitration-equivalence-reprise');
  let actions: typeof import('@/services/to-process/to-process-action.service');

  beforeAll(async () => {
    engine = await import('@/services/ai/reconciliation/reconciliation-engine');
    evidence = await import('@/services/ai/evidence/field-evidence.service');
    reprise = await import('@/services/to-process/arbitration-equivalence-reprise');
    actions = await import('@/services/to-process/to-process-action.service');
  });

  // ── Fabriques ────────────────────────────────────────────────────────────
  const maison = async (c: AccountRow, kc: Kc, purchaseDate: string | null = null) => {
    const a = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: kc, purchaseDate });
    await sql`UPDATE assets SET subtype = 'Maison' WHERE id = ${a.id}`;
    return a.id;
  };
  const fichier = async (c: AccountRow, assetId: number, documentType: string) => {
    const f = await make.assetFile(c, { assetId });
    await sql`UPDATE asset_files SET document_type = ${documentType} WHERE id = ${f.id}`;
    return f.id;
  };
  const preuve = (c: AccountRow, assetId: number, sourceId: number, key: string, value: string | number, o: { documentType?: string; documentDate?: string } = {}) =>
    evidence.recordEvidence({
      accountId: c.id, assetId, fieldKey: key, value, normalizedValue: String(value), sourceType: 'document', sourceId, location: {},
      excerpt: `Date d’achat : ${String(value)}`, confidence: 'certain', authorityScore: 60, canonicalKey: key,
      documentType: o.documentType ?? 'FACTURE', ...(o.documentDate ? { documentDate: new Date(o.documentDate) } : {}),
      projectionOrigin: 'MODEL_CANONICAL', projectionRule: null,
      target: { type: 'ASSET', entityId: assetId, label: null, confidence: 'certain' },
    } as Parameters<typeof evidence.recordEvidence>[0]);
  const t3 = (c: AccountRow, assetId: number) => engine.reconcileAsset({ accountId: c.id, assetId, triggeredBy: 'manual', aiReview: false });
  const cartes = (assetId: number) => sql<Card[]>`
    SELECT id, rule_code, field_key, action_kind, resolved_at, resolution_reason, cycle_number, proposals_json
      FROM to_process_actions WHERE target_type = 'ASSET' AND target_id = ${assetId} AND field_key = 'acquisitionDate' ORDER BY id`;
  const fiche = async (assetId: number) => {
    const [r] = await sql<{ kc: string | null; purchase_date: string | null }[]>`SELECT key_characteristics AS kc, purchase_date::text FROM assets WHERE id = ${assetId}`;
    return { kc: (r.kc ? JSON.parse(r.kc) : {}) as Kc, purchaseDate: r.purchase_date };
  };
  const ecritures = async (c: AccountRow, assetId: number) => Number((await sql<{ n: number }[]>`
    SELECT ((SELECT count(*) FROM canonical_field_writes WHERE account_id = ${c.id} AND asset_id = ${assetId})
          + (SELECT count(*) FROM ai_field_updates WHERE account_id = ${c.id} AND asset_id = ${assetId}))::int AS n`)[0].n);
  /** Ancienne carte « 06/05/2021 vs 06/05/2021 » telle que l'ancien moteur la produisait. */
  const fausseCarte = async (c: AccountRow, assetId: number, evidenceIds: number[]) => {
    const [r] = await sql<{ id: number }[]>`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, priority, question,
        proposals_json, active_since, last_seen_at, cycle_number, created_at, updated_at)
      VALUES (${c.id}, 'ASSET', ${assetId}, 'acquisitionDate', 'ARBITRATE', 'DATA-ACQUISITION-DATE', 'DO_NEXT', 'Quelle est la date d’achat de ce bien ?',
        ${JSON.stringify([{ value: '2021-05-06', label: '2021-05-06', confidence: 0.3, evidenceIds: evidenceIds.map(String) }, { value: '2021-05-06', label: '2021-05-06', confidence: 1, isCurrentValue: true }])}::jsonb,
        now(), now(), 1, now(), now()) RETURNING id`;
    await sql`INSERT INTO inconsistency_registry (account_id, asset_id, field_key, current_value, proposed_value, source_type, source_detail, inconsistency_type, status, reason_code, current_origin)
      VALUES (${c.id}, ${assetId}, 'acquisitionDate', '2021-05-06', '2021-05-06', 'reconciliation', 'Aucune règle', 'conflictual', 'open', 'NO_AUTHORITY_RULE', 'USER')`;
    return r.id;
  };
  const KC_MAISON: Kc = { acquisitionDate: '2021-05-06', acquisitionDate__origin: 'USER' };

  // ── Chemin complet T3 → « À traiter » ───────────────────────────────────

  it('L81A-E2E-01 — cas « Maison » : fiche = acte A (06/05/2021), acte B (17/05/2021) : la carte propose 17/05/2021 contre 06/05/2021 ; aucune écriture ; nouveau passage sans réouverture ni doublon', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c, KC_MAISON, '2021-05-06');
    const a = await preuve(c, m, await fichier(c, m, 'FACTURE'), 'acquisitionDate', '2021-05-06', { documentDate: '2024-06-01' });
    const b = await preuve(c, m, await fichier(c, m, 'FACTURE'), 'acquisitionDate', '2021-05-17', { documentDate: '2024-01-01' });
    const avant = await ecritures(c, m);

    await t3(c, m);
    const [carte, ...autres] = (await cartes(m)).filter((x) => x.resolved_at === null);
    expect(autres).toEqual([]);
    expect(carte.rule_code).toBe('DATA-ACQUISITION-DATE');
    const proposees = carte.proposals_json.filter((p) => !p.isCurrentValue).map((p) => p.value);
    expect(proposees).toEqual(['2021-05-17']);
    expect(carte.proposals_json.find((p) => p.isCurrentValue)?.value).toBe('2021-05-06');
    // Preuves des deux valeurs conservées (décision T3 tracée).
    const [dec] = await sql<{ action: string; reason_code: string; evidence_ids: number[] }[]>`
      SELECT action, reason_code, evidence_ids FROM reconciliation_decisions WHERE account_id = ${c.id} AND asset_id = ${m} AND field_key = 'acquisitionDate' ORDER BY id DESC LIMIT 1`;
    expect(dec.action).toBe('create_conflict');
    expect([...dec.evidence_ids].sort()).toEqual([a, b].sort());
    const [reg] = await sql<{ proposed_value: string; status: string }[]>`SELECT proposed_value, status FROM inconsistency_registry WHERE account_id = ${c.id} AND asset_id = ${m} AND field_key = 'acquisitionDate'`;
    expect(reg).toMatchObject({ proposed_value: '2021-05-17', status: 'open' });
    // Fiche intacte.
    expect((await fiche(m)).kc.acquisitionDate).toBe('2021-05-06');
    expect(await ecritures(c, m)).toBe(avant);

    // Nouvelle exécution T3 sans modification des preuves : même carte, aucune réouverture.
    await t3(c, m);
    const apres = await cartes(m);
    expect(apres.map((x) => x.id)).toEqual([carte.id]);
    expect(apres[0].resolved_at).toBeNull();
    expect(apres[0].cycle_number).toBe(1);
  });

  it('L81A-E2E-02 — deux documents portant la même date (formats différents) et fiche identique : aucune carte', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c, KC_MAISON, '2021-05-06');
    await preuve(c, m, await fichier(c, m, 'FACTURE'), 'acquisitionDate', '2021-05-06');
    await preuve(c, m, await fichier(c, m, 'FACTURE'), 'acquisitionDay', '06/05/2021');
    await t3(c, m);
    expect(await cartes(m)).toEqual([]);
    expect((await fiche(m)).kc.acquisitionDate).toBe('2021-05-06');
  });

  it('L81A-E2E-03 — source contradictoire retirée : la carte devenue sans objet est résolue OBSOLETE et ne réapparaît pas', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c, KC_MAISON, '2021-05-06');
    await preuve(c, m, await fichier(c, m, 'FACTURE'), 'acquisitionDate', '2021-05-06', { documentDate: '2024-06-01' });
    const b = await preuve(c, m, await fichier(c, m, 'FACTURE'), 'acquisitionDate', '2021-05-17', { documentDate: '2024-01-01' });
    await t3(c, m);
    expect((await cartes(m)).filter((x) => x.resolved_at === null)).toHaveLength(1);

    await evidence.supersedeEvidence([b]);
    await t3(c, m);
    const [carte] = await cartes(m);
    expect(carte.resolved_at).not.toBeNull();
    expect(carte.resolution_reason).toBe('OBSOLETE');
    const [reg] = await sql<{ status: string }[]>`SELECT status FROM inconsistency_registry WHERE account_id = ${c.id} AND asset_id = ${m} AND field_key = 'acquisitionDate'`;
    expect(reg.status).toBe('resolved');
    await t3(c, m);
    expect((await cartes(m)).filter((x) => x.resolved_at === null)).toEqual([]);
    expect((await fiche(m)).kc.acquisitionDate).toBe('2021-05-06');
  });

  it('L81A-E2E-04 — contrôle de création : un arbitrage sans véritable alternative n’est ni créé ni mis à jour', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c, KC_MAISON, '2021-05-06');
    const r = await actions.upsertAction({
      accountId: c.id, targetType: 'ASSET', targetId: m, fieldKey: 'acquisitionDate', actionKind: 'ARBITRATE', ruleCode: 'DATA-ACQUISITION-DATE',
      proposals: [{ value: '2021-05-06', label: '2021-05-06', confidence: 0.3 }, { value: '06/05/2021', label: '06/05/2021', confidence: 1, isCurrentValue: true }],
    });
    expect(r).toMatchObject({ status: 'SKIPPED', code: 'NO_REAL_ALTERNATIVE' });
    expect(await cartes(m)).toEqual([]);
  });

  // ── Rattrapage des cartes existantes ────────────────────────────────────

  it('L81A-E2E-05 — ancienne carte « 06/05/2021 vs 06/05/2021 » sans contradiction restante : simulation sans écriture, puis campagne → OBSOLETE, tracée, fiche intacte', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c, KC_MAISON, '2021-05-06');
    const a = await preuve(c, m, await fichier(c, m, 'FACTURE'), 'acquisitionDate', '2021-05-06');
    const id = await fausseCarte(c, m, [a]);
    const avant = { fiche: await fiche(m), ecritures: await ecritures(c, m) };

    // BO — simulation : rapport exact, aucune écriture.
    const sim = await reprise.runArbitrationReprise({ apply: false, accountId: c.id });
    const it = sim.items.find((x) => x.actionId === id)!;
    expect(it).toMatchObject({ suspect: 'EQUIVALENT_TO_CURRENT', outcome: 'OBSOLETE', currentValue: '2021-05-06' });
    expect(it.initial?.registryReason).toBe('NO_AUTHORITY_RULE');
    expect((await cartes(m))[0].resolved_at).toBeNull();

    // Campagne automatique (tâche planifiée) : bornée, reprise par curseur.
    await reprise.runArbitrationRepriseCampaign({ deadline: Date.now() + 60_000, limit: 1_000, code: `l81a-e2e-05-${c.id}` });
    const [carte] = await cartes(m);
    expect(carte.id).toBe(id);
    expect(carte.resolution_reason).toBe('OBSOLETE');
    const [ev] = await sql<{ event: string; details: Record<string, unknown>; previous_value: unknown }[]>`
      SELECT event, details, previous_value FROM to_process_action_events WHERE action_id = ${id} ORDER BY id DESC LIMIT 1`;
    expect(ev.event).toBe('OBSOLETE');
    expect(ev.details).toMatchObject({ reason: 'EQUIVALENT_VALUES_NO_CONTRADICTION', suspect: 'EQUIVALENT_TO_CURRENT', currentValue: '2021-05-06' });
    expect((ev.details.candidates as Array<{ evidenceId: number }>).map((x) => x.evidenceId)).toEqual([a]);
    expect((ev.details.initial as { registryReason: string }).registryReason).toBe('NO_AUTHORITY_RULE');
    expect(ev.previous_value).toBeTruthy();
    const [reg] = await sql<{ status: string }[]>`SELECT status FROM inconsistency_registry WHERE account_id = ${c.id} AND asset_id = ${m}`;
    expect(reg.status).toBe('resolved');
    // Données métier inchangées.
    expect(await fiche(m)).toEqual(avant.fiche);
    expect(await ecritures(c, m)).toBe(avant.ecritures);
    // Nouveau passage T3 sans nouvelle contradiction : aucune réapparition.
    await t3(c, m);
    expect((await cartes(m)).filter((x) => x.resolved_at === null)).toEqual([]);
  });

  it('L81A-E2E-06 — ancienne carte « 06/05/2021 vs 06/05/2021 » masquant une troisième valeur divergente : carte CORRIGÉE (même carte, jamais supprimée)', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c, KC_MAISON, '2021-05-06');
    const a = await preuve(c, m, await fichier(c, m, 'FACTURE'), 'acquisitionDate', '2021-05-06', { documentDate: '2024-06-01' });
    const b = await preuve(c, m, await fichier(c, m, 'FACTURE'), 'acquisitionDate', '2021-05-17', { documentDate: '2024-01-01' });
    const id = await fausseCarte(c, m, [a, b]);
    const avant = { fiche: await fiche(m), ecritures: await ecritures(c, m) };

    const r = await reprise.runArbitrationReprise({ apply: true, accountId: c.id });
    expect(r.items.find((x) => x.actionId === id)?.outcome).toBe('CORRECTED');
    const toutes = await cartes(m);
    expect(toutes).toHaveLength(1);
    expect(toutes[0]).toMatchObject({ id, resolved_at: null });
    expect(toutes[0].proposals_json.filter((p) => !p.isCurrentValue).map((p) => p.value)).toEqual(['2021-05-17']);
    const [ev] = await sql<{ event: string; previous_value: Array<{ value: unknown }>; new_value: Array<{ value: unknown }> }[]>`
      SELECT event, previous_value, new_value FROM to_process_action_events WHERE action_id = ${id} ORDER BY id DESC LIMIT 1`;
    expect(ev.event).toBe('PROPOSALS_CORRECTED');
    expect(ev.previous_value.map((p) => p.value)).toEqual(['2021-05-06', '2021-05-06']);
    expect(ev.new_value.map((p) => p.value)).toEqual(['2021-05-17', '2021-05-06']);
    const [reg] = await sql<{ proposed_value: string; status: string }[]>`SELECT proposed_value, status FROM inconsistency_registry WHERE account_id = ${c.id} AND asset_id = ${m}`;
    expect(reg).toMatchObject({ proposed_value: '2021-05-17', status: 'open' });
    expect(await fiche(m)).toEqual(avant.fiche);
    expect(await ecritures(c, m)).toBe(avant.ecritures);
    // Rejoué : plus rien de suspect sur ce compte.
    const encore = await reprise.runArbitrationReprise({ apply: true, accountId: c.id });
    expect(encore.counters.suspects).toBe(0);
  });

  it('L81A-E2E-07 — campagne : état visible (0626), terminée puis inerte ; vraie carte jamais touchée', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c, KC_MAISON, '2021-05-06');
    await preuve(c, m, await fichier(c, m, 'FACTURE'), 'acquisitionDate', '2005-02-17', { documentType: 'ACTE_AUTHENTIQUE' });
    await t3(c, m);
    const [vraie] = (await cartes(m)).filter((x) => x.resolved_at === null);
    expect(vraie.proposals_json.filter((p) => !p.isCurrentValue).map((p) => p.value)).toEqual(['2005-02-17']);
    const code = `l81a-e2e-07-${c.id}`;
    const r1 = await reprise.runArbitrationRepriseCampaign({ deadline: Date.now() + 60_000, limit: 10_000, code });
    expect(r1.done).toBe(true);
    const etat = await reprise.readArbitrationRepriseState(code);
    expect(etat).toMatchObject({ status: 'DONE' });
    expect(Number(etat!.runs)).toBe(1);
    const r2 = await reprise.runArbitrationRepriseCampaign({ deadline: Date.now() + 60_000, code });
    expect(r2.counters.scanned).toBe(0);
    const [apres] = await cartes(m);
    expect(apres).toMatchObject({ id: vraie.id, resolved_at: null });
    expect(apres.proposals_json).toEqual(vraie.proposals_json);
  });
});
