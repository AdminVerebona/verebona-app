import { NextRequest, NextResponse } from 'next/server';
import { readClientContext } from '@/lib/mobile/client-context';
import { publicMobileConfig, readMobileServerConfig } from '@/lib/mobile/mobile-config';
import { appReturnUrl } from '@/lib/auth/oauth/config';
import { appOAuthReturnKind } from '@/lib/native/oauth-return';

export const dynamic = 'force-dynamic';

/**
 * GET /api/mobile/config — lot 97 (CDC 12 §25 API-07/08, §30 VER-02..06).
 *
 * PUBLIQUE (aucune session) : l'application la lit au démarrage et au retour
 * au premier plan, AVANT toute connexion, pour savoir si elle doit afficher
 * l'écran bloquant « Mise à jour requise » (lien vers la fiche store) et
 * quelles fonctions sont coupées. Environnement servi (préproduction /
 * production) : l'app vérifie qu'elle parle au bon serveur (REC-063/064).
 *
 * Aucune donnée sensible : versions, liens stores, interrupteurs. Jamais
 * soumise au contrôle de version (`isExemptFromVersionGate`).
 */
export async function GET(request: NextRequest) {
  const body = {
    ...publicMobileConfig(readMobileServerConfig(), readClientContext(request)),
    // Lot 95 (PO M1) : FORME du retour Google / Apple vers l'app (https ou
    // schéma privé) — jamais l'adresse elle-même. L'app choisit ainsi le
    // retour attendu par la session d'authentification iOS.
    auth: { appOAuthReturn: appOAuthReturnKind(appReturnUrl()) },
  };
  // Cache court côté client : une coupure d'urgence doit se propager vite.
  // La réponse dépend des en-têtes du client (bloc `client`) : jamais partagée.
  return NextResponse.json(body, { headers: { 'Cache-Control': 'private, max-age=60' } });
}
