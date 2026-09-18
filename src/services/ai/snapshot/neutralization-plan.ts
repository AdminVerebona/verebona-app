/**
 * Neutralisation d'un snapshot — CDC BO IA SNP-005 à SNP-009, SCR-11.
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
 * · EFFETS EXTERNES — rien ne doit sortir (SNP-006). Une file de notifications
 *   restaurée telle quelle enverrait de vrais courriels à de vraies personnes,
 *   depuis un environnement de test, à propos d'événements passés.
 *
 * · SECRETS ET PAIEMENTS — ni credentials ni moyens de paiement réels
 *   (SNP-007). Un identifiant Stripe copié permettrait à un test de toucher un
 *   abonnement réel.
 *
 * Les identifiants MÉTIER, eux, restent identiques (SNP-004) : c'est tout
 * l'intérêt du snapshot, pouvoir reproduire un problème sur les mêmes numéros.
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
    tables: ['ai_provider_credential'],
  },
];

export function stepsByFamily(family: NeutralizationFamily): NeutralizationStep[] {
  return NEUTRALIZATION_PLAN.filter((s) => s.family === family);
}

/** Toutes les tables touchées — pour la revue, et pour vérifier le périmètre. */
export function affectedTables(): string[] {
  return [...new Set(NEUTRALIZATION_PLAN.flatMap((s) => s.tables))].sort();
}
