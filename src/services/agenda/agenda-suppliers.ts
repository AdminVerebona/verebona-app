/**
 * Fournisseurs / intervenants des éléments d'Agenda — service UNIQUE (lot
 * 103E, ticket P1 « Agenda / Fournisseurs »). Règles pures :
 * `lib/agenda/agenda-suppliers-rules.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DIAGNOSTIC DE L'EXISTANT (avant ce lot)
 *
 *   · aucune relation Agenda ↔ fournisseur : la fiche fournisseur DÉDUISAIT
 *     ses « échéances » des documents et équipements liés (voisinage) —
 *     remplacée par la relation persistante `agenda_item_suppliers` (0950) ;
 *   · référentiel `suppliers` (lot 22) : rapprochement `findCandidates` /
 *     `assessMatch`, création `document_extraction`, revue de doublon
 *     `supplier_review_items` — RÉUTILISÉS tels quels ici (aucun second
 *     annuaire, aucun second moteur) ;
 *   · `POST /api/suppliers` créait une fiche sans contrôle de doublon : le
 *     tiroir Agenda passe par le même rapprochement que les documents.
 *
 * ÉCRITURES
 *   · utilisateur (tiroir Agenda, fiche fournisseur) : `applyAgendaItemSuppliers`,
 *     `linkSupplierByUser`, `unlinkSupplierByUser` — un retrait est MÉMORISÉ ;
 *     un nouvel ajout lève le retrait (nouveau consentement) ;
 *   · automatique (fin d'analyse / T4, gestes sur les documents, contrôle de
 *     cohérence COH-AGENDA-SUPPLIERS) : `syncAutomaticAgendaSuppliers` —
 *     preuves PROPRES à l'élément seulement (voir les règles), jamais un lien
 *     USER retiré, jamais un retrait manuel recréé, idempotent ;
 *   · fusion de fournisseurs : `mergeAgendaSupplierLinksInTx` (liens et
 *     retraits reportés sur la fiche conservée, sans doublon).
 *
 * Toute lecture et écriture est bornée au compte (et le déclencheur 0950
 * refuse un lien intercomptes). Aucun appel IA : seules les données
 * persistées sont exploitées.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db';
import { suppliers } from '@/db/schema';
import {
  AGENDA_SUPPLIER_PROVENANCE_RANK, AGENDA_SUPPLIER_RULES, findSupplierMentions, isEmptySyncPlan, planAgendaSupplierSync,
  type AgendaSupplierEvidence, type AgendaSupplierProvenance, type AgendaSupplierSyncPlan, type AgendaSuppliersPayload,
} from '@/lib/agenda/agenda-suppliers-rules';
import { assessMatch, findCandidates, normalizeName, type SupplierQueryRunner } from '@/services/suppliers/supplier-service';
import { AGENDA_EVENT_LABELS } from '@/lib/agenda/grouping-view';

type Row = Record<string, unknown>;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Pick<typeof db, 'execute'> | Tx;

const rows = async <T = Row>(x: Exec, q: SQL): Promise<T[]> => (await x.execute(q)) as unknown as T[];
const ints = (l: readonly number[]) => sql`${`{${[...new Set(l.filter((v) => Number.isSafeInteger(v)))].join(',')}}`}::int[]`;
const texts = (l: readonly string[]) => sql`${`{${l.map((v) => `"${v.replace(/["\\]/g, '')}"`).join(',')}}`}::text[]`;
const num = (v: unknown) => Number(v);

/** Erreur fonctionnelle (code stable, message affichable). */
export class AgendaSupplierError extends Error {
  constructor(readonly code: 'ITEM_NOT_FOUND' | 'SUPPLIER_NOT_FOUND' | 'INVALID_INPUT', message: string) {
    super(message);
  }
}

// ── Lecture ──────────────────────────────────────────────────────────────

export interface AgendaSupplierLink {
  id: number;
  name: string;
  /** Fiche archivée (encore consultable) ou active. */
  status: string;
  provenance: AgendaSupplierProvenance;
}

/** Fournisseurs des éléments (du compte), triés par nom. NOMS seulement : aucune coordonnée. */
export async function listSuppliersOfItems(accountId: number, itemIds: readonly number[], x: Exec = db): Promise<Map<number, AgendaSupplierLink[]>> {
  const out = new Map<number, AgendaSupplierLink[]>();
  if (!itemIds.length) return out;
  const r = await rows<{ item_id: number; id: number; name: string; status: string; provenance: AgendaSupplierProvenance }>(x, sql`
    SELECT l.agenda_item_id AS item_id, s.id, s.name, s.status, l.provenance
      FROM agenda_item_suppliers l
      JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = ${accountId}
      JOIN suppliers s ON s.id = l.supplier_id AND s.account_id = ${accountId} AND s.status <> 'deleted'
     WHERE l.account_id = ${accountId} AND l.agenda_item_id = ANY(${ints(itemIds)})
     ORDER BY lower(s.name), s.id`);
  for (const l of r) {
    const k = num(l.item_id);
    out.set(k, [...(out.get(k) ?? []), { id: num(l.id), name: String(l.name), status: String(l.status), provenance: l.provenance }]);
  }
  // Ordre alphabétique FRANÇAIS calculé ici, jamais par la collation de la base :
  // « Électricité » avant « Vauban » partout (base en locale C ici, en_US en CI / Scalingo).
  for (const [k, v] of out) out.set(k, v.sort(compareSupplierNames));
  return out;
}

