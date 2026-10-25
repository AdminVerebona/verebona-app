/**
 * Lot 87B (CODE-01) — contexte LARGE et BORNÉ d'une réévaluation T4 de la
 * représentation Agenda d'une Opération. PUR : les lectures sont dans
 * `load.ts`.
 *
 * Le contexte ne se limite pas à un couple d'objets : l'Opération examinée,
 * ses voisines pertinentes (biens communs, période), TOUS les éléments
 * d'agenda liés ou candidats, les éléments absorbés par une ancienne
 * consolidation (restaurables), les documents sources avec leurs faits et
 * extraits, dates, biens, Pièces, équipements, montants, références,
 * relations existantes, décisions antérieures utiles et corrections de
 * l'utilisateur. Les bornes sont EXPLICITES (`bounds`) : un contexte tronqué
 * sur les éléments À DÉCIDER n'est jamais soumis (la décision serait prise
 * sans tout voir) ; seul le contexte d'appoint (voisines, documents, extraits)
 * peut être réduit, et la réduction est déclarée.
 *
 * Références opaques : le serveur garde la correspondance (`scope`) ; la
 * sortie de T4 est validée contre elle (`validate.ts`).
 */
import { createHash } from 'node:crypto';
import {
  REPRESENTATION_CONTRACT_VERSION, REPRESENTATION_TASK,
  type ContextAgendaItem, type ContextAmount, type ContextDocument, type ContextOperation, type ContextPriorDecision,
  type ContextReference, type ContextRestorable, type ContextUserDecision, type RepresentationInput,
} from './contract';

export interface RepresentationBounds {
  /** Éléments à décider au plus (au-delà : aucune demande, constat). */
  maxInScopeItems: number;
  /** Éléments de contexte (voisines) au plus. */
  maxContextItems: number;
  maxNeighbours: number;
  maxDocuments: number;
  maxExcerptsPerDocument: number;
  maxExcerptLength: number;
  maxRestorable: number;
}

export const DEFAULT_REPRESENTATION_BOUNDS: RepresentationBounds = {
  maxInScopeItems: 20, maxContextItems: 30, maxNeighbours: 5, maxDocuments: 12, maxExcerptsPerDocument: 6, maxExcerptLength: 200, maxRestorable: 10,
};

// ── Données lues (entrée du constructeur) ───────────────────────────────────

export interface RawOperation {
  id: number;
  typeCode: string | null;
  status: string;
  label: string | null;
  provider: string | null;
  plannedDate: string | null;
  startDate: string | null;
  realizedDate: string | null;
  endDate: string | null;
  active: boolean;
  assetIds: number[];
  equipmentIds: number[];
  roomIds: number[];
  fileIds: number[];
  amounts: ContextAmount[];
  references: ContextReference[];
}

export interface RawItem {
  id: number;
  title: string;
  date: string | null;
  nature: string | null;
  businessType: string | null;
  isAutomatic: boolean;
  isAutomaticModified: boolean;
  manualStatus: string | null;
  /** « à qualifier », prévision, confirmation de l'utilisateur, consolidation restaurée. */
  pendingStatus: boolean;
  confirmedByUser: boolean;
  projected: boolean;
  operationId: number | null;
  operationActive: boolean;
  role: 'PRINCIPAL' | 'RELATED' | null;
  roleOrigin: string | null;
  fileIds: number[];
  originFileId: number | null;
  sources: Array<{ fileId: number | null; role: string | null }>;
  assetIds: number[];
  /** Élément restauré par l'utilisateur / l'exploitation après une consolidation : choix humain. */
  restoredByUser: boolean;
}

export interface RawRestorable {
  journalId: number;
  absorbedItemId: number;
  principalItemId: number | null;
  title: string;
  date: string | null;
  businessType: string | null;
  fileIds: number[];
  reason: string;
  at: string;
  /** Ligne non restaurée et identifiant de l'élément libre (restaurable sans conflit). */
  restorable: boolean;
}

export interface RawDocument {
  id: number;
  type: string | null;
  title: string | null;
  date: string | null;
  provider: string | null;
  amounts: ContextAmount[];
  references: ContextReference[];
  excerpts: string[];
  operationIds: number[];
}

