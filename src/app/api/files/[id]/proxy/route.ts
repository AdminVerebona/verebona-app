import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import * as jose from 'jose';

const s3Client = new S3Client({
  region: process.env.OVH_S3_REGION || 'gra',
  endpoint: process.env.OVH_S3_ENDPOINT || 'https://s3.gra.io.cloud.ovh.net',
  credentials: {
    accessKeyId: process.env.OVH_S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.OVH_S3_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: false,
});

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'your-secret-key-change-in-production'
);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const params = await context.params;

  try {
    const { searchParams } = new URL(request.url);
    const queryToken = searchParams.get('token');

    let token: string | null = queryToken;

    // ⚠️ CHAÎNE DE REPLI RÉTABLIE — le codemod l'avait supprimée.
    //
    // Elle est désormais le SEUL chemin fonctionnel. Le paramètre `?token=`
    // a été retiré des appels côté navigateur — un jeton n'a rien à faire
    // dans une URL, qui finit dans l'historique, les en-têtes `Referer` et
    // les journaux du proxy. Sans ce repli sur le cookie, chaque
    // prévisualisation d'image ou de PDF renverrait 401.
    if (!token) {
      const authHeader = request.headers.get('authorization');
      if (authHeader?.startsWith('Bearer ')) token = authHeader.substring(7);
    }
    if (!token) {
      const cookieToken = request.cookies.get('access_token')?.value;
      if (cookieToken) token = cookieToken;
    }

    if (!token) {
      return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
    }

    let accountId: number | undefined;
    try {
      const { payload } = await jose.jwtVerify(token, JWT_SECRET);
      accountId = payload.currentAccountId as number | undefined;
      if (!accountId) {
        return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 401 });
      }
    } catch {
      return NextResponse.json({ error: 'INVALID_TOKEN' }, { status: 401 });
    }

    const fileId = parseInt(params.id);
    if (isNaN(fileId)) {
      return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });
    }

    // Use raw SQL to avoid Drizzle schema mismatch issues
    const rows = await db.$client`
      SELECT id, account_id, s3_bucket, s3_key, mime_type, deleted_at
      FROM asset_files
      WHERE id = ${fileId} AND deleted_at IS NULL
      LIMIT 1
    `;

    if (!rows || rows.length === 0) {
      return NextResponse.json({ error: 'FILE_NOT_FOUND' }, { status: 404 });
    }

    const file = rows[0];

    if (file.account_id !== accountId) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }

    if (!file.s3_bucket || !file.s3_key) {
      return NextResponse.json({ error: 'S3_CONFIG_MISSING' }, { status: 500 });
    }

    const command = new GetObjectCommand({
      Bucket: file.s3_bucket,
      Key: file.s3_key,
    });

    const s3Response = await s3Client.send(command);

    if (!s3Response.Body) {
      return NextResponse.json({ error: 'EMPTY_BODY' }, { status: 500 });
    }

    const mimeType = (file.mime_type as string) ?? 'application/octet-stream';
    const chunks: Uint8Array[] = [];
    for await (const chunk of s3Response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': 'inline',
        'Content-Length': buffer.length.toString(),
        'Cache-Control': 'private, max-age=3600',
        'X-Frame-Options': 'SAMEORIGIN',
      },
    });
  } catch (error) {
    console.error('[proxy] Error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR', details: String(error) }, { status: 500 });
  }
}
