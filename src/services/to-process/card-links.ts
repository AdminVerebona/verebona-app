/**
 * Lot 107E — liens directs des cartes « À traiter » (ticket « liens directs
 * vers l'objet et les justificatifs »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE CARTE DIT CE QU'ELLE DEMANDE — ET D'OÙ VIENT CHAQUE PROPOSITION
 *
 * Constat iOS du 02/11/2026 : « Quel est le prix d'acquisition de ce bien ? »
 * (Draisienne, 69,99 € ou 127,93 € actuelle) sans accès à la facture qui
 * justifie 69,99 €. L'utilisateur quittait l'arbitrage pour chercher la pièce.
 *
 * Ce module calcule, À LA LECTURE de la file (aucune migration des cartes :
 * les cartes déjà ouvertes sont couvertes), les destinations d'une carte :
 *   · l'OBJET concerné (document, bien, équipement, pièce, événement,
 *     fournisseur) ;
 *   · les JUSTIFICATIFS : documents EXACTS reliés à la décision par les
 *     relations de preuve déjà persistées — jamais une recherche par nom,
 *     titre, type, montant ou ressemblance ;
 *   · la source de CHAQUE proposition quand elle existe ;
 *   · les objets liés (événement de référence, événement de l'agenda, bien
 *     ou équipement proposé).
 *
 * ── RELATIONS DE PREUVE RÉUTILISÉES (aucune relation concurrente) ─────────
 *
 *   · `proposals[].evidenceIds` numériques → `field_evidence.id` →
 *     `source_type` document / web_link (et anciens `asset_file` / `file`)
 *     → `asset_files.id` ;
 *   · `file:<id>` / `file_<id>` et `sourceContext { targetType: 'DOCUMENT' }`
 *     (cartes de statut, doublons, propositions d'agenda) → `asset_files.id` ;
 *   · `t1:<ref>` : référence interne au document CIBLE de la carte ;
 *   · contexte de la carte (`trigger_context`) : périmètre d'une carte groupée
 *     (105D), documents d'un sinistre ou d'une projection, élément d'agenda,
 *     événement de référence (`operationId` → élément PRINCIPAL) ;
 *   · valeur ACTUELLE d'un bien : dernière écriture journalisée
 *     (`canonical_field_writes`, `outcome = written`) si — et seulement si —
 *     elle porte cette valeur ET vient d'un document. Sinon la valeur actuelle
 *     n'a PAS de source : aucune preuve factice.
 *
 * ── SÉCURITÉ ──────────────────────────────────────────────────────────────
 *
 * Tout est lu dans le compte de la SESSION. Un document supprimé, en cours de
 * dépôt ou d'un autre compte (Duo, bien transféré, donnée incohérente) n'est
 * JAMAIS exposé : ni identifiant ni titre, seulement un compteur
 * « justificatif plus disponible ». Aucune URL de stockage n'est émise : la
 * carte porte des identifiants typés, le tiroir existant relit le document
 * par ses routes autorisées. Une référence techniquement cassée (preuve
 * introuvable, document d'un autre compte) est tracée en Supervision
 * (`admin_anomalies`, domaine « other », consolidée, sans secret).
 *
 * Aucune réanalyse IA, aucun effet de décision : lecture seule.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { areBusinessEquivalent } from '@/services/ai/reconciliation/decision/equivalence';
import type { ActionKind, ActionProposal, TargetType } from './action-model';

// ── Paramètres (centralisés) ────────────────────────────────────────────────

/** Justificatifs listés au plus par carte (« Voir les justificatifs »). */
export const CARD_LINKS_MAX_DOCUMENTS = 10;
/** Références de preuve lues au plus par carte (borne de lecture). */
const CARD_LINKS_MAX_REFS = 40;
/** Un même défaut de référence n'est signalé en Supervision qu'une fois par fenêtre et par processus. */
export const CARD_LINKS_ANOMALY_THROTTLE_MS = 30 * 60 * 1000;

