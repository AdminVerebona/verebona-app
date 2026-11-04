/**
 * Lot 109D — ticket P1 « TCO — remises vs avoirs, 1 document → 1..N achats » — PostgreSQL 16 réel.
 *
 * Chemins de PRODUCTION : persistance T1 réelle des candidats (`replaceOperationCandidates`, barrière T1
 * `gateOperationCandidates` pour le chemin « nouvelle analyse »), consolidation T3 réelle
 * (`consolidateAccountOperations`, M3 coupé), service TCO (`readAssetTco`), route HTTP de la fiche,
 * contrôle COH-TCO-COMMERCIAL-ADJUSTMENTS par le moteur de cohérence (`controlObjects`). Aucun appel IA.
 *
 *   L109D-E2E-01  cas observé (bon de commande payé, 4 × 69,50 − 20,00 + 19,35 = 277,35 € TTC, bien immobilier +
 *                 équipement « chaises ») : diagnostic de bout en bout ; une entrée, aucun faux avoir, aucune double
 *                 déduction, avant ET après T3 ; fiche (route) : une ligne, détail consultable, justificatif ouvrable
 *   L109D-E2E-02  quatre formes persistées des indices T1 : même résultat ; T3 rejoué deux fois : stable, aucune ligne nouvelle
 *   L109D-E2E-03  vrai avoir postérieur : coût ajusté une fois, preuve conservée ; devis non réalisé : aucun coût
 *   L109D-E2E-04  nouvelle analyse : barrière T1 → aucun candidat « avoir » établi, aucune Opération autonome
 *   L109D-E2E-05  reprise de l'historique : faux avoir T3, Opération « remise » autonome, lignes au lieu du net →
 *                 contrôle de cohérence (réparation T3 déterministe), idempotent ; décision de l'utilisateur préservée
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { cand, cible, cibleEquipement, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow, AssetRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 }));

type Json = Record<string, any>;
const AUJ = '2026-11-04';
const D_CMD = '2021-04-24';
const NET = 27_735;
const MAISON = 49_000_000;
const CHECK = 'COH-TCO-COMMERCIAL-ADJUSTMENTS';
const TITRE = 'Bon de commande Tikamoon — 24 avril 2021';

scenario('L109D', 'TCO — une remise n’est jamais un avoir ; un achat = un coût net', ({ sql, make }) => {
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
  const passer = (compte: AccountRow) => k.passer(compte, { today: AUJ });
  const retenues = (t: Awaited<ReturnType<typeof tco>>) => t.lines.filter((l) => l.status === 'RETAINED_DIRECT' || l.status === 'RETAINED_CONSOLIDATED');
  const credits = async (compte: AccountRow) => (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM business_operation_financial_components c JOIN business_operations o ON o.id = c.operation_id
     WHERE c.account_id = ${compte.id} AND c.active AND c.kind IN ('REDUCTION', 'REFUND') AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`)[0].n;
  const composantesActives = async (compte: AccountRow) => sql<{ id: number; kind: string; amount_minor: number; operation_id: number }[]>`
    SELECT c.id::int AS id, c.kind, c.amount_minor::int AS amount_minor, c.operation_id::int AS operation_id
      FROM business_operation_financial_components c JOIN business_operations o ON o.id = c.operation_id
     WHERE c.account_id = ${compte.id} AND c.active AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL ORDER BY c.id`;
  const controler = async (compte: AccountRow, ids: number[], mode: 'CORRECTIVE' | 'DRY_RUN' = 'CORRECTIVE') => {
    const [{ controlObjects }, { getCheck }, { pgClient }] = await Promise.all([
      import('@/services/coherence/engine'), import('@/services/coherence/registry'), import('@/db'),
    ]);
    return controlObjects({
      ctx: { sql: pgClient as never, now: new Date(`${AUJ}T10:00:00Z`), today: AUJ, mode, correlationId: `coherence:e2e-109d:${CHECK}` },
      check: getCheck(CHECK)!, accountId: compte.id, ids, trigger: 'MANUAL', campaignId: null,
      stillEligible: async () => ({ eligible: true, reason: 'e2e' }),
    });
  };
  const preuve = async (compte: AccountRow, objectId: number) => (await sql<Json[]>`
    SELECT last_result, finding FROM coherence_object_proofs WHERE account_id = ${compte.id} AND check_id = ${CHECK} AND object_id = ${objectId}`)[0];

  /** Bien immobilier (prix d'achat sur la fiche) + équipement « Chaises » (rubrique Équipements et mobilier). */
  const maisonEtChaises = async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', purchasePriceCents: MAISON, keyCharacteristics: { acquisitionDate: '2020-06-30' } });
    const chaises = await k.equipement(maison, 'Chaises de salle à manger', 'FURNITURE');
    return { compte, maison, chaises };
  };
  const commande = async (compte: AccountRow, maison: AssetRow, chaises: number, candidats: ReturnType<typeof cand>[], o: { amountCents?: number } = {}) => {
    const f = await k.document(compte, maison.id, candidats, { type: 'ACQUISITION_ORDER', title: TITRE, amountCents: o.amountCents ?? NET, date: D_CMD });
    await sql`UPDATE asset_files SET equipment_id = ${chaises}, supplier = 'Tikamoon' WHERE id = ${f}`;
    return f;
  };
  const base = (maisonId: number, chaises: number) => ({
    typeHint: 'ACQUISITION' as const, summary: 'Commande de quatre chaises', provider: 'Tikamoon',
    targetHints: [cible(maisonId), cibleEquipement(chaises)], businessReferences: [ref('ORDER', 'TK-2021-0424')],
  });
  /** Les quatre formes plausibles des indices T1 persistés (cause racine reproduite pour chacune). */
  const formes = (m: number, e: number): Record<string, ReturnType<typeof cand>[]> => ({
    COMMANDE_PAYEE: [cand({ ...base(m, e), sourceRoleHint: 'ORDER', statusHint: 'ENVISAGED',
      financialHints: [fh('FORECAST_COST', NET), fh('REDUCTION', 2000, { amountScope: null }), fh('PAYMENT', NET, { economicDate: D_CMD })] })],
    FACTURE_TOTAL_REMISE: [cand({ ...base(m, e), sourceRoleHint: 'INVOICE', temporalHints: { realizedDate: D_CMD },
      financialHints: [fh('REALIZED_COST', NET, { economicDate: D_CMD }), fh('REDUCTION', 2000, { amountScope: null }), fh('PAYMENT', NET, { economicDate: D_CMD })] })],
    REMISE_ISOLEE: [
      cand({ ...base(m, e), candidateKey: 'op1', sourceRoleHint: 'INVOICE', temporalHints: { realizedDate: D_CMD }, financialHints: [fh('REALIZED_COST', NET, { economicDate: D_CMD })] }),
      cand({ ...base(m, e), candidateKey: 'op2', summary: 'Remise commerciale', sourceRoleHint: null, temporalHints: { realizedDate: D_CMD },
        targetHints: [cible(m)], financialHints: [fh('REDUCTION', 2000, { amountScope: null, economicDate: D_CMD })] })],
    LIGNES_SANS_TOTAL: [cand({ ...base(m, e), sourceRoleHint: 'INVOICE', temporalHints: { realizedDate: D_CMD },
      financialHints: [fh('REALIZED_COST', 27_800, { amountScope: null, economicDate: D_CMD }), fh('REALIZED_COST', 1935, { amountScope: 'FEE', economicDate: D_CMD }),
        fh('REDUCTION', 2000, { amountScope: null })] })],
  });

  /** Invariants du cas observé : une seule dépense nette de 277,35 €, aucun avoir, aucune double déduction. */
  const attendu = (t: Awaited<ReturnType<typeof tco>>, f: number, etape: string) => {
    expect(t.summary.cumulativeCostCents, etape).toBe(MAISON + NET);
    expect(t.reductionsCents + t.refundsCents, etape).toBe(0);
    const achat = retenues(t).filter((l) => l.includedCents === NET);
    expect(achat, etape).toHaveLength(1);
    expect(retenues(t).filter((l) => l.kind === 'REDUCTION' || l.kind === 'REFUND'), etape).toEqual([]);
    // Justificatif accessible : porté par la ligne retenue ou par la ligne documentaire de la dépense consolidée.
    expect(t.lines.some((l) => l.fileId === f), etape).toBe(true);
  };

  it('L109D-E2E-01 — cas observé : diagnostic de bout en bout, une entrée « commande » de 277,35 €, aucun faux avoir, avant et après T3 ; fiche sobre et détaillable', async () => {
    const { compte, maison, chaises } = await maisonEtChaises();
    const f = await commande(compte, maison, chaises, formes(maison.id, chaises).COMMANDE_PAYEE);
    // ① Données T1 persistées : la remise est un indice REDUCTION (rôle porté par le signe) sur la commande.
    const [c] = await sql<Json[]>`SELECT payload FROM document_operation_candidates WHERE file_id = ${f} AND status = 'ACTIVE'`;
    expect((c.payload.financialHints as Json[]).map((h) => h.role)).toEqual(['FORECAST_COST', 'REDUCTION', 'PAYMENT']);
    // ② Dépenses documentaires (avant T3) — avant le lot : −20 € « avoir » retenu, commande en prévision (TCO = maison − 20 €).
    const avant = await tco(compte, maison.id);
    attendu(avant, f, 'avant T3');
    const ligne = retenues(avant).find((l) => l.fileId === f)!;
    expect(ligne).toMatchObject({ kind: 'REALIZED_COST', date: D_CMD, label: TITRE, note: null });
    expect(ligne.composition).toMatchObject({ netMinor: NET, discountsMinor: 2000, paidOn: D_CMD });
    expect(avant.lines.find((l) => l.kind === 'REDUCTION')).toMatchObject({ status: 'INCLUDED_IN_TOTAL', reason: 'COMMERCIAL_ADJUSTMENT_INTEGRATED', includedCents: 0 });
    // ③ T3 réel : composante unique, coût RÉALISÉ (commande payée), aucune composante REDUCTION.
    await passer(compte);
    const comps = await composantesActives(compte);
    console.info(`[L109D-E2E-01] composantes T3 : ${JSON.stringify(comps.map((x) => [x.kind, x.amount_minor]))}`);
    expect(comps.filter((x) => x.kind === 'REDUCTION')).toEqual([]);
    expect(comps.filter((x) => x.amount_minor === NET).map((x) => x.kind)).toEqual(['REALIZED_COST']);
    const apres = await tco(compte, maison.id);
    attendu(apres, f, 'après T3');
    expect(apres.annual.years.find((y) => y.year === 2021)).toMatchObject({ costsCents: NET, creditsCents: 0 });
    // ④ Fiche (route HTTP, mobile et desktop) : une entrée, aucune ligne « avoir », détail consultable, justificatif ouvrable.
    const vue = await fiche(compte, maison.id);
    expect(vue.summary.cumulativeCostCents).toBe(MAISON + NET);
    expect(vue.reductionsCents + vue.refundsCents + vue.indemnitiesCents).toBe(0);
    const lignes = (vue.lines as Json[]).filter((l) => l.includedCents === NET || l.amountMinor === 2000 || l.fileId === f);
    expect(lignes.filter((l) => l.kind === 'REDUCTION')).toEqual([]);
    expect(lignes.filter((l) => l.includedCents === NET)).toHaveLength(1);
    expect(JSON.stringify(vue.lines)).toContain(`"fileId":${f}`);
    expect(JSON.stringify(vue.lines)).not.toContain('sans en porter le prix');
    // T2 « coût de possession » lit le même service : même total.
    const { ownershipCostAnswer } = await import('@/services/verebona-assistant/canonical/structured-answers');
    const r = ownershipCostAnswer({ id: maison.id, name: 'Maison' } as never, apres);
    expect((r as { answer: string }).answer.replace(/[\s  ]/g, '')).toContain('490277,35');
  });

  it('L109D-E2E-02 — quatre formes persistées des indices T1 : 277,35 € partout ; T3 rejoué : stable, aucune ligne nouvelle', async () => {
    for (const nom of ['FACTURE_TOTAL_REMISE', 'REMISE_ISOLEE', 'LIGNES_SANS_TOTAL', 'COMMANDE_PAYEE']) {
      const { compte, maison, chaises } = await maisonEtChaises();
      const f = await commande(compte, maison, chaises, formes(maison.id, chaises)[nom]);
      attendu(await tco(compte, maison.id), f, `${nom} avant T3`);
      await passer(compte);
      const t1 = await tco(compte, maison.id);
      attendu(t1, f, `${nom} après T3`);
      expect(await credits(compte), nom).toBe(0);
      const avant = await composantesActives(compte);
      await passer(compte);
      await passer(compte);
      expect(await composantesActives(compte), `${nom} idempotent`).toEqual(avant);
      expect((await tco(compte, maison.id)).summary, nom).toEqual(t1.summary);
      // Aucune Opération autonome « remise » (une seule Opération de la commande, hors achat de la maison).
      const ops = (await k.actives(compte)).filter((o) => o.type_code !== null);
      const deLaCommande = [];
      for (const o of ops) if ((await k.sources(o.id)).some((s) => s.source_entity_key === String(f) && s.active)) deLaCommande.push(o.id);
      expect(deLaCommande, nom).toHaveLength(1);
    }
  });

  it('L109D-E2E-03 — vrai avoir postérieur : coût ajusté UNE fois, preuve conservée ; devis non réalisé : aucun coût', async () => {
    const { compte, maison, chaises } = await maisonEtChaises();
    const f = await commande(compte, maison, chaises, formes(maison.id, chaises).FACTURE_TOTAL_REMISE);
    const avoir = await k.document(compte, maison.id, [cand({ ...base(maison.id, chaises), summary: 'Avoir : retour d’une chaise', sourceRoleHint: 'CREDIT_NOTE',
      businessReferences: [ref('ORDER', 'TK-2021-0424'), ref('INVOICE', 'AV-12')], temporalHints: { realizedDate: '2021-06-02' },
      financialHints: [fh('REDUCTION', 6950, { economicDate: '2021-06-02' })] })], { type: 'ACQUISITION_INVOICE', title: 'Avoir n° AV-12', amountCents: 6950, date: '2021-06-02' });
    await sql`UPDATE asset_files SET equipment_id = ${chaises} WHERE id = ${avoir}`;
    const devis = await k.document(compte, maison.id, [cand({ ...base(maison.id, chaises), summary: 'Devis table', sourceRoleHint: 'QUOTE', statusHint: 'ENVISAGED',
      businessReferences: [ref('QUOTE', 'TK-D-9')], financialHints: [fh('FORECAST_COST', 89_000), fh('REDUCTION', 5000, { amountScope: null })] })],
    { type: 'ACQUISITION_QUOTE', title: 'Devis table Tikamoon', amountCents: 84_000, date: '2021-05-01' });
    for (const etape of ['avant T3', 'après T3']) {
      if (etape === 'après T3') await passer(compte);
      const t = await tco(compte, maison.id);
      expect(t.summary.cumulativeCostCents, etape).toBe(MAISON + NET - 6950);
      expect(t.reductionsCents, etape).toBe(6950);
      expect(t.lines.some((l) => l.fileId === avoir), etape).toBe(true);
      expect(t.lines.some((l) => l.fileId === f), etape).toBe(true);
      expect(retenues(t).some((l) => l.fileId === devis), etape).toBe(false);
    }
  });

  it('L109D-E2E-04 — nouvelle analyse : la barrière T1 ne laisse aucun candidat « avoir » établi depuis une remise ; aucune Opération autonome', async () => {
    const { compte, maison, chaises } = await maisonEtChaises();
    const { gateOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/prepare');
    const bruts = formes(maison.id, chaises).REMISE_ISOLEE.map((c, i) => ({ ...c, evidenceFactRefs: [`f${i}`], financialHints: c.financialHints.map((h) => ({ ...h, factRef: `f${i}` })) }));
    const g = gateOperationCandidates(bruts, {
      hasExploitableContent: true, documentTypeCode: 'ACQUISITION_ORDER', capabilities: { rooms: true, equipments: true }, keptFactRefs: new Set(['f0', 'f1']),
      verifiedIds: { ASSET: new Set([maison.id]), EQUIPMENT: new Set([chaises]), ROOM: new Set() },
    });
    expect(g.candidates.map((c) => [c.candidateKey, c.established])).toEqual([['op1', true], ['op2', false]]);
    const f = await commande(compte, maison, chaises, g.candidates);
    await passer(compte);
    attendu(await tco(compte, maison.id), f, 'barrière T1');
    expect(await credits(compte)).toBe(0);
    const [x] = await sql<Json[]>`SELECT established, payload->'adjustments' AS adj FROM document_operation_candidates WHERE file_id = ${f} AND candidate_key = 'op2' AND status = 'ACTIVE'`;
    expect(x).toMatchObject({ established: false });
  });

  it('L109D-E2E-05 — reprise de l’historique : faux avoir T3, Opération « remise » autonome, lignes au lieu du net → contrôle de cohérence (T3 déterministe), idempotent ; décision utilisateur préservée', async () => {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    // Trois commandes consolidées par T3, puis l'état laissé par l'ANCIENNE consolidation reproduit par le dépôt
    // (comme T3 l'écrivait avant le lot) : (a) faux avoir dans l'Opération de la commande, (b) Opération autonome
    // « remise », (c) composante de lignes (278,00 €) au lieu du net.
    const { compte, maison, chaises } = await maisonEtChaises();
    const fo = formes(maison.id, chaises);
    const f = await commande(compte, maison, chaises, fo.REMISE_ISOLEE);
    const f2 = await commande(compte, maison, chaises, fo.REMISE_ISOLEE.map((c) => ({ ...c, businessReferences: [ref('ORDER', 'TK-2021-0999')] })));
    const f3 = await commande(compte, maison, chaises, fo.LIGNES_SANS_TOTAL.map((c) => ({ ...c, businessReferences: [ref('ORDER', 'TK-2021-0777')] })));
    await passer(compte);
    const opDe = async (fileId: number) => {
      for (const o of await k.actives(compte)) if ((await k.sources(o.id)).some((x) => x.source_entity_key === String(fileId) && x.active)) return o;
      throw new Error(`aucune Opération pour ${fileId}`);
    };
    const opCommande = await opDe(f);
    const opLignes = await opDe(f3);
    const autonome = await withBusinessOperationWrite(compte.id, async (repo) => {
      const s = await repo.addSource(opCommande.id, { kind: 'DOCUMENT', entityKey: f, role: null, locator: { candidateKey: 'op2' }, authority: 'DOCUMENT', confidence: 'certain', matchMethod: 'M1' }, 'E2E_LEGACY');
      await repo.addFinancialComponent(opCommande.id, { kind: 'REDUCTION', amountMinor: 2000, currency: 'EUR', economicDate: D_CMD, sources: [{ sourceId: s }], fingerprint: 'legacy-remise' }, 'E2E_LEGACY');
      const c = await repo.create({ type: { code: 'ACQUISITION' }, status: 'REALIZED', realizedDate: D_CMD, reasonCode: 'E2E_LEGACY',
        source: { kind: 'DOCUMENT', entityKey: f2, role: null, locator: { candidateKey: 'op2' }, authority: 'DOCUMENT', confidence: 'certain' },
        assets: [{ assetId: maison.id, role: 'PRIMARY', authority: 'DOCUMENT' }] });
      await repo.addFinancialComponent(c.id, { kind: 'REDUCTION', amountMinor: 2000, currency: 'EUR', economicDate: D_CMD, sources: [{ sourceId: c.sourceId }], fingerprint: 'legacy-autonome' }, 'E2E_LEGACY');
      return c.id;
    });
    const net3 = (await k.composantes(opLignes.id)).find((x) => x.amount_minor === NET)!;
    await sql`UPDATE business_operation_financial_components SET amount_minor = 27800, fingerprint = 'legacy-lignes' WHERE id = ${net3.id}`;
    const faux = await tco(compte, maison.id);
    // Avant réparation (stock persisté) : 277,35 − 20 + 277,35 − 20 + 278,00 au lieu de 3 × 277,35.
    expect(faux.summary.cumulativeCostCents).toBe(MAISON + 2 * NET - 2000 - 2000 + 27_800);
    expect(await credits(compte)).toBe(2);

    // Mode à blanc : constat sans écriture.
    await controler(compte, [f, f2, f3], 'DRY_RUN');
    expect(await credits(compte)).toBe(2);
    // Mode correctif : reconsolidation T3 déterministe (aucune IA).
    await controler(compte, [f, f2, f3]);
    for (const x of [f, f2, f3]) {
      const p = await preuve(compte, x);
      console.info(`[L109D-E2E-05] document ${x} : ${p?.last_result}`);
      expect(['REPAIRED', 'CONSISTENT']).toContain(p?.last_result);
    }
    expect(await credits(compte)).toBe(0);
    const repare = await tco(compte, maison.id);
    expect(repare.summary.cumulativeCostCents).toBe(MAISON + 3 * NET);
    expect(repare.reductionsCents).toBe(0);
    expect((await k.operations(compte)).find((o) => o.id === autonome)!.invalidated_at).not.toBeNull();
    // Idempotent : rejoué, plus rien à faire ; T3 rejoué : stable.
    const etat = await composantesActives(compte);
    await controler(compte, [f, f2, f3]);
    for (const x of [f, f2, f3]) expect((await preuve(compte, x))?.last_result).toBe('CONSISTENT');
    await passer(compte);
    expect(await composantesActives(compte)).toEqual(etat);

    // Décision de l'utilisateur (montant retenu) sur une Opération : jamais réparée automatiquement, constat seulement.
    const { compte: c2, maison: m2, chaises: e2 } = await maisonEtChaises();
    const g = await commande(c2, m2, e2, formes(m2.id, e2).LIGNES_SANS_TOTAL);
    await passer(c2);
    const op2 = (await k.actives(c2)).find((o) => o.provider === 'Tikamoon')!;
    const comp2 = (await k.composantes(op2.id))[0];
    await sql`UPDATE business_operation_financial_components SET amount_minor = 27800 WHERE id = ${comp2.id}`;
    // Décision « montant retenu » de l'utilisateur (carte « À traiter » tranchée), comme `operation-cards` la persiste.
    const [carte] = await sql<{ id: number }[]>`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
      VALUES (${c2.id}, 'OPERATION', ${op2.id}, 'amount', 'ARBITRATE', 'E2E_109D', 'Montant ?') RETURNING id`;
    await withBusinessOperationWrite(c2.id, async (repo) => {
      await repo.addSource(op2.id, { kind: 'USER_ARBITRATION', entityKey: carte.id, locator: { decision: 'AMOUNT', fingerprint: 'x', amountMinor: 27800, currency: 'EUR' }, authority: 'USER', confidence: 'certain' }, 'E2E_USER');
    });
    await controler(c2, [g]);
    expect((await k.composantes(op2.id))[0].amount_minor).toBe(27800);
    expect((await preuve(c2, g))?.last_result).not.toBe('REPAIRED');
  });
});
