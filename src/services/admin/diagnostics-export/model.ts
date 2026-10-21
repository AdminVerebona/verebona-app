/**
 * BO › Dashboard › Supervision › « Diagnostics techniques » (lot 77C) —
 * vocabulaire, bornes, masquage et sérialiseurs PURS.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN EXPORT À LA DEMANDE, PAS UN SECOND MOTEUR
 *
 * Le diagnostic ASSEMBLE des lectures existantes : dossiers d'entité de
 * « Données du compte » (lot 75N/76H), TCO (`readAssetTco`, lignes et
 * provenance), rapports d'exécution T1 / T3 (lot 58C), traces IA
 * (`ai_usage_event`, `ai_operation`, `ai_call_diagnostics`), file des
 * traitements (`ai_job_queue`), anomalies de supervision. Il n'écrit rien
 * (transactions READ ONLY) ; seule la demande est journalisée
 * (`admin_audit_log`).
 *
 * MASQUAGE (ticket §5) — appliqué à TOUT le contenu avant sérialisation :
 *   · secrets : les requêtes du diagnostic listent leurs colonnes (liste
 *     blanche) ; filet de sécurité par nom de clé (mot de passe, jeton, clé
 *     d'API…) et par motif dans les textes (Bearer, sk-…, JWT, URL avec
 *     identifiants) ;
 *   · données personnelles : e-mails remplacés par un pseudonyme stable
 *     (corrélation possible sans l'adresse), adresses postales, téléphones,
 *     n° de contrat / de police / de client, noms, IBAN masqués ;
 *   · contenus bruts des documents (texte intégral, sorties brutes du
 *     modèle) : longueur seule — sauf sorties modèle en « diagnostic
 *     renforcé » (accès existant `AI_MODEL_OUTPUT_ADMIN_IDS`, journalisé).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { kcBaseKey, maskRuleFor, masked, isMarker, type MaskOptions } from '@/services/admin/account-data/model';
import { maskSensitiveString } from '@/services/business-operations/diagnostics/model';

export const DIAG_SCHEMA = 'verebona.bo.diagnostic-technique/1';

// ── Périmètres, traitements, bornes ─────────────────────────────────────────

export const DIAG_SCOPES = ['global', 'user', 'asset', 'document', 'operation'] as const;
export type DiagScope = (typeof DIAG_SCOPES)[number];

export const DIAG_SCOPE_LABELS: Readonly<Record<DiagScope, string>> = {
  global: 'Ensemble de l’application',
  user: 'Utilisateur',
  asset: 'Bien et ses équipements',
  document: 'Document',
  operation: 'Opération',
};

/** Traitements filtrables (file `ai_job_queue` et rapports d'exécution). */
export const DIAG_TREATMENTS = ['T1', 'T3', 'T4'] as const;
export type DiagTreatment = (typeof DIAG_TREATMENTS)[number];

/** Bornes explicites (ticket §5 « limitation des volumes ») — reprises dans le manifeste. */
export const DIAG_LIMITS = Object.freeze({
  /** Durée maximale de la période (jours). */
  periodMaxDays: 366,
  /** Période par défaut (jours, jusqu'à aujourd'hui). */
  periodDefaultDays: 30,
  /** Lignes par liste (journaux, appels IA, rapports…). */
  listRows: 500,
  /** Lignes par section d'un dossier d'entité (« Données du compte »). */
  dossierSectionRows: 500,
  /** Dossiers d'équipement joints à un diagnostic de bien. */
  equipmentDossiers: 25,
  /** Dossiers de document joints à un diagnostic d'Opération. */
  documentDossiers: 10,
  /** Biens dont le TCO est recalculé (document, Opération). */
  tcoAssets: 10,
  /** Lignes de TCO tracées par bien. */
  tcoTracedLines: 400,
  /** Lignes de rapport d'exécution par rapport, rapports détaillés. */
  reportEntries: 200,
  reportsWithEntries: 20,
  /** Comptes d'un utilisateur. */
  userAccounts: 10,
  /** Diagnostic renforcé : traces dont les sorties modèle sont jointes, caractères par sortie. */
  modelOutputTraces: 10,
  modelOutputChars: 50_000,
  /** Taille maximale du contenu (octets, avant compression) : au-delà, refus motivé. */
  totalBytes: 40 * 1024 * 1024,
  /** Générations simultanées par instance. */
  concurrent: 2,
});

