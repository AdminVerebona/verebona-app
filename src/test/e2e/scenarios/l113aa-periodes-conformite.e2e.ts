/**
 * Lot 113AA (Trello #725) — conformité des périodes métier au CDC #724, sur PostgreSQL 16 réel. Sorties T1 SIMULÉES
 * (candidats et faits génériques `period.*` persistés comme le fait le pipeline : aucun appel Gemini), consolidation T3
 * réelle (sans IA : `operationMatch: false`), projection Agenda réelle, cartes « À traiter » réelles (résolution par la
 * même fonction que l'interface), contrôle de cohérence (orchestrateur unique), routes réelles (session simulée).
 *
 *   L113AA-E2E-V2   pertinence décidée par T1 (contrat t1-business-periods-v2) : pertinente inconnue → « non renseignée »
 *                   (R02) ; non pertinente → aucun champ, même sur une facture (R03) ; durée indéterminée établie ≠ fin
 *                   inconnue (R10) ; effet contractuel ≠ couverture ; document SANS TYPE qualifié par T1 ;
 *   L113AA-E2E-T4   sens d'une date de fin (R17, §3 T4) : police dont la fin écrite n'est qu'une couverture → aucune
 *                   « Fin de contrat » ; avis d'échéance (Type de couverture) dont T1 qualifie la fin contractuelle → échéance
 *                   FONDÉE conservée et RÉTABLIE sur le stock (COH-OPS-CONTRACT-DATES v3) ; document sans type non qualifié →
 *                   règle 86C (prudence documentée), puis qualifié → fin retirée ; idempotent ;
 *   L113AA-E2E-D11  résolution contextuelle (R06, R13, R14) : succession sans question ; avenant déclaré → période actualisée,
 *                   ancienne dans l'historique ; contradiction réelle → UNE carte PERIOD-CONFLICT avec justificatifs ;
 *                   décision de l'utilisateur → durable, jamais redemandée (passage T3, contrôle, réanalyse) ; divergence
 *                   non qualifiée → aucune carte, constat PERIOD_DIVERGENCE_UNQUALIFIED ; compte isolé ;
 *   L113AA-E2E-R21  transversalité : même comportement pour un véhicule, un objet et un document d'équipement.
 *
 * Assertions bornées aux comptes créés ici.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { cand, cible, cibleEquipement, fh, operationsKit, ref, RECETTE_TODAY, type OperationsKit } from '../datasets/operations-v1';
import { proofOf, runCoherenceFor } from '../coherence-run';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;

/** Pièce contractuelle datée (attestation, police, avis) : dates d'effet et de fin écrites. */
const piece = (assetTarget: ReturnType<typeof cible> | ReturnType<typeof cibleEquipement>, start: string | null, end: string | null, o: { police?: string; provider?: string; role?: string; summary?: string } = {}): AnchoredOperationCandidate =>
  cand({
    typeHint: 'CONTRACT', statusHint: 'REALIZED', sourceRoleHint: (o.role ?? 'CONTRACT_DOCUMENT') as never, provider: o.provider ?? 'Assureur Habitation',
    summary: o.summary ?? 'Assurance habitation', targetHints: [assetTarget],
    businessReferences: [ref('POLICY', o.police ?? 'POL-725')] as AnchoredOperationCandidate['businessReferences'],
    temporalHints: { ...(start ? { startDate: start } : {}), ...(end ? { endDate: end } : {}) }, financialHints: [],
  });

