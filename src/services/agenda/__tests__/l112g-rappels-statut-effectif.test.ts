/**
 * Lot 112G — rappels de la mascotte (T6) et cartes « À traiter » sur le
 * STATUT EFFECTIF COMMUN (111R : `computeEffectiveStatus` + preuve 103D).
 *
 *   L112G-U1  `effectiveStatusOf` délègue au calcul commun (parité exhaustive)
 *   L112G-U2  pré-filtre SQL `settledByProofSql` : jamais plus large que le calcul commun (fuseaux, veille, jour même)
 *   L112G-U3  bloc « Rappels sur l'accueil » : réalisé prouvé / annulé → sujet clos ; à confirmer / date échue → inchangé
 *   L112G-U4  contrat de publication AGENDA-DONE / AGENDA-NOT-DONE : statut manuel OU preuve valide
 *   L112G-U5  lecture des colonnes `es*` (formats SQL) → statut
 *   L112G-U6  lecteurs alignés (mascotte, cartes, J-7, accueil) et rafraîchissement (suppression / dissociation)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeEffectiveStatus } from '../AgendaDomainService';
import { validCompletionProofSql } from '../completion-proof';
import {
  effectiveStatusOf, effectiveStatusOfSelected, isAgendaItemSettled, isSettledStatus, settledByProofSql, statusRowOfSelected,
} from '../effective-status-read';
import { agendaReminderRelevance } from '@/lib/agenda/reminder-relevance';
import { PUBLISHABILITY_CONTRACTS } from '@/services/to-process/publishability';

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', p), 'utf8');
const NOW = new Date('2026-11-06T10:00:00');

describe('L112G-U1 — statut effectif commun, sans calcul parallèle', () => {
  it('parité exhaustive avec computeEffectiveStatus', () => {
    const dates = [null, '2026-04-04', '2026-11-05', '2026-11-06', '2026-11-07', '2027-02-01'];
    const heures = [null, '08:00:00', '23:00:00'];
    const manuels = [null, '', '  ', 'realise', 'annule', ' realise '];
    const natures = [null, 'HISTORICAL', 'DEADLINE'];
    let n = 0;
    for (const startDate of dates) for (const startTime of heures) for (const manualStatus of manuels)
      for (const completionProven of [false, true]) for (const eventNature of natures) {
        const row = { startDate, startTime, manualStatus, completionProven, eventNature };
        const attendu = computeEffectiveStatus({
          startDate, startTime, endDate: null, endTime: null, manualStatus: manualStatus as never, completionProven, eventNature,
          businessType: null, originFieldKey: null,
        }, NOW);
        expect(effectiveStatusOf(row, NOW)).toBe(attendu);
        n++;
      }
    expect(n).toBe(648);
  });

  it('cas de la recette : prouvé et passé → réalisé (clos) ; sans preuve → ouvert ; jamais « réalisé » sans preuve ni statut', () => {
    expect(effectiveStatusOf({ startDate: '2026-09-01', eventNature: 'DEADLINE', completionProven: true }, NOW)).toBe('realise');
    expect(isAgendaItemSettled({ startDate: '2026-09-01', eventNature: 'DEADLINE', completionProven: true }, NOW)).toBe(true);
    expect(effectiveStatusOf({ startDate: '2026-09-01', eventNature: 'DEADLINE', completionProven: false }, NOW)).toBe('en_retard');
    expect(effectiveStatusOf({ startDate: '2026-09-01', eventNature: 'HISTORICAL', completionProven: false }, NOW)).toBe('a_confirmer');
    // Une preuve ne rend pas « réalisée » une échéance future.
    expect(effectiveStatusOf({ startDate: '2026-12-01', eventNature: 'DEADLINE', completionProven: true }, NOW)).toBe('a_venir');
    expect(isSettledStatus('a_confirmer')).toBe(false);
    expect(isSettledStatus('en_retard')).toBe(false);
    expect(isSettledStatus('annule')).toBe(true);
  });
});

describe('L112G-U2 — pré-filtre SQL : sous-ensemble certain du calcul commun', () => {
  /** Jumeau JS de la condition de date du pré-filtre (fin < veille de la date de référence). */
  const prefiltre = (fin: string, today: string) => {
    const t = new Date(`${today}T00:00:00Z`); t.setUTCDate(t.getUTCDate() - 1);
    return fin < t.toISOString().slice(0, 10);
  };
  it('toute ligne écartée par le pré-filtre est « réalisée » pour computeEffectiveStatus (fuseaux -12 h à +14 h)', () => {
    const debut = Date.parse('2026-10-20T00:00:00Z');
    for (let h = 0; h < 24 * 20; h += 1) {
      const now = new Date(debut + h * 3600_000);
      for (const decalage of [-12, -5, 0, 1, 2, 9, 14]) {
        // « Aujourd'hui » vu par la base, le serveur ou Europe/Paris : décalé d'au plus ±14 h.
        const today = new Date(now.getTime() + decalage * 3600_000).toISOString().slice(0, 10);
        for (let j = -6; j <= 2; j++) {
          const d = new Date(Date.parse(`${today}T00:00:00Z`) + j * 86_400_000).toISOString().slice(0, 10);
          for (const startTime of [null, '23:59:00', '00:30:00']) {
            if (!prefiltre(d, today)) continue;
            expect(effectiveStatusOf({ startDate: d, startTime, completionProven: true, eventNature: 'DEADLINE' }, now), `${d} ${today} ${now.toISOString()}`).toBe('realise');
          }
        }
      }
    }
  });
  it('SQL : preuve valide commune (111R) et marge d\'un jour, rien d\'autre', () => {
    const s = settledByProofSql('i', '$2::date');
    expect(s).toContain(validCompletionProofSql('i'));
    expect(s).toContain('coalesce(i.end_date, i.start_date) < (($2::date)::date - 1)');
    expect(settledByProofSql('x')).toContain('CURRENT_DATE');
  });
});

