/**
 * GET /api/cron/trial/repair — diagnostic et rattrapage de l'essai gratuit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN ÉCHEC D'ATTRIBUTION EST SILENCIEUX PAR CONCEPTION
 *
 * La création de compte enveloppe `grantTrial` dans un `catch` qui journalise
 * et poursuit — et c'est le bon choix : un essai non attribué ne doit pas
 * faire échouer une inscription.
 *
 * Mais la conséquence est un compte SANS abonnement, donc restreint dès la
 * première seconde. L'utilisateur vient de s'inscrire pour sept jours d'essai
 * et se voit refuser toute écriture.
 *
 * Rien ne le signalait : ni à l'utilisateur, ni à l'exploitant.
 *
 * ── DEUX MODES ────────────────────────────────────────────────────────────
 *
 *   (défaut)   recense les comptes sans abonnement, n'écrit rien
 *   ?repair=1  attribue l'essai aux comptes recensés
 *
 * Le rattrapage respecte l'anti-fraude : `grantTrial` refuse un email ayant
 * déjà consommé son essai, et cette route ne contourne pas ce contrôle.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations, pgClient } from '@/db';
import { grantTrial } from '@/services/trial.service';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

interface CompteSansAbonnement {
  accountId: number;
  email: string;
  createdAt: Date;
  /** Un email déjà présent dans `trial_grants` a consommé son essai. */
  essaiDejaConsomme: boolean;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();

  const repare = req.nextUrl.searchParams.get('repair') === '1';
  const limite = Math.min(Number(req.nextUrl.searchParams.get('limit')) || 50, 500);

  // Comptes actifs dépourvus de toute ligne d'abonnement — l'état exact que
  // produit un `grantTrial` en échec.
  const comptes = await pgClient<CompteSansAbonnement[]>`
    SELECT a.id            AS "accountId",
           u.email         AS email,
           a.created_at    AS "createdAt",
           EXISTS (
             SELECT 1 FROM trial_grants g
             WHERE lower(g.email_normalized) = lower(u.email)
           )               AS "essaiDejaConsomme"
    FROM accounts a
    JOIN users u ON u.id = a.owner_user_id
    LEFT JOIN account_subscriptions s ON s.account_id = a.id
    WHERE s.id IS NULL
      AND a.is_active = true
    ORDER BY a.created_at DESC
    LIMIT ${limite}
  `;

  const rapport = {
    mode: repare ? 'rattrapage' : 'diagnostic',
    comptesSansAbonnement: comptes.length,
    // Ceux-là ne peuvent pas être rattrapés : leur email a déjà servi.
    dejaConsomme: comptes.filter((c) => c.essaiDejaConsomme).length,
    detail: comptes.map((c) => ({
      compte: c.accountId,
      // Adresse tronquée : ce rapport circule en copier-coller.
      email: c.email.replace(/^(.{2}).*@/, '$1***@'),
      creeLe: c.createdAt,
      essaiDejaConsomme: c.essaiDejaConsomme,
    })),
    rattrapes: [] as Array<{ compte: number; resultat: string }>,
  };

  if (!repare) {
    return NextResponse.json({
      ...rapport,
      note:
        comptes.length > 0
          ? 'Relancer avec ?repair=1 pour attribuer l’essai aux comptes éligibles.'
          : 'Aucun compte sans abonnement : rien à rattraper.',
    });
  }

  for (const compte of comptes) {
    try {
      const resultat = await grantTrial({
        accountId: compte.accountId,
        email: compte.email,
        now: new Date(),
      });
      rapport.rattrapes.push({
        compte: compte.accountId,
        resultat: resultat.granted ? 'essai attribué' : `refusé : ${resultat.reason}`,
      });
    } catch (e) {
      // La cause exacte, enfin visible : c'est elle qui manquait à
      // l'inscription, où elle n'atteignait que les journaux du serveur.
      const cause = (e as { cause?: { message?: string; code?: string } }).cause;
      rapport.rattrapes.push({
        compte: compte.accountId,
        resultat: `échec : ${cause?.code ?? ''} ${cause?.message ?? (e as Error).message}`.trim(),
      });
    }
  }

  const echecs = rapport.rattrapes.filter((r) => r.resultat.startsWith('échec'));

  return NextResponse.json(
    {
      ...rapport,
      echecs: echecs.length,
      // Le premier échec suffit presque toujours : ils partagent la cause.
      premiereCause: echecs[0]?.resultat ?? null,
    },
    { status: echecs.length > 0 ? 500 : 200 },
  );
}