scenario('L113AA', 'Périodes métier — conformité au CDC #724 (#725)', ({ sql, make }) => {
  let k: OperationsKit;
  beforeAll(() => { k = operationsKit(sql, make); });
  afterAll(() => { session.currentAccountId = null; });
  const as = (c: AccountRow) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };
  const svc = () => import('@/services/documents/business-periods/service');
  const rafraichir = async (c: AccountRow, ids: number[]) => { for (const id of ids) await (await svc()).refreshDocumentBusinessPeriods(c.id, id); };
  const lireDoc = async (c: AccountRow, id: number) => {
    as(c);
    const { GET } = await import('@/app/api/documents/[id]/periodes/route');
    const r = await GET(new NextRequest(`http://x/api/documents/${id}/periodes`), { params: Promise.resolve({ id: String(id) }) });
    expect(r.status).toBe(200);
    return (await r.json() as { periods: Json }).periods;
  };
  /** Sortie T1 simulée : faits génériques `period.*` persistés (même table et mêmes colonnes que le pipeline). */
  const faits = async (c: AccountRow, fileId: number, liste: Array<[string, string, (string | null)?, (string | null)?]>) => {
    const [x] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`;
    for (const [key, value, attribute, rawValue] of liste) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, raw_key, attribute, normalized_value, raw_value, confidence, excerpt, status)
                VALUES (${c.id}, ${fileId}, ${x.id}, ${key}, ${key}, ${attribute ?? null}, ${value}, ${rawValue ?? null}, 'certain', ${`extrait ${value}`}, 'active')`;
    }
  };
  const details = async (opId: number) => (await sql<{ f: string | null; t: string | null }[]>`
    SELECT effective_from::text AS f, effective_to::text AS t FROM business_operation_contract_details WHERE operation_id = ${opId}`)[0] ?? null;
  const opDe = async (c: AccountRow, fileId: number) => (await sql<{ id: number }[]>`
    SELECT DISTINCT s.operation_id::int AS id FROM business_operation_sources s JOIN business_operations o ON o.id = s.operation_id AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
     WHERE s.account_id = ${c.id} AND s.active AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = ${String(fileId)}`)[0]?.id;
  const finsContrat = (c: AccountRow) => sql<{ id: number; start_date: string | null; op: number | null }[]>`
    SELECT id, start_date::text AS start_date, business_operation_id::int AS op FROM agenda_items WHERE account_id = ${c.id} AND business_type = 'contract' ORDER BY id`;
  const projeter = async (c: AccountRow) => (await import('@/services/business-operations/agenda-projection/service')).projectAccountOperations(c.id, { all: true, today: RECETTE_TODAY });
  const cartes = (c: AccountRow) => sql<{ id: number; public_id: string; target_id: number; relation_key: string; trigger_context: Json; proposals: Json[]; resolved_at: string | null; question: string }[]>`
    SELECT id, public_id, target_id, relation_key, trigger_context, proposals_json AS proposals, resolved_at::text AS resolved_at, question FROM to_process_actions
     WHERE account_id = ${c.id} AND rule_code = 'PERIOD-CONFLICT' ORDER BY id`;

  // ══ V2 ═══════════════════════════════════════════════════════════════════
  it('L113AA-E2E-V2 — pertinence décidée par T1 : inconnue, non pertinente, indéterminée ; durée indéterminée ; sans type', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    // R02 : pertinente mais inconnue, sur un document qui n'est PAS une pièce contractuelle (pertinence par l'IA, pas par le rôle).
    const courrier = await k.document(c, m.id, [cand({ typeHint: null, sourceRoleHint: 'OTHER' as never, targetHints: [cible(m.id)] })], { title: 'Courrier assureur' });
    await faits(c, courrier, [['period.relevance', 'coverage=unknown;contract=undetermined;billing=not_relevant']]);
    // R03 : facture que T1 juge sans période utile (achat ponctuel) — aucun champ, même avec un rôle de facturation.
    const achat = await k.document(c, m.id, [cand({ typeHint: 'ACQUISITION', sourceRoleHint: 'INVOICE', targetHints: [cible(m.id)], temporalHints: { realizedDate: '2026-02-03' },
      financialHints: [fh('REALIZED_COST', 45900, { economicDate: '2026-02-03' })] })], { type: 'INVOICE', title: 'Facture aspirateur' });
    await faits(c, achat, [['period.relevance', 'billing=not_relevant;coverage=not_relevant;warranty=undetermined']]);
    // R10 : abonnement à durée indéterminée établie + couverture distincte ; document SANS type.
    const abo = await k.document(c, m.id, [piece(cible(m.id), '2024-07-05', null, { police: 'ABO-1', provider: 'Télésurveillance' })], { title: 'Contrat télésurveillance' });
    await faits(c, abo, [['period.relevance', 'contract=known;coverage=known'], ['period.contract', '2024-07-05/INDEFINITE', 'principal'], ['period.coverage', '2024-07-05/']]);
    // Indéterminée seule : aucune obligation fictive (la pièce contractuelle datée n'est pas convertie en couverture).
    const flou = await k.document(c, m.id, [piece(cible(m.id), '2025-01-01', '2025-12-31', { police: 'X-9', provider: 'Autre' })], { title: 'Document divers' });
    await faits(c, flou, [['period.relevance', 'coverage=undetermined;contract=undetermined']]);
    await rafraichir(c, [courrier, achat, abo, flou]);

    expect((await lireDoc(c, courrier)).principal).toMatchObject({ kind: 'COVERAGE', line: 'Période couverte : non renseignée' });
    expect(await lireDoc(c, achat)).toMatchObject({ principal: null, secondary: [] });
    const a = await lireDoc(c, abo);
    expect(a.principal).toMatchObject({ kind: 'CONTRACT', line: 'Date d’effet du contrat : 05/07/2024 (durée indéterminée)' });
    expect(a.secondary.map((x: Json) => x.line)).toEqual(['Début de couverture : 05/07/2024']);
    const [ouvert] = await sql<{ end_open: boolean; end_on: string | null }[]>`SELECT end_open, end_on FROM document_business_periods WHERE file_id = ${abo} AND period_kind = 'CONTRACT' AND status = 'ACTIVE'`;
    expect(ouvert).toEqual({ end_open: true, end_on: null });
    expect(await lireDoc(c, flou)).toMatchObject({ principal: null, secondary: [] });
    // « non renseignée » corrigeable (même fait) ; la correction ne fabrique jamais une durée indéterminée.
    const [p] = await sql<{ id: number }[]>`SELECT id::int AS id FROM document_business_periods WHERE file_id = ${courrier} AND status = 'ACTIVE'`;
    const { correctDocumentPeriod } = await svc();
    expect(await correctDocumentPeriod(c.id, c.ownerUserId, courrier, { periodId: p.id, start: '2026-01-01', end: '2026-12-31' })).toMatchObject({ ok: true });
    expect((await lireDoc(c, courrier)).principal.line).toBe('Période couverte : du 01/01/2026 au 31/12/2026');
    // Reprise rejouée : rien ne change (empreintes stables).
    for (const f of [courrier, achat, abo, flou]) expect((await (await svc()).refreshDocumentBusinessPeriods(c.id, f)).outcome).toBe('UNCHANGED');
    // Listes / recherche / exports : la MÊME période principale par une lecture groupée, bornée au compte.
    const lignes = await (await svc()).readPrincipalPeriodLines(c.id, [courrier, achat, abo, flou]);
    expect([...lignes.entries()].sort((x, y) => x[0] - y[0])).toEqual([
      [courrier, { kind: 'COVERAGE', line: 'Période couverte : du 01/01/2026 au 31/12/2026' }],
      [abo, { kind: 'CONTRACT', line: 'Date d’effet du contrat : 05/07/2024 (durée indéterminée)' }]]);
    const autre = await make.account({ plan: 'premium' });
    expect((await (await svc()).readPrincipalPeriodLines(autre.id, [courrier, abo])).size).toBe(0);
  });

  // ══ T4 ═══════════════════════════════════════════════════════════════════
  it('L113AA-E2E-T4 — sens d’une date de fin : couverture ≠ fin de contrat ; échéance fondée conservée et rétablie ; sans type', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    // Police dont la fin écrite n'est qu'une COUVERTURE (T1 : contrat indéterminé, couverture connue).
    const police = await k.document(c, m.id, [piece(cible(m.id), '2026-04-01', '2027-03-31', { police: 'POL-P', provider: 'Assureur P' })], { type: 'INSURANCE_POLICY', title: 'Conditions particulières' });
    await faits(c, police, [['period.relevance', 'contract=undetermined;coverage=known'], ['period.coverage', '2026-04-01/2027-03-31', 'principal']]);
    // Avis d'échéance (Type de COUVERTURE, liste 113W2) dont T1 qualifie la fin CONTRACTUELLE : échéance réellement fondée.
    const avis = await k.document(c, m.id, [piece(cible(m.id), '2026-01-01', '2027-12-31', { police: 'POL-A', provider: 'Assureur A' })], { type: 'INSURANCE_DUE_NOTICE', title: 'Avis d’échéance — fin du contrat' });
    await faits(c, avis, [['period.relevance', 'contract=known;coverage=known'], ['period.contract', '2026-01-01/2027-12-31']]);
    // Document SANS type, non qualifié : règle 86C (prudence documentée : sa fin écrite reste une fin de contrat).
    const brut = await k.document(c, m.id, [piece(cible(m.id), '2026-02-01', '2027-01-31', { police: 'POL-S', provider: 'Assureur S' })], { title: 'Document reçu' });
    await k.passer(c);
    await k.passer(c);
    const [opP, opA, opS] = [await opDe(c, police), await opDe(c, avis), await opDe(c, brut)];
    expect(await details(opP)).toMatchObject({ t: null });
    // Aucun transfert mécanique de la date d'effet d'une couverture vers l'effet contractuel.
    expect(await details(opP)).toMatchObject({ f: null });
    expect(await details(opA)).toMatchObject({ f: '2026-01-01', t: '2027-12-31' });
    expect(await details(opS)).toMatchObject({ t: '2027-01-31' });
    await projeter(c);
    expect((await finsContrat(c)).map((x) => [x.op, x.start_date]).sort()).toEqual([[opA, '2027-12-31'], [opS, '2027-01-31']].sort());

    // Stock : fin de l'avis retirée à tort (113W2, Type seul) et échéance disparue → la campagne v3 la RÉTABLIT.
    await sql`UPDATE business_operation_contract_details SET effective_to = NULL WHERE operation_id = ${opA}`;
    await sql`UPDATE business_operations SET end_date = NULL WHERE id = ${opA}`;
    // Le document sans type est maintenant qualifié par T1 : sa fin n'est qu'une couverture.
    await faits(c, brut, [['period.relevance', 'contract=not_relevant;coverage=known'], ['period.coverage', '2026-02-01/2027-01-31']]);
    const blanc = await runCoherenceFor(sql, [c.id], { mode: 'DRY_RUN', today: RECETTE_TODAY });
    expect(blanc.results['COH-OPS-CONTRACT-DATES']).toMatchObject({ WOULD_REPAIR: 2 });
    expect(await details(opA)).toMatchObject({ t: null });
    await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    expect(await details(opA)).toMatchObject({ t: '2027-12-31' });
    expect(await details(opS)).toMatchObject({ t: null });
    expect(await details(opP)).toMatchObject({ t: null });
    const fins = await finsContrat(c);
    expect(fins.map((x) => [x.op, x.start_date])).toEqual([[opA, '2027-12-31']]);
    // Idempotent.
    const r2 = await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
    expect(r2.results['COH-OPS-CONTRACT-DATES']?.REPAIRED ?? 0).toBe(0);
    expect((await finsContrat(c)).map((x) => x.id)).toEqual(fins.map((x) => x.id));
  });

  // ══ D11 ══════════════════════════════════════════════════════════════════
  describe('D11 — résolution contextuelle des périodes d’un événement de référence', () => {
    let c: AccountRow; let m: { id: number }; let op: number; let docs: Record<string, number>;
    const v2 = (val: string, ...extra: Array<[string, string, (string | null)?, (string | null)?]>) => [['period.relevance', 'coverage=known;contract=undetermined'], ['period.coverage', val, 'principal'], ...extra] as Array<[string, string, (string | null)?, (string | null)?]>;

    it('L113AA-E2E-D11 — succession, avenant, contradiction → une question ciblée, décision durable, jamais redemandée', async () => {
      c = await make.account({ plan: 'premium' });
      m = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
      docs = {};
      const deposer = async (nom: string, start: string, end: string) => {
        const f = await k.document(c, m.id, [piece(cible(m.id), start, end)], { type: 'INSURANCE_CERTIFICATE', title: nom });
        docs[nom] = f;
        return f;
      };
      // R06 : trois attestations successives qualifiées.
      for (const [n, s, e] of [['Attestation 2023', '2023-04-01', '2024-03-31'], ['Attestation 2024', '2024-04-01', '2025-03-31'], ['Attestation 2025', '2025-04-01', '2026-03-31']] as const) {
        await faits(c, await deposer(n, s, e), v2(`${s}/${e}`));
      }
      // R13 : avenant déclaré par T1 qui actualise la période 2024.
      await faits(c, await deposer('Avenant 2024', '2024-06-01', '2025-03-31'), v2('2024-06-01/2025-03-31', ['period.relation', 'amendment', null, 'Avenant n° 1 — modification de la période de garantie']));
      await k.passer(c);
      await k.passer(c);
      op = (await k.actives(c)).filter((o) => o.type_code === 'CONTRACT').map((o) => o.id)[0];
      await rafraichir(c, Object.values(docs));
      await k.passer(c);

      const h = (await (await svc()).readOperationCoverageHistory(c.id, op))!;
      const parDoc = new Map(h.coverages.map((x) => [x.fileId, x]));
      expect(h.coverages).toHaveLength(4);
      expect(parDoc.get(docs['Attestation 2023'])!.resolution).toBeUndefined();
      expect(parDoc.get(docs['Attestation 2025'])!.resolution).toBeUndefined();
      expect(parDoc.get(docs['Attestation 2024'])!.resolution).toMatchObject({ status: 'REPLACED', byFileId: docs['Avenant 2024'], note: 'Actualisée par l’avenant « Avenant 2024 »' });
      expect(parDoc.get(docs['Avenant 2024'])!.resolution).toBeUndefined();
      expect(await cartes(c)).toEqual([]);

      // R14 : contradiction réelle (deux attestations qualifiées, rien ne l'explique) → UNE question avec justificatifs.
      await faits(c, await deposer('Attestation 2025 bis', '2025-07-01', '2026-06-30'), v2('2025-07-01/2026-06-30'));
      await k.passer(c);
      await rafraichir(c, [docs['Attestation 2025 bis']]);
      await k.passer(c);
      const ouvertes = (await cartes(c)).filter((x) => !x.resolved_at);
      expect(ouvertes).toHaveLength(1);
      const carte = ouvertes[0];
      expect(carte.question).toBe('Ces documents indiquent des périodes différentes : laquelle est la bonne ?');
      expect(carte.trigger_context).toMatchObject({ kind: 'period_conflict', operationId: op, fileIds: [docs['Attestation 2025'], docs['Attestation 2025 bis']] });
      expect(carte.proposals.map((p) => p.value)).toEqual([`KEEP:${docs['Attestation 2025']}`, `KEEP:${docs['Attestation 2025 bis']}`, 'BOTH']);
      expect(carte.proposals[0]).toMatchObject({ evidenceIds: [`file:${docs['Attestation 2025']}`] });
      expect(JSON.stringify(carte)).not.toMatch(/Opération/);
      const h2 = (await (await svc()).readOperationCoverageHistory(c.id, op))!;
      expect(h2.coverages.find((x) => x.fileId === docs['Attestation 2025 bis'])!.resolution).toMatchObject({ status: 'CONFLICT', pendingQuestion: true });
      // Rejoué (passage T3, contrôle) : toujours UNE carte.
      await k.passer(c);
      await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
      expect((await cartes(c)).filter((x) => !x.resolved_at).map((x) => x.id)).toEqual([carte.id]);

      // Décision de l'utilisateur (même fonction que l'interface) : durable, aucune période modifiée.
      const avant = await sql`SELECT id, start_on, end_on FROM document_business_periods WHERE account_id = ${c.id} AND status = 'ACTIVE' ORDER BY id`;
      const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
      expect(await resolveArbitration(c.id, carte.public_id, `KEEP:${docs['Attestation 2025']}`, { userId: c.ownerUserId })).toMatchObject({ ok: true });
      expect(await sql`SELECT id, start_on, end_on FROM document_business_periods WHERE account_id = ${c.id} AND status = 'ACTIVE' ORDER BY id`).toEqual(avant);
      const [dec] = await sql<Json[]>`SELECT choice, retained_file_id, status, decided_by_user_id FROM business_period_decisions WHERE account_id = ${c.id}`;
      expect(dec).toMatchObject({ choice: 'KEEP', retained_file_id: docs['Attestation 2025'], status: 'ACTIVE', decided_by_user_id: c.ownerUserId });
      const h3 = (await (await svc()).readOperationCoverageHistory(c.id, op))!;
      expect(h3.coverages.find((x) => x.fileId === docs['Attestation 2025 bis'])!.resolution).toMatchObject({ status: 'REPLACED', note: 'Remplacée par « Attestation 2025 » (votre choix)' });
      // Jamais redemandé : passage T3, contrôle de cohérence, requalification.
      await rafraichir(c, Object.values(docs));
      await k.passer(c);
      const r = await runCoherenceFor(sql, [c.id], { today: RECETTE_TODAY });
      expect(r.results['COH-OPS-PERIOD-RESOLUTION']?.REPAIRED ?? 0).toBe(0);
      expect((await cartes(c)).filter((x) => !x.resolved_at)).toEqual([]);
      // Isolation : un autre compte ne lit ni l'historique ni la décision.
      const autre = await make.account({ plan: 'premium' });
      expect(await (await svc()).readOperationCoverageHistory(autre.id, op)).toBeNull();
      // Lecture groupée publique (Assistant, dossiers) : la MÊME résolution que la fiche ; autre compte : rien.
      const groupe = await (await svc()).readOperationsCoverageHistories(c.id, [op]);
      expect(groupe.get(op)!.coverages).toEqual((await (await svc()).readOperationCoverageHistory(c.id, op))!.coverages);
      expect((await (await svc()).readOperationsCoverageHistories(autre.id, [op])).size).toBe(0);
    });

    it('L113AA-E2E-D11b — divergence avec un document NON qualifié (bloc 28 absent) : aucune question, constat signalé', async () => {
      const c2 = await make.account({ plan: 'premium' });
      const m2 = await make.asset(c2, { category: 'IMMOBILIER', name: 'Maison' });
      const a = await k.document(c2, m2.id, [piece(cible(m2.id), '2025-04-01', '2026-03-31', { police: 'POL-N' })], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation A' });
      await faits(c2, a, v2('2025-04-01/2026-03-31'));
      // Document analysé sans le bloc 28 : couverture lue sans IA (113W), aucune qualification v2.
      const b = await k.document(c2, m2.id, [piece(cible(m2.id), '2025-07-01', '2026-06-30', { police: 'POL-N' })], { type: 'INSURANCE_CERTIFICATE', title: 'Attestation B' });
      await k.passer(c2);
      await k.passer(c2);
      await rafraichir(c2, [a, b]);
      const op2 = (await k.actives(c2)).filter((o) => o.type_code === 'CONTRACT').map((o) => o.id)[0];
      const h = (await (await svc()).readOperationCoverageHistory(c2.id, op2))!;
      expect(h.coverages.map((x) => x.resolution?.status)).toEqual(['CONFLICT', 'CONFLICT']);
      expect(h.coverages.every((x) => !x.resolution?.pendingQuestion)).toBe(true);
      expect(h.coverages[0].resolution!.note).toBe('Les justificatifs indiquent des périodes différentes.');
      expect(await cartes(c2)).toEqual([]);
      const r = await runCoherenceFor(sql, [c2.id], { today: RECETTE_TODAY });
      expect(r.results['COH-OPS-PERIOD-RESOLUTION']).toMatchObject({ FINDING: 1 });
      const p = await proofOf(sql, c2.id, 'COH-OPS-PERIOD-RESOLUTION', op2);
      expect(p).toMatchObject({ last_result: 'FINDING' });
      expect(JSON.stringify(p!.finding)).toContain('PERIOD_DIVERGENCE_UNQUALIFIED');
      expect(await cartes(c2)).toEqual([]);
    });
  });

  // ══ R21 ══════════════════════════════════════════════════════════════════
  it('L113AA-E2E-R21 — véhicule, objet, équipement : mêmes règles, aucune exception par fournisseur', async () => {
    const c = await make.account({ plan: 'premium' });
    const auto = await make.asset(c, { category: 'VEHICULE', name: 'Voiture' });
    const velo = await make.asset(c, { category: 'OBJET', name: 'Vélo' });
    const maison = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    const [eq] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${maison.id}, 'Chaudière') RETURNING id`;
    const fa = await k.document(c, auto.id, [piece(cible(auto.id), '2026-02-01', '2027-01-31', { police: 'AUTO-1', provider: 'Mutuelle Auto' })], { type: 'INSURANCE_POLICY', title: 'Assurance auto' });
    await faits(c, fa, [['period.relevance', 'coverage=known;contract=undetermined'], ['period.coverage', '2026-02-01/2027-01-31']]);
    const fv = await k.document(c, velo.id, [cand({ typeHint: 'ACQUISITION', sourceRoleHint: 'INVOICE', targetHints: [cible(velo.id)], financialHints: [fh('REALIZED_COST', 89900)] })], { type: 'INVOICE', title: 'Facture vélo' });
    await faits(c, fv, [['period.relevance', 'billing=not_relevant;warranty=known'], ['period.warranty', '2026-03-01/2028-02-29']]);
    const fe = await k.document(c, maison.id, [cand({ typeHint: 'INTERVENTION', sourceRoleHint: 'INVOICE', targetHints: [cibleEquipement(eq.id)], financialHints: [fh('REALIZED_COST', 18900)] })], { type: 'INVOICE', title: 'Entretien chaudière' });
    await faits(c, fe, [['period.relevance', 'realization=known;billing=not_relevant'], ['period.realization', '2026-03-14']]);
    await k.passer(c);
    await rafraichir(c, [fa, fv, fe]);
    expect((await lireDoc(c, fa)).principal.line).toBe('Période couverte : du 01/02/2026 au 31/01/2027');
    expect((await lireDoc(c, fv)).principal.line).toBe('Période de garantie : du 01/03/2026 au 29/02/2028');
    expect((await lireDoc(c, fe)).principal.line).toBe('Période de réalisation : 14/03/2026');
    const opA = await opDe(c, fa);
    expect(await details(opA)).toMatchObject({ t: null });
    await projeter(c);
    expect(await finsContrat(c)).toEqual([]);
  });
});
