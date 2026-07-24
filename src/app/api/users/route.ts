import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users, accounts, accountMemberships } from '@/db/schema';
import { eq, like, or, and } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { validatePassword, getPasswordValidationError } from '@/lib/auth/password';
import { emailService } from '@/lib/email/email-service';
import { grantTrial } from '@/services/trial.service';

const VALID_PLAN_TYPES = ['STANDARD', 'PREMIUM', 'PREMIUM_DUO', 'PREMIUM_PRO'];

function excludePasswordHash<T extends { passwordHash?: string }>(user: T): Omit<T, 'passwordHash'> {
  const { passwordHash, ...userWithoutPassword } = user;
  return userWithoutPassword;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    // Single user by ID
    if (id) {
      if (isNaN(parseInt(id))) {
        return NextResponse.json({ error: 'Valid ID is required', code: 'INVALID_ID' }, { status: 400 });
      }

      const user = await db.select().from(users).where(eq(users.id, parseInt(id))).limit(1);

      if (user.length === 0) {
        return NextResponse.json({ error: 'User not found', code: 'USER_NOT_FOUND' }, { status: 404 });
      }

      return NextResponse.json(excludePasswordHash(user[0]), { status: 200 });
    }

    // List users with pagination, search, and filters
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '10'), 100);
    const offset = parseInt(searchParams.get('offset') ?? '0');
    const search = searchParams.get('search');
    const planType = searchParams.get('planType');
    const isActiveParam = searchParams.get('isActive');

    let query = db.select().from(users).$dynamic();

    const conditions: any[] = [];

    // Search condition
    if (search) {
      conditions.push(
        or(
          like(users.email, `%${search}%`),
          like(users.firstName, `%${search}%`),
          like(users.lastName, `%${search}%`),
          like(users.username, `%${search}%`)
        )
      );
    }

    // Filter by planType
    if (planType) {
      conditions.push(eq(users.planType, planType));
    }

    // Filter by isActive
    if (isActiveParam !== null) {
      const isActive = isActiveParam === 'true';
      conditions.push(eq(users.isActive, isActive));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const results = await query.limit(limit).offset(offset);
    const usersWithoutPasswords = results.map((user) => excludePasswordHash(user));

    return NextResponse.json(usersWithoutPasswords, { status: 200 });
  } catch (error) {
    console.error('GET error:', error);
    return NextResponse.json({ error: 'Internal server error: ' + (error as Error).message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      email,
      password,
      firstName,
      lastName,
      username,
      company,
      planType,
      locale,
      acceptedTerms,
      termsVersion,
      inviteToken,
      signupPlan: rawSignupPlan, // 'standard' | 'premium' | 'premium_duo' | 'duo' — plan choisi au signup, pour rediriger vers Stripe après vérification
    } = body;

    const signupPlan = rawSignupPlan === 'duo' ? 'premium_duo' : rawSignupPlan;

    // Validate required fields
    if (!email) {
      return NextResponse.json({ error: 'Email is required', code: 'MISSING_EMAIL' }, { status: 400 });
    }

    if (!password) {
      return NextResponse.json({ error: 'Password is required', code: 'MISSING_PASSWORD' }, { status: 400 });
    }

    if (!firstName) {
      return NextResponse.json({ error: 'First name is required', code: 'MISSING_FIRST_NAME' }, { status: 400 });
    }

    if (!lastName) {
      return NextResponse.json({ error: 'Last name is required', code: 'MISSING_LAST_NAME' }, { status: 400 });
    }

    // Validate CGSU acceptance
    if (!acceptedTerms) {
      return NextResponse.json(
        {
          error: "Vous devez accepter les Conditions Générales d'Utilisation et de Services",
          code: 'TERMS_NOT_ACCEPTED',
        },
        { status: 400 }
      );
    }

    // Validate email format
    if (!email.includes('@')) {
      return NextResponse.json({ error: 'Invalid email format', code: 'INVALID_EMAIL_FORMAT' }, { status: 400 });
    }

    // ✅ OWASP ASVS: Validate password strength
    if (!validatePassword(password)) {
      return NextResponse.json(getPasswordValidationError(), { status: 400 });
    }

    // Validate planType if provided
    if (planType && !VALID_PLAN_TYPES.includes(planType)) {
      return NextResponse.json(
        {
          error: 'Invalid plan type. Must be one of: ' + VALID_PLAN_TYPES.join(', '),
          code: 'INVALID_PLAN_TYPE',
        },
        { status: 400 }
      );
    }

    // Sanitize inputs
    const sanitizedEmail = email.trim().toLowerCase();
    const sanitizedFirstName = firstName.trim();
    const sanitizedLastName = lastName.trim();
    const sanitizedUsername = username ? String(username).trim() : null;

    // Delete any unverified account with this email — unverified = not a real account
    await db.delete(users).where(
      and(
        eq(users.email, sanitizedEmail),
        eq(users.isActive, false)
      )
    );

    // Check if a verified account already exists with this email
    const existingUserByEmail = await db
      .select()
      .from(users)
      .where(and(eq(users.email, sanitizedEmail), eq(users.isActive, true)))
      .limit(1);

    if (existingUserByEmail.length > 0) {
      return NextResponse.json(
        {
          error: 'Cet email est déjà utilisé. Veuillez vous connecter ou utiliser un autre email.',
          code: 'DUPLICATE_EMAIL',
        },
        { status: 409 }
      );
    }

    // Check if user already exists with this username (if provided)
    if (sanitizedUsername) {
      const existingUserByUsername = await db
        .select()
        .from(users)
        .where(eq(users.username, sanitizedUsername))
        .limit(1);

      if (existingUserByUsername.length > 0) {
        return NextResponse.json(
          { error: "Ce nom d'utilisateur est déjà utilisé.", code: 'DUPLICATE_USERNAME' },
          { status: 409 }
        );
      }
    }

    const now = new Date();

    // If this is an invite signup, validate the invite BEFORE creating the user (prevents orphan users)
    let pendingMembership:
      | (typeof accountMemberships.$inferSelect)
      | undefined;

    if (inviteToken) {
      const membershipRows = await db
        .select()
        .from(accountMemberships)
        .where(eq(accountMemberships.inviteToken, String(inviteToken)))
        .limit(1);

      pendingMembership = membershipRows[0];

      if (!pendingMembership || pendingMembership.status !== 'pending') {
        return NextResponse.json({ error: 'Invalid invite token', code: 'INVALID_INVITE_TOKEN' }, { status: 400 });
      }

      if (pendingMembership.invitedEmail && pendingMembership.invitedEmail !== sanitizedEmail) {
        return NextResponse.json({ error: 'Invite token email mismatch', code: 'INVITE_EMAIL_MISMATCH' }, { status: 400 });
      }

      if (pendingMembership.inviteTokenExpiresAt && pendingMembership.inviteTokenExpiresAt.getTime() < Date.now()) {
        return NextResponse.json({ error: 'Invite token expired', code: 'INVITE_TOKEN_EXPIRED' }, { status: 400 });
      }
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

      // Prepare user data
      // isActive = false until email is verified (unless joining via invite)
      const userData = {
        email: sanitizedEmail,
        passwordHash,
        firstName: sanitizedFirstName,
        lastName: sanitizedLastName,
        username: sanitizedUsername,
        company: company || null,
        planType: planType || 'STANDARD',
        isActive: inviteToken ? true : false,
        locale: locale || 'fr-FR',
        acceptedTermsAt: now,
        termsVersion: termsVersion || '1.0',
        createdAt: now,
        updatedAt: now,
      };

    try {
      const insertedUsers = await db.insert(users).values(userData).returning();
      const newUser = insertedUsers[0];

      if (!newUser) {
        return NextResponse.json({ error: 'User creation failed', code: 'USER_CREATION_FAILED' }, { status: 500 });
      }

      if (inviteToken && pendingMembership) {
        await db
          .update(accountMemberships)
          .set({
            userId: newUser.id,
            status: 'active',
            joinedAt: now,
            inviteToken: null,
            inviteTokenExpiresAt: null,
            updatedAt: now,
          })
          .where(eq(accountMemberships.id, pendingMembership.id));
      } else {
        // Create account + owner membership
        const accountName = `Compte de ${sanitizedFirstName} ${sanitizedLastName}`;

        // Accounts table has a different planType enum; keep it consistent.
        const accountPlanType = planType || 'STANDARD';

        const insertedAccounts = await db
          .insert(accounts)
          .values({
            name: accountName,
            ownerUserId: newUser.id,
            planType: accountPlanType,
            subscriptionTier: 'free',
            subscriptionStatus: 'NONE',
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        const newAccount = insertedAccounts[0];

        if (!newAccount) {
          return NextResponse.json({ error: 'Account creation failed', code: 'ACCOUNT_CREATION_FAILED' }, { status: 500 });
        }

        await db.insert(accountMemberships).values({
          accountId: newAccount.id,
          userId: newUser.id,
          role: 'owner',
          status: 'active',
          invitedAt: now,
          joinedAt: now,
          createdAt: now,
          updatedAt: now,
        });

        // Essai gratuit de 7 jours (CDC §3) : automatique, sans carte bancaire
        // et sans objet Stripe. Refuse silencieusement si l'email a deja
        // consomme son essai (anti-fraude via trial_grants).
        try {
          const trial = await grantTrial({ accountId: newAccount.id, email: newUser.email, now });
          if (!trial.granted) {
            console.info('[signup] essai non accorde (deja consomme) pour', newUser.email);
          }
        } catch (trialError) {
          // Un echec d'attribution ne doit pas bloquer la creation du compte.
          console.error('[signup] echec attribution essai:', trialError);
        }
      }

      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'http://localhost:3000';
      const timestamp = Date.now();
      const tokenData = `${newUser.email}:${timestamp}`;
      const token = Buffer.from(tokenData).toString('base64');
      const planParam = signupPlan && ['standard', 'premium', 'premium_duo', 'premium_pro'].includes(signupPlan) ? `&plan=${signupPlan}` : '';
      const verificationUrl = `${baseUrl}/api/auth/verify-email?token=${token}${planParam}`;

      await emailService
        .send({
          templateCode: 'EMAIL_VERIFICATION',
          to: newUser.email,
          variables: {
            firstName: newUser.firstName,
            verificationUrl,
          },
          userId: newUser.id,
        })
        .catch((err) => {
          console.error('Failed to send verification email:', err);
        });

      return NextResponse.json(excludePasswordHash(newUser), { status: 201 });
    } catch (dbError: any) {
      console.error('Database error during user creation:', dbError);

      const errorMessage = dbError.message?.toLowerCase() || '';
      const isConstraintError =
        dbError.code === 'SQLITE_CONSTRAINT' ||
        dbError.code === '23505' ||
        errorMessage.includes('unique constraint') ||
        errorMessage.includes('sqlite_constraint');

      if (isConstraintError) {
        if (errorMessage.includes('email') || errorMessage.includes('users.email')) {
          return NextResponse.json(
            {
              error: 'Cet email est déjà utilisé. Veuillez vous connecter ou utiliser un autre email.',
              code: 'DUPLICATE_EMAIL',
            },
            { status: 409 }
          );
        }

        if (errorMessage.includes('username') || errorMessage.includes('users.username')) {
          return NextResponse.json(
            { error: "Ce nom d'utilisateur est déjà utilisé.", code: 'DUPLICATE_USERNAME' },
            { status: 409 }
          );
        }

        return NextResponse.json(
          {
            error: "Ces informations sont déjà utilisées. Veuillez utiliser d'autres informations.",
            code: 'DUPLICATE_CONSTRAINT',
          },
          { status: 409 }
        );
      }

      return NextResponse.json(
        { error: 'Erreur lors de la création du compte. Veuillez réessayer.', code: 'DATABASE_ERROR' },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('POST error:', error);
    return NextResponse.json({ error: 'Internal server error: ' + (error as Error).message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json({ error: 'Valid ID is required', code: 'INVALID_ID' }, { status: 400 });
    }

    // Check if user exists
    const existingUser = await db.select().from(users).where(eq(users.id, parseInt(id))).limit(1);

    if (existingUser.length === 0) {
      return NextResponse.json({ error: 'User not found', code: 'USER_NOT_FOUND' }, { status: 404 });
    }

    const body = await request.json();
    const {
      firstName,
      lastName,
      username,
      company,
      planType,
      planRenewalDate,
      stripeCustomerId,
      stripeSubscriptionId,
      isActive,
      locale,
    } = body;

    // Validate planType if provided
    if (planType && !VALID_PLAN_TYPES.includes(planType)) {
      return NextResponse.json(
        { error: 'Invalid plan type. Must be one of: ' + VALID_PLAN_TYPES.join(', '), code: 'INVALID_PLAN_TYPE' },
        { status: 400 }
      );
    }

    // Prepare update data
    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (firstName !== undefined) updateData.firstName = String(firstName).trim();
    if (lastName !== undefined) updateData.lastName = String(lastName).trim();
    if (username !== undefined) updateData.username = username ? String(username).trim() : null;
    if (company !== undefined) updateData.company = company || null;
    if (planType !== undefined) updateData.planType = planType;
    if (planRenewalDate !== undefined) updateData.planRenewalDate = planRenewalDate || null;
    if (stripeCustomerId !== undefined) updateData.stripeCustomerId = stripeCustomerId || null;
    if (stripeSubscriptionId !== undefined) updateData.stripeSubscriptionId = stripeSubscriptionId || null;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (locale !== undefined) updateData.locale = locale;

    try {
      const updatedUser = await db.update(users).set(updateData).where(eq(users.id, parseInt(id))).returning();
      return NextResponse.json(excludePasswordHash(updatedUser[0]), { status: 200 });
    } catch (dbError: any) {
      // Check for unique constraint violation
      if (dbError.message && dbError.message.includes('UNIQUE constraint failed')) {
        if (dbError.message.includes('username')) {
          return NextResponse.json({ error: 'Username already exists', code: 'DUPLICATE_USERNAME' }, { status: 400 });
        }
      }
      throw dbError;
    }
  } catch (error) {
    console.error('PUT error:', error);
    return NextResponse.json({ error: 'Internal server error: ' + (error as Error).message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json({ error: 'Valid ID is required', code: 'INVALID_ID' }, { status: 400 });
    }

    // Check if user exists
    const existingUser = await db.select().from(users).where(eq(users.id, parseInt(id))).limit(1);

    if (existingUser.length === 0) {
      return NextResponse.json({ error: 'User not found', code: 'USER_NOT_FOUND' }, { status: 404 });
    }

    const deletedUser = await db.delete(users).where(eq(users.id, parseInt(id))).returning();

    return NextResponse.json(
      {
        message: 'User deleted successfully',
        user: excludePasswordHash(deletedUser[0]),
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('DELETE error:', error);
    return NextResponse.json({ error: 'Internal server error: ' + (error as Error).message }, { status: 500 });
  }
}
