/**
 * Lot 53 — retour PO D25 (mascotte : « aucun sujet à traiter en priorité »
 * sans masquer ce qui reste), D27 (échéance ≠ rendez-vous programmé ≠
 * intervention réalisée ; une heure ne prouve rien), cohérence D25 / Q25 /
 * D27 (vocabulaire de priorité et statuts réels).
 */
import { describe, expect, it } from 'vitest';
import { buildCandidates, openOverdueCount, type MascotAgendaRow, type MascotRawData } from '../signals';
import { selectSubjects } from '../selector';
import { buildPresentation } from '../presentation';
import { CLEAR_SPEECH, NOTHING_PRIORITY, composeSpeech, homePose } from '../bubble';
import { buildT6Input, nuanceViolation } from '../t6-contract';
import { deadlineExtActionText, deadlineNextText } from '../deadline-label';
import { agendaDateRole } from '@/services/agenda/agenda-date-role';
import type { MascotPresentation } from '../types';

const TODAY = '2026-10-12';
const CUPRA = { title: 'Prochain contrôle technique — CUPRA LEON E-HYBRID180', assetName: 'Cupra', assetCategory: 'VEHICULE', assetSubtype: 'Voiture' };
const raw = (over: Partial<MascotRawData> = {}): MascotRawData => ({
  accountId: 7, today: TODAY,
  processing: { uploads: [], analyses: [], exports: [] },
  onboarding: { activeAssets: [{ id: 1, name: 'Cupra' }], activeAssetCount: 1, documentCount: 3 },
  toProcess: [], agenda: [], acknowledgments: [], overdueAgenda: [], ...over,
});
const row = (over: Partial<MascotAgendaRow>): MascotAgendaRow => ({
  id: 1, ...CUPRA, date: '2028-04-18', forecast: false, requiresQualification: false, assetId: 1, ...over,
});

/** Présentation produite par le moteur (sans T6), comme `getMascotPresentation`. */
function presenter(r: MascotRawData, todo?: MascotPresentation['todo']): MascotPresentation {
  const c = buildCandidates(r);
  const subjects = selectSubjects(c.candidates);
  return buildPresentation({
    subjects, secondaries: [], degraded: c.degraded, messages: null, today: TODAY,
    tiles: { unprovenOverdueIsQuestion: true }, todo, overdueDeadlines: openOverdueCount(r),
  });
}
const parler = (p: MascotPresentation) => composeSpeech({ presentation: p, empty: false }).text;

