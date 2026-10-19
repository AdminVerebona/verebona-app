/**
 * Lot 70A — éditeur des modèles d'e-mails transactionnels (BO › Communications ›
 * E-mails transactionnels, décision PO du 19/10).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE FAIT LE SERVICE
 *
 *   · état de l'éditeur d'un gabarit : objet, contenu (ou zones de texte d'un
 *     gabarit HTML), variables disponibles et obligatoires, verrous (contenu
 *     légal / canal non désactivable — distincts), personnalisation, texte
 *     livré (et texte livré plus récent), historique des versions ;
 *   · enregistrement validé (`template-editor.ts`), restauration d'une version,
 *     « Revenir au texte livré avec l'application » — chacun dans UNE
 *     transaction : gabarit, version et journal d'audit (avant / après) ;
 *   · prévisualisation et envoi de test d'un BROUILLON (non enregistré), avec
 *     les données du propre compte de l'administrateur (COM-007, COM-008) et le
 *     même rendu que l'envoi réel (`EmailService.renderTemplate`).
 *
 * Écriture : réglage de transaction `verebona.email_template_edit = on` — seul
 * l'éditeur peut modifier un gabarit personnalisé (déclencheurs de la 0483).
 * Concurrence : l'empreinte du texte ouvert (`baseHash`) doit être celle du
 * texte en base, sinon refus (CONFLICT) — jamais d'écrasement silencieux.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { logAdminAction, type AdminActionType } from '@/lib/admin-audit';
import { transactionalLockReason } from '@/lib/notifications/channel-activation';
import { DEFAULT_EMAIL_TEMPLATES } from '@/lib/email-defaults';
import { EMAIL_HTML_TEMPLATES_L66 } from '@/lib/email/email-html-templates';
import {
  EDITOR_LIMITS,
  applyHtmlZones,
  contentLockReason,
  extractHtmlZones,
  extractVariables,
  limitedEditReason,
  scanHtmlBody,
  scanTextBody,
  templateFormat,
  validateDraft,
  variableSpecFor,
  type HtmlZone,
  type RequiredVariableGroup,
  type TemplateFormat,
  type TemplateVariable,
  type TemplateVariableSpec,
  type ValidationIssue,
} from '@/lib/email/template-editor';
import {
  appBaseUrl,
  MISSING_DATA_MARK,
  contextVariables,
  listEventDefinitions,
  loadAdminPreviewContext,
  loadEmailTemplateCodes,
  loadPreviewContextOptions,
  resolveTemplateVariables,
  selectPreviewContext,
  type PreviewSelection,
} from './communications.service';

// ── Modèle ──────────────────────────────────────────────────────────────────

interface TemplateRow {
  id: number;
  type: string;
  subject: string;
  body: string;
  placeholders: string | null;
  is_customized: boolean;
  customized_at: Date | null;
  shipped_subject: string | null;
  shipped_body: string | null;
  shipped_updated_at: Date | null;
  updated_at: Date | null;
  updated_by: number | null;
  updated_by_email?: string | null;
}

export interface VersionSummary {
  id: number;
  versionNo: number;
  source: string;
  subject: string;
  createdAt: string | null;
  createdByEmail: string | null;
  restoredFromVersion: number | null;
  note: string | null;
  /** Même objet et même contenu que le texte en base. */
  matchesCurrent: boolean;
}

export interface VersionDetail extends VersionSummary {
  body: string;
  format: TemplateFormat;
}

export interface EditorState {
  code: string;
  type: string;
  label: string;
  format: TemplateFormat;
  subject: string;
  body: string;
  zones: HtmlZone[] | null;
  baseHash: string;
  variables: TemplateVariable[];
  required: RequiredVariableGroup[];
  declaredVariables: boolean;
  /** Contenu non modifiable (contrainte légale), motif. */
  contentLock: string | null;
  /** Édition limitée (mentions obligatoires), motif. */
  limitedReason: string | null;
  /** Canal non désactivable (verrou d'activation, sans effet sur l'édition). */
  channelLock: string | null;
  isCustomized: boolean;
  customizedAt: string | null;
  updatedAt: string | null;
  updatedByEmail: string | null;
  shipped: {
    available: boolean;
    /** `base` : texte livré conservé en base ; `code` : défaut du code (gabarit personnalisé avant le lot 70). */
    source: 'base' | 'code' | null;
    subject: string | null;
    body: string | null;
    /** Texte livré plus récent reçu pendant la personnalisation. */
    newerAt: string | null;
    differsFromCurrent: boolean;
  };
  versions: VersionSummary[];
  limits: typeof EDITOR_LIMITS;
}