/** Types de document présentés comme une « facture » (référentiel V2 et ancien type). */
const INVOICE_LEGACY_TYPES = new Set(['FACTURE', 'INVOICE']);
export function isInvoiceDocument(documentTypeCode: string | null | undefined, documentType: string | null | undefined): boolean {
  if (documentTypeCode && /_INVOICE$/.test(documentTypeCode)) return true;
  return !!documentType && INVOICE_LEGACY_TYPES.has(documentType.trim().toUpperCase());
}

// ── Contrat (payload des cartes) ────────────────────────────────────────────

/** Destinations natives : tiroir document / équipement / pièce / échéance, page du bien, fiche fournisseur. */
export type CardLinkKind = 'document' | 'asset' | 'equipement' | 'piece' | 'echeance' | 'reference' | 'supplier';

export interface CardLinkRef {
  kind: CardLinkKind;
  /** Identifiant typé et stable : `asset_files.id`, `assets.id`, `equipments.id`, `substructures.id`, `agenda_items.id`, `suppliers.id`. */
  id: number;
  /** Bien : identifiant public de sa page. */
  publicId?: string | null;
  label: string;
  /** Document : facture (« Voir la facture ») ou autre (« Voir le document »). */
  invoice?: boolean;
}

export interface CardProposalLinks {
  /** Documents (`asset_files.id`) qui justifient CETTE proposition — voir `documents`. */
  documents: number[];
  /** Objet que la proposition désigne (bien ou équipement proposé, événement candidat). */
  target: CardLinkRef | null;
  /** Justificatifs de cette proposition devenus inaccessibles. */
  unavailable: number;
}

export interface CardLinks {
  /** Objet concerné par la carte ; `null` : rien à ouvrir. */
  object: CardLinkRef | null;
  /** Objet supprimé / archivé / inaccessible : état explicite, aucun lien. */
  objectUnavailable: CardLinkKind | null;
  /** Événement de référence, événement de l'agenda lié à la carte. */
  related: CardLinkRef[];
  /** Tous les justificatifs ACCESSIBLES de la carte (dédoublonnés, bornés). */
  documents: CardLinkRef[];
  /** Justificatifs portés par la carte elle-même (pas par une proposition). */
  cardDocuments: number[];
  /** Alignées sur les propositions AFFICHÉES (même ordre, même longueur). */
  proposals: CardProposalLinks[];
  /** Justificatifs de la carte (hors propositions) devenus inaccessibles. */
  unavailable: number;
}

// ── Plan (pur) : quelles références la carte porte ─────────────────────────

export interface CardLinkInput {
  publicId: string;
  ruleCode: string;
  actionKind: ActionKind;
  targetType: TargetType;
  targetId: number;
  fieldKey: string | null;
  relationKey: string | null;
  /** Propositions AFFICHÉES, brutes (avant reformulation des libellés). */
  proposals: ActionProposal[];
  triggerContext: unknown;
  /** Fournisseur résolu (cible SUPPLIER). */
  supplierId?: number | null;
}

type PlanTarget = { kind: 'asset' | 'equipement' | 'echeance' | 'reference'; id: number };

interface ProposalPlan {
  evidence: number[];
  files: number[];
  target: PlanTarget | null;
  /** Valeur actuelle d'un bien : source cherchée dans le journal d'écriture. */
  currentOf: { assetId: number; key: string; value: unknown } | null;
}

export interface CardPlan {
  object: { kind: CardLinkKind; id: number } | null;
  cardFiles: number[];
  related: Array<{ kind: 'echeance' | 'reference'; id: number }>;
  proposals: ProposalPlan[];
}

const posInt = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v.trim()) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, CARD_LINKS_MAX_REFS) : []);
const uniq = (xs: number[]) => [...new Set(xs)];

const OBJECT_KIND: Record<TargetType, CardLinkKind> = {
  DOCUMENT: 'document', ASSET: 'asset', EQUIPMENT: 'equipement', ROOM: 'piece', AGENDA_ITEM: 'echeance', SUPPLIER: 'supplier',
};

/** Règles dont la valeur proposée EST l'identifiant du bien à rattacher. */
const ASSET_VALUE_RULES = new Set(['LINK-ASSET']);

/**
 * Références d'une carte (pure, testée) : uniquement des identifiants déjà
 * persistés dans la carte — aucune lecture, aucune heuristique.
 */
