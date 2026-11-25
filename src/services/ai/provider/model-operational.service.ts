/**
 * État opérationnel connu des modèles — lot 32B, ticket « BO IA : ne proposer
 * que les modèles réellement utilisables par traitement » (§1.H), migration
 * 0273.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LISTÉ N'EST PAS OPÉRATIONNEL
 *
 * `GET /v1beta/models` dit qu'un modèle existe pour la clé ; seule une
 * génération dit qu'il répond. Le 18/09/2026, `gemini-2.5-flash-lite` était
 * listé et refusait toute génération aux comptes récents.
 *
 * Le résultat de la DERNIÈRE génération minimale connue est conservé par
 * modèle, avec l'empreinte (SHA-256 tronqué) de la clé testée — jamais la
 * clé. Il est mis à jour par les mécanismes de test fournisseur existants :
 *   · « Tester la clé » (WF-21, `testProviderKey`) ;
 *   · « Actualiser le catalogue » (E-04), qui sonde les modèles déclarés et
 *     listés (génération minimale, sans donnée utilisateur, coût technique).
 * Il n'est JAMAIS rafraîchi à l'affichage du BO : `usableModelsForTreatment`
 * le lit, sans appel fournisseur.
 *
 * Un résultat obtenu avec une autre clé que la clé active est ignoré : après
 * une rotation, l'état redevient « inconnu » jusqu'au prochain test.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 49 (ticket 11) — UN ÉCHEC DE SONDE N'EST PAS UNE PANNE DE MODÈLE
 *
 *   · sonde fiabilisée : prompt minimal sans donnée utilisateur, niveau de
 *     raisonnement `minimal` EXPLICITE, plafond de sortie 512 (un plafond,
 *     pas une consommation : la réponse attendue tient en un mot), délai
 *     borné à 20 s ; appel tracé TECHNIQUE, non facturable ;
 *   · classification (`probe-classification.ts`) : `inconclusive` (quota,
 *     5xx, délai, réseau, réponse vide, erreur de sonde, erreur globale de
 *     clé / projet, 403 ambigu) ne touche JAMAIS l'état retenu ; seul un
 *     échec attribuable au modèle peut le dégrader ;
 *   · confirmation avant dégradation : un premier échec présumé définitif
 *     rend le modèle SUSPECT (état sain conservé) et déclenche un second
 *     contrôle ; seul un échec répété, ou un message explicitement définitif
 *     (modèle retiré, 404 du modèle), donne `failed_confirmed` (`ok=false`) ;
 *   · diagnostic conservé (message nettoyé, catégorie, date, source,
 *     statut) : le BO l'affiche sans consultation SQL.
 * Aucun remplacement automatique de modèle, jamais.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 114 (carte #771) — UN VERDICT PAR ACCÈS, ÉCRIT UNE FOIS, DANS L'ORDRE
 *
 *   · périmètre : un verdict vaut pour (modèle, ACCÈS = empreinte de la clé,
 *     capacité « génération de texte », generateContent). Le contrôle d'une
 *     autre clé n'efface plus celui de la clé active (migration 1692) ;
 *   · écriture ATOMIQUE et ordonnée (`recordOperationalCheck`) : verrou par
 *     (modèle, accès), état relu sous verrou, transition, écriture de l'état
 *     et de l'historique dans la même transaction. Un contrôle ENVOYÉ avant
 *     le verdict en vigueur est écarté (historisé `applied = false`) : une
 *     réponse lente n'efface jamais un refus plus récent ;
 *   · sources : sonde, qualification, test de clé, et — E04 — refus définitif
 *     d'un APPEL RÉEL (`gateway_call`), classé par la même fonction ;
 *   · propagation : tout changement de verdict incrémente la clé de version
 *     partagée (`verebona_cache_versions`, périmètre `ai-model-operational`) ;
 *     chaque instance relit son cache dès qu'elle la voit changer ;
 *   · recontrôle borné d'un modèle refusé (`next_probe_at`, délai doublé de
 *     1 h à 24 h) : ni retest en boucle, ni exclusion permanente ;
 *   · diagnostic : code HTTP, code fournisseur, catégorie, message nettoyé,
 *     appel technique (`probe_call_id`), accès pseudonymisé — au BO, dans la
 *     trace et l'export (`MODEL_UNAVAILABLE_CONFIRMED`… au lieu d'`UNKNOWN`).
 * Disponibilité, tarif (#770) et aptitude métier restent trois dimensions
 * distinctes et cumulatives : ce module ne lit ni n'écrit aucun tarif.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 115 (carte #786) — LECTURE FIABLE, ORDRE, IDEMPOTENCE, RÉSERVATION
 *
 *   · E01 — une lecture qui ÉCHOUE n'est plus un état vide : `readPublishedVerdict`
 *     et `loadOperationalSnapshot` disent si la lecture est FIABLE. Les
 *     appelants conservent alors leur dernier verdict fiable
 *     (`operational-admission.ts`) : un refus confirmé ne redevient jamais
 *     appelable par une panne de base ou l'expiration d'un cache ;
 *   · E01 — `operationalRefusalInTx` distingue « rien ne s'oppose » de
 *     « contrôle final IMPOSSIBLE » : une promotion ou une activation est
 *     refusée dans le second cas (jamais admise sans contrôle) ;
 *   · E04 — chaque contrôle porte un IDENTIFIANT STABLE (`checkId`) figé à la
 *     source, l'instant d'envoi et le contexte d'accès : le rejouer n'ouvre
 *     aucune ligne, ne change aucun compteur ni échéance. À instant d'envoi
 *     ÉGAL, un succès ne lève pas un refus confirmé ; une horloge de worker
 *     en avance est ramenée à l'heure de la base ;
 *   · E04 / E08 — le dernier RÉSULTAT reçu est conservé à part du dernier
 *     VERDICT retenu (`last_result_*`) : un recontrôle non concluant est
 *     visible sans effacer le refus ;
 *   · E05 — l'accès est celui qui a ENVOYÉ (`accessFingerprint` figé au
 *     départ) : une rotation de clé en vol n'attribue plus le résultat à la
 *     nouvelle clé. Environnement et version d'API sont figés avec lui ;
 *   · E07 — `acquireProbeLease` : réservation ATOMIQUE et partagée d'un
 *     recontrôle par route (bail borné, reprise après crash du détenteur) —
 *     deux instances à échéance ne sondent plus deux fois ;
 *   · E05 (migration 1816) — la CAPACITÉ fait partie de la CLÉ CANONIQUE
 *     (fournisseur, modèle, accès, capacité) : un refus ne vaut que pour la
 *     capacité éprouvée, et seule la capacité de BASE (génération de texte)
 *     étend sa portée à tout l'accès, parce qu'elle en est le prérequis
 *     (`refusalCapabilityScope`, règle documentée et testée). Le PROJET du
 *     fournisseur est une dimension EXPLICITÉE et vide : l'application n'en
 *     connaît aucun, il n'est donc jamais inventé ni fusionné avec l'accès
 *     (`operationalProjectDimension`).
 */
import { pgClient } from '@/db';
import { accessLabel, keyFingerprint } from './access-identity';
import {
  PROBE_CAPABILITY, PROBE_ENDPOINT, PROBE_MAX_OUTPUT_TOKENS, PROBE_PROMPT, PROBE_REASONING, PROBE_TIMEOUT_MS,
  GLOBAL_PROBE_KINDS, PROBE_ERROR_KIND_LABELS, classifyProbeFailure, classifyProbeResponse, nextOperationalState, nextProbeDelayMs, probeErrorCodeOf, providerCodesOf,
  reinterpretLegacyState, sanitizeProviderError,
  BASE_CAPABILITY, OPERATIONAL_CAPABILITY_LABELS, isOperationalCapability, refusalCapabilityScope,
  type CheckStatus, type KnownOperationalState, type NextOperationalState, type OperationalCapability, type ProbeErrorKind, type ProbeOutcome,
} from './probe-classification';
import { unknownVerdict, type PublishedVerdict } from './operational-admission';

type Row = Record<string, unknown>;

/**
 * Source d'un contrôle (affichée au BO). Lot 114 (#771) : `gateway_call` — refus définitif reçu par un appel
 * réel (E04) ; `recovery_check` — recontrôle borné d'un modèle sauté par la passerelle.
 */
export type OperationalSource = 'provider_test' | 'catalog_refresh' | 'qualification' | 'gateway_call' | 'recovery_check';

/** Périmètre de la clé de version partagée (`verebona_cache_versions`, 0209) — #771, P03. */
export const OPERATIONAL_CACHE_SCOPE = 'ai-model-operational';

/** État RETENU d'un modèle (lu par `usableModelsForTreatment`). */
interface OperationalStatus {
  ok: boolean;
  checkedAt: string;
  error: string | null;
  source: string;
  /** #771 : prochain recontrôle au plus tôt d'un modèle confirmé indisponible (absent avant la migration 1692). */
  nextProbeAt?: string | null;
}

/** Diagnostic complet du dernier contrôle (BO, sans consultation SQL). */
export interface OperationalDiagnostic {
  model: string;
  /** État retenu : `true` sain, `false` indisponible confirmé, `null` inconnu. */
  ok: boolean | null;
  /** Issue du dernier contrôle. */
  checkStatus: CheckStatus;
  /** Message fournisseur NETTOYÉ (jamais de secret). */
  error: string | null;
  errorKind: ProbeErrorKind | null;
  checkedAt: string;
  source: string;
  lastOkAt: string | null;
  suspectSince: string | null;
  // ── Lot 114 (#771, S06 / S07 / B01) — absents avant la migration 1692 ──
  /** Code HTTP et code fournisseur (`NOT_FOUND`…) du dernier contrôle en échec. */
  httpStatus?: number | null;
  providerCode?: string | null;
  /** Accès concerné, PSEUDONYMISÉ (début de l'empreinte de la clé — jamais la clé). */
  access?: string | null;
  /** Capacité et point d'accès éprouvés. */
  capability?: string | null;
  endpoint?: string | null;
  /** Appel technique tracé qui fonde le verdict. */
  probeCallId?: number | null;
  /** Indisponibilité confirmée depuis ; prochain recontrôle au plus tôt. */
  confirmedAt?: string | null;
  nextProbeAt?: string | null;
  // ── Lot 115 (#786, E05) — portée exacte du verdict (absents avant la migration 1816) ──
  /** Capacités réellement REFUSÉES pour cet accès (vide : aucune). */
  refusedCapabilities?: OperationalCapability[];
  /** Projet du fournisseur tel que l'application le connaît : toujours `null` aujourd'hui, jamais deviné. */
  providerProject?: string | null;
}

/** #786 (E05) : version d'API du point d'accès sondé, figée avec le contrôle. */
export const PROBE_API_VERSION = 'v1beta' as const;

/** Environnement de l'accès (jamais inventé : `null` si le référentiel ne le dit pas). */
async function environnementCourant(): Promise<string | null> {
  try {
    return (await import('../config/environment')).getAiEnvironment();
  } catch {
    return null;
  }
}

/**
 * Empreinte non réversible d'une clé, et accès pseudonymisé affiché.
 *
 * #786 (A01) : DÉFINIS dans `access-identity` — module PUR, sans aucune
 * dépendance (ni base de données, ni classification), pour que l'identité de
 * route et le test de clé puissent figer l'empreinte de l'accès avant l'envoi
 * sans charger la persistance, et qu'aucun harnais de test simulant la
 * persistance ou le résolveur de clé ne puisse en priver le code. Réexportés
 * ici : tous les appelants historiques continuent de les lire au même endroit,
 * et il n'existe qu'UNE définition dans le dépôt.
 */
export { keyFingerprint, accessLabel };

/**
 * #786 (E05) — empreinte de l'accès ACTIF, à figer AVANT un envoi : le
 * résultat sera attribué à l'accès qui a envoyé, jamais à la clé qui serait
 * active à la réception (rotation en vol). `null` : aucune clé active, ou
 * clé illisible. Ne lève jamais ; la clé elle-même n'est jamais rendue.
 */
export async function activeAccessFingerprint(): Promise<string | null> {
  try {
    const secret = await (await import('./provider-secret')).getProviderSecret('gemini');
    return secret ? keyFingerprint(secret) : null;
  } catch {
    return null;
  }
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(String(v)).toISOString());

function toKnown(r: Row): KnownOperationalState {
  const checkStatus = r.check_status == null ? null : (String(r.check_status) as CheckStatus);
  const okBrut = r.ok == null ? null : Boolean(r.ok);
  return {
    ok: reinterpretLegacyState({ ok: okBrut, checkStatus, error: r.error == null ? null : String(r.error) }),
    checkStatus,
    suspectSince: iso(r.suspect_since),
  };
}

