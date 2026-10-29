/**
 * Lot 97A — contexte BORNÉ d'une réévaluation T3 de l'identité d'une
 * Opération à plusieurs sources (contrat `t3-operation-identity-v1`).
 * `buildIdentityInput` est PUR ; `loadIdentityRaw` fait les lectures (aucune
 * écriture). Mêmes voisines et mêmes documents que la réévaluation T4
 * (`load.ts`) : une seule façon de lire le compte.
 */
import type postgres from 'postgres';
import type { ContextDocument, ContextOperation } from './contract';
import { fingerprintOf, type RawDocument, type RawOperation } from './context';
import { IDENTITY_CONTRACT_VERSION, IDENTITY_TASK, type IdentityInput, type IdentitySource } from './identity-contract';
import type { IdentityScope } from './identity-validate';

type Sql = postgres.Sql | postgres.TransactionSql;
type Row = Record<string, unknown>;

export interface RawIdentitySource {
  id: number;
  kind: string;
  fileId: number | null;
  candidateKey: string | null;
  matchMethod: string | null;
  role: string | null;
  /** Bloc candidat T1 du document (type, statut, synthèse, prestataire, indices). */
  payload: Record<string, unknown> | null;
  /** Rattachement confirmé par l'utilisateur ou l'exploitation (décision active). */
  userConfirmed: boolean;
}

export interface RawIdentity {
  today: string;
  accountId: number;
  operation: RawOperation;
  sources: RawIdentitySource[];
  neighbours: RawOperation[];
  documents: RawDocument[];
  request: string;
  assetLabels?: ReadonlyMap<number, string>;
}

export interface IdentityBounds { maxSources: number; maxNeighbours: number; maxDocuments: number; maxExcerptsPerDocument: number; maxExcerptLength: number }
export const DEFAULT_IDENTITY_BOUNDS: IdentityBounds = { maxSources: 30, maxNeighbours: 5, maxDocuments: 12, maxExcerptsPerDocument: 6, maxExcerptLength: 200 };