export function planCardLinks(c: CardLinkInput): CardPlan {
  const ctx = obj(c.triggerContext) ?? {};
  const targetDoc = c.targetType === 'DOCUMENT' ? c.targetId : null;

  let object: CardPlan['object'] = null;
  if (c.targetType === 'SUPPLIER') {
    const s = posInt(c.supplierId);
    object = s ? { kind: 'supplier', id: s } : null;
  } else {
    object = { kind: OBJECT_KIND[c.targetType], id: c.targetId };
  }

  // Candidats d'agenda / événements de référence offerts par la carte (contrôle d'appartenance).
  const itemCandidates = new Set(arr(ctx.candidates).map((x) => posInt(obj(x)?.itemId)).filter((x): x is number => x !== null));
  const operationCandidates = new Set(arr(ctx.operationIds).map(posInt).filter((x): x is number => x !== null));

  const proposals: ProposalPlan[] = c.proposals.map((p) => {
    const evidence: number[] = [];
    const files: number[] = [];
    for (const raw of (p.evidenceIds ?? []).slice(0, CARD_LINKS_MAX_REFS)) {
      const ref = String(raw).trim();
      const num = posInt(ref);
      if (num !== null) { evidence.push(num); continue; }
      const f = /^file[:_](\d{1,10})$/.exec(ref);
      if (f) { const id = posInt(f[1]); if (id) files.push(id); continue; }
      // `t1:<ref>` : fait lu dans le document CIBLE de la carte.
      if (/^t1:/.test(ref) && targetDoc) files.push(targetDoc);
    }
    let target: PlanTarget | null = null;
    const sc = p.sourceContext;
    const scId = posInt(sc?.targetId);
    if (sc?.targetType === 'DOCUMENT' && scId) files.push(scId);
    else if (sc?.targetType === 'ASSET' && scId) target = { kind: 'asset', id: scId };
    else if (sc?.targetType === 'EQUIPMENT' && scId) target = { kind: 'equipement', id: scId };
    else if (sc?.targetType === 'AGENDA_ITEM' && scId) target = { kind: 'echeance', id: scId };
    if (!target && typeof p.value === 'string') {
      const item = /^ITEM:(\d{1,10})$/.exec(p.value);
      const same = /^SAME:(\d{1,10})$/.exec(p.value);
      const confirm = /^CONFIRM:(\d{1,10})$/.exec(p.value);
      if (item && itemCandidates.has(Number(item[1]))) target = { kind: 'echeance', id: Number(item[1]) };
      else if (same && operationCandidates.has(Number(same[1]))) target = { kind: 'reference', id: Number(same[1]) };
      // Carte groupée (105D) : le bien proposé est celui du contexte de la carte.
      else if (confirm && c.ruleCode === 'LINK-ASSET-GROUP' && posInt(ctx.assetId) === Number(confirm[1])) target = { kind: 'asset', id: Number(confirm[1]) };
    }
    if (!target && ASSET_VALUE_RULES.has(c.ruleCode) && !p.isCurrentValue) {
      const a = posInt(p.value);
      if (a) target = { kind: 'asset', id: a };
    }
    const currentOf = p.isCurrentValue && c.targetType === 'ASSET' && c.fieldKey
      ? { assetId: c.targetId, key: c.fieldKey, value: p.value }
      : null;
    return { evidence: uniq(evidence), files: uniq(files), target, currentOf };
  });

  // Justificatifs portés par la carte : périmètre groupé (105D), documents
  // d'un sinistre (exclusion), provenance d'une projection d'agenda.
  const cardFiles: number[] = [];
  const scope = obj(ctx.scope);
  if (scope) for (const d of arr(scope.documents)) { const id = posInt(obj(d)?.id); if (id) cardFiles.push(id); }
  for (const d of arr(ctx.documents)) { const id = posInt(obj(d)?.fileId); if (id) cardFiles.push(id); }
  for (const f of arr(ctx.fileIds)) { const id = posInt(f); if (id) cardFiles.push(id); }
  const provenance = obj(ctx.provenance);
  if (provenance) for (const d of arr(provenance.documents)) { const id = posInt(obj(d)?.fileId); if (id) cardFiles.push(id); }

  const related: CardPlan['related'] = [];
  const agendaItemId = posInt(ctx.agendaItemId);
  if (agendaItemId && !(object?.kind === 'echeance' && object.id === agendaItemId)) related.push({ kind: 'echeance', id: agendaItemId });
  const operationId = posInt(ctx.operationId);
  if (operationId) related.push({ kind: 'reference', id: operationId });

  return { object, cardFiles: uniq(cardFiles).filter((f) => f !== targetDoc), related, proposals };
}