async function readKnown(model: string, fingerprint: string): Promise<KnownOperationalState | null> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT ok, check_status, error, suspect_since FROM ai_model_operational_status
        WHERE provider = 'gemini' AND model = $1 AND key_fingerprint = $2`,
      [model, fingerprint] as never[],
    )) as unknown as Row[];
    return rows[0] ? toKnown(rows[0]) : null;
  } catch {
    return null;
  }
}

type SqlRunner = { unsafe: (query: string, params?: never[]) => Promise<unknown> };

/** État rendu par `recordOperationalCheck` (#771). */
export interface RecordedOperationalState extends NextOperationalState {
  /** Contrôle ÉCARTÉ : envoyé avant le verdict en vigueur (état inchangé). */
  stale?: boolean;
  /** Le modèle devient, ou cesse d'être, confirmé indisponible : caches invalidés dans toutes les instances. */
  changed?: boolean;
  /** Prochain recontrôle au plus tôt d'un modèle confirmé indisponible. */
  nextProbeAt?: string | null;
  /**
   * #786 (A03) — RÉSULTAT CALCULÉ ≠ VERDICT PUBLIÉ. La distinction est
   * explicite et opposable :
   *   · `published`     — la transaction a été COMMITTÉE : cet état est le
   *                       verdict publié, opposable, et les autres instances
   *                       le verront par la clé de version partagée ;
   *   · `not_persisted` — l'écriture ou le commit a ÉCHOUÉ (base
   *                       indisponible, table ou colonne absente, délai SQL,
   *                       crash). L'état rendu n'est qu'un CALCUL local :
   *                       aucun verdict n'est annoncé publié, et aucun
   *                       appelant ne doit en tirer une décision de promotion,
   *                       d'activation ou d'import.
   * Règle remplacée (carte #786, A03) : un échec d'écriture journalisait puis
   * rendait un état indiscernable d'un verdict publié.
   */
  persistence: 'published' | 'not_persisted';
  /** #786 (A03) : motif, quand rien n'a été publié (journal, BO ; jamais de secret). */
  notPersistedReason?: string | null;
  /**
   * #786 (C02) — transition `failed_confirmed → ok` RÉELLEMENT PERSISTÉE :
   * c'est elle, et elle seule, qui oblige à requalifier, quelle que soit la
   * source du contrôle.
   */
  recovered?: boolean;
}

/**
 * #786 (A03) — l'état rendu est-il un VERDICT PUBLIÉ sur lequel une décision
 * (promotion, activation, import, affichage opposable au BO) peut se fonder ?
 * Un état seulement calculé ne décide de rien.
 */
export function isPublishedVerdict(state: Pick<RecordedOperationalState, 'persistence'>): boolean {
  return state.persistence === 'published';
}

/**
 * #786 (B02) — TOLÉRANCE d'écart entre l'horloge d'un worker et celle de la
 * base. Au-delà, l'instant d'envoi du contrôle est RECALÉ sur l'horloge de la
 * base, DANS LES DEUX SENS (avance comme retard), par la mesure de l'écart au
 * moment de l'enregistrement.
 *
 * Soixante secondes : au-dessous, l'écart est du même ordre que la latence
 * d'un appel et le recalage apporterait plus de bruit que d'ordre ; au-dessus,
 * c'est une horloge réellement désynchronisée. Valeur à valider par le PO.
 *
 * Le recalage DÉPLACE l'instant d'envoi de l'écart mesuré — il ne l'écrase pas
 * par « maintenant » : un succès réellement ancien reste ancien, et ne peut
 * donc pas lever un refus plus récent (c'était le risque de B02).
 */
export const CLOCK_SKEW_TOLERANCE_MS = 60_000;

/**
 * #786 (B02) — FENÊTRE D'ÉGALITÉ de l'ordre : deux instants d'envoi plus
 * proches que cela ne sont PAS ordonnables, et l'arbitrage déterministe des
 * « instants égaux » s'applique.
 *
 * Pourquoi une fenêtre, et pas une égalité stricte à la milliseconde : le
 * recalage sur l'horloge de la base repose sur un écart MESURÉ au moment de
 * l'enregistrement. Deux résultats réellement partis au même instant, mais
 * enregistrés à quelques millisecondes d'intervalle, sont donc projetés sur
 * des instants très légèrement différents. Avec une égalité stricte, le second
 * serait déclaré « hors ordre » — l'ordre resterait suspendu à la précision
 * des horloges, ce que la carte demande précisément d'éliminer.
 *
 * Une seconde : très au-dessus du bruit de mesure, très au-dessous du délai
 * réel entre deux contrôles d'une même route (la confirmation attend 2 s, le
 * recontrôle au moins une heure). Valeur à valider par le PO.
 */
export const ORDER_EQUALITY_WINDOW_MS = 1_000;

/**
 * #786 (B03) — sources de contrôle qui sont des SONDES réservées : leur
 * résultat doit porter le jeton de clôture (`leaseGeneration`) du bail sous
 * lequel la sonde est partie.
 */
const PROBE_SOURCES: ReadonlySet<OperationalSource> = new Set<OperationalSource>(['catalog_refresh', 'recovery_check']);

/** Schéma antérieur à la migration 1692 (colonne, contrainte ou table absente). */
function schemaAnterieur(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === '42703' || code === '42P10' || code === '42P01';
}

// ── #786 : état du schéma (migration critique absente = signal, pas de repli silencieux) ──

/** Colonnes de la migration 1815 présentes ? `null` : pas encore constaté. */
let colonnes1815: boolean | null = null;
/** Une écriture a-t-elle dû retomber sur un schéma antérieur dans ce processus ? */
let schemaDegradeMotif: string | null = null;

/**
 * #786 (E01) — le schéma de l'état opérationnel est-il COMPLET ? Une migration
 * critique absente est SIGNALÉE (journal, BO) et rend l'admission prudente :
 * jamais un repli silencieux vers un schéma qui perdrait l'isolation par
 * accès, l'ordre des contrôles ou l'historique.
 */
export function operationalSchemaState(): { complete: boolean | null; degradedReason: string | null } {
  return { complete: colonnes1815, degradedReason: schemaDegradeMotif };
}

/** Réservé aux tests : oublie l'état constaté du schéma. */
export function __resetOperationalSchemaState(): void {
  colonnes1815 = null;
  colonnes1816 = null;
  colonnes1950 = null;
  schemaDegradeMotif = null;
}

/** #786 (E05) : la capacité fait-elle partie de la clé (migration 1816) ? `null` : pas encore constaté. */
let colonnes1816: boolean | null = null;

/**
 * #786 (E05) — la CAPACITÉ est-elle une composante de la clé canonique
 * (migration 1816) ? Tant qu'elle ne l'est pas, seule la capacité de BASE a un
 * verdict retenu : un contrôle portant sur une autre capacité est HISTORISÉ
 * sans toucher l'état retenu, plutôt que d'écraser le verdict de la base — un
 * schéma incomplet ne fabrique aucune portée.
 */
async function has1816(): Promise<boolean> {
  if (colonnes1816 !== null) return colonnes1816;
  try {
    const rows = (await pgClient.unsafe(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ai_model_operational_status' AND column_name = 'provider_project' LIMIT 1`,
    )) as unknown as Row[];
    colonnes1816 = rows.length > 0;
    if (!colonnes1816) {
      schemaDegradeMotif = schemaDegradeMotif
        ?? 'migration 1816 non appliquée : verdict par capacité et dimension « projet » indisponibles';
      console.warn(`[model-operational] ${schemaDegradeMotif}.`);
    }
  } catch {
    colonnes1816 = false;
  }
  return colonnes1816;
}

/**
 * #786 (E05) — DIMENSION « PROJET DU FOURNISSEUR » : explicitée, jamais
 * inventée. L'application n'en connaît aucun identifiant — une clé Gemini ne
 * le restitue pas, et aucun référentiel ne le porte — donc la colonne
 * `provider_project` reste VIDE : « non renseignée », jamais fusionnée avec
 * l'empreinte de la clé. `missing` dit ce qu'il faudrait pour que la dimension
 * existe réellement (textes à valider par le PO).
 */
export function operationalProjectDimension(): { known: false; label: string; missing: readonly string[] } {
  return {
    known: false,
    label: 'projet du fournisseur : non connu de l’application (dimension conservée vide, jamais devinée)',
    missing: [
      'un identifiant de projet DÉCLARÉ à côté de la clé dans BO › Fournisseur (saisi par un administrateur, '
      + 'conservé pseudonymisé comme l’empreinte de clé), ou une variable d’environnement dédiée posée par l’exploitant',
      'à défaut, un point d’accès du fournisseur qui restitue le projet de la clé : aucun de ceux utilisés aujourd’hui '
      + '(catalogue des modèles, génération) ne le fait',
      'et, dans les deux cas, une reprise prudente des lignes existantes : elles resteraient « projet non renseigné » '
      + 'plutôt que d’être rattachées au projet constaté plus tard (aucune portée fabriquée)',
    ],
  };
}

/** #786 (B03) : la génération de bail fait-elle partie du schéma (migration 1950) ? `null` : pas encore constaté. */
let colonnes1950: boolean | null = null;

/**
 * #786 (B03) — la RÉSERVATION DE SONDE porte-t-elle un jeton de clôture
 * (`probe_lease_generation`, migration 1950) ? Tant qu'elle ne l'est pas, le
 * fencing n'est pas opposable : c'est signalé, et la réservation reste celle
 * du lot 115I (bail borné sans jeton).
 */
async function has1950(): Promise<boolean> {
  if (colonnes1950 !== null) return colonnes1950;
  try {
    const rows = (await pgClient.unsafe(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ai_model_operational_status' AND column_name = 'probe_lease_generation' LIMIT 1`,
    )) as unknown as Row[];
    colonnes1950 = rows.length > 0;
    if (!colonnes1950) {
      schemaDegradeMotif = schemaDegradeMotif
        ?? 'migration 1950 non appliquée : jeton de clôture du bail de sonde (fencing) indisponible';
      console.warn(`[model-operational] ${schemaDegradeMotif}.`);
    }
  } catch {
    colonnes1950 = false;
  }
  return colonnes1950;
}

/** Les colonnes 1815 existent-elles ? (une lecture par processus ; prudent en cas d'échec) */
async function has1815(): Promise<boolean> {
  if (colonnes1815 !== null) return colonnes1815;
  try {
    const rows = (await pgClient.unsafe(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ai_model_operational_status' AND column_name = 'check_id' LIMIT 1`,
    )) as unknown as Row[];
    colonnes1815 = rows.length > 0;
    if (!colonnes1815) {
      schemaDegradeMotif = 'migration 1815 non appliquée : identifiant de contrôle, contexte d’accès et dernier résultat non conservés';
      console.warn(`[model-operational] ${schemaDegradeMotif}.`);
    }
  } catch {
    colonnes1815 = false;
  }
  return colonnes1815;
}

/** Incrémente la clé de version partagée dans la transaction du verdict. */
async function bumpOperationalVersion(sql: SqlRunner, reason: string): Promise<void> {
  await sql.unsafe(
    `INSERT INTO verebona_cache_versions (scope, version, last_reason, updated_at)
     VALUES ($1, 1, $2, now())
     ON CONFLICT (scope) DO UPDATE SET version = verebona_cache_versions.version + 1,
       last_reason = EXCLUDED.last_reason, updated_at = now()`,
    [OPERATIONAL_CACHE_SCOPE, reason.slice(0, 60)] as never[],
  );
}

