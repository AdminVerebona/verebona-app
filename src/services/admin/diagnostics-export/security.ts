/**
 * Lot 88A — LISTE D'EXCLUSION CENTRALISÉE du diagnostic global (ticket P1
 * « Rendre le diagnostic global exhaustif et auto-suffisant », § Sécurité).
 * PUR (aucun import serveur) : partagé par le moteur, le manifeste et les
 * tests.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS NIVEAUX, TOUS DÉCLARÉS DANS LE MANIFESTE (« exclusions volontaires »)
 *
 *   1. COLONNES EXCLUES — jamais sélectionnées (absentes du SQL) : mots de
 *      passe et leurs empreintes, jetons, sessions, clés, secrets, webhooks,
 *      emplacements de stockage (secrets d'infrastructure). Règle par NOM de
 *      colonne (`DIAG_EXCLUDED_COLUMN_RULES`), valable pour toute table,
 *      présente ou future ; complétée par table (`DIAG_TABLE_OMITTED_COLUMNS`,
 *      isolation : colonnes d'une table globale qui citent d'autres comptes).
 *   2. CONTENUS RESTREINTS — colonne sélectionnée mais remplacée par sa
 *      longueur et son empreinte SHA-256 (texte intégral d'un document,
 *      prompts, sorties brutes du modèle, messages) : la corrélation reste
 *      possible (empreinte), le contenu ne sort pas. Les sorties modèle
 *      restent lisibles par le « diagnostic renforcé » (accès existant
 *      AI_MODEL_OUTPUT_ADMIN_IDS, journalisé).
 *   3. TABLES EXCLUES — par le registre de couverture (`coverage.ts`), avec
 *      catégorie et motif (sécurité, contenu personnel, hors compte…).
 *
 * Les compteurs (`input_tokens`, `output_tokens`, `max_output_tokens`…) ne
 * sont PAS des jetons d'authentification : ils sont exportés.
 * ══════════════════════════════════════════════════════════════════════════
 */

interface ColumnExclusionRule {
  code: string;
  test: RegExp;
  motif: string;
}

/** Colonnes jamais sélectionnées, quelle que soit la table (ordre : première règle qui s'applique). */
const DIAG_EXCLUDED_COLUMN_RULES: readonly ColumnExclusionRule[] = [
  { code: 'MOT_DE_PASSE', test: /pass(word|wd)|mot_de_passe/i, motif: 'mot de passe ou empreinte de mot de passe' },
  { code: 'JETON', test: /(^|_)(token|token_hash|tokens_hash)$|(access|refresh|invite|reset|session|share|verification|calendar_share|unsubscribe|magic|api)_?token/i, motif: 'jeton d’authentification ou de partage' },
  { code: 'SESSION', test: /^(session_id|session_key|checkout_session_id|sid)$/i, motif: 'identifiant de session' },
  { code: 'SECRET', test: /secret/i, motif: 'secret (fournisseur, webhook, signature)' },
  { code: 'CLE', test: /(^|_)(api_?key|apikey|private_?key|signing_?key|signature_?key|encryption_?key|key_hash|p256dh|auth_key)$/i, motif: 'clé cryptographique ou clé d’API' },
  { code: 'IDENTIFIANTS', test: /credential/i, motif: 'identifiants de connexion' },
  { code: 'EN_TETE_HTTP', test: /^(cookie|cookies|authorization|auth_header)$/i, motif: 'en-tête d’authentification' },
  { code: 'STOCKAGE', test: /(^|_)(s3_?key|s3_?bucket|storage_?path|storage_?key|blob_?key|file_?key|source_?ref|storage_prefix|endpoint)$/i, motif: 'emplacement de stockage ou point d’accès (secret d’infrastructure)' },
  // Lot 91A : empreinte de la clé d'API d'un fournisseur (corrélation inutile au diagnostic, prudence).
  { code: 'EMPREINTE_CLE', test: /(^|_)key_fingerprint$/i, motif: 'empreinte de clé d’API fournisseur' },
];

/**
 * Colonnes omises par table. Deux natures (lot 91A) :
 *   · ISOLATION — une table transversale citée par un diagnostic FILTRÉ
 *     (compte, bien, document, Opération) peut citer d'autres comptes
 *     (curseur, échantillon d'erreurs, liste de comptes) : colonne omise dans
 *     les diagnostics filtrés seulement ; le périmètre « Ensemble de
 *     l'application » (tous les comptes) l'exporte ;
 *   · CONTENU / SECURITE — texte de prompt (empreinte exportée), identité,
 *     code utilisable (promotion, parrainage) : omise dans TOUS les périmètres.
 */