// ── Données lues (compte de la session) ─────────────────────────────────────

export interface FileInfo {
  state: 'ok' | 'deleted' | 'not_ready' | 'other_account';
  label: string;
  invoice: boolean;
}

export interface LinkData {
  /** `field_evidence.id` → document source (`null` : source non documentaire). Absente : preuve introuvable dans le compte. */
  evidence: Map<number, number | null>;
  /** `asset_files.id` → état ; absente : introuvable. */
  files: Map<number, FileInfo>;
  assets: Map<number, { publicId: string; label: string; available: boolean }>;
  equipments: Map<number, { label: string; available: boolean }>;
  rooms: Map<number, { label: string }>;
  agenda: Map<number, { label: string }>;
  /** Événement de référence : opération → élément d'agenda PRINCIPAL. */
  references: Map<number, { itemId: number; label: string }>;
  suppliers: Map<number, { label: string }>;
  /** `${assetId}:${key}` → dernière écriture appliquée (valeur, document source ou null). */
  currentWrites: Map<string, { value: unknown; fileId: number | null }>;
}

/** Défaut technique d'une référence (Supervision) — jamais pour une suppression volontaire. */
export interface LinkIssue {
  code: 'EVIDENCE_NOT_FOUND' | 'SOURCE_NOT_FOUND' | 'SOURCE_OTHER_ACCOUNT';
  publicId: string;
  ruleCode: string;
  ref: number;
}

const LABELS = {
  document: 'Document',
  asset: 'Bien',
  equipement: 'Équipement',
  piece: 'Pièce',
  echeance: 'Événement',
  reference: 'Événement de référence',
  supplier: 'Fournisseur',
} as const satisfies Record<CardLinkKind, string>;

/**
 * Assemblage (pur, testé) : plan + données → liens affichables. Seuls les
 * objets ACCESSIBLES dans le compte deviennent des liens.
 */