export interface BuiltIdentity {
  input: IdentityInput;
  scope: IdentityScope;
  /** Empreinte des ENTRÉES (hors date du jour) : mémoire anti-rappel. */
  fingerprint: string;
  /** Sources à décider au-delà de la borne : aucune demande (constat). */
  tooLarge: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const arr = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') as Array<Record<string, unknown>> : []);

const ATTACHED_BY: Record<string, IdentitySource['attachedBy']> = { M0: 'USER', M1: 'REFERENCE', M2: 'RULE', M3: 'AI' };

/** Entrée du contrat (pure, déterministe : même entrée → même empreinte). */
export function buildIdentityInput(raw: RawIdentity, bounds: IdentityBounds = DEFAULT_IDENTITY_BOUNDS): BuiltIdentity {
  const opRef = new Map<number, string>([[raw.operation.id, 'O1']]);
  const voisines = raw.neighbours.filter((n) => n.id !== raw.operation.id && n.active).sort((a, b) => a.id - b.id);
  const voisinesRetenues = voisines.slice(0, bounds.maxNeighbours);
  voisinesRetenues.forEach((n, i) => opRef.set(n.id, `O${i + 2}`));

  const sources = [...raw.sources].sort((a, b) => a.id - b.id);
  const aDecider = sources.filter((s) => s.kind === 'DOCUMENT' && s.fileId !== null && s.candidateKey !== null);
  const tooLarge = aDecider.length > bounds.maxSources;
  const retenues = sources.slice(0, bounds.maxSources);
  const fondatrice = sources[0]?.id ?? null;

  const docsParId = new Map(raw.documents.map((d) => [d.id, d]));
  const prioritaires = [...new Set([
    ...retenues.flatMap((s) => (s.fileId ? [s.fileId] : [])), ...raw.operation.fileIds, ...voisinesRetenues.flatMap((n) => n.fileIds),
  ])].filter((id) => docsParId.has(id));
  const docsRetenus = prioritaires.slice(0, bounds.maxDocuments);
  const docRef = new Map<number, string>(docsRetenus.map((id, i) => [id, `D${i + 1}`]));
  const ds = (ids: readonly number[]) => [...new Set(ids)].map((x) => docRef.get(x)).filter((x): x is string => !!x);
  const assetRef = (id: number) => (raw.assetLabels?.get(id) ? `${raw.assetLabels.get(id)} (#${id})` : `#${id}`);

  const operationOf = (o: RawOperation, ref: string, sharedWith?: RawOperation): ContextOperation => ({
    ref, type: o.typeCode, status: o.status, label: o.label, provider: o.provider,
    plannedDate: o.plannedDate, startDate: o.startDate, realizedDate: o.realizedDate, endDate: o.endDate,
    assets: o.assetIds.map(assetRef), equipments: o.equipmentIds.map((x) => `#${x}`), rooms: o.roomIds.map((x) => `#${x}`),
    amounts: o.amounts, references: o.references, documents: ds(o.fileIds),
    ...(sharedWith ? { sharedAssets: o.assetIds.filter((a) => sharedWith.assetIds.includes(a)).map(assetRef) } : {}),
  });

  const sourceRef = new Map(retenues.map((s, i) => [s.id, `S${i + 1}`]));
  const inputSources: IdentitySource[] = retenues.map((s) => {
    const p = obj(s.payload);
    const t = obj(p.temporalHints);
    const protege = s.userConfirmed || s.matchMethod === 'M0';
    return {
      ref: sourceRef.get(s.id)!, kind: s.kind, document: s.fileId ? docRef.get(s.fileId) ?? null : null,
      role: s.role ?? str(p.sourceRoleHint), type: str(p.typeHint), status: str(p.statusHint), summary: str(p.summary), provider: str(p.provider),
      dates: { plannedDate: str(t.plannedDate), startDate: str(t.startDate), realizedDate: str(t.realizedDate), endDate: str(t.endDate) },
      amounts: arr(p.financialHints).slice(0, 10).map((h) => `${String(h.role ?? '?')}${h.amountScope ? `/${String(h.amountScope)}` : ''} ${(Number(h.amountMinor) / 100).toFixed(2)} ${String(h.currency ?? '')}`.trim()),
      references: arr(p.businessReferences).slice(0, 10).map((r) => `${String(r.kind ?? 'OTHER')}:${String(r.value ?? '')}`),
      assets: arr(p.targetHints).slice(0, 10).map((h) => (h.entityId ? assetRef(Number(h.entityId)) : String(h.rawLabel ?? '')).slice(0, 80)).filter(Boolean),
      attachedBy: s.id === fondatrice ? 'FOUNDING' : ATTACHED_BY[s.matchMethod ?? ''] ?? (protege ? 'USER' : 'OTHER'),
      inScope: s.kind === 'DOCUMENT' && s.fileId !== null && s.candidateKey !== null,
      protected: protege,
    };
  });

  let extraitsRetires = 0;
  const documents: ContextDocument[] = docsRetenus.map((id) => {
    const x = docsParId.get(id)!;
    const extraits = x.excerpts.slice(0, bounds.maxExcerptsPerDocument).map((e) => e.slice(0, bounds.maxExcerptLength));
    extraitsRetires += Math.max(0, x.excerpts.length - extraits.length);
    return {
      ref: docRef.get(id)!, type: x.type, title: x.title, date: x.date, provider: x.provider, amounts: x.amounts, references: x.references,
      excerpts: extraits, operations: x.operationIds.map((o) => opRef.get(o)).filter((v): v is string => !!v),
    };
  });

  const input: IdentityInput = {
    contractVersion: IDENTITY_CONTRACT_VERSION, task: IDENTITY_TASK, today: raw.today,
    operation: operationOf(raw.operation, 'O1'),
    sources: inputSources,
    neighbours: voisinesRetenues.map((n) => operationOf(n, opRef.get(n.id)!, raw.operation)),
    documents, request: raw.request.slice(0, 300),
    bounds: {
      complete: !tooLarge && voisines.length <= bounds.maxNeighbours && prioritaires.length <= bounds.maxDocuments && extraitsRetires === 0,
      droppedSources: Math.max(0, sources.length - bounds.maxSources),
      droppedNeighbours: Math.max(0, voisines.length - bounds.maxNeighbours),
      droppedDocuments: Math.max(0, prioritaires.length - bounds.maxDocuments),
    },
  };
  const scope: IdentityScope = {
    accountId: raw.accountId, operationId: raw.operation.id,
    sources: retenues.map((s) => ({
      ref: sourceRef.get(s.id)!, sourceId: s.id, kind: s.kind, fileId: s.fileId, candidateKey: s.candidateKey,
      inScope: s.kind === 'DOCUMENT' && s.fileId !== null && s.candidateKey !== null, protected: s.userConfirmed || s.matchMethod === 'M0',
    })),
    operations: Object.fromEntries([...opRef].map(([id, ref]) => [ref, id])),
    documents: Object.fromEntries([...docRef].map(([id, ref]) => [ref, id])),
  };
  // Le motif de la demande ne fait pas partie de l'empreinte : la même situation n'est jamais redemandée.
  const { today: _t, request: _r, ...stable } = input;
  void _t; void _r;
  return { input, scope, fingerprint: fingerprintOf(stable), tooLarge };
}

/** Lectures du contexte (null : Opération introuvable dans le compte). */
export async function loadIdentityRaw(sql: Sql, accountId: number, operationId: number, opts: { today: string; request: string }): Promise<RawIdentity | null> {
  const { loadOperations, loadNeighbourIds, loadDocuments } = await import('./load');
  const [op] = await loadOperations(sql, accountId, [operationId]);
  if (!op) return null;
  const voisinesIds = await loadNeighbourIds(sql, accountId, op);
  const neighbours = await loadOperations(sql, accountId, voisinesIds);
  const r = await sql.unsafe<Row[]>(`
    SELECT s.id, s.source_kind, s.source_entity_key, s.locator ->> 'candidateKey' AS candidate_key, s.match_method, s.source_role,
           (SELECT c.payload FROM document_operation_candidates c
             WHERE c.account_id = s.account_id AND s.source_kind = 'DOCUMENT' AND c.file_id::text = s.source_entity_key
               AND c.candidate_key = s.locator ->> 'candidateKey' AND c.status = 'ACTIVE' ORDER BY c.id DESC LIMIT 1) AS payload,
           EXISTS (SELECT 1 FROM business_operation_match_decisions d
                    WHERE d.account_id = s.account_id AND d.active AND d.decision = 'CONFIRMED' AND d.candidate_operation_id = s.operation_id
                      AND d.source_kind = s.source_kind AND d.source_entity_key = s.source_entity_key
                      AND d.origin IN ('USER_ARBITRATION', 'ADMIN_REVIEW')) AS user_confirmed
      FROM business_operation_sources s
     WHERE s.account_id = $1 AND s.operation_id = $2 AND s.active ORDER BY s.id LIMIT 60`, [accountId, operationId] as never[]);
  const sources: RawIdentitySource[] = r.map((x) => {
    const doc = x.source_kind === 'DOCUMENT' && /^\d+$/.test(String(x.source_entity_key));
    let payload = x.payload as Record<string, unknown> | string | null;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload) as Record<string, unknown>; } catch { payload = null; } }
    return {
      id: Number(x.id), kind: String(x.source_kind), fileId: doc ? Number(x.source_entity_key) : null,
      candidateKey: doc && x.candidate_key ? String(x.candidate_key) : null, matchMethod: (x.match_method as string | null) ?? null,
      role: (x.source_role as string | null) ?? null, payload: payload as Record<string, unknown> | null, userConfirmed: x.user_confirmed === true,
    };
  });
  const fichiers = [...sources.flatMap((s) => (s.fileId ? [s.fileId] : [])), ...neighbours.flatMap((n) => n.fileIds)];
  const documents = await loadDocuments(sql, accountId, fichiers.slice(0, 60));
  const noms = await sql.unsafe<Row[]>(`SELECT id, name FROM assets WHERE account_id = $1 AND id = ANY($2::int[])`,
    [accountId, `{${[...new Set([...op.assetIds, ...neighbours.flatMap((n) => n.assetIds)])].join(',')}}`] as never[]);
  return {
    today: opts.today, accountId, operation: op, sources, neighbours, documents, request: opts.request,
    assetLabels: new Map(noms.map((x) => [Number(x.id), String(x.name ?? '')]).filter(([, n]) => n) as Array<[number, string]>),
  };
}
