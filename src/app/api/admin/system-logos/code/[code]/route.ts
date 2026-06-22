import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { systemLogos } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;

    // Validate code parameter
    if (!code || typeof code !== 'string' || code.trim() === '') {
      return NextResponse.json(
        { 
          error: 'Valid code parameter is required',
          code: 'INVALID_CODE'
        },
        { status: 400 }
      );
    }

    // Query database for logo by code (active only)
    const [logo] = await db
      .select({
        id: systemLogos.id,
        code: systemLogos.code,
        label: systemLogos.label,
        logoType: systemLogos.logoType,
        contentType: systemLogos.contentType,
        logoContent: systemLogos.logoContent,
        width: systemLogos.width,
        height: systemLogos.height,
        version: systemLogos.version,
      })
      .from(systemLogos)
      .where(and(
        eq(systemLogos.code, code.trim()),
        eq(systemLogos.isActive, true)
      ))
      .limit(1);

    // Return 404 if logo not found or inactive
    if (!logo) {
      return NextResponse.json(
        { 
          error: 'Logo not found or inactive',
          code: 'LOGO_NOT_FOUND'
        },
        { status: 404 }
      );
    }

    // Return logo object
    return NextResponse.json(logo, { status: 200 });

  } catch (error) {
    console.error('GET /api/admin/system-logos/code/[code] error:', error);
    return NextResponse.json(
      { 
        error: 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error'),
        code: 'INTERNAL_ERROR'
      },
      { status: 500 }
    );
  }
}