const SUPPLIER_NAME_COLLATOR = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
/** Tri d'affichage des fournisseurs d'un élément : nom (français, sans casse ni accents), puis identifiant. */
export function compareSupplierNames(a: { name: string; id: number }, b: { name: string; id: number }): number {
  return SUPPLIER_NAME_COLLATOR.compare(a.name, b.name) || a.id - b.id;
}

/** Fournisseurs d'un élément, ou `null` si l'élément n'est pas du compte (anti-énumération). */
export async function getItemSuppliers(accountId: number, itemId: number): Promise<AgendaSupplierLink[] | null> {
  if (!(await itemInAccount(db, accountId, itemId))) return null;
  return (await listSuppliersOfItems(accountId, [itemId])).get(itemId) ?? [];
}

async function itemInAccount(x: Exec, accountId: number, itemId: number): Promise<boolean> {
  if (!Number.isSafeInteger(itemId) || itemId <= 0) return false;
  const [r] = await rows(x, sql`SELECT 1 AS ok FROM agenda_items WHERE id = ${itemId} AND account_id = ${accountId}`);
  return !!r;
}

/** Éléments liés à un fournisseur (fiche fournisseur), annulés compris (statut affiché). */
export async function listItemsOfSupplier(accountId: number, supplierId: number, limit = 500): Promise<Array<{
  id: number; title: string; startDate: string | null; manualStatus: string | null; provenance: AgendaSupplierProvenance;
}>> {
  const r = await rows<Row>(db, sql`
    SELECT i.id, i.title, i.start_date::text AS start_date, i.manual_status, l.provenance
      FROM agenda_item_suppliers l
      JOIN agenda_items i ON i.id = l.agenda_item_id AND i.account_id = ${accountId}
      JOIN suppliers s ON s.id = l.supplier_id AND s.account_id = ${accountId}
     WHERE l.account_id = ${accountId} AND l.supplier_id = ${supplierId}
     ORDER BY i.start_date DESC NULLS LAST, i.id DESC
     LIMIT ${limit}`);
  return r.map((x) => ({
    id: num(x.id), title: String(x.title ?? ''), startDate: x.start_date == null ? null : String(x.start_date).slice(0, 10),
    manualStatus: (x.manual_status as string | null) ?? null, provenance: x.provenance as AgendaSupplierProvenance,
  }));
}

// ── Création / réutilisation d'un fournisseur (moteur du référentiel) ───────

export interface DuplicateCheck {
  /** `certain` : fiche existante réutilisée ; `uncertain` : fiche proche à confirmer ; `new` : aucune. */
  decision: 'certain' | 'uncertain' | 'new';
  candidates: Array<{ id: number; name: string }>;
}

const cleNormalisee = (name: string) => normalizeName(name) || name.trim().toLowerCase();

/** Doublon possible d'un nom saisi (lecture seule) : MÊME rapprochement que les documents. */
export async function checkSupplierDuplicate(accountId: number, name: string, q: SupplierQueryRunner = db): Promise<DuplicateCheck> {
  const candidats = await findCandidates(accountId, cleNormalisee(name), null, null, null, q);
  return { decision: assessMatch(candidats), candidates: candidats.slice(0, 3).map((c) => ({ id: c.id, name: c.name })) };
}

/**
 * Fiche du référentiel pour un nom saisi par l'utilisateur (dans la
 * transaction et sous le verrou du référentiel) :
 *   · rapprochement CERTAIN → fiche existante réutilisée ;
 *   · INCERTAIN → nouvelle fiche ; sans confirmation explicite de
 *     l'utilisateur, revue de doublon « À traiter » (comme un document) ;
 *   · aucun candidat → nouvelle fiche (`source = manual`).
 */
export async function resolveSupplierForUser(
  tx: Tx, p: { accountId: number; userId: number; name: string; confirmNew?: boolean },
): Promise<{ supplierId: number; outcome: 'reused' | 'created' | 'created_uncertain' }> {
  const q = tx as unknown as SupplierQueryRunner;
  const nom = p.name.trim().replace(/\s+/g, ' ');
  const normalizedName = cleNormalisee(nom);
  const candidats = await findCandidates(p.accountId, normalizedName, null, null, null, q);
  const decision = assessMatch(candidats);
  if (decision === 'certain') return { supplierId: candidats[0].id, outcome: 'reused' };
  const [cree] = await tx.insert(suppliers).values({
    accountId: p.accountId, createdByUserId: p.userId, name: nom, normalizedName,
    source: 'manual', status: 'active', createdAt: new Date(), updatedAt: new Date(),
  }).returning({ id: suppliers.id });
  if (decision === 'uncertain' && !p.confirmNew) {
    // Lot 113G : revue seulement pour une paire plausible non tranchée, jamais en double (`openIdentityReview`).
    const { openIdentityReview } = await import('@/services/suppliers/supplier-identity-reviews');
    const r = await openIdentityReview(q, { accountId: p.accountId, supplierId: cree.id, documentId: null, detectedName: nom, candidateIds: candidats.map((c) => c.id) });
    if (r.reviewId !== null) return { supplierId: cree.id, outcome: 'created_uncertain' };
  } else if (decision === 'uncertain' && p.confirmNew) {
    // Lot 113G : « Créer quand même » = identités DISTINCTES décidées par l'utilisateur (jamais reproposées).
    await recordDistinctFromCandidates(q, p.accountId, cree.id, candidats.map((c) => c.id), p.userId);
  }
  return { supplierId: cree.id, outcome: 'created' };
}

