/**
 * GET/POST /api/cron/ai/corpus-account — compte technique de mesure. CDC §11.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UNE ROUTE PLUTÔT QUE LE SEED
 *
 * `npm run db:seed:corpus-account` suppose un accès à la base depuis un poste.
 * La préproduction n'en offre pas — et c'est bien ainsi.
 *
 * Le serveur, lui, a déjà la connexion. Même raisonnement que pour les
 * amorçages et la reprise du classement.
 *
 * ── POURQUOI UN COMPTE SÉPARÉ ─────────────────────────────────────────────
 *
 * Les appels d'une campagne de mesure sont facturés comme les autres. Les
 * rattacher à un compte client mélangerait ses coûts réels avec ceux de la
 * mesure — et fausserait précisément le chiffrage que le corpus sert à
 * produire avant une bascule.
 *
 * ── LE COMPTE N'EST PAS UTILISABLE ────────────────────────────────────────
 *
 * `is_active = false` sur l'utilisateur : personne ne peut s'y connecter. Le
 * mot de passe vaut `!corpus-no-login` — aucun hachage bcrypt ne commence par
 * `!`, donc aucune comparaison ne peut réussir.
 *
 * `subscription_status = 'NONE'` : il ne compte pas comme client dans les
 * tableaux d'abonnement ni dans les rapprochements Stripe.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations, pgClient } from '@/db';

export const dynamic = 'force-dynamic';

const EMAIL = 'corpus@verebona.local';
const NOM = 'Corpus de recette IA';

/** État actuel : le compte existe-t-il, et la variable est-elle posée ? */
async function etat() {
  const rows = await pgClient<{ account_id: number; user_id: number }[]>`
    SELECT a.id AS account_id, u.id AS user_id
    FROM users u JOIN accounts a ON a.owner_user_id = u.id
    WHERE u.email = ${EMAIL}
    LIMIT 1
  `;
  const declare = Number(process.env.CORPUS_ACCOUNT_ID) || null;
  return {
    compte: rows[0]?.account_id ?? null,
    utilisateur: rows[0]?.user_id ?? null,
    variableDeclaree: declare,
    // Un compte créé mais non déclaré ne sert à rien : la campagne lit la
    // variable, pas la base.
    coherent: rows[0] ? rows[0].account_id === declare : declare === null,
  };
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  await ensureMigrations();

  const e = await etat();
  return NextResponse.json({
    ...e,
    note: e.compte === null
      ? 'Compte absent. Appeler cette route en POST pour le créer.'
      : e.coherent
        ? 'Compte présent et déclaré. La campagne peut s’exécuter.'
        : `Compte ${e.compte} présent, mais CORPUS_ACCOUNT_ID vaut ${e.variableDeclaree ?? 'rien'}. ` +
          'Corriger la variable côté hébergeur, puis redémarrer.',
  });
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  await ensureMigrations();

  const existant = await etat();
  if (existant.compte !== null) {
    // Idempotent : deux comptes de mesure disperseraient les coûts et
    // rendraient la comparaison entre campagnes impossible.
    return NextResponse.json({
      statut: 'deja_present',
      ...existant,
      aFaire: existant.coherent
        ? null
        : `Poser CORPUS_ACCOUNT_ID=${existant.compte} côté hébergeur, puis redémarrer.`,
    });
  }

  const [utilisateur] = await pgClient<{ id: number }[]>`
    INSERT INTO users (email, password_hash, first_name, last_name, is_active, role,
                       plan_type, accepted_terms_at, terms_version)
    VALUES (${EMAIL}, '!corpus-no-login', 'Corpus', 'Recette', false, 'USER',
            'PREMIUM', now(), 'n/a')
    RETURNING id
  `;

  const [compte] = await pgClient<{ id: number }[]>`
    INSERT INTO accounts (name, owner_user_id, plan_type, subscription_status, is_active)
    VALUES (${NOM}, ${utilisateur.id}, 'PREMIUM', 'NONE', true)
    RETURNING id
  `;

  return NextResponse.json({
    statut: 'cree',
    compte: compte.id,
    utilisateur: utilisateur.id,
    aFaire: `Poser CORPUS_ACCOUNT_ID=${compte.id} côté hébergeur, puis redémarrer.`,
  });
}
