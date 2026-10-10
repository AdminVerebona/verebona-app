/**
 * Lot 34E — moteur de titre v2 sur base réelle (ticket « Documents : refondre
 * le moteur de titre et assurer la repasse T3 sur l'existant »). Critères
 * TITLE2-AC1 à TITLE2-AC8.
 *
 * Chaîne de production : `analyzeFileSources` (sortie T1 rejouée) → service
 * commun `DocumentTitleService` en fin d'analyse ; rattrapage T3 par
 * `sweepDocumentTitles` (même sélection que les pages planifiées) ; contrôle
 * ciblé après une nouvelle connaissance T3 (rattachement DOCUMENT_ASSET, fait
 * → équipement). Aucun OCR, aucun appel T1 au rattrapage (compteur d'appels).
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState, type FaitT1 } from '../chain';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };

scenario('L34E-TITRE', 'Moteur de titre v2 : meilleur titre métier, repasse T3 sur l’existant, contexte versionné', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const analyser = async (compte: Compte, fileId: number, output: Record<string, unknown>) => {
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = coalesce(original_filename, ${`doc-${fileId}.pdf`}),
                analysis_state = NULL WHERE id = ${fileId}`;
    const replay = await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output, repeat: true }]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l34e-titre' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
    return replay;
  };
  /** Sortie T1 : facture avec fournisseur, date, sujets de faits. */
  const facture = (p: { title: string; supplier?: string | null; date: string; subject?: string; assets?: Array<{ id: number; label: string }>; facts?: FaitT1[] }) => {
    const facts: FaitT1[] = [
      ...(p.subject ? [{ canonicalKey: null, rawKey: 'prestation', label: 'Prestation', value: p.subject, valueType: 'string' as const, excerpt: `Prestation ${p.subject}`, assetId: null }] : []),
      ...(p.facts ?? []),
    ];
    const out = sortieT1({
      title: p.title, date: p.date, documentTypeCode: 'SUBSCRIPTION_INVOICE', canonicalType: 'FACTURE', rubricCode: 'PROPERTY_MANAGEMENT',
      supplier: p.supplier ?? null, assets: p.assets ?? [], facts, multiAsset: false,
    });
    if (p.subject) (out.facts as Array<Record<string, unknown>>)[0].subject = p.subject;
    return out;
  };
  const fichier = async (fileId: number) => (await sql<{
    retained_title: string | null; title_source: string; title_rule_version: number | null; title_context_fingerprint: string | null;
    title_checked_at: Date | null; updated_at: Date;
  }[]>`SELECT retained_title, title_source, title_rule_version, title_context_fingerprint, title_checked_at, updated_at FROM asset_files WHERE id = ${fileId}`)[0];
  const evenements = async (fileId: number) => sql<{ origin: string; outcome: string; reason: string | null; old_title: string | null; new_title: string | null; rule_version: number | null; context_fingerprint: string | null; trigger_reason: string | null }[]>`
    SELECT origin, outcome, reason, old_title, new_title, rule_version, context_fingerprint, trigger_reason FROM document_title_events WHERE file_id = ${fileId} ORDER BY id`;
  const balayer = async (compte: Compte) => {
    const { sweepDocumentTitles } = await import('@/services/ai/reconciliation/document-title-sweep');
    return sweepDocumentTitles({ accountId: compte.id });
  };
  /** Stock antérieur au lot 34E : titre SYSTEM figé, jamais contrôlé par les règles v2. */
  const stock = async (fileId: number, titre: string) => {
    await sql`UPDATE asset_files SET retained_title = ${titre}, title_source = 'SYSTEM', title_rule_version = NULL,
                title_context_fingerprint = NULL, title_checked_at = now() - interval '1 day' WHERE id = ${fileId}`;
  };
  const appelsT1 = (replay: { calls: Array<{ operationCode?: string }> }) => replay.calls.filter((c) => c.operationCode === 't1_analyze_document').length;
  const ATTENDU = 'Facture fibre Orange _ Septembre 2026';

  it('TITLE2-AC1 — nouveau document (facture, fibre, Orange, septembre 2026) : « Facture fibre Orange _ Septembre 2026 », pas « Facture fibre internet »', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: maison.id });
    await analyser(compte, doc.id, facture({ title: 'Facture fibre internet', supplier: 'Orange', date: '2026-09-05', subject: 'fibre', assets: [{ id: maison.id, label: 'Maison' }] }));
    expect(await fichier(doc.id)).toMatchObject({ retained_title: ATTENDU, title_source: 'SYSTEM', title_rule_version: 2 });
    expect((await evenements(doc.id)).at(-1)).toMatchObject({ origin: 'T1', outcome: 'UPDATED', new_title: ATTENDU, rule_version: 2 });
  });

  it('TITLE2-AC2 / TITLE2-AC8 — stock : titre valide mais médiocre « Facture fibre internet » → rattrapage T3 sans T1 ; titre suffisant et titre utilisateur intacts', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const mediocre = await make.assetFile(compte, { assetId: maison.id });
    const bon = await make.assetFile(compte, { assetId: maison.id });
    const user = await make.assetFile(compte, { assetId: maison.id });
    for (const d of [mediocre, bon, user]) {
      await analyser(compte, d.id, facture({ title: 'Facture fibre internet', supplier: 'Orange', date: '2026-09-05', subject: 'fibre', assets: [{ id: maison.id, label: 'Maison' }] }));
    }
    await stock(mediocre.id, 'Facture fibre internet');
    await stock(bon.id, ATTENDU);
    await sql`UPDATE asset_files SET retained_title = 'Ma facture', title_source = 'USER', title_rule_version = NULL WHERE id = ${user.id}`;

    const replay = await rejouer([]);
    const c = await balayer(compte);
    expect(appelsT1(replay)).toBe(0);
    expect(c.UPDATED).toBe(1);
    expect(await fichier(mediocre.id)).toMatchObject({ retained_title: ATTENDU, title_rule_version: 2 });
    expect((await evenements(mediocre.id)).at(-1)).toMatchObject({
      origin: 'T3', outcome: 'UPDATED', reason: 'SUPPLIER_ADDED', trigger_reason: 'RULE_VERSION_UPGRADE', old_title: 'Facture fibre internet', new_title: ATTENDU, rule_version: 2,
    });
    // AC8 : le titre déjà suffisant est CONTRÔLÉ (version posée) sans être renommé ; le titre USER n'est jamais touché.
    expect(await fichier(bon.id)).toMatchObject({ retained_title: ATTENDU, title_rule_version: 2 });
    expect(await fichier(user.id)).toMatchObject({ retained_title: 'Ma facture', title_source: 'USER', title_rule_version: null });
  });

  it('TITLE2-AC3 — nouvelle connaissance T3 : la Polo est identifiée (rattachement DOCUMENT_ASSET) → « Facture entretien Polo _ Octobre 2026 », sans T1', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, facture({
      title: 'Facture entretien', date: '2026-10-03', facts: [{ canonicalKey: 'registrationNumber', value: 'AB-123-CD', valueType: 'string', excerpt: 'Immatriculation AB-123-CD', assetId: null }],
    }));
    expect((await fichier(doc.id)).retained_title).toBe('Facture entretien _ Octobre 2026');
    // T3 identifie la Polo (immatriculation saisie après l'analyse).
    await sql`UPDATE assets SET registration_number = 'AB-123-CD' WHERE id = ${polo.id}`;
    const replay = await rejouer([]);
    const { sweepDocumentsWithoutPrimary } = await import('@/services/ai/reconciliation/document-asset/queue');
    expect(await sweepDocumentsWithoutPrimary({ accountId: compte.id })).toBe(1);
    await drainQueues();
    expect(appelsT1(replay)).toBe(0);
    expect((await fichier(doc.id)).retained_title).toBe('Facture entretien Polo _ Octobre 2026');
    expect((await evenements(doc.id)).at(-1)).toMatchObject({ origin: 'T3', outcome: 'UPDATED', reason: 'TARGET_ADDED', trigger_reason: 'CONTEXT_CHANGED' });
  });

  it('TITLE2-AC3 — rattachement par l’utilisateur (événement document_linked) : la réconciliation compte T3 recontrôle le titre sans attendre le balayage horaire', async () => {
    const compte = await make.account();
    const polo = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const doc = await make.assetFile(compte, { assetId: null });
    await analyser(compte, doc.id, facture({ title: 'Facture entretien', date: '2026-10-03' }));
    expect((await fichier(doc.id)).retained_title).toBe('Facture entretien _ Octobre 2026');
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    await linkDocumentToAsset({ accountId: compte.id, fileId: doc.id, target: { assetId: polo.id }, role: 'PRIMARY', origin: 'USER' });
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    const run = await reconcileAccount(compte.id, { type: 'event', event: 'document_linked', objectType: 'document', objectId: doc.id });
    expect(run.openKnowledge?.titles.updated).toBe(1);
    expect((await fichier(doc.id)).retained_title).toBe('Facture entretien Polo _ Octobre 2026');
  });

  it('TITLE2-AC4 — équipement identifié plus tard : « Facture entretien chaudière Saunier Duval _ Octobre 2026 », sans relancer T1', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: maison.id });
    await analyser(compte, doc.id, facture({
      title: 'Facture entretien chaudière', date: '2026-10-03', assets: [{ id: maison.id, label: 'Maison' }],
      facts: [{ canonicalKey: 'serialNumber', value: 'SD-998877', valueType: 'string', excerpt: 'N° série SD-998877', assetId: null }],
    }));
    expect((await fichier(doc.id)).retained_title).toBe('Facture entretien chaudière _ Octobre 2026');
    const [{ id: eq }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${maison.id}, 'Chaudière Saunier Duval') RETURNING id`;
    await sql`INSERT INTO equipment_cil_specs (equipment_id, serial_number) VALUES (${eq}, 'SD998877')`;
    const replay = await rejouer([]);
    const { reconcileOpenKnowledge } = await import('@/services/ai/reconciliation/continuous/open-knowledge.service');
    expect((await reconcileOpenKnowledge(compte.id)).facts).toMatchObject({ retargeted: 1, linkedEquipments: 1 });
    expect(appelsT1(replay)).toBe(0);
    expect((await fichier(doc.id)).retained_title).toBe('Facture entretien chaudière Saunier Duval _ Octobre 2026');
    expect((await evenements(doc.id)).at(-1)).toMatchObject({ origin: 'T3', outcome: 'UPDATED', reason: 'EQUIPMENT_ADDED' });
  });

  it('TITLE2-AC5 — titre utilisateur : aucune modification automatique (balayage, T1, nouveau rattachement)', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: maison.id });
    const sortie = facture({ title: 'Facture fibre internet', supplier: 'Orange', date: '2026-09-05', subject: 'fibre', assets: [{ id: maison.id, label: 'Maison' }] });
    await analyser(compte, doc.id, sortie);
    await sql`UPDATE asset_files SET retained_title = 'Internet maison', title_source = 'USER' WHERE id = ${doc.id}`;
    expect((await balayer(compte)).UPDATED).toBe(0);
    await analyser(compte, doc.id, sortie);
    const { ensureBusinessTitle } = await import('@/services/documents/document-title.service');
    expect(await ensureBusinessTitle({ fileId: doc.id, accountId: compte.id, origin: 'T3', mode: 'repair', trigger: 'CONTEXT_CHANGED' }))
      .toMatchObject({ outcome: 'SKIP_USER_TITLE', reason: 'USER_TITLE_PROTECTED' });
    expect(await fichier(doc.id)).toMatchObject({ retained_title: 'Internet maison', title_source: 'USER' });
  });

  it('TITLE2-AC6 / TITLE2-AC7 — deux balayages avec le même contexte : aucun renommage, aucune écriture ; pas de variation stylistique', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(compte, { assetId: maison.id });
    await analyser(compte, doc.id, facture({ title: 'Facture fibre internet', supplier: 'Orange', date: '2026-09-05', subject: 'fibre', assets: [{ id: maison.id, label: 'Maison' }] }));
    await stock(doc.id, ATTENDU); // titre déjà bon, règles antérieures
    await balayer(compte);
    const f1 = await fichier(doc.id);
    expect(f1).toMatchObject({ retained_title: ATTENDU, title_rule_version: 2 });
    const ev1 = (await evenements(doc.id)).length;
    const c2 = await balayer(compte);
    expect(c2).toEqual({ UPDATED: 0, NO_CHANGE: 0, SKIP_USER_TITLE: 0, INSUFFICIENT_DATA: 0, FAILED: 0 });
    const f2 = await fichier(doc.id);
    expect(f2.updated_at).toEqual(f1.updated_at);
    expect(f2.title_checked_at).toEqual(f1.title_checked_at);
    expect(await evenements(doc.id)).toHaveLength(ev1);
    // AC7 : nouvelle analyse au modèle formulé autrement (« Facture internet ») : pas de reformulation.
    await analyser(compte, doc.id, facture({ title: 'Facture internet Orange', supplier: 'Orange', date: '2026-09-05', subject: 'fibre', assets: [{ id: maison.id, label: 'Maison' }] }));
    expect((await fichier(doc.id)).retained_title).toBe(ATTENDU);
  });

  it('TITLE2-AC8 — reprise du stock, paginée et reprenable : tous les titres SYSTEM d’avant la version 2 sont contrôlés', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const docs = [await make.assetFile(compte, { assetId: maison.id }), await make.assetFile(compte, { assetId: maison.id }), await make.assetFile(compte, { assetId: maison.id })];
    const mois = ['2026-07-04', '2026-08-04', '2026-09-04'];
    for (const [i, d] of docs.entries()) {
      await analyser(compte, d.id, facture({ title: 'Facture fibre internet', supplier: 'Orange', date: mois[i], subject: 'fibre', assets: [{ id: maison.id, label: 'Maison' }] }));
      await stock(d.id, 'Facture fibre Orange');
    }
    const { sweepDocumentTitles } = await import('@/services/ai/reconciliation/document-title-sweep');
    // Pages bornées : un document par passage, sans retraiter les précédents.
    for (let i = 0; i < 3; i += 1) expect((await sweepDocumentTitles({ accountId: compte.id, limit: 1 })).UPDATED).toBe(1);
    expect((await sweepDocumentTitles({ accountId: compte.id, limit: 1 })).UPDATED).toBe(0);
    const titres = await Promise.all(docs.map(async (d) => (await fichier(d.id)).retained_title));
    // Discriminant métier (période), jamais « (2) ».
    expect(titres).toEqual(['Facture fibre Orange _ Juillet 2026', 'Facture fibre Orange _ Août 2026', 'Facture fibre Orange _ Septembre 2026']);
    for (const d of docs) expect((await fichier(d.id)).title_rule_version).toBe(2);
  });
});
