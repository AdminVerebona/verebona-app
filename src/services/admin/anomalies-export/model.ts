/**
 * Lot 113AI (Trello #733) — anomalies du BO exportables / copiables pour une
 * ANALYSE EXTERNE. Module PUR (aucun accès base, aucun import serveur) :
 * partagé par les routes d'export, le flux et les tests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PÉRIMÈTRE — « les anomalies du BO » = la Supervision (CDC BO §4.5) :
 * table `admin_anomalies` (liste « Anomalies ouvertes », « Historique des
 * anomalies résolues », écran de traitement `/admin/supervision/[id]`). C'est
 * le point de convergence de tous les signalements techniques (Stripe,
 * communications, exports, sauvegardes, IA, parrainage, cohérence COH-*,
 * tâches planifiées, santé du moteur, isolation des comptes…).
 *
 * TROIS SORTIES, UN SEUL ENREGISTREMENT (`toExportRecord`) :
 *   · Markdown (« Copier ») : une anomalie, ou la page affichée ;
 *   · JSON versionné (`ANOMALY_EXPORT_FORMAT`) : liste filtrée complète ;
 *   · CSV (`;`, BOM UTF-8, CRLF, formules neutralisées) : idem.
 *
 * DONNÉES EXCLUES (analyse externe) : nom du compte, e-mail de l'utilisateur,
 * administrateur ayant résolu, commentaire interne. Le compte et l'utilisateur
 * sont désignés par leur identifiant interne BO (+ lien BO). Le détail
 * technique et tous les textes libres passent par le masquage du diagnostic
 * (`maskForExport` / `maskText` : secrets, e-mails pseudonymisés, identité,
 * adresse, téléphone, coordonnées bancaires, contenus bruts) complété ici
 * par les clés de contenu documentaire (extrait, aperçu, texte…).
 *
 * GRAVITÉ : la Supervision n'attribue aucune criticité (CDC BO §4.5). La
 * gravité est reprise du détail technique s'il en porte une ; sinon elle est
 * déclarée « non définie » — jamais inventée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { maskForExport, maskText } from '@/services/admin/diagnostics-export/model';
import { redactDeep, redactString } from '@/services/admin/ops/redact';
import { CSV_BOM, csvCell, masked, isMarker } from '@/services/admin/account-data/model';
import { exportFileName } from '@/lib/files/export-file-name';

/** Identifiant de schéma du fichier JSON (incrémenter la version à tout changement incompatible). */
export const ANOMALY_EXPORT_SCHEMA = 'verebona.bo-anomalies';
// Lot 113AQ (#751) : version 2 — section facultative `conflitsAttributs` (contrat
// `verebona.operation-attribute-conflicts/1`) pour les anomalies IDENTITY_ATTRIBUTE_CONFLICT ;
// le reste de l'enregistrement est inchangé (compatible avec un lecteur de la version 1).
export const ANOMALY_EXPORT_SCHEMA_VERSION = 2;
export const ANOMALY_EXPORT_FORMAT = `${ANOMALY_EXPORT_SCHEMA}/${ANOMALY_EXPORT_SCHEMA_VERSION}`;

/** Occurrences reprises dans la copie / l'export d'UNE anomalie (les plus récentes). */
export const ANOMALY_EXPORT_MAX_OCCURRENCES = 50;

type Status = 'open' | 'resolved';
type SortKey = 'date' | 'detected' | 'domain' | 'account' | 'user';
const SORT_KEYS: readonly SortKey[] = ['date', 'detected', 'domain', 'account', 'user'];
export type AnomalyExportFormat = 'json' | 'csv' | 'md';

/** Ligne lue en base (colonnes brutes), sans nom de compte ni e-mail. */
export interface AnomalyExportSource {
  id: number;
  domain: string;
  domainLabel: string;
  fingerprint: string;
  title: string;
  status: Status;
  accountId: number | null;
  userId: number | null;
  occurrenceCount: number;
  firstSeenAt: Date | string;
  lastSeenAt: Date | string;
  resolvedAt: Date | string | null;
  resolutionSource: 'manual' | 'auto' | null;
  cause: string | null;
  correctiveAction: string | null;
  autoResolutionOrigin: string | null;
  autoResolutionCause: string | null;
  previousAnomalyId: number | null;
  technicalDetail: Record<string, unknown> | null;
}

export interface AnomalyOccurrenceSource {
  id: number;
  occurredAt: Date | string;
  accountId: number | null;
  userId: number | null;
  technicalDetail: Record<string, unknown> | null;
}

interface Instant { iso: string; paris: string }

export interface TechnicalContext {
  code: string | null;
  sqlstate: string | null;
  etape: string | null;
  version: string | null;
  traitement: string | null;
}

export interface AnomalyExportRecord {
  id: number;
  lienBo: string;
  domaine: { code: string; libelle: string };
  code: string;
  gravite: string | null;
  graviteMotif: string | null;
  titre: string;
  statut: 'ouverte' | 'resolue';
  compte: { id: number; lienBo: string } | null;
  utilisateur: { id: number; lienBo: string } | null;
  empreinte: string;
  occurrences: number;
  premiereOccurrence: Instant;
  derniereOccurrence: Instant;
  resolution: {
    date: Instant | null;
    source: 'manuelle' | 'automatique' | null;
    origineAutomatique: string | null;
    cause: string | null;
    actionCorrective: string | null;
  } | null;
  recurrenceDe: number | null;
  contexteTechnique: TechnicalContext;
  detailTechnique: unknown;
  historique?: Array<{ id: number; date: Instant; compteId: number | null; utilisateurId: number | null; detailTechnique: unknown }>;
  /**
   * Lot 113AQ (#751) : diagnostic STRUCTURÉ des contradictions d'attributs (même contrat que l'écran),
   * masqué (secrets, e-mails, téléphones, IBAN) ; `complet` faux si borné ou en échec (jamais prétendu complet).
   */
  conflitsAttributs?: AttributeConflictsExport;
}

/** Lot 113AQ : section d'export du diagnostic des contradictions d'attributs. */
export interface AttributeConflictsExport {
  contrat: string;
  complet: boolean;
  erreur: string | null;
  diagnostic: unknown;
}

/** Lot 113AQ : diagnostic prêt à sortir du BO (valeurs métier conservées, secrets / coordonnées masqués). */
export function toConflictsExport(diagnostic: { contract: string; contractVersion: number; complete: boolean } | null, error: string | null = null): AttributeConflictsExport {
  if (!diagnostic) return { contrat: 'verebona.operation-attribute-conflicts/1', complet: false, erreur: maskFreeText(error) ?? 'diagnostic indisponible', diagnostic: null };
  return {
    contrat: `${diagnostic.contract}/${diagnostic.contractVersion}`, complet: diagnostic.complete, erreur: null,
    diagnostic: maskForExport(redactDeep(diagnostic)),
  };
}

export interface ExportMeta {
  generatedAt: Date;
  filters: { status: Status; sort: SortKey; dir: 'asc' | 'desc' };
  build: { version: string; commit: string | null };
  baseUrl: string;
}

// ── Dates ───────────────────────────────────────────────────────────────────

const PARIS = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** « 10/11/2026 17:05:03 » (heure de Paris, changement d'heure compris). */
export function parisDateTime(value: Date | string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : PARIS.format(d).replace(',', '');
}

function instant(value: Date | string): Instant {
  const d = new Date(value);
  return { iso: Number.isNaN(d.getTime()) ? '' : d.toISOString(), paris: parisDateTime(d) };
}

// ── Paramètres ──────────────────────────────────────────────────────────────

export interface AnomalyExportQuery {
  status: Status;
  sort: SortKey;
  dir: 'asc' | 'desc';
  format: AnomalyExportFormat;
  page: number;
}

type ParseResult = { ok: true; value: AnomalyExportQuery } | { ok: false; code: string; message: string };

/**
 * Mêmes paramètres que l'écran (`GET /api/admin/anomalies`) : statut, tri,
 * sens (et page pour la copie de la page affichée). Liste blanche stricte :
 * aucune valeur libre ne parvient au SQL ; une valeur inconnue est refusée
 * (un export ne doit pas porter sur autre chose que ce que l'admin croit).
 */
export function parseAnomalyExportQuery(sp: { get(k: string): string | null }, allowed: readonly AnomalyExportFormat[] = ['json', 'csv', 'md']): ParseResult {
  const status = sp.get('status') ?? 'open';
  if (status !== 'open' && status !== 'resolved') return { ok: false, code: 'INVALID_STATUS', message: 'Statut inconnu (open, resolved).' };
  const rawSort = sp.get('sort') ?? 'date';
  if (!(SORT_KEYS as readonly string[]).includes(rawSort)) return { ok: false, code: 'INVALID_SORT', message: 'Tri inconnu.' };
  const sort = rawSort as SortKey;
  const rawDir = sp.get('dir');
  if (rawDir !== null && rawDir !== 'asc' && rawDir !== 'desc') return { ok: false, code: 'INVALID_DIR', message: 'Sens de tri inconnu (asc, desc).' };
  const dir = rawDir ?? (sort === 'date' || sort === 'detected' ? 'desc' : 'asc');
  const format = (sp.get('format') ?? 'json') as AnomalyExportFormat;
  if (!allowed.includes(format)) return { ok: false, code: 'INVALID_FORMAT', message: `Format inconnu (${allowed.join(', ')}).` };
  const rawPage = sp.get('page') ?? '1';
  if (!/^\d{1,6}$/.test(rawPage) || Number(rawPage) < 1) return { ok: false, code: 'INVALID_PAGE', message: 'Page invalide.' };
  return { ok: true, value: { status, sort, dir, format, page: Number(rawPage) } };
}

/** `verebona-anomalies-ouvertes-2026-11-10.csv` (jour civil Europe/Paris). */
export function anomalyExportFileName(status: Status, ext: 'json' | 'csv' | 'md', at: Date = new Date(), id?: number): string {
  if (id !== undefined) return exportFileName('anomalie', id, at, { ext });
  return exportFileName('anomalies', status === 'open' ? 'ouvertes' : 'resolues', at, { ext });
}

// ── Masquage ────────────────────────────────────────────────────────────────

/**
 * Clés de CONTENU documentaire ou conversationnel non couvertes par les
 * règles du diagnostic (qui masquent déjà texte intégral, prompts, sorties
 * brutes) : extrait, aperçu, corps, HTML, charge utile. Remplacées par leur
 * longueur — l'analyse externe n'a pas à lire un document.
 */
const CONTENT_KEY = /^(excerpt|evidence_?excerpt|snippet|preview|text|content|body|html|html_?content|payload|raw|raw_?payload|document_?text|page_?text|answer|question|message_?text|user_?message|filename|file_?name|original_?name|original_?filename|subject)$/i;
/** Clés d'identité de compte / personne exclues (désignées par identifiant). */
const IDENTITY_KEY = /^(account_?name|accountName|user_?name|userName|display_?name|displayName|owner_?name|recipient|recipient_?name|name)$/i;

const lengthOf = (v: unknown): number => (typeof v === 'string' ? v.length : JSON.stringify(v)?.length ?? 0);

function stripContent(value: unknown, depth = 0): unknown {
  if (depth > 12) return masked('profondeur maximale');
  if (Array.isArray(value)) return value.map((v) => stripContent(v, depth + 1));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (isMarker(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) { out[k] = v; continue; }
      if (CONTENT_KEY.test(k)) { out[k] = masked('contenu (document ou échange)', lengthOf(v)); continue; }
      if (IDENTITY_KEY.test(k) && typeof v === 'string') { out[k] = masked('identité'); continue; }
      out[k] = stripContent(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Détail technique prêt à sortir du BO : contenus, identité, secrets, e-mails masqués. */
export function maskAnomalyDetail(detail: unknown): unknown {
  if (detail === null || detail === undefined) return null;
  return maskForExport(redactDeep(stripContent(detail)));
}

/** Texte libre (titre, cause, action corrective) : secrets et e-mails masqués. */
export function maskFreeText(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  return maskText(redactString(String(s)));
}

// ── Contexte technique ──────────────────────────────────────────────────────

const pick = (d: Record<string, unknown> | null, keys: readonly string[]): string | null => {
  if (!d) return null;
  for (const k of keys) {
    const v = d[k];
    if ((typeof v === 'string' && v.trim()) || typeof v === 'number') return String(v).trim().slice(0, 200);
  }
  return null;
};
const SQLSTATE = /^[0-9][0-9A-Z]{4}$/;

/**
 * Champs utiles à l'analyse, lus du détail technique (texte libre de
 * l'appelant) : code d'erreur, SQLSTATE PostgreSQL, étape, version,
 * traitement. Absent = null (jamais déduit).
 */
export function extractTechnicalContext(detail: Record<string, unknown> | null): TechnicalContext {
  const rawCode = pick(detail, ['code', 'errorCode', 'error_code', 'checkId', 'checkCode', 'check', 'kind', 'reason']);
  const sqlstate = pick(detail, ['sqlstate', 'sqlState', 'pgCode', 'pg_code']) ?? (rawCode && SQLSTATE.test(rawCode) ? rawCode : null);
  return {
    code: rawCode,
    sqlstate: sqlstate && SQLSTATE.test(sqlstate) ? sqlstate : null,
    etape: pick(detail, ['step', 'stage', 'phase', 'etape', 'state']),
    version: pick(detail, ['version', 'appVersion', 'commit', 'buildCommit', 'servingCommit', 'promptVersion', 'schemaVersion']),
    traitement: pick(detail, ['treatment', 'traitement', 'task', 'taskCode', 'operationCode', 'eventType']),
  };
}

/** Code stable de l'anomalie : celui du détail, sinon les deux premiers segments de l'empreinte. */
export function anomalyCode(fingerprint: string, ctx: TechnicalContext): string {
  if (ctx.code) return ctx.code;
  return fingerprint.split(':').slice(0, 2).join(':') || fingerprint;
}

function gravityOf(detail: Record<string, unknown> | null): { gravite: string | null; motif: string | null } {
  const g = pick(detail, ['severity', 'gravite', 'gravity', 'level', 'criticality']);
  return g ? { gravite: g, motif: null } : { gravite: null, motif: 'non définie : la Supervision n’attribue pas de criticité (CDC BO §4.5)' };
}

// ── Enregistrement ──────────────────────────────────────────────────────────

const clean = (base: string) => base.replace(/\/+$/, '');

export function toExportRecord(src: AnomalyExportSource, baseUrl: string, occurrences?: AnomalyOccurrenceSource[]): AnomalyExportRecord {
  const base = clean(baseUrl);
  const ctxRaw = extractTechnicalContext(src.technicalDetail);
  const ctx: TechnicalContext = {
    code: maskFreeText(ctxRaw.code), sqlstate: ctxRaw.sqlstate, etape: maskFreeText(ctxRaw.etape),
    version: maskFreeText(ctxRaw.version), traitement: maskFreeText(ctxRaw.traitement),
  };
  const g = gravityOf(src.technicalDetail);
  const resolved = src.status === 'resolved';
  const rec: AnomalyExportRecord = {
    id: Number(src.id),
    lienBo: `${base}/admin/supervision/${src.id}`,
    domaine: { code: src.domain, libelle: src.domainLabel },
    code: maskFreeText(anomalyCode(src.fingerprint, ctxRaw)) ?? '',
    gravite: maskFreeText(g.gravite),
    graviteMotif: g.motif,
    titre: maskFreeText(src.title) ?? '',
    statut: resolved ? 'resolue' : 'ouverte',
    compte: src.accountId ? { id: Number(src.accountId), lienBo: `${base}/admin/accounts/${src.accountId}` } : null,
    utilisateur: src.userId ? { id: Number(src.userId), lienBo: `${base}/admin/users/${src.userId}` } : null,
    empreinte: maskFreeText(src.fingerprint) ?? '',
    occurrences: Number(src.occurrenceCount),
    premiereOccurrence: instant(src.firstSeenAt),
    derniereOccurrence: instant(src.lastSeenAt),
    resolution: resolved ? {
      date: src.resolvedAt ? instant(src.resolvedAt) : null,
      source: src.resolutionSource === 'auto' ? 'automatique' : src.resolutionSource === 'manual' ? 'manuelle' : null,
      origineAutomatique: maskFreeText(src.autoResolutionOrigin),
      cause: maskFreeText(src.cause ?? src.autoResolutionCause),
      actionCorrective: maskFreeText(src.correctiveAction),
    } : null,
    recurrenceDe: src.previousAnomalyId ? Number(src.previousAnomalyId) : null,
    contexteTechnique: ctx,
    detailTechnique: maskAnomalyDetail(src.technicalDetail),
  };
  if (occurrences) {
    rec.historique = occurrences.map((o) => ({
      id: Number(o.id), date: instant(o.occurredAt), compteId: o.accountId ? Number(o.accountId) : null,
      utilisateurId: o.userId ? Number(o.userId) : null, detailTechnique: maskAnomalyDetail(o.technicalDetail),
    }));
  }
  return rec;
}

// ── Markdown (« Copier ») ───────────────────────────────────────────────────

/** Cellule / valeur Markdown sur une ligne (barres verticales et retours neutralisés). */
export function mdInline(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  return String(v).replace(/\r?\n|\r/g, ' ').replace(/\|/g, '\\|').replace(/`/g, 'ʼ').trim() || '—';
}

const SORT_LABEL: Record<SortKey, string> = { date: 'date', detected: 'détection', domain: 'domaine', account: 'compte', user: 'utilisateur' };
const statusLabel = (s: Status) => (s === 'open' ? 'anomalies ouvertes' : 'anomalies résolues (historique)');
const when = (i: Instant | null) => (i && i.iso ? `${i.paris} (Europe/Paris) — ${i.iso}` : '—');

function fence(json: unknown): string[] {
  // Bloc de code : aucune séquence ``` ne peut le refermer (les ` sont remplacés).
  return ['```json', JSON.stringify(json, null, 2).replace(/`/g, 'ʼ'), '```'];
}

/** Copie d'UNE anomalie : texte structuré prêt à coller dans un outil d'analyse. */
export function formatAnomalyMarkdown(r: AnomalyExportRecord, meta: Pick<ExportMeta, 'generatedAt' | 'build'>): string {
  const c = r.contexteTechnique;
  const L: string[] = [
    `## Anomalie #${r.id} — ${mdInline(r.titre)}`,
    '',
    `- Code : ${mdInline(r.code)}`,
    `- Gravité : ${r.gravite ? mdInline(r.gravite) : mdInline(r.graviteMotif)}`,
    `- Domaine : ${mdInline(r.domaine.libelle)} (${mdInline(r.domaine.code)})`,
    `- Statut : ${r.statut === 'ouverte' ? 'ouverte' : 'résolue'}`,
    `- Compte : ${r.compte ? `#${r.compte.id} (${r.compte.lienBo})` : 'non applicable'}`,
    `- Utilisateur : ${r.utilisateur ? `#${r.utilisateur.id}` : 'non applicable'}`,
    `- Objet (empreinte) : ${mdInline(r.empreinte)}`,
    `- Première occurrence : ${when(r.premiereOccurrence)}`,
    `- Dernière occurrence : ${when(r.derniereOccurrence)}`,
    `- Occurrences : ${r.occurrences}`,
  ];
  if (r.recurrenceDe) L.push(`- Récurrence de : #${r.recurrenceDe}`);
  if (r.resolution) {
    L.push(`- Résolution : ${when(r.resolution.date)} — ${r.resolution.source ?? 'source inconnue'}${r.resolution.origineAutomatique ? ` (${mdInline(r.resolution.origineAutomatique)})` : ''}`);
    L.push(`- Cause : ${mdInline(r.resolution.cause)}`);
    L.push(`- Action corrective : ${mdInline(r.resolution.actionCorrective)}`);
  }
  L.push('', '### Contexte technique', '',
    `- Version de l’application (à l’export) : ${mdInline(meta.build.version)}${meta.build.commit ? ` — commit ${mdInline(meta.build.commit)}` : ''}`,
    `- Version (détail) : ${mdInline(c.version)}`,
    `- SQLSTATE : ${mdInline(c.sqlstate)}`,
    `- Étape : ${mdInline(c.etape)}`,
    `- Traitement : ${mdInline(c.traitement)}`,
    `- Lien BO : ${r.lienBo}`,
    '', 'Détail technique (dernière occurrence, masqué) :', '', ...fence(r.detailTechnique ?? null));
  if (r.historique && r.historique.length > 0) {
    L.push('', `### Historique des occurrences (${r.historique.length} plus récente(s) sur ${r.occurrences})`, '',
      '| Date (Europe/Paris) | ISO | Compte | Utilisateur | Détail (masqué) |', '|---|---|---|---|---|');
    for (const o of r.historique) {
      L.push(`| ${o.date.paris} | ${o.date.iso} | ${o.compteId ? `#${o.compteId}` : '—'} | ${o.utilisateurId ? `#${o.utilisateurId}` : '—'} | ${mdInline(o.detailTechnique ? JSON.stringify(o.detailTechnique) : null)} |`);
    }
  }
  if (r.conflitsAttributs) L.push('', ...conflictsMarkdown(r.conflitsAttributs));
  L.push('', `_Copié depuis le BO Verebona le ${parisDateTime(meta.generatedAt)} (Europe/Paris) — ${meta.generatedAt.toISOString()} — format ${ANOMALY_EXPORT_FORMAT}. Données personnelles exclues ou pseudonymisées._`);
  return `${L.join('\n')}\n`;
}

type Obj = Record<string, unknown>;
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);

/** Lot 113AQ : section Markdown du diagnostic des contradictions d'attributs (cohérente avec l'écran et le JSON). */
function conflictsMarkdown(x: AttributeConflictsExport): string[] {
  const d = (x.diagnostic ?? {}) as Obj;
  const c = (d.counters ?? {}) as Obj;
  const L: string[] = [`### Contradictions d’attributs par Opération (${mdInline(x.contrat)})`, ''];
  if (!x.diagnostic) return [...L, `- Diagnostic indisponible : ${mdInline(x.erreur)} — aucun verdict n’est donné à sa place.`];
  const val = (k: string) => (c[k] === null || c[k] === undefined ? 'non mesuré' : String(c[k]));
  L.push(
    `- Lu le : ${d.generatedAt ? `${parisDateTime(String(d.generatedAt))} (Europe/Paris) — ${mdInline(String(d.generatedAt))}` : '—'} · ${x.complet ? 'complet' : 'PARTIEL (borné)'}`,
    `- Signalements : ${val('occurrences')} (matériels ${val('materialOccurrences')}, répétitions ${val('periodicReports')})`,
    `- Opérations : ${val('operations')} · attributs : ${val('attributes')} · conflits actifs : ${val('activeConflicts')} · non vérifiables : ${val('nonVerifiable')}`,
    `- Divergences légitimes : ${val('legitimateDifferences')} · résolus : ${val('resolved')} · arbitrages ouverts : ${val('openArbitrations')} · contrôles échoués : ${val('checksFailed')}`,
    `- Alerte maintenue par : ${mdInline(String(((d.alert ?? {}) as Obj).maintainedBy ?? '—'))}`,
    '', '| Compte | Opération | Attribut | Rôle | Valeurs (rôle, sources) | Retenue | Persistée | Verdict | Raison | Dernier contrôle | État |', '|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const e of arr(d.conflicts)) {
    const attr = (e.attribute ?? {}) as Obj;
    const role = (e.role ?? {}) as Obj;
    const chk = (e.lastCheck ?? {}) as Obj;
    const valeurs = arr(e.values).map((v) => `${String(v.raw)} [${String(v.roleLabel)} ; ${arr(v.sources).map((s) => `#${String(s.sourceId)}${s.fileId ? ` doc #${String(s.fileId)}` : ''}`).join(', ')}]`).join(' ⟷ ');
    L.push(`| #${String(e.accountId)} | #${String(e.operationId)} | ${mdInline(String(attr.label ?? attr.key))} | ${mdInline(String(role.label ?? '—'))} | ${mdInline(valeurs)} | ${mdInline(e.retainedValue as string | null)} | ${mdInline(e.persistedValue as string | null)} | ${mdInline(String(e.qualification))} | ${mdInline(String(e.reason ?? ''))} | ${chk.at ? `${parisDateTime(String(chk.at))} — ${mdInline(String(chk.at))}` : 'inconnu'} (${mdInline(String(chk.result ?? ''))}) | ${mdInline(String(e.lineState))} |`);
  }
  if (!arr(d.conflicts).length) L.push('| — | — | — | — | Aucune ligne active ou non vérifiable | — | — | — | — | — | — |');
  for (const l of Array.isArray(d.limits) ? (d.limits as unknown[]) : []) L.push(`- Limite : ${mdInline(String(l))}`);
  return L;
}

/** Copie de la PAGE affichée (liste filtrée visible). */
export function formatAnomalyListMarkdown(
  records: readonly AnomalyExportRecord[],
  meta: ExportMeta & { page: number; pageSize: number; total: number },
): string {
  const f = meta.filters;
  const pages = Math.max(1, Math.ceil(meta.total / meta.pageSize));
  const L: string[] = [
    `# Anomalies du BO Verebona — ${statusLabel(f.status)}`,
    '',
    `- Filtres de l’écran : statut ${f.status === 'open' ? 'ouvertes' : 'résolues'} · tri ${SORT_LABEL[f.sort]} ${f.dir === 'asc' ? 'croissant' : 'décroissant'}`,
    `- Page ${meta.page} / ${pages} : ${records.length} anomalie(s) sur ${meta.total} au total`,
    `- Généré le ${parisDateTime(meta.generatedAt)} (Europe/Paris) — ${meta.generatedAt.toISOString()}`,
    `- Version de l’application : ${mdInline(meta.build.version)}${meta.build.commit ? ` — commit ${mdInline(meta.build.commit)}` : ''}`,
    `- Format : ${ANOMALY_EXPORT_FORMAT} (liste complète : « Exporter JSON » ou « Exporter CSV »)`,
    '',
    '| # | Code | Domaine | Anomalie | Compte | Utilisateur | Occurrences | Première | Dernière | Statut | SQLSTATE | Étape | Lien BO |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of records) {
    L.push(`| ${r.id} | ${mdInline(r.code)} | ${mdInline(r.domaine.libelle)} | ${mdInline(r.titre)} | ${r.compte ? `#${r.compte.id}` : '—'} | ${r.utilisateur ? `#${r.utilisateur.id}` : '—'} | ${r.occurrences} | ${r.premiereOccurrence.paris} | ${r.derniereOccurrence.paris} | ${r.statut === 'ouverte' ? 'ouverte' : 'résolue'} | ${mdInline(r.contexteTechnique.sqlstate)} | ${mdInline(r.contexteTechnique.etape)} | ${r.lienBo} |`);
  }
  if (records.length === 0) L.push('| — | — | — | Aucune anomalie | — | — | — | — | — | — | — | — | — |');
  L.push('', '_Données personnelles exclues (nom de compte, e-mail) ; détail technique masqué. Le détail complet de chaque anomalie : écran de traitement › « Copier »._');
  return `${L.join('\n')}\n`;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

export const ANOMALY_CSV_COLUMNS = [
  'id', 'code', 'gravite', 'domaine_code', 'domaine', 'titre', 'statut', 'compte_id', 'utilisateur_id', 'empreinte', 'occurrences',
  'premiere_occurrence_paris', 'premiere_occurrence_iso', 'derniere_occurrence_paris', 'derniere_occurrence_iso',
  'resolution_paris', 'resolution_iso', 'resolution_source', 'resolution_origine', 'cause', 'action_corrective', 'recurrence_de',
  'sqlstate', 'etape', 'traitement', 'version_detail', 'lien_bo', 'detail_technique_json',
] as const;

/** En-tête CSV : BOM UTF-8 (accents lus par Excel), séparateur `;`, CRLF. */
export const ANOMALY_CSV_HEADER = `${CSV_BOM}${ANOMALY_CSV_COLUMNS.join(';')}\r\n`;

const cell = (v: string | number | null | undefined) => csvCell(v === null || v === undefined ? '' : String(v));

export function anomalyCsvLine(r: AnomalyExportRecord): string {
  const values: Record<(typeof ANOMALY_CSV_COLUMNS)[number], string | number | null> = {
    id: r.id, code: r.code, gravite: r.gravite ?? 'non définie', domaine_code: r.domaine.code, domaine: r.domaine.libelle, titre: r.titre,
    statut: r.statut, compte_id: r.compte?.id ?? null, utilisateur_id: r.utilisateur?.id ?? null, empreinte: r.empreinte, occurrences: r.occurrences,
    premiere_occurrence_paris: r.premiereOccurrence.paris, premiere_occurrence_iso: r.premiereOccurrence.iso,
    derniere_occurrence_paris: r.derniereOccurrence.paris, derniere_occurrence_iso: r.derniereOccurrence.iso,
    resolution_paris: r.resolution?.date?.paris ?? null, resolution_iso: r.resolution?.date?.iso ?? null,
    resolution_source: r.resolution?.source ?? null, resolution_origine: r.resolution?.origineAutomatique ?? null,
    cause: r.resolution?.cause ?? null, action_corrective: r.resolution?.actionCorrective ?? null, recurrence_de: r.recurrenceDe,
    sqlstate: r.contexteTechnique.sqlstate, etape: r.contexteTechnique.etape, traitement: r.contexteTechnique.traitement,
    version_detail: r.contexteTechnique.version, lien_bo: r.lienBo,
    detail_technique_json: r.detailTechnique === null || r.detailTechnique === undefined ? null : JSON.stringify(r.detailTechnique),
  };
  return `${ANOMALY_CSV_COLUMNS.map((c) => cell(values[c])).join(';')}\r\n`;
}

// ── JSON (flux) ─────────────────────────────────────────────────────────────

/** Début du document JSON : schéma versionné, filtres, horodatage, total attendu. */
export function anomalyJsonHead(meta: ExportMeta & { total: number; snapshotAt: Date }): string {
  const head = {
    format: ANOMALY_EXPORT_FORMAT,
    schema: ANOMALY_EXPORT_SCHEMA,
    schemaVersion: ANOMALY_EXPORT_SCHEMA_VERSION,
    generatedAt: meta.generatedAt.toISOString(),
    generatedAtParis: parisDateTime(meta.generatedAt),
    timeZone: 'Europe/Paris',
    snapshotAt: meta.snapshotAt.toISOString(),
    source: 'BO › Dashboard › Supervision',
    filters: meta.filters,
    application: meta.build,
    total: meta.total,
    privacy: 'Nom de compte, e-mail, administrateur et commentaire interne exclus ; compte et utilisateur désignés par identifiant interne ; détail technique masqué (secrets, e-mails pseudonymisés, identité, adresse, contenus).',
  };
  const json = JSON.stringify(head, null, 2);
  // Ouvre le tableau `items` dans l'objet (le reste est écrit au fil du flux).
  return `${json.slice(0, json.lastIndexOf('}')).replace(/\s*$/, '')},\n  "items": [\n`;
}

export function anomalyJsonItem(r: AnomalyExportRecord, index: number): string {
  return `${index === 0 ? '' : ',\n'}    ${JSON.stringify(r)}`;
}

/** Fin du document : nombre réellement écrit et complétude (un fichier tronqué n'est jamais « complet »). */
export function anomalyJsonTail(exported: number, total: number): string {
  return `\n  ],\n  "exported": ${exported},\n  "complete": ${exported === total}\n}\n`;
}
