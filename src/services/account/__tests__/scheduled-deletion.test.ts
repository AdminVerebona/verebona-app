/**
 * Rappels avant suppression — CDC rétractation §13.3.
 *
 * « Rappel sept jours avant suppression ; rappel vingt-quatre heures avant
 * suppression. » Toute la règle tient dans `selectDueReminder`, isolée de la
 * base pour être vérifiable.
 */
import { describe, it, expect } from 'vitest';
import {
  selectDueReminder,
  DELETION_DELAY_DAYS,
} from '@/services/account/scheduled-deletion.service';

const NOW = new Date('2026-08-01T10:00:00Z');
const inDays = (n: number) => new Date(NOW.getTime() + n * 24 * 3600 * 1000);

const item = (days: number, sent: { j7?: boolean; j1?: boolean } = {}) => ({
  scheduledAt: inDays(days),
  reminderJ7SentAt: sent.j7 ? NOW : null,
  reminderJ1SentAt: sent.j1 ? NOW : null,
});

describe('délai réglementaire', () => {
  it('est de trente jours (§13.3)', () => {
    expect(DELETION_DELAY_DAYS).toBe(30);
  });
});

describe('sélection du rappel dû', () => {
  it('ne rappelle rien à trente jours de l’échéance', () => {
    expect(selectDueReminder(item(30), NOW)).toBeNull();
  });

  it('ne rappelle rien à huit jours', () => {
    expect(selectDueReminder(item(8), NOW)).toBeNull();
  });

  it('déclenche le rappel J-7 à sept jours', () => {
    expect(selectDueReminder(item(7), NOW)).toBe('j7');
  });

  it('déclenche encore le rappel J-7 à trois jours s’il n’a pas été envoyé', () => {
    // Un balayage manqué ne doit pas faire sauter le rappel : mieux vaut
    // prévenir tard que pas du tout.
    expect(selectDueReminder(item(3), NOW)).toBe('j7');
  });

  it('ne renvoie pas un rappel J-7 déjà envoyé', () => {
    expect(selectDueReminder(item(5, { j7: true }), NOW)).toBeNull();
  });

  it('déclenche le rappel J-1 à vingt-quatre heures', () => {
    expect(selectDueReminder(item(1), NOW)).toBe('j1');
  });

  it('déclenche le rappel J-1 à quelques heures de l’échéance', () => {
    expect(selectDueReminder(item(0.25), NOW)).toBe('j1');
  });

  it('privilégie J-1 sur J-7 dans les dernières vingt-quatre heures', () => {
    // Un compte à rebours court, créé à moins de sept jours de son échéance,
    // ne doit pas annoncer « dans sept jours » alors qu'il reste une nuit.
    expect(selectDueReminder(item(0.5), NOW)).toBe('j1');
  });

  it('ne renvoie pas un rappel J-1 déjà envoyé', () => {
    expect(selectDueReminder(item(0.5, { j1: true }), NOW)).toBeNull();
  });

  it('ne rappelle plus rien une fois l’échéance atteinte', () => {
    // C'est la suppression qui s'applique, pas un rappel.
    expect(selectDueReminder(item(0), NOW)).toBeNull();
    expect(selectDueReminder(item(-1), NOW)).toBeNull();
  });

  it('ne rappelle plus rien après une échéance dépassée, même sans rappel envoyé', () => {
    expect(selectDueReminder(item(-5), NOW)).toBeNull();
  });

  it('envoie les deux rappels au fil du temps, jamais deux fois', () => {
    // Déroulé complet d'un compte à rebours de trente jours, balayé chaque jour.
    let j7Sent: Date | null = null;
    let j1Sent: Date | null = null;
    const deadline = inDays(30);
    const emitted: string[] = [];

    for (let day = 0; day <= 31; day += 1) {
      const now = inDays(day);
      const due = selectDueReminder(
        { scheduledAt: deadline, reminderJ7SentAt: j7Sent, reminderJ1SentAt: j1Sent },
        now,
      );
      if (due === 'j7') { j7Sent = now; emitted.push(`j7@${day}`); }
      if (due === 'j1') { j1Sent = now; emitted.push(`j1@${day}`); }
    }

    expect(emitted).toEqual(['j7@23', 'j1@29']);
  });
});
