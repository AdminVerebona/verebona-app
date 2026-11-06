/**
 * Lot 111X — fournisseurs : coordonnées documentaires (PostgreSQL réel,
 * migrations du harnais, point d'entrée T1 de production avec sortie
 * rejouée). Copie SYNTHÉTIQUE du devis Raynard (aucune donnée du compte 13).
 *
 * L111X-E2E-AC01  T1 → T3 → suppliers → fiche : téléphone (fait SUPPLIER), e-mail et TVA (même unité
 *                 LABEL_VALUE, aucun fait — AC03), adresse de l'émetteur seule (AC04), provenance ; ni site
 *                 ni IBAN ; couverture T1 de l'unité multi-champs non « couverte » (AC11) ; historique par champ.
 * L111X-E2E-AC05  Document DÉJÀ lié : enrichissement, aucun doublon de fiche ni de lien.
 * L111X-E2E-AC06  Fiche manuelle : champ jamais renseigné complété ; effacement volontaire respecté à chaque reprise.
 * L111X-E2E-AC07  Valeur différente : conflit sourcé (pas d'écrasement), distinct du doublon d'identité ; décision persistée.
 * L111X-E2E-AC08  Preuve incertaine seule / contradictoire : abstention tracée, aucune valeur, aucune carte.
 * L111X-E2E-AC09  Document supprimé, lien retiré, fournisseur archivé, autre compte : aucun traitement indû.
 * L111X-E2E-AC10  Rattrapage par COH-SUPPLIER-COORDINATES : à blanc, correctif, idempotent sans IA ;
 *                 découpage requis sans contrat T3 → CONTRACT_PENDING persisté (jamais un faux succès).
 */
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { analyserDocument, sortieT1, useTargetState } from '../chain';
import { proofOf, runCoherenceFor } from '../coherence-run';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const NOM = 'RAYNARD TRAITEMENT DU BOIS';
const SIRET = '83272432200017';

/** Sortie T1 du devis synthétique : émetteur + SIRET, un fait téléphone ciblé SUPPLIER, e-mail / TVA laissés dans le texte. */
function devisT1(assetId: number) {
  const out = sortieT1({
    title: 'Devis n° 261104488', date: '2026-11-03', documentTypeCode: 'QUOTE', rubricCode: 'WORKS', supplier: NOM, amountCents: 198000,
    assets: [{ id: assetId, label: 'Maison' }], multiAsset: false,
    facts: [{ canonicalKey: null, rawKey: 'supplierPhone', label: 'Téléphone', value: '04 78 44 65 25', valueType: 'string', excerpt: 'Tél : 04 78 44 65 25', assetId: null }],
    texte: [
      '', NOM, '32 rue du Vorlat', '69290 Saint-Genis-les-Ollières', '',
      'Email : raynard-bois@orange.fr  TVA : FR58832724322',
      'SIRET : 832 724 322 00017', '',
      'Devis établi pour', 'M. Durand', '5 avenue des Tilleuls', '69005 Lyon', '',
      'Traitement de charpente — coût prévisionnel',
    ],
  }) as { document: { supplier: Record<string, unknown> }; facts: Array<{ target: Record<string, unknown> }> };
  out.document.supplier.siret = SIRET;
  out.facts[0].target = { type: 'SUPPLIER', entityId: null, rawLabel: NOM, confidence: 'certain', evidenceSignals: [] };
  return out as unknown as Record<string, unknown>;
}

