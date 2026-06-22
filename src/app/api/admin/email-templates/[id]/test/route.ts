import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { emailTemplates, adminAuditLog } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';
import { emailService } from '@/lib/email/email-service';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    // Verify admin authentication
    await requireAdmin(request);
    
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

    // Get body
    const body = await request.json();
    const { testEmail } = body;

    if (!testEmail || !testEmail.includes('@')) {
      return NextResponse.json(
        { error: 'Valid test email is required', code: 'INVALID_EMAIL' },
        { status: 400 }
      );
    }

    // Get template
    const template = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.id, templateId))
      .limit(1);

    if (template.length === 0) {
      return NextResponse.json(
        { error: 'Email template not found', code: 'NOT_FOUND' },
        { status: 404 }
      );
    }

    const emailTemplate = template[0];

    // Envoyer l'email de test via EmailService
    // Le service gère automatiquement les variables mock
    const result = await emailService.sendTest(emailTemplate.type.toLowerCase(), testEmail);

    // Log action (best-effort — don't fail the response if audit log fails)
    try {
      await db.insert(adminAuditLog).values({
        adminUserId: adminUserId,
        adminEmail: adminEmail,
        actionType: 'EMAIL_TEMPLATE_UPDATE',
        targetType: 'EMAIL_TEMPLATE',
        targetId: templateId,
        details: JSON.stringify({
          type: emailTemplate.type,
          action: 'TEST_SEND',
          testEmail: testEmail,
          success: result.success,
        }),
      });
    } catch (auditErr) {
      console.warn('[EmailTemplateTest] Audit log failed (non-blocking):', auditErr);
    }

    if (!result.success) {
      return NextResponse.json({
        success: false,
        error: result.error,
        message: 'Échec de l\'envoi de l\'email de test'
      }, { status: 500 });
    }

    // Return success
    return NextResponse.json({
      success: true,
      message: 'Email de test envoyé avec succès',
      details: {
        to: testEmail,
        templateType: emailTemplate.type,
      }
    }, { status: 200 });

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('POST test error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + (error as Error).message },
      { status: 500 }
    );
  }
}