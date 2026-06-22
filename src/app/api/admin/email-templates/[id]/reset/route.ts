import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { emailTemplates, adminAuditLog } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';
import { DEFAULT_EMAIL_TEMPLATES, TemplateType } from '@/lib/email-defaults';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    // Verify admin authentication
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

    // Get existing template
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

    const templateType = existingTemplate[0].type as TemplateType;

    // Check if default exists
    if (!DEFAULT_EMAIL_TEMPLATES[templateType]) {
      return NextResponse.json(
        { error: 'No default template available for this type', code: 'NO_DEFAULT' },
        { status: 400 }
      );
    }

    const defaultTemplate = DEFAULT_EMAIL_TEMPLATES[templateType];

    // Reset to default
    const updated = await db
      .update(emailTemplates)
      .set({
        subject: defaultTemplate.subject,
        body: defaultTemplate.body,
        placeholders: defaultTemplate.placeholders,
        updatedAt: new Date(),
        updatedBy: adminUserId,
      })
      .where(eq(emailTemplates.id, templateId))
      .returning();

    // Log action
    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId: adminUserId,
      adminEmail: adminEmail,
      actionType: 'EMAIL_TEMPLATE_UPDATE',
      targetType: 'EMAIL_TEMPLATE',
      targetId: templateId,
      details: JSON.stringify({
        type: templateType,
        action: 'RESET_TO_DEFAULT',
      }),
    });

    return NextResponse.json(updated[0], { status: 200 });
  } catch (error) {
    console.error('POST reset error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + (error as Error).message },
      { status: 500 }
    );
  }
}
