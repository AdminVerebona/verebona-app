/**
 * Santé des notifications — CDC 3 §20.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * « SANS ACCÈS EXCESSIF AUX CONTENUS »
 *
 * Le §20.1 pose cette réserve dès sa première phrase, et le §20.2 la précise :
 * « ne pas afficher les clés push ni les données sensibles ».
 *
 * Ce module ne rend donc que des AGRÉGATS — des compteurs, des taux, des
 * codes d'erreur. Jamais un contenu de notification, jamais un point de
 * terminaison push, jamais une adresse complète.
 *
 * C'est une contrainte de conception, pas une discipline d'affichage : ce qui
 * n'est pas sélectionné ici ne peut pas fuiter plus loin.
 *
 * ── UN ÉCRAN DE SANTÉ SERT À DÉTECTER, PAS À CONSULTER ────────────────────
 *
 * Les neuf indicateurs du §20.1 répondent tous à la même question : quelque
 * chose est-il en train de se dégrader ? Une file qui s'allonge, un taux de
 * succès qui baisse, des événements bloqués — ce sont des signaux, et ils
 * doivent être lisibles sans ouvrir une seule notification.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';

/** Fenêtre d'observation par défaut, en heures. */
const FENETRE_DEFAUT = 24;

/** Au-delà, un événement en file est considéré comme bloqué (§20.1). */
const SEUIL_BLOCAGE_MINUTES = 60;

export interface NotificationHealth {
  fenetreHeures: number;
  /** Événements produits par type (§20.1). */
  evenementsParType: Array<{ type: string; total: number }>;
  /** Livraisons par canal, avec leur taux de succès. */
  livraisonsParCanal: Array<{
    canal: string;
    total: number;
    envoyees: number;
    echouees: number;
    tauxSucces: number | null;
  }>;
  /** Erreurs push par code — le code seul, jamais le point de terminaison. */
  erreursPushParCode: Array<{ code: string; total: number }>;
  /** Emails en échec, par gabarit. */
  emailsEnEchec: Array<{ gabarit: string; total: number }>;
  abonnementsPush: { actifs: number; enEchec: number };
  outbox: {
    enAttente: number;
    enErreur: number;
    /** En file depuis plus d'une heure — signal de blocage (§20.1). */
    bloquesDepuisSeuil: number;
    plusAncienEnAttenteMinutes: number | null;
  };
  recapitulatifs: { envoyes: number; ignoresCarVides: number };
  /** Aucun signal d'alerte : la file s'écoule et les taux tiennent. */
  sain: boolean;
  alertes: string[];
}

/**
 * Compose le tableau de santé.
 *
 * Une requête par indicateur plutôt qu'une jointure : les tables n'ont pas la
 * même granularité — un événement produit plusieurs livraisons —, et les
 * combiner produirait des compteurs faux par multiplication de lignes.
 */
