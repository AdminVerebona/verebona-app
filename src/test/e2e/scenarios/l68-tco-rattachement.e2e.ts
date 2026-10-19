/**
 * Lot 68 (68A) — bug PO « facture Midas de la Polo dans le TCO de la maison »
 * sur PostgreSQL 16 réel.
 *
 * Cause racine : la sélection des sources du TCO (`readAssetDocuments`) et
 * des dépenses T2 (`readExpenseDocuments`) prenait TOUT lien N-N actif, y
 * compris MENTIONED (bien seulement CITÉ par l'analyse, ex. adresse du
 * client sur une facture de garage) — alors que le périmètre commun des
 * documents d'un bien (`asset-document-scope`, lot 32C) l'exclut. Une
 * facture de la Polo citant la maison entrait donc dans les candidats de la
 * maison (« Autre bien — Dépense attribuée à un autre bien »), et la maison
 * entrait dans les biens d'attribution de la facture côté Polo (facture non
 * ventilée → non comptée pour la Polo avant consolidation, et en T2).
 *
 * Chemins de PRODUCTION : T1 réel (`replaceOperationCandidates`), T3 réel,
 * `readAssetTco`, routes HTTP réelles (fiche, BO), T2 réel
 * (`sumQualifiedExpenses`). Seule la session est simulée. Aucun appel IA.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref, RECETTE_TODAY } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0, adminId: 0 }));
vi.mock('@/lib/auth-guards', async (o) => ({ ...(await o<object>()), requireAdmin: async () => session.adminId }));

scenario('L68A', 'TCO — rattachement réel des sources et présentation des dépenses non retenues', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;

  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }) as never);
    ({ NextRequest } = await import('next/server'));
  });

  const tco = async (compte: AccountRow, assetId: number) => (await import('@/services/business-operations/tco/service')).readAssetTco(compte.id, assetId, { today: RECETTE_TODAY });
  const fiche = async (compte: AccountRow, assetId: number) => {
    session.currentAccountId = compte.id; session.userId = compte.ownerUserId;
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    expect(res.status).toBe(200);
    return (await res.json() as Record<string, any>).tco as Record<string, any>;
  };
  const bo = async (compte: AccountRow, assetId: number) => {
    const admin = await make.user({ role: 'ADMIN' });
    session.adminId = admin.id;
    const { GET } = await import('@/app/api/admin/operations/tco/route');
    const res = await GET(new NextRequest(`http://x/api/admin/operations/tco?accountId=${compte.id}&assetId=${assetId}`));
    expect(res.status).toBe(200);
    return await res.json() as Record<string, any>;
  };
  const t2 = async (compte: AccountRow, assetId: number) =>
    (await import('@/services/verebona-assistant/canonical/expenses')).sumQualifiedExpenses(compte.id, { assetIds: [assetId] });
  const lien = (compte: AccountRow, fileId: number, assetId: number, role: 'MENTIONED' | 'SECONDARY', origin = 'AI') =>
    sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status) VALUES (${compte.id}, ${fileId}, ${assetId}, ${role}, ${origin}, 'ACTIVE')`;

  const biens = async (compte: AccountRow): Promise<{ maison: AssetRow; polo: AssetRow }> => ({
    maison: await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' }),
    polo: await make.asset(compte, { category: 'VEHICULE', name: 'Polo' }),
  });
  /** Facture Midas (entretien climatisation de la Polo, 511,54 €) déposée sur la Polo. */
  const midas = (compte: AccountRow, polo: AssetRow, cibles = [cible(polo.id)]) =>
    k.document(compte, polo.id, [cand({ typeHint: 'INTERVENTION', summary: 'Entretien climatisation', provider: 'Midas', targetHints: cibles,
      businessReferences: [ref('INVOICE', 'F-1614-2022-1090')], temporalHints: { realizedDate: '2022-06-13' }, financialHints: [fh('REALIZED_COST', 51_154)] })],
    { type: 'MAINTENANCE_INVOICE', title: 'Facture Midas F-1614-2022-1090 Centre LYON TETE D\'OR _ Juin 2022', amountCents: 51_154, date: '2022-06-13' });

  it('L68-TCO-01 — facture de la Polo seulement CITANT la maison (lien MENTIONED) : absente du TCO de la maison (service, fiche, BO), comptée pour la Polo, avant et après T3', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { maison, polo } = await biens(compte);
    const f = await midas(compte, polo);
    await lien(compte, f, maison.id, 'MENTIONED');
    for (const etape of ['avant T3', 'après T3']) {
      if (etape === 'après T3') await k.passer(compte);
      const m = await tco(compte, maison.id);
      expect(m.lines.filter((l) => l.fileId === f), etape).toEqual([]);
      expect(m.summary.cumulativeCostCents, etape).toBe(0);
      const p = await tco(compte, polo.id);
      expect(p.summary.cumulativeCostCents, etape).toBe(51_154);
      expect(p.lines.filter((l) => l.fileId === f && (l.status === 'RETAINED_DIRECT' || l.status === 'RETAINED_CONSOLIDATED')).reduce((n, l) => n + l.includedCents, 0), etape).toBe(51_154);
      expect((await fiche(compte, maison.id)).lines.filter((l: any) => l.fileId === f), etape).toEqual([]);
      // BO : la facture n'est pas une ligne de la maison, mais le diagnostic explique pourquoi (bien seulement cité).
      const d = await bo(compte, maison.id);
      expect(d.tco.lines.filter((l: any) => l.fileId === f), etape).toEqual([]);
      expect(d.tco.citedOnlyDocuments, etape).toEqual([expect.objectContaining({ fileId: f })]);
    }
  });

  it('L68-TCO-01b — sans cible T1 : la maison seulement citée ne rend plus la facture « non ventilée » pour la Polo (TCO et T2 comptent 511,54 €)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { maison, polo } = await biens(compte);
    const f = await midas(compte, polo, []);
    await lien(compte, f, maison.id, 'MENTIONED');
    const p = await tco(compte, polo.id);
    expect(p.lines.find((l) => l.fileId === f)).toMatchObject({ status: 'RETAINED_DIRECT', includedCents: 51_154 });
    expect(p.reliability.warnings).not.toContain('UNALLOCATED_AMOUNTS');
    expect((await t2(compte, polo.id)).qualifiedSumCents).toBe(51_154);
    expect((await t2(compte, maison.id)).qualifiedSumCents).toBe(0);
    expect((await tco(compte, maison.id)).lines.filter((l) => l.fileId === f)).toEqual([]);
  });

  it('L68-TCO-02 — facture réellement rattachée aux deux biens (SECONDARY) mais attribuée à la seule Polo : ligne écartée au BO de la maison, masquée sur la fiche de la maison, comptée pour la Polo ; totaux inchangés', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { maison, polo } = await biens(compte);
    const f = await midas(compte, polo);
    await lien(compte, f, maison.id, 'SECONDARY', 'USER');
    for (const etape of ['avant T3', 'après T3']) {
      if (etape === 'après T3') await k.passer(compte);
      const m = await tco(compte, maison.id);
      expect(m.summary.cumulativeCostCents, etape).toBe(0);
      expect(m.lines.filter((l) => l.fileId === f && l.source === 'DOCUMENT').map((l) => l.status), etape).toEqual(['OUT_OF_SCOPE']);
      const vue = await fiche(compte, maison.id);
      expect(vue.summary.cumulativeCostCents, etape).toBe(0);
      expect(vue.lines.filter((l: any) => l.fileId === f || l.status === 'OUT_OF_SCOPE'), etape).toEqual([]);
      const d = await bo(compte, maison.id);
      expect(d.tco.lines.length, etape).toBe(m.lines.length);
      expect(d.tco.lines.find((l: any) => l.fileId === f && l.source === 'DOCUMENT'), etape).toMatchObject({ status: 'OUT_OF_SCOPE' });
      expect(Object.values(d.userView.hidden), etape).toContain('OTHER_ASSET');
      expect((await tco(compte, polo.id)).summary.cumulativeCostCents, etape).toBe(51_154);
    }
  });

  it('L68-TCO-03 — document commun aux deux biens sans ventilation : non imputé et signalé sur les DEUX fiches (lot 61 préservé)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { maison, polo } = await biens(compte);
    const commune = await k.document(compte, polo.id, [cand({ targetHints: [], provider: 'Serrurerie Lyon', financialHints: [fh('REALIZED_COST', 12_000)] })],
      { type: 'REPAIR_INVOICE', title: 'Facture commune', amountCents: 12_000, date: '2026-03-01' });
    await lien(compte, commune, maison.id, 'SECONDARY', 'USER');
    for (const a of [maison, polo]) {
      const t = await tco(compte, a.id);
      expect(t.lines.find((l) => l.fileId === commune)).toMatchObject({ status: 'UNALLOCATED', includedCents: 0 });
      expect(t.reliability.warnings).toContain('UNALLOCATED_AMOUNTS');
      const vue = await fiche(compte, a.id);
      expect(vue.lines.find((l: any) => l.fileId === commune)).toMatchObject({ status: 'UNALLOCATED' });
      expect(vue.summary.cumulativeCostCents).toBe(0);
    }
  });

  it('L68-TCO-04 — justificatifs repris par une dépense consolidée (Homiris) : masqués des non retenues sur la fiche, ouvrables depuis la ligne retenue ; BO conserve toutes les lignes ; total identique', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { maison } = await biens(compte);
    const contrat = { typeHint: 'CONTRACT' as const, sourceRoleHint: 'INVOICE' as const, summary: 'Télésurveillance', provider: 'Homiris', targetHints: [cible(maison.id)] };
    const nov = await k.document(compte, maison.id, [cand({ ...contrat, businessReferences: [ref('CONTRACT', 'HOM-1'), ref('INVOICE', 'HOM-2025-11')], temporalHints: { realizedDate: '2025-11-05' }, financialHints: [fh('REALIZED_COST', 4_050, { economicDate: '2025-11-05' })] })],
      { type: 'SUBSCRIPTION_INVOICE', title: 'Facture Homiris _ Novembre à décembre 2025', amountCents: 4_050, date: '2025-11-05' });
    const jan = await k.document(compte, maison.id, [cand({ ...contrat, businessReferences: [ref('CONTRACT', 'HOM-1'), ref('INVOICE', 'HOM-2026-01')], temporalHints: { realizedDate: '2026-01-05' }, financialHints: [fh('REALIZED_COST', 4_050, { economicDate: '2026-01-05' })] })],
      { type: 'SUBSCRIPTION_INVOICE', title: 'Facture Homiris _ Janvier à février 2026', amountCents: 4_050, date: '2026-01-05' });
    const avant = await tco(compte, maison.id);
    expect(avant.summary.cumulativeCostCents).toBe(8_100);
    await k.passer(compte);
    const apres = await tco(compte, maison.id);
    expect(apres.summary.cumulativeCostCents).toBe(8_100);
    const reprises = apres.lines.filter((l) => l.status === 'CONSOLIDATED_ELSEWHERE' && l.source === 'DOCUMENT');
    expect(reprises.map((l) => l.fileId).sort()).toEqual([nov, jan].sort());
    const vue = await fiche(compte, maison.id);
    expect(vue.summary.cumulativeCostCents).toBe(8_100);
    expect(vue.lines.filter((l: any) => l.status === 'CONSOLIDATED_ELSEWHERE')).toEqual([]);
    // Chaque justificatif repris reste ouvrable depuis la (les) ligne(s) consolidée(s) retenue(s).
    const ouvrables = new Set(vue.lines.filter((l: any) => l.status === 'RETAINED_CONSOLIDATED')
      .flatMap((l: any) => [l.fileId, ...(l.supportingDocuments ?? []).map((s: any) => s.fileId)]));
    expect(ouvrables.has(nov) && ouvrables.has(jan)).toBe(true);
    const d = await bo(compte, maison.id);
    expect(d.tco.lines.filter((l: any) => l.status === 'CONSOLIDATED_ELSEWHERE' && l.source === 'DOCUMENT')).toHaveLength(2);
    expect(Object.values(d.userView.hidden).filter((v) => v === 'CONSOLIDATED_SHOWN')).toHaveLength(2);
  });
});
