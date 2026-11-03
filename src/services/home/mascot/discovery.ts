/**
 * Lot 106B — invitations de DÉCOUVERTE de l'accueil : contrat, validation,
 * rotation et suggestions passées (ticket « Mascotte — réparer les
 * suggestions et ajouter des invitations de découverte »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX USAGES DANS LA MÊME FONCTION DE SUGGESTIONS
 *
 *   A. questions personnalisées (contrat `t6-suggestions-v3`, lot 87C) :
 *      fondées sur les données du compte, preuves et répondabilité T2
 *      contrôlées — INCHANGÉES ;
 *   B. invitations de découverte (contrat `t6-discovery-v1`, ce module) :
 *      inviter à ajouter un type de document des biens Verebona, avec un
 *      bénéfice concret. Elles NE dépendent PAS du contenu du compte : ni
 *      bien correspondant, ni preuve, ni échéance, ni anomalie — et donc
 *      AUCUNE référence de preuve (une référence citée est un rejet).
 *
 * Contrôles propres aux invitations (rejet individuel, motif structuré) :
 *   · structure : `kind` = "DISCOVERY", texte d'une ligne, longueur bornée,
 *     ni emoji ni tutoiement ;
 *   · référentiels fermés : univers (logement, véhicule, objet /
 *     équipement) et type de document ;
 *   · aucune référence (`groundRefs`, `assetRef`, `deadlineRef`) ;
 *   · aucune affirmation personnelle (« votre », « vos », « il vous
 *     manque », « vous avez »…), aucune donnée du compte citée (nom d'un
 *     bien, libellé d'une échéance), aucun chiffre ;
 *   · aucune promesse que le document ne tient pas forcément (« expire »,
 *     « prochaine intervention »…) ;
 *   · périmètre des biens : ni santé, ni scolarité, ni identité personnelle.
 * Ce sont des contrôles de CONTRAT et de formulation, jamais un catalogue de
 * phrases imposé à T6.
 *
 * Rotation (pure) : univers servis à tour de rôle (point de départ qui
 * change chaque jour et par utilisateur), les deux premières invitations
 * toujours d'univers différents, une réserve pour « Autre suggestion ». Aucun
 * appel IA : la rotation porte sur des invitations déjà validées (sortie T6
 * en cache, ou catalogue éditorial — `discovery-catalog.ts`).
 *
 * Suggestions passées (« Autre suggestion ») : préférence PERSONNELLE de
 * l'utilisateur (`home_suggestion_skips`, migration 1005), jamais une tâche
 * « À traiter », une alerte ni un retard. Une invitation passée n'est plus
 * proposée pendant `DISCOVERY_SKIP_REST_DAYS` jours.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DISCOVERY_CATALOG, type DiscoveryCatalogEntry } from './discovery-catalog';
import { EMOJI, TUTOIEMENT } from './t6-contract';
import { normalizeForFingerprint } from './t6-interpellation';
import { sha256 } from './hash';
import {
  MASCOT_DISCOVERY_DOCUMENT_KINDS, MASCOT_DISCOVERY_UNIVERSES,
  type MascotDiscoveryDocumentKind, type MascotDiscoveryInvitation, type MascotDiscoveryUniverse,
} from './types';

/** Contrat des invitations de découverte (prompt maître T6, étape 13 du guide du PO). */
export const T6_DISCOVERY_CONTRACT = 't6-discovery-v1';
/** Marqueur de sortie attendu dans le prompt (exemple d'élément de `suggestions`). */
export const T6_DISCOVERY_OUTPUT_MARKER = '"kind":"DISCOVERY"';
/** Invitations examinées au plus dans une sortie T6 (les suivantes sont rejetées, jamais substituées). */
export const MAX_T6_DISCOVERY = 2;
/** Invitations transmises au client (2 affichables + réserve « Autre suggestion »). */
export const DISCOVERY_LIST_MAX = 8;
/** Repos d'une suggestion passée : jours pendant lesquels elle n'est plus proposée. */
export const DISCOVERY_SKIP_REST_DAYS = 14;
/** Suggestions passées conservées au plus par utilisateur et par compte (les plus anciennes sont purgées). */
const SKIPS_MAX_PER_USER = 200;
const DISCOVERY_TEXT_MIN = 20;
const DISCOVERY_TEXT_MAX = 160;

