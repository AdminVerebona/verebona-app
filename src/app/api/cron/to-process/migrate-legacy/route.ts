/**
 * GET /api/cron/to-process/migrate-legacy — CDC V2.0 §15.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA REPRISE FAIT DIMINUER LE NOMBRE D'ACTIONS
 *
 * C'est le résultat attendu, pas une perte. La V1 créait des éléments sur des
 * champs simplement vides ; P-06 l'interdit en V2. Les actions portant sur une
 * donnée absente du catalogue §10 ne sont donc pas reprises, et le rapport les
 * compte sous `NO_RULE`.
 *
 * Un compte passant de 60 éléments V1 à 12 actions V2 n'a rien perdu : il a
 * cessé de se voir réclamer 48 champs que personne n'aurait renseignés.
 *
 * ── TOUJOURS COMMENCER PAR ?dryRun=1 ──────────────────────────────────────
 *
 *   ?dryRun=1      rapporte sans rien écrire — À FAIRE EN PREMIER
 *   ?account=42    limite la reprise à un compte
 *   ?limit=50      nombre de comptes traités sur ce passage
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { db, ensureMigrations } from '@/db';
import { accounts } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { migrateLegacyActions, type LegacyMigrationReport } from '@/services/to-process/legacy-migration.service';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();

  const p = req.nextUrl.searchParams;
  const dryRun = p.get('dryRun') === '1';
  const accountId = Number(p.get('account')) || undefined;
  const limit = Number(p.get('limit')) || 50;

  const targets = accountId
    ? await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId))
    : await db.select({ id: accounts.id }).from(accounts).limit(limit);

  const perAccount: Array<{ accountId: number; report: LegacyMigrationReport }> = [];
  for (const account of targets) {
    try {
      perAccount.push({
        accountId: account.id,
        report: await migrateLegacyActions(account.id, { dryRun }),
      });
    } catch (e) {
      // Un compte en échec ne doit pas arrêter la reprise des autres : la
      // route est rejouable, et un compte manqué se rattrape au passage
      // suivant.
      console.error('[migrate-legacy] compte', account.id, (e as Error).message);
    }
  }

  const totals = perAccount.reduce(
    (acc, { report }) => ({
      scanned: acc.scanned + report.scanned,
      created: acc.created + report.created,
      updated: acc.updated + report.updated,
    }),
    { scanned: 0, created: 0, updated: 0 },
  );

  return NextResponse.json({ dryRun, accounts: perAccount.length, totals, perAccount });
}
