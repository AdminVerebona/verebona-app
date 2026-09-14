/**
 * GET /api/cron/documents/referential-upgrade — CDC V2.0 §11.6, AI-05.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA MISE À NIVEAU PASSE PAR LE MOTEUR EXISTANT
 *
 * Le §11.6 l'impose : « Le retraitement utilise le mécanisme existant
 * d'optimisation des données, pas un job documentaire séparé. » Cette route
 * ne classe donc rien elle-même — elle sélectionne les documents dont la
 * version de référentiel est dépassée et les soumet à `runSourceAnalysis`,
 * en réanalyse technique non facturée.
 *
 * ── TOUJOURS COMMENCER PAR ?dryRun=1 ──────────────────────────────────────
 *
 * Une évolution du référentiel peut concerner tout le parc. Le rapport à
 * blanc donne le volume avant d'engager la moindre analyse, et surtout le
 * nombre de documents portant une valeur utilisateur : ceux-là seront
 * repassés mais jamais écrasés (§11.6), et une meilleure proposition ne
 * produira qu'une action « À arbitrer ».
 *
 * ── PARAMÈTRES ────────────────────────────────────────────────────────────
 *
 *   ?dryRun=1        rapporte sans rien retraiter — À FAIRE EN PREMIER
 *   ?account=42      limite la mise à niveau à un compte
 *   ?limit=200       plafond de documents soumis sur ce passage
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import {
  upgradeCounts,
  upgradeReferential,
} from '@/services/documents/referential-upgrade.service';
import { runSourceAnalysis } from '@/services/ai/source-analysis';

export const dynamic = 'force-dynamic';
/** Une mise à niveau porte sur des milliers de documents. */
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
  // Plafond bas par défaut : chaque document soumis déclenche une analyse.
  // Un passage court, répété par la planification, est préférable à un
  // passage unique qui dépasserait le délai maximal et perdrait son travail.
  const limit = Number(p.get('limit')) || 200;

  const avant = await upgradeCounts(accountId);

  const rapport = await upgradeReferential(
    async (candidate) => {
      await runSourceAnalysis({
        sourceType: 'file',
        sourceIds: [candidate.fileId],
        accountId: candidate.accountId,
        // Réanalyse technique : elle ne doit consommer aucun crédit client.
        // Une évolution de NOTRE référentiel ne se facture pas à l'utilisateur.
        userId: 0,
        billable: false,
      });
    },
    { accountId, limit, dryRun },
  );

  const apres = dryRun ? avant : await upgradeCounts(accountId);

  return NextResponse.json({ dryRun, avant, apres, rapport });
}