export interface DiagRequest {
  scope: DiagScope;
  /** Identifiant de l'objet ciblé (null : global). */
  id: number | null;
  /** Période inclusive, jours UTC `YYYY-MM-DD`. */
  from: string;
  to: string;
  /** Vide : tous les traitements. */
  treatments: DiagTreatment[];
  /** Diagnostic renforcé : sorties modèle conservées (accès contrôlé, journalisé). */
  reinforced: boolean;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
function validDay(s: string): boolean {
  if (!ISO_DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && dayOf(d) === s;
}

/** Lecture stricte des paramètres (liste blanche ; aucune valeur libre ne parvient au SQL). */
export function parseDiagRequest(sp: { get(k: string): string | null }, now: Date = new Date()): ParseResult<DiagRequest> {
  const scope = sp.get('scope') ?? 'global';
  if (!(DIAG_SCOPES as readonly string[]).includes(scope)) return { ok: false, code: 'INVALID_SCOPE', message: 'Périmètre inconnu.' };
  let id: number | null = null;
  if (scope !== 'global') {
    const raw = (sp.get('id') ?? '').trim();
    if (!/^\d{1,9}$/.test(raw) || Number(raw) <= 0) return { ok: false, code: 'INVALID_ID', message: 'Identifiant obligatoire (nombre entier positif).' };
    id = Number(raw);
  }
  const today = dayOf(now);
  const to = (sp.get('to') ?? '').trim() || today;
  const from = (sp.get('from') ?? '').trim() || dayOf(new Date(new Date(`${to}T00:00:00Z`).getTime() - (DIAG_LIMITS.periodDefaultDays - 1) * DAY_MS));
  if (!validDay(from) || !validDay(to)) return { ok: false, code: 'INVALID_PERIOD', message: 'Période invalide (dates AAAA-MM-JJ).' };
  if (from > to) return { ok: false, code: 'INVALID_PERIOD', message: 'La date de début est postérieure à la date de fin.' };
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > DIAG_LIMITS.periodMaxDays) return { ok: false, code: 'PERIOD_TOO_LONG', message: `Période limitée à ${DIAG_LIMITS.periodMaxDays} jours.` };
  const rawT = (sp.get('treatments') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (rawT.some((t) => !(DIAG_TREATMENTS as readonly string[]).includes(t))) return { ok: false, code: 'INVALID_TREATMENT', message: 'Traitement inconnu (T1, T3, T4).' };
  const treatments = DIAG_TREATMENTS.filter((t) => rawT.includes(t));
  const reinforced = sp.get('reinforced') === '1' || sp.get('reinforced') === 'true';
  return { ok: true, value: { scope: scope as DiagScope, id, from, to, treatments, reinforced } };
}

/** Bornes SQL de la période : [from 00:00 UTC ; to + 1 jour 00:00 UTC[. */
export function periodBounds(r: Pick<DiagRequest, 'from' | 'to'>): { start: string; end: string } {
  return { start: `${r.from}T00:00:00.000Z`, end: new Date(Date.parse(`${r.to}T00:00:00Z`) + DAY_MS).toISOString() };
}

// ── Masquage ────────────────────────────────────────────────────────────────

/** Pseudonyme stable (FNV-1a 32 bits) : corrélation sans révéler la valeur. */
export function pseudonym(value: string): string {
  let h = 0x811c9dc5;
  const s = value.trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Motifs de secrets dans un texte libre (filet de sécurité). */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bwhsec_[A-Za-z0-9]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@[^\s]+/gi,
  /\b(?:password|passwd|mot_de_passe|secret|api[_-]?key|token)\s*[=:]\s*\S+/gi,
];

/** Texte masqué : secrets, e-mails (pseudonyme), IBAN (règle existante). */
export function maskText(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[secret masqué]');
  out = out.replace(EMAIL, (m) => `[e-mail masqué #${pseudonym(m)}]`);
  return out;
}

/** Règles par NOM de clé, en plus de celles de « Données du compte » (stockage, fichier, secrets, IBAN). */
const KEY_RULES: ReadonlyArray<{ test: RegExp; motif: string; length?: boolean; email?: boolean }> = [
  // `input_tokens` (compteur) n'est pas un secret : les compteurs sont renommés (`*_jetons`) par les requêtes.
  { test: /(password|passwd|secret|api_?key|apikey|credential|private_?key|signature_?key|cookie|authorization)|(^|_)(token|access_?token|refresh_?token|invite_?token|session_?token|reset_?token)$|^(session_?id|token)$/i, motif: 'secret ou jeton' },
  { test: /^(e-?mail|.*_email|email_.*|.*Email)$/i, motif: 'e-mail', email: true },
  { test: /^(phone|telephone|tel|mobile|mobile_?phone|phone_?number)$/i, motif: 'téléphone' },
  { test: /^(first_?name|last_?name|firstName|lastName|full_?name|birth_?date|date_of_birth)$/i, motif: 'identité' },
  { test: /(^|_)(address|adresse|street|rue|postal_?address)\d?$|^address\d?$|^(zip|postal_?code|code_?postal|city|ville)$|^ip_?address$/i, motif: 'adresse' },
  { test: /(contract|policy|contrat|police|insurance|customer|client|subscriber|adherent)_?(number|no|num|numero|id_?number)$|^(contractNumber|policyNumber|customerNumber|clientNumber)$/i, motif: 'n° de contrat ou de client' },
  { test: /^(iban|bic|swift|rib|card_?number|pan)$/i, motif: 'coordonnées bancaires' },
  { test: /^(full_?text|extracted_?text|raw_?text|ocr_?text|raw_?output|extracted_?output|parsed_?output|output_?preview|raw_?response(_json)?|content_?base64|visual_?summary|prompt|system_?prompt|messages)$/i, motif: 'contenu brut (document ou échange IA)', length: true },
];

function keyRule(k: string) {
  for (const r of KEY_RULES) if (r.test.test(k)) return r;
  return null;
}
const lengthOf = (v: unknown): number => (typeof v === 'string' ? v.length : JSON.stringify(v)?.length ?? 0);

/** Colonnes de clé de champ / de valeur des tables de preuves (même liste que « Données du compte »). */
const KEY_COLUMNS = ['field_key', 'canonical_key', 'fact_key', 'data_key', 'target_key', 'raw_key', 'origin_field_key'] as const;
const VALUE_COLUMNS = new Set([
  'value_json', 'normalized_value', 'raw_value', 'evidence_excerpt', 'value_text', 'value_number', 'old_value', 'new_value',
  'previous_value', 'proposed_value_json', 'final_value_json', 'excerpt', 'original_payload', 'proposals_json', 'trigger_context',
]);

/**
 * Masquage complet d'une valeur exportée. Réutilise les règles de « Données
 * du compte » (`maskRuleFor` : stockage, nom / URL de fichier, secrets, IBAN,
 * texte intégral ; clés canoniques sensibles du registre ; ligne de preuve
 * portant une clé sensible), puis ajoute celles du diagnostic (clé et
 * texte). IDEMPOTENT : un marqueur déjà posé (dossiers d'entité déjà
 * masqués) est conservé tel quel, longueur comprise.
 */
export function maskForExport(value: unknown, opts: MaskOptions = {}): unknown {
  return pass(value, opts);
}

function pass(value: unknown, opts: MaskOptions): unknown {
  if (typeof value === 'string') return maskText(maskSensitiveString(value));
  if (Array.isArray(value)) return value.map((v) => pass(v, opts));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (isMarker(value)) return value;
    const row = value as Record<string, unknown>;
    const sensitiveRow = !!opts.isSensitiveKey && KEY_COLUMNS.some((c) => typeof row[c] === 'string' && opts.isSensitiveKey!(String(row[c])));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined || isMarker(v)) { out[k] = v; continue; }
      const base = maskRuleFor(k);
      if (base) { out[k] = masked(base.motif, base.length ? lengthOf(v) : undefined); continue; }
      if (opts.isSensitiveKey?.(kcBaseKey(k)) && kcBaseKey(k) === k) { out[k] = masked('donnée sensible (registre)'); continue; }
      if (sensitiveRow && VALUE_COLUMNS.has(k)) { out[k] = masked('donnée sensible (registre)'); continue; }
      const rule = keyRule(k);
      if (rule) {
        out[k] = rule.email && typeof v === 'string'
          ? { $etat: 'masque', motif: 'e-mail', pseudonyme: pseudonym(v) }
          : masked(rule.motif, rule.length ? lengthOf(v) : undefined);
        continue;
      }
      out[k] = pass(v, opts);
    }
    return out;
  }
  return value;
}