/** Appel à l'action, par type de document (référentiel fermé, aucune règle métier). */
export const DISCOVERY_CTA: Readonly<Record<MascotDiscoveryDocumentKind, string>> = {
  INVOICE: 'Ajouter une facture',
  CONTRACT: 'Ajouter un contrat',
  DIAGNOSTIC: 'Ajouter un diagnostic',
  NOTICE: 'Ajouter une notice',
  WARRANTY: 'Ajouter une garantie',
  DOCUMENT: 'Ajouter un document',
};

/** Clé stable d'une invitation : univers et type de document (jamais le texte). */
export const discoveryKeyOf = (universe: MascotDiscoveryUniverse, documentKind: MascotDiscoveryDocumentKind) => `DISC:${universe}:${documentKind}`;

/** Motifs STRUCTURÉS de rejet d'une invitation (trace BO, aucune donnée personnelle). */
export const T6_DISCOVERY_REJECTIONS = [
  'discovery_unsupported', 'discovery_over_limit', 'discovery_format', 'discovery_universe', 'discovery_document_kind',
  'discovery_with_grounds', 'discovery_with_ref', 'discovery_personal_claim', 'discovery_cites_account',
  'discovery_specific_fact', 'discovery_unfounded_promise', 'discovery_out_of_scope',
] as const;
export type T6DiscoveryRejectReason = (typeof T6_DISCOVERY_REJECTIONS)[number];

/**
 * Section du contexte transmis à T6 quand le prompt porte le contrat :
 * univers dans l'ordre de rotation du jour, types de document admis.
 * Aucune donnée du compte (les invitations n'en dépendent pas).
 */
export interface T6DiscoveryContext {
  contract: typeof T6_DISCOVERY_CONTRACT;
  universes: MascotDiscoveryUniverse[];
  documentKinds: MascotDiscoveryDocumentKind[];
  max: number;
}

/** Portée de validation d'une invitation (serveur). */
export interface T6DiscoveryScope {
  /** Le prompt effectif porte le contrat et le contexte l'a proposé. */
  enabled: boolean;
  /** Noms normalisés des biens du compte (jamais cités par une invitation). */
  assetNames?: readonly string[];
  /** Libellés normalisés des échéances transmises ou écartées (jamais cités). */
  deadlineLabels?: readonly string[];
}

// ── Contrôles de formulation ────────────────────────────────────────────────

/** Tutoiement en inversion (« ajoute-tu »), comme pour les questions. */
const INVERSION_TU = /-(tu|toi)(?=[\s?,.!]|$)/i;
// Motifs appliqués au texte NORMALISÉ (minuscules, sans accents, ponctuation et apostrophes → espaces).
/** Affirmations personnelles : possession, manque, constat sur le compte. */
const AFFIRMATION_PERSONNELLE = [
  /\b(votre|vos)\b/, /\bvous manque/, /\bmanquant/, /\bvous n avez\b/, /\bn avez (pas|jamais|aucun)\b/, /\bvous avez\b/,
  /\bvous possedez\b/, /\bvous oubliez\b/,
];
/** Promesses que le document ne tient pas forcément (date, intervention, rappel). */
const PROMESSE = [
  /\bexpir/, /\barrivent? a echeance\b/, /\ben retard\b/, /\bbientot\b/, /\bprochaine?s? (intervention|echeance|revision|entretien|visite)/,
  /\bdate d expiration\b/, /\bnous vous rappellerons\b/, /\bvous serez (alerte|prevenu)/, /\bobligatoire\b/,
];
/** Hors du périmètre des biens Verebona (santé, scolarité, identité personnelle, revenus). */
const HORS_PERIMETRE = [
  /\bmedic/, /\bsante\b/, /\bordonnance/, /\bmutuelle\b/, /\bscolaire/, /\becole\b/, /\bbulletin\b/, /\bdiplome/,
  /\bcarte d identite\b/, /\bpasseport\b/, /\bpermis de conduire\b/, /\bcarte vitale\b/, /\bacte de naissance\b/,
  /\bimpot/, /\bfiche de paie\b/, /\bsalaire\b/,
];
const contient = (q: string, norm: string) => norm.length >= 3 && ` ${q} `.includes(` ${norm} `);

type BrutInvitation = { kind?: unknown; text?: unknown; universe?: unknown; documentKind?: unknown; groundRefs?: unknown; assetRef?: unknown; deadlineRef?: unknown };

