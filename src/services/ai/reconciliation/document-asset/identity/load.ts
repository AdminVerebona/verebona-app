/**
 * Chargement du GRAPHE D'IDENTITÉ d'un compte depuis la connaissance
 * PERSISTÉE (lot 105D, ticket « Rattachement rétroactif après création d'un
 * bien », §D1, §D4). Lecture seule, aucun appel modèle, jamais T1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Lectures GROUPÉES par compte (jamais une requête par document) :
 *   · documents visibles analysés du compte : sans bien principal
 *     (« orphelins », même définition que le balayage T3) ou rattachés
 *     (« ancres » : bien principal connu) ;
 *   · lot 108E (A1) : TOUTE la connaissance T1 persistée (`sources.ts`) —
 *     extraction, transcription INTÉGRALE (plus de fenêtre), faits actifs,
 *     unités source et tableaux, faits non résolus, preuves de T1, relations
 *     d'événements de référence — par pages de documents ;
 *   · décisions ACTIVES de l'utilisateur sur les groupes (table 0995).
 * Pages techniques transparentes (`PAGE`), AUCUNE limite de découverte.
 *
 * Mémorisé PAR INDEX DE RAPPROCHEMENT (`AccountMatchingIndex`, construit une
 * fois par passage / page de balayage) : un même passage ne relit pas le
 * compte pour chaque document.
 *
 * Lot 108E (A5) : l'issue est EXPLICITE (`identityGraphOutcomeFor`) —
 * OK, DISABLED (coupure volontaire `T3_IDENTITY_GROUPS_ENABLED=0` :
 * comportement d'avant le lot 105D), MIGRATION_MISSING (tables 0995
 * absentes) ou UNAVAILABLE (lecture en échec). Une panne n'est JAMAIS
 * confondue avec une coupure : la phase et chaque document la portent
 * (Supervision, aucune carte métier, reprise au passage suivant).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import type { AccountMatchingIndex } from '../matching-index';
import { buildIdentityGraph, type AccountIdentityGraph, type GraphDecision, type GraphDocument } from './graph';
import { extractIdentityProfile } from './signals';
import { identityGroupsEnabled } from './contract';
import { identityLayers, loadIdentityInputs, PAGE_DOCUMENTS, type IdentitySourceCoverage } from './sources';

const PAGE = 500;

/** Condition SQL : document visible, analysé, non brouillon / ignoré (alias `f`). */
const VISIBLE = `f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL AND COALESCE(f.upload_status, 'COMPLETED') = 'COMPLETED'
  AND COALESCE(f.is_draft, false) = false AND COALESCE(f.is_ignored, false) = false`;

interface DocRow { id: number; orphan: boolean; primary_ids: number[] | null; user_decided: boolean }

