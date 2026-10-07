/**
 * Lot 26 — point 11 : e-mail « Votre quota d'analyses » retiré, et compteur
 * d'analyses qui ne bloque plus l'analyse des documents (PostgreSQL réel).
 *
 * Cas de préproduction reproduit : compte Premium ACTIF (150 documents),
 * colonne historique `accounts.subscription_status` restée `TRIALING` —
 * le compteur d'analyses retombe sur la période d'essai (30) et atteint son
 * plafond alors que le compte n'a que ~60 documents.
 *
 * L26-11-AC1 : compteur d'analyses épuisé ⇒ l'analyse reste autorisée.
 * L26-11-AC2 : consommer au-delà ⇒ ni erreur, ni notification « quota
 *              d'analyses » (outbox, notification_events), consommation tracée.
 * L26-11-AC3 : le quota de DOCUMENTS légitime refuse toujours au-delà de 150.
 * L26-11-AC4 : migration 0261 — événements en file annulés, modèle
 *              `notif_quota` supprimé, idempotente.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { scenario } from '../scenario';

scenario('L26-11', 'Quota d’analyses : e-mail retiré, analyse non bloquée', ({ sql, make }) => {
  const compteAuPlafond = async () => {
    const c = await make.account({ plan: 'premium' });
    await sql`UPDATE accounts SET subscription_status = 'TRIALING' WHERE id = ${c.id}`;
    await sql`
      INSERT INTO account_analysis_counters (account_id, period_type, included_quota, included_consumed, period_start_at, updated_at, created_at)
      VALUES (${c.id}, 'trial', 30, 30, now(), now(), now())`;
    return c;
  };

  it('L26-11-AC1 : compteur d’analyses épuisé ⇒ analyse toujours autorisée', async () => {
    const { canConsumeAnalysis, getAnalysisQuotaState } = await import('@/services/commercial-model.service');
    const c = await compteAuPlafond();
    expect((await getAnalysisQuotaState(c.id)).totalRemaining).toBe(0);
    expect(await canConsumeAnalysis(c.id, 1)).toEqual({ allowed: true });
    expect(await canConsumeAnalysis(c.id, 5)).toEqual({ allowed: true });
  });

  it('L26-11-AC2 : consommation au-delà ⇒ ni erreur ni notification, consommation tracée', async () => {
    const { consumeAnalysisCredits } = await import('@/services/commercial-model.service');
    const c = await compteAuPlafond();
    await expect(consumeAnalysisCredits(c.id, 2)).resolves.toBeUndefined();
    const [compteur] = await sql<{ n: number }[]>`
      SELECT included_consumed AS n FROM account_analysis_counters WHERE account_id = ${c.id} AND period_end_at IS NULL`;
    expect(compteur.n).toBe(32);
    const [outbox] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notification_outbox
      WHERE account_id = ${c.id} AND event_type IN ('ANALYSIS_QUOTA_90', 'ANALYSIS_QUOTA_100')`;
    expect(outbox.n).toBe(0);
    const [evts] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notification_events WHERE account_id = ${c.id}`;
    expect(evts.n).toBe(0);
  });

  it('L26-11-AC2 : seuil 90 % franchi sur un compteur neuf ⇒ aucune notification', async () => {
    const { consumeAnalysisCredits } = await import('@/services/commercial-model.service');
    const c = await make.account({ plan: 'premium' });
    await sql`
      INSERT INTO account_analysis_counters (account_id, period_type, included_quota, included_consumed, period_start_at, updated_at, created_at)
      VALUES (${c.id}, 'annual', 10, 8, now(), now(), now())`;
    await consumeAnalysisCredits(c.id, 2);
    const [outbox] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notification_outbox WHERE account_id = ${c.id}`;
    expect(outbox.n).toBe(0);
  });

  it('L26-11-AC3 : le quota de documents (150 en Premium) refuse toujours', async () => {
    const { canAddDocument } = await import('@/services/entitlements.service');
    const c = await make.account({ plan: 'premium' });
    expect((await canAddDocument(c.id, 61)).allowed).toBe(true);
    expect(await canAddDocument(c.id, 150)).toMatchObject({ allowed: false, reason: 'DOCUMENT_QUOTA_REACHED', limit: 150 });
  });

  it('L26-11-AC4 : migration 0261 — file annulée, modèle supprimé, idempotente', async () => {
    const c = await make.account({ plan: 'premium' });
    await sql`
      INSERT INTO email_templates (type, subject, body, placeholders, updated_at)
      VALUES ('notif_quota', 'Votre quota d''analyses', '{{body}}', '["body"]', now())
      ON CONFLICT (type) DO NOTHING`;
    const [enFile] = await sql<{ id: string }[]>`
      INSERT INTO notification_outbox (event_type, category, account_id, recipient_user_id, dedupe_key, status)
      VALUES ('ANALYSIS_QUOTA_100', 'account', ${c.id}, ${c.ownerUserId}, ${`l26-q-${c.id}`}, 'pending') RETURNING id`;
    const [envoye] = await sql<{ id: string }[]>`
      INSERT INTO notification_outbox (event_type, category, account_id, recipient_user_id, dedupe_key, status)
      VALUES ('ANALYSIS_QUOTA_90', 'account', ${c.id}, ${c.ownerUserId}, ${`l26-q90-${c.id}`}, 'sent') RETURNING id`;

    const texte = await readFile(join(process.cwd(), 'src', 'db', 'migrations', '0261_remove_analysis_quota_notifications.sql'), 'utf8');
    for (let i = 0; i < 2; i++) await sql.begin((tx) => tx.unsafe(texte));

    const lignes = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM notification_outbox WHERE id IN (${enFile.id}, ${envoye.id})`;
    expect(Object.fromEntries(lignes.map((l) => [l.id, l.status]))).toEqual({ [enFile.id]: 'cancelled', [envoye.id]: 'sent' });
    const [tpl] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM email_templates WHERE type = 'notif_quota'`;
    expect(tpl.n).toBe(0);
  });
});
