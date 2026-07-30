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
import {
  renderLegalVersionHtml,
  LEGAL_DOCUMENT_LABEL,
} from './legal-html.renderer';
import {
  buildLegalStorageKey,
  mirrorToObjectStorage,
  readFromObjectStorage,
} from './legal-storage';

export const DOCUMENT_TYPE_CGVU = 'CGVU';

export type VersionStatus = 'DRAFT' | 'PUBLISHED' | 'CURRENT' | 'ARCHIVED';

export interface LegalVersion {
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
}

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

/** Construit le permalien d'une version (§3.2). */
export function buildPermalink(versionCode: string): string {
  return `/cgvu/versions/${versionCode}`;
}

/** Empreinte du document publié (§16.2). */
export function computeSha256(html: string): string {
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

/* ── Brouillons (§5, §6.1) ─────────────────────────────────────────────── */

export interface CreateDraftInput {
  versionCode: string;
  title?: string;
  bodyHtml: string;
  changeSummary: string;
  effectiveAt: Date;
  requiresReacceptance?: boolean;
  actorUserId?: number | null;
  documentType?: string;
}

export class LegalVersionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LegalVersionError';
  }
}

/**
 * Crée un brouillon.
 *
 * Le corps est conservé tel quel dans `html_content` tant que la version est
 * en brouillon : c'est seulement à la publication qu'il est enveloppé dans le
 * document autonome et figé.
 */
