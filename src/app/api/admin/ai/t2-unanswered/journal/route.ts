/**
 * /api/admin/ai/t2-unanswered/journal — lot 110E, journal BO « Questions
 * sans réponse » (`core/unanswered-journal.ts`).
 *
 *   GET   ?days=30&origin=FREE|SUGGESTION&corpus=ACCOUNT|HELP|RESOURCES
 *         &motive=<code>&status=TO_ANALYZE|TO_FIX|RESOLVED
 *         → groupes de questions proches (texte expurgé), occurrences (lien
 *         vers la trace par identifiant de demande), totaux par motif, et
 *         couverture effective du catalogue des questions Ressources ;
 *   PATCH { groupKey, status, note? } → décision de revue.
 *
 * Administrateurs seulement ; aucun compte ni utilisateur exposé ; le
 * contenu d'une demande reste derrière la route à accès restreint
 * `t2-requests/[requestId]/content` (justification, journalisée).
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  JOURNAL_MOTIVES, JOURNAL_MOTIVE_HINTS, JOURNAL_MOTIVE_LABELS, REVIEW_STATUSES, REVIEW_STATUS_LABELS,
  listUnansweredJournal, setReviewStatus, type JournalCorpus, type JournalOrigin, type ReviewStatus,
} from '@/services/verebona-assistant/core/unanswered-journal';
import type { UnansweredMotive } from '@/services/verebona-assistant/core/resources-answer';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

const un = <T extends string>(v: string | null, ok: readonly T[]): T | null => (v && (ok as readonly string[]).includes(v) ? (v as T) : null);

async function catalogueCoverage() {
  const [{ GUIDE_STOCK }, { checkResourceEvidence }, { loadResourcesCorpus }] = await Promise.all([
    import('@/services/suggestions/shared/stock'),
    import('@/services/suggestions/shared/resource-questions'),
    import('@/services/verebona-assistant/core/resources-corpus.service'),
  ]);
  const c = await loadResourcesCorpus({ staleWhileRevalidate: true }).catch(() => null);
  return GUIDE_STOCK.filter((e) => e.corpus === 'RESOURCES').map((e) => {
    const r = checkResourceEvidence(e.id, c && c.articles.length ? c : null);
    return {
      id: e.id, label: e.label, articleId: r.articleId, revision: r.revision, validatedRevision: r.validatedRevision,
      revisionChanged: r.revisionChanged, status: r.status, proposed: r.status === 'VERIFIED',
      sections: r.answerSections, missingSections: r.missingSections, missingSubjects: r.missingSubjects, corpusVersion: r.corpusVersion,
    };
  });
}

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const p = new URL(req.url).searchParams;
  try {
    const journal = await listUnansweredJournal({
      days: /^\d{1,3}$/.test(p.get('days') ?? '') ? Number(p.get('days')) : 30,
      origin: un<JournalOrigin>(p.get('origin'), ['FREE', 'SUGGESTION']),
      corpus: un<JournalCorpus>(p.get('corpus'), ['ACCOUNT', 'HELP', 'RESOURCES']),
      motive: un<UnansweredMotive>(p.get('motive'), JOURNAL_MOTIVES),
      status: un<ReviewStatus>(p.get('status'), REVIEW_STATUSES),
    });
    const catalog = await catalogueCoverage().catch(() => null);
    return NextResponse.json({
      ...journal, catalog,
      labels: { motives: JOURNAL_MOTIVE_LABELS, hints: JOURNAL_MOTIVE_HINTS, statuses: REVIEW_STATUS_LABELS },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/t2-unanswered/journal');
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const b = (await req.json().catch(() => ({}))) as { groupKey?: unknown; status?: unknown; note?: unknown };
  const status = typeof b.status === 'string' ? un<ReviewStatus>(b.status, REVIEW_STATUSES) : null;
  if (typeof b.groupKey !== 'string' || !status) return NextResponse.json({ error: 'INVALID_REVIEW' }, { status: 400 });
  try {
    const ok = await setReviewStatus({
      groupKey: b.groupKey, status, note: typeof b.note === 'string' ? b.note : null, adminUserId: guard.ctx.adminUserId ?? null,
    });
    if (!ok) return NextResponse.json({ error: 'INVALID_REVIEW' }, { status: 400 });
    return NextResponse.json({ ok: true, groupKey: b.groupKey, status, statusLabel: REVIEW_STATUS_LABELS[status] });
  } catch (e) {
    return toErrorResponse(e, 'PATCH /api/admin/ai/t2-unanswered/journal');
  }
}
