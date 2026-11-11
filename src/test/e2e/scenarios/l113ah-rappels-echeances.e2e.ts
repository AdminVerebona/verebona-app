/**
 * Lot 113AH (#732) — rappels d'échéance J−7 et rattrapage, sur PostgreSQL 16
 * réel : vraie migration 1625, vrais chemins d'écriture (agenda manuel,
 * primitive T4, écriture de projection, écriture directe hors primitive),
 * vrai moteur de notifications (emit / outbox / dispatcher / préférences /
 * cloche / e-mail simulé / push mobile simulé), horloge SIMULÉE
 * (`vi.setSystemTime`, Date seule) en heure de Paris.
 *
 * Tableau de recette §5 du ticket, un test par ligne :
 *   R01 création à 11 h 30 pour J+7 → pris en charge sans attendre le lendemain
 *   R02 création à 9 h après le passage de 8 h 30 (premier rappel préparé pour
 *       la même date) → le nouveau est notifié, le premier jamais renvoyé
 *   R03 création à J+6 / J+2 / J+1 (et J+0) → délai réel exact, jamais « dans 7 jours »
 *   R04 connu à J+8, passage quotidien à J+7 → un seul rappel normal
 *   R05 date déplacée de J+20 vers J+5 → rappel ; sauvegardes répétées : aucun doublon
 *   R06 date déplacée / événement supprimé avant l'envoi différé → pas de rappel périmé
 *   R07 événement passé, sans date, « information » → aucun rappel
 *   R08 deux événements même date, puis un troisième après l'émission → chacun une fois
 *   R09 relance simultanée, crash entre mise en file et livraison, reprise → ni perte ni doublon
 *   R10 préférences désactivées, compte restreint, Duo à préférences différentes
 *   R11 changement d'heure été / hiver, passage de minuit
 *   R12 création par T4 / projection / saisie manuelle / écriture directe → même garantie
 *   R13 déploiement : un rappel déjà envoyé par l'ancien mécanisme n'est pas renvoyé ;
 *       anti-rafale après changement de date ; écriture la nuit → rattrapée à 8 h 30
 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

const etat = vi.hoisted(() => {
  process.env.RESEND_API_KEY = 're_e2e_simule';
  return { mails: [] as Array<{ to: string | string[]; subject?: string }>, pushes: [] as Array<{ token: string }>, n: 0 };
});
afterAll(async () => {
  delete process.env.RESEND_API_KEY;
  const { setMobilePushProviderForTests } = await import('@/lib/mobile/push-provider');
  setMobilePushProviderForTests(undefined);
});
vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (p: { to: string; subject?: string }) => {
        etat.mails.push(p);
        etat.n += 1;
        return { data: { id: `em_l113ah_${etat.n}` }, error: null };
      },
    };
  },
}));
const fournisseurPush = {
  name: 'fake-l113ah',
  async send(m: { token: string }) {
    etat.pushes.push({ token: m.token });
    return { ok: true as const, messageId: `projects/e2e/messages/${etat.pushes.length}` };
  },
};

/** Instant Europe/Paris → Date (hiver UTC+1 sauf indication). */
const paris = (iso: string, offset = '+01:00') => new Date(`${iso}${offset}`);
const DAY = '2026-11-03'; // mardi (hiver)
const plus = (d: string, n: number) => {
  const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10);
};