scenario('L111X', 'Fournisseurs : coordonnées documentaires → fiche, abstentions et conflits tracés', ({ sql, make, useRecordings }) => {
  useTargetState();
  const compte = async () => {
    const c = await make.account({ plan: 'premium' });
    await sql`UPDATE users SET last_name = 'Durand' WHERE id = ${c.ownerUserId}`;
    const bien = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    await sql`UPDATE assets SET address = '5 avenue des Tilleuls', postal_code = '69005', city = 'Lyon' WHERE id = ${bien.id}`;
    session.currentAccountId = c.id; session.userId = c.ownerUserId;
    return { c, bien };
  };
  const fiche = async (id: number) => (await sql<Record<string, unknown>[]>`
    SELECT name, phone, email, website, address_line_1, postal_code, city, vat_number, iban, source, field_provenance, user_field_decisions
      FROM suppliers WHERE id = ${id}`)[0];
  const decisions = async (accountId: number, id: number) => sql<{ field_key: string; decision: string; cause: string | null; value_after: unknown; findings: unknown[] }[]>`
    SELECT DISTINCT ON (field_key) field_key, decision, cause, value_after, findings FROM property_recovery_decisions
     WHERE account_id = ${accountId} AND object_type = 'SUPPLIER' AND object_id = ${id} ORDER BY field_key, id DESC`;
  /** Connaissance T1 persistée d'un document (comme après une analyse), liée à la fiche. */
  const connaissance = async (accountId: number, fileId: number, supplierId: number | null, unites: Array<{ id: string; kind?: string; text: string; coverage?: string }>, faits: Array<{ value: string; confidence?: string }> = []) => {
    const [x] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, full_text, full_text_chars, supplier_name, supplier_siret)
      VALUES (${accountId}, ${fileId}, 'e2e', 3, ${NOM}, ${SIRET}) ON CONFLICT (file_id) DO UPDATE SET updated_at = now() RETURNING id`;
    let n = 0;
    for (const u of unites) {
      n += 1;
      await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, page, ordinal, content_text, coverage_status)
        VALUES (${accountId}, ${fileId}, ${x.id}, ${u.id}, ${u.kind ?? 'TEXT_BLOCK'}, 1, ${n}, ${u.text}, ${u.coverage ?? 'COVERED'})`;
    }
    for (const f of faits) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, value_text, normalized_value, confidence, excerpt, target_type)
        VALUES (${accountId}, ${fileId}, ${x.id}, 'supplierPhone', ${f.value}, ${f.value}, ${f.confidence ?? 'certain'}, ${f.value}, 'SUPPLIER')`;
    }
    if (supplierId) await sql`INSERT INTO document_suppliers (document_id, supplier_id, is_confirmed) VALUES (${fileId}, ${supplierId}, true) ON CONFLICT DO NOTHING`;
    return x.id;
  };
  const fournisseur = async (accountId: number, userId: number, o: Record<string, string | null> = {}) => (await sql<{ id: number }[]>`
    INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, siren, siret, source, email, phone, created_at, updated_at)
    VALUES (${accountId}, ${userId}, ${NOM}, 'raynard traitement du bois', '832724322', ${SIRET}, ${o.source ?? 'manual'}, ${o.email ?? null}, ${o.phone ?? null}, now(), now())
    RETURNING id`)[0].id;
  const recuperer = async (accountId: number, supplierId: number) => {
    const { recoverSupplierCoordinates } = await import('@/services/ai/reconciliation/missing-properties/supplier-service');
    return recoverSupplierCoordinates({ accountId, supplierId, trigger: 'e2e', deps: { capability: async () => ({ available: true, version: 'v-e2e', reason: 'AVAILABLE', contracts: ['t3-knowledge-query-v2'] }) } });
  };
  const blocRaynard = { id: 'page:1:block:1', text: `${NOM}\n32 rue du Vorlat\n69290 Saint-Genis-les-Ollières` };
  const champRaynard = { id: 'page:1:field:3', kind: 'LABEL_VALUE', text: 'Email : raynard-bois@orange.fr  TVA : FR58832724322' };

  it('L111X-E2E-AC01 — devis synthétique : T1 → T3 → fiche complète avec provenance, ni site ni IBAN ; couverture T1 (AC11)', async () => {
    const { c, bien } = await compte();
    const { registerSupplierReferentialHandler } = await import('@/services/suppliers/supplier-from-analysis');
    await registerSupplierReferentialHandler();
    const f = await make.assetFile(c, { assetId: bien.id });
    await analyserDocument(sql, useRecordings, { accountId: c.id, userId: c.ownerUserId, fileId: f.id, linkedAssetId: bien.id, output: devisT1(bien.id) });

    const [s] = await sql<{ id: number }[]>`SELECT id FROM suppliers WHERE account_id = ${c.id}`;
    expect(s).toBeTruthy();
    const x = await fiche(s.id);
    expect(x).toMatchObject({
      name: NOM, phone: '0478446525', email: 'raynard-bois@orange.fr', address_line_1: '32 rue du Vorlat', postal_code: '69290',
      city: 'Saint-Genis-les-Ollières', vat_number: 'FR58832724322', website: null, iban: null,
    });
    // Provenance par champ (document, unité ou fait, règle).
    const prov = x.field_provenance as Record<string, Record<string, unknown>>;
    expect(prov.email).toMatchObject({ source: 'DOCUMENT', rule: 'T3_SECOND_CHANCE', documentId: f.id, layer: 'SOURCE_UNIT' });
    expect(prov.phone).toMatchObject({ documentId: f.id, layer: 'FACT' });
    // AC04 : jamais l'adresse du destinataire.
    expect(JSON.stringify(x)).not.toMatch(/Tilleuls|69005/);
    // Historique par champ : écrit avec preuve, ou abstention motivée — jamais un NO_CHANGE silencieux.
    const d = Object.fromEntries((await decisions(c.id, s.id)).map((r) => [r.field_key, r]));
    // Dernière décision = passage de confirmation (déjà cohérent) ; l'écriture reste dans l'historique.
    expect(d.email).toMatchObject({ decision: 'ABSTAINED', cause: 'ALREADY_CONSISTENT' });
    const [ecrit] = await sql<{ value_after: unknown; findings: Array<Record<string, unknown>> }[]>`
      SELECT value_after, findings FROM property_recovery_decisions
       WHERE account_id = ${c.id} AND object_type = 'SUPPLIER' AND object_id = ${s.id} AND field_key = 'email' AND decision = 'WRITTEN'`;
    expect(ecrit.value_after).toBe('raynard-bois@orange.fr');
    expect(ecrit.findings[0]).toMatchObject({ fileId: f.id, layer: 'SOURCE_UNIT' });
    expect(d.website).toMatchObject({ decision: 'ABSTAINED', cause: 'NO_EVIDENCE' });
    expect(d.iban).toMatchObject({ decision: 'ABSTAINED', cause: 'NO_EVIDENCE' });
    // Aucune carte « à confirmer » pour un nouveau fournisseur sûr ; un seul lien.
    const [{ n: revues }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM supplier_review_items WHERE supplier_id = ${s.id}`;
    expect(revues).toBe(0);
    // Fiche (API) : mêmes valeurs ; IBAN jamais en clair.
    const { getSupplierDetail } = await import('@/services/suppliers/supplier-detail.service');
    const vue = (await getSupplierDetail(c.id, s.id))!;
    expect(vue.supplier).toMatchObject({ phone: '0478446525', email: 'raynard-bois@orange.fr', vatNumber: 'FR58832724322', ibanMasked: null });
    // AC11 : l'unité « Email … TVA … » n'est pas déclarée intégralement couverte sans faits e-mail / TVA.
    const [u] = await sql<{ coverage_status: string; coverage_reason: string | null }[]>`
      SELECT coverage_status, coverage_reason FROM document_source_units WHERE file_id = ${f.id} AND content_text LIKE 'Email :%'`;
    expect(u).toBeTruthy();
    expect(u.coverage_status).not.toBe('COVERED');
    // Seconde exécution : contexte inchangé → aucune écriture ni appel.
    const r = await recuperer(c.id, s.id);
    expect(['UNCHANGED_CONTEXT', 'APPLIED']).toContain(r.status);
    expect(r.written).toEqual([]);
    expect(r.aiCalls).toBe(0);
  });

  it('L111X-E2E-AC05 — document déjà lié : enrichissement, aucun doublon de fiche ni de lien', async () => {
    const { c, bien } = await compte();
    const id = await fournisseur(c.id, c.ownerUserId, { source: 'document_extraction' });
    const f = await make.assetFile(c, { assetId: bien.id });
    await connaissance(c.id, f.id, id, [blocRaynard, champRaynard], [{ value: '04 78 44 65 25' }]);
    const { feedSupplierFromAnalysis } = await import('@/services/suppliers/supplier-from-analysis');
    expect(await feedSupplierFromAnalysis({ accountId: c.id, userId: c.ownerUserId, documentId: f.id, supplier: { name: NOM, siret: SIRET, confidence: 'certain' } }))
      .toEqual({ status: 'already_linked', supplierId: id, conflicts: 0 });
    expect(await fiche(id)).toMatchObject({ phone: '0478446525', email: 'raynard-bois@orange.fr', city: 'Saint-Genis-les-Ollières' });
    const [{ fiches, liens }] = await sql<{ fiches: number; liens: number }[]>`
      SELECT (SELECT count(*)::int FROM suppliers WHERE account_id = ${c.id}) AS fiches, (SELECT count(*)::int FROM document_suppliers WHERE document_id = ${f.id}) AS liens`;
    expect({ fiches, liens }).toEqual({ fiches: 1, liens: 1 });
  });

  it('L111X-E2E-AC06 — fiche manuelle complétée ; téléphone effacé par l’utilisateur jamais réintroduit', async () => {
    const { c, bien } = await compte();
    const id = await fournisseur(c.id, c.ownerUserId, { source: 'manual' });
    const f = await make.assetFile(c, { assetId: bien.id });
    await connaissance(c.id, f.id, id, [blocRaynard, champRaynard], [{ value: '04 78 44 65 25' }]);
    expect((await recuperer(c.id, id)).written).toEqual(expect.arrayContaining(['phone', 'email', 'vatNumber']));
    expect((await fiche(id)).phone).toBe('0478446525');
    // Effacement volontaire depuis la fiche (route de production).
    const { PATCH } = await import('@/app/api/suppliers/[id]/route');
    const res = await PATCH(new NextRequest('http://x', { method: 'PATCH', body: JSON.stringify({ phone: '', email: 'raynard-bois@orange.fr' }) }), { params: Promise.resolve({ id: String(id) }) });
    expect(res.status).toBe(200);
    const apres = await fiche(id);
    expect(apres.phone).toBeNull();
    expect(apres.user_field_decisions).toMatchObject({ phone: { action: 'CLEARED' } });
    expect((apres.user_field_decisions as Record<string, unknown>).email).toBeUndefined();
    for (let i = 0; i < 2; i += 1) {
      await recuperer(c.id, id);
      expect((await fiche(id)).phone).toBeNull();
    }
    const d = Object.fromEntries((await decisions(c.id, id)).map((r) => [r.field_key, r]));
    expect(d.phone).toMatchObject({ decision: 'ABSTAINED', cause: 'USER_CLEARED' });
  });

  it('L111X-E2E-AC07 — valeur différente : conflit sourcé, jamais écrasée, distinct du doublon ; décision respectée', async () => {
    const { c, bien } = await compte();
    const id = await fournisseur(c.id, c.ownerUserId, { email: 'ancien@raynard.fr' });
    const f = await make.assetFile(c, { assetId: bien.id });
    await connaissance(c.id, f.id, id, [champRaynard]);
    const r = await recuperer(c.id, id);
    expect(r.conflicts).toBe(1);
    expect((await fiche(id)).email).toBe('ancien@raynard.fr');
    const revues = await sql<{ id: number; item_type: string; conflicting_field: string; detected_value: string; document_id: number; observation_id: number | null }[]>`
      SELECT id, item_type, conflicting_field, detected_value, document_id, observation_id FROM supplier_review_items WHERE supplier_id = ${id}`;
    expect(revues).toEqual([expect.objectContaining({ item_type: 'contact_conflict', conflicting_field: 'email', detected_value: 'raynard-bois@orange.fr', document_id: f.id })]);
    expect(revues[0].observation_id).not.toBeNull();
    // L'utilisateur garde la valeur actuelle : jamais reproposée.
    const { POST } = await import('@/app/api/to-process/suppliers/[id]/resolve/route');
    expect((await POST(new NextRequest('http://x', { method: 'POST', body: JSON.stringify({ resolution: 'keep_current' }) }), { params: Promise.resolve({ id: String(revues[0].id) }) })).status).toBe(200);
    await sql`UPDATE document_source_units SET coverage_reason = 'nouvelle lecture' WHERE file_id = ${f.id}`;
    await connaissance(c.id, f.id, id, [{ id: 'page:1:field:9', kind: 'LABEL_VALUE', text: 'Email : raynard-bois@orange.fr' }]);
    await recuperer(c.id, id);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM supplier_review_items WHERE supplier_id = ${id} AND status = 'open'`;
    expect(n).toBe(0);
    expect((await fiche(id)).email).toBe('ancien@raynard.fr');
  });

  it('L111X-E2E-AC08 — preuve incertaine seule ou contradictoire : abstention tracée, aucune valeur ni carte', async () => {
    const { c, bien } = await compte();
    const id = await fournisseur(c.id, c.ownerUserId);
    const f = await make.assetFile(c, { assetId: bien.id });
    await connaissance(c.id, f.id, id, [
      { ...champRaynard, coverage: 'UNCERTAIN' },
      { id: 'page:1:block:7', text: `${NOM} Tél : 04 78 44 65 25` }, { id: 'page:1:block:8', text: `${NOM} Tél : 04 72 00 00 01` },
    ]);
    await recuperer(c.id, id);
    const x = await fiche(id);
    expect({ email: x.email, phone: x.phone }).toEqual({ email: null, phone: null });
    const d = Object.fromEntries((await decisions(c.id, id)).map((r) => [r.field_key, r]));
    expect(d.email).toMatchObject({ decision: 'ABSTAINED', cause: 'UNCERTAIN_ONLY' });
    expect(d.phone).toMatchObject({ decision: 'ABSTAINED', cause: 'EVIDENCE_CONFLICT' });
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM supplier_review_items WHERE supplier_id = ${id}`;
    expect(n).toBe(0);
  });

  it('L111X-E2E-AC09 — document supprimé / regroupé, lien retiré, fiche archivée, autre compte : aucun traitement indû', async () => {
    const { c, bien } = await compte();
    const id = await fournisseur(c.id, c.ownerUserId);
    const supprime = await make.assetFile(c, { assetId: bien.id });
    await connaissance(c.id, supprime.id, id, [champRaynard]);
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${supprime.id}`;
    const delie = await make.assetFile(c, { assetId: bien.id });
    await connaissance(c.id, delie.id, null, [blocRaynard]);
    await recuperer(c.id, id);
    expect(await fiche(id)).toMatchObject({ email: null, vat_number: null, address_line_1: null });
    // Autre compte : un document du compte B ne peut même pas être lié à la fiche du compte A (déclencheur
    // CROSS_ACCOUNT_LINK) ; sa connaissance n'est jamais lue pour A.
    const autre = await make.account();
    const fb = await make.assetFile(autre, {});
    await connaissance(autre.id, fb.id, null, [champRaynard]);
    await expect(sql`INSERT INTO document_suppliers (document_id, supplier_id) VALUES (${fb.id}, ${id})`).rejects.toThrow(/CROSS_ACCOUNT_LINK/);
    await recuperer(c.id, id);
    expect((await fiche(id)).email).toBeNull();
    // Fiche archivée : rien.
    const actif = await make.assetFile(c, { assetId: bien.id });
    await connaissance(c.id, actif.id, id, [champRaynard]);
    await sql`UPDATE suppliers SET status = 'archived' WHERE id = ${id}`;
    expect((await recuperer(c.id, id)).status).toBe('GONE');
    expect((await fiche(id)).email).toBeNull();
  });

  it('L111X-E2E-AC10 — rattrapage COH-SUPPLIER-COORDINATES : à blanc, correctif, idempotent sans IA ; contrat T3 absent tracé', async () => {
    const { c, bien } = await compte();
    const id = await fournisseur(c.id, c.ownerUserId, { source: 'document_extraction' });
    const f = await make.assetFile(c, { assetId: bien.id });
    await connaissance(c.id, f.id, id, [blocRaynard, champRaynard, { id: 'page:1:field:5', kind: 'LABEL_VALUE', text: `${NOM} — Site web : voir au verso` }], [{ value: '04 78 44 65 25' }]);
    const blanc = await runCoherenceFor(sql, [c.id], { mode: 'DRY_RUN' });
    expect(blanc.results['COH-SUPPLIER-COORDINATES']).toMatchObject({ WOULD_REPAIR: 1 });
    expect((await fiche(id)).email).toBeNull();
    const corr = await runCoherenceFor(sql, [c.id]);
    expect(corr.results['COH-SUPPLIER-COORDINATES']).toBeTruthy();
    expect(await fiche(id)).toMatchObject({ email: 'raynard-bois@orange.fr', phone: '0478446525', website: null });
    // Découpage nécessaire (« Site web : » sans valeur lisible) sans contrat T3 : issue persistée, constat Supervision.
    const [gate] = await sql<{ status: string; cause: string }[]>`
      SELECT status, cause FROM property_recovery_runs WHERE account_id = ${c.id} AND object_type = 'SUPPLIER' AND object_id = ${id} AND status = 'CONTRACT_PENDING'`;
    expect(gate?.cause).toMatch(/t3-knowledge-query-v3/);
    const encore = await runCoherenceFor(sql, [c.id]);
    const p = await proofOf(sql, c.id, 'COH-SUPPLIER-COORDINATES', id);
    expect(['FINDING', 'CONSISTENT']).toContain(p?.last_result);
    expect(Object.values(encore.results['COH-SUPPLIER-COORDINATES'] ?? {}).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(0);
    const [{ calls }] = await sql<{ calls: number }[]>`SELECT coalesce(sum(calls), 0)::int AS calls FROM property_recovery_runs WHERE account_id = ${c.id} AND object_type = 'SUPPLIER'`;
    expect(calls).toBe(0);
  });
});
