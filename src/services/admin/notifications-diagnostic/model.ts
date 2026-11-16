/**
 * Diagnostic des notifications — MODÈLE PUR (lot 115B, Trello #800).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE MODULE GARANTIT
 *
 * 1. EXPURGATION UNIQUE. L'interface, la copie et le téléchargement passent
 *    tous par `expurgerMessageTechnique` et `empreinteCourte` : il n'existe
 *    pas de chemin où un jeton, une clé, une adresse ou une URL signée
 *    pourrait sortir d'un côté et pas de l'autre (#800 §6).
 * 2. AUCUNE CAUSE INVENTÉE. Un champ absent reste absent : il est rendu
 *    « non enregistré » (`NON_ENREGISTRE`), jamais remplacé par une
 *    supposition. `mobile_push_config` est une CLASSE du code, pas une
 *    preuve que les variables manquent (#800 §1).
 * 3. ÉCHEC ≠ IGNORÉ. `nature()` sépare l'échec réel, l'ignoré volontaire,
 *    le jeton expiré, l'acceptation par le prestataire (qui n'est PAS une
 *    réception sur le téléphone) et l'attente (#800 §3.5).
 *
 * Module SANS dépendance serveur : il est importé par les routes, par le
 * service de lecture et par les tests unitaires, sans base de données.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Version du schéma du téléchargement. Toute rupture incrémente le suffixe. */
export const DIAGNOSTIC_SCHEMA_VERSION = 'verebona.notifications.diagnostic/1';

/** Marqueur unique d'une donnée que le code n'a jamais écrite. */
export const NON_ENREGISTRE = 'non enregistré';

/** Taille d'une page de détail (pagination à curseur, aucun plafonnement). */
export const PAGE_DETAIL = 100;
/** Lignes lues par FETCH du curseur d'export (mémoire bornée). */
export const EXPORT_LOT = 500;
/** Longueur maximale d'un message technique expurgé. */
export const MESSAGE_MAX = 300;

/* ── Vocabulaires ─────────────────────────────────────────────────────────── */

export const CANAUX = ['bell', 'push', 'email'] as const;
export type Canal = (typeof CANAUX)[number];

export const PLATEFORMES = ['ios', 'android'] as const;
export type Plateforme = (typeof PLATEFORMES)[number];

/** Environnements d'appareil (séparation préprod / prod, #800 §6). */
export const ENVIRONNEMENTS = ['local', 'preprod', 'production'] as const;
export type Environnement = (typeof ENVIRONNEMENTS)[number];

export const STATUTS_LIVRAISON = ['pending', 'sent', 'failed', 'skipped_preference', 'skipped_unavailable', 'expired'] as const;
export const STATUTS_EVENEMENT = ['pending', 'processing', 'sent', 'partial', 'failed', 'cancelled', 'reemitted', 'skipped', 'grouped'] as const;

/** Périodes proposées par le BO ; `dates` = bornes transmises. */
export const PERIODES = ['24h', '7j', '30j', 'dates'] as const;
export type Periode = (typeof PERIODES)[number];

/**
 * Familles d'erreur : regroupement STABLE des codes internes, pour filtrer
 * sans connaître le code exact. Le code exact reste toujours affiché à côté.
 */
export const FAMILLES = [
  'configuration', 'catalogue', 'jeton_appareil', 'deduplication', 'canal',
  'fournisseur', 'reseau', 'destinataire', 'interne', 'aucune', 'inconnue',
] as const;
export type FamilleErreur = (typeof FAMILLES)[number];

export const FAMILLE_LIBELLES: Readonly<Record<FamilleErreur, string>> = {
  configuration: 'Configuration du canal ou du fournisseur',
  catalogue: 'Non prévu au catalogue pour ce canal',
  jeton_appareil: 'Jeton ou appareil',
  deduplication: 'Déduplication / regroupement',
  canal: 'Canal supprimé, coupé ou porté ailleurs',
  fournisseur: 'Refus ou indisponibilité du fournisseur',
  reseau: 'Réseau ou délai dépassé',
  destinataire: 'Destinataire ou gabarit',
  interne: 'Écriture interne',
  aucune: 'Aucune erreur',
  inconnue: 'Famille non déterminée',
};

/** Nature réelle d'un résultat de livraison (#800 §3.5). */
export const NATURES = [
  'accepte_par_prestataire', 'ecrit_localement', 'echec_reel',
  'ignore_volontaire', 'jeton_expire', 'en_attente',
] as const;
export type NatureResultat = (typeof NATURES)[number];

export const NATURE_LIBELLES: Readonly<Record<NatureResultat, string>> = {
  // « Accepté » et non « reçu » : FCM / Resend accusent réception du message,
  // pas son affichage sur le téléphone (#800 §3.5).
  accepte_par_prestataire: 'Accepté par le prestataire (réception sur le téléphone non confirmée)',
  ecrit_localement: 'Écrit dans la cloche',
  echec_reel: 'Échec réel',
  ignore_volontaire: 'Ignoré volontairement',
  jeton_expire: 'Jeton expiré ou refusé',
  en_attente: 'En attente',
};