/** Vrai si un texte sérialisé contient encore un motif de secret ou un e-mail en clair (contrôle de sortie). */
export function leaksSecretOrEmail(serialized: string): boolean {
  if (SECRET_PATTERNS.some((p) => { p.lastIndex = 0; const hit = p.test(serialized); p.lastIndex = 0; return hit; })) return true;
  EMAIL.lastIndex = 0;
  const hit = EMAIL.test(serialized);
  EMAIL.lastIndex = 0;
  return hit;
}

// ── Traçabilité (Document → … → Affichage) ──────────────────────────────────

export const TRACE_STEPS = ['DOCUMENT', 'EXTRACTION_IA', 'DECISION', 'ENREGISTREMENT', 'RAPPROCHEMENT', 'CALCUL', 'AFFICHAGE'] as const;
export type TraceStepCode = (typeof TRACE_STEPS)[number];
export const TRACE_STEP_LABELS: Readonly<Record<TraceStepCode, string>> = {
  DOCUMENT: 'Document source',
  EXTRACTION_IA: 'Extraction IA (T1)',
  DECISION: 'Décision (T3 / arbitrage)',
  ENREGISTREMENT: 'Enregistrement',
  RAPPROCHEMENT: 'Rapprochement',
  CALCUL: 'Calcul (TCO)',
  AFFICHAGE: 'Affichage',
};

