/**
 * GET/POST /api/cron/admin/grant — attribution du rôle administrateur.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CETTE ROUTE EXISTE
 *
 * `PATCH /api/admin/users/[id]` sait déjà changer un rôle — mais elle exige
 * d'être DÉJÀ administrateur. Sur un environnement où personne ne l'est
 * encore, il n'existe aucun moyen de le devenir.
 *
 * C'est le problème classique de l'amorçage : la seule porte est fermée de
 * l'intérieur.
 *
 * ── ELLE NE CRÉE JAMAIS DE COMPTE ─────────────────────────────────────────
 *
 * Si l'adresse est inconnue, la route refuse et le dit. Créer un utilisateur
 * ici reviendrait à fabriquer un compte administrateur sans mot de passe
 * vérifié ni acceptation des conditions — une porte dérobée, pas un
 * amorçage.
 *
 * La personne s'inscrit normalement, puis on l'élève.
 *
 * ── TROIS VERROUS ─────────────────────────────────────────────────────────
 *
 * 1. `CRON_SECRET`, comme toutes les routes d'exploitation.
 *
 * 2. En production, `ALLOW_ADMIN_GRANT=true` est exigée en plus. Un secret
 *    d'exploitation ne doit pas suffire à s'octroyer les pleins pouvoirs sur
 *    des données clients : il circule dans des scripts, des journaux, des
 *    copier-coller.
 *
 * 3. L'adresse est nommée explicitement. Aucune promotion en masse.
 *
 * ── `ADMIN` ET NON `SUPER_ADMIN` ──────────────────────────────────────────
 *
 * `requireAdmin` accepte les deux, et aucun code ne les distingue. Mais
 * `DashboardLayout` teste `role === 'ADMIN'` : un `SUPER_ADMIN` aurait accès
 * aux routes sans voir le menu qui y mène.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { db, pgClient, ensureMigrations } from '@/db';
import { users, adminAuditLog } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

/** L'environnement autorise-t-il l'attribution du rôle ? */
function attributionAutorisee(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.ALLOW_ADMIN_GRANT === 'true';
}

function normaliser(email: string): string {
  return email.trim().toLowerCase();
}

/** Diagnostic : qui est administrateur aujourd'hui ? */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();

  const administrateurs = await pgClient<{ id: number; email: string; role: string }[]>`
    SELECT id, email, role FROM users
    WHERE role IN ('ADMIN', 'SUPER_ADMIN')
    ORDER BY id
  `;

  const email = req.nextUrl.searchParams.get('email');
  let cible = null;
  if (email) {
    const [row] = await pgClient<{ id: number; role: string; is_active: boolean }[]>`
      SELECT id, role, is_active FROM users WHERE lower(email) = ${normaliser(email)}
    `;
    cible = row
      ? { existe: true, id: row.id, role: row.role, actif: row.is_active }
      : { existe: false };
  }

  return NextResponse.json({
    administrateurs: administrateurs.map((a) => ({
      id: a.id,
      // Adresse tronquée : ce rapport circule en copier-coller.
      email: a.email.replace(/^(.{2}).*@/, '$1***@'),
      role: a.role,
    })),
    cible,
    attributionAutorisee: attributionAutorisee(),
  });
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  if (!attributionAutorisee()) {
    return NextResponse.json(
      {
        error: 'Attribution du rôle administrateur interdite sur cet environnement.',
        code: 'GRANT_FORBIDDEN',
        remede:
          'Poser ALLOW_ADMIN_GRANT=true si cette élévation est délibérée, puis ' +
          'la retirer aussitôt. Un secret d\'exploitation ne doit pas suffire à ' +
          's\'octroyer les pleins pouvoirs sur des données clients.',
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

  const email = typeof body.email === 'string' ? normaliser(body.email) : null;
  if (!email) {
    return NextResponse.json(
      {
        error: '`email` requis.',
        code: 'EMAIL_REQUIS',
        note: 'Aucune promotion en masse : l\'adresse est nommée explicitement.',
      },
      { status: 400 },
    );
  }

  const [cible] = await pgClient<{ id: number; role: string; is_active: boolean }[]>`
    SELECT id, role, is_active FROM users WHERE lower(email) = ${email}
  `;

  if (!cible) {
    // On ne crée pas : un compte administrateur sans mot de passe vérifié ni
    // conditions acceptées serait une porte dérobée, pas un amorçage.
    return NextResponse.json(
      {
        error: 'Aucun compte pour cette adresse.',
        code: 'UTILISATEUR_INCONNU',
        remede:
          'La personne doit s\'inscrire normalement — inscription, vérification ' +
          'de l\'adresse, acceptation des conditions — puis relancer cet appel.',
      },
      { status: 404 },
    );
  }

  if (cible.role === 'ADMIN' || cible.role === 'SUPER_ADMIN') {
    // Idempotent : relancer ne doit ni échouer, ni rétrograder un SUPER_ADMIN.
    return NextResponse.json({
      statut: 'deja_administrateur',
      utilisateur: cible.id,
      role: cible.role,
    });
  }

  await db.update(users).set({ role: 'ADMIN', updatedAt: new Date() })
    .where(eq(users.id, cible.id));

  // Trace d'audit hors transaction : une trace qui ferait échouer l'élévation
  // serait pire que son absence. Un échec est journalisé sans interrompre.
  try {
    await db.insert(adminAuditLog).values({
      adminUserId: null,
      adminEmail: 'cron:admin-grant',
      actionType: 'ADMIN_ROLE_GRANTED',
      targetType: 'users',
      targetId: cible.id,
      details: JSON.stringify({ ancienRole: cible.role, nouveauRole: 'ADMIN' }),
      timestamp: new Date(),
    });
  } catch (e) {
    console.error('[admin-grant] trace d\'audit non écrite :', (e as Error).message);
  }

  console.warn(
    `[admin-grant] rôle ADMIN attribué à l'utilisateur ${cible.id} ` +
    `(ancien rôle : ${cible.role}).`,
  );

  return NextResponse.json({
    statut: 'attribue',
    utilisateur: cible.id,
    ancienRole: cible.role,
    nouveauRole: 'ADMIN',
    actif: cible.is_active,
    // `/api/users/me` lit le rôle en base avec 30 s de cache, et
    // `requireAdmin` retombe sur la base si le jeton est périmé : la
    // promotion prend effet sans reconnexion.
    note: cible.is_active
      ? 'Effectif sous 30 secondes, sans reconnexion.'
      : 'Compte inactif : la vérification de l\'adresse doit être faite pour se connecter.',
  });
}
