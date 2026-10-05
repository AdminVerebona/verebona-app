/**
 * Retour sur « Mes documents » sans repartir en haut — ticket DOC-PERF.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST GARDÉ, POUR COMBIEN DE TEMPS, ET OÙ
 *
 * L'utilisateur a chargé 250 documents, ouvre le 187e, revient : il doit
 * retrouver ses filtres, son tri, les lots déjà chargés et sa position.
 *
 * · Stockage de SESSION (onglet courant) et non local : ce n'est pas une
 *   préférence. Les filtres ne sont jamais mémorisés d'une visite à l'autre
 *   (`view-prefs.ts`) ; ils le sont le temps d'un aller-retour.
 * · Durée bornée (10 minutes) : au-delà, la liste serait trop ancienne pour
 *   être montrée sans la recharger.
 * · Taille bornée (300 documents, coupés à une fin de lot) : on ne conserve
 *   pas des milliers d'objets pour un retour. Les lots suivants seront
 *   redemandés au défilement, à partir du curseur de la coupure.
 *
 * Le tri et le regroupement sont déjà mémorisés par `view-prefs.ts` ; la clé
 * de requête enregistrée garantit qu'une liste n'est restaurée que pour les
 * mêmes critères.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { FeedMeta } from '@/lib/documents/document-feed';
import type { PageEnd } from './documents-feed';
import type { DocumentItem, ViewFilters } from './documents-view';

export const RESTORE_MAX_DOCUMENTS = 300;
export const RESTORE_TTL_MS = 10 * 60 * 1000;

export interface ListSnapshot {
  v: 1;
  key: string;
  filters: ViewFilters;
  documents: DocumentItem[];
  meta: FeedMeta | null;
  nextCursor: string | null;
  pageEnds: PageEnd[];
  scrollTop: number;
  savedAt: number;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const PREFIX = 'verebona.documents.liste.v1.';
export const snapshotStorageKey = (scope: string) => PREFIX + scope;

function storageOrNull(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null; // accès refusé (navigation privée, iframe sandbox)
  }
}

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Valide un instantané lu ; `null` s'il est absent, expiré, trop gros ou malformé. */
export function parseSnapshot(raw: unknown, now: number): ListSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const f = o.filters as Record<string, unknown> | undefined;
  if (o.v !== 1 || typeof o.key !== 'string' || typeof o.savedAt !== 'number') return null;
  if (now - o.savedAt > RESTORE_TTL_MS || o.savedAt > now + 60_000) return null;
  if (!f || !isStringList(f.biens) || !isStringList(f.rubrics) || !isStringList(f.types)) return null;
  if (!Array.isArray(o.documents) || o.documents.length > RESTORE_MAX_DOCUMENTS) return null;
  if (!Array.isArray(o.pageEnds)) return null;
  if (o.nextCursor !== null && typeof o.nextCursor !== 'string') return null;
  return {
    v: 1,
    key: o.key,
    filters: { biens: f.biens, rubrics: f.rubrics, types: f.types },
    documents: o.documents as DocumentItem[],
    meta: (o.meta ?? null) as FeedMeta | null,
    nextCursor: o.nextCursor as string | null,
    pageEnds: o.pageEnds as PageEnd[],
    scrollTop: typeof o.scrollTop === 'number' && o.scrollTop > 0 ? o.scrollTop : 0,
    savedAt: o.savedAt,
  };
}

/** Lit l'instantané d'un écran, puis l'efface : il ne sert qu'à UN retour. */
export function takeListSnapshot(scope: string, now = Date.now(), storage?: StorageLike | null): ListSnapshot | null {
  const s = storageOrNull(storage);
  if (!s) return null;
  try {
    const brut = s.getItem(snapshotStorageKey(scope));
    s.removeItem(snapshotStorageKey(scope));
    return brut ? parseSnapshot(JSON.parse(brut), now) : null;
  } catch {
    return null;
  }
}

export function saveListSnapshot(scope: string, snapshot: ListSnapshot, storage?: StorageLike | null): void {
  const s = storageOrNull(storage);
  if (!s || snapshot.documents.length === 0 || snapshot.documents.length > RESTORE_MAX_DOCUMENTS) return;
  try {
    s.setItem(snapshotStorageKey(scope), JSON.stringify(snapshot));
  } catch {
    /* quota dépassé ou stockage bloqué : le retour repartira du premier lot */
  }
}

/**
 * Efface tous les instantanés de listes (changement de session ou de compte) :
 * un retour arrière ne doit jamais réafficher les documents d'un autre compte.
 */
export function purgeListSnapshots(storage?: StorageLike & Pick<Storage, 'length' | 'key'> | null): void {
  let s: (StorageLike & Pick<Storage, 'length' | 'key'>) | null = null;
  try {
    s = storage !== undefined ? storage : (typeof window !== 'undefined' ? window.sessionStorage : null);
  } catch { s = null; }
  if (!s) return;
  try {
    const cles: string[] = [];
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      if (k && k.startsWith(PREFIX)) cles.push(k);
    }
    for (const k of cles) s.removeItem(k);
  } catch { /* stockage indisponible */ }
}

if (typeof window !== 'undefined') {
  window.addEventListener('verebona:session-changed', () => purgeListSnapshots());
}
