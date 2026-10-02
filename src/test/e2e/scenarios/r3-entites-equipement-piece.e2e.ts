/**
 * Lot 18, volet R3 — valeurs lues pour un équipement ou une pièce appliquées
 * à LEUR fiche (CDC 15 T1-04, T3-01, T3-02, T3-04), sur PostgreSQL réel.
 *
 *  · facture de chaudière → numéro de série et fin de garantie sur
 *    l'équipement (fiche 0227, `equipment_cil_specs.serial_number`, journal
 *    ciblé), fiche du bien intacte ; travail T3 ciblé passé par la file ;
 *    lecture assistant et export (section équipements) ;
 *  · valeur USER protégée (fiche de l'entité et colonne saisie à l'écran) ;
 *    édition manuelle par la route → origine USER ;
 *  · suppression du document → retrait des valeurs automatiques ;
 *  · pièce (= sous-structure depuis D-G, lot 20) : surface (`substructures.area`),
 *    jamais la surface habitable du bien ;
 *  · commutateurs : legacy = rien (aucun travail), shadow = journal seulement.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { ProjectedFact } from '@/services/ai/source-analysis/master/t1-contract';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
vi.mock('@/lib/asset-quota-guard', () => ({
  assetModificationDecision: async () => ({ allowed: true }), refuserSiModificationBiensSuspendue: async () => null,
  countAccountAssets: async () => 0,
}));
vi.mock('@/services/ai/reconciliation/coherence-impact', () => ({ hasCoherenceImpact: async () => false }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const trace = {
  traceIds: [], operationCodes: [], totalInputTokens: 0, totalOutputTokens: 0,
  totalCostMicros: 0, totalDurationMs: 0, usedFallback: false, models: ['replay'],
};
type Cible = { type: 'EQUIPMENT' | 'ROOM' | 'ASSET'; id: number };
const fait = (cible: Cible, canonicalKey: string, value: string | number, excerpt: string, over: Partial<ProjectedFact> = {}): ProjectedFact => ({
  canonicalKey, rawKey: canonicalKey, label: null, subject: null, attribute: null,
  rawValue: String(value), value, valueType: typeof value === 'number' ? 'number' : 'string', canonicalUnit: null,
  target: { targetType: cible.type, targetEntityId: cible.id, targetEntityLabel: null, targetConfidence: 'certain' },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt, page: 1 },
  semanticEvent: null, recurrence: null, periodStart: null, periodEnd: null, origin: 'MODEL_CANONICAL', ruleCode: null,
  ...over,
});
const SWITCHES = ['CANONICAL_WRITE_MODE', 'T3_NEGATIVE_RECONCILIATION', 'ASSISTANT_CANONICAL_READ', 'EXPORTS_CANONICAL_SOURCE'];

scenario('R3-L18', 'Valeurs d’un équipement ou d’une pièce appliquées à leur fiche', ({ sql, make }) => {
  const env = { ...process.env };
  let persistProjectedFacts: typeof import('@/services/ai/source-analysis/steps/persist-evidence.step').persistProjectedFacts;
  let fanout: typeof import('@/services/ai/source-analysis/master/reconciliation-fanout');
  let t3: typeof import('@/services/ai/reconciliation/t3-queue');
  let reconcileAsset: typeof import('@/services/ai/reconciliation/reconciliation-engine').reconcileAsset;
  let lifecycle: typeof import('@/services/ai/evidence/document-evidence-lifecycle');
  let es: typeof import('@/services/canonical/entity-state');
  let NO_GUARD: typeof import('@/services/ai/queue/execution-control').NO_GUARD;

  beforeAll(async () => {
    ({ persistProjectedFacts } = await import('@/services/ai/source-analysis/steps/persist-evidence.step'));
    fanout = await import('@/services/ai/source-analysis/master/reconciliation-fanout');
    t3 = await import('@/services/ai/reconciliation/t3-queue');
    ({ reconcileAsset } = await import('@/services/ai/reconciliation/reconciliation-engine'));
    lifecycle = await import('@/services/ai/evidence/document-evidence-lifecycle');
    es = await import('@/services/canonical/entity-state');
    ({ NO_GUARD } = await import('@/services/ai/queue/execution-control'));
  });
  afterEach(() => {
    for (const k of SWITCHES) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
    vi.restoreAllMocks();
  });

  const input = (accountId: number, userId: number, fileId: number) => ({
    sourceType: 'file' as const, sourceIds: [fileId], accountId, userId, mimeTypes: [], displayNames: [],
  });
  const maison = async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const [eq] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type) VALUES (${bien.id}, 'Chaudière', 'BOILER') RETURNING id`;
    // Pièce = sous-structure (D-G, lot 20).
    const [piece] = await sql<{ id: number }[]>`
      INSERT INTO substructures (asset_id, name, room_type) VALUES (${bien.id}, 'Salon', 'LIVING_ROOM') RETURNING id`;
    return { compte, bien, equipement: { type: 'EQUIPMENT' as const, id: eq.id }, piece: { type: 'ROOM' as const, id: piece.id } };
  };
  const facture = async (m: Awaited<ReturnType<typeof maison>>, facts: ProjectedFact[], run = 1) => {
    const doc = await make.assetFile(m.compte, { assetId: m.bien.id, name: 'facture-chaudiere.pdf' });
    const r = await persistProjectedFacts({
      input: input(m.compte.id, m.compte.ownerUserId, doc.id), leadSourceId: doc.id, trace, analysisRunId: run, documentType: 'FACTURE', facts,
    });
    return { doc, r };
  };
  const kcEquipement = async (id: number) => {
    const [r] = await sql<{ kc: Record<string, unknown>; sn: string | null; ppc: number | null }[]>`
      SELECT e.key_characteristics AS kc, s.serial_number AS sn, e.purchase_price_cents AS ppc
        FROM equipments e LEFT JOIN equipment_cil_specs s ON s.equipment_id = e.id WHERE e.id = ${id}`;
    return r;
  };
  const kcBien = async (id: number) => {
    const [r] = await sql<{ kc: string | null; w: string | null }[]>`
      SELECT key_characteristics AS kc, to_char(warranty_end_date, 'YYYY-MM-DD') AS w FROM assets WHERE id = ${id}`;
    return { kc: JSON.parse(r.kc ?? '{}') as Record<string, unknown>, warrantyEndDate: r.w };
  };
  /** Exécute les travaux T3 ciblés en attente du compte (comme le boucleur). */
  const executerFile = async (accountId: number) => {
    const jobs = await sql<{ id: number; target_type: string; target_id: string; payload: Record<string, unknown> }[]>`
      SELECT id, target_type, target_id, payload FROM ai_job_queue
       WHERE treatment = 'T3' AND account_id = ${accountId} AND target_type IN ('equipment', 'room') AND status = 'PENDING' ORDER BY id`;
    for (const j of jobs) {
      await t3.t3JobHandler({
        id: Number(j.id), treatment: 'T3', accountId, targetType: j.target_type, targetId: String(j.target_id), payload: j.payload,
        origin: 'automatic', triggerCode: 'source_analyzed',
      } as never, NO_GUARD);
      await sql`UPDATE ai_job_queue SET status = 'DONE', finished_at = now() WHERE id = ${j.id}`;
    }
    return jobs.map((j) => `${j.target_type}:${j.target_id}`);
  };

  it('facture de chaudière → numéro de série et fin de garantie sur l’équipement, fiche du bien intacte ; lecture et export', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    process.env.T3_NEGATIVE_RECONCILIATION = 'enabled';
    const m = await maison();
    const { doc, r } = await facture(m, [
      fait(m.equipement, 'serialNumber', 'FR-2024-0077', 'N° de série : FR-2024-0077'),
      fait(m.equipement, 'warrantyEndDate', '2031-03-01', 'Garantie jusqu’au 01/03/2031', { valueType: 'date' }),
    ]);
    expect(r.affectedTargets).toEqual([expect.objectContaining({ type: 'EQUIPMENT', id: m.equipement.id, assetId: m.bien.id })]);

    // Mise en file depuis l'analyse (même appel que le pipeline), puis exécution.
    await fanout.enqueueT3ForAffectedEntities({ accountId: m.compte.id, userId: m.compte.ownerUserId, leadSourceId: doc.id, targets: r.affectedTargets });
    expect(await executerFile(m.compte.id)).toEqual([`equipment:${m.equipement.id}`]);

    const eq = await kcEquipement(m.equipement.id);
    expect(eq.kc).toMatchObject({
      serialNumber: 'FR-2024-0077', serialNumber__origin: 'RECONCILIATION',
      warrantyEndDate: '2031-03-01', warrantyEndDate__origin: 'RECONCILIATION',
    });
    expect(typeof eq.kc.serialNumber__updatedAt).toBe('string');
    expect(eq.sn).toBe('FR-2024-0077');
    const journal = await sql<{ canonical_key: string; target_type: string; target_id: number; asset_id: number; dry_run: boolean }[]>`
      SELECT canonical_key, target_type, target_id, asset_id, dry_run FROM canonical_field_writes
       WHERE target_type = 'EQUIPMENT' AND target_id = ${m.equipement.id} ORDER BY canonical_key`;
    expect(journal).toEqual([
      { canonical_key: 'serialNumber', target_type: 'EQUIPMENT', target_id: m.equipement.id, asset_id: m.bien.id, dry_run: false },
      { canonical_key: 'warrantyEndDate', target_type: 'EQUIPMENT', target_id: m.equipement.id, asset_id: m.bien.id, dry_run: false },
    ]);

    // Fiche du bien intacte, y compris après sa propre réconciliation.
    await reconcileAsset({ accountId: m.compte.id, userId: m.compte.ownerUserId, assetId: m.bien.id, triggeredBy: 'document_analyzed' });
    const bien = await kcBien(m.bien.id);
    expect(bien.kc.serialNumber).toBeUndefined();
    expect(bien.kc.warrantyEndDate).toBeUndefined();
    expect(bien.warrantyEndDate).toBeNull();
    const [{ n: lignesBien }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM canonical_field_writes WHERE asset_id = ${m.bien.id} AND target_type IS NULL`;
    expect(lignesBien).toBe(0);

    // Assistant (lecture canonique) : valeur, origine et preuve de l'équipement.
    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    const { readCanonicalField, readCanonicalEntityField } = await import('@/services/verebona-assistant/canonical/field-reader');
    const lu = await readCanonicalField(m.compte.id, m.bien.id, 'serialNumber');
    expect(lu?.value).toBeNull();
    expect(lu?.entities).toEqual([expect.objectContaining({
      target: m.equipement, entityName: 'Chaudière', value: 'FR-2024-0077', origin: 'RECONCILIATION',
      evidence: expect.objectContaining({ fileId: doc.id, excerpt: 'N° de série : FR-2024-0077' }),
    })]);
    expect(await readCanonicalEntityField(m.compte.id, m.equipement, 'finGarantie')).toMatchObject({ key: 'warrantyEndDate', value: '2031-03-01', display: '1 mars 2031' });
    const autre = await make.account();
    expect(await readCanonicalEntityField(autre.id, m.equipement, 'serialNumber')).toBeNull();
    const { answerFromTarget } = await import('@/services/verebona-assistant/core/target-answer');
    const rep = await answerFromTarget(m.compte.id, 'numéro de série de la chaudière ?', {
      primary: null, asset: { type: 'asset', id: m.bien.id, name: 'Maison', origin: 'message' } as never, document: null, agendaItem: null, supplier: null,
      namedAssets: [], hints: {} as never,
    }, undefined, { requestedFacts: ['serialNumber'] } as never);
    expect(rep?.text).toContain('Numéro de série de Chaudière : FR-2024-0077.');

    // Export (section équipements) en lecture canonique.
    process.env.EXPORTS_CANONICAL_SOURCE = 'enabled';
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const src = await loadExportSource({ assetId: m.bien.id, accountId: m.compte.id, userId: m.compte.ownerUserId, exportType: 'DOSSIER_COMPLET' });
    const e = src.equipments.find((x) => x.id === m.equipement.id)!;
    expect(e.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'serialNumber', value: 'FR-2024-0077', origin: 'RECONCILIATION', evidence: expect.objectContaining({ fileId: doc.id }) }),
      expect.objectContaining({ key: 'warrantyEndDate', value: '2031-03-01', origin: 'RECONCILIATION' }),
    ]));
    // Snapshot transmis : référence de la preuve, jamais l'extrait.
    expect(JSON.stringify(e.fields)).not.toContain('N° de série');
    process.env.EXPORTS_CANONICAL_SOURCE = 'legacy';
    const legacy = await loadExportSource({ assetId: m.bien.id, accountId: m.compte.id, userId: m.compte.ownerUserId, exportType: 'DOSSIER_COMPLET' });
    expect(legacy.equipments.find((x) => x.id === m.equipement.id)?.fields).toBeUndefined();
  });

  it('valeur USER protégée : fiche de l’entité, colonne saisie à l’écran ; édition par la route → USER', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    const m = await maison();
    // Saisie de l'utilisateur sur la fiche de l'équipement (primitive, origine USER).
    await es.writeCanonicalEntityField({ target: m.equipement, accountId: m.compte.id, origin: 'USER', key: 'serialNumber', value: 'MANUEL-1', mode: 'enabled' });
    const { r } = await facture(m, [
      fait(m.equipement, 'serialNumber', 'FR-2024-0077', 'N° de série : FR-2024-0077'),
      fait(m.equipement, 'acquisitionPrice', 1899, 'Total TTC 1 899 €'),
    ]);
    // Prix saisi à l'écran AVANT le traitement (colonne, sans origine tracée) : USER.
    await sql`UPDATE equipments SET purchase_price_cents = 150000 WHERE id = ${m.equipement.id}`;
    await t3.enqueueT3ForEntities({ accountId: m.compte.id, userId: m.compte.ownerUserId, targets: r.affectedTargets });
    await executerFile(m.compte.id);
    const eq = await kcEquipement(m.equipement.id);
    expect(eq.kc).toMatchObject({ serialNumber: 'MANUEL-1', serialNumber__origin: 'USER' });
    expect(eq.sn).toBe('MANUEL-1');
    expect(eq.ppc).toBe(150000);
    expect(eq.kc.acquisitionPrice).toBeUndefined();

    // Conflit preuve ↔ saisie : carte « À traiter » ENTITY-FIELD sur l'équipement.
    // (Une carte par champ contredit : numéro de série et prix saisi.)
    const cartes = await sql<{ public_id: string; field_key: string; action_kind: string }[]>`
      SELECT public_id, field_key, action_kind FROM to_process_actions
       WHERE account_id = ${m.compte.id} AND target_type = 'EQUIPMENT' AND target_id = ${m.equipement.id}
         AND rule_code = 'ENTITY-FIELD' AND resolved_at IS NULL ORDER BY field_key`;
    expect(cartes.map((c) => [c.field_key, c.action_kind])).toEqual([['acquisitionPrice', 'ARBITRATE'], ['serialNumber', 'ARBITRATE']]);
    const carte = cartes[1];
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    expect(await resolveArbitration(m.compte.id, carte.public_id, 'FR-2024-0077', { userId: m.compte.ownerUserId }))
      .toMatchObject({ ok: true, previousValue: 'MANUEL-1' });
    const tranche = await kcEquipement(m.equipement.id);
    expect(tranche.kc).toMatchObject({ serialNumber: 'FR-2024-0077', serialNumber__origin: 'USER' });
    expect(tranche.sn).toBe('FR-2024-0077');

    // Route d'édition : le prix modifié reçoit l'origine USER dans la fiche.
    session.currentAccountId = m.compte.id; session.userId = m.compte.ownerUserId;
    const { PUT } = await import('@/app/api/assets/[id]/equipments/[equipId]/route');
    const res = await PUT(new NextRequest(`http://x/api/assets/${m.bien.id}/equipments/${m.equipement.id}`, {
      method: 'PUT', body: JSON.stringify({ purchasePriceCents: 160000, estimatedValueCents: null }),
    }), { params: Promise.resolve({ id: String(m.bien.id), equipId: String(m.equipement.id) }) });
    expect(res.status).toBe(200);
    const apres = await kcEquipement(m.equipement.id);
    expect(apres.ppc).toBe(160000);
    expect(apres.kc).toMatchObject({ acquisitionPrice: 1600, acquisitionPrice__origin: 'USER' });
    // Valeur estimée inchangée (null → null) : aucune origine posée.
    expect(apres.kc.estimatedValue__origin).toBeUndefined();
    const [j] = await sql<{ origin: string; source_type: string }[]>`
      SELECT origin, source_type FROM canonical_field_writes WHERE target_id = ${m.equipement.id} AND canonical_key = 'acquisitionPrice' ORDER BY id DESC LIMIT 1`;
    expect(j).toEqual({ origin: 'USER', source_type: 'asset_details' });
    // La saisie a tranché la carte du prix.
    const [prix] = await sql<{ resolution_reason: string }[]>`
      SELECT resolution_reason FROM to_process_actions WHERE target_type = 'EQUIPMENT' AND target_id = ${m.equipement.id} AND field_key = 'acquisitionPrice'`;
    expect(prix.resolution_reason).toBe('USER_COMPLETED');

    // Ancien client API : montant décimal arrondi au centime (avertissement), négatif refusé.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const put = (body: unknown) => PUT(new NextRequest(`http://x/api/assets/${m.bien.id}/equipments/${m.equipement.id}`, {
      method: 'PUT', body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: String(m.bien.id), equipId: String(m.equipement.id) }) });
    expect((await put({ estimatedValueCents: 1234.6 })).status).toBe(200);
    const [{ evc }] = await sql<{ evc: number }[]>`SELECT estimated_value_cents AS evc FROM equipments WHERE id = ${m.equipement.id}`;
    expect(evc).toBe(1235);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('arrondi'));
    expect((await put({ estimatedValueCents: -5 })).status).toBe(400);
  });

  it('suppression du document → retrait des valeurs automatiques de l’équipement (valeur USER conservée)', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    process.env.T3_NEGATIVE_RECONCILIATION = 'enabled';
    const m = await maison();
    await es.writeCanonicalEntityField({ target: m.equipement, accountId: m.compte.id, origin: 'USER', key: 'brand', value: 'Frisquet', mode: 'enabled' });
    const { doc, r } = await facture(m, [
      fait(m.equipement, 'serialNumber', 'FR-2024-0077', 'N° de série : FR-2024-0077'),
      fait(m.equipement, 'warrantyEndDate', '2031-03-01', 'Garantie jusqu’au 01/03/2031', { valueType: 'date' }),
      fait(m.equipement, 'brand', 'Viessmann', 'Marque : Viessmann'),
    ]);
    await t3.enqueueT3ForEntities({ accountId: m.compte.id, userId: m.compte.ownerUserId, targets: r.affectedTargets });
    await executerFile(m.compte.id);
    expect((await kcEquipement(m.equipement.id)).sn).toBe('FR-2024-0077');

    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${doc.id}`;
    const out = await lifecycle.onDocumentsDeleted({ accountId: m.compte.id, userId: m.compte.ownerUserId, fileIds: [doc.id] });
    expect(out).toMatchObject({ mode: 'enabled', withdrawn: 3 });
    expect(await executerFile(m.compte.id)).toEqual([`equipment:${m.equipement.id}`]);

    const eq = await kcEquipement(m.equipement.id);
    expect(eq.kc.serialNumber).toBeUndefined();
    expect(eq.kc.warrantyEndDate).toBeUndefined();
    expect(eq.sn).toBeNull();
    expect(eq.kc).toMatchObject({ brand: 'Frisquet', brand__origin: 'USER' });
    const [j] = await sql<{ new_value: unknown; outcome: string }[]>`
      SELECT new_value, outcome FROM canonical_field_writes WHERE target_id = ${m.equipement.id} AND canonical_key = 'serialNumber' ORDER BY id DESC LIMIT 1`;
    expect(j).toEqual({ new_value: null, outcome: 'written' });
  });

  it('équipement déplacé vers un autre bien : preuves toujours lues, réconciliation et retrait corrects', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    process.env.T3_NEGATIVE_RECONCILIATION = 'enabled';
    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    const m = await maison();
    const studio = await make.asset(m.compte, { category: 'IMMOBILIER', name: 'Studio' });
    const { doc, r } = await facture(m, [
      fait(m.equipement, 'serialNumber', 'FR-2024-0077', 'N° de série : FR-2024-0077'),
      fait(m.equipement, 'warrantyEndDate', '2031-03-01', 'Garantie jusqu’au 01/03/2031', { valueType: 'date' }),
    ]);
    await t3.enqueueT3ForEntities({ accountId: m.compte.id, userId: m.compte.ownerUserId, targets: r.affectedTargets });
    await executerFile(m.compte.id);

    // Déplacement par la route : les preuves gardent l'ancien bien porteur.
    session.currentAccountId = m.compte.id; session.userId = m.compte.ownerUserId;
    const { PUT } = await import('@/app/api/assets/[id]/equipments/[equipId]/route');
    const res = await PUT(new NextRequest(`http://x/api/assets/${m.bien.id}/equipments/${m.equipement.id}`, {
      method: 'PUT', body: JSON.stringify({ newAssetId: studio.id }),
    }), { params: Promise.resolve({ id: String(m.bien.id), equipId: String(m.equipement.id) }) });
    expect(res.status).toBe(200);
    const porteurs = await sql<{ asset_id: number }[]>`SELECT DISTINCT asset_id FROM field_evidence WHERE source_id = ${doc.id}`;
    expect(porteurs).toEqual([{ asset_id: m.bien.id }]);

    // Lecture assistant : sur le NOUVEAU bien, avec sa preuve ; plus rien sur l'ancien.
    const { readCanonicalField } = await import('@/services/verebona-assistant/canonical/field-reader');
    const lu = await readCanonicalField(m.compte.id, studio.id, 'serialNumber');
    expect(lu?.entities).toEqual([expect.objectContaining({
      assetId: studio.id, value: 'FR-2024-0077', evidence: expect.objectContaining({ fileId: doc.id }),
    })]);
    expect((await readCanonicalField(m.compte.id, m.bien.id, 'serialNumber'))?.entities).toEqual([]);

    // Export du nouveau bien : preuve référencée.
    process.env.EXPORTS_CANONICAL_SOURCE = 'enabled';
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const src = await loadExportSource({ assetId: studio.id, accountId: m.compte.id, userId: m.compte.ownerUserId, exportType: 'DOSSIER_COMPLET' });
    expect(src.equipments.find((x) => x.id === m.equipement.id)?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'serialNumber', evidence: expect.objectContaining({ fileId: doc.id }) }),
    ]));

    // Réconciliation après déplacement : preuves trouvées, valeurs conservées.
    const { reconcileEntity } = await import('@/services/ai/reconciliation/entity-reconciliation');
    const run = await reconcileEntity({ accountId: m.compte.id, target: m.equipement, triggeredBy: 'document_linked' });
    expect(run.decisions.filter((x) => x.fieldKey === 'serialNumber').map((x) => x.action)).toEqual(['keep']);
    expect(run.retracted).toEqual([]);
    expect((await kcEquipement(m.equipement.id)).kc.serialNumber).toBe('FR-2024-0077');

    // Suppression du document : retrait sur l'équipement déplacé.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${doc.id}`;
    await lifecycle.onDocumentsDeleted({ accountId: m.compte.id, userId: m.compte.ownerUserId, fileIds: [doc.id] });
    expect(await executerFile(m.compte.id)).toEqual([`equipment:${m.equipement.id}`]);
    const apres = await kcEquipement(m.equipement.id);
    expect(apres.kc.serialNumber).toBeUndefined();
    expect(apres.kc.warrantyEndDate).toBeUndefined();
  });

  it('pièce : surface appliquée à la pièce (`substructures.area`), jamais à la surface habitable du bien', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    const m = await maison();
    const { r } = await facture(m, [fait(m.piece, 'roomArea', 18.5, 'Salon : 18,5 m²', { canonicalUnit: 'm2' })]);
    expect(r.affectedTargets).toEqual([expect.objectContaining({ type: 'ROOM', id: m.piece.id })]);
    await t3.enqueueT3ForEntities({ accountId: m.compte.id, userId: m.compte.ownerUserId, targets: r.affectedTargets });
    expect(await executerFile(m.compte.id)).toEqual([`room:${m.piece.id}`]);
    const [p] = await sql<{ area: string | null; kc: Record<string, unknown> }[]>`SELECT area, key_characteristics AS kc FROM substructures WHERE id = ${m.piece.id}`;
    expect(p.area).toBe('18.5');
    expect(p.kc).toMatchObject({ roomArea: 18.5, roomArea__origin: 'RECONCILIATION' });
    const bien = await kcBien(m.bien.id);
    expect(bien.kc.livingArea).toBeUndefined();
    expect(bien.kc.roomArea).toBeUndefined();
    const { readCanonicalEntityField } = await import('@/services/verebona-assistant/canonical/field-reader');
    expect(await readCanonicalEntityField(m.compte.id, m.piece, 'roomArea')).toMatchObject({ value: 18.5, origin: 'RECONCILIATION', entityName: 'Salon' });
  });

  it('lot 19 — conflit sur une pièce : carte ENTITY-FIELD-ROOM, libellé et bien porteur, résolution', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    const m = await maison();
    await es.writeCanonicalEntityField({ target: m.piece, accountId: m.compte.id, origin: 'USER', key: 'roomArea', value: 20, mode: 'enabled' });
    const { r } = await facture(m, [fait(m.piece, 'roomArea', 18.5, 'Salon : 18,5 m²', { canonicalUnit: 'm2' })]);
    await t3.enqueueT3ForEntities({ accountId: m.compte.id, userId: m.compte.ownerUserId, targets: r.affectedTargets });
    expect(await executerFile(m.compte.id)).toEqual([`room:${m.piece.id}`]);
    // Valeur saisie protégée, conflit ouvert.
    const [p] = await sql<{ area: string }[]>`SELECT area FROM substructures WHERE id = ${m.piece.id}`;
    expect(p.area).toBe('20');

    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    const page = await getToProcessPage(m.compte.id, { filters: { targetType: 'ROOM' } });
    const carte = page.actions.find((a) => a.targetType === 'ROOM' && a.targetId === m.piece.id)!;
    expect(carte).toMatchObject({ ruleCode: 'ENTITY-FIELD-ROOM', fieldKey: 'roomArea', actionKind: 'ARBITRATE' });
    const [bien] = await sql<{ public_id: string }[]>`SELECT public_id FROM assets WHERE id = ${m.bien.id}`;
    expect(carte.target).toMatchObject({ label: 'Salon', assetId: m.bien.id, assetName: 'Maison', publicId: bien.public_id });
    // Filtre « bien » (§8.8) : la carte de la pièce suit son bien.
    expect((await getToProcessPage(m.compte.id, { filters: { assetIds: [m.bien.id] } })).actions.some((a) => a.publicId === carte.publicId)).toBe(true);

    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    expect(await resolveArbitration(m.compte.id, carte.publicId, 18.5, { userId: m.compte.ownerUserId })).toMatchObject({ ok: true, previousValue: 20 });
    const [apres] = await sql<{ area: string; kc: Record<string, unknown> }[]>`SELECT area, key_characteristics AS kc FROM substructures WHERE id = ${m.piece.id}`;
    expect(apres.area).toBe('18.5');
    expect(apres.kc).toMatchObject({ roomArea: 18.5, roomArea__origin: 'USER' });
  });

  it('commutateurs : legacy = aucun travail ni écriture ; shadow = journal dry_run, équipement intact', async () => {
    delete process.env.CANONICAL_WRITE_MODE;
    delete process.env.T3_NEGATIVE_RECONCILIATION;
    const m = await maison();
    const { r } = await facture(m, [fait(m.equipement, 'serialNumber', 'FR-2024-0077', 'N° de série : FR-2024-0077')]);
    expect(await t3.enqueueT3ForEntities({ accountId: m.compte.id, userId: m.compte.ownerUserId, targets: r.affectedTargets })).toEqual([]);
    const { reconcileEntity } = await import('@/services/ai/reconciliation/entity-reconciliation');
    expect((await reconcileEntity({ accountId: m.compte.id, target: m.equipement, triggeredBy: 'document_analyzed' })).skipped).toBe(true);
    expect((await kcEquipement(m.equipement.id)).kc).toEqual({});

    process.env.CANONICAL_WRITE_MODE = 'shadow';
    const res = await reconcileEntity({ accountId: m.compte.id, target: m.equipement, triggeredBy: 'document_analyzed' });
    expect(res).toMatchObject({ applyMode: 'shadow', written: ['serialNumber'] });
    const eq = await kcEquipement(m.equipement.id);
    expect(eq.kc).toEqual({});
    expect(eq.sn).toBeNull();
    const [j] = await sql<{ dry_run: boolean; target_type: string }[]>`
      SELECT dry_run, target_type FROM canonical_field_writes WHERE target_id = ${m.equipement.id} AND canonical_key = 'serialNumber'`;
    expect(j).toEqual({ dry_run: true, target_type: 'EQUIPMENT' });
  });
});
