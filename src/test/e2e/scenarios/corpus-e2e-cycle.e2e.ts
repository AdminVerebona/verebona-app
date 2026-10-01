/**
 * Corpus §15 (CDC 15) — cycle de vie des documents : E2E-10 à E2E-13,
 * E2E-15, E2E-16, E2E-18, E2E-19, E2E-20.
 *
 * Même chaîne réelle que `corpus-e2e-documents` (`chain.ts`). Les gestes de
 * l'utilisateur sont rejoués comme les routes les exécutent :
 *   · rattacher / déplacer (`PUT /api/documents/[id]`) : colonne mise à jour,
 *     `onDocumentAssetChanged` (A → B) puis `projectDocumentKnowledgeToAsset`
 *     (projection depuis T1, sans relire le fichier) ;
 *   · supprimer (`DELETE /api/files/[id]`) : `deleted_at` puis `onDocumentsDeleted` ;
 *   · corriger la fiche : façade `updateAssetDetails` (origine USER).
 * Les files T3 et T4 sont ensuite vidées par l'exécutant de production.
 *
 * État cible (enabled / master) : voir `TARGET_SWITCHES`.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import {
  agenda, analyserDocument, demander, drainQueues, exportDe, fiche, preuves, sortieT1, useTargetState, withIds, type FaitT1,
} from '../chain';
import { loadT1Fixture } from '@/services/ai/source-analysis/__fixtures__/t1/load';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };

scenario('CORPUS-CYCLE', 'Corpus §15 — cycle de vie des documents (enabled / master)', ({ sql, make, useRecordings }) => {
  useTargetState();

  const analyser = (compte: Compte, fileId: number, linkedAssetId: number | null, output: Record<string, unknown>) =>
    analyserDocument(sql, useRecordings, { accountId: compte.id, userId: compte.ownerUserId, fileId, linkedAssetId, output });

  /** Facture d'entretien : date d'achat, dernier et prochain entretien. */
  const facture = (assetId: number | null, label: string, over: Partial<{ achat: string; due: string }> = {}) => sortieT1({
    title: `Facture entretien ${label}`, date: '2026-09-03', documentTypeCode: 'MAINTENANCE_INVOICE', amountCents: 30000, supplier: 'Garage Martin',
    assets: assetId ? [{ id: assetId, label }] : [],
    facts: [
      { canonicalKey: 'lastRevision', value: '2026-09-03', valueType: 'date', excerpt: 'Révision effectuée le 03/09/2026', assetId,
        semanticEvent: { type: 'maintenance', nature: 'HISTORICAL' } },
      { canonicalKey: 'maintenanceDueDate', value: over.due ?? '2027-09-03', valueType: 'date',
        excerpt: `Prochaine révision : ${(over.due ?? '2027-09-03').split('-').reverse().join('/')}`, assetId,
        semanticEvent: { type: 'maintenance', nature: 'DEADLINE' } },
      { canonicalKey: 'mileage', value: 45000, valueType: 'number', unit: 'km', excerpt: 'Kilométrage : 45 000 km', assetId },
    ] as FaitT1[],
  });

  /**
   * Rattachement / déplacement, comme `PUT /api/documents/[id]` : projection
   * des faits T1 persistés ; si elle ne produit aucune preuve, la route se
   * replie sur la réanalyse (`reanalyse` = sortie T1 rejouée, bien = `to`).
   */
  const rattacher = async (compte: Compte, fileId: number, from: number | null, to: number, reanalyse?: Record<string, unknown>) => {
    await sql`UPDATE asset_files SET asset_id = ${to} WHERE id = ${fileId}`;
    if (from) {
      const { onDocumentAssetChanged } = await import('@/services/ai/evidence/document-evidence-lifecycle');
      await onDocumentAssetChanged({ accountId: compte.id, userId: compte.ownerUserId, fileId, fromAssetId: from, toAssetId: to });
    }
    const { projectDocumentKnowledgeToAsset } = await import('@/services/ai/knowledge/document-knowledge.service');
    const n = await projectDocumentKnowledgeToAsset({ accountId: compte.id, userId: compte.ownerUserId, fileId, assetId: to });
    await drainQueues();
    if (n === 0 && reanalyse) await analyser(compte, fileId, to, reanalyse);
    return n;
  };
  /** État final comparable d'un bien (sans identifiants). */
  const etat = async (compte: Compte, assetId: number) => {
    const fi = await fiche(sql, assetId);
    const champs = Object.fromEntries(Object.entries(fi).filter(([k]) => !k.includes('__') && !k.startsWith('_')));
    const ex = await exportDe(compte, assetId);
    return {
      champs,
      preuves: (await preuves(sql, assetId)).map((p) => [p.key, p.value]),
      agenda: (await agenda(sql, assetId)).map((e) => [e.date, e.nature, e.businessType, e.category, e.sources.length]),
      export: { characteristics: ex.asset.characteristics, documents: ex.documents.length, events: ex.events.map((e) => [e.date, e.nature]) },
    };
  };

  it('E2E-10 — document sans bien puis rattaché (enabled/master) : état final identique à un rattachement initial', async () => {
    // Référence : document déposé directement sur le bien.
    const c1 = await make.account();
    const b1 = await make.asset(c1, { category: 'VEHICULE', name: 'Clio' });
    const f1 = await make.assetFile(c1, { assetId: b1.id });
    await analyser(c1, f1.id, b1.id, facture(b1.id, 'Clio'));

    // Même document, déposé SANS bien, puis rattaché.
    const c2 = await make.account();
    const b2 = await make.asset(c2, { category: 'VEHICULE', name: 'Clio' });
    const f2 = await make.assetFile(c2, { assetId: null });
    await analyser(c2, f2.id, null, facture(null, 'Clio'));
    expect(await preuves(sql, b2.id)).toEqual([]);
    expect(await rattacher(c2, f2.id, null, b2.id)).toBeGreaterThan(0);

    const ref = await etat(c1, b1.id);
    expect(ref.champs).toMatchObject({ lastRevision: '2026-09-03', maintenanceDueDate: '2027-09-03', mileage: 45000 });
    expect(ref.agenda).toHaveLength(2);
    expect(await etat(c2, b2.id)).toEqual(ref);
  });

  it('E2E-11 — déplacement A → B (enabled/master) : preuves, agenda et export retirés de A et projetés sur B', async () => {
    const compte = await make.account();
    const A = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const B = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const f = await make.assetFile(compte, { assetId: A.id });
    await analyser(compte, f.id, A.id, facture(A.id, 'Clio'));
    const avant = await etat(compte, A.id);
    expect(avant.preuves.length).toBe(3);
    expect(avant.agenda.length).toBe(2);

    // Les faits T1 ciblent explicitement la Clio (A) : la projection sur B
    // n'écrit rien (jamais de réécriture sur A) → repli route = réanalyse.
    expect(await rattacher(compte, f.id, A.id, B.id, facture(B.id, 'Polo'))).toBe(0);

    const a = await etat(compte, A.id);
    expect(a.preuves).toEqual([]);
    expect(a.champs).toEqual({});
    expect(a.agenda).toEqual([]);
    expect(a.export).toEqual({ characteristics: {}, documents: 0, events: [] });
    const b = await etat(compte, B.id);
    expect(b.champs).toEqual(avant.champs);
    expect(b.preuves).toEqual(avant.preuves);
    expect(b.agenda).toEqual(avant.agenda);
    expect(b.export).toEqual(avant.export);
  });

  it('E2E-12 — réanalyse, date corrigée (enabled/master) : une seule preuve active, un seul événement', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const f = await make.assetFile(compte, { assetId: clio.id });
    await analyser(compte, f.id, clio.id, facture(clio.id, 'Clio', { due: '2027-03-01' }));
    await analyser(compte, f.id, clio.id, facture(clio.id, 'Clio', { due: '2027-04-01' }));

    const actives = await sql<{ value: string }[]>`
      SELECT value_json #>> '{}' AS value FROM field_evidence
       WHERE source_id = ${f.id} AND canonical_key = 'maintenanceDueDate' AND status = 'active' AND lifecycle_status = 'ACTIVE'`;
    expect(actives.map((x) => x.value)).toEqual(['2027-04-01']);
    expect((await fiche(sql, clio.id)).maintenanceDueDate).toBe('2027-04-01');
    const echeances = (await agenda(sql, clio.id)).filter((e) => e.nature === 'DEADLINE');
    expect(echeances.map((e) => e.date)).toEqual(['2027-04-01']);
  });

  it('E2E-13 — correction humaine (enabled/master) : la valeur USER reste prioritaire sur une nouvelle preuve automatique', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const f1 = await make.assetFile(compte, { assetId: clio.id });
    await analyser(compte, f1.id, clio.id, facture(clio.id, 'Clio'));
    expect((await fiche(sql, clio.id)).mileage).toBe(45000);

    const { updateAssetDetails } = await import('@/services/asset-details-write.service');
    await updateAssetDetails({ assetId: clio.id, accountId: compte.id, section: 'vehicle_usage', fields: { mileage: 47000 }, actorUserId: compte.ownerUserId });
    expect(await fiche(sql, clio.id)).toMatchObject({ mileage: 47000, mileage__origin: 'USER' });

    const f2 = await make.assetFile(compte, { assetId: clio.id });
    await analyser(compte, f2.id, clio.id, facture(clio.id, 'Clio', { due: '2027-10-01' }));
    expect(await fiche(sql, clio.id)).toMatchObject({ mileage: 47000, mileage__origin: 'USER' });
    const t2 = await demander(compte, 'Quel est le kilométrage de la Clio ?');
    expect(t2.answer).toMatch(/47\s?000/);
  });

  it('E2E-15 — document via linkedAssetId (enabled/master) : visible dans T2 et dans l’export du bien lié', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const studio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio' });
    const f = await make.assetFile(compte, { assetId: maison.id });
    await sql`UPDATE asset_files SET linked_asset_id = ${studio.id}, retained_title = 'Facture toiture commune', document_type_code = 'WORKS_INVOICE',
              document_date = '2026-02-10', analysis_state = 'ANALYZED' WHERE id = ${f.id}`;

    const ex = await exportDe(compte, studio.id);
    expect(ex.documents.map((d) => d.id)).toContain(f.id);
    expect((await exportDe(compte, maison.id)).documents.map((d) => d.id)).toContain(f.id);
    const t2 = await demander(compte, 'Retrouve mes factures', { pageContext: { assetId: String(studio.id) } });
    expect(t2.sources.map((s) => s.id)).toContain(`doc_${f.id}`);
    const liste = await demander(compte, 'Quels sont les documents du Studio ?');
    expect(liste.answer).toContain('Facture toiture commune');
  });

  it('E2E-16 — document multi-biens (enabled/master) : chaque fait vers le bon bien, zéro contamination', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const tesla = await make.asset(compte, { category: 'VEHICULE', name: 'Tesla Model 3' });
    const f = await make.assetFile(compte, { assetId: clio.id });
    await analyser(compte, f.id, clio.id, withIds(loadT1Fixture('p-t1-04-facture-deux-vehicules.json').recording.output, { 12: clio.id, 13: tesla.id }));

    expect(await fiche(sql, clio.id)).toMatchObject({ mileage: 78000, lastRevision: '2026-09-03', maintenanceDueDate: '2027-11-15' });
    expect(await fiche(sql, tesla.id)).toMatchObject({ mileage: 42000, lastRevision: '2026-09-03', maintenanceDueDate: '2027-03-01' });
    // Fait sans cible (immatriculation du véhicule de prêt) : sur aucun bien.
    expect((await fiche(sql, clio.id)).registrationNumber).toBeUndefined();
    expect((await fiche(sql, tesla.id)).registrationNumber).toBeUndefined();
    // Agenda : aucune date de la Tesla sur la Clio.
    expect((await agenda(sql, clio.id)).map((e) => e.date)).not.toContain('2027-03-01');
    const [lien] = await sql<{ link_role: string }[]>`
      SELECT link_role FROM document_asset_links WHERE file_id = ${f.id} AND asset_id = ${tesla.id} AND status = 'ACTIVE'`;
    expect(lien?.link_role).toBe('SECONDARY');
  });

  it('E2E-18 — événement T4 lié au document (enabled/master) : visible depuis le document source', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const f = await make.assetFile(compte, { assetId: clio.id });
    await analyser(compte, f.id, clio.id, facture(clio.id, 'Clio'));
    const { listAgendaItemsForDocument } = await import('@/services/agenda/agenda-source-links');
    const depuisDoc = await listAgendaItemsForDocument(f.id, { accountId: compte.id });
    const surLeBien = await agenda(sql, clio.id);
    expect(depuisDoc.map((x) => x.id).sort()).toEqual(surLeBien.map((x) => x.id).sort());
    expect(depuisDoc).toHaveLength(2);
    // Autre compte : rien.
    expect(await listAgendaItemsForDocument(f.id, { accountId: (await make.account()).id })).toEqual([]);
  });

  it('E2E-19 — suppression d’un document (enabled/master) : preuves automatiques retirées, fiche recalculée, valeur USER intacte', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const { updateAssetDetails } = await import('@/services/asset-details-write.service');
    await updateAssetDetails({ assetId: clio.id, accountId: compte.id, section: 'vehicle_identification', fields: { registrationNumber: 'AB-123-CD' }, actorUserId: compte.ownerUserId });
    const f = await make.assetFile(compte, { assetId: clio.id });
    await analyser(compte, f.id, clio.id, facture(clio.id, 'Clio'));
    expect(await fiche(sql, clio.id)).toMatchObject({ mileage: 45000, lastRevision: '2026-09-03' });

    // Comme `DELETE /api/files/[id]`.
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${f.id}`;
    const { onDocumentsDeleted } = await import('@/services/ai/evidence/document-evidence-lifecycle');
    await onDocumentsDeleted({ accountId: compte.id, userId: compte.ownerUserId, fileIds: [f.id] });
    await drainQueues();

    expect(await preuves(sql, clio.id)).toEqual([]);
    const fi = await fiche(sql, clio.id);
    expect(fi.mileage).toBeUndefined();
    expect(fi.lastRevision).toBeUndefined();
    expect(fi.maintenanceDueDate).toBeUndefined();
    expect(fi).toMatchObject({ registrationNumber: 'AB-123-CD', registrationNumber__origin: 'USER', _registration: 'AB-123-CD' });
    // Aucune donnée fantôme : les événements automatiques du document partent avec lui.
    expect(await agenda(sql, clio.id)).toEqual([]);
  });

  it('E2E-19 — suppression, sources multiples (enabled/master) : un événement encore justifié par un autre document reste, seule la source supprimée part', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const f1 = await make.assetFile(compte, { assetId: clio.id });
    const f2 = await make.assetFile(compte, { assetId: clio.id });
    await analyser(compte, f1.id, clio.id, facture(clio.id, 'Clio'));
    await analyser(compte, f2.id, clio.id, facture(clio.id, 'Clio'));
    const [echeance] = (await agenda(sql, clio.id)).filter((e) => e.nature === 'DEADLINE');
    // Seconde source de la même échéance (consolidation T4, ou lien posé ici si T4 ne l'a pas fait).
    await sql`INSERT INTO agenda_item_sources (agenda_item_id, asset_file_id, effect_type, source_role)
              SELECT ${echeance.id}, ${f2.id}, 'linked', 'SOURCE'
               WHERE NOT EXISTS (SELECT 1 FROM agenda_item_sources WHERE agenda_item_id = ${echeance.id} AND asset_file_id = ${f2.id} AND source_role = 'SOURCE')`;
    await sql`INSERT INTO agenda_item_sources (agenda_item_id, asset_file_id, effect_type, source_role)
              SELECT ${echeance.id}, ${f1.id}, 'linked', 'SOURCE'
               WHERE NOT EXISTS (SELECT 1 FROM agenda_item_sources WHERE agenda_item_id = ${echeance.id} AND asset_file_id = ${f1.id} AND source_role = 'SOURCE')`;

    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${f1.id}`;
    const { onDocumentsDeleted } = await import('@/services/ai/evidence/document-evidence-lifecycle');
    await onDocumentsDeleted({ accountId: compte.id, userId: compte.ownerUserId, fileIds: [f1.id] });
    await drainQueues();

    const apres = (await agenda(sql, clio.id)).find((e) => e.id === echeance.id);
    expect(apres).toBeDefined();
    expect(apres!.sources).not.toContain(f1.id);
    expect(apres!.sources).toContain(f2.id);
    expect((await preuves(sql, clio.id)).every((p) => p.sourceId === f2.id)).toBe(true);
  });

  it('E2E-20 — source non autoritaire (enabled/master) : devis daté → aucune création automatique, proposition dans « À traiter »', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const f = await make.assetFile(compte, { assetId: maison.id });
    await analyser(compte, f.id, maison.id, sortieT1({
      title: 'Devis entretien chaudière', date: '2026-09-10', documentTypeCode: 'MAINTENANCE_QUOTE', canonicalType: 'DEVIS', rubricCode: 'MAINTENANCE_WORKS',
      amountCents: 18000, assets: [{ id: maison.id, label: 'Maison' }],
      facts: [
        { canonicalKey: 'maintenanceDueDate', value: '2027-05-12', valueType: 'date', excerpt: 'Intervention proposée le 12/05/2027', assetId: maison.id,
          semanticEvent: { type: 'maintenance', nature: 'DEADLINE' } },
      ],
    }));
    expect(await agenda(sql, maison.id)).toEqual([]);
    const cartes = await sql<{ rule_code: string; resolved_at: string | null }[]>`
      SELECT rule_code, resolved_at FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code LIKE 'AGENDA-PROPOSAL%'`;
    expect(cartes).toHaveLength(1);
    expect(cartes[0].resolved_at).toBeNull();
  });
});