/**
 * Validation d'UNE invitation (pure, testée). Ne corrige jamais : rejet
 * motivé. `origin` : invitation rédigée par T6 ou entrée du catalogue.
 */
export function validateDiscoveryInvitation(
  raw: unknown, scope: T6DiscoveryScope, origin: MascotDiscoveryInvitation['origin'] = 'AI',
): { ok: true; invitation: MascotDiscoveryInvitation } | { ok: false; reason: T6DiscoveryRejectReason } {
  const o = (raw && typeof raw === 'object' ? raw : null) as BrutInvitation | null;
  if (!o || o.kind !== 'DISCOVERY') return { ok: false, reason: 'discovery_format' };
  if (!scope.enabled) return { ok: false, reason: 'discovery_unsupported' };
  if (typeof o.text !== 'string' || /[\r\n]/.test(o.text)) return { ok: false, reason: 'discovery_format' };
  const text = o.text.replace(/\s+/g, ' ').trim();
  if (text.length < DISCOVERY_TEXT_MIN || text.length > DISCOVERY_TEXT_MAX || !/[.?]$/.test(text)) return { ok: false, reason: 'discovery_format' };
  if (EMOJI.test(text) || TUTOIEMENT.test(text) || INVERSION_TU.test(text)) return { ok: false, reason: 'discovery_format' };
  if (typeof o.universe !== 'string' || !(MASCOT_DISCOVERY_UNIVERSES as readonly string[]).includes(o.universe)) return { ok: false, reason: 'discovery_universe' };
  if (typeof o.documentKind !== 'string' || !(MASCOT_DISCOVERY_DOCUMENT_KINDS as readonly string[]).includes(o.documentKind)) return { ok: false, reason: 'discovery_document_kind' };
  // Aucune référence de preuve : une invitation ne s'appuie sur rien du compte.
  if (Array.isArray(o.groundRefs) ? o.groundRefs.length > 0 : o.groundRefs != null) return { ok: false, reason: 'discovery_with_grounds' };
  if (o.assetRef != null || o.deadlineRef != null) return { ok: false, reason: 'discovery_with_ref' };
  const q = normalizeForFingerprint(text);
  if (AFFIRMATION_PERSONNELLE.some((r) => r.test(q))) return { ok: false, reason: 'discovery_personal_claim' };
  if ((scope.assetNames ?? []).some((n) => contient(q, n)) || (scope.deadlineLabels ?? []).some((n) => n.length >= 4 && contient(q, n))) {
    return { ok: false, reason: 'discovery_cites_account' };
  }
  if (/\d/.test(text)) return { ok: false, reason: 'discovery_specific_fact' };
  if (PROMESSE.some((r) => r.test(q))) return { ok: false, reason: 'discovery_unfounded_promise' };
  if (HORS_PERIMETRE.some((r) => r.test(q))) return { ok: false, reason: 'discovery_out_of_scope' };
  const universe = o.universe as MascotDiscoveryUniverse;
  const documentKind = o.documentKind as MascotDiscoveryDocumentKind;
  return { ok: true, invitation: { key: discoveryKeyOf(universe, documentKind), universe, documentKind, text, cta: DISCOVERY_CTA[documentKind], origin } };
}

/** Le texte maître effectif porte-t-il le contrat des invitations (marqueur ET format de sortie) ? */
export function promptSupportsDiscovery(effectiveText: string | null | undefined): boolean {
  return !!effectiveText && effectiveText.includes(T6_DISCOVERY_CONTRACT) && effectiveText.includes(T6_DISCOVERY_OUTPUT_MARKER);
}

// ── Rotation ────────────────────────────────────────────────────────────────

/** Jour (entier) d'une date `AAAA-MM-JJ` : base de la rotation quotidienne. */
export function dayIndexOf(day: string): number {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor(t / 86_400_000) : 0;
}

/** Graine stable d'un utilisateur dans un compte (Duo : chacun sa rotation). */
export function discoverySeedOf(accountId: number, userId: number | null): number {
  return Number.parseInt(sha256(`${accountId}:${userId ?? 0}`).slice(0, 8), 16);
}

/** Univers dans l'ordre de rotation du jour (pur). */
export function universeOrder(seed: number, day: number): MascotDiscoveryUniverse[] {
  const n = MASCOT_DISCOVERY_UNIVERSES.length;
  const start = ((seed + day) % n + n) % n;
  return MASCOT_DISCOVERY_UNIVERSES.map((_, i) => MASCOT_DISCOVERY_UNIVERSES[(start + i) % n]);
}