describe('L112G-U3 — bloc « Rappels sur l’accueil » de la fiche Agenda', () => {
  const base = { manualStatus: null, historical: false, dueDate: '2026-09-01', hasPreference: true, assessment: { interpellation: 'ACT_NOW', action: 'Faire la révision', actionDate: null } };
  it('réalisé (prouvé) ou annulé → sujet clos, aucun « Rappel actif »', () => {
    expect(agendaReminderRelevance({ ...base, effectiveStatus: 'realise' })).toMatchObject({ visible: false, reason: 'SUBJECT_CLOSED' });
    expect(agendaReminderRelevance({ ...base, effectiveStatus: 'annule' })).toMatchObject({ visible: false, reason: 'SUBJECT_CLOSED' });
  });
  it('date échue / à venir / à confirmer : comportement inchangé', () => {
    expect(agendaReminderRelevance({ ...base, effectiveStatus: 'en_retard' })).toMatchObject({ visible: true, reason: 'USER_PREFERENCE' });
    expect(agendaReminderRelevance({ ...base, hasPreference: false, effectiveStatus: 'a_venir' })).toMatchObject({ visible: true, reason: 'T6_REMINDER' });
    expect(agendaReminderRelevance({ ...base })).toMatchObject({ visible: true });
    expect(agendaReminderRelevance({ ...base, manualStatus: 'realise' })).toMatchObject({ visible: false, reason: 'SUBJECT_CLOSED' });
  });
});

describe('L112G-U4 — cartes « À traiter » de statut : prémisse sur le statut effectif', () => {
  it('AGENDA-DONE et AGENDA-NOT-DONE : statut manuel non vide OU preuve valide (même pré-filtre)', () => {
    for (const code of ['AGENDA-DONE', 'AGENDA-NOT-DONE']) {
      const sqlTxt = PUBLISHABILITY_CONTRACTS[code].noLongerUseful!('a');
      expect(sqlTxt, code).toContain(settledByProofSql('i'));
      expect(sqlTxt, code).toContain("NULLIF(trim(coalesce(i.manual_status, '')), '') IS NOT NULL");
      expect(PUBLISHABILITY_CONTRACTS[code].atCreation, code).toBe(true);
    }
  });
  it('DATA-AGENDA-DATE inchangé (élément sans date : la preuve n\'a pas d\'effet sur le statut)', () => {
    expect(PUBLISHABILITY_CONTRACTS['DATA-AGENDA-DATE'].noLongerUseful!('a')).not.toContain('completion_proof_file_id');
    expect(effectiveStatusOf({ startDate: null, completionProven: true }, NOW)).toBe('a_venir');
  });
});

