/**
 * Lot 113U (carte Trello #720 « Analyse T1 ko ») — retour d'un lancement
 * d'analyse depuis le tiroir : plus jamais « Impossible de lancer l'analyse.
 * Veuillez réessayer. » pour une cause CONNUE (référentiel fermé, lot 34C) ;
 * le générique ne reste que pour l'inconnu, avec sa référence d'incident.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeErrorFeedback, analyzeHttpFeedback, genericLaunchMessage, nextAttemptLabel, LAUNCH_MESSAGES,
} from '../document-analysis-feedback';
import {
  LAUNCH_CODE_CATEGORY, launchCategoryOf, newIncidentRef, parseIncidentRef, INCIDENT_REF_PATTERN, launchOriginOf, appVersionFromUserAgent,
} from '@/lib/ai/analysis-launch';
import { normalizeLaunchRefusal } from '@/services/ai/source-analysis/launch-refusals';
import { ANALYSIS_FAILED_FINAL_MESSAGE, USER_MESSAGES } from '@/lib/ai/processing-status';

const GENERIQUE = "Impossible de lancer l'analyse. Veuillez réessayer.";
const lire = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('113U — correspondance code → message (flux SSE)', () => {
  it('aucun code connu (hors panne inattendue) ne rend le texte générique', () => {
    for (const [code, cat] of Object.entries(LAUNCH_CODE_CATEGORY)) {
      const r = analyzeErrorFeedback({ code });
      if (cat === 'UNKNOWN') expect(r.message, code).toMatch(/^Impossible de lancer l'analyse/);
      else expect(r.message.startsWith(GENERIQUE), code).toBe(false);
    }
  });

  it('chaque catégorie a son texte précis et actionnable', () => {
    expect(analyzeErrorFeedback({ code: 'UNAUTHORIZED' }).message).toBe(LAUNCH_MESSAGES.SESSION);
    expect(analyzeErrorFeedback({ code: 'INVALID_TOKEN' }).message).toBe(LAUNCH_MESSAGES.SESSION);
    expect(analyzeErrorFeedback({ code: 'MFA_REQUIRED' }).message).toBe(LAUNCH_MESSAGES.MFA);
    expect(analyzeErrorFeedback({ code: 'CGUV_REACCEPTANCE_REQUIRED' }).message).toBe(LAUNCH_MESSAGES.CGUV);
    expect(analyzeErrorFeedback({ code: 'APP_UPDATE_REQUIRED' }).message).toBe(LAUNCH_MESSAGES.APP_UPDATE);
    expect(analyzeErrorFeedback({ code: 'NO_ACCOUNT' }).message).toBe(LAUNCH_MESSAGES.ACCESS);
    expect(analyzeErrorFeedback({ code: 'NOT_FOUND' }).message).toBe(LAUNCH_MESSAGES.NOT_FOUND);
    expect(analyzeErrorFeedback({ code: 'INVALID_ID' }).message).toBe(LAUNCH_MESSAGES.NOT_FOUND);
    expect(analyzeErrorFeedback({ code: 'PLAN_NOT_SUBSCRIBABLE' }).message).toBe(LAUNCH_MESSAGES.PLAN_NOT_SUBSCRIBABLE);
    expect(analyzeErrorFeedback({ code: 'TRIAL_EXPIRED' }).message).toBe(LAUNCH_MESSAGES.TRIAL_EXPIRED);
    expect(analyzeErrorFeedback({ code: 'SUBSCRIPTION_REQUIRED' }).message).toBe(LAUNCH_MESSAGES.SUBSCRIPTION_REQUIRED);
    // Message FONCTIONNEL du serveur conservé (refus d'écriture rédigé pour l'utilisateur).
    expect(analyzeErrorFeedback({ code: 'TRIAL_EXPIRED', message: 'Votre essai est terminé.' }).message).toBe('Votre essai est terminé.');
    const indispo = analyzeErrorFeedback({ code: 'SESSION_UNAVAILABLE' });
    expect(indispo).toMatchObject({ category: 'UNAVAILABLE', autoRetry: true, message: LAUNCH_MESSAGES.UNAVAILABLE });
  });

  it('jamais un texte reçu pour un code non fonctionnel', () => {
    for (const code of ['UNAUTHORIZED', 'INTERNAL_ERROR', 'NOT_FOUND', 'MFA_REQUIRED', 'ZZZ_INCONNU']) {
      expect(analyzeErrorFeedback({ code, message: 'Error: ECONNRESET stack trace' }).message).not.toMatch(/ECONNRESET|stack/);
    }
    expect(analyzeErrorFeedback({ code: '<script>' }).message).toBe(GENERIQUE);
  });

  it('CAUSE #720 : erreur SANS code relayée du pipeline (statut FAILED_FINAL) → issue d’analyse, jamais « impossible de lancer »', () => {
    const relaye = { type: 'error', analysisState: 'ANALYSIS_FAILED', processingStatus: 'FAILED_FINAL', userMessageCode: 'ANALYSIS_FAILED_FINAL' };
    expect(analyzeErrorFeedback(relaye)).toEqual({ level: 'error', message: ANALYSIS_FAILED_FINAL_MESSAGE });
    expect(analyzeErrorFeedback({ ...relaye, processingStatus: 'PENDING' }).level).toBe('info');
  });

  it('job vivant : information, heure de la prochaine tentative ; attente technique : texte du référentiel', () => {
    const futur = new Date(Date.now() + 3_600_000).toISOString();
    const r = analyzeErrorFeedback({ code: 'ALREADY_ANALYZING', nextAttemptAt: futur, message: 'x' });
    expect(r.level).toBe('info');
    expect(r.message).toBe(LAUNCH_MESSAGES.ALREADY_QUEUED_AT(nextAttemptLabel(futur)!));
    expect(r.message).toMatch(/prochaine tentative vers \d{2} h \d{2}/);
    expect(analyzeErrorFeedback({ code: 'ALREADY_ANALYZING', userMessageCode: 'ANALYSIS_WAITING_TECHNICAL', nextAttemptAt: futur }))
      .toMatchObject({ level: 'info', message: USER_MESSAGES.ANALYSIS_WAITING_TECHNICAL });
    expect(nextAttemptLabel(new Date(Date.now() - 1000).toISOString())).toBeNull();
    expect(nextAttemptLabel('n’importe quoi')).toBeNull();
  });

  it('inconnu : générique + référence valide seulement', () => {
    expect(genericLaunchMessage('AN-7K3Q9XM2')).toBe(`${GENERIQUE} Référence : AN-7K3Q9XM2.`);
    expect(genericLaunchMessage('<b>x</b>')).toBe(GENERIQUE);
    expect(analyzeErrorFeedback({ code: 'INTERNAL_ERROR', incidentRef: 'AN-7K3Q9XM2' })).toMatchObject({ category: 'UNKNOWN', incidentRef: 'AN-7K3Q9XM2' });
  });
});

describe('113U — refus HTTP (middleware, proxy, application mobile)', () => {
  it('le code est lu dans `code`, jamais le libellé `error` du middleware', () => {
    expect(analyzeHttpFeedback(401, { error: 'Unauthorized', code: 'INVALID_TOKEN', message: 'Invalid or expired token' }).message).toBe(LAUNCH_MESSAGES.SESSION);
    expect(analyzeHttpFeedback(403, { error: 'Origine non autorisee', code: 'CSRF_ORIGIN_REJECTED' }).message).toBe(LAUNCH_MESSAGES.ACCESS);
    expect(analyzeHttpFeedback(403, { error: 'Forbidden', code: 'MFA_REQUIRED' }).message).toBe(LAUNCH_MESSAGES.MFA);
    expect(analyzeHttpFeedback(426, { error: 'Une mise à jour…', code: 'APP_UPDATE_REQUIRED' }).message).toBe(LAUNCH_MESSAGES.APP_UPDATE);
    expect(analyzeHttpFeedback(403, { error: 'Forbidden', code: 'ACCOUNT_SUSPENDED' }).message).toBe(LAUNCH_MESSAGES.ACCESS);
  });

  it('sans corps exploitable : le statut décide ; seul un statut inconnu reste générique (avec référence)', () => {
    const attendu: Record<number, string> = {
      401: LAUNCH_MESSAGES.SESSION, 403: LAUNCH_MESSAGES.ACCESS, 404: LAUNCH_MESSAGES.NOT_FOUND, 426: LAUNCH_MESSAGES.APP_UPDATE,
      429: LAUNCH_MESSAGES.UNAVAILABLE, 502: LAUNCH_MESSAGES.UNAVAILABLE, 503: LAUNCH_MESSAGES.UNAVAILABLE, 504: LAUNCH_MESSAGES.UNAVAILABLE,
    };
    for (const [st, msg] of Object.entries(attendu)) expect(analyzeHttpFeedback(Number(st), null).message, st).toBe(msg);
    expect(analyzeHttpFeedback(500, '<html>', 'AN-7K3Q9XM2').message).toBe(`${GENERIQUE} Référence : AN-7K3Q9XM2.`);
    expect(analyzeHttpFeedback(503, null)).toMatchObject({ autoRetry: true });
  });

  it('catégorie : code connu prioritaire, sinon statut', () => {
    expect(launchCategoryOf('Unauthorized', 401)).toBe('SESSION');
    expect(launchCategoryOf('NOT_FOUND', 500)).toBe('NOT_FOUND');
    expect(launchCategoryOf('', 418)).toBe('UNKNOWN');
  });
});

describe('113U — référence d’incident, origine, journal normalisé', () => {
  it('référence courte, alphabet sans ambiguïté', () => {
    const refs = new Set(Array.from({ length: 200 }, () => newIncidentRef()));
    expect(refs.size).toBe(200);
    for (const r of refs) expect(r).toMatch(INCIDENT_REF_PATTERN);
    expect(parseIncidentRef('an-7k3q9xm2')).toBe('AN-7K3Q9XM2');
    expect(parseIncidentRef('AN-ILOU0000')).toBeNull();
  });

  it('origine Web / iOS / Android (en-tête, sinon marqueur de la vue mobile)', () => {
    expect(launchOriginOf('IOS', null)).toBe('IOS');
    expect(launchOriginOf(null, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) VerebonaApp/1.4.0 (52; preprod)')).toBe('IOS');
    expect(launchOriginOf(null, 'Mozilla/5.0 (Linux; Android 15) VerebonaApp/1.4.0 (52; prod)')).toBe('ANDROID');
    expect(launchOriginOf(null, 'Mozilla/5.0 (iPhone) Safari')).toBe('WEB');
    expect(appVersionFromUserAgent('x VerebonaApp/1.4.0 (52; preprod)')).toBe('1.4.0 (52)');
  });

  it('ligne de journal : codes et états seulement, aucun texte libre', () => {
    const row = normalizeLaunchRefusal({
      incidentRef: 'AN-7K3Q9XM2', source: 'server', code: 'MFA_REQUIRED', httpStatus: 200, assetFileId: 42, accountId: 5, userId: 3,
      client: 'IOS', appVersion: '1.4.0 (52)', processingStatus: 'FAILED_FINAL',
      detail: { userMessageCode: 'ANALYSIS_FAILED_FINAL', reason: 'Error: secret key=abc stack', retryScheduled: false },
    });
    expect(row).toMatchObject({ code: 'MFA_REQUIRED', category: 'MFA', level: 'error', client: 'IOS', assetFileId: 42 });
    expect(row!.detail).toEqual({ userMessageCode: 'ANALYSIS_FAILED_FINAL', retryScheduled: false });
    expect(normalizeLaunchRefusal({ incidentRef: 'pas-une-ref', source: 'server', code: 'X' })).toBeNull();
    expect(normalizeLaunchRefusal({ incidentRef: 'AN-7K3Q9XM2', source: 'client', code: 'texte libre !' })!.code).toBe('UNKNOWN_CODE');
    expect(normalizeLaunchRefusal({ incidentRef: 'AN-7K3Q9XM2', source: 'server', code: 'ALREADY_ANALYZING' })!.level).toBe('info');
  });
});

describe('113U — câblage (route, tiroir, BO)', () => {
  const route = lire('src/app/api/documents/[id]/analyze/route.ts');
  const tiroir = lire('src/components/assets/DocumentDrawer.tsx');

  it('route : un `error` du pipeline n’est jamais relayé comme verdict ; erreurs de session propagées ; job vivant avant les contrôles d’offre', () => {
    expect(route).toMatch(/evt\.type === 'error' \? \{ \.\.\.evt, type: 'state_update' \}/);
    expect(route).toMatch(/isKnownSessionError\(e\)/);
    expect(route.indexOf('signalLiveJob(assetFileId')).toBeLessThan(route.indexOf('refuserSiPasDIA(accountId)'));
    expect(route).toMatch(/recordLaunchRefusal\(/);
    expect(route).not.toMatch(/writer\.write\(sseEvent\(\{ type: 'error'/);
  });

  it('tiroir : départ commun (en-têtes, renouvellement), état relu après tout échec, prochaine tentative affichée', () => {
    expect(tiroir).toMatch(/startAnalyzeRequest\(doc\.id/);
    expect(tiroir).not.toMatch(/analyzeErrorFeedback\(\{ code: err\.error/);
    expect(tiroir).toMatch(/await relireEtat\(fileId\)/);
    expect(tiroir).toMatch(/data-testid="document-analysis-next-attempt"/);
    expect(tiroir).not.toMatch(/Erreur lors de l'analyse\. Veuillez réessayer\./);
    // Relance proposée seulement sur un échec (jamais sur « en file d'attente » / attente technique).
    expect(tiroir).toMatch(/\(analysisState === 'ANALYSIS_FAILED' && retryCount < 2\) \?/);
  });

  it('BO : panneau des refus dans la file d’attente IA, table déclarée aux registres', () => {
    expect(lire('src/app/admin/ai-queue/page.tsx')).toMatch(/<LaunchRefusalsPanel/);
    for (const f of ['src/services/admin/diagnostics-export/coverage.ts', 'src/services/admin/diagnostics-export/recette-catalog.ts', 'src/services/backup/schema-signature.ts']) {
      expect(lire(f), f).toMatch(/document_analysis_launch_refusals/);
    }
    const sql = lire('src/db/migrations/1550_l113u_refus_lancement_analyse.sql');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS document_analysis_launch_refusals/);
    const instructions = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(instructions).not.toMatch(/DROP|ALTER TABLE asset_files/);
  });
});
