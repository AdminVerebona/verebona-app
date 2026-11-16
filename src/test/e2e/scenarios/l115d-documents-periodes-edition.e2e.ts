/**
 * Carte Trello #782 (lot 115D) — ÉDITION UNIFIÉE DES PÉRIODES D'UN DOCUMENT, PostgreSQL réel :
 * routes réelles (session simulée), qualification des périodes réelle (service 113W / 114R), AUCUN
 * appel à un fournisseur d'IA (sorties T1 simulées par des faits persistés).
 *
 * Ce que la carte change, et donc ce qui est prouvé ici : l'action « Corriger » de la ligne disparaît
 * du tiroir ; les périodes s'éditent dans le parcours général « Modifier », qui enchaîne
 * `PUT /api/documents/:id` (champs du document) puis `PUT /api/documents/:id/periodes` pour les
 * périodes RÉELLEMENT modifiées. Les deux écritures restent séparées et gardent leurs contrôles.
 *
 *   L115D-E2E-01  facture d'achat avec garantie : enregistrer le document SANS toucher aux périodes
 *                 n'écrit aucune période (aucun verrou utilisateur, aucun état antérieur, notes
 *                 intactes) ; les deux périodes restent lisibles pour le formulaire ;
 *   L115D-E2E-02  édition de PLUSIEURS périodes dans le même enregistrement : chacune est écrite par
 *                 la route du même fait, l'autre nature n'est pas touchée, une nouvelle analyse T1 ne
 *                 remplace pas la décision de l'utilisateur ; lecture seule 403, autre compte 404.
 *
 * Assertions bornées aux comptes créés ici.
 */
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import { cand, cible, operationsKit, type OperationsKit } from '../datasets/operations-v1';

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

type Json = Record<string, any>;
type Fait = [string, string, (string | null)?];

/** Facture d'achat ponctuel (aucune date dans le candidat : les périodes viennent des faits T1). */
const achat = (assetId: number): AnchoredOperationCandidate => cand({
  typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE', provider: 'Conforama France SA',
  summary: 'Table de cuisson', targetHints: [cible(assetId)], temporalHints: {}, financialHints: [],
});

