import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { emailTemplates, adminAuditLog } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    // Verify admin authentication with JWT
    await await requireAdmin(request);

    const params = await context.params;
    const id = params.id;
    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json(
        { error: 'Valid ID is required', code: 'INVALID_ID' },
        { status: 400 }
      );
    }

    const template = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.id, parseInt(id)))
      .limit(1);

    if (template.length === 0) {
      return NextResponse.json(
        { error: 'Email template not found', code: 'NOT_FOUND' },
        { status: 404 }
      );
    }

    return NextResponse.json(template[0], { status: 200 });
  } catch (error) {
    console.error('GET error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + (error as Error).message },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    // Verify admin authentication with JWT
    await await requireAdmin(request);
    
    // Get session for audit log
    const session = await getSession(request);

    const params = await context.params;
    const id = params.id;
    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json(
        { error: 'Valid ID is required', code: 'INVALID_ID' },
        { status: 400 }
      );
    }

    const templateId = parseInt(id);
    const adminUserId = session.userId;
    const adminEmail = session.email;

    const existingTemplate = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.id, templateId))
      .limit(1);

    if (existingTemplate.length === 0) {
      return NextResponse.json(
        { error: 'Email template not found', code: 'NOT_FOUND' },
        { status: 404 }
      );
    }

    const body = await request.json();
    const { subject, body: emailBody, placeholders, triggerConfig } = body;

    // Validate triggerConfig if provided
    if (triggerConfig !== undefined && triggerConfig !== null) {
      if (typeof triggerConfig === 'string') {
        try {
          const parsed = JSON.parse(triggerConfig);
          
          // Validate structure
          if (typeof parsed !== 'object') {
            return NextResponse.json(
              { error: 'triggerConfig must be a valid JSON object', code: 'INVALID_TRIGGER_CONFIG' },
              { status: 400 }
            );
          }

          // Validate required fields if enabled
          if (parsed.enabled === true) {
            if (!parsed.trigger_event || typeof parsed.trigger_event !== 'string') {
              return NextResponse.json(
                { error: 'trigger_event is required when trigger is enabled', code: 'INVALID_TRIGGER_CONFIG' },
                { status: 400 }
              );
            }

            // Validate trigger_conditions is an object if provided
            if (parsed.trigger_conditions !== undefined && typeof parsed.trigger_conditions !== 'object') {
              return NextResponse.json(
                { error: 'trigger_conditions must be an object', code: 'INVALID_TRIGGER_CONFIG' },
                { status: 400 }
              );
            }
          }
        } catch (parseError) {
          return NextResponse.json(
            { error: 'triggerConfig must be valid JSON', code: 'INVALID_JSON' },
            { status: 400 }
          );
        }
      } else if (typeof triggerConfig === 'object') {
        // Validate structure if object is provided directly
        if (triggerConfig.enabled === true) {
          if (!triggerConfig.trigger_event || typeof triggerConfig.trigger_event !== 'string') {
            return NextResponse.json(
              { error: 'trigger_event is required when trigger is enabled', code: 'INVALID_TRIGGER_CONFIG' },
              { status: 400 }
            );
          }

          if (triggerConfig.trigger_conditions !== undefined && typeof triggerConfig.trigger_conditions !== 'object') {
            return NextResponse.json(
              { error: 'trigger_conditions must be an object', code: 'INVALID_TRIGGER_CONFIG' },
              { status: 400 }
            );
          }
        }
      } else {
        return NextResponse.json(
          { error: 'triggerConfig must be a JSON string or object', code: 'INVALID_TRIGGER_CONFIG' },
          { status: 400 }
        );
      }
    }

    const updateData: {
      subject?: string;
      body?: string;
      placeholders?: string;
      triggerConfig?: string | null;
      updatedAt: Date;
      updatedBy: number;
    } = {
      updatedAt: new Date(),
      updatedBy: adminUserId,
    };

    const updatedFields: string[] = [];

    if (subject !== undefined) {
      updateData.subject = subject;
      updatedFields.push('subject');
    }

    if (emailBody !== undefined) {
      updateData.body = emailBody;
      updatedFields.push('body');
    }

    if (placeholders !== undefined) {
      updateData.placeholders = placeholders;
      updatedFields.push('placeholders');
    }

    if (triggerConfig !== undefined) {
      // Convert to JSON string if object, or store as string
      updateData.triggerConfig = typeof triggerConfig === 'object' 
        ? JSON.stringify(triggerConfig) 
        : triggerConfig;
      updatedFields.push('triggerConfig');
    }

    const updated = await db
      .update(emailTemplates)
      .set(updateData)
      .where(eq(emailTemplates.id, templateId))
      .returning();

    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: adminUserId,
      adminEmail: adminEmail,
      actionType: 'TEMPLATE_UPDATE',
      targetType: 'EMAIL_TEMPLATE',
      targetId: templateId,
      details: JSON.stringify({
        type: existingTemplate[0].type,
        updatedFields: updatedFields,
      }),
    });

    return NextResponse.json(updated[0], { status: 200 });
  } catch (error) {
    console.error('PUT error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + (error as Error).message },
      { status: 500 }
    );
  }
}