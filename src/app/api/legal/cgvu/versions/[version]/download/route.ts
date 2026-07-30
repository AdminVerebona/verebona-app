/**
 * GET /api/legal/cgvu/versions/{version}/download — CDC 7 §13 et §15.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE MÊME OCTET QUE LA PAGE
 *
 * Le §13 exige que le fichier téléchargé « contienne exactement le même texte
 * que la page ». Cette route sert `htmlContent` — la chaîne figée à la
 * publication, celle dont l'empreinte SHA-256 est enregistrée — exactement
 * comme le permalien. Seul l'en-tête `Content-Disposition` diffère.
 *
 * Aucune régénération : reconstruire le document ici, même avec le même code,
 * ouvrirait la possibilité qu'il diverge de la page un jour, sans que rien ne
 * l'indique. Le scénario R06 vérifie cette identité.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { getVersionByCode, isValidVersionCode, buildDownloadFilename } from '@/services/legal';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ version: string }> },
) {
  const { version } = await params;

  if (!isValidVersionCode(version)) {
    return NextResponse.json(
      { error: 'Identifiant de version invalide.', code: 'INVALID_VERSION_CODE' },
      { status: 400 },
    );
  }

  await ensureMigrations();
  const found = await getVersionByCode(version);

  if (!found?.htmlContent) {
    return NextResponse.json(
      { error: 'Version introuvable ou indisponible.', code: 'VERSION_NOT_FOUND' },
      { status: 404 },
    );
  }

  const filename = buildDownloadFilename(found.versionCode);

  return new NextResponse(found.htmlContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Le nom est en ASCII pur : pas d'échappement RFC 5987 nécessaire.
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Legal-Version': found.versionCode,
    },
  });
}
