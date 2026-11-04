/**
 * Lot 108E — ticket P1 « T3 DOCUMENT_ASSET — correctif #626 bis », sur
 * PostgreSQL réel (base dédiée du scénario). Données SYNTHÉTIQUES (pas d'accès
 * à la préprod ni au compte 10 : la recette réelle est faite par le PO avec le
 * diagnostic BO, voir docs/exploitation/recette-108e-t3-rattachement.md).
 *
 * Assertions OBLIGATOIRES (aucune vérification sous condition, aucune borne
 * permissive) :
 *   E1 (A1)  identité lue SEULEMENT dans une unité source (tableau) et un fait
 *            non résolu → groupe ATTESTÉ, rattachement sans IA ni T1 ;
 *   E2 (A2)  factures « Electro DEMO » + garantie Bosch : appareil → fiche
 *            d'équipement → bien ; facture multilignes jamais affectée entière ;
 *            aucun prix d'appareil recopié sur le bien ;
 *   E3 (A6)  panne IA (structurée, sémantique) : ZÉRO carte, issue technique,
 *            Supervision ; carte historique née d'une panne réexaminée (fermée),
 *            vraie ambiguïté conservée ;
 *   E4 (A5)  migration 0995 absente / graphe illisible : passage FAILED /
 *            PARTIAL + Supervision, zéro carte, reprise réelle après correction ;
 *   E5 (A7)  réparation de cohérence `userId: null` : lien, preuves projetées en
 *            contexte technique, valeur USER protégée, aucun double comptage ;
 *   E6 (C)   diagnostic BO : configuration, contrôles et journal par document.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, preuves, sortieT1, useTargetState, type FaitT1 } from '../chain';
import type { RecordedOutput } from '../replay-gateway';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
const ADR = '12 rue des Érables Fictifs, 69000 Lyon';

scenario('L108E', 'T3 DOCUMENT_ASSET — correctif #626 bis (sources T1, appareils, pannes, projection technique, diagnostic)', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();

  const T3_ABS: RecordedOutput = { operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [] }, repeat: true };
  const fait = (canonicalKey: string, value: string | number, excerpt: string, valueType: FaitT1['valueType'] = 'string'): FaitT1 => ({ canonicalKey, value, valueType, excerpt, assetId: null });
  const sortie = (p: { title: string; type?: string; texte?: string[]; facts?: FaitT1[]; supplier?: string | null }) => sortieT1({
    title: p.title, date: '2025-09-15', documentTypeCode: p.type ?? 'OTHER', rubricCode: 'PROPERTY_MANAGEMENT', supplier: p.supplier ?? null,
    assets: [], facts: p.facts ?? [], texte: p.texte, multiAsset: false,
  });
  const analyser = async (compte: Compte, out: Record<string, unknown>, opts: { assetId?: number | null } = {}) => {
    const doc = await make.assetFile(compte, { assetId: opts.assetId ?? null });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`doc-${doc.id}.pdf`}, analysis_state = NULL WHERE id = ${doc.id}`;
    await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output: out }, T3_ABS]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([doc.id], compte.id, { userId: compte.ownerUserId, billable: false, origin: 'e2e/l108e' });
    expect(r?.results.length, `analyse du fichier ${doc.id}`).toBeGreaterThan(0);
    await drainQueues();
    return doc.id;
  };
  const passage = async (compte: Compte, recordings: RecordedOutput[] = [T3_ABS]) => {
    const replay = await rejouer(recordings);
    const { reconcileAccount } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    const run = await reconcileAccount(compte.id, { type: 'scheduled' }, { triggerCode: 'asset_updated' });
    await drainQueues();
    return { run, replay };
  };
  const appels = (replay: { calls: Array<{ operationCode?: string }> }, op: string) => replay.calls.filter((c) => c.operationCode === op).length;
  const principal = async (fileId: number) => (await sql<{ a: number | null }[]>`
    SELECT COALESCE(f.asset_id, (SELECT l.asset_id FROM document_asset_links l WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND l.link_role = 'PRIMARY' ORDER BY l.id LIMIT 1)) AS a
      FROM asset_files f WHERE f.id = ${fileId}`)[0].a;
  const cartes = async (compte: Compte) => (await sql<{ id: number }[]>`
    SELECT id FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code IN ('LINK-ASSET', 'LINK-ASSET-GROUP') AND resolved_at IS NULL ORDER BY id`).map((x) => Number(x.id));
  const carteDoc = async (fileId: number) => (await sql<{ id: number }[]>`
    SELECT id FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${fileId} AND rule_code = 'LINK-ASSET' AND resolved_at IS NULL`).map((x) => Number(x.id));
  const evaluation = async (fileId: number) => (await sql<{ status: string; reason_code: string | null; e: Record<string, unknown> | null }[]>`
    SELECT status, reason_code, last_evaluation AS e FROM document_asset_resolutions WHERE file_id = ${fileId}`)[0];
  const anomalie = async (fp: string) => (await sql<{ status: string; detail: Record<string, unknown> | null }[]>`
    SELECT status, technical_detail AS detail FROM admin_anomalies WHERE fingerprint = ${fp} ORDER BY id DESC LIMIT 1`)[0];
  const equipement = async (assetId: number, name: string, serial: string) => Number((await sql<{ id: number }[]>`
    INSERT INTO equipments (asset_id, name, type, key_characteristics) VALUES (${assetId}, ${name}, 'APPLIANCE', ${JSON.stringify({ serialNumber: serial })}::jsonb) RETURNING id`)[0].id);
  const resoudre = async () => (await import('@/services/ai/reconciliation/document-asset/resolve-document-asset.service')).resolveDocumentAsset;
  const panne = async () => { throw Object.assign(new Error('provider timeout (e2e)'), { code: 'PROVIDER_TIMEOUT', operationCode: 't3_link_ambiguity' }); };

  it('E1 / A1 — identité lue SEULEMENT dans une ligne de tableau (unité source) et un fait non résolu : groupe ATTESTÉ, rattachement sans IA ni T1, sources tracées', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const ancre = await analyser(compte, sortie({ title: 'Acte notarié', type: 'ACTE_AUTHENTIQUE', texte: ['Acte de vente — voir tableau des biens'] }), { assetId: maison.id });
    const orphelin = await analyser(compte, sortie({ title: 'Avis de taxe foncière', type: 'PROPERTY_TAX', texte: ['Montant à payer 1 240 €'] }));
    // L'adresse n'existe QUE dans la couche exhaustive T1 : une ligne de tableau (acte) et un fait non intégré (taxe).
    await sql`INSERT INTO document_source_units (account_id, file_id, source_unit_id, kind, page, ordinal, content_text, coverage_status)
              VALUES (${compte.id}, ${ancre}, 'p2-t1-r1', 'TABLE_ROW', 2, 40, ${`Désignation du bien : ${ADR}`}, 'COVERED')`;
    await sql`INSERT INTO document_unresolved_facts (account_id, file_id, reason, status, raw_key, raw_value)
              VALUES (${compte.id}, ${orphelin}, 'UNKNOWN_CANONICAL_KEY', 'UNRESOLVED', 'Adresse du bien', ${ADR})`;
    expect(await principal(orphelin)).toBeNull();
    const { replay } = await passage(compte, []);
    expect(appels(replay, 't1_analyze_document') + appels(replay, 't3_link_ambiguity')).toBe(0);
    expect(await principal(orphelin)).toBe(maison.id);
    const e = await evaluation(orphelin);
    expect(e.reason_code).toBe('GROUP_IDENTITY_ATTESTED:OWN_IDENTITY');
    expect(e.e).toMatchObject({ branch: 'IDENTITY', identityGraph: { status: 'OK' }, identitySources: { counts: expect.objectContaining({ UNRESOLVED_FACTS: 1 }) } });
    const [g] = await sql<{ evidence: Array<{ fileId: number; origin: string; unitIds: string[] }> }[]>`
      SELECT evidence FROM document_identity_groups WHERE account_id = ${compte.id} AND active AND identity_family = 'PROPERTY'`;
    expect(g.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ fileId: ancre, origin: 'SOURCE_UNIT', unitIds: ['p2-t1-r1'] }),
      expect.objectContaining({ fileId: orphelin, origin: 'UNRESOLVED_FACT' }),
    ]));
  }, 240_000);

  it('E2 / A2 — factures Electro DEMO + garantie Bosch : appareil → fiche d’équipement → bien ; facture multilignes jamais affectée entière ; aucun prix d’appareil sur le bien', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const appart = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement' });
    const factureA = await analyser(compte, sortie({
      title: 'Facture Electro DEMO lave-vaisselle', type: 'PURCHASE_INVOICE', supplier: 'Electro DEMO',
      texte: ['Lave-vaisselle Bosch Serie 4', 'N° de série : FD9811-0456', `Adresse de facturation : ${ADR}`],
      facts: [fait('acquisitionPrice', 499, 'Total TTC : 499 €', 'money_eur'), fait('brand', 'Bosch', 'Marque : Bosch')],
    }));
    const garantie = await analyser(compte, sortie({ title: 'Garantie Bosch', type: 'WARRANTY_CERTIFICATE', supplier: 'Bosch', facts: [fait('serialNumber', 'FD9811-0456', 'N° de série : FD9811-0456')] }));
    const factureB = await analyser(compte, sortie({
      title: 'Facture Electro DEMO deux appareils', type: 'PURCHASE_INVOICE', supplier: 'Electro DEMO',
      texte: ['Lave-vaisselle Bosch — N° de série : FD9811-0456', 'Four Brandt — N° de série : BX77001234'],
      facts: [fait('acquisitionPrice', 1298, 'Total TTC : 1 298 €', 'money_eur')],
    }));
    expect(await principal(factureA)).toBeNull();
    // Fiches d'équipement créées APRÈS l'import des documents (série persistée, bien porteur).
    await equipement(maison.id, 'Lave-vaisselle Bosch', 'FD9811-0456');
    await equipement(appart.id, 'Four Brandt', 'BX77001234');
    await passage(compte);
    expect(await principal(factureA)).toBe(maison.id);
    expect(await principal(garantie)).toBe(maison.id);
    // Facture de DEUX appareils de deux biens : jamais affectée entière à l'un ni à l'autre.
    expect(await principal(factureB)).toBeNull();
    expect((await sql<{ e: number | null }[]>`SELECT equipment_id AS e FROM asset_files WHERE id = ${factureB}`)[0].e).toBeNull();
    const [eq] = await sql<{ status: string; target_asset_id: number | null; member_file_ids: number[]; excluded: Array<{ fileId: number; reason: string }> }[]>`
      SELECT status, target_asset_id, member_file_ids, excluded FROM document_identity_groups WHERE account_id = ${compte.id} AND active AND identity_family = 'EQUIPMENT'
       AND ${garantie} = ANY(member_file_ids)`;
    expect(eq).toMatchObject({ status: 'DEMONSTRABLE', target_asset_id: maison.id });
    expect([...eq.member_file_ids].sort((a, b) => a - b)).toEqual([factureA, garantie].sort((a, b) => a - b));
    expect(eq.excluded).toEqual(expect.arrayContaining([{ fileId: factureB, reason: 'MULTI_ARTICLE_DOCUMENT' }]));
    // Aucun prix d'appareil recopié sur le bien porteur (document d'appareil : faits sans cible jamais réattribués).
    const p = await preuves(sql, maison.id);
    expect(p.filter((x) => x.sourceId === factureA || x.sourceId === factureB).map((x) => x.key)).not.toContain('acquisitionPrice');
    expect((await evaluation(factureA)).e).toMatchObject({ projection: { equipmentDocument: true } });
    // L'adresse de FACTURATION n'a créé aucun groupe de logement.
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_identity_groups WHERE account_id = ${compte.id} AND active AND identity_family = 'PROPERTY'`)[0].n).toBe(0);
  }, 300_000);

  it('E3 / A6 — panne IA (branche structurée et sémantique) : ZÉRO carte, issue technique, Supervision ; carte née d’une panne réexaminée et fermée ; vraie ambiguïté conservée', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const resolve = await resoudre();
    const deps = { callModel: panne, crossContractActive: async () => false, aiConfigSignature: async () => 'sig' };
    // Branche sémantique (aucun candidat structuré).
    const sem = await analyser(compte, sortie({ title: 'Facture prestation', supplier: 'Prestataire Fictif' }));
    // Point de départ sans carte, contexte à réexaminer.
    await sql`UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'OBSOLETE' WHERE target_type = 'DOCUMENT' AND target_id = ${sem} AND resolved_at IS NULL`;
    await sql`UPDATE document_asset_resolutions SET context_fingerprint = NULL WHERE file_id = ${sem}`;
    await expect(resolve({ accountId: compte.id, fileId: sem, triggerCode: 'e2e', reprocessReason: 'FORCED' }, deps)).rejects.toThrow(/provider timeout/);
    const r1 = await resolve({ accountId: compte.id, fileId: sem, finalAttempt: true, triggerCode: 'e2e', reprocessReason: 'FORCED' }, deps);
    expect(r1).toMatchObject({ outcome: 'ABSTAIN', status: 'ABSTAINED', decision: { kind: 'ABSTAIN', reasonCode: 'TECHNICAL_FAILURE' } });
    expect(await carteDoc(sem)).toEqual([]);
    expect(await evaluation(sem)).toMatchObject({ status: 'ABSTAINED', reason_code: 'TECHNICAL_FAILURE', e: expect.objectContaining({ branch: 'TECHNICAL', result: 'TECHNICAL_FAILURE' }) });
    expect((await sql<{ fp: string | null }[]>`SELECT context_fingerprint AS fp FROM document_asset_resolutions WHERE file_id = ${sem}`)[0].fp).toBeNull();
    expect(await anomalie(`ai:t3-document-asset-technical:model:${compte.id}`)).toMatchObject({ status: 'open' });
    // Branche structurée (candidat T1) : même règle.
    const str = await analyser(compte, sortie({ title: 'Devis entretien', supplier: 'Artisan Fictif' }));
    await sql`UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'OBSOLETE' WHERE target_type = 'DOCUMENT' AND target_id = ${str} AND resolved_at IS NULL`;
    await sql`UPDATE document_asset_resolutions SET t1_candidates = ${JSON.stringify([{ assetId: maison.id, confidence: 'probable', score: 0.6, reason: 'bien cité', signals: 'Maison' }])}::jsonb WHERE file_id = ${str}`;
    const r2 = await resolve({ accountId: compte.id, fileId: str, finalAttempt: true, triggerCode: 'e2e', reprocessReason: 'FORCED' }, deps);
    expect(r2).toMatchObject({ status: 'ABSTAINED', decision: { reasonCode: 'TECHNICAL_FAILURE' }, aiCalled: true });
    expect(await carteDoc(str)).toEqual([]);
    // Carte HISTORIQUE née d'une panne (ancien comportement) : constat de cohérence REPAIRABLE, réexamen forcé → fermée.
    const { upsertAction } = await import('@/services/to-process/to-process-action.service');
    await upsertAction({ accountId: compte.id, targetType: 'DOCUMENT', targetId: str, relationKey: 'assetIds', actionKind: 'ARBITRATE', ruleCode: 'LINK-ASSET',
      proposals: [{ value: maison.id, label: 'Maison', confidence: 0.6 }], triggerContext: { current: '', producer: 'T3_DOCUMENT_ASSET' } });
    await sql`UPDATE document_asset_resolutions SET reason_code = 'AI_UNAVAILABLE', last_evaluation = jsonb_set(COALESCE(last_evaluation, '{}'::jsonb), '{ai}', '{"status":"ERROR"}'::jsonb) WHERE file_id = ${str}`;
    const [historique] = await carteDoc(str);
    expect(historique).toBeGreaterThan(0);
    const { documentPrimaryLinkCheck } = await import('@/services/coherence/registry/checks/document-primary-link');
    const { pgClient } = await import('@/db');
    const insp = await documentPrimaryLinkCheck.inspect!({ sql: pgClient as never, now: new Date(), today: '2026-11-03', mode: 'DRY_RUN', correlationId: 'e2e' }, compte.id, [str]);
    expect(insp.get(str)).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'PRIMARY_LINK_TECHNICAL_CARD' });
    await resolve({ accountId: compte.id, fileId: str, finalAttempt: true, triggerCode: 'coherence', reprocessReason: 'TECHNICAL_CARD_REVIEW' }, deps);
    expect(await carteDoc(str)).toEqual([]);
    const [ev] = await sql<{ details: Record<string, unknown> }[]>`SELECT details FROM to_process_action_events WHERE action_id = ${historique} AND event = 'OBSOLETE' ORDER BY id DESC LIMIT 1`;
    expect(String(ev.details.reason)).toBe('T3_TECHNICAL_FAILURE:MODEL');
    // VRAIE ambiguïté (le modèle a répondu sans preuve suffisante) puis panne : la carte est CONSERVÉE, intacte.
    const ok = { ...deps, callModel: async () => ({ task: 'LINK_AMBIGUITY' as const, matches: [] }) };
    await resolve({ accountId: compte.id, fileId: str, finalAttempt: true, triggerCode: 'e2e', reprocessReason: 'FORCED' }, ok);
    const vraie = await carteDoc(str);
    expect(vraie).toHaveLength(1);
    await resolve({ accountId: compte.id, fileId: str, finalAttempt: true, triggerCode: 'e2e', reprocessReason: 'FORCED' }, deps);
    expect(await carteDoc(str)).toEqual(vraie);
    // Premier appel réussi : incident « modèle » résolu automatiquement (contrôle après correction).
    expect(await anomalie(`ai:t3-document-asset-technical:model:${compte.id}`)).toMatchObject({ status: 'open' });
    await resolve({ accountId: compte.id, fileId: str, finalAttempt: true, triggerCode: 'e2e', reprocessReason: 'FORCED' }, ok);
    await new Promise((r) => setTimeout(r, 200));
    expect(await anomalie(`ai:t3-document-asset-technical:model:${compte.id}`)).toMatchObject({ status: 'resolved' });
  }, 300_000);

  it('E4 / A5 — migration 0995 absente puis graphe illisible : passage FAILED / PARTIAL, Supervision, zéro carte créée ; reprise réelle après correction', async () => {
    const compte = await make.account();
    await analyser(compte, sortie({ title: 'Taxe foncière', texte: [`Adresse du bien : ${ADR}`] }));
    await analyser(compte, sortie({ title: 'DPE', texte: [`Adresse du logement : ${ADR}`] }));
    await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const avant = await cartes(compte);
    await sql`ALTER TABLE document_identity_decisions RENAME TO document_identity_decisions_l108e`;
    try {
      const { run } = await passage(compte);
      expect(run.phases?.IDENTITY_GROUPS).toMatchObject({ status: 'FAILED', state: 'FAILED' });
      expect(run.phases?.OPEN_KNOWLEDGE?.status).toBe('FAILED');
      expect(run.outcome).toBe('TECHNICAL_FAILURE');
      expect(run.status).not.toBe('completed');
      expect(await cartes(compte)).toEqual(avant);
      expect(await anomalie(`ai:t3-identity-graph:migration_missing:${compte.id}`)).toMatchObject({ status: 'open', detail: expect.objectContaining({ untreatedDocuments: 2 }) });
    } finally {
      await sql`ALTER TABLE document_identity_decisions_l108e RENAME TO document_identity_decisions`;
    }
    await sql`ALTER TABLE document_unresolved_facts RENAME COLUMN raw_value TO raw_value_l108e`;
    try {
      const { run } = await passage(compte);
      expect(run.phases?.IDENTITY_GROUPS).toMatchObject({ status: 'PARTIAL', state: 'PARTIAL' });
      expect(run.phases?.OPEN_KNOWLEDGE?.status).toBe('PARTIAL');
      expect(run.outcome).toBe('PARTIAL_SUCCESS');
      expect(await cartes(compte)).toEqual(avant);
      expect(await anomalie(`ai:t3-identity-graph:graph_unavailable:${compte.id}`)).toMatchObject({ status: 'open' });
    } finally {
      await sql`ALTER TABLE document_unresolved_facts RENAME COLUMN raw_value_l108e TO raw_value`;
    }
    // Reprise réelle : la carte groupée attendue apparaît, incidents résolus automatiquement.
    const { run } = await passage(compte);
    expect(run.phases?.IDENTITY_GROUPS).toMatchObject({ status: 'DONE', state: 'DONE' });
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'LINK-ASSET-GROUP' AND resolved_at IS NULL`)[0].n).toBe(1);
    expect(await anomalie(`ai:t3-identity-graph:migration_missing:${compte.id}`)).toMatchObject({ status: 'resolved' });
    expect(await anomalie(`ai:t3-identity-graph:graph_unavailable:${compte.id}`)).toMatchObject({ status: 'resolved' });
  }, 300_000);

  it('E5 / A7 — réparation de cohérence (userId null) : lien posé, projection en contexte technique journalisée, valeur USER protégée, aucun double comptage', async () => {
    const compte = await make.account();
    const acte = await analyser(compte, sortie({
      title: 'Acte d’acquisition', type: 'ACTE_AUTHENTIQUE', texte: [`Désignation du bien : ${ADR}`],
      facts: [fait('address1', '12 rue des Érables Fictifs', 'Adresse du bien : 12 rue des Érables Fictifs'), fait('postalCode', '69000', 'Code postal : 69000'), fait('livingArea', 112, 'Surface habitable : 112 m²', 'number')],
    }));
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: { address1: '12 rue des Érables Fictifs', postalCode: '69000', city: 'Lyon', livingArea: 100, livingArea__origin: 'USER' } });
    expect(await principal(acte)).toBeNull();
    const { documentPrimaryLinkCheck } = await import('@/services/coherence/registry/checks/document-primary-link');
    const { pgClient } = await import('@/db');
    const ctx = { sql: pgClient as never, now: new Date(), today: '2026-11-03', mode: 'AUTO' as never, correlationId: 'e2e-l108e' };
    const insp = await documentPrimaryLinkCheck.inspect!(ctx, compte.id, [acte]);
    expect(insp.get(acte)).toMatchObject({ verdict: 'REPAIRABLE', anomaly: 'PRIMARY_LINK_RECOVERABLE' });
    await rejouer([]);
    await documentPrimaryLinkCheck.repair!(ctx, compte.id, [{ id: acte, inspection: insp.get(acte)! }]);
    await drainQueues();
    expect(await principal(acte)).toBe(maison.id);
    const e = await evaluation(acte);
    expect(e.e).toMatchObject({ trigger: 'coherence', projection: { actor: 'TECHNICAL', reason: 'ACCOUNT_OWNER', trigger: 'coherence', assets: [expect.objectContaining({ assetId: maison.id, status: 'PROJECTED' })] } });
    const p = await preuves(sql, maison.id);
    expect(p.filter((x) => x.sourceId === acte).map((x) => x.key)).toEqual(expect.arrayContaining(['address1', 'livingArea']));
    // Valeur USER jamais écrasée par la projection technique.
    const [kc] = await sql<{ kc: Record<string, unknown> }[]>`SELECT key_characteristics AS kc FROM assets WHERE id = ${maison.id}`;
    expect(typeof kc.kc === 'string' ? JSON.parse(kc.kc) : kc.kc).toMatchObject({ livingArea: 100, livingArea__origin: 'USER' });
    // Rejoué : déjà rattaché → aucune seconde projection, aucune preuve de plus.
    const n = p.length;
    await documentPrimaryLinkCheck.repair!(ctx, compte.id, [{ id: acte, inspection: insp.get(acte)! }]);
    await drainQueues();
    expect((await preuves(sql, maison.id)).length).toBe(n);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_asset_links WHERE file_id = ${acte} AND status = 'ACTIVE' AND link_role = 'PRIMARY'`)[0].n).toBe(1);
  }, 300_000);

  it('E6 / C — diagnostic BO : contrôles de configuration visibles, journal par document (branche, sources, groupes, carte avant → après), sans adresse', async () => {
    const compte = await make.account();
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const d1 = await analyser(compte, sortie({ title: 'Taxe foncière', texte: [`Adresse du bien : ${ADR}`] }));
    await analyser(compte, sortie({ title: 'DPE', texte: [`Adresse du logement : ${ADR}`] }));
    await passage(compte);
    const { pgClient } = await import('@/db');
    const { t3DocumentAssetDiagnostic, t3DiagnosticText, t3PromptState } = await import('@/services/ai/reconciliation/document-asset/diagnostic');
    const q = (t: string, p: unknown[]) => pgClient.unsafe(t, p as never[]) as unknown as Promise<Record<string, unknown>[]>;
    const prompt = await t3PromptState(q);
    expect(prompt.carriesCrossContract).toBe(false);
    const d = await t3DocumentAssetDiagnostic(q, [compte.id], { prompt });
    expect(d.checks.map((c) => c.code)).toEqual(['ENGINE_VERSION', 'MIGRATION_0995', 'MIGRATION_1060', 'T3_IDENTITY_GROUPS_ENABLED', 'T3_CROSS_DOCUMENT_CONTEXT_ENABLED',
      'T3_DOCUMENT_ASSET_AI_MEMORY_ENABLED', 'PROMPT_ARCHITECTURE', 'PROMPT_CROSS_MARKER', 'CROSS_CONTEXT_SENT', 'QUALIFICATION']);
    expect(d.checks.find((c) => c.code === 'MIGRATION_1060')!.ok).toBe(true);
    expect(d.checks.find((c) => c.code === 'ENGINE_VERSION')!.ok).toBe(true);
    const [a] = d.accounts;
    expect(a.counters).toMatchObject({ withoutPrimaryAsset: 2, documentsCoveredByOpenGroupCard: 2 });
    expect(a.lastRun).toMatchObject({ identityGroups: expect.objectContaining({ state: 'DONE' }) });
    const doc = a.documents!.find((x) => x.fileId === d1)!;
    expect(doc.evaluation).toMatchObject({ branch: 'GROUP_GATE', reasonCode: 'GROUP_CONFIRMATION_PENDING', identityGraph: { status: 'OK' } });
    expect(doc.groups).toEqual([expect.objectContaining({ family: 'PROPERTY', status: 'TO_CONFIRM', role: 'MEMBER', candidateAssetIds: [maison.id] })]);
    expect(doc.cards.some((c) => c.rule === 'LINK-ASSET-GROUP' && c.resolvedAt === null)).toBe(true);
    expect(JSON.stringify(d)).not.toMatch(/rables/i);
    const txt = t3DiagnosticText(d);
    expect(txt).toContain(`COMPTE ${compte.id}`);
    expect(txt).toMatch(/\[OK\] Version du moteur T3 DOCUMENT_ASSET : attendu 4 → 4/);
  }, 240_000);
});
