/**
 * Lot 109F — DÉTECTION CENTRALISÉE DES E-MAILS JETABLES (service serveur
 * unique : `isDisposableEmailDomain` / `classifyEmailDomain`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Référentiel : liste publique « disposable-email-domains » (CC0 1.0),
 * VERSIONNÉE dans le dépôt (`data/`, version et empreinte dans
 * `data/source.json`), mise à jour par `npm run disposable-domains:update`.
 * Aucun appel externe, aucune adresse transmise à un tiers : seul le DOMAINE
 * est comparé, en mémoire.
 *
 * Ordre de décision (le premier qui s'applique) :
 *   1. liste d'autorisation (locale `LOCAL_ALLOWLIST` + DISPOSABLE_EMAIL_ALLOWLIST)
 *      sur le domaine ou l'un de ses parents → accepté (PRIORITAIRE) ;
 *   2. blocage d'urgence DISPOSABLE_EMAIL_EXTRA_BLOCKLIST → jetable ;
 *   3. référentiel embarqué → jetable ;
 *   4. sinon → accepté. Un domaine inconnu, personnalisé, un alias « + »,
 *      un MX partagé ou un relais de confidentialité ne rendent JAMAIS une
 *      adresse jetable (seul le domaine est lu, contre des entrées exactes).
 *
 * Référentiel embarqué illisible ou tronqué (« momentanément indisponible ») :
 * le contrôle s'applique avec les seules listes d'environnement, sans bloquer
 * les autres adresses, et le signale (`listAvailable: false`, journal unique).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { domainToASCII } from 'node:url';
import embeddedDomains from './data/disposable-domains.json';
import embeddedSource from './data/source.json';
import { DISPOSABLE_ENV, DISPOSABLE_LIST_MAX_AGE_DAYS, LOCAL_ALLOWLIST, MIN_MATCH_LABELS, MIN_VALID_LIST_SIZE } from './policy';

export { DISPOSABLE_EMAIL_MESSAGE, DISPOSABLE_EMAIL_NOT_ALLOWED } from './messages';

export type DisposableReason = 'blocklist' | 'extra_blocklist';

export interface DomainClassification {
  /** Domaine normalisé (ASCII, minuscules) ; `null` si l'adresse n'en a pas. */
  domain: string | null;
  disposable: boolean;
  /** Entrée de liste qui a décidé (domaine ou parent), si une liste a décidé. */
  matched: string | null;
  decidedBy: DisposableReason | 'allowlist' | null;
  /** Version du référentiel embarqué (métriques). */
  listVersion: string;
  listAvailable: boolean;
}

/**
 * Normalise un domaine (ou la partie domaine d'une adresse) : espaces (y
 * compris insécables / invisibles) retirés, NFC, minuscules, point final
 * retiré, forme internationale convertie en ASCII (punycode). `null` : vide.
 */
export function normalizeEmailDomain(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.normalize('NFC').replace(/[\s​-‍﻿]+/g, '');
  const at = s.lastIndexOf('@');
  let d = (at >= 0 ? s.slice(at + 1) : s).toLowerCase().replace(/\.+$/, '');
  if (!d) return null;
  if (/[^\x00-\x7f]/.test(d)) {
    const ascii = domainToASCII(d);
    if (ascii) d = ascii;
  }
  return d;
}

/** Domaine puis parents d'au moins `MIN_MATCH_LABELS` niveaux (`a.b.c.com` → `a.b.c.com`, `b.c.com`, `c.com`). */
export function domainCandidates(domain: string): string[] {
  const labels = domain.split('.');
  if (labels.some((l) => l === '')) return [domain];
  const out: string[] = [];
  for (let i = 0; labels.length - i >= MIN_MATCH_LABELS; i += 1) out.push(labels.slice(i).join('.'));
  return out;
}

// ── Référentiel embarqué ────────────────────────────────────────────────────

interface EmbeddedList { set: ReadonlySet<string>; available: boolean; version: string }
let embedded: EmbeddedList | null = null;
let overrideForTests: readonly string[] | null | undefined;
let unavailableLogged = false;