export const ETAPE_LIBELLES: Readonly<Record<string, string>> = {
  catalogue: 'Catalogue de l’événement',
  configuration: 'Configuration du canal / fournisseur',
  jeton_appareil: 'Jeton de l’appareil',
  deduplication: 'Déduplication',
  oauth_fournisseur: 'Obtention du jeton d’accès du fournisseur',
  appel_fournisseur: 'Appel au fournisseur',
  reponse_fournisseur: 'Réponse du fournisseur',
  canal: 'Décision de canal',
  ecriture_locale: 'Écriture locale',
};

/** Statut de complétude d'une section du rapport (#800 §5). */
export const SECTION_STATUTS = ['COMPLETE', 'PARTIAL', 'NOT_APPLICABLE', 'ERROR'] as const;
export type SectionStatut = (typeof SECTION_STATUTS)[number];

/* ── Classement ───────────────────────────────────────────────────────────── */

/**
 * Table DÉCLARATIVE des codes de chaque famille — codes réellement émis par
 * `src/lib/notifications/**` et `src/lib/mobile/**`.
 *
 * Une seule source : `familleDeCode` (affichage) et le filtre SQL du service
 * la lisent tous les deux. Sans cela, l'écran et le filtre « famille »
 * pourraient classer le même code différemment, et le total de l'écran ne
 * correspondrait plus au détail (CA06).
 */
export const FAMILLE_CODES: Readonly<Record<FamilleErreur, { exacts: readonly string[]; prefixes: readonly string[] }>> = {
  catalogue: { exacts: ['mobile_push_not_in_catalog'], prefixes: [] },
  canal: { exacts: ['channel_retired', 'channel_disabled_by_admin', 'no_email_template', 'email_sent_by_trial_sequence'], prefixes: ['account_ineligible'] },
  deduplication: { exacts: ['mobile_push_duplicate_suppressed', 'digest_already_pushed_today', 'grouped_incident'], prefixes: [] },
  jeton_appareil: { exacts: ['token_unreadable', 'no_active_subscription'], prefixes: ['invalid_token'] },
  configuration: { exacts: ['mobile_push_not_configured', 'mobile_push_disabled', 'mobile_push_config', 'template_not_seeded'], prefixes: [] },
  destinataire: { exacts: ['no_recipient_email'], prefixes: [] },
  reseau: { exacts: ['mobile_push_transient'], prefixes: [] },
  fournisseur: { exacts: ['mobile_push_rejected', 'email_send_error'], prefixes: [] },
  interne: { exacts: ['bell_insert_error'], prefixes: [] },
  aucune: { exacts: [], prefixes: [] },
  inconnue: { exacts: [], prefixes: [] },
};

/**
 * Famille d'un code d'erreur interne. Un code inconnu rend `inconnue` —
 * jamais une famille devinée.
 */
export function familleDeCode(code: string | null | undefined): FamilleErreur {
  if (!code) return 'aucune';
  const c = code.toLowerCase();
  for (const f of FAMILLES) {
    if (f === 'aucune' || f === 'inconnue') continue;
    const t = FAMILLE_CODES[f];
    if (t.exacts.includes(c) || t.prefixes.some((p) => c.startsWith(p))) return f;
  }
  return 'inconnue';
}

/**
 * Nature d'un résultat. Le statut de la ligne commande : un `skipped_*` n'est
 * JAMAIS présenté comme un échec, et un `sent` n'est jamais présenté comme
 * une réception.
 */
export function nature(statut: string, canal: string): NatureResultat {
  switch (statut) {
    case 'sent': return canal === 'bell' ? 'ecrit_localement' : 'accepte_par_prestataire';
    case 'failed': return 'echec_reel';
    case 'expired': return 'jeton_expire';
    case 'skipped_preference':
    case 'skipped_unavailable': return 'ignore_volontaire';
    default: return 'en_attente';
  }
}

/* ── Expurgation ──────────────────────────────────────────────────────────── */

/** Remplacement visible : on sait qu'il y avait quelque chose, pas quoi. */
const EXPURGE = '[expurgé]';

/**
 * Message technique rendu publiable.
 *
 * Ordre volontaire : les motifs les plus spécifiques d'abord (en-tête
 * d'autorisation, jeton JWT, paire clé/valeur sensible), puis les motifs
 * génériques (longue suite base64 / hexadécimale) qui attraperaient sinon des
 * morceaux de jeton déjà partiellement masqués.
 *
 * On ne tente PAS de deviner ce qui est sensible mot par mot : tout ce qui
 * ressemble à un secret est remplacé, quitte à expurger un peu trop. Un
 * diagnostic tronqué reste exploitable ; un secret copié ne se rattrape pas.
 */
