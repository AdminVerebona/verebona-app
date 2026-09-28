/**
 * Notification support des échecs d'export : envoi réel via Resend vers
 * SUPPORT_EMAIL, `false` (jamais d'envoi prétendu) si non configuré ou refusé.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendMock = vi.fn();
vi.mock('resend', () => ({
  Resend: class { emails = { send: (...a: unknown[]) => sendMock(...a) }; },
}));

const { notifySupportOfExportFailure } = await import('../export-support-notifier');

const params = {
  assetId: 5, exportId: 99, exportType: 'DOSSIER_COMPLET',
  technicalMessage: 'S3 <AccessDenied>', attemptCount: 1, userId: 2, accountId: 10,
};

const saved = { ...process.env };

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue({ data: { id: 'x' }, error: null });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.env.SUPPORT_EMAIL = 'support@example.test';
  process.env.RESEND_API_KEY = 're_test';
});
afterEach(() => { process.env = { ...saved }; });

describe('notifySupportOfExportFailure', () => {
  it('envoie à SUPPORT_EMAIL et renvoie true', async () => {
    expect(await notifySupportOfExportFailure(params)).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const mail = sendMock.mock.calls[0][0];
    expect(mail.to).toBe('support@example.test');
    expect(mail.subject).toContain('#99');
    expect(mail.text).toContain('S3 <AccessDenied>');
    // Contenu HTML échappé.
    expect(mail.html).toContain('S3 &lt;AccessDenied&gt;');
  });

  it('sans SUPPORT_EMAIL : aucun envoi, false', async () => {
    delete process.env.SUPPORT_EMAIL;
    expect(await notifySupportOfExportFailure(params)).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sans RESEND_API_KEY : aucun envoi, false', async () => {
    delete process.env.RESEND_API_KEY;
    expect(await notifySupportOfExportFailure(params)).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('refus du fournisseur ou exception : false, sans lever', async () => {
    sendMock.mockResolvedValueOnce({ data: null, error: { message: 'rate limited' } });
    expect(await notifySupportOfExportFailure(params)).toBe(false);
    sendMock.mockRejectedValueOnce(new Error('network'));
    expect(await notifySupportOfExportFailure(params)).toBe(false);
  });
});
