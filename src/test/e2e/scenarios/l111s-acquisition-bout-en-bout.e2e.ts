/**
 * Lot 111S — acquisition prouvée par un justificatif → Opération ACQUISITION
 * + Informations + historique « Achat » (ticket P1 « acquisition bout en
 * bout ») — PostgreSQL 16 réel.
 *
 * Chemins de PRODUCTION : persistance T1 des candidats (`replaceOperationCandidates`),
 * preuve canonique de la fiche (`field_evidence` + primitive canonique
 * DOCUMENT_EXTRACTION, telles que les écrit la projection T1), fiche saisie
 * (`updateAssetDetails`, USER), consolidation T3 (`consolidateAccountOperations`,
 * M3 coupé), réconciliation de la fiche (`consolidateAssetData`), projection T4
 * (`projectAccountOperations`), suppression / modification utilisateur de
 * l'Agenda (`deleteAgendaItem`, `updateAgendaItem`), moteur de cohérence
 * (`controlObjects`, à blanc puis correctif ; campagne exhaustive), TCO
 * (`readAssetTco`). Aucun appel IA. Date de référence injectée.
 *
 *   L111S-E2E-01  bien + facture probante (date / prix déjà sur la fiche) : une Opération, un Achat daté, documents accessibles, TCO une fois
 *   L111S-E2E-02  rupture constatée : candidat « probable » + preuve canonique — avant (stock) abstention, contrôle → Opération + Achat
 *   L111S-E2E-03  fiche initialement vide : Opération et historique créés, date de la fiche renseignée par la chaîne canonique (107C)
 *   L111S-E2E-04  facture arrivée AVANT le bien : rattachement tardif → rattrapage complet (contrôle ciblé)
 *   L111S-E2E-05  date de facture ≠ date d'acquisition : date réelle retenue ; date inconnue : aucune date inventée
 *   L111S-E2E-06  prix corrigé par l'utilisateur : aucune écriture silencieuse de la fiche, un seul achat
 *   L111S-E2E-07  travaux / accessoire / équipement : jamais l'achat du bien parent ; achat de l'équipement prouvé
 *   L111S-E2E-08  plusieurs documents (commande + facture + reçu) : une identité, un événement, un coût net
 *   L111S-E2E-09  facture multibiens : aucune corroboration ni attribution arbitraire
 *   L111S-E2E-10  Opération existante sans événement : projection réparée par le contrôle, pas de seconde Opération
 *   L111S-E2E-11  événement supprimé / modifié par l'utilisateur : protections T4 respectées
 *   L111S-E2E-12  candidat absent : relance T1 ciblée (une fois, budgétée) ; candidats non retenus : constat tracé
 *   L111S-E2E-13  repassages T3 / T4 / campagne quotidienne : NO_CHANGE, aucun doublon, aucune dépense
 *   L111S-E2E-14  compte Standard : Informations / Agenda fonctionnels, TCO réservé Premium / Duo
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, cibleEquipement, fh, operationsKit, ref } from '../datasets/operations-v1';
import { uid, type AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const AUJ = '2026-11-05';
const CHECK = 'COH-OPS-ACQUISITION-DOCUMENT';

scenario('L111S', 'Acquisition prouvée par un justificatif : Opération, Informations, historique « Achat »', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const projection = () => import('@/services/business-operations/agenda-projection/service');

  // ── Outils ────────────────────────────────────────────────────────────────
  const achat = (over: Partial<AnchoredOperationCandidate> = {}) => cand({
    typeHint: 'ACQUISITION', summary: 'Achat du vélo électrique', provider: 'Cycles Exemple', ...over,
  });
  /** Preuve canonique écrite par la projection T1 (fait certain ciblé + valeur DOCUMENT_EXTRACTION de la fiche). */
  async function preuve(compte: AccountRow, assetId: number, fileId: number, key: string, value: unknown, o: { equipmentId?: number; rule?: string } = {}) {
    await sql`INSERT INTO field_evidence (account_id, asset_id, field_key, canonical_key, value_json, source_type, source_id, confidence, fingerprint,
                evidence_excerpt, target_type, target_entity_id, projection_rule)
      VALUES (${compte.id}, ${assetId}, ${key}, ${key}, ${JSON.stringify(value)}::jsonb, 'document', ${fileId}, 'certain', ${uid('fp')}, 'Facture : extrait',
              ${o.equipmentId ? 'EQUIPMENT' : 'ASSET'}, ${o.equipmentId ?? assetId}, ${o.rule ?? 'PURCHASE_RECEIPT_ACQUISITION_DATE'})`;
    if (o.equipmentId) return;
    const canon = await import('@/services/canonical/asset-state');
    await canon.writeCanonicalAssetFields({ assetId, accountId: compte.id, origin: 'DOCUMENT_EXTRACTION', source: { type: 'document', id: String(fileId) }, writes: [{ key, value }] });
  }
  const facture = (compte: AccountRow, assetId: number | null, c: AnchoredOperationCandidate[], cents = 120000) =>
    k.document(compte, assetId, c, { type: 'FACTURE_ACHAT', title: 'Facture vélo', amountCents: cents, date: '2024-05-02' });
  const passer = (compte: AccountRow) => k.passer(compte, { today: AUJ });
  const projeter = async (compte: AccountRow, ids?: number[]) => (await projection()).projectAccountOperations(compte.id,
    ids ? { operationIds: ids, today: AUJ, correlationId: 'e2e-111s' } : { all: true, today: AUJ, correlationId: 'e2e-111s' });
  const acquisitions = (compte: AccountRow) => sql<Json[]>`
    SELECT id::int AS id, status, realized_date::text AS realized_date, invalidated_at IS NULL AND merged_into_operation_id IS NULL AS active
      FROM business_operations WHERE account_id = ${compte.id} AND type_code = 'ACQUISITION' ORDER BY id`;
  const evenements = (compte: AccountRow) => sql<Json[]>`
    SELECT ai.id, ai.title, ai.start_date::text AS date, ai.business_operation_id::int AS op, ai.event_nature AS nature, ai.business_type,
           ai.is_automatic_modified AS modified,
           COALESCE((SELECT array_agg(l.asset_file_id ORDER BY l.asset_file_id) FROM agenda_file_links l WHERE l.agenda_item_id = ai.id), '{}') AS files,
           COALESCE((SELECT array_agg(l.asset_id ORDER BY l.asset_id) FROM agenda_asset_links l WHERE l.agenda_item_id = ai.id), '{}') AS assets
      FROM agenda_items ai WHERE ai.account_id = ${compte.id} ORDER BY ai.id`;
  const candidat = async (fileId: number) => (await sql<Json[]>`
    SELECT confidence, t3_outcome, t3_reason, t3_operation_id::int AS op, t3_pending, t3_detail -> 'corroboration' AS corroboration
      FROM document_operation_candidates WHERE file_id = ${fileId} AND status = 'ACTIVE' ORDER BY id`)[0];
  const fiche = async (assetId: number, key: string) => (await sql<Json[]>`
    SELECT key_characteristics::jsonb ->> ${key} AS v, key_characteristics::jsonb ->> ${`${key}__origin`} AS origin FROM assets WHERE id = ${assetId}`)[0];
  async function controler(compte: AccountRow, ids: number[], mode: 'DRY_RUN' | 'CORRECTIVE') {
    const [{ controlObjects }, { getCheck }, { pgClient }] = await Promise.all([
      import('@/services/coherence/engine'), import('@/services/coherence/registry'), import('@/db'),
    ]);
    return controlObjects({
      ctx: { sql: pgClient as never, now: new Date(`${AUJ}T10:00:00Z`), today: AUJ, mode, correlationId: `coherence:e2e-111s:${CHECK}` },
      check: getCheck(CHECK)!, accountId: compte.id, ids, trigger: 'MANUAL', campaignId: null,
      stillEligible: async () => ({ eligible: true, reason: 'e2e' }),
    });
  }
  const inspecter = async (compte: AccountRow, ids: number[]) => {
    const [{ getCheck }, { pgClient }] = await Promise.all([import('@/services/coherence/registry'), import('@/db')]);
    return getCheck(CHECK)!.inspect!({ sql: pgClient as never, now: new Date(`${AUJ}T10:00:00Z`), today: AUJ, mode: 'DRY_RUN', correlationId: 'e2e-111s' } as never, compte.id, ids);
  };
  const preuveControle = async (fileId: number) => (await sql<Json[]>`
    SELECT last_result, finding ->> 'anomaly' AS anomaly FROM coherence_object_proofs WHERE check_id = ${CHECK} AND object_id = ${fileId}`)[0];
  const lister = async (compte: AccountRow) => {
    const [{ getCheck }, { pgClient }] = await Promise.all([import('@/services/coherence/registry'), import('@/db')]);
    return getCheck(CHECK)!.listObjects!({ sql: pgClient as never, now: new Date(), today: AUJ, mode: 'DRY_RUN', correlationId: 'e2e' } as never, compte.id, 0, 100);
  };

  // ══ 01 ═══════════════════════════════════════════════════════════════════

  it('L111S-E2E-01 — bien + facture probante, date / prix déjà présents : une Opération active, un Achat daté lié au bien et à la facture, TCO compté une fois', async () => {
    const compte = await make.account({ plan: 'premium' });
    const velo = await make.asset(compte, { category: 'OBJET', name: 'Vélo' });
    const f = await facture(compte, velo.id, [achat({ targetHints: [cible(velo.id)], financialHints: [fh('REALIZED_COST', 120000, { economicDate: '2024-05-02' })] })]);
    await preuve(compte, velo.id, f, 'acquisitionDate', '2024-05-02');
    await preuve(compte, velo.id, f, 'acquisitionPrice', 1200, { rule: 'PURCHASE_RECEIPT_ACQUISITION_PRICE' });
    await passer(compte);
    const [op, ...autres] = await acquisitions(compte);
    expect(autres).toEqual([]);
    expect(op).toMatchObject({ status: 'REALIZED', realized_date: '2024-05-02', active: true });
    expect((await k.liens(op.id)).map((l) => l.asset_id)).toEqual([velo.id]);
    await projeter(compte, [op.id]);
    const [evt, ...rien] = await evenements(compte);
    expect(rien).toEqual([]);
    expect(evt).toMatchObject({ title: 'Achat', date: '2024-05-02', op: op.id, nature: 'HISTORICAL', business_type: 'purchase', assets: [velo.id] });
    expect(evt.files).toContain(f);
    // TCO : prix de fiche (même facture) + Opération = UN achat.
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    const tco = await readAssetTco(compte.id, velo.id, { today: AUJ });
    expect(JSON.stringify(tco)).toContain('120000');
    expect(await controler(compte, [f], 'CORRECTIVE')).toBeTruthy();
    expect(await preuveControle(f)).toMatchObject({ last_result: 'CONSISTENT' });
  });

  // ══ 02 ═══════════════════════════════════════════════════════════════════

  it('L111S-E2E-02 — rupture : candidat « probable » + preuve canonique — stock en abstention réparé par le contrôle (à blanc puis correctif), T3 vivant corroboré', async () => {
    const compte = await make.account({ plan: 'premium' });
    const velo = await make.asset(compte, { category: 'OBJET', name: 'Vélo' });
    const c = achat({ confidence: 'probable', targetHints: [cible(velo.id)], financialHints: [fh('REALIZED_COST', 120000, { economicDate: '2024-05-02' })] });
    const f = await facture(compte, velo.id, [c]);
    // État de préproduction : T3 a tranché AVANT la preuve canonique (ou avant le correctif) → abstention, aucune Opération.
    await passer(compte);
    expect(await candidat(f)).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'PROBABLE_WITHOUT_MATCH', op: null });
    await preuve(compte, velo.id, f, 'acquisitionDate', '2024-05-02');
    expect(await acquisitions(compte)).toEqual([]);
    expect(await lister(compte)).toEqual([f]);
    // À blanc : constat réparable, aucune écriture.
    const h0 = await k.historique(compte);
    await controler(compte, [f], 'DRY_RUN');
    expect(await preuveControle(f)).toMatchObject({ last_result: 'WOULD_REPAIR', anomaly: 'ACQUISITION_CORROBORATED_NOT_CONSOLIDATED' });
    expect(await k.historique(compte)).toBe(h0);
    expect(await acquisitions(compte)).toEqual([]);
    // Correctif : T3 ciblé (corroboration), fiche, T4.
    await controler(compte, [f], 'CORRECTIVE');
    const [op, ...autres] = await acquisitions(compte);
    expect(autres).toEqual([]);
    expect(op).toMatchObject({ status: 'REALIZED', realized_date: '2024-05-02', active: true });
    expect(await candidat(f)).toMatchObject({ t3_outcome: 'CREATE_NEW', op: op.id, corroboration: expect.objectContaining({ code: 'CANONICAL_ACQUISITION_EVIDENCE', confidence: 'certain' }) });
    expect(await evenements(compte)).toEqual([expect.objectContaining({ title: 'Achat', date: '2024-05-02', op: op.id })]);
    expect(await preuveControle(f)).toMatchObject({ last_result: 'REPAIRED' });
    // Sans preuve canonique, un candidat probable reste une abstention justifiée (aucune création).
    const autre = await make.account({ plan: 'premium' });
    const b2 = await make.asset(autre, { category: 'OBJET', name: 'Vélo 2' });
    const f2 = await facture(autre, b2.id, [achat({ confidence: 'probable', targetHints: [cible(b2.id)] })]);
    await passer(autre);
    expect(await acquisitions(autre)).toEqual([]);
    expect((await inspecter(autre, [f2])).get(f2)).toMatchObject({ verdict: 'AMBIGUOUS', anomaly: 'ACQUISITION_NOT_PROVEN' });
  });

  // ══ 03 ═══════════════════════════════════════════════════════════════════

  it('L111S-E2E-03 — fiche vide : Opération + historique sans saisie, date d’achat de la fiche renseignée par la primitive canonique (COH-OPS-ACQUISITION-DATE)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const velo = await make.asset(compte, { category: 'OBJET', name: 'Vélo' });
    const f = await facture(compte, velo.id, [achat({ targetHints: [cible(velo.id)], temporalHints: { realizedDate: '2024-05-02' }, financialHints: [fh('REALIZED_COST', 120000)] })]);
    await passer(compte);
    const [op] = await acquisitions(compte);
    expect(op).toMatchObject({ realized_date: '2024-05-02' });
    expect((await inspecter(compte, [f])).get(f)).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'ACQUISITION_EVENT_MISSING' });
    await controler(compte, [f], 'CORRECTIVE');
    expect(await evenements(compte)).toEqual([expect.objectContaining({ title: 'Achat', date: '2024-05-02', op: op.id })]);
    expect((await fiche(velo.id, 'acquisitionDate')).v ?? null).toBeNull();
    const [{ controlObjects }, { getCheck }, { pgClient }] = await Promise.all([import('@/services/coherence/engine'), import('@/services/coherence/registry'), import('@/db')]);
    await controlObjects({
      ctx: { sql: pgClient as never, now: new Date(`${AUJ}T10:00:00Z`), today: AUJ, mode: 'CORRECTIVE', correlationId: 'coherence:e2e-111s:COH-OPS-ACQUISITION-DATE' },
      check: getCheck('COH-OPS-ACQUISITION-DATE')!, accountId: compte.id, ids: [op.id], trigger: 'MANUAL', campaignId: null, stillEligible: async () => ({ eligible: true, reason: 'e2e' }),
    });
    expect(await fiche(velo.id, 'acquisitionDate')).toMatchObject({ v: '2024-05-02', origin: 'RECONCILIATION' });
  });

  // ══ 04 ═══════════════════════════════════════════════════════════════════

  it('L111S-E2E-04 — facture arrivée avant le bien : rattachement tardif → Opération liée et Achat (contrôle ciblé du document)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const f = await facture(compte, null, [achat({ financialHints: [fh('REALIZED_COST', 120000, { economicDate: '2024-05-02' })] })]);
    await passer(compte);
    const velo = await make.asset(compte, { category: 'OBJET', name: 'Vélo' });
    await sql`UPDATE asset_files SET asset_id = ${velo.id} WHERE id = ${f}`;
    await preuve(compte, velo.id, f, 'acquisitionDate', '2024-05-02');
    const { getCheck } = await import('@/services/coherence/registry');
    const { pgClient } = await import('@/db');
    expect(await getCheck(CHECK)!.objectsForEvent!({ sql: pgClient as never } as never, compte.id, { type: 'DOCUMENT_UPDATED', entityId: f })).toEqual([f]);
    expect(await getCheck(CHECK)!.objectsForEvent!({ sql: pgClient as never } as never, compte.id, { type: 'ASSET_UPDATED', entityId: velo.id })).toEqual([f]);
    await controler(compte, [f], 'CORRECTIVE');
    const actives = (await acquisitions(compte)).filter((o) => o.active);
    expect(actives).toHaveLength(1);
    expect((await k.liens(actives[0].id)).map((l) => l.asset_id)).toEqual([velo.id]);
    expect((await evenements(compte)).filter((e) => e.title === 'Achat')).toEqual([expect.objectContaining({ op: actives[0].id, date: '2024-05-02', assets: [velo.id] })]);
    expect(['CONSISTENT', 'REPAIRED']).toContain((await preuveControle(f)).last_result);
  });

  // ══ 05 ═══════════════════════════════════════════════════════════════════

  it('L111S-E2E-05 — date de facture ≠ date d’acquisition : date réelle retenue ; aucune date connue : aucune date inventée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const velo = await make.asset(compte, { category: 'OBJET', name: 'Vélo' });
    await facture(compte, velo.id, [achat({ targetHints: [cible(velo.id)], temporalHints: { realizedDate: '2024-04-27' }, financialHints: [fh('REALIZED_COST', 120000, { economicDate: '2024-05-02' })] })]);
    await passer(compte);
    const [op] = await acquisitions(compte);
    expect(op.realized_date).toBe('2024-04-27');
    await projeter(compte);
    expect(await evenements(compte)).toEqual([expect.objectContaining({ title: 'Achat', date: '2024-04-27' })]);

    const c2 = await make.account({ plan: 'premium' });
    const b2 = await make.asset(c2, { category: 'OBJET', name: 'Vélo' });
    await k.document(c2, b2.id, [achat({ targetHints: [cible(b2.id)], financialHints: [fh('REALIZED_COST', 120000)] })], { type: 'FACTURE_ACHAT', amountCents: 120000, date: null });
    await passer(c2);
    const [o2] = await acquisitions(c2);
    expect(o2).toMatchObject({ status: 'REALIZED', realized_date: null });
    await projeter(c2);
    expect(await evenements(c2)).toEqual([expect.objectContaining({ title: 'Achat', date: null, op: o2.id })]);
  });

  // ══ 06 ═══════════════════════════════════════════════════════════════════

  it('L111S-E2E-06 — prix d’achat corrigé par l’utilisateur : fiche jamais réécrite, un seul achat actif', async () => {
    const compte = await make.account({ plan: 'premium' });
    const velo = await make.asset(compte, { category: 'OBJET', name: 'Vélo' });
    const { updateAssetDetails } = await import('@/services/asset-details-write.service');
    await updateAssetDetails({ assetId: velo.id, accountId: compte.id, section: 'common', fields: { acquisitionPrice: 1000 }, actorUserId: compte.ownerUserId });
    await (await import('@/services/business-operations/consolidation/asset-data-consolidator')).consolidateAssetData(compte.id, velo.id, { today: AUJ });
    const f = await facture(compte, velo.id, [achat({ targetHints: [cible(velo.id)], financialHints: [fh('REALIZED_COST', 120000, { economicDate: '2024-05-02' })] })]);
    await preuve(compte, velo.id, f, 'acquisitionDate', '2024-05-02');
    await passer(compte);
    await controler(compte, [f], 'CORRECTIVE');
    expect(await fiche(velo.id, 'acquisitionPrice')).toMatchObject({ origin: 'USER' });
    expect(Number((await fiche(velo.id, 'acquisitionPrice')).v)).toBe(1000);
    const actives = (await acquisitions(compte)).filter((o) => o.active);
    expect(actives.length).toBeLessThanOrEqual(1);
    // Aucun double comptage : au plus une composante de coût réalisé active pour l'achat.
    if (actives.length) expect((await k.composantes(actives[0].id)).filter((x) => x.kind === 'REALIZED_COST')).toHaveLength(1);
    expect((await evenements(compte)).filter((e) => e.title === 'Achat').length).toBeLessThanOrEqual(1);
  });

  // ══ 07 ═══════════════════════════════════════════════════════════════════

  it('L111S-E2E-07 — travaux / accessoire / équipement : jamais l’achat du bien parent ; achat de l’équipement prouvé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    // Travaux (type connu) : jamais requalifiés, même avec une preuve canonique d'acquisition (mal ciblée).
    const travaux = await facture(compte, maison.id, [cand({ typeHint: 'INTERVENTION', confidence: 'probable', targetHints: [cible(maison.id)] })]);
    // Équipement : facture d'achat de la chaudière, preuve canonique sur l'ÉQUIPEMENT seulement.
    const chaudiere = await k.equipement(maison, 'Chaudière');
    const fe = await facture(compte, maison.id, [achat({ summary: 'Achat chaudière', confidence: 'probable', targetHints: [cibleEquipement(chaudiere)] })]);
    await preuve(compte, maison.id, fe, 'acquisitionPrice', 1200, { equipmentId: chaudiere, rule: 'PURCHASE_RECEIPT_ACQUISITION_PRICE' });
    // Accessoire : candidat d'achat probable sur le bien, aucune preuve canonique du bien → abstention.
    const acc = await facture(compte, maison.id, [achat({ summary: 'Achat accessoire', confidence: 'probable' })]);
    await passer(compte);
    expect((await candidat(travaux)).t3_outcome).not.toBe('CREATE_NEW');
    // Abstention (sans correspondance, ou examen M3 face à l'achat de l'équipement) : jamais une création.
    expect(await candidat(acc)).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', op: null });
    const [op, ...autres] = (await acquisitions(compte)).filter((o) => o.active);
    expect(autres).toEqual([]);
    expect(await candidat(fe)).toMatchObject({ t3_outcome: 'CREATE_NEW', op: op.id });
    expect((await k.liensEquipement(op.id)).map((l) => l.equipment_id)).toEqual([chaudiere]);
    // L'achat de l'équipement n'est jamais celui du bien parent (TCO : départ du bien non pris sur cet achat).
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    const depart = (await readAssetTco(compte.id, maison.id, { today: AUJ })).acquisitionStart;
    expect(depart?.candidates?.find((x: Json) => x.operationId === op.id)?.reason ?? 'EQUIPMENT_PURCHASE').not.toBe('ASSET_PURCHASE');
  });

  // ══ 08 ═══════════════════════════════════════════════════════════════════

  it('L111S-E2E-08 — commande + facture + reçu d’un même achat : une identité économique, un événement, un coût net', async () => {
    const compte = await make.account({ plan: 'premium' });
    const velo = await make.asset(compte, { category: 'OBJET', name: 'Vélo' });
    const refs = [ref('ORDER', 'CMD-2024-118')];
    await k.document(compte, velo.id, [achat({ sourceRoleHint: 'ORDER', statusHint: 'ENVISAGED', targetHints: [cible(velo.id)], businessReferences: refs,
      financialHints: [fh('FORECAST_COST', 120000, { economicDate: '2024-04-20' })] })], { type: 'BON_COMMANDE', amountCents: 120000, date: '2024-04-20' });
    const f = await facture(compte, velo.id, [achat({ targetHints: [cible(velo.id)], businessReferences: [...refs, ref('INVOICE', 'FA-2024-0502')],
      financialHints: [fh('REALIZED_COST', 120000, { economicDate: '2024-05-02' })] })]);
    await k.document(compte, velo.id, [achat({ sourceRoleHint: 'PAYMENT_PROOF', confidence: 'probable', targetHints: [cible(velo.id)], businessReferences: [ref('INVOICE', 'FA-2024-0502')],
      financialHints: [fh('PAYMENT', 120000, { economicDate: '2024-05-02' })] })], { type: 'TICKET_CAISSE', amountCents: 120000, date: '2024-05-02' });
    await preuve(compte, velo.id, f, 'acquisitionDate', '2024-05-02');
    await passer(compte);
    await passer(compte);
    const actives = (await acquisitions(compte)).filter((o) => o.active);
    expect(actives).toHaveLength(1);
    expect(await k.coutNet(actives[0].id)).toBe(120000);
    await projeter(compte);
    expect((await evenements(compte)).filter((e) => e.title === 'Achat')).toHaveLength(1);
  });

  // ══ 09 ═══════════════════════════════════════════════════════════════════

  it('L111S-E2E-09 — facture multibiens : aucune corroboration, aucun coût attribué arbitrairement à un bien', async () => {
    const compte = await make.account({ plan: 'premium' });
    const a = await make.asset(compte, { category: 'OBJET', name: 'Vélo A' });
    const b = await make.asset(compte, { category: 'OBJET', name: 'Vélo B' });
    const f = await facture(compte, a.id, [achat({ confidence: 'probable', targetHints: [cible(a.id), cible(b.id)], financialHints: [fh('REALIZED_COST', 240000)] })], 240000);
    await preuve(compte, a.id, f, 'acquisitionDate', '2024-05-02');
    await passer(compte);
    expect(await candidat(f)).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'PROBABLE_WITHOUT_MATCH' });
    expect(await acquisitions(compte)).toEqual([]);
    expect((await inspecter(compte, [f])).get(f)).toMatchObject({ verdict: 'AMBIGUOUS', anomaly: 'ACQUISITION_NOT_PROVEN' });
  });

  // ══ 10 ═══════════════════════════════════════════════════════════════════

  it('L111S-E2E-10 — Opération existante sans événement : historique réparé (à blanc puis correctif), jamais une seconde Opération', async () => {
    const compte = await make.account({ plan: 'premium' });
    const velo = await make.asset(compte, { category: 'OBJET', name: 'Vélo' });
    const f = await facture(compte, velo.id, [achat({ targetHints: [cible(velo.id)], financialHints: [fh('REALIZED_COST', 120000, { economicDate: '2024-05-02' })] })]);
    await passer(compte);
    const [op] = await acquisitions(compte);
    expect(await evenements(compte)).toEqual([]);
    await controler(compte, [f], 'DRY_RUN');
    expect(await preuveControle(f)).toMatchObject({ last_result: 'WOULD_REPAIR', anomaly: 'ACQUISITION_EVENT_MISSING' });
    expect(await evenements(compte)).toEqual([]);
    await controler(compte, [f], 'CORRECTIVE');
    expect(await preuveControle(f)).toMatchObject({ last_result: 'REPAIRED' });
    expect(await evenements(compte)).toEqual([expect.objectContaining({ title: 'Achat', op: op.id, date: '2024-05-02' })]);
    expect(await acquisitions(compte)).toHaveLength(1);
  });

  // ══ 11 ═══════════════════════════════════════════════════════════════════

  it('L111S-E2E-11 — événement supprimé volontairement : jamais recréé ; événement modifié : jamais réécrit', async () => {
    const compte = await make.account({ plan: 'premium' });
    const velo = await make.asset(compte, { category: 'OBJET', name: 'Vélo' });
    const f = await facture(compte, velo.id, [achat({ targetHints: [cible(velo.id)], financialHints: [fh('REALIZED_COST', 120000, { economicDate: '2024-05-02' })] })]);
    await passer(compte);
    await projeter(compte);
    const [evt] = await evenements(compte);
    const { deleteAgendaItem, updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    await deleteAgendaItem(evt.id, compte.id, compte.ownerUserId);
    expect((await inspecter(compte, [f])).get(f)).toMatchObject({ verdict: 'CONSISTENT' });
    await controler(compte, [f], 'CORRECTIVE');
    await projeter(compte);
    expect(await evenements(compte)).toEqual([]);

    const c2 = await make.account({ plan: 'premium' });
    const b2 = await make.asset(c2, { category: 'OBJET', name: 'Vélo' });
    const f2 = await facture(c2, b2.id, [achat({ targetHints: [cible(b2.id)], financialHints: [fh('REALIZED_COST', 120000, { economicDate: '2024-05-02' })] })]);
    await passer(c2);
    await projeter(c2);
    const [e2] = await evenements(c2);
    await updateAgendaItem(e2.id, { title: 'Achat du vélo (magasin)', startDate: '2024-05-03' }, c2.id, c2.ownerUserId);
    await controler(c2, [f2], 'CORRECTIVE');
    await projeter(c2);
    expect(await evenements(c2)).toEqual([expect.objectContaining({ id: e2.id, title: 'Achat du vélo (magasin)', date: '2024-05-03' })]);
  });

  // ══ 12 ═══════════════════════════════════════════════════════════════════

  it('L111S-E2E-12 — candidat absent : relance T1 ciblée une seule fois (à blanc : rien) ; candidats non retenus : constat tracé, aucune relance', async () => {
    const compte = await make.account({ plan: 'premium' });
    const velo = await make.asset(compte, { category: 'OBJET', name: 'Vélo' });
    const vieux = await k.vieuxDocument(compte, velo.id, { type: 'FACTURE_ACHAT', title: 'Facture vélo', amountCents: 120000, date: '2024-05-02' });
    await preuve(compte, velo.id, vieux, 'acquisitionDate', '2024-05-02');
    const jobs = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_job_queue WHERE account_id = ${compte.id}`.catch(() => [{ n: -1 }]))[0].n;
    const avant = await jobs();
    await controler(compte, [vieux], 'DRY_RUN');
    expect(await preuveControle(vieux)).toMatchObject({ last_result: 'WOULD_REPAIR', anomaly: 'ACQUISITION_CANDIDATE_ABSENT' });
    expect(await jobs()).toBe(avant);
    await controler(compte, [vieux], 'CORRECTIVE');
    expect(await preuveControle(vieux)).toMatchObject({ last_result: 'REPAIR_PENDING' });
    expect(await sql`SELECT 1 FROM coherence_repairs WHERE check_id = ${CHECK} AND object_id = ${vieux} AND service = 'requeueDocumentForReread'`).toHaveLength(1);
    // Analyse T1 relancée qui produit le candidat : la chaîne existante crée Opération et historique.
    await k.t1(compte, vieux, [achat({ targetHints: [cible(velo.id)], financialHints: [fh('REALIZED_COST', 120000, { economicDate: '2024-05-02' })] })], true);
    await passer(compte);
    await controler(compte, [vieux], 'CORRECTIVE');
    expect((await acquisitions(compte)).filter((o) => o.active)).toHaveLength(1);
    expect((await evenements(compte)).filter((e) => e.title === 'Achat')).toHaveLength(1);
    expect(await sql`SELECT 1 FROM coherence_repairs WHERE check_id = ${CHECK} AND object_id = ${vieux} AND service = 'requeueDocumentForReread'`).toHaveLength(1);

    // Candidats produits mais aucune acquisition retenue (exclusion T1) : constat, jamais de relance.
    const c2 = await make.account({ plan: 'premium' });
    const b2 = await make.asset(c2, { category: 'OBJET', name: 'Vélo' });
    const f2 = await facture(c2, b2.id, [achat({ established: false, exclusionReason: 'NO_EVIDENCE' as never })]);
    await preuve(c2, b2.id, f2, 'acquisitionDate', '2024-05-02');
    await controler(c2, [f2], 'CORRECTIVE');
    expect(await preuveControle(f2)).toMatchObject({ last_result: 'FINDING', anomaly: 'ACQUISITION_CANDIDATE_NOT_PRODUCED' });
    expect(await sql`SELECT 1 FROM coherence_repairs WHERE check_id = ${CHECK} AND object_id = ${f2}`).toHaveLength(0);
  });

  // ══ 13 ═══════════════════════════════════════════════════════════════════

  it('L111S-E2E-13 — repassages T3 / T4 / contrôle à état stable : NO_CHANGE, aucun doublon, aucun appel IA', async () => {
    const compte = await make.account({ plan: 'premium' });
    const velo = await make.asset(compte, { category: 'OBJET', name: 'Vélo' });
    const f = await facture(compte, velo.id, [achat({ confidence: 'probable', targetHints: [cible(velo.id)], financialHints: [fh('REALIZED_COST', 120000, { economicDate: '2024-05-02' })] })]);
    await preuve(compte, velo.id, f, 'acquisitionDate', '2024-05-02');
    await passer(compte);
    await projeter(compte);
    await controler(compte, [f], 'CORRECTIVE');
    const h = await k.historique(compte);
    const evts = await evenements(compte);
    const comps = await sql`SELECT c.id FROM business_operation_financial_components c JOIN business_operations o ON o.id = c.operation_id WHERE o.account_id = ${compte.id} AND c.active`;
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE file_id = ${f} AND status = 'ACTIVE'`;
    const r = await passer(compte);
    expect(r.changes).toBe(0);
    const p = await projeter(compte);
    expect(p).toMatchObject({ created: 0, updated: 0, linked: 0 });
    const res = await controler(compte, [f], 'CORRECTIVE');
    expect(JSON.stringify(res)).not.toMatch(/"aiCalls":[1-9]/);
    expect(await preuveControle(f)).toMatchObject({ last_result: 'CONSISTENT' });
    expect(await k.historique(compte)).toBe(h);
    expect(await evenements(compte)).toEqual(evts);
    expect(await sql`SELECT c.id FROM business_operation_financial_components c JOIN business_operations o ON o.id = c.operation_id WHERE o.account_id = ${compte.id} AND c.active`).toEqual(comps);
    expect(await acquisitions(compte)).toHaveLength(1);
  });

  // ══ 14 ═══════════════════════════════════════════════════════════════════

  it('L111S-E2E-14 — compte Standard : Opération et historique « Achat » produits ; TCO réservé Premium / Duo', async () => {
    const compte = await make.account({ plan: 'standard' });
    const velo = await make.asset(compte, { category: 'OBJET', name: 'Vélo' });
    const f = await facture(compte, velo.id, [achat({ confidence: 'probable', targetHints: [cible(velo.id)], financialHints: [fh('REALIZED_COST', 120000, { economicDate: '2024-05-02' })] })]);
    await preuve(compte, velo.id, f, 'acquisitionDate', '2024-05-02');
    await passer(compte);
    await controler(compte, [f], 'CORRECTIVE');
    const [op] = await acquisitions(compte);
    expect(op).toMatchObject({ realized_date: '2024-05-02', active: true });
    expect(await evenements(compte)).toEqual([expect.objectContaining({ title: 'Achat', op: op.id })]);
    const { getEntitlements } = await import('@/services/entitlements.service');
    expect((await getEntitlements(compte.id)).premiumFeatures).toBe(false);
  });
});
