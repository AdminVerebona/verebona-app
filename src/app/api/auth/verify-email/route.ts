import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { emailService } from '@/lib/email/email-service';
import { generateAccessToken, generateRefreshToken } from '@/lib/jwt';
import { AccountService } from '@/services/account-service';
import type { UserRole, PlanType, UserStatus } from '@/types/domain';

const baseUrl = () =>
  process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

function redirect(path: string) {
  return NextResponse.redirect(`${baseUrl()}${path}`);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const plan = searchParams.get('plan'); // 'premium' | 'premium_duo' | 'duo' | null
  const normalizedPlan = plan === 'duo' ? 'premium_duo' : plan;
  const planSuffix = normalizedPlan ? `&plan=${normalizedPlan}` : '';

  if (!token) {
    return redirect('/verify-email?error=missing_token');
  }

  let email: string;
  let timestamp: number;

  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const [emailPart, timestampPart] = decoded.split(':');
    email = emailPart;
    timestamp = parseInt(timestampPart, 10);

    const expiryTime = 24 * 60 * 60 * 1000;
    if (Date.now() - timestamp > expiryTime) {
      return redirect(`/verify-email?error=token_expired${planSuffix}`);
    }
  } catch {
    return redirect(`/verify-email?error=invalid_token${planSuffix}`);
  }

  try {
    const userResult = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (userResult.length === 0) {
      return redirect('/verify-email?error=user_not_found');
    }

    const user = userResult[0];

    if (user.isActive) {
      return redirect(`/verify-email?status=already_verified${planSuffix}`);
    }

    await db
      .update(users)
      .set({ isActive: true, updatedAt: new Date() })
      .where(eq(users.id, user.id));

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

      const params = new URLSearchParams({
        status: 'success',
        at: accessToken,
        rt: refreshToken,
      });
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