export type TraceStatus = 'disponible' | 'partiel' | 'non_disponible' | 'sans_objet';

export interface TraceRef { table: string; id: string | number }

export interface TraceStep {
  etape: TraceStepCode;
  libelle: string;
  statut: TraceStatus;
  /** Motif d'indisponibilité / de limite (jamais une valeur reconstruite). */
  motif?: string;
  /** Lignes persistées qui fondent l'étape. */
  references: TraceRef[];
  donnees?: unknown;
}

/** Les quatre valeurs que le ticket demande de distinguer (§4). */
export interface TraceValues {
  /** Donnée source telle que lue par T1 (le document original n'est pas exporté). */
  source: unknown;
  /** Valeur proposée par l'IA (indice T1). */
  proposeeIA: unknown;
  /** Valeur réellement enregistrée (composante, fiche). */
  enregistree: unknown;
  /** Valeur calculée (TCO) et valeur affichée. */
  calculee: unknown;
  affichee: unknown;
}

export interface AmountTrace {
  /** Ligne économique du TCO (`c:<composante>`, `doc:<fichier>[:<candidat>:<n>]`, `asset:…`, `equipment:…`). */
  ligne: Record<string, unknown>;
  assetId: number | null;
  valeurs: TraceValues;
  chaine: TraceStep[];
  /** Première étape non disponible (où la trace s'interrompt), sinon null. */
  rupture: TraceStepCode | null;
}

export function step(etape: TraceStepCode, statut: TraceStatus, references: TraceRef[] = [], donnees?: unknown, motif?: string): TraceStep {
  const s: TraceStep = { etape, libelle: TRACE_STEP_LABELS[etape], statut, references };
  if (motif) s.motif = motif;
  if (donnees !== undefined) s.donnees = donnees;
  return s;
}

/** Chaîne ordonnée selon le ticket ; première rupture identifiée. */
export function finalizeTrace(t: Omit<AmountTrace, 'rupture' | 'chaine'> & { chaine: TraceStep[] }): AmountTrace {
  const ordre = new Map(TRACE_STEPS.map((s, i) => [s, i]));
  const chaine = [...t.chaine].sort((a, b) => (ordre.get(a.etape)! - ordre.get(b.etape)!));
  const rupture = chaine.find((s) => s.statut === 'non_disponible')?.etape ?? null;
  return { ...t, chaine, rupture };
}

