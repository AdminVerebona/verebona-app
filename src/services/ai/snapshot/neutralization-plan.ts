/**
 * Neutralisation d'un snapshot — CDC BO IA SNP-005 à SNP-010, SCR-11.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ CE FICHIER DÉCRIT DES OPÉRATIONS DESTRUCTRICES SUR DES DONNÉES RÉELLES
 *
 * Il est écrit pour être relu ligne à ligne avant tout usage. Chaque opération
 * porte la raison pour laquelle elle existe et ce qui arriverait sans elle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST ICI, ET CE QUI N'Y EST PAS
 *
 * N'Y EST PAS : la génération du snapshot, sa copie, la restauration, le
 * transfert des objets S3. Ces étapes dépendent de l'hébergeur, pas de
 * l'application, et un code applicatif qui prétendrait les faire donnerait
 * l'illusion d'un mécanisme complet là où il n'y a qu'une moitié.
 *
 * Y EST : le plan de neutralisation lui-même — la liste exacte de ce qu'il faut
 * faire disparaître pour qu'une copie de production cesse d'être dangereuse.
 * C'est la seule partie qui relève de la connaissance du domaine : personne
 * d'autre que l'application ne sait quelle table porte une session, un jeton de
 * rétractation ou une file de courriels en attente.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS FAMILLES, TROIS RISQUES DIFFÉRENTS
 *
 * · CONNEXION — un utilisateur réel ne doit pas pouvoir se connecter à une
 *   préproduction (SNP-005). Sinon, il verrait des données qui ressemblent aux
 *   siennes sans l'être, et agirait dessus.
 *
 * · EFFETS EXTERNES — rien ne doit sortir (SNP-006, SNP-010). Une file de
 *   notifications restaurée telle quelle enverrait de vrais courriels à de
 *   vraies personnes, depuis un environnement de test, à propos d'événements
 *   passés. Même chose pour les travaux en attente qui appellent un service
 *   tiers à la réouverture (fournisseur IA, envoi de courriels, Stripe).
 *
 * · SECRETS ET PAIEMENTS — ni credentials ni moyens de paiement réels
 *   (SNP-007). Un identifiant Stripe copié permettrait à un test de toucher un
 *   abonnement réel.
 *
 * Les identifiants MÉTIER, eux, restent identiques (SNP-004) : c'est tout
 * l'intérêt du snapshot, pouvoir reproduire un problème sur les mêmes numéros.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SNP-010 — WEBHOOKS ET INTÉGRATIONS EXTERNES, ET CONTRÔLE ANTI-EFFETS
 *
 * Inventaire du code au 27/09/2026 : l'application n'émet AUCUN webhook
 * sortant (seul Stripe l'appelle, en entrant : `stripe_webhook_logs`), et ses
 * intégrations tierces sont configurées par l'environnement (Resend, VAPID,
 * Stripe, PDFMonkey, Gemini) — sauf deux choses stockées en base : la clé du
 * fournisseur IA administrée par le BO (`ai_provider_credential`) et les
 * rattachements Stripe (comptes, abonnements, Duo, rétractations). Tout est
 * couvert ci-dessous, avec le commutateur global des courriels et les travaux
 * en attente qui déclencheraient un appel tiers à la réouverture.
 *
 * Chaque étape porte sa VÉRIFICATION (`verify`, nombre de résidus attendu à
 * 0). S'y ajoute un contrôle de dérive : une table dont le nom évoque un
 * webhook, une intégration ou un secret, et que le plan ne couvre pas, bloque
 * la réouverture — le plan doit être relu avant qu'elle ne fuie. La
 * réouverture est refusée tant qu'un contrôle n'est pas à 0
 * (`neutralization.service#assertReopeningAllowed`, et le bloc final du
 * script SQL, qui annule toute la transaction).
 *
 * Mécanismes de test explicitement autorisés (SNP-010) : les comptes de test
 * préservés (SNP-009) ; les courriels, coupés globalement, se réactivent
 * depuis le BO APRÈS la réouverture, par une décision explicite.
 */

export type NeutralizationFamily = 'connexion' | 'effets_externes' | 'secrets';

