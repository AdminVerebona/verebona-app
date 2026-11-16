/**
 * Diagnostic des notifications — LECTURE (lot 115B, Trello #800).
 * Formatage et expurgation : `./model.ts` (pur, testé sans base).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE SOURCE POUR L'ÉCRAN, LA COPIE ET LE FICHIER
 *
 * `construireFiltre` est la SEULE clause `WHERE` du module : les agrégats
 * cliquables, le détail paginé et l'export la partagent. C'est ce qui garantit
 * CA06 — « toute recherche filtrée et son export donnent les mêmes totaux » :
 * il n'existe pas deux façons d'interpréter les mêmes filtres.
 *
 * PAGINATION EXHAUSTIVE À CURSEUR. Le détail avance sur `(created_at, id)`
 * strictement décroissant, sans `OFFSET` : aucune ligne sautée, aucun
 * doublon, aucun plafonnement silencieux. Le total du périmètre est compté à
 * part et affiché à côté : si l'écran montre 100 lignes sur 72 + n, il le dit.
 *
 * AUCUN EFFET DE BORD. Ce module ne fait que lire : il n'appelle ni FCM ni
 * OAuth, n'écrit aucune livraison et ne réémet rien (#800 §6, CA09).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { getBuildIdentity } from '@/lib/runtime-identity';
import { fcmConfigDiagnostic } from '@/lib/mobile/push-provider';
import { serverPushEnvironment } from '@/lib/mobile/push-installations';
import {
  DIAGNOSTIC_SCHEMA_VERSION, EXPORT_LOT, FAMILLES, FAMILLE_CODES, FAMILLE_LIBELLES, NATURES, NATURE_LIBELLES,
  ETAPE_LIBELLES, curseurDe, empreinteCourte, expurgerMessageTechnique, familleDeCode, identifiantDiagnostic,
  instant, jsonEntete, jsonLigne, jsonPied, libelleFenetre, nature, queryVersParams, sectionCompletude,
  type AgregatCode, type DiagnosticQuery, type EnteteExport, type FamilleErreur, type LigneDiagnostic,
  type NatureResultat, type PerimetreDiagnostic, type SectionCompletude, type SyntheseDiagnostic,
} from './model';

/**
 * Lecteur SQL : le client global, ou la connexion réservée d'un instantané.
 * Toutes les lectures du module le reçoivent en argument — c'est ce qui permet
 * de garantir que les agrégats et le détail viennent du MÊME instantané.
 */
interface Lecteur {
  unsafe(query: string, params?: never[]): Promise<unknown>;
}

/** Délai par requête de lecture : un diagnostic ne doit pas bloquer le BO. */
const STATEMENT_TIMEOUT_MS = 30_000;
/** Durée maximale d'un export en flux (client qui ne lit plus). */
const EXPORT_MAX_MS = 10 * 60_000;

/* ── Filtre commun ────────────────────────────────────────────────────────── */

/** Statuts de livraison correspondant à chaque nature (#800 §3.5). */
const NATURE_SQL: Readonly<Record<NatureResultat, string>> = {
  accepte_par_prestataire: `d.status = 'sent' AND d.channel <> 'bell'`,
  ecrit_localement: `d.status = 'sent' AND d.channel = 'bell'`,
  echec_reel: `d.status = 'failed'`,
  ignore_volontaire: `d.status IN ('skipped_preference', 'skipped_unavailable')`,
  jeton_expire: `d.status = 'expired'`,
  en_attente: `d.status = 'pending'`,
};

/** Condition SQL d'appartenance d'un code à une famille (table du modèle). */
function conditionFamille(f: FamilleErreur, params: unknown[]): string {
  if (f === 'aucune') return 'd.last_error_code IS NULL';
  if (f === 'inconnue') {
    const connues = FAMILLES.filter((x) => x !== 'aucune' && x !== 'inconnue');
    const exacts = connues.flatMap((x) => FAMILLE_CODES[x].exacts);
    const prefixes = connues.flatMap((x) => FAMILLE_CODES[x].prefixes).map((p) => `${p}%`);
    params.push(exacts, prefixes);
    return `(d.last_error_code IS NOT NULL
             AND NOT (lower(d.last_error_code) = ANY($${params.length - 1}::text[]))
             AND NOT (lower(d.last_error_code) LIKE ANY($${params.length}::text[])))`;
  }
  const t = FAMILLE_CODES[f];
  const parties: string[] = [];
  if (t.exacts.length) {
    params.push(t.exacts);
    parties.push(`lower(d.last_error_code) = ANY($${params.length}::text[])`);
  }
  if (t.prefixes.length) {
    params.push(t.prefixes.map((p) => `${p}%`));
    parties.push(`lower(d.last_error_code) LIKE ANY($${params.length}::text[])`);
  }
  return parties.length ? `(${parties.join(' OR ')})` : 'false';
}

