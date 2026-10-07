/**
 * Lot 29 — harnais des tests T2 « lecture de données » (tickets 8a, 8b, 12,
 * 13, 14). SANS BASE : un compte en mémoire, des lectures injectées qui
 * appliquent les MÊMES règles que les requêtes SQL (disponibilité unique
 * `isAssetAvailableForAssistant`, bornage au compte, équipements non
 * archivés), l'orchestrateur RÉEL (`runAssistant`) et un COMPTEUR d'appels
 * modèle (classification UNDERSTAND et génération ANSWER).
 *
 * Le fichier appelant doit déclarer `vi.mock('@/db', …)` avant d'importer ce
 * harnais (aucune connexion n'est ouverte).
 */
import { vi } from 'vitest';
import type { AssistantRequestInput, AssistantRunResult, IntentRoute } from '../../../types/contracts';
import type { OrchestratorPorts } from '../../assistant-orchestrator.service';
import type { TargetLookup, AssetCandidate, EntityCandidate } from '../../target-lookup.repository';
import type { TargetReaders } from '../../target-answer';
import type { CanonicalEntityFieldReading, CanonicalFieldReading } from '../../../canonical/field-reader';
import type { DocumentFieldFact } from '../../../canonical/field-document';
import type { ThreadContext } from '../../reference-resolver';
import type { ResolvedSource, RetrievedSource } from '../../../types/sources';

const { runAssistant } = await import('../../assistant-orchestrator.service');
const { readTargetForRequest } = await import('../../target-answer');
const { isAssetAvailableForAssistant } = await import('../../asset-availability');
const { getField, fieldTargetTypes } = await import('@/services/canonical/registry');
const { formatCanonicalValue, canonicalKeyOf } = await import('../../../canonical/field-reader');
const { normalizePlate, normalizeVin } = await import('../../vehicle-identifiers');
const { toIntentRoute } = await import('../../classification.adapter');
const { resolveAssistantTargets } = await import('../../assistant-targets');

export interface FxAsset {
  id: number; accountId?: number; name: string; category?: string; subtype?: string | null; status?: string | null; deleted?: boolean;
  city?: string | null; registrationNumber?: string | null; fields?: Record<string, unknown>;
}
export interface FxEntity {
  kind: 'equipment' | 'room'; id: number; assetId: number; name: string; type?: string | null; archived?: boolean; fields?: Record<string, unknown>;
}
export interface FxDocFact { assetId: number; key: string; display: string; fileId: number; title: string }

export interface Account {
  id: number;
  assets: FxAsset[];
  entities: FxEntity[];
  docFacts: FxDocFact[];
}

export const ACCOUNT_ID = 1;
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function account(p: Partial<Account> = {}): Account {
  return { id: ACCOUNT_ID, assets: [], entities: [], docFacts: [], ...p };
}

const duCompte = (a: Account, x: FxAsset) => (x.accountId ?? a.id) === a.id;
const dispo = (x: FxAsset) => isAssetAvailableForAssistant({ status: x.status ?? null, deletedAt: x.deleted ? new Date() : null });
const versCandidat = (x: FxAsset): AssetCandidate => ({
  id: x.id, name: x.name, category: x.category ?? null, subtype: x.subtype ?? null, city: x.city ?? null,
  registrationNumber: x.registrationNumber ?? null, status: x.status ?? null,
});

/** Lectures de résolution : mêmes règles que `target-lookup.repository` (compte, disponibilité, archivage). */
export function fakeLookup(acc: Account): TargetLookup & { calls: Record<string, number> } {
  const calls: Record<string, number> = { assets: 0, entities: 0, entityById: 0, vehicles: 0 };
  const parent = (e: FxEntity) => acc.assets.find((x) => x.id === e.assetId && duCompte(acc, x) && dispo(x));
  const versEntite = (e: FxEntity): EntityCandidate => ({ kind: e.kind, id: e.id, name: e.name, assetId: e.assetId, assetName: parent(e)?.name ?? null, entityType: e.type ?? null });
  return {
    calls,
    assets: async (accountId) => { calls.assets += 1; return accountId === acc.id ? acc.assets.filter((x) => duCompte(acc, x) && dispo(x)).map(versCandidat) : []; },
    entities: async (accountId, kind, terms, opts = {}) => {
      calls.entities += 1;
      if (accountId !== acc.id) return [];
      const motifs = terms.map((t) => plain(t)).filter((t) => t.length >= 3);
      return acc.entities.filter((e) => e.kind === kind && !e.archived && parent(e)
        && (!opts.assetIds?.length || opts.assetIds.includes(e.assetId))
        && motifs.some((m) => plain(e.name).includes(m) || plain(e.type ?? '').includes(m))).map(versEntite);
    },
    entityById: async (accountId, kind, id) => {
      calls.entityById += 1;
      const e = acc.entities.find((x) => x.kind === kind && x.id === id && !x.archived && parent(x));
      return accountId === acc.id && e ? versEntite(e) : null;
    },
    vehiclesByIdentifier: async (accountId, ident) => {
      calls.vehicles += 1;
      if (accountId !== acc.id) return [];
      return acc.assets.filter((x) => duCompte(acc, x) && dispo(x) && (
        (x.registrationNumber && ident.plates.includes(normalizePlate(x.registrationNumber)))
        || (typeof x.fields?.vin === 'string' && ident.vins.includes(normalizeVin(x.fields.vin as string))))).map(versCandidat);
    },
  };
}

