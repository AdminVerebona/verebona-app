/**
 * Lot 113P (#715, décision PO du 06/11/2026) — Agenda SANS statut
 * d'événement, sur PostgreSQL 16 réel.
 *
 *   L113P-E01  lectures (Agenda, fiche, recherche, accueil, Timeline, ICS, assistant) : aucun statut, passé visible à sa date
 *   L113P-E02  migration 1526 : archivage réversible, protection conservée, neutralisation, déclencheur, idempotence
 *   L113P-E03  migration 1527 : cartes AGENDA-DONE / AGENDA-NOT-DONE ouvertes closes et tracées ; aucune nouvelle carte
 *   L113P-E04  suppression utilisateur : trace d'exclusion, la réanalyse T4 ne ressuscite rien ; recréation manuelle possible
 *   L113P-E05  récurrence : supprimer CETTE occurrence ou TOUTE la série (choix explicite)
 *   L113P-E06  « Échéance assurance APRIL Moto » passée : ni confirmation de réalisation, ni relance, ni retard
 *
 * Chaînes de PRODUCTION (routes, services, migrations rejouées) ; seules la
 * session et les notifications sont simulées. Aucun appel IA.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AgendaDecision } from '@/services/ai/agenda';

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
vi.mock('@/lib/notifications', async (o) => ({ ...(await o<object>()), emit: async () => {} }));
vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/ai/reconciliation/coherence-impact', () => ({ hasCoherenceImpact: async () => false }));

const jour = (decalage: number) => { const d = new Date(); d.setDate(d.getDate() + decalage); return d.toISOString().slice(0, 10); };
const PASSE = jour(-200);
const FUTUR = jour(40);
/** Clés de statut retirées du contrat (#715). */
const STATUTAIRE = /"(effectiveStatus|manualStatus|automaticStatus|isOverdue|isDone|toConfirm|overdue|status4)"/;
const migration = (n: string) => readFileSync(join(process.cwd(), 'src/db/migrations', n), 'utf8');

const echeance = (fileId: number, date: string, over: Partial<AgendaDecision> = {}): AgendaDecision => ({
  action: 'create', title: 'Contrôle technique', date, category: 'action', confidence: 'certain',
  reasonCode: 'E2E', deterministic: true, sourceFileId: fileId, originFieldKey: 'technicalInspectionDueDate', ...over,
});