type OmissionKind = 'ISOLATION' | 'CONTENU' | 'SECURITE';
const DIAG_TABLE_OMITTED_COLUMNS: Readonly<Record<string, Readonly<Record<string, { kind: OmissionKind; motif: string }>>>> = {
  coherence_campaigns: {
    scope_account_ids: { kind: 'ISOLATION', motif: 'isolation : liste des comptes de la campagne' },
    cursor_account_id: { kind: 'ISOLATION', motif: 'isolation : compte en cours de traitement' },
    error_sample: { kind: 'ISOLATION', motif: 'isolation : échantillon d’erreurs multi-comptes' },
    remaining: { kind: 'ISOLATION', motif: 'isolation : reste à traiter multi-comptes' },
    accounts: { kind: 'ISOLATION', motif: 'isolation : comptes traités' },
  },
  claim_legacy_cleanup_runs: {
    account_filter: { kind: 'ISOLATION', motif: 'isolation : filtre de comptes' }, accounts: { kind: 'ISOLATION', motif: 'isolation : comptes traités' },
    counters: { kind: 'ISOLATION', motif: 'isolation : compteurs multi-comptes' },
  },
  operations_rebuild_runs: {
    account_filter: { kind: 'ISOLATION', motif: 'isolation : filtre de comptes' }, accounts: { kind: 'ISOLATION', motif: 'isolation : comptes traités' },
    excluded: { kind: 'ISOLATION', motif: 'isolation : comptes exclus' }, counters: { kind: 'ISOLATION', motif: 'isolation : compteurs multi-comptes' },
  },
  to_process_relevance_campaigns: {
    cursor_action_id: { kind: 'ISOLATION', motif: 'isolation : curseur multi-comptes' }, cursor_file_id: { kind: 'ISOLATION', motif: 'isolation : curseur multi-comptes' },
    error_sample: { kind: 'ISOLATION', motif: 'isolation : échantillon multi-comptes' }, before_counts: { kind: 'ISOLATION', motif: 'isolation : compteurs multi-comptes' },
    after_counts: { kind: 'ISOLATION', motif: 'isolation : compteurs multi-comptes' }, outcomes: { kind: 'ISOLATION', motif: 'isolation : compteurs multi-comptes' },
    outcomes_by_rule: { kind: 'ISOLATION', motif: 'isolation : compteurs multi-comptes' },
  },
  ai_queue_worker_heartbeats: {
    running_json: { kind: 'ISOLATION', motif: 'isolation : traitements en cours d’autres comptes' },
    last_error: { kind: 'ISOLATION', motif: 'isolation : erreur possiblement liée à un autre compte' },
  },
  scheduled_task_state: {
    last_error: { kind: 'ISOLATION', motif: 'isolation : erreur multi-comptes (voir les erreurs des traitements du compte)' },
    last_note: { kind: 'ISOLATION', motif: 'isolation : note multi-comptes' },
  },
  ai_config_entries: {
    prompt: { kind: 'CONTENU', motif: 'texte de prompt : empreinte des prompts maîtres exportée (ai_master_prompt_versions.content_sha256)' },
    master_prompt: { kind: 'CONTENU', motif: 'texte de prompt maître : empreinte exportée' },
  },
  ai_master_prompt_versions: { content: { kind: 'CONTENU', motif: 'texte du prompt maître : empreinte content_sha256 exportée' } },
  ai_prompt_versions: { content: { kind: 'CONTENU', motif: 'texte du prompt : empreinte content_hash exportée' } },
  ai_config_revisions: { snapshot: { kind: 'CONTENU', motif: 'instantané complet de configuration (prompts) : empreinte snapshot_sha256 exportée' } },
  users: { username: { kind: 'CONTENU', motif: 'identité' }, company: { kind: 'CONTENU', motif: 'identité' } },
  // Lot 91A — tables transversales désormais exportées au périmètre global : codes utilisables omis.
  promo_codes: { code: { kind: 'SECURITE', motif: 'code promotionnel utilisable' } },
  signup_contexts: { raw_code: { kind: 'SECURITE', motif: 'code saisi à l’inscription (promotion ou parrainage utilisable)' } },
  referral_links: { code: { kind: 'SECURITE', motif: 'code de parrainage utilisable' } },
};

