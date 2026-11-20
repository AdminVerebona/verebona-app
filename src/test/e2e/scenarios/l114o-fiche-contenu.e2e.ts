/**
 * Lot 114O (Trello #744, CDC « Opérations / Agenda V2.0 ») — travaux D de la
 * carte, CONTENU de la fiche : SYNTHÈSE factuelle, MONTANTS et NOTE LIBRE
 * (CDC §5, §14, §18 ; AC42, AC52 à AC55, AC57), sur PostgreSQL 16 réel, par
 * les chemins de PRODUCTION : persistance T1 et consolidation T3 réelles
 * (jeu de données `operations-v1`), service du coût de possession
 * `readAssetTco`, vraies routes `GET /api/evenements-reference/:id/fiche` et
 * `PUT /api/evenements-reference/:id/notes`, façade d'écriture. Seule la
 * session est simulée. Aucune IA. Dates FIXES : aucun test ne dépend du jour.
 *
 *   L114OK-E01  AC42, AC52 : la synthèse d'une intervention réelle — total dépensé (DEVIS exclu), justificatifs,
 *               période couverte, événements, fournisseurs ; le montant est celui du moteur EXISTANT, et la lecture
 *               de la fiche n'écrit rien et ne change pas le coût de possession
 *   L114OK-E02  AC57 : AUCUN DOUBLE COMPTE — un justificatif et un événement de l'Agenda PARTAGÉS entre deux
 *               événements de référence sont comptés une fois sur chaque fiche ; les montants et le coût de
 *               possession ne bougent pas ; rattacher deux fois ne compte pas deux fois
 *   L114OK-E03  AC53 à AC55 : aucun montant inventé — devise sans contre-valeur connue non convertie et signalée,
 *               aucune composante → aucune rubrique de montant, aucun fait daté → aucune période
 *   L114OK-E04  AC42 : la NOTE LIBRE par sa vraie route — enregistrée, rejouée sans écriture, version périmée
 *               refusée, retirée, trop longue refusée, isolée du compte ; T3 ne la réécrit pas et elle ne change
 *               aucun montant ; journal avant / après ; aucun événement, rappel ni carte créés
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import { cand, cible, fh, operationsKit, ref } from '../datasets/operations-v1';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';
import { REFERENCE_EVENT_SUCCESS, REFERENCE_EVENT_WRITE_MESSAGES } from '@/lib/reference-events/reference-event-write';
import { REFERENCE_EVENT_NOTES_MAX } from '@/lib/reference-events/reference-event-summary';

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
const facade = () => import('@/services/business-operations/operation-write.facade');
/** Jour figé de la lecture du coût de possession. */
const AUJ = '2026-11-05';

