/**
 * Cycle de vie des versions de CGVU — CDC 7 §6, §7, §16.2.
 *
 * Brouillon → publication → version courante → archivage. Chaque transition
 * est journalisée (§19), et l'immutabilité d'une version publiée est garantie
 * par la base elle-même (déclencheurs de la migration 0115), pas par l'absence
 * de code pour la violer.
 */
import { createHash } from 'crypto';
import { db } from '@/db';
import { legalDocumentVersions } from '@/db/schema';
import { and, desc, eq, ne } from 'drizzle-orm';
import { recordLegalAudit } from './legal-audit.service';
import { readFromObjectStorage } from './legal-storage';

export const DOCUMENT_TYPE_CGVU = 'CGVU';

type VersionStatus = 'DRAFT' | 'PUBLISHED' | 'CURRENT' | 'ARCHIVED';

interface LegalVersion {
  id: string;
  documentType: string;
  versionCode: string;
  title: string;
  status: VersionStatus;
  effectiveAt: Date | null;
  publishedAt: Date | null;
  publishedBy: number | null;
  changeSummary: string;
  requiresReacceptance: boolean;
  htmlContent: string | null;
  htmlStorageKey: string | null;
  permalink: string | null;
  sha256: string | null;
  /** Lot 102B : APP_LEGACY | PUBLIC_SITE | BO_MANUAL. */
  source: VersionSource;
  publicPermalink: string | null;
  publicSha256: string | null;
}

export type VersionSource = 'APP_LEGACY' | 'PUBLIC_SITE' | 'BO_MANUAL';
export type { LegalVersion };

/* ── Format de version (§7) ────────────────────────────────────────────── */

const VERSION_CODE_PATTERN = /^\d{4}-\d{2}-\d{2}-v\d+$/;

/** Le code respecte-t-il le format `AAAA-MM-JJ-vN` ? */
export function isValidVersionCode(code: string): boolean {
  if (!VERSION_CODE_PATTERN.test(code)) return false;
  // Rejette les dates impossibles : `2026-02-31-v1` passe l'expression mais
  // ne désigne aucun jour.
  const [year, month, day] = code.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Empreinte du document publié (§16.2). */
function computeSha256(html: string): string {
  return createHash('sha256').update(html, 'utf-8').digest('hex');
}

/* ── Lecture ───────────────────────────────────────────────────────────── */

function toVersion(row: typeof legalDocumentVersions.$inferSelect): LegalVersion {
  return {
    id: row.id,
    documentType: row.documentType,
    versionCode: row.versionCode,
    title: row.title,
    status: row.status as VersionStatus,
    effectiveAt: row.effectiveAt ?? null,
    publishedAt: row.publishedAt ?? null,
    publishedBy: row.publishedBy ?? null,
    changeSummary: row.changeSummary,
    requiresReacceptance: row.requiresReacceptance,
    htmlContent: row.htmlContent ?? null,
    htmlStorageKey: row.htmlStorageKey ?? null,
    permalink: row.permalink ?? null,
    sha256: row.sha256 ?? null,
    source: (row.source ?? 'APP_LEGACY') as VersionSource,
    publicPermalink: row.publicPermalink ?? null,
    publicSha256: row.publicSha256 ?? null,
  };
}

/** Version actuellement en vigueur, ou `null` si aucune n'est publiée. */
export async function getCurrentVersion(
  documentType = DOCUMENT_TYPE_CGVU,
): Promise<LegalVersion | null> {
  const [row] = await db
    .select()
    .from(legalDocumentVersions)
    .where(
      and(
        eq(legalDocumentVersions.documentType, documentType),
        eq(legalDocumentVersions.status, 'CURRENT'),
      ),
    )
    .limit(1);
  return row ? toVersion(row) : null;
}

/**
 * Version désignée par son code.
 *
 * ⚠️ Ne retombe JAMAIS sur la version courante lorsque le code est inconnu.
 * Le §16.3 l'interdit formellement — « ne jamais rediriger silencieusement
 * vers une version plus récente » — et le §18 exige une erreur spécifique.
 * Un permalien qui affiche autre chose que ce qu'il désigne détruit la valeur
 * probante de tout le dispositif.
 */
export async function getVersionByCode(
  versionCode: string,
  documentType = DOCUMENT_TYPE_CGVU,
): Promise<LegalVersion | null> {
  const [row] = await db
    .select()
    .from(legalDocumentVersions)
    .where(
      and(
        eq(legalDocumentVersions.documentType, documentType),
        eq(legalDocumentVersions.versionCode, versionCode),
        // Un brouillon n'est pas accessible publiquement (§6.1).
        ne(legalDocumentVersions.status, 'DRAFT'),
      ),
    )
    .limit(1);
  return row ? toVersion(row) : null;
}

export async function getVersionById(id: string): Promise<LegalVersion | null> {
  const [row] = await db
    .select()
    .from(legalDocumentVersions)
    .where(eq(legalDocumentVersions.id, id))
    .limit(1);
  return row ? toVersion(row) : null;
}

/** Historique, versions les plus récentes d'abord. */
export async function listVersions(
  documentType = DOCUMENT_TYPE_CGVU,
): Promise<LegalVersion[]> {
  const rows = await db
    .select()
    .from(legalDocumentVersions)
    .where(eq(legalDocumentVersions.documentType, documentType))
    .orderBy(desc(legalDocumentVersions.createdAt));
  return rows.map(toVersion);
}

export class LegalVersionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LegalVersionError';
  }
}

