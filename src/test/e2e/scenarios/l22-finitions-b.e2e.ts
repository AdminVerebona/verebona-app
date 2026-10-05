/**
 * Lot 22, chantier B (finitions), sur PostgreSQL réel :
 *
 *  1. « Ce que j'ai fait » : une écriture AUTOMATIQUE sur un équipement ou une
 *     pièce laisse une ligne `ai_field_updates` CIBLÉE (migration 0236) — vue
 *     dans l'historique (`/api/ai-history`, libellé de l'entité) et l'accueil,
 *     annulable (fiche de l'entité restaurée en USER), jamais lue comme un
 *     champ du bien ;
 *  2. cache des ambiguïtés de date T4 partagé en base (`ai_operation_
 *     idempotency`, préfixe `t4-temporal:`), purge des entrées expirées ;
 *  3. moteur de propagation de cohérence : écriture par la primitive
 *     canonique (SYSTEM_RULE), valeur USER jamais écrasée (conflit « À
 *     traiter ») ;
 *  4. référentiel fournisseurs alimenté par la projection T1 (nom, SIRET) :
 *     idempotent, sans doublon, fiche utilisateur jamais modifiée.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/auth-guards', async (o) => ({
  ...(await o<object>()),
  getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
}));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

scenario('L22-B', 'Lot 22 — finitions (journal des entités, cache T4, cohérence, fournisseurs)', ({ sql, make }) => {
  beforeAll(async () => {
    const { ensureMigrations } = await import('@/db');
    await ensureMigrations();
  });

  const maison = async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const [eq] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type) VALUES (${bien.id}, 'Chaudière', 'BOILER') RETURNING id`;
    const [piece] = await sql<{ id: number }[]>`
      INSERT INTO substructures (asset_id, name, room_type) VALUES (${bien.id}, 'Salon', 'LIVING_ROOM') RETURNING id`;
    session.currentAccountId = compte.id;
    session.userId = compte.ownerUserId;
    return { compte, bien, equipement: { type: 'EQUIPMENT' as const, id: eq.id }, piece: { type: 'ROOM' as const, id: piece.id } };
  };

  // ── 1. « Ce que j'ai fait » ───────────────────────────────────────────────
  it('0236 : écriture automatique sur l’équipement / la pièce → ligne ciblée, historique, accueil, annulation', async () => {
    const m = await maison();
    const doc = await make.assetFile(m.compte, { assetId: m.bien.id, name: 'facture-chaudiere.pdf' });
    const es = await import('@/services/canonical/entity-state');
    // Valeur automatique antérieure (pour l'annulation), puis valeur lue dans la facture.
    await sql`UPDATE equipments SET key_characteristics = ${JSON.stringify({ serialNumber: 'SN-ANCIEN', serialNumber__origin: 'RECONCILIATION' })}::jsonb WHERE id = ${m.equipement.id}`;
    await es.writeCanonicalEntityFields({
      target: m.equipement, accountId: m.compte.id, origin: 'RECONCILIATION', source: { type: 'document', id: doc.id },
      writes: [{ key: 'serialNumber', value: 'FR-2024-0077' }, { key: 'warrantyEndDate', value: '2031-03-01' }],
    });
    await es.writeCanonicalEntityFields({
      target: m.piece, accountId: m.compte.id, origin: 'RECONCILIATION', writes: [{ key: 'roomArea', value: 18.5 }],
    });
    // Une saisie humaine n'est pas « ce que j'ai fait ».
    await es.writeCanonicalEntityField({ target: m.equipement, accountId: m.compte.id, origin: 'USER', key: 'brand', value: 'Viessmann' });

    const lignes = await sql<{ id: number; asset_id: number; target_type: string; target_id: number; asset_file_id: number | null; field_key: string; old_value: string | null; new_value: string }[]>`
      SELECT id, asset_id, target_type, target_id, asset_file_id, field_key, old_value, new_value FROM ai_field_updates
       WHERE account_id = ${m.compte.id} ORDER BY field_key`;
    expect(lignes.map(({ id: _i, ...l }) => l)).toEqual([
      { asset_id: m.bien.id, target_type: 'ROOM', target_id: m.piece.id, asset_file_id: null, field_key: 'roomArea', old_value: null, new_value: '18.5' },
      { asset_id: m.bien.id, target_type: 'EQUIPMENT', target_id: m.equipement.id, asset_file_id: doc.id, field_key: 'serialNumber', old_value: 'SN-ANCIEN', new_value: 'FR-2024-0077' },
      { asset_id: m.bien.id, target_type: 'EQUIPMENT', target_id: m.equipement.id, asset_file_id: doc.id, field_key: 'warrantyEndDate', old_value: null, new_value: '2031-03-01' },
    ]);

    // Historique des enrichissements : libellé de l'entité, bien porteur.
    const { GET } = await import('@/app/api/ai-history/route');
    const hist = await (await GET(new NextRequest('http://x/api/ai-history?limit=50'))).json() as {
      total: number; items: Array<{ id: number; fieldLabel: string; assetName: string; entityType: string | null; entityName: string | null }>;
    };
    expect(hist.total).toBe(3);
    expect(hist.items.map((i) => i.fieldLabel).sort()).toEqual(['Fin de garantie (Chaudière)', 'Numéro de série (Chaudière)', 'Surface de la pièce (Salon)']);
    expect(hist.items.every((i) => i.assetName === 'Maison')).toBe(true);
    // Filtre « Bien » : le bien porteur.
    const filtre = await (await GET(new NextRequest(`http://x/api/ai-history?assetId=${m.bien.id}`))).json() as { total: number };
    expect(filtre.total).toBe(3);

    // Accueil : même rendu, libellé de l'entité.
    const { buildHomeSummary } = await import('@/services/home/HomeSummaryService');
    const fait = (await buildHomeSummary(m.compte.id)).blocks.verebonaWork.items.find((w) => w.kind === 'fields');
    // Même instant (même transaction) : ordre des deux champs de l'équipement indifférent.
    expect(fait?.text).toMatch(/^J’ai complété trois informations sur Maison : .+ et surface de la pièce \(Salon\)\.$/);
    expect(fait?.text).toContain('numéro de série (Chaudière)');
    expect(fait?.text).toContain('fin de garantie (Chaudière)');

    // Assistant (historique d'un champ du BIEN) : la ligne de l'équipement n'en fait pas partie.
    const { getFieldHistory } = await import('@/services/ai/assistant/tools/read-tools');
    const h = await getFieldHistory.execute({ assetId: m.bien.id, fieldKey: 'serialNumber' }, { accountId: m.compte.id, userId: m.compte.ownerUserId, maxResults: 10 } as never);
    expect((h as { data: unknown[] }).data).toEqual([]);

    // Équipement DÉPLACÉ vers un autre bien du compte : lignes toujours visibles, nom conservé.
    const garage = await make.asset(m.compte, { category: 'IMMOBILIER', name: 'Garage' });
    await sql`UPDATE equipments SET asset_id = ${garage.id} WHERE id = ${m.equipement.id}`;
    const apres = await (await GET(new NextRequest('http://x/api/ai-history?limit=50'))).json() as typeof hist;
    expect(apres.items.map((i) => i.fieldLabel).sort()).toEqual(['Fin de garantie (Chaudière)', 'Numéro de série (Chaudière)', 'Surface de la pièce (Salon)']);
    const faitApres = (await buildHomeSummary(m.compte.id)).blocks.verebonaWork.items.find((w) => w.kind === 'fields');
    expect(faitApres?.text).toContain('numéro de série (Chaudière)');
    // Équipement d'un AUTRE compte portant le même identifiant : jamais lu (cloisonnement par compte).
    const autre = await make.account();
    const bienAutre = await make.asset(autre, { category: 'IMMOBILIER', name: 'Autre' });
    await sql`UPDATE equipments SET asset_id = ${bienAutre.id} WHERE id = ${m.equipement.id}`;
    const ailleurs = await (await GET(new NextRequest('http://x/api/ai-history?limit=50'))).json() as typeof hist;
    expect(ailleurs.items.filter((i) => i.fieldLabel.includes('(équipement supprimé)'))).toHaveLength(2);
    await sql`UPDATE equipments SET asset_id = ${garage.id} WHERE id = ${m.equipement.id}`;

    // Annulation : fiche de l'ÉQUIPEMENT restaurée (USER), fiche du bien intacte.
    const sn = hist.items.find((i) => i.fieldLabel.startsWith('Numéro de série'))!;
    const { POST } = await import('@/app/api/ai-history/[id]/revert/route');
    const rev = await POST(new NextRequest('http://x', { method: 'POST' }), { params: Promise.resolve({ id: String(sn.id) }) });
    expect(rev.status).toBe(200);
    const [eq] = await sql<{ kc: Record<string, unknown>; sn: string | null }[]>`
      SELECT e.key_characteristics AS kc, s.serial_number AS sn FROM equipments e LEFT JOIN equipment_cil_specs s ON s.equipment_id = e.id WHERE e.id = ${m.equipement.id}`;
    expect(eq.kc).toMatchObject({ serialNumber: 'SN-ANCIEN', serialNumber__origin: 'USER' });
    expect(eq.sn).toBe('SN-ANCIEN');
    const [bien] = await sql<{ kc: string | null }[]>`SELECT key_characteristics AS kc FROM assets WHERE id = ${m.bien.id}`;
    expect(JSON.parse(bien.kc ?? '{}').serialNumber).toBeUndefined();
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_field_updates WHERE id = ${sn.id}`;
    expect(n).toBe(0);
    const [j] = await sql<{ origin: string; target_type: string; source_type: string }[]>`
      SELECT origin, target_type, source_type FROM canonical_field_writes
       WHERE target_id = ${m.equipement.id} AND canonical_key = 'serialNumber' ORDER BY id DESC LIMIT 1`;
    expect(j).toEqual({ origin: 'USER', target_type: 'EQUIPMENT', source_type: 'ai_history_revert' });
  });

  // ── 2. Cache T4 partagé ───────────────────────────────────────────────────
  it('cache des ambiguïtés de date : ligne partagée en base (24 h), relue sans appel modèle, purgée à expiration', async () => {
    const compte = await make.account();
    const { resoudreAmbiguiteTemporelle, __resetTemporalCacheForTests } = await import('@/services/ai/agenda/agenda-intelligence.service');
    await __resetTemporalCacheForTests();
    const cand = { title: 'Prochain entretien', date: '2027-03-04', confidence: 'certain' as const, excerpt: 'Prochain entretien le 03/04/2027', originFieldKey: 'maintenanceDueDate' };
    const choix = { chosen: { candidateId: 2, date: '2027-04-03', interpretation: 'lecture jour/mois' }, warning: null };
    const resolve = vi.fn(async () => choix);
    const go = () => resoudreAmbiguiteTemporelle(cand, { accountId: compte.id, userId: compte.ownerUserId }, { resolve: resolve as never });

    expect(await go()).toMatchObject({ kind: 'keep', candidate: { date: '2027-04-03' } });
    const lignes = await sql<{ key_hash: string; result_json: unknown; ttl: number }[]>`
      SELECT key_hash, result_json, round(extract(epoch FROM expires_at - created_at))::int AS ttl
        FROM ai_operation_idempotency WHERE key_hash LIKE ${`t4-temporal:a${compte.id}:%`}`;
    expect(lignes).toHaveLength(1);
    expect(lignes[0].result_json).toEqual(choix);
    expect(lignes[0].ttl).toBe(24 * 3600);
    // « Autre instance » : la mémoire du processus n'intervient pas — la ligne suffit.
    await go();
    expect(resolve).toHaveBeenCalledTimes(1);

    // Expirée : jamais relue, purgée par la purge quotidienne existante, puis remplacée.
    await sql`UPDATE ai_operation_idempotency SET expires_at = now() - interval '1 second' WHERE key_hash = ${lignes[0].key_hash}`;
    const { purgeExpiredIdempotency } = await import('@/services/ai/idempotency/idempotency.service');
    expect(await purgeExpiredIdempotency()).toBeGreaterThanOrEqual(1);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_operation_idempotency WHERE key_hash = ${lignes[0].key_hash}`;
    expect(n).toBe(0);
    await go();
    expect(resolve).toHaveBeenCalledTimes(2);
    // Entrée expirée encore présente (purge non passée) : remplacée à l'écriture.
    await sql`UPDATE ai_operation_idempotency SET expires_at = now() - interval '1 second', result_json = '{"chosen":null,"warning":"ancien"}'::jsonb WHERE key_hash = ${lignes[0].key_hash}`;
    await go();
    expect(resolve).toHaveBeenCalledTimes(3);
    const [apres] = await sql<{ result_json: unknown }[]>`SELECT result_json FROM ai_operation_idempotency WHERE key_hash = ${lignes[0].key_hash}`;
    expect(apres.result_json).toEqual(choix);
  });

  // ── 3. Cohérence ──────────────────────────────────────────────────────────
  describeCoherence();
  function describeCoherence() {
    let regle = 0;
    afterAll(async () => {
      if (regle) await sql`DELETE FROM field_dependencies WHERE id = ${regle}`;
      (await import('@/services/coherence/field-dependency.service')).clearDependencyCache();
    });

    it('propagation : primitive canonique (SYSTEM_RULE) ; valeur USER jamais écrasée → conflit « À traiter »', async () => {
      const [r] = await sql<{ id: number }[]>`
        INSERT INTO field_dependencies (source_field, target_field, category, impact_type, transform_rule, confidence, is_active)
        VALUES ('l22AmountCents', 'acquisitionPrice', NULL, 'propagation', 'cents_to_euros', 'certain', true) RETURNING id`;
      regle = r.id;
      (await import('@/services/coherence/field-dependency.service')).clearDependencyCache();
      const { enqueue } = await import('@/services/coherence/impact-queue.service');
      const { processPendingImpacts } = await import('@/services/coherence/impact-propagation.service');

      const compte = await make.account();
      const vide = await make.asset(compte, { category: 'IMMOBILIER', name: 'Vide' });
      // Prix saisi à l'écran : colonne seule, sans origine → USER (vue canonique).
      const saisi = await make.asset(compte, { category: 'IMMOBILIER', name: 'Saisi', purchasePriceCents: 150000 });
      for (const a of [vide, saisi]) {
        await enqueue({ accountId: compte.id, assetId: a.id, triggerType: 'manual_request', source: 'e2e', metadata: { changedFields: { l22AmountCents: 189900 } }, priority: 0 });
      }
      const res = await processPendingImpacts(25, compte.id);
      expect(res).toMatchObject({ fieldsApplied: 1, fieldsConflicted: 1, errors: 0 });

      const [v] = await sql<{ kc: string | null; ppc: number | null }[]>`SELECT key_characteristics AS kc, purchase_price_cents AS ppc FROM assets WHERE id = ${vide.id}`;
      expect(JSON.parse(v.kc ?? '{}')).toMatchObject({ acquisitionPrice: 1899, acquisitionPrice__origin: 'SYSTEM_RULE' });
      expect(v.ppc).toBe(189900);
      const [j] = await sql<{ origin: string; source_type: string; source_id: string }[]>`
        SELECT origin, source_type, source_id FROM canonical_field_writes WHERE asset_id = ${vide.id} AND canonical_key = 'acquisitionPrice'`;
      expect(j).toEqual({ origin: 'SYSTEM_RULE', source_type: 'impact_propagation', source_id: 'l22AmountCents' });
      const [{ n: traces }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_field_updates WHERE asset_id = ${vide.id} AND field_key = 'acquisitionPrice'`;
      expect(traces).toBe(1);

      const [s] = await sql<{ kc: string | null; ppc: number | null }[]>`SELECT key_characteristics AS kc, purchase_price_cents AS ppc FROM assets WHERE id = ${saisi.id}`;
      expect(s.ppc).toBe(150000);
      expect(JSON.parse(s.kc ?? '{}').acquisitionPrice).toBeUndefined();
      const conflits = await sql<{ field_key: string; current_value: string; proposed_value: string; source_type: string; status: string }[]>`
        SELECT field_key, current_value, proposed_value, source_type, status FROM inconsistency_registry WHERE asset_id = ${saisi.id}`;
      expect(conflits).toEqual([{ field_key: 'acquisitionPrice', current_value: '1500', proposed_value: '1899', source_type: 'reconciliation', status: 'open' }]);
      // La carte existe dans « À traiter » (À arbitrer).
      const { listOpenReconciliationConflicts } = await import('@/services/ai/reconciliation/to-process-conflicts');
      const cartes = await listOpenReconciliationConflicts(compte.id);
      expect(cartes.map((c) => c.objectId)).toContain(saisi.id);
    });
  }

  // ── 4. Fournisseurs ───────────────────────────────────────────────────────
  it('référentiel fournisseurs : création, rapprochement, idempotence, fiche utilisateur intacte, document édité ignoré', async () => {
    const { feedSupplierFromAnalysis, registerSupplierReferentialHandler } = await import('@/services/suppliers/supplier-from-analysis');
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const d1 = await make.assetFile(compte, { assetId: bien.id });
    const d2 = await make.assetFile(compte, { assetId: bien.id });
    const base = { accountId: compte.id, userId: compte.ownerUserId };

    // Par l'abonné à l'analyse (comme le pipeline T1).
    const { emitSourceAnalyzed } = await import('@/services/ai/source-analysis/events');
    await registerSupplierReferentialHandler();
    await emitSourceAnalyzed({
      accountId: compte.id, userId: compte.ownerUserId, assetId: bien.id, leadSourceId: d1.id,
      result: { document: { supplier: { value: { name: 'Chauffage Martin SARL', siret: '12345678900012', supplierId: null }, confidence: 'certain', excerpt: '', location: {} } } } as never,
    });
    const [f] = await sql<{ id: number; name: string; siret: string | null; siren: string | null; source: string }[]>`
      SELECT id, name, siret, siren, source FROM suppliers WHERE account_id = ${compte.id}`;
    expect(f).toMatchObject({ name: 'Chauffage Martin SARL', siret: '12345678900012', siren: '123456789', source: 'document_extraction' });

    // Même fournisseur sur un autre document (SIRET) : lien, aucune nouvelle fiche.
    expect(await feedSupplierFromAnalysis({ ...base, documentId: d2.id, supplier: { name: 'CHAUFFAGE MARTIN', siret: '12345678900012', confidence: 'probable' } }))
      .toMatchObject({ status: 'linked', supplierId: f.id });
    // Réanalyse : rien (idempotent).
    expect(await feedSupplierFromAnalysis({ ...base, documentId: d1.id, supplier: { name: 'Chauffage Martin SARL', siret: '12345678900012' } }))
      .toEqual({ status: 'skipped', reason: 'ALREADY_LINKED' });
    const liens = await sql<{ document_id: number; supplier_id: number; is_confirmed: boolean }[]>`
      SELECT document_id, supplier_id, is_confirmed FROM document_suppliers WHERE supplier_id = ${f.id} ORDER BY document_id`;
    expect(liens.map((l) => l.document_id)).toEqual([d1.id, d2.id]);
    const [{ n: fiches }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM suppliers WHERE account_id = ${compte.id}`;
    expect(fiches).toBe(1);

    // Fiche SAISIE par l'utilisateur, autre SIRET : rapprochée par le nom, jamais modifiée ; conflit en revue.
    const [u] = await sql<{ id: number }[]>`
      INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, siret, source, created_at, updated_at)
      VALUES (${compte.id}, ${compte.ownerUserId}, 'Plomberie Durand', 'plomberie durand', '98765432100019', 'manual', now(), now()) RETURNING id`;
    const d3 = await make.assetFile(compte, { assetId: bien.id });
    expect(await feedSupplierFromAnalysis({ ...base, documentId: d3.id, supplier: { name: 'Plomberie Durand', siret: '11122233300044' } }))
      .toMatchObject({ status: 'linked', supplierId: u.id, conflicts: 1 });
    const [fu] = await sql<{ siret: string; siren: string | null }[]>`SELECT siret, siren FROM suppliers WHERE id = ${u.id}`;
    expect(fu).toEqual({ siret: '98765432100019', siren: null });
    const revues = await sql<{ item_type: string; conflicting_field: string; current_value: string; detected_value: string }[]>`
      SELECT item_type, conflicting_field, current_value, detected_value FROM supplier_review_items WHERE supplier_id = ${u.id}`;
    expect(revues).toEqual([{ item_type: 'contact_conflict', conflicting_field: 'siret', current_value: '98765432100019', detected_value: '11122233300044' }]);

    // Groupe T1 : les autres fichiers du groupe sont reliés au même fournisseur.
    const g1 = await make.assetFile(compte, { assetId: bien.id });
    const g2 = await make.assetFile(compte, { assetId: bien.id });
    const g3 = await make.assetFile(compte, { assetId: bien.id });
    await sql`UPDATE asset_files SET user_edited_fields = ${JSON.stringify({ supplier: true })}::jsonb WHERE id = ${g3.id}`;
    await emitSourceAnalyzed({
      accountId: compte.id, userId: compte.ownerUserId, assetId: bien.id, leadSourceId: g1.id,
      result: {
        sourceGroup: { sourceIds: [g1.id, g2.id, g3.id], leadSourceId: g1.id },
        document: { supplier: { value: { name: 'Menuiserie Petit', siret: null, supplierId: null }, confidence: 'certain', excerpt: '', location: {} } },
      } as never,
    });
    const groupe = await sql<{ document_id: number; supplier_id: number }[]>`
      SELECT ds.document_id, ds.supplier_id FROM document_suppliers ds WHERE ds.document_id IN (${g1.id}, ${g2.id}, ${g3.id}) ORDER BY ds.document_id`;
    expect(groupe.map((l) => l.document_id)).toEqual([g1.id, g2.id]);
    expect(new Set(groupe.map((l) => l.supplier_id)).size).toBe(1);

    // Lien RETIRÉ par l'utilisateur : la réanalyse ne le recrée pas.
    session.currentAccountId = compte.id;
    session.userId = compte.ownerUserId;
    const { DELETE } = await import('@/app/api/documents/[id]/supplier/route');
    const del = await DELETE(new NextRequest('http://x', { method: 'DELETE', body: JSON.stringify({ supplierId: groupe[1].supplier_id }) }),
      { params: Promise.resolve({ id: String(g2.id) }) });
    expect(del.status).toBe(200);
    expect(await feedSupplierFromAnalysis({ ...base, documentId: g2.id, supplier: { name: 'Menuiserie Petit' } }))
      .toEqual({ status: 'skipped', reason: 'USER_EDITED_DOCUMENT' });

    // Fournisseur modifié à la main sur le document : jamais remplacé.
    const d4 = await make.assetFile(compte, { assetId: bien.id });
    await sql`UPDATE asset_files SET user_edited_fields = ${JSON.stringify({ supplier: true })}::jsonb WHERE id = ${d4.id}`;
    expect(await feedSupplierFromAnalysis({ ...base, documentId: d4.id, supplier: { name: 'Autre Société' } }))
      .toEqual({ status: 'skipped', reason: 'USER_EDITED_DOCUMENT' });

    // Deux analyses simultanées d'un nouveau fournisseur : une seule fiche.
    const d5 = await make.assetFile(compte, { assetId: bien.id });
    const d6 = await make.assetFile(compte, { assetId: bien.id });
    await Promise.all([d5, d6].map((d) => feedSupplierFromAnalysis({ ...base, documentId: d.id, supplier: { name: 'Toiture Leroy' } })));
    const [{ n: leroy }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM suppliers WHERE account_id = ${compte.id} AND normalized_name = 'toiture leroy'`;
    expect(leroy).toBe(1);
  });
});
