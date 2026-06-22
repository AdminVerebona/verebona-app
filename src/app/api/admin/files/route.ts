import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetFiles, users, assets } from '@/db/schema';
import { eq, and, like, isNull, desc, lt } from 'drizzle-orm';
import { parsePaginationParams, buildPaginationResponse, getCursorId } from '@/lib/pagination';
import { ApiErrors } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

export async function GET(request: NextRequest) {
  try {
    // Check authentication
    try {
      await SessionService.requireAdmin(request);
    } catch (authError) {
      console.error('[API] Auth failed in admin files:', (authError as Error).message);
      return SessionService.handleSessionError(authError);
    }

    const { searchParams } = new URL(request.url);
    const { limit, cursor } = parsePaginationParams(searchParams);
    
    const uParam = searchParams.get('userId');
    const aParam = searchParams.get('assetId');
    const sParam = searchParams.get('uploadStatus');
    const qParam = searchParams.get('search');
    const delParam = searchParams.get('includeDeleted') === 'true';


    const conditions = [];
    
    const cid = getCursorId(cursor);
    if (cid !== null) {
      conditions.push(lt(assetFiles.id, cid));
    }

    if (uParam) {
      const parsedUser = parseInt(uParam);
      if (!isNaN(parsedUser)) {
        conditions.push(eq(assetFiles.userId, parsedUser));
      }
    }

    if (aParam) {
      const parsedAsset = parseInt(aParam);
      if (!isNaN(parsedAsset)) {
        conditions.push(eq(assetFiles.assetId, parsedAsset));
      }
    }

    if (sParam && ['PENDING', 'COMPLETED', 'FAILED'].includes(sParam)) {
      conditions.push(eq(assetFiles.uploadStatus, sParam as any));
    }

    if (qParam) {
      conditions.push(like(assetFiles.originalFilename, `%${qParam}%`));
    }

    if (!delParam) {
      conditions.push(isNull(assetFiles.deletedAt));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const results = await db
      .select({
        file: assetFiles,
        user: {
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
        },
        asset: {
          id: assets.id,
          name: assets.name,
          category: assets.category,
        },
      })
      .from(assetFiles)
      .leftJoin(users, eq(assetFiles.userId, users.id))
      .leftJoin(assets, eq(assetFiles.assetId, assets.id))
      .where(where)
      .orderBy(desc(assetFiles.id))
      .limit(limit + 1);


    const data = results.map((row) => ({
      ...row.file,
      user: row.user?.id ? row.user : null,
      asset: row.asset?.id ? row.asset : null,
    }));

    return NextResponse.json(buildPaginationResponse(data, limit));
  } catch (error) {
    console.error('[API] GET admin files critical error:', error);
    // Ensure we ALWAYS return JSON
    return NextResponse.json(
      { 
        error: 'Internal Server Error', 
        message: (error as Error).message,
        code: 'INTERNAL_ERROR' 
      }, 
      { status: 500 }
    );
  }
}