/** Version partagée de l'état opérationnel ; `null` si illisible. Ne lève jamais. */
export async function readOperationalVersion(): Promise<number | null> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT version FROM verebona_cache_versions WHERE scope = $1`, [OPERATIONAL_CACHE_SCOPE] as never[],
    )) as unknown as Array<{ version: string | number }>;
    return rows[0] ? Number(rows[0].version) : 0;
  } catch { return null; }
}

/**
 * #786 (A03) — L'ÉCRITURE AU FORMAT ANTÉRIEUR À 1692 EST SUPPRIMÉE.
 *
 * `ecrireFormatAnterieur` écrivait, en repli d'une erreur de schéma, une ligne
 * par `(provider, model)` : la clé n'y portait PAS l'accès. Le verdict d'une
 * clé écrasait donc celui d'une autre, l'ordre des contrôles et l'historique
 * étaient perdus, et l'état ainsi écrit était rendu comme s'il était publié.
 *
 * Désormais : aucun repli silencieux. Une migration critique absente est
 * SIGNALÉE (`operationalSchemaState`), l'état est rendu `not_persisted`, et
 * l'admission comme l'activation sont refusées faute de contrôle possible —
 * la candidate et les preuves sont conservées.
 */

/**
 * Enregistre l'issue d'un contrôle (best effort : ne lève jamais) et rend le
 * nouvel état.
 *
 * Lot 114 (#771, P02) : UNE transaction — verrou par (modèle, accès), état
 * relu sous verrou, transition (`nextOperationalState`), écriture de l'état,
 * de l'historique et de la clé de version si l'état retenu change.
 *   · `observedAt` : instant d'ENVOI du contrôle (défaut : maintenant). Un
 *     contrôle envoyé avant celui qui fonde l'état en vigueur est écarté ;
 *   · `prev` : n'est plus utilisé que si l'état ne peut pas être relu (schéma
 *     absent) — l'état relu sous verrou fait foi ;
 *   · rejouer le même contrôle (même `observedAt`, même issue) ne change rien
 *     à l'état retenu.
 */
export async function recordOperationalCheck(p: {
  model: string; secret: string; outcome: ProbeOutcome; source: OperationalSource;
  prev?: KnownOperationalState | null; now?: Date;
  /** #771 : instant d'envoi du contrôle, appel technique tracé, codes du fournisseur. */
  observedAt?: Date; probeCallId?: number | null; httpStatus?: number | null; providerCode?: string | null;
  /**
   * #786 (E04, B02) : identifiant STABLE du contrôle, figé à la source AVANT
   * l'envoi, et OBLIGATOIRE. Rejouer le même identifiant ne change rien (ni
   * état, ni compteur `failure_count`, ni `next_probe_at`, ni `state_version`,
   * ni ligne d'historique, ni alerte) : un même échec reçu deux fois n'est pas
   * deux sondes, et une reprise après échec de commit n'en fabrique pas une.
   *
   * Règle remplacée (carte #786, B02) : il était facultatif, et les appelants
   * qui l'omettaient n'étaient donc pas idempotents.
   */
  checkId: string;
  /**
   * #786 (B03) : JETON DE CLÔTURE (fencing) du bail sous lequel la sonde est
   * partie, tel que `acquireProbeLease` l'a rendu. Exigé des sources de sonde
   * quand un bail est en cours : un résultat produit par un détenteur dont le
   * bail a été repris par un autre worker est REJETÉ et historisé comme écarté.
   */
  leaseGeneration?: number | null;
  /**
   * #786 (E05) : empreinte de l'accès qui a ENVOYÉ le contrôle, figée au
   * départ. Une rotation de clé en vol n'attribue plus le résultat à la
   * nouvelle clé. Par défaut : l'empreinte du secret transmis.
   */
  accessFingerprint?: string | null;
  /**
   * #786 (E05) : CAPACITÉ (et modalité) réellement éprouvée par l'envoi. La
   * portée du verdict en est déduite par la règle documentée unique
   * (`refusalCapabilityScope`) : un refus de portée MODÈLE est retenu sur la
   * capacité de base et vaut pour tout l'accès ; tout autre refus ne vaut que
   * pour cette capacité. Par défaut : la capacité de base.
   */
  capability?: OperationalCapability;
}): Promise<RecordedOperationalState> {
  const fp = p.accessFingerprint ?? keyFingerprint(p.secret);
  const now = p.now ?? new Date();
  const checkId = p.checkId;
  const environment = await environnementCourant();
  const observedAt = p.observedAt ?? now;
  const brut = p.outcome.status === 'ok' ? null : p.outcome.error;
  const lus = brut ? providerCodesOf(brut) : { httpStatus: null, providerCode: null };
  const httpStatus = p.httpStatus ?? lus.httpStatus;
  const providerCode = p.providerCode ?? lus.providerCode;
  const definitive = p.outcome.status === 'failed' ? p.outcome.definitive : null;
  const kind = p.outcome.status === 'ok' ? null : p.outcome.kind;

  // Colonnes 1815 / 1816 / 1950 présentes ? (lu hors transaction : une requête échouée l'avorterait)
  const etendu = await has1815();
  const parCapacite = await has1816();
  const bail = await has1950();
  // #786 (E05) : portée du verdict — capacité éprouvée, ou capacité de BASE pour un refus de portée modèle.
  const { capability } = refusalCapabilityScope(p.outcome, p.capability ?? BASE_CAPABILITY);
  /**
   * Capacité réellement portée par la LIGNE d'état. Sans la migration 1816, la clé n'a pas de capacité : un
   * contrôle d'une autre capacité que la base est alors seulement HISTORISÉ (aucun écrasement du verdict de
   * base, aucune portée fabriquée).
   */
  const capaciteEtat: OperationalCapability | null = parCapacite ? capability : capability === BASE_CAPABILITY ? BASE_CAPABILITY : null;

  const transaction = async (sql: SqlRunner): Promise<RecordedOperationalState> => {
    await sql.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ai-model-operational:${p.model}:${fp}:${capability}`] as never[]);
    const row = capaciteEtat === null ? undefined : ((await sql.unsafe(
      `SELECT ok, check_status, error, suspect_since, error_kind, observed_at, failure_count, state_version, next_probe_at${
  bail ? ', probe_lease_generation, probe_lease_until' : ''}
         FROM ai_model_operational_status
        WHERE provider = 'gemini' AND model = $1 AND key_fingerprint = $2${parCapacite ? ' AND capability = $3' : ''}`,
      (parCapacite ? [p.model, fp, capaciteEtat] : [p.model, fp]) as never[],
    )) as unknown as Row[])[0];
    const prev = row ? toKnown(row) : p.prev ?? null;
    const version = Number(row?.state_version ?? 0);
    /** Instant d'ENVOI retenu, recalé sur l'horloge de la base dans les deux sens (#786, B02). */
    let envoye = observedAt;
    const historise = async (
      etat: { checkStatus: CheckStatus | null; ok: boolean | null }, applied: boolean, v: number, discardedReason: string | null = null,
    ) => {
      // Colonnes fixes, puis celles de 1815, puis le jeton de bail de 1950 (#786, B03) : l'historique dit
      // SOUS QUEL BAIL le contrôle est parti, donc pourquoi un résultat tardif a été écarté.
      const colonnes = ['provider', 'model', 'key_fingerprint', 'capability', 'endpoint', 'source', 'outcome', 'definitive',
        'error_kind', 'http_status', 'provider_code', 'error', 'check_status', 'ok_after', 'applied', 'state_version',
        'probe_call_id', 'observed_at'];
      const valeurs: unknown[] = [p.model, fp, capability, PROBE_ENDPOINT, p.source, p.outcome.status, definitive, kind,
        httpStatus, providerCode, brut ? sanitizeProviderError(brut, p.secret) : null, etat.checkStatus, etat.ok, applied, v,
        p.probeCallId ?? null, envoye.toISOString()];
      if (etendu) {
        colonnes.push('check_id', 'environment', 'api_version', 'discarded_reason');
        valeurs.push(checkId, environment, PROBE_API_VERSION, discardedReason);
      }
      if (bail) {
        colonnes.push('probe_lease_generation');
        valeurs.push(p.leaseGeneration ?? null);
      }
      // `provider` est la première colonne, et sa valeur est littérale : les paramètres commencent donc à $1
      // pour la deuxième colonne.
      const placeholders = ["'gemini'", ...valeurs.map((_, i) => `$${i + 1}`)];
      await sql.unsafe(
        `INSERT INTO ai_model_operational_history (${colonnes.join(', ')}) VALUES (${placeholders.join(', ')})`,
        valeurs as never[],
      );
    };
    /**
     * État rendu sans rien changer (contrôle écarté ou déjà enregistré). La transaction est bien COMMITTÉE :
     * le verdict en vigueur est donc le verdict publié — simplement, ce contrôle ne l'a pas modifié.
     */
    const inchange = (stale: boolean): RecordedOperationalState => ({
      ...(prev as KnownOperationalState), error: row?.error == null ? null : String(row.error),
      errorKind: (row?.error_kind == null ? null : String(row.error_kind)) as ProbeErrorKind | null,
      healthy: false, ...(stale ? { stale: true } : {}), changed: false, nextProbeAt: iso(row?.next_probe_at),
      persistence: 'published',
    });
    /** État en vigueur rendu tel quel, avec le motif d'écart du contrôle reçu. */
    const conserve = (stale: boolean): RecordedOperationalState => ({
      ...(prev as KnownOperationalState), error: row?.error == null ? null : String(row.error),
      errorKind: (row?.error_kind == null ? null : String(row.error_kind)) as ProbeErrorKind | null,
      healthy: false, ...(stale ? { stale: true } : {}), changed: false, nextProbeAt: iso(row?.next_probe_at),
      persistence: 'published',
    });

    // #786 (E05) : capacité hors base alors que la clé n'en porte pas (migration 1816 absente) — le contrôle est
    // HISTORISÉ avec sa capacité, et le verdict de la capacité de base n'est NI écrasé, NI étendu. Signalé.
    if (capaciteEtat === null) {
      await historise({ checkStatus: null, ok: null }, false, version, 'capability_scope_unsupported');
      return {
        ok: prev?.ok ?? null, checkStatus: prev?.checkStatus ?? null, suspectSince: prev?.suspectSince ?? null,
        error: null, errorKind: null, healthy: false, changed: false, stale: true, nextProbeAt: null,
        persistence: 'published',
      };
    }

    // #786 (E04, B02) : REJEU — ce contrôle (identifiant stable) est déjà enregistré pour cette route et cet
    // accès. Rien n'est réécrit : ni état, ni compteur `failure_count`, ni `next_probe_at`, ni `state_version`,
    // ni seconde ligne d'historique, ni alerte. C'est ce qui rend la reprise après échec de commit sûre.
    if (etendu) {
      const deja = (await sql.unsafe(
        `SELECT 1 FROM ai_model_operational_history
          WHERE provider = 'gemini' AND model = $1 AND key_fingerprint = $2 AND check_id = $3 LIMIT 1`,
        [p.model, fp, checkId] as never[],
      ).catch(() => [])) as unknown as Row[];
      if (deja.length > 0) return inchange(false);
    }

    /**
     * #786 (B02) — ORDRE INDÉPENDANT DES HORLOGES DE WORKERS.
     *
     * L'écart entre l'horloge de ce worker et celle de la base est MESURÉ ici
     * (`now` est l'heure du worker au moment de l'enregistrement). Au-delà de la
     * tolérance, l'instant d'envoi est DÉPLACÉ de cet écart — dans les deux sens.
     *
     * Règle remplacée (carte #786, B02) : seule une AVANCE de plus de 60 s était
     * corrigée, et en écrasant l'instant d'envoi par « maintenant ». Un worker en
     * RETARD faisait donc paraître un résultat récent plus ancien qu'il n'était
     * (écarté à tort), et l'écrasement pouvait rendre un vieux succès « récent ».
     * Le déplacement, lui, conserve l'ÂGE réel du résultat : un succès ancien
     * reste ancien et ne peut pas lever un refus plus récent.
     */
    const basesNow = ((await sql.unsafe(`SELECT now() AS t`).catch(() => [])) as unknown as Row[])[0]?.t;
    if (basesNow) {
      const baseMs = new Date(String(basesNow)).getTime();
      const ecartMs = now.getTime() - baseMs;
      if (Math.abs(ecartMs) > CLOCK_SKEW_TOLERANCE_MS) {
        envoye = new Date(observedAt.getTime() - ecartMs);
        console.info(`[model-operational] ${p.model} : instant d'envoi recalé de ${Math.round(-ecartMs / 1000)} s sur l'horloge de la base (écart mesuré du worker).`);
      }
      // BORNE DURE : un envoi ne peut pas être dans le futur de la base au-delà de la tolérance — il serait
      // alors daté par une horloge que le recalage n'a pas suffi à corriger. Il est ramené à l'heure de la
      // base, jamais extrapolé. En DEÇA de la tolérance, l'horloge du worker est acceptée telle quelle :
      // la ramener ferait croire à une égalité d'instants là où il n'y en a pas.
      if (envoye.getTime() > baseMs + CLOCK_SKEW_TOLERANCE_MS) envoye = new Date(baseMs);
    }

    /**
     * #786 (B03) — FENCING : le bail de sonde a-t-il été repris par un autre worker ?
     *
     * `probe_lease_generation` est incrémentée à chaque réservation. Un résultat
     * dont le jeton est INFÉRIEUR à la génération en cours vient d'un détenteur
     * dépassé : il est REJETÉ et historisé (`lease_fenced`), sans rien changer.
     *
     * Une source de sonde qui ne présente AUCUN jeton alors qu'un bail est en
     * cours est rejetée de la même façon (`lease_missing`) : son résultat n'est
     * pas celui du détenteur. Hors bail en cours, une sonde non réservée (test
     * unitaire, appel injecté) reste enregistrée — rien à clôturer.
     */
    if (bail && row) {
      const generation = Number(row.probe_lease_generation ?? 0);
      const bailActif = row.probe_lease_until != null && Date.parse(String(row.probe_lease_until)) > Date.now();
      const jeton = p.leaseGeneration ?? null;
      if (jeton !== null && generation > jeton) {
        await historise({ checkStatus: prev?.checkStatus ?? null, ok: prev?.ok ?? null }, false, version, 'lease_fenced');
        console.info(`[model-operational] ${p.model} (${accessLabel(fp)}) : résultat rejeté — bail de sonde repris (jeton ${jeton} < génération ${generation}).`);
        return conserve(true);
      }
      if (jeton === null && bailActif && PROBE_SOURCES.has(p.source)) {
        await historise({ checkStatus: prev?.checkStatus ?? null, ok: prev?.ok ?? null }, false, version, 'lease_missing');
        console.info(`[model-operational] ${p.model} (${accessLabel(fp)}) : résultat de sonde rejeté — aucun jeton de bail alors qu'une réservation est en cours.`);
        return conserve(true);
      }
    }

    // Hors ordre : ce contrôle a été ENVOYÉ STRICTEMENT avant celui qui fonde l'état en vigueur (au-delà de la
    // fenêtre d'égalité) — écarté, état inchangé.
    const enVigueur = row?.observed_at == null ? null : new Date(String(row.observed_at));
    const ecartMsOrdre = enVigueur === null ? null : envoye.getTime() - enVigueur.getTime();
    if (row && prev && ecartMsOrdre !== null && ecartMsOrdre < -ORDER_EQUALITY_WINDOW_MS) {
      await historise({ checkStatus: prev.checkStatus, ok: prev.ok }, false, version, 'out_of_order');
      return conserve(true);
    }

    /**
     * #786 (B02) — INSTANT D'ENVOI ÉGAL à celui du verdict en vigueur, à la fenêtre d'égalité près
     * (`ORDER_EQUALITY_WINDOW_MS`).
     *
     * L'ordre n'est pas tranchable par les dates : il faut un arbitrage qui ne dépende PAS de l'ordre
     * d'arrivée des workers. Celui retenu porte sur les VERDICTS, et il est monotone :
     *
     *   un résultat n'est appliqué, à instant égal, que s'il ne REND PAS la route plus disponible
     *   qu'elle ne l'est déjà.
     *
     * Soit le rang de prudence : refusé (2) > inconnu (1) > sain (0). Le résultat s'applique si
     * `rang(nouveau) >= rang(en vigueur)`, et il est sinon historisé comme écarté (`equal_instant`).
     *
     * Conséquences, toutes voulues :
     *   · un refus confirmé n'est JAMAIS levé par un résultat qui ne lui est pas STRICTEMENT postérieur —
     *     succès, suspicion ou non concluant à instant égal le laissent intact ;
     *   · un non concluant reçu à instant égal sur une route refusée s'applique quand même (rang égal) :
     *     c'est ce qui tient à jour le DERNIER RÉSULTAT reçu, à part du verdict retenu ;
     *   · une DÉGRADATION à instant égal s'applique (prudence) ;
     *   · quel que soit l'ordre dans lequel deux workers commitent, le VERDICT final est le même.
     *
     * Règle complétée (carte #786, B02) : seul le cas `status === 'ok'` après un refus était écarté. Pour
     * tous les autres, l'issue dépendait de l'ordre d'arrivée — ce n'était pas un arbitrage, c'était une
     * course.
     */
    const rangDePrudence = (ok: boolean | null): number => (ok === false ? 2 : ok === null ? 1 : 0);
    if (row && prev && ecartMsOrdre !== null && Math.abs(ecartMsOrdre) <= ORDER_EQUALITY_WINDOW_MS) {
      const futur = nextOperationalState(prev, p.outcome, now);
      if (rangDePrudence(futur.ok) < rangDePrudence(prev.ok)) {
        await historise({ checkStatus: prev.checkStatus, ok: prev.ok }, false, version, 'equal_instant');
        return conserve(true);
      }
    }

    // Réception idempotente (E06) : les appels réels encore en vol au moment du verdict rapportent le même
    // refus — il est déjà opposable, rien n'est réécrit (ni échéance de recontrôle repoussée).
    // #786 (E04) : le REJEU d'un contrôle d'une autre source est écarté par son identifiant stable (ci-dessus) —
    // un recontrôle NOUVEAU qui échoue de nouveau garde, lui, son effet (échéance doublée, A06).
    if (row && prev && prev.ok === false && p.source === 'gateway_call' && p.outcome.status === 'failed') {
      await historise({ checkStatus: prev.checkStatus, ok: prev.ok }, false, version, 'already_opposable');
      return conserve(false);
    }

    const next = nextOperationalState(prev, p.outcome, now);
    const error = next.error ? sanitizeProviderError(next.error, p.secret) : null;
    // Changement OPPOSABLE : le modèle devient, ou cesse d'être, confirmé indisponible (inconnu → sain n'exclut rien).
    const changed = (prev?.ok === false) !== (next.ok === false);
    // Recontrôle borné : chaque échec confirmé consécutif double le délai (1 h → 24 h).
    const failureCount = next.checkStatus === 'failed_confirmed' ? Number(row?.failure_count ?? 0) + 1
      : next.checkStatus === 'ok' ? 0 : Number(row?.failure_count ?? 0);
    // Non concluant sur un modèle déjà refusé : l'échéance en vigueur est conservée (pas de retest immédiat).
    const nextProbeAt = next.checkStatus === 'failed_confirmed' ? new Date(now.getTime() + nextProbeDelayMs(failureCount)).toISOString()
      : next.ok === false ? iso(row?.next_probe_at) : null;
    await sql.unsafe(
      `INSERT INTO ai_model_operational_status
         (provider, model, key_fingerprint, ok, error, source, checked_at, check_status, error_kind, suspect_since, last_ok_at,
          http_status, provider_code, capability, endpoint, probe_call_id, observed_at, confirmed_at, failure_count, next_probe_at, state_version${
  etendu ? ',\n          check_id, environment, api_version, last_result_status, last_result_kind, last_result_at' : ''})
       VALUES ('gemini', $1, $2, $3, $4, $5, NOW(), $6, $7, $8, CASE WHEN $9::boolean THEN NOW() ELSE NULL END,
               $10, $11, $12, $13, $14, $15, CASE WHEN $16::boolean THEN NOW() ELSE NULL END, $17, $18, $19${
  etendu ? ',\n               $20, $21, $22, $23, $24, NOW()' : ''})
       ON CONFLICT (provider, model, key_fingerprint${parCapacite ? ', capability' : ''}) DO UPDATE SET${etendu ? `
         check_id = EXCLUDED.check_id, environment = EXCLUDED.environment, api_version = EXCLUDED.api_version,
         last_result_status = EXCLUDED.last_result_status, last_result_kind = EXCLUDED.last_result_kind,
         last_result_at = EXCLUDED.last_result_at,` : ''}
         ok = EXCLUDED.ok, error = EXCLUDED.error, source = EXCLUDED.source, checked_at = NOW(),
         check_status = EXCLUDED.check_status, error_kind = EXCLUDED.error_kind, suspect_since = EXCLUDED.suspect_since,
         last_ok_at = CASE WHEN $9::boolean THEN NOW() ELSE ai_model_operational_status.last_ok_at END,
         http_status = EXCLUDED.http_status, provider_code = EXCLUDED.provider_code, capability = EXCLUDED.capability,
         endpoint = EXCLUDED.endpoint, probe_call_id = EXCLUDED.probe_call_id, observed_at = EXCLUDED.observed_at,
         confirmed_at = CASE WHEN NOT $16::boolean THEN NULL
                             ELSE COALESCE(ai_model_operational_status.confirmed_at, NOW()) END,
         failure_count = EXCLUDED.failure_count, next_probe_at = EXCLUDED.next_probe_at, state_version = EXCLUDED.state_version`,
      [p.model, fp, next.ok, error, p.source, next.checkStatus, next.errorKind, next.suspectSince, next.healthy,
       httpStatus, providerCode, capaciteEtat, PROBE_ENDPOINT, p.probeCallId ?? null, envoye.toISOString(),
       next.checkStatus === 'failed_confirmed', failureCount, nextProbeAt, version + 1,
       // #786 : identifiant stable du contrôle retenu, contexte d'accès figé, et dernier RÉSULTAT reçu (à part du verdict).
       ...(etendu ? [checkId, environment, PROBE_API_VERSION, p.outcome.status, kind] : [])] as never[],
    );
    await historise({ checkStatus: next.checkStatus, ok: next.ok }, true, version + 1);
    if (changed) await bumpOperationalVersion(sql, `${p.source}:${next.ok === false ? 'indisponible' : next.ok ? 'sain' : 'inconnu'}`);
    // #786 (C02) : la transition `failed_confirmed → ok` est RELEVÉE ICI, dans l'unique point d'écriture, et
    // seulement si elle est réellement persistée — c'est elle qui obligera à requalifier, quelle que soit la source.
    const recovered = prev?.ok === false && next.ok === true;
    return { ...next, error, changed, nextProbeAt, persistence: 'published', ...(recovered ? { recovered: true } : {}) };
  };

  let etat: RecordedOperationalState;
  try {
    const client = pgClient as unknown as SqlRunner & { begin?: <T>(fn: (tx: SqlRunner) => Promise<T>) => Promise<T> };
    etat = typeof client.begin === 'function' ? await client.begin((tx) => transaction(tx)) : await transaction(client);
  } catch (e) {
    /**
     * #786 (A03) — ÉCHEC D'ÉCRITURE OU DE COMMIT : RIEN N'EST PUBLIÉ.
     *
     * Aucun repli vers le format antérieur à 1692 (il écrasait les autres accès) ; aucun verdict annoncé
     * publié. L'état rendu est marqué `not_persisted` : un appelant qui en dépend pour une décision
     * (promotion, activation, import, BO) doit REFUSER et conserver la candidate et les preuves.
     *
     * La reprise est IDEMPOTENTE : le `checkId` figé à la source est la clé de déduplication (index unique
     * 1815). Rejouer ce contrôle après le rétablissement de la base publie le verdict UNE fois, et ne compte
     * pas pour une seconde sonde.
     */
    const prev = p.prev !== undefined ? p.prev : await readKnown(p.model, fp);
    const next = nextOperationalState(prev, p.outcome, now);
    const error = next.error ? sanitizeProviderError(next.error, p.secret) : null;
    const code = (e as { code?: string } | null)?.code ?? null;
    const motif = schemaAnterieur(e)
      ? `schéma incomplet (${code ?? 'colonne ou table absente'}) : migration critique 1692 / 1815 / 1816 non appliquée`
      : `écriture ou commit en échec (${code ?? 'erreur'})`;
    if (schemaAnterieur(e)) schemaDegradeMotif = schemaDegradeMotif ?? motif;
    console.warn(`[model-operational] ${p.model} (${accessLabel(fp)}) : AUCUN verdict publié — ${motif}. `
      + `Reprise idempotente possible avec le même identifiant de contrôle (${checkId}). Détail : `
      + sanitizeProviderError((e as Error).message, p.secret));
    return { ...next, error, changed: false, persistence: 'not_persisted', notPersistedReason: motif };
  }
  if (etat.changed) {
    // Cette instance n'attend pas la relecture de la clé de version (#771, P03).
    try { (await import('../gateway/fallback-context')).invalidateFallbackStatusCache(); } catch { /* cache absent */ }
  }
  // #786 (C02) : OBLIGATION DE REQUALIFICATION, émise depuis l'unique point d'écriture, à chaque transition
  // persistée `failed_confirmed → ok`, QUELLE QUE SOIT LA SOURCE. Hors transaction, idempotente, reprenable.
  if (etat.recovered) await emettreRequalification(p.model, p.secret, p.source);
  // #771 (B05) : journal de propagation — sans secret ni donnée de compte.
  if (etat.changed || etat.stale) {
    console.info(`[model-operational] ${p.model} (${accessLabel(fp)}, ${OPERATIONAL_CAPABILITY_LABELS[capability]}) : ${etat.stale ? 'contrôle écarté (antérieur au verdict en vigueur, hors ordre ou hors portée)' : `état retenu → ${etat.ok === false ? 'indisponible confirmé' : etat.ok ? 'sain (blocage de disponibilité levé)' : 'inconnu'}`} — source ${p.source}${p.probeCallId ? `, appel ${p.probeCallId}` : ''}${etat.nextProbeAt ? `, prochain contrôle ${etat.nextProbeAt}` : ''}.`);
  }
  return etat;
}