scenario('L113AH', 'Rappels d’échéance : couverture par événement, rattrapage après 11 h, délai réel', ({ sql, make }) => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { setMobilePushProviderForTests } = await import('@/lib/mobile/push-provider');
    setMobilePushProviderForTests(fournisseurPush as never);
    await sql`INSERT INTO email_settings (id, emails_enabled, sender_name, sender_email, reply_to_email)
              VALUES (1, true, 'Verebona', 'bonjour@verebona.com', 'support@verebona.com')
              ON CONFLICT (id) DO UPDATE SET emails_enabled = true`;
  });
  afterEach(() => { vi.useRealTimers(); });

  const horloge = (d: Date) => vi.setSystemTime(d);

  async function telephone(userId: number, accountId: number) {
    const { registerPushInstallation } = await import('@/lib/mobile/push-installations');
    const jeton = `l113ah-${userId}-${'x'.repeat(30)}`;
    await registerPushInstallation({ userId, accountId, sessionId: null, installationId: crypto.randomUUID(),
      platform: 'ios', appVersion: '1.0.0', build: '1', pushToken: jeton });
    return jeton;
  }
  async function compte(opts: { duo?: boolean; plan?: 'premium' | null } = {}) {
    const acc = await make.account({ plan: opts.plan === null ? null : 'premium' });
    const [owner] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${acc.ownerUserId}`;
    const a = { id: acc.ownerUserId, email: owner.email, jeton: await telephone(acc.ownerUserId, acc.id) };
    let b: typeof a | null = null;
    if (opts.duo) {
      const u = await make.user();
      await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${acc.id}, ${u.id}, 'member', 'active')`;
      b = { id: u.id, email: u.email, jeton: await telephone(u.id, acc.id) };
    }
    return { id: acc.id, ownerUserId: acc.ownerUserId, a, b };
  }
  async function pref(userId: number, channel: 'email' | 'push', enabled: boolean) {
    await sql`INSERT INTO notification_preferences (user_id, category, delivery_mode, channel, enabled)
              VALUES (${userId}, 'deadlines', 'immediate', ${channel}, ${enabled})
              ON CONFLICT (user_id, category, delivery_mode, channel) DO UPDATE SET enabled = EXCLUDED.enabled`;
  }

  /** Saisie MANUELLE (agenda, même service que l'interface). */
  async function saisir(c: { id: number; ownerUserId: number }, date: string | null, over: { title?: string; category?: 'action' | 'information'; time?: string } = {}) {
    const { createAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    const it = await createAgendaItem({
      title: over.title ?? `Échéance ${date}`, startDate: date, startTime: over.time ?? null,
      homeCategory: over.category ?? 'action',
    } as never, c.id, c.ownerUserId);
    return it.id;
  }
  async function deplacer(c: { id: number; ownerUserId: number }, itemId: number, date: string, title?: string) {
    const { updateAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    await updateAgendaItem(itemId, { startDate: date, ...(title ? { title } : {}) } as never, c.id, c.ownerUserId);
  }
  async function supprimer(c: { id: number; ownerUserId: number }, itemId: number) {
    const { deleteAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    await deleteAgendaItem(itemId, c.id, c.ownerUserId);
  }
  async function passage(now: Date) {
    horloge(now);
    const { runDeadlineReminders } = await import('@/lib/notifications/scheduled/deadlines');
    return runDeadlineReminders(now);
  }
  /** Le dispatcher (tâche `notifications-dispatch`), à l'instant simulé. */
  async function envoyer(now?: Date) {
    if (now) horloge(now);
    const { processPending } = await import('@/lib/notifications');
    for (let i = 0; i < 20; i++) if ((await processPending(100)).claimed === 0) break;
  }
  const couverture = (accountId: number) => sql<{ agenda_item_id: number; recipient_user_id: number; due: string; state: string; outcome: string | null; trigger: string; days_before: number }[]>`
    SELECT agenda_item_id, recipient_user_id, to_char(due_date, 'YYYY-MM-DD') AS due, state, outcome, trigger, days_before
      FROM agenda_deadline_reminders WHERE account_id = ${accountId} ORDER BY agenda_item_id, recipient_user_id, due_date`;
  const rappels = (accountId: number, userId?: number) => sql<{ id: string; status: string; outcome_reason: string | null; payload: { count: number; date: string; agendaItemIds: number[]; daysUntil?: number; forecastCount?: number }; recipient_user_id: number }[]>`
    SELECT id, status, outcome_reason, payload_json AS payload, recipient_user_id FROM notification_outbox
     WHERE account_id = ${accountId} AND event_type = 'DEADLINE_DUE_IN_7_DAYS'
       AND (${userId ?? null}::int IS NULL OR recipient_user_id = ${userId ?? null}::int)
     ORDER BY created_at, id`;
  const cloches = (userId: number) => sql<{ title: string; body: string; href: string | null }[]>`
    SELECT title, body, href FROM notifications WHERE user_id = ${userId} AND type = 'DEADLINE_DUE_IN_7_DAYS' ORDER BY id`;
  const livraisons = (outboxId: string) => sql<{ channel: string; status: string }[]>`
    SELECT channel, status FROM notification_deliveries WHERE outbox_id = ${outboxId}::uuid ORDER BY channel`;

  it('R01 — création à 11 h 30 pour une échéance à J+7 : prise en charge immédiate (envoi différé de 2 min), sans attendre le lendemain', async () => {
    const c = await compte();
    horloge(paris(`${DAY}T11:30:00`));
    const item = await saisir(c, plus(DAY, 7));
    const cov = await couverture(c.id);
    expect(cov).toEqual([expect.objectContaining({ agenda_item_id: item, recipient_user_id: c.a.id, due: plus(DAY, 7), state: 'pending', trigger: 'WRITE', days_before: 7 })]);
    const [due] = await sql<{ s: Date }[]>`SELECT scheduled_for AS s FROM notification_outbox WHERE account_id = ${c.id}`;
    expect(new Date(due.s).toISOString()).toBe(paris(`${DAY}T11:32:00`).toISOString()); // envoi différé de 2 min
    await envoyer(paris(`${DAY}T11:33:00`));
    const [r] = await rappels(c.id);
    expect(r.status).toBe('sent');
    expect(await cloches(c.a.id)).toEqual([{ title: 'Échéance dans 7 jours', body: 'Une action est à prévoir dans Verebona.', href: `/agenda?date=${plus(DAY, 7)}` }]);
    expect((await couverture(c.id))[0]).toMatchObject({ state: 'processed', outcome: 'sent' });
    // Passages suivants (11 h 45, lendemain) : rien de plus.
    await passage(paris(`${DAY}T11:45:00`));
    await passage(paris(`${plus(DAY, 1)}T08:30:00`));
    await envoyer();
    expect(await rappels(c.id)).toHaveLength(1);
  });

  it('R02 — création à 9 h après le passage de 8 h 30 : nouveau notifié seul, premier jamais renvoyé (envoyé ou encore en file)', async () => {
    // a) premier rappel déjà ENVOYÉ : nouvelle notification du seul nouvel événement.
    const c = await compte();
    const cible = plus(DAY, 7);
    horloge(paris(`${plus(DAY, -1)}T10:00:00`));
    const premier = await saisir(c, cible); // J+8 la veille : rien
    expect(await couverture(c.id)).toHaveLength(0);
    await passage(paris(`${DAY}T08:30:00`));
    await envoyer();
    horloge(paris(`${DAY}T09:00:00`));
    const nouveau = await saisir(c, cible);
    await envoyer(paris(`${DAY}T09:03:00`));
    const r = await rappels(c.id);
    expect(r.map((x) => x.payload.agendaItemIds)).toEqual([[premier], [nouveau]]);
    expect(r.every((x) => x.status === 'sent')).toBe(true);
    expect((await cloches(c.a.id)).map((x) => x.title)).toEqual(['Échéance dans 7 jours', 'Échéance dans 7 jours']);

    // b) premier rappel encore EN FILE : le nouvel événement le rejoint (une seule notification, deux échéances).
    const d = await compte();
    horloge(paris(`${DAY}T09:00:00`));
    const x1 = await saisir(d, cible);
    horloge(paris(`${DAY}T09:01:00`));
    const x2 = await saisir(d, cible);
    await envoyer(paris(`${DAY}T09:05:00`));
    const rd = await rappels(d.id);
    expect(rd).toHaveLength(1);
    expect(rd[0].payload).toMatchObject({ count: 2, agendaItemIds: [x1, x2], daysUntil: 7 });
    expect((await cloches(d.a.id)).map((x) => x.title)).toEqual(['2 échéances dans 7 jours']);
  });

  it('R03 — création à J+6 / J+2 / J+1 / J+0 : rattrapage avant l’échéance, délai réel exact, jamais « dans 7 jours »', async () => {
    const c = await compte();
    horloge(paris(`${DAY}T15:00:00`));
    for (const n of [6, 2, 1, 0]) await saisir(c, plus(DAY, n));
    // J+0 dont l'heure est passée : aucun rappel.
    await saisir(c, DAY, { time: '14:00' });
    await envoyer(paris(`${DAY}T15:03:00`));
    const titres = (await cloches(c.a.id)).map((x) => x.title).sort();
    expect(titres).toEqual(['Échéance aujourd’hui', 'Échéance dans 2 jours', 'Échéance dans 6 jours', 'Échéance demain'].sort());
    expect(titres.join(' ')).not.toContain('7 jours');
    expect((await rappels(c.id)).map((r) => r.payload.daysUntil).sort()).toEqual([0, 1, 2, 6]);
    // E-mail : sujet générique, corps et lien de l'Agenda (préférences par défaut).
    expect(etat.mails.filter((m) => m.to === c.a.email || (Array.isArray(m.to) && m.to.includes(c.a.email)))).toHaveLength(4);
  });

  it('R04 — événement connu à J+8, puis passage quotidien à J+7 : un seul rappel normal', async () => {
    const c = await compte();
    horloge(paris(`${DAY}T10:00:00`));
    const item = await saisir(c, plus(DAY, 8));
    await passage(paris(`${DAY}T10:15:00`));
    expect(await couverture(c.id)).toHaveLength(0);
    const lendemain = plus(DAY, 1);
    const r1 = await passage(paris(`${lendemain}T08:30:00`));
    expect(r1.covered).toBe(1);
    await passage(paris(`${lendemain}T08:45:00`));
    await passage(paris(`${lendemain}T14:00:00`));
    await envoyer();
    const r = await rappels(c.id);
    expect(r).toHaveLength(1);
    expect(r[0].payload).toMatchObject({ agendaItemIds: [item], daysUntil: 7 });
    expect((await couverture(c.id))[0]).toMatchObject({ trigger: 'SWEEP', state: 'processed' });
    expect((await cloches(c.a.id)).map((x) => x.title)).toEqual(['Échéance dans 7 jours']);
  });

  it('R05 — date déplacée de J+20 vers J+5 : rappel éligible ; sauvegardes répétées sans changement : aucun doublon', async () => {
    const c = await compte();
    horloge(paris(`${DAY}T10:00:00`));
    const item = await saisir(c, plus(DAY, 20));
    expect(await couverture(c.id)).toHaveLength(0);
    horloge(paris(`${DAY}T10:05:00`));
    await deplacer(c, item, plus(DAY, 5));
    horloge(paris(`${DAY}T10:06:00`));
    await deplacer(c, item, plus(DAY, 5), 'Titre modifié');
    await deplacer(c, item, plus(DAY, 5));
    await envoyer(paris(`${DAY}T10:10:00`));
    await passage(paris(`${DAY}T10:15:00`));
    await envoyer();
    expect((await rappels(c.id)).map((r) => [r.status, r.payload.daysUntil])).toEqual([['sent', 5]]);
    expect(await couverture(c.id)).toHaveLength(1);
  });

  it('R06 — date déplacée / événement supprimé AVANT l’envoi différé : aucun rappel périmé', async () => {
    const c = await compte();
    horloge(paris(`${DAY}T10:00:00`));
    const deplace = await saisir(c, plus(DAY, 3), { title: 'Déplacé' });
    const supprime = await saisir(c, plus(DAY, 2), { title: 'Supprimé' });
    const lointain = await saisir(c, plus(DAY, 4), { title: 'Repoussé loin' });
    horloge(paris(`${DAY}T10:01:00`));
    await deplacer(c, deplace, plus(DAY, 4));
    await deplacer(c, lointain, plus(DAY, 30));
    await supprimer(c, supprime);
    await envoyer(paris(`${DAY}T10:05:00`));
    const r = await rappels(c.id);
    // Rappel J+3 (périmé) et J+2 (supprimé) ignorés ; J+4 envoyé pour le seul événement encore daté du J+4
    // (l'événement repoussé à J+30 en est retiré à l'envoi).
    expect(r.filter((x) => x.status === 'sent')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'skipped').map((x) => x.outcome_reason).sort()).toEqual(['deadline_stale', 'deadline_stale']);
    expect((await cloches(c.a.id)).map((x) => x.title)).toEqual(['Échéance dans 4 jours']);
    const [cloche] = await sql<{ p: { agendaItemIds: number[]; count: number } }[]>`SELECT payload_json::jsonb AS p FROM notifications WHERE user_id = ${c.a.id} AND type = 'DEADLINE_DUE_IN_7_DAYS'`;
    expect(cloche.p).toMatchObject({ agendaItemIds: [deplace], count: 1 });
    const cov = await couverture(c.id);
    expect(cov.map((x) => [x.agenda_item_id, x.due, x.state, x.outcome])).toEqual([
      [deplace, plus(DAY, 3), 'cancelled', 'stale'], [deplace, plus(DAY, 4), 'processed', 'sent'], [lointain, plus(DAY, 4), 'cancelled', 'stale'],
    ]);
  });

  it('R07 — événement passé, sans date, « information », au-delà de J+7 : aucun rappel', async () => {
    const c = await compte();
    horloge(paris(`${DAY}T10:00:00`));
    await saisir(c, plus(DAY, -1));
    await saisir(c, null, { title: 'Sans date' });
    await saisir(c, plus(DAY, 2), { category: 'information' });
    await saisir(c, plus(DAY, 8));
    await passage(paris(`${DAY}T10:15:00`));
    await envoyer();
    expect(await couverture(c.id)).toHaveLength(0);
    expect(await rappels(c.id)).toHaveLength(0);
  });

  it('R08 — deux événements même date et compte, puis un troisième après émission : chacun une fois, sans répétition', async () => {
    const c = await compte();
    const cible = plus(DAY, 7);
    horloge(paris(`${plus(DAY, -1)}T20:00:00`));
    const a = await saisir(c, cible);
    const b = await saisir(c, cible);
    await passage(paris(`${DAY}T08:30:00`));
    await envoyer();
    horloge(paris(`${DAY}T13:00:00`));
    const troisieme = await saisir(c, cible);
    await envoyer(paris(`${DAY}T13:05:00`));
    await passage(paris(`${DAY}T13:15:00`));
    await envoyer();
    const r = await rappels(c.id);
    expect(r.map((x) => x.payload.agendaItemIds)).toEqual([[a, b], [troisieme]]);
    expect((await cloches(c.a.id)).map((x) => x.title)).toEqual(['2 échéances dans 7 jours', 'Échéance dans 7 jours']);
  });

  it('R09 — relance simultanée, crash entre mise en file et livraison, envoi interrompu, reprise : ni perte ni doublon', async () => {
    const c = await compte({ duo: true });
    horloge(paris(`${plus(DAY, -1)}T21:30:00`)); // hors plage : écriture sans mise en file
    const items = [await saisir(c, plus(DAY, 3)), await saisir(c, plus(DAY, 3)), await saisir(c, plus(DAY, 5))];
    expect(await couverture(c.id)).toHaveLength(0);
    // Trois passages SIMULTANÉS + une réévaluation d'écriture concurrente.
    const now = paris(`${DAY}T08:30:00`);
    horloge(now);
    const { runDeadlineReminders, evaluateDeadlineRemindersAfterWrite } = await import('@/lib/notifications/scheduled/deadlines');
    await Promise.all([runDeadlineReminders(now), runDeadlineReminders(now), runDeadlineReminders(now), evaluateDeadlineRemindersAfterWrite(c.id, items, { now })]);
    const cov = await couverture(c.id);
    expect(cov).toHaveLength(6); // 3 événements × 2 destinataires, une fois chacun
    expect(new Set(cov.map((x) => `${x.agenda_item_id}:${x.recipient_user_id}:${x.due}`)).size).toBe(6);
    expect(await rappels(c.id)).toHaveLength(4); // 2 dates × 2 destinataires

    // « Crash » entre mise en file et livraison : rien n'a été livré ; redémarrage → nouveau passage, puis envoi.
    await passage(paris(`${DAY}T08:45:00`));
    expect(await rappels(c.id)).toHaveLength(4);
    // Envoi interrompu : une ligne prise en charge (« processing ») sans aucune livraison depuis plus d'une heure.
    const [bloquee] = await rappels(c.id, c.a.id);
    await sql`UPDATE notification_outbox SET status = 'processing', created_at = ${paris(`${DAY}T08:31:00`).toISOString()}::timestamptz, scheduled_for = ${paris(`${DAY}T08:31:00`).toISOString()}::timestamptz WHERE id = ${bloquee.id}::uuid`;
    const reprise = await passage(paris(`${DAY}T09:45:00`));
    expect(reprise.recovered).toBe(1);
    await envoyer();
    const fin = await rappels(c.id);
    expect(fin.map((x) => x.status)).toEqual(['sent', 'sent', 'sent', 'sent']);
    expect((await couverture(c.id)).every((x) => x.state === 'processed' && x.outcome === 'sent')).toBe(true);
    expect((await cloches(c.a.id)).map((x) => x.title).sort()).toEqual(['2 échéances dans 3 jours', 'Échéance dans 5 jours']);
    expect((await cloches(c.b!.id)).map((x) => x.title).sort()).toEqual(['2 échéances dans 3 jours', 'Échéance dans 5 jours']);
    // Nouvelle relance (redémarrage, double déclenchement) : rien de plus.
    await passage(paris(`${DAY}T10:00:00`));
    await envoyer();
    expect(await rappels(c.id)).toHaveLength(4);
  });

  it('R10 — préférences désactivées, compte restreint, Duo à préférences différentes : règles existantes pour chaque destinataire', async () => {
    const c = await compte({ duo: true });
    // Membre B : e-mail et push des « Échéances et rappels » coupés (cloche conservée, comme toute notification).
    await pref(c.b!.id, 'email', false);
    await pref(c.b!.id, 'push', false);
    horloge(paris(`${DAY}T12:00:00`));
    await saisir(c, plus(DAY, 4));
    await envoyer(paris(`${DAY}T12:03:00`));
    const ra = (await rappels(c.id, c.a.id))[0];
    const rb = (await rappels(c.id, c.b!.id))[0];
    expect((await livraisons(ra.id)).map((l) => `${l.channel}:${l.status}`)).toEqual(['bell:sent', 'email:sent', 'push:sent']);
    expect((await livraisons(rb.id)).map((l) => `${l.channel}:${l.status}`)).toEqual(['bell:sent']);
    expect(etat.pushes.filter((p) => p.token === c.b!.jeton)).toHaveLength(0);
    expect(etat.pushes.filter((p) => p.token === c.a.jeton)).toHaveLength(1);

    // Compte restreint (sans abonnement) : ni couverture, ni notification.
    const r = await compte({ plan: null });
    horloge(paris(`${DAY}T12:10:00`));
    await sql`INSERT INTO agenda_items (account_id, title, start_date, home_category) VALUES (${r.id}, 'Restreint', ${plus(DAY, 2)}, 'action')`;
    await passage(paris(`${DAY}T12:15:00`));
    expect(await couverture(r.id)).toHaveLength(0);
    expect(await rappels(r.id)).toHaveLength(0);
  });

  it('R11 — changement d’heure été / hiver et passage de minuit : délais calendaires de Paris', async () => {
    const c = await compte();
    // Passage à l'heure d'été (29/03/2026, UTC+2 après 2 h) : 9 h Paris = 07:00Z.
    horloge(paris('2026-03-29T09:00:00', '+02:00'));
    await saisir(c, '2026-04-05');
    await saisir(c, '2026-03-30');
    await envoyer(paris('2026-03-29T09:05:00', '+02:00'));
    // Passage à l'heure d'hiver (25/10/2026, UTC+1 après 3 h) : 9 h Paris = 08:00Z.
    horloge(paris('2026-10-25T09:00:00'));
    await saisir(c, '2026-11-01');
    await saisir(c, '2026-10-26');
    await envoyer(paris('2026-10-25T09:05:00'));
    // Minuit : mis en file à 20 h 59 pour le lendemain (« demain »), envoyé après minuit → « aujourd'hui ».
    horloge(paris(`${DAY}T20:59:00`));
    await saisir(c, plus(DAY, 1), { title: 'Minuit' });
    await envoyer(paris(`${plus(DAY, 1)}T00:05:00`));
    const titres = (await cloches(c.a.id)).map((x) => x.title);
    expect(titres).toEqual(['Échéance dans 7 jours', 'Échéance demain', 'Échéance dans 7 jours', 'Échéance demain', 'Échéance aujourd’hui']);
    // Délai à la mise en file : 1 (outbox) ; recalculé à l'envoi : 0 (contenu livré).
    const minuit = (await rappels(c.id)).at(-1)!;
    expect(minuit.payload.daysUntil).toBe(1);
    const [livre] = await sql<{ p: { daysUntil: number } }[]>`SELECT payload_json::jsonb AS p FROM notifications WHERE outbox_id = ${minuit.id}::uuid`;
    expect(livre.p.daysUntil).toBe(0);
    expect((await couverture(c.id)).at(-1)!.days_before).toBe(1);
  });

  it('R12 — création par T4 (primitive), projection d’événement, saisie manuelle, écriture directe : même garantie', async () => {
    const c = await compte();
    const bien = await make.asset({ id: c.id, ownerUserId: c.ownerUserId });
    const doc = await make.assetFile({ id: c.id, ownerUserId: c.ownerUserId }, { assetId: bien.id });
    horloge(paris(`${DAY}T14:00:00`));
    const prim = await import('@/services/agenda/agenda-write-primitive');
    const t4 = await prim.upsertAgendaItem({
      accountId: c.id, assetId: bien.id, origin: 'AUTOMATIC', category: 'action', date: plus(DAY, 3), title: 'Contrôle technique',
      originFieldKey: 'maintenanceDueDate', sources: [{ fileId: doc.id, role: 'SOURCE' }], occurrenceIndex: 'single',
    }, { notify: true });
    // Rejouée à l'identique (réanalyse) : aucune nouvelle couverture.
    await prim.upsertAgendaItem({
      accountId: c.id, assetId: bien.id, origin: 'AUTOMATIC', category: 'action', date: plus(DAY, 3), title: 'Contrôle technique',
      originFieldKey: 'maintenanceDueDate', sources: [{ fileId: doc.id, role: 'SOURCE' }], occurrenceIndex: 'single',
    }, { notify: true });
    const { writeAgendaItem } = await import('@/services/agenda/write-agenda-item');
    const projete = await writeAgendaItem({
      values: { title: 'Entretien chaudière', startDate: plus(DAY, 3), homeCategory: 'action', isAutomatic: true, isAutomaticModified: false,
        requiresQualification: false, originType: 'qualified_document', occurrenceNature: 'FORECAST', dateSource: 'PREDICTED_FROM_RECURRENCE' } as never,
      links: { assetIds: [bien.id], equipmentIds: [], substructureIds: [] },
    }, { accountId: c.id, channel: 'T4', linkMode: 'replace', notify: false });
    const manuel = await saisir(c, plus(DAY, 3));
    await envoyer(paris(`${DAY}T14:05:00`));
    // Écriture directe hors primitive (restauration, transfert…) : rattrapée par le passage périodique.
    const [direct] = await sql<{ id: number }[]>`INSERT INTO agenda_items (account_id, title, start_date, home_category) VALUES (${c.id}, 'Direct', ${plus(DAY, 3)}, 'action') RETURNING id`;
    const cov1 = await couverture(c.id);
    expect(cov1.map((x) => [x.agenda_item_id, x.trigger])).toEqual([[t4.id, 'WRITE'], [projete.id, 'WRITE'], [manuel, 'WRITE']]);
    await passage(paris(`${DAY}T14:15:00`));
    await envoyer();
    const cov2 = await couverture(c.id);
    expect(cov2.find((x) => x.agenda_item_id === direct.id)).toMatchObject({ trigger: 'SWEEP' });
    // Écritures de 14 h regroupées (une notification, 3 échéances dont 1 prévisionnelle) ; l'écriture directe à part.
    const r = await rappels(c.id);
    expect(r.map((x) => x.payload.agendaItemIds)).toEqual([[t4.id, projete.id, manuel], [direct.id]]);
    expect((await cloches(c.a.id)).map((x) => x.title)).toEqual(['3 échéances dans 3 jours (dont 1 prévisionnelle)', 'Échéance dans 3 jours']);
  });

  it('R13 — déploiement (rappel déjà envoyé par l’ancien mécanisme), anti-rafale après changement de date, écriture la nuit', async () => {
    const c = await compte();
    horloge(paris(`${DAY}T07:00:00`));
    const ancien = await saisir(c, plus(DAY, 7)); // avant 8 h 30 : rien
    const nuit = await saisir(c, plus(DAY, 1));
    expect(await couverture(c.id)).toHaveLength(0);
    // Ligne de l'ANCIEN mécanisme (clé par date, déjà envoyée avant la mise en production de 113AH).
    await sql`INSERT INTO notification_outbox (event_type, category, account_id, recipient_user_id, entity_type, entity_id, payload_json, priority, dedupe_key, status, processed_at)
              VALUES ('DEADLINE_DUE_IN_7_DAYS', 'deadlines', ${c.id}, ${c.a.id}, 'agenda_date', ${plus(DAY, 7)},
                      ${JSON.stringify({ count: 1, date: plus(DAY, 7), agendaItemIds: [ancien], forecastCount: 0 })}::jsonb, 'normal',
                      ${`deadline:j7:${plus(DAY, 7)}:u${c.a.id}`}, 'sent', now())`;
    await passage(paris(`${DAY}T08:30:00`));
    await envoyer();
    // Seule l'échéance non couverte (écrite la nuit) est rattrapée.
    expect((await couverture(c.id)).map((x) => x.agenda_item_id)).toEqual([nuit]);
    expect((await cloches(c.a.id)).map((x) => x.title)).toEqual(['Échéance demain']);

    // Anti-rafale : rappel envoyé pour J+5, date avancée à J+3 30 min plus tard → pas de second rappel immédiat…
    horloge(paris(`${DAY}T10:00:00`));
    const evt = await saisir(c, plus(DAY, 5));
    await envoyer(paris(`${DAY}T10:03:00`));
    horloge(paris(`${DAY}T10:30:00`));
    await deplacer(c, evt, plus(DAY, 3));
    await passage(paris(`${DAY}T11:00:00`));
    await envoyer();
    expect((await rappels(c.id)).filter((r) => r.payload.agendaItemIds?.includes(evt))).toHaveLength(1);
    // …réévalué au-delà de l'intervalle (12 h), tant que l'échéance est à venir.
    await passage(paris(`${plus(DAY, 1)}T08:30:00`));
    await envoyer();
    const pourEvt = (await rappels(c.id)).filter((r) => r.payload.agendaItemIds?.includes(evt));
    expect(pourEvt.map((r) => r.payload.daysUntil)).toEqual([5, 2]);
  });
});
