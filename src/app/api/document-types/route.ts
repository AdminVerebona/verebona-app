import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { documentTypes } from '@/db/schema';
import { eq, asc } from 'drizzle-orm';
import { DOCUMENT_TYPE_LIST } from '@/lib/document-type-constants';

// Lookup map: code → hideFromPicker (dérivé de la liste canonique, pas en DB)
const HIDE_FROM_PICKER = new Set(
  DOCUMENT_TYPE_LIST.filter(t => t.hideFromPicker).map(t => t.code)
);

export async function GET(request: NextRequest) {
  try {
    const activeDocumentTypes = await db
      .select({
        id: documentTypes.id,
        code: documentTypes.code,
        label: documentTypes.label,
        isActive: documentTypes.isActive,
      })
      .from(documentTypes)
      .where(eq(documentTypes.isActive, true))
      .orderBy(asc(documentTypes.displayOrder));

    const result = activeDocumentTypes.map(t => ({
      ...t,
      hideFromPicker: HIDE_FROM_PICKER.has(t.code),
    }));

    return NextResponse.json({ documentTypes: result }, { status: 200 });
  } catch (error: any) {
    console.error('GET /api/document-types error:', error);
    return NextResponse.json(
      { error: 'Internal server error: ' + error.message },
      { status: 500 }
    );
  }
}