/**
 * #786 (C02) — REQUALIFICATION UNIVERSELLE après un retour à sain.
 *
 * Émise depuis l'UNIQUE point d'écriture du verdict (`recordOperationalCheck`),
 * à chaque transition PERSISTÉE `failed_confirmed → ok`, quelle que soit la
 * source : `provider_test`, `catalog_refresh`, `qualification`, `gateway_call`,
 * `recovery_check`.
 *
 * Règle remplacée (carte #786, C02) : seul le chemin de récupération après rang
 * sauté (`fallback-context.probeUnderReservation`) marquait et relançait. Un
 * rétablissement constaté par le catalogue ou par « Tester la clé » laissait
 * donc des qualifications historiques en place, et une ancienne candidate
 * pouvait redevenir sélectionnable sans épreuve.
 *
 * IDEMPOTENTE ET REPRENABLE : `markRequalificationRequired` ne marque que les
 * qualifications NON encore marquées (`requalification_required_at IS NULL`) —
 * un rejeu ou un crash ne produit donc ni second marquage, ni seconde campagne.
 * La campagne ciblée est dédupliquée par cette même marque, que son résultat
 * efface ; ce qu'elle ne finit pas reste marqué et le passage planifié
 * EXISTANT le reprend.
 *
 * Un succès ne lève QUE la disponibilité : aucune activation d'ancienne
 * candidate, aucune substitution de principal ou de repli, et le tarif (#770)
 * comme la qualification restent des conditions distinctes et cumulatives.
 * Hors transaction, et jamais bloquant.
 */