export function expurgerMessageTechnique(message: string | null | undefined): string | null {
  if (message == null) return null;
  const brut = String(message);
  if (brut.trim() === '') return null;
  let s = brut
    // En-tête d'autorisation, jeton porteur.
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${EXPURGE}`)
    // Jeton JWT / assertion signée (trois segments base64url).
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+)?/g, EXPURGE)
    // Bloc de clé privée.
    .replace(/-{3,}BEGIN[^-]*PRIVATE KEY-{3,}[\s\S]*?-{3,}END[^-]*-{3,}/gi, EXPURGE)
    // Paires clé/valeur sensibles (token=…, "private_key": "…", apiKey: …).
    // La clé peut être entourée de guillemets (fragment de JSON) : on les
    // tolère des deux côtés du séparateur.
    .replace(/\b(access_?token|id_?token|refresh_?token|private_?key|client_?secret|api_?key|secret|password|passwd|signature|cookie|authorization|token)\b"?\s*[=:]\s*"?[^\s",;}&]+"?/gi, (_m, cle: string) => `${cle}=${EXPURGE}`)
    // Adresse de courriel.
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[adresse expurgée]')
    // URL : le chemin suffit au diagnostic ; la requête peut porter une signature.
    .replace(/(https?:\/\/[^\s"'<>]+?)\?[^\s"'<>]*/gi, '$1?[expurgé]')
    // Longue suite opaque (jeton d'appareil, clé encodée) restée en clair.
    .replace(/\b[A-Za-z0-9_:-]{40,}\b/g, EXPURGE)
    .replace(/\b[0-9a-f]{32,}\b/gi, EXPURGE);
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > MESSAGE_MAX) s = `${s.slice(0, MESSAGE_MAX)}…`;
  return s === '' ? null : s;
}

/**
 * Empreinte courte d'un identifiant technique : assez pour rapprocher deux
 * traces, trop peu pour reconstituer la valeur. `null` reste `null`.
 */
export function empreinteCourte(valeur: string | null | undefined, taille = 12): string | null {
  if (!valeur) return null;
  const v = String(valeur);
  return v.length <= taille ? v : `${v.slice(0, taille)}…`;
}

/** Valeur affichable : `null` devient « non enregistré ». */
export function ouNonEnregistre(v: string | number | null | undefined): string {
  return v === null || v === undefined || v === '' ? NON_ENREGISTRE : String(v);
}

/* ── Dates ────────────────────────────────────────────────────────────────── */

/** `AAAA-MM-JJ HH:MM:SS` en Europe/Paris (affichage français, #800 §5). */
export function heureParis(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  const p = new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`;
}

/** Couple ISO (UTC) + lisible (Europe/Paris) : les deux sont exigés (#800 §3.4). */
export function instant(d: Date | string | null | undefined): { iso: string; paris: string } | null {
  if (d == null) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return { iso: date.toISOString(), paris: heureParis(date) ?? date.toISOString() };
}

/* ── Critères de recherche ────────────────────────────────────────────────── */

export interface DiagnosticCurseur { createdAt: string; id: string }

export interface DiagnosticQuery {
  periode: Periode;
  depuis: Date;
  jusqu: Date;
  canal: Canal | null;
  plateforme: Plateforme | null;
  /** Environnement de l'appareil visé (canal push uniquement). */
  environnement: Environnement | null;
  statutLivraison: string | null;
  statutEvenement: string | null;
  /** Code interne EXACT (`last_error_code`). */
  code: string | null;
  /** Code EXACT rendu par le fournisseur (`provider_error_code`). */
  codeFournisseur: string | null;
  famille: FamilleErreur | null;
  nature: NatureResultat | null;
  evenement: string | null;
  utilisateurId: number | null;
  compteId: number | null;
  /**
   * Référence libre, non secrète : identifiant d'événement (outbox), de
   * livraison, d'installation, ou fragment de clé de déduplication. Permet de
   * chercher SANS connaître d'identifiant interne (#800 §3.2) : une saisie qui
   * n'est pas un UUID est cherchée dans la clé de déduplication et le type.
   */
  reference: string | null;
  curseur: DiagnosticCurseur | null;
  taille: number;
}

