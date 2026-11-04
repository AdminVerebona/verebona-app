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
 * Lot 108J : les invitations ne sont PLUS affichées à l'accueil (le ticket
 * « Suggestions de l'accueil et de T2 » ne garde que des questions, servies
 * par le service unique) ; la rotation, le catalogue éditorial et « Autre
 * suggestion » sont supprimés. La table `home_suggestion_skips` (1005) est
 * conservée, plus lue ni écrite.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { EMOJI, TUTOIEMENT } from './t6-contract';
import { normalizeForFingerprint } from './t6-interpellation';
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

// Lot 108J : rotation, catalogue éditorial d'invitations et « Autre
// suggestion » (repos de 14 jours) SUPPRIMÉS — chemins concurrents du service
// unique des suggestions partagées (`src/services/suggestions/shared`), qui
// ne propose que des QUESTIONS. Restent ici le contrat et la validation des
// éléments `DISCOVERY` d'une sortie T6 (prompt maître, corpus rejoué,
// registre de conformité), sans effet sur l'accueil.

// ── Contexte T6 (contrat `t6-discovery-v1`, corpus et qualification) ───────

/** Jour (entier) d'une date `AAAA-MM-JJ`. */
export function dayIndexOf(day: string): number {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor(t / 86_400_000) : 0;
}

/** Univers dans l'ordre du jour (pur). */
export function universeOrder(seed: number, day: number): MascotDiscoveryUniverse[] {
  const n = MASCOT_DISCOVERY_UNIVERSES.length;
  const start = ((seed + day) % n + n) % n;
  return MASCOT_DISCOVERY_UNIVERSES.map((_, i) => MASCOT_DISCOVERY_UNIVERSES[(start + i) % n]);
}

/** Section du contexte T6 du contrat (pure) — qualification et corpus seulement depuis le lot 108J. */
export function discoveryContextOf(seed: number, day: number): T6DiscoveryContext {
  return { contract: T6_DISCOVERY_CONTRACT, universes: universeOrder(seed, day), documentKinds: [...MASCOT_DISCOVERY_DOCUMENT_KINDS], max: MAX_T6_DISCOVERY };
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
