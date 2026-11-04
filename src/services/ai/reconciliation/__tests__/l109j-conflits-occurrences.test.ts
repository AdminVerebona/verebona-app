/**
 * Lot 109J — audit des SOURCE_CONFLICT de l'exécution T3:6033 (dates
 * d'entretien, contrôle technique, échéances d'assurance). Moteur de
 * décision PUR (`decide`), preuves construites comme le collecteur.
 *
 * Avant correction (démontré par ces tests sur le code du lot 108) :
 *   · deux entretiens SUCCESSIFS (deux factures, deux dates) → carte
 *     « Conflit entre plusieurs sources » ;
 *   · un justificatif ANCIEN face à une date plus récente en place → carte,
 *     ou mise à jour vers la date ANCIENNE quand la valeur en place n'avait
 *     pas de date de source (lastRevision depuis un justificatif obsolète).
 */
import { describe, expect, it } from 'vitest';
import { decide } from '../decision/decision-matrix';
import { normalize } from '../decision/normalizers';
import { resolveAuthority } from '../decision/authority-matrix';
import { isLatestOccurrenceField, isYearlyRecurringDeadline, planLatestOccurrence } from '../decision/latest-occurrence';
import type { CurrentValue, EvidenceCandidate } from '../types';

const preuve = (evidenceId: number, fieldKey: string, value: string, o: Partial<EvidenceCandidate> = {}): EvidenceCandidate => ({
  evidenceId, value, normalized: normalize(fieldKey, value), confidence: 'certain', evidenceOrigin: 'TEXT_EXTRACTION', visualDescription: null,
  authorityScore: resolveAuthority({ fieldKey, documentType: 'FACTURE', isWebLink: false }).score,
  documentType: 'FACTURE', documentDate: new Date(`${value}T00:00:00Z`), sourceId: 100 + evidenceId, excerpt: value, ...o,
} as EvidenceCandidate);
const enPlace = (fieldKey: string, value: string, origin: CurrentValue['origin'] = 'RECONCILIATION', o: Partial<CurrentValue> = {}): CurrentValue => ({
  value, normalized: normalize(fieldKey, value), origin, updatedAt: null, sourceDate: null, ...o,
} as CurrentValue);

