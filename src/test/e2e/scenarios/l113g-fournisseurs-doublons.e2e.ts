/**
 * Lot 113G (ticket #706) — fournisseurs : création automatique, arbitrage des
 * seuls doublons plausibles (PostgreSQL réel, migrations du harnais, chemins de
 * production : `feedSupplierFromAnalysis` → revue → `produceSupplierActions` →
 * `getToProcessPage` → `resolveArbitration` → fusion / séparation ;
 * `COH-SUPPLIER-IDENTITY` par l'orchestrateur de cohérence).
 * Noms SYNTHÉTIQUES (aucune donnée réelle).
 *
 * L113G-E2E-AC01  nouveau prestataire sans fiche proche : fiche + lien créés, fiabilité RÉELLE (non promue),
 *                 base NEW_SUPPLIER, aucune revue ni carte ; AC07 idem sur compte historique ;
 *                 règle 6 : le nom d'un membre du compte (client cité) n'alimente pas le référentiel ;
 * L113G-E2E-AC02  même fournisseur (SIRET identique, nom en casse différente) : fiche réutilisée, aucune carte ;
 * L113G-E2E-AC03  noms proches sans preuve : UNE carte « S’agit-il du même fournisseur ? », A / B exposés,
 *                 Oui / Non seulement, aucune fusion anticipée ; AC06 trois documents → une carte, revue
 *                 inverse portant la même paire → toujours une carte ; plusieurs candidats : paire par paire ;
 * L113G-E2E-AC04  « Oui » : fusion persistante (documents, observations, revues), fiche fusionnée archivée avec
 *                 son identifiant de référence, carte fermée, fiabilité des liens conservée ; clics concurrents ;
 * L113G-E2E-AC05  « Non » : fiches et liens intacts, décision persistée ; nouveau document, réanalyse et campagne
 *                 de cohérence : aucune nouvelle proposition ; preuve objective nouvelle : réouverture tracée ;
 * L113G-E2E-AC09  stock : paire plausible jamais revue → revue + carte (à blanc d'abord), revue obsolète close,
 *                 liens anciens ni promus ni requalifiés, paire tranchée respectée, rejeu idempotent ;
 * L113G-E2E-AC10  isolation des comptes (candidat d'un autre compte ignoré, décision intercomptes refusée).
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import { runCoherenceFor } from '../coherence-run';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const CHECK = 'COH-SUPPLIER-IDENTITY';

scenario('L113G', 'Fournisseurs : création automatique, arbitrage des seuls doublons, décisions respectées', ({ sql, make }) => {
  const nouveauCompte = async () => {
    const c = await make.account({ plan: 'premium' });
    await sql`UPDATE users SET first_name = 'Jean', last_name = 'Durand' WHERE id = ${c.ownerUserId}`;
    const bien = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    return { c, bien };
  };
  const feed = async (c: AccountRow, bienId: number, name: string, siret: string | null = null) => {
    const f = await make.assetFile(c, { assetId: bienId });
    const { feedSupplierFromAnalysis } = await import('@/services/suppliers/supplier-from-analysis');
    const r = await feedSupplierFromAnalysis({ accountId: c.id, userId: c.ownerUserId, documentId: f.id, supplier: { name, siret, confidence: 'certain' }, enrich: false });
    return { fileId: f.id, r };
  };
  const produire = async (c: AccountRow) => (await import('@/services/to-process/producers.service')).produceSupplierActions(c.id);
  const page = async (c: AccountRow) => (await import('@/services/to-process/to-process-query.service')).getToProcessPage(c.id, {});
  const cartesFournisseur = async (c: AccountRow) => (await page(c)).actions.filter((v) => v.ruleCode === 'SUPPLIER-IDENTITY');
  const resoudre = async (c: AccountRow, publicId: string, value: string) =>
    (await import('@/services/to-process/resolve-action.service')).resolveArbitration(c.id, publicId, value, { userId: c.ownerUserId });
  const fiches = (c: AccountRow) => sql<{ id: number; name: string; status: string; merged_into_supplier_id: number | null; source: string }[]>`
    SELECT id, name, status, merged_into_supplier_id, source FROM suppliers WHERE account_id = ${c.id} ORDER BY id`;
  const lien = async (fileId: number) => (await sql<{ supplier_id: number; is_confirmed: boolean; confidence_score: string | null; match_basis: string | null }[]>`
    SELECT supplier_id, is_confirmed, confidence_score, match_basis FROM document_suppliers WHERE document_id = ${fileId}`);
  const revuesOuvertes = (c: AccountRow) => sql<{ id: number; supplier_id: number; candidate_supplier_ids: number[] }[]>`
    SELECT id, supplier_id, candidate_supplier_ids FROM supplier_review_items
     WHERE account_id = ${c.id} AND item_type = 'deduplication' AND status = 'open' ORDER BY id`;
  const decisions = (c: AccountRow) => sql<{ supplier_low_id: number; supplier_high_id: number; decision: string; reopen_reason: string | null }[]>`
    SELECT supplier_low_id, supplier_high_id, decision, reopen_reason FROM supplier_identity_decisions WHERE account_id = ${c.id} ORDER BY id`;

  it('L113G-E2E-AC01 — nouveau prestataire : fiche + lien sans confirmation, fiabilité réelle ; client cité ignoré (AC07, règle 6)', async () => {
    const { c, bien } = await nouveauCompte();
    // Compte « historique » : d'autres fournisseurs sans rapport existent déjà (AC07).
    await feed(c, bien.id, 'Garage Martin');
    await feed(c, bien.id, 'Leroy Merlin');
    const { fileId, r } = await feed(c, bien.id, 'RAYNARD TRAITEMENT DU BOIS');
    expect(r.status).toBe('created');
    const raynard = (await fiches(c)).find((f) => f.name === 'RAYNARD TRAITEMENT DU BOIS')!;
    expect(raynard).toMatchObject({ source: 'document_extraction', status: 'active' });
    // Raison sociale stockée telle quelle (casse d'origine) ; lien : base NEW_SUPPLIER, fiabilité NON promue.
    expect(await lien(fileId)).toEqual([{ supplier_id: raynard.id, is_confirmed: false, confidence_score: '1', match_basis: 'NEW_SUPPLIER' }]);
    expect(await revuesOuvertes(c)).toEqual([]);
    await produire(c);
    expect(await cartesFournisseur(c)).toEqual([]);

    // Règle 6 : « Jean Durand » est le titulaire (client cité sur le devis), jamais un fournisseur.
    const client = await feed(c, bien.id, 'Jean Durand');
    expect(client.r).toEqual({ status: 'skipped', reason: 'ACCOUNT_PARTY' });
    expect(await lien(client.fileId)).toEqual([]);
    // … mais « Durand Plomberie » reste un fournisseur.
    expect((await feed(c, bien.id, 'Durand Plomberie')).r.status).toBe('created');
  });

  it('L113G-E2E-AC02 — même fournisseur (SIRET identique, autre casse) : fiche réutilisée, aucune nouvelle fiche ni carte', async () => {
    const { c, bien } = await nouveauCompte();
    const a = await feed(c, bien.id, 'RAYNARD TRAITEMENT DU BOIS', '83272432200017');
    const b = await feed(c, bien.id, 'Raynard Traitement du Bois', '83272432200017');
    const autreNom = await feed(c, bien.id, 'Ets Raynard - Charpente', '832724322');
    expect(a.r.status).toBe('created');
    expect(b.r.status).toBe('linked');
    expect(autreNom.r.status).toBe('linked'); // même SIREN : certitude par identifiant, quel que soit le nom
    expect((await fiches(c))).toHaveLength(1);
    expect((await lien(b.fileId))[0]).toMatchObject({ is_confirmed: true, match_basis: 'IDENTIFIER' });
    expect(await revuesOuvertes(c)).toEqual([]);
    await produire(c);
    expect(await cartesFournisseur(c)).toEqual([]);
  });

  /** Fiche « déjà connue » B (« Raynard Bois ») puis fiche détectée A au nom proche, sans identifiant. */
  const paireIncertaine = async () => {
    const { c, bien } = await nouveauCompte();
    const b = await feed(c, bien.id, 'Raynard Bois');
    const a1 = await feed(c, bien.id, 'Raynard Traitement du Bois');
    const a2 = await feed(c, bien.id, 'RAYNARD TRAITEMENT DU BOIS');
    const a3 = await feed(c, bien.id, 'Raynard Traitement du Bois');
    const [B, A] = await fiches(c);
    return { c, bien, A, B, docs: { b: b.fileId, a: [a1.fileId, a2.fileId, a3.fileId] }, results: [b.r, a1.r, a2.r, a3.r] };
  };

  it('L113G-E2E-AC03 / AC06 — noms proches : une seule carte A / B, Oui / Non, aucune fusion anticipée', async () => {
    const { c, A, B, docs, results } = await paireIncertaine();
    expect(results.map((r) => r.status)).toEqual(['created', 'created_uncertain', 'linked', 'linked']);
    expect(A.status).toBe('active'); expect(B.status).toBe('active');
    expect((await lien(docs.a[0]))[0]).toMatchObject({ supplier_id: A.id, is_confirmed: false, match_basis: 'UNCERTAIN_NEW' });
    // Une revue legacy « inverse » portant la même paire ne crée pas de seconde carte.
    await sql`INSERT INTO supplier_review_items (account_id, item_type, status, supplier_id, detected_name, candidate_supplier_ids)
              VALUES (${c.id}, 'deduplication', 'open', ${B.id}, 'Raynard Bois', ${JSON.stringify([A.id])}::jsonb)`;
    await produire(c);
    await produire(c); // rejeu : aucune oscillation, aucun doublon
    const cartes = await cartesFournisseur(c);
    expect(cartes).toHaveLength(1);
    const carte = cartes[0];
    expect(carte.question).toBe('S’agit-il du même fournisseur ?');
    expect(carte.choiceMode).toBe('BINARY');
    expect(carte.proposals.map((p) => p.label)).toEqual(['Oui', 'Non']);
    expect(carte.supplierPair).toMatchObject({
      detected: { id: A.id, name: 'Raynard Traitement du Bois', siren: null, documents: 3 },
      known: { id: B.id, name: 'Raynard Bois', siren: null, documents: 1 },
    });
    expect(JSON.stringify(carte)).not.toMatch(/Opération/);
    // Aucune fusion anticipée, aucun lien déplacé.
    expect((await fiches(c)).map((f) => f.status)).toEqual(['active', 'active']);
    expect((await lien(docs.b))[0].supplier_id).toBe(B.id);
  });

  it('L113G-E2E-AC06 bis — plusieurs candidats : une carte par fiche, paire par paire (la suivante après « Non »)', async () => {
    const { c, bien, A, B } = await paireIncertaine();
    const x = await feed(c, bien.id, 'Raynard'); // proche de A ET de B
    expect(x.r.status).toBe('created_uncertain');
    const C = (await fiches(c)).at(-1)!;
    await produire(c);
    const pourC = () => cartesFournisseur(c).then((l) => l.filter((v) => v.supplierPair?.detected.id === C.id));
    const [premiere] = await pourC();
    expect(premiere).toBeTruthy();
    const premierConnu = premiere.supplierPair!.known.id;
    expect([A.id, B.id]).toContain(premierConnu);
    expect(await pourC()).toHaveLength(1);
    expect((await resoudre(c, premiere.publicId, 'DISTINCT')).ok).toBe(true);
    const [suivante] = await pourC();
    expect(suivante.supplierPair!.known.id).toBe(premierConnu === A.id ? B.id : A.id);
    expect(suivante.publicId).not.toBe(premiere.publicId);
  });

  it('L113G-E2E-AC04 — « Oui » : fusion persistante sans perte, carte fermée ; clic concurrent sans double effet', async () => {
    const { c, bien, A, B, docs } = await paireIncertaine();
    await produire(c);
    const [carte] = await cartesFournisseur(c);
    const [r1, r2] = await Promise.all([resoudre(c, carte.publicId, 'SAME'), resoudre(c, carte.publicId, 'SAME')]);
    expect([r1.ok, r2.ok].sort()).toEqual([false, true]);
    expect([r1.error, r2.error].filter(Boolean)).toEqual(['ALREADY_RESOLVED']);
    expect([r1, r2].find((r) => r.ok)!.undoable).toBe(false);

    const apres = await fiches(c);
    expect(apres.find((f) => f.id === A.id)).toMatchObject({ status: 'archived', merged_into_supplier_id: B.id });
    expect(apres.find((f) => f.id === B.id)).toMatchObject({ status: 'active', name: 'Raynard Bois' });
    for (const d of docs.a) {
      const l = await lien(d);
      expect(l).toHaveLength(1);
      expect(l[0]).toMatchObject({ supplier_id: B.id, match_basis: 'MERGED' });
    }
    // Fiabilité réelle conservée (jamais promue par la fusion).
    expect((await lien(docs.a[0]))[0].is_confirmed).toBe(false);
    const [{ n: obs }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM supplier_contact_observations WHERE supplier_id = ${A.id}`;
    expect(obs).toBe(0);
    expect(await revuesOuvertes(c)).toEqual([]);
    expect(await decisions(c)).toEqual([{ supplier_low_id: Math.min(A.id, B.id), supplier_high_id: Math.max(A.id, B.id), decision: 'SAME', reopen_reason: null }]);
    expect(await cartesFournisseur(c)).toEqual([]);
    // Nouveau document au nom de A : rattaché à la fiche CONSERVÉE (raison sociale de la fiche fusionnée), aucune fiche ni carte.
    const nouveau = await feed(c, bien.id, 'Raynard Traitement du Bois');
    expect(nouveau.r).toMatchObject({ status: 'linked', supplierId: B.id });
    expect(await fiches(c)).toHaveLength(2);
    await produire(c);
    expect(await cartesFournisseur(c)).toEqual([]);
  });

  it('L113G-E2E-AC05 — « Non » : décision persistée, jamais reproposée (document, réanalyse, cohérence) ; preuve nouvelle : réouverture', async () => {
    const { c, bien, A, B, docs } = await paireIncertaine();
    await produire(c);
    const [carte] = await cartesFournisseur(c);
    expect((await resoudre(c, carte.publicId, 'DISTINCT')).ok).toBe(true);
    expect((await fiches(c)).map((f) => f.status)).toEqual(['active', 'active']);
    expect((await lien(docs.a[0]))[0].supplier_id).toBe(A.id);
    expect((await lien(docs.b))[0].supplier_id).toBe(B.id);
    expect(await decisions(c)).toEqual([{ supplier_low_id: Math.min(A.id, B.id), supplier_high_id: Math.max(A.id, B.id), decision: 'DISTINCT', reopen_reason: null }]);
    expect(await revuesOuvertes(c)).toEqual([]);
    expect(await cartesFournisseur(c)).toEqual([]);

    // Nouveaux documents des deux fournisseurs, réanalyse (même document repassé), producteur, cohérence corrective.
    await feed(c, bien.id, 'Raynard Traitement du Bois');
    await feed(c, bien.id, 'Raynard Bois');
    const { feedSupplierFromAnalysis } = await import('@/services/suppliers/supplier-from-analysis');
    expect((await feedSupplierFromAnalysis({ accountId: c.id, userId: c.ownerUserId, documentId: docs.a[0], supplier: { name: 'Raynard Traitement du Bois', confidence: 'certain' }, enrich: false })).status).toBe('already_linked');
    await produire(c);
    const coh = await runCoherenceFor(sql, [c.id]);
    expect(coh.results[CHECK]?.REPAIRED ?? 0).toBe(0);
    expect(await revuesOuvertes(c)).toEqual([]);
    expect(await cartesFournisseur(c)).toEqual([]);
    expect(await fiches(c)).toHaveLength(2);

    // Preuve OBJECTIVE nouvelle : même SIREN des deux côtés → paire reproposée, motif tracé.
    await sql`UPDATE suppliers SET siren = '832724322' WHERE id IN (${A.id}, ${B.id})`;
    const { openIdentityReview } = await import('@/services/suppliers/supplier-identity-reviews');
    const { db } = await import('@/db');
    const r = await openIdentityReview(db, { accountId: c.id, supplierId: A.id, documentId: null, detectedName: 'Raynard Traitement du Bois', candidateIds: [B.id] });
    expect(r.reviewId).not.toBeNull();
    expect((await decisions(c))[0]).toMatchObject({ decision: 'DISTINCT', reopen_reason: 'NEW_MATCHING_IDENTIFIER' });
  });

  it('L113G-E2E-AC09 — stock : à blanc puis correctif ; vrais arbitrages ouverts une fois, obsolètes clos, liens anciens intacts', async () => {
    const { c, bien } = await nouveauCompte();
    const fiche = async (name: string, source = 'document_extraction') => (await sql<{ id: number }[]>`
      INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, source, status, created_at, updated_at)
      VALUES (${c.id}, ${c.ownerUserId}, ${name}, ${name.toLowerCase()}, ${source}, 'active', now(), now()) RETURNING id`)[0].id;
    const ancien = await fiche('raynard bois');
    const recent = await fiche('raynard traitement du bois');
    const m1 = await fiche('menuiserie lambert', 'manual');
    const m2 = await fiche('menuiserie lambert et fils', 'manual'); // deux saisies de l'utilisateur : ses choix
    const g = await fiche('garage martin');
    const k = await fiche('castorama');
    const d1 = await fiche('plomberie dupuis'); const d2 = await fiche('plomberie dupuis services');
    await sql`INSERT INTO supplier_identity_decisions (account_id, supplier_low_id, supplier_high_id, decision, basis)
              VALUES (${c.id}, ${d1}, ${d2}, 'DISTINCT', 'SIMILAR_NAME')`;
    // Lien ancien non confirmé (avant 113G : match_basis NULL) — ni promu ni requalifié.
    const f = await make.assetFile(c, { assetId: bien.id });
    await sql`INSERT INTO document_suppliers (document_id, supplier_id, is_confirmed) VALUES (${f.id}, ${recent}, false)`;
    // Revue legacy sans paire utile (noms sans ressemblance) : obsolète.
    await sql`INSERT INTO supplier_review_items (account_id, item_type, status, supplier_id, detected_name, candidate_supplier_ids)
              VALUES (${c.id}, 'deduplication', 'open', ${k}, 'castorama', ${JSON.stringify([g])}::jsonb)`;

    const blanc = await runCoherenceFor(sql, [c.id], { mode: 'DRY_RUN' });
    expect(blanc.results[CHECK]).toMatchObject({ WOULD_REPAIR: 2 });
    expect(await revuesOuvertes(c)).toHaveLength(1); // rien écrit à blanc

    const corr = await runCoherenceFor(sql, [c.id]);
    expect(corr.results[CHECK]).toMatchObject({ REPAIRED: 2 });
    const ouvertes = await revuesOuvertes(c);
    expect(ouvertes).toEqual([expect.objectContaining({ supplier_id: recent, candidate_supplier_ids: [ancien] })]);
    const [{ resolution }] = await sql<{ resolution: string }[]>`SELECT resolution FROM supplier_review_items WHERE supplier_id = ${k}`;
    expect(resolution).toBe('obsolete');
    const cartes = await cartesFournisseur(c);
    expect(cartes).toHaveLength(1);
    expect(cartes[0].supplierPair).toMatchObject({ detected: { id: recent }, known: { id: ancien } });
    expect(await lien(f.id)).toEqual([{ supplier_id: recent, is_confirmed: false, confidence_score: null, match_basis: null }]);
    expect((await fiches(c)).every((x) => x.status === 'active')).toBe(true);
    expect([m1, m2, d1, d2].some((id) => ouvertes.some((o) => o.supplier_id === id))).toBe(false);

    // Rejeu : idempotent (aucune revue ni carte de plus).
    const encore = await runCoherenceFor(sql, [c.id]);
    expect(encore.results[CHECK]?.REPAIRED ?? 0).toBe(0);
    expect(await revuesOuvertes(c)).toHaveLength(1);
    expect(await cartesFournisseur(c)).toHaveLength(1);
  });

  it('L113G-E2E-AC10 — isolation : candidat d’un autre compte ignoré, décision intercomptes refusée', async () => {
    const un = await nouveauCompte();
    const deux = await nouveauCompte();
    await feed(deux.c, deux.bien.id, 'Raynard Bois');
    const { r } = await feed(un.c, un.bien.id, 'Raynard Traitement du Bois');
    expect(r.status).toBe('created');
    expect(await revuesOuvertes(un.c)).toEqual([]);
    const [a] = await fiches(un.c); const [b] = await fiches(deux.c);
    await expect(sql`INSERT INTO supplier_identity_decisions (account_id, supplier_low_id, supplier_high_id, decision)
                     VALUES (${un.c.id}, ${Math.min(a.id, b.id)}, ${Math.max(a.id, b.id)}, 'DISTINCT')`).rejects.toThrow(/SUPPLIER_IDENTITY_CROSS_ACCOUNT/);
    const { openIdentityReview } = await import('@/services/suppliers/supplier-identity-reviews');
    const { db } = await import('@/db');
    expect((await openIdentityReview(db, { accountId: un.c.id, supplierId: a.id, documentId: null, detectedName: 'x', candidateIds: [b.id] })).reviewId).toBeNull();
  });
});
