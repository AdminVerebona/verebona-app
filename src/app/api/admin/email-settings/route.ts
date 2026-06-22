import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { emailSettings, adminAuditLog } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';

export async function GET(request: NextRequest) {
  try {
    // Require admin authentication
    await requireAdmin(request);

    // Fetch the single settings row where id=1
    const settings = await db.select()
      .from(emailSettings)
      .where(eq(emailSettings.id, 1))
      .limit(1);

    if (settings.length === 0) {
      return NextResponse.json({ 
        error: 'Email settings not found',
        code: 'SETTINGS_NOT_FOUND' 
      }, { status: 404 });
    }

    return NextResponse.json(settings[0], { status: 200 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('GET error:', error);
    return NextResponse.json({ 
      error: 'Internal server error: ' + (error as Error).message 
    }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    // Require admin authentication
    await requireAdmin(request);

    // Get session for admin user info
    const session = await getSession(request);

    const adminUserId = session.userId;
    const adminEmail = session.email;

    // Parse request body
    const body = await request.json();
    const {
      emailsEnabled,
      senderName,
      senderEmail,
      replyToEmail,
      footerText,
      logoUrl,
      logoUrlLight,
      logoUrlDark
    } = body;

    // Validation
    const updates: Record<string, any> = {};
    const updatedFields: Record<string, any> = {};

    if (emailsEnabled !== undefined) {
      if (typeof emailsEnabled !== 'boolean') {
        return NextResponse.json({ 
          error: 'emailsEnabled must be a boolean',
          code: 'INVALID_EMAILS_ENABLED' 
        }, { status: 400 });
      }
      updates.emailsEnabled = emailsEnabled;
      updatedFields.emailsEnabled = emailsEnabled;
    }

    if (senderName !== undefined) {
      if (typeof senderName !== 'string' || senderName.trim() === '') {
        return NextResponse.json({ 
          error: 'senderName must be a non-empty string',
          code: 'INVALID_SENDER_NAME' 
        }, { status: 400 });
      }
      updates.senderName = senderName.trim();
      updatedFields.senderName = senderName.trim();
    }

    if (senderEmail !== undefined) {
      if (typeof senderEmail !== 'string' || !senderEmail.includes('@')) {
        return NextResponse.json({ 
          error: 'senderEmail must be a valid email address',
          code: 'INVALID_SENDER_EMAIL' 
        }, { status: 400 });
      }
      updates.senderEmail = senderEmail.trim().toLowerCase();
      updatedFields.senderEmail = senderEmail.trim().toLowerCase();
    }

    if (replyToEmail !== undefined) {
      if (typeof replyToEmail !== 'string' || !replyToEmail.includes('@')) {
        return NextResponse.json({ 
          error: 'replyToEmail must be a valid email address',
          code: 'INVALID_REPLY_TO_EMAIL' 
        }, { status: 400 });
      }
      updates.replyToEmail = replyToEmail.trim().toLowerCase();
      updatedFields.replyToEmail = replyToEmail.trim().toLowerCase();
    }

    if (footerText !== undefined) {
      if (footerText !== null && typeof footerText !== 'string') {
        return NextResponse.json({ 
          error: 'footerText must be a string or null',
          code: 'INVALID_FOOTER_TEXT' 
        }, { status: 400 });
      }
      updates.footerText = footerText;
      updatedFields.footerText = footerText;
    }

    // Logo URL validations (backward compatibility)
    if (logoUrl !== undefined) {
      if (logoUrl !== null && typeof logoUrl !== 'string') {
        return NextResponse.json({ 
          error: 'logoUrl must be a string or null',
          code: 'INVALID_LOGO_URL' 
        }, { status: 400 });
      }
      updates.logoUrl = logoUrl;
      updatedFields.logoUrl = logoUrl;
    }

    if (logoUrlLight !== undefined) {
      if (logoUrlLight !== null && typeof logoUrlLight !== 'string') {
        return NextResponse.json({ 
          error: 'logoUrlLight must be a string or null',
          code: 'INVALID_LOGO_URL_LIGHT' 
        }, { status: 400 });
      }
      updates.logoUrlLight = logoUrlLight;
      updatedFields.logoUrlLight = logoUrlLight;
    }

    if (logoUrlDark !== undefined) {
      if (logoUrlDark !== null && typeof logoUrlDark !== 'string') {
        return NextResponse.json({ 
          error: 'logoUrlDark must be a string or null',
          code: 'INVALID_LOGO_URL_DARK' 
        }, { status: 400 });
      }
      updates.logoUrlDark = logoUrlDark;
      updatedFields.logoUrlDark = logoUrlDark;
    }

    // Check if any fields to update
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ 
        error: 'No fields provided to update',
        code: 'NO_FIELDS_TO_UPDATE' 
      }, { status: 400 });
    }

    // Check if settings row exists (id=1)
    const existingSettings = await db.select()
      .from(emailSettings)
      .where(eq(emailSettings.id, 1))
      .limit(1);

    if (existingSettings.length === 0) {
      return NextResponse.json({ 
        error: 'Email settings not found',
        code: 'SETTINGS_NOT_FOUND' 
      }, { status: 404 });
    }

    // Update settings
    updates.updatedAt = new Date();
    updates.updatedBy = adminUserId;

    const updated = await db.update(emailSettings)
      .set(updates)
      .where(eq(emailSettings.id, 1))
      .returning();

    // Create audit log entry
    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: adminUserId,
      adminEmail: adminEmail,
      actionType: 'EMAIL_TEMPLATE_UPDATE',
      targetType: 'EMAIL_SETTINGS',
      targetId: 1,
      details: JSON.stringify(updatedFields)
    });

    return NextResponse.json(updated[0], { status: 200 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('PUT error:', error);
    return NextResponse.json({ 
      error: 'Internal server error: ' + (error as Error).message 
    }, { status: 500 });
  }
}