async function emettreRequalification(model: string, secret: string, source: OperationalSource): Promise<void> {
  try {
    const Q = await import('./model-qualification.service');
    const marquees = await Q.markRequalificationRequired([model], secret,
      `modèle rétabli après une indisponibilité confirmée (#786, source ${source}) : qualifications antérieures à requalifier`);
    // Le cache de disponibilité est vidé AVANT la campagne : ses épreuves passent la garde avec le verdict
    // rétabli, et non avec le refus que le contrôle vient de lever.
    try { (await import('../gateway/fallback-context')).invalidateFallbackStatusCache(); } catch { /* cache absent */ }
    if (marquees === 0) {
      // Déjà marqué (rejeu, autre worker) : aucune seconde campagne — la marque est la déduplication.
      return;
    }
    const bilan = await Q.runTargetedRequalification([model], secret, { max: 1 });
    if (bilan.attempted.length === 0) {
      console.info(`[model-operational] campagne ciblée de ${model} non lancée (${bilan.skipped.map((s) => s.reason).join(', ') || 'rien à reprendre'}) : reprise au passage planifié.`);
    }
  } catch {
    /* marquage ou campagne non bloquants : la marque subsiste et le passage planifié les reprend */
  }
}

/**
 * Verdict du contrôle FINAL de disponibilité, lu dans la transaction de l'appelant (#771, A03 ; #786, E01).
 *   · `clear`        — rien ne s'oppose (sain, absent ou inconnu : un état inconnu n'est jamais une
 *                      indisponibilité, P04) ;
 *   · `refused`      — route confirmée indisponible pour l'accès actif ;
 *   · `unverifiable` — le contrôle final est IMPOSSIBLE (lecture en erreur, schéma incomplet, clé active
 *                      illisible) : l'appelant REFUSE la promotion ou l'activation et conserve les preuves,
 *                      au lieu d'admettre sans contrôle.
 */
export type OperationalTxVerdict =
  | { kind: 'clear' }
  | { kind: 'refused'; error: string | null; checkedAt: string | null; capability?: OperationalCapability }
  | { kind: 'unverifiable'; detail: string };

/**
 * Contrôle de disponibilité FINAL, lu dans la transaction de l'appelant (promotion, activation) — #771, A03 :
 * le modèle a pu être confirmé indisponible entre la campagne et l'écriture. Lecture directe de l'état canonique
 * (pas du cache d'instance), pour l'accès actif.
 *
 * Règle remplacée (carte #786, E01) : une lecture impossible rendait `null` (« rien ne s'oppose ») et laissait
 * passer la promotion. Elle rend désormais `unverifiable`.
 */
export async function operationalRefusalInTx(
  sql: SqlRunner, model: string, activeSecret?: string | null,
): Promise<OperationalTxVerdict> {
  const secret = activeSecret === undefined
    ? await (await import('./provider-secret')).getProviderSecret('gemini').catch(() => undefined)
    : activeSecret;
  if (secret === undefined) return { kind: 'unverifiable', detail: 'clé active du fournisseur illisible' };
  // Aucune clé active configurée : aucune route n'existe pour cet accès, il n'y a rien à contrôler.
  if (!secret) return { kind: 'clear' };
  // #786 (A03) : une MIGRATION CRITIQUE absente (1692 / 1815 / 1816) rend le contrôle final impossible —
  // la promotion, l'activation et l'import sont REFUSÉS, et la candidate comme les preuves sont conservées.
  // Jamais un repli silencieux vers un schéma qui perdrait l'isolation par accès, l'ordre ou l'historique.
  if (await dimensionInstrumentee()) {
    const schema = operationalSchemaState();
    if (schema.complete === false || schema.degradedReason !== null) {
      return { kind: 'unverifiable', detail: `schéma de disponibilité incomplet — ${schema.degradedReason ?? 'migration critique non appliquée'}` };
    }
  }
  try {
    await sql.unsafe(`SAVEPOINT l114q_disponibilite`);
    const rows = (await sql.unsafe(
      `SELECT ok, check_status, error, suspect_since, checked_at, capability FROM ai_model_operational_status
        WHERE provider = 'gemini' AND model = $1 AND key_fingerprint = $2 FOR SHARE`,
      [model, keyFingerprint(secret)] as never[],
    )) as unknown as Row[];
    await sql.unsafe(`RELEASE SAVEPOINT l114q_disponibilite`);
    // #786 (E05) : la route porte un verdict PAR CAPACITÉ. Une promotion ou une activation engage toutes les
    // capacités dont les opérations du traitement ont besoin : un refus confirmé sur N'IMPORTE LAQUELLE la
    // refuse, en la NOMMANT. Règle complétée (carte #786) : le contrôle ne portait que sur l'unique ligne.
    const r = rows.find((x) => toKnown(x).ok === false) ?? null;
    if (!r) return { kind: 'clear' };
    return {
      kind: 'refused', error: r.error == null ? null : sanitizeProviderError(String(r.error)), checkedAt: iso(r.checked_at),
      ...(isOperationalCapability(r.capability) ? { capability: r.capability } : {}),
    };
  } catch (e) {
    await sql.unsafe(`ROLLBACK TO SAVEPOINT l114q_disponibilite`).catch(() => undefined);
    const code = (e as { code?: string } | null)?.code ?? null;
    /**
     * #786 (A03) — TABLE OU COLONNE ABSENTE (`42P01`, `42703`).
     *
     * Règle remplacée (carte #786, A03) : `42P01` rendait `clear` (« rien ne s'oppose »), et une promotion ou
     * une activation passait donc alors que la table critique était absente — contrôle final impossible
     * confondu avec contrôle final favorable.
     *
     * Désormais, la réponse dépend de la seule question qui vaille : la dimension « disponibilité » est-elle
     * INSTRUMENTÉE dans ce processus ?
     *   · OUI  — la table devrait exister : le contrôle final est IMPOSSIBLE (`unverifiable`). La promotion et
     *            l'activation sont refusées, la candidate et les preuves conservées ;
     *   · NON  — aucune base n'est branchée (test unitaire) : il n'y a RIEN à contrôler, et bloquer
     *            l'application serait le pire choix. `clear` est conservé.
     */
    if (code === '42P01' || code === '42703') {
      return (await dimensionInstrumentee())
        ? { kind: 'unverifiable', detail: `état de disponibilité absent du schéma (${code}) : migration critique non appliquée` }
        : { kind: 'clear' };
    }
    return { kind: 'unverifiable', detail: `état de disponibilité illisible dans la transaction (${code ?? 'erreur'})` };
  }
}

/**
 * #786 (A03) — la dimension « disponibilité » est-elle INSTRUMENTÉE dans ce
 * processus ? Elle ne l'est pas en test unitaire sans base (convention de
 * `db/index.ts` : aucune connexion). Source unique :
 * `operational-admission.admissionActive()` — jamais une seconde règle locale.
 * Ne lève jamais ; en cas de doute, répond « instrumentée » (prudence).
 */
async function dimensionInstrumentee(): Promise<boolean> {
  try {
    return (await import('./operational-admission')).admissionActive();
  } catch {
    return true;
  }
}

async function rowsForActiveKey(activeSecret?: string | null): Promise<Row[]> {
  const secret = activeSecret === undefined
    ? await (await import('./provider-secret')).getProviderSecret('gemini')
    : activeSecret;
  if (!secret) return [];
  try {
    return (await pgClient.unsafe(
      `SELECT model, ok, error, source, checked_at, check_status, error_kind, suspect_since, last_ok_at,
              key_fingerprint, http_status, provider_code, capability, endpoint, probe_call_id, confirmed_at, next_probe_at
         FROM ai_model_operational_status
        WHERE provider = 'gemini' AND key_fingerprint = $1`,
      [keyFingerprint(secret)] as never[],
    )) as unknown as Row[];
  } catch (e) {
    if (!schemaAnterieur(e)) throw e;
    // Colonnes 1692 absentes : lecture du format 0335, sinon 0273 (ci-dessous).
  }
  try {
    return (await pgClient.unsafe(
      `SELECT model, ok, error, source, checked_at, check_status, error_kind, suspect_since, last_ok_at
         FROM ai_model_operational_status
        WHERE provider = 'gemini' AND key_fingerprint = $1`,
      [keyFingerprint(secret)] as never[],
    )) as unknown as Row[];
  } catch {
    // Colonnes 0335 absentes : lecture du format 0273.
    return (await pgClient.unsafe(
      `SELECT model, ok, error, source, checked_at FROM ai_model_operational_status
        WHERE provider = 'gemini' AND key_fingerprint = $1`,
      [keyFingerprint(secret)] as never[],
    )) as unknown as Row[];
  }
}

/**
 * #786 (E05) — UNE ligne retenue par modèle, à partir des lignes PAR CAPACITÉ
 * de la clé active (pure, déterministe) :
 *   1. un refus confirmé l'emporte (la capacité de BASE d'abord : son refus
 *      vaut pour tout l'accès) — jamais « tout sain » parce qu'une autre
 *      capacité répond ;
 *   2. sinon la ligne de la capacité de base ;
 *   3. sinon la première capacité par ordre alphabétique (stable).
 * `refusedCapabilities` liste toutes les capacités refusées : les décomptes et
 * le BO disent la PORTÉE exacte, sans fusion implicite.
 */
function lignesParModele(rows: readonly Row[]): Array<{ model: string; row: Row; refusedCapabilities: OperationalCapability[] }> {
  const parModele = new Map<string, Row[]>();
  for (const r of rows) {
    const m = String(r.model);
    parModele.set(m, [...(parModele.get(m) ?? []), r]);
  }
  const rang = (r: Row): number => {
    const cap = isOperationalCapability(r.capability) ? r.capability : BASE_CAPABILITY;
    const refus = toKnown(r).ok === false;
    return (refus ? 0 : 10) + (cap === BASE_CAPABILITY ? 0 : 1);
  };
  return [...parModele.entries()].map(([model, lignes]) => {
    const triees = [...lignes].sort((a, b) => rang(a) - rang(b)
      || String(a.capability ?? '').localeCompare(String(b.capability ?? '')));
    return {
      model, row: triees[0]!,
      refusedCapabilities: triees.filter((r) => toKnown(r).ok === false)
        .map((r) => (isOperationalCapability(r.capability) ? r.capability : BASE_CAPABILITY)),
    };
  });
}

