import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { systemLogos, adminAuditLog } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  try {
    await requireAdmin(request);

    const { id } = await context.params;

    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json({
        error: 'Valid ID is required',
        code: 'INVALID_ID'
      }, { status: 400 });
    }

    const logoId = parseInt(id);

    const logo = await db.select()
      .from(systemLogos)
      .where(eq(systemLogos.id, logoId))
      .limit(1);

    if (logo.length === 0) {
      return NextResponse.json({
        error: 'Logo not found',
        code: 'LOGO_NOT_FOUND'
      }, { status: 404 });
    }

    return NextResponse.json(logo[0], { status: 200 });

  } catch (error: any) {
    if (error.message?.includes('Unauthorized') || error.message?.includes('Forbidden')) {
      return NextResponse.json({
        error: error.message,
        code: 'AUTH_ERROR'
      }, { status: error.message.includes('Unauthorized') ? 401 : 403 });
    }

    console.error('GET /api/admin/system-logos/[id] error:', error);
    return NextResponse.json({
      error: 'Internal server error: ' + error.message
    }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  context: RouteContext
) {
  try {
    await requireAdmin(request);
    const session = await getSession(request);
    const adminUserId = session.userId;
    const adminEmail = session.email;

    const { id } = await context.params;

    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json({
        error: 'Valid ID is required',
        code: 'INVALID_ID'
      }, { status: 400 });
    }

    const logoId = parseInt(id);

    const existingLogo = await db.select()
      .from(systemLogos)
      .where(eq(systemLogos.id, logoId))
      .limit(1);

    if (existingLogo.length === 0) {
      return NextResponse.json({
        error: 'Logo not found',
        code: 'LOGO_NOT_FOUND'
      }, { status: 404 });
    }

    const body = await request.json();

    if ('code' in body) {
      return NextResponse.json({
        error: 'Code field is immutable and cannot be updated',
        code: 'CODE_IMMUTABLE'
      }, { status: 400 });
    }

    const updatableFields = [
      'label',
      'description',
      'logoType',
      'contentType',
      'logoContent',
      'width',
      'height',
      'isActive',
      'version'
    ];

    const updateData: any = {};
    const updatedFields: Record<string, { old: any; new: any }> = {};

    for (const field of updatableFields) {
      if (field in body) {
        const newValue = body[field];

        if (field === 'logoType') {
          const validTypes = ['WEB_ANIMATED', 'EMAIL_STATIC', 'PDF_STATIC', 'SVG', 'PNG'];
          if (!validTypes.includes(newValue)) {
            return NextResponse.json({
              error: `Invalid logoType. Must be one of: ${validTypes.join(', ')}`,
              code: 'INVALID_LOGO_TYPE'
            }, { status: 400 });
          }
        }

        if (field === 'label' && (!newValue || typeof newValue !== 'string' || newValue.trim() === '')) {
          return NextResponse.json({
            error: 'Label is required and must be a non-empty string',
            code: 'INVALID_LABEL'
          }, { status: 400 });
        }

        if (field === 'contentType' && (!newValue || typeof newValue !== 'string' || newValue.trim() === '')) {
          return NextResponse.json({
            error: 'Content type is required and must be a non-empty string',
            code: 'INVALID_CONTENT_TYPE'
          }, { status: 400 });
        }

        if (field === 'logoContent' && (!newValue || typeof newValue !== 'string' || newValue.trim() === '')) {
          return NextResponse.json({
            error: 'Logo content is required and must be a non-empty string',
            code: 'INVALID_LOGO_CONTENT'
          }, { status: 400 });
        }

        if ((field === 'width' || field === 'height') && (typeof newValue !== 'number' || newValue <= 0)) {
          return NextResponse.json({
            error: `${field} must be a positive number`,
            code: `INVALID_${field.toUpperCase()}`
          }, { status: 400 });
        }

        if (field === 'version' && (typeof newValue !== 'number' || newValue < 1)) {
          return NextResponse.json({
            error: 'Version must be a positive integer',
            code: 'INVALID_VERSION'
          }, { status: 400 });
        }

        if (field === 'isActive' && typeof newValue !== 'boolean') {
          return NextResponse.json({
            error: 'isActive must be a boolean',
            code: 'INVALID_IS_ACTIVE'
          }, { status: 400 });
        }

        const oldValue = existingLogo[0][field as keyof typeof existingLogo[0]];
        if (oldValue !== newValue) {
          updateData[field] = newValue;
          updatedFields[field] = { old: oldValue, new: newValue };
        }
      }
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({
        error: 'No valid fields to update',
        code: 'NO_UPDATES'
      }, { status: 400 });
    }

    updateData.updatedAt = new Date();

    const updated = await db.update(systemLogos)
      .set(updateData)
      .where(eq(systemLogos.id, logoId))
      .returning();

    if (updated.length === 0) {
      return NextResponse.json({
        error: 'Failed to update logo',
        code: 'UPDATE_FAILED'
      }, { status: 500 });
    }

    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId,
      adminEmail,
      actionType: 'TEMPLATE_UPDATE',
      targetType: 'SYSTEM_LOGO',
      targetId: logoId,
      details: JSON.stringify({
        updatedFields,
        code: existingLogo[0].code,
        label: existingLogo[0].label
      })
    });

    return NextResponse.json(updated[0], { status: 200 });

  } catch (error: any) {
    if (error.message?.includes('Unauthorized') || error.message?.includes('Forbidden')) {
      return NextResponse.json({
        error: error.message,
        code: 'AUTH_ERROR'
      }, { status: error.message.includes('Unauthorized') ? 401 : 403 });
    }

    console.error('PUT /api/admin/system-logos/[id] error:', error);
    return NextResponse.json({
      error: 'Internal server error: ' + error.message
    }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: RouteContext
) {
  try {
    await requireAdmin(request);
    const session = await getSession(request);
    const adminUserId = session.userId;
    const adminEmail = session.email;

    const { id } = await context.params;

    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json({
        error: 'Valid ID is required',
        code: 'INVALID_ID'
      }, { status: 400 });
    }

    const logoId = parseInt(id);

    const existingLogo = await db.select()
      .from(systemLogos)
      .where(eq(systemLogos.id, logoId))
      .limit(1);

    if (existingLogo.length === 0) {
      return NextResponse.json({
        error: 'Logo not found',
        code: 'LOGO_NOT_FOUND'
      }, { status: 404 });
    }

    const body = await request.json();
    const { confirmId } = body;

    if (!confirmId || isNaN(parseInt(confirmId))) {
      return NextResponse.json({
        error: 'Confirmation ID is required',
        code: 'MISSING_CONFIRM_ID'
      }, { status: 400 });
    }

    if (parseInt(confirmId) !== logoId) {
      return NextResponse.json({
        error: 'Confirmation ID does not match logo ID',
        code: 'CONFIRM_ID_MISMATCH'
      }, { status: 400 });
    }

    const deleted = await db.delete(systemLogos)
      .where(eq(systemLogos.id, logoId))
      .returning();

    if (deleted.length === 0) {
      return NextResponse.json({
        error: 'Failed to delete logo',
        code: 'DELETE_FAILED'
      }, { status: 500 });
    }

    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId,
      adminEmail,
      actionType: 'TEMPLATE_DELETE',
      targetType: 'SYSTEM_LOGO',
      targetId: logoId,
      details: JSON.stringify({
        code: existingLogo[0].code,
        label: existingLogo[0].label,
        logoType: existingLogo[0].logoType
      })
    });

    return NextResponse.json({
      message: 'Logo deleted successfully',
      deletedLogo: deleted[0]
    }, { status: 200 });

  } catch (error: any) {
    if (error.message?.includes('Unauthorized') || error.message?.includes('Forbidden')) {
      return NextResponse.json({
        error: error.message,
        code: 'AUTH_ERROR'
      }, { status: error.message.includes('Unauthorized') ? 401 : 403 });
    }

    console.error('DELETE /api/admin/system-logos/[id] error:', error);
    return NextResponse.json({
      error: 'Internal server error: ' + error.message
    }, { status: 500 });
  }
}