export interface NeutralizationStep {
  id: string;
  family: NeutralizationFamily;
  /** Ce que fait l'opération, en une phrase. */
  label: string;
  /** Ce qui arriverait si on l'omettait. C'est la justification, pas un commentaire. */
  risk: string;
  sql: string;
  /**
   * Contrôle anti-effets de l'étape (SNP-010) : `SELECT count(*) …` des
   * résidus, 0 attendu une fois l'étape appliquée. `$1` = comptes préservés.
   */
  verify: string;
  /** Tables touchées — pour que la revue puisse vérifier le périmètre. */
  tables: readonly string[];
}

/**
 * Domaine des adresses réécrites.
 *
 * Un domaine réservé aux tests : s'il fuitait malgré tout dans un envoi, aucun
 * courriel n'atteindrait de vraie boîte. `example.invalid` est réservé par la
 * norme et ne sera jamais délégué.
 */
export const NEUTRAL_EMAIL_DOMAIN = 'preprod.example.invalid';

/**
 * Comptes de test préservés (SNP-009).
 *
 * Reconnus par leur adresse : ils restent connectables, sinon la préproduction
 * serait inutilisable après installation. La liste vient de l'environnement,
 * pour ne pas figer dans le code des adresses qui changent.
 */
export function testAccountEmails(): string[] {
  return (process.env.PREPROD_TEST_ACCOUNTS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Plan complet.
 *
 * `$1` reçoit la liste des adresses de test à préserver. Le paramétrer plutôt
 * que l'interpoler évite qu'une adresse contenant une apostrophe casse — ou
 * détourne — une requête destructrice.
 */
export const NEUTRALIZATION_PLAN: readonly NeutralizationStep[] = [
  {
    id: 'passwords',
    family: 'connexion',
    label: 'Rendre les mots de passe réels inutilisables',
    risk:
      "Sans cela, tout utilisateur réel pourrait se connecter à la préproduction "
      + "avec son mot de passe habituel et agir sur des données qui ressemblent aux "
      + 'siennes sans l’être.',
    // Une empreinte volontairement invalide : aucun mot de passe ne peut la
    // produire, et la comparaison échouera toujours. Écraser par une empreinte
    // connue ouvrirait au contraire une porte à tout le monde.
    sql: `UPDATE users
             SET password_hash = '$neutralized$'
           WHERE lower(email) <> ALL($1::text[])`,
    verify: `SELECT count(*) FROM users
              WHERE password_hash IS DISTINCT FROM '$neutralized$'
                AND lower(email) <> ALL($1::text[])`,
    tables: ['users'],
  },
  {
    id: 'emails',
    family: 'connexion',
    label: 'Réécrire les adresses des utilisateurs réels',
    risk:
      'Une adresse réelle conservée permettrait une réinitialisation de mot de passe '
      + 'depuis la préproduction, et donc un accès — en plus de recevoir les courriels '
      + 'de test.',
    // L'identifiant reste dans l'adresse : le SNP-004 veut des identifiants
    // métier identiques, et pouvoir relier un compte à son équivalent de
    // production est tout l'intérêt du snapshot.
    sql: `UPDATE users
             SET email = 'user-' || id || '@${NEUTRAL_EMAIL_DOMAIN}'
           WHERE lower(email) <> ALL($1::text[])`,
    verify: `SELECT count(*) FROM users
              WHERE email NOT LIKE '%@${NEUTRAL_EMAIL_DOMAIN}'
                AND lower(email) <> ALL($1::text[])`,
    tables: ['users'],
  },
  {
    id: 'sessions',
    family: 'connexion',
    label: 'Supprimer les sessions et jetons révoqués',
    risk:
      'Un jeton de session copié resterait valide : il donnerait un accès immédiat '
      + 'sans mot de passe.',
    sql: `DELETE FROM revoked_tokens`,
    verify: `SELECT count(*) FROM revoked_tokens`,
    tables: ['revoked_tokens'],
  },
  {
    id: 'verification_tokens',
    family: 'connexion',
    label: 'Supprimer les jetons de vérification et de rétractation',
    risk:
      'Ces jetons ouvrent des parcours sans authentification — rétractation, '
      + 'transmission de bien, invitation Duo. Copiés, ils resteraient actionnables.',
    sql: `DELETE FROM withdrawal_verification_tokens`,
    verify: `SELECT count(*) FROM withdrawal_verification_tokens`,
    tables: ['withdrawal_verification_tokens'],
  },
  {
    id: 'notification_outbox',
    family: 'effets_externes',
    label: 'Vider la file de notifications en attente',
    risk:
      'Restaurée telle quelle, la file enverrait de vrais courriels et de vraies '
      + 'notifications à de vraies personnes, depuis un environnement de test, à propos '
      + 'd’événements déjà passés.',
    sql: `DELETE FROM notification_outbox`,
    verify: `SELECT count(*) FROM notification_outbox`,
    tables: ['notification_outbox'],
  },
  {
    id: 'push_subscriptions',
    family: 'effets_externes',
    label: 'Supprimer les abonnements aux notifications poussées',
    risk:
      'Les abonnements poussés visent des navigateurs réels : la préproduction leur '
      + 'enverrait des notifications indiscernables de celles de la production.',
    sql: `DELETE FROM push_subscriptions`,
    verify: `SELECT count(*) FROM push_subscriptions`,
    tables: ['push_subscriptions'],
  },
  {
    id: 'email_logs',
    family: 'effets_externes',
    label: 'Purger les journaux de courriels',
    risk:
      'Ils contiennent les adresses réelles et le contenu envoyé — donc des données '
      + 'personnelles que la réécriture des comptes ne suffirait pas à neutraliser.',
    sql: `DELETE FROM email_logs`,
    verify: `SELECT count(*) FROM email_logs`,
    tables: ['email_logs'],
  },
  {
    id: 'stripe_ids',
    family: 'secrets',
    label: 'Détacher les identifiants de paiement',
    risk:
      'Un identifiant client ou abonnement Stripe copié permettrait à un test de '
      + 'modifier, résilier ou facturer un abonnement RÉEL.',
    sql: `UPDATE accounts
             SET stripe_customer_id = NULL,
                 stripe_subscription_id = NULL`,
    verify: `SELECT count(*) FROM accounts
              WHERE stripe_customer_id IS NOT NULL OR stripe_subscription_id IS NOT NULL`,
    tables: ['accounts'],
  },
  {
    id: 'stripe_webhooks',
    family: 'secrets',
    label: 'Purger les journaux de webhooks de paiement',
    risk:
      'Ils portent des charges utiles complètes de Stripe : identifiants, montants, '
      + 'et parfois des éléments de facturation.',
    sql: `DELETE FROM stripe_webhook_logs`,
    verify: `SELECT count(*) FROM stripe_webhook_logs`,
    tables: ['stripe_webhook_logs'],
  },
  {
    id: 'provider_credentials',
    family: 'secrets',
    label: 'Supprimer les credentials fournisseur IA',
    risk:
      'Le SNP-007 les exclut du snapshot. La préproduction doit utiliser sa propre '
      + 'clé : partager celle de production ferait imputer les appels de test à la '
      + 'facturation réelle, et exposerait la clé à un environnement moins protégé.',
    sql: `DELETE FROM ai_provider_credential`,
    verify: `SELECT count(*) FROM ai_provider_credential`,
    tables: ['ai_provider_credential'],
  },  // ── SNP-010 : paiements — tous les rattachements Stripe, pas seulement le compte.
  {
    id: 'stripe_ids_subscriptions',
    family: 'secrets',
    label: 'Détacher les identifiants de paiement des abonnements',
    risk:
      'La synchronisation des abonnements relit Stripe à partir de ces identifiants : '
      + 'copiés, ils permettraient à la préproduction de modifier ou résilier un '
      + 'abonnement RÉEL, même une fois ceux du compte effacés.',
    sql: `UPDATE account_subscriptions
             SET stripe_customer_id = NULL,
                 stripe_subscription_id = NULL
           WHERE stripe_customer_id IS NOT NULL OR stripe_subscription_id IS NOT NULL`,
    verify: `SELECT count(*) FROM account_subscriptions
              WHERE stripe_customer_id IS NOT NULL OR stripe_subscription_id IS NOT NULL`,
    tables: ['account_subscriptions'],
  },
  {
    id: 'stripe_ids_duo',
    family: 'secrets',
    label: 'Détacher les identifiants de paiement des espaces Duo',
    risk:
      'Un espace Duo porte son propre abonnement Stripe : conservé, il resterait '
      + 'facturable et résiliable depuis la préproduction.',
    sql: `UPDATE duo_accounts
             SET stripe_customer_id = NULL,
                 stripe_subscription_id = NULL
           WHERE stripe_customer_id IS NOT NULL OR stripe_subscription_id IS NOT NULL`,
    verify: `SELECT count(*) FROM duo_accounts
              WHERE stripe_customer_id IS NOT NULL OR stripe_subscription_id IS NOT NULL`,
    tables: ['duo_accounts'],
  },
  {
    id: 'stripe_ids_withdrawals',
    family: 'secrets',
    label: 'Détacher les abonnements visés par les demandes de rétractation',
    risk:
      'Une rétractation en cours déclenche la résiliation et le remboursement de '
      + "l'abonnement Stripe qu'elle vise : rejouée en préproduction, elle "
      + 'rembourserait un client réel.',
    sql: `UPDATE withdrawal_requests
             SET stripe_subscription_id = NULL
           WHERE stripe_subscription_id IS NOT NULL`,
    verify: `SELECT count(*) FROM withdrawal_requests WHERE stripe_subscription_id IS NOT NULL`,
    tables: ['withdrawal_requests'],
  },

  // ── SNP-010 : effets externes différés — ce qui partirait À LA RÉOUVERTURE.
  {
    id: 'email_global_switch',
    family: 'effets_externes',
    label: 'Couper l’envoi global des courriels',
    risk:
      'Relances d’impayés, exports RGPD, suppressions programmées, parrainages : '
      + 'les travaux restaurés enverraient leurs courriels dès la réouverture. Même '
      + 'réécrites, les adresses partent chez le prestataire d’envoi (rebonds sur le '
      + 'domaine réel). Réactivation explicite depuis le BO, après contrôle.',
    sql: `UPDATE email_settings SET emails_enabled = false WHERE emails_enabled`,
    verify: `SELECT count(*) FROM email_settings WHERE emails_enabled`,
    tables: ['email_settings'],
  },
  {
    id: 'gdpr_export_notifications',
    family: 'effets_externes',
    label: 'Annuler les avis « archive prête » des exports RGPD en attente',
    risk:
      'Un export en attente notifierait son demandeur à la fin de sa génération : '
      + 'un message sur des données de production, émis par la préproduction.',
    sql: `UPDATE gdpr_exports
             SET notify_on_ready = false
           WHERE notify_on_ready AND notified_at IS NULL`,
    verify: `SELECT count(*) FROM gdpr_exports WHERE notify_on_ready AND notified_at IS NULL`,
    tables: ['gdpr_exports'],
  },
  {
    id: 'ai_pending_jobs',
    family: 'effets_externes',
    label: 'Annuler les travaux IA en file',
    risk:
      'Un travail en file appelle le fournisseur IA (intégration externe) dès la '
      + 'réouverture, puis écrit des résultats et déclenche des notifications — sur '
      + 'la foi d’une file figée au moment de la copie.',
    sql: `UPDATE ai_job_queue
             SET status = 'CANCELLED'
           WHERE status IN ('PENDING', 'RUNNING')`,
    verify: `SELECT count(*) FROM ai_job_queue WHERE status IN ('PENDING', 'RUNNING')`,
    tables: ['ai_job_queue'],
  },
  {
    id: 'analysis_recovery_candidates',
    family: 'effets_externes',
    label: 'Retirer les documents copiés de la reprise automatique d’analyse',
    risk:
      'La reprise d’analyse (`analysis-recovery.service`) relance d’elle-même, à '
      + 'intervalle régulier, les documents jamais analysés (état NULL), en échec '
      + '(moins de 10 tentatives), bloqués en ANALYZING ou oubliés en UPLOADED '
      + 'depuis plus de 10 min : à la réouverture, elle renverrait au fournisseur '
      + 'IA des documents de PRODUCTION copiés. Ils sont marqués en échec '
      + 'définitif (10 tentatives), état que la reprise ignore.',
    // Surensemble volontaire des critères de la reprise : ni délai de 10 min
    // (il serait écoulé à la réouverture), ni filtre sur le crédit du compte,
    // l'état du téléversement ou la suppression logique — un document exclu à
    // la copie peut redevenir éligible après.
    sql: `UPDATE asset_files
             SET analysis_state = 'ANALYSIS_FAILED',
                 analysis_retry_count = GREATEST(analysis_retry_count, 10),
                 analysis_fail_reason = 'snapshot_neutralized'
           WHERE analysis_state IS NULL
              OR analysis_state IN ('UPLOADED', 'ANALYZING')
              OR (analysis_state = 'ANALYSIS_FAILED' AND analysis_retry_count < 10)`,
    verify: `SELECT count(*) FROM asset_files
              WHERE analysis_state IS NULL
                 OR analysis_state IN ('UPLOADED', 'ANALYZING')
                 OR (analysis_state = 'ANALYSIS_FAILED' AND analysis_retry_count < 10)`,
    tables: ['asset_files'],
  },
];

export function stepsByFamily(family: NeutralizationFamily): NeutralizationStep[] {
  return NEUTRALIZATION_PLAN.filter((s) => s.family === family);
}

/** Toutes les tables touchées — pour la revue, et pour vérifier le périmètre. */
export function affectedTables(): string[] {
  return [...new Set(NEUTRALIZATION_PLAN.flatMap((s) => s.tables))].sort();
}

// ── Contrôle anti-effets avant réouverture — SNP-010 ─────────────────────────

/**
 * Noms de tables qui évoquent un webhook, une intégration ou un secret. Une
 * telle table absente du plan est une intégration que personne n'a encore
 * neutralisée : elle bloque la réouverture jusqu'à relecture du plan.
 */
export const EXTERNAL_INTEGRATION_TABLE_PATTERN = '(webhook|integration|oauth|api_?key|credential|secret)';

export interface NeutralizationCheck {
  id: string;
  label: string;
  /** `SELECT count(*) …` des résidus : 0 attendu. `$1` = comptes préservés. */
  sql: string;
}

/** Contrôles à passer avant toute réouverture : un par étape, plus la dérive. */
export function neutralizationChecks(): NeutralizationCheck[] {
  const couvertes = affectedTables().map((t) => `'${t}'`).join(', ');
  return [
    ...NEUTRALIZATION_PLAN.map((s) => ({ id: s.id, label: s.label, sql: s.verify })),
    {
      id: 'uncovered_integrations',
      label: 'Aucune table de webhook, d’intégration ou de secret hors du plan',
      sql: `SELECT count(*) FROM information_schema.tables
             WHERE table_schema = current_schema()
               AND table_name ~* '${EXTERNAL_INTEGRATION_TABLE_PATTERN}'
               AND table_name <> ALL(ARRAY[${couvertes}]::text[])`,
    },
  ];
}

// ── Script SQL pour la chaîne d'exploitation — SNP-007, SNP-008 ─────────────
//
// DÉCISION LOT IA 2 (snapshot Prod → Préprod, SNP-001 à SNP-021, SCR-11) :
// la génération, la copie S3, l'installation avec sauvegarde de sécurité, la
// maintenance et le rollback automatique dépendent de l'hébergeur (pg_dump
// sur l'instance de PROD, buckets, bascule de trafic) et ne sont PAS réalisés
// par l'application : un bouton qui prétendrait les faire donnerait l'illusion
// d'un mécanisme complet. Ils restent à outiller côté exploitation.
//
// Ce que l'application PEUT fournir, et fournit ici : le plan de
// neutralisation sous forme d'un script autonome, pour que la chaîne
// d'exploitation l'applique à la COPIE, CÔTÉ PROD, AVANT que le snapshot ne
// quitte le périmètre de production (SNP-007 / SNP-008) :
//
//   pg_dump prod | psql copie_temporaire
//   psql copie_temporaire -f neutralisation.sql   ← ce script
//   pg_dump copie_temporaire > snapshot_publiable
//
// Il est téléchargeable par `GET /api/admin/ai/snapshot?format=sql`, qui
// n'exécute RIEN. `runNeutralization` reste la dernière barrière côté
// préproduction, jamais la seule.

/**
 * Littéral SQL d'une adresse préservée. Rejette tout caractère hors du jeu
 * courant des adresses : le script est exécuté sur une copie de PRODUCTION,
 * une injection y serait irréparable. L'apostrophe est doublée par sûreté.
 */
function sqlEmailLiteral(email: string): string {
  if (!/^[a-z0-9._%+@'-]+$/i.test(email)) {
    throw new Error(`Adresse de compte de test refusée dans le script : « ${email} ».`);
  }
  return `'${email.replace(/'/g, "''")}'`;
}

/**
 * Script SQL autonome (une transaction) : chaque étape du plan, `$1` remplacé
 * par la liste des comptes de test préservés. Une table absente est ignorée
 * (même règle que `runNeutralization`), toute autre erreur annule tout.
 */
/** Littéral SQL du tableau des comptes préservés (`$1` des étapes et contrôles). */
function preservedArrayLiteral(preservedEmails: string[]): string {
  return preservedEmails.length === 0
    ? `ARRAY[]::text[]`
    : `ARRAY[${preservedEmails.map((e) => sqlEmailLiteral(e.toLowerCase())).join(', ')}]::text[]`;
}

export function renderNeutralizationScript(preservedEmails: string[] = testAccountEmails()): string {
  const array = preservedArrayLiteral(preservedEmails);
  const lines: string[] = [
    '-- Neutralisation d\'une copie de production — CDC BO IA SNP-005 à SNP-010.',
    '-- À appliquer sur la COPIE, côté production, AVANT publication (SNP-007, SNP-008).',
    `-- Comptes de test préservés : ${preservedEmails.length}. Tables : ${affectedTables().join(', ')}.`,
    'SET standard_conforming_strings = on;',
    'BEGIN;',
  ];
  for (const step of NEUTRALIZATION_PLAN) {
    const sql = step.sql.replace(/\$1::text\[\]/g, () => array);
    lines.push(
      '',
      `-- [${step.family}] ${step.id} : ${step.label}`,
      'DO $snp$ BEGIN',
      `  ${sql.replace(/\n\s*/g, ' ')};`,
      `EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'étape ${step.id} ignorée : table absente';`,
      'END $snp$;',
    );
  }
  // SNP-010 : contrôle anti-effets DANS la transaction. Un seul résidu lève
  // une exception : tout est annulé, aucun artefact à moitié neutralisé ne
  // peut être publié, et la chaîne (psql -v ON_ERROR_STOP=1) s'arrête.
  lines.push('', ...renderChecksBlock(array), '', 'COMMIT;', '');
  return lines.join('\n');
}

/**
 * Bloc PL/pgSQL qui évalue chaque contrôle et lève une exception s'il reste
 * un résidu. Une table absente compte pour 0, comme pour les étapes.
 */
function renderChecksBlock(array: string): string[] {
  const lines = [
    '-- [SNP-010] Contrôle anti-effets : aucun résidu toléré.',
    'DO $snpcheck$',
    'DECLARE',
    '  n bigint;',
    "  residus text := '';",
    'BEGIN',
  ];
  for (const check of neutralizationChecks()) {
    const sql = check.sql.replace(/\$1::text\[\]/g, () => array).replace(/\n\s*/g, ' ');
    lines.push(
      '  BEGIN',
      `    n := (${sql});`,
      `    IF n > 0 THEN residus := residus || ' ${check.id}=' || n; END IF;`,
      '  EXCEPTION WHEN undefined_table THEN NULL;',
      '  END;',
    );
  }
  lines.push(
    "  IF residus <> '' THEN",
    "    RAISE EXCEPTION 'Neutralisation incomplète, réouverture interdite :%', residus;",
    '  END IF;',
    'END $snpcheck$;',
  );
  return lines;
}

/**
 * Script de contrôle seul, en lecture : à exécuter côté préproduction juste
 * avant la réouverture (SNP-010). Échoue — et donc arrête la chaîne — s'il
 * reste le moindre résidu. Ne modifie rien.
 */
export function renderReopeningCheckScript(preservedEmails: string[] = testAccountEmails()): string {
  const array = preservedArrayLiteral(preservedEmails);
  return [
    '-- Contrôle anti-effets avant réouverture d\'une préproduction — CDC BO IA SNP-010.',
    '-- Lecture seule. Échoue s\'il reste un résidu : ne pas rouvrir.',
    'SET standard_conforming_strings = on;',
    ...renderChecksBlock(array),
    '',
  ].join('\n');
}