/**
 * États RETENUS avec la clé active (lecture seule, aucun appel fournisseur).
 * Un état inconnu (`ok` NULL, ou ancien `ok=false` non concluant) est absent :
 * il n'écarte aucun modèle. Sans clé active, table absente ou base
 * indisponible : vide.
 */
export async function loadOperationalStatuses(activeSecret?: string | null): Promise<Map<string, OperationalStatus>> {
  return (await loadOperationalSnapshot(activeSecret)).statuses;
}

/**
 * #786 (E01) — MÊME lecture, en disant si elle est FIABLE. Une lecture en
 * erreur (base indisponible, délai, schéma illisible) rend `reliable: false`
 * avec une table vide : l'appelant doit alors conserver son dernier
 * instantané fiable, et ne JAMAIS en conclure qu'aucun modèle n'est exclu.
 *
 * Règle remplacée (carte #786) : `loadOperationalStatuses` absorbait l'erreur
 * et rendait une table vide, indiscernable d'une lecture fiable sans aucune
 * indisponibilité.
 */
export async function loadOperationalSnapshot(
  activeSecret?: string | null,
): Promise<OperationalSnapshot> {
  const statuses = new Map<string, OperationalStatus>();
  try {
    for (const { row: r } of lignesParModele(await rowsForActiveKey(activeSecret))) {
      const known = toKnown(r);
      if (known.ok === null) continue;
      statuses.set(String(r.model), {
        ok: known.ok,
        checkedAt: new Date(String(r.checked_at)).toISOString(),
        error: r.error == null ? null : String(r.error),
        source: String(r.source),
        ...(r.next_probe_at != null ? { nextProbeAt: iso(r.next_probe_at) } : {}),
      });
    }
  } catch {
    /**
     * #786 (D01) — LECTURE IMPOSSIBLE : le DERNIER INSTANTANÉ FIABLE est rendu, avec `reliable: false`.
     *
     * Règle remplacée (carte #786, D01) : une table VIDE était rendue. Le BO et l'API `catalog-status`
     * recalculaient alors les anomalies sur ce vide et affichaient « tout sain », alors qu'aucun
     * rétablissement n'avait eu lieu — une indisponibilité prouvée disparaissait de l'écran.
     *
     * Les interdictions déjà connues sont donc conservées, et `completeness` dit d'où vient l'instantané :
     * un appelant ne peut pas confondre « lu à l'instant » et « dernier état fiable connu ».
     */
    return dernierInstantaneFiable !== null
      ? { reliable: false, statuses: new Map(dernierInstantaneFiable.statuses), completeness: 'last_reliable', readAt: dernierInstantaneFiable.readAt }
      : { reliable: false, statuses: new Map(), completeness: 'none', readAt: null };
  }
  dernierInstantaneFiable = { statuses: new Map(statuses), readAt: new Date().toISOString() };
  return { reliable: true, statuses, completeness: 'fresh', readAt: dernierInstantaneFiable.readAt };
}

/**
 * #786 (D01) — PROVENANCE de l'instantané rendu, pour que le BO l'affiche sans
 * jamais confondre deux choses différentes :
 *   · `fresh`         — lu à l'instant, fiable et complet ;
 *   · `last_reliable` — lecture IMPOSSIBLE : dernier état fiable connu de cette
 *                       instance (« vérification impossible », interdictions
 *                       conservées) ;
 *   · `none`          — lecture impossible et aucun état fiable connu : rien
 *                       n'est su, et surtout rien n'est « sain ».
 */
export type OperationalCompleteness = 'fresh' | 'last_reliable' | 'none';

export interface OperationalSnapshot {
  reliable: boolean;
  statuses: Map<string, OperationalStatus>;
  /** #786 (D01) : INDICATEUR DE COMPLÉTUDE (absent sur les contextes construits à la main en test). */
  completeness?: OperationalCompleteness;
  /** Instant de la lecture fiable dont vient cet instantané. */
  readAt?: string | null;
}

/** Dernier instantané lu de façon FIABLE par cette instance (aucun TTL : la mémoire des interdictions). */
let dernierInstantaneFiable: { statuses: Map<string, OperationalStatus>; readAt: string } | null = null;

/** Réservé aux tests : oublie le dernier instantané fiable (démarrage à froid). */
export function __resetOperationalSnapshotMemory(): void {
  dernierInstantaneFiable = null;
}

/**
 * #786 (E02) — VERDICT PUBLIÉ d'une route, lu à la frontière d'un envoi : une
 * seule ligne, par clé primaire (fournisseur, modèle, accès actif), sans
 * aucun délai de tolérance, sans sonde ni appel fournisseur. `reliable: false`
 * quand la lecture échoue : l'appelant (`operational-admission.ts`) retombe
 * alors sur son dernier verdict fiable, ou suspend l'envoi.
 */
export async function readPublishedVerdict(
  model: string, activeSecret?: string | null,
  /**
   * #786 (E05) : capacité (et modalité) que l'envoi va réellement solliciter.
   * Le verdict rendu est celui de CETTE capacité ; un refus de la capacité de
   * BASE lui est opposable (règle documentée d'extension), un refus d'une
   * AUTRE capacité ne l'est pas.
   */
  capability: OperationalCapability = BASE_CAPABILITY,
  /**
   * #786 (A02) : EMPREINTE de l'accès à lire, figée avant l'envoi. Quand elle
   * est fournie, elle fait foi — la clé active n'est PAS relue, et le verdict
   * rendu est celui de l'accès qui va réellement envoyer. Le secret n'a alors
   * pas besoin de circuler jusqu'ici.
   */
  accessFingerprint?: string | null,
): Promise<PublishedVerdict> {
  let fp: string;
  if (accessFingerprint != null && accessFingerprint !== '') {
    fp = accessFingerprint;
  } else {
    let secret: string | null;
    try {
      secret = activeSecret === undefined ? await (await import('./provider-secret')).getProviderSecret('gemini') : activeSecret;
    } catch {
      return unknownVerdict(model, false, capability);
    }
    // Aucune clé active : aucune route n'est joignable de toute façon — rien à vérifier.
    if (!secret) return unknownVerdict(model, true, capability);
    fp = keyFingerprint(secret);
  }
  const etendu = await has1815();
  const colonnes = etendu
    ? `ok, check_status, error, suspect_since, checked_at, confirmed_at, next_probe_at, capability, endpoint,
       environment, api_version, last_result_status, last_result_kind, last_result_at`
    : `ok, check_status, error, suspect_since, checked_at, confirmed_at, next_probe_at, capability, endpoint`;
  let rows: Row[];
  try {
    // Une seule lecture, par la clé primaire (fournisseur, modèle, accès[, capacité]) : TOUTES les capacités
    // de la route sont rendues (au plus quatre lignes). Aucune sonde, aucune recherche de modèle.
    rows = (await pgClient.unsafe(
      `SELECT ${colonnes} FROM ai_model_operational_status
        WHERE provider = 'gemini' AND model = $1 AND key_fingerprint = $2`,
      [model, fp] as never[],
    )) as unknown as Row[];
  } catch (e) {
    // Colonnes 1692 absentes : le schéma ne tient ni l'isolation par accès, ni l'ordre, ni l'historique.
    // Signalé, et lecture déclarée NON fiable : l'admission devient prudente (jamais un repli silencieux).
    if (schemaAnterieur(e)) {
      schemaDegradeMotif = schemaDegradeMotif
        ?? 'migration 1692 non appliquée : état par accès, ordre des contrôles et historique indisponibles';
      console.warn(`[model-operational] ${schemaDegradeMotif}.`);
    }
    return unknownVerdict(model, false);
  }
  // #786 (E05) : ligne de la capacité demandée ; à défaut, la ligne de la capacité de BASE (un refus de base
  // est opposable à toutes les capacités). Un refus d'une AUTRE capacité n'est jamais retenu ici.
  const parCapacite = new Map<string, Row>();
  for (const x of rows) parCapacite.set(isOperationalCapability(x.capability) ? x.capability : BASE_CAPABILITY, x);
  const demandee = parCapacite.get(capability) ?? null;
  const ligneBase = parCapacite.get(BASE_CAPABILITY) ?? null;
  const refusBase = ligneBase !== null && toKnown(ligneBase).ok === false;
  const r = refusBase ? ligneBase : demandee ?? (capability === BASE_CAPABILITY ? ligneBase : null);
  const base = {
    ...unknownVerdict(model, true), access: accessLabel(fp),
    // #786 (A01) : l'accès RÉELLEMENT lu, pour que le verdict soit indexé par route exacte (jamais la clé).
    accessFingerprint: fp,
    askedCapability: capability,
    ...(refusBase && capability !== BASE_CAPABILITY ? { scopeExtendedFromBase: true as const } : {}),
  };
  if (!r) return base;
  const known = toKnown(r);
  return {
    ...base,
    state: known.ok === false ? 'unavailable' : known.ok === true ? 'healthy' : 'unknown',
    checkStatus: known.checkStatus,
    error: r.error == null ? null : sanitizeProviderError(String(r.error)),
    checkedAt: r.checked_at == null ? null : iso(r.checked_at),
    confirmedAt: iso(r.confirmed_at),
    nextProbeAt: iso(r.next_probe_at),
    capability: r.capability == null ? null : String(r.capability),
    endpoint: r.endpoint == null ? null : String(r.endpoint),
    environment: r.environment == null ? null : String(r.environment),
    apiVersion: r.api_version == null ? null : String(r.api_version),
    lastResultStatus: r.last_result_status == null ? null : (String(r.last_result_status) as CheckStatus),
    lastResultAt: iso(r.last_result_at),
    lastResultKind: r.last_result_kind == null ? null : (String(r.last_result_kind) as ProbeErrorKind),
  };
}

// ── #786 (E07) : réservation partagée d'un recontrôle ───────────────────────

/** Issue d'une demande de réservation de recontrôle. */
export interface ProbeLease {
  acquired: boolean;
  /**
   * #786 (B03) : `no_state` ne vaut PLUS réservation. Une route jamais sondée
   * est désormais créée puis réservée atomiquement (`acquired`), ou laissée à
   * son détenteur (`held_elsewhere`) ; `no_state` ne subsiste que comme REFUS
   * quand la ligne d'état n'a pu être ni lue ni créée.
   */
  reason: 'acquired' | 'no_state' | 'held_elsewhere' | 'not_due' | 'unreadable';
  /** Fin du bail (quand il est obtenu). */
  until: string | null;
  /**
   * #786 (B03) : JETON DE CLÔTURE du bail (fencing token) — la génération
   * attribuée à CE détenteur. À transmettre à `recordOperationalCheck` :
   * un résultat dont le jeton est dépassé est rejeté. `null` : migration 1950
   * non appliquée (le fencing n'est alors pas opposable, et c'est signalé).
   */
  generation: number | null;
}

/** Durée par défaut d'un bail de recontrôle (à valider par le PO). */
export const PROBE_LEASE_MS = 120_000;

/**
 * Réserve ATOMIQUEMENT le recontrôle d'une route (E07) : un seul `UPDATE`
 * conditionnel, donc une seule instance l'obtient, même si le cron, le BO et
 * plusieurs workers arrivent ensemble à l'échéance. Le bail est BORNÉ : s'il
 * expire (arrêt brutal du détenteur), une autre instance peut reprendre, et
 * l'ancien détenteur ne peut plus écrire une réservation périmée.
 *   · `immediate` : geste manuel explicite (« Actualiser le catalogue ») —
 *     l'échéance partagée est ignorée, mais la réservation reste exigée
 *     (double clic, deux administrateurs : une seule sonde) ;
 *   · route sans état connu : `no_state` (rien à dédupliquer, la sonde part) ;
 *   · lecture impossible : `unreadable` — la sonde ne part PAS (aucune rafale
 *     non bornée pendant une panne de base).
 */