/** Lectures canoniques simulées (champ d'un bien, d'une entité, fait documentaire), comptées. */
export function fakeReaders(acc: Account): TargetReaders & { calls: Array<{ kind: string; id: number; key: string }> } {
  const calls: Array<{ kind: string; id: number; key: string }> = [];
  const lectureEntite = (e: FxEntity, key: string): CanonicalEntityFieldReading | null => {
    const def = getField(key)!;
    const v = e.fields?.[key] ?? null;
    return {
      target: { type: e.kind === 'room' ? 'ROOM' : 'EQUIPMENT', id: e.id }, entityName: e.name, assetId: e.assetId, key, label: def.label,
      value: v, display: formatCanonicalValue(def, v), origin: v == null ? null : 'USER', originLabel: v == null ? null : 'saisie par vous',
      updatedAt: null, from: v == null ? null : 'key', evidence: null, sensitive: def.sensitive === true,
    };
  };
  return {
    calls,
    document: vi.fn(async () => null),
    agenda: vi.fn(async () => null),
    today: () => '2026-10-06',
    field: async (accountId, assetId, keyOrAlias) => {
      const key = canonicalKeyOf(keyOrAlias);
      calls.push({ kind: 'asset', id: assetId, key: key ?? keyOrAlias });
      const def = key ? getField(key) : undefined;
      // `readCanonicalField` : borné au compte, clé du registre — le statut du
      // bien n'y est PAS contrôlé (c'est la résolution qui l'applique).
      const a = acc.assets.find((x) => x.id === assetId && duCompte(acc, x) && !x.deleted);
      if (!key || !def || !def.assistantReadable || accountId !== acc.id || !a) return null;
      const v = a.fields?.[key] ?? null;
      const cibles = fieldTargetTypes(def);
      const entities = cibles.includes('EQUIPMENT') || cibles.includes('ROOM')
        ? acc.entities.filter((e) => e.assetId === a.id && !e.archived && e.fields?.[key] != null && cibles.includes(e.kind === 'room' ? 'ROOM' : 'EQUIPMENT'))
          .map((e) => lectureEntite(e, key)!)
        : undefined;
      const r: CanonicalFieldReading = {
        assetId, assetName: a.name, key, label: def.label, value: v, display: formatCanonicalValue(def, v),
        origin: v == null ? null : 'USER', originLabel: v == null ? null : 'saisie par vous', updatedAt: null,
        from: v == null ? null : 'key', evidence: null, openConflict: null, sensitive: def.sensitive === true,
        ...(entities ? { entities } : {}),
      };
      return r;
    },
    entityField: async (accountId, target, keyOrAlias) => {
      const key = canonicalKeyOf(keyOrAlias);
      calls.push({ kind: target.type, id: target.id, key: key ?? keyOrAlias });
      const def = key ? getField(key) : undefined;
      if (!key || !def || !fieldTargetTypes(def).includes(target.type) || accountId !== acc.id) return null;
      const e = acc.entities.find((x) => x.id === target.id && (x.kind === 'room' ? 'ROOM' : 'EQUIPMENT') === target.type);
      const p = e ? acc.assets.find((x) => x.id === e.assetId && duCompte(acc, x) && !x.deleted) : undefined;
      return e && p ? lectureEntite(e, key) : null;
    },
    documentFact: async (accountId, assetId, key): Promise<DocumentFieldFact | null> => {
      calls.push({ kind: 'document', id: assetId, key });
      const f = acc.docFacts.find((x) => x.assetId === assetId && x.key === key);
      const def = getField(key);
      return f && def && accountId === acc.id ? {
        key, label: def.label, value: f.display, display: f.display, fileId: f.fileId, documentTitle: f.title,
        excerpt: null, confidence: 'certain', sensitive: def.sensitive === true,
      } : null;
    },
  };
}