scenario('L115D', 'Documents — édition unifiée des périodes dans « Modifier » (#782)', ({ sql, make }) => {
  let k: OperationsKit;
  beforeAll(() => { k = operationsKit(sql, make); });
  afterAll(() => { session.currentAccountId = null; });

  const as = (c: AccountRow) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };
  const svc = () => import('@/services/documents/business-periods/service');
  const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
  const cuisine = (c: AccountRow) => make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });

  /** Faits génériques T1 persistés (`document_facts`) — aucun appel à un modèle. */
  const faits = async (c: AccountRow, fileId: number, liste: Fait[]) => {
    const [x] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`;
    for (const [key, value, attribute] of liste) {
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, raw_key, attribute, normalized_value, confidence, excerpt, status)
                VALUES (${c.id}, ${fileId}, ${x.id}, ${key}, ${key}, ${attribute ?? null}, ${value}, 'certain', ${`extrait ${value}`}, 'active')`;
    }
  };
  const rafraichir = async (c: AccountRow, fileId: number) => (await svc()).refreshDocumentBusinessPeriods(c.id, fileId);
  const actives = (fileId: number) => sql<Json[]>`
    SELECT id::int AS id, period_kind AS kind, start_on AS s, end_on AS e, end_open AS open, origin,
           user_locked AS locked, before_correction AS before, corrected_by_user_id::int AS by
      FROM document_business_periods WHERE file_id = ${fileId} AND status = 'ACTIVE' ORDER BY period_kind`;

  /** Lecture du tiroir : ce que le formulaire « Modifier » propose (principale + autres natures). */
  const lireDoc = async (c: AccountRow, id: number): Promise<Json> => {
    as(c);
    const { GET } = await import('@/app/api/documents/[id]/periodes/route');
    const r = await GET(new NextRequest(`http://x/api/documents/${id}/periodes`), ctx(id));
    expect(r.status).toBe(200);
    return (await r.json() as { periods: Json }).periods;
  };
  /** Premier temps du parcours « Modifier » : champs du document (mêmes champs que `handleSave`). */
  const enregistrerDocument = async (c: AccountRow, id: number, extra: Json = {}) => {
    as(c);
    const [f] = await sql<Json[]>`SELECT retained_title, document_date::text AS d, supplier, amount_cents FROM asset_files WHERE id = ${id}`;
    const { PUT } = await import('@/app/api/documents/[id]/route');
    const body = {
      fileName: f.retained_title, retainedTitle: f.retained_title, documentDate: f.d ?? null,
      supplier: f.supplier ?? null, amountCents: f.amount_cents ?? null, userEditedFields: {}, ...extra,
    };
    const r = await PUT(new NextRequest(`http://x/api/documents/${id}`, { method: 'PUT', body: JSON.stringify(body) }), ctx(id));
    return { status: r.status, body: await r.json() as Json };
  };
  /** Second temps : une période modifiée (le formulaire en envoie une par période touchée). */
  const enregistrerPeriode = async (c: AccountRow, fileId: number, body: Json) => {
    as(c);
    const { PUT } = await import('@/app/api/documents/[id]/periodes/route');
    const r = await PUT(new NextRequest(`http://x/api/documents/${fileId}/periodes`, { method: 'PUT', body: JSON.stringify(body) }), ctx(fileId));
    return { status: r.status, body: await r.json().catch(() => ({})) as Json };
  };

  /** Facture d'achat avec garantie (principale) et période facturée (secondaire). */
  const factureGarantie = async (c: AccountRow) => {
    const m = await cuisine(c);
    const id = await k.document(c, m.id, [achat(m.id)], { type: 'INVOICE', title: 'Facture Conforama', amountCents: 46999, date: '2026-11-14' });
    await faits(c, id, [
      ['period.warranty', '2026-11-14/2028-11-14', 'principal'],
      ['period.billing', '2026-11-01/2026-11-30'],
    ]);
    await sql`UPDATE asset_files SET upload_status = 'COMPLETED', notes = 'Note de l’utilisateur', description = 'Description T1' WHERE id = ${id}`;
    expect(await rafraichir(c, id)).toMatchObject({ outcome: 'UPDATED', inserted: 2 });
    return { m, id };
  };

  it('L115D-E2E-01 — enregistrer le document sans toucher aux périodes : aucune période écrite, notes intactes', async () => {
    const c = await make.account({ plan: 'premium' });
    const { id } = await factureGarantie(c);

    // Le formulaire « Modifier » propose les DEUX périodes du document : garantie (principale) et facturation.
    const vue = await lireDoc(c, id);
    expect(vue.principal).toMatchObject({ kind: 'WARRANTY', line: 'Période de garantie : du 14/11/2026 au 14/11/2028' });
    expect(vue.principal.segments).toHaveLength(1);
    expect(vue.secondary.map((x: Json) => x.line)).toEqual(['Période facturée : du 01/11/2026 au 30/11/2026']);

    const avant = await actives(id);
    expect(avant.map((x) => [x.kind, x.origin, x.locked])).toEqual([['BILLING', 'T1', false], ['WARRANTY', 'T1', false]]);

    // Enregistrement du document (titre, date, fournisseur, montant) : les périodes ne sont PAS écrites.
    const r = await enregistrerDocument(c, id, { fileName: 'Facture Conforama — Table de cuisson', retainedTitle: 'Facture Conforama — Table de cuisson', supplier: 'Conforama France SA' });
    expect(r.status).toBe(200);
    expect(await actives(id)).toEqual(avant);
    // Aucune période n'est devenue « corrigée par vous » (donc aucune n'est protégée à tort de T1).
    expect((await actives(id)).every((x) => x.locked === false && x.before === null && x.by === null)).toBe(true);
    // Lot 113Z : notes de l'utilisateur et description T1 intactes (le parcours n'y touche pas).
    const [ligne] = await sql<Json[]>`SELECT notes, description, retained_title FROM asset_files WHERE id = ${id}`;
    expect(ligne).toMatchObject({ notes: 'Note de l’utilisateur', description: 'Description T1', retained_title: 'Facture Conforama — Table de cuisson' });
    // Aucun fait supprimé ni remplacé par l'enregistrement.
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM document_business_periods WHERE file_id = ${id} AND status <> 'ACTIVE'`;
    expect(n).toBe(0);
  });

  it('L115D-E2E-02 — plusieurs périodes éditées dans le parcours : chacune par la route du même fait, les autres intactes', async () => {
    const c = await make.account({ plan: 'premium' });
    const { id } = await factureGarantie(c);
    const vue = await lireDoc(c, id);
    const garantie = vue.principal.segments[0].id as number;
    const facturation = vue.secondary[0].id as number;

    // Le formulaire envoie UNE requête par période touchée. Ici les deux sont modifiées.
    expect((await enregistrerPeriode(c, id, { periodId: garantie, start: '2026-11-14', end: '2029-11-14', openEnded: false })).status).toBe(200);
    expect((await enregistrerPeriode(c, id, { periodId: facturation, start: '2026-11', end: null, openEnded: false })).status).toBe(200);

    const apres = await lireDoc(c, id);
    expect(apres.principal.segments[0]).toMatchObject({ line: 'Période de garantie : du 14/11/2026 au 14/11/2029', userCorrected: true });
    // Dates partielles conservées telles quelles (aucune borne inventée) et fin INCONNUE (pas de durée indéterminée).
    expect(apres.secondary[0]).toMatchObject({ line: 'Début de la période facturée : novembre 2026', userCorrected: true });
    expect(apres.secondary[0].openEnded).toBeUndefined();
    // Auteur et état antérieur tracés pour chacune ; les faits d'origine conservés (SUPERSEDED).
    const lignes = await actives(id);
    expect(lignes.map((x) => [x.kind, x.origin, x.locked, x.by])).toEqual([['BILLING', 'USER', true, c.ownerUserId], ['WARRANTY', 'USER', true, c.ownerUserId]]);
    expect(lignes.find((x) => x.kind === 'WARRANTY')!.before).toMatchObject({ start: '2026-11-14', end: '2028-11-14' });

    // Une seule période modifiée laisse l'autre intacte : nouvelle facture, une seule écriture.
    const b = await factureGarantie(c);
    const vb = await lireDoc(c, b.id);
    expect((await enregistrerPeriode(c, b.id, { periodId: vb.principal.segments[0].id, start: '2026-11-14', end: null, openEnded: true })).status).toBe(200);
    const apresB = await actives(b.id);
    expect(apresB.find((x) => x.kind === 'BILLING')).toMatchObject({ origin: 'T1', locked: false, before: null, by: null });
    expect(apresB.find((x) => x.kind === 'WARRANTY')).toMatchObject({ origin: 'USER', locked: true, open: true, e: null });
    expect((await lireDoc(c, b.id)).principal.line).toBe('Début de garantie : 14/11/2026 (durée indéterminée)');

    // Nouvelle analyse T1 : la garantie décidée par l'utilisateur n'est pas remplacée.
    await faits(c, b.id, [['period.warranty', '2026-11-14/2030-11-14', 'principal']]);
    expect(await rafraichir(c, b.id)).toMatchObject({ protectedKinds: ['WARRANTY'] });
    expect((await lireDoc(c, b.id)).principal.line).toBe('Début de garantie : 14/11/2026 (durée indéterminée)');

    // Lecture seule : l'enregistrement d'une période est refusé (403) et rien n'est écrit.
    const lecture = await make.account({ plan: null });
    const l = await factureGarantie(lecture);
    const vl = await lireDoc(lecture, l.id);
    expect((await enregistrerPeriode(lecture, l.id, { periodId: vl.principal.segments[0].id, start: '2026-01-01', end: null, openEnded: false })).status).toBe(403);
    expect((await lireDoc(lecture, l.id)).principal.segments[0]).toMatchObject({ id: vl.principal.segments[0].id, userCorrected: false });

    // Un autre compte en écriture n'atteint pas la période de ce compte : introuvable, rien d'écrit.
    const autre = await make.account({ plan: 'premium' });
    expect((await enregistrerPeriode(autre, b.id, { periodId: vb.principal.segments[0].id, start: null, end: null, openEnded: false })).status).toBe(404);
    expect((await lireDoc(c, b.id)).principal.line).toBe('Début de garantie : 14/11/2026 (durée indéterminée)');
  });
});
