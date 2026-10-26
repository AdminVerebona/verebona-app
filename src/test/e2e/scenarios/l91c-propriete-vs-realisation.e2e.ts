/**
 * Lot 91C — projection T1 : la preuve d'une PROPRIÉTÉ métier n'est plus
 * détruite par l'absence de preuve de RÉALISATION, sur PostgreSQL 16 réel.
 * Analyses T1 par le point d'entrée de PRODUCTION (`analyzeFileSources`,
 * passerelle réelle, sorties modèle rejouées), files réelles (T3, Opérations).
 *
 *   L91C-E2E-01  document qui ENGAGE sans prouver la réalisation (type dérivé
 *                du catalogue et de la matrice d'autorité), prix explicite :
 *                preuve de champ `acquisitionPrice` ACTIVE, aucun événement
 *                réalisé, aucune date d'acquisition ; candidat Opération
 *                envisagé / coût prévu ; aucune Opération ni coût RÉALISÉ ;
 *   L91C-E2E-02  correction de l'utilisateur intacte ;
 *   L91C-E2E-03  acte définitif ensuite : comportement inchangé (achat
 *                réalisé), T3 arbitre par la matrice d'autorité ;
 *   L91C-E2E-04  facture de travaux : jamais le prix d'acquisition ;
 *   L91C-E2E-05  rattrapage du stock neutralisé (ancienne règle) : simulation
 *                sans écriture, application sans nouvel envoi ni appel T1,
 *                preuve écrite, T3 ; rejoué : rien ; refus conservés.
 *
 * Valeurs et noms de biens variés : aucun cas ne dépend d'une valeur.
 */
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, useTargetState } from '../chain';
import type { RecordedOutput } from '../replay-gateway';
import type { AccountRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/commercial-model.service', async (orig) => ({
  ...(await orig<typeof import('@/services/commercial-model.service')>()),
  canConsumeAnalysis: async () => ({ allowed: true }),
  consumeAnalysisCredits: async () => undefined,
}));
/** PDF servi au découpage et à la vérification : jamais de lecture S3 réelle. */
const pdf = vi.hoisted(() => ({ bytes: null as Uint8Array | null }));
vi.mock('@/services/ai/source-analysis/source-units/page-chunks', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/source-analysis/source-units/page-chunks')>()),
  fetchSourceBytes: async () => pdf.bytes,
}));

type Json = Record<string, any>;

interface Doc { canonicalType: string; documentTypeCode?: string | null; titre: string; euros: number; brut: string; extrait: string; label?: string }

const sortie = (d: Doc, assetId: number, nom: string, candidat?: Json) => ({
  task: 'ANALYZE_DOCUMENT',
  document: {
    title: { value: d.titre, confidence: 'certain', evidence: { excerpt: d.titre, page: 1 } },
    documentDate: { value: '2026-03-17', confidence: 'certain', evidence: { excerpt: 'Fait le 17/03/2026', page: 1 } },
    classification: { canonicalType: d.canonicalType, documentTypeCode: d.documentTypeCode ?? null, rubricCode: null, confidence: 0.95, evidence: { excerpt: d.titre, page: 1 } },
  },
  entities: {
    assets: [{ entityId: assetId, rawLabel: nom, score: 0.97, confidence: 'certain', evidenceSignals: [nom], reason: 'désignation lue' }],
    rooms: [], equipments: [], suppliers: [], multiAsset: false,
  },
  transcription: `${d.titre}\nFait le 17/03/2026\n${d.extrait}`,
  tables: [],
  facts: [{
    canonicalKey: 'acquisitionPrice', rawKey: 'prixConvenu', label: d.label ?? 'Prix', subject: null, attribute: null,
    rawValue: d.brut, normalizedValue: d.euros, valueType: 'money_eur', canonicalUnit: 'EUR',
    target: { type: 'ASSET', entityId: assetId, rawLabel: nom, confidence: 'certain', evidenceSignals: [nom] },
    provenance: 'TEXT_EXTRACTION', confidence: 'certain', evidence: { excerpt: d.extrait, page: 1 },
  }],
  hasExploitableContent: true,
  ...(candidat ? { businessOperationCandidates: [candidat] } : {}),
});
const T1 = (output: unknown): RecordedOutput => ({ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output });