export type ParseResult =
  | { ok: true; value: DiagnosticQuery }
  | { ok: false; code: string; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function estUuid(v: string): boolean {
  return UUID.test(v.trim());
}

function dansListe<T extends string>(v: string | null, liste: readonly T[]): T | null {
  if (!v) return null;
  return (liste as readonly string[]).includes(v) ? (v as T) : null;
}

/** Durées des périodes nommées, en millisecondes. */
const DUREES: Readonly<Record<Exclude<Periode, 'dates'>, number>> = {
  '24h': 24 * 3600_000,
  '7j': 7 * 24 * 3600_000,
  '30j': 30 * 24 * 3600_000,
};

/**
 * Lit et VALIDE les critères. Une valeur hors vocabulaire est refusée (400)
 * au lieu d'être ignorée : un filtre silencieusement abandonné donnerait un
 * total juste pour un périmètre faux (#800 §5, CA06).
 */
export function parseDiagnosticQuery(sp: URLSearchParams, maintenant: Date = new Date()): ParseResult {
  const refus = (code: string, message: string): ParseResult => ({ ok: false, code, message });
  const lire = (n: string) => {
    const v = sp.get(n);
    return v === null || v.trim() === '' ? null : v.trim();
  };

  const periodeBrute = lire('periode') ?? '7j';
  const periode = dansListe(periodeBrute, PERIODES);
  if (!periode) return refus('PERIODE_INVALIDE', 'Période inconnue.');

  let depuis: Date;
  let jusqu: Date;
  if (periode === 'dates') {
    const d = lire('depuis');
    const j = lire('jusqu');
    if (!d || !j) return refus('DATES_REQUISES', 'Les deux dates sont requises pour une période personnalisée.');
    depuis = new Date(d);
    jusqu = new Date(j);
    if (Number.isNaN(depuis.getTime()) || Number.isNaN(jusqu.getTime())) return refus('DATES_INVALIDES', 'Dates illisibles (format ISO 8601 attendu).');
    if (depuis.getTime() > jusqu.getTime()) return refus('DATES_INVERSEES', 'La date de début est postérieure à la date de fin.');
  } else {
    jusqu = maintenant;
    depuis = new Date(maintenant.getTime() - DUREES[periode]);
  }

  const canalBrut = lire('canal');
  const canal = canalBrut ? dansListe(canalBrut, CANAUX) : null;
  if (canalBrut && !canal) return refus('CANAL_INVALIDE', 'Canal inconnu.');

  const plateformeBrute = lire('plateforme');
  const plateforme = plateformeBrute ? dansListe(plateformeBrute, PLATEFORMES) : null;
  if (plateformeBrute && !plateforme) return refus('PLATEFORME_INVALIDE', 'Plateforme inconnue.');

  const environnementBrut = lire('environnement');
  const environnement = environnementBrut ? dansListe(environnementBrut, ENVIRONNEMENTS) : null;
  if (environnementBrut && !environnement) return refus('ENVIRONNEMENT_INVALIDE', 'Environnement inconnu.');

  const statutLivraisonBrut = lire('statutLivraison');
  const statutLivraison = statutLivraisonBrut ? dansListe(statutLivraisonBrut, STATUTS_LIVRAISON) : null;
  if (statutLivraisonBrut && !statutLivraison) return refus('STATUT_LIVRAISON_INVALIDE', 'Statut de livraison inconnu.');

  const statutEvenementBrut = lire('statutEvenement');
  const statutEvenement = statutEvenementBrut ? dansListe(statutEvenementBrut, STATUTS_EVENEMENT) : null;
  if (statutEvenementBrut && !statutEvenement) return refus('STATUT_EVENEMENT_INVALIDE', 'Statut d’événement inconnu.');

  const familleBrute = lire('famille');
  const famille = familleBrute ? dansListe(familleBrute, FAMILLES) : null;
  if (familleBrute && !famille) return refus('FAMILLE_INVALIDE', 'Famille d’erreur inconnue.');

  const natureBrute = lire('nature');
  const natureFiltre = natureBrute ? dansListe(natureBrute, NATURES) : null;
  if (natureBrute && !natureFiltre) return refus('NATURE_INVALIDE', 'Nature de résultat inconnue.');

  const entier = (n: string): number | null | 'invalide' => {
    const v = lire(n);
    if (v === null) return null;
    if (!/^\d{1,9}$/.test(v)) return 'invalide';
    return Number(v);
  };
  const utilisateurId = entier('utilisateurId');
  if (utilisateurId === 'invalide') return refus('UTILISATEUR_INVALIDE', 'Identifiant d’utilisateur invalide.');
  const compteId = entier('compteId');
  if (compteId === 'invalide') return refus('COMPTE_INVALIDE', 'Identifiant de compte invalide.');

  const tailleBrute = lire('taille');
  let taille = PAGE_DETAIL;
  if (tailleBrute !== null) {
    if (!/^\d{1,4}$/.test(tailleBrute)) return refus('TAILLE_INVALIDE', 'Taille de page invalide.');
    taille = Math.max(1, Math.min(500, Number(tailleBrute)));
  }

  let curseur: DiagnosticCurseur | null = null;
  const curseurBrut = lire('curseur');
  if (curseurBrut) {
    const [at, id] = curseurBrut.split('|');
    if (!at || !id || Number.isNaN(new Date(at).getTime()) || !estUuid(id)) {
      return refus('CURSEUR_INVALIDE', 'Curseur de pagination invalide.');
    }
    curseur = { createdAt: new Date(at).toISOString(), id: id.toLowerCase() };
  }

  const borne = (v: string | null, max: number) => (v === null ? null : v.slice(0, max));

  return {
    ok: true,
    value: {
      periode, depuis, jusqu, canal, plateforme, environnement, statutLivraison, statutEvenement,
      code: borne(lire('code'), 80),
      codeFournisseur: borne(lire('codeFournisseur'), 80),
      famille, nature: natureFiltre,
      evenement: borne(lire('evenement'), 80),
      utilisateurId, compteId,
      reference: borne(lire('reference'), 120),
      curseur, taille,
    },
  };
}

/** Critères remis sous forme de requête (export = MÊME périmètre que l'écran). */
export function queryVersParams(q: DiagnosticQuery): URLSearchParams {
  const sp = new URLSearchParams();
  sp.set('periode', q.periode);
  if (q.periode === 'dates') {
    sp.set('depuis', q.depuis.toISOString());
    sp.set('jusqu', q.jusqu.toISOString());
  }
  const paires: Array<[string, string | number | null]> = [
    ['canal', q.canal], ['plateforme', q.plateforme], ['environnement', q.environnement], ['statutLivraison', q.statutLivraison],
    ['statutEvenement', q.statutEvenement], ['code', q.code], ['codeFournisseur', q.codeFournisseur],
    ['famille', q.famille], ['nature', q.nature], ['evenement', q.evenement],
    ['utilisateurId', q.utilisateurId], ['compteId', q.compteId], ['reference', q.reference],
  ];
  for (const [k, v] of paires) if (v !== null && v !== undefined) sp.set(k, String(v));
  return sp;
}

/** Curseur opaque de la ligne suivante. */
export function curseurDe(ligne: { creeLe: { iso: string } | null; id: string }): string | null {
  return ligne.creeLe ? `${ligne.creeLe.iso}|${ligne.id}` : null;
}

/* ── Enregistrements rendus ───────────────────────────────────────────────── */

/** Une tentative de livraison, telle qu'elle est affichée, copiée et exportée. */
export interface LigneDiagnostic {
  /** Identifiant stable de la livraison (opaque, non secret). */
  id: string;
  /** Événement de référence porteur (`notification_outbox.id`). */
  evenementId: string;
  evenementType: string;
  evenementStatut: string;
  evenementCategorie: string | null;
  /** Cause d'un événement ignoré / événement de référence du regroupement. */
  evenementMotif: string | null;
  regroupeAvecId: string | null;
  /** Clé de déduplication, tronquée : sert à reconnaître les tentatives d'un même récapitulatif. */
  cleDeduplication: string | null;
  tentativesEvenement: number;
  canal: string;
  statut: string;
  nature: NatureResultat;
  natureLibelle: string;
  /** Classe interne du code (historique, inchangée). */
  code: string | null;
  famille: FamilleErreur;
  familleLibelle: string;
  /** Message technique EXPURGÉ, ou null si rien n'a été enregistré. */
  message: string | null;
  etape: string | null;
  etapeLibelle: string | null;
  categorieEchec: string | null;
  fournisseur: string | null;
  statutHttp: number | null;
  codeFournisseur: string | null;
  /** Identifiant de message du fournisseur, tronqué. */
  messageFournisseur: string | null;
  plateforme: string | null;
  versionApplication: string | null;
  build: string | null;
  /** Installation visée : identifiant de ligne (opaque) + empreinte de l'identifiant applicatif. */
  appareilId: string | null;
  appareilEmpreinte: string | null;
  appareilStatut: string | null;
  appareilMotifStatut: string | null;
  appareilEnvironnement: string | null;
  /** Présence d'un jeton déchiffrable — BOOLÉEN SEUL (#800 §4). */
  appareilJetonPresent: boolean | null;
  utilisateurId: number;
  compteId: number | null;
  creeLe: { iso: string; paris: string } | null;
  tenteLe: { iso: string; paris: string } | null;
  envoyeLe: { iso: string; paris: string } | null;
  evenementCreeLe: { iso: string; paris: string } | null;
  evenementTraiteLe: { iso: string; paris: string } | null;
  evenementPrevuLe: { iso: string; paris: string } | null;
  /** Remise CONFIRMÉE par le prestataire (e-mail seulement), quand elle existe. */
  remiseConfirmee: boolean | null;
  /** Lot 115B : la livraison est-elle postérieure à la migration 1745 ? */
  instrumentationStructuree: boolean;
}

export interface AgregatCode {
  statut: string;
  code: string | null;
  famille: FamilleErreur;
  familleLibelle: string;
  nature: NatureResultat;
  natureLibelle: string;
  canal: string;
  livraisons: number;
  evenementsDistincts: number;
  appareils: number;
}

export interface SyntheseDiagnostic {
  livraisons: number;
  evenementsDistincts: number;
  tentativesEvenements: number;
  appareils: number;
  parNature: Record<NatureResultat, number>;
}

export interface SectionCompletude {
  nom: string;
  statut: SectionStatut;
  attendu: number | null;
  exporte: number | null;
  motif: string | null;
  horodatage: string;
  versionSchema: string;
}

export interface PerimetreDiagnostic {
  identifiantDiagnostic: string;
  versionSchema: string;
  genereLe: { iso: string; paris: string };
  instantane: { iso: string; paris: string };
  fenetre: { depuis: { iso: string; paris: string }; jusqu: { iso: string; paris: string }; periode: Periode; libelle: string };
  filtres: Record<string, string | number | null>;
  environnement: string;
  build: { version: string; commit: string | null };
  /** Fuseau d'affichage : les deux repères sont donnés partout. */
  fuseauAffichage: 'Europe/Paris';
}

/** Libellé de fenêtre affiché à côté de chaque compteur (#800 §3.6). */
export function libelleFenetre(q: DiagnosticQuery): string {
  const d = heureParis(q.depuis) ?? q.depuis.toISOString();
  const j = heureParis(q.jusqu) ?? q.jusqu.toISOString();
  const nom = q.periode === 'dates' ? 'Période choisie' : { '24h': '24 heures', '7j': '7 jours', '30j': '30 jours' }[q.periode];
  return `${nom} — du ${d} au ${j} (Europe/Paris)`;
}

/**
 * Identifiant du diagnostic : lisible, daté, et stable pour un même
 * périmètre. Il figure dans l'écran, dans la copie et dans le fichier : un
 * échange avec l'équipe technique peut s'y référer (#800 §5).
 */
export function identifiantDiagnostic(q: DiagnosticQuery, genereLe: Date): string {
  const params = queryVersParams(q).toString();
  let h = 2166136261;
  for (let i = 0; i < params.length; i++) {
    h ^= params.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const jour = (heureParis(genereLe) ?? genereLe.toISOString()).slice(0, 10);
  return `DIAG-NOTIF-${jour}-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/** Nom du fichier téléchargé : daté et explicite (#800 §5). */
export function nomFichierDiagnostic(q: DiagnosticQuery, genereLe: Date, suffixe?: string): string {
  const jour = (heureParis(genereLe) ?? genereLe.toISOString()).slice(0, 10);
  const parties = ['verebona-notifications-diagnostic'];
  if (suffixe) parties.push(suffixe.replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, ''));
  else parties.push(q.periode);
  parties.push(jour);
  return `${parties.filter(Boolean).join('-')}.json`;
}

/* ── Rendu du téléchargement (JSON en flux) ───────────────────────────────── */

export function sectionCompletude(
  nom: string, statut: SectionStatut, attendu: number | null, exporte: number | null, motif: string | null, horodatage: Date,
): SectionCompletude {
  return { nom, statut, attendu, exporte, motif, horodatage: horodatage.toISOString(), versionSchema: DIAGNOSTIC_SCHEMA_VERSION };
}

export interface EnteteExport {
  perimetre: PerimetreDiagnostic;
  synthese: SyntheseDiagnostic;
  agregats: AgregatCode[];
  configurationPush: unknown;
  file: unknown;
  sections: SectionCompletude[];
  /** Champs que le code n'enregistre pas pour les lignes antérieures à 1745. */
  champsNonEnregistres: string[];
}

export function jsonEntete(e: EnteteExport): string {
  const enveloppe = {
    schema: DIAGNOSTIC_SCHEMA_VERSION,
    perimetre: e.perimetre,
    synthese: e.synthese,
    agregats: e.agregats,
    configurationPush: e.configurationPush,
    file: e.file,
    completude: { sections: e.sections, champsNonEnregistres: e.champsNonEnregistres },
  };
  const texte = JSON.stringify(enveloppe, null, 2);
  // L'enveloppe est écrite d'abord, le tableau de livraisons est rempli en
  // flux : le fichier reste du JSON valide, quelle que soit sa taille.
  return `${texte.slice(0, texte.length - 2)},\n  "livraisons": [`;
}

export function jsonLigne(l: LigneDiagnostic, index: number): string {
  return `${index === 0 ? '\n    ' : ',\n    '}${JSON.stringify(l)}`;
}

/**
 * Pied du fichier : le MANIFESTE de complétude. `COMPLETE` n'est écrit que si
 * le nombre de lignes écrites égale le nombre attendu ET qu'aucune trace
 * nécessaire ne manque (#800 §5 : « Pas de COMPLET si des traces nécessaires
 * manquent »).
 */
export function jsonPied(o: {
  exporte: number; attendu: number; interruption: string | null; champsNonEnregistres: string[]; horodatage: Date;
}): string {
  const complet = o.interruption === null && o.exporte === o.attendu;
  const statut: SectionStatut = o.interruption !== null ? 'ERROR' : complet ? (o.champsNonEnregistres.length ? 'PARTIAL' : 'COMPLETE') : 'PARTIAL';
  const motif = o.interruption !== null
    ? `Export interrompu (${o.interruption}) : ${o.exporte} ligne(s) écrite(s) sur ${o.attendu} attendue(s).`
    : !complet
      ? `Écart entre l’attendu (${o.attendu}) et l’écrit (${o.exporte}).`
      : o.champsNonEnregistres.length
        ? 'Périmètre complet, mais certaines livraisons n’ont pas de trace structurée (antérieures à l’instrumentation).'
        : null;
  const manifeste = {
    statut,
    attendu: o.attendu,
    exporte: o.exporte,
    motif,
    champsNonEnregistres: o.champsNonEnregistres,
    horodatage: o.horodatage.toISOString(),
    versionSchema: DIAGNOSTIC_SCHEMA_VERSION,
  };
  return `\n  ],\n  "manifeste": ${JSON.stringify(manifeste, null, 2).split('\n').join('\n  ')}\n}\n`;
}

/* ── Rendu de la copie (texte structuré) ──────────────────────────────────── */

const TIRET = '─'.repeat(72);

function ligneTexte(l: LigneDiagnostic): string[] {
  const out = [
    `  • Livraison ${l.id} · canal ${l.canal} · ${l.natureLibelle}`,
    `    Événement de référence ${l.evenementId} (${l.evenementType}, statut ${l.evenementStatut}) · tentative(s) : ${l.tentativesEvenement}`,
    `    Créée : ${l.creeLe ? `${l.creeLe.paris} (Europe/Paris) · ${l.creeLe.iso}` : NON_ENREGISTRE}`,
    `    Tentée : ${l.tenteLe ? l.tenteLe.paris : NON_ENREGISTRE} · Envoyée : ${l.envoyeLe ? l.envoyeLe.paris : NON_ENREGISTRE}`,
    `    Code interne : ${ouNonEnregistre(l.code)} (famille : ${l.familleLibelle})`,
    `    Étape : ${ouNonEnregistre(l.etapeLibelle)} · Catégorie : ${ouNonEnregistre(l.categorieEchec)}`,
    `    Fournisseur : ${ouNonEnregistre(l.fournisseur)} · Statut HTTP : ${ouNonEnregistre(l.statutHttp)} · Code fournisseur : ${ouNonEnregistre(l.codeFournisseur)}`,
    `    Message technique (expurgé) : ${ouNonEnregistre(l.message)}`,
  ];
  if (l.canal === 'push') {
    out.push(`    Appareil : ${ouNonEnregistre(l.appareilEmpreinte)} · ${ouNonEnregistre(l.plateforme)} ${ouNonEnregistre(l.versionApplication)} · statut ${ouNonEnregistre(l.appareilStatut)} · environnement ${ouNonEnregistre(l.appareilEnvironnement)}`);
    out.push(`    Jeton déchiffrable : ${l.appareilJetonPresent === null ? NON_ENREGISTRE : l.appareilJetonPresent ? 'oui' : 'non'}`);
  }
  if (l.canal === 'email') {
    out.push(`    Remise confirmée par le prestataire : ${l.remiseConfirmee === null ? NON_ENREGISTRE : l.remiseConfirmee ? 'oui' : 'non'}`);
  }
  if (l.regroupeAvecId) out.push(`    Regroupé avec l’événement de référence ${l.regroupeAvecId}`);
  if (l.evenementMotif) out.push(`    Motif de l’événement : ${l.evenementMotif}`);
  if (!l.instrumentationStructuree) {
    out.push('    Trace structurée absente : livraison antérieure à l’instrumentation (aucune cause reconstruite).');
  }
  return out;
}

/**
 * Texte de « Copier le diagnostic » : lisible, prêt à coller dans un message
 * à l'équipe technique. Même expurgation que l'écran et que le fichier.
 */
export function formatDiagnosticTexte(o: {
  perimetre: PerimetreDiagnostic;
  synthese: SyntheseDiagnostic;
  agregats: AgregatCode[];
  lignes: LigneDiagnostic[];
  sections: SectionCompletude[];
  champsNonEnregistres: string[];
  configurationPush: Record<string, unknown>;
  file: Record<string, unknown>;
  /** Vrai si les lignes copiées ne sont qu'une partie du périmètre. */
  partiel: boolean;
}): string {
  const p = o.perimetre;
  const l: string[] = [];
  l.push('Diagnostic des notifications Verebona');
  l.push(TIRET);
  l.push(`Identifiant du diagnostic : ${p.identifiantDiagnostic}`);
  l.push(`Version du schéma : ${p.versionSchema}`);
  l.push(`Généré le : ${p.genereLe.paris} (Europe/Paris) · ${p.genereLe.iso}`);
  l.push(`Instantané de lecture : ${p.instantane.paris} (Europe/Paris) · ${p.instantane.iso}`);
  l.push(`Fenêtre de calcul : ${p.fenetre.libelle}`);
  l.push(`Environnement : ${p.environnement} · version ${p.build.version} · commit ${ouNonEnregistre(p.build.commit)}`);
  const filtres = Object.entries(p.filtres).filter(([, v]) => v !== null && v !== '');
  l.push(`Filtres : ${filtres.length ? filtres.map(([k, v]) => `${k}=${v}`).join(' · ') : 'aucun'}`);
  l.push('');
  l.push('Synthèse chiffrée');
  l.push(TIRET);
  l.push(`Livraisons : ${o.synthese.livraisons}`);
  l.push(`Événements de référence distincts : ${o.synthese.evenementsDistincts}`);
  l.push(`Tentatives cumulées des événements : ${o.synthese.tentativesEvenements}`);
  l.push(`Appareils concernés : ${o.synthese.appareils}`);
  for (const n of NATURES) {
    l.push(`  ${NATURE_LIBELLES[n]} : ${o.synthese.parNature[n] ?? 0}`);
  }
  l.push('');
  l.push('Causes par statut et code');
  l.push(TIRET);
  if (o.agregats.length === 0) l.push('Aucune livraison dans ce périmètre.');
  for (const a of o.agregats) {
    l.push(`  ${a.statut} · ${ouNonEnregistre(a.code)} · canal ${a.canal} → ${a.livraisons} livraison(s), ${a.evenementsDistincts} événement(s) distinct(s), ${a.appareils} appareil(s) — ${a.familleLibelle}`);
  }
  l.push('');
  l.push('État de la configuration du push mobile (aucune valeur secrète)');
  l.push(TIRET);
  for (const [k, v] of Object.entries(o.configurationPush)) {
    l.push(`  ${k} : ${v === null ? NON_ENREGISTRE : String(v)}`);
  }
  l.push('');
  l.push('File des événements de référence');
  l.push(TIRET);
  for (const [k, v] of Object.entries(o.file)) {
    l.push(`  ${k} : ${v === null ? NON_ENREGISTRE : String(v)}`);
  }
  l.push('');
  l.push('Chronologie des tentatives');
  l.push(TIRET);
  if (o.lignes.length === 0) l.push('Aucune tentative dans ce périmètre.');
  for (const ligne of o.lignes) l.push(...ligneTexte(ligne), '');
  l.push('Complétude');
  l.push(TIRET);
  for (const s of o.sections) {
    l.push(`  ${s.nom} : ${s.statut}${s.attendu !== null ? ` (attendu ${s.attendu}, obtenu ${s.exporte ?? 0})` : ''}${s.motif ? ` — ${s.motif}` : ''}`);
  }
  if (o.champsNonEnregistres.length) {
    l.push('');
    l.push('Éléments non disponibles (jamais reconstruits) :');
    for (const c of o.champsNonEnregistres) l.push(`  • ${c}`);
  }
  if (o.partiel) {
    l.push('');
    l.push('ATTENTION : cette copie ne contient qu’une partie du périmètre. Utilisez « Télécharger les résultats filtrés » pour l’ensemble.');
  }
  return `${l.join('\n')}\n`;
}

/** Un événement de référence et sa filiation, pour la copie d'un diagnostic individuel. */
export interface EnteteDossier {
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
}

/**
 * Texte de « Copier le diagnostic » d'UN événement de référence (#800 CA05 :
 * les deux actions sont aussi disponibles sur un diagnostic individuel).
 */
export function formatDossierTexte(o: {
  perimetre: PerimetreDiagnostic;
  evenement: EnteteDossier;
  evenementsApparentes: Array<{ id: string; statut: string; creeLe: { iso: string; paris: string } | null; tentatives: number }>;
  livraisons: LigneDiagnostic[];
  synthese: SyntheseDiagnostic;
  configurationPush: Record<string, unknown>;
  sections: SectionCompletude[];
  champsNonEnregistres: string[];
}): string {
  const e = o.evenement;
  const l: string[] = [];
  l.push(`Diagnostic d’un événement de référence — ${e.type}`);
  l.push(TIRET);
  l.push(`Identifiant du diagnostic : ${o.perimetre.identifiantDiagnostic}`);
  l.push(`Version du schéma : ${o.perimetre.versionSchema}`);
  l.push(`Généré le : ${o.perimetre.genereLe.paris} (Europe/Paris) · ${o.perimetre.genereLe.iso}`);
  l.push(`Environnement : ${o.perimetre.environnement} · version ${o.perimetre.build.version} · commit ${ouNonEnregistre(o.perimetre.build.commit)}`);
  l.push('');
  l.push('Événement de référence');
  l.push(TIRET);
  l.push(`Identifiant : ${e.id}`);
  l.push(`Type : ${e.type} · catégorie : ${ouNonEnregistre(e.categorie)} · priorité : ${e.priorite}`);
  l.push(`Statut : ${e.statut}${e.motif ? ` (motif : ${e.motif})` : ''}`);
  l.push(`Destinataire : utilisateur ${e.destinataireUtilisateurId} · compte ${ouNonEnregistre(e.compteId)}`);
  l.push(`Cloche obligatoire : ${e.obligatoireCloche ? 'oui' : 'non'} · E-mail obligatoire : ${e.obligatoireEmail ? 'oui' : 'non'}`);
  l.push(`Clé de déduplication (tronquée) : ${ouNonEnregistre(e.cleDeduplication)}`);
  l.push(`Tentatives enregistrées : ${e.tentatives}`);
  l.push(`Mise en file : ${e.creeLe ? `${e.creeLe.paris} · ${e.creeLe.iso}` : NON_ENREGISTRE}`);
  l.push(`Heure prévue : ${e.prevuLe ? `${e.prevuLe.paris} · ${e.prevuLe.iso}` : NON_ENREGISTRE}`);
  l.push(`Traité : ${e.traiteLe ? `${e.traiteLe.paris} · ${e.traiteLe.iso}` : NON_ENREGISTRE}`);
  l.push(`Dernière erreur (expurgée) : ${ouNonEnregistre(e.derniereErreur)}`);
  if (e.regroupeAvecId) l.push(`Regroupé avec l’événement de référence ${e.regroupeAvecId}`);
  l.push('');
  l.push('Événements apparentés (même clé de base — tentatives et réémissions, PAS des événements distincts)');
  l.push(TIRET);
  if (o.evenementsApparentes.length === 0) l.push('Aucun.');
  for (const a of o.evenementsApparentes) {
    l.push(`  • ${a.id} · statut ${a.statut} · ${a.creeLe ? a.creeLe.paris : NON_ENREGISTRE} · ${a.tentatives} tentative(s)`);
  }
  l.push('');
  l.push('Synthèse des livraisons');
  l.push(TIRET);
  l.push(`Livraisons : ${o.synthese.livraisons} · appareils : ${o.synthese.appareils}`);
  for (const n of NATURES) l.push(`  ${NATURE_LIBELLES[n]} : ${o.synthese.parNature[n] ?? 0}`);
  l.push('');
  l.push('Chronologie des tentatives');
  l.push(TIRET);
  if (o.livraisons.length === 0) l.push('Aucune livraison enregistrée.');
  for (const ligne of o.livraisons) l.push(...ligneTexte(ligne), '');
  l.push('État de la configuration du push mobile (aucune valeur secrète)');
  l.push(TIRET);
  for (const [k, v] of Object.entries(o.configurationPush)) l.push(`  ${k} : ${v === null ? NON_ENREGISTRE : String(v)}`);
  l.push('');
  l.push('Complétude');
  l.push(TIRET);
  for (const s of o.sections) {
    l.push(`  ${s.nom} : ${s.statut}${s.attendu !== null ? ` (attendu ${s.attendu}, obtenu ${s.exporte ?? 0})` : ''}${s.motif ? ` — ${s.motif}` : ''}`);
  }
  if (o.champsNonEnregistres.length) {
    l.push('');
    l.push('Éléments non disponibles (jamais reconstruits) :');
    for (const c of o.champsNonEnregistres) l.push(`  • ${c}`);
  }
  return `${l.join('\n')}\n`;
}