scenario('L114OK', 'Opérations / Agenda CDC V2.0 — travaux D : synthèse, montants et note libre de la fiche', ({ sql, make }) => {
  const k = operationsKit(sql, make);
  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };

  /** Événement de référence créé par le dépôt (chemin d'écriture de production). */
  async function operation(compte: AccountRow, type: string | null, over: { realized?: string; label?: string; assetIds?: number[] } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: (type ? { code: type } : null) as never, status: over.realized ? 'REALIZED' : 'ENVISAGED',
      realizedDate: over.realized ?? null, technicalLabel: over.label ?? null,
      source: { kind: 'MIGRATION', entityKey: `l114ok-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' },
      assets: (over.assetIds ?? []).map((assetId) => ({ assetId, authority: 'USER' as const })),
      reasonCode: 'L114OK_E2E',
    })).id);
  }
  const element = async (compte: AccountRow, title: string, date: string | null, assetIds: number[] = []): Promise<number> =>
    (await make.agendaItem(compte, { title, ...(date ? { startDate: date } : {}), assetIds })).id;
  const fournisseur = async (c: AccountRow, name: string): Promise<number> =>
    (await sql<{ id: number }[]>`INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, status)
      VALUES (${c.id}, ${c.ownerUserId}, ${name}, ${name.toLowerCase()}, 'active') RETURNING id`)[0].id;

  /** Vraie route de la page (lecture). */
  async function page(id: number | string): Promise<{ status: number; fiche: Json | null }> {
    const route = await import('@/app/api/evenements-reference/[id]/fiche/route');
    const r = await route.GET(new NextRequest(`http://x/api/evenements-reference/${id}/fiche`), { params: Promise.resolve({ id: String(id) }) });
    return { status: r.status, fiche: r.status === 200 ? (await r.json()).fiche as Json : null };
  }
  const synthese = async (id: number): Promise<Json> => (await page(id)).fiche!.summary as Json;

  /** Vraie route d'écriture de la note. */
  async function ecrireNote(id: number, body: unknown): Promise<{ status: number; body: Json }> {
    const route = await import('@/app/api/evenements-reference/[id]/notes/route');
    const r = await route.PUT(
      new NextRequest(`http://x/api/evenements-reference/${id}/notes`, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id: String(id) }) },
    );
    return { status: r.status, body: (await r.json()) as Json };
  }
  const version = async (id: number): Promise<number> =>
    (await sql<{ version: number }[]>`SELECT version FROM business_operations WHERE id = ${id}`)[0].version;
  const noteEnBase = async (id: number) =>
    (await sql<{ user_notes: string | null; jour: string | null; auteur: number | null }[]>`
      SELECT user_notes, user_notes_updated_at::date::text AS jour, user_notes_author_user_id::int AS auteur
        FROM business_operations WHERE id = ${id}`)[0];

  /** Coût de possession lu par le service de PRODUCTION (jour figé). */
  const tco = async (compte: AccountRow, assetId: number) =>
    (await import('@/services/business-operations/tco/service')).readAssetTco(compte.id, assetId, { today: AUJ });
  type Tco = Awaited<ReturnType<typeof tco>>;
  /** Empreinte LIGNE PAR LIGNE du coût de possession : ce qu'aucun partage, aucune note, aucune lecture ne doit changer. */
  const empreinteTco = (t: Tco) => JSON.stringify({
    total: t.summary.cumulativeCostCents, acquisition: t.summary.acquisitionCents, complements: t.summary.additionalCostsCents,
    remises: t.reductionsCents, remboursements: t.refundsCents, indemnites: t.indemnitiesCents,
    postes: t.breakdown.map((b) => `${b.category}:${b.costsCents}:${b.count}`).sort(),
    lignes: t.lines.map((l) => `${l.kind}|${l.status}|${l.includedCents}`).sort(),
  });

  /** Empreinte de ce qu'une LECTURE ne doit jamais toucher. */
  async function empreinte(compte: AccountRow): Promise<string> {
    const [r] = await sql<{ h: string }[]>`
      SELECT md5(concat_ws('#',
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM agenda_items t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_agenda_links t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_documents t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM business_operation_graph_history t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM notification_outbox t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM to_process_actions t WHERE t.account_id = ${compte.id}))) AS h`;
    return r.h;
  }

  // ── Synthèse et montants (CDC §14, §18) ─────────────────────────────────

  it('L114OK-E01 — synthèse d’une intervention réelle : total dépensé sans les devis, nombres, période, fournisseurs ; la lecture n’écrit rien', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    // DEVIS de 2 000 € puis FACTURE payée 1 200 € du MÊME chantier (la facture cite la référence du devis : un
    // seul événement de référence après la consolidation T3 réelle).
    const commun = {
      typeHint: 'INTERVENTION' as const, summary: 'Remplacement de la chaudière', provider: 'Thermo Services',
      targetHints: [cible(bien.id)] as ReturnType<typeof cible>[],
    };
    await k.document(compte, bien.id, [cand({
      ...commun, candidateKey: 'devis', statusHint: 'ENVISAGED', sourceRoleHint: 'QUOTE',
      businessReferences: [ref('QUOTE', 'DV-744K-01')],
      temporalHints: { plannedDate: '2025-01-10' }, financialHints: [fh('FORECAST_COST', 200_000)],
    })], { type: 'QUOTE', title: 'Devis chaudière', date: '2025-01-10', amountCents: 200_000 });
    await k.passer(compte, { today: AUJ });
    await k.document(compte, bien.id, [cand({
      ...commun, candidateKey: 'facture', statusHint: 'REALIZED', sourceRoleHint: 'INVOICE',
      businessReferences: [ref('QUOTE', 'DV-744K-01'), ref('INVOICE', 'FA-744K-07')],
      temporalHints: { realizedDate: '2025-04-02' }, financialHints: [fh('REALIZED_COST', 120_000, { economicDate: '2025-04-02' })],
    })], { type: 'INVOICE', title: 'Facture chaudière', date: '2025-04-02', amountCents: 120_000 });
    await k.passer(compte, { today: AUJ });

    const actifs = await k.actives(compte);
    const interventions = actifs.filter((o) => o.type_code === 'INTERVENTION');
    expect(interventions.length, 'devis et facture rapprochés : UNE seule opération').toBe(1);
    const id = interventions[0].id;
    // Un événement de l'Agenda et un fournisseur relié, par la façade (chemin de production).
    const visite = await element(compte, 'Passage de l’artisan', '2025-04-02', [bien.id]);
    expect(await (await facade()).linkAgendaItem(user(compte), { operationId: id, agendaItemId: visite })).toMatchObject({ status: 'APPLIED' });
    const presta = await fournisseur(compte, 'Thermo Services');
    expect(await (await facade()).linkSupplier(user(compte), { operationId: id, supplierId: presta })).toMatchObject({ status: 'APPLIED' });
    asUser(compte);

    const avant = await empreinte(compte);
    const tcoAvant = empreinteTco(await tco(compte, bien.id));
    const s = await synthese(id);

    // MONTANT : exactement la règle du moteur EXISTANT — les devis ne sont pas une dépense (CDC §18, AC52).
    const attendu = await k.coutNet(id);
    expect(s.netCents, 'le total dépensé est celui du moteur, devis exclus').toBe(attendu);
    expect(s.netCents).toBe(120_000);
    expect(s.unconvertedCount).toBe(0);
    // NOMBRES et FOURNISSEURS : exactement ce que la fiche porte, compté une fois chacun.
    const [{ docs }] = await sql<{ docs: number }[]>`
      SELECT count(DISTINCT file_id)::int AS docs FROM business_operation_documents WHERE account_id = ${compte.id} AND operation_id = ${id} AND active`;
    expect(s.documentCount, 'les justificatifs du chantier, chacun une fois').toBe(docs);
    expect(docs, 'le devis et la facture du même chantier').toBe(2);
    expect(s.agendaItemCount).toBe(1);
    expect(s.supplierNames).toEqual(['Thermo Services']);
    // PÉRIODE : étendue des faits DATÉS (devis de janvier → facture d'avril), aucune date inventée.
    expect(s.period).toEqual({ from: '2025-01-10', to: '2025-04-02' });

    // La LECTURE de la fiche n'écrit rien et ne touche pas au coût de possession (aucun agrégat nouveau).
    expect(await empreinte(compte)).toBe(avant);
    expect(empreinteTco(await tco(compte, bien.id))).toBe(tcoAvant);
    // Aucun appel IA, aucun rappel, aucune carte « À traiter » : vérifié par l'empreinte ci-dessus.
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM notification_outbox WHERE account_id = ${compte.id}`;
    expect(n).toBe(0);
  });

  it('L114OK-E02 — aucun double compte : un justificatif et un événement partagés entre deux opérations comptent une fois sur chaque fiche', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const sinistre = await operation(compte, 'CLAIM', { realized: '2025-05-02', label: 'Dégât des eaux', assetIds: [bien.id] });
    const reparation = await operation(compte, 'INTERVENTION', { realized: '2025-05-20', label: 'Réfection du plafond', assetIds: [bien.id] });
    // Un justificatif du compte, et un événement de l'Agenda, rattachés au SINISTRE puis PARTAGÉS avec la réparation.
    const f = await make.assetFile(compte, { assetId: bien.id });
    await sql`UPDATE asset_files SET document_date = '2025-05-20', analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    const expertise = await element(compte, 'Passage de l’expert', '2025-05-10', [bien.id]);
    asUser(compte);

    const tcoAvant = empreinteTco(await tco(compte, bien.id));
    for (const op of [sinistre, reparation]) {
      expect(await (await facade()).linkDocument(user(compte), { operationId: op, fileId: f.id }), `document → ${op}`).toMatchObject({ status: 'APPLIED' });
      expect(await (await facade()).linkAgendaItem(user(compte), { operationId: op, agendaItemId: expertise }), `événement → ${op}`).toMatchObject({ status: 'APPLIED' });
    }

    // Chaque fiche compte le justificatif et l'événement UNE SEULE FOIS — jamais deux parce qu'ils sont partagés.
    for (const op of [sinistre, reparation]) {
      const s = await synthese(op);
      expect(s.documentCount, `justificatif partagé, fiche ${op}`).toBe(1);
      expect(s.agendaItemCount, `événement partagé, fiche ${op}`).toBe(1);
      // Aucune composante financière n'est née du partage : aucun montant sur l'une ou l'autre fiche.
      expect(s.netCents, `aucun montant inventé, fiche ${op}`).toBeNull();
    }
    // La fiche de la réparation voit bien l'événement comme PARTAGÉ (lecture du graphe), et une seule fois.
    const fiche = (await page(reparation)).fiche!;
    expect(fiche.agendaItems.filter((a: Json) => a.id === expertise)).toHaveLength(1);
    expect(fiche.agendaItems.find((a: Json) => a.id === expertise)!.shared).toBe(true);
    expect(fiche.documents.filter((d: Json) => d.fileId === f.id)).toHaveLength(1);

    // Rattacher DEUX FOIS le même justificatif et le même événement ne les compte pas deux fois (idempotence).
    expect(await (await facade()).linkDocument(user(compte), { operationId: reparation, fileId: f.id })).toMatchObject({ status: 'APPLIED', changed: false });
    expect(await (await facade()).linkAgendaItem(user(compte), { operationId: reparation, agendaItemId: expertise })).toMatchObject({ status: 'APPLIED' });
    const apres = await synthese(reparation);
    expect(apres.documentCount).toBe(1);
    expect(apres.agendaItemCount).toBe(1);

    // Et le coût de possession du bien n'a pas bougé d'un centime : le partage n'ajoute aucun coût (AC51, AC57).
    expect(empreinteTco(await tco(compte, bien.id)), 'le partage ne change aucun total').toBe(tcoAvant);
    // Associer les deux événements de référence ne change rien non plus.
    expect(await (await facade()).associateOperations(user(compte), {
      fromOperationId: reparation, toOperationId: sinistre, nature: 'ASSOCIATED', evidence: [{ kind: 'DOCUMENT', ref: String(f.id) }],
    })).toMatchObject({ status: 'APPLIED' });
    expect(empreinteTco(await tco(compte, bien.id))).toBe(tcoAvant);
    for (const op of [sinistre, reparation]) expect((await synthese(op)).documentCount).toBe(1);
  });

  it('L114OK-E03 — aucun montant inventé : devise non convertie signalée, aucune composante → aucun montant, aucun fait daté → aucune période', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Chalet' });
    const op = await operation(compte, 'INTERVENTION', { realized: '2025-07-01', label: 'Toiture', assetIds: [bien.id] });
    // Deux composantes du MÊME événement : 300 € connus, et 500 CHF sans contre-valeur fiable en euros (AC54).
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(compte.id, async (repo) => {
      const s = await repo.addSource(op, { kind: 'MIGRATION', entityKey: `l114ok-devises-${op}`, authority: 'STRUCTURED' }, 'L114OK_E2E');
      void s;
    });
    await sql`INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency, amount_eur_cents, economic_date)
              VALUES (${compte.id}, ${op}, 'REALIZED_COST', 30000, 'EUR', 30000, '2025-07-01'),
                     (${compte.id}, ${op}, 'REALIZED_COST', 50000, 'CHF', NULL, '2025-07-02')`;
    asUser(compte);

    const s = await synthese(op);
    expect(s.netCents, 'seuls les euros connus sont comptés').toBe(30_000);
    expect(s.unconvertedCount, 'la devise sans contre-valeur est signalée, jamais convertie').toBe(1);
    // Aucun euro inventé : le montant hors EUR n'apparaît dans aucun total.
    expect(s.netCents).not.toBe(80_000);

    // Un événement de référence SANS composante et SANS fait daté : aucune rubrique de montant, aucune période.
    const nu = await operation(compte, null, { label: 'À qualifier' });
    const sNu = await synthese(nu);
    expect(sNu.netCents).toBeNull();
    expect(sNu.period).toBeNull();
    expect(sNu.documentCount).toBe(0);
    expect(sNu.agendaItemCount).toBe(0);
    expect(sNu.supplierNames).toEqual([]);
    expect((await page(nu)).fiche!.undated).toBe(true);
  });

  // ── Note libre de l'utilisateur (CDC §5, §14 ; AC42) ─────────────────────

  it('L114OK-E04 — note libre : enregistrée, rejouée sans écriture, version périmée refusée, retirée, bornée, isolée ; T3 ne la réécrit pas', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    await k.document(compte, bien.id, [cand({
      candidateKey: 'facture', typeHint: 'INTERVENTION', statusHint: 'REALIZED', summary: 'Remplacement de la chaudière',
      provider: 'Thermo Services', sourceRoleHint: 'INVOICE', targetHints: [cible(bien.id)],
      temporalHints: { realizedDate: '2025-04-02' }, financialHints: [fh('REALIZED_COST', 120_000, { economicDate: '2025-04-02' })],
    })], { type: 'INVOICE', title: 'Facture chaudière', date: '2025-04-02', amountCents: 120_000 });
    await k.passer(compte, { today: AUJ });
    const id = (await k.actives(compte)).find((o) => o.type_code === 'INTERVENTION')!.id;
    asUser(compte);

    // Aucune note au départ : la fiche le dit sans rien inventer.
    expect((await page(id)).fiche!.notes).toBeNull();
    const v0 = await version(id);
    const journalAvant = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_graph_history WHERE account_id = ${compte.id}`)[0].n;

    // 1. Enregistrée : phrase utilisateur, version avancée, texte lu par la fiche, auteur et date en base.
    const r1 = await ecrireNote(id, { notes: '  Garantie 2 ans. Contact : Pierre.  ', expectedVersion: v0 });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ ok: true, changed: true, message: REFERENCE_EVENT_SUCCESS.notes });
    expect(await version(id)).toBe(v0 + 1);
    const enBase = await noteEnBase(id);
    expect(enBase.user_notes).toBe('Garantie 2 ans. Contact : Pierre.');
    expect(enBase.auteur).toBe(compte.ownerUserId);
    expect(enBase.jour).not.toBeNull();
    const fiche = (await page(id)).fiche!;
    expect(fiche.notes).toMatchObject({ text: 'Garantie 2 ans. Contact : Pierre.' });
    expect(fiche.notes.updatedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // 2. Le JOURNAL porte l'avant et l'après (aucune autre trace nouvelle).
    const [trace] = await sql<{ action: string; reason_code: string; before_json: Json | null; after_json: Json | null }[]>`
      SELECT action, reason_code, before_json, after_json FROM business_operation_graph_history
       WHERE account_id = ${compte.id} AND operation_id = ${id} AND command = 'setOperationNotes' ORDER BY id DESC LIMIT 1`;
    expect(trace).toMatchObject({ action: 'UPDATED', reason_code: 'USER_PAGE_NOTES' });
    expect(trace.before_json!.notes).toBeNull();
    expect(trace.after_json!.notes).toBe('Garantie 2 ans. Contact : Pierre.');
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_graph_history WHERE account_id = ${compte.id}`)[0].n).toBe(journalAvant + 1);

    // 3. Le même texte rejoué : rien n'est écrit, la version ne bouge pas.
    const v1 = await version(id);
    const r2 = await ecrireNote(id, { notes: 'Garantie 2 ans. Contact : Pierre.', expectedVersion: v1 });
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ ok: true, changed: false, message: REFERENCE_EVENT_WRITE_MESSAGES.NO_CHANGE });
    expect(await version(id)).toBe(v1);

    // 4. Version PÉRIMÉE (écran resté ouvert) : refus 409, rien n'est écrit.
    const r3 = await ecrireNote(id, { notes: 'Autre texte', expectedVersion: v1 - 1 });
    expect(r3.status).toBe(409);
    expect(r3.body.message).toBe(REFERENCE_EVENT_WRITE_MESSAGES.VERSION_MISMATCH);
    expect((await noteEnBase(id)).user_notes).toBe('Garantie 2 ans. Contact : Pierre.');

    // 5. Demande illisible, texte qui n'est pas un texte, texte trop long, champ absent : 400, rien n'est écrit.
    for (const corps of [{}, { notes: 12 }, { notes: 'x'.repeat(REFERENCE_EVENT_NOTES_MAX + 1) }, { note: 'x' }, { notes: 'x', inconnu: 1 }]) {
      const r = await ecrireNote(id, corps);
      expect(r.status, JSON.stringify(corps)).toBe(400);
      // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
      expect(JSON.stringify(r.body)).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
    }
    expect((await noteEnBase(id)).user_notes).toBe('Garantie 2 ans. Contact : Pierre.');

    // 6. La note ne change AUCUN montant ni aucun nombre de la synthèse, et le coût de possession est intact.
    const tcoAvant = empreinteTco(await tco(compte, bien.id));
    const sAvecNote = await synthese(id);
    expect(sAvecNote.netCents).toBe(await k.coutNet(id));
    expect(empreinteTco(await tco(compte, bien.id))).toBe(tcoAvant);

    // 7. T3 REJOUÉ (consolidation réelle) : la note de l'utilisateur est intacte — aucun traitement ne la réécrit.
    await k.passer(compte, { today: AUJ });
    expect((await noteEnBase(id)).user_notes, 'T3 ne touche pas à la parole de l’utilisateur').toBe('Garantie 2 ans. Contact : Pierre.');
    expect((await page(id)).fiche!.notes.text).toBe('Garantie 2 ans. Contact : Pierre.');

    // 8. ISOLATION : la session d'un autre compte ne voit rien et n'écrit rien (404, jamais 403).
    asUser(autre);
    expect((await page(id)).status).toBe(404);
    const r4 = await ecrireNote(id, { notes: 'Pris en main depuis ailleurs' });
    expect(r4.status).toBe(404);
    asUser(compte);
    expect((await noteEnBase(id)).user_notes).toBe('Garantie 2 ans. Contact : Pierre.');

    // 9. RETIRÉE : vider le champ retire la note (auteur et date effacés), et la note ne revient jamais d'elle-même.
    const r5 = await ecrireNote(id, { notes: '   ', expectedVersion: await version(id) });
    expect(r5.status).toBe(200);
    expect(r5.body).toMatchObject({ ok: true, changed: true, message: REFERENCE_EVENT_SUCCESS.notesCleared });
    expect(await noteEnBase(id)).toMatchObject({ user_notes: null, jour: null, auteur: null });
    expect((await page(id)).fiche!.notes).toBeNull();
    await k.passer(compte, { today: AUJ });
    expect((await noteEnBase(id)).user_notes).toBeNull();

    // 10. AUCUN EFFET DÉRIVÉ : la note n'a créé ni événement de l'Agenda, ni rappel, ni carte, ni composante.
    const [{ agenda, rappels, cartes }] = await sql<{ agenda: number; rappels: number; cartes: number }[]>`
      SELECT (SELECT count(*)::int FROM agenda_items WHERE account_id = ${compte.id}) AS agenda,
             (SELECT count(*)::int FROM notification_outbox WHERE account_id = ${compte.id}) AS rappels,
             (SELECT count(*)::int FROM to_process_actions WHERE account_id = ${compte.id}) AS cartes`;
    expect({ rappels, cartes }).toEqual({ rappels: 0, cartes: 0 });
    expect(agenda).toBe(0);

    // 11. RECONSTRUCTION (lot 85A) : un événement de référence qui porte une note est CONSERVÉ — la parole de
    //     l’utilisateur n’est jamais effacée par une remise à plat (CDC §19 ; lecture seule de l’inventaire).
    await ecrireNote(id, { notes: 'Note à conserver même après une remise à plat', expectedVersion: await version(id) });
    const { inventoryAccount } = await import('@/services/business-operations/rebuild/purge');
    const plan = await inventoryAccount(sql, compte.id);
    expect(plan.purged, 'un événement de référence noté n’est jamais purgé').not.toContain(id);
    expect(plan.kept.find((o) => o.id === id)?.reasons, 'conservé comme décision de l’utilisateur').toContain('USER_DECISION');

    // 12. Compte en LECTURE SEULE : la route refuse (403), rien n’est écrit ; la fiche reste consultable.
    const avantLectureSeule = await noteEnBase(id);
    await sql`DELETE FROM account_subscriptions WHERE account_id = ${compte.id}`;
    const r6 = await ecrireNote(id, { notes: 'Changement interdit' });
    expect(r6.status).toBe(403);
    expect(await noteEnBase(id)).toEqual(avantLectureSeule);
    expect((await page(id)).status).toBe(200);
  });
});
