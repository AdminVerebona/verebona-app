import { NextRequest, NextResponse } from 'next/server';
import { db, ensureMigrations } from '@/db';
import { assets, assetFiles, events, documentTypes, agendaItems } from '@/db/schema';
import { eq, and, desc, sql, isNull, gte, inArray, or, asc, notInArray } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({
  region: process.env.OVH_S3_REGION || 'gra',
  endpoint: process.env.OVH_S3_ENDPOINT || 'https://s3.gra.io.cloud.ovh.net',
  credentials: {
    accessKeyId: process.env.OVH_S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.OVH_S3_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: false,
});

const s3Bucket = process.env.OVH_S3_BUCKET || 'owntrack';

async function getSignedThumbnail(thumbnailUrl: string): Promise<string | null> {
  try {
    const url = new URL(thumbnailUrl);
    const pathname = url.pathname.startsWith('/') ? url.pathname.substring(1) : url.pathname;
    const firstSlash = pathname.indexOf('/');
    if (firstSlash === -1) return null;
    const s3Key = pathname.substring(firstSlash + 1);
    const command = new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key, ResponseContentDisposition: 'inline' });
    return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  } catch {
    return null;
  }
}

const toCount = (value: unknown) => Number(value ?? 0);

export async function GET(req: NextRequest) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    const accountId = session.currentAccountId;

    await ensureMigrations();

    if (!accountId) {
      // Admin users (ADMIN) may not have an account — return empty dashboard data
      if (session.role === 'ADMIN') {
        const documentTypesList = await db
          .select()
          .from(documentTypes)
          .where(eq(documentTypes.isActive, true));

        return NextResponse.json({
          assets: { items: [], total: 0 },
          files: { items: [], total: 0, unassigned: 0, totalToProcess: 0 },
          events: { items: [], total: 0 },
          agenda: { items: [], total: 0 },
          assetMap: {},
          documentTypes: documentTypesList,
        });
      }
      return NextResponse.json({ error: 'No account selected' }, { status: 400 });
    }

    const today = new Date().toISOString().split('T')[0];

    // Charger les données principales en parallèle
    const [
      recentAssets,
      totalAssetsCount,
      recentFiles,
      totalFilesCount,
      unassignedFilesCount,
      toProcessDocumentsCount,
      toProcessEquipementsCount,
      upcomingEvents,
      totalAgendaCount,
      documentTypesList,
      upcomingAgendaItems,
    ] = await Promise.all([
      // Assets récents (hors archivés/transmis)
      db.select()
        .from(assets)
        .where(and(
          eq(assets.accountId, accountId),
          isNull(assets.deletedAt),
          notInArray(assets.status, ['ARCHIVED', 'TRANSMIS'])
        ))
        .orderBy(desc(assets.createdAt))
        .limit(4),

      // Total assets (hors archivés/transmis)
      db.select({ count: sql<number>`count(*)` })
        .from(assets)
        .where(and(
          eq(assets.accountId, accountId),
          isNull(assets.deletedAt),
          notInArray(assets.status, ['ARCHIVED', 'TRANSMIS'])
        )),

      // Fichiers récents
      db.select()
        .from(assetFiles)
        .where(and(
          eq(assetFiles.accountId, accountId),
          or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
          isNull(assetFiles.deletedAt)
        ))
        .orderBy(desc(assetFiles.uploadedAt))
        .limit(8),

      // Total fichiers
      db.select({ count: sql<number>`count(*)` })
        .from(assetFiles)
        .where(and(
          eq(assetFiles.accountId, accountId),
          or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
          isNull(assetFiles.deletedAt)
        )),

      // Fichiers non assignés (legacy — conservé pour rétrocompat)
      db.select({ count: sql<number>`count(*)` })
        .from(assetFiles)
        .where(
          and(
            eq(assetFiles.accountId, accountId),
            or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
            isNull(assetFiles.deletedAt),
            isNull(assetFiles.assetId)
          )
        ),

      // Documents à traiter — logique identique aux motifs calculés dans /api/dashboard/a-traiter
      // missing_title   : retainedTitle, originalFilename ET filename tous vides/null
      // missing_function: retainedFunctionCode ET documentType vides/null, et pas une image
      // missing_link    : aucune liaison parmi assetId, linkedAssetId, linkedRoomId, equipmentId
      db.select({ count: sql<number>`count(*)` })
        .from(assetFiles)
        .where(
          and(
            eq(assetFiles.accountId, accountId),
            or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
            isNull(assetFiles.deletedAt),
            eq(assetFiles.isWebLink, false),
            eq(assetFiles.isIgnored, false),
            or(
              // missing_title : aucun titre utilisable
              and(
                or(isNull(assetFiles.retainedTitle), sql`trim(${assetFiles.retainedTitle}) = ''`),
                or(isNull(assetFiles.originalFilename), sql`trim(${assetFiles.originalFilename}) = ''`),
                or(isNull(assetFiles.filename), sql`trim(${assetFiles.filename}) = ''`)
              ),
              // missing_function : ni retainedFunctionCode ni documentType, et pas une image
              and(
                or(isNull(assetFiles.retainedFunctionCode), sql`trim(${assetFiles.retainedFunctionCode}) = ''`),
                or(isNull(assetFiles.documentType), sql`trim(${assetFiles.documentType}) = ''`),
                sql`${assetFiles.mimeType} NOT LIKE 'image/%'`
              ),
              // missing_link : aucune liaison utile
              and(
                isNull(assetFiles.assetId),
                isNull(assetFiles.linkedAssetId),
                isNull(assetFiles.linkedRoomId),
                isNull(assetFiles.equipmentId)
              ),
              // missing_analysis : jamais analysé par l'IA
              isNull(assetFiles.lastAnalysisAt)
            )
          )
        ),

      // Équipements à traiter — critère à définir, 0 pour l'instant (cohérence avec /api/dashboard/a-traiter)
      Promise.resolve([{ count: 0 }] as { count: number }[]),

      // Événements legacy à venir (conservé pour rétrocompat widget — sera retiré lors de la suppression du domaine events)
      db.select({
        id: events.id,
        title: events.title,
        date: events.date,
        categorie: events.categorie,
        important: events.important,
        asset: {
          id: assets.id,
          name: assets.name,
          thumbnailUrl: assets.thumbnailUrl,
        },
      })
        .from(events)
        .leftJoin(assets, eq(events.assetId, assets.id))
        .where(
          and(
            eq(events.accountId, accountId),
            eq(events.statut, 'planifie'),
            gte(events.date, today)
          )
        )
        .orderBy(asc(events.date))
        .limit(5),

      // Total éléments agenda actifs (hors réalisé + annulé) — KPI carte accueil
      // Doit correspondre exactement aux items affichés dans HomepageAgendaBlock
      db.select({ count: sql<number>`count(*)` })
        .from(agendaItems)
        .where(
          and(
            eq(agendaItems.accountId, accountId),
            or(
              isNull(agendaItems.manualStatus),
              sql`trim(${agendaItems.manualStatus}) = ''`
            )
          )
        ),

      // Types de documents
      db.select()
        .from(documentTypes)
        .where(eq(documentTypes.isActive, true)),

      // Prochains éléments agenda canoniques (remplace deadlines)
      db.select({
        id: agendaItems.id,
        title: agendaItems.title,
        startDate: agendaItems.startDate,
        manualStatus: agendaItems.manualStatus,
        originType: agendaItems.originType,
      })
        .from(agendaItems)
        .where(and(
          eq(agendaItems.accountId, accountId),
          isNull(agendaItems.manualStatus),
          gte(agendaItems.startDate, today)
        ))
        .orderBy(asc(agendaItems.startDate))
        .limit(3)
    ]);

    // Agenda à traiter — items en retard (startDate passée, pas de statut manuel)
    const [overdueAgendaCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(agendaItems)
      .where(and(
        eq(agendaItems.accountId, accountId),
        isNull(agendaItems.manualStatus),
        sql`${agendaItems.startDate} < ${today}`
      ));
    const toProcessAgendaCount = toCount(overdueAgendaCount?.count);

    // Générer les signed URLs pour les previews des fichiers image et PDF
    const filesWithPreviews = await Promise.all(recentFiles.map(async file => {
      const isImage = file.mimeType?.startsWith('image/');
      let previewUrl: string | null = null;
      if (isImage && file.s3Key) {
        try {
          const command = new GetObjectCommand({ Bucket: file.s3Bucket || s3Bucket, Key: file.s3Key, ResponseContentDisposition: 'inline' });
          previewUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        } catch {
          previewUrl = null;
        }
      }
      return { ...file, previewUrl };
    }));

    const fileAssetIds = Array.from(new Set(
      recentFiles
        .map((file) => file.assetId)
        .filter((assetId): assetId is number => typeof assetId === 'number')
    ));

    const fileAssets = fileAssetIds.length > 0
      ? await db.select({
          id: assets.id,
          name: assets.name,
          category: assets.category,
          thumbnailUrl: assets.thumbnailUrl,
        })
          .from(assets)
          .where(and(
            eq(assets.accountId, accountId),
            inArray(assets.id, fileAssetIds),
            isNull(assets.deletedAt)
          ))
      : [];

    // Calculer les statistiques par asset (documents & labels)
    const assetIds = recentAssets.map(a => a.id);
    const assetStats: Record<number, { documentCount: number; documentLabels: string[]; eventCount: number }> = {};

    if (assetIds.length > 0) {
      const [recentAssetFiles, assetEvents] = await Promise.all([
        db.select({
          assetId: assetFiles.assetId,
          documentType: assetFiles.documentType,
        })
        .from(assetFiles)
        .where(and(
          eq(assetFiles.accountId, accountId),
          inArray(assetFiles.assetId, assetIds),
          or(eq(assetFiles.uploadStatus, 'COMPLETED'), isNull(assetFiles.uploadStatus)),
          isNull(assetFiles.deletedAt)
        )),
        db.select({
          assetId: events.assetId,
        })
        .from(events)
        .where(and(
          eq(events.accountId, accountId),
          inArray(events.assetId, assetIds)
        ))
      ]);

      const typeLabels: Record<string, string> = {};
      documentTypesList.forEach(dt => {
        typeLabels[dt.code] = dt.label;
      });

        recentAssetFiles.forEach(file => {
          if (!file.assetId) return;
          if (!assetStats[file.assetId]) {
            assetStats[file.assetId] = { documentCount: 0, documentLabels: [], eventCount: 0 };
          }
          assetStats[file.assetId].documentCount++;
          
            const label = file.documentType ? (typeLabels[file.documentType] || file.documentType) : 'Autre';
            if (label.toUpperCase() !== 'AUTRE' && !assetStats[file.assetId].documentLabels.includes(label) && assetStats[file.assetId].documentLabels.length < 5) {
              assetStats[file.assetId].documentLabels.push(label);
            }
        });

      assetEvents.forEach(event => {
        if (!event.assetId) return;
        if (!assetStats[event.assetId]) {
          assetStats[event.assetId] = { documentCount: 0, documentLabels: [], eventCount: 0 };
        }
        assetStats[event.assetId].eventCount++;
      });
    }

    // Generate signed thumbnail URLs in parallel (eliminates N client-side fetches)
    const assetsWithStats = await Promise.all(recentAssets.map(async asset => ({
      ...asset,
      documentCount: assetStats[asset.id]?.documentCount || 0,
      documentLabels: assetStats[asset.id]?.documentLabels || [],
      eventCount: assetStats[asset.id]?.eventCount || 0,
      signedThumbnailUrl: asset.thumbnailUrl ? await getSignedThumbnail(asset.thumbnailUrl) : null,
    })));

    return NextResponse.json({
      assets: {
        items: assetsWithStats,
        total: toCount(totalAssetsCount[0]?.count)
      },
      files: {
        items: filesWithPreviews,
        total: toCount(totalFilesCount[0]?.count),
        unassigned: toCount(unassignedFilesCount[0]?.count),
        totalToProcess: toCount(toProcessDocumentsCount[0]?.count) + toProcessAgendaCount + toCount(toProcessEquipementsCount[0]?.count)
      },
      events: {
        items: upcomingEvents,
        total: toCount(totalAgendaCount[0]?.count)
      },
      agenda: {
        items: upcomingAgendaItems,
        total: toCount(totalAgendaCount[0]?.count),
      },
      assetMap: fileAssets.reduce((acc, asset) => {
        acc[asset.id] = asset;
        return acc;
      }, {} as Record<number, any>),
      documentTypes: documentTypesList
    }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });

  } catch (error) {
    console.error('Dashboard API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
