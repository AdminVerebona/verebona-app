/**
 * Carte Trello #783 (lot 115D) — RENOMMAGE IA CONTEXTUEL, PostgreSQL réel : service de nommage
 * unique réel, qualification des périodes réelle (lot 113W), AUCUN appel à un fournisseur d'IA
 * (les sorties T1 sont simulées par des candidats et des faits persistés).
 *
 *   L115D-E2E-10  facture d'achat avec garantie (cas de la capture) : le titre ne reprend PAS les
 *                 bornes de garantie ; la garantie reste une période STRUCTURÉE du document,
 *                 affichée et éditable ; le titre nomme l'objet, le fournisseur et la date ;
 *   L115D-E2E-11  une période facturée nomme toujours une facture d'abonnement (rien n'est supprimé
 *                 en bloc) ; une facture d'achat qui porte LES DEUX garde la période facturée ;
 *   L115D-E2E-12  reprise du stock : un titre automatique écrit avant la carte est repris par le
 *                 contrôle COH-DOC-TITLES (version des règles), à blanc puis en réparation,
 *                 IDEMPOTENTE ; un titre modifié par l'utilisateur n'est jamais touché.
 *
 * Assertions bornées aux comptes créés ici.
 */
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { cand, cible, fh, operationsKit, ref, type OperationsKit } from '../datasets/operations-v1';
import { proofOf, runCoherenceFor } from '../coherence-run';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    tryGetSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
type Fait = [string, string, string | null, (string | null)?, (string | null)?];

/** Achat ponctuel d'un équipement (aucune date dans le candidat : les périodes viennent des faits). */
const achat = (assetId: number): AnchoredOperationCandidate => cand({
  typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', provider: 'Conforama France SA',
  summary: 'Table de cuisson', targetHints: [cible(assetId)], temporalHints: {}, financialHints: [],
});
/** Échéance d'abonnement (période facturée prouvée, portée INSTALLMENT). */
const abonnement = (assetId: number, debut: string, fin: string): AnchoredOperationCandidate => cand({
  typeHint: 'INTERVENTION', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', provider: 'Homiris',
  summary: 'Abonnement télésurveillance', targetHints: [cible(assetId)],
  businessReferences: [ref('INVOICE', 'F-2026-02')] as AnchoredOperationCandidate['businessReferences'],
  temporalHints: { startDate: debut, endDate: fin },
  financialHints: [fh('REALIZED_COST', 3990, { amountScope: 'INSTALLMENT', economicDate: debut, periodStart: debut, periodEnd: fin })],
});

