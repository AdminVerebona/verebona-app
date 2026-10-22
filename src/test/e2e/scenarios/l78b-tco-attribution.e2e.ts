/**
 * Lot 78B — ticket P1 « Opérations & TCO — identité économique », §3
 * (attribution financière, doublons financiers, pertinence TCO) et tests §7
 * qui le concernent, sur PostgreSQL 16 réel.
 *
 * Chemins de PRODUCTION : persistance T1 réelle des candidats
 * (`replaceOperationCandidates`), consolidation T3 réelle
 * (`consolidateAccountOperations`, rapprochements déterministes M1 / M2 du
 * socle — quel que soit leur résultat, le TCO doit rester juste), service TCO
 * réel (`readAssetTco` + `readComponentProvenance`), route HTTP réelle de la
 * fiche, diagnostic BO réel (77C : `tracabilite/montants.json`). Seules les
 * sessions sont simulées. Aucun appel IA. Assertions limitées aux comptes créés ici.
 *
 * Jeu « maison + chaises » (cas de l'Opération #76) : acte de vente (preuve T1
 * du prix 490 000 €), attestation reprenant le prix en 2021, commande de
 * mobilier (277,35 €) ciblant la maison, deux avis de taxe foncière, un devis
 * et une facture de travaux de même montant. Aucun nom de commerçant n'est
 * utilisé par le code testé.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0, role: 'USER', email: '' }));
const TODAY = '2026-10-21';
type Json = Record<string, any>;

scenario('L78B', 'TCO — attribution des montants, doublons financiers, pertinence (maison, chaises, taxe foncière)', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;

  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId, role: session.role, email: session.email }) as never);
    ({ NextRequest } = await import('next/server'));
  });

  const tco = async (compte: AccountRow, assetId: number) => (await import('@/services/business-operations/tco/service')).readAssetTco(compte.id, assetId, { today: TODAY });
  const getTco = async (assetId: number) => {
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: res.status, body: await res.json() as Json };
  };
  const preuvePrix = (compte: AccountRow, assetId: number, fileId: number, eur: number) => sql`
    INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, confidence, fingerprint, evidence_excerpt)
    VALUES (${compte.id}, ${assetId}, 'acquisitionPrice', ${String(eur)}::jsonb, 'document', ${fileId}, 'certain', ${`e2e-l78b-${fileId}`}, ${`Prix ${eur} €`})`;
  const coherent = (t: Awaited<ReturnType<typeof tco>>) => {
    const a = t.annual;
    expect(a.years.reduce((n, y) => n + y.netCents, 0) + a.undated.costsCents - a.undated.creditsCents + a.future.costsCents - a.future.creditsCents)
      .toBe(t.summary.cumulativeCostCents);
    expect(t.reliability.anomalies.filter((x) => x.code === 'SUM_MISMATCH' || x.code === 'DUPLICATE_COMPONENT')).toEqual([]);
  };
  /** Somme retenue des lignes d'un montant donné (quel que soit le chemin : Opération, justificatif, fiche). */
  const retenu = (t: Awaited<ReturnType<typeof tco>>, montant: number) => t.lines.filter((l) => l.amountMinor === montant).reduce((n, l) => n + l.includedCents, 0);

  const PRIX = 49_000_000;
  const CHAISES = 27_735;
  const TAXE = 123_400;
  const TRAVAUX = 150_000;

  /** Maison achetée 490 000 € le 14/05/2007 (fiche) et ses justificatifs. */
  async function jeu(compte: AccountRow) {
    const maison: AssetRow = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', purchasePriceCents: PRIX, keyCharacteristics: { acquisitionDate: '2007-05-14' } });
    const vente = (summary: string, date: string, provider: string) => [cand({
      typeHint: 'ACQUISITION', summary, provider, sourceRoleHint: 'INVOICE', targetHints: [cible(maison.id)],
      temporalHints: { realizedDate: '2007-05-14' }, financialHints: [fh('REALIZED_COST', PRIX, { economicDate: date })],
    })];
    const acte = await k.document(compte, maison.id, vente('Vente de la maison', '2007-05-14', 'Étude notariale'), { type: 'PROPERTY_TITLE', title: 'Acte de vente', amountCents: PRIX, date: '2007-05-14' });
    await preuvePrix(compte, maison.id, acte, PRIX / 100);
    const attestation = await k.document(compte, maison.id, vente('Attestation de propriété', '2021-02-01', 'Étude notariale'), { type: 'PROPERTY_TITLE', title: 'Attestation de propriété', amountCents: PRIX, date: '2021-02-01' });
    const commande = await k.document(compte, maison.id, [cand({
      typeHint: 'ACQUISITION', summary: 'Quatre chaises de jardin', provider: 'Vendeur de mobilier', sourceRoleHint: 'INVOICE', targetHints: [cible(maison.id)],
      businessReferences: [ref('ORDER', 'CMD-2021-277'), ref('INVOICE', 'FA-2021-277')], temporalHints: { realizedDate: '2021-06-03' },
      financialHints: [fh('REALIZED_COST', CHAISES, { economicDate: '2021-06-03' })],
    })], { type: 'ACQUISITION_INVOICE', title: 'Commande de chaises de jardin', amountCents: CHAISES, date: '2021-06-03' });
    const taxe = (annee: number) => k.document(compte, maison.id, [cand({
      typeHint: 'OTHER', summary: `Taxe foncière ${annee}`, provider: 'Finances publiques', sourceRoleHint: 'INVOICE', targetHints: [cible(maison.id)],
      businessReferences: [ref('OTHER', `AVIS-${annee}`)], temporalHints: { realizedDate: `${annee}-10-15` },
      financialHints: [fh('REALIZED_COST', TAXE, { economicDate: `${annee}-10-15`, periodStart: `${annee}-01-01`, periodEnd: `${annee}-12-31` })],
    })], { type: 'PROPERTY_TAX_NOTICE', title: `Taxe foncière ${annee}`, amountCents: TAXE, date: `${annee}-10-15` });
    const taxe24 = await taxe(2024);
    const taxe25 = await taxe(2025);
    const travaux = { provider: 'Couvreur', targetHints: [cible(maison.id)], businessReferences: [ref('QUOTE', 'DV-TOIT-1')] };
    const devis = await k.document(compte, maison.id, [cand({ ...travaux, summary: 'Devis toiture', sourceRoleHint: 'QUOTE', statusHint: 'ENVISAGED', financialHints: [fh('FORECAST_COST', TRAVAUX, { economicDate: '2026-03-01' })] })],
      { type: 'WORKS_QUOTE', title: 'Devis toiture', amountCents: TRAVAUX, date: '2026-03-01' });
    const facture = await k.document(compte, maison.id, [cand({ ...travaux, summary: 'Réfection toiture', temporalHints: { realizedDate: '2026-04-01' },
      businessReferences: [ref('QUOTE', 'DV-TOIT-1'), ref('INVOICE', 'FA-TOIT-1')], financialHints: [fh('REALIZED_COST', TRAVAUX, { economicDate: '2026-04-01' })] })],
    { type: 'WORKS_INVOICE', title: 'Facture toiture', amountCents: TRAVAUX, date: '2026-04-01' });
    return { maison, acte, attestation, commande, taxe24, taxe25, devis, facture };
  }

  /** Attentes communes : quelle que soit la forme des Opérations produites par T3, les montants sont justes et rattachés. */
  function attentes(t: Awaited<ReturnType<typeof tco>>, j: Awaited<ReturnType<typeof jeu>>) {
    // Maison 490 000 € une seule fois ; taxe foncière 2024 et 2025 ; travaux 1 500 € une fois (devis = prévision) ; chaises hors TCO.
    expect(t.summary.cumulativeCostCents, JSON.stringify(t.lines.map((l) => [l.id, l.amountMinor, l.status, l.reason, l.includedCents, l.fileId]))).toBe(PRIX + 2 * TAXE + TRAVAUX);
    expect(t.summary.acquisitionCents).toBe(PRIX);
    expect(retenu(t, PRIX)).toBe(PRIX);
    expect(retenu(t, TAXE)).toBe(2 * TAXE);
    expect(retenu(t, TRAVAUX)).toBe(TRAVAUX);
    expect(retenu(t, CHAISES)).toBe(0);
    // Les chaises : transaction indépendante, motif visible ; jamais rattachées à l'acte, jamais l'inverse.
    const chaises = t.lines.filter((l) => l.amountMinor === CHAISES && l.status !== 'CONSOLIDATED_ELSEWHERE');
    expect(chaises.length).toBeGreaterThan(0);
    for (const l of chaises) expect(l).toMatchObject({ status: 'EXCLUDED', reason: 'NOT_OWNERSHIP_COST', fileId: j.commande });
    // Le prix retenu est porté par l'acte (ou par la fiche), jamais par la commande.
    for (const l of t.lines.filter((x) => x.amountMinor === PRIX && x.includedCents > 0)) expect([j.acte, null]).toContain(l.fileId);
    expect(t.lines.filter((l) => l.fileId === j.commande && l.includedCents > 0)).toEqual([]);
    expect(t.reliability.warnings).toContain('NOT_OWNERSHIP_COSTS');
    coherent(t);
  }

  it('L78B-E01 (§7) — maison 490 000 €, chaises 277,35 €, taxe foncière, devis / facture : avant T3, après T3, après reconsolidations répétées', async () => {
    const compte = await make.account({ plan: 'premium' });
    const j = await jeu(compte);
    // Avant T3 (justificatifs seuls).
    attentes(await tco(compte, j.maison.id), j);
    // T3 réel (rapprochements déterministes du socle) : le TCO reste juste, quelle que soit la forme des Opérations.
    await k.passer(compte);
    const apres = await tco(compte, j.maison.id);
    attentes(apres, j);
    // Reconsolidations répétées : résultat stable (montants, statuts), aucun nouveau doublon.
    await k.passer(compte);
    await k.passer(compte);
    const encore = await tco(compte, j.maison.id);
    attentes(encore, j);
    const forme = (t: typeof apres) => t.lines.map((l) => `${l.id}|${l.status}|${l.reason}|${l.includedCents}`).sort();
    expect(forme(encore)).toEqual(forme(apres));
    // Route de la fiche : mêmes montants, motif des chaises lisible, aucun montant de la commande retenu.
    session.currentAccountId = compte.id; session.userId = compte.ownerUserId;
    const r = await getTco(j.maison.id);
    expect(r.status).toBe(200);
    expect(r.body.tco.summary.cumulativeCostCents).toBe(PRIX + 2 * TAXE + TRAVAUX);
    expect(r.body.tco.lineReasonLabels.NOT_OWNERSHIP_COST).toMatch(/non incorporé/);
    expect(r.body.tco.warningLabels.join(' ')).toMatch(/objets distincts/);
  });

  it('L78B-E02 (§3A, §3B) — Opération mêlée (cas #76 : commande + justificatifs de la maison) : prix une fois, porté par l’acte ; provenance lue en base', async () => {
    const compte = await make.account({ plan: 'premium' });
    const j = await jeu(compte);
    await k.passer(compte);
    // Reproduction de la contamination historique : toutes les sources de vente rattachées à l'Opération de la commande.
    const [opCommande] = await sql<{ id: number }[]>`
      SELECT DISTINCT s.operation_id::int AS id FROM business_operation_sources s JOIN business_operations o ON o.id = s.operation_id
       WHERE s.account_id = ${compte.id} AND s.source_kind = 'DOCUMENT' AND s.active AND s.source_entity_key = ${String(j.commande)}
         AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`;
    const autres = await sql<{ id: number }[]>`
      SELECT DISTINCT s.operation_id::int AS id FROM business_operation_sources s JOIN business_operations o ON o.id = s.operation_id
       WHERE s.account_id = ${compte.id} AND s.source_kind = 'DOCUMENT' AND s.active AND s.source_entity_key IN (${String(j.acte)}, ${String(j.attestation)})
         AND o.id <> ${opCommande.id} AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`;
    for (const o of autres) {
      await sql`UPDATE business_operation_sources SET operation_id = ${opCommande.id} WHERE operation_id = ${o.id} AND source_kind = 'DOCUMENT'`;
      await sql`UPDATE business_operation_financial_components SET operation_id = ${opCommande.id} WHERE operation_id = ${o.id}`;
      await sql`UPDATE business_operations SET merged_into_operation_id = ${opCommande.id}, invalidated_at = now(), invalidation_reason = 'MERGED' WHERE id = ${o.id}`;
    }
    const comps = await k.composantes(opCommande.id);
    expect(comps.filter((c) => c.amount_minor === PRIX).length).toBeGreaterThanOrEqual(2);
    // Provenance réelle (SQL) : chaque composante désigne SES justificatifs.
    const { readComponentProvenance } = await import('@/services/business-operations/tco/service');
    const prov = await readComponentProvenance((await import('@/db')).db as never, compte.id, [opCommande.id], j.maison.id);
    const deChaises = comps.find((c) => c.amount_minor === CHAISES)!;
    expect(prov.get(deChaises.id)).toMatchObject({ documentFileIds: [j.commande], explained: true, otherAssetAcquisition: false, invoiceRefs: ['FA2021277'] });
    for (const c of comps.filter((x) => x.amount_minor === PRIX)) {
      expect(prov.get(c.id)!.explained).toBe(true);
      expect(prov.get(c.id)!.documentFileIds.some((f) => f === j.acte || f === j.attestation)).toBe(true);
    }
    const t = await tco(compte, j.maison.id);
    attentes(t, j);
    const prixRetenu = t.lines.filter((l) => l.source === 'OPERATION' && l.amountMinor === PRIX && l.includedCents > 0);
    expect(prixRetenu).toEqual([expect.objectContaining({ operationId: opCommande.id, fileId: j.acte, category: 'ACQUISITION', sourceFileIds: [j.acte] })]);
    const doublons = t.lines.filter((l) => l.source === 'OPERATION' && l.amountMinor === PRIX && l.status === 'DUPLICATE');
    for (const d of doublons) expect(d).toMatchObject({ reason: 'SAME_FACT_OTHER_DOCUMENT', duplicateOf: prixRetenu[0].id, relatedFileId: j.acte });
    // Source retirée de l'Opération : le montant qu'elle justifiait est signalé (jamais attribué en silence).
    const srcAttestation = await sql`UPDATE business_operation_sources SET active = false, superseded_at = now()
      WHERE operation_id = ${opCommande.id} AND source_kind = 'DOCUMENT' AND source_entity_key = ${String(j.attestation)} RETURNING id`;
    expect(srcAttestation.length).toBe(1);
    const u = await tco(compte, j.maison.id);
    expect(u.summary.cumulativeCostCents).toBe(PRIX + 2 * TAXE + TRAVAUX);
    const orphelines = u.lines.filter((l) => l.source === 'OPERATION' && l.reason === 'SOURCE_WITHDRAWN');
    for (const l of orphelines) expect(l).toMatchObject({ includedCents: 0, relatedFileId: j.attestation });
    expect(retenu(u, PRIX)).toBe(PRIX);
  });

  it('L78B-E03 (§3A) — le prix de la maison ne devient jamais le coût de la commande : bien « Chaises » distinct', async () => {
    const compte = await make.account({ plan: 'premium' });
    const j = await jeu(compte);
    const chaises = await make.asset(compte, { category: 'OBJET', name: 'Chaises de jardin', purchasePriceCents: CHAISES, keyCharacteristics: { acquisitionDate: '2021-06-03' } });
    await k.passer(compte);
    // L'Opération de la commande (éventuellement contaminée) est rattachée au bien « Chaises » par l'utilisateur.
    const ops = await sql<{ id: number }[]>`
      SELECT DISTINCT s.operation_id::int AS id FROM business_operation_sources s JOIN business_operations o ON o.id = s.operation_id
       WHERE s.account_id = ${compte.id} AND s.active AND s.source_entity_key IN (${String(j.commande)}, ${String(j.acte)})
         AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`;
    for (const o of ops) {
      await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority)
                VALUES (${compte.id}, ${o.id}, ${chaises.id}, 'CONCERNED', 'USER') ON CONFLICT DO NOTHING`;
    }
    const t = await tco(compte, chaises.id);
    expect(retenu(t, PRIX)).toBe(0);
    for (const l of t.lines.filter((x) => x.amountMinor === PRIX && x.source === 'OPERATION')) {
      expect(['OUT_OF_SCOPE', 'UNALLOCATED', 'DUPLICATE']).toContain(l.status);
    }
  });

  it('L78B-E05 (TCO-R-14) — T2 et TCO : même règle, mêmes montants sur le jeu #76 (doublons présumés, prix d’un autre bien, achat non incorporé)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const j = await jeu(compte);
    await k.passer(compte);
    const t = await tco(compte, j.maison.id);
    attentes(t, j);
    const t2 = await (await import('@/services/verebona-assistant/canonical/expenses')).sumQualifiedExpenses(compte.id, { assetIds: [j.maison.id] });
    // Total T2 (dépenses qualifiées + non qualifiées) = TCO cumulé : la maison une fois, les chaises jamais, taxes et travaux.
    expect(t2.qualifiedSumCents + t2.unqualified.sumCents).toBe(t.summary.cumulativeCostCents);
    expect((t2.operations?.sumCents ?? 0) + (t2.documents?.sumCents ?? 0)).toBeLessThanOrEqual(t.summary.cumulativeCostCents);
    // Compte entier : les chaises restent une dépense du compte ; le prix de la maison n'est compté qu'une fois.
    const tout = await (await import('@/services/verebona-assistant/canonical/expenses')).sumQualifiedExpenses(compte.id, {});
    expect(tout.qualifiedSumCents + tout.unqualified.sumCents).toBe(t.summary.cumulativeCostCents + CHAISES);
  });

  it('L78B-E04 (§6, 77C) — diagnostic BO : l’origine de chaque montant retenu ou écarté est traçable (montants.json)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const j = await jeu(compte);
    await k.passer(compte);
    const admin = await make.user({ role: 'ADMIN' });
    session.userId = admin.id; session.role = 'ADMIN'; session.email = admin.email;
    const { GET } = await import('@/app/api/admin/diagnostics/route');
    const res = await (GET as (r: InstanceType<typeof NextRequest>) => Promise<Response>)(new NextRequest(`http://app.test/api/admin/diagnostics?scope=asset&id=${j.maison.id}&format=zip`));
    expect(res.status, await res.clone().text().catch(() => '')).toBe(200);
    const z = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const traces = JSON.parse(await z.file('tracabilite/montants.json')!.async('string')) as Array<Json>;
    const etape = (t: Json, e: string) => (t.chaine as Json[]).find((s) => s.etape === e)!;
    // Chaque montant RETENU : chaîne complète, document source = justificatif de la ligne, justificatifs du montant listés.
    const retenus = traces.filter((t) => t.ligne.includedCents > 0);
    expect(retenus.length).toBeGreaterThanOrEqual(4);
    for (const t of retenus) {
      const doc = etape(t, 'DOCUMENT');
      expect(doc.statut, JSON.stringify([t.ligne.id, doc])).not.toBe('non_disponible');
      if (t.ligne.fileId != null) expect(doc.references).toEqual(expect.arrayContaining([{ table: 'asset_files', id: t.ligne.fileId }]));
      expect(etape(t, 'CALCUL').donnees.justificatifsDuMontant.length).toBeGreaterThan(0);
    }
    // Le prix retenu est tracé jusqu'à l'acte ; les chaises jusqu'à la commande, avec le motif d'exclusion.
    const prix = retenus.filter((t) => t.ligne.amountMinor === PRIX);
    expect(prix.length).toBe(1);
    expect(etape(prix[0], 'CALCUL').donnees.justificatifsDuMontant).toContain(j.acte);
    const chaises = traces.filter((t) => t.ligne.amountMinor === CHAISES && t.ligne.status === 'EXCLUDED');
    expect(chaises.length).toBeGreaterThan(0);
    for (const t of chaises) {
      expect(etape(t, 'CALCUL').donnees).toMatchObject({ statut: 'EXCLUDED', motif: 'NOT_OWNERSHIP_COST', retenuCents: 0 });
      expect(etape(t, 'DOCUMENT').references).toEqual(expect.arrayContaining([{ table: 'asset_files', id: j.commande }]));
    }
    // Doublons présumés éventuels : la ligne comptée à leur place est désignée.
    for (const t of traces.filter((x) => x.ligne.status === 'DUPLICATE' && x.ligne.reason === 'SAME_FACT_OTHER_DOCUMENT')) {
      expect(etape(t, 'CALCUL').donnees.doublonDe ?? t.ligne.relatedFileId).toBeTruthy();
    }
  });
});
