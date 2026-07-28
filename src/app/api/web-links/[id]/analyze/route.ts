/**
 * POST /api/web-links/[id]/analyze — VERSION REFONDUE (CDC §4.1.5, §8).
 *
 * AVANT : 338 lignes portant leur propre logique Gemini — instanciation du SDK,
 * téléchargement, nettoyage HTML, prompt `extract_agenda_v1`, parsing et
 * persistance. C'était le défaut n°4 du CDC §2.2 : « Les liens web suivent un
 * pipeline séparé, alors qu'ils produisent les mêmes informations qu'un
 * document. »
 *
 * APRÈS : contrôle d'accès, puis délégation au pipeline commun. Le
 * `WebLinkSourceAdapter` porte les seules spécificités du lien web. Le résultat
 * est un `SourceAnalysisResult` identique à celui d'un fichier — critère
 * d'acceptation n°6.
 *
 * Cette route ne contient plus aucun appel modèle.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { runSourceAnalysis } from '@/services/ai/source-analysis';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  const accountId = session.currentAccountId;
  if (!accountId) {
    return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
  }

  const { id } = await params;
  const sourceId = Number(id);
  if (!Number.isInteger(sourceId) || sourceId <= 0) {
    return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
  }

  await ensureMigrations();

  // L'appartenance au compte est revérifiée par l'adaptateur : le pipeline ne
  // fait jamais confiance à l'appelant sur ce point (§11.4).
  const outcome = await runSourceAnalysis({
    sourceType: 'web_link',
    sourceIds: [sourceId],
    accountId,
    userId: session.userId,
  });

  if (outcome.skippedReason === 'quota') {
    return NextResponse.json({ error: 'QUOTA_EXCEEDED' }, { status: 402 });
  }
  if (outcome.skippedReason === 'already_running') {
    return NextResponse.json({ status: 'ANALYZING' }, { status: 202 });
  }
  if (outcome.skippedReason === 'no_valid_source' || outcome.results.length === 0) {
    return NextResponse.json({ error: 'SOURCE_UNAVAILABLE' }, { status: 404 });
  }

  const result = outcome.results[0];
  return NextResponse.json({
    status: 'ANALYZED',
    document: result.document,
    warnings: result.warnings,
    agendaCandidates: result.agendaCandidates,
    // Le rattachement et la mise à jour de la fiche relèvent de la
    // réconciliation (usage 2), déclenchée en aval par événement.
  });
}
