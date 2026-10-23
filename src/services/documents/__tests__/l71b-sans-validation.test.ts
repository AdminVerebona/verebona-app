/**
 * Lot 71B — décision PO du 19/10 : « Il ne doit pas y avoir de système de
 * validation sur les fiches. Soit il y a besoin d'une carte À traiter, soit
 * la donnée est ajoutée. » Tests sans base (le comportement des moteurs est
 * couvert sur PostgreSQL 16 par `l71b-sans-validation.e2e.ts`).
 *
 * VALID-01 Fiche document (tiroir unique, desktop ET mobile) : plus de
 *          bandeau « Validation suggérée », plus de bouton « Appliquer » ni
 *          « Valider et appliquer », plus d'appel de validation, plus
 *          d'édition imposée après une analyse.
 * VALID-08 L'ancien état (documents pas encore repris) se lit « analysé »
 *          partout où l'utilisateur le voit (tiroir, accueil, assistant).
 * VALID-09 Plus aucun producteur : seuls des LECTEURS de l'ancien état
 *          subsistent (liste fermée) ; la route de validation a disparu.
 * VALID-10 Reprise : rattrapage BO (Simuler / Appliquer, motif) et tâche
 *          planifiée interne déclarés ; synthèse BO lisible.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayAnalysisState, computeProcessingStatus } from '@/lib/ai/processing-status';
import { docStatus, deriveVerebonaWork } from '@/services/home/home-blocks';
import { documentAnalysisStatus } from '@/services/verebona-assistant/core/document-status';
import { BACKFILL_DEFINITIONS, validateBackfillRequest } from '@/services/admin/ops/backfill/definitions';
import { summarizeBackfill } from '@/services/admin/ops/backfill/report-format';
import { findTask } from '@/services/scheduling/scheduled-tasks.catalog';
import { formatValidationReprise, type ValidationRepriseReport } from '../validation-reprise';

const ROOT = process.cwd();
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const sansCommentaires = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('VALID-01 — fiche document : plus de système de validation (desktop et mobile : même tiroir)', () => {
  const tiroir = lire('src/components/assets/DocumentDrawer.tsx');
  const code = sansCommentaires(tiroir);

  it('ni bandeau « Validation suggérée », ni texte « Cliquez sur Appliquer », ni bouton « Appliquer » / « Valider et appliquer »', () => {
    expect(tiroir).not.toMatch(/Validation suggérée/);
    expect(tiroir).not.toMatch(/Cliquez sur/);
    expect(code).not.toMatch(/>\s*Appliquer\s*</);
    expect(code).not.toMatch(/Valider et appliquer/);
    expect(code).not.toMatch(/VALIDATION_REQUIRED/);
  });

  it('« Sauvegarder » n’est plus « valider » : aucun appel /commit, aucune proposition à conserver', () => {
    expect(code).not.toMatch(/\/commit/);
    expect(code).not.toMatch(/needsCommit|fieldProposals|pendingAiProposals/);
  });

  it('fin d’analyse ou ouverture depuis une notification : jamais de passage imposé en édition', () => {
    expect(code).not.toMatch(/setPendingAiProposals|setFieldProposals/);
    expect(code).toMatch(/if \(showAnalysisResults && !cancelled\) setShowDetectedInfo\(true\);/);
    expect(code).toMatch(/Analyse terminée — informations enregistrées/);
    // Le tiroir est le même composant sur mobile (aucune variante mobile du bloc).
    expect(readdirSync(join(ROOT, 'src/components/mobile')).some((f) => /Document/i.test(f))).toBe(false);
  });

  it('état diffusé en direct (SSE) normalisé : l’ancien état s’affiche « analysé »', () => {
    expect(code).toMatch(/setAnalysisState\(displayAnalysisState\(evt\.analysisState, null\)\)/);
  });
});

describe('VALID-01b — fiche du bien (et de ses sections, desktop et mobile : même composant) : plus de « Appliquer la valeur suggérée » ni « Conserver »', () => {
  const section = sansCommentaires(lire('src/components/assets/AssetDetailSection.tsx'));
  const onglet = sansCommentaires(lire('src/components/assets/AssetDetailsTab.tsx'));
  const details = sansCommentaires(lire('src/app/api/assets/[id]/details/route.ts'));

  it('aucun bouton « Appliquer » / « Conserver » ni badge « Incohérence » à valider sur la fiche', () => {
    for (const src of [section, onglet]) {
      expect(src).not.toMatch(/>\s*Appliquer\s*</);
      expect(src).not.toMatch(/Appliquer la valeur suggérée|Valeur suggérée/);
      expect(src).not.toMatch(/>\s*Conserver\s*</);
      expect(src).not.toMatch(/coherenceAlerts|onApplyAlert|onDismissAlert|dismiss-coherence-alert/);
    }
  });

  it('l’API de la fiche ne renvoie plus d’alertes à appliquer ; la route « ignorer l’incohérence » est retirée', () => {
    expect(details).not.toMatch(/coherenceAlerts/);
    expect(existsSync(join(ROOT, 'src/app/api/assets/[id]/dismiss-coherence-alert/route.ts'))).toBe(false);
  });
});

describe('VALID-08 — ancien état « à valider » lu « analysé » (documents pas encore repris)', () => {
  it('tiroir : displayAnalysisState', () => {
    expect(displayAnalysisState('VALIDATION_REQUIRED', 'COMPLETED')).toBe('ANALYZED');
    expect(displayAnalysisState('VALIDATION_REQUIRED', null)).toBe('ANALYZED');
    expect(displayAnalysisState('ANALYZED', 'COMPLETED')).toBe('ANALYZED');
    expect(displayAnalysisState('CONFLICT_DETECTED', 'COMPLETED')).toBe('CONFLICT_DETECTED');
    expect(computeProcessingStatus({ analysisState: 'VALIDATION_REQUIRED', liveJob: null }).processingStatus).toBe('COMPLETED');
  });
  it('accueil : aucun statut « À valider », frise « J’ai analysé… »', () => {
    expect(docStatus('VALIDATION_REQUIRED')).toBeNull();
    const w = deriveVerebonaWork({ fieldUpdates: [], deadlines: [], documents: [{ id: 1, title: 'Bail', assetName: null, analysisState: 'VALIDATION_REQUIRED', at: '2026-10-19T08:00:00Z' }] });
    expect(w.map((x) => x.text)).toEqual(['J’ai analysé « Bail ».']);
    expect(w[0].tone).toBe('violet');
  });
  it('assistant : document analysé (plus « à vérifier »)', () => {
    expect(documentAnalysisStatus('VALIDATION_REQUIRED')).toBe('ANALYZED');
    expect(documentAnalysisStatus('CONFLICT_DETECTED')).toBe('TO_VALIDATE');
  });
});

describe('VALID-09 — plus aucun producteur de l’état « à valider »', () => {
  const fichiers = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return /__tests__|[/\\]test$|e2e/.test(p) ? [] : fichiers(p);
    return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
  const lecteurs = fichiers(join(ROOT, 'src'))
    .filter((p) => readFileSync(p, 'utf8').includes('VALIDATION_REQUIRED'))
    .map((p) => relative(ROOT, p).replace(/\\/g, '/'))
    .sort();

  it('liste FERMÉE des fichiers qui mentionnent encore l’ancien état (lecture, reprise, transition de sortie)', () => {
    expect(lecteurs).toEqual([
      'src/app/api/billing/me/route.ts',
      'src/contexts/AnalysisBannerContext.tsx',
      'src/db/schema.ts',
      'src/lib/ai/processing-status.ts',
      'src/services/admin/account-documents.service.ts',
      'src/services/ai/reconciliation/document-asset/question-gate.ts',
      'src/services/ai/reconciliation/document-asset/resolve-document-asset.service.ts',
      // Lot 81E : lecture seule (état abouti → document « analysé » dans le résultat du lot).
      'src/services/ai/source-analysis/lot-notification.ts',
      'src/services/ai/source-analysis/pipeline.ts',
      // Lot 82B : coherence-maintenance.service.ts retiré (maintenance horaire remplacée par le registre de cohérence).
      'src/services/documents/validation-reprise.ts',
      'src/services/home/home-blocks.ts',
      'src/services/to-process/document-rule-bridge.ts',
      'src/services/verebona-assistant/core/document-status.ts',
      'src/services/verebona-assistant/registries/retrieval-adapters.ts',
      'src/types/domain.ts',
    ]);
  });

  it('aucune écriture de l’état : ni UPDATE/SET vers VALIDATION_REQUIRED, ni setState / setAnalysisState vers lui', () => {
    for (const f of lecteurs) {
      const src = sansCommentaires(lire(f));
      expect(src, f).not.toMatch(/analysis_state\s*=\s*'VALIDATION_REQUIRED'/);
      expect(src, f).not.toMatch(/analysisState:\s*'VALIDATION_REQUIRED'/);
      expect(src, f).not.toMatch(/setState\([^)]*'VALIDATION_REQUIRED'\)/);
      expect(src, f).not.toMatch(/setAnalysisState\([^)]*,\s*'VALIDATION_REQUIRED'\s*\)/);
    }
  });

  it('route de validation et service retirés', () => {
    expect(existsSync(join(ROOT, 'src/app/api/documents/[id]/commit/route.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'src/services/documents/document-validation.service.ts'))).toBe(false);
  });
});

describe('VALID-10 — reprise de l’existant : BO et tâche planifiée', () => {
  const rapport = (o: Partial<ValidationRepriseReport>): ValidationRepriseReport => ({
    mode: 'apply', runId: '00000000-0000-4000-8000-000000000000', origin: 'BO', scanned: 3, processed: 3, skipped: 0, pendingProposals: 5,
    rules: { written: 1, created: 2, updated: 0, closed: 0, errors: 0 }, equipment: { linksCreated: 1, cards: 0, ambiguous: 0 },
    openCards: 0, failed: [], samples: [], more: false, ...o,
  });

  it('rattrapage BO « document-validation » : Simuler / Appliquer, filtre compte, motif obligatoire à l’application', () => {
    const def = BACKFILL_DEFINITIONS.find((d) => d.script === 'document-validation')!;
    expect(def).toMatchObject({ actions: ['simulate', 'apply'], accountFilter: true, order: 10 });
    expect(validateBackfillRequest({ script: 'document-validation', action: 'simulate' })).toMatchObject({ ok: true });
    expect(validateBackfillRequest({ script: 'document-validation', action: 'apply', reason: 'x' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(validateBackfillRequest({ script: 'document-validation', action: 'restore', runId: '00000000-0000-4000-8000-000000000000' })).toMatchObject({ ok: false, code: 'ACTION_NOT_SUPPORTED' });
  });

  it('synthèse BO et note de tâche', () => {
    const s = summarizeBackfill('document-validation', 'apply', null, { result: rapport({}) });
    expect(s.headline).toBe('Application : 3 document(s) repris, 1 donnée(s) écrite(s), 2 carte(s) « À traiter » créée(s), 1 lien(s) équipement posé(s), 0 échec(s).');
    expect(s.scriptRunId).toBe('00000000-0000-4000-8000-000000000000');
    expect(summarizeBackfill('document-validation', 'simulate', null, { result: rapport({ mode: 'simulate', processed: 0, openCards: 2 }) }).headline)
      .toBe('Simulation : 3 document(s) « à valider » à reprendre, 5 proposition(s) en attente, 2 carte(s) « À traiter » déjà ouverte(s), 1 lien(s) équipement à poser.');
    expect(formatValidationReprise(rapport({ more: true }))).toMatch(/3 repris, .*reste à traiter$/);
  });

  it('tâche planifiée interne « document-validation-reprise » : toutes les heures, au démarrage', () => {
    expect(findTask('document-validation-reprise')).toMatchObject({ schedule: { kind: 'interval', everyMs: 3_600_000 }, startupDelayMs: 7 * 60_000 });
  });
});
