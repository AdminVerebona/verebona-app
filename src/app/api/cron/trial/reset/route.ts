/**
 * POST /api/cron/trial/reset — remise à zéro de l'essai, HORS PRODUCTION.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'ANTI-FRAUDE FAIT SON TRAVAIL, ET C'EST LE PROBLÈME
 *
 * `grantTrial` refuse une adresse déjà présente dans `trial_grants` — le §3.4
 * l'exige, et la trace survit à la suppression du compte pour que recréer un
 * compte ne redonne pas un essai.
 *
 * En recette, cela rend le parcours d'inscription **intestable au-delà de la
 * première fois** : chaque nouveau compte créé avec la même adresse démarre
 * restreint, et l'écran annonce que l'essai n'a pas pu être activé.
 *
 * Ce n'est pas un défaut à corriger dans `grantTrial`. C'est un besoin de
 * recette, qui appelle un outil distinct — et clairement borné.
 *
 * ── TROIS VERROUS ─────────────────────────────────────────────────────────
 *
 * 1. `NODE_ENV=production` ET `ALLOW_TRIAL_RESET` absente → refus.
 *    La production ne doit jamais pouvoir effacer une trace d'anti-fraude.
 *
 * 2. `CRON_SECRET` exigé, comme toutes les routes d'exploitation.
 *
 * 3. Une adresse doit être nommée explicitement. Aucune purge globale : elle
 *    rendrait un essai à tout le monde, y compris aux comptes réels.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations, pgClient } from '@/db';
import { grantTrial } from '@/services/trial.service';

export const dynamic = 'force-dynamic';

/**
 * L'environnement autorise-t-il l'effacement d'une trace d'anti-fraude ?
 *
 * En production, `ALLOW_TRIAL_RESET` doit être posée délibérément. Sans elle,
 * la route répond 403 même avec le bon secret — un secret d'exploitation ne
 * doit pas suffire à contourner une règle commerciale.
 */
function resetAutorise(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.ALLOW_TRIAL_RESET === 'true';
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  if (!resetAutorise()) {
    return NextResponse.json(
      {
        error: 'Remise à zéro interdite en production.',
        code: 'RESET_FORBIDDEN',
        remede:
          'Poser ALLOW_TRIAL_RESET=true si cet environnement est bien une recette. ' +
          'Sur un environnement réel, cette route ne doit pas être ouverte.',
      },
      { status: 403 },
    );
  }

  await ensureMigrations();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Corps invalide.' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;
  if (!email) {
    return NextResponse.json(
      {
        error: '`email` requis.',
        code: 'EMAIL_REQUIS',
        note:
          'Aucune purge globale : elle rendrait un essai à tous les comptes, ' +
          'y compris réels.',
      },
      { status: 400 },
    );
  }

  // ── Effacement de la trace ──────────────────────────────────────────────
  const supprimees = await pgClient`
    DELETE FROM trial_grants WHERE lower(email_normalized) = ${email}
    RETURNING id, account_id
  `;

  // ── Nouvelle attribution, si un compte est nommé ────────────────────────
  //
  // Facultative : effacer la trace suffit pour que la PROCHAINE inscription
  // ouvre un essai. Réattribuer sert au compte déjà créé, celui qui affiche
  // « n'a pas pu être activé ».
  let attribution: { granted: boolean; reason?: string } | null = null;
  const accountId = Number(body.accountId) || null;

  if (accountId) {
    const resultat = await grantTrial({ accountId, email });
    attribution = { granted: resultat.granted, reason: resultat.reason };
  }

  return NextResponse.json({
    email: email.replace(/^(.{2}).*@/, '$1***@'),
    tracesSupprimees: supprimees.length,
    comptesConcernes: supprimees.map((r) => r.account_id).filter(Boolean),
    attribution,
    note: attribution?.granted
      ? "Essai réattribué. Rechargez l'application."
      : "Trace effacée : la prochaine inscription avec cette adresse ouvrira un essai.",
  });
}

/** Diagnostic : cette adresse a-t-elle consommé son essai ? */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();

  const email = req.nextUrl.searchParams.get('email')?.trim().toLowerCase();
  if (!email) {
    return NextResponse.json({ error: 'Paramètre `email` requis.' }, { status: 400 });
  }

  const traces = await pgClient<{
    id: number; account_id: number | null; granted_at: Date; expires_at: Date;
  }[]>`
    SELECT id, account_id, granted_at, expires_at
    FROM trial_grants WHERE lower(email_normalized) = ${email}
    ORDER BY granted_at DESC
  `;

  return NextResponse.json({
    email: email.replace(/^(.{2}).*@/, '$1***@'),
    essaiConsomme: traces.length > 0,
    traces: traces.map((t) => ({
      compte: t.account_id,
      accordeLe: t.granted_at,
      expireLe: t.expires_at,
    })),
    // L'explication que l'écran ne donne pas : ce n'est pas une panne.
    explication: traces.length > 0
      ? "Cette adresse a déjà consommé son essai (§3.4). Tout nouveau compte " +
        'créé avec elle démarre sans essai — c\'est le comportement attendu.'
      : "Aucune trace : une inscription avec cette adresse ouvrira un essai.",
    resetPossible: resetAutorise(),
  });
}