export function assembleCardLinks(c: CardLinkInput, plan: CardPlan, data: LinkData): { links: CardLinks; issues: LinkIssue[] } {
  const issues: LinkIssue[] = [];
  const documents = new Map<number, CardLinkRef>();

  /** Document accessible → son id ; sinon compte l'indisponibilité (et trace un défaut technique). */
  const resolveFile = (fileId: number): number | 'unavailable' => {
    const f = data.files.get(fileId);
    if (!f) { issues.push({ code: 'SOURCE_NOT_FOUND', publicId: c.publicId, ruleCode: c.ruleCode, ref: fileId }); return 'unavailable'; }
    if (f.state === 'other_account') { issues.push({ code: 'SOURCE_OTHER_ACCOUNT', publicId: c.publicId, ruleCode: c.ruleCode, ref: fileId }); return 'unavailable'; }
    if (f.state !== 'ok') return 'unavailable';
    if (!documents.has(fileId) && documents.size < CARD_LINKS_MAX_DOCUMENTS) {
      documents.set(fileId, { kind: 'document', id: fileId, label: f.label, invoice: f.invoice });
    }
    return documents.has(fileId) ? fileId : 'unavailable';
  };

  const resolveTarget = (t: PlanTarget | { kind: CardLinkKind; id: number }): CardLinkRef | null => {
    switch (t.kind) {
      case 'asset': {
        const a = data.assets.get(t.id);
        return a?.available ? { kind: 'asset', id: t.id, publicId: a.publicId, label: a.label } : null;
      }
      case 'equipement': {
        const e = data.equipments.get(t.id);
        return e?.available ? { kind: 'equipement', id: t.id, label: e.label } : null;
      }
      case 'piece': {
        const r = data.rooms.get(t.id);
        return r ? { kind: 'piece', id: t.id, label: r.label } : null;
      }
      case 'echeance': {
        const i = data.agenda.get(t.id);
        return i ? { kind: 'echeance', id: t.id, label: i.label } : null;
      }
      case 'reference': {
        const r = data.references.get(t.id);
        // Le lien ouvre l'élément d'agenda PRINCIPAL (destination native existante).
        return r ? { kind: 'reference', id: r.itemId, label: r.label } : null;
      }
      case 'supplier': {
        const s = data.suppliers.get(t.id);
        return s ? { kind: 'supplier', id: t.id, label: s.label } : null;
      }
      case 'document': {
        const f = data.files.get(t.id);
        return f?.state === 'ok' ? { kind: 'document', id: t.id, label: f.label, invoice: f.invoice } : null;
      }
    }
  };

  // Objet de la carte.
  let object: CardLinkRef | null = null;
  let objectUnavailable: CardLinkKind | null = null;
  if (plan.object) {
    object = resolveTarget(plan.object);
    if (!object) objectUnavailable = plan.object.kind;
  }

  // Propositions : chaque valeur garde SES sources, rien n'est réparti.
  const proposals: CardProposalLinks[] = plan.proposals.map((p) => {
    const ids: number[] = [];
    let unavailable = 0;
    const take = (fileId: number) => {
      const r = resolveFile(fileId);
      if (r === 'unavailable') unavailable += 1; else ids.push(r);
    };
    for (const e of p.evidence) {
      if (!data.evidence.has(e)) {
        issues.push({ code: 'EVIDENCE_NOT_FOUND', publicId: c.publicId, ruleCode: c.ruleCode, ref: e });
        unavailable += 1;
        continue;
      }
      const fileId = data.evidence.get(e);
      if (fileId != null) take(fileId); // source non documentaire (saisie, agenda…) : aucun lien
    }
    for (const f of p.files) take(f);
    if (p.currentOf) {
      const w = data.currentWrites.get(`${p.currentOf.assetId}:${p.currentOf.key}`);
      // Valeur actuelle : source SEULEMENT si la dernière écriture appliquée
      // porte exactement cette valeur et provient d'un document.
      if (w && w.fileId != null && areBusinessEquivalent(p.currentOf.key, w.value, p.currentOf.value)) take(w.fileId);
    }
    return { documents: uniq(ids), target: p.target ? resolveTarget(p.target) : null, unavailable };
  });

  let unavailable = 0;
  const cardDocuments: number[] = [];
  for (const f of plan.cardFiles) {
    const r = resolveFile(f);
    if (r === 'unavailable') unavailable += 1; else cardDocuments.push(r);
  }

  const related = plan.related
    .map((r) => resolveTarget(r))
    .filter((r): r is CardLinkRef => r !== null)
    .filter((r, i, all) => all.findIndex((x) => x.kind === r.kind && x.id === r.id) === i);

  return {
    links: {
      object,
      objectUnavailable,
      related,
      documents: [...documents.values()],
      cardDocuments: uniq(cardDocuments),
      proposals,
      unavailable,
    },
    issues,
  };
}

// ── Lecture (une requête par nature d'objet, compte de la session) ──────────

/** `field_evidence.source_type` désignant un `asset_files.id` (anciens libellés compris, cf. transfert de bien). */
const FILE_SOURCE_TYPES = new Set(['document', 'web_link', 'asset_file', 'file']);

type Row = Record<string, unknown>;
async function q(sql: string, params: unknown[]): Promise<Row[]> {
  return (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];
}
const intArray = (xs: Iterable<number>) => `{${[...new Set(xs)].join(',')}}`;

export function documentLabel(r: { retained_title?: unknown; web_link_title?: unknown; original_filename?: unknown; filename?: unknown }): string {
  const t = [r.retained_title, r.web_link_title, r.original_filename, r.filename]
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .find((x) => x !== '');
  return t ? t.slice(0, 200) : LABELS.document;
}