function loadEmbedded(): EmbeddedList {
  if (embedded) return embedded;
  const version = typeof embeddedSource?.version === 'string' ? embeddedSource.version : 'inconnue';
  const raw: unknown = overrideForTests === undefined ? embeddedDomains : overrideForTests;
  const list = Array.isArray(raw) ? raw.filter((d): d is string => typeof d === 'string') : [];
  const available = list.length >= MIN_VALID_LIST_SIZE;
  if (!available && !unavailableLogged) {
    unavailableLogged = true;
    console.error(`[disposable-email] référentiel embarqué indisponible ou tronqué (${list.length} domaines, version ${version}) : seules les listes DISPOSABLE_EMAIL_* s'appliquent.`);
  }
  embedded = { set: new Set(available ? list : []), available, version };
  return embedded;
}

/** Tests : remplace le référentiel embarqué (`null` : indisponible ; `undefined` : rétablit). */
export function setDisposableListForTests(domains: readonly string[] | null | undefined): void {
  overrideForTests = domains;
  embedded = null;
  unavailableLogged = false;
}

// ── Listes d'environnement (relues à chaque appel, mémorisées par valeur) ────

const envCache = new Map<string, ReadonlySet<string>>();
function envList(name: string): ReadonlySet<string> {
  const raw = process.env[name] ?? '';
  const hit = envCache.get(`${name}=${raw}`);
  if (hit) return hit;
  const set = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const d = normalizeEmailDomain(part);
    // Jamais un suffixe d'un seul niveau (« com ») : ce serait un blocage / une autorisation globale.
    if (d && d.split('.').length >= MIN_MATCH_LABELS) set.add(d);
  }
  if (envCache.size > 16) envCache.clear();
  envCache.set(`${name}=${raw}`, set);
  return set;
}

const localAllow: ReadonlySet<string> = new Set(LOCAL_ALLOWLIST.map((d) => normalizeEmailDomain(d)!).filter(Boolean));

// ── Classification ──────────────────────────────────────────────────────────

/** Classe l'adresse (ou le domaine) donnée. Pur hormis la lecture de l'environnement. */
export function classifyEmailDomain(emailOrDomain: unknown): DomainClassification {
  const list = loadEmbedded();
  const base = { listVersion: list.version, listAvailable: list.available };
  const domain = normalizeEmailDomain(emailOrDomain);
  if (!domain) return { domain: null, disposable: false, matched: null, decidedBy: null, ...base };
  const candidates = domainCandidates(domain);

  const envAllow = envList(DISPOSABLE_ENV.allowlist);
  const allowed = candidates.find((c) => localAllow.has(c) || envAllow.has(c));
  if (allowed) return { domain, disposable: false, matched: allowed, decidedBy: 'allowlist', ...base };

  const extra = envList(DISPOSABLE_ENV.extraBlocklist);
  const urgent = candidates.find((c) => extra.has(c));
  if (urgent) return { domain, disposable: true, matched: urgent, decidedBy: 'extra_blocklist', ...base };

  const listed = candidates.find((c) => list.set.has(c));
  if (listed) return { domain, disposable: true, matched: listed, decidedBy: 'blocklist', ...base };

  return { domain, disposable: false, matched: null, decidedBy: null, ...base };
}

/** Le domaine de cette adresse (ou ce domaine) est-il reconnu comme jetable ? */
export function isDisposableEmailDomain(emailOrDomain: unknown): boolean {
  return classifyEmailDomain(emailOrDomain).disposable;
}

/** État du référentiel (documentation, supervision) — jamais la liste elle-même. */
export function disposableListStatus(now = new Date()) {
  const list = loadEmbedded();
  const fetchedAt = typeof embeddedSource?.fetchedAt === 'string' ? embeddedSource.fetchedAt : null;
  const ageDays = fetchedAt ? Math.floor((now.getTime() - new Date(fetchedAt).getTime()) / 86_400_000) : null;
  return {
    source: embeddedSource?.repository ?? null,
    license: embeddedSource?.license ?? null,
    version: list.version,
    ref: embeddedSource?.ref ?? null,
    fetchedAt,
    count: list.set.size,
    available: list.available,
    ageDays,
    stale: ageDays == null || ageDays > DISPOSABLE_LIST_MAX_AGE_DAYS,
    allowlistOverrides: envList(DISPOSABLE_ENV.allowlist).size,
    extraBlocklist: envList(DISPOSABLE_ENV.extraBlocklist).size,
  };
}