/** Entrées du catalogue converties en invitations validées (une entrée invalide est ignorée). */
export function catalogInvitations(catalog: readonly DiscoveryCatalogEntry[] = DISCOVERY_CATALOG): MascotDiscoveryInvitation[] {
  const out: MascotDiscoveryInvitation[] = [];
  for (const e of catalog) {
    const v = validateDiscoveryInvitation({ kind: 'DISCOVERY', ...e }, { enabled: true }, 'CATALOG');
    if (v.ok) out.push(v.invitation);
  }
  return out;
}

/**
 * Ordre des invitations proposées (pur, testé) : invitations de T6 d'abord
 * (déjà validées), puis le catalogue, univers servis À TOUR DE RÔLE à partir
 * de l'univers du jour ; une clé passée récemment est exclue ; une seule
 * invitation par univers et type de document ; les deux premières toujours
 * d'univers différents quand c'est possible.
 */
export function rotateDiscovery(p: {
  ai?: readonly MascotDiscoveryInvitation[];
  catalog?: readonly MascotDiscoveryInvitation[];
  skipped?: ReadonlySet<string>;
  seed: number;
  day: number;
  max?: number;
}): MascotDiscoveryInvitation[] {
  const max = p.max ?? DISCOVERY_LIST_MAX;
  const skipped = p.skipped ?? new Set<string>();
  const vues = new Set<string>();
  const out: MascotDiscoveryInvitation[] = [];
  const prendre = (x: MascotDiscoveryInvitation) => {
    if (out.length >= max || skipped.has(x.key) || vues.has(x.key)) return;
    vues.add(x.key);
    out.push(x);
  };
  (p.ai ?? []).forEach(prendre);
  const ordre = universeOrder(p.seed, p.day);
  const catalogue = p.catalog ?? catalogInvitations();
  const files = new Map(ordre.map((u) => {
    const l = catalogue.filter((x) => x.universe === u);
    const k = l.length ? (p.seed + p.day) % l.length : 0;
    return [u, [...l.slice(k), ...l.slice(0, k)]] as [MascotDiscoveryUniverse, MascotDiscoveryInvitation[]];
  }));
  // L'univers qui suit la dernière invitation de T6 commence (alternance continue).
  let i = 0;
  const dernier = out.at(-1)?.universe;
  if (dernier) i = (ordre.indexOf(dernier) + 1) % ordre.length;
  for (let garde = 0; out.length < max && garde < catalogue.length * ordre.length + ordre.length; garde += 1) {
    const u = ordre[i % ordre.length];
    i += 1;
    const file = files.get(u)!;
    while (file.length) {
      const x = file.shift()!;
      if (!skipped.has(x.key) && !vues.has(x.key)) { prendre(x); break; }
    }
    if ([...files.values()].every((f) => f.length === 0)) break;
  }
  // Deux premières d'univers différents (une invitation de T6 en double univers recule).
  if (out.length > 2 && out[0].universe === out[1].universe) {
    const j = out.findIndex((x, k) => k > 1 && x.universe !== out[0].universe);
    if (j > 1) out.splice(1, 0, ...out.splice(j, 1));
  }
  return out;
}

/** Section du contexte T6 (pure) : univers du jour, types admis, plafond. */
export function discoveryContextOf(seed: number, day: number): T6DiscoveryContext {
  return { contract: T6_DISCOVERY_CONTRACT, universes: universeOrder(seed, day), documentKinds: [...MASCOT_DISCOVERY_DOCUMENT_KINDS], max: MAX_T6_DISCOVERY };
}

// ── Suggestions passées (préférence personnelle) ────────────────────────────

/** Format admis d'une clé de suggestion passée (invitation ou question T6). */
export const SKIP_KEY_PATTERN = /^(DISC:[A-Z]+:[A-Z]+|Q:T6:[^\r\n]{1,180})$/;

/**
 * Suggestions passées par l'utilisateur dans ce compte, encore au repos.
 * Table absente ou lecture impossible : aucune (jamais bloquant).
 */