export async function getNotificationHealth(
  fenetreHeures = FENETRE_DEFAUT,
): Promise<NotificationHealth> {
  const depuis = `${Math.max(1, Math.min(fenetreHeures, 720))} hours`;

  const [
    parType,
    parCanal,
    erreursPush,
    emailsEchec,
    abonnements,
    fileAttente,
    recap,
  ] = await Promise.all([
    pgClient<{ type: string; total: number }[]>`
      SELECT event_type AS type, count(*)::int AS total
      FROM notification_outbox
      WHERE created_at > now() - ${depuis}::interval
      GROUP BY event_type ORDER BY total DESC LIMIT 30
    `,

    pgClient<{ canal: string; total: number; envoyees: number; echouees: number }[]>`
      SELECT channel                                              AS canal,
             count(*)::int                                        AS total,
             count(*) FILTER (WHERE status = 'sent')::int         AS envoyees,
             count(*) FILTER (WHERE status = 'failed')::int       AS echouees
      FROM notification_deliveries
      WHERE created_at > now() - ${depuis}::interval
      GROUP BY channel ORDER BY total DESC
    `,

    // Le code d'erreur seul. Le point de terminaison push est une donnée
    // sensible : il permet d'écrire à un appareil (§20.2).
    pgClient<{ code: string; total: number }[]>`
      SELECT coalesce(last_error_code, 'sans_code') AS code, count(*)::int AS total
      FROM notification_deliveries
      WHERE channel = 'push' AND status = 'failed'
        AND created_at > now() - ${depuis}::interval
      GROUP BY 1 ORDER BY total DESC LIMIT 20
    `,

    pgClient<{ gabarit: string; total: number }[]>`
      SELECT template_code AS gabarit, count(*)::int AS total
      FROM email_logs
      WHERE status <> 'sent' AND sent_at > now() - ${depuis}::interval
      GROUP BY template_code ORDER BY total DESC LIMIT 20
    `,

    pgClient<{ actifs: number; enEchec: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'active')::int  AS actifs,
             count(*) FILTER (WHERE status <> 'active')::int AS "enEchec"
      FROM push_subscriptions
    `,

    pgClient<{
      enAttente: number; enErreur: number; bloques: number; plusAncien: number | null;
    }[]>`
      SELECT count(*) FILTER (WHERE status = 'pending')::int AS "enAttente",
             count(*) FILTER (WHERE status = 'failed')::int  AS "enErreur",
             count(*) FILTER (
               WHERE status = 'pending'
                 AND created_at < now() - ${`${SEUIL_BLOCAGE_MINUTES} minutes`}::interval
             )::int AS bloques,
             EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'pending'))) / 60
               AS "plusAncien"
      FROM notification_outbox
    `,

    // Un récapitulatif ignoré faute de contenu n'est pas un incident : c'est
    // le comportement attendu quand rien ne s'est produit. Le §20.1 demande
    // néanmoins de le compter, pour distinguer « rien à dire » de « panne ».
    pgClient<{ envoyes: number; ignores: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'sent')::int    AS envoyes,
             count(*) FILTER (WHERE status = 'skipped')::int AS ignores
      FROM notification_outbox
      WHERE event_type LIKE '%digest%'
        AND created_at > now() - ${depuis}::interval
    `,
  ]);

  const livraisonsParCanal = parCanal.map((c) => ({
    canal: c.canal,
    total: c.total,
    envoyees: c.envoyees,
    echouees: c.echouees,
    // `null` et non 0 quand rien n'a été tenté : un taux de 0 % laisserait
    // croire à une panne là où il ne s'est simplement rien passé.
    tauxSucces: c.total > 0 ? Math.round((c.envoyees / c.total) * 100) : null,
  }));

  const file = fileAttente[0] ?? { enAttente: 0, enErreur: 0, bloques: 0, plusAncien: null };

  const alertes: string[] = [];
  if (file.bloques > 0) {
    alertes.push(`${file.bloques} événement(s) en file depuis plus d'une heure.`);
  }
  if (file.enErreur > 0) {
    alertes.push(`${file.enErreur} événement(s) en erreur définitive.`);
  }
  for (const c of livraisonsParCanal) {
    // Seuil sur un volume significatif : deux échecs sur trois envois ne
    // signalent rien d'exploitable.
    if (c.tauxSucces !== null && c.tauxSucces < 80 && c.total >= 20) {
      alertes.push(`Canal ${c.canal} : ${c.tauxSucces} % de succès seulement.`);
    }
  }
  if (emailsEchec.length > 0) {
    const total = emailsEchec.reduce((s, e) => s + e.total, 0);
    alertes.push(`${total} email(s) en échec, dont ${emailsEchec[0].gabarit}.`);
  }

  return {
    fenetreHeures,
    evenementsParType: parType,
    livraisonsParCanal,
    erreursPushParCode: erreursPush,
    emailsEnEchec: emailsEchec,
    abonnementsPush: abonnements[0] ?? { actifs: 0, enEchec: 0 },
    outbox: {
      enAttente: file.enAttente,
      enErreur: file.enErreur,
      bloquesDepuisSeuil: file.bloques,
      plusAncienEnAttenteMinutes: file.plusAncien === null ? null : Math.round(file.plusAncien),
    },
    recapitulatifs: {
      envoyes: recap[0]?.envoyes ?? 0,
      ignoresCarVides: recap[0]?.ignores ?? 0,
    },
    sain: alertes.length === 0,
    alertes,
  };
}

/* ── Recherche (§20.2) ─────────────────────────────────────────────────── */

export interface RechercheCriteres {
  /** UUID de l'événement (§20.2). */
  eventId?: string;
  userId?: number;
  type?: string;
  status?: string;
  depuis?: string;
  jusqu?: string;
  limite?: number;
}

export interface LigneRecherche {
  id: string;
  eventType: string;
  status: string;
  recipientUserId: number | null;
  createdAt: Date;
  processedAt: Date | null;
  attemptCount: number;
  /** Motif d'échec, tronqué. Jamais le contenu de la notification. */
  lastError: string | null;
}

/**
 * Recherche dans la file.
 *
 * Ne rend ni `deep_link`, ni `entity_id`, ni aucune charge utile : le §20.2
 * interdit d'exposer les données sensibles, et le contenu d'une notification
 * en fait partie. Un exploitant a besoin de savoir QU'un envoi a échoué et
 * pourquoi, pas de lire ce qu'il contenait.
 */
export async function rechercherNotifications(
  criteres: RechercheCriteres,
): Promise<LigneRecherche[]> {
  const limite = Math.min(criteres.limite ?? 50, 200);

  return pgClient<LigneRecherche[]>`
    SELECT id,
           event_type        AS "eventType",
           status,
           recipient_user_id AS "recipientUserId",
           created_at        AS "createdAt",
           processed_at      AS "processedAt",
           attempt_count     AS "attemptCount",
           left(last_error, 200) AS "lastError"
    FROM notification_outbox
    WHERE (${criteres.eventId ?? null}::text IS NULL OR id::text = ${criteres.eventId ?? null})
      AND (${criteres.userId ?? null}::int IS NULL OR recipient_user_id = ${criteres.userId ?? null})
      AND (${criteres.type ?? null}::text IS NULL OR event_type = ${criteres.type ?? null})
      AND (${criteres.status ?? null}::text IS NULL OR status = ${criteres.status ?? null})
      AND (${criteres.depuis ?? null}::timestamptz IS NULL OR created_at >= ${criteres.depuis ?? null}::timestamptz)
      AND (${criteres.jusqu ?? null}::timestamptz IS NULL OR created_at <= ${criteres.jusqu ?? null}::timestamptz)
    ORDER BY id DESC
    LIMIT ${limite}
  `;
}
