/**
 * Lot 114O (Trello #744, CDC « Opérations / Agenda V2.0 ») — point F de la
 * carte « Dates, finances et protections » et exports (CDC §9, §11, §18 ;
 * AC32, AC33, AC35, AC49 à AC51) — sur PostgreSQL 16 réel, par les chemins de
 * PRODUCTION : dépôt et façade d'écriture des événements de référence,
 * persistance T1 et consolidation T3 réelles, service du coût de possession
 * (`readAssetTco`), vraies routes `GET /api/assets/:id/overview`,
 * `GET /api/evenements-reference/:id/fiche` et `GET /api/search` (seule la session
 * est simulée). Aucune IA. Dates fixes : aucun test ne dépend du jour.
 *
 *   L114OF-E01  AC32 : intervention — premier devis (le plus ancien) faute de réalisation ; un devis ultérieur et une
 *               visite ne déplacent pas le repère ; réalisation attestée → repère ; date contestée → non fiable ;
 *               Timeline, page et recherche rendent la MÊME date ; les événements gardent leur date ; rien n'est écrit
 *   L114OF-E02  AC33, AC35 : contrat — début initial, sinon première couverture connue (repère, jamais écrite comme
 *               prise d'effet) ; période incomplète ou jour inexistant ignorés ; sans fait daté : « Sans date » partout ;
 *               isolation des comptes ; la lecture SQL (Timeline) et la règle pure donnent le même résultat
 *   L114OF-E03  AC49 à AC51, AC53, AC68 : financement ↔ achat(s) — la relation est lue dans les deux sens et n'ajoute
 *               ni coût ni capital ; coût de possession identique poste par poste et ligne par ligne avant / après,
 *               sur CHAQUE bien financé (multi-acquisition), et après une nouvelle consolidation T3 ; échéance
 *               multi-biens sans ventilation prouvée : non allouée, jamais comptée en entier sur chaque bien
 *   L114OF-E04  AC24, AC52, AC53 : sinistre ↔ réparation — un justificatif partagé entre deux événements de
 *               référence et un événement de l'Agenda partagé n'ajoutent aucun coût ; la réparation et l'indemnité
 *               ne sont comptées qu'une fois ; coût de possession identique avant / après chaque partage
 *   L114OF-E05  AC24, AC43, AC69 : la source du dossier « Assurance — sinistre » lit la chronologie dans le GRAPHE
 *               (élément relié par un lien actif seul, élément porté par les deux supports, élément partagé avec un
 *               autre événement de référence) — jamais deux fois le même, chacun à SA date ; documents dédoublonnés ;
 *               isolation des comptes ; aucun coût ajouté par les partages
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    requireAdmin: async () => session.userId,
    tryGetSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
/** Catégorie de résultat de la recherche générale (travaux D) : « Événement de référence ». */
const CATEGORIE = 'Opération';
const facade = () => import('@/services/business-operations/operation-write.facade');

