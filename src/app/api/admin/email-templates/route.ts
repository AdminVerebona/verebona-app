import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { emailTemplates, adminAuditLog } from '@/db/schema';
import { requireAdmin, getSession } from '@/lib/auth-guards';

// Valid template types — keep in sync with DEFAULT_EMAIL_TEMPLATES in email-defaults.ts
const VALID_TEMPLATE_TYPES = [
  'WELCOME',
  'PASSWORD_RESET',
  'EMAIL_VERIFICATION',
  'SUBSCRIPTION_EXPIRING',
  'SUBSCRIPTION_EXPIRED',
  'PAYMENT_FAILED',
  'ACCOUNT_SUSPENDED',
  'DEADLINE_REMINDER',
  'ASSET_SHARED',
  'DUO_INVITATION',
  'PREMIUM_CONFIRMATION',
  'DOWNGRADE_NOTIFICATION',
  'MEMBER_REMOVED_DUE_TO_DOWNGRADE',
  'ACCOUNT_INVITATION',
  'CUSTOM',
] as const;

export async function GET(request: NextRequest) {
  try {
    // Verify admin authentication with JWT
    await await requireAdmin(request);

    // Fetch all email templates
    const templates = await db
      .select()
      .from(emailTemplates);

    return NextResponse.json(templates, { status: 200 });

  } catch (error) {
    console.error('GET email templates error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error') },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    // Verify admin authentication
    await await requireAdmin(request);
    
    // Get session for audit log
    const session = await getSession(request);

    const body = await request.json();
    const { type, subject, body: emailBody, placeholders, triggerConfig, sender } = body;

    // Validate required fields
    if (!type || typeof type !== 'string' || type.trim() === '') {
      return NextResponse.json(
        { error: 'type is required and must be a non-empty string', code: 'MISSING_TYPE' },
        { status: 400 }
      );
    }

    if (!subject || typeof subject !== 'string' || subject.trim() === '') {
      return NextResponse.json(
        { error: 'subject is required and must be a non-empty string', code: 'MISSING_SUBJECT' },
        { status: 400 }
      );
    }

    if (!emailBody || typeof emailBody !== 'string' || emailBody.trim() === '') {
      return NextResponse.json(
        { error: 'body is required and must be a non-empty string', code: 'MISSING_BODY' },
        { status: 400 }
      );
    }

    // Validate type against enum
    const normalizedType = type.trim().toUpperCase();
    if (!VALID_TEMPLATE_TYPES.includes(normalizedType as any)) {
      return NextResponse.json(
        { 
          error: `Invalid template type. Must be one of: ${VALID_TEMPLATE_TYPES.join(', ')}`,
          code: 'INVALID_TYPE',
          validTypes: VALID_TEMPLATE_TYPES
        },
        { status: 400 }
      );
    }

    // Validate placeholders is valid JSON if provided
    if (placeholders !== undefined && placeholders !== null) {
      if (typeof placeholders === 'string') {
        try {
          JSON.parse(placeholders);
        } catch (parseError) {
          return NextResponse.json(
            { error: 'placeholders must be valid JSON string', code: 'INVALID_JSON_PLACEHOLDERS' },
            { status: 400 }
          );
        }
      } else if (typeof placeholders === 'object') {
        // If object provided, convert to JSON string
        // Will be handled in insert
      } else {
        return NextResponse.json(
          { error: 'placeholders must be a JSON string or object', code: 'INVALID_PLACEHOLDERS_TYPE' },
          { status: 400 }
        );
      }
    }

    // Validate triggerConfig is valid JSON if provided
    if (triggerConfig !== undefined && triggerConfig !== null) {
      if (typeof triggerConfig === 'string') {
        try {
          const parsed = JSON.parse(triggerConfig);
          
          // Validate structure if enabled
          if (typeof parsed === 'object' && parsed.enabled === true) {
            if (!parsed.trigger_event || typeof parsed.trigger_event !== 'string') {
              return NextResponse.json(
                { error: 'trigger_event is required when trigger is enabled', code: 'INVALID_TRIGGER_CONFIG' },
                { status: 400 }
              );
            }
          }
        } catch (parseError) {
          return NextResponse.json(
            { error: 'triggerConfig must be valid JSON string', code: 'INVALID_JSON_TRIGGER_CONFIG' },
            { status: 400 }
          );
        }
      } else if (typeof triggerConfig === 'object') {
        // Validate structure if enabled
        if (triggerConfig.enabled === true) {
          if (!triggerConfig.trigger_event || typeof triggerConfig.trigger_event !== 'string') {
            return NextResponse.json(
              { error: 'trigger_event is required when trigger is enabled', code: 'INVALID_TRIGGER_CONFIG' },
              { status: 400 }
            );
          }
        }
      } else {
        return NextResponse.json(
          { error: 'triggerConfig must be a JSON string or object', code: 'INVALID_TRIGGER_CONFIG_TYPE' },
          { status: 400 }
        );
      }
    }

    // Validate sender email format if provided
    if (sender !== undefined && sender !== null) {
      if (typeof sender !== 'string') {
        return NextResponse.json(
          { error: 'sender must be a string', code: 'INVALID_SENDER_TYPE' },
          { status: 400 }
        );
      }
      
      const trimmedSender = sender.trim();
      if (trimmedSender !== '' && !trimmedSender.includes('@')) {
        return NextResponse.json(
          { error: 'sender must be a valid email address', code: 'INVALID_SENDER_FORMAT' },
          { status: 400 }
        );
      }
    }

    // Prepare insert data
    const now = new Date();
    const insertData: any = {
      type: normalizedType,
      subject: subject.trim(),
      body: emailBody.trim(),
      updatedAt: now,
      updatedBy: session.userId,
    };

    // Add optional fields
    if (placeholders !== undefined && placeholders !== null) {
      insertData.placeholders = typeof placeholders === 'object' 
        ? JSON.stringify(placeholders) 
        : placeholders;
    }

    if (triggerConfig !== undefined && triggerConfig !== null) {
      insertData.triggerConfig = typeof triggerConfig === 'object' 
        ? JSON.stringify(triggerConfig) 
        : triggerConfig;
    }

    if (sender !== undefined && sender !== null) {
      const trimmedSender = sender.trim();
      insertData.sender = trimmedSender !== '' ? trimmedSender : null;
    }

    // Insert new template
    try {
      const newTemplate = await db
        .insert(emailTemplates)
        .values(insertData)
        .returning();

      if (newTemplate.length === 0) {
        return NextResponse.json(
          { error: 'Failed to create email template', code: 'INSERT_FAILED' },
          { status: 500 }
        );
      }

      // Create audit log entry
      await db.insert(adminAuditLog).values({
        timestamp: now,
        adminUserId: session.userId,
        adminEmail: session.email,
        actionType: 'EMAIL_TEMPLATE_UPDATE',
        targetType: 'EMAIL_TEMPLATE',
        targetId: newTemplate[0].id,
        details: JSON.stringify({
          action: 'CREATE',
          type: normalizedType,
          subject: subject.trim(),
          sender: insertData.sender || null,
        }),
      });

      return NextResponse.json(newTemplate[0], { status: 201 });

    } catch (dbError: any) {
      // Check for unique constraint violation
      if (dbError.message && (dbError.message.includes('UNIQUE constraint failed') || dbError.message.includes('SQLITE_CONSTRAINT') || dbError.code === 'SQLITE_CONSTRAINT')) {
        return NextResponse.json(
          { 
            error: `Email template with type '${normalizedType}' already exists`,
            code: 'DUPLICATE_TYPE' 
          },
          { status: 409 }
        );
      }
      
      console.error('Database error creating email template:', dbError);
      return NextResponse.json(
        { error: 'Database error: ' + (dbError.message || 'Unknown database error'), code: 'DATABASE_ERROR' },
        { status: 500 }
      );
    }

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    
    console.error('POST email templates error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error') },
      { status: 500 }
    );
  }
}