export type EditorErrorCode =
  | 'NOT_FOUND'
  | 'CONTENT_LOCKED'
  | 'INVALID'
  | 'CONFLICT'
  | 'VERSION_NOT_FOUND'
  | 'NO_SHIPPED_TEXT'
  | 'SEND_FAILED';

export type EditorResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: EditorErrorCode; message: string; issues?: ValidationIssue[] };

export interface AdminActor {
  id: number;
  email?: string;
}

export const contentHash = (subject: string, body: string): string =>
  createHash('sha256').update(`${subject}\u0000${body}`, 'utf8').digest('hex');

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Pick<typeof db, 'execute'>;

const rows = async <T>(ex: Exec, q: ReturnType<typeof sql>): Promise<T[]> => (await ex.execute(q)) as unknown as T[];

// ── Périmètre ───────────────────────────────────────────────────────────────

/** Gabarits éditables : ceux du groupe « E-mails transactionnels » (hors notifications du catalogue). */
export async function transactionalTemplateScope(): Promise<Map<string, string>> {
  const defs = listEventDefinitions(await loadEmailTemplateCodes());
  const out = new Map<string, string>();
  for (const d of defs) {
    if (d.kind === 'transactional' && d.emailTemplateCode) out.set(d.emailTemplateCode.toUpperCase(), d.label);
  }
  return out;
}

export function normalizeCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  return /^[A-Z0-9_]{2,80}$/.test(c) ? c : null;
}

async function loadRow(ex: Exec, code: string, forUpdate = false): Promise<TemplateRow | null> {
  const [row] = await rows<TemplateRow>(ex, sql`
    SELECT t.id, t.type, t.subject, t.body, t.placeholders, t.is_customized, t.customized_at,
           t.shipped_subject, t.shipped_body, t.shipped_updated_at, t.updated_at, t.updated_by,
           u.email AS updated_by_email
      FROM email_templates t LEFT JOIN users u ON u.id = t.updated_by
     WHERE upper(t.type) = ${code}
     ORDER BY t.id LIMIT 1
     ${forUpdate ? sql`FOR UPDATE OF t` : sql``}`);
  return row ?? null;
}

/** Texte livré : conservé en base (0483 et déclencheurs) ou, à défaut, défaut du code. */
export function resolveShipped(row: Pick<TemplateRow, 'type' | 'subject' | 'shipped_subject' | 'shipped_body'>):
  { subject: string; body: string; source: 'base' | 'code' } | null {
  if (row.shipped_body != null && row.shipped_subject != null) {
    return { subject: row.shipped_subject, body: row.shipped_body, source: 'base' };
  }
  const key = row.type.toUpperCase();
  const def = (DEFAULT_EMAIL_TEMPLATES as Record<string, { subject: string; body: string } | undefined>)[key];
  const html = EMAIL_HTML_TEMPLATES_L66[key];
  if (html) return { subject: def?.subject ?? row.subject, body: html, source: 'code' };
  if (def) return { subject: def.subject, body: def.body, source: 'code' };
  return null;
}

function specOf(row: TemplateRow, format: TemplateFormat): TemplateVariableSpec {
  const shipped = resolveShipped(row);
  return variableSpecFor(row.type, {
    format,
    currentTexts: [row.subject, row.body],
    shippedTexts: shipped ? [shipped.subject, shipped.body] : [],
    placeholders: row.placeholders,
  });
}

async function listVersionRows(ex: Exec, code: string, limit = 50) {
  return rows<{
    id: number; version_no: number; source: string; subject: string; body: string; created_at: Date | null;
    created_by_email: string | null; restored_from_version: number | null; note: string | null;
  }>(ex, sql`
    SELECT id, version_no, source, subject, body, created_at, created_by_email, restored_from_version, note
      FROM email_template_versions WHERE template_type = ${code}
     ORDER BY version_no DESC LIMIT ${limit}`);
}

// ── Lecture ─────────────────────────────────────────────────────────────────

export async function getEditorState(rawCode: unknown): Promise<EditorResult<{ state: EditorState }>> {
  const code = normalizeCode(rawCode);
  const scope = await transactionalTemplateScope();
  if (!code || !scope.has(code)) return { ok: false, error: 'NOT_FOUND', message: 'Modèle d’e-mail transactionnel inconnu.' };
  const row = await loadRow(db, code);
  if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Aucun gabarit e-mail n’est enregistré pour ce modèle.' };
  const format = templateFormat(row.body);
  const spec = specOf(row, format);
  const shipped = resolveShipped(row);
  const versions = await listVersionRows(db, code);
  return {
    ok: true,
    state: {
      code,
      type: row.type,
      label: scope.get(code) ?? code,
      format,
      subject: row.subject,
      body: row.body,
      zones: format === 'html' ? extractHtmlZones(row.body, spec) : null,
      baseHash: contentHash(row.subject, row.body),
      variables: spec.variables.filter((x) => !x.system),
      required: spec.required,
      declaredVariables: spec.declared,
      contentLock: contentLockReason(code),
      limitedReason: limitedEditReason(code),
      channelLock: transactionalLockReason(code),
      isCustomized: row.is_customized,
      customizedAt: iso(row.customized_at),
      updatedAt: iso(row.updated_at),
      updatedByEmail: row.updated_by_email ?? null,
      shipped: {
        available: !!shipped,
        source: shipped?.source ?? null,
        subject: shipped?.subject ?? null,
        body: shipped?.body ?? null,
        newerAt: row.is_customized ? iso(row.shipped_updated_at) : null,
        differsFromCurrent: !!shipped && (shipped.subject !== row.subject || shipped.body !== row.body),
      },
      versions: versions.map((x) => ({
        id: Number(x.id),
        versionNo: x.version_no,
        source: x.source,
        subject: x.subject,
        createdAt: iso(x.created_at),
        createdByEmail: x.created_by_email,
        restoredFromVersion: x.restored_from_version,
        note: x.note,
        matchesCurrent: x.subject === row.subject && x.body === row.body,
      })),
      limits: EDITOR_LIMITS,
    },
  };
}

export async function getVersion(rawCode: unknown, versionId: unknown): Promise<EditorResult<{ version: VersionDetail }>> {
  const code = normalizeCode(rawCode);
  const id = Number(versionId);
  if (!code || !Number.isSafeInteger(id) || id <= 0) return { ok: false, error: 'VERSION_NOT_FOUND', message: 'Version introuvable.' };
  const scope = await transactionalTemplateScope();
  if (!scope.has(code)) return { ok: false, error: 'NOT_FOUND', message: 'Modèle d’e-mail transactionnel inconnu.' };
  const row = await loadRow(db, code);
  const [v] = await rows<{
    id: number; version_no: number; source: string; subject: string; body: string; created_at: Date | null;
    created_by_email: string | null; restored_from_version: number | null; note: string | null;
  }>(db, sql`SELECT id, version_no, source, subject, body, created_at, created_by_email, restored_from_version, note
               FROM email_template_versions WHERE id = ${id} AND template_type = ${code}`);
  if (!v) return { ok: false, error: 'VERSION_NOT_FOUND', message: 'Version introuvable.' };
  return {
    ok: true,
    version: {
      id: Number(v.id), versionNo: v.version_no, source: v.source, subject: v.subject, body: v.body,
      createdAt: iso(v.created_at), createdByEmail: v.created_by_email, restoredFromVersion: v.restored_from_version,
      note: v.note, format: templateFormat(v.body),
      matchesCurrent: !!row && v.subject === row.subject && v.body === row.body,
    },
  };
}

// ── Brouillon ───────────────────────────────────────────────────────────────

export interface DraftInput {
  subject: unknown;
  /** Gabarit texte : contenu complet. */
  body?: unknown;
  /** Gabarit HTML : textes des zones, dans l'ordre. */
  zones?: unknown;
}