export interface RawUserDecisions {
  /** Éléments détachés de CETTE Opération par l'utilisateur (AGENDA REJECTED). */
  detachedItemIds: number[];
  /** Éléments rattachés à cette Opération par l'utilisateur (AGENDA CONFIRMED). */
  attachedItemIds: number[];
  /** Liens Document ↔ élément détachés (AGENDA_FILE_LINK REJECTED). */
  detachedLinks: Array<{ itemId: number; fileId: number }>;
  principalWithdrawn: boolean;
  /** Principal désigné par l'utilisateur (rôle d'origine USER), s'il existe. */
  userPrincipalItemId: number | null;
  /** Clés de projection supprimées par l'utilisateur. */
  suppressedKeys: string[];
}

export interface RawContext {
  today: string;
  accountId: number;
  operation: RawOperation;
  neighbours: RawOperation[];
  /** Éléments À DÉCIDER (liés à l'Opération, candidats sélectionnés). */
  scopeItems: RawItem[];
  /** Éléments de contexte (liés aux voisines). */
  contextItems: RawItem[];
  restorables: RawRestorable[];
  documents: RawDocument[];
  decisions: RawUserDecisions;
  prior: ContextPriorDecision[];
  assetLabels?: ReadonlyMap<number, string>;
}

// ── Correspondance serveur (jamais transmise) ───────────────────────────────

export interface ScopeItem {
  ref: string;
  id: number;
  inScope: boolean;
  operationId: number | null;
  operationActive: boolean;
  role: 'PRINCIPAL' | 'RELATED' | null;
  roleOrigin: string | null;
  projected: boolean;
  isAutomatic: boolean;
  /** Touché par l'utilisateur (saisi, modifié, statut, confirmé). */
  touched: boolean;
  pendingStatus: boolean;
  restoredByUser: boolean;
  userDetached: boolean;
  userAttached: boolean;
  /** Documents de l'élément (liens, origine, preuves) — protection des liens détachés par l'utilisateur. */
  fileIds: number[];
}

export interface ScopeRestorable { ref: string; journalId: number; absorbedItemId: number; principalItemId: number | null; restorable: boolean }

export interface RepresentationScope {
  accountId: number;
  operationId: number;
  operationActive: boolean;
  principalWithdrawn: boolean;
  userPrincipalItemId: number | null;
  /** Liens Document ↔ élément détachés par l'utilisateur (AGENDA_FILE_LINK REJECTED). */
  detachedLinks: Array<{ itemId: number; fileId: number }>;
  items: ScopeItem[];
  restorables: ScopeRestorable[];
  /** Références des documents (D…) → identifiants (preuves citées). */
  documents: Record<string, number>;
  /** Références des Opérations (O…) → identifiants. */
  operations: Record<string, number>;
}

export interface BuiltRepresentation {
  input: RepresentationInput;
  scope: RepresentationScope;
  /** Empreinte des ENTRÉES (hors date du jour) : mémoire anti-rappel. */
  fingerprint: string;
  /** Les éléments à décider dépassent la borne : aucune demande (constat). */
  tooLarge: boolean;
}

// ── Construction (pure) ─────────────────────────────────────────────────────

export const isTouchedItem = (i: Pick<RawItem, 'isAutomatic' | 'isAutomaticModified' | 'manualStatus' | 'confirmedByUser'>): boolean =>
  !i.isAutomatic || i.isAutomaticModified || (i.manualStatus !== null && i.manualStatus !== '') || i.confirmedByUser;

