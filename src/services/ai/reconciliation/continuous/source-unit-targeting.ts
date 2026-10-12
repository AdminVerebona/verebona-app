/**
 * Réévaluation CIBLÉE après une évolution de la connaissance du compte (lot
 * 49B — ticket « T3 : exploiter la couche exhaustive T1 », §7).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *   bien / équipement / pièce créé ou modifié (journal 0292)
 *     → termes discriminants de l'objet (adresse, immatriculation, VIN,
 *       numéro de série, référence cadastrale, nom distinctif)
 *     → `searchDocumentSourceUnits` (couche exhaustive T1, base seulement)
 *     → documents SANS bien principal qui citent ces termes
 *     → reprise PRIORITAIRE de ces seuls documents (même sélection et même
 *       contrôle d'empreinte que le balayage : déterministe d'abord, IA
 *       seulement si le contexte a changé et l'exige).
 *
 * Jamais un scan IA de tous les documents : la recherche est SQL, bornée
 * (`TARGETING_MAX_OBJECTS` objets, `TARGETING_MAX_SEARCHES` recherches,
 * `TARGETING_MAX_DOCUMENTS` documents par passage) ; un document sans rapport
 * n'est jamais repris (AC5). Le balayage périodique reste le filet de
 * sécurité (événement manqué, journal compacté, backfill T1 tardif).
 *
 * Curseur : révision de connaissance déjà ciblée, par compte
 * (`t3_reconciliation_states`, relation `SOURCE_UNIT_TARGETING`) — écrire
 * cet état ne journalise rien (pas de boucle).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { ExecutionGuard } from '../../queue/execution-control';
import type { AccountMatchingIndex, MatchingIndexCache } from '../document-asset/matching-index';

export const TARGETING_RELATION = 'SOURCE_UNIT_TARGETING';
export const TARGETING_MAX_OBJECTS = 10;
export const TARGETING_MAX_SEARCHES = 12;
export const TARGETING_MAX_DOCUMENTS = 100;

export interface TargetingResult {
  objects: number;
  searches: number;
  documents: number[];
  enqueued: number;
  confirmed: number;
  delegated: number;
}

export interface TermGroup {
  /** Termes cherchés ensemble (tous requis). */
  terms: string[];
  kind: 'ADDRESS' | 'IDENTIFIER' | 'NAME';
}

const mots = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .split(/[^a-z0-9]+/).filter(Boolean);
const VIDES = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'rue', 'avenue', 'av', 'bd', 'boulevard', 'chemin', 'place', 'allee', 'impasse', 'route', 'et']);

/** Groupes de termes d'une adresse (« 12 rue Victor Hugo » → 12, victor, hugo). Pure. */
export function addressTerms(address: string | null | undefined): TermGroup | null {
  const t = mots(address ?? '').filter((m) => !VIDES.has(m) && (m.length >= 3 || /^\d+$/.test(m)));
  return t.length >= 2 && t.some((m) => /^[a-z]{3,}$/.test(m)) ? { terms: t.slice(0, 6), kind: 'ADDRESS' } : null;
}

/** Identifiant (immatriculation, VIN, série, cadastre) : forme lue, et forme compacte si différente. Pure. */
export function identifierTerms(value: string | null | undefined): TermGroup[] {
  const brut = String(value ?? '').trim();
  if (brut.length < 5 || !/\d/.test(brut)) return [];
  const compact = brut.replace(/[^A-Za-z0-9]/g, '');
  const out: TermGroup[] = [{ terms: [brut.toLowerCase()], kind: 'IDENTIFIER' }];
  if (compact.length >= 5 && compact.toLowerCase() !== brut.toLowerCase()) out.push({ terms: [compact.toLowerCase()], kind: 'IDENTIFIER' });
  return out;
}

/** Nom distinctif (au moins deux mots significatifs). Pure. */
export function nameTerms(name: string | null | undefined): TermGroup | null {
  const t = mots(name ?? '').filter((m) => m.length >= 3 && !VIDES.has(m));
  return t.length >= 2 ? { terms: t.slice(0, 4), kind: 'NAME' } : null;
}

interface ChangedObject { type: 'ASSET' | 'EQUIPMENT' | 'ROOM'; id: number }

