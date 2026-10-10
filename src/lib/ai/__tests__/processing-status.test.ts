/**
 * Lot 34C — statut fonctionnel côté utilisateur, calculé sur l'état réel
 * (ticket « ne plus exposer les erreurs techniques IA aux utilisateurs »).
 * Critères UXERR-01 à UXERR-07 (cas 1 à 7 du ticket), partie application.
 */
import { describe, it, expect } from 'vitest';
import {
  computeProcessingStatus, displayAnalysisState, isSettledProcessingStatus, userMessageText,
  USER_MESSAGES, USER_MESSAGE_CODES, PROCESSING_STATUS_LABELS, ANALYSIS_FAILED_FINAL_MESSAGE,
} from '../processing-status';

const NOW = Date.parse('2026-10-09T10:00:00Z');

/** Vocabulaire technique interdit côté utilisateur (ticket, « Constat »). */
const JARGON = /T[1-6]\b|TASK|prompt|mod[eè]le|gemini|provider|fournisseur|fallback|repli|sch[eé]ma|schema|INVALID_OUTPUT|Invalid input|parser|mapper|stack|document\.\w+|amountCents/i;

describe('computeProcessingStatus — état réel du traitement', () => {
  it('UXERR-01 — principal en échec, fallback en cours (job RUNNING) : « Analyse en cours », aucune erreur', () => {
    // Le pipeline a pu écrire l'échec intermédiaire sur le document : le job vivant fait foi.
    const v = computeProcessingStatus({ analysisState: 'ANALYSIS_FAILED', liveJob: { status: 'RUNNING', attempts: 1 } }, NOW);
    expect(v).toEqual({ processingStatus: 'PROCESSING', userMessageCode: null, retryScheduled: false, nextAttemptAt: null, resumeAt: null });
    expect(PROCESSING_STATUS_LABELS[v.processingStatus]).toBe('Analyse en cours');
    expect(displayAnalysisState('ANALYSIS_FAILED', v.processingStatus)).toBe('ANALYZING');
  });

  it('UXERR-02 — tous les modèles échouent, vrai retry planifié (job PENDING après 1 exécution) : « En file d’attente », retryScheduled explicite', () => {
    const v = computeProcessingStatus({
      analysisState: 'UPLOADED', liveJob: { status: 'PENDING', attempts: 1, availableAt: '2026-10-09T10:00:30.000Z' },
    }, NOW);
    expect(v).toMatchObject({ processingStatus: 'PENDING', userMessageCode: null, retryScheduled: true, nextAttemptAt: '2026-10-09T10:00:30.000Z' });
    expect(PROCESSING_STATUS_LABELS.PENDING).toBe('En file d’attente');
    // La reprise en cours d'exécution est un RETRYING (« Analyse en cours »).
    const r = computeProcessingStatus({ analysisState: 'ANALYZING', liveJob: { status: 'RUNNING', attempts: 2 } }, NOW);
    expect(r.processingStatus).toBe('RETRYING');
    expect(PROCESSING_STATUS_LABELS.RETRYING).toBe('Analyse en cours');
  });

  it('UXERR-03 — tous les modèles échouent, aucun retry (aucun job vivant) : FAILED_FINAL + message générique', () => {
    const v = computeProcessingStatus({ analysisState: 'ANALYSIS_FAILED', liveJob: null, failureCode: 'ANALYSIS_FAILED_FINAL' }, NOW);
    expect(v).toMatchObject({ processingStatus: 'FAILED_FINAL', userMessageCode: 'ANALYSIS_FAILED_FINAL', retryScheduled: false });
    expect(userMessageText(v.userMessageCode)).toBe('L’analyse automatique de ce document n’a pas pu être finalisée.');
  });

  it('UXERR-03 — action utilisateur possible : NEEDS_USER_ACTION avec un message ciblé, sans diagnostic', () => {
    const v = computeProcessingStatus({ analysisState: 'ANALYSIS_FAILED', liveJob: null, failureCode: 'FILE_PASSWORD_PROTECTED' }, NOW);
    expect(v).toMatchObject({ processingStatus: 'NEEDS_USER_ACTION', userMessageCode: 'FILE_PASSWORD_PROTECTED' });
    expect(userMessageText(v.userMessageCode)).toBe('Ce document est protégé et ne peut pas être analysé automatiquement.');
  });

  it('UXERR-04 — référentiel fermé : aucun message ne contient de vocabulaire technique ; un code inconnu rend le générique', () => {
    for (const code of USER_MESSAGE_CODES) expect(USER_MESSAGES[code], code).not.toMatch(JARGON);
    for (const l of Object.values(PROCESSING_STATUS_LABELS)) if (l) expect(l).not.toMatch(JARGON);
    // Une valeur reçue n'est jamais affichée telle quelle.
    expect(userMessageText('gemini-2.5-pro : Sortie non conforme au schéma, document.amountCents : Invalid input'))
      .toBe(ANALYSIS_FAILED_FINAL_MESSAGE);
    expect(userMessageText(null)).toBeNull();
  });

  it('UXERR-07 — « En file d’attente » seulement si un job est réellement PENDING ; UPLOADED sans job : rien en attente', () => {
    const sansJob = computeProcessingStatus({ analysisState: 'UPLOADED', liveJob: null }, NOW);
    expect(sansJob.processingStatus).toBe('NOT_PROCESSED');
    expect(PROCESSING_STATUS_LABELS.NOT_PROCESSED).toBeNull();
    expect(displayAnalysisState('UPLOADED', sansJob.processingStatus)).toBeNull();
    const enFile = computeProcessingStatus({ analysisState: 'UPLOADED', liveJob: { status: 'PENDING', attempts: 0 } }, NOW);
    expect(enFile).toMatchObject({ processingStatus: 'PENDING', retryScheduled: false });
    // Un échec suivi d'aucun retry n'est jamais « en file ».
    const fini = computeProcessingStatus({ analysisState: 'ANALYSIS_FAILED', liveJob: null }, NOW);
    expect(fini.processingStatus).not.toBe('PENDING');
  });

  it('report pour plafond de coût : en file avec un message fonctionnel daté (code du référentiel)', () => {
    const v = computeProcessingStatus({
      analysisState: 'UPLOADED',
      liveJob: { status: 'PENDING', attempts: 0, costCapDeferredUntil: '2026-11-01T00:00:00+01:00', availableAt: '2026-11-01T00:01:00+01:00' },
    }, NOW);
    expect(v).toMatchObject({ processingStatus: 'PENDING', userMessageCode: 'ANALYSIS_DEFERRED_COST_CAP', retryScheduled: false });
    expect(userMessageText(v.userMessageCode, { resumeAt: v.resumeAt })).toMatch(/reprise le 1er novembre/);
  });

  it('analyse aboutie : COMPLETED, aucun message ; statuts terminés pour le bandeau', () => {
    expect(computeProcessingStatus({ analysisState: 'VALIDATION_REQUIRED', liveJob: null }, NOW).processingStatus).toBe('COMPLETED');
    expect(displayAnalysisState('VALIDATION_REQUIRED', 'COMPLETED')).toBe('VALIDATION_REQUIRED');
    expect(isSettledProcessingStatus('FAILED_FINAL')).toBe(true);
    expect(isSettledProcessingStatus('PENDING')).toBe(false);
    expect(isSettledProcessingStatus('RETRYING')).toBe(false);
  });
});