describe('L112G-U5 — colonnes es* lues en SQL', () => {
  it('formats PostgreSQL (date, heure texte, booléen) → statut commun', () => {
    const r = { esStartDate: '2026-09-01', esStartTime: null, esEndDate: null, esEndTime: null, esManualStatus: '', esCompletionProven: true, esEventNature: 'DEADLINE', esBusinessType: null, esOriginFieldKey: null };
    expect(statusRowOfSelected(r)).toMatchObject({ startDate: '2026-09-01', manualStatus: null, completionProven: true });
    expect(effectiveStatusOfSelected(r, NOW)).toBe('realise');
    expect(effectiveStatusOfSelected({ ...r, esCompletionProven: false }, NOW)).toBe('en_retard');
    expect(effectiveStatusOfSelected({ ...r, esCompletionProven: null }, NOW)).toBe('en_retard');
    expect(effectiveStatusOfSelected({ ...r, esStartDate: new Date('2026-09-01T00:00:00Z') }, NOW)).toBe('realise');
  });
});

describe('L112G-U6 — lecteurs alignés et rafraîchissement', () => {
  it('mascotte (T6) : lectures principale, T6, dépassées ; revalidation au clic ; « C’est fait » ; fondements ; préférences', () => {
    const col = lire('services/home/mascot/collector.ts');
    expect(col).toContain('agendaColumns(t4, es)');
    expect(col.match(/notSettledByProofFilter\('i', '\$2::date'\)/g)?.length).toBe(3);
    expect(col).toContain('!closedByEffectiveStatus(i, now)');
    const act = lire('services/home/mascot/actions.service.ts');
    expect(act.match(/loadEffectiveStatus\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(act).not.toMatch(/SELECT manual_status FROM agenda_items/);
    expect(lire('services/home/mascot/t6-suggestion-grounds.ts')).toContain('loadEffectiveStatuses(accountId, agenda)');
    expect(lire('services/home/mascot/t6-reminders.service.ts')).toContain('effectiveStatus: effectif');
    expect(lire('services/home/mascot/pregen-queue.ts').match(/notSettledByProofFilter\(/g)?.length).toBe(2);
  });
  it('cartes, J-7, accueil, assistant', () => {
    expect(lire('services/to-process/agenda-status-cards.ts')).toContain('Réalisation déjà établie : rien à proposer.');
    expect(lire('lib/notifications/scheduled/deadlines.ts')).toContain('effectiveStatusOfSelected(r, now)');
    expect(lire('services/home/HomeSummaryService.ts')).toContain('agendaOuverts');
    expect(lire('services/verebona-assistant/canonical/actionables.ts')).toContain('notSettledByProofFilter');
  });
  it('rafraîchissement après suppression / dissociation de document', () => {
    expect(lire('components/home/T6ReminderControls.tsx')).toContain('subscribeAgendaStatusSources(');
    expect(lire('components/to-process/ToProcessQueue.tsx')).toMatch(/'agenda-mutated', 'document-analysis-complete', 'document-deleted'/);
    expect(lire('components/home/useMascotPresentation.ts')).toMatch(/'document-deleted'[\s\S]*'agenda-mutated'/);
    expect(lire('hooks/useToProcessCount.ts')).toMatch(/'document-deleted'[\s\S]*'agenda-mutated'/);
    // La dissociation depuis le tiroir du document émet `agenda-mutated`.
    expect(lire('components/assets/DocumentDrawer.tsx')).toMatch(/agenda-liens\?itemId=[\s\S]{0,300}agenda-mutated/);
  });
  it('aucun calcul parallèle : le module délègue à computeEffectiveStatus', () => {
    const m = lire('services/agenda/effective-status-read.ts');
    expect(m).toContain('return computeEffectiveStatus(');
    expect(m).not.toMatch(/isPastHistoricalUnconfirmed|agendaDatePassed\(/);
  });
});