scenario('L113P', 'Agenda sans statut d’événement (#715)', ({ sql, make }) => {
  const as = (c: AccountRow) => { session.userId = c.ownerUserId; session.currentAccountId = c.id; };
  const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

  async function supprimer(id: number, serie = false) {
    const { DELETE } = await import('@/app/api/agenda/[id]/route');
    const res = await DELETE(new NextRequest(`http://localhost/api/agenda/${id}${serie ? '?scope=series' : ''}`, { method: 'DELETE' }), ctx(id));
    return { status: res.status, body: await res.json() as { deletedIds?: number[] } };
  }
  const existe = async (id: number) => (await sql`SELECT 1 FROM agenda_items WHERE id = ${id}`).length === 1;
  const itemsDuBien = async (assetId: number) => sql<{ id: number; d: string; title: string }[]>`
    SELECT i.id, i.start_date::text AS d, i.title FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id
     WHERE l.asset_id = ${assetId} ORDER BY i.start_date, i.id`;

  it('L113P-E01 — lectures : passé et futur visibles à leur date, AUCUN statut (Agenda, fiche, recherche, accueil, Timeline, ICS, assistant)', async () => {
    const compte = await make.account({ plan: 'premium' });
    as(compte);
    const bien = await make.asset(compte, { name: 'Moto' });
    const passe = await make.agendaItem(compte, { title: 'Révision moto', startDate: PASSE, assetIds: [bien.id] });
    const futur = await make.agendaItem(compte, { title: 'Révision moto', startDate: FUTUR, assetIds: [bien.id] });

    const { getAgendaItems, getAgendaItemById, searchAgendaItems, getHomepageAgendaItems } = await import('@/services/agenda/AgendaQueryService');
    const liste = await getAgendaItems({ accountId: compte.id, period: 'all' } as never);
    for (const id of [passe.id, futur.id]) {
      const i = liste.find((x) => x.id === id);
      expect(i, 'visible dans l’Agenda').toBeDefined();
      expect(JSON.stringify(i)).not.toMatch(STATUTAIRE);
      expect(i!.attentionFlags).not.toContain('en_retard');
      expect(JSON.stringify(await getAgendaItemById(id, compte.id))).not.toMatch(STATUTAIRE);
    }
    expect(JSON.stringify(await searchAgendaItems('Révision', compte.id))).not.toMatch(STATUTAIRE);
    // Accueil : l'à-venir seulement — une date passée n'est jamais « en retard ».
    const accueil = (await getHomepageAgendaItems(compte.id)).map((i) => i.id);
    expect(accueil).not.toContain(passe.id);

    // Route de la fiche (tiroir) : ni statut, ni ancien sélecteur.
    const { GET } = await import('@/app/api/agenda/[id]/route');
    const fiche = await GET(new NextRequest(`http://localhost/api/agenda/${passe.id}`), ctx(passe.id));
    expect(fiche.status).toBe(200);
    expect(JSON.stringify(await fiche.json())).not.toMatch(STATUTAIRE);

    // Timeline du bien : les deux événements, neutres.
    const { readAssetTimelineAll } = await import('@/services/agenda/timeline/read');
    const tl = await readAssetTimelineAll({ accountId: compte.id, assetId: bien.id, today: jour(0) });
    const vus = JSON.stringify(tl);
    expect(vus).toContain(String(passe.id));
    expect(vus).toContain(String(futur.id));
    expect(vus).not.toMatch(STATUTAIRE);

    // ICS : le passé reste exporté, sans préfixe d'état.
    const { computeICSContent } = await import('@/services/agenda/AgendaCalendarExportService');
    const ics = computeICSContent(liste.filter((x) => x.id === passe.id || x.id === futur.id), 'Verebona');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).not.toMatch(/🕒|Réalisé|Annulé|Date échue/);

    // Assistant (lecture canonique) : la date, jamais un statut.
    const { getCanonicalAgendaItem } = await import('@/services/verebona-assistant/canonical/agenda');
    expect(JSON.stringify(await getCanonicalAgendaItem(compte.id, passe.id))).not.toMatch(STATUTAIRE);

    // Ancien écran (cache PWA) : la route de statut ne modifie plus rien.
    const { PATCH } = await import('@/app/api/agenda/[id]/statut/route');
    expect((await PATCH(new NextRequest(`http://localhost/api/agenda/${passe.id}/statut`, { method: 'PATCH', body: JSON.stringify({ manualStatus: 'realise' }) }))).status).toBe(410);
    expect((await sql`SELECT manual_status AS s FROM agenda_items WHERE id = ${passe.id}`)[0].s).toBeNull();
  });

  it('L113P-E02 — migration 1526 : archivage réversible, protection du geste utilisateur, neutralisation, déclencheur, idempotence', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const f = await make.assetFile(compte, { assetId: bien.id });
    // Données d'AVANT le lot 113P : déclencheur suspendu le temps de les écrire (base propre au fichier,
    // instructions hors transaction : les contraintes différées d'agenda_items interdisent l'ALTER en cours de transaction).
    await sql`ALTER TABLE agenda_items DISABLE TRIGGER agenda_items_manual_status_obsolete`;
    const ligne = async (title: string, auto: boolean, statut: string) => (await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, manual_status, completion_proof_file_id)
      VALUES (${compte.id}, ${title}, ${PASSE}, ${auto}, ${statut}, ${statut === 'realise' ? f.id : null}) RETURNING id`)[0].id;
    let ids: { systeme: number; utilisateur: number; manuel: number };
    try {
      ids = {
        systeme: await ligne('Réalisé par le système', true, 'realise'),
        utilisateur: await ligne('Annulé par l’utilisateur', true, 'annule'),
        manuel: await ligne('Réalisé, saisi à la main', false, 'realise'),
      };
    } finally {
      await sql`ALTER TABLE agenda_items ENABLE TRIGGER agenda_items_manual_status_obsolete`;
    }
    await sql`INSERT INTO agenda_occurrence_events (agenda_item_id, account_id, event_type, detail_json)
              VALUES (${ids.systeme}, ${compte.id}, 'STATUS_AUTO_COMPLETED', '{"origin":"AI"}'::jsonb)`;
    const liensAvant = await sql`SELECT agenda_item_id, asset_file_id FROM agenda_file_links WHERE agenda_item_id IN ${sql([ids.systeme, ids.utilisateur, ids.manuel])} ORDER BY 1, 2`;

    const sqlMigration = migration('1526_l113p_agenda_statut_neutralise.sql');
    await sql.begin((tx) => tx.unsafe(sqlMigration));
    await sql.begin((tx) => tx.unsafe(sqlMigration)); // rejouable

    const etat = async (id: number) => (await sql<{ s: string | null; mod: boolean; d: string; proof: number | null }[]>`
      SELECT manual_status AS s, is_automatic_modified AS mod, start_date::text AS d, completion_proof_file_id AS proof FROM agenda_items WHERE id = ${id}`)[0];
    const archives = async (id: number) => sql<{ d: Record<string, unknown> }[]>`
      SELECT detail_json AS d FROM agenda_occurrence_events WHERE agenda_item_id = ${id} AND event_type = 'LEGACY_STATUS_ARCHIVED'`;

    expect(await etat(ids.systeme)).toMatchObject({ s: null, mod: false, d: PASSE });
    expect(await etat(ids.utilisateur)).toMatchObject({ s: null, mod: true, d: PASSE });
    expect(await etat(ids.manuel)).toMatchObject({ s: null, d: PASSE });
    const [a1] = await archives(ids.systeme);
    expect(await archives(ids.systeme)).toHaveLength(1);
    expect(a1.d).toMatchObject({ manualStatus: 'realise', isAutomaticModifiedBefore: false, userGesture: false, completionProofFileId: f.id, migration: '1526' });
    expect((await archives(ids.utilisateur))[0].d).toMatchObject({ manualStatus: 'annule', userGesture: true });
    // « Réalisé » n'est JAMAIS converti en preuve : aucun lien document créé, aucune Opération touchée.
    expect(await sql`SELECT agenda_item_id, asset_file_id FROM agenda_file_links WHERE agenda_item_id IN ${sql([ids.systeme, ids.utilisateur, ids.manuel])} ORDER BY 1, 2`).toEqual(liensAvant);
    expect(await sql`SELECT 1 FROM business_operations WHERE account_id = ${compte.id}`).toHaveLength(0);
    // L'« annulé » d'hier redevient visible à sa date.
    const { getAgendaItems } = await import('@/services/agenda/AgendaQueryService');
    expect((await getAgendaItems({ accountId: compte.id, period: 'all' } as never)).map((i) => i.id)).toContain(ids.utilisateur);

    // Déclencheur : tout écrivain ancien est ramené à NULL (insertion et mise à jour).
    await sql`UPDATE agenda_items SET manual_status = 'realise' WHERE id = ${ids.manuel}`;
    expect((await etat(ids.manuel)).s).toBeNull();
    const [{ id: neuf }] = await sql<{ id: number }[]>`INSERT INTO agenda_items (account_id, title, start_date, manual_status) VALUES (${compte.id}, 'Ancien client', ${FUTUR}, 'annule') RETURNING id`;
    expect((await etat(neuf)).s).toBeNull();

    // Retour arrière documenté (en-tête) : réversible depuis l'archive — vérifié dans une transaction annulée.
    await sql.begin(async (tx) => {
      await tx`DROP TRIGGER IF EXISTS agenda_items_manual_status_obsolete ON agenda_items`;
      await tx`UPDATE agenda_items i SET manual_status = e.detail_json ->> 'manualStatus'
                 FROM agenda_occurrence_events e WHERE e.agenda_item_id = i.id AND e.event_type = 'LEGACY_STATUS_ARCHIVED' AND i.id = ${ids.utilisateur}`;
      expect((await tx`SELECT manual_status AS s FROM agenda_items WHERE id = ${ids.utilisateur}`)[0].s).toBe('annule');
      throw new Error('ROLLBACK');
    }).catch((e: Error) => { if (e.message !== 'ROLLBACK') throw e; });
    expect((await etat(ids.utilisateur)).s).toBeNull();
  });

  it('L113P-E03 — migration 1527 : cartes de statut ouvertes closes et tracées ; aucune nouvelle carte de statut', async () => {
    const compte = await make.account();
    const item = await make.agendaItem(compte, { title: 'Entretien chaudière', startDate: PASSE });
    const [{ id: carte }] = await sql<{ id: number }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question)
      VALUES (${compte.id}, 'AGENDA_ITEM', ${item.id}, 'manualStatus', 'ARBITRATE', 'AGENDA-DONE', 'Cette échéance a-t-elle été réalisée ?') RETURNING id`;
    await sql.begin((tx) => tx.unsafe(migration('1527_l113p_cartes_statut_agenda_closes.sql')));
    await sql.begin((tx) => tx.unsafe(migration('1527_l113p_cartes_statut_agenda_closes.sql')));
    expect((await sql`SELECT resolved_at IS NOT NULL AS clos, resolution_reason AS r FROM to_process_actions WHERE id = ${carte}`)[0]).toEqual({ clos: true, r: 'OBSOLETE' });
    const evs = await sql<{ details: Record<string, unknown> }[]>`SELECT details FROM to_process_action_events WHERE action_id = ${carte} AND event = 'OBSOLETE'`;
    expect(evs).toHaveLength(1);
    expect(evs[0].details).toMatchObject({ ruleCode: 'AGENDA-DONE', reason: 'EVENT_STATUS_RETIRED', migration: '1527' });

    const { produceAgendaActions } = await import('@/services/to-process/producers.service');
    await produceAgendaActions(compte.id);
    expect(await sql`SELECT 1 FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code IN ('AGENDA-DONE', 'AGENDA-NOT-DONE') AND resolved_at IS NULL`).toHaveLength(0);
  });

  it('L113P-E04 — suppression utilisateur : trace d’exclusion ; la réanalyse T4 ne recrée pas l’événement ; recréation MANUELLE possible', async () => {
    const compte = await make.account({ plan: 'premium' });
    as(compte);
    const bien = await make.asset(compte, { category: 'VEHICULE' });
    const doc = await make.assetFile(compte, { assetId: bien.id });
    const { persistAgendaDecisions } = await import('@/services/agenda/agenda-persistence');
    await persistAgendaDecisions([echeance(doc.id, FUTUR)], compte.id, bien.id);
    const [cree] = await itemsDuBien(bien.id);
    expect(cree).toMatchObject({ d: FUTUR, title: 'Contrôle technique' });

    const r = await supprimer(cree.id);
    expect(r).toEqual({ status: 200, body: { success: true, deletedIds: [cree.id] } });
    expect(await existe(cree.id)).toBe(false);
    const [trace] = await sql<{ reason: string; fk: string | null; snap: Record<string, unknown> }[]>`
      SELECT reason, functional_key AS fk, item_snapshot AS snap FROM agenda_item_removals WHERE agenda_item_id = ${cree.id}`;
    expect(trace.reason).toBe('USER_DELETED');
    expect(trace.fk).toBeTruthy();
    expect(trace.snap).toMatchObject({ deleted_by_user_id: compte.ownerUserId });

    // Réanalyses (même document, même décision ; puis une seconde fois) : jamais ressuscité.
    await persistAgendaDecisions([echeance(doc.id, FUTUR)], compte.id, bien.id);
    await persistAgendaDecisions([echeance(doc.id, FUTUR)], compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
    expect(await itemsDuBien(bien.id)).toEqual([]);
    expect(await sql`SELECT 1 FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'AGENDA-PROPOSAL' AND resolved_at IS NULL`).toHaveLength(0);

    // Même événement (même document, même champ) annoncé à une autre date : toujours le MÊME événement — non recréé.
    await persistAgendaDecisions([echeance(doc.id, jour(400))], compte.id, bien.id);
    expect(await itemsDuBien(bien.id)).toEqual([]);
    // Événement DISTINCT (autre champ d'origine, autre sujet) : non bloqué.
    await persistAgendaDecisions([echeance(doc.id, jour(400), { title: 'Échéance assurance', originFieldKey: 'insuranceExpiry' })], compte.id, bien.id);
    expect((await itemsDuBien(bien.id)).map((x) => x.title)).toEqual(['Échéance assurance']);

    // Recréation explicite par l'utilisateur : toujours possible.
    const { createAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    const manuel = await createAgendaItem({ title: 'Contrôle technique', startDate: FUTUR, assetIds: [bien.id], homeCategory: 'action' }, compte.id, compte.ownerUserId);
    expect(await existe(manuel.id)).toBe(true);
  });

  it('L113P-E05 — récurrence : « Supprimer cet événement uniquement » ou « Supprimer toute la série »', async () => {
    const compte = await make.account();
    as(compte);
    const bien = await make.asset(compte);
    const serie = async (cle: string) => {
      const out: number[] = [];
      for (const [d, nature] of [[jour(10), 'CONFIRMED'], [jour(375), 'FORECAST'], [jour(740), 'FORECAST']] as const) {
        const [{ id }] = await sql<{ id: number }[]>`
          INSERT INTO agenda_items (account_id, title, start_date, is_automatic, series_key, occurrence_nature, home_category)
          VALUES (${compte.id}, 'Entretien chaudière', ${d}, true, ${cle}, ${nature}, 'action') RETURNING id`;
        await sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${id}, ${bien.id})`;
        out.push(id);
      }
      return out;
    };
    const a = await serie('e2e-113p-a');
    const b = await serie('e2e-113p-b');

    // Une occurrence : les autres restent.
    expect((await supprimer(a[1])).body.deletedIds).toEqual([a[1]]);
    expect(await Promise.all(a.map(existe))).toEqual([true, false, true]);
    // Toute la série.
    const r = await supprimer(b[0], true);
    expect([...(r.body.deletedIds ?? [])].sort((x, y) => x - y)).toEqual([...b].sort((x, y) => x - y));
    expect(await Promise.all(b.map(existe))).toEqual([false, false, false]);
    const traces = await sql<{ reason: string }[]>`SELECT reason FROM agenda_item_removals WHERE agenda_item_id IN ${sql(b)}`;
    expect(traces.map((t) => t.reason)).toEqual(['USER_DELETED_SERIES', 'USER_DELETED_SERIES', 'USER_DELETED_SERIES']);

    // Règle de blocage, sur la base réelle.
    const { userDeletionBlocks } = await import('@/services/agenda/agenda-user-deletion');
    expect(await userDeletionBlocks(compte.id, { seriesKey: 'e2e-113p-b', occurrenceNature: 'FORECAST' })).toBe('USER_DELETED_SERIES');
    // Série dont UNE occurrence a été supprimée : une nouvelle prévision n'est pas bloquée.
    expect(await userDeletionBlocks(compte.id, { seriesKey: 'e2e-113p-a', occurrenceNature: 'FORECAST' })).toBeNull();
    // Autre compte : jamais concerné.
    expect(await userDeletionBlocks((await make.account()).id, { seriesKey: 'e2e-113p-b', occurrenceNature: 'FORECAST' })).toBeNull();
  });

  it('L113P-E06 — « Échéance assurance APRIL Moto » passée : ni « C’est fait ? », ni relance, ni retard ; date modifiable', async () => {
    const compte = await make.account({ plan: 'premium' });
    as(compte);
    const moto = await make.asset(compte, { category: 'VEHICULE', name: 'Moto' });
    const doc = await make.assetFile(compte, { assetId: moto.id });
    const { persistAgendaDecisions } = await import('@/services/agenda/agenda-persistence');
    await persistAgendaDecisions([echeance(doc.id, PASSE, { title: 'Échéance assurance APRIL Moto', originFieldKey: 'insuranceExpiry', category: 'action' })], compte.id, moto.id);
    const [april] = await itemsDuBien(moto.id);
    expect(april).toMatchObject({ title: 'Échéance assurance APRIL Moto', d: PASSE });

    // « À traiter » : aucune demande de confirmation de réalisation.
    const { produceAgendaActions } = await import('@/services/to-process/producers.service');
    await produceAgendaActions(compte.id);
    const cartes = await sql<{ rule_code: string }[]>`SELECT rule_code FROM to_process_actions WHERE account_id = ${compte.id} AND target_type = 'AGENDA_ITEM' AND target_id = ${april.id} AND resolved_at IS NULL`;
    expect(cartes.map((c) => c.rule_code)).not.toEqual(expect.arrayContaining(['AGENDA-DONE']));
    expect(cartes.map((c) => c.rule_code)).not.toEqual(expect.arrayContaining(['AGENDA-NOT-DONE']));

    // Mascotte : ni « dépassée », ni tuile « C'est fait ? ».
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const { buildCandidates } = await import('@/services/home/mascot/signals');
    const raw = await collectMascotData(compte.id);
    expect((raw.overdueAgenda ?? []).map((r) => r.id)).not.toContain(april.id);
    expect(JSON.stringify(buildCandidates(raw))).not.toMatch(/EXT-ACTION|C’est fait|C'est fait/);
    // Revalidation au clic : l'événement existe, il est ouvrable.
    const { checkTarget } = await import('@/services/home/mascot/actions.service');
    expect(await checkTarget(compte.id, { kind: 'drawer', drawer: 'echeance', id: april.id } as never)).toBe('ok');

    // Bloc « Rappels sur l'accueil » : date passée → aucun rappel.
    const { getT6ReminderState } = await import('@/services/home/mascot/t6-reminders.service');
    const etat = await getT6ReminderState({ accountId: compte.id, userId: compte.ownerUserId, agendaItemId: april.id });
    expect('relevance' in etat ? etat.relevance : null).toMatchObject({ visible: false, reason: 'PAST_DATE' });

    // Date modifiée par l'utilisateur (nouvelle échéance) : de nouveau à venir, sans statut.
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    const maj = await updateAgendaItem(april.id, { startDate: FUTUR }, compte.id, compte.ownerUserId);
    expect(maj.startDate?.slice(0, 10)).toBe(FUTUR);
    expect(JSON.stringify(maj)).not.toMatch(STATUTAIRE);
    const { getHomepageAgendaItems } = await import('@/services/agenda/AgendaQueryService');
    expect(JSON.stringify(await getHomepageAgendaItems(compte.id))).not.toMatch(STATUTAIRE);
  });
});
