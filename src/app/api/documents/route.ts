import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles, assets, documentTypes } from '@/db/schema';
import { eq, and, sql, isNull, or } from 'drizzle-orm';

function matchesSearch(
  doc: { fileName: string | null; originalFilename?: string | null; assetName: string | null; documentType: string | null; retainedTitle?: string | null; retainedFunctionCode?: string | null; description?: string | null; extractedText?: string | null },
  terms: string[],
  typeLabels: Record<string, string>
): boolean {
  const typeCode = doc.retainedFunctionCode || doc.documentType || '';
  const typeLabel = typeCode ? (typeLabels[typeCode] ?? typeCode) : '';
  const haystack = [
    doc.fileName ?? '',
    doc.originalFilename ?? '',
    doc.assetName ?? '',
    typeCode,
    typeLabel,
    doc.retainedTitle ?? '',
    doc.description ?? '',
    doc.extractedText ?? '',
  ].join(' ').toLowerCase();
  return terms.every(t => haystack.includes(t));
}
import { getSession } from '@/lib/auth-guards';

// Valid document types from schema
const VALID_DOCUMENT_TYPES = ['FACTURE', 'GARANTIE', 'MANUEL', 'CONTRAT', 'CERTIFICAT', 'AUTRE'] as const;

// Helper to get file extension
function getFileExtension(fileName: string): string {
  const parts = fileName.toLowerCase().split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

// Helper to map format filter to extensions
function matchesFormat(fileName: string, format: string): boolean {
  const ext = getFileExtension(fileName);
  
  switch (format) {
    case 'pdf':
      return ext === 'pdf';
    case 'image':
      return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext);
    case 'word':
      return ['doc', 'docx'].includes(ext);
    case 'excel':
      return ['xls', 'xlsx', 'csv'].includes(ext);
    case 'autre':
      // Anything that's not pdf, image, word, or excel
      return !['pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'doc', 'docx', 'xls', 'xlsx', 'csv'].includes(ext);
    default:
      return true;
  }
}

/**
 * DELETE /api/documents — not supported on the collection.
 * Use DELETE /api/documents/{id} to delete a specific document.
 */
export async function DELETE() {
  return NextResponse.json(
    {
      error: 'METHOD_NOT_ALLOWED',
      message: 'DELETE is not supported on the document collection. Use DELETE /api/documents/{id} to delete a specific document.',
    },
    { status: 405, headers: { Allow: 'GET' } }
  );
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session.currentAccountId) {
      return NextResponse.json(
        { error: 'UNAUTHORIZED', message: 'No account selected' },
        { status: 401 }
      );
    }
    const accountId = session.currentAccountId;
    const { searchParams } = new URL(request.url);

    // Parse query params
    const assetId = searchParams.get('assetId');
    const documentType = searchParams.get('documentType');
    const format = searchParams.get('format');
    const searchRaw = searchParams.get('search') ?? '';
    const searchTerms = searchRaw.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const sortBy = searchParams.get('sortBy') || 'createdAt';
    const sortDir = searchParams.get('sortDir') || 'desc';
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = Math.min(parseInt(searchParams.get('pageSize') || '20'), 1000);

    // Validate sortBy and sortDir
    const validSortBy = ['fileName', 'assetName', 'documentType', 'mimeType', 'createdAt', 'documentDate'];
    const validSortDir = ['asc', 'desc'];
    const finalSortBy = validSortBy.includes(sortBy) ? sortBy : 'documentDate';
    const finalSortDir = validSortDir.includes(sortDir) ? sortDir : 'desc';

    // Load document type labels for search enrichment
    const allDocTypes = await db.select({ code: documentTypes.code, label: documentTypes.label }).from(documentTypes);
    const typeLabels: Record<string, string> = {};
    for (const dt of allDocTypes) typeLabels[dt.code] = dt.label.toLowerCase();

    // Get total count (all account documents, no filters) - only COMPLETED and not deleted
    const totalResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(assetFiles)
      .where(
        and(
          eq(assetFiles.accountId, accountId),
          or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
          isNull(assetFiles.deletedAt)
        )
      );
    const total = totalResult[0]?.count || 0;

      // Build query with LEFT JOIN on assets
        let query = db
          .select({
            id: assetFiles.id,
            fileName: assetFiles.originalFilename,
            originalFilename: assetFiles.originalFilename,
            mimeType: assetFiles.mimeType,
            fileSize: assetFiles.size,
            documentType: assetFiles.documentType,
            documentDate: assetFiles.documentDate,
            createdAt: assetFiles.createdAt,
            assetId: assetFiles.assetId,
            assetName: assets.name,
            retainedTitle: assetFiles.retainedTitle,
            retainedFunctionCode: assetFiles.retainedFunctionCode,
            webLinkUrl: assetFiles.webLinkUrl,
            description: assetFiles.description,
            extractedText: assetFiles.extractedText,
            analysisState: assetFiles.analysisState,
            lastAnalysisAt: assetFiles.lastAnalysisAt,
          })

        .from(assetFiles)
        .leftJoin(assets, eq(assetFiles.assetId, assets.id))
        .where(
          and(
            eq(assetFiles.accountId, accountId),
            or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
            isNull(assetFiles.deletedAt)
          )
        )
        .$dynamic();

      // Apply filters
      const conditions = [
        eq(assetFiles.accountId, accountId),
        or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
        isNull(assetFiles.deletedAt)
      ];

    if (assetId) {
      const assetIdInt = parseInt(assetId);
      if (!isNaN(assetIdInt)) {
        conditions.push(eq(assetFiles.assetId, assetIdInt));
      }
    }

    if (documentType && VALID_DOCUMENT_TYPES.includes(documentType as any)) {
      conditions.push(eq(assetFiles.documentType, documentType));
    }

    // Apply conditions
    if (conditions.length > 3) {
      query = query.where(and(...conditions));
    }

    // Get all matching documents (before format filter and pagination)
    const allMatchingDocs = await query;

    // Apply format filter (post-query since it's based on file extension)
    let filteredDocs = allMatchingDocs;
    if (format && format !== 'all') {
      filteredDocs = filteredDocs.filter(doc => matchesFormat(doc.fileName ?? '', format));
    }

    // Apply full-text search across filename, asset name, document type and labels
    if (searchTerms.length > 0) {
      filteredDocs = filteredDocs.filter(doc => matchesSearch(doc, searchTerms, typeLabels));
    }

    const filteredTotal = filteredDocs.length;

    // Apply sorting
    filteredDocs.sort((a, b) => {
      let aVal: any, bVal: any;
      
      switch (finalSortBy) {
        case 'fileName':
          aVal = (a.fileName ?? '').toLowerCase();
          bVal = (b.fileName ?? '').toLowerCase();
          break;
        case 'assetName':
          aVal = (a.assetName || '').toLowerCase();
          bVal = (b.assetName || '').toLowerCase();
          break;
        case 'documentType':
          aVal = a.documentType;
          bVal = b.documentType;
          break;
          case 'mimeType':
            aVal = a.mimeType;
            bVal = b.mimeType;
            break;
          case 'documentDate':
            aVal = a.documentDate ? new Date(a.documentDate).getTime() : 0;
            bVal = b.documentDate ? new Date(b.documentDate).getTime() : 0;
            break;
          case 'createdAt':
          default:

          aVal = new Date(a.createdAt).getTime();
          bVal = new Date(b.createdAt).getTime();
          break;
      }

      if (aVal < bVal) return finalSortDir === 'asc' ? -1 : 1;
      if (aVal > bVal) return finalSortDir === 'asc' ? 1 : -1;
      return 0;
    });

    // Apply pagination
    const offset = (page - 1) * pageSize;
    const paginatedDocs = filteredDocs.slice(offset, offset + pageSize);

    // Format response
    const data = paginatedDocs.map(doc => ({
        id: doc.id,
        fileName: doc.fileName,
        retainedTitle: doc.retainedTitle ?? null,
        mimeType: doc.mimeType,
        fileSize: doc.fileSize,
        documentType: doc.documentType,
        documentDate: doc.documentDate,
        asset: doc.assetId ? {
          id: doc.assetId,
          name: doc.assetName || 'Bien supprimé',
        } : null,
        createdAt: doc.createdAt,
        webLinkUrl: doc.webLinkUrl ?? null,
      }));

    return NextResponse.json({
      data,
      pagination: {
        page,
        pageSize,
        filteredTotal,
        total,
      },
    }, { status: 200 });

  } catch (error) {
    if (error instanceof Response) return error;
    const msg = (error as Error).message;
    if (msg === 'AUTH_REQUIRED' || msg === 'INVALID_TOKEN') {
      return NextResponse.json({ error: 'UNAUTHORIZED', message: 'Authentication required' }, { status: 401 });
    }
    if (msg === 'FORBIDDEN' || msg === 'INSUFFICIENT_PERMISSIONS') {
      return NextResponse.json({ error: 'FORBIDDEN', message: 'Access denied' }, { status: 403 });
    }
    console.error('GET /api/documents error:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' },
      { status: 500 }
    );
  }
}