import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

/**
 * GET /api/auth/me
 *
 * Profil de l'utilisateur connecte (CDC §5.6).
 *
 * Les jetons n'etant plus lisibles en JavaScript, c'est cette route qui
 * permet au front-end de savoir s'il existe une session et d'afficher les
 * informations courantes. Les donnees renvoyees sont volontairement
 * limitees a l'affichage : elles ne permettent pas de recreer une session.
 *
 * Retourne 401 si aucune session valide n'est presente.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        username: users.username,
        company: users.company,
        planType: users.planType,
        role: users.role,
        status: users.status,
        locale: users.locale,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (!user) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    return NextResponse.json({ authenticated: true, user });
  } catch {
    // Session absente, expiree ou invalide : reponse neutre.
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
}