/** Construit et valide le brouillon contre le gabarit en base. Pur hors lecture. */
export function buildDraft(row: TemplateRow, input: DraftInput):
  { ok: true; subject: string; body: string; format: TemplateFormat; changedZones: number[] } | { ok: false; issues: ValidationIssue[] } {
  const format = templateFormat(row.body);
  const spec = specOf(row, format);
  const subject = typeof input.subject === 'string' ? input.subject : '';
  let body: string;
  let changedZones: number[] = [];
  if (format === 'html') {
    if (input.zones === undefined && typeof input.body === 'string') {
      // Le HTML d'un gabarit complet ne s'édite pas directement (zones seulement).
      return { ok: false, issues: [{ code: 'HTML_EDIT_NOT_ALLOWED', message: 'Gabarit HTML complet : seules les zones de texte sont modifiables.' }] };
    }
    const applied = applyHtmlZones(row.body, input.zones, spec);
    if (!applied.ok) return { ok: false, issues: [...applied.issues, ...validateSubjectOnly(subject, spec)] };
    body = applied.body;
    changedZones = applied.changed;
  } else {
    body = typeof input.body === 'string' ? input.body.replace(/\r\n?/g, '\n') : '';
  }
  const issues = validateDraft({ subject, body, format, spec, htmlVariablesAllowed: htmlVarsAllowed(row, body) });
  return issues.length ? { ok: false, issues } : { ok: true, subject, body, format, changedZones };
}

function validateSubjectOnly(subject: string, spec: TemplateVariableSpec): ValidationIssue[] {
  return validateDraft({ subject, body: 'x', format: 'text', spec }).filter((i) => i.code.startsWith('SUBJECT') || i.code === 'VARIABLE_NOT_ALLOWED_IN_SUBJECT');
}

/** Blocs HTML produits par le code : admis seulement s'ils figurent déjà dans le texte livré ou actuel. */
function htmlVarsAllowed(row: TemplateRow, body: string): boolean {
  const shipped = resolveShipped(row);
  const allowed = new Set([...extractVariables(row.body), ...extractVariables(shipped?.body ?? '')]);
  return extractVariables(body).filter((n) => /html$/i.test(n)).every((n) => allowed.has(n));
}

// ── Écritures ───────────────────────────────────────────────────────────────

