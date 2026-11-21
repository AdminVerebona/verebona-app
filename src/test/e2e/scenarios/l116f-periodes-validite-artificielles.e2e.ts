/**
 * Carte Trello #812 (lot 116F) — PÉRIODES DE VALIDITÉ ARTIFICIELLES, PostgreSQL réel : routes réelles
 * (session simulée), qualification réelle des périodes (service 113W / 114R), contrôle de cohérence
 * réel (même orchestrateur que la tâche planifiée). AUCUN appel à un fournisseur d'IA : les sorties T1
 * sont simulées par des faits, des candidats et une analyse de référence persistés.
 *
 * Le défaut : un bon de commande du 17/11/2026, sans clause de validité, affichait « Début de
 * validité : 17/11/2026 » — T1 avait rendu un fait `period.validity` dont la seule borne était la date
 * de la commande, et la qualification le recopiait. Règle : une date du document n'est jamais, à elle
 * seule, une borne de validité (`business-periods/point-date`).
 *
 *   L116F-E2E-01 (critère 1)  bon de commande du 17/11/2026 : aucune ligne « Début de validité », aucun
 *                 fait VALIDITY, date du document intacte, faits T1 intacts, aucun élément d'agenda ;
 *                 toutes les formes de la sortie T1 (extrait absent, sans date, réduit à la date, mention
 *                 de la date du document, contrat v2 « validity=known ») ;
 *   L116F-E2E-02 (critères 2, 5) facture d'achat ponctuel, date d'émission = date du document : aucune
 *                 validité ; la garantie et la période facturée établies séparément restent ;
 *   L116F-E2E-03 (critère 3)  devis : validité explicite conservée (deux bornes, fin seule, durée
 *                 indéterminée) ; sans validité, ou réduite à la date du devis : rien d'inventé ;
 *   L116F-E2E-04 (critère 4)  contrat, attestation, garantie, facture périodique : début seul, fin seule,
 *                 dates partielles, plusieurs périodes, durée indéterminée — inchangés ;
 *   L116F-E2E-05 (critère 6)  correction de l'utilisateur : persistante après une nouvelle
 *                 qualification et après le contrôle de cohérence ; les autres périodes et les autres
 *                 documents ne sont pas touchés ;
 *   L116F-E2E-06 (critère 7)  stock : à blanc (rapport, aucune écriture), correctif (copies retirées et
 *                 tracées — y compris le début seul à « mention propre », règle remplacée par la recette
 *                 du 21/11 —, validité légitime et fin seule « à réexaminer » conservées), rejoué sans effet ;
 *   L116F-E2E-07 (critère 8)  consommateurs : liste, recherche, dossiers / exports, Assistant — aucune
 *                 ligne de validité pour le bon de commande, la validité du devis toujours rendue.
 *
 * Assertions bornées aux comptes créés ici.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { cand, cible, operationsKit, RECETTE_TODAY, type OperationsKit } from '../datasets/operations-v1';
import { proofOf, runCoherenceFor } from '../coherence-run';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    tryGetSession: async () => (session.userId ? { userId: session.userId, currentAccountId: session.currentAccountId } : null),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const CHECK = 'COH-DOC-BUSINESS-PERIODS';
type Json = Record<string, any>;
/** Fait T1 simulé : clé, valeur, extrait (absent : observation visuelle, sans citation), attribut. */
type Fait = { key: string; value: string; excerpt?: string; attribute?: string | null };

/** Bon de commande ponctuel (confirmation de commande) : opération d'achat datée du jour de la commande. */
const commande = (assetId: number, jour: string): AnchoredOperationCandidate => cand({
  typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRoleHint: 'ORDER', provider: 'Enseigne de sport',
  summary: 'Commande d’un accessoire', targetHints: [cible(assetId)], temporalHints: { realizedDate: jour }, financialHints: [],
});
const facture = (assetId: number, jour: string): AnchoredOperationCandidate => cand({
  typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', provider: 'Magasin',
  summary: 'Achat d’un équipement', targetHints: [cible(assetId)], temporalHints: { realizedDate: jour }, financialHints: [],
});
const devis = (assetId: number): AnchoredOperationCandidate => cand({
  typeHint: 'INTERVENTION', statusHint: 'ENVISAGED', sourceRoleHint: 'QUOTE', provider: 'Artisan',
  summary: 'Devis de travaux', targetHints: [cible(assetId)], temporalHints: {}, financialHints: [],
});
const piece = (assetId: number, role: string, type: string): AnchoredOperationCandidate => cand({
  typeHint: type as AnchoredOperationCandidate['typeHint'], statusHint: 'REALIZED', sourceRoleHint: role as AnchoredOperationCandidate['sourceRoleHint'],
  provider: 'Émetteur', summary: 'Pièce', targetHints: [cible(assetId)], temporalHints: {}, financialHints: [],
});