async function listDocuments(accountId: number): Promise<DocRow[]> {
  const out: DocRow[] = [];
  let after = 0;
  for (;;) {
    const rows = (await pgClient.unsafe(
      `SELECT f.id,
              (f.asset_id IS NULL AND f.linked_asset_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND l.asset_id IS NOT NULL
                                 AND (l.link_role = 'PRIMARY' OR l.origin = 'USER'))) AS orphan,
              COALESCE((f.user_edited_fields ->> 'assetId')::boolean, false) AS user_decided,
              ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[f.asset_id] || ARRAY(
                       SELECT l.asset_id FROM document_asset_links l
                        WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND l.asset_id IS NOT NULL AND l.link_role = 'PRIMARY')) x
                     WHERE x IS NOT NULL) AS primary_ids
         FROM asset_files f
         JOIN document_extractions e ON e.file_id = f.id AND e.account_id = f.account_id
        WHERE f.account_id = $1 AND f.id > $2 AND ${VISIBLE}
        ORDER BY f.id LIMIT ${PAGE}`,
      [accountId, after] as never[],
    )) as unknown as DocRow[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
    after = Number(rows[rows.length - 1].id);
  }
}

/** Décisions ACTIVES de l'utilisateur sur les groupes du compte. Lève sur une lecture en échec (lot 108E : jamais « aucune décision » par erreur). */
export async function loadGroupDecisions(accountId: number): Promise<GraphDecision[]> {
  const rows = (await pgClient.unsafe(
    `SELECT id, group_key, asset_id, decision, context_fingerprint FROM document_identity_decisions
      WHERE account_id = $1 AND status = 'ACTIVE' ORDER BY id`,
    [accountId] as never[],
  )) as unknown as Array<{ id: number; group_key: string; asset_id: number; decision: 'CONFIRMED' | 'REFUSED'; context_fingerprint: string }>;
  return rows.map((r) => ({ id: Number(r.id), groupKey: r.group_key, assetId: Number(r.asset_id), decision: r.decision, contextFingerprint: r.context_fingerprint }));
}

/** Migrations du graphe présentes ? (0995 : tables ; 1060 : famille EQUIPMENT admise). Ne lève pas. */
export interface IdentityMigrations { m0995: boolean; m1060: boolean }

export async function identityMigrations(sql: Pick<typeof pgClient, 'unsafe'> = pgClient): Promise<IdentityMigrations> {
  try {
    const [r] = (await sql.unsafe(
      `SELECT to_regclass('document_identity_groups') IS NOT NULL AND to_regclass('document_identity_decisions') IS NOT NULL AS m0995,
              COALESCE((SELECT pg_get_constraintdef(c.oid) LIKE '%EQUIPMENT%' FROM pg_constraint c
                         WHERE c.conname = 'document_identity_groups_family_chk' LIMIT 1), false) AS m1060`,
    )) as unknown as Array<{ m0995: boolean; m1060: boolean }>;
    return { m0995: r?.m0995 === true, m1060: r?.m1060 === true };
  } catch {
    return { m0995: false, m1060: false };
  }
}

/** Construit le graphe d'identité du compte (lectures groupées, par pages). Lève sur une lecture en échec. */
export async function loadAccountIdentityGraph(accountId: number, index: AccountMatchingIndex): Promise<AccountIdentityGraph> {
  const docs = (await listDocuments(accountId)).filter((d) => d.orphan ? !d.user_decided : (d.primary_ids?.length ?? 0) > 0);
  const [decisions, layers] = await Promise.all([loadGroupDecisions(accountId), identityLayers(pgClient as never)]);
  const documents: GraphDocument[] = [];
  const coverage = new Map<number, IdentitySourceCoverage>();
  // Page par page : profils calculés, textes libérés (mémoire bornée, découverte complète).
  for (let i = 0; i < docs.length; i += PAGE_DOCUMENTS) {
    const page = docs.slice(i, i + PAGE_DOCUMENTS);
    const inputs = await loadIdentityInputs(pgClient as never, accountId, page.map((d) => Number(d.id)), layers);
    for (const d of page) {
      const it = inputs.get(Number(d.id));
      if (!it) continue;
      documents.push({ profile: extractIdentityProfile(it.input), orphan: d.orphan, primaryAssetIds: (d.primary_ids ?? []).map(Number) });
      if (d.orphan) coverage.set(Number(d.id), it.coverage);
    }
  }
  const graph = buildIdentityGraph({ accountId, documents, assets: index.assets, decisions, entities: index.entities });
  graph.coverage = coverage;
  return graph;
}

/** Issue explicite du graphe (lot 108E, A5). */
export type IdentityGraphStatus = 'OK' | 'DISABLED' | 'MIGRATION_MISSING' | 'UNAVAILABLE';
export interface IdentityGraphOutcome {
  status: IdentityGraphStatus;
  graph: AccountIdentityGraph | null;
  /** Cause technique (sans valeur de document). */
  error: string | null;
  migrations: IdentityMigrations | null;
  durationMs: number;
}

/** Le graphe est-il en PANNE (≠ coupure volontaire) ? Pure. */
export function identityGraphFailed(o: Pick<IdentityGraphOutcome, 'status'> | null | undefined): boolean {
  return o?.status === 'UNAVAILABLE' || o?.status === 'MIGRATION_MISSING';
}

const memo = new WeakMap<AccountMatchingIndex, Promise<IdentityGraphOutcome>>();

/**
 * Issue du graphe d'identité du compte pour cet index (mémorisée tant que
 * l'index vit). Ne lève jamais : la panne est PORTÉE par l'issue.
 */
export function identityGraphOutcomeFor(accountId: number, index: AccountMatchingIndex): Promise<IdentityGraphOutcome> {
  if (!identityGroupsEnabled()) return Promise.resolve({ status: 'DISABLED', graph: null, error: null, migrations: null, durationMs: 0 });
  let p = memo.get(index);
  if (!p) {
    p = (async (): Promise<IdentityGraphOutcome> => {
      const t0 = Date.now();
      const migrations = await identityMigrations();
      if (!migrations.m0995) {
        console.error(`[t3-identity] compte ${accountId} : migration 0995 absente (document_identity_groups / document_identity_decisions) — phase non exécutée.`);
        return { status: 'MIGRATION_MISSING', graph: null, error: 'MIGRATION_0995_MISSING', migrations, durationMs: Date.now() - t0 };
      }
      try {
        const graph = await loadAccountIdentityGraph(accountId, index);
        return { status: 'OK', graph, error: null, migrations, durationMs: Date.now() - t0 };
      } catch (e) {
        const msg = (e as Error).message.slice(0, 300);
        console.error(`[t3-identity] graphe d'identité du compte ${accountId} illisible :`, msg);
        return { status: 'UNAVAILABLE', graph: null, error: msg, migrations, durationMs: Date.now() - t0 };
      }
    })();
    memo.set(index, p);
  }
  return p;
}

/** Graphe du compte, ou `null` (coupure ou panne — voir `identityGraphOutcomeFor` pour les distinguer). */
export async function identityGraphFor(accountId: number, index: AccountMatchingIndex): Promise<AccountIdentityGraph | null> {
  return (await identityGraphOutcomeFor(accountId, index)).graph;
}
