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
 *   · faits ACTIFS d'identité (adresse, code postal, ville, cadastre,
 *     immatriculation, VIN, série, marque / modèle, contrats, DPE) ;
 *   · extraction : titre, description, type, fournisseur, multibiens, et la
 *     transcription — fenêtre `IDENTITY_TEXT_WINDOW` pour un orphelin,
 *     `ANCHOR_TEXT_WINDOW` pour une ancre (les adresses figurent en tête) ;
 *   · décisions ACTIVES de l'utilisateur sur les groupes (table 0995).
 * Pages techniques transparentes (`PAGE`), AUCUNE limite de découverte.
 *
 * Mémorisé PAR INDEX DE RAPPROCHEMENT (`AccountMatchingIndex`, construit une
 * fois par passage / page de balayage) : un même passage ne relit pas le
 * compte pour chaque document. Panne (table absente, lecture en échec) ou
 * coupure `T3_IDENTITY_GROUPS_ENABLED=0` : `null` — T3 se comporte comme
 * avant le lot 105D, jamais un blocage.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import type { AccountMatchingIndex } from '../matching-index';
import { buildIdentityGraph, type AccountIdentityGraph, type GraphDecision, type GraphDocument } from './graph';
import { extractIdentityProfile, IDENTITY_TEXT_WINDOW, type IdentityProfileInput } from './signals';
import { identityGroupsEnabled } from './contract';

const PAGE = 500;
/** Fenêtre de transcription lue pour un document DÉJÀ rattaché (ancre). */
const ANCHOR_TEXT_WINDOW = 8_000;

const IDENTITY_FACT_KEYS = [
  'address1', 'postalCode', 'city', 'cadastralRef', 'registrationNumber', 'vin', 'serialNumber', 'modelName', 'model', 'brand', 'make',
  'insuranceContractNumber', 'contractNumber', 'dpeAdemeNumber',
];

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

async function loadInputs(accountId: number, ids: number[], window: number): Promise<Map<number, IdentityProfileInput>> {
  const out = new Map<number, IdentityProfileInput>();
  for (let i = 0; i < ids.length; i += PAGE) {
    const page = ids.slice(i, i + PAGE);
    const [ext, facts] = await Promise.all([
      pgClient.unsafe(
        `SELECT file_id, title, description, document_type_code, supplier_name, multi_asset, left(COALESCE(full_text, ''), $3::int) AS txt
           FROM document_extractions WHERE account_id = $1 AND file_id = ANY($2::int[])`,
        [accountId, page, window] as never[],
      ) as unknown as Promise<Array<{ file_id: number; title: string | null; description: string | null; document_type_code: string | null; supplier_name: string | null; multi_asset: boolean | null; txt: string }>>,
      pgClient.unsafe(
        `SELECT file_id, canonical_key, label, subject, raw_key, excerpt, confidence,
                COALESCE(normalized_value, value_text, value_number::text) AS v
           FROM document_facts
          WHERE account_id = $1 AND file_id = ANY($2::int[]) AND status = 'active' AND canonical_key = ANY($3::text[])
          ORDER BY id`,
        [accountId, page, IDENTITY_FACT_KEYS] as never[],
      ) as unknown as Promise<Array<{ file_id: number; canonical_key: string | null; label: string | null; subject: string | null; raw_key: string | null; excerpt: string | null; confidence: string | null; v: string | null }>>,
    ]);
    for (const e of ext) {
      const texts: IdentityProfileInput['texts'][number][] = [];
      if (e.title) texts.push({ origin: 'EXTRACTION', zone: 'TITLE', text: e.title });
      if (e.description) texts.push({ origin: 'EXTRACTION', zone: 'DESCRIPTION', text: e.description });
      if (e.txt) texts.push({ origin: 'TRANSCRIPTION', zone: 'BODY', text: e.txt });
      out.set(Number(e.file_id), {
        fileId: Number(e.file_id), title: e.title, description: e.description, documentType: e.document_type_code,
        supplier: e.supplier_name, multiAsset: e.multi_asset, texts, facts: [],
      });
    }
    for (const f of facts) {
      const inp = out.get(Number(f.file_id));
      if (!inp) continue;
      (inp.facts as IdentityProfileInput['facts'][number][]).push({
        canonicalKey: f.canonical_key, label: f.label, subject: f.subject, rawKey: f.raw_key, excerpt: f.excerpt, confidence: f.confidence, value: f.v,
      });
    }
  }
  return out;
}

/** Décisions ACTIVES de l'utilisateur sur les groupes du compte (table absente : aucune). */
export async function loadGroupDecisions(accountId: number): Promise<GraphDecision[]> {
  const rows = (await pgClient.unsafe(
    `SELECT id, group_key, asset_id, decision, context_fingerprint FROM document_identity_decisions
      WHERE account_id = $1 AND status = 'ACTIVE' ORDER BY id`,
    [accountId] as never[],
  ).catch(() => [])) as unknown as Array<{ id: number; group_key: string; asset_id: number; decision: 'CONFIRMED' | 'REFUSED'; context_fingerprint: string }>;
  return rows.map((r) => ({ id: Number(r.id), groupKey: r.group_key, assetId: Number(r.asset_id), decision: r.decision, contextFingerprint: r.context_fingerprint }));
}

/** Construit le graphe d'identité du compte (lectures groupées). Lève sur une lecture en échec. */
export async function loadAccountIdentityGraph(accountId: number, index: AccountMatchingIndex): Promise<AccountIdentityGraph> {
  const docs = (await listDocuments(accountId)).filter((d) => d.orphan ? !d.user_decided : (d.primary_ids?.length ?? 0) > 0);
  const orphans = docs.filter((d) => d.orphan).map((d) => Number(d.id));
  const anchors = docs.filter((d) => !d.orphan).map((d) => Number(d.id));
  const [inO, inA, decisions] = await Promise.all([
    loadInputs(accountId, orphans, IDENTITY_TEXT_WINDOW), loadInputs(accountId, anchors, ANCHOR_TEXT_WINDOW), loadGroupDecisions(accountId),
  ]);
  const documents: GraphDocument[] = [];
  for (const d of docs) {
    const inp = (d.orphan ? inO : inA).get(Number(d.id));
    if (!inp) continue;
    documents.push({ profile: extractIdentityProfile(inp), orphan: d.orphan, primaryAssetIds: (d.primary_ids ?? []).map(Number) });
  }
  return buildIdentityGraph({ accountId, documents, assets: index.assets, decisions });
}

const memo = new WeakMap<AccountMatchingIndex, Promise<AccountIdentityGraph | null>>();

/**
 * Graphe d'identité du compte pour cet index (mémorisé tant que l'index vit).
 * `null` : coupure, table absente ou lecture en échec (journalisé) — jamais
 * une erreur pour T3.
 */
export function identityGraphFor(accountId: number, index: AccountMatchingIndex): Promise<AccountIdentityGraph | null> {
  if (!identityGroupsEnabled()) return Promise.resolve(null);
  let p = memo.get(index);
  if (!p) {
    p = loadAccountIdentityGraph(accountId, index).catch((e) => {
      console.error(`[t3-identity] graphe d'identité du compte ${accountId} illisible (comportement antérieur) :`, (e as Error).message);
      return null;
    });
    memo.set(index, p);
  }
  return p;
}