describe('L109J-CONF — champs « dernière occurrence » et échéances renouvelées', () => {
  it('L109J-CONF-00 — sémantique lue dans le registre canonique (aucune liste en dur)', () => {
    expect(isLatestOccurrenceField('lastRevision')).toBe(true);
    expect(isLatestOccurrenceField('lastServiceDate')).toBe(true); // alias
    expect(isLatestOccurrenceField('lastInspectionDate')).toBe(true);
    expect(isLatestOccurrenceField('insuranceExpiry')).toBe(false);
    // Événement UNIQUE (achat) : jamais « dernière occurrence » — deux dates d'achat restent une contradiction.
    expect(isLatestOccurrenceField('acquisitionDate')).toBe(false);
    expect(isYearlyRecurringDeadline('insuranceExpiry')).toBe(true);
    expect(isYearlyRecurringDeadline('maintenanceDueDate')).toBe(false);
  });

  it('L109J-CONF-01 — deux entretiens SUCCESSIFS (documents distincts), champ vide : la date la plus récente, aucune carte', () => {
    const d = decide({ fieldKey: 'lastRevision', current: null, candidates: [preuve(1, 'lastRevision', '2024-03-10'), preuve(2, 'lastRevision', '2025-04-02')], isCritical: false });
    expect(d).toMatchObject({ action: 'apply', proposedValue: '2025-04-02' });
  });

  it('L109J-CONF-02 — justificatif ANCIEN face à une date plus récente en place (sans date de source) : conservée, jamais remplacée', () => {
    const d = decide({ fieldKey: 'lastRevision', current: enPlace('lastRevision', '2025-04-02'), candidates: [preuve(1, 'lastRevision', '2024-03-10')], isCritical: false });
    expect(d).toMatchObject({ action: 'keep', reasonCode: 'OLDER_OCCURRENCE', proposedValue: '2025-04-02' });
  });

  it('L109J-CONF-03 — valeur USER plus récente, justificatif ancien : USER intacte, aucune carte', () => {
    const d = decide({ fieldKey: 'lastInspectionDate', current: enPlace('lastInspectionDate', '2025-06-01', 'USER'), candidates: [preuve(1, 'lastInspectionDate', '2023-06-01')], isCritical: false });
    expect(d).toMatchObject({ action: 'keep', reasonCode: 'OLDER_OCCURRENCE' });
  });

  it('L109J-CONF-04 — valeur USER plus ANCIENNE qu’un nouvel entretien : proposition (carte), jamais un écrasement', () => {
    const d = decide({ fieldKey: 'lastRevision', current: enPlace('lastRevision', '2024-03-10', 'USER'), candidates: [preuve(1, 'lastRevision', '2024-03-10'), preuve(2, 'lastRevision', '2025-04-02')], isCritical: false });
    expect(d).toMatchObject({ action: 'create_conflict', reasonCode: 'MANUAL_VALUE_CONTRADICTED', proposedValue: '2025-04-02' });
  });

  it('L109J-CONF-05 — deux dates DIFFÉRENTES lues dans le MÊME document : vraie contradiction conservée', () => {
    const d = decide({ fieldKey: 'lastRevision', current: null, candidates: [preuve(1, 'lastRevision', '2024-03-10', { sourceId: 9 }), preuve(2, 'lastRevision', '2025-04-02', { sourceId: 9 })], isCritical: false });
    expect(d.action).toBe('create_conflict');
  });

  it('L109J-CONF-06 — échéances d’assurance renouvelées (même jour, années successives, documents distincts) : la plus récente, aucune carte', () => {
    const d = decide({ fieldKey: 'insuranceExpiry', current: enPlace('insuranceExpiry', '2025-03-01'), candidates: [preuve(1, 'insuranceExpiry', '2025-03-01'), preuve(2, 'insuranceExpiry', '2026-03-01')], isCritical: false });
    expect(d.action).not.toBe('create_conflict');
    expect(d.proposedValue).toBe('2026-03-01');
  });

  it('L109J-CONF-07 — échéances à des jours différents (contrats possiblement distincts) : conflit RÉEL conservé', () => {
    const d = decide({ fieldKey: 'insuranceExpiry', current: null, candidates: [preuve(1, 'insuranceExpiry', '2026-03-01'), preuve(2, 'insuranceExpiry', '2026-09-15')], isCritical: false });
    expect(d.action).toBe('create_conflict');
  });

  it('L109J-CONF-08 — avis d’échéance ANCIEN face à l’échéance renouvelée en place : conservée', () => {
    const d = decide({ fieldKey: 'insuranceExpiry', current: enPlace('insuranceExpiry', '2026-03-01'), candidates: [preuve(1, 'insuranceExpiry', '2025-03-01')], isCritical: false });
    expect(d).toMatchObject({ action: 'keep', reasonCode: 'OLDER_OCCURRENCE' });
  });

  it('L109J-CONF-09 — autre champ (non temporel) : règles ordinaires inchangées (divergence → carte)', () => {
    const d = decide({ fieldKey: 'insurerName', current: null, candidates: [preuve(1, 'insurerName', 'Assureur A'), preuve(2, 'insurerName', 'Assureur B')], isCritical: false });
    expect(d.action).toBe('create_conflict');
  });

  it('L109J-CONF-09B — date d’achat (événement unique) : deux dates distinctes = contradiction conservée', () => {
    const d = decide({ fieldKey: 'acquisitionDate', current: null, candidates: [preuve(1, 'acquisitionDate', '2024-03-10'), preuve(2, 'acquisitionDate', '2025-04-02')], isCritical: false });
    expect(d.action).toBe('create_conflict');
  });

  it('L109J-CONF-10 — plan pur : dates illisibles → règles ordinaires', () => {
    expect(planLatestOccurrence(null, [preuve(1, 'lastRevision', 'pas une date', { normalized: 'x' })]).kind).toBe('ORDINARY');
  });
});