scenario('L114OF', 'Opérations / Agenda CDC V2.0 — point F : date de présentation, coût de possession sans double compte, exports', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };
  const G = (op: number) => `op-${op}`;

  /** Événement de référence créé par le dépôt (chemin d'écriture de production), relié à des biens. */
  async function operation(compte: AccountRow, type: string | null, over: { realized?: string; start?: string; planned?: string; label?: string; assetIds?: number[] } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: (type ? { code: type } : null) as never, status: over.realized ? 'REALIZED' : 'ENVISAGED',
      realizedDate: over.realized ?? null, startDate: over.start ?? null, plannedDate: over.planned ?? null, technicalLabel: over.label ?? null,
      source: { kind: 'MIGRATION', entityKey: `l114of-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' },
      assets: (over.assetIds ?? []).map((assetId) => ({ assetId, authority: 'USER' as const })),
      reasonCode: 'L114OF_E2E',
    })).id);
  }
  /** Justificatif daté du compte, source ACTIVE de l'événement de référence avec un rôle (devis, facture…), membre de l'événement. */
  async function justificatif(compte: AccountRow, op: number, role: string | null, date: string | null, assetId: number | null = null): Promise<number> {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET document_date = ${date}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(compte.id, async (repo) => {
      await repo.addSource(op, { kind: 'DOCUMENT', entityKey: f.id, role: role as never, authority: 'DOCUMENT' }, 'L114OF_E2E');
    });
    await sql`INSERT INTO business_operation_documents (account_id, operation_id, file_id, origins) VALUES (${compte.id}, ${op}, ${f.id}, ARRAY['SOURCE']) ON CONFLICT DO NOTHING`;
    return f.id;
  }
  const couverture = (compte: AccountRow, fileId: number, start: string | null, end: string | null, seg = 0) => sql`
    INSERT INTO document_business_periods (account_id, file_id, period_kind, segment_index, start_on, end_on, origin, basis)
    VALUES (${compte.id}, ${fileId}, 'COVERAGE', ${seg}, ${start}, ${end}, 'T1', 'T1_PERIOD_FACT')`;
  const element = async (compte: AccountRow, title: string, date: string | null, assetIds: number[]): Promise<number> =>
    (await make.agendaItem(compte, { title, ...(date ? { startDate: date } : {}), assetIds })).id;
  async function lier(compte: AccountRow, operationId: number, agendaItemId: number): Promise<void> {
    expect(await (await facade()).linkAgendaItem(user(compte), { operationId, agendaItemId })).toMatchObject({ status: 'APPLIED' });
  }
  async function timeline(assetId: number, mode: 'grouped' | 'detailed' = 'grouped'): Promise<Json[]> {
    const route = await import('@/app/api/assets/[id]/overview/route');
    const r = await route.GET(new NextRequest(`http://x/api/assets/${assetId}/overview?section=timeline&mode=${mode}&limit=100`), { params: Promise.resolve({ id: String(assetId) }) });
    expect(r.status).toBe(200);
    return (await r.json()).timeline as Json[];
  }
  async function page(operationId: number): Promise<{ status: number; reference: Json | null }> {
    const route = await import('@/app/api/evenements-reference/[id]/fiche/route');
    const r = await route.GET(new NextRequest(`http://x/api/evenements-reference/${operationId}/fiche`), { params: Promise.resolve({ id: String(operationId) }) });
    return { status: r.status, reference: r.status === 200 ? (await r.json()).fiche as Json : null };
  }
  async function recherche(q: string): Promise<Json[]> {
    const route = await import('@/app/api/search/route');
    const r = await route.GET(new NextRequest(`http://x/api/search?instant=1&q=${encodeURIComponent(q)}`));
    expect(r.status).toBe(200);
    return ((await r.json()).results as Json[]).filter((x) => x.category === CATEGORIE);
  }
  const dates = async (compte: AccountRow, ids: number[]) =>
    (await import('@/services/business-operations/graph/presentation-date')).readPresentationDates(compte.id, ids);
  /** Ce qu'une LECTURE ne doit jamais toucher. */
  async function empreinte(compte: AccountRow): Promise<string> {
    const [r] = await sql<{ h: string }[]>`
      SELECT md5(concat_ws('#',
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM agenda_items t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.operation_id)), '') FROM business_operation_contract_details t
          WHERE t.operation_id IN (SELECT id FROM business_operations WHERE account_id = ${compte.id})),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM document_business_periods t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM notification_outbox t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM to_process_actions t WHERE t.account_id = ${compte.id}))) AS h`;
    return r.h;
  }
  const groupe = (l: Json[], op: number) => l.find((e) => e.id === G(op))!;

  it('L114OF-E01 — intervention : premier devis faute de réalisation, puis réalisation attestée ; même date sur la Timeline, la page et la recherche (AC32)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const op = await operation(compte, 'INTERVENTION', { label: 'Toiture zinguerie', assetIds: [bien.id] });
    // Trois faits, trois dates : devis du 10 mars, visite du 20 mars, second devis du 25 mars.
    const devis2 = await justificatif(compte, op, 'QUOTE', '2025-03-25');
    await justificatif(compte, op, 'QUOTE', '2025-03-10');
    // Une facture d'acompte ou un autre justificatif plus ancien n'est pas un devis : sans effet sur le repère.
    await justificatif(compte, op, 'OTHER_EVIDENCE', '2025-01-05');
    const visite = await element(compte, 'Visite du couvreur', '2025-03-20', [bien.id]);
    const repere = await element(compte, 'Contrôle chaudière', '2025-03-15', [bien.id]);
    await lier(compte, op, visite);
    asUser(compte);
    const avant = await empreinte(compte);

    const reg = await timeline(bien.id);
    expect(reg.map((e) => e.id)).toEqual([String(repere), G(op)]);
    expect(groupe(reg, op)).toMatchObject({ kind: 'group', effectiveDate: '2025-03-10', dateBasis: 'FIRST_QUOTE' });
    // La visite reste à SA date, dans le dépliage et en mode détaillé.
    expect(groupe(reg, op).members.map((m: Json) => [m.id, m.effectiveDate])).toEqual([[String(visite), '2025-03-20']]);
    expect((await timeline(bien.id, 'detailed')).map((e) => [e.id, e.effectiveDate])).toEqual([[String(visite), '2025-03-20'], [String(repere), '2025-03-15']]);
    const p = await page(op);
    expect(p.reference).toMatchObject({ presentation: { date: '2025-03-10', basis: 'FIRST_QUOTE', label: 'Premier devis' }, undated: false, dates: [] });
    const [res] = await recherche('zinguerie');
    expect(JSON.stringify(res)).toContain('10/03/2025');
    expect((await dates(compte, [op])).get(op)).toEqual({ date: '2025-03-10', basis: 'FIRST_QUOTE' });

    // Devis supprimé (corbeille) ou source retirée : il ne fonde plus le repère (le suivant le remplace).
    const [premier] = await sql<{ id: number }[]>`SELECT id FROM asset_files WHERE account_id = ${compte.id} AND document_date = '2025-03-10'`;
    await sql`UPDATE asset_files SET deleted_at = '2025-06-01T00:00:00Z' WHERE id = ${premier.id}`;
    expect(groupe(await timeline(bien.id), op)).toMatchObject({ effectiveDate: '2025-03-25', dateBasis: 'FIRST_QUOTE' });
    await sql`UPDATE asset_files SET deleted_at = NULL WHERE id = ${premier.id}`;
    expect(devis2).toBeGreaterThan(0);
    expect(await empreinte(compte)).toBe(avant);

    // Réalisation attestée le 15 avril : elle devient le repère ; le devis et la visite gardent leur date.
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(compte.id, async (repo) => {
      await repo.setStatus(op, 'REALIZED', { reasonCode: 'L114OF_E2E' });
      await repo.updateAttributes(op, { realizedDate: '2025-04-15' }, 'L114OF_E2E');
    });
    const apres = await timeline(bien.id);
    expect(apres.map((e) => e.id)).toEqual([G(op), String(repere)]);
    expect(groupe(apres, op)).toMatchObject({ effectiveDate: '2025-04-15', dateBasis: 'REALIZED' });
    expect(groupe(apres, op).members.map((m: Json) => m.effectiveDate)).toEqual(['2025-03-20']);
    expect((await page(op)).reference).toMatchObject({ presentation: { date: '2025-04-15', basis: 'REALIZED', label: null }, undated: false, dates: [{ role: 'REALIZED', date: '2025-04-15' }] });
    expect(JSON.stringify(await recherche('zinguerie'))).toContain('15/04/2025');

    // Date de réalisation CONTESTÉE (deux valeurs tracées par T3) : non fiable — retour au premier devis.
    await sql`UPDATE business_operations SET attribute_provenance = ${JSON.stringify({ conflicts: [{ field: 'realizedDate', values: [{ value: '2025-04-15' }, { value: '2025-05-02' }] }] })}::jsonb WHERE id = ${op}`;
    expect(groupe(await timeline(bien.id), op)).toMatchObject({ effectiveDate: '2025-03-10', dateBasis: 'FIRST_QUOTE' });
    expect((await dates(compte, [op])).get(op)).toEqual({ date: '2025-03-10', basis: 'FIRST_QUOTE' });
    // Aucun rappel, aucune carte, aucun événement créé par ces lectures.
    const [n] = await sql<{ items: number; outbox: number; cards: number }[]>`
      SELECT (SELECT count(*)::int FROM agenda_items WHERE account_id = ${compte.id}) AS items,
             (SELECT count(*)::int FROM notification_outbox WHERE account_id = ${compte.id}) AS outbox,
             (SELECT count(*)::int FROM to_process_actions WHERE account_id = ${compte.id}) AS cards`;
    expect(n).toEqual({ items: 2, outbox: 0, cards: 0 });
  });

  it('L114OF-E02 — contrat : début initial, sinon première couverture connue (repère seulement) ; sans fait daté : « Sans date » ; SQL = règle pure (AC33, AC35)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement' });
    // Contrat SANS début connu : trois attestations de couverture (2023, 2024, 2025), une période « mois seul », un jour inexistant.
    const contrat = await operation(compte, 'CONTRACT', { label: 'Assurance habitation Altima', assetIds: [bien.id] });
    const a2024 = await justificatif(compte, contrat, 'CONTRACT_DOCUMENT', '2024-01-02');
    const a2023 = await justificatif(compte, contrat, 'CONTRACT_DOCUMENT', '2023-01-03');
    const a2025 = await justificatif(compte, contrat, 'CONTRACT_DOCUMENT', '2025-01-04');
    const flou = await justificatif(compte, contrat, 'CONTRACT_DOCUMENT', '2022-01-04');
    await couverture(compte, a2024, '2024-01-01', '2024-12-31');
    await couverture(compte, a2023, '2023-01-01', '2023-12-31');
    await couverture(compte, a2025, '2025-01-01', '2025-12-31');
    await couverture(compte, flou, '2021-06', null);        // mois seul : pas un jour fiable
    await couverture(compte, flou, '2021-02-31', null, 1);  // jour inexistant : ignoré, jamais une erreur
    // Échéance future du contrat (2031) : elle ne déplace pas le repère historique.
    const echeance = await element(compte, 'Échéance du contrat', '2031-01-01', [bien.id]);
    await lier(compte, contrat, echeance);
    // Contrat avec un début initial fiable ET des couvertures plus anciennes : le début l'emporte.
    const avecDebut = await operation(compte, 'CONTRACT', { start: '2019-06-01', label: 'Entretien chaudière Thermia', assetIds: [bien.id] });
    await couverture(compte, await justificatif(compte, avecDebut, 'CONTRACT_DOCUMENT', '2018-01-01'), '2018-01-01', '2018-12-31');
    // Événements de référence sans aucun fait daté (un par type du référentiel, plus le type non qualifié).
    const { BUSINESS_OPERATION_TYPE_CODES } = await import('@/services/business-operations/model');
    const sansDate: number[] = [];
    for (const t of [...BUSINESS_OPERATION_TYPE_CODES.filter((c) => c !== 'OTHER'), null]) sansDate.push(await operation(compte, t, { label: `Sans fait daté ${t ?? 'non qualifié'}`, assetIds: [bien.id] }));
    // Achat seulement prévu (devis d'achat) : l'acquisition n'a pas de date réelle → sans date.
    const achatPrevu = await operation(compte, 'ACQUISITION', { planned: '2027-02-01', label: 'Achat prévu', assetIds: [bien.id] });
    await justificatif(compte, achatPrevu, 'QUOTE', '2026-12-01');
    // Autre compte : même libellé, une couverture plus ancienne — jamais lue.
    const etranger = await operation(autre, 'CONTRACT', { label: 'Assurance habitation Altima' });
    await couverture(autre, await justificatif(autre, etranger, 'CONTRACT_DOCUMENT', '2001-01-01'), '2001-01-01', '2001-12-31');

    asUser(compte);
    const avant = await empreinte(compte);
    const reg = await timeline(bien.id);
    expect(groupe(reg, contrat)).toMatchObject({ effectiveDate: '2023-01-01', dateBasis: 'FIRST_COVERAGE' });
    expect(groupe(reg, contrat).members.map((m: Json) => m.effectiveDate)).toEqual(['2031-01-01']);
    expect(groupe(reg, avecDebut)).toMatchObject({ effectiveDate: '2019-06-01', dateBasis: 'START' });
    // Ordre : flux daté (2023, 2019), puis « sans date » (identifiant décroissant) ; aucune date inventée.
    expect(reg.map((e) => e.id)).toEqual([G(contrat), G(avecDebut), G(achatPrevu), ...[...sansDate].reverse().map(G)]);
    for (const id of [...sansDate, achatPrevu]) {
      expect(groupe(reg, id)).toMatchObject({ effectiveDate: null, dateBasis: null });
      expect((await page(id)).reference).toMatchObject({ presentation: { date: null, basis: null, label: null } });
    }
    for (const id of sansDate) expect((await page(id)).reference).toMatchObject({ undated: true, dates: [] });
    // L'achat prévu garde sa date PROPRE qualifiée sur la page (« Prévu le »), sans devenir un repère.
    expect((await page(achatPrevu)).reference).toMatchObject({ undated: false, dates: [{ role: 'PLANNED', date: '2027-02-01' }] });
    const texte = JSON.stringify(await recherche('Sans fait daté'));
    expect(texte).toContain('Sans date');
    expect(texte).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);

    // Page et recherche : même repère que la Timeline ; la couverture n'est JAMAIS écrite comme prise d'effet.
    expect((await page(contrat)).reference).toMatchObject({ presentation: { date: '2023-01-01', basis: 'FIRST_COVERAGE', label: 'Première couverture connue' }, undated: false, dates: [] });
    expect((await page(avecDebut)).reference).toMatchObject({ presentation: { date: '2019-06-01', basis: 'START', label: null }, dates: [{ role: 'START', date: '2019-06-01' }] });
    expect(JSON.stringify(await recherche('Altima'))).toContain('01/01/2023');
    const [stocke] = await sql<{ start_date: string | null; n: number }[]>`
      SELECT o.start_date::text AS start_date, (SELECT count(*)::int FROM business_operation_contract_details d WHERE d.operation_id = o.id AND d.effective_from IS NOT NULL) AS n
        FROM business_operations o WHERE o.id = ${contrat}`;
    expect(stocke).toEqual({ start_date: null, n: 0 });
    expect(await empreinte(compte)).toBe(avant);

    // UNE règle : pour chaque événement de référence du compte, la Timeline (SQL) = la règle pure (lecture des faits).
    const tous = [contrat, avecDebut, achatPrevu, ...sansDate];
    const pures = await dates(compte, tous);
    expect([...pures.keys()].sort((a, b) => a - b)).toEqual([...tous].sort((a, b) => a - b));
    for (const id of tous) expect({ date: groupe(reg, id).effectiveDate, basis: groupe(reg, id).dateBasis }, `événement ${id}`).toEqual(pures.get(id));

    // Isolation : l'événement de l'autre compte n'est jamais daté ni lu depuis ce compte.
    expect((await dates(compte, [etranger])).size).toBe(0);
    expect((await page(etranger)).status).toBe(404);
    expect((await dates(autre, [etranger])).get(etranger)).toEqual({ date: '2001-01-01', basis: 'FIRST_COVERAGE' });
    // Événement invalidé : plus de repère.
    await sql`UPDATE business_operations SET invalidated_at = '2026-01-01T00:00:00Z', invalidation_reason = 'L114OF_E2E' WHERE id = ${avecDebut}`;
    expect((await dates(compte, [avecDebut])).size).toBe(0);
  });
  // ── Finances et coût de possession (CDC §9, §18 ; AC49 à AC53, AC68) ──────

  /** Jour figé de la lecture du coût de possession (aucun test ne dépend du jour). */
  const AUJ = '2026-11-05';
  /** Coût de possession lu par le service de PRODUCTION (lecture seule, recalculée à chaque appel). */
  const tco = async (compte: AccountRow, assetId: number) =>
    (await import('@/services/business-operations/tco/service')).readAssetTco(compte.id, assetId, { today: AUJ });
  type Tco = Awaited<ReturnType<typeof tco>>;
  /** Totaux, postes et montants retenus : ce qui ne doit pas bouger, même après une reconsolidation (les identifiants de composantes changent). */
  const totaux = (t: Tco) => ({
    total: t.summary.cumulativeCostCents, acquisition: t.summary.acquisitionCents, complements: t.summary.additionalCostsCents,
    remises: t.reductionsCents, remboursements: t.refundsCents, indemnites: t.indemnitiesCents,
    postes: t.breakdown.map((b) => `${b.category}:${b.costsCents}:${b.count}`).sort(),
    retenues: t.lines.filter((l) => l.includedCents !== 0).map((l) => `${l.kind}:${l.eurCents}:${l.includedCents}`).sort(),
    financement: t.indicators.financing, alertes: [...t.reliability.warnings].sort(),
  });
  /** Empreinte LIGNE PAR LIGNE (identifiants, statuts et motifs compris) : une relation ou un partage ne change rien du tout. */
  const empreinteTco = (t: Tco) => ({ ...totaux(t), lignes: t.lines.map((l) => `${l.id}|${l.status}|${l.reason ?? ''}|${l.includedCents}`).sort() });
  /** Nombre de lignes RETENUES qui portent ce montant (un montant compté deux fois en donnerait deux). */
  const comptees = (t: Tco, eurCents: number) => t.lines.filter((l) => l.includedCents === eurCents).length;
  const associer = async (compte: AccountRow, from: number, to: number, nature: 'FINANCING' | 'CLAIM_REPAIR' | 'ASSOCIATED', preuve: string) => {
    expect(await (await facade()).associateOperations(user(compte), {
      fromOperationId: from, toOperationId: to, nature, evidence: [{ kind: 'USER_DECLARATION', ref: preuve }], reasonCode: 'L114OF_E2E',
    }), `relation ${nature} ${from} → ${to}`).toMatchObject({ status: 'APPLIED' });
  };
  const facture = (compte: AccountRow, assetId: number, o: { type: string; titre: string; cents: number; date: string; hint: string; reference: string; fournisseur?: string }) =>
    k.document(compte, assetId, [cand({
      typeHint: o.hint as never, sourceRoleHint: 'INVOICE', summary: o.titre, provider: o.fournisseur ?? 'Artisan', targetHints: [cible(assetId)],
      businessReferences: [ref('INVOICE', o.reference)], temporalHints: { realizedDate: o.date },
      financialHints: [fh('REALIZED_COST', o.cents, { economicDate: o.date })],
    })], { type: o.type, title: o.titre, amountCents: o.cents, date: o.date });

  it('L114OF-E03 — financement ↔ achat(s) : relation lue dans les deux sens, aucun coût ni capital ajouté ; coût de possession identique avant / après, sur chaque bien, et après reconsolidation (AC49 à AC51, AC68)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison du bourg' });
    const voiture = await make.asset(compte, { category: 'VEHICULE', name: 'Break' });
    await facture(compte, maison.id, { type: 'ACQUISITION_INVOICE', titre: 'Acte d’achat de la maison', cents: 40_000_000, date: '2021-11-05', hint: 'ACQUISITION', reference: 'F-MAISON', fournisseur: 'Notaire' });
    await facture(compte, voiture.id, { type: 'ACQUISITION_INVOICE', titre: 'Facture du break', cents: 1_500_000, date: '2022-05-10', hint: 'ACQUISITION', reference: 'F-BREAK', fournisseur: 'Concession' });
    await facture(compte, maison.id, { type: 'REPAIR_INVOICE', titre: 'Réfection de la toiture', cents: 3_800_000, date: '2023-03-01', hint: 'INTERVENTION', reference: 'F-TOIT' });
    // UN prêt pour les deux achats : capital (jamais un coût) et une échéance d'intérêts passée.
    await k.document(compte, maison.id, [cand({
      typeHint: 'FINANCING', sourceRoleHint: 'CONTRACT_DOCUMENT', summary: 'Prêt travaux et véhicule', provider: 'Banque du bourg',
      targetHints: [cible(maison.id), cible(voiture.id)], businessReferences: [ref('LOAN', 'PRET-744F')],
      temporalHints: { startDate: '2021-11-05' },
      financialHints: [fh('LOAN_PRINCIPAL', 30_000_000), fh('REALIZED_COST', 120_000, { economicDate: '2026-01-05' })],
    })], { type: 'LEASING_FINANCING_CONTRACT', title: 'Tableau d’amortissement PRET-744F', date: '2021-10-20' });
    await k.passer(compte, { today: AUJ });

    const actifs = await k.actives(compte);
    const [pret] = actifs.filter((o) => o.type_code === 'FINANCING');
    const achats = actifs.filter((o) => o.type_code === 'ACQUISITION');
    expect(pret, 'une opération FINANCING').toBeTruthy();
    expect(achats.length, 'deux achats distincts').toBe(2);
    asUser(compte);
    const avant = { maison: empreinteTco(await tco(compte, maison.id)), voiture: empreinteTco(await tco(compte, voiture.id)) };
    const avantTotaux = { maison: totaux(await tco(compte, maison.id)), voiture: totaux(await tco(compte, voiture.id)) };
    // Le capital emprunté n'est jamais un coût de possession (CDC §9), avant comme après la relation.
    expect(comptees(await tco(compte, maison.id), 30_000_000), 'capital jamais compté').toBe(0);
    // AC53 : l'échéance du prêt concerne DEUX biens sans ventilation prouvée — non allouée, jamais 100 % sur chacun.
    expect((await tco(compte, maison.id)).reliability.unallocated.count, 'échéance multi-biens non allouée').toBeGreaterThan(0);
    for (const b of [maison, voiture]) expect(comptees(await tco(compte, b.id), 120_000), `aucun partage inventé (bien ${b.id})`).toBe(0);

    // AC49, AC50 : un financement avant l'acquisition reste DISTINCT et relié ensuite à PLUSIEURS achats.
    for (const a of achats) await associer(compte, pret.id, a.id, 'FINANCING', `pret-${a.id}`);
    const cotePret = (await page(pret.id)).reference!;
    expect(cotePret.relations.map((r: Json) => [r.operationId, r.nature, r.direction]).sort()).toEqual(achats.map((a) => [a.id, 'FINANCING', 'OUTGOING']).sort());
    for (const a of achats) expect((await page(a.id)).reference!.relations).toEqual([{ operationId: pret.id, label: cotePret.title, nature: 'FINANCING', direction: 'INCOMING' }]);
    // Aucune fusion, aucun déplacement : les deux achats et le prêt restent trois événements de référence actifs.
    expect((await k.actives(compte)).length).toBe(actifs.length);

    // AC51 : la relation n'ajoute NI coût NI capital — coût de possession identique ligne par ligne sur chaque bien.
    expect(empreinteTco(await tco(compte, maison.id)), 'maison : relation sans effet').toEqual(avant.maison);
    expect(empreinteTco(await tco(compte, voiture.id)), 'véhicule : relation sans effet').toEqual(avant.voiture);
    // Aucune composante financière n'a été créée par la relation (CDC §9 : « une relation ne crée aucune composante »).
    const nComposantes = async () => (await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM business_operation_financial_components c
        JOIN business_operations o ON o.id = c.operation_id AND o.account_id = ${compte.id} WHERE c.active`)[0].n;
    const compAvant = await nComposantes();

    // AC68 : nouvelle consolidation T3 à faits constants — mêmes postes et mêmes totaux (les identifiants peuvent changer).
    await k.passer(compte, { today: AUJ });
    expect(await nComposantes()).toBe(compAvant);
    expect(totaux(await tco(compte, maison.id)), 'maison : reconsolidation à faits constants').toEqual(avantTotaux.maison);
    expect(totaux(await tco(compte, voiture.id)), 'véhicule : reconsolidation à faits constants').toEqual(avantTotaux.voiture);
    // La relation posée par l'utilisateur a survécu à la reconsolidation, dans les deux sens.
    expect((await page(pret.id)).reference!.relations).toHaveLength(2);
    expect(comptees(await tco(compte, maison.id), 30_000_000)).toBe(0);
  });

  it('L114OF-E04 — sinistre ↔ réparation : justificatif partagé et événement de l’Agenda partagé n’ajoutent aucun coût ; réparation et indemnité comptées une seule fois (AC24, AC52)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison de la plaine' });
    const sinistre = await k.sinistre(compte, { id: compte.ownerUserId }, maison, {
      claimType: 'DEGAT_DES_EAUX', occurredOn: '2025-02-10', declaredOn: '2025-02-12', insurerClaimRef: 'SIN-744F',
      status: 'INDEMNISE', estimatedDamageCents: 3_200_000, compensationCents: 1_500_000,
    });
    const reparation = await facture(compte, maison.id, { type: 'REPAIR_INVOICE', titre: 'Réparation après dégât des eaux', cents: 3_000_000, date: '2025-03-20', hint: 'INTERVENTION', reference: 'F-REPAR-744F' });
    await k.passer(compte, { today: AUJ });
    const intervention = (await k.actives(compte)).find((o) => o.type_code === 'INTERVENTION');
    expect(intervention, 'une opération INTERVENTION pour la réparation').toBeTruthy();
    asUser(compte);

    const depart = empreinteTco(await tco(compte, maison.id));
    const departTotaux = totaux(await tco(compte, maison.id));
    // La réparation et l'indemnité sont comptées UNE fois (AC52) : une seule ligne retenue pour chacune.
    expect(comptees(await tco(compte, maison.id), 3_000_000), 'réparation comptée une fois').toBe(1);
    expect((await tco(compte, maison.id)).indemnitiesCents, 'indemnité comptée une fois').toBe(1_500_000);

    // 1. La relation sinistre → réparation n'ajoute aucun coût.
    await associer(compte, sinistre, intervention!.id, 'CLAIM_REPAIR', `sinistre-${sinistre}`);
    expect(empreinteTco(await tco(compte, maison.id)), 'relation sinistre ↔ réparation sans effet').toEqual(depart);

    // 2. Le JUSTIFICATIF de la réparation est partagé avec le sinistre (geste de l'utilisateur) : aucun coût de plus.
    expect(await (await facade()).linkDocument(user(compte), { operationId: sinistre, fileId: reparation, reasonCode: 'L114OF_E2E' })).toMatchObject({ status: 'APPLIED' });
    const [partage] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM business_operation_documents WHERE account_id = ${compte.id} AND file_id = ${reparation} AND active`;
    expect(partage.n, 'le justificatif appartient bien aux deux opérations').toBe(2);
    expect(comptees(await tco(compte, maison.id), 3_000_000), 'justificatif partagé : toujours un seul coût').toBe(1);
    expect(totaux(await tco(compte, maison.id)), 'justificatif partagé : total inchangé').toEqual(departTotaux);

    // 3. Un ÉVÉNEMENT de l'Agenda partagé par les deux événements de référence : un seul objet, aucun coût.
    const visite = await element(compte, 'Passage de l’expert', '2025-02-20', [maison.id]);
    await lier(compte, sinistre, visite);
    await lier(compte, intervention!.id, visite);
    const detaillee = await timeline(maison.id, 'detailed');
    expect(detaillee.filter((e) => e.id === String(visite)), 'AC24 : une seule occurrence du même événement').toHaveLength(1);
    expect(totaux(await tco(compte, maison.id)), 'événement partagé : aucun coût ajouté').toEqual(departTotaux);

    // 4. Nouvelle consolidation T3 après les partages : mêmes totaux, toujours un seul coût de réparation.
    await k.passer(compte, { today: AUJ });
    expect(comptees(await tco(compte, maison.id), 3_000_000), 'après reconsolidation : toujours un seul coût').toBe(1);
    expect(totaux(await tco(compte, maison.id)), 'après reconsolidation : totaux inchangés').toEqual(departTotaux);
    expect((await tco(compte, maison.id)).indemnitiesCents).toBe(1_500_000);
  });
  // ── Exports (CDC §19 ; AC43, AC69) ───────────────────────────────────────

  /** Source du dossier lue par le chemin de PRODUCTION (aucune modification de la façade de demande d'export). */
  const sourceDossier = async (compte: AccountRow, assetId: number, exportType: 'ASSURANCE_SINISTRE' | 'DOSSIER_COMPLET', claimOperationId?: number) => {
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    return loadExportSource({ assetId, accountId: compte.id, userId: compte.ownerUserId, exportType, ...(claimOperationId ? { claimOperationId } : {}) });
  };

  it('L114OF-E05 — dossier « Assurance — sinistre » : chronologie lue dans le graphe, un élément partagé jamais en double, documents dédoublonnés, isolation des comptes (AC24, AC43, AC69)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison du port' });
    const sinistre = await k.sinistre(compte, { id: compte.ownerUserId }, maison, {
      claimType: 'DEGAT_DES_EAUX', occurredOn: '2025-02-10', declaredOn: '2025-02-12', insurerClaimRef: 'SIN-744G',
      status: 'EXPERTISE_REALISEE', estimatedDamageCents: 2_000_000, compensationCents: 900_000,
    });
    const reparation = await facture(compte, maison.id, { type: 'REPAIR_INVOICE', titre: 'Remise en état du plafond', cents: 1_200_000, date: '2025-03-20', hint: 'INTERVENTION', reference: 'F-PLAFOND-744G' });
    await k.passer(compte, { today: AUJ });
    const intervention = (await k.actives(compte)).find((o) => o.type_code === 'INTERVENTION');
    expect(intervention, 'une opération INTERVENTION').toBeTruthy();

    // 1. Élément relié au sinistre par le GRAPHE SEUL (modèle cible : aucun rôle PRINCIPAL, aucune colonne historique).
    const expertise = await element(compte, 'Passage de l’expert', '2025-02-20', [maison.id]);
    await lier(compte, sinistre, expertise);
    // 2. Élément porté par les DEUX supports (colonne historique ET lien actif) : il ne doit apparaître qu'une fois.
    const constat = await element(compte, 'Constat amiable', '2025-02-11', [maison.id]);
    await lier(compte, sinistre, constat);
    await sql`UPDATE agenda_items SET business_operation_id = ${sinistre} WHERE id = ${constat} AND account_id = ${compte.id}`;
    // 3. Élément PARTAGÉ entre le sinistre et la réparation : un seul objet, une seule ligne de chronologie.
    const chantier = await element(compte, 'Intervention du plâtrier', '2025-03-18', [maison.id]);
    await lier(compte, sinistre, chantier);
    await lier(compte, intervention!.id, chantier);
    // 4. Élément d'un AUTRE compte : jamais lu (aucun lien possible, vérifié par la lecture).
    const ailleurs = await make.asset(autre, { category: 'IMMOBILIER', name: 'Maison du port' });
    const etranger = await element(autre, 'Passage de l’expert', '2025-02-20', [ailleurs.id]);

    asUser(compte);
    const src = await sourceDossier(compte, maison.id, 'ASSURANCE_SINISTRE', sinistre);
    const dossier = src.claimFile!;
    expect(dossier.operationId).toBe(sinistre);
    // Les trois éléments sont là, chacun UNE fois, chacun à SA date (jamais la date de présentation de l'événement).
    expect(dossier.agenda.map((a) => [a.key, a.date])).toEqual([
      ['agenda:' + constat, '2025-02-11'], ['agenda:' + expertise, '2025-02-20'], ['agenda:' + chantier, '2025-03-18'],
    ]);
    expect(dossier.agendaKeys.length, 'aucune clé répétée').toBe(new Set(dossier.agendaKeys).size);
    // Un élément de l'autre compte n'apparaît jamais, même à nom et date identiques.
    expect(dossier.agendaKeys).not.toContain(`agenda:${etranger}`);
    // Documents du sinistre : aucun doublon (un justificatif partagé n'apparaît pas deux fois — AC43).
    expect(await (await facade()).linkDocument(user(compte), { operationId: sinistre, fileId: reparation, reasonCode: 'L114OF_E2E' })).toMatchObject({ status: 'APPLIED' });
    const src2 = await sourceDossier(compte, maison.id, 'ASSURANCE_SINISTRE', sinistre);
    const docs = src2.claimFile!.documentIds;
    expect(docs.length, 'aucun justificatif répété').toBe(new Set(docs).size);
    expect(docs).toContain(reparation);
    // Le partage n'élargit pas le dossier : seuls des justificatifs du COMPTE y figurent (AC59).
    const [fuite] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM asset_files WHERE id = ANY(${docs.length ? docs : [0]}::bigint[]) AND account_id <> ${compte.id}`;
    expect(fuite.n, 'aucun justificatif hors compte').toBe(0);
    // La chronologie reste identique après le partage du justificatif, et le coût n'a pas bougé.
    expect(src2.claimFile!.agendaKeys).toEqual(dossier.agendaKeys);
    expect(comptees(await tco(compte, maison.id), 1_200_000), 'réparation comptée une fois').toBe(1);

    // Événement de référence invalidé : le dossier du compte reste lisible, et le sinistre supprimé n'est plus proposé.
    await sql`UPDATE business_operations SET invalidated_at = '2026-01-01T00:00:00Z', invalidation_reason = 'L114OF_E2E' WHERE id = ${sinistre}`;
    const src3 = await sourceDossier(compte, maison.id, 'ASSURANCE_SINISTRE', sinistre);
    expect(src3.claim).toMatchObject({ selectedOperationId: null, origin: 'none', options: [] });
    expect(src3.claimFile).toBeNull();
  });
});