scenario('L115D-TITRE', 'Renommage contextuel : la garantie ne nomme pas une facture d’achat (#783)', ({ sql, make }) => {
  let k: OperationsKit;
  beforeAll(() => { k = operationsKit(sql, make); });
  afterAll(() => { session.currentAccountId = null; });

  const svc = () => import('@/services/documents/document-title.service');
  const cuisine = (c: AccountRow) => make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });

  /** Faits T1 persistés, avec leurs bornes de période (colonnes lues par le nommage). */
  const faits = async (c: AccountRow, fileId: number, liste: Fait[]) => {
    const [x] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`;
    for (const [key, value, attribute, debut, fin] of liste) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, raw_key, attribute, normalized_value,
                                            period_start, period_end, confidence, excerpt, status)
                VALUES (${c.id}, ${fileId}, ${x.id}, ${key}, ${key}, ${attribute}, ${value},
                        ${debut ?? null}, ${fin ?? null}, 'certain', ${`extrait ${value}`}, 'active')`;
    }
  };
  const titre = (fileId: number) => sql<Json[]>`
    SELECT retained_title, title_source, title_rule_version::int AS rule_version, title_convention,
           title_basis -> 'billedPeriod' AS billed, title_basis ->> 'supplier' AS supplier
      FROM asset_files WHERE id = ${fileId}`.then((r) => r[0]);
  const periodes = (fileId: number) => sql<Json[]>`
    SELECT period_kind AS kind, start_on AS s, end_on AS e, origin FROM document_business_periods
     WHERE file_id = ${fileId} AND status = 'ACTIVE' ORDER BY period_kind`;
  const nommer = async (c: AccountRow, fileId: number, mode: 'refresh' | 'repair' = 'refresh') =>
    (await svc()).ensureBusinessTitle({ fileId, accountId: c.id, origin: mode === 'repair' ? 'COHERENCE' : 'T1', mode });

  /** Facture d'achat de la capture : garantie de deux ans, objet identifié, fournisseur de l'émetteur. */
  const factureAchat = async (c: AccountRow, o: { facturee?: [string, string] } = {}) => {
    const m = await cuisine(c);
    const id = await k.document(c, m.id, [achat(m.id)], { type: 'INVOICE', title: 'Facture', amountCents: 46999, date: '2026-11-14' });
    await faits(c, id, [
      ['period.warranty', '2026-11-14/2028-11-14', 'principal', '2026-11-14', '2028-11-14'],
      ...(o.facturee ? [['period.billing', `${o.facturee[0]}/${o.facturee[1]}`, null, o.facturee[0], o.facturee[1]] as Fait] : []),
    ]);
    await sql`UPDATE asset_files SET upload_status = 'COMPLETED', supplier = 'Conforama France SA Chasse S/R', analysis_state = 'ANALYZED',
                     last_analysis_at = now() - interval '1 hour' WHERE id = ${id}`;
    await sql`UPDATE document_extractions SET title = 'Facture', supplier_name = 'Conforama France SA Chasse S/R',
                     document_date = '2026-11-14' WHERE file_id = ${id}`;
    // Sujet structuré du document (objet acheté) : ce que le titre doit nommer.
    await sql`UPDATE document_facts SET subject = 'Table de cuisson FAR CI606025BK' WHERE file_id = ${id} AND raw_key = 'period.warranty'`;
    const r = await (await import('@/services/documents/business-periods/service')).refreshDocumentBusinessPeriods(c.id, id);
    expect(r.outcome).toBe('UPDATED');
    return { m, id };
  };

  it('L115D-E2E-10 — facture d’achat avec garantie : le titre ne reprend pas les bornes de garantie, la période reste structurée', async () => {
    const c = await make.account({ plan: 'premium' });
    const { id } = await factureAchat(c);

    expect((await nommer(c, id)).outcome).toBe('UPDATED');
    const t = await titre(id);
    // Critère d'acceptation : plus aucune plage de garantie dans le titre.
    expect(t.retained_title).not.toMatch(/2028|14 novembre 2026 au/);
    // Le titre nomme la nature, l'objet acheté, le fournisseur et la date du document.
    expect(t.retained_title).toBe('Facture Table de cuisson FAR CI606025BK Conforama France SA Chasse S/R — 14 novembre 2026');
    // Aucune période facturée n'a été fabriquée depuis la garantie (données de nommage).
    expect(t.billed).toBeNull();
    expect(t.title_convention).toBeNull();
    // La garantie reste un FAIT structuré du document, intact (affiché et éditable, carte #782).
    expect(await periodes(id)).toEqual([{ kind: 'WARRANTY', s: '2026-11-14', e: '2028-11-14', origin: 'T1' }]);
  });

  it('L115D-E2E-11 — une période facturée nomme toujours : abonnement mensuel, et achat qui porte les deux', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await cuisine(c);
    // Facture d'abonnement : la période facturée est discriminante — elle reste dans le titre.
    const mensuelle = await k.document(c, m.id, [abonnement(m.id, '2026-02-01', '2026-02-28')], { type: 'INVOICE', title: 'Facture', amountCents: 3990, date: '2026-02-06' });
    await sql`UPDATE asset_files SET supplier = 'HOMIRIS', analysis_state = 'ANALYZED', last_analysis_at = now() - interval '1 hour' WHERE id = ${mensuelle}`;
    await sql`UPDATE document_extractions SET title = 'Facture', supplier_name = 'HOMIRIS', document_date = '2026-02-06' WHERE file_id = ${mensuelle}`;
    expect((await nommer(c, mensuelle)).outcome).toBe('UPDATED');
    expect((await titre(mensuelle)).retained_title).toBe('Facture Homiris — Février 2026');
    expect((await titre(mensuelle)).title_convention).toBe('PERIODIC');

    // Facture d'achat portant AUSSI une période facturée : c'est elle qui nomme, jamais la garantie.
    const b = await factureAchat(c, { facturee: ['2026-11-01', '2026-11-30'] });
    expect((await nommer(c, b.id)).outcome).toBe('UPDATED');
    const t = await titre(b.id);
    expect(t.billed).toMatchObject({ start: '2026-11-01', end: '2026-11-30' });
    expect(t.retained_title).toContain('Novembre 2026');
    expect(t.retained_title).not.toMatch(/2028/);
    // Les deux périodes restent qualifiées et distinctes sur le document.
    expect((await periodes(b.id)).map((x) => [x.kind, x.s, x.e])).toEqual([
      ['BILLING', '2026-11-01', '2026-11-30'], ['WARRANTY', '2026-11-14', '2028-11-14'],
    ]);
  });

  it('L115D-E2E-12 — reprise du stock : COH-DOC-TITLES reprend les titres automatiques, idempotente ; titre utilisateur intact', async () => {
    const c = await make.account({ plan: 'premium' });
    const a = await factureAchat(c);
    const u = await factureAchat(c);
    // Titres écrits AVANT la carte (version des règles antérieure) : l'un automatique, l'autre de l'utilisateur.
    const ANCIEN = 'Facture Conforama France SA Chasse S/R — 14 novembre 2026 au 14 novembre 2028';
    for (const id of [a.id, u.id]) {
      await sql`UPDATE asset_files SET retained_title = ${ANCIEN}, title_source = 'SYSTEM', title_rule_version = 3,
                       title_context_fingerprint = 'v3', title_checked_at = now() - interval '2 days' WHERE id = ${id}`;
    }
    await sql`UPDATE asset_files SET retained_title = 'Ma facture de table de cuisson', title_source = 'USER' WHERE id = ${u.id}`;

    // Simulation (à blanc) par le contrôle COH-DOC-TITLES : le titre automatique est signalé, rien n'est écrit.
    const blanc = await runCoherenceFor(sql, [c.id], { mode: 'DRY_RUN' });
    expect(blanc.results['COH-DOC-TITLES']?.WOULD_REPAIR).toBeGreaterThanOrEqual(1);
    expect((await proofOf(sql, c.id, 'COH-DOC-TITLES', a.id))).toMatchObject({ last_result: 'WOULD_REPAIR', last_mode: 'DRY_RUN' });
    // À blanc : AUCUN titre n'est écrit (ni l'automatique, ni celui de l'utilisateur).
    expect((await titre(a.id)).retained_title).toBe(ANCIEN);
    expect((await titre(u.id)).retained_title).toBe('Ma facture de table de cuisson');

    // Réparation : nouveau titre par le MÊME service de nommage, version des règles à jour.
    const correctif = await runCoherenceFor(sql, [c.id], { mode: 'CORRECTIVE' });
    expect(correctif.results['COH-DOC-TITLES']?.REPAIRED).toBeGreaterThanOrEqual(1);
    const apres = await titre(a.id);
    expect(apres.retained_title).not.toMatch(/2028/);
    // Règle remplacée (carte #813) : version des règles de titre 4 → 5.
    expect(apres.rule_version).toBe(5);
    // Idempotence : un second passage ne répare plus rien et ne renomme rien.
    const second = await runCoherenceFor(sql, [c.id], { mode: 'CORRECTIVE' });
    expect(second.results['COH-DOC-TITLES']?.REPAIRED ?? 0).toBe(0);
    expect((await titre(a.id)).retained_title).toBe(apres.retained_title);
    expect((await nommer(c, a.id, 'repair')).outcome).toBe('NO_CHANGE');
    // Le titre de l'utilisateur reste intact après la campagne et une nouvelle passe de nommage.
    expect((await nommer(c, u.id, 'repair')).outcome).toBe('SKIP_USER_TITLE');
    expect(await titre(u.id)).toMatchObject({ retained_title: 'Ma facture de table de cuisson', title_source: 'USER' });
  });
});
