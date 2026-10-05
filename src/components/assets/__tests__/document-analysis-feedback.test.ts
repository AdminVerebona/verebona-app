/**
 * Revue L16b-3 — retour d'une réanalyse depuis le tiroir : le motif du
 * serveur atteint l'utilisateur (toast), info pour une analyse déjà en cours.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeErrorFeedback } from '../document-analysis-feedback';

describe('analyzeErrorFeedback', () => {
  it('échec motivé : motif du serveur, en erreur', () => {
    expect(analyzeErrorFeedback({ code: 'ANALYSIS_FAILED', message: 'Analyse impossible (prompt maître T1) : sortie invalide' }))
      .toEqual({ level: 'error', message: 'Analyse impossible (prompt maître T1) : sortie invalide' });
  });
  it('déjà en file ou en cours : information, motif conservé ou libellé par défaut', () => {
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
    expect(src).toMatch(/analysisState === 'UPLOADED' && fullData\?\.analysisFailReason\?\.startsWith\('Plafond IA du mois atteint'\)/);
  });
  it('le tiroir rend le retour par toast et affiche le motif d’échec existant', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/assets/DocumentDrawer.tsx'), 'utf8');
    expect(src).toMatch(/analysisFeedback\?\.level === 'info'\) toast\.info\(analysisError/);
    expect(src).toMatch(/\{fullData\.analysisFailReason\}/);
  });
});
