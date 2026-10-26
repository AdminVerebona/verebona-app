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
  { code: 'STOCKAGE', test: /^(s3_?key|s3_?bucket|storage_?path|storage_?key|blob_?key|file_?key|source_?ref|storage_prefix|endpoint)$/i, motif: 'emplacement de stockage ou point d’accès (secret d’infrastructure)' },
];

/**
 * Colonnes omises par table (isolation stricte au compte) : une table
 * globale exportée pour la fermeture transitive peut citer d'autres comptes
 * (curseur, échantillon d'erreurs, liste de comptes) — ces colonnes ne sont
 * jamais sélectionnées.
 */
const DIAG_TABLE_OMITTED_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  coherence_campaigns: {
    scope_account_ids: 'isolation : liste des comptes de la campagne',
    cursor_account_id: 'isolation : compte en cours de traitement',
    error_sample: 'isolation : échantillon d’erreurs multi-comptes',
    remaining: 'isolation : reste à traiter multi-comptes',
    accounts: 'isolation : comptes traités',
  },
  claim_legacy_cleanup_runs: { account_filter: 'isolation : filtre de comptes', accounts: 'isolation : comptes traités', counters: 'isolation : compteurs multi-comptes' },
  operations_rebuild_runs: { account_filter: 'isolation : filtre de comptes', accounts: 'isolation : comptes traités', excluded: 'isolation : comptes exclus', counters: 'isolation : compteurs multi-comptes' },
  to_process_relevance_campaigns: { cursor_action_id: 'isolation : curseur multi-comptes', cursor_file_id: 'isolation : curseur multi-comptes', error_sample: 'isolation : échantillon multi-comptes', before_counts: 'isolation : compteurs multi-comptes', after_counts: 'isolation : compteurs multi-comptes', outcomes: 'isolation : compteurs multi-comptes', outcomes_by_rule: 'isolation : compteurs multi-comptes' },
  ai_queue_worker_heartbeats: { running_json: 'isolation : traitements en cours d’autres comptes', last_error: 'isolation : erreur possiblement liée à un autre compte' },
  scheduled_task_state: { last_error: 'isolation : erreur multi-comptes (voir les erreurs des traitements du compte)', last_note: 'isolation : note multi-comptes' },
  ai_config_entries: { prompt: 'texte de prompt : empreinte des prompts maîtres exportée (ai_master_prompt_versions.content_sha256)', master_prompt: 'texte de prompt maître : empreinte exportée' },
  ai_master_prompt_versions: { content: 'texte du prompt maître : empreinte content_sha256 exportée' },
  ai_prompt_versions: { content: 'texte du prompt : empreinte content_hash exportée' },
  ai_config_revisions: { snapshot: 'instantané complet de configuration (prompts) : empreinte snapshot_sha256 exportée' },
  users: { username: 'identité', company: 'identité' },
};

/**
 * Colonnes à CONTENU RESTREINT : longueur + SHA-256, jamais le contenu (en
 * plus des règles de contenu brut du masquage existant `exportMaskingRule`).
 */
const DIAG_CONTENT_COLUMN_TEST = /^(prompt_text|response_raw|pages|ocr_pages|variables|attachments|request_params|provider_steps|actions_payload|snapshot_payload|output_payload|manifest_payload|messages|raw_output|extracted_output|parsed_output|full_text|extracted_text|raw_text|ocr_text|content_base64|raw_response(_json)?|response_body|file_content|row_data)$/i;

/** Motif d'exclusion d'une colonne (null : colonne exportée). */
export function excludedColumnMotif(table: string, column: string): { code: string; motif: string } | null {
  const t = DIAG_TABLE_OMITTED_COLUMNS[table]?.[column];
  if (t) return { code: 'ISOLATION_OU_TABLE', motif: t };
  // Compteurs de consommation (`input_tokens`, `max_output_tokens`…) : exportés.
  if (/(^|_)tokens$/i.test(column) && !/token_hash|tokens_hash/i.test(column)) return null;
  for (const r of DIAG_EXCLUDED_COLUMN_RULES) if (r.test.test(column)) return { code: r.code, motif: r.motif };
  return null;
}

/** Vrai si la colonne est un contenu restreint (longueur + empreinte). */
export function isRestrictedContentColumn(column: string): boolean {
  return DIAG_CONTENT_COLUMN_TEST.test(column);
}

/** Notes du manifeste : ce qui est volontairement exclu, et pourquoi. */
export const DIAG_SECURITY_NOTES: readonly string[] = [
  'Colonnes jamais sélectionnées (règles par nom, valables pour toute table) : '
    + DIAG_EXCLUDED_COLUMN_RULES.map((r) => `${r.code} (${r.motif})`).join(' ; ') + '.',
  'Colonnes omises par table (isolation stricte au compte ou texte de prompt remplacé par son empreinte) : listées par fichier dans `couverture/tables.json` (colonnesExclues).',
  'Contenus restreints (texte intégral, prompts, sorties brutes du modèle, messages) : {"$etat":"masque","longueur":N,"sha256":…} — corrélation possible, contenu non exporté ; sorties modèle lisibles par le diagnostic renforcé (accès réservé et journalisé).',
  'Tables exclues (sécurité, contenu conversationnel personnel, journaux multi-comptes, catalogue commercial) : liste et motifs dans `couverture/tables.json` et dans le manifeste (exclusionsVolontaires).',
  'E-mails pseudonymisés, identité / adresse / téléphone / coordonnées bancaires masqués (règles existantes du diagnostic) ; identifiants et colonnes de liaison jamais masqués.',
];