async function adminEdit(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT set_config('verebona.email_template_edit', 'on', true)`);
}

async function ensureInitialVersion(tx: Tx, code: string, row: TemplateRow): Promise<void> {
  await tx.execute(sql`
    INSERT INTO email_template_versions (template_type, version_no, subject, body, source, created_at, created_by, note)
    SELECT ${code}, 1, ${row.subject}, ${row.body}, 'initial', coalesce(${row.updated_at}::timestamptz, now()), ${row.updated_by},
           'Texte en place avant la première modification depuis l’éditeur'
     WHERE NOT EXISTS (SELECT 1 FROM email_template_versions WHERE template_type = ${code})`);
}

async function insertVersion(tx: Tx, input: {
  code: string; subject: string; body: string; source: 'admin_edit' | 'restore' | 'reset_shipped';
  admin: AdminActor; adminEmail: string; restoredFrom?: number | null; note?: string | null;
}): Promise<number> {
  const [r] = await rows<{ version_no: number }>(tx, sql`
    INSERT INTO email_template_versions (template_type, version_no, subject, body, source, created_by, created_by_email, restored_from_version, note)
    SELECT ${input.code}, coalesce(max(version_no), 0) + 1, ${input.subject}, ${input.body}, ${input.source},
           ${input.admin.id}, ${input.adminEmail}, ${input.restoredFrom ?? null}, ${input.note ?? null}
      FROM email_template_versions WHERE template_type = ${input.code}
    RETURNING version_no`);
  return r.version_no;
}

async function resolveAdminEmail(ex: Exec, admin: AdminActor): Promise<string> {
  if (admin.email) return admin.email;
  const [u] = await rows<{ email: string }>(ex, sql`SELECT email FROM users WHERE id = ${admin.id}`);
  return u?.email ?? `user:${admin.id}`;
}

const cleanNote = (note: unknown): string | null =>
  typeof note === 'string' && note.trim() ? note.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, EDITOR_LIMITS.note) : null;

async function auditRefusal(action: AdminActionType, admin: AdminActor, row: TemplateRow | null, code: string, result: 'FAILURE' | 'DENIED', details: Record<string, unknown>) {
  await logAdminAction({
    adminId: admin.id, adminEmail: admin.email, action, targetType: 'EMAIL_TEMPLATE', targetId: row?.id ?? null, result,
    details: { templateCode: code, ...details },
  });
}

/** Enregistre le brouillon (objet + contenu ou zones). */
export async function saveTemplate(input: DraftInput & { code: unknown; baseHash: unknown; note?: unknown; admin: AdminActor }):
  Promise<EditorResult<{ changed: boolean; versionNo: number | null }>> {
  const code = normalizeCode(input.code);
  const scope = await transactionalTemplateScope();
  if (!code || !scope.has(code)) return { ok: false, error: 'NOT_FOUND', message: 'Modèle d’e-mail transactionnel inconnu.' };
  const lock = contentLockReason(code);
  if (lock) {
    await auditRefusal('EMAIL_TEMPLATE_UPDATE', input.admin, null, code, 'DENIED', { code: 'CONTENT_LOCKED' });
    return { ok: false, error: 'CONTENT_LOCKED', message: lock };
  }
  const adminEmail = await resolveAdminEmail(db, input.admin);
  let refusal: { error: EditorErrorCode; message: string; issues?: ValidationIssue[]; row: TemplateRow | null } | null = null;
  const out = await db.transaction(async (tx) => {
    const row = await loadRow(tx, code, true);
    if (!row) { refusal = { error: 'NOT_FOUND', message: 'Aucun gabarit e-mail n’est enregistré pour ce modèle.', row: null }; return null; }
    if (input.baseHash !== contentHash(row.subject, row.body)) {
      refusal = { error: 'CONFLICT', message: 'Le modèle a été modifié depuis l’ouverture de l’éditeur (autre administrateur ou livraison) : rechargez la page avant d’enregistrer.', row };
      return null;
    }
    const draft = buildDraft(row, input);
    if (!draft.ok) { refusal = { error: 'INVALID', message: 'Modèle non enregistré : corrigez les points signalés.', issues: draft.issues, row }; return null; }
    if (draft.subject === row.subject && draft.body === row.body) return { changed: false, versionNo: null };

    await adminEdit(tx);
    await ensureInitialVersion(tx, code, row);
    await tx.execute(sql`
      UPDATE email_templates
         SET subject = ${draft.subject}, body = ${draft.body}, is_customized = true, customized_at = now(),
             updated_by = ${input.admin.id}, updated_at = now()
       WHERE id = ${row.id}`);
    const note = cleanNote(input.note);
    const versionNo = await insertVersion(tx, { code, subject: draft.subject, body: draft.body, source: 'admin_edit', admin: input.admin, adminEmail, note });
    await logAdminAction({
      adminId: input.admin.id, adminEmail, action: 'EMAIL_TEMPLATE_UPDATE', targetType: 'EMAIL_TEMPLATE', targetId: row.id, result: 'SUCCESS',
      before: { subject: row.subject, body: row.body, isCustomized: row.is_customized },
      after: { subject: draft.subject, body: draft.body, isCustomized: true },
      details: { templateCode: code, versionNo, format: draft.format, changedZones: draft.changedZones, note },
      executor: tx,
    });
    return { changed: true, versionNo };
  });
  if (refusal) {
    const r = refusal as { error: EditorErrorCode; message: string; issues?: ValidationIssue[]; row: TemplateRow | null };
    await auditRefusal('EMAIL_TEMPLATE_UPDATE', input.admin, r.row, code, 'FAILURE', { code: r.error, issues: r.issues?.map((i) => i.code) });
    return { ok: false, error: r.error, message: r.message, issues: r.issues };
  }
  return { ok: true, ...(out as { changed: boolean; versionNo: number | null }) };
}

/** Restaure une version de l'historique (validée comme un enregistrement). */
export async function restoreVersion(input: { code: unknown; versionId: unknown; baseHash: unknown; admin: AdminActor }):
  Promise<EditorResult<{ versionNo: number }>> {
  const code = normalizeCode(input.code);
  const scope = await transactionalTemplateScope();
  if (!code || !scope.has(code)) return { ok: false, error: 'NOT_FOUND', message: 'Modèle d’e-mail transactionnel inconnu.' };
  const lock = contentLockReason(code);
  if (lock) {
    await auditRefusal('EMAIL_TEMPLATE_RESTORE', input.admin, null, code, 'DENIED', { code: 'CONTENT_LOCKED' });
    return { ok: false, error: 'CONTENT_LOCKED', message: lock };
  }
  const versionId = Number(input.versionId);
  const adminEmail = await resolveAdminEmail(db, input.admin);
  let refusal: { error: EditorErrorCode; message: string; issues?: ValidationIssue[]; row: TemplateRow | null } | null = null;
  const out = await db.transaction(async (tx) => {
    const row = await loadRow(tx, code, true);
    if (!row) { refusal = { error: 'NOT_FOUND', message: 'Aucun gabarit e-mail n’est enregistré pour ce modèle.', row: null }; return null; }
    if (input.baseHash !== contentHash(row.subject, row.body)) {
      refusal = { error: 'CONFLICT', message: 'Le modèle a été modifié depuis l’ouverture de l’éditeur : rechargez la page.', row };
      return null;
    }
    const [v] = Number.isSafeInteger(versionId) && versionId > 0
      ? await rows<{ version_no: number; subject: string; body: string }>(tx, sql`
          SELECT version_no, subject, body FROM email_template_versions WHERE id = ${versionId} AND template_type = ${code}`)
      : [];
    if (!v) { refusal = { error: 'VERSION_NOT_FOUND', message: 'Version introuvable.', row }; return null; }
    const format = templateFormat(v.body);
    const issues = validateDraft({ subject: v.subject, body: v.body, format, spec: specOf(row, format), htmlVariablesAllowed: htmlVarsAllowed(row, v.body) });
    if (issues.length) { refusal = { error: 'INVALID', message: 'Cette version ne respecte plus les règles du modèle : restauration refusée.', issues, row }; return null; }

    await adminEdit(tx);
    await ensureInitialVersion(tx, code, row);
    await tx.execute(sql`
      UPDATE email_templates
         SET subject = ${v.subject}, body = ${v.body}, is_customized = true, customized_at = now(),
             updated_by = ${input.admin.id}, updated_at = now()
       WHERE id = ${row.id}`);
    const versionNo = await insertVersion(tx, { code, subject: v.subject, body: v.body, source: 'restore', admin: input.admin, adminEmail, restoredFrom: v.version_no });
    await logAdminAction({
      adminId: input.admin.id, adminEmail, action: 'EMAIL_TEMPLATE_RESTORE', targetType: 'EMAIL_TEMPLATE', targetId: row.id, result: 'SUCCESS',
      before: { subject: row.subject, body: row.body, isCustomized: row.is_customized },
      after: { subject: v.subject, body: v.body, isCustomized: true },
      details: { templateCode: code, versionNo, restoredFromVersion: v.version_no },
      executor: tx,
    });
    return { versionNo };
  });
  if (refusal) {
    const r = refusal as { error: EditorErrorCode; message: string; issues?: ValidationIssue[]; row: TemplateRow | null };
    await auditRefusal('EMAIL_TEMPLATE_RESTORE', input.admin, r.row, code, 'FAILURE', { code: r.error, versionId, issues: r.issues?.map((i) => i.code) });
    return { ok: false, error: r.error, message: r.message, issues: r.issues };
  }
  return { ok: true, ...(out as { versionNo: number }) };
}

/**
 * « Revenir au texte livré avec l'application » : le gabarit redevient NON
 * personnalisé (les livraisons futures le mettront à jour, comme avant).
 */
export async function resetToShipped(input: { code: unknown; baseHash: unknown; admin: AdminActor }):
  Promise<EditorResult<{ versionNo: number; changed: boolean }>> {
  const code = normalizeCode(input.code);
  const scope = await transactionalTemplateScope();
  if (!code || !scope.has(code)) return { ok: false, error: 'NOT_FOUND', message: 'Modèle d’e-mail transactionnel inconnu.' };
  const adminEmail = await resolveAdminEmail(db, input.admin);
  let refusal: { error: EditorErrorCode; message: string; issues?: ValidationIssue[]; row: TemplateRow | null } | null = null;
  const out = await db.transaction(async (tx) => {
    const row = await loadRow(tx, code, true);
    if (!row) { refusal = { error: 'NOT_FOUND', message: 'Aucun gabarit e-mail n’est enregistré pour ce modèle.', row: null }; return null; }
    if (input.baseHash !== contentHash(row.subject, row.body)) {
      refusal = { error: 'CONFLICT', message: 'Le modèle a été modifié depuis l’ouverture de l’éditeur : rechargez la page.', row };
      return null;
    }
    const shipped = resolveShipped(row);
    if (!shipped) { refusal = { error: 'NO_SHIPPED_TEXT', message: 'Aucun texte livré n’est connu pour ce modèle.', row }; return null; }
    // Texte livré : fourni par l'application ; seul le filet de sûreté est rejoué.
    const safety = templateFormat(shipped.body) === 'html' ? scanHtmlBody(shipped.body) : scanTextBody(shipped.body);
    if (safety.length) { refusal = { error: 'INVALID', message: 'Le texte livré ne passe pas les contrôles de sûreté.', issues: safety, row }; return null; }

    await adminEdit(tx);
    await ensureInitialVersion(tx, code, row);
    await tx.execute(sql`
      UPDATE email_templates
         SET subject = ${shipped.subject}, body = ${shipped.body}, is_customized = false, customized_at = NULL,
             shipped_subject = ${shipped.subject}, shipped_body = ${shipped.body}, shipped_updated_at = NULL,
             updated_by = NULL, updated_at = now()
       WHERE id = ${row.id}`);
    const versionNo = await insertVersion(tx, { code, subject: shipped.subject, body: shipped.body, source: 'reset_shipped', admin: input.admin, adminEmail });
    await logAdminAction({
      adminId: input.admin.id, adminEmail, action: 'EMAIL_TEMPLATE_RESET', targetType: 'EMAIL_TEMPLATE', targetId: row.id, result: 'SUCCESS',
      before: { subject: row.subject, body: row.body, isCustomized: row.is_customized },
      after: { subject: shipped.subject, body: shipped.body, isCustomized: false },
      details: { templateCode: code, versionNo, shippedSource: shipped.source },
      executor: tx,
    });
    return { versionNo, changed: shipped.subject !== row.subject || shipped.body !== row.body };
  });
  if (refusal) {
    const r = refusal as { error: EditorErrorCode; message: string; issues?: ValidationIssue[]; row: TemplateRow | null };
    await auditRefusal('EMAIL_TEMPLATE_RESET', input.admin, r.row, code, 'FAILURE', { code: r.error });
    return { ok: false, error: r.error, message: r.message, issues: r.issues };
  }
  return { ok: true, ...(out as { versionNo: number; changed: boolean }) };
}

// ── Prévisualisation et test d'un brouillon ─────────────────────────────────

/**
 * Lien d'action indisponible dans le compte de l'administrateur (lien signé de
 * vérification, invitation…) : remplacé par un lien NEUTRE vers l'application
 * (aucun jeton, aucune donnée), pour que le bouton de la charte s'affiche dans
 * l'aperçu et le test. L'aperçu reste signalé incomplet (COM-009).
 */
export function withPreviewLinks(variables: Record<string, string>, base: string = appBaseUrl()): Record<string, string> {
  const out = { ...variables };
  for (const [k, v] of Object.entries(out)) {
    if (v === MISSING_DATA_MARK && /(url|link)$/i.test(k)) out[k] = `${base.replace(/\/+$/, '')}/?apercu-lien=${encodeURIComponent(k)}`;
  }
  return out;
}

export interface DraftRender {
  subject: string;
  html: string;
  issues: ValidationIssue[];
  incomplete: boolean;
  missingCount: number;
  rejected: string[];
  recipient: string;
}

/**
 * Rend le brouillon (ou, s'il est invalide, signale les refus) avec les
 * données du propre compte de l'administrateur. `draft` absent : texte en base.
 */
export async function renderDraft(input: {
  code: unknown; draft?: DraftInput | null; selection?: PreviewSelection; adminId: number; accountId?: number | null;
}): Promise<EditorResult<{ render: DraftRender; subject: string; body: string; valid: boolean; templateType: string; rowId: number }>> {
  const code = normalizeCode(input.code);
  const scope = await transactionalTemplateScope();
  if (!code || !scope.has(code)) return { ok: false, error: 'NOT_FOUND', message: 'Modèle d’e-mail transactionnel inconnu.' };
  const row = await loadRow(db, code);
  if (!row) return { ok: false, error: 'NOT_FOUND', message: 'Aucun gabarit e-mail n’est enregistré pour ce modèle.' };

  let subject = row.subject;
  let body = row.body;
  let issues: ValidationIssue[] = [];
  if (input.draft) {
    const d = buildDraft(row, input.draft);
    if (d.ok) { subject = d.subject; body = d.body; }
    else {
      issues = d.issues;
      // Rendu de ce qui est rendable : objet saisi et contenu texte saisi s'ils sont des chaînes.
      if (typeof input.draft.subject === 'string') subject = input.draft.subject;
      if (templateFormat(row.body) === 'text' && typeof input.draft.body === 'string' && !issues.some((i) => ['SCRIPT', 'FORBIDDEN_TAG', 'FORBIDDEN_ATTRIBUTE', 'JAVASCRIPT_URL'].includes(i.code))) {
        body = input.draft.body;
      }
    }
  }
  const options = await loadPreviewContextOptions(input.adminId, input.accountId ?? undefined);
  const selected = selectPreviewContext(options, input.selection ?? {});
  const ctx = { ...(await loadAdminPreviewContext(input.adminId, input.accountId ?? undefined)), extra: contextVariables(selected) };
  const { variables: resolved, missingCount } = resolveTemplateVariables([subject, body], ctx, appBaseUrl());
  const variables = withPreviewLinks(resolved);
  const { emailService } = await import('@/lib/email/email-service');
  const rendered = await emailService.renderTemplate({ subject, body }, variables);
  return {
    ok: true,
    subject,
    body,
    valid: issues.length === 0,
    templateType: row.type,
    rowId: row.id,
    render: {
      subject: rendered.subject,
      html: rendered.html,
      issues,
      incomplete: missingCount > 0,
      missingCount,
      rejected: selected.rejected,
      recipient: ctx.email,
    },
  };
}

/** Envoi de test du brouillon VALIDE vers l'administrateur connecté (adresse de session). */
export async function sendDraftTest(input: {
  code: unknown; draft: DraftInput; selection?: PreviewSelection; admin: AdminActor & { email: string }; accountId?: number | null;
}): Promise<EditorResult<{ to: string; incomplete: boolean }>> {
  const r = await renderDraft({ code: input.code, draft: input.draft, selection: input.selection, adminId: input.admin.id, accountId: input.accountId });
  if (!r.ok) return r;
  const code = normalizeCode(input.code)!;
  if (!r.valid) {
    await auditRefusal('EMAIL_TEMPLATE_TEST', input.admin, { id: r.rowId } as TemplateRow, code, 'FAILURE', { code: 'INVALID', issues: r.render.issues.map((i) => i.code) });
    return { ok: false, error: 'INVALID', message: 'Test non envoyé : corrigez d’abord les points signalés.', issues: r.render.issues };
  }
  const options = await loadPreviewContextOptions(input.admin.id, input.accountId ?? undefined);
  const selected = selectPreviewContext(options, input.selection ?? {});
  const ctx = { ...(await loadAdminPreviewContext(input.admin.id, input.accountId ?? undefined)), extra: contextVariables(selected) };
  const { variables: resolved, missingCount } = resolveTemplateVariables([r.subject, r.body], ctx, appBaseUrl());
  const variables = withPreviewLinks(resolved);
  const { emailService } = await import('@/lib/email/email-service');
  const sent = await emailService.sendDraftTest(r.templateType, input.admin.email, { subject: r.subject, body: r.body }, variables);
  await logAdminAction({
    adminId: input.admin.id, adminEmail: input.admin.email, action: 'EMAIL_TEMPLATE_TEST', targetType: 'EMAIL_TEMPLATE', targetId: r.rowId,
    result: sent.success ? 'SUCCESS' : 'FAILURE',
    after: { subject: r.subject, bodyHash: contentHash(r.subject, r.body) },
    details: { templateCode: code, emailLogId: sent.logId ?? null, ...(sent.success ? {} : { error: String(sent.error ?? '').slice(0, 120) }) },
  });
  if (!sent.success) return { ok: false, error: 'SEND_FAILED', message: 'Échec de l’envoi de l’e-mail de test.' };
  return { ok: true, to: input.admin.email, incomplete: missingCount > 0 };
}