/** Route rendue par le classifieur simulé (sortie UNDERSTAND structurée). */
export function understood(intent: string, requestedFacts: string[], hints: Array<{ type: string; value: string }> = []): IntentRoute {
  return {
    ...toIntentRoute({ intent, confidence: 'exact', entityHints: hints as never, reason: 'test' }, 'PREMIUM'),
    understanding: { requestedFacts, filters: {} },
  };
}

export interface Harness {
  acc: Account;
  lookup: ReturnType<typeof fakeLookup>;
  readers: ReturnType<typeof fakeReaders>;
  /** Compteurs d'appels MODÈLE (UNDERSTAND, ANSWER). */
  classify: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
  saveClarification: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
  ports: OrchestratorPorts;
  ask(message: string, extra?: Partial<AssistantRequestInput>): Promise<AssistantRunResult>;
  /** Nombre total d'appels au client LLM simulé. */
  llmCalls(): number;
}

export function harness(acc: Account, o: {
  understand?: IntentRoute | null;
  thread?: ThreadContext | null;
  retrieved?: RetrievedSource[];
  generated?: string;
  readersOver?: Partial<TargetReaders>;
} = {}): Harness {
  const lookup = fakeLookup(acc);
  const readers = Object.assign(fakeReaders(acc), o.readersOver ?? {});
  const classify = vi.fn(async () => o.understand ?? null);
  const generate = vi.fn(async () => (o.generated ? { answer: o.generated, claims: [], actions: [], supportLevel: 'supported' as const } : null));
  const saveClarification = vi.fn(async () => true);
  const retrieve = vi.fn(async () => o.retrieved ?? []);
  const ports: OrchestratorPorts = {
    retrieve,
    resolveSources: async (sources): Promise<ResolvedSource[]> => sources.map((s) => ({
      id: s.id, type: s.type, typeLabel: s.type, title: s.title, excerpt: s.content.slice(0, 240), isAvailable: true,
    })),
    classifyWithAI: classify,
    generateWithAI: generate,
    resolveActions: async () => [],
    persist: async () => null,
    hasPendingClarification: async () => false,
    saveClarification,
    readTarget: (input, targets, route) => readTargetForRequest(input, targets, route, { lookup, readers }),
    // Lot 32 : même résolution serveur que la production, sur le compte en mémoire.
    resolveTargets: (input, route) => resolveAssistantTargets(input, route, lookup),
    loadThreadContext: o.thread ? async () => o.thread! : undefined,
    describeEntity: async (_acc, e) => {
      if (e.type === 'asset') {
        const a = acc.assets.find((x) => x.id === e.id && duCompte(acc, x) && dispo(x));
        return a ? { label: a.name } : null;
      }
      if (e.type === 'equipment' || e.type === 'room') {
        const x = await lookup.entityById!(acc.id, e.type, e.id);
        return x ? { label: x.name, assetId: x.assetId } : null;
      }
      return null;
    },
  };
  return {
    acc, lookup, readers, classify, generate, saveClarification, retrieve, ports,
    ask: (message, extra = {}) => runAssistant({
      accountId: acc.id, userId: 7, planType: 'PREMIUM', message, clientRequestId: `t-${Math.random()}`, locale: 'fr-FR',
      conversationId: 99, ...extra,
    } as AssistantRequestInput, ports),
    llmCalls: () => classify.mock.calls.length + generate.mock.calls.length,
  };
}

/** Contexte de fil minimal (référence « son… » sur une entité sélectionnée). */
export function threadOn(type: ThreadContext['lastSelected'] extends infer T ? T extends { type: infer K } ? K : never : never, id: number, label: string): ThreadContext {
  return {
    conversationId: 99, messages: [{ role: 'user', content: 'question précédente' }, { role: 'assistant', content: `Voici « ${label} ».` }],
    presentedLists: [], lastPresentedEntities: [], lastSelected: { type, id, label }, currentAssetId: type === 'asset' ? id : null,
    currentDocumentId: null, pendingClarification: null,
  };
}