scenario('L116F', 'Documents — périodes de validité artificielles (#812)', ({ sql, make }) => {
  let k: OperationsKit;
  beforeAll(() => { k = operationsKit(sql, make); });
  afterAll(() => { session.currentAccountId = null; });

  const as = (c: AccountRow) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };
  const svc = () => import('@/services/documents/business-periods/service');
  const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
  const maison = (c: AccountRow) => make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });

  /** Faits génériques T1 persistés (`document_facts`) — aucun appel à un modèle. Rend leurs identifiants. */
  const faits = async (c: AccountRow, fileId: number, liste: Fait[]): Promise<number[]> => {
    const [x] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`;
    const ids: number[] = [];
    for (const f of liste) {
      // Sans extrait : observation VISUELLE (seule forme de fait sans citation que le schéma admet, contrainte 0161).
      const [r] = f.excerpt
        ? await sql<{ id: number }[]>`
        INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, raw_key, attribute, normalized_value, confidence, excerpt, status)
        VALUES (${c.id}, ${fileId}, ${x.id}, ${f.key}, ${f.key}, ${f.attribute ?? null}, ${f.value}, 'certain', ${f.excerpt}, 'active') RETURNING id::int AS id`
        : await sql<{ id: number }[]>`
        INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, raw_key, attribute, normalized_value, confidence, excerpt, status, evidence_origin, visual_evidence)
        VALUES (${c.id}, ${fileId}, ${x.id}, ${f.key}, ${f.key}, ${f.attribute ?? null}, ${f.value}, 'certain', NULL, 'active', 'VISUAL_ANALYSIS',
                ${JSON.stringify({ description: 'Capture d’écran d’une confirmation de commande' })}::jsonb) RETURNING id::int AS id`;
      ids.push(r.id);
    }
    return ids;
  };
  /** Analyse T1 de référence : date du document lue par T1, avec la mention qui la prouve. */
  const analyse = async (c: AccountRow, fileId: number, jour: string, extrait: string) => {
    const raw = { task: 'ANALYZE_DOCUMENT', document: { documentDate: { value: jour, confidence: 'certain', evidence: { excerpt: extrait } } } };
    await sql`INSERT INTO document_analysis_runs (asset_file_id, input_file_hash, prompt_version, provider, model, status, is_current_reference, account_id, raw_response_json)
              VALUES (${fileId}, ${`h${fileId}`}, 't1_master_v1@file', 'replay', 'm', 'completed', true, ${c.id}, ${JSON.stringify(raw)})`;
  };
  const rafraichir = async (c: AccountRow, fileId: number) => (await svc()).refreshDocumentBusinessPeriods(c.id, fileId);
  const actives = (fileId: number) => sql<Json[]>`
    SELECT id::int AS id, period_kind AS kind, start_on AS s, end_on AS e, end_open AS open, origin, user_locked AS locked
      FROM document_business_periods WHERE file_id = ${fileId} AND status = 'ACTIVE' ORDER BY period_kind, segment_index`;
  const lignes = async (c: AccountRow, id: number): Promise<{ principal: string | null; secondary: string[]; brut: Json }> => {
    as(c);
    const { GET } = await import('@/app/api/documents/[id]/periodes/route');
    const r = await GET(new NextRequest(`http://x/api/documents/${id}/periodes`), ctx(id));
    expect(r.status).toBe(200);
    const p = (await r.json() as { periods: Json }).periods;
    return { principal: p.principal?.line ?? null, secondary: p.secondary.map((x: Json) => x.line), brut: p };
  };
  /**
   * Période du STOCK, telle que la qualification d'avant la carte l'enregistrait pour un fait T1
   * (origine T1, base `T1_PERIOD_FACT`, preuve : extrait et identifiant du fait).
   */
  const stock = async (c: AccountRow, fileId: number, o: { kind?: string; start: string | null; end: string | null; factId: number; quote: string | null }) => {
    const [r] = await sql<{ id: number }[]>`
      INSERT INTO document_business_periods (account_id, file_id, period_kind, segment_index, start_on, end_on, principal_hint, origin, basis, evidence)
      VALUES (${c.id}, ${fileId}, ${o.kind ?? 'VALIDITY'}, 0, ${o.start}, ${o.end}, false, 'T1', 'T1_PERIOD_FACT',
              ${JSON.stringify({ quote: o.quote, page: null, factIds: [o.factId] })}::jsonb) RETURNING id::int AS id`;
    return r.id;
  };

  /** Bon de commande du 17/11/2026 : date du document, analyse de référence, fait de validité rendu par T1. */
  const bonDeCommande = async (c: AccountRow, assetId: number, validite: Fait | null, autres: Fait[] = []) => {
    const id = await k.document(c, assetId, [commande(assetId, '2026-11-17')], { title: 'Bon de commande', amountCents: 2499, date: '2026-11-17' });
    await analyse(c, id, '2026-11-17', 'Commande du 17/11/2026');
    const ids = await faits(c, id, [...(validite ? [validite] : []), ...autres]);
    return { id, factId: validite ? ids[0] : 0 };
  };

  it('L116F-E2E-01 — bon de commande du 17/11/2026 sans clause de validité : aucune ligne « Début de validité »', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    // Toutes les formes sous lesquelles T1 a pu rendre la date de la commande comme une validité.
    const formes: Array<[string, Fait, Fait[]]> = [
      ['mention de la date du document', { key: 'period.validity', value: '2026-11-17/', excerpt: 'Commande du 17/11/2026' }, []],
      ['extrait sans date', { key: 'period.validity', value: '2026-11-17/', excerpt: 'Votre commande est validée !' }, []],
      ['extrait réduit à la date', { key: 'period.validity', value: '2026-11-17/', excerpt: '17 novembre 2026' }, []],
      ['aucun extrait (observation visuelle)', { key: 'period.validity', value: '2026-11-17/' }, []],
      ['début = fin', { key: 'period.validity', value: '2026-11-17/2026-11-17', excerpt: 'Commande du 17/11/2026' }, []],
      ['mention d’un autre fait de date', { key: 'period.validity', value: '2026-11-17/', excerpt: 'Date de commande : 17/11/2026' },
        [{ key: 'order.date', value: '2026-11-17', excerpt: 'Date de commande : 17/11/2026' }]],
      ['contrat v2, validity=known', { key: 'period.validity', value: '2026-11-17/', excerpt: 'Commande du 17/11/2026', attribute: 'principal' },
        [{ key: 'period.relevance', value: 'validity=known;billing=not_relevant;coverage=not_relevant', excerpt: 'Confirmation de commande' }]],
      ['contrat v2, validity=undetermined', { key: 'period.validity', value: '2026-11-17/', excerpt: 'Valable à compter du 17/11/2026' },
        [{ key: 'period.relevance', value: 'validity=undetermined', excerpt: 'Confirmation de commande' }]],
    ];
    for (const [nom, validite, autres] of formes) {
      const { id } = await bonDeCommande(c, m.id, validite, autres);
      const r = await rafraichir(c, id);
      expect(r.inserted, nom).toBe(0);
      expect(await actives(id), nom).toEqual([]);
      const vue = await lignes(c, id);
      expect(vue.principal, nom).toBeNull();
      expect(vue.secondary, nom).toEqual([]);
      // Dates ponctuelles conservées, faits T1 intacts (rien n'est supprimé de la connaissance T1).
      const [f] = await sql<Json[]>`SELECT document_date::text AS d FROM asset_files WHERE id = ${id}`;
      expect(f.d, nom).toBe('2026-11-17');
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_facts WHERE file_id = ${id} AND status = 'active'`;
      expect(n, nom).toBe(1 + autres.length);
    }
    // Aucune échéance ni élément d'agenda créé sur cette base.
    const [{ n: agenda }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${c.id}`;
    expect(agenda).toBe(0);
  });

  it('L116F-E2E-02 — facture d’achat ponctuel, date d’émission = date du document : aucune validité, garantie et facturation conservées', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const id = await k.document(c, m.id, [facture(m.id, '2026-11-14')], { type: 'INVOICE', title: 'Facture', amountCents: 46999, date: '2026-11-14' });
    await analyse(c, id, '2026-11-14', 'Facture émise le 14/11/2026');
    await faits(c, id, [
      { key: 'period.validity', value: '2026-11-14/', excerpt: 'Facture émise le 14/11/2026' },
      { key: 'invoice.issueDate', value: '2026-11-14', excerpt: 'Date d’émission : 14/11/2026' },
      { key: 'period.warranty', value: '2026-11-14/2028-11-14', excerpt: 'Garantie 2 ans, du 14/11/2026 au 14/11/2028', attribute: 'principal' },
      { key: 'period.billing', value: '2026-11-01/2026-11-30', excerpt: 'Période du 01/11/2026 au 30/11/2026' },
    ]);
    expect(await rafraichir(c, id)).toMatchObject({ outcome: 'UPDATED', inserted: 2 });
    expect((await actives(id)).map((x) => [x.kind, x.s, x.e])).toEqual([['BILLING', '2026-11-01', '2026-11-30'], ['WARRANTY', '2026-11-14', '2028-11-14']]);
    const vue = await lignes(c, id);
    expect(vue.principal).toBe('Période de garantie : du 14/11/2026 au 14/11/2028');
    expect(vue.secondary).toEqual(['Période facturée : du 01/11/2026 au 30/11/2026']);
    // Les faits distincts utiles restent : date d'émission (fait T1) et date du document.
    const [f] = await sql<Json[]>`SELECT document_date::text AS d FROM asset_files WHERE id = ${id}`;
    expect(f.d).toBe('2026-11-14');
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_facts WHERE file_id = ${id} AND status = 'active' AND raw_key = 'invoice.issueDate'`;
    expect(n).toBe(1);

    // Facture d'achat ponctuel sans aucune période (R03) : rien.
    const nue = await k.document(c, m.id, [facture(m.id, '2026-11-15')], { type: 'INVOICE', title: 'Facture', date: '2026-11-15' });
    await analyse(c, nue, '2026-11-15', 'Le 15/11/2026');
    await faits(c, nue, [{ key: 'period.validity', value: '/2026-11-15', excerpt: 'Le 15/11/2026' }]);
    await rafraichir(c, nue);
    expect(await actives(nue)).toEqual([]);
    expect((await lignes(c, nue)).principal).toBeNull();
  });

  it('L116F-E2E-03 — devis : validité explicite conservée ; sans validité ou réduite à la date du devis, rien d’inventé', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const creer = async (liste: Fait[]) => {
      const id = await k.document(c, m.id, [devis(m.id)], { type: 'WORKS_QUOTE', title: 'Devis', date: '2026-11-03' });
      await analyse(c, id, '2026-11-03', 'Devis du 03/11/2026');
      await faits(c, id, liste);
      await rafraichir(c, id);
      return id;
    };
    // Deux bornes : la date du devis est le début, la fin est écrite — validité réelle.
    const complet = await creer([{ key: 'period.validity', value: '2026-11-03/2026-12-03', excerpt: 'Devis valable 30 jours, du 03/11/2026 au 03/12/2026' }]);
    expect((await lignes(c, complet)).principal).toBe('Période de validité : du 03/11/2026 au 03/12/2026');
    // Fin seule (borne partielle prouvée) : seulement cette borne.
    const finSeule = await creer([{ key: 'period.validity', value: '/2026-12-03', excerpt: 'Offre valable jusqu’au 03/12/2026' }]);
    expect((await lignes(c, finSeule)).principal).toBe('Fin de validité : 03/12/2026');
    // Durée indéterminée établie à compter de la date du devis : conservée.
    const ouverte = await creer([{ key: 'period.validity', value: '2026-11-03/INDEFINITE', excerpt: 'Valable à compter du 03/11/2026, sans limitation de durée' }]);
    expect((await lignes(c, ouverte)).principal).toBe('Début de validité : 03/11/2026 (durée indéterminée)');
    // Pertinente mais non datée (contrat v2) : « non renseignée », règle existante.
    const inconnue = await creer([{ key: 'period.relevance', value: 'validity=unknown', excerpt: 'Devis' }]);
    expect((await lignes(c, inconnue)).principal).toBe('Période de validité : non renseignée');
    // Sans validité : rien.
    const sans = await creer([]);
    expect((await lignes(c, sans)).principal).toBeNull();
    // Validité réduite à la date du devis : rien d'inventé (ni borne, ni « non renseignée »).
    const copie = await creer([{ key: 'period.validity', value: '2026-11-03/', excerpt: 'Devis du 03/11/2026' }]);
    expect(await actives(copie)).toEqual([]);
    // Mention propre au jour du devis (« valable à compter du… », sans fin) : pertinence indéterminée, non créée.
    const propre = await creer([{ key: 'period.validity', value: '2026-11-03/', excerpt: 'Offre valable à compter du 03/11/2026' }]);
    expect(await actives(propre)).toEqual([]);
    expect((await lignes(c, propre)).principal).toBeNull();
  });

  it('L116F-E2E-04 — contrat, attestation, garantie, facture périodique : début seul, fin seule, dates partielles, plusieurs périodes, durée indéterminée', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const creer = async (cd: AnchoredOperationCandidate, jour: string, liste: Fait[]) => {
      const id = await k.document(c, m.id, [cd], { title: 'Pièce', date: jour });
      await analyse(c, id, jour, `Le ${jour.slice(8)}/${jour.slice(5, 7)}/${jour.slice(0, 4)}`);
      await faits(c, id, liste);
      await rafraichir(c, id);
      return id;
    };
    // Contrat : effet contractuel le jour du document, durée indéterminée (nature non gardée, début = date du document).
    const contrat = await creer(piece(m.id, 'CONTRACT_DOCUMENT', 'CONTRACT'), '2026-01-01', [
      { key: 'period.contract', value: '2026-01-01/INDEFINITE', excerpt: 'Contrat à effet du 01/01/2026, durée indéterminée', attribute: 'principal' }]);
    expect((await lignes(c, contrat)).principal).toBe('Date d’effet du contrat : 01/01/2026 (durée indéterminée)');
    // Attestation : début de couverture seul, le jour même de l'attestation — conservé (la couverture n'est pas une validité).
    const attestation = await creer(piece(m.id, 'CONTRACT_DOCUMENT', 'CONTRACT'), '2026-04-01', [
      { key: 'period.coverage', value: '2026-04-01/', excerpt: 'Garanties acquises à compter du 01/04/2026', attribute: 'principal' }]);
    expect((await lignes(c, attestation)).principal).toBe('Début de couverture : 01/04/2026');
    // Garantie : fin seule, date partielle (année).
    const garantie = await creer(piece(m.id, 'INVOICE', 'ACQUISITION'), '2026-05-10', [
      { key: 'period.warranty', value: '/2028', excerpt: 'Garantie jusqu’en 2028' }]);
    expect((await lignes(c, garantie)).principal).toBe('Fin de garantie : 2028');
    // Facture périodique : deux périodes facturées (mois partiels) — « Plusieurs périodes concernées ».
    const periodique = await creer(piece(m.id, 'INVOICE', 'CONTRACT'), '2026-03-05', [
      { key: 'period.billing', value: '2026-01', excerpt: 'Janvier 2026' }, { key: 'period.billing', value: '2026-02', excerpt: 'Février 2026' }]);
    const vp = await lignes(c, periodique);
    expect(vp.principal).toBe('Plusieurs périodes concernées');
    expect(vp.brut.principal.segments.map((s: Json) => s.line)).toEqual(['Période facturée : janvier 2026', 'Période facturée : février 2026']);
    // Validité : plusieurs périodes, dont une qui commence le jour du document mais porte une fin ; mois et année partiels.
    const certificat = await creer(piece(m.id, 'REPORT', 'OTHER'), '2026-06-01', [
      { key: 'period.validity', value: '2026-06-01/2027-05-31', excerpt: 'Valable du 01/06/2026 au 31/05/2027' },
      { key: 'period.validity', value: '2028', excerpt: 'Puis pour l’année 2028' },
      { key: 'period.validity', value: '2026-06', excerpt: 'Juin 2026' }]);
    expect((await actives(certificat)).map((x) => [x.kind, x.s, x.e])).toEqual([
      ['VALIDITY', '2026-06', '2026-06'], ['VALIDITY', '2026-06-01', '2027-05-31'], ['VALIDITY', '2028', '2028']]);
    // Validité à début seul qui n'est PAS une date du document : borne partielle prouvée, conservée.
    const debutSeul = await creer(piece(m.id, 'REPORT', 'OTHER'), '2026-06-01', [
      { key: 'period.validity', value: '2026-07-01/', excerpt: 'Valable à compter du 01/07/2026' }]);
    expect((await lignes(c, debutSeul)).principal).toBe('Début de validité : 01/07/2026');
  });

  it('L116F-E2E-05 — correction de l’utilisateur : persistante après requalification et contrôle de cohérence, autres périodes et documents intacts', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    // Stock : deux bons de commande portant la fausse validité, enregistrée avant la carte.
    const a = await bonDeCommande(c, m.id, { key: 'period.validity', value: '2026-11-17/', excerpt: 'Commande du 17/11/2026' },
      [{ key: 'period.warranty', value: '2026-11-17/2028-11-17', excerpt: 'Garantie 2 ans jusqu’au 17/11/2028' }]);
    const b = await bonDeCommande(c, m.id, { key: 'period.validity', value: '2026-11-17/', excerpt: 'Commande du 17/11/2026' });
    const pa = await stock(c, a.id, { start: '2026-11-17', end: null, factId: a.factId, quote: 'Commande du 17/11/2026' });
    await stock(c, b.id, { start: '2026-11-17', end: null, factId: b.factId, quote: 'Commande du 17/11/2026' });

    // L'utilisateur établit lui-même la validité du premier (parcours « Modifier », route du même fait).
    as(c);
    const { PUT } = await import('@/app/api/documents/[id]/periodes/route');
    const r = await PUT(new NextRequest(`http://x/api/documents/${a.id}/periodes`, { method: 'PUT', body: JSON.stringify({ periodId: pa, start: '2026-11-17', end: null, openEnded: false }) }), ctx(a.id));
    expect(r.status).toBe(200);

    // Nouvelle qualification (après T1 / T3) puis contrôle de cohérence correctif, deux fois.
    await rafraichir(c, a.id);
    await rafraichir(c, b.id);
    await runCoherenceFor(sql, [c.id], { mode: 'CORRECTIVE', today: RECETTE_TODAY });
    await runCoherenceFor(sql, [c.id], { mode: 'CORRECTIVE', today: RECETTE_TODAY });

    // La décision de l'utilisateur est intacte ; la garantie du même document aussi (créée par la qualification).
    expect((await actives(a.id)).map((x) => [x.kind, x.s, x.e, x.origin, x.locked])).toEqual([
      ['VALIDITY', '2026-11-17', null, 'USER', true], ['WARRANTY', '2026-11-17', '2028-11-17', 'T1', false]]);
    expect((await lignes(c, a.id)).principal).toBe('Début de validité : 17/11/2026');
    // L'autre document, non corrigé, n'a plus la fausse validité.
    expect(await actives(b.id)).toEqual([]);
  });

  // Règle remplacée (carte #812, recette du 21/11) : le document B (début seul le jour du document, « mention propre »)
  // était CONSERVÉ « à réexaminer » et sa ligne restait affichée ; il est désormais RETIRÉ avec le motif précis
  // `DOCUMENT_DATE_RESTATED`. Le cas « à réexaminer » est porté par D (fin seule le jour du document, non tranché).
  it('L116F-E2E-06 — stock : à blanc sans écriture, correctif ciblé et tracé, validités légitimes et cas à réexaminer conservés, rejouable', async () => {
    const c = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const m = await maison(c);
    // A : copie PROUVÉE (la mention est celle de la date du document).
    const a = await bonDeCommande(c, m.id, { key: 'period.validity', value: '2026-11-17/', excerpt: 'Commande du 17/11/2026' });
    const pa = await stock(c, a.id, { start: '2026-11-17', end: null, factId: a.factId, quote: 'Commande du 17/11/2026' });
    // B : même jour, mention PROPRE (« valable à compter du… ») — règle remplacée : retiré (la mention ne fait que redire la date).
    const b = await bonDeCommande(c, m.id, { key: 'period.validity', value: '2026-11-17/', excerpt: 'Offre valable à compter du 17/11/2026' });
    const pb = await stock(c, b.id, { start: '2026-11-17', end: null, factId: b.factId, quote: 'Offre valable à compter du 17/11/2026' });
    // C : validité légitime (fin écrite).
    const cc = await bonDeCommande(c, m.id, { key: 'period.validity', value: '2026-11-17/2026-12-17', excerpt: 'Valable du 17/11/2026 au 17/12/2026' });
    const pc = await stock(c, cc.id, { start: '2026-11-17', end: '2026-12-17', factId: cc.factId, quote: 'Valable du 17/11/2026 au 17/12/2026' });
    // D : FIN SEULE le jour du document, mention propre — non tranché par le PO : conservé « à réexaminer ».
    const d = await bonDeCommande(c, m.id, { key: 'period.validity', value: '/2026-11-17', excerpt: 'Offre valable jusqu’au 17/11/2026' });
    const pdd = await stock(c, d.id, { start: null, end: '2026-11-17', factId: d.factId, quote: 'Offre valable jusqu’au 17/11/2026' });
    // Autre compte : même défaut, hors du périmètre de la campagne — jamais touché (isolation).
    const m2 = await maison(autre);
    const z = await bonDeCommande(autre, m2.id, { key: 'period.validity', value: '2026-11-17/', excerpt: 'Commande du 17/11/2026' });
    const pz = await stock(autre, z.id, { start: '2026-11-17', end: null, factId: z.factId, quote: 'Commande du 17/11/2026' });

    const etat = async () => (await sql<Json[]>`
      SELECT id::int AS id, status, superseded_reason AS reason FROM document_business_periods WHERE id = ANY(${[pa, pb, pc, pz]}::bigint[]) ORDER BY id`);
    const etatD = async () => (await sql<Json[]>`SELECT status, superseded_reason AS reason FROM document_business_periods WHERE id = ${pdd}`)[0];
    const avant = await etat();

    // À BLANC : rapport, aucune écriture.
    const blanc = await runCoherenceFor(sql, [c.id], { mode: 'DRY_RUN', today: RECETTE_TODAY });
    expect(blanc.results[CHECK]).toMatchObject({ WOULD_REPAIR: 2, AMBIGUOUS: 1, CONSISTENT: 1 });
    expect(await etat()).toEqual(avant);
    expect(await etatD()).toEqual({ status: 'ACTIVE', reason: null });
    const constatA = await proofOf(sql, c.id, CHECK, a.id);
    expect(constatA?.finding).toMatchObject({ anomaly: 'BUSINESS_PERIODS_POINT_DATE_COPY' });
    expect(JSON.stringify(constatA?.finding)).toContain('SAME_MENTION_AS_POINT_DATE');
    const constatB = await proofOf(sql, c.id, CHECK, b.id);
    expect(constatB?.finding).toMatchObject({ anomaly: 'BUSINESS_PERIODS_POINT_DATE_COPY' });
    expect(JSON.stringify(constatB?.finding)).toContain('DOCUMENT_DATE_RESTATED');
    const constatD = await proofOf(sql, c.id, CHECK, d.id);
    expect(constatD?.finding).toMatchObject({ anomaly: 'BUSINESS_PERIODS_POINT_DATE_TO_REVIEW' });

    // CORRECTIF : les copies sont retirées (conservées en base, SUPERSEDED, motif tracé) ; C et D restent.
    const correctif = await runCoherenceFor(sql, [c.id], { mode: 'CORRECTIVE', today: RECETTE_TODAY });
    expect(correctif.results[CHECK]).toMatchObject({ REPAIRED: 2, AMBIGUOUS: 1, CONSISTENT: 1 });
    expect(await etatD()).toEqual({ status: 'ACTIVE', reason: null });
    expect((await lignes(c, d.id)).principal).toBe('Fin de validité : 17/11/2026');
    const details = await sql<Json[]>`SELECT id::int AS id, superseded_detail AS detail FROM document_business_periods WHERE id = ANY(${[pa, pb]}::bigint[]) ORDER BY id`;
    expect(details).toEqual([{ id: pa, detail: 'SAME_MENTION_AS_POINT_DATE' }, { id: pb, detail: 'DOCUMENT_DATE_RESTATED' }]);
    expect(await etat()).toEqual([
      { id: pa, status: 'SUPERSEDED', reason: 'POINT_DATE_COPY' },
      { id: pb, status: 'SUPERSEDED', reason: 'POINT_DATE_COPY' },
      { id: pc, status: 'ACTIVE', reason: null },
      { id: pz, status: 'ACTIVE', reason: null },
    ]);
    expect((await lignes(c, a.id)).principal).toBeNull();
    expect((await lignes(c, b.id)).principal).toBeNull();
    expect((await lignes(c, cc.id)).principal).toBe('Période de validité : du 17/11/2026 au 17/12/2026');
    // Aucun appel d'IA par la reprise.
    const [{ n: ia }] = await sql<{ n: number }[]>`SELECT COALESCE(sum(ai_calls), 0)::int AS n FROM coherence_repairs WHERE account_id = ${c.id} AND check_id = ${CHECK}`;
    expect(ia).toBe(0);

    // REJOUÉ : plus rien à faire, même état.
    const apres = await etat();
    const rejeu = await runCoherenceFor(sql, [c.id], { mode: 'CORRECTIVE', today: RECETTE_TODAY });
    expect(rejeu.results[CHECK]).toMatchObject({ AMBIGUOUS: 1, CONSISTENT: 3 });
    expect(rejeu.results[CHECK].REPAIRED).toBeUndefined();
    expect(await etat()).toEqual(apres);

    // Après une NOUVELLE analyse de B (faits remplacés), la validité n'est pas recréée.
    await sql`UPDATE document_facts SET status = 'superseded' WHERE id = ${b.factId}`;
    await faits(c, b.id, [{ key: 'period.validity', value: '2026-11-17/', excerpt: 'Offre valable à compter du 17/11/2026' }]);
    await rafraichir(c, b.id);
    expect(await actives(b.id)).toEqual([]);
  });

  it('L116F-E2E-07 — consommateurs : liste, dossiers / exports, Assistant — aucune validité pour le bon de commande, celle du devis rendue', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const bc = await bonDeCommande(c, m.id, { key: 'period.validity', value: '2026-11-17/', excerpt: 'Commande du 17/11/2026' });
    await rafraichir(c, bc.id);
    const dv = await k.document(c, m.id, [devis(m.id)], { type: 'WORKS_QUOTE', title: 'Devis', date: '2026-11-03' });
    await analyse(c, dv, '2026-11-03', 'Devis du 03/11/2026');
    await faits(c, dv, [{ key: 'period.validity', value: '2026-11-03/2026-12-03', excerpt: 'Valable du 03/11/2026 au 03/12/2026' }]);
    await rafraichir(c, dv);

    const ids = [bc.id, dv];
    const { readPrincipalPeriodLines } = await svc();
    const liste = await readPrincipalPeriodLines(c.id, ids);
    expect(liste.has(bc.id)).toBe(false);
    expect(liste.get(dv)).toMatchObject({ kind: 'VALIDITY', line: 'Période de validité : du 03/11/2026 au 03/12/2026' });

    const surfaces = await import('@/services/documents/business-period-surfaces');
    const dossier = await surfaces.dossierPeriodLines(c.id, ids);
    expect(dossier.has(bc.id)).toBe(false);
    expect(dossier.get(dv)).toContain('03/12/2026');
    const assistant = await surfaces.documentPeriodTexts(c.id, ids);
    expect(assistant.has(bc.id)).toBe(false);
    expect(assistant.get(dv)).toContain('03/12/2026');
    const resumes = await surfaces.readDocumentPeriodSummaries(c.id, ids);
    expect(resumes.has(bc.id)).toBe(false);
    expect(resumes.has(dv)).toBe(true);
  });
});
