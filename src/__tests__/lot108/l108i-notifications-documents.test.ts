/**
 * Lot 108I — une seule notification maximum par document pour le cycle
 * normal d'import et d'analyse. Tests unitaires L108I-U-*.
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as { React?: typeof React }).React = React;

const ctx = vi.hoisted(() => ({ value: { analyzingCount: 0, analyzingFileIds: [] as number[], analysisStartTimes: {}, recentlyCompletedFileId: null as number | null } }));
vi.mock('@/contexts/AnalysisBannerContext', async (o) => ({
  ...(await o<object>()),
  useAnalysisBanner: () => ctx.value,
}));
vi.mock('sonner', () => ({ toast: vi.fn() }));

const policy = await import('@/lib/notifications/document-notification-policy');
const { MARK_ANALYSIS_FOLLOWED_SQL } = await import('@/services/documents/analysis-follow.service');
const { uploadConfirmationText, confirmerAjout, UPLOAD_CONFIRMATION_MS } = await import('@/lib/upload-confirmation-client');
const { isSuccessfulCompletion } = await import('@/contexts/AnalysisBannerContext');
const { AnalysisBanner, MobileAnalysisBanner, ANALYSIS_DONE_LABEL } = await import('@/components/AnalysisBanner');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { toast } = await import('sonner');

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const doc = (assetFileId: number, o: Partial<{ firstSuccess: boolean; userVisible: boolean }> = {}) =>
  ({ assetFileId, title: `Doc ${assetFileId}`, firstSuccess: true, userVisible: true, ...o });

describe('L108I-U-DEC — réussite d’un lot : notifier ou non (pure)', () => {
  const d = policy.decideLotSuccessNotification;

  it('asynchrone, non suivie, premier succès : UNE notification, clé stable document × T1', () => {
    expect(d({ lotId: 9, followedRecently: false, analysed: [doc(42)] }))
      .toEqual({ notify: true, documents: [{ assetFileId: 42, title: 'Doc 42' }], dedupeKey: 'document:analysis-success:t1:42' });
    // La clé ne dépend PAS du lot : un second lot du même document est dédupliqué.
    expect(d({ lotId: 10, followedRecently: false, analysed: [doc(42)] })).toMatchObject({ dedupeKey: policy.documentSuccessDedupeKey(42) });
  });

  it('plusieurs documents nouveaux : une notification pour le lot, ne nommant que les nouveaux', () => {
    const r = d({ lotId: 9, followedRecently: false, analysed: [doc(1), doc(2, { firstSuccess: false }), doc(3)] });
    expect(r).toEqual({ notify: true, documents: [{ assetFileId: 1, title: 'Doc 1' }, { assetFileId: 3, title: 'Doc 3' }], dedupeKey: 'document:lot-result:9' });
  });

  it('suivie dans l’application : aucune notification (interface)', () => {
    expect(d({ lotId: 9, followedRecently: true, analysed: [doc(42)] })).toEqual({ notify: false, reason: 'followed_in_app' });
  });

  it('réanalyse / reprise / relance par la cohérence (108B) : aucune notification de succès, même non suivie', () => {
    expect(d({ lotId: 9, followedRecently: false, analysed: [doc(42, { firstSuccess: false })] })).toEqual({ notify: false, reason: 'reanalysis' });
    expect(d({ lotId: 9, followedRecently: false, analysed: [doc(42, { firstSuccess: false, userVisible: false })] })).toEqual({ notify: false, reason: 'reanalysis' });
    expect(d({ lotId: 9, followedRecently: false, analysed: [doc(42, { userVisible: false })] })).toEqual({ notify: false, reason: 'technical' });
    expect(d({ lotId: 9, followedRecently: false, analysed: [] })).toEqual({ notify: false, reason: 'no_outcome' });
  });

  it('paramètres centralisés : fenêtre de suivi ≥ 2 relèves, relève visible déclarée', () => {
    expect(policy.ANALYSIS_FOLLOW_FRESHNESS_SECONDS * 1000).toBeGreaterThanOrEqual(2 * policy.ANALYSIS_FOLLOW_POLL_MS);
    expect(policy.analysisStatusUrl(7, true)).toBe('/api/documents/7/analysis-status?suivi=1');
    expect(policy.analysisStatusUrl(7, false)).toBe('/api/documents/7/analysis-status');
  });
});

describe('L108I-U-SUIVI — signal de suivi sans fuite', () => {
  it('compte de la session, destinataire du lot, lot en attente, document du lot ; écriture bornée', () => {
    const q = MARK_ANALYSIS_FOLLOWED_SQL;
    expect(q).toMatch(/l\.account_id = \$1/);
    expect(q).toMatch(/l\.notification_user_id = \$2/);
    expect(q).toMatch(/l\.notification_state = 'awaiting'/);
    expect(q).toMatch(/li\.asset_file_id = \$3/);
    expect(q).toMatch(/followed_at < now\(\) - make_interval\(secs => \$4\)/);
    expect(q).not.toMatch(/RETURNING/);
  });

  it('la route de relève vérifie le document du compte AVANT de poser le suivi, seulement avec ?suivi=1', () => {
    const r = sansCommentaires(src('src/app/api/documents/[id]/analysis-status/route.ts'));
    expect(r.indexOf("error: 'NOT_FOUND'")).toBeLessThan(r.indexOf('markAnalysisFollowed('));
    expect(r).toContain("searchParams?.get(ANALYSIS_FOLLOW_QUERY) === '1'");
    expect(r).toContain('userId: session.userId');
  });

  it('le bandeau ne déclare le suivi que page visible', () => {
    const c = sansCommentaires(src('src/contexts/AnalysisBannerContext.tsx'));
    expect(c).toContain("document.visibilityState === 'visible'");
    expect(c).toContain('analysisStatusUrl(fileId, visible)');
    expect(c).toContain('POLL_INTERVAL_MS = ANALYSIS_FOLLOW_POLL_MS');
  });
});

describe('L108I-U-UI — confirmation discrète de l’ajout et fin d’analyse dans l’interface', () => {
  it('confirmation brève, neutre (pas un succès appuyé), sans cloche', () => {
    expect(uploadConfirmationText({ count: 1, kind: 'file', analysisStarted: true })).toEqual({ title: 'Document ajouté', description: 'Analyse en cours…' });
    expect(uploadConfirmationText({ count: 1, kind: 'web_link', analysisStarted: false })).toEqual({ title: 'Lien web ajouté' });
    expect(uploadConfirmationText({ count: 3, kind: 'file', analysisStarted: true })).toEqual({ title: 'Documents ajoutés', description: 'Analyses en cours…' });
    (globalThis as { window?: unknown }).window = globalThis;
    confirmerAjout({ count: 1, kind: 'file', analysisStarted: false });
    expect(toast).toHaveBeenCalledWith('Document ajouté', { duration: UPLOAD_CONFIRMATION_MS });
    delete (globalThis as { window?: unknown }).window;
    const client = src('src/lib/upload-confirmation-client.ts');
    expect(client).not.toMatch(/toast\.success|fetch\(|\/api\//);
  });

  it('la fenêtre d’ajout n’appelle plus le signalement serveur ; une reprise tardive ne reconfirme pas', () => {
    const dialog = sansCommentaires(src('src/components/documents/unified-document-dialog.tsx'));
    expect(dialog).not.toMatch(/upload-notification|signalerEnvoiReussi/);
    expect(dialog).toContain("if (!bilan.tardif) confirmerAjout({ count: bilan.fileIds.length, kind: 'file', analysisStarted: ctx.isPremium });");
  });

  it('fin d’analyse réussie suivie : « Analyse terminée · Voir » (ordinateur et mobile), rien sinon', () => {
    ctx.value = { analyzingCount: 0, analyzingFileIds: [], analysisStartTimes: {}, recentlyCompletedFileId: 42 };
    const desktop = renderToStaticMarkup(h(TooltipProvider, null, h(AnalysisBanner)));
    expect(desktop).toContain(ANALYSIS_DONE_LABEL);
    expect(desktop).toContain('Voir');
    expect(desktop).toContain('data-analysis-done');
    const mobile = renderToStaticMarkup(h(MobileAnalysisBanner));
    expect(mobile).toContain(ANALYSIS_DONE_LABEL);
    expect(mobile).toContain('md:hidden');
    ctx.value = { ...ctx.value, recentlyCompletedFileId: null };
    expect(renderToStaticMarkup(h(TooltipProvider, null, h(AnalysisBanner)))).toBe('');
    expect(renderToStaticMarkup(h(MobileAnalysisBanner))).toBe('');
    // Aucune couleur brute : jetons de la charte.
    expect(src('src/components/AnalysisBanner.tsx')).not.toMatch(/#[0-9a-fA-F]{3,6}\b|text-(green|red|blue)-\d/);
  });

  it('fin réussie = statut fonctionnel COMPLETED (sinon état brut abouti) ; un échec n’affiche pas « terminée »', () => {
    expect(isSuccessfulCompletion({ processingStatus: 'COMPLETED' })).toBe(true);
    expect(isSuccessfulCompletion({ processingStatus: 'FAILED_FINAL', analysisState: 'ANALYZED' })).toBe(false);
    expect(isSuccessfulCompletion({ processingStatus: 'NEEDS_USER_ACTION' })).toBe(false);
    expect(isSuccessfulCompletion({ analysisState: 'VALIDATION_REQUIRED' })).toBe(true);
    expect(isSuccessfulCompletion({ analysisState: 'ANALYSIS_FAILED' })).toBe(false);
    expect(isSuccessfulCompletion(null)).toBe(false);
  });
});

describe('L108I-U-PROD — producteurs : plus de notification d’ajout ni de doublon « analysé »', () => {
  const ROOT = join(process.cwd(), 'src');
  const fichiers = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? fichiers(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
  const prod = fichiers(ROOT).map((p) => ({ rel: relative(ROOT, p), code: readFileSync(p, 'utf8') }))
    .filter(({ rel }) => !/__tests__|\/test\/|\.test\.|\.e2e\./.test(rel));

  it('aucun code applicatif n’émet DOCUMENT_UPLOAD_COMPLETED ni DOCUMENT_ANALYZED (web et push natif : même source)', () => {
    const emetteurs = prod.filter(({ code }) => /type:\s*'DOCUMENT_UPLOAD_COMPLETED'|type:\s*'DOCUMENT_ANALYZED'/.test(sansCommentaires(code))).map((f) => f.rel);
    expect(emetteurs).toEqual([]);
    expect(sansCommentaires(src('src/app/api/documents/upload-notification/route.ts'))).not.toMatch(/emit\(|insert\(|pgClient/);
    expect(sansCommentaires(src('src/app/api/documents/[id]/notify-analyzed/route.ts'))).not.toMatch(/emit\(|insert\(|pgClient/);
  });

  it('le résultat du lot passe par la décision 108I ; les échecs gardent leur notification (lot 81E)', () => {
    const lot = sansCommentaires(src('src/services/ai/source-analysis/lot-notification.ts'));
    expect(lot).toContain("if (outcome.type === 'DOCUMENT_BATCH_COMPLETED') {");
    expect(lot).toContain('decideLotSuccessNotification(');
    expect(lot).toContain('dedupeKey: succes?.dedupeKey ?? lotSuccessDedupeKey(lotId)');
    expect(lot).toContain('lotFailurePayload(lotId, outcome.analysed.length, outcome.failed)');
    const faits = sansCommentaires(src('src/services/ai/source-analysis/lot-success-facts.ts'));
    expect(faits).toContain("r.status = 'completed'");
    expect(faits).toContain('r.created_at < l.created_at');
    expect(faits).toContain('af.account_id = l.account_id');
  });

  it('cloche : compteur non lu, « Tout lu » et historique non touchés (types historiques toujours rendus)', () => {
    const bell = src('src/components/NotificationBell.tsx');
    expect(bell).toContain("case 'DOCUMENT_UPLOAD_COMPLETED':");
    expect(bell).toContain("case 'DOCUMENT_ANALYZED':");
    expect(bell).not.toMatch(/108I/);
  });

  it('migration 1080 additive et idempotente', () => {
    const m = src('src/db/migrations/1080_l108i_notifications_documents.sql');
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS followed_at timestamptz/);
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS notification_skip_reason text/);
    expect(sansCommentaires(m.replace(/^--.*$/gm, ''))).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE)\b/i);
  });
});
