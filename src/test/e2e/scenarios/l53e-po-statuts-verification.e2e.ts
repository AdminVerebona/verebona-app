/**
 * Lot 53 (agent 53E) — retours PO D17, D19, D25, D27 sur base PostgreSQL
 * réelle (gestes de production : primitive d'agenda, routes, collecteur de
 * la mascotte, migration 0354, route BO de reprise). Aucun appel IA.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

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
vi.mock('@/services/coherence/impact-propagation.service', async (o) => ({
  ...(await o<object>()), emitAgendaItemCreated: async () => {},
}));

const jour = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

scenario('L53E', 'Statuts réels (D17, D25, D27) et vérification T1 incomplète (D19)', ({ sql, make }) => {
  it('PO-D17-E1 — suivi et fiche du bien : fait passé non confirmé VISIBLE (jamais masqué comme terminé) ; réalisé seulement si établi', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE' });
    session.currentAccountId = compte.id;
    session.userId = compte.ownerUserId;
    const { upsertAgendaItem } = await import('@/services/agenda/agenda-write-primitive');
    // Deux factures distinctes (une source chacune : deux faits distincts).
    const ecrire = async (title: string, date: string, businessType: string) => upsertAgendaItem({
      accountId: compte.id, assetId: clio.id, origin: 'AUTOMATIC', title, date, nature: 'HISTORICAL', businessType,
      category: 'information', sources: [{ fileId: (await make.assetFile(compte, { assetId: clio.id })).id, role: 'SOURCE' }], occurrenceIndex: 'single',
    });
    const reparation = await ecrire('Réparation embrayage', jour(-40), 'repair');
    const etablie = await ecrire('Remplacement pneus', jour(-90), 'repair');
    await sql`UPDATE agenda_items SET manual_status = 'realise' WHERE id = ${etablie.id}`;

    // Suivi SANS les éléments terminés : la réparation non confirmée reste affichée.
    const followup = await import('@/app/api/assets/[id]/followup/route');
    const fr = await followup.GET(new NextRequest(`http://x/api/assets/${clio.id}/followup`), { params: Promise.resolve({ id: String(clio.id) }) });
    const suivi = ((await fr.json()) as { items: Array<{ id: string; effectiveStatus: string; isDone: boolean; toConfirm: boolean }> }).items;
    expect(suivi.find((x) => x.id === String(reparation.id))).toMatchObject({ effectiveStatus: 'a_confirmer', isDone: false, toConfirm: true });
    expect(suivi.find((x) => x.id === String(etablie.id))).toBeUndefined();

    const overview = await import('@/app/api/assets/[id]/overview/route');
    const o = await overview.GET(new NextRequest(`http://x/api/assets/${clio.id}/overview`), { params: Promise.resolve({ id: String(clio.id) }) });
    const tl = ((await o.json()) as { timeline: Array<{ id: string; isDone: boolean; isOverdue: boolean; toConfirm: boolean }> }).timeline;
    expect(tl.find((x) => x.id === String(reparation.id))).toMatchObject({ isDone: false, isOverdue: false, toConfirm: true });
    expect(tl.find((x) => x.id === String(etablie.id))).toMatchObject({ isDone: true, toConfirm: false });

    // Assistant : non prouvé, jamais « réalisé » ; aucun statut écrit.
    const { getCanonicalAgendaItem } = await import('@/services/verebona-assistant/canonical/agenda');
    expect(await getCanonicalAgendaItem(compte.id, reparation.id)).toMatchObject({ status: 'not_proven', overdue: false });
    expect(await getCanonicalAgendaItem(compte.id, etablie.id)).toMatchObject({ status: 'completed' });
    expect(await sql`SELECT manual_status FROM agenda_items WHERE id = ${reparation.id}`).toEqual([{ manual_status: null }]);
  });

  it('PO-D25-E1 (revu lot 61) / PO-D27-E1 — mascotte : échéance échue ancienne, ni « Tout est à jour » ni vérification générique ; une heure ne fait pas un rendez-vous', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    // Compte déjà amorcé (un document) : pas d'étape d'accueil.
    await make.assetFile(compte, { assetId: maison.id });
    const { upsertAgendaItem } = await import('@/services/agenda/agenda-write-primitive');
    // Échéance d'action dépassée depuis 90 jours (hors fenêtre de 60 j des sujets).
    await upsertAgendaItem({
      accountId: compte.id, assetId: maison.id, origin: 'AUTOMATIC', title: 'Ramonage', date: jour(-90), nature: 'DEADLINE', businessType: 'maintenance',
      category: 'action', occurrenceIndex: 'single',
    });
    const { getMascotPresentation } = await import('@/services/home/mascot/mascot.service');
    const { composeSpeech } = await import('@/services/home/mascot/bubble');
    const p = await getMascotPresentation(compte.id, 'display');
    // Lot 61 (T6) : le compteur reste une donnée de supervision ; une date
    // dépassée n'établit aucune action — ni phrase générique, ni « Tout est à jour ».
    expect(p.overdueDeadlines).toBe(1);
    const t = composeSpeech({ presentation: p, empty: false }).text;
    expect(t).not.toContain('Des échéances dépassées sont à vérifier');
    expect(t).not.toMatch(/Tout est à jour|Aucune échéance dépassée|urgen/i);

    // D27 : échéance automatique AVEC heure → « à prévoir », jamais « prévu le ».
    const ct = await upsertAgendaItem({
      accountId: compte.id, assetId: maison.id, origin: 'AUTOMATIC', title: 'Contrôle chaudière', date: jour(30), nature: 'DEADLINE', businessType: 'maintenance',
      category: 'action', occurrenceIndex: 'single',
    });
    await sql`UPDATE agenda_items SET start_time = '14:00' WHERE id = ${ct.id}`;
    const { collectMascotData } = await import('@/services/home/mascot/collector');
    const raw = await collectMascotData(compte.id);
    expect(raw.agenda?.find((i) => i.id === ct.id)?.dateRole).toBe('DEADLINE');
    // Assistant : même règle.
    const { getCanonicalAgendaItem } = await import('@/services/verebona-assistant/canonical/agenda');
    expect((await getCanonicalAgendaItem(compte.id, ct.id))?.dateRole).toBe('DEADLINE');
  });

  it('PO-D19-E1 — migration 0354 : contrainte élargie, lignes non vérifiables requalifiées (date intacte), rejouable', async () => {
    const compte = await make.account();
    const fichier = async () => (await make.assetFile(compte)).id;
    const [image, partiel, manquant, verifie] = [await fichier(), await fichier(), await fichier(), await fichier()];
    const ligne = (fileId: number, sv: string, verif: Record<string, unknown>) => sql`
      INSERT INTO document_extraction_coverage (file_id, account_id, total_units, covered_units, quality_state, anomalies, source_verification, verification, updated_at)
      VALUES (${fileId}, ${compte.id}, 0, 0, 'COMPLETE_WITH_UNRESOLVED', '{PAGE_UNVERIFIED}', ${sv}, ${JSON.stringify(verif)}::jsonb, '2026-01-02T03:04:05Z')`;
    await ligne(image, 'UNVERIFIABLE', { verificationReason: 'image_not_checkable' });
    await ligne(partiel, 'PARTIAL', { pagesMissing: [], pagesUnverified: [3] });
    await ligne(manquant, 'PARTIAL', { pagesMissing: [4], pagesUnverified: [] });
    await ligne(verifie, 'VERIFIED', {});
    // Lignes remises dans l'état d'avant la migration : on la rejoue (deux passes).
    const texte = await readFile(join(process.cwd(), 'src/db/migrations/0354_t1_verification_incomplete.sql'), 'utf-8');
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `passe ${passe}`).resolves.toBeDefined();
    } finally {
      cnx.release();
    }
    const etat = async (id: number) => (await sql<{ q: string; a: string[]; u: string }[]>`
      SELECT quality_state AS q, anomalies AS a, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS u FROM document_extraction_coverage WHERE file_id = ${id}`)[0];
    expect(await etat(image)).toEqual({ q: 'VERIFICATION_INCOMPLETE', a: ['PAGE_UNVERIFIED', 'COVERAGE_UNVERIFIED'], u: '2026-01-02' });
    expect((await etat(partiel)).q).toBe('VERIFICATION_INCOMPLETE');
    expect((await etat(manquant)).q).toBe('COMPLETE_WITH_UNRESOLVED');
    expect((await etat(verifie)).q).toBe('COMPLETE_WITH_UNRESOLVED');
    await expect(sql`UPDATE document_extraction_coverage SET quality_state = 'N_IMPORTE' WHERE file_id = ${verifie}`).rejects.toThrow(/quality_chk/);
  });

  it('PO-D19-E2 — BO : reprise manuelle d’une vérification incomplète (mise en file T1 technique, tracée) ; refusée pour un autre état', async () => {
    const admin = await make.user({ role: 'ADMIN' });
    session.userId = admin.id;
    const compte = await make.account();
    const f = await make.assetFile(compte, { mimeType: 'image/jpeg' });
    const autre = await make.assetFile(compte);
    await sql`INSERT INTO document_extraction_coverage (file_id, account_id, total_units, covered_units, quality_state, anomalies, source_verification, verification)
              VALUES (${f.id}, ${compte.id}, 0, 0, 'VERIFICATION_INCOMPLETE', '{COVERAGE_UNVERIFIED}', 'UNVERIFIABLE', ${JSON.stringify({ verificationReason: 'image_not_checkable' })}::jsonb),
                     (${autre.id}, ${compte.id}, 0, 0, 'COMPLETE', '{}', 'VERIFIED', NULL)`;
    const route = await import('@/app/api/admin/ai/t1-completeness/retry/route');
    const post = (fileId: unknown) => route.POST(new NextRequest('http://localhost/api/admin/ai/t1-completeness/retry', {
      method: 'POST', body: JSON.stringify({ fileId }), headers: { 'content-type': 'application/json' },
    }));
    const r = await post(f.id);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
    const [cov] = await sql<{ r: string; n: number; next: string | null }[]>`
      SELECT last_retry_result AS r, retry_attempts AS n, next_retry_at AS next FROM document_extraction_coverage WHERE file_id = ${f.id}`;
    expect(cov).toMatchObject({ r: 'REQUEUED_T1_ADMIN', n: 1, next: null });
    expect((await post(autre.id)).status).toBe(409);
    expect((await post('x')).status).toBe(400);

    // Vue BO : motif, pages, prochaine action calculables depuis la ligne.
    const { getT1CompletenessOverview } = await import('@/services/ai/source-analysis/source-units/monitoring');
    const ov = await getT1CompletenessOverview({ days: 7, limit: 200 });
    expect(ov.byQuality.VERIFICATION_INCOMPLETE).toBeGreaterThanOrEqual(1);
    expect(ov.rows.find((x) => x.fileId === f.id)).toMatchObject({ qualityState: 'VERIFICATION_INCOMPLETE', lastRetryResult: 'REQUEUED_T1_ADMIN' });
  });
});
