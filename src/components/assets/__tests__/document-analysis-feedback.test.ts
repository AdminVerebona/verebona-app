/**
 * Revue L16b-3 — retour d'une réanalyse depuis le tiroir : toast, info pour
 * une analyse déjà en cours. Lot 34C : le texte vient d'un référentiel
 * fermé — jamais un motif technique reçu du serveur (UXERR-02, 03, 04).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeErrorFeedback } from '../document-analysis-feedback';

const MOTIF = 'Analyse impossible (prompt maître T1) : Tous les modèles ont échoué, gemini-2.5-pro : Sortie non conforme au schéma, document.title.evidence : Invalid input';

describe('analyzeErrorFeedback', () => {
  it('UXERR-04 — échec d’analyse : le motif technique du serveur n’est JAMAIS affiché', () => {
    const r = analyzeErrorFeedback({ code: 'ANALYSIS_FAILED', message: MOTIF, processingStatus: 'FAILED_FINAL', userMessageCode: 'ANALYSIS_FAILED_FINAL' });
    expect(r).toEqual({ level: 'error', message: 'L’analyse automatique de ce document n’a pas pu être finalisée.' });
    expect(analyzeErrorFeedback({ code: 'ANALYSIS_FAILED', message: MOTIF }).message).not.toMatch(/prompt|gemini|schéma|Invalid/);
    expect(analyzeErrorFeedback({ code: 'INTERNAL_ERROR', message: 'TypeError: cannot read x' }))
      .toEqual({ level: 'error', message: "Impossible de lancer l'analyse. Veuillez réessayer." });
  });
  it('UXERR-02 — retry réellement en file : information, aucune alerte d’erreur', () => {
    expect(analyzeErrorFeedback({ code: 'ANALYSIS_FAILED', processingStatus: 'PENDING', retryScheduled: true } as never))
      .toEqual({ level: 'info', message: 'L’analyse de ce document se poursuit automatiquement.' });
  });
  it('UXERR-03 — action utilisateur : message ciblé du référentiel', () => {
    expect(analyzeErrorFeedback({ code: 'ANALYSIS_FAILED', processingStatus: 'NEEDS_USER_ACTION', userMessageCode: 'FILE_PASSWORD_PROTECTED' }))
      .toEqual({ level: 'error', message: 'Ce document est protégé et ne peut pas être analysé automatiquement.' });
  });
  it('déjà en file ou en cours : information, message fonctionnel conservé ou libellé par défaut', () => {
    expect(analyzeErrorFeedback({ code: 'ALREADY_ANALYZING', message: 'Ce document est déjà en file d’analyse.' }))
      .toEqual({ level: 'info', message: 'Ce document est déjà en file d’analyse.' });
    expect(analyzeErrorFeedback({ code: 'ALREADY_ANALYZING' }).level).toBe('info');
  });
  it('abonnement requis, code inconnu sans motif : libellés existants', () => {
    expect(analyzeErrorFeedback({ code: 'PLAN_UPGRADE_REQUIRED', message: 'x' }).message).toMatch(/Premium/);
    expect(analyzeErrorFeedback({ code: 'INTERNAL_ERROR' })).toEqual({ level: 'error', message: "Impossible de lancer l'analyse. Veuillez réessayer." });
  });
  it('lot 22 — plafond IA du mois atteint : information (analyse reportée), motif daté conservé', () => {
    const motif = 'Plafond IA du mois atteint, reprise le 1er novembre : l’analyse sera lancée automatiquement.';
    expect(analyzeErrorFeedback({ code: 'ANALYSIS_COST_CAP_REACHED', message: motif })).toEqual({ level: 'info', message: motif });
    expect(analyzeErrorFeedback({ code: 'ANALYSIS_COST_CAP_REACHED' }).message).toMatch(/Plafond IA du mois atteint/);
    const src = readFileSync(join(process.cwd(), 'src/components/assets/DocumentDrawer.tsx'), 'utf8');
    expect(src).toMatch(/analysisState === 'UPLOADED' && fullData\?\.userMessageCode === 'ANALYSIS_DEFERRED_COST_CAP'/);
  });
  it('le tiroir rend le retour par toast et n’affiche que le message du référentiel', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/assets/DocumentDrawer.tsx'), 'utf8');
    expect(src).toMatch(/analysisFeedback\?\.level === 'info'\) toast\.info\(analysisError/);
    expect(src).not.toMatch(/analysisFailReason/);
    expect(src).toMatch(/userMessageText\(fullData\?\.userMessageCode \?\? 'ANALYSIS_FAILED_FINAL'\)/);
  });
});
