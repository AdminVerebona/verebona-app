/**
 * COM-014 — historique des communications de la fiche Utilisateur : un e-mail
 * du moteur de notifications n'apparaît qu'une fois, même s'il figure dans
 * `email_logs` ET dans `notification_deliveries`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unsafe = vi.fn();
vi.mock('@/db', () => ({ pgClient: { unsafe: (...a: unknown[]) => unsafe(...a) }, db: {} }));

import {
  dedupeCommunicationRows,
  loadCommunications,
  type RawCommunicationRow,
} from '@/services/admin/user-detail.service';

const row = (r: Partial<RawCommunicationRow>): RawCommunicationRow => ({
  source: 'email_log',
  at: '2026-09-20T10:00:00.000Z',
  channel: 'email',
  type: 'WELCOME',
  status: 'sent',
  ...r,
});

describe('dedupeCommunicationRows', () => {
  it('retire la ligne email_logs `notif_*` appariée à une livraison e-mail', () => {
    const rows = [
      row({ source: 'email_log', type: 'notif_payment_incident', at: '2026-09-20T10:00:01.000Z' }),
      row({ source: 'delivery', type: 'PAYMENT_FAILED', at: '2026-09-20T10:00:03.000Z' }),
      row({ source: 'delivery', channel: 'in_app', type: 'PAYMENT_FAILED', at: '2026-09-20T10:00:02.000Z' }),
    ];
    const out = dedupeCommunicationRows(rows);
    expect(out.map((r) => `${r.source}:${r.channel}`)).toEqual(['delivery:email', 'delivery:in_app']);
  });

  it('conserve les e-mails transactionnels hors catalogue', () => {
    const rows = [
      row({ source: 'email_log', type: 'WELCOME' }),
      row({ source: 'delivery', type: 'NEW_DEVICE_LOGIN' }),
    ];
    expect(dedupeCommunicationRows(rows)).toHaveLength(2);
  });

  it('n’apparie pas au-delà de la fenêtre de 10 minutes', () => {
    const rows = [
      row({ source: 'email_log', type: 'notif_x', at: '2026-09-20T10:00:00.000Z' }),
      row({ source: 'delivery', type: 'X', at: '2026-09-20T10:30:00.000Z' }),
    ];
    expect(dedupeCommunicationRows(rows)).toHaveLength(2);
  });

  it('appariement un pour un : deux envois réels restent deux', () => {
    const rows = [
      row({ source: 'email_log', type: 'notif_x', at: '2026-09-20T10:00:00.000Z' }),
      row({ source: 'email_log', type: 'notif_x', at: '2026-09-20T10:01:00.000Z' }),
      row({ source: 'delivery', type: 'X', at: '2026-09-20T10:00:01.000Z' }),
    ];
    const out = dedupeCommunicationRows(rows);
    expect(out).toHaveLength(2);
    expect(out.filter((r) => r.source === 'email_log')).toHaveLength(1);
  });
});

describe('loadCommunications', () => {
  beforeEach(() => unsafe.mockReset());

  it('renvoie un historique trié, sans doublon, avec libellés métier', async () => {
    unsafe.mockResolvedValueOnce([
      row({ source: 'email_log', type: 'notif_payment_incident', at: new Date('2026-09-20T10:00:00Z') }),
      row({ source: 'email_log', type: 'WELCOME', at: new Date('2026-09-01T08:00:00Z') }),
      row({ source: 'delivery', type: 'PAYMENT_FAILED', at: new Date('2026-09-20T10:00:02Z') }),
    ]);
    const out = await loadCommunications(5, (c) => `label:${c}`);
    expect(out).toEqual([
      { at: '2026-09-20T10:00:02.000Z', channel: 'email', type: 'label:PAYMENT_FAILED', status: 'sent' },
      { at: '2026-09-01T08:00:00.000Z', channel: 'email', type: 'label:WELCOME', status: 'sent' },
    ]);
    expect(unsafe.mock.calls[0][1]).toEqual([5]);
  });
});
