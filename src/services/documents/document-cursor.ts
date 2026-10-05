/**
 * Pagination par curseur des documents — ticket DOC-PERF.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN CURSEUR ET PAS OFFSET / LIMIT
 *
 * Avec OFFSET, la base relit et jette toutes les lignes précédentes à chaque
 * lot ; surtout, un document ajouté ou supprimé entre deux lots décale tout
 * le reste, d'où doublons et oublis. Le curseur (« keyset ») mémorise les
 * valeurs de tri du DERNIER document reçu et demande « ce qui vient après » :
 * le lot suivant ne dépend que de ces valeurs.
 *
 * ── UN ORDRE TOTAL, SINON RIEN ────────────────────────────────────────────
 *
 * Deux documents de même date seraient rendus dans un ordre arbitraire, et
 * la frontière entre deux lots pourrait passer entre eux : l'un apparaîtrait
 * deux fois, l'autre jamais. L'ordre se termine donc toujours par
 * l'identifiant, unique (`ORDER BY document_date DESC, …, id DESC`), et le
 * curseur porte TOUTES les composantes de l'ordre.
 *
 * ── VALEURS ABSENTES ──────────────────────────────────────────────────────
 *
 * Une date ou un bien absent passe en dernier dans les DEUX sens (`NULLS
 * LAST`), comme le tri historique de l'écran. La condition « après » en tient
 * compte : après une valeur renseignée viennent les valeurs suivantes PUIS
 * les absentes ; après une valeur absente, seules d'autres absentes.
 *
 * Ce module est pur : il décrit l'ordre et la condition sous forme d'arbre,
 * que le service traduit en SQL et que les tests évaluent en mémoire. Une
 * seule définition, deux interprétations — elles ne peuvent pas diverger.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { RUBRICS } from '@/lib/referential/v2/rubrics';
import type { FeedDirection, FeedSort } from '@/lib/documents/document-feed';

/** Composantes d'ordre connues du service. */
export type FeedKey =
  | 'rubricRank'
  | 'rubricCode'
  | 'uploadedAt'
  | 'documentDate'
  | 'title'
  | 'assetName'
  | 'id';

export interface KeyComponent {
  key: FeedKey;
  dir: FeedDirection;
  nullable: boolean;
}

/**
 * Rang d'une Rubrique dans l'ordre fonctionnel : « Sans rubrique » d'abord
 * (§4.4), puis l'ordre du référentiel, puis les codes inconnus (départagés
 * par leur code — voir `rubricsForPage`).
 */
export const UNFILED_RANK = -1;
export const UNKNOWN_RUBRIC_RANK = 1000;
export function rubricRank(code: string | null): number {
  if (!code) return UNFILED_RANK;
  const index = RUBRICS.findIndex((r) => r.code === code);
  return index >= 0 ? index : UNKNOWN_RUBRIC_RANK;
}

/**
 * Ordre global, explicite et déterministe.
 *
 * Regroupé : Rubrique (rang puis code) AVANT le tri choisi — chaque section
 * garde l'ordre global, et les lots remplissent les sections de haut en bas.
 * À valeur égale : date d'ajout la plus récente, puis identifiant.
 */
export function keyComponents(sort: FeedSort, dir: FeedDirection, grouped: boolean): KeyComponent[] {
  const out: KeyComponent[] = [];
  if (grouped) {
    out.push({ key: 'rubricRank', dir: 'asc', nullable: false }, { key: 'rubricCode', dir: 'asc', nullable: false });
  }
  switch (sort) {
    case 'added': out.push({ key: 'uploadedAt', dir, nullable: false }); break;
    case 'docDate': out.push({ key: 'documentDate', dir, nullable: true }); break;
    case 'title': out.push({ key: 'title', dir, nullable: false }); break;
    case 'bien': out.push({ key: 'assetName', dir, nullable: true }); break;
    case 'rubric':
      // Regroupé, la Rubrique ordonne déjà tout : la répéter ne changerait rien.
      if (!grouped) out.push({ key: 'rubricRank', dir, nullable: false }, { key: 'rubricCode', dir, nullable: false });
      break;
  }
  if (sort !== 'added') out.push({ key: 'uploadedAt', dir: 'desc', nullable: false });
  out.push({ key: 'id', dir: 'desc', nullable: false });
  return out;
}

// ── Condition « après le curseur » ───────────────────────────────────────

export type KeysetNode =
  | { op: 'false' }
  | { op: 'and' | 'or'; items: KeysetNode[] }
  | { op: 'cmp'; index: number; cmp: '>' | '<' | '=' }
  | { op: 'isNull'; index: number };

function after(c: KeyComponent, index: number, value: string | null): KeysetNode {
  // Après une valeur absente (rangée en dernier) : rien de plus loin.
  if (value === null) return { op: 'false' };
  const strict: KeysetNode = { op: 'cmp', index, cmp: c.dir === 'asc' ? '>' : '<' };
  return c.nullable ? { op: 'or', items: [strict, { op: 'isNull', index }] } : strict;
}

function equal(index: number, value: string | null): KeysetNode {
  return value === null ? { op: 'isNull', index } : { op: 'cmp', index, cmp: '=' };
}

/**
 * (k1 après v1) OU (k1 = v1 ET k2 après v2) OU … — la comparaison de tuples,
 * étendue aux sens mixtes et aux valeurs absentes.
 */
export function keysetCondition(components: KeyComponent[], values: Array<string | null>): KeysetNode {
  const branches: KeysetNode[] = components.map((c, i) => ({
    op: 'and',
    items: [...components.slice(0, i).map((_, j) => equal(j, values[j] ?? null)), after(c, i, values[i] ?? null)],
  }));
  return { op: 'or', items: branches };
}

// ── Curseur opaque ───────────────────────────────────────────────────────

/**
 * Le curseur porte la signature de l'ordre : renvoyé avec un autre tri, il
 * désignerait une position sans rapport. Il est refusé plutôt qu'interprété.
 */
export function orderSignature(sort: FeedSort, dir: FeedDirection, grouped: boolean): string {
  return `${sort}.${dir}.${grouped ? 1 : 0}`;
}

export function encodeFeedCursor(signature: string, values: Array<string | null>): string {
  return Buffer.from(JSON.stringify({ s: signature, k: values }), 'utf-8').toString('base64url');
}

/** `null` si le curseur est illisible, d'un autre ordre ou de mauvaise forme. */
export function decodeFeedCursor(cursor: string, signature: string, size: number): Array<string | null> | null {
  try {
    if (cursor.length > 2048) return null;
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as { s?: unknown; k?: unknown };
    if (raw.s !== signature || !Array.isArray(raw.k) || raw.k.length !== size) return null;
    if (!raw.k.every((v) => v === null || (typeof v === 'string' && v.length <= 1024))) return null;
    return raw.k as Array<string | null>;
  } catch {
    return null;
  }
}