/** Lot 113G : fiche créée malgré des fiches proches (choix explicite) — séparation mémorisée par paire. */
export async function recordDistinctFromCandidates(q: SupplierQueryRunner, accountId: number, supplierId: number, candidateIds: readonly number[], userId: number | null): Promise<void> {
  const ids = [...new Set(candidateIds.filter((x) => Number.isInteger(x) && x > 0 && x !== supplierId))].slice(0, 10);
  if (!ids.length) return;
  const { recordPairDecision } = await import('@/services/suppliers/supplier-identity-reviews');
  const fiches = await q.select().from(suppliers).where(and(eq(suppliers.accountId, accountId), inArray(suppliers.id, [supplierId, ...ids])));
  const a = fiches.find((f) => f.id === supplierId);
  if (!a) return;
  for (const b of fiches) if (b.id !== a.id) await recordPairDecision(q, { accountId, a, b, decision: 'DISTINCT', reviewId: null, userId, evidence: { reason: 'CREATED_ANYWAY' } });
}

// ── Écritures utilisateur ─────────────────────────────────────────────────

async function verrouReferentiel(tx: Tx, accountId: number): Promise<void> {
  const { SUPPLIER_REFERENTIAL_LOCK } = await import('@/services/suppliers/supplier-from-analysis');
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${SUPPLIER_REFERENTIAL_LOCK}, ${accountId})`);
}

async function historique(x: Exec, h: {
  accountId: number; itemId: number; supplierId: number; action: string; provenance?: string | null;
  actorUserId?: number | null; correlationId?: string | null; detail?: Record<string, unknown> | null;
}): Promise<void> {
  await x.execute(sql`
    INSERT INTO agenda_item_supplier_history (account_id, agenda_item_id, supplier_id, action, provenance, actor_user_id, correlation_id, detail)
    VALUES (${h.accountId}, ${h.itemId}, ${h.supplierId}, ${h.action}, ${h.provenance ?? null}, ${h.actorUserId ?? null},
            ${h.correlationId ?? null}, ${h.detail ? JSON.stringify(h.detail) : null}::jsonb)`);
}

/** Lien posé par l'utilisateur (le retrait éventuel est levé ; un lien automatique devient USER). */
async function lierParUtilisateur(tx: Tx, accountId: number, itemId: number, supplierId: number, actorUserId: number | null, correlationId: string | null): Promise<boolean> {
  const leve = await rows(tx, sql`
    DELETE FROM agenda_item_supplier_suppressions WHERE account_id = ${accountId} AND agenda_item_id = ${itemId} AND supplier_id = ${supplierId} RETURNING 1`);
  if (leve.length) await historique(tx, { accountId, itemId, supplierId, action: 'RESTORED', provenance: 'USER', actorUserId, correlationId });
  const [avant] = await rows<{ provenance: string }>(tx, sql`
    SELECT provenance FROM agenda_item_suppliers WHERE agenda_item_id = ${itemId} AND supplier_id = ${supplierId}`);
  if (avant?.provenance === 'USER') return false;
  if (avant) {
    await tx.execute(sql`
      UPDATE agenda_item_suppliers SET provenance = 'USER', created_by_user_id = coalesce(created_by_user_id, ${actorUserId}), updated_at = now()
       WHERE agenda_item_id = ${itemId} AND supplier_id = ${supplierId}`);
    await historique(tx, { accountId, itemId, supplierId, action: 'PROVENANCE_UPGRADED', provenance: 'USER', actorUserId, correlationId, detail: { from: avant.provenance } });
    return true;
  }
  await tx.execute(sql`
    INSERT INTO agenda_item_suppliers (account_id, agenda_item_id, supplier_id, provenance, created_by_user_id, correlation_id)
    VALUES (${accountId}, ${itemId}, ${supplierId}, 'USER', ${actorUserId}, ${correlationId})
    ON CONFLICT (agenda_item_id, supplier_id) DO NOTHING`);
  await historique(tx, { accountId, itemId, supplierId, action: 'LINKED', provenance: 'USER', actorUserId, correlationId });
  return true;
}

/** Retrait par l'utilisateur : lien supprimé (aucune entité supprimée) et retrait MÉMORISÉ. */
async function retirerParUtilisateur(tx: Tx, accountId: number, itemId: number, supplierId: number, actorUserId: number | null, correlationId: string | null): Promise<boolean> {
  const [supprime] = await rows<{ provenance: string }>(tx, sql`
    DELETE FROM agenda_item_suppliers WHERE account_id = ${accountId} AND agenda_item_id = ${itemId} AND supplier_id = ${supplierId}
    RETURNING provenance`);
  if (!supprime) return false;
  await tx.execute(sql`
    INSERT INTO agenda_item_supplier_suppressions (account_id, agenda_item_id, supplier_id, previous_provenance, suppressed_by_user_id)
    VALUES (${accountId}, ${itemId}, ${supplierId}, ${supprime.provenance}, ${actorUserId})
    ON CONFLICT (agenda_item_id, supplier_id) DO UPDATE SET previous_provenance = EXCLUDED.previous_provenance,
      suppressed_by_user_id = EXCLUDED.suppressed_by_user_id, suppressed_at = now()`);
  await historique(tx, { accountId, itemId, supplierId, action: 'SUPPRESSED', provenance: supprime.provenance, actorUserId, correlationId });
  return true;
}

/**
 * Validation AVANT toute écriture d'une sélection reçue par l'API :
 * fournisseurs du compte (non supprimés). Lève `AgendaSupplierError`.
 */
export async function assertSuppliersPayloadInAccount(accountId: number, payload: AgendaSuppliersPayload, itemId?: number | null): Promise<void> {
  if (!payload.supplierIds.length) return;
  const ok = await rows<{ id: number }>(db, sql`
    SELECT s.id FROM suppliers s
     WHERE s.account_id = ${accountId} AND s.id = ANY(${ints(payload.supplierIds)})
       AND (s.status = 'active'
            OR (${itemId ?? null}::int IS NOT NULL AND EXISTS (SELECT 1 FROM agenda_item_suppliers l WHERE l.agenda_item_id = ${itemId ?? null}::int AND l.supplier_id = s.id)))`);
  if (ok.length !== payload.supplierIds.length) throw new AgendaSupplierError('SUPPLIER_NOT_FOUND', 'Fournisseur introuvable.');
}

export interface ApplySuppliersResult {
  supplierIds: number[];
  added: number[];
  removed: number[];
  created: Array<{ name: string; supplierId: number; outcome: 'reused' | 'created' | 'created_uncertain' }>;
}

/**
 * Sélection du tiroir (création ou modification d'un élément) : l'ensemble
 * VOULU = fournisseurs choisis + nouveaux noms (réutilisés ou créés par le
 * moteur du référentiel). Un lien déjà présent garde sa provenance ; un
 * ajout est USER ; un retrait est mémorisé. Une seule transaction : un échec
 * ne laisse ni fiche créée ni lien partiel.
 */
export async function applyAgendaItemSuppliers(p: {
  accountId: number; itemId: number; actorUserId: number | null; payload: AgendaSuppliersPayload; correlationId?: string | null;
}): Promise<ApplySuppliersResult> {
  const correlationId = p.correlationId ?? `agenda-suppliers:user:${p.itemId}`;
  return db.transaction(async (tx) => {
    const [item] = await rows(tx, sql`SELECT id FROM agenda_items WHERE id = ${p.itemId} AND account_id = ${p.accountId} FOR UPDATE`);
    if (!item) throw new AgendaSupplierError('ITEM_NOT_FOUND', AGENDA_EVENT_LABELS.notFound);
    const voulus = new Set(p.payload.supplierIds);
    const created: ApplySuppliersResult['created'] = [];
    if (p.payload.newSuppliers.length) {
      if (p.actorUserId == null) throw new AgendaSupplierError('INVALID_INPUT', 'Création de fournisseur impossible sans utilisateur.');
      await verrouReferentiel(tx, p.accountId);
      for (const n of p.payload.newSuppliers) {
        const r = await resolveSupplierForUser(tx, { accountId: p.accountId, userId: p.actorUserId, name: n.name, confirmNew: n.confirmNew });
        created.push({ name: n.name, ...r });
        voulus.add(r.supplierId);
      }
    }
    if (voulus.size) {
      const valides = await rows<{ id: number }>(tx, sql`
        SELECT s.id FROM suppliers s WHERE s.account_id = ${p.accountId} AND s.id = ANY(${ints([...voulus])})
          AND (s.status = 'active' OR EXISTS (SELECT 1 FROM agenda_item_suppliers l WHERE l.agenda_item_id = ${p.itemId} AND l.supplier_id = s.id))`);
      if (valides.length !== voulus.size) throw new AgendaSupplierError('SUPPLIER_NOT_FOUND', 'Fournisseur introuvable.');
    }
    const actuels = (await rows<{ supplier_id: number }>(tx, sql`
      SELECT supplier_id FROM agenda_item_suppliers WHERE account_id = ${p.accountId} AND agenda_item_id = ${p.itemId}`)).map((r) => num(r.supplier_id));
    const removed: number[] = [];
    for (const sid of actuels.filter((s) => !voulus.has(s))) {
      if (await retirerParUtilisateur(tx, p.accountId, p.itemId, sid, p.actorUserId, correlationId)) removed.push(sid);
    }
    const added: number[] = [];
    for (const sid of [...voulus].filter((s) => !actuels.includes(s)).sort((a, b) => a - b)) {
      if (await lierParUtilisateur(tx, p.accountId, p.itemId, sid, p.actorUserId, correlationId)) added.push(sid);
    }
    return { supplierIds: [...voulus].sort((a, b) => a - b), added, removed, created };
  });
}

/** Association depuis la fiche fournisseur (même relation que depuis l'Agenda). */
export async function linkSupplierByUser(p: { accountId: number; itemId: number; supplierId: number; actorUserId: number | null }): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await itemInAccount(tx, p.accountId, p.itemId))) throw new AgendaSupplierError('ITEM_NOT_FOUND', AGENDA_EVENT_LABELS.notFound);
    const [s] = await rows(tx, sql`SELECT id FROM suppliers WHERE id = ${p.supplierId} AND account_id = ${p.accountId} AND status = 'active'`);
    if (!s) throw new AgendaSupplierError('SUPPLIER_NOT_FOUND', 'Fournisseur introuvable.');
    return lierParUtilisateur(tx, p.accountId, p.itemId, p.supplierId, p.actorUserId, `agenda-suppliers:supplier-page:${p.supplierId}`);
  });
}

/** Dissociation depuis la fiche fournisseur : aucune entité supprimée ; retrait mémorisé. */
export async function unlinkSupplierByUser(p: { accountId: number; itemId: number; supplierId: number; actorUserId: number | null }): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await itemInAccount(tx, p.accountId, p.itemId))) throw new AgendaSupplierError('ITEM_NOT_FOUND', AGENDA_EVENT_LABELS.notFound);
    const [s] = await rows(tx, sql`SELECT id FROM suppliers WHERE id = ${p.supplierId} AND account_id = ${p.accountId}`);
    if (!s) throw new AgendaSupplierError('SUPPLIER_NOT_FOUND', 'Fournisseur introuvable.');
    return retirerParUtilisateur(tx, p.accountId, p.itemId, p.supplierId, p.actorUserId, `agenda-suppliers:supplier-page:${p.supplierId}`);
  });
}

// ── Identification automatique (preuves propres à l'élément) ───────────────

export interface ItemEvidence {
  evidence: AgendaSupplierEvidence[];
  /** Noms mentionnés portés par plusieurs fiches : aucun lien (ambiguïté). */
  ambiguousMentions: string[];
}

/**
 * Preuves PERSISTÉES propres à chaque élément du compte (lecture seule, sans
 * IA) — voir les règles (`agenda-suppliers-rules.ts`) :
 *   · DOCUMENT : document DIRECTEMENT rattaché (MANUAL_DIRECT / AI_DIRECT),
 *     non supprimé, du compte, dont le lien fournisseur est fiable (confirmé
 *     ou lu avec certitude), hors preuve de paiement ;
 *   · AUTO : mention explicite non ambiguë d'un fournisseur ACTIF du compte.
 */
export async function computeAgendaSupplierEvidence(accountId: number, itemIds: readonly number[], x: Exec = db): Promise<Map<number, ItemEvidence>> {
  const out = new Map<number, ItemEvidence>();
  if (!itemIds.length) return out;
  const R = AGENDA_SUPPLIER_RULES;
  const items = await rows<{ id: number; title: string; description: string | null }>(x, sql`
    SELECT id, title, description FROM agenda_items WHERE account_id = ${accountId} AND id = ANY(${ints(itemIds)}) ORDER BY id`);
  for (const i of items) out.set(num(i.id), { evidence: [], ambiguousMentions: [] });
  if (!items.length) return out;
  const docs = await rows<{ item_id: number; supplier_id: number; document_id: number }>(x, sql`
    SELECT DISTINCT fl.agenda_item_id AS item_id, ds.supplier_id, fl.asset_file_id AS document_id
      FROM agenda_file_links fl
      JOIN asset_files f ON f.id = fl.asset_file_id AND f.account_id = ${accountId} AND f.deleted_at IS NULL
      JOIN document_suppliers ds ON ds.document_id = f.id
       AND (ds.is_confirmed OR coalesce(ds.confidence_score, 0) >= ${R.reliableConfidence})
      JOIN suppliers s ON s.id = ds.supplier_id AND s.account_id = ${accountId} AND s.status <> 'deleted'
     WHERE fl.agenda_item_id = ANY(${ints(items.map((i) => num(i.id)))})
       AND fl.provenances && ${texts(R.directFileLinkProvenances)}
       AND NOT EXISTS (SELECT 1 FROM document_operation_candidates c
                        WHERE c.file_id = f.id AND c.account_id = ${accountId} AND c.status = 'ACTIVE'
                          AND c.payload->>'sourceRoleHint' = ANY(${texts(R.nonActorSourceRoles)}))
     ORDER BY 1, 2, 3`);
  for (const d of docs) {
    out.get(num(d.item_id))?.evidence.push({ supplierId: num(d.supplier_id), provenance: 'DOCUMENT', documentId: num(d.document_id) });
  }
  const actifs = (await rows<{ id: number; normalized_name: string }>(x, sql`
    SELECT id, normalized_name FROM suppliers WHERE account_id = ${accountId} AND status = 'active'`))
    .map((s) => ({ id: num(s.id), normalizedName: String(s.normalized_name ?? '') }));
  if (actifs.length) {
    for (const i of items) {
      const e = out.get(num(i.id))!;
      const titre = findSupplierMentions(String(i.title ?? ''), actifs);
      const tout = findSupplierMentions(`${i.title ?? ''} \n ${i.description ?? ''}`, actifs);
      for (const sid of tout.matched) e.evidence.push({ supplierId: sid, provenance: 'AUTO', field: titre.matched.includes(sid) ? 'title' : 'description' });
      e.ambiguousMentions = tout.ambiguous;
    }
  }
  return out;
}

/** Liens actuels et retraits manuels des éléments (lecture seule). */
export async function loadAgendaSupplierState(accountId: number, itemIds: readonly number[], x: Exec = db): Promise<Map<number, {
  links: Array<{ supplierId: number; provenance: AgendaSupplierProvenance }>; suppressed: number[];
}>> {
  const out = new Map<number, { links: Array<{ supplierId: number; provenance: AgendaSupplierProvenance }>; suppressed: number[] }>();
  for (const id of itemIds) out.set(id, { links: [], suppressed: [] });
  if (!itemIds.length) return out;
  const [liens, retraits] = await Promise.all([
    rows<{ item_id: number; supplier_id: number; provenance: AgendaSupplierProvenance }>(x, sql`
      SELECT agenda_item_id AS item_id, supplier_id, provenance FROM agenda_item_suppliers
       WHERE account_id = ${accountId} AND agenda_item_id = ANY(${ints(itemIds)})`),
    rows<{ item_id: number; supplier_id: number }>(x, sql`
      SELECT agenda_item_id AS item_id, supplier_id FROM agenda_item_supplier_suppressions
       WHERE account_id = ${accountId} AND agenda_item_id = ANY(${ints(itemIds)})`),
  ]);
  for (const l of liens) out.get(num(l.item_id))?.links.push({ supplierId: num(l.supplier_id), provenance: l.provenance });
  for (const r of retraits) out.get(num(r.item_id))?.suppressed.push(num(r.supplier_id));
  return out;
}

/** Plans de synchronisation (lecture seule) — utilisés par le contrôle de cohérence et l'application. */
export async function planAgendaSuppliers(accountId: number, itemIds: readonly number[], x: Exec = db): Promise<Map<number, {
  plan: AgendaSupplierSyncPlan; ambiguousMentions: string[]; exists: boolean;
}>> {
  const [preuves, etat] = await Promise.all([computeAgendaSupplierEvidence(accountId, itemIds, x), loadAgendaSupplierState(accountId, itemIds, x)]);
  const out = new Map<number, { plan: AgendaSupplierSyncPlan; ambiguousMentions: string[]; exists: boolean }>();
  for (const id of itemIds) {
    const p = preuves.get(id);
    const e = etat.get(id) ?? { links: [], suppressed: [] };
    out.set(id, {
      plan: planAgendaSupplierSync(e.links, p?.evidence ?? [], e.suppressed),
      ambiguousMentions: p?.ambiguousMentions ?? [],
      exists: !!p,
    });
  }
  return out;
}

export interface SyncResult {
  itemId: number;
  added: number[];
  removed: number[];
  upgraded: number[];
  suppressed: number[];
  ambiguousMentions: string[];
}

/**
 * Applique les liens AUTOMATIQUES des éléments (idempotent). Chaque élément
 * est traité dans sa propre transaction, ligne verrouillée, plan RECALCULÉ
 * dans la transaction (jamais un plan ancien rejoué) ; les écritures portent
 * elles-mêmes leurs conditions (pas de retrait manuel, jamais un lien USER).
 */
export async function syncAutomaticAgendaSuppliers(accountId: number, itemIds: readonly number[], o: { correlationId?: string; dryRun?: boolean } = {}): Promise<SyncResult[]> {
  const out: SyncResult[] = [];
  const ids = [...new Set(itemIds.filter((v) => Number.isSafeInteger(v) && v > 0))].sort((a, b) => a - b);
  const correlationId = o.correlationId ?? 'agenda-suppliers:auto';
  for (const itemId of ids) {
    if (o.dryRun) {
      const p = (await planAgendaSuppliers(accountId, [itemId])).get(itemId);
      if (p?.exists) out.push({ itemId, added: p.plan.add.map((a) => a.supplierId), removed: p.plan.remove.map((r) => r.supplierId), upgraded: p.plan.upgrade.map((u) => u.supplierId), suppressed: p.plan.suppressed, ambiguousMentions: p.ambiguousMentions });
      continue;
    }
    const r = await db.transaction(async (tx) => {
      const [item] = await rows(tx, sql`SELECT id FROM agenda_items WHERE id = ${itemId} AND account_id = ${accountId} FOR UPDATE`);
      if (!item) return null;
      const p = (await planAgendaSuppliers(accountId, [itemId], tx)).get(itemId)!;
      const res: SyncResult = { itemId, added: [], removed: [], upgraded: [], suppressed: p.plan.suppressed, ambiguousMentions: p.ambiguousMentions };
      if (isEmptySyncPlan(p.plan)) return res;
      for (const e of p.plan.add) {
        const ins = await rows(tx, sql`
          INSERT INTO agenda_item_suppliers (account_id, agenda_item_id, supplier_id, provenance, evidence, source_document_id, correlation_id)
          SELECT ${accountId}, ${itemId}, ${e.supplierId}, ${e.provenance}, ${JSON.stringify(preuve(e))}::jsonb,
                 ${e.documentId ?? null}, ${correlationId}
           WHERE NOT EXISTS (SELECT 1 FROM agenda_item_supplier_suppressions x WHERE x.agenda_item_id = ${itemId} AND x.supplier_id = ${e.supplierId})
          ON CONFLICT (agenda_item_id, supplier_id) DO NOTHING
          RETURNING 1`);
        if (!ins.length) continue;
        res.added.push(e.supplierId);
        await historique(tx, { accountId, itemId, supplierId: e.supplierId, action: 'LINKED', provenance: e.provenance, correlationId, detail: preuve(e) });
      }
      for (const e of p.plan.upgrade) {
        const up = await rows(tx, sql`
          UPDATE agenda_item_suppliers SET provenance = ${e.provenance}, evidence = ${JSON.stringify(preuve(e))}::jsonb,
                 source_document_id = ${e.documentId ?? null}, correlation_id = ${correlationId}, updated_at = now()
           WHERE agenda_item_id = ${itemId} AND supplier_id = ${e.supplierId} AND provenance <> 'USER'
          RETURNING 1`);
        if (!up.length) continue;
        res.upgraded.push(e.supplierId);
        await historique(tx, { accountId, itemId, supplierId: e.supplierId, action: 'PROVENANCE_UPGRADED', provenance: e.provenance, correlationId, detail: preuve(e) });
      }
      for (const e of p.plan.remove) {
        const del = await rows(tx, sql`
          DELETE FROM agenda_item_suppliers WHERE agenda_item_id = ${itemId} AND supplier_id = ${e.supplierId} AND provenance <> 'USER' RETURNING 1`);
        if (!del.length) continue;
        res.removed.push(e.supplierId);
        await historique(tx, { accountId, itemId, supplierId: e.supplierId, action: 'UNLINKED', provenance: e.provenance, correlationId, detail: { reason: 'EVIDENCE_GONE' } });
      }
      return res;
    });
    if (r) out.push(r);
  }
  const changes = out.filter((r) => r.added.length || r.removed.length || r.upgraded.length);
  if (changes.length && !o.dryRun) {
    console.info(JSON.stringify({
      event: 'agenda_suppliers.auto_sync', accountId, correlationId, items: changes.length,
      added: changes.reduce((s, r) => s + r.added.length, 0), removed: changes.reduce((s, r) => s + r.removed.length, 0),
    }));
  }
  return out;
}

const preuve = (e: AgendaSupplierEvidence): Record<string, unknown> =>
  e.provenance === 'DOCUMENT' ? { kind: 'DIRECT_DOCUMENT_SUPPLIER', documentId: e.documentId ?? null } : { kind: 'EXPLICIT_MENTION', field: e.field ?? null };

/** Éléments DIRECTEMENT rattachés à des documents du compte (déclencheurs). */
export async function itemsDirectlyLinkedToDocuments(accountId: number, fileIds: readonly number[], x: Exec = db): Promise<number[]> {
  if (!fileIds.length) return [];
  const r = await rows<{ id: number }>(x, sql`
    SELECT DISTINCT fl.agenda_item_id AS id
      FROM agenda_file_links fl JOIN agenda_items i ON i.id = fl.agenda_item_id AND i.account_id = ${accountId}
     WHERE fl.asset_file_id = ANY(${ints(fileIds)}) ORDER BY 1 LIMIT ${AGENDA_SUPPLIER_RULES.syncBatch}`);
  return r.map((v) => num(v.id));
}

/** Éléments liés à un fournisseur ou qui le mentionnent potentiellement (renommage, fusion). */
export async function itemsTouchingSupplier(accountId: number, supplierId: number, x: Exec = db): Promise<number[]> {
  const r = await rows<{ id: number }>(x, sql`
    SELECT agenda_item_id AS id FROM agenda_item_suppliers WHERE account_id = ${accountId} AND supplier_id = ${supplierId}
    UNION
    SELECT fl.agenda_item_id FROM agenda_file_links fl
      JOIN document_suppliers ds ON ds.document_id = fl.asset_file_id AND ds.supplier_id = ${supplierId}
      JOIN agenda_items i ON i.id = fl.agenda_item_id AND i.account_id = ${accountId}
    ORDER BY 1 LIMIT ${AGENDA_SUPPLIER_RULES.syncBatch}`);
  return r.map((v) => num(v.id));
}

// ── Fusion de fournisseurs ─────────────────────────────────────────────────

/**
 * Fusion (`from` → `to`, même compte) : liens et retraits manuels reportés
 * sur la fiche conservée, sans doublon ; la provenance la plus forte est
 * gardée ; un lien USER sur la cible l'emporte sur un retrait de la source.
 * Aucun lien orphelin, aucune réassociation hors compte. Dans la transaction
 * de l'appelant.
 */
export async function mergeAgendaSupplierLinksInTx(tx: Tx, p: { accountId: number; fromSupplierId: number; toSupplierId: number; actorUserId?: number | null }): Promise<{ moved: number; merged: number }> {
  if (p.fromSupplierId === p.toSupplierId) return { moved: 0, merged: 0 };
  const corr = `agenda-suppliers:merge:${p.fromSupplierId}->${p.toSupplierId}`;
  const sources = await rows<{ item_id: number; provenance: AgendaSupplierProvenance; target: AgendaSupplierProvenance | null; target_suppressed: boolean }>(tx, sql`
    SELECT l.agenda_item_id AS item_id, l.provenance, t.provenance AS target,
           EXISTS (SELECT 1 FROM agenda_item_supplier_suppressions x WHERE x.agenda_item_id = l.agenda_item_id AND x.supplier_id = ${p.toSupplierId}) AS target_suppressed
      FROM agenda_item_suppliers l
      LEFT JOIN agenda_item_suppliers t ON t.agenda_item_id = l.agenda_item_id AND t.supplier_id = ${p.toSupplierId}
     WHERE l.account_id = ${p.accountId} AND l.supplier_id = ${p.fromSupplierId}`);
  let moved = 0; let merged = 0;
  for (const s of sources) {
    const itemId = num(s.item_id);
    if (s.target) {
      if (AGENDA_SUPPLIER_PROVENANCE_RANK[s.provenance] > AGENDA_SUPPLIER_PROVENANCE_RANK[s.target]) {
        await tx.execute(sql`UPDATE agenda_item_suppliers SET provenance = ${s.provenance}, updated_at = now() WHERE agenda_item_id = ${itemId} AND supplier_id = ${p.toSupplierId}`);
      }
      await tx.execute(sql`DELETE FROM agenda_item_suppliers WHERE agenda_item_id = ${itemId} AND supplier_id = ${p.fromSupplierId}`);
      merged++;
    } else if (s.target_suppressed && s.provenance !== 'USER') {
      // La cible a été RETIRÉE à la main de cet élément : un lien automatique du doublon ne la réintroduit pas.
      await tx.execute(sql`DELETE FROM agenda_item_suppliers WHERE agenda_item_id = ${itemId} AND supplier_id = ${p.fromSupplierId}`);
      merged++;
    } else {
      // Lien USER de la source : geste explicite sur la même identité — il l'emporte sur un retrait de la cible.
      if (s.target_suppressed) await tx.execute(sql`DELETE FROM agenda_item_supplier_suppressions WHERE agenda_item_id = ${itemId} AND supplier_id = ${p.toSupplierId}`);
      await tx.execute(sql`
        UPDATE agenda_item_suppliers SET supplier_id = ${p.toSupplierId}, correlation_id = ${corr}, updated_at = now()
         WHERE agenda_item_id = ${itemId} AND supplier_id = ${p.fromSupplierId}`);
      moved++;
    }
    await historique(tx, { accountId: p.accountId, itemId, supplierId: p.toSupplierId, action: 'MERGED', provenance: s.provenance, actorUserId: p.actorUserId ?? null, correlationId: corr, detail: { fromSupplierId: p.fromSupplierId } });
  }
  // Retraits manuels : reportés sur la cible, sauf lien USER explicite de la cible sur l'élément ;
  // un lien AUTOMATIQUE de la cible sur un élément où l'utilisateur a retiré la source est retiré (même identité refusée).
  await tx.execute(sql`
    DELETE FROM agenda_item_suppliers t USING agenda_item_supplier_suppressions x
     WHERE x.account_id = ${p.accountId} AND x.supplier_id = ${p.fromSupplierId}
       AND t.agenda_item_id = x.agenda_item_id AND t.supplier_id = ${p.toSupplierId} AND t.provenance <> 'USER'`);
  await tx.execute(sql`
    INSERT INTO agenda_item_supplier_suppressions (account_id, agenda_item_id, supplier_id, previous_provenance, suppressed_by_user_id, suppressed_at)
    SELECT x.account_id, x.agenda_item_id, ${p.toSupplierId}, x.previous_provenance, x.suppressed_by_user_id, x.suppressed_at
      FROM agenda_item_supplier_suppressions x
     WHERE x.account_id = ${p.accountId} AND x.supplier_id = ${p.fromSupplierId}
       AND NOT EXISTS (SELECT 1 FROM agenda_item_suppliers t WHERE t.agenda_item_id = x.agenda_item_id AND t.supplier_id = ${p.toSupplierId} AND t.provenance = 'USER')
    ON CONFLICT (agenda_item_id, supplier_id) DO NOTHING`);
  await tx.execute(sql`DELETE FROM agenda_item_supplier_suppressions WHERE account_id = ${p.accountId} AND supplier_id = ${p.fromSupplierId}`);
  return { moved, merged };
}

// ── Déclencheurs (fin d'analyse / T4, gestes) ─────────────────────────────

let abonne = false;

/** Synchronisation automatique, jamais bloquante. */
export async function syncAgendaSuppliersSafely(accountId: number, itemIds: readonly number[], correlationId: string): Promise<void> {
  try {
    if (!itemIds.length) return;
    const { checkAccountProcessingEligibility } = await import('@/services/account/processing-eligibility');
    // Compte non éligible aux traitements (lecture seule, suppression…) : aucun traitement automatique.
    if (!(await checkAccountProcessingEligibility(accountId, { maxAgeMs: 30_000 })).eligible) return;
    await syncAutomaticAgendaSuppliers(accountId, itemIds.slice(0, AGENDA_SUPPLIER_RULES.syncBatch), { correlationId });
  } catch (e) {
    console.error(JSON.stringify({ event: 'agenda_suppliers.auto_sync_failed', accountId, correlationId, code: 'AGENDA_SUPPLIERS_SYNC_FAILED', message: (e as Error).message.slice(0, 200) }));
  }
}

/**
 * Abonnements (démarrage, après le référentiel fournisseurs) ; idempotent.
 *   · fin d'analyse T1 : éléments directement rattachés aux documents
 *     analysés (le fournisseur du document vient d'être établi) ;
 *   · élément créé / modifié, document modifié (fournisseur corrigé, lien
 *     posé ou retiré) : mêmes règles.
 * T4 (file durable) appelle `syncAgendaSuppliersSafely` après ses écritures.
 */
export async function registerAgendaSupplierHandlers(): Promise<void> {
  if (abonne) return;
  abonne = true;
  const [{ onSourceAnalyzed }, { onBusinessEvent }] = await Promise.all([
    import('@/services/ai/source-analysis/events'),
    import('@/services/verebona-assistant/events/business-events'),
  ]);
  onSourceAnalyzed('agenda-fournisseurs', async (e) => {
    const fichiers = [...new Set([e.leadSourceId, ...(e.result.sourceGroup?.sourceIds ?? [])])];
    const ids = await itemsDirectlyLinkedToDocuments(e.accountId, fichiers);
    await syncAgendaSuppliersSafely(e.accountId, ids, `agenda-suppliers:source-analyzed:${e.leadSourceId}`);
  });
  onBusinessEvent('agenda-fournisseurs', async (e) => {
    if (e.accountId == null) return;
    const id = typeof e.entityId === 'number' ? e.entityId : Number(e.entityId);
    if (!Number.isSafeInteger(id) || id <= 0) return;
    if (e.type === 'AGENDA_ITEM_CREATED' || e.type === 'AGENDA_ITEM_UPDATED') {
      await syncAgendaSuppliersSafely(e.accountId, [id], `agenda-suppliers:${e.type.toLowerCase()}:${id}`);
    } else if (e.type === 'DOCUMENT_UPDATED') {
      await syncAgendaSuppliersSafely(e.accountId, await itemsDirectlyLinkedToDocuments(e.accountId, [id]), `agenda-suppliers:document-updated:${id}`);
    } else if (e.type === 'SUPPLIER_CHANGED') {
      await syncAgendaSuppliersSafely(e.accountId, await itemsTouchingSupplier(e.accountId, id), `agenda-suppliers:supplier-changed:${id}`);
    }
  });
}

/** Réservé aux tests. */
export function __resetAgendaSupplierHandlersForTests(): void { abonne = false; }
