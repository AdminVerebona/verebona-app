import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { systemLogos, adminAuditLog } from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { requireAdmin, getSession } from '@/lib/auth-guards';

const VALID_LOGO_TYPES = ['WEB_ANIMATED', 'EMAIL_STATIC', 'PDF_STATIC', 'SVG', 'PNG'] as const;
type LogoType = typeof VALID_LOGO_TYPES[number];

function isValidLogoType(value: any): value is LogoType {
  return VALID_LOGO_TYPES.includes(value);
}

async function createAuditLog(
  adminUserId: number,
  adminEmail: string,
  actionType: 'TEMPLATE_CREATE' | 'TEMPLATE_UPDATE' | 'TEMPLATE_DELETE',
  targetId: number,
  details: any
) {
  try {
    await db.insert(adminAuditLog).values({
      timestamp: new Date(),
      adminUserId,
      adminEmail,
      actionType,
      targetType: 'SYSTEM_LOGO',
      targetId,
      details: JSON.stringify(details),
    });
  } catch (error) {
    console.error('Failed to create audit log:', error);
  }
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    const { searchParams } = new URL(request.url);
    const logoType = searchParams.get('logoType');
    const isActive = searchParams.get('isActive');
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 100);
    const page = Math.max(parseInt(searchParams.get('page') ?? '1'), 1);
    const offset = (page - 1) * limit;

    let query = db.select().from(systemLogos).$dynamic();
    const conditions = [];

    if (logoType && isValidLogoType(logoType)) {
      conditions.push(eq(systemLogos.logoType, logoType));
    }

    if (isActive !== null && isActive !== undefined) {
      const activeValue = isActive === 'true' || isActive === '1';
      conditions.push(eq(systemLogos.isActive, activeValue));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const results = await query
      .orderBy(desc(systemLogos.createdAt))
      .limit(limit)
      .offset(offset);

    const countQuery = conditions.length > 0
      ? db.select({ count: systemLogos.id }).from(systemLogos).where(and(...conditions))
      : db.select({ count: systemLogos.id }).from(systemLogos);

    const countResult = await countQuery;
    const total = countResult.length;

    const session = await getSession(request);
    await createAuditLog(
      session.userId,
      session.email,
      'TEMPLATE_CREATE',
      0,
      { action: 'list_logos', filters: { logoType, isActive }, total }
    );

    return NextResponse.json({
      data: results,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Admin access required') {
      return NextResponse.json(
        { error: error.message, code: 'FORBIDDEN' },
        { status: 403 }
      );
    }
    console.error('GET system-logos error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + error.message },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);
    const session = await getSession(request);

    const body = await request.json();
    const { code, label, description, logoType, contentType, logoContent, width, height, isActive, version } = body;

    if (!code || typeof code !== 'string' || code.trim() === '') {
      return NextResponse.json(
        { error: 'Code is required and must be a non-empty string', code: 'INVALID_CODE' },
        { status: 400 }
      );
    }

    if (!label || typeof label !== 'string' || label.trim() === '') {
      return NextResponse.json(
        { error: 'Label is required and must be a non-empty string', code: 'INVALID_LABEL' },
        { status: 400 }
      );
    }

    if (!logoType || !isValidLogoType(logoType)) {
      return NextResponse.json(
        { error: 'Invalid logoType. Must be one of: WEB_ANIMATED, EMAIL_STATIC, PDF_STATIC, SVG, PNG', code: 'INVALID_LOGO_TYPE' },
        { status: 400 }
      );
    }

    if (!contentType || typeof contentType !== 'string' || contentType.trim() === '') {
      return NextResponse.json(
        { error: 'ContentType is required and must be a non-empty string', code: 'INVALID_CONTENT_TYPE' },
        { status: 400 }
      );
    }

    if (!logoContent || typeof logoContent !== 'string' || logoContent.trim() === '') {
      return NextResponse.json(
        { error: 'LogoContent is required and must be a non-empty string', code: 'INVALID_LOGO_CONTENT' },
        { status: 400 }
      );
    }

    if (!width || typeof width !== 'number' || width <= 0) {
      return NextResponse.json(
        { error: 'Width is required and must be a positive integer', code: 'INVALID_WIDTH' },
        { status: 400 }
      );
    }

    if (!height || typeof height !== 'number' || height <= 0) {
      return NextResponse.json(
        { error: 'Height is required and must be a positive integer', code: 'INVALID_HEIGHT' },
        { status: 400 }
      );
    }

    const existingLogo = await db.select()
      .from(systemLogos)
      .where(eq(systemLogos.code, code.trim()))
      .limit(1);

    if (existingLogo.length > 0) {
      return NextResponse.json(
        { error: 'A logo with this code already exists', code: 'DUPLICATE_CODE' },
        { status: 409 }
      );
    }

    const newLogo = await db.insert(systemLogos).values({
      code: code.trim(),
      label: label.trim(),
      description: description?.trim() || null,
      logoType,
      contentType: contentType.trim(),
      logoContent: logoContent.trim(),
      width,
      height,
      isActive: isActive !== undefined ? isActive : true,
      version: version || 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).returning();

    await createAuditLog(
      session.userId,
      session.email,
      'TEMPLATE_CREATE',
      newLogo[0].id,
      { action: 'create_logo', code: newLogo[0].code, label: newLogo[0].label }
    );

    return NextResponse.json(newLogo[0], { status: 201 });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Admin access required') {
      return NextResponse.json(
        { error: error.message, code: 'FORBIDDEN' },
        { status: 403 }
      );
    }
    console.error('POST system-logos error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + error.message },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    await requireAdmin(request);
    const session = await getSession(request);

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json(
        { error: 'Valid ID is required', code: 'INVALID_ID' },
        { status: 400 }
      );
    }

    const logoId = parseInt(id);
    const body = await request.json();
    const { label, description, logoType, contentType, logoContent, width, height, isActive, version } = body;

    const existingLogo = await db.select()
      .from(systemLogos)
      .where(eq(systemLogos.id, logoId))
      .limit(1);

    if (existingLogo.length === 0) {
      return NextResponse.json(
        { error: 'Logo not found', code: 'LOGO_NOT_FOUND' },
        { status: 404 }
      );
    }

    const updates: any = {
      updatedAt: new Date(),
    };

    if (label !== undefined) {
      if (typeof label !== 'string' || label.trim() === '') {
        return NextResponse.json(
          { error: 'Label must be a non-empty string', code: 'INVALID_LABEL' },
          { status: 400 }
        );
      }
      updates.label = label.trim();
    }

    if (description !== undefined) {
      updates.description = description?.trim() || null;
    }

    if (logoType !== undefined) {
      if (!isValidLogoType(logoType)) {
        return NextResponse.json(
          { error: 'Invalid logoType. Must be one of: WEB_ANIMATED, EMAIL_STATIC, PDF_STATIC, SVG, PNG', code: 'INVALID_LOGO_TYPE' },
          { status: 400 }
        );
      }
      updates.logoType = logoType;
    }

    if (contentType !== undefined) {
      if (typeof contentType !== 'string' || contentType.trim() === '') {
        return NextResponse.json(
          { error: 'ContentType must be a non-empty string', code: 'INVALID_CONTENT_TYPE' },
          { status: 400 }
        );
      }
      updates.contentType = contentType.trim();
    }

    if (logoContent !== undefined) {
      if (typeof logoContent !== 'string' || logoContent.trim() === '') {
        return NextResponse.json(
          { error: 'LogoContent must be a non-empty string', code: 'INVALID_LOGO_CONTENT' },
          { status: 400 }
        );
      }
      updates.logoContent = logoContent.trim();
    }

    if (width !== undefined) {
      if (typeof width !== 'number' || width <= 0) {
        return NextResponse.json(
          { error: 'Width must be a positive integer', code: 'INVALID_WIDTH' },
          { status: 400 }
        );
      }
      updates.width = width;
    }

    if (height !== undefined) {
      if (typeof height !== 'number' || height <= 0) {
        return NextResponse.json(
          { error: 'Height must be a positive integer', code: 'INVALID_HEIGHT' },
          { status: 400 }
        );
      }
      updates.height = height;
    }

    if (isActive !== undefined) {
      updates.isActive = isActive;
    }

    if (version !== undefined) {
      updates.version = version;
    }

    const updated = await db.update(systemLogos)
      .set(updates)
      .where(eq(systemLogos.id, logoId))
      .returning();

    await createAuditLog(
      session.userId,
      session.email,
      'TEMPLATE_UPDATE',
      logoId,
      { action: 'update_logo', updates, previousCode: existingLogo[0].code }
    );

    return NextResponse.json(updated[0]);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Admin access required') {
      return NextResponse.json(
        { error: error.message, code: 'FORBIDDEN' },
        { status: 403 }
      );
    }
    console.error('PUT system-logos error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + error.message },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await requireAdmin(request);
    const session = await getSession(request);

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id || isNaN(parseInt(id))) {
      return NextResponse.json(
        { error: 'Valid ID is required', code: 'INVALID_ID' },
        { status: 400 }
      );
    }

    const logoId = parseInt(id);
    const body = await request.json();
    const { confirmId } = body;

    if (confirmId !== logoId) {
      return NextResponse.json(
        { error: 'Confirmation ID does not match logo ID', code: 'CONFIRMATION_MISMATCH' },
        { status: 400 }
      );
    }

    const existingLogo = await db.select()
      .from(systemLogos)
      .where(eq(systemLogos.id, logoId))
      .limit(1);

    if (existingLogo.length === 0) {
      return NextResponse.json(
        { error: 'Logo not found', code: 'LOGO_NOT_FOUND' },
        { status: 404 }
      );
    }

    const deleted = await db.delete(systemLogos)
      .where(eq(systemLogos.id, logoId))
      .returning();

    await createAuditLog(
      session.userId,
      session.email,
      'TEMPLATE_DELETE',
      logoId,
      { action: 'delete_logo', code: existingLogo[0].code, label: existingLogo[0].label }
    );

    return NextResponse.json({
      message: 'Logo deleted successfully',
      deletedLogo: deleted[0],
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Admin access required') {
      return NextResponse.json(
        { error: error.message, code: 'FORBIDDEN' },
        { status: 403 }
      );
    }
    console.error('DELETE system-logos error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + error.message },
      { status: 500 }
    );
  }
}