/** Analyse d'un identifiant de ligne TCO (format du moteur, lot 61). */
export function parseLineId(id: string):
  | { kind: 'component'; componentId: number }
  | { kind: 'document'; fileId: number; candidateId: number | null; hintIndex: number | null }
  | { kind: 'asset-price'; assetId: number }
  | { kind: 'equipment-price'; equipmentId: number }
  | { kind: 'unknown' } {
  let m = /^c:(\d+)$/.exec(id);
  if (m) return { kind: 'component', componentId: Number(m[1]) };
  m = /^doc:(\d+)(?::(\d+):(\d+))?$/.exec(id);
  if (m) return { kind: 'document', fileId: Number(m[1]), candidateId: m[2] ? Number(m[2]) : null, hintIndex: m[3] ? Number(m[3]) : null };
  m = /^asset:(\d+):acquisitionPrice$/.exec(id);
  if (m) return { kind: 'asset-price', assetId: Number(m[1]) };
  m = /^equipment:(\d+):acquisitionPrice$/.exec(id);
  if (m) return { kind: 'equipment-price', equipmentId: Number(m[1]) };
  return { kind: 'unknown' };
}

/** Identifiant du candidat T1 porté par `business_operation_sources.source_version` (`c<id>|a…|t…`, consolidateur T3). */
export function candidateIdFromSourceVersion(v: unknown): number | null {
  const m = /^c(\d+)\|/.exec(typeof v === 'string' ? v : '');
  return m ? Number(m[1]) : null;
}

// ── Manifeste, fichiers, rapport ────────────────────────────────────────────

export interface DiagFileInfo {
  path: string;
  description: string;
  /** Lignes / éléments (listes), le cas échéant. */
  count?: number;
  complete: boolean;
}

export interface DiagUnavailable { element: string; motif: string }

export interface DiagManifest {
  schema: typeof DIAG_SCHEMA;
  generationId: string;
  generatedAt: string;
  environment: string;
  build: { version: string; commit: string | null; commitSource: string | null; container: string | null };
  request: DiagRequest & { scopeLabel: string };
  /** Objet ciblé résolu (compte(s), libellé). */
  target: { label: string; accountIds: number[] };
  limits: typeof DIAG_LIMITS;
  files: DiagFileInfo[];
  /** Bornes atteintes, sections non chargées. */
  warnings: string[];
  /** Informations NON disponibles (jamais reconstruites). */
  unavailable: DiagUnavailable[];
  masking: string[];
  readOnly: string;
}

export const MASKING_NOTES: readonly string[] = [
  'Secrets (mots de passe, jetons, clés d’API, signatures, cookies) : colonnes jamais sélectionnées (liste blanche) ; filet par nom de clé et par motif de texte.',
  'E-mails : remplacés par un pseudonyme stable (#xxxxxxxx) — même adresse, même pseudonyme.',
  'Adresses postales, téléphones, identité, n° de contrat / police / client, IBAN et coordonnées bancaires : masqués.',
  'Données sensibles du registre canonique (adresse, n° de contrat d’assurance, GPS…) : masquées (règle « Données du compte »).',
  'Fichiers originaux : ni contenu, ni nom d’origine, ni clé ou URL de stockage. Texte intégral et sorties brutes du modèle : longueur seule.',
  'Diagnostic renforcé (option) : sorties modèle des traces concernées, lues par l’accès existant (AI_MODEL_OUTPUT_ADMIN_IDS) et journalisées ; e-mails, IBAN et secrets restent masqués.',
];

export const READ_ONLY_NOTE = 'Diagnostic en lecture seule (transactions READ ONLY) : aucune donnée métier modifiée, aucun traitement IA déclenché. Seule la demande est journalisée (admin_audit_log).';

/** Nom de l'archive : `verebona-diagnostic-<périmètre>[-<id>]-<date>-<génération>.zip`. */
export function zipFileName(m: Pick<DiagManifest, 'request' | 'generatedAt' | 'generationId'>): string {
  const id = m.request.id ? `-${m.request.id}` : '';
  return `verebona-diagnostic-${m.request.scope}${id}-${m.generatedAt.slice(0, 10)}-${m.generationId.slice(0, 8)}.zip`;
}

const fmtEur = (cents: unknown): string => {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return 'n/d';
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  return `${neg ? '-' : ''}${String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${String(abs % 100).padStart(2, '0')} €`;
};