export async function createDraft(input: CreateDraftInput): Promise<LegalVersion> {
  const documentType = input.documentType ?? DOCUMENT_TYPE_CGVU;

  if (!isValidVersionCode(input.versionCode)) {
    throw new LegalVersionError(
      'INVALID_VERSION_CODE',
      `Code de version invalide : ${input.versionCode}. Format attendu AAAA-MM-JJ-vN.`,
    );
  }
  if (!input.changeSummary?.trim()) {
    // §14.1 : le résumé est obligatoire. Il est affiché à l'utilisateur lors
    // d'une modification substantielle (§8.3) : le rendre facultatif reviendrait
    // à le laisser vide le jour où il compte.
    throw new LegalVersionError('MISSING_CHANGE_SUMMARY', 'Le résumé des modifications est obligatoire.');
  }

  const existing = await db
    .select({ id: legalDocumentVersions.id })
    .from(legalDocumentVersions)
    .where(
      and(
        eq(legalDocumentVersions.documentType, documentType),
        eq(legalDocumentVersions.versionCode, input.versionCode),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    throw new LegalVersionError(
      'VERSION_CODE_TAKEN',
      `Le code ${input.versionCode} est déjà utilisé. Un code de version n'est jamais réutilisé (§5).`,
    );
  }

  const now = new Date();
  const [row] = await db
    .insert(legalDocumentVersions)
    .values({
      documentType,
      versionCode: input.versionCode,
      title: input.title ?? LEGAL_DOCUMENT_LABEL,
      status: 'DRAFT',
      effectiveAt: input.effectiveAt,
      changeSummary: input.changeSummary.trim(),
      requiresReacceptance: input.requiresReacceptance ?? false,
      htmlContent: input.bodyHtml,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await recordLegalAudit({
    action: 'DRAFT_CREATED',
    actorUserId: input.actorUserId,
    versionCode: row.versionCode,
    versionId: row.id,
  });

  return toVersion(row);
}

export interface UpdateDraftInput {
  title?: string;
  bodyHtml?: string;
  changeSummary?: string;
  effectiveAt?: Date;
  requiresReacceptance?: boolean;
  actorUserId?: number | null;
}

/** Modifie un brouillon. Refusé dès que la version est publiée. */
export async function updateDraft(
  id: string,
  input: UpdateDraftInput,
): Promise<LegalVersion> {
  const current = await getVersionById(id);
  if (!current) throw new LegalVersionError('NOT_FOUND', `Version ${id} introuvable.`);

  // Contrôle applicatif pour un message clair ; le déclencheur de base reste
  // le garde-fou réel, y compris pour un accès direct au moteur.
  if (current.status !== 'DRAFT') {
    throw new LegalVersionError(
      'ALREADY_PUBLISHED',
      `Version ${current.versionCode} publiée : son contenu est figé (§3.3). Créez une nouvelle version.`,
    );
  }

  const [row] = await db
    .update(legalDocumentVersions)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.bodyHtml !== undefined ? { htmlContent: input.bodyHtml } : {}),
      ...(input.changeSummary !== undefined ? { changeSummary: input.changeSummary } : {}),
      ...(input.effectiveAt !== undefined ? { effectiveAt: input.effectiveAt } : {}),
      ...(input.requiresReacceptance !== undefined
        ? { requiresReacceptance: input.requiresReacceptance }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(legalDocumentVersions.id, id))
    .returning();

  await recordLegalAudit({
    action: 'DRAFT_UPDATED',
    actorUserId: input.actorUserId,
    versionCode: row.versionCode,
    versionId: row.id,
  });

  return toVersion(row);
}

/* ── Publication (§6.2) ────────────────────────────────────────────────── */

export interface PublishOptions {
  actorUserId?: number | null;
  /** Désigne la version comme courante dans la foulée (§6.2, étape 9). */
  setAsCurrent?: boolean;
}

/**
 * Publie un brouillon, en suivant les neuf étapes du §6.2.
 *
 * L'ordre est significatif : la copie sur stockage objet est tentée AVANT
 * l'écriture en base. Une clé déjà occupée fait donc échouer la publication
 * sans laisser de version à demi publiée — le §16.1 interdit l'écrasement, et
 * une clé occupée signale une réutilisation d'identifiant, c'est-à-dire
 * précisément ce que le §5 proscrit.
 */
export async function publishVersion(
  id: string,
  options: PublishOptions = {},
): Promise<LegalVersion> {
  const draft = await getVersionById(id);
  if (!draft) throw new LegalVersionError('NOT_FOUND', `Version ${id} introuvable.`);

  if (draft.status !== 'DRAFT') {
    throw new LegalVersionError(
      'ALREADY_PUBLISHED',
      `Version ${draft.versionCode} déjà publiée le ${draft.publishedAt?.toISOString()}.`,
    );
  }
  if (!draft.effectiveAt) {
    throw new LegalVersionError(
      'MISSING_EFFECTIVE_DATE',
      "La date d'entrée en vigueur est obligatoire avant publication (§14.1).",
    );
  }
  if (!draft.htmlContent?.trim()) {
    throw new LegalVersionError('EMPTY_CONTENT', 'Le contenu du brouillon est vide.');
  }

  // Étape 2 : rendu autonome. Étape 3 : le fichier figé.
  const html = renderLegalVersionHtml({
    versionCode: draft.versionCode,
    title: draft.title,
    bodyHtml: draft.htmlContent,
    effectiveAt: draft.effectiveAt,
    changeSummary: draft.changeSummary,
  });

  // Étape 4 : empreinte. Étapes 5 et 6 : clé et permalien.
  const sha256 = computeSha256(html);
  const storageKey = buildLegalStorageKey(draft.documentType, draft.versionCode);
  const permalink = buildPermalink(draft.versionCode);

  const mirror = await mirrorToObjectStorage(storageKey, html);
  if (mirror.status === 'failed') {
    await recordLegalAudit({
      action: 'PUBLISHED',
      actorUserId: options.actorUserId,
      versionCode: draft.versionCode,
      versionId: draft.id,
      result: 'failure',
      details: `copie sur stockage objet impossible : ${mirror.reason}`,
    });
    throw new LegalVersionError('STORAGE_FAILED', `Publication interrompue : ${mirror.reason}`);
  }

  const publishedAt = new Date();

  // Étapes 7 et 8 : le passage hors de DRAFT arme le déclencheur d'immutabilité.
  const [row] = await db
    .update(legalDocumentVersions)
    .set({
      status: 'PUBLISHED',
      htmlContent: html,
      htmlStorageKey: storageKey,
      permalink,
      sha256,
      publishedAt,
      publishedBy: options.actorUserId ?? null,
      updatedAt: publishedAt,
    })
    .where(eq(legalDocumentVersions.id, id))
    .returning();

  await recordLegalAudit({
    action: 'PUBLISHED',
    actorUserId: options.actorUserId,
    versionCode: row.versionCode,
    versionId: row.id,
    details:
      `sha256=${sha256}` +
      (mirror.status === 'skipped' ? ' ; stockage objet non configuré' : ''),
  });

  // Étape 9.
  if (options.setAsCurrent) {
    return setCurrentVersion(row.id, options.actorUserId);
  }

  return toVersion(row);
}

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

export interface IntegrityIssue {
  versionCode: string;
  versionId: string;
  scope: 'database' | 'object_storage';
  detail: string;
}

export interface IntegrityReport {
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
  const versions = (await listVersions(documentType)).filter((v) => v.status !== 'DRAFT');
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