export async function readSuggestionSkips(accountId: number, userId: number | null): Promise<Set<string>> {
  if (userId == null) return new Set();
  try {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(
      `SELECT suggestion_key AS k FROM home_suggestion_skips
        WHERE account_id = $1 AND user_id = $2 AND skipped_at > NOW() - ($3::int * INTERVAL '1 day')`,
      [accountId, userId, DISCOVERY_SKIP_REST_DAYS] as never[],
    )) as unknown as Array<{ k: string }>;
    return new Set(r.map((x) => x.k));
  } catch {
    return new Set();
  }
}

/**
 * Enregistre une suggestion passée (idempotent : la date de passage est
 * renouvelée). Aucune donnée métier, aucune tâche « À traiter ». Rend
 * `false` si l'écriture est impossible (table absente…).
 */
export async function recordSuggestionSkip(accountId: number, userId: number, key: string): Promise<boolean> {
  if (!SKIP_KEY_PATTERN.test(key)) return false;
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `INSERT INTO home_suggestion_skips (account_id, user_id, suggestion_key, skipped_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (account_id, user_id, suggestion_key) DO UPDATE SET skipped_at = EXCLUDED.skipped_at`,
      [accountId, userId, key] as never[],
    );
    // Purge bornée : au-delà du repos, ou au-delà du plafond par utilisateur.
    await pgClient.unsafe(
      `DELETE FROM home_suggestion_skips s
        WHERE s.account_id = $1 AND s.user_id = $2
          AND (s.skipped_at < NOW() - ($3::int * INTERVAL '1 day')
               OR s.id NOT IN (SELECT id FROM home_suggestion_skips WHERE account_id = $1 AND user_id = $2 ORDER BY skipped_at DESC LIMIT $4))`,
      [accountId, userId, DISCOVERY_SKIP_REST_DAYS, SKIPS_MAX_PER_USER] as never[],
    );
    return true;
  } catch (e) {
    console.error('[mascotte] suggestion passée non enregistrée :', (e as Error).message);
    return false;
  }
}

// ── Corpus rejoué (P-T6-DISC-*) ─────────────────────────────────────────────

/**
 * Lot 106B — évaluation d'un cas du corpus T6 FORMULATE portant des
 * invitations (pure) : validation SERVEUR réelle des éléments `DISCOVERY` de
 * la sortie, sur la portée construite depuis le contexte transmis (biens et
 * échéances nommés, section `discovery`). Attendu : `accepted` (clés, dans
 * l'ordre) et `rejected` (motifs, dans l'ordre). Rend la liste des écarts.
 */
export function evaluateDiscoveryCorpusCase(
  suggestionContext: unknown, output: unknown, expected: { accepted?: string[]; rejected?: string[] } | null | undefined,
): string[] {
  if (!expected) return [];
  const ctx = (suggestionContext ?? {}) as { discovery?: unknown; assets?: Array<{ name?: string }>; nextDeadlines?: Array<{ label?: string }> };
  const scope: T6DiscoveryScope = {
    enabled: !!ctx.discovery,
    assetNames: (ctx.assets ?? []).map((a) => normalizeForFingerprint(a.name ?? '')).filter((x) => x.length >= 3),
    deadlineLabels: (ctx.nextDeadlines ?? []).map((d) => normalizeForFingerprint(d.label ?? '')).filter((x) => x.length >= 4),
  };
  const items = ((output as { suggestions?: unknown[] } | null)?.suggestions ?? []).filter((x) => (x as { kind?: unknown } | null)?.kind === 'DISCOVERY');
  const accepted: string[] = [];
  const rejected: string[] = [];
  items.forEach((x, i) => {
    if (i >= MAX_T6_DISCOVERY) { rejected.push('discovery_over_limit'); return; }
    const v = validateDiscoveryInvitation(x, scope);
    if (!v.ok) { rejected.push(v.reason); return; }
    if (accepted.includes(v.invitation.key)) { rejected.push('duplicate'); return; }
    accepted.push(v.invitation.key);
  });
  const errs: string[] = [];
  if (expected.accepted && JSON.stringify(accepted) !== JSON.stringify(expected.accepted)) errs.push(`invitations acceptées ${JSON.stringify(accepted)} ≠ ${JSON.stringify(expected.accepted)}`);
  if (expected.rejected && JSON.stringify(rejected) !== JSON.stringify(expected.rejected)) errs.push(`invitations rejetées ${JSON.stringify(rejected)} ≠ ${JSON.stringify(expected.rejected)}`);
  return errs;
}