/** Valeur compacte d'une ligne de rapport (JSON borné ; « non disponible » pour l'absence). */
function compact(v: unknown): string {
  if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return 'non disponible';
  const s = JSON.stringify(v);
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

/** Rapport lisible (TXT) : contexte, filtres, synthèse, traçabilité des montants, limites. */
export function buildReportText(m: DiagManifest, summary: Array<[string, string | number]>, traces: AmountTrace[]): string {
  const L: string[] = [];
  L.push('VEREBONA — DIAGNOSTIC TECHNIQUE', '='.repeat(31));
  L.push(`Généré le        : ${m.generatedAt} (UTC)`);
  L.push(`Génération       : ${m.generationId}`);
  L.push(`Environnement    : ${m.environment}`);
  L.push(`Version          : ${m.build.version}${m.build.commit ? ` — commit ${m.build.commit} (${m.build.commitSource})` : ' — commit non disponible'}${m.build.container ? ` — conteneur ${m.build.container}` : ''}`);
  L.push(`Périmètre        : ${m.request.scopeLabel}${m.request.id ? ` #${m.request.id}` : ''} — ${m.target.label}`);
  L.push(`Comptes          : ${m.target.accountIds.length ? m.target.accountIds.map((a) => `#${a}`).join(', ') : '— (global)'}`);
  L.push(`Période          : du ${m.request.from} au ${m.request.to} inclus (UTC) — journaux et traitements ; l’état métier est l’état courant.`);
  L.push(`Traitements      : ${m.request.treatments.length ? m.request.treatments.join(', ') : 'tous'} (filtre : file des traitements et rapports d’exécution)`);
  L.push(`Diagnostic renforcé : ${m.request.reinforced ? 'oui (sorties modèle jointes si conservées et autorisées)' : 'non'}`);
  L.push('', READ_ONLY_NOTE);
  L.push('', '-- Synthèse --');
  for (const [k, v] of summary) L.push(`${k} : ${v}`);

  if (traces.length) {
    L.push('', '-- Traçabilité des montants (Document → Extraction IA → Décision → Enregistrement → Rapprochement → Calcul → Affichage) --');
    for (const t of traces) {
      const l = t.ligne;
      L.push('', `* Ligne ${String(l.id)} — ${String(l.label ?? '')}${t.assetId ? ` (bien #${t.assetId})` : ''}`);
      L.push(`  Montant ${fmtEur(l.eurCents)} · retenu ${fmtEur(l.includedCents)} · statut ${String(l.status ?? 'n/d')}${l.reason ? ` (${String(l.reason)})` : ''} · provenance ${String(l.provenance ?? 'n/d')}`);
      L.push(`  Valeurs : source=${compact(t.valeurs.source)} | proposée IA=${compact(t.valeurs.proposeeIA)} | enregistrée=${compact(t.valeurs.enregistree)}`);
      for (const s of t.chaine) {
        const refs = s.references.length ? ` [${s.references.map((r) => `${r.table}#${r.id}`).join(', ')}]` : '';
        L.push(`  - ${s.libelle} : ${s.statut.toUpperCase().replace('_', ' ')}${refs}${s.motif ? ` — ${s.motif}` : ''}`);
      }
      L.push(`  Rupture de la trace : ${t.rupture ? TRACE_STEP_LABELS[t.rupture] : 'aucune'}`);
    }
  }
  L.push('', '-- Informations non disponibles (signalées, jamais reconstruites) --');
  if (!m.unavailable.length) L.push('(aucune)');
  for (const u of m.unavailable) L.push(`- ${u.element} : ${u.motif}`);
  L.push('', '-- Avertissements (bornes, sections non chargées) --');
  if (!m.warnings.length) L.push('(aucun)');
  for (const w of m.warnings) L.push(`- ${w}`);
  L.push('', '-- Masquage --');
  for (const n of m.masking) L.push(`- ${n}`);
  L.push('', '-- Contenu de l’archive --');
  for (const f of m.files) L.push(`- ${f.path}${f.count !== undefined ? ` (${f.count})` : ''}${f.complete ? '' : ' — INCOMPLET'} : ${f.description}`);
  return `${L.join('\n')}\n`;
}

/** Sérialisation JSON d'un fichier de l'archive (indentation, ordre conservé). */
export function toJsonFile(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}