export async function loadLinkData(accountId: number, plans: CardPlan[]): Promise<LinkData> {
  const evidenceIds = new Set<number>();
  const fileIds = new Set<number>();
  const assetIds = new Set<number>();
  const equipmentIds = new Set<number>();
  const roomIds = new Set<number>();
  const agendaIds = new Set<number>();
  const operationIds = new Set<number>();
  const supplierIds = new Set<number>();
  const currents: Array<{ assetId: number; key: string }> = [];

  const addTarget = (t: { kind: CardLinkKind | PlanTarget['kind']; id: number }) => {
    if (t.kind === 'document') fileIds.add(t.id);
    else if (t.kind === 'asset') assetIds.add(t.id);
    else if (t.kind === 'equipement') equipmentIds.add(t.id);
    else if (t.kind === 'piece') roomIds.add(t.id);
    else if (t.kind === 'echeance') agendaIds.add(t.id);
    else if (t.kind === 'reference') operationIds.add(t.id);
    else if (t.kind === 'supplier') supplierIds.add(t.id);
  };
  for (const p of plans) {
    if (p.object) addTarget(p.object);
    p.cardFiles.forEach((f) => fileIds.add(f));
    p.related.forEach(addTarget);
    for (const pr of p.proposals) {
      pr.evidence.forEach((e) => evidenceIds.add(e));
      pr.files.forEach((f) => fileIds.add(f));
      if (pr.target) addTarget(pr.target);
      if (pr.currentOf) currents.push({ assetId: pr.currentOf.assetId, key: pr.currentOf.key });
    }
  }

  const data: LinkData = {
    evidence: new Map(), files: new Map(), assets: new Map(), equipments: new Map(), rooms: new Map(),
    agenda: new Map(), references: new Map(), suppliers: new Map(), currentWrites: new Map(),
  };

  // 1. Preuves (compte) → document source.
  if (evidenceIds.size) {
    for (const r of await q(
      `SELECT id, source_type, source_id FROM field_evidence WHERE account_id = $1 AND id = ANY($2::int[])`,
      [accountId, intArray(evidenceIds)],
    )) {
      const doc = typeof r.source_type === 'string' && FILE_SOURCE_TYPES.has(r.source_type) ? posInt(r.source_id) : null;
      data.evidence.set(Number(r.id), doc);
      if (doc) fileIds.add(doc);
    }
  }

  // 2. Valeur actuelle d'un bien : dernière écriture APPLIQUÉE (journal).
  if (currents.length) {
    const rows = await q(
      `SELECT DISTINCT ON (asset_id, canonical_key) asset_id, canonical_key, new_value, source_type, source_id
         FROM canonical_field_writes
        WHERE account_id = $1 AND asset_id = ANY($2::int[]) AND canonical_key = ANY($3::text[])
          AND outcome = 'written' AND dry_run = false AND target_type IS NULL
        ORDER BY asset_id, canonical_key, created_at DESC, id DESC`,
      [accountId, intArray(currents.map((c) => c.assetId)), `{${[...new Set(currents.map((c) => `"${c.key.replace(/["\\]/g, '')}"`))].join(',')}}`],
    );
    for (const r of rows) {
      const fileId = r.source_type === 'document' || r.source_type === 'DOCUMENT' ? posInt(r.source_id) : null;
      data.currentWrites.set(`${Number(r.asset_id)}:${String(r.canonical_key)}`, { value: r.new_value, fileId });
      if (fileId) fileIds.add(fileId);
    }
  }

  // 3. Documents : lus SANS filtre de compte pour CLASSER (autre compte →
  //    défaut tracé), jamais pour exposer — seul l'état du compte de la
  //    session devient un lien.
  if (fileIds.size) {
    for (const r of await q(
      `SELECT id, account_id, deleted_at, upload_status, retained_title, web_link_title, original_filename, filename,
              document_type_code, document_type
         FROM asset_files WHERE id = ANY($1::int[])`,
      [intArray(fileIds)],
    )) {
      const mine = Number(r.account_id) === accountId;
      const state: FileInfo['state'] = !mine ? 'other_account'
        : r.deleted_at ? 'deleted'
          : r.upload_status && r.upload_status !== 'COMPLETED' ? 'not_ready'
            : 'ok';
      data.files.set(Number(r.id), {
        state,
        label: state === 'ok' ? documentLabel(r) : LABELS.document,
        invoice: state === 'ok' && isInvoiceDocument(r.document_type_code as string | null, r.document_type as string | null),
      });
    }
  }

  if (assetIds.size) {
    for (const r of await q(
      `SELECT id, public_id, name, deleted_at FROM assets WHERE account_id = $1 AND id = ANY($2::int[])`,
      [accountId, intArray(assetIds)],
    )) data.assets.set(Number(r.id), { publicId: String(r.public_id), label: String(r.name ?? '').trim() || LABELS.asset, available: !r.deleted_at });
  }
  if (equipmentIds.size) {
    for (const r of await q(
      `SELECT e.id, e.name, e.archived_at, a.deleted_at FROM equipments e JOIN assets a ON a.id = e.asset_id
        WHERE a.account_id = $1 AND e.id = ANY($2::int[])`,
      [accountId, intArray(equipmentIds)],
    )) data.equipments.set(Number(r.id), { label: String(r.name ?? '').trim() || LABELS.equipement, available: !r.archived_at && !r.deleted_at });
  }
  if (roomIds.size) {
    for (const r of await q(
      `SELECT s.id, s.name FROM substructures s JOIN assets a ON a.id = s.asset_id
        WHERE a.account_id = $1 AND a.deleted_at IS NULL AND s.id = ANY($2::int[])`,
      [accountId, intArray(roomIds)],
    )) data.rooms.set(Number(r.id), { label: String(r.name ?? '').trim() || LABELS.piece });
  }
  if (agendaIds.size) {
    for (const r of await q(
      `SELECT id, title FROM agenda_items WHERE account_id = $1 AND id = ANY($2::int[])`,
      [accountId, intArray(agendaIds)],
    )) data.agenda.set(Number(r.id), { label: String(r.title ?? '').trim() || LABELS.echeance });
  }
  if (operationIds.size) {
    for (const r of await q(
      `SELECT DISTINCT ON (business_operation_id) business_operation_id AS op, id, title
         FROM agenda_items
        WHERE account_id = $1 AND business_operation_id = ANY($2::bigint[]) AND operation_role = 'PRINCIPAL'
        ORDER BY business_operation_id, id`,
      [accountId, intArray(operationIds)],
    )) data.references.set(Number(r.op), { itemId: Number(r.id), label: String(r.title ?? '').trim() || LABELS.reference });
  }
  if (supplierIds.size) {
    for (const r of await q(
      `SELECT id, name FROM suppliers WHERE account_id = $1 AND id = ANY($2::int[]) AND status <> 'deleted'`,
      [accountId, intArray(supplierIds)],
    )) data.suppliers.set(Number(r.id), { label: String(r.name ?? '').trim() || LABELS.supplier });
  }
  return data;
}