/** Objets modifiés depuis la révision (journal 0292), du plus récent au plus ancien. */
async function changedObjects(accountId: number, sinceRevision: number): Promise<ChangedObject[]> {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT kind, object_type, max(object_id)::bigint AS object_id, max(id) AS last
       FROM account_knowledge_changes
      WHERE account_id = $1 AND id > $2::bigint AND kind IN ('ASSET', 'EQUIPMENT', 'ROOM') AND object_id IS NOT NULL
      GROUP BY kind, object_type, object_id
      ORDER BY last DESC
      LIMIT $3`,
    [accountId, sinceRevision, TARGETING_MAX_OBJECTS] as never[],
  )) as unknown as Array<{ kind: string; object_type: string; object_id: string | number }>;
  return rows.map((r) => ({ type: r.kind as ChangedObject['type'], id: Number(r.object_id) }));
}

/** Termes d'un objet modifié (index du compte, numéro de série brut des équipements). */
async function termsOf(o: ChangedObject, index: AccountMatchingIndex): Promise<TermGroup[]> {
  const out: TermGroup[] = [];
  if (o.type === 'ASSET') {
    const a = index.byId.get(o.id);
    if (!a) return [];
    const v = a.record.values;
    const adr = addressTerms(v.address1);
    if (adr) out.push(adr);
    for (const k of ['registrationNumber', 'vin', 'serialNumber', 'cadastralRef']) out.push(...identifierTerms(v[k]));
    const n = nameTerms(a.name);
    if (n) out.push(n);
    return out;
  }
  const e = index.entities.find((x) => x.type === o.type && x.id === o.id);
  if (!e) return [];
  if (o.type === 'EQUIPMENT') {
    const { pgClient } = await import('@/db');
    const [s] = (await pgClient.unsafe(
      `SELECT serial_number FROM equipment_cil_specs WHERE equipment_id = $1 LIMIT 1`, [o.id] as never[],
    ).catch(() => [])) as unknown as Array<{ serial_number: string | null }>;
    out.push(...identifierTerms(s?.serial_number ?? null));
  }
  const n = nameTerms(e.name);
  if (n) out.push(n);
  return out;
}

/**
 * Documents du compte, sans bien principal, dont la couche exhaustive T1
 * cite un objet modifié depuis la dernière recherche ciblée — puis reprise de
 * CES documents seulement (`sweepAccountDocuments`, empreinte comparée).
 */
export async function reconcileTargetedSourceUnits(p: {
  accountId: number; revision: number; indexes: MatchingIndexCache; guard?: ExecutionGuard; triggerCode?: string | null;
}): Promise<TargetingResult> {
  const out: TargetingResult = { objects: 0, searches: 0, documents: [], enqueued: 0, confirmed: 0, delegated: 0 };
  const [{ getReconciliationState, recordReconciliationState }, { searchDocumentSourceUnits }] = await Promise.all([
    import('./reconciliation-state.repository'),
    import('@/services/ai/source-analysis/source-units/repository'),
  ]);
  const etat = await getReconciliationState(TARGETING_RELATION, 'ACCOUNT', p.accountId);
  const depuis = etat?.knowledgeRevision ?? 0;
  if (depuis >= p.revision) return out;
  const objets = await changedObjects(p.accountId, depuis);
  out.objects = objets.length;
  const index = objets.length > 0 ? await p.indexes.get(p.accountId) : null;
  const docs = new Set<number>();
  for (const o of objets) {
    for (const g of await termsOf(o, index!)) {
      if (out.searches >= TARGETING_MAX_SEARCHES || docs.size >= TARGETING_MAX_DOCUMENTS) break;
      await p.guard?.assertActive('T3 — recherche ciblée dans la couche exhaustive T1');
      out.searches += 1;
      const hits = await searchDocumentSourceUnits(p.accountId, g.terms, {
        statuses: ['COVERED', 'UNRESOLVED', 'UNCERTAIN'], minMatched: g.terms.length, limit: TARGETING_MAX_DOCUMENTS,
      });
      for (const h of hits) if (h.assetId == null) docs.add(Number(h.fileId));
    }
  }
  out.documents = [...docs].sort((a, b) => a - b).slice(0, TARGETING_MAX_DOCUMENTS);
  if (out.documents.length > 0) {
    const { sweepAccountDocuments } = await import('../document-asset/queue');
    const r = await sweepAccountDocuments({
      accountId: p.accountId, guard: p.guard, triggerCode: p.triggerCode ?? 'knowledge_changed', limit: TARGETING_MAX_DOCUMENTS,
      indexes: p.indexes, fileIds: out.documents,
    });
    out.enqueued = r.enqueued.length;
    out.confirmed = r.confirmed;
    out.delegated = r.delegated;
  }
  await recordReconciliationState({
    relation: TARGETING_RELATION, subjectType: 'ACCOUNT', subjectId: p.accountId, accountId: p.accountId, engineVersion: 1,
    knowledgeRevision: p.revision, contextFingerprint: null, result: out.documents.length > 0 ? 'TARGETED' : 'NO_MATCH',
    reason: null, detail: { objects: out.objects, searches: out.searches, documents: out.documents.length, enqueued: out.enqueued },
  });
  if (out.documents.length > 0) {
    console.info(`[t3-source-units] compte ${p.accountId} : ${out.objects} objet(s) modifié(s), ${out.searches} recherche(s), `
      + `${out.documents.length} document(s) ciblé(s), ${out.enqueued} remis en file.`);
  }
  return out;
}