export async function acquireProbeLease(p: {
  model: string; secret?: string | null; owner: string; leaseMs?: number; immediate?: boolean;
}): Promise<ProbeLease> {
  const refus = (reason: ProbeLease['reason'], until: string | null = null): ProbeLease =>
    ({ acquired: false, reason, until, generation: null });
  if (!(await has1815())) return refus('unreadable');
  let secret: string | null;
  try {
    secret = p.secret === undefined ? await (await import('./provider-secret')).getProviderSecret('gemini') : p.secret;
  } catch {
    return refus('unreadable');
  }
  if (!secret) return refus('unreadable');
  const fp = keyFingerprint(secret);
  const ms = Math.max(1_000, p.leaseMs ?? PROBE_LEASE_MS);
  // #786 (E05) : la sonde éprouve la capacité de BASE — la réservation porte sur sa ligne, jamais sur les autres.
  const parCapacite = await has1816();
  const capacite = parCapacite ? ' AND capability = $6' : '';
  // #786 (B03) : jeton de clôture — incrémenté dans l'UPDATE qui attribue le bail, et rendu au détenteur.
  const jeton = await has1950();
  const setGeneration = jeton ? ', probe_lease_generation = ai_model_operational_status.probe_lease_generation + 1' : '';
  const retourGeneration = jeton ? ', probe_lease_generation' : '';
  /** UNE seule tentative : `UPDATE` conditionnel, donc un seul détenteur possible. */
  const tenter = async (): Promise<Row | undefined> => ((await pgClient.unsafe(
    `UPDATE ai_model_operational_status
        SET probe_lease_owner = $3, probe_lease_until = now() + ($4 || ' milliseconds')::interval, probe_lease_at = now()${setGeneration}
      WHERE provider = 'gemini' AND model = $1 AND key_fingerprint = $2${capacite}
        AND (probe_lease_until IS NULL OR probe_lease_until <= now())
        AND ($5::boolean OR next_probe_at IS NULL OR next_probe_at <= now())
      RETURNING probe_lease_until${retourGeneration}`,
    [p.model, fp, p.owner.slice(0, 100), String(ms), Boolean(p.immediate), ...(parCapacite ? [BASE_CAPABILITY] : [])] as never[],
  )) as unknown as Row[])[0];
  const obtenu = (r: Row): ProbeLease => ({
    acquired: true, reason: 'acquired', until: iso(r.probe_lease_until),
    generation: r.probe_lease_generation == null ? null : Number(r.probe_lease_generation),
  });
  try {
    const premier = await tenter();
    if (premier) return obtenu(premier);
    // Refus : la ligne existe-t-elle, et pourquoi n'a-t-elle pas été prise ?
    const etat = (await pgClient.unsafe(
      `SELECT next_probe_at, probe_lease_until FROM ai_model_operational_status
        WHERE provider = 'gemini' AND model = $1 AND key_fingerprint = $2${parCapacite ? ' AND capability = $3' : ''}`,
      (parCapacite ? [p.model, fp, BASE_CAPABILITY] : [p.model, fp]) as never[],
    )) as unknown as Row[];
    if (etat[0]) {
      const bail = etat[0].probe_lease_until == null ? 0 : Date.parse(String(etat[0].probe_lease_until));
      if (bail > Date.now()) return refus('held_elsewhere', iso(etat[0].probe_lease_until));
      return refus('not_due');
    }
    /**
     * #786 (B03) — ROUTE JAMAIS SONDÉE : la ligne d'état est CRÉÉE, puis la réservation est RETENTÉE.
     *
     * Règle remplacée (carte #786, B03) : l'absence de ligne rendait
     * `{ acquired: true, reason: 'no_state' }` SANS aucune réservation. Deux
     * instances arrivant ensemble sur un modèle nouveau obtenaient donc toutes
     * les deux « réservé » et sondaient toutes les deux.
     *
     * L'`INSERT ... ON CONFLICT DO NOTHING` est ATOMIQUE : si deux instances
     * l'exécutent, l'une crée la ligne et l'autre ne fait rien — puis toutes
     * deux retentent l'`UPDATE` conditionnel, que l'une seule gagne. Exactement
     * un détenteur, même pour une route neuve.
     *
     * La ligne créée est NEUTRE : état INCONNU (`ok` NULL, aucun `check_status`,
     * aucune erreur, aucune échéance). Elle ne retire aucun modèle, ne fabrique
     * aucun verdict et n'invente aucune preuve — elle n'existe que pour porter
     * la réservation. C'est le contrôle qui suivra qui écrira le verdict.
     */
    await pgClient.unsafe(
      `INSERT INTO ai_model_operational_status
         (provider, model, key_fingerprint, capability, endpoint, ok, error, source, checked_at, check_status, observed_at,
          environment, api_version, state_version)
       VALUES ('gemini', $1, $2, $3, $4, NULL, NULL, $5, NOW(), NULL, NULL, $6, $7, 0)
       ON CONFLICT DO NOTHING`,
      [p.model, fp, BASE_CAPABILITY, PROBE_ENDPOINT, 'catalog_refresh', await environnementCourant(), PROBE_API_VERSION] as never[],
    );
    const second = await tenter();
    if (second) return obtenu(second);
    // La ligne existe maintenant, mais une autre instance tient le bail : une seule sonde part.
    const apres = (await pgClient.unsafe(
      `SELECT probe_lease_until FROM ai_model_operational_status
        WHERE provider = 'gemini' AND model = $1 AND key_fingerprint = $2${parCapacite ? ' AND capability = $3' : ''}`,
      (parCapacite ? [p.model, fp, BASE_CAPABILITY] : [p.model, fp]) as never[],
    )) as unknown as Row[];
    if (apres[0]) return refus('held_elsewhere', iso(apres[0].probe_lease_until));
    // Ligne ni lue ni créée : rien n'est réservé, donc rien ne part (aucune rafale non bornée).
    return refus('no_state');
  } catch {
    return refus('unreadable');
  }
}

/** Libère le bail de recontrôle, s'il appartient toujours au détenteur (ne lève jamais). */
export async function releaseProbeLease(p: { model: string; secret?: string | null; owner: string }): Promise<void> {
  if (!(await has1815())) return;
  try {
    const secret = p.secret === undefined ? await (await import('./provider-secret')).getProviderSecret('gemini') : p.secret;
    if (!secret) return;
    const capacite = await has1816() ? ' AND capability = $4' : '';
    await pgClient.unsafe(
      `UPDATE ai_model_operational_status SET probe_lease_owner = NULL, probe_lease_until = NULL
        WHERE provider = 'gemini' AND model = $1 AND key_fingerprint = $2 AND probe_lease_owner = $3${capacite}`,
      [p.model, keyFingerprint(secret), p.owner.slice(0, 100), ...(capacite ? [BASE_CAPABILITY] : [])] as never[],
    );
  } catch { /* bail laissé à son expiration */ }
}

/** Diagnostic de chaque modèle contrôlé avec la clé active (BO). */
export async function loadOperationalDiagnostics(activeSecret?: string | null): Promise<Map<string, OperationalDiagnostic>> {
  const out = new Map<string, OperationalDiagnostic>();
  try {
    for (const { row: r, refusedCapabilities } of lignesParModele(await rowsForActiveKey(activeSecret))) {
      const known = toKnown(r);
      const error = r.error == null ? null : sanitizeProviderError(String(r.error));
      // Ligne antérieure au lot 49 : statut déduit de la classification.
      let checkStatus = known.checkStatus;
      let errorKind = (r.error_kind == null ? null : String(r.error_kind)) as ProbeErrorKind | null;
      if (checkStatus === null) {
        if (r.ok) checkStatus = 'ok';
        else {
          const c = /^réponse vide/i.test(error ?? '') || error == null ? classifyProbeResponse('') : classifyProbeFailure(error);
          checkStatus = c.status === 'failed' ? 'failed_confirmed' : 'inconclusive';
          errorKind = c.status === 'ok' ? null : c.kind;
        }
      }
      out.set(String(r.model), {
        model: String(r.model), ok: known.ok, checkStatus, error, errorKind,
        checkedAt: new Date(String(r.checked_at)).toISOString(), source: String(r.source),
        lastOkAt: iso(r.last_ok_at), suspectSince: known.suspectSince,
        // #771 : diagnostic étendu (absent avant la migration 1692 : codes relus dans le message nettoyé).
        httpStatus: r.http_status == null ? providerCodesOf(error ?? '').httpStatus : Number(r.http_status),
        providerCode: r.provider_code == null ? providerCodesOf(error ?? '').providerCode : String(r.provider_code),
        access: r.key_fingerprint == null ? null : accessLabel(String(r.key_fingerprint)),
        capability: r.capability == null ? null : String(r.capability),
        endpoint: r.endpoint == null ? null : String(r.endpoint),
        probeCallId: r.probe_call_id == null ? null : Number(r.probe_call_id),
        confirmedAt: iso(r.confirmed_at), nextProbeAt: iso(r.next_probe_at),
        // #786 (E05) : PORTÉE exacte du refus — capacités réellement refusées, et projet (dimension vide).
        refusedCapabilities,
        providerProject: r.provider_project == null ? null : String(r.provider_project),
      });
    }
  } catch {
    /* diagnostic indisponible */
  }
  return out;
}

// ── Sonde ───────────────────────────────────────────────────────────────────

export { PROBE_PROMPT, PROBE_TIMEOUT_MS, PROBE_MAX_OUTPUT_TOKENS, PROBE_REASONING } from './probe-classification';
/** Pause avant le second contrôle d'un modèle suspect. */
const CONFIRM_DELAY_MS = 2_000;

/** Paramètres d'appel d'une sonde (port fournisseur). */
export function probeCallInput(model: string) {
  return {
    model, prompt: PROBE_PROMPT, attachments: [], timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS, reasoning: PROBE_REASONING,
  };
}

interface ProbeResult {
  model: string;
  /** Le modèle a répondu. */
  ok: boolean;
  /** Message nettoyé du dernier contrôle, sinon null. */
  error: string | null;
  /** Non concluant ou en attente de confirmation : l'état connu est conservé. */
  transient?: boolean;
  checkStatus: CheckStatus;
  /** #771 : sonde NON ENVOYÉE (incident global constaté pendant le passage) — rien n'est conclu sur ce modèle. */
  notSent?: boolean;
}

type ProbeCall = (model: string) => Promise<{ inputTokens?: number; outputTokens?: number; rawText: string }>;

/** Un contrôle : issue classée, instant d'envoi, appel technique tracé, codes du fournisseur (#771). */
interface Controle {
  outcome: ProbeOutcome;
  observedAt: Date;
  probeCallId: number | null;
  httpStatus: number | null;
  providerCode: string | null;
  /** #786 (E04) : identifiant stable, figé avant l'envoi. */
  checkId: string;
}

/** Un contrôle : appel, classification, trace technique. */
async function controle(model: string, secret: string, call: ProbeCall, traced: boolean): Promise<Controle> {
  const started = Date.now();
  // #786 (E04) : identifiant STABLE de ce contrôle, figé AVANT l'envoi et transmis jusqu'à l'écriture.
  const checkId = `probe:${crypto.randomUUID()}`;
  let tokens = { inputTokens: 0, outputTokens: 0 };
  let outcome: ProbeOutcome;
  let raw: string | null = null;
  let codes: { httpStatus: number | null; providerCode: string | null } = { httpStatus: null, providerCode: null };
  try {
    const r = await call(model);
    raw = r.rawText;
    tokens = { inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0 };
    outcome = classifyProbeResponse(r.rawText);
  } catch (e) {
    outcome = classifyProbeFailure(e, { model, secret });
    codes = providerCodesOf(e);
  }
  let probeCallId: number | null = null;
  if (traced) {
    const error = outcome.status === 'ok' ? null : outcome.error;
    probeCallId = await traceTechnicalCall('model_operational_probe', model, outcome.status === 'ok', Date.now() - started, tokens,
      error, { input: probeCallInput(model), responseRaw: raw }, { outcome, ...codes });
  }
  return { outcome, observedAt: new Date(started), probeCallId, checkId, ...codes };
}

/**
 * Génération minimale sur chaque modèle (port fournisseur, comme les sondes
 * du disjoncteur — MOD-013), classification et enregistrement de l'état ;
 * un modèle devenu SUSPECT est recontrôlé aussitôt (confirmation avant
 * dégradation). Tracée en appel TECHNIQUE sans compte, non facturable.
 * `call` et `confirmDelayMs` sont injectables en test.
 *
 * Lot 114 (#771, S04) : un incident GLOBAL (clé, authentification, projet)
 * constaté sur un modèle arrête les sondes restantes du passage — aucun
 * modèle n'en est tenu responsable, aucun appel répété n'est dépensé.
 */