// ── Supervision (défauts techniques, consolidés, sans secret) ───────────────

const lastReported = new Map<string, number>();

/** Tests : oublie la mémoire de limitation des signalements. */
export function resetCardLinkAnomalyThrottle(): void {
  lastReported.clear();
}

const ISSUE_TITLES: Record<LinkIssue['code'], string> = {
  EVIDENCE_NOT_FOUND: 'À traiter : preuve référencée par une carte introuvable',
  SOURCE_NOT_FOUND: 'À traiter : document source d’une carte introuvable',
  SOURCE_OTHER_ACCOUNT: 'À traiter : document source d’une carte hors du compte (non exposé)',
};

/** Signale les défauts (une anomalie ouverte par code et par compte). N'échoue jamais. */
export async function reportCardLinkIssues(accountId: number, issues: LinkIssue[], now = Date.now()): Promise<number> {
  if (!issues.length) return 0;
  const { reportAnomaly, buildFingerprint } = await import('@/services/admin/anomaly.service');
  let n = 0;
  const parCode = new Map<LinkIssue['code'], LinkIssue[]>();
  for (const i of issues) parCode.set(i.code, [...(parCode.get(i.code) ?? []), i]);
  for (const [code, lot] of parCode) {
    const fingerprint = buildFingerprint('other', 'a-traiter-liens', code, accountId);
    const last = lastReported.get(fingerprint);
    if (last !== undefined && now - last < CARD_LINKS_ANOMALY_THROTTLE_MS) continue;
    lastReported.set(fingerprint, now);
    try {
      const id = await reportAnomaly({
        domain: 'other', fingerprint, title: ISSUE_TITLES[code], accountId,
        detail: {
          code,
          cards: lot.slice(0, 10).map((i) => ({ publicId: i.publicId, ruleCode: i.ruleCode, ref: i.ref })),
          count: lot.length,
        },
      });
      if (id !== null) n += 1;
    } catch (e) {
      console.error('[to-process/links] signalement Supervision impossible :', (e as Error).message);
    }
  }
  return n;
}