/* ── Plus de rédaction ni de publication de texte (lot 102B) ────────────────
 *
 * Les brouillons HTML, leur rendu et leur publication par l'application
 * (`createDraft`, `publishVersion`, amorçages de textes) sont RETIRÉS : le site
 * public publie le texte officiel et ses archives immuables. L'application
 * importe le référentiel des versions depuis le manifeste public
 * (`cguv-referential.service.ts`). Les versions APP_LEGACY déjà publiées
 * restent en base, figées, comme archives historiques.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Désigne une version publiée comme version courante (§6.1).
 *
 * L'ancienne version courante passe à `ARCHIVED` — elle reste accessible par
 * son permalien (§3.3), c'est tout l'intérêt du dispositif.
 */
export async function setCurrentVersion(
  id: string,
  actorUserId?: number | null,
): Promise<LegalVersion> {
  const target = await getVersionById(id);
  if (!target) throw new LegalVersionError('NOT_FOUND', `Version ${id} introuvable.`);
  if (target.status === 'DRAFT') {
    throw new LegalVersionError(
      'NOT_PUBLISHED',
      `Version ${target.versionCode} en brouillon : publiez-la avant de la désigner comme courante.`,
    );
  }
  if (target.status === 'CURRENT') return target;

  const previous = await getCurrentVersion(target.documentType);

  // L'index unique partiel n'autorise qu'une seule ligne CURRENT : l'ancienne
  // doit être archivée d'abord, sinon l'écriture est rejetée.
  if (previous) {
    await db
      .update(legalDocumentVersions)
      .set({ status: 'ARCHIVED' })
      .where(eq(legalDocumentVersions.id, previous.id));
  }

  const [row] = await db
    .update(legalDocumentVersions)
    .set({ status: 'CURRENT' })
    .where(eq(legalDocumentVersions.id, id))
    .returning();

  await recordLegalAudit({
    action: 'CURRENT_CHANGED',
    actorUserId,
    versionCode: row.versionCode,
    versionId: row.id,
    details: previous ? `remplace ${previous.versionCode}` : 'première version courante',
  });

  return toVersion(row);
}

/* ── Intégrité (§16.2, R09) ────────────────────────────────────────────── */

interface IntegrityIssue {
  versionCode: string;
  versionId: string;
  scope: 'database' | 'object_storage';
  detail: string;
}

interface IntegrityReport {
  checked: number;
  issues: IntegrityIssue[];
}

/**
 * Vérifie que chaque version publiée correspond toujours à son empreinte.
 *
 * ⚠️ NE RÉPARE RIEN, NE REMPLACE RIEN. Le scénario R09 est explicite : « la
 * version n'est pas remplacée automatiquement par une autre ». Une réécriture
 * automatique masquerait précisément l'incident qu'il s'agit de détecter.
 */
export async function verifyIntegrity(
  documentType = DOCUMENT_TYPE_CGVU,
): Promise<IntegrityReport> {
  // Lot 102B : seules les archives APP_LEGACY portent un texte en base ; le
  // texte des versions publiques est sur le site (empreinte au manifeste).
  const versions = (await listVersions(documentType)).filter((v) => v.status !== 'DRAFT' && v.source === 'APP_LEGACY');
  const issues: IntegrityIssue[] = [];

  for (const version of versions) {
    if (!version.htmlContent || !version.sha256) {
      issues.push({
        versionCode: version.versionCode,
        versionId: version.id,
        scope: 'database',
        detail: 'contenu ou empreinte absent alors que la version est publiée',
      });
      continue;
    }

    const actual = computeSha256(version.htmlContent);
    if (actual !== version.sha256) {
      issues.push({
        versionCode: version.versionCode,
        versionId: version.id,
        scope: 'database',
        detail: `empreinte attendue ${version.sha256}, calculée ${actual}`,
      });
    }

    if (version.htmlStorageKey) {
      const mirrored = await readFromObjectStorage(version.htmlStorageKey);
      // `null` = stockage non configuré ou objet illisible : pas de conclusion.
      if (mirrored !== null && computeSha256(mirrored) !== version.sha256) {
        issues.push({
          versionCode: version.versionCode,
          versionId: version.id,
          scope: 'object_storage',
          detail: `la copie ${version.htmlStorageKey} diffère de l'empreinte enregistrée`,
        });
      }
    }
  }

  for (const issue of issues) {
    await recordLegalAudit({
      action: 'INTEGRITY_FAILED',
      versionCode: issue.versionCode,
      versionId: issue.versionId,
      result: 'failure',
      details: `${issue.scope} : ${issue.detail}`,
    });
  }

  return { checked: versions.length, issues };
}