export async function probeModels(
  models: readonly string[],
  secret: string,
  deps: {
    call?: ProbeCall; confirmDelayMs?: number; source?: OperationalSource;
    /** #786 (E07) : réserver la route avant de sonder (déduplication entre instances). */
    reserve?: boolean;
    /** #786 (E07) : geste manuel — l'échéance partagée est ignorée, la réservation reste exigée. */
    immediate?: boolean;
    /**
     * #786 (B03) : jeton de clôture d'un bail DÉJÀ obtenu par l'appelant
     * (`fallback-context` réserve la route puis appelle cette fonction). Sans
     * lui, le résultat serait rejeté comme « sans jeton alors qu'un bail est en
     * cours ». Incompatible avec `reserve` : celui-ci obtient son propre jeton.
     */
    leaseGeneration?: number | null;
  } = {},
): Promise<ProbeResult[]> {
  const call: ProbeCall = deps.call ?? (async (model: string) => {
    const { getAiProvider } = await import('../gateway/providers');
    return getAiProvider().call(probeCallInput(model));
  });
  const traced = !deps.call;
  const pause = deps.confirmDelayMs ?? CONFIRM_DELAY_MS;
  const source: OperationalSource = deps.source ?? 'catalog_refresh';
  // Lot 114 (Trello #770) : la sonde est une GÉNÉRATION — un modèle sans tarif officiel vérifié n'est pas sondé
  // (aucun appel, aucun état opérationnel modifié : ce n'est pas une indisponibilité du modèle).
  models = (await (await import('../gateway/pricing/pricing-guard')).splitByPricing(models)).priced;
  // #771 (S04) : incident global constaté pendant ce passage — les sondes non encore envoyées sont abandonnées.
  let incidentGlobal: Exclude<ProbeOutcome, { status: 'ok' }> | null = null;
  // #786 (E05) : l'accès est celui qui a ENVOYÉ la sonde (empreinte figée au départ du passage), jamais celui
  // qui serait actif à la réception — une rotation de clé en vol n'attribue plus le résultat à la nouvelle clé.
  const accessFingerprint = keyFingerprint(secret);
  /**
   * #786 (B03) : le JETON DE CLÔTURE du bail accompagne le résultat jusqu'à l'écriture. Si le bail a été
   * repris par un autre worker pendant la sonde, le résultat est rejeté et historisé — jamais appliqué.
   */
  const enregistrer = (model: string, c: Controle, leaseGeneration: number | null) => recordOperationalCheck({
    model, secret, outcome: c.outcome, source, observedAt: c.observedAt, probeCallId: c.probeCallId,
    httpStatus: c.httpStatus, providerCode: c.providerCode, checkId: c.checkId, accessFingerprint,
    ...(leaseGeneration === null ? {} : { leaseGeneration }),
  });
  const owner = `${process.pid}:probeModels`;
  const sonder = async (model: string): Promise<ProbeResult> => {
    // #786 (E07) : réservation ATOMIQUE partagée — une seule instance sonde la route à son échéance, y
    // compris sur une route JAMAIS sondée (la ligne d'état est créée puis réservée, #786 B03).
    if (deps.reserve) {
      const bail = await acquireProbeLease({ model, secret, owner, immediate: deps.immediate });
      if (!bail.acquired) {
        console.info(`[model-operational] sonde de ${model} non envoyée : ${bail.reason} (réservation partagée, #786).`);
        // #786 (D03) : une sonde NON ENVOYÉE est comptée comme telle — jamais confondue avec un état sain.
        try { (await import('./operational-admission')).noteProbeNotSent(); } catch { /* mesures absentes */ }
        return { model, ok: false, error: null, transient: true, checkStatus: 'inconclusive', notSent: true };
      }
      try {
        return await sonderSansReservation(model, bail.generation);
      } finally {
        await releaseProbeLease({ model, secret, owner });
      }
    }
    // Bail déjà tenu par l'appelant : son jeton accompagne le résultat (#786, B03).
    return sonderSansReservation(model, deps.leaseGeneration ?? null);
  };
  const sonderSansReservation = async (model: string, leaseGeneration: number | null): Promise<ProbeResult> => {
    if (incidentGlobal) {
      // Sonde NON ENVOYÉE : le dernier contrôle du modèle est noté non concluant pour le motif global (état
      // retenu inchangé, aucun appel tracé) — le BO montre que rien n'a été conclu, jamais un modèle fautif.
      try { (await import('./operational-admission')).noteProbeNotSent(); } catch { /* mesures absentes */ }
      const etat = await recordOperationalCheck({
        model, secret, outcome: incidentGlobal, source, accessFingerprint,
        checkId: `probe-not-sent:${crypto.randomUUID()}`,
        ...(leaseGeneration === null ? {} : { leaseGeneration }),
      });
      return { model, ok: false, error: etat.error, transient: true, checkStatus: 'inconclusive', notSent: true };
    }
    const premier = await controle(model, secret, call, traced);
    if (premier.outcome.status === 'inconclusive' && GLOBAL_PROBE_KINDS.has(premier.outcome.kind)) incidentGlobal = premier.outcome;
    let etat = await enregistrer(model, premier, leaseGeneration);
    if (etat.checkStatus === 'suspect' && !etat.stale) {
      // Second contrôle : seul un échec répété confirme l'indisponibilité.
      if (pause > 0) await new Promise((r) => setTimeout(r, pause));
      etat = await enregistrer(model, await controle(model, secret, call, traced), leaseGeneration);
    }
    return {
      model,
      ok: etat.checkStatus === 'ok',
      error: etat.error,
      ...(etat.checkStatus === 'inconclusive' || etat.checkStatus === 'suspect' ? { transient: true } : {}),
      checkStatus: etat.checkStatus ?? 'inconclusive',
    };
  };
  // #771 (S04) : le premier modèle est sondé SEUL (éclaireur) — s'il bute sur un incident global, les autres
  // sondes ne partent pas. Puis en parallèle : une dizaine d'appels courts, bornés chacun à 20 s —
  // l'actualisation reste un geste de quelques secondes.
  const [eclaireur, ...suite] = models;
  if (eclaireur === undefined) return [];
  const premierResultat = await sonder(eclaireur);
  return [premierResultat, ...(await Promise.all(suite.map(sonder)))];
}

/**
 * Trace d'un appel TECHNIQUE (sonde opérationnelle, qualification — lot
 * 35B) : usage technique AI_GOVERNANCE (jamais une exécution T1–T6 ; lot
 * 49 : plus « T5 »), sans compte, non facturable, coût au tarif connu (sinon
 * non calculable). Message d'erreur NETTOYÉ. Ne lève jamais.
 */
export async function traceTechnicalCall(
  operationCode: 'model_operational_probe' | 'model_qualification_probe',
  model: string, ok: boolean, durationMs: number,
  tokens: { inputTokens: number; outputTokens: number }, error: string | null,
  /** Lot 82C (LOG-01) : requête transmise et réponse brute, pour la capture complète. */
  exchange?: { input: import('../gateway/providers/provider.port').ProviderCallInput; responseRaw: string | null },
  /**
   * Lot 114 (#771, S07) : issue CLASSÉE du contrôle — la trace porte un code d'erreur, la famille et l'étape de
   * l'échec, le code HTTP et le code fournisseur (l'export n'affiche plus `UNKNOWN` quand la cause est connue).
   */
  verdict?: { outcome: ProbeOutcome; httpStatus: number | null; providerCode: string | null },
): Promise<number | null> {
  try {
    const [{ recordCallTrace }, { calcCostMicros }] = await Promise.all([
      import('../telemetry/ai-trace.service'), import('../gateway/cost-catalog'),
    ]);
    const diag = verdict && verdict.outcome.status !== 'ok' ? probeFailureDiagnostic(verdict.outcome, verdict) : null;
    return await recordCallTrace({
      traceId: crypto.randomUUID(),
      useCaseCode: 'AI_GOVERNANCE',
      operationCode,
      accountId: null,
      provider: 'gemini',
      model,
      promptVersion: operationCode === 'model_qualification_probe' ? 'qualif-v2' : 'probe-v2',
      usedFallback: false,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      costMicros: tokens.inputTokens + tokens.outputTokens > 0
        ? calcCostMicros(model, tokens.inputTokens, tokens.outputTokens, 'gemini')
        : 0,
      durationMs,
      status: ok ? 'success' : 'error',
      errorMessage: error ? sanitizeProviderError(error) : undefined,
      ...(diag ? { errorCode: diag.errorCode, failure: diag.failure, providerMeta: diag.providerMeta } : {}),
      billable: false,
      shadow: false,
      ...(exchange ? {
        capture: withProbeDiagnostic((await import('../telemetry/call-capture')).technicalCapture({
          origin: operationCode, input: exchange.input, responseRaw: exchange.responseRaw,
          error: error ? sanitizeProviderError(error) : null, durationMs,
        }), diag),
      } : {}),
    });
  } catch (e) {
    console.warn('[model-operational] trace de sonde impossible :', sanitizeProviderError((e as Error).message));
    return null;
  }
}

/** Diagnostic d'un contrôle en échec, tel que figé dans la trace technique (#771, S07). */
interface ProbeFailureDiagnostic {
  errorCode: string;
  failure: { family: string; subtype: string | null; stage: string | null; signature: string | null };
  providerMeta: Record<string, unknown>;
}

/** Famille d'échec (taxonomie de la passerelle) d'une catégorie de sonde. */
const FAMILLE_PAR_CATEGORIE: Readonly<Record<ProbeErrorKind, string>> = {
  empty_response: 'INVALID_OUTPUT', quota: 'RATE_LIMIT', server: 'PROVIDER_ERROR', timeout: 'TIMEOUT', network: 'NETWORK_ERROR',
  auth_global: 'AUTH_ERROR', project_global: 'AUTH_ERROR', forbidden_ambiguous: 'AUTH_ERROR', forbidden_model: 'AUTH_ERROR',
  model_not_found: 'INPUT_ERROR', model_retired: 'INPUT_ERROR', model_access_closed: 'INPUT_ERROR', unsupported_method: 'INPUT_ERROR',
  model_invalid_request: 'INPUT_ERROR', probe_parameter_rejected: 'INPUT_ERROR', probe_error: 'INTERNAL_ERROR',
};

/**
 * Diagnostic restitué d'un contrôle en échec (pure) : code d'erreur (`MODEL_UNAVAILABLE_CONFIRMED`,
 * `MODEL_UNAVAILABLE_SUSPECTED`, `PROVIDER_AUTH_FAILURE`, `PROBE_INCONCLUSIVE`), famille et étape, code HTTP et
 * code fournisseur, catégorie et libellé. Sépare l'échec technique de la sonde, le rejet du fournisseur et
 * l'incident global. Aucun secret : le message est celui, nettoyé, de l'issue.
 */
export function probeFailureDiagnostic(
  outcome: Exclude<ProbeOutcome, { status: 'ok' }>, codes: { httpStatus: number | null; providerCode: string | null },
): ProbeFailureDiagnostic {
  const errorCode = probeErrorCodeOf(outcome) ?? 'PROBE_INCONCLUSIVE';
  const nature = outcome.status === 'failed' ? 'provider_rejection'
    : GLOBAL_PROBE_KINDS.has(outcome.kind) ? 'provider_global_incident'
      : outcome.kind === 'probe_error' || outcome.kind === 'empty_response' || outcome.kind === 'probe_parameter_rejected' ? 'probe_technical_failure' : 'provider_transient';
  return {
    errorCode,
    failure: {
      family: FAMILLE_PAR_CATEGORIE[outcome.kind],
      subtype: outcome.kind === 'empty_response' ? 'EMPTY_RESPONSE' : null,
      stage: outcome.kind === 'empty_response' ? 'provider_generation' : 'provider_request',
      signature: `probe:${outcome.kind}`,
    },
    providerMeta: {
      httpStatus: codes.httpStatus, providerErrorCode: codes.providerCode,
      probe: {
        verdict: outcome.status === 'failed' ? (outcome.definitive ? 'failed_confirmed' : 'suspect') : 'inconclusive',
        kind: outcome.kind, kindLabel: PROBE_ERROR_KIND_LABELS[outcome.kind], nature,
        definitive: outcome.status === 'failed' ? outcome.definitive : false,
        capability: PROBE_CAPABILITY, endpoint: PROBE_ENDPOINT,
      },
    },
  };
}

/** Ajoute le diagnostic classé à la capture technique (sans en changer la forme). */
function withProbeDiagnostic<T extends { diagnostic?: unknown }>(capture: T, diag: ProbeFailureDiagnostic | null): T {
  if (!diag) return capture;
  const existant = (capture.diagnostic && typeof capture.diagnostic === 'object' ? capture.diagnostic : {}) as Record<string, unknown>;
  return { ...capture, diagnostic: { ...existant, errorCode: diag.errorCode, ...diag.failure, ...diag.providerMeta } };
}