/**
 * Clause `WHERE` complète des livraisons du périmètre. `params` est complété
 * au fur et à mesure : toute valeur passe par un paramètre lié (aucune
 * concaténation de saisie utilisateur).
 */
function construireFiltre(q: DiagnosticQuery, params: unknown[], avecCurseur: boolean): string {
  const c: string[] = [];
  params.push(q.depuis.toISOString());
  c.push(`d.created_at >= $${params.length}::timestamptz`);
  params.push(q.jusqu.toISOString());
  c.push(`d.created_at <= $${params.length}::timestamptz`);

  if (q.canal) { params.push(q.canal); c.push(`d.channel = $${params.length}`); }
  if (q.statutLivraison) { params.push(q.statutLivraison); c.push(`d.status = $${params.length}`); }
  if (q.statutEvenement) { params.push(q.statutEvenement); c.push(`o.status = $${params.length}`); }
  if (q.code) { params.push(q.code.toLowerCase()); c.push(`lower(coalesce(d.last_error_code, '')) = $${params.length}`); }
  if (q.codeFournisseur) { params.push(q.codeFournisseur.toLowerCase()); c.push(`lower(coalesce(d.provider_error_code, '')) = $${params.length}`); }
  if (q.famille) c.push(conditionFamille(q.famille, params));
  if (q.nature) c.push(`(${NATURE_SQL[q.nature]})`);
  if (q.evenement) { params.push(q.evenement); c.push(`o.event_type = $${params.length}`); }
  if (q.utilisateurId !== null) { params.push(q.utilisateurId); c.push(`d.user_id = $${params.length}::int`); }
  if (q.compteId !== null) { params.push(q.compteId); c.push(`o.account_id = $${params.length}::int`); }
  if (q.plateforme) { params.push(q.plateforme); c.push(`i.platform = $${params.length}`); }
  if (q.environnement) { params.push(q.environnement); c.push(`i.environment = $${params.length}`); }

  // Recherche libre SANS identifiant interne (#800 §3.2) : un UUID vise les
  // identifiants stables ; toute autre saisie cherche dans la clé de
  // déduplication, le type d'événement et le code d'erreur.
  if (q.reference) {
    const ref = q.reference.trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
      params.push(ref);
      const p = params.length;
      c.push(`(d.id = $${p}::uuid OR d.outbox_id = $${p}::uuid OR o.grouped_with_id = $${p}::uuid
               OR d.mobile_push_installation_id = $${p}::uuid OR i.installation_id = $${p}::text)`);
    } else {
      params.push(`%${ref.toLowerCase()}%`);
      const p = params.length;
      c.push(`(lower(o.dedupe_key) LIKE $${p} OR lower(o.event_type) LIKE $${p}
               OR lower(coalesce(d.last_error_code, '')) LIKE $${p}
               OR lower(coalesce(d.provider_error_code, '')) LIKE $${p}
               OR lower(coalesce(i.installation_id, '')) LIKE $${p})`);
    }
  }

  if (avecCurseur && q.curseur) {
    params.push(q.curseur.createdAt, q.curseur.id);
    c.push(`(d.created_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  return c.join('\n     AND ');
}

const DEPUIS = `
  FROM notification_deliveries d
  JOIN notification_outbox o ON o.id = d.outbox_id
  LEFT JOIN mobile_push_installations i ON i.id = d.mobile_push_installation_id`;

/* ── Lignes ───────────────────────────────────────────────────────────────── */

interface LigneBrute {
  id: string; outbox_id: string; user_id: number; channel: string; status: string;
  last_error_code: string | null; last_error_message: string | null; provider_message_id: string | null;
  failure_step: string | null; failure_category: string | null; provider_name: string | null;
  provider_status_code: number | null; provider_error_code: string | null;
  created_at: Date | null; attempted_at: Date | null; sent_at: Date | null;
  event_type: string; event_status: string; event_category: string | null; outcome_reason: string | null;
  grouped_with_id: string | null; dedupe_key: string | null; event_attempts: number | null;
  event_created_at: Date | null; event_processed_at: Date | null; event_scheduled_for: Date | null;
  account_id: number | null;
  installation_row_id: string | null; installation_id: string | null; platform: string | null;
  app_version: string | null; build_number: string | null; installation_status: string | null;
  installation_status_reason: string | null; installation_environment: string | null;
  jeton_present: boolean | null; remise_confirmee: boolean | null;
}

const SELECT_LIGNES = `
  SELECT d.id::text, d.outbox_id::text, d.user_id, d.channel, d.status,
         d.last_error_code, d.last_error_message, d.provider_message_id,
         d.failure_step, d.failure_category, d.provider_name, d.provider_status_code, d.provider_error_code,
         d.created_at, d.attempted_at, d.sent_at,
         o.event_type, o.status AS event_status, o.category AS event_category, o.outcome_reason,
         o.grouped_with_id::text, o.dedupe_key, o.attempt_count AS event_attempts,
         o.created_at AS event_created_at, o.processed_at AS event_processed_at,
         o.scheduled_for AS event_scheduled_for, o.account_id,
         i.id::text AS installation_row_id, i.installation_id, i.platform, i.app_version, i.build_number,
         i.status AS installation_status, i.status_reason AS installation_status_reason,
         i.environment AS installation_environment,
         (i.push_token_enc IS NOT NULL) AS jeton_present,
         CASE WHEN d.channel = 'email' AND d.provider_message_id IS NOT NULL
              THEN EXISTS (SELECT 1 FROM email_logs l
                            WHERE l.provider_message_id = d.provider_message_id
                              AND l.delivery_status = 'delivered')
              ELSE NULL END AS remise_confirmee`;

/**
 * Traduit une ligne brute en enregistrement publiable.
 *
 * Tout ce qui pourrait porter un secret passe par `expurgerMessageTechnique`
 * ou `empreinteCourte` ICI : aucun appelant ne manipule la ligne brute.
 */
function versLigne(r: LigneBrute): LigneDiagnostic {
  const famille = familleDeCode(r.last_error_code);
  const n = nature(r.status, r.channel);
  const etape = r.failure_step;
  return {
    id: r.id,
    evenementId: r.outbox_id,
    evenementType: r.event_type,
    evenementStatut: r.event_status,
    evenementCategorie: r.event_category,
    evenementMotif: r.outcome_reason,
    regroupeAvecId: r.grouped_with_id,
    // La clé de déduplication contient des identifiants internes : tronquée.
    cleDeduplication: empreinteCourte(r.dedupe_key, 48),
    tentativesEvenement: Number(r.event_attempts ?? 0),
    canal: r.channel,
    statut: r.status,
    nature: n,
    natureLibelle: NATURE_LIBELLES[n],
    code: r.last_error_code,
    famille,
    familleLibelle: FAMILLE_LIBELLES[famille],
    message: expurgerMessageTechnique(r.last_error_message),
    etape,
    etapeLibelle: etape ? (ETAPE_LIBELLES[etape] ?? etape) : null,
    categorieEchec: r.failure_category,
    fournisseur: r.provider_name,
    statutHttp: r.provider_status_code === null ? null : Number(r.provider_status_code),
    codeFournisseur: r.provider_error_code,
    // Identifiant de message du fournisseur : non secret mais long et sans
    // intérêt complet pour le diagnostic — tronqué comme le reste.
    messageFournisseur: empreinteCourte(r.provider_message_id, 32),
    plateforme: r.platform,
    versionApplication: r.app_version,
    build: r.build_number,
    appareilId: r.installation_row_id,
    appareilEmpreinte: empreinteCourte(r.installation_id, 8),
    appareilStatut: r.installation_status,
    appareilMotifStatut: r.installation_status_reason,
    appareilEnvironnement: r.installation_environment,
    // JAMAIS le jeton : seulement sa présence (#800 §4 « sous forme booléenne »).
    appareilJetonPresent: r.installation_row_id === null ? null : r.jeton_present === true,
    utilisateurId: Number(r.user_id),
    compteId: r.account_id === null ? null : Number(r.account_id),
    creeLe: instant(r.created_at),
    tenteLe: instant(r.attempted_at),
    envoyeLe: instant(r.sent_at),
    evenementCreeLe: instant(r.event_created_at),
    evenementTraiteLe: instant(r.event_processed_at),
    evenementPrevuLe: instant(r.event_scheduled_for),
    remiseConfirmee: r.remise_confirmee === null ? null : r.remise_confirmee === true,
    // Une livraison sans aucune trace structurée est antérieure à la migration
    // 1745 : on le signale au lieu de reconstruire une cause (#800 §4).
    instrumentationStructuree: r.failure_step !== null || r.provider_name !== null || r.provider_error_code !== null || r.status === 'sent',
  };
}

/* ── Synthèse et agrégats ─────────────────────────────────────────────────── */

interface SyntheseBrute {
  livraisons: number; evenements: number; appareils: number;
  acceptes: number; locales: number; echecs: number; ignores: number; expires: number; attente: number;
}

async function lireSynthese(lire: Lecteur, q: DiagnosticQuery): Promise<SyntheseDiagnostic> {
  const params: unknown[] = [];
  const where = construireFiltre(q, params, false);
  const [r] = await lire.unsafe(`
    SELECT count(*)::int                                   AS livraisons,
           count(DISTINCT d.outbox_id)::int                AS evenements,
           count(DISTINCT d.mobile_push_installation_id)::int AS appareils,
           count(*) FILTER (WHERE d.status = 'sent' AND d.channel <> 'bell')::int AS acceptes,
           count(*) FILTER (WHERE d.status = 'sent' AND d.channel = 'bell')::int  AS locales,
           count(*) FILTER (WHERE d.status = 'failed')::int AS echecs,
           count(*) FILTER (WHERE d.status IN ('skipped_preference', 'skipped_unavailable'))::int AS ignores,
           count(*) FILTER (WHERE d.status = 'expired')::int AS expires,
           count(*) FILTER (WHERE d.status = 'pending')::int AS attente
    ${DEPUIS}
    WHERE ${where}
  `, params as never[]) as unknown as SyntheseBrute[];
  // Tentatives : somme des `attempt_count` des événements DISTINCTS du
  // périmètre. Sommer la colonne ligne par ligne la compterait autant de fois
  // qu'il y a de livraisons — c'est précisément la confusion « 7 échecs = 7
  // événements » que la carte demande de lever (#800 §1, CA04). Les mêmes
  // paramètres servent aux deux requêtes : la numérotation est identique.
  const [t] = await lire.unsafe(`
    SELECT coalesce(sum(t.attempt_count), 0)::int AS tentatives
      FROM (SELECT DISTINCT o.id, o.attempt_count ${DEPUIS} WHERE ${where}) t
  `, params as never[]) as unknown as Array<{ tentatives: number }>;
  return {
    livraisons: Number(r?.livraisons ?? 0),
    evenementsDistincts: Number(r?.evenements ?? 0),
    tentativesEvenements: Number(t?.tentatives ?? 0),
    appareils: Number(r?.appareils ?? 0),
    parNature: {
      accepte_par_prestataire: Number(r?.acceptes ?? 0),
      ecrit_localement: Number(r?.locales ?? 0),
      echec_reel: Number(r?.echecs ?? 0),
      ignore_volontaire: Number(r?.ignores ?? 0),
      jeton_expire: Number(r?.expires ?? 0),
      en_attente: Number(r?.attente ?? 0),
    },
  };
}

/**
 * Agrégats CLIQUABLES : un par (statut, code, canal). Le total de chaque
 * ligne est le nombre de livraisons que le détail rendra avec les mêmes
 * filtres plus ce statut et ce code — c'est l'invariant de CA01.
 */
async function lireAgregats(lire: Lecteur, q: DiagnosticQuery): Promise<AgregatCode[]> {
  const params: unknown[] = [];
  const where = construireFiltre(q, params, false);
  const rows = await lire.unsafe(`
    SELECT d.status, d.last_error_code, d.channel,
           count(*)::int AS livraisons,
           count(DISTINCT d.outbox_id)::int AS evenements,
           count(DISTINCT d.mobile_push_installation_id)::int AS appareils
    ${DEPUIS}
    WHERE ${where}
    GROUP BY d.status, d.last_error_code, d.channel
    ORDER BY livraisons DESC, d.status, d.channel
  `, params as never[]) as unknown as Array<{ status: string; last_error_code: string | null; channel: string; livraisons: number; evenements: number; appareils: number }>;
  return rows.map((r) => {
    const famille = familleDeCode(r.last_error_code);
    const n = nature(r.status, r.channel);
    return {
      statut: r.status,
      code: r.last_error_code,
      famille,
      familleLibelle: FAMILLE_LIBELLES[famille],
      nature: n,
      natureLibelle: NATURE_LIBELLES[n],
      canal: r.channel,
      livraisons: Number(r.livraisons),
      evenementsDistincts: Number(r.evenements),
      appareils: Number(r.appareils),
    };
  });
}

/** État de la file des événements de référence (contexte, hors fenêtre). */
async function lireFile(lire: Lecteur): Promise<Record<string, number | string | null>> {
  const [r] = await lire.unsafe(`
    SELECT count(*) FILTER (WHERE status = 'pending')::int    AS attente,
           count(*) FILTER (WHERE status = 'failed')::int     AS erreur,
           count(*) FILTER (WHERE status = 'processing')::int AS traitement,
           count(*) FILTER (WHERE status = 'pending' AND created_at < now() - interval '1 hour')::int AS bloques,
           min(created_at) FILTER (WHERE status = 'pending')  AS "plusAncien"
      FROM notification_outbox
  `) as unknown as Array<{ attente: number; erreur: number; bloques: number; traitement: number; plusAncien: Date | null }>;
  return {
    'En attente': Number(r?.attente ?? 0),
    'En cours de traitement': Number(r?.traitement ?? 0),
    'En erreur définitive': Number(r?.erreur ?? 0),
    'En file depuis plus d’une heure': Number(r?.bloques ?? 0),
    'Plus ancien événement en attente': r?.plusAncien ? (instant(r.plusAncien)?.paris ?? null) : null,
  };
}

/* ── Périmètre et complétude ──────────────────────────────────────────────── */

function perimetre(q: DiagnosticQuery, genereLe: Date, instantane: Date): PerimetreDiagnostic {
  const b = getBuildIdentity();
  const filtres: Record<string, string | number | null> = {};
  for (const [k, v] of queryVersParams(q).entries()) filtres[k] = v;
  return {
    identifiantDiagnostic: identifiantDiagnostic(q, genereLe),
    versionSchema: DIAGNOSTIC_SCHEMA_VERSION,
    genereLe: instant(genereLe)!,
    instantane: instant(instantane)!,
    fenetre: {
      depuis: instant(q.depuis)!,
      jusqu: instant(q.jusqu)!,
      periode: q.periode,
      libelle: libelleFenetre(q),
    },
    filtres,
    environnement: serverPushEnvironment(),
    build: { version: b.version, commit: b.commit },
    fuseauAffichage: 'Europe/Paris',
  };
}

/**
 * Champs que le code n'a PAS enregistrés pour les lignes du périmètre.
 *
 * C'est ce qui empêche d'écrire « COMPLET » devant un historique muet : les
 * 72 échecs du 16/11 sont antérieurs à l'instrumentation, leur étape FCM et
 * leur statut HTTP n'existent pas, et le rapport doit le dire (#800 §4).
 */
async function lireChampsNonEnregistres(lire: Lecteur, q: DiagnosticQuery): Promise<string[]> {
  const params: unknown[] = [];
  const where = construireFiltre(q, params, false);
  const [r] = await lire.unsafe(`
    SELECT count(*) FILTER (WHERE d.status <> 'sent' AND d.failure_step IS NULL)::int        AS sans_etape,
           count(*) FILTER (WHERE d.status <> 'sent' AND d.provider_status_code IS NULL
                              AND d.channel = 'push' AND d.status IN ('failed', 'expired'))::int AS sans_http,
           count(*) FILTER (WHERE d.status <> 'sent' AND d.provider_error_code IS NULL
                              AND d.channel = 'push' AND d.status IN ('failed', 'expired'))::int AS sans_code_fournisseur,
           count(*) FILTER (WHERE d.last_error_message IS NULL AND d.status = 'failed')::int AS sans_message
    ${DEPUIS}
    WHERE ${where}
  `, params as never[]) as unknown as Array<{ sans_etape: number; sans_http: number; sans_code_fournisseur: number; sans_message: number }>;
  const manquants: string[] = [];
  const n = (v: number | undefined) => Number(v ?? 0);
  if (n(r?.sans_etape)) manquants.push(`Étape fautive non enregistrée pour ${n(r?.sans_etape)} livraison(s) (antérieures à l’instrumentation du lot 115B).`);
  if (n(r?.sans_http)) manquants.push(`Statut HTTP du fournisseur non enregistré pour ${n(r?.sans_http)} livraison(s) push en échec.`);
  if (n(r?.sans_code_fournisseur)) manquants.push(`Code exact du fournisseur non enregistré pour ${n(r?.sans_code_fournisseur)} livraison(s) push en échec.`);
  if (n(r?.sans_message)) manquants.push(`Message technique non enregistré pour ${n(r?.sans_message)} livraison(s) en échec.`);
  return manquants;
}

/* ── Rapport affiché (écran) ──────────────────────────────────────────────── */

export interface RapportDiagnostic {
  perimetre: PerimetreDiagnostic;
  synthese: SyntheseDiagnostic;
  agregats: AgregatCode[];
  lignes: LigneDiagnostic[];
  /** Curseur de la page suivante ; `null` = dernière page. */
  curseurSuivant: string | null;
  /** Total du périmètre, indépendant de la page affichée (CA06). */
  total: number;
  configurationPush: Record<string, string | number | boolean | null>;
  file: Record<string, number | string | null>;
  sections: SectionCompletude[];
  champsNonEnregistres: string[];
}

/** État de la configuration push, sans aucune valeur secrète (#800 §4). */
export function configurationPushAffichable(): Record<string, string | number | boolean | null> {
  const d = fcmConfigDiagnostic();
  return {
    'Fournisseur configuré': d.configure,
    'FIREBASE_SERVICE_ACCOUNT_JSON posée': d.compteDeServicePresent,
    'Compte de service lisible': d.compteDeServiceLisible,
    'FIREBASE_PROJECT_ID posée': d.variableProjetPresente,
    'Projet concordant avec le compte de service': d.projetConcordant,
    'Empreinte du projet effectif': d.empreinteProjet,
    'Droits et API réellement vérifiés': d.permissionsVerifiees,
    'Anomalie de réglage': d.anomalie,
    'Environnement du serveur': serverPushEnvironment(),
  };
}

/**
 * Rapport complet du périmètre demandé : agrégats cliquables, page de détail,
 * configuration, file et manifeste de complétude. Toutes les sections sont
 * lues dans le MÊME instantané (`REPEATABLE READ READ ONLY`) : les totaux de
 * l'écran et ceux de l'export ne peuvent pas diverger par un envoi survenu
 * entre deux requêtes (#800 §5).
 */
export async function lireRapportDiagnostic(q: DiagnosticQuery): Promise<RapportDiagnostic> {
  const genereLe = new Date();
  const conn = await pgClient.reserve();
  try {
    await conn.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await conn.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const [{ at: instantane }] = await conn.unsafe('SELECT now() AS at') as unknown as Array<{ at: Date }>;

    // Toutes les lectures reçoivent la connexion réservée : agrégats, détail
    // et manifeste viennent du même instantané.
    const params: unknown[] = [];
    const where = construireFiltre(q, params, true);
    const lignesBrutes = await conn.unsafe(`
      ${SELECT_LIGNES}
      ${DEPUIS}
      WHERE ${where}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT ${Math.max(1, Math.min(500, q.taille))}
    `, params as never[]) as unknown as LigneBrute[];
    const lignes = lignesBrutes.map(versLigne);

    // Une connexion réservée ne traite qu'une requête à la fois : séquentiel.
    const synthese = await lireSynthese(conn, q);
    const agregats = await lireAgregats(conn, q);
    const champsNonEnregistres = await lireChampsNonEnregistres(conn, q);
    const file = await lireFile(conn);

    const complet = lignes.length >= synthese.livraisons;
    const sections: SectionCompletude[] = [
      sectionCompletude('synthese', 'COMPLETE', synthese.livraisons, synthese.livraisons, null, genereLe),
      sectionCompletude('agregats', 'COMPLETE', agregats.length, agregats.length, null, genereLe),
      sectionCompletude(
        'livraisons',
        complet ? (champsNonEnregistres.length ? 'PARTIAL' : 'COMPLETE') : 'PARTIAL',
        synthese.livraisons, lignes.length,
        complet
          ? (champsNonEnregistres.length ? 'Certaines livraisons n’ont pas de trace structurée.' : null)
          : `Page affichée : ${lignes.length} livraison(s) sur ${synthese.livraisons}. Utilisez « Télécharger les résultats filtrés » pour l’ensemble.`,
        genereLe,
      ),
      sectionCompletude(
        'configurationPush',
        'COMPLETE', null, null,
        'État de structure seulement : aucun appel à FCM n’est fait par le diagnostic.',
        genereLe,
      ),
    ];

    const dernier = lignes[lignes.length - 1];
    return {
      perimetre: perimetre(q, genereLe, instantane),
      synthese,
      agregats,
      lignes,
      curseurSuivant: !complet && dernier ? curseurDe(dernier) : null,
      total: synthese.livraisons,
      configurationPush: configurationPushAffichable(),
      file,
      sections,
      champsNonEnregistres,
    };
  } finally {
    try { await conn.unsafe('ROLLBACK'); } catch { /* transaction déjà close */ }
    conn.release();
  }
}

/* ── Dossier d'UN événement de référence ──────────────────────────────────── */

export interface DossierEvenement {
  perimetre: PerimetreDiagnostic;
  evenement: {
    id: string;
    type: string;
    statut: string;
    categorie: string | null;
    motif: string | null;
    regroupeAvecId: string | null;
    cleDeduplication: string | null;
    tentatives: number;
    destinataireUtilisateurId: number;
    compteId: number | null;
    obligatoireCloche: boolean;
    obligatoireEmail: boolean;
    priorite: string;
    creeLe: { iso: string; paris: string } | null;
    prevuLe: { iso: string; paris: string } | null;
    traiteLe: { iso: string; paris: string } | null;
    derniereErreur: string | null;
  };
  /** Autres événements portant la même clé de déduplication de base (tentatives du même récapitulatif). */
  evenementsApparentes: Array<{ id: string; statut: string; creeLe: { iso: string; paris: string } | null; tentatives: number }>;
  livraisons: LigneDiagnostic[];
  synthese: SyntheseDiagnostic;
  configurationPush: Record<string, string | number | boolean | null>;
  sections: SectionCompletude[];
  champsNonEnregistres: string[];
}

/** Dossier structuré d'un événement : null s'il n'existe pas. */
export async function lireDossierEvenement(outboxId: string, q: DiagnosticQuery): Promise<DossierEvenement | null> {
  const genereLe = new Date();
  const [ev] = await pgClient<Array<{
    id: string; event_type: string; status: string; category: string | null; outcome_reason: string | null;
    grouped_with_id: string | null; dedupe_key: string | null; attempt_count: number;
    recipient_user_id: number; account_id: number | null; mandatory_bell: boolean; mandatory_email: boolean;
    priority: string; created_at: Date | null; scheduled_for: Date | null; processed_at: Date | null; last_error: string | null;
  }>>`
    SELECT id::text, event_type, status, category, outcome_reason, grouped_with_id::text, dedupe_key,
           attempt_count, recipient_user_id, account_id, mandatory_bell, mandatory_email, priority,
           created_at, scheduled_for, processed_at, last_error
      FROM notification_outbox WHERE id = ${outboxId}::uuid`;
  if (!ev) return null;

  const brutes = await pgClient.unsafe(`
    ${SELECT_LIGNES}
    ${DEPUIS}
    WHERE d.outbox_id = $1::uuid
    ORDER BY d.created_at ASC, d.channel ASC, d.id ASC
  `, [outboxId] as never[]) as unknown as LigneBrute[];
  const livraisons = brutes.map(versLigne);

  // Tentatives d'un même récapitulatif (#800 CA04) : la clé de déduplication
  // d'une réémission dérive de celle d'origine (`…:reemis:n`). On regroupe sur
  // la racine, SANS présenter ces lignes comme des événements distincts.
  const racine = (ev.dedupe_key ?? '').replace(/:reemis:\d+$/, '');
  const apparentes = racine
    ? await pgClient<Array<{ id: string; status: string; created_at: Date | null; attempt_count: number }>>`
        SELECT id::text, status, created_at, attempt_count
          FROM notification_outbox
         WHERE id <> ${outboxId}::uuid
           AND (dedupe_key = ${racine} OR dedupe_key LIKE ${`${racine}:reemis:%`})
         ORDER BY created_at ASC LIMIT 50`
    : [];

  const parNature = NATURES.reduce((acc, n) => {
    acc[n] = livraisons.filter((l) => l.nature === n).length;
    return acc;
  }, {} as Record<NatureResultat, number>);
  const synthese: SyntheseDiagnostic = {
    livraisons: livraisons.length,
    evenementsDistincts: 1,
    tentativesEvenements: Number(ev.attempt_count ?? 0),
    appareils: new Set(livraisons.map((l) => l.appareilId).filter((x): x is string => x !== null)).size,
    parNature,
  };
  const champsNonEnregistres: string[] = [];
  const sansTrace = livraisons.filter((l) => !l.instrumentationStructuree).length;
  if (sansTrace) {
    champsNonEnregistres.push(`${sansTrace} livraison(s) sans trace structurée (antérieures à l’instrumentation du lot 115B) : étape, statut HTTP et code fournisseur non enregistrés.`);
  }
  const sections: SectionCompletude[] = [
    sectionCompletude('evenement', 'COMPLETE', 1, 1, null, genereLe),
    sectionCompletude(
      'livraisons',
      champsNonEnregistres.length ? 'PARTIAL' : livraisons.length ? 'COMPLETE' : 'NOT_APPLICABLE',
      livraisons.length, livraisons.length,
      champsNonEnregistres[0] ?? (livraisons.length ? null : 'Aucune livraison enregistrée pour cet événement de référence.'),
      genereLe,
    ),
    sectionCompletude('evenementsApparentes', 'COMPLETE', apparentes.length, apparentes.length, null, genereLe),
    sectionCompletude('configurationPush', 'COMPLETE', null, null, 'État de structure seulement : aucun appel à FCM n’est fait par le diagnostic.', genereLe),
  ];

  return {
    perimetre: perimetre(q, genereLe, genereLe),
    evenement: {
      id: ev.id,
      type: ev.event_type,
      statut: ev.status,
      categorie: ev.category,
      motif: ev.outcome_reason,
      regroupeAvecId: ev.grouped_with_id,
      cleDeduplication: empreinteCourte(ev.dedupe_key, 48),
      tentatives: Number(ev.attempt_count ?? 0),
      destinataireUtilisateurId: Number(ev.recipient_user_id),
      compteId: ev.account_id === null ? null : Number(ev.account_id),
      obligatoireCloche: ev.mandatory_bell === true,
      obligatoireEmail: ev.mandatory_email === true,
      priorite: ev.priority,
      creeLe: instant(ev.created_at),
      prevuLe: instant(ev.scheduled_for),
      traiteLe: instant(ev.processed_at),
      derniereErreur: expurgerMessageTechnique(ev.last_error),
    },
    evenementsApparentes: apparentes.map((a) => ({
      id: a.id, statut: a.status, creeLe: instant(a.created_at), tentatives: Number(a.attempt_count ?? 0),
    })),
    livraisons,
    synthese,
    configurationPush: configurationPushAffichable(),
    sections,
    champsNonEnregistres,
  };
}

/* ── Export complet en flux ───────────────────────────────────────────────── */

export interface IssueExport { exporte: number; attendu: number; complet: boolean; erreur: string | null; octets: number }

/**
 * Ouvre l'instantané, compte le périmètre, déclare le curseur et rend le corps
 * de réponse JSON produit lot par lot.
 *
 * L'export n'est JAMAIS limité à la page affichée (#800 §5) : il repart des
 * mêmes filtres, sans curseur, et écrit tout le périmètre. Une interruption
 * (départ du client, délai, erreur de lecture) est déclarée dans le manifeste
 * et dans le journal d'audit : il n'existe pas de fichier tronqué qui se
 * présente comme complet.
 */
export async function ouvrirExportDiagnostic(
  q: DiagnosticQuery,
  opts: { onDone?: (o: IssueExport) => void | Promise<void>; lot?: number } = {},
): Promise<{ attendu: number; body: ReadableStream<Uint8Array> }> {
  const lot = Math.max(1, Math.min(5000, Math.floor(opts.lot ?? EXPORT_LOT)));
  const genereLe = new Date();
  // L'export ignore le curseur de l'écran : il reprend TOUT le périmètre.
  const sansCurseur: DiagnosticQuery = { ...q, curseur: null };
  const conn = await pgClient.reserve();
  let fermee = false;
  const fermer = async () => {
    if (fermee) return;
    fermee = true;
    try { await conn.unsafe('ROLLBACK'); } catch { /* transaction déjà close */ }
    conn.release();
  };

  let attendu = 0;
  let instantane = genereLe;
  let entete: EnteteExport;
  try {
    await conn.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await conn.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const [{ at }] = await conn.unsafe('SELECT now() AS at') as unknown as Array<{ at: Date }>;
    instantane = new Date(at);

    const synthese = await lireSynthese(conn, sansCurseur);
    const agregats = await lireAgregats(conn, sansCurseur);
    const champsNonEnregistres = await lireChampsNonEnregistres(conn, sansCurseur);
    const file = await lireFile(conn);
    attendu = synthese.livraisons;
    entete = {
      perimetre: perimetre(sansCurseur, genereLe, instantane),
      synthese,
      agregats,
      configurationPush: configurationPushAffichable(),
      file,
      sections: [
        sectionCompletude('synthese', 'COMPLETE', attendu, attendu, null, genereLe),
        sectionCompletude('agregats', 'COMPLETE', agregats.length, agregats.length, null, genereLe),
        sectionCompletude('configurationPush', 'COMPLETE', null, null, 'État de structure seulement : aucun appel à FCM n’est fait par le diagnostic.', genereLe),
        sectionCompletude(
          'livraisons',
          attendu === 0 ? 'NOT_APPLICABLE' : 'PARTIAL',
          attendu, null,
          attendu === 0 ? 'Aucune livraison dans ce périmètre.' : 'Écriture en cours : l’issue est portée par le manifeste.',
          genereLe,
        ),
      ],
      champsNonEnregistres,
    };

    const params: unknown[] = [];
    const where = construireFiltre(sansCurseur, params, false);
    await conn.unsafe(`
      DECLARE vb_notif_diag NO SCROLL CURSOR FOR
      ${SELECT_LIGNES}
      ${DEPUIS}
      WHERE ${where}
      ORDER BY d.created_at DESC, d.id DESC
    `, params as never[]);
  } catch (e) {
    await fermer();
    throw e;
  }

  const enc = new TextEncoder();
  let exporte = 0;
  let octets = 0;
  let termine = false;
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const champs = entete.champsNonEnregistres;
  const finir = async (erreur: string | null) => {
    if (termine) return;
    termine = true;
    clearTimeout(minuteur);
    await fermer();
    try {
      await opts.onDone?.({ exporte, attendu, complet: erreur === null && exporte === attendu, erreur, octets });
    } catch { /* audit : ne lève jamais */ }
  };
  const minuteur = setTimeout(() => {
    void finir('EXPORT_TIMEOUT');
    try { ctrl?.error(new Error('EXPORT_TIMEOUT')); } catch { /* déjà fermé */ }
  }, EXPORT_MAX_MS);
  (minuteur as { unref?: () => void }).unref?.();
  const pousser = (c: ReadableStreamDefaultController<Uint8Array>, s: string) => {
    const b = enc.encode(s);
    octets += b.length;
    c.enqueue(b);
  };

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      pousser(c, jsonEntete(entete));
    },
    async pull(c) {
      if (termine) return;
      try {
        const rows = await conn.unsafe(`FETCH ${lot} FROM vb_notif_diag`) as unknown as LigneBrute[];
        if (termine) return;
        if (rows.length === 0) {
          pousser(c, jsonPied({ exporte, attendu, interruption: null, champsNonEnregistres: champs, horodatage: new Date() }));
          await finir(null);
          c.close();
          return;
        }
        let morceau = '';
        for (const r of rows) {
          morceau += jsonLigne(versLigne(r), exporte);
          exporte++;
        }
        pousser(c, morceau);
      } catch (e) {
        const code = (e as { code?: string })?.code;
        console.error('[admin/notifications/diagnostic] lecture :', (e as Error)?.message ?? e);
        await finir(code === '57014' ? 'READ_TIMEOUT' : 'READ_FAILED');
        // Flux mis en erreur : jamais un fichier tronqué présenté comme complet.
        c.error(e instanceof Error ? e : new Error(String(e)));
      }
    },
    async cancel() {
      await finir('CLIENT_ABORTED');
    },
  });
  return { attendu, body };
}
