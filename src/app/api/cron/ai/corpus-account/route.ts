/**
 * GET/POST /api/cron/ai/corpus-account — compte technique de mesure. CDC §11.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UNE ROUTE PLUTÔT QUE LE SEED
 *
 * `npm run db:seed:corpus-account` suppose un accès à la base depuis un poste.
 * La préproduction n'en offre pas — et c'est bien ainsi. Le serveur, lui, a
 * déjà la connexion.
 *
 * Lot 103G : la route délègue au mécanisme UNIQUE
 * (`services/ai/qualification/technical-account.ts`) — le même que le seed,
 * l'action auditée du BO (Configuration IA › Compte technique de
 * qualification) et l'auto-provisionnement de préproduction :
 *   · GET  : diagnostic en lecture seule (motif CORPUS_ACCOUNT_*, variable
 *            déclarée / cohérente, prochain geste, campagnes et
 *            incompatibilités affectées) ;
 *   · POST : provisionnement IDEMPOTENT (crée, ou marque le compte existant à
 *            l'identité dédiée ; jamais de doublon, jamais un compte client),
 *            puis contrôle (anomalie de Supervision résolue si réparé).
 * Le compte n'est ni connectable (utilisateur inactif, mot de passe marqueur
 * `!`), ni facturable (`subscription_status = NONE`, aucun Stripe).
 * Aucune adresse e-mail client ni secret dans la réponse.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';

export const dynamic = 'force-dynamic';

function autorise(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!autorise(req)) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  await ensureMigrations();
  const { corpusAccountDiagnostic } = await import('@/services/ai/qualification/technical-account-diagnostic');
  const d = await corpusAccountDiagnostic();
  return NextResponse.json({
    ...d,
    // Compatibilité des champs historiques de la route.
    compte: d.status.accountId ?? d.status.markedAccountId,
    variableDeclaree: d.status.variable.value,
    coherent: d.status.ok,
    note: d.status.ok ? 'Compte présent et conforme. La campagne peut s’exécuter.' : `${d.status.code} : ${d.status.reasons.join(' ; ')}. ${d.status.nextAction ?? ''}`.trim(),
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  if (!autorise(req)) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  await ensureMigrations();
  const { provisionCorpusAccount, checkCorpusAccount } = await import('@/services/ai/qualification/technical-account');
  const r = await provisionCorpusAccount({ actor: 'cron-route' });
  const check = await checkCorpusAccount({ report: true, impact: { source: 'POST /api/cron/ai/corpus-account' } });
  return NextResponse.json({
    statut: r.status === 'created' ? 'cree' : r.status === 'refused' ? 'refuse' : r.status === 'marked' ? 'marque' : 'deja_present',
    compte: r.accountId, utilisateur: r.userId, message: r.message, check,
    aFaire: check.ok ? (check.warnings[0] ?? null) : check.nextAction,
  }, { status: r.status === 'refused' ? 409 : 200 });
}
