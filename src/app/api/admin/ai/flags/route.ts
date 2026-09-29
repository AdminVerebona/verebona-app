/**
 * GET /api/admin/ai/flags — « Drapeaux et commutateurs » (CDC 15 D-01, HC-01).
 *
 * Valeurs EFFECTIVES de ce déploiement : drapeaux `AI_*` (un par usage), file
 * durable T1 et commutateurs de déploiement du CDC 15. Lecture seule : ces
 * valeurs sont des variables d'environnement, elles se changent chez
 * l'hébergeur, jamais depuis l'administration.
 *
 * Aucune base pour les drapeaux : la route répond même si la base est
 * indisponible — c'est justement quand quelque chose ne va pas qu'on veut
 * voir ces valeurs. Seule exception, bornée et sans échec possible :
 * `promptArchitectureWarnings` (CDC 15 D-04) lit la version de configuration
 * effective (1,5 s max, en cache) pour signaler un master déclaré mais non
 * appliqué faute de commutateur `enabled`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { requireAdmin } from '@/lib/auth-guards';
import { buildFlagsSnapshot } from '@/services/ai/flags/flags-snapshot.service';
import { promptArchitectureWarnings } from '@/services/ai/config/prompt-architecture';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  const warnings = await promptArchitectureWarnings().catch(() => []);
  return NextResponse.json(
    { ...buildFlagsSnapshot(), promptArchitectureWarnings: warnings },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
