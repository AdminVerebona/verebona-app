/**
 * Notification « Analyse terminée » : le document est nommé et s'ouvre.
 */
import { describe, it, expect } from 'vitest';
import { lotNotificationPayload, lotNotificationText } from '../lot-notification-text';
import { NOTIFICATION_CATALOG } from '@/lib/notifications/catalog';

const doc = (id: number, title: string) => ({ assetFileId: id, title });

describe('fin de lot', () => {
  it('un document : « Le document “Titre” a été analysé », avec son identifiant', () => {
    const p = lotNotificationPayload(7, 1, [doc(42, 'Facture Béquille draisienne')]);
    expect(p).toMatchObject({ lotId: 7, assetFileId: 42, documentTitle: 'Facture Béquille draisienne', failedCount: 0 });
    expect(lotNotificationText(p)).toBe('Le document “Facture Béquille draisienne” a été analysé');
  });

  it('plusieurs documents : nommés, puis comptés au-delà de la liste', () => {
    const docs = [1, 2, 3, 4, 5, 6].map((i) => doc(i, `Doc ${i}`));
    const p = lotNotificationPayload(7, 8, docs);
    expect(p.assetFileId).toBeUndefined();
    expect(lotNotificationText(p)).toBe('8 documents ont été analysés : “Doc 1”, “Doc 2”, “Doc 3”, “Doc 4”, “Doc 5” et 3 autres');
  });

  it('sans titre lisible, un texte simple plutôt que « 1 document(s) »', () => {
    expect(lotNotificationText(lotNotificationPayload(7, 1, []))).toBe('Votre document a été analysé');
    expect(lotNotificationText(lotNotificationPayload(7, 3, []))).toBe('3 documents ont été analysés');
  });

  it('le catalogue rend le même texte et un lien profond vers le tiroir', () => {
    const entry = NOTIFICATION_CATALOG.DOCUMENT_BATCH_COMPLETED!;
    const p = lotNotificationPayload(7, 1, [doc(42, 'Facture Béquille draisienne')]);
    expect(entry.payloadSchema.parse(p)).toBeTruthy();
    expect(entry.render(p as never).bellBody).toBe('Le document “Facture Béquille draisienne” a été analysé');
    expect(entry.deepLink?.(p as never)).toBe('/documents?tiroir=document%3A42');
  });
});