scenario('L91C', 'Projection T1 : preuve d’une propriété ≠ preuve de réalisation (compromis, acte, facture, rattrapage)', ({ sql, make, replay, useRecordings: rejouer }) => {
  useTargetState({}, { masters: ['T1', 'T4'] });
  let pageUnique: Uint8Array;
  /** Types dérivés du catalogue et de la matrice (jamais codés pour ce cas). */
  let ENGAGEANT = '';
  let REALISANT = '';
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    const { PDFDocument } = await import('pdf-lib');
    const d = await PDFDocument.create();
    d.addPage();
    pageUnique = await d.save();
    const { DOCUMENT_CATALOG } = await import('@/services/canonical/registry');
    const { getAuthorityMatrix } = await import('@/services/ai/reconciliation/decision/authority-matrix');
    const ordre = getAuthorityMatrix().fieldOrders.acquisitionPrice ?? [];
    const prouveAchat = (e: (typeof DOCUMENT_CATALOG)[number]) => e.completionProofs.some((p) => p.establishes === 'completed' && (p.businessTypes ?? e.businessTypes).includes('purchase'));
    ENGAGEANT = DOCUMENT_CATALOG.find((e) => e.authority === 'AUTHORITATIVE' && e.businessTypes.includes('purchase') && !prouveAchat(e) && ordre.includes(e.code))!.code;
    REALISANT = DOCUMENT_CATALOG.find((e) => e.authority === 'AUTHORITATIVE' && prouveAchat(e) && ordre.includes(e.code))!.code;
  });
  beforeEach(() => { pdf.bytes = pageUnique; });

  const fichier = async (compte: AccountRow, assetId: number) => {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = ${`document-${f.id}.pdf`}, analysis_state = NULL WHERE id = ${f.id}`;
    return f.id;
  };
  const owner = async (compte: AccountRow) => (await sql<{ o: number }[]>`SELECT owner_user_id AS o FROM accounts WHERE id = ${compte.id}`)[0].o;
  const analyser = async (compte: AccountRow, fileId: number, records: RecordedOutput[], assetId: number) => {
    await rejouer(records);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], compte.id, { userId: await owner(compte), linkedAssetId: assetId, billable: false, origin: 'e2e/l91c' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
  };
  const preuves = (fileId: number) => sql<Json[]>`
    SELECT field_key, canonical_key, asset_id, value_json, projection_rule, semantic_event_type, semantic_event_nature, lifecycle_status, document_type
      FROM field_evidence WHERE source_id = ${fileId} AND field_key IN ('acquisitionPrice', 'acquisitionDate') ORDER BY id`;
  const kc = async (assetId: number): Promise<Json> => {
    const brut = (await sql<Json[]>`SELECT key_characteristics AS kc FROM assets WHERE id = ${assetId}`)[0].kc;
    return (typeof brut === 'string' ? JSON.parse(brut) : brut) ?? {};
  };
  const operations = (accountId: number) => sql<Json[]>`
    SELECT o.id::int AS id, o.type_code, o.status,
           coalesce((SELECT json_agg(c.kind ORDER BY c.id) FROM business_operation_financial_components c WHERE c.operation_id = o.id AND c.active), '[]'::json) AS kinds
      FROM business_operations o WHERE o.account_id = ${accountId} AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`;
  const candidat = (assetId: number, euros: number) => ({
    candidateKey: 'achat', established: true, confidence: 'certain', typeHint: 'ACQUISITION', statusHint: 'ENVISAGED',
    summary: 'Acquisition envisagée du bien', sourceRoleHint: 'CONTRACT_DOCUMENT',
    targetHints: [{ type: 'ASSET', entityId: assetId, rawLabel: null, confidence: 'certain' }], businessReferences: [], temporalHints: {},
    financialHints: [{ role: 'FORECAST_COST', amountMinor: Math.round(euros * 100), currency: 'EUR', amountScope: 'TOTAL', factIndex: 0 }],
    evidenceFactIndexes: [0],
  });

  // ══ L91C-E2E-01 ════════════════════════════════════════════════════════════
  it('L91C-E2E-01 — document qui engage sans réaliser : preuve du prix conservée, Opération envisagée, rien de réalisé', async () => {
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER', name: 'Longère du Perche' });
    const f = await fichier(c, bien.id);
    const d: Doc = { canonicalType: ENGAGEANT, titre: 'Avant-contrat de vente', euros: 287_350, brut: '287 350 €', extrait: 'Prix de vente convenu : 287 350 €' };
    await analyser(c, f, [T1(sortie(d, bien.id, 'Longère du Perche', candidat(bien.id, d.euros)))], bien.id);

    // Fait persisté : clé canonique, règle 91C, aucun événement.
    const [fait] = await sql<Json[]>`SELECT canonical_key, projection_origin, projection_rule, semantic_event_type FROM document_facts
      WHERE file_id = ${f} AND status = 'active' AND raw_key = 'prixConvenu'`;
    expect(fait).toMatchObject({ canonical_key: 'acquisitionPrice', projection_origin: 'MODEL_CANONICAL', projection_rule: 'PROPERTY_EVIDENCE_WITHOUT_REALIZATION', semantic_event_type: null });
    // Preuve de champ ACTIVE sur le bien, sans événement d'achat, et aucune date d'acquisition.
    const p = await preuves(f);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ field_key: 'acquisitionPrice', canonical_key: 'acquisitionPrice', asset_id: bien.id, projection_rule: 'PROPERTY_EVIDENCE_WITHOUT_REALIZATION',
      semantic_event_type: null, lifecycle_status: 'ACTIVE' });
    expect(Number(p[0].value_json)).toBe(d.euros);
    // T3 arbitre normalement la preuve (ici : champ vide, source admise → valeur automatique), sans date d'achat.
    const fiche = await kc(bien.id);
    expect(fiche).toMatchObject({ acquisitionPrice: d.euros, acquisitionPrice__origin: 'RECONCILIATION' });
    expect(fiche.acquisitionDate).toBeUndefined();
    expect((await sql<Json[]>`SELECT purchase_date FROM assets WHERE id = ${bien.id}`)[0].purchase_date).toBeNull();
    // Candidat Opération : envisagé, coût prévu (statut indépendant de la preuve de champ).
    const [cand] = await sql<Json[]>`SELECT type_hint, status_hint, payload FROM document_operation_candidates WHERE file_id = ${f} AND status = 'ACTIVE'`;
    expect(cand).toMatchObject({ type_hint: 'ACQUISITION', status_hint: 'ENVISAGED' });
    expect(cand.payload.financialHints.map((h: Json) => h.role)).toEqual(['FORECAST_COST']);
    // Aucune Opération ni coût RÉALISÉ inventé.
    const ops = await operations(c.id);
    expect(ops.filter((o) => o.status === 'REALIZED')).toEqual([]);
    expect(ops.flatMap((o) => o.kinds)).not.toContain('REALIZED_COST');
    // Aucun élément d'agenda « achat » réalisé.
    expect(await sql`SELECT 1 FROM field_evidence WHERE source_id = ${f} AND semantic_event_type = 'purchase'`).toHaveLength(0);
  });

  // ══ L91C-E2E-02 ════════════════════════════════════════════════════════════
  it('L91C-E2E-02 — prix saisi par l’utilisateur : jamais remplacé par la preuve du document qui engage', async () => {
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER', name: 'Appartement Croix-Rousse', keyCharacteristics: { acquisitionPrice: 199_000, acquisitionPrice__origin: 'USER' } });
    const f = await fichier(c, bien.id);
    await analyser(c, f, [T1(sortie({ canonicalType: ENGAGEANT, titre: 'Promesse de vente', euros: 205_500, brut: '205 500 €', extrait: 'au prix de 205 500 €' }, bien.id, 'Appartement'))], bien.id);
    expect((await preuves(f)).map((x) => x.field_key)).toEqual(['acquisitionPrice']);
    const v = await kc(bien.id);
    expect(v.acquisitionPrice).toBe(199_000);
    expect(v.acquisitionPrice__origin).toBe('USER');
  });

  // ══ L91C-E2E-03 ════════════════════════════════════════════════════════════
  it('L91C-E2E-03 — acte définitif : achat réalisé (inchangé) ; la matrice d’autorité le fait primer sur le document qui engage', async () => {
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison de ville' });
    const f1 = await fichier(c, bien.id);
    await analyser(c, f1, [T1(sortie({ canonicalType: ENGAGEANT, titre: 'Avant-contrat', euros: 412_000, brut: '412 000 €', extrait: 'Prix : 412 000 €' }, bien.id, 'Maison de ville'))], bien.id);
    const f2 = await fichier(c, bien.id);
    await analyser(c, f2, [T1(sortie({ canonicalType: REALISANT, titre: 'Acte de vente', euros: 405_000, brut: '405 000 €', extrait: 'moyennant le prix de 405 000 €' }, bien.id, 'Maison de ville'))], bien.id);
    const acte = await preuves(f2);
    expect(acte.find((x) => x.field_key === 'acquisitionPrice')).toMatchObject({ semantic_event_type: 'purchase', semantic_event_nature: 'HISTORICAL', lifecycle_status: 'ACTIVE' });
    expect(acte.some((x) => x.field_key === 'acquisitionDate')).toBe(true);
    // Les deux preuves coexistent ; T3 retient la valeur de l'acte (rang supérieur de la matrice).
    expect((await preuves(f1)).map((x) => x.lifecycle_status)).toEqual(['ACTIVE']);
    const v = await kc(bien.id);
    expect(v.acquisitionPrice).toBe(405_000);
    const { resolveAuthority } = await import('@/services/ai/reconciliation/decision/authority-matrix');
    expect(resolveAuthority({ fieldKey: 'acquisitionPrice', documentType: REALISANT }).score)
      .toBeGreaterThan(resolveAuthority({ fieldKey: 'acquisitionPrice', documentType: ENGAGEANT }).score);
  });

  // ══ L91C-E2E-04 ════════════════════════════════════════════════════════════
  it('L91C-E2E-04 — facture de travaux : jamais le prix d’acquisition du bien', async () => {
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER', name: 'Pavillon' });
    const f = await fichier(c, bien.id);
    await analyser(c, f, [T1(sortie({ canonicalType: 'FACTURE', documentTypeCode: 'WORKS_INVOICE', titre: 'Facture — réfection toiture', euros: 18_420, brut: '18 420 €', extrait: 'Total TTC 18 420 €', label: 'Total TTC' }, bien.id, 'Pavillon'))], bien.id);
    expect(await preuves(f)).toEqual([]);
    expect((await kc(bien.id)).acquisitionPrice).toBeUndefined();
  });

  // ══ L91C-E2E-05 ════════════════════════════════════════════════════════════
  it('L91C-E2E-05 — rattrapage du stock neutralisé : sans nouvel envoi ni appel T1, idempotent, refus conservés', async () => {
    const c = await make.account();
    const bien = await make.asset(c, { category: 'IMMOBILIER', name: 'Mas provençal' });
    const fEng = await fichier(c, bien.id);
    await analyser(c, fEng, [T1(sortie({ canonicalType: ENGAGEANT, titre: 'Avant-contrat', euros: 538_900, brut: '538 900 €', extrait: 'Prix de vente : 538 900 €' }, bien.id, 'Mas'))], bien.id);
    const fFac = await fichier(c, bien.id);
    // Facture sans finalité établie : neutralisée par l'ancienne ET la nouvelle règle.
    await analyser(c, fFac, [T1(sortie({ canonicalType: 'FACTURE', titre: 'Facture', euros: 1_250, brut: '1 250 €', extrait: 'Total 1 250 €', label: 'Total' }, bien.id, 'Mas'))], bien.id);
    expect(await sql`SELECT 1 FROM document_facts WHERE file_id = ${fFac} AND projection_rule = 'ACQUISITION_WITHOUT_PURCHASE_PROOF'`).toHaveLength(1);

    // État laissé par l'ANCIENNE projection sur le document qui engage.
    await sql`UPDATE document_facts SET canonical_key = NULL, fact_key = raw_key, projection_origin = 'GENERIC', projection_rule = 'ACQUISITION_WITHOUT_PURCHASE_PROOF'
               WHERE file_id = ${fEng} AND raw_key = 'prixConvenu'`;
    await sql`DELETE FROM field_evidence WHERE source_id = ${fEng} AND field_key = 'acquisitionPrice'`;
    const appelsAvant = replay.calls.filter((x) => x.operationCode === 't1_analyze_document').length;
    const runsAvant = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_analysis_runs WHERE account_id = ${c.id}`)[0].n;
    const { runPropertyEvidenceReprise } = await import('@/services/ai/source-analysis/projection/property-evidence-reprise');

    // Simulation : rien n'est écrit.
    const sim = await runPropertyEvidenceReprise({ apply: false, origin: 'BO', accountId: c.id });
    expect(sim).toMatchObject({ mode: 'simulate', scanned: 2, admitted: 1, requalified: 0, refused: { SOURCE_NOT_ADMISSIBLE: 1 } });
    expect(await preuves(fEng)).toEqual([]);

    // Application : fait requalifié, preuve écrite, T3 en file ; aucun appel T1, aucune nouvelle analyse.
    const app = await runPropertyEvidenceReprise({ apply: true, origin: 'BO', accountId: c.id, reason: 'recette 91C' });
    expect(app).toMatchObject({ mode: 'apply', admitted: 1, requalified: 1, evidenceWritten: 1, assetsReconciled: 1, failed: 0 });
    await drainQueues();
    const [fait] = await sql<Json[]>`SELECT canonical_key, fact_key, raw_key, projection_rule FROM document_facts WHERE file_id = ${fEng} AND raw_key = 'prixConvenu'`;
    expect(fait).toEqual({ canonical_key: 'acquisitionPrice', fact_key: 'acquisitionPrice', raw_key: 'prixConvenu', projection_rule: 'PROPERTY_EVIDENCE_WITHOUT_REALIZATION' });
    const p = await preuves(fEng);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ field_key: 'acquisitionPrice', asset_id: bien.id, semantic_event_type: null, lifecycle_status: 'ACTIVE' });
    expect(Number(p[0].value_json)).toBe(538_900);
    expect(await preuves(fFac)).toEqual([]);
    expect(replay.calls.filter((x) => x.operationCode === 't1_analyze_document').length).toBe(appelsAvant);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_analysis_runs WHERE account_id = ${c.id}`)[0].n).toBe(runsAvant);
    expect((await operations(c.id)).filter((o) => o.status === 'REALIZED')).toEqual([]);

    // Rejoué : rien à reprendre, rien d'écrit en double ; le refus reste en l'état.
    const encore = await runPropertyEvidenceReprise({ apply: true, origin: 'BO', accountId: c.id, reason: 'recette 91C' });
    expect(encore).toMatchObject({ scanned: 1, admitted: 0, requalified: 0 });
    expect(await preuves(fEng)).toHaveLength(1);
    expect(await sql`SELECT 1 FROM document_facts WHERE file_id = ${fFac} AND projection_rule = 'ACQUISITION_WITHOUT_PURCHASE_PROOF' AND canonical_key IS NULL`).toHaveLength(1);
  });
});