/**
 * Lot 91A — colonnes à contenu restreint PROPRES à une table (en plus de la
 * règle par nom) : contenus complets de configuration IA (prompts compris),
 * résultats rejouables de l'IA, charge brute des webhooks, contextes des
 * e-mails (liens personnels), contenu HTML / image volumineux.
 */
const DIAG_TABLE_CONTENT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  ai_config_exports: ['content'],
  ai_config_packages: ['payload'],
  ai_instructions: ['instruction', 'gemini_analysis', 'prompts_patched'],
  ai_prompt_change_requests: ['instruction', 'impact_analysis'],
  ai_operation_idempotency: ['result_json'],
  stripe_webhook_logs: ['payload'],
  transactional_email_jobs: ['context'],
  withdrawal_events: ['payload_json'],
  legal_document_versions: ['html_content'],
  system_logos: ['logo_content'],
  // Lot 84D (décision maintenue) : générations T6 sans texte généré ni contexte d'entrée — longueur et empreinte.
  home_mascot_generations: ['input_json', 'output_json'],
  home_mascot_cache: ['suggestions'],
};

/**
 * Colonnes à CONTENU RESTREINT : longueur + SHA-256, jamais le contenu (en
 * plus des règles de contenu brut du masquage existant `exportMaskingRule`).
 */
const DIAG_CONTENT_COLUMN_TEST = /^(prompt_text|response_raw|pages|ocr_pages|variables|attachments|request_params|provider_steps|actions_payload|snapshot_payload|output_payload|manifest_payload|messages|raw_output|extracted_output|parsed_output|full_text|extracted_text|raw_text|ocr_text|content_base64|raw_response(_json)?|response_body|file_content|row_data)$/i;

/**
 * Motif d'exclusion d'une colonne (null : colonne exportée). `global` : périmètre
 * « Ensemble de l'application » (tous les comptes) — les omissions d'ISOLATION
 * n'y ont pas lieu d'être (aucun autre compte à protéger).
 */
export function excludedColumnMotif(table: string, column: string, opts: { global?: boolean } = {}): { code: string; motif: string } | null {
  const t = DIAG_TABLE_OMITTED_COLUMNS[table]?.[column];
  if (t && !(t.kind === 'ISOLATION' && opts.global)) return { code: t.kind === 'ISOLATION' ? 'ISOLATION' : t.kind === 'SECURITE' ? 'SECURITE_TABLE' : 'CONTENU_TABLE', motif: t.motif };
  // Compteurs de consommation (`input_tokens`, `max_output_tokens`…) : exportés.
  if (/(^|_)tokens$/i.test(column) && !/token_hash|tokens_hash/i.test(column)) return null;
  for (const r of DIAG_EXCLUDED_COLUMN_RULES) if (r.test.test(column)) return { code: r.code, motif: r.motif };
  return null;
}

/** Vrai si la colonne est un contenu restreint (longueur + empreinte) — par nom, ou propre à la table. */
export function isRestrictedContentColumn(column: string, table?: string): boolean {
  return DIAG_CONTENT_COLUMN_TEST.test(column) || (!!table && !!DIAG_TABLE_CONTENT_COLUMNS[table]?.includes(column));
}

/** Notes du manifeste : ce qui est volontairement exclu, et pourquoi. */
export const DIAG_SECURITY_NOTES: readonly string[] = [
  'Colonnes jamais sélectionnées (règles par nom, valables pour toute table) : '
    + DIAG_EXCLUDED_COLUMN_RULES.map((r) => `${r.code} (${r.motif})`).join(' ; ') + '.',
  'Colonnes omises par table : ISOLATION (diagnostics filtrés seulement — exportées au périmètre « Ensemble de l’application »), CONTENU (texte de prompt remplacé par son empreinte, identité) et SECURITE (codes utilisables) dans tous les périmètres : listées par table dans `couverture/tables.json` (colonnesExclues).',
  'Contenus restreints (texte intégral, prompts, sorties brutes du modèle, messages) : {"$etat":"masque","longueur":N,"sha256":…} — corrélation possible, contenu non exporté ; sorties modèle lisibles par le diagnostic renforcé (accès réservé et journalisé).',
  'Tables exclues (sécurité, contenu conversationnel personnel de l’assistant) : liste et motifs dans `couverture/tables.json` et dans le manifeste (exclusionsVolontaires). Les tables transversales (journaux multi-comptes, configuration, catalogue) sont exportées au périmètre « Ensemble de l’application ».',
  'E-mails pseudonymisés, identité / adresse / téléphone / coordonnées bancaires masqués (règles existantes du diagnostic) ; identifiants et colonnes de liaison jamais masqués.',
];