describe('PO-D25 — « Aucun sujet à traiter en priorité » : jamais au prix de masquer', () => {
  it('PO-D25-01 — aucun sujet, file vide : lot 61, « Rien de particulier à vous signaler » (jamais « Tout est à jour »)', () => {
    const p = presenter(raw());
    expect(p.status).toBe('clear');
    expect(parler(p)).toBe(CLEAR_SPEECH);
    expect(parler(p)).toBe('Rien de particulier à vous signaler pour le moment.');
    expect(homePose(p, false)).toBe('success-check');
  });

  it('PO-D25-02 (revu lot 61, T6) — échéance échue hors fenêtre des sujets : ni « tout est à jour », ni « aucune échéance dépassée », ni vérification générique', () => {
    const p = presenter(raw({ overdueAgenda: [{ id: 9, date: '2026-05-01' }] }));
    // Lot 61 : une date dépassée n'établit aucune action — compteur de supervision seulement.
    expect(p.overdueDeadlines).toBe(1);
    const t = parler(p);
    expect(t).not.toContain('Des échéances dépassées sont à vérifier');
    expect(t).not.toMatch(/Tout est à jour|Aucune échéance dépassée|urgen/i);
    expect(t).not.toMatch(/\d/);
  });

  it('PO-D25-03 — échéance échue récente : un vrai sujet « à confirmer », jamais « aucun sujet »', () => {
    const r = raw({ agenda: [row({ id: 4, date: '2026-10-01', dateRole: 'DEADLINE' })], overdueAgenda: [{ id: 4, date: '2026-10-01' }] });
    const t = parler(presenter(r));
    // Lot 68 : le sujet est dit directement (plus d'introduction de comptage).
    expect(t).toMatch(/^Le contrôle technique de la Cupra était à prévoir/);
    expect(t).not.toMatch(/mérite votre attention/);
    expect(t).not.toContain(NOTHING_PRIORITY);
  });

  it('PO-D25-04 — élément en attente de rapprochement (À traiter non prioritaire) : « aucun sujet en priorité », jamais « tout est à jour » (la pastille du menu le compte ; MASC3 maintenu)', () => {
    const p = presenter(raw(), { items: [], total: 3 } as never);
    expect(p.status).toBe('ok');
    expect(p.todo?.total).toBe(3);
    const t = parler(p);
    expect(t).toBe(NOTHING_PRIORITY);
    expect(t).not.toMatch(/\d|Tout est à jour|À traiter/);
    expect(homePose(p, false)).toBe('neutral');
    // Lot 61 : une échéance dépassée hors sujets n'ajoute plus de phrase générique.
    expect(parler(presenter(raw({ overdueAgenda: [{ id: 9, date: '2026-01-01' }] }), { items: [], total: 1 } as never)))
      .toBe(NOTHING_PRIORITY);
  });

  it('PO-D25-05 — données incomplètes (source en panne) : aucune assurance catégorique, même devant une simple information', () => {
    const enPanne = presenter(raw({ overdueAgenda: null }));
    expect(enPanne.status).toBe('degraded');
    expect(parler(enPanne)).not.toMatch(/Tout est à jour|Aucun sujet/);
    // Sujet seulement informatif (prochaine échéance) sur une source en panne : pas de « Tout est à jour. ».
    const info = presenter(raw({ agenda: [row({ dateRole: 'DEADLINE' })], toProcess: null }));
    expect(info.status).toBe('degraded');
    const t = parler(info);
    expect(t).toMatch(/^Certaines informations n’ont pas pu être actualisées\./);
    expect(t).not.toContain('Tout est à jour');
  });

  it('PO-D25-06 — « C’est fait » déclaré par l’utilisateur (même cycle) : l’échéance ne compte plus comme dépassée', () => {
    const r = raw({
      overdueAgenda: [{ id: 9, date: '2026-05-01' }, { id: 10, date: '2026-04-01' }],
      acknowledgments: [{ occurrenceKey: 'MASC-EXT-ACTION:agenda:9', cycleKey: '2026-05-01' }],
    });
    expect(openOverdueCount(r)).toBe(1);
    expect(openOverdueCount(raw({ overdueAgenda: undefined }))).toBeNull();
  });
});

