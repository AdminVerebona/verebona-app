/**
 * Lot 108A — ticket P1 « TCO — correctifs globaux » §A, §C, §D — PostgreSQL 16 réel.
 *
 * Chemins de PRODUCTION : persistance T1 réelle des candidats, consolidation
 * T3 réelle (`consolidateAccountOperations` : la fiche et la facture du même
 * achat réunies dans un même événement de référence), écriture canonique de
 * la fiche (`writeCanonicalAssetFields`, USER), service TCO (`readAssetTco`),
 * route HTTP de la fiche, réponse T2 « coût de possession », contrôle
 * COH-TCO-SAME-FACT par le moteur (`controlObjects`). Aucun appel IA. Date
 * de référence injectée ; assertions limitées aux comptes créés ici.
 *
 *   L108A-E2E-01  fiche (prix + date d'achat) + facture du même achat datée de la veille, trois familles :
 *                 une contribution avant ET après T3 ; preuves consultables ; route, T2 cohérents
 *   L108A-E2E-02  ordre d'import inversé (facture et T3 AVANT le prix de la fiche) : même résultat
 *   L108A-E2E-03  deux achats distincts de même montant (dates éloignées) : deux coûts ; contrôle de cohérence :
 *                 faits réunis tracés (CONSISTENT), incertitude seule → arbitrage (AMBIGUOUS), aucune écriture
 *   L108A-E2E-04  sans valorisation : aucune fausse alerte (fiche, T2) ; texte informatif hors alertes
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 }));

type Json = Record<string, any>;
const AUJ = '2026-11-03';
const D_FICHE = '2025-03-07';
const D_PIECE = '2025-03-06';
const MONTANT = 202_300;
const CHECK = 'COH-TCO-SAME-FACT';

scenario('L108A', 'TCO — un même achat représenté par plusieurs sources compté une seule fois', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  let NextRequest: typeof import('next/server').NextRequest;
  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }) as never);
    ({ NextRequest } = await import('next/server'));
  });

  const tco = async (compte: AccountRow, assetId: number) =>
    (await import('@/services/business-operations/tco/service')).readAssetTco(compte.id, assetId, { today: AUJ });
  const fiche = async (compte: AccountRow, assetId: number) => {
    session.currentAccountId = compte.id; session.userId = compte.ownerUserId;
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    expect(res.status).toBe(200);
    return (await res.json() as Json).tco as Json;
  };
  const ecrire = async (compte: AccountRow, assetId: number, fields: Record<string, unknown>) => {
    const canon = await import('@/services/canonical/asset-state');
    await canon.writeCanonicalAssetFields({
      assetId, accountId: compte.id, origin: 'USER', actorUserId: compte.ownerUserId, source: { type: 'asset_details', id: 'e2e-108a' },
      writes: Object.entries(fields).map(([key, value]) => ({ key, value })),
    });
  };
  /** Facture d'achat du bien persistée par T1 (indice d'achat ciblant le bien, date de pièce). */
  const factureAchat = (compte: AccountRow, asset: AssetRow, o: { cents?: number; date?: string; ref?: string; provider?: string } = {}) =>
    k.document(compte, asset.id, [cand({
      typeHint: 'ACQUISITION', summary: 'Achat du bien', provider: o.provider ?? 'Magasin Exemple', targetHints: [cible(asset.id)],
      businessReferences: o.ref ? [ref('INVOICE', o.ref)] : [], temporalHints: { realizedDate: o.date ?? D_PIECE },
      financialHints: [fh('REALIZED_COST', o.cents ?? MONTANT, { economicDate: o.date ?? D_PIECE })],
    })], { type: 'ACQUISITION_INVOICE', title: 'Facture d’achat', amountCents: o.cents ?? MONTANT, date: o.date ?? D_PIECE });
  const controler = async (compte: AccountRow, ids: number[]) => {
    const [{ controlObjects }, { getCheck }, { pgClient }] = await Promise.all([
      import('@/services/coherence/engine'), import('@/services/coherence/registry'), import('@/db'),
    ]);
    return controlObjects({
      ctx: { sql: pgClient as never, now: new Date(`${AUJ}T10:00:00Z`), today: AUJ, mode: 'CORRECTIVE', correlationId: `coherence:e2e-108a:${CHECK}` },
      check: getCheck(CHECK)!, accountId: compte.id, ids, trigger: 'MANUAL', campaignId: null,
      stillEligible: async () => ({ eligible: true, reason: 'e2e' }),
    });
  };
  const preuve = async (compte: AccountRow, objectId: number) => (await sql<Json[]>`
    SELECT last_result, finding FROM coherence_object_proofs WHERE account_id = ${compte.id} AND check_id = ${CHECK} AND object_id = ${objectId}`)[0];
  const retenues = (t: Awaited<ReturnType<typeof tco>>) => t.lines.filter((l) => l.includedCents > 0);

  it('L108A-E2E-01 — fiche (07/03) + facture du même achat (06/03), trois familles : une contribution avant et après T3 ; preuves ouvrables ; route et T2 cohérents', async () => {
    for (const category of ['VEHICULE', 'OBJET', 'IMMOBILIER']) {
      const compte = await make.account({ plan: 'premium' });
      const bien = await make.asset(compte, { category, name: `Bien ${category}`, purchasePriceCents: MONTANT, keyCharacteristics: { acquisitionDate: D_FICHE } });
      const f = await factureAchat(compte, bien);
      const avant = await tco(compte, bien.id);
      expect(avant.summary.cumulativeCostCents).toBe(MONTANT);
      expect(retenues(avant)).toHaveLength(1);
      expect(avant.lines.find((l) => l.fileId === f && l.source === 'DOCUMENT')).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_AS_ASSET_PRICE' });
      // T3 réel : la fiche et la facture du même achat (dates différentes) consolidées.
      await k.passer(compte);
      // Contrat T3 inchangé (cause racine n° 2) : selon la consolidation, la fiche et la facture forment une ou deux composantes.
      const comps = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_financial_components c
        JOIN business_operations o ON o.id = c.operation_id WHERE c.account_id = ${compte.id} AND c.active AND c.kind = 'REALIZED_COST'
         AND c.amount_minor = ${MONTANT} AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`;
      console.info(`[L108A-E2E-01] ${category} : composantes T3 de ${MONTANT} = ${comps[0].n}`);
      const apres = await tco(compte, bien.id);
      expect(apres.summary.cumulativeCostCents).toBe(MONTANT);
      expect(apres.summary.acquisitionCents).toBe(MONTANT);
      expect(retenues(apres)).toHaveLength(1);
      expect(apres.reliability.warnings).not.toContain('PRESUMED_DUPLICATES');
      // Le justificatif reste consultable : porté par la ligne retenue ou visible avec son motif.
      expect(apres.lines.some((l) => l.fileId === f)).toBe(true);
      // Fiche (route HTTP) : même total, la facture ouvrable depuis le détail.
      const vue = await fiche(compte, bien.id);
      expect(vue.summary.cumulativeCostCents).toBe(MONTANT);
      expect(JSON.stringify(vue.lines)).toContain(`"fileId":${f}`);
      // T2 (réponse « coût de possession ») : mêmes chiffres, lus du service TCO.
      const { ownershipCostAnswer } = await import('@/services/verebona-assistant/canonical/structured-answers');
      const r = ownershipCostAnswer({ id: bien.id, name: `Bien ${category}` } as never, apres);
      const texte = (r as { answer: string }).answer.replace(/[\s\u00a0\u202f]/g, '');
      expect(texte).toContain('2023,00');
      expect(texte).not.toContain('4046');
    }
  });

  it('L108A-E2E-02 — ordre d’import inversé : facture et T3 AVANT la saisie du prix sur la fiche → même résultat, idempotent', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'OBJET', name: 'Vélo électrique' });
    await factureAchat(compte, bien);
    await k.passer(compte);
    expect((await tco(compte, bien.id)).summary.cumulativeCostCents).toBe(MONTANT);
    await ecrire(compte, bien.id, { acquisitionPrice: MONTANT / 100, acquisitionDate: D_FICHE });
    const t = await tco(compte, bien.id);
    expect(t.summary.cumulativeCostCents).toBe(MONTANT);
    await k.passer(compte);
    const u = await tco(compte, bien.id);
    expect(u.summary.cumulativeCostCents).toBe(MONTANT);
    expect(retenues(u)).toHaveLength(1);
    await k.passer(compte);
    expect((await tco(compte, bien.id)).summary).toEqual(u.summary);
  });

  it('L108A-E2E-03 — deux achats distincts de même montant : deux coûts ; contrôle COH-TCO-SAME-FACT : faits réunis tracés, incertitude → arbitrage, aucune écriture', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'VEHICULE', name: 'Vélo cargo', purchasePriceCents: MONTANT, keyCharacteristics: { acquisitionDate: D_FICHE } });
    const accessoire = await factureAchat(compte, bien, { date: '2025-09-15', ref: 'ACC-1', provider: 'Autre magasin' });
    const t = await tco(compte, bien.id);
    expect(t.summary.cumulativeCostCents).toBe(2 * MONTANT);
    expect(t.lines.find((l) => l.fileId === accessoire && l.source === 'DOCUMENT')?.uncertain).toBeUndefined();

    // Contrôle : cas réuni (fiche + facture du même achat) → CONSISTENT, faits tracés.
    const c2 = await make.account({ plan: 'premium' });
    const reuni = await make.asset(c2, { category: 'OBJET', name: 'Draisienne', purchasePriceCents: MONTANT, keyCharacteristics: { acquisitionDate: D_FICHE } });
    await factureAchat(c2, reuni);
    const decisions = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_cost_line_decisions WHERE account_id = ${c2.id}`;
    await controler(c2, [reuni.id]);
    const p = await preuve(c2, reuni.id);
    expect(p?.last_result).toBe('CONSISTENT');
    // Incertitude réelle (date d'achat inconnue) → arbitrage, jamais une fusion.
    const c3 = await make.account({ plan: 'premium' });
    const flou = await make.asset(c3, { category: 'OBJET', name: 'Trottinette', purchasePriceCents: MONTANT });
    await factureAchat(c3, flou);
    await controler(c3, [flou.id]);
    expect((await tco(c3, flou.id)).summary.cumulativeCostCents).toBe(2 * MONTANT);
    expect((await preuve(c3, flou.id))?.last_result).toMatch(/AMBIGUOUS|ARBITRATION/);
    // Aucune écriture : ni décision utilisateur, ni événement de référence créé par le contrôle.
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_cost_line_decisions WHERE account_id = ${c2.id}`)[0].n).toBe(decisions[0].n);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${c3.id}`)[0].n).toBe(0);
  });

  it('L108A-E2E-04 — sans valorisation actuelle : aucune fausse alerte (fiche, T2) ; coût net « non calculable »', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'VEHICULE', name: 'Scooter', purchasePriceCents: MONTANT, keyCharacteristics: { acquisitionDate: D_FICHE } });
    const vue = await fiche(compte, bien.id);
    expect(vue.reliability.warnings).not.toContain('NO_RELIABLE_VALUATION');
    expect(vue.warningLabels.join(' ')).not.toMatch(/valorisation/i);
    expect(vue.summary.netEstimatedCents).toBeNull();
    expect(vue.status).toBe('COMPLETE');
    const { ownershipCostAnswer } = await import('@/services/verebona-assistant/canonical/structured-answers');
    expect((ownershipCostAnswer({ id: bien.id, name: 'Scooter' } as never, await tco(compte, bien.id)) as { answer: string }).answer).not.toMatch(/Aucune valorisation/);
  });
});
