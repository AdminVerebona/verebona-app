/**
 * GET /api/cron/documents/classification-report — inspection du classement V2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UNE ROUTE PLUTÔT QU'UN ÉCRAN
 *
 * Juger la qualité du classement suppose de voir, côte à côte, ce que le
 * document est et où il a atterri. Les pages produit ne le montrent pas : elles
 * affichent le rangement, pas la décision qui l'a produit — et c'est voulu
 * (§11.2 interdit d'exposer la confiance à l'utilisateur).
 *
 * Cette route sert au réglage, pas à l'usage. Elle est protégée par
 * `CRON_SECRET`, ne dépend d'aucune session, et traverse donc les comptes —
 * indispensable quand les documents à examiner ne sont pas sur le compte
 * auquel on peut se connecter.
 *
 * ── ELLE N'ÉCRIT RIEN ─────────────────────────────────────────────────────
 *
 * Lecture seule, strictement. Une route de diagnostic qui modifie quoi que ce
 * soit finit par être appelée « pour voir » sur un parc qu'on ne voulait pas
 * toucher.
 *
 *   ?account=42   restreint à un compte
 *   ?limit=50     nombre de documents détaillés (défaut 50)
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, ensureMigrations } from '@/db';
import { assetFiles } from '@/db/schema';
import { getDocumentType, getRubric } from '@/lib/referential/v2';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();

  const p = req.nextUrl.searchParams;
  const accountId = Number(p.get('account')) || undefined;
  const limit = Math.min(Number(p.get('limit')) || 50, 200);

  const scope = [isNull(assetFiles.deletedAt)];
  if (accountId) scope.push(eq(assetFiles.accountId, accountId));

  const [repartition, documents] = await Promise.all([
    db
      .select({
        rubricCode: assetFiles.rubricCode,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(assetFiles)
      .where(and(...scope))
      .groupBy(assetFiles.rubricCode),
    db
      .select({
        accountId: assetFiles.accountId,
        titre: assetFiles.retainedTitle,
        fichier: assetFiles.originalFilename,
        typeV1: assetFiles.documentType,
        rubricCode: assetFiles.rubricCode,
        documentTypeCode: assetFiles.documentTypeCode,
        rubricOrigin: assetFiles.rubricOrigin,
        rubricConfidence: assetFiles.rubricConfidence,
        version: assetFiles.classificationReferentialVersion,
      })
      .from(assetFiles)
      .where(and(...scope))
      .orderBy(desc(assetFiles.uploadedAt))
      .limit(limit),
  ]);

  return NextResponse.json({
    // Où sont les documents, tous comptes confondus : répond à « sur quel
    // compte dois-je me connecter ? » sans avoir à deviner.
    repartitionParRubrique: repartition
      .map((r) => ({
        rubrique: r.rubricCode ? (getRubric(r.rubricCode)?.label ?? r.rubricCode) : 'Sans rubrique',
        code: r.rubricCode ?? null,
        nombre: r.count,
      }))
      .sort((a, b) => b.nombre - a.nombre),

    documents: documents.map((d) => ({
      compte: d.accountId,
      // Le titre retenu, à défaut le nom de fichier : c'est ce qui permet de
      // juger si la Rubrique est la bonne.
      titre: d.titre ?? d.fichier,
      typeV1: d.typeV1,
      rubrique: d.rubricCode ? (getRubric(d.rubricCode)?.label ?? d.rubricCode) : 'Sans rubrique',
      type: d.documentTypeCode
        ? (getDocumentType(d.documentTypeCode)?.label ?? d.documentTypeCode)
        : null,
      origine: d.rubricOrigin,
      // Interne, jamais affiché à l'utilisateur (§11.2) — mais c'est
      // précisément ce qu'il faut voir pour régler le seuil et le prompt.
      confiance: d.rubricConfidence,
      versionReferentiel: d.version,
    })),
  });
}