describe('PO-D27 — échéance à respecter, rendez-vous programmé, intervention réalisée', () => {
  const base = { forecast: false, isAutomatic: false, originType: 'manual', projectionOrigin: null, eventNature: null, startTime: null };

  it('PO-D27-01 — une heure enregistrée ne suffit pas : échéance automatique avec heure → « à prévoir »', () => {
    expect(agendaDateRole({ ...base, isAutomatic: true, originType: 'qualified_document', startTime: '14:00' })).toBe('DEADLINE');
    expect(agendaDateRole({ ...base, isAutomatic: true, originType: 'asset_field', startTime: '09:30' })).toBe('DEADLINE');
    // Échéance (nature) saisie à la main avec heure : toujours une échéance.
    expect(agendaDateRole({ ...base, eventNature: 'DEADLINE', startTime: '10:00' })).toBe('DEADLINE');
    // Prévision : jamais un rendez-vous.
    expect(agendaDateRole({ ...base, forecast: true, startTime: '10:00' })).toBe('DEADLINE');
    // Seule preuve de programmation : l'événement saisi par l'utilisateur lui-même (avec ou sans heure).
    expect(agendaDateRole({ ...base })).toBe('SCHEDULED_EVENT');
    expect(agendaDateRole({ ...base, startTime: '10:00' })).toBe('SCHEDULED_EVENT');
    // Projeté d'une Opération : jamais présenté comme organisé.
    expect(agendaDateRole({ ...base, projectionOrigin: 'OPERATION' })).toBe('DEADLINE');
  });

  it('PO-D27-02 — contrôle technique futur automatique : « à prévoir », jamais « prévu » ni « confirmé »', () => {
    const t = deadlineNextText({ ...CUPRA, forecast: false, dateRole: 'DEADLINE' }, '18 avril 2028');
    expect(t).toBe('Le prochain contrôle technique de la Cupra est à prévoir pour le 18 avril 2028.');
    expect(t).not.toMatch(/prévu |confirm|rendez-vous/);
  });

  it('PO-D27-03 — échéance passée non confirmée : « était à prévoir », jamais « était prévu » ni « réalisé »', () => {
    const passe = deadlineExtActionText({ ...CUPRA, dateRole: 'DEADLINE' }, '1 octobre 2026', true);
    expect(passe).toBe('Le contrôle technique de la Cupra était à prévoir pour le 1 octobre 2026. Si c’est fait, vous pouvez l’indiquer.');
    expect(deadlineExtActionText({ ...CUPRA, dateRole: 'DEADLINE' }, '12 octobre 2026', false))
      .toBe('Le contrôle technique de la Cupra est à prévoir pour aujourd’hui, le 12 octobre 2026. Une fois que c’est fait, vous pouvez l’indiquer.');
    // Événement saisi par l'utilisateur : « était prévu ».
    expect(deadlineExtActionText({ ...CUPRA, title: 'Contrôle garage', dateRole: 'SCHEDULED_EVENT' }, '1 octobre 2026', true))
      .toMatch(/^Le contrôle garage de la Cupra était prévu le 1 octobre 2026\./);
    for (const t of [passe]) expect(t).not.toMatch(/réalisé|confirm/);
  });

  it('PO-D27-04 — T6 ne qualifie jamais un rendez-vous de « confirmé » / « réservé » sans le fait (échéance ET événement)', () => {
    const sujet = (dateRole: 'DEADLINE' | 'SCHEDULED_EVENT', title = 'Rendez-vous garage') => buildT6Input(
      buildCandidates(raw({ agenda: [row({ title, dateRole })] })).candidates.filter((c) => c.sourceCode === 'DATE-NEXT'),
    ).subjects[0];
    const planifie = sujet('SCHEDULED_EVENT');
    expect(nuanceViolation('Votre rendez-vous garage de la Cupra est confirmé pour le 18 avril 2028.', planifie, 'info')).toBe('unproven_confirmation');
    expect(nuanceViolation('Le rendez-vous garage de la Cupra est réservé le 18 avril 2028.', planifie, 'info')).toBe('unproven_confirmation');
    expect(nuanceViolation('Le rendez-vous garage de la Cupra est prévu le 18 avril 2028.', planifie, 'info')).toBeNull();
    // La « nature confirmée » d'une date (certaine, non estimée) n'autorise pas « confirmé ».
    expect(planifie.facts.dateNature).toBe('confirmée');
    const echeance = sujet('DEADLINE', CUPRA.title);
    expect(nuanceViolation('Le contrôle technique de la Cupra est confirmé pour le 18 avril 2028.', echeance, 'info')).toBe('unproven_confirmation');
    // Le mot vient du titre saisi : admis.
    const titre = sujet('SCHEDULED_EVENT', 'RDV confirmé garage');
    expect(nuanceViolation('Le rdv confirmé garage de la Cupra est prévu le 18 avril 2028.', titre, 'info')).toBeNull();
  });
});
