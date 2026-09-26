import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { emailService } from '@/lib/email/email-service';
import { generateAccessToken, generateRefreshToken } from '@/lib/jwt';
import { AccountService } from '@/services/account-service';
import {
  checkEmailVerificationToken,
  consumeEmailVerification,
  isLegacyVerificationToken,
  parseEmailVerificationToken,
} from '@/services/auth/email-verification.service';
import type { UserRole, PlanType, UserStatus } from '@/types/domain';

const baseUrl = () =>
  process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

function redirect(path: string) {
  return NextResponse.redirect(`${baseUrl()}${path}`);
}

/** Offres acceptées dans le paramètre `plan` : il est recopié dans l'URL de redirection. */
const KNOWN_PLANS = new Set(['standard', 'premium', 'premium_duo', 'premium_pro']);

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const plan = searchParams.get('plan'); // 'premium' | 'premium_duo' | 'duo' | null
  // Liste fermée : le paramètre n'est pas signé et finit dans une URL de
  // redirection ; une valeur libre pourrait y injecter d'autres paramètres.
  const rawPlan = plan === 'duo' ? 'premium_duo' : plan;
  const normalizedPlan = rawPlan && KNOWN_PLANS.has(rawPlan) ? rawPlan : null;
  const planSuffix = normalizedPlan ? `&plan=${normalizedPlan}` : '';

  // Garde rétablie : `token` provient de la query string du lien reçu par
  // email, sans rapport avec le stockage local. Le codemod de migration l'a
  // retirée par excès de zèle.
  if (!token) {
    return redirect('/verify-email?error=missing_token');
  }

  // Lien émis avant le passage au jeton signé : refusé, mais expliqué — et
  // l'adresse qu'il contient pré-remplit le renvoi (qui ne révèle rien).
  const legacy = isLegacyVerificationToken(token);
  if (legacy) {
    return redirect(`/verify-email?error=link_outdated&email=${encodeURIComponent(legacy.email)}${planSuffix}`);
  }

  const parsed = parseEmailVerificationToken(token);
  if (!parsed) {
    return redirect(`/verify-email?error=invalid_token${planSuffix}`);
  }

  try {
    // Projection explicite : `select()` enumere toutes les colonnes du schema
    // et fait echouer la verification des qu'une seule manque en base.
    const userResult = await db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        isActive: users.isActive,
        role: users.role,
        planType: users.planType,
        status: users.status,
      })
      .from(users)
      .where(eq(users.id, parsed.userId))
      .limit(1);

    // Compte introuvable ou signature fausse : même réponse. Distinguer les
    // deux dirait à un fabricant de liens quels identifiants existent.
    const user = userResult[0] ?? null;
    const check = checkEmailVerificationToken(token, user);
    if (!check.ok || !user) {
      if (check.ok === false && check.code === 'TOKEN_EXPIRED' && user) {
        // Signature valide : c'est bien le lien de cette adresse, on peut
        // pré-remplir le renvoi.
        return redirect(`/verify-email?error=token_expired&email=${encodeURIComponent(user.email)}${planSuffix}`);
      }
      return redirect(`/verify-email?error=invalid_token${planSuffix}`);
    }

    if (user.isActive) {
      // Usage unique : un lien déjà utilisé n'ouvre plus de session.
      return redirect(`/verify-email?status=already_verified${planSuffix}`);
    }

    // Activation conditionnelle : seule la requête qui fait passer le compte
    // de « non vérifié » à « actif » obtient une session (voir le service).
    if (!(await consumeEmailVerification(user.id))) {
      return redirect(`/verify-email?status=already_verified${planSuffix}`);
    }

    await emailService.send({
      templateCode: 'WELCOME',
      to: user.email,
      variables: {
        firstName: user.firstName,
        loginUrl: `${baseUrl()}/login`,
      },
      userId: user.id,
    }).catch(err => console.error('Failed to send welcome email:', err));

    // Generate auth tokens so the user is logged in immediately after verification
    try {
      const defaultAccount = await AccountService.getUserDefaultAccount(user.id);

      const isSubscribedOrTrialing = !!defaultAccount && ['ACTIVE', 'TRIALING', 'PAST_DUE_GRACE'].includes(defaultAccount.subscriptionStatus);

      const tokenPayload = {
        id: user.id,
        email: user.email,
        role: user.role as UserRole,
        planType: user.planType as PlanType,
        status: user.status as UserStatus,
        currentAccountId: defaultAccount?.id,
        hasActiveAccount: isSubscribedOrTrialing,
      };

      const [accessToken, refreshToken] = await Promise.all([
        generateAccessToken(tokenPayload),
        generateRefreshToken(tokenPayload),
      ]);

      // ══════════════════════════════════════════════════════════════════
      // AUCUN JETON DANS L'URL — CDC cookies §5.1 et §13
      //
      // Cette redirection transportait `at` et `rt` en clair dans la query
      // string. Une URL finit dans l'historique du navigateur, dans l'en-tete
      // `Referer` envoye aux tiers, dans les journaux du reverse proxy et dans
      // les outils de mesure : c'est exactement la fuite de jeton que le
      // chantier « suppression du stockage local » vise a supprimer.
      //
      // Les deux jetons sont deja poses en cookies HttpOnly sur cette meme
      // reponse (ci-dessous) : la session est etablie sans eux. La page de
      // destination les ignorait d'ailleurs deja.
      // ══════════════════════════════════════════════════════════════════
      const params = new URLSearchParams({ status: 'success' });
      if (normalizedPlan) params.set('plan', normalizedPlan);

      const targetPath = normalizedPlan ? '/abonnement/onboarding' : '/verify-email';
      const response = NextResponse.redirect(`${baseUrl()}${targetPath}?${params.toString()}`);

      const isProduction = process.env.NODE_ENV === 'production';
      response.cookies.set('access_token', accessToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 2 * 60 * 60,
        path: '/',
      });
      response.cookies.set('refresh_token', refreshToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60,
        path: '/',
      });

      return response;
    } catch {
      // Token generation failed — fall back to asking user to log in
      return redirect(`/verify-email?status=success${planSuffix}`);
    }

  } catch (error) {
    console.error('Verify email error:', error);
    return redirect('/verify-email?error=server_error');
  }
}