/**
 * Liens de plusieurs cartes, en un passage (lecture groupée). Les défauts
 * techniques partent en Supervision sans retarder la réponse.
 */
export async function resolveCardLinks(
  accountId: number,
  cards: CardLinkInput[],
  opts: { awaitReport?: boolean } = {},
): Promise<Map<string, CardLinks>> {
  const out = new Map<string, CardLinks>();
  if (!cards.length) return out;
  const plans = cards.map((c) => planCardLinks(c));
  const data = await loadLinkData(accountId, plans);
  const issues: LinkIssue[] = [];
  cards.forEach((c, i) => {
    const r = assembleCardLinks(c, plans[i], data);
    out.set(c.publicId, r.links);
    issues.push(...r.issues);
  });
  const report = reportCardLinkIssues(accountId, issues).catch(() => 0);
  if (opts.awaitReport) await report;
  return out;
}

/** Une destination est-elle offerte par ces liens ? (revalidation au clic) */
export function linksOffer(links: CardLinks, t: { kind: CardLinkKind; id: number }): boolean {
  const same = (r: CardLinkRef | null | undefined) => !!r && r.kind === t.kind && r.id === t.id;
  if (same(links.object)) return true;
  if (links.related.some(same)) return true;
  if (t.kind === 'document' && links.documents.some((d) => d.id === t.id)) return true;
  return links.proposals.some((p) => same(p.target));
}

export type CardLinkCheck = 'ok' | 'gone' | 'resolved';

/**
 * Revalidation AU CLIC (compte de la session) : la carte existe dans le
 * compte, la destination fait partie de SES liens recalculés maintenant, et
 * elle est toujours accessible. Aucune destination arbitraire : un
 * identifiant hors des liens de la carte est refusé (`gone`), sans dire
 * pourquoi (anti-énumération).
 */
export async function checkCardLink(accountId: number, publicId: string, t: { kind: CardLinkKind; id: number }): Promise<CardLinkCheck> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(publicId)) return 'gone';
  const [row] = await q(
    `SELECT public_id::text AS public_id, rule_code, action_kind, target_type, target_id, field_key, relation_key,
            proposals_json, trigger_context, resolved_at
       FROM to_process_actions WHERE account_id = $1 AND public_id = $2::uuid LIMIT 1`,
    [accountId, publicId],
  );
  if (!row) return 'gone';
  if (row.resolved_at) return 'resolved';
  const { selectDisplayedProposals } = await import('./action-model');
  let supplierId: number | null = null;
  if (row.target_type === 'SUPPLIER') {
    // Même résolution que la file (revue ouverte → vrai fournisseur), jamais deviné.
    const { hydrateSupplierTargets } = await import('./to-process-query.service');
    supplierId = (await hydrateSupplierTargets(accountId, [Number(row.target_id)])).get(`SUPPLIER:${Number(row.target_id)}`)?.supplierId ?? null;
  }
  const card: CardLinkInput = {
    publicId: String(row.public_id), ruleCode: String(row.rule_code), actionKind: row.action_kind as ActionKind,
    targetType: row.target_type as TargetType, targetId: Number(row.target_id),
    fieldKey: (row.field_key as string | null) ?? null, relationKey: (row.relation_key as string | null) ?? null,
    proposals: selectDisplayedProposals((row.proposals_json as ActionProposal[] | null) ?? []),
    triggerContext: row.trigger_context, supplierId,
  };
  const links = (await resolveCardLinks(accountId, [card])).get(card.publicId);
  if (links && linksOffer(links, t)) return 'ok';
  // Lot 110D : référence ACTUELLE de l'Opération d'une question « même réalité » binaire.
  const { binaryMatchReferenceOffered } = await import('./operation-match-binary');
  return (await binaryMatchReferenceOffered(accountId, card, t)) ? 'ok' : 'gone';
}