/** Sérialisation stable (clés triées) : empreintes reproductibles. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

export const fingerprintOf = (v: unknown): string => createHash('sha256').update(stableStringify(v)).digest('hex').slice(0, 32);

const uniq = (xs: readonly number[]) => [...new Set(xs)].filter((x) => Number.isSafeInteger(x));

/** Contexte de la réévaluation T4 (pur, déterministe : même entrée → même empreinte). */
export function buildRepresentationInput(raw: RawContext, bounds: RepresentationBounds = DEFAULT_REPRESENTATION_BOUNDS): BuiltRepresentation {
  const opRef = new Map<number, string>([[raw.operation.id, 'O1']]);
  const voisines = [...raw.neighbours].filter((n) => n.id !== raw.operation.id).sort((a, b) => a.id - b.id);
  const voisinesRetenues = voisines.slice(0, bounds.maxNeighbours);
  voisinesRetenues.forEach((n, i) => opRef.set(n.id, `O${i + 2}`));

  // Documents : ceux de l'Opération d'abord, puis ceux des éléments à décider, puis le reste ; bornés.
  const docsParId = new Map(raw.documents.map((d) => [d.id, d]));
  const prioritaires = uniq([
    ...raw.operation.fileIds,
    ...raw.scopeItems.flatMap((i) => [...i.fileIds, ...(i.originFileId ? [i.originFileId] : []), ...i.sources.map((s) => s.fileId ?? 0)]),
    ...raw.restorables.flatMap((r) => r.fileIds),
    ...voisinesRetenues.flatMap((n) => n.fileIds),
  ]).filter((id) => docsParId.has(id));
  const docsRetenus = prioritaires.slice(0, bounds.maxDocuments);
  const docRef = new Map<number, string>(docsRetenus.map((id, i) => [id, `D${i + 1}`]));
  const d = (id: number | null | undefined): string | null => (id == null ? null : docRef.get(id) ?? null);
  const ds = (ids: readonly number[]) => uniq(ids).map((x) => docRef.get(x)).filter((x): x is string => !!x);
  const assetRef = (id: number) => raw.assetLabels?.get(id) ? `${raw.assetLabels.get(id)} (#${id})` : `#${id}`;

  const operationOf = (o: RawOperation, ref: string, sharedWith?: RawOperation): ContextOperation => ({
    ref, type: o.typeCode, status: o.status, label: o.label, provider: o.provider,
    plannedDate: o.plannedDate, startDate: o.startDate, realizedDate: o.realizedDate, endDate: o.endDate,
    assets: o.assetIds.map(assetRef), equipments: o.equipmentIds.map((x) => `#${x}`), rooms: o.roomIds.map((x) => `#${x}`),
    amounts: o.amounts, references: o.references, documents: ds(o.fileIds),
    ...(sharedWith ? { sharedAssets: o.assetIds.filter((a) => sharedWith.assetIds.includes(a)).map(assetRef) } : {}),
  });

  const aDecider = [...raw.scopeItems].sort((a, b) => a.id - b.id);
  const tooLarge = aDecider.length > bounds.maxInScopeItems;
  const contexte = [...raw.contextItems].filter((i) => !aDecider.some((x) => x.id === i.id)).sort((a, b) => a.id - b.id);
  const contexteRetenu = contexte.slice(0, bounds.maxContextItems);
  const tous = [...aDecider.slice(0, bounds.maxInScopeItems), ...contexteRetenu];
  const itemRef = new Map<number, string>(tous.map((i, k) => [i.id, `A${k + 1}`]));
  const detaches = new Set(raw.decisions.detachedItemIds);
  const rattaches = new Set(raw.decisions.attachedItemIds);

  const items: ContextAgendaItem[] = tous.map((i) => ({
    ref: itemRef.get(i.id)!,
    title: i.title, date: i.date, nature: i.nature, businessType: i.businessType,
    origin: i.projected ? 'PROJECTION' : i.isAutomatic ? 'AUTOMATIC' : 'USER',
    touchedByUser: isTouchedItem(i),
    status: i.manualStatus,
    operationRef: i.operationId === null ? null : opRef.get(i.operationId) ?? (i.operationActive ? 'OTHER' : null),
    role: i.role, roleOrigin: i.roleOrigin,
    documents: ds(i.fileIds), originDocument: d(i.originFileId),
    sources: i.sources.slice(0, 10).map((s) => ({ document: d(s.fileId), role: s.role })),
    assets: i.assetIds.map(assetRef),
    inScope: aDecider.some((x) => x.id === i.id),
  }));

  const restRetenus = [...raw.restorables].sort((a, b) => a.journalId - b.journalId).slice(0, bounds.maxRestorable);
  const restorable: ContextRestorable[] = restRetenus.map((r, k) => ({
    ref: `R${k + 1}`, absorbedInto: r.principalItemId === null ? null : itemRef.get(r.principalItemId) ?? null,
    title: r.title, date: r.date, businessType: r.businessType, documents: ds(r.fileIds), reason: r.reason, at: r.at,
  }));

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

  const userDecisions: ContextUserDecision[] = [
    ...[...detaches].map((id) => ({ kind: 'ITEM_DETACHED' as const, item: itemRef.get(id) ?? null, operation: 'O1' })),
    ...[...rattaches].map((id) => ({ kind: 'ITEM_ATTACHED' as const, item: itemRef.get(id) ?? null, operation: 'O1' })),
    ...raw.decisions.detachedLinks.map((l) => ({ kind: 'LINK_DETACHED' as const, item: itemRef.get(l.itemId) ?? null, document: d(l.fileId) })),
    ...(raw.decisions.principalWithdrawn ? [{ kind: 'PRINCIPAL_WITHDRAWN' as const, operation: 'O1' }] : []),
    ...(raw.decisions.userPrincipalItemId !== null ? [{ kind: 'PRINCIPAL_CHOSEN' as const, item: itemRef.get(raw.decisions.userPrincipalItemId) ?? null, operation: 'O1' }] : []),
    ...raw.decisions.suppressedKeys.map(() => ({ kind: 'PROJECTION_DELETED' as const, operation: 'O1' })),
    ...tous.filter((i) => i.restoredByUser).map((i) => ({ kind: 'CONSOLIDATION_RESTORED' as const, item: itemRef.get(i.id) ?? null })),
  ];

  const input: RepresentationInput = {
    contractVersion: REPRESENTATION_CONTRACT_VERSION,
    task: REPRESENTATION_TASK,
    today: raw.today,
    operation: operationOf(raw.operation, 'O1'),
    neighbours: voisinesRetenues.map((n) => operationOf(n, opRef.get(n.id)!, raw.operation)),
    agendaItems: items,
    restorable,
    documents,
    userDecisions,
    priorDecisions: raw.prior.slice(0, 5),
    bounds: {
      complete: !tooLarge && contexte.length <= bounds.maxContextItems && voisines.length <= bounds.maxNeighbours
        && prioritaires.length <= bounds.maxDocuments && extraitsRetires === 0 && raw.restorables.length <= bounds.maxRestorable,
      droppedItems: Math.max(0, aDecider.length - bounds.maxInScopeItems) + Math.max(0, contexte.length - bounds.maxContextItems),
      droppedDocuments: Math.max(0, prioritaires.length - bounds.maxDocuments),
      droppedNeighbours: Math.max(0, voisines.length - bounds.maxNeighbours),
      droppedExcerpts: extraitsRetires,
    },
  };

  const scope: RepresentationScope = {
    accountId: raw.accountId,
    operationId: raw.operation.id,
    operationActive: raw.operation.active,
    principalWithdrawn: raw.decisions.principalWithdrawn,
    userPrincipalItemId: raw.decisions.userPrincipalItemId,
    detachedLinks: raw.decisions.detachedLinks,
    items: tous.map((i) => ({
      ref: itemRef.get(i.id)!, id: i.id, inScope: aDecider.some((x) => x.id === i.id),
      operationId: i.operationId, operationActive: i.operationActive, role: i.role, roleOrigin: i.roleOrigin,
      projected: i.projected, isAutomatic: i.isAutomatic, touched: isTouchedItem(i), pendingStatus: i.pendingStatus,
      restoredByUser: i.restoredByUser, userDetached: detaches.has(i.id), userAttached: rattaches.has(i.id) || i.roleOrigin === 'USER',
      fileIds: uniq([...i.fileIds, ...(i.originFileId ? [i.originFileId] : []), ...i.sources.map((x) => x.fileId ?? 0)]).filter((x) => x > 0),
    })),
    restorables: restRetenus.map((r, k) => ({ ref: `R${k + 1}`, journalId: r.journalId, absorbedItemId: r.absorbedItemId, principalItemId: r.principalItemId, restorable: r.restorable })),
    documents: Object.fromEntries([...docRef].map(([id, ref]) => [ref, id])),
    operations: Object.fromEntries([...opRef].map(([id, ref]) => [ref, id])),
  };

  const { today: _today, priorDecisions: _prior, ...stable } = input;
  void _today; void _prior;
  return { input, scope, fingerprint: fingerprintOf(stable), tooLarge };
}
