/**
 * Regroupement des Opérations — vocabulaire et règles PURES (lot 82D, CDC
 * « Opérations, Agenda, Timeline, Sinistres v5 », lot O-1 ; arbitrages PO
 * V-Q4, V-Q5, V-Q6, V-Q8 du 23/10/2026).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUI DÉCIDE QUOI (V-Q5)
 *
 *   T1  extrait faits et signaux (cibles Pièce / équipement certaines…) ;
 *   T3  consolide l'Opération (documents, biens, Pièces, équipements) ;
 *   T4  décide la représentation Agenda, y compris l'EXISTENCE et l'identité
 *       de l'élément principal (projection des Opérations : `projectionRoleOf`
 *       traduit la table C16 de la projection ; la décision IA par document
 *       relève d'une évolution de contrat — demande 82D-t4-principal) ;
 *   le CODE orchestre, persiste, rattache et dédoublonne : les fonctions de ce
 *   module ne prennent AUCUNE décision sémantique (aucun mot-clé, aucune
 *   ressemblance d'intitulé) ; elles appliquent des décisions déjà prises et
 *   maintiennent les invariants structurels.
 *
 * Terme « principal » : strictement interne (jamais affiché, P1).
 * « Pièce » : seul terme métier (V-Q6) ; identifiant technique historique
 * `substructure_id` (table `substructures`, fusion D-G 0229).
 * ══════════════════════════════════════════════════════════════════════════
 */

// ── Vocabulaire (aligné sur les contraintes 0652 / 0654 / 0655 / 0656) ─────

export const OPERATION_ROLES = ['PRINCIPAL', 'RELATED'] as const;
export type OperationRole = (typeof OPERATION_ROLES)[number];

/** Auteur du rôle d'un élément : T4 (projection), USER (geste), T3, SYSTEM (reprise déterministe). */
export const ROLE_ORIGINS = ['T4', 'USER', 'T3', 'SYSTEM'] as const;
export type RoleOrigin = (typeof ROLE_ORIGINS)[number];

/** Justifications d'un lien Document ↔ Agenda (§7.4). */
export const LINK_PROVENANCES = ['MANUAL_DIRECT', 'AI_DIRECT', 'OPERATION_PRINCIPAL'] as const;
export type LinkProvenance = (typeof LINK_PROVENANCES)[number];

/** Origines de l'appartenance d'un document (§27.3). */
export const MEMBERSHIP_ORIGINS = ['SOURCE', 'USER'] as const;
export type MembershipOrigin = (typeof MEMBERSHIP_ORIGINS)[number];

/**
 * Objets de la mémoire des décisions utilisateur (`business_operation_match_decisions.source_kind`) :
 * DOCUMENT et AGENDA (existants), ROOM, EQUIPMENT, PRINCIPAL_LINK (0656). Le bien
 * garde sa mémoire d'exclusion (0349).
 */
export const DECISION_SUBJECTS = ['DOCUMENT', 'AGENDA', 'ROOM', 'EQUIPMENT', 'PRINCIPAL_LINK'] as const;
export type DecisionSubject = (typeof DECISION_SUBJECTS)[number];

export const isLinkProvenance = (v: unknown): v is LinkProvenance => typeof v === 'string' && (LINK_PROVENANCES as readonly string[]).includes(v);

// ── Autorité sur le rôle principal ──────────────────────────────────────────

/** Rang d'autorité : USER > T4 > T3 > SYSTEM (une décision utilisateur prime, §10, P8). */
export const ROLE_ORIGIN_RANK: Readonly<Record<RoleOrigin, number>> = { USER: 3, T4: 2, T3: 1, SYSTEM: 0 };

/**
 * Un auteur peut-il remplacer le principal en place ? Oui si son autorité est
 * au moins égale (T4 corrige sa propre décision, jamais celle de l'utilisateur).
 */
export function canReplacePrincipal(current: RoleOrigin | null, requester: RoleOrigin): boolean {
  if (current === null) return true;
  return ROLE_ORIGIN_RANK[requester] >= ROLE_ORIGIN_RANK[current];
}

/**
 * Rôle de l'élément qui REPRÉSENTE une Opération dans la projection T4 (table
 * C16, `agenda-projection/model.ts`) : l'historique d'une intervention, d'un
 * sinistre, d'un achat ou d'une cession est l'événement global (PRINCIPAL) ;
 * une échéance de contrat est une étape (RELATED) — une relation durable
 * n'impose aucun événement global (§11.10, AC52).
 */
export function projectionRoleOf(projectionKey: string | null): OperationRole {
  if (!projectionKey) return 'RELATED';
  const head = projectionKey.split(':')[0];
  return head === 'INTERVENTION' || head === 'CLAIM' || head === 'ACQUISITION' || head === 'DISPOSAL' ? 'PRINCIPAL' : 'RELATED';
}

/**
 * Lot 83A (CDC v5 O-7, §11.10, AC52) — RELATIONS DURABLES : une relation
 * contractuelle ou un financement n'appellent jamais d'événement global ;
 * aucun principal n'y est DÉDUIT (T4, T3, reprise) — un choix de
 * l'utilisateur reste. Traduction de la table C16 (aucune projection
 * d'événement global pour ces types), sans jugement sémantique.
 */
export const DURABLE_RELATION_TYPES = ['CONTRACT', 'FINANCING'] as const;
export const isDurableRelation = (typeCode: string | null | undefined): boolean =>
  typeCode != null && (DURABLE_RELATION_TYPES as readonly string[]).includes(typeCode);

// ── Provenances d'un lien ───────────────────────────────────────────────────

/** Ensemble normalisé (ordre du vocabulaire, sans doublon ni valeur inconnue). */
export function normalizeProvenances(v: readonly unknown[] | null | undefined): LinkProvenance[] {
  const s = new Set((v ?? []).filter(isLinkProvenance));
  return LINK_PROVENANCES.filter((p) => s.has(p));
}
export const withProvenance = (v: readonly unknown[] | null | undefined, p: LinkProvenance): LinkProvenance[] => normalizeProvenances([...(v ?? []), p]);
export const withoutProvenance = (v: readonly unknown[] | null | undefined, p: LinkProvenance | 'ALL'): LinkProvenance[] =>
  (p === 'ALL' ? [] : normalizeProvenances(v).filter((x) => x !== p));

/**
 * Provenance par défaut d'un lien existant sans justification (reprise 0654 et
 * réparation INV-O1-PROVENANCE) : principal projeté → OPERATION_PRINCIPAL ;
 * élément projeté ou automatique → AI_DIRECT ; élément saisi → MANUAL_DIRECT.
 * Déterministe : lit l'origine de l'élément, jamais son contenu.
 */
export function inferredProvenance(item: { projected: boolean; isAutomatic: boolean; role: OperationRole | null }): LinkProvenance {
  if (item.projected && item.role === 'PRINCIPAL') return 'OPERATION_PRINCIPAL';
  if (item.projected || item.isAutomatic) return 'AI_DIRECT';
  return 'MANUAL_DIRECT';
}

// ── Propagation des documents vers le principal (§7.1, §7.2, §11.9, P4) ────

export interface PrincipalLinkSnapshot {
  /** Élément principal de l'Opération (null : Opération sans principal). */
  principalItemId: number | null;
  /** Éléments membres de l'Opération. */
  memberItemIds: readonly number[];
  /** Documents membres actifs (appartenance), non supprimés. */
  memberFileIds: readonly number[];
  /** Documents dont l'utilisateur a retiré le lien vers le principal (PRINCIPAL_LINK rejeté). */
  rejectedFileIds: readonly number[];
  /** Liens Document ↔ Agenda des éléments membres. */
  links: ReadonlyArray<{ itemId: number; fileId: number; provenances: readonly string[] }>;
}

export interface PrincipalLinkPlan {
  /** OPERATION_PRINCIPAL à ajouter (lien créé s'il n'existe pas). */
  add: Array<{ itemId: number; fileId: number }>;
  /** OPERATION_PRINCIPAL à retirer (lien supprimé s'il ne reste aucune provenance). */
  remove: Array<{ itemId: number; fileId: number }>;
}

/**
 * Plan de propagation (pur, idempotent : un état conforme rend un plan vide).
 *   · principal présent : chaque document membre non refusé lui est lié
 *     (OPERATION_PRINCIPAL) ; les liens précis existants sont conservés (§7.3) ;
 *   · OPERATION_PRINCIPAL retiré d'un élément qui n'est plus principal
 *     (changement de principal : transfert, §11.9), ou pour un document qui
 *     n'est plus membre, ou refusé par l'utilisateur.
 */
export function planPrincipalLinks(s: PrincipalLinkSnapshot): PrincipalLinkPlan {
  const members = new Set(s.memberFileIds);
  const rejected = new Set(s.rejectedFileIds);
  const add: PrincipalLinkPlan['add'] = [];
  const remove: PrincipalLinkPlan['remove'] = [];
  const parPrincipal = new Map<number, readonly string[]>();
  for (const l of s.links) {
    const propage = l.provenances.includes('OPERATION_PRINCIPAL');
    if (l.itemId === s.principalItemId) {
      parPrincipal.set(l.fileId, l.provenances);
      if (propage && (!members.has(l.fileId) || rejected.has(l.fileId))) remove.push({ itemId: l.itemId, fileId: l.fileId });
    } else if (propage) {
      remove.push({ itemId: l.itemId, fileId: l.fileId });
    }
  }
  if (s.principalItemId !== null) {
    for (const f of [...members].sort((a, b) => a - b)) {
      if (rejected.has(f)) continue;
      const p = parPrincipal.get(f);
      if (!p || !p.includes('OPERATION_PRINCIPAL')) add.push({ itemId: s.principalItemId, fileId: f });
    }
  }
  const tri = (a: { itemId: number; fileId: number }, b: { itemId: number; fileId: number }) => a.itemId - b.itemId || a.fileId - b.fileId;
  return { add: add.sort(tri), remove: remove.sort(tri) };
}

// ── Lien Agenda ↔ Agenda (§8.2, §8.3) ─────────────────────────────────────

export type LinkAgendaPlan =
  | { kind: 'CREATE' }
  | { kind: 'ATTACH'; operationId: number; itemId: number }
  | { kind: 'NOOP'; operationId: number }
  | { kind: 'MERGE'; canonicalId: number; absorbedId: number };

/**
 * Les quatre cas du §8.3 (pur). `operationId` : Opération ACTIVE de
 * l'élément, sinon null. Fusion : la plus ancienne Opération est canonique
 * (règle stable, sans jugement sur le contenu).
 */
export function planLinkAgendaItems(a: { itemId: number; operationId: number | null }, b: { itemId: number; operationId: number | null }): LinkAgendaPlan {
  if (a.operationId === null && b.operationId === null) return { kind: 'CREATE' };
  if (a.operationId !== null && b.operationId === null) return { kind: 'ATTACH', operationId: a.operationId, itemId: b.itemId };
  if (a.operationId === null && b.operationId !== null) return { kind: 'ATTACH', operationId: b.operationId, itemId: a.itemId };
  if (a.operationId === b.operationId) return { kind: 'NOOP', operationId: a.operationId! };
  const [canonicalId, absorbedId] = [a.operationId!, b.operationId!].sort((x, y) => x - y);
  return { kind: 'MERGE', canonicalId, absorbedId };
}

// ── Fusion : principal conservé (V-Q4 : jamais deux principaux) ─────────────

/**
 * Principal de la canonique après fusion (pur) : la canonique garde le sien ;
 * à défaut, celui de l'absorbée est conservé (même réalité, décision déjà
 * prise par T4 ou l'utilisateur) ; l'autre redevient un élément lié (RELATED)
 * — jamais absorbé ni supprimé (§6.5 : même Opération ≠ doublon).
 */
export function principalAfterMerge(
  canonical: { itemId: number; origin: RoleOrigin | null } | null,
  absorbed: { itemId: number; origin: RoleOrigin | null } | null,
): { keep: { itemId: number; origin: RoleOrigin | null } | null; demote: number[] } {
  if (canonical && absorbed) {
    // Une décision utilisateur de l'absorbée prime sur une décision automatique de la canonique.
    if (ROLE_ORIGIN_RANK[absorbed.origin ?? 'SYSTEM'] > ROLE_ORIGIN_RANK[canonical.origin ?? 'SYSTEM']) return { keep: absorbed, demote: [canonical.itemId] };
    return { keep: canonical, demote: [absorbed.itemId] };
  }
  return { keep: canonical ?? absorbed, demote: [] };
}

// ── Garde anti-cartésienne Document × Équipement (§9.4, P19, AC50) ─────────

/** Preuve d'un lien direct Document → Équipement, portée par CE document. */
export interface DocumentEquipmentEvidence {
  kind: 'USER' | 'T1_TARGET' | 'IDENTIFIER' | 'AI_DECISION';
  /** Document qui porte la preuve : doit être celui du lien. */
  fileId: number;
  ref?: string | null;
}

export interface DocumentEquipmentProposal {
  fileId: number;
  equipmentId: number;
  evidence: DocumentEquipmentEvidence | null;
}

export type CartesianRejection = 'NO_PER_DOCUMENT_EVIDENCE' | 'NOT_MEMBER' | 'EQUIPMENT_NOT_IN_OPERATION' | 'SHARED_EVIDENCE';

/**
 * Garde (pure) : l'appartenance commune à une Opération n'est JAMAIS une
 * preuve qu'un document concerne un équipement. Un lien n'est accepté que
 * s'il porte une preuve propre au document (même `fileId`) ; une même preuve
 * (`ref`) réutilisée pour plusieurs documents est refusée (propagation
 * déguisée). Rend les liens acceptés et les refus motivés.
 */
export function guardDocumentEquipmentLinks(
  proposals: readonly DocumentEquipmentProposal[],
  ctx: { memberFileIds: readonly number[]; equipmentIds: readonly number[] },
): { accepted: DocumentEquipmentProposal[]; rejected: Array<DocumentEquipmentProposal & { reason: CartesianRejection }> } {
  const members = new Set(ctx.memberFileIds);
  const equips = new Set(ctx.equipmentIds);
  const refs = new Map<string, Set<number>>();
  for (const p of proposals) {
    if (p.evidence?.ref) refs.set(`${p.evidence.kind}:${p.evidence.ref}`, (refs.get(`${p.evidence.kind}:${p.evidence.ref}`) ?? new Set()).add(p.fileId));
  }
  const accepted: DocumentEquipmentProposal[] = [];
  const rejected: Array<DocumentEquipmentProposal & { reason: CartesianRejection }> = [];
  for (const p of proposals) {
    if (!members.has(p.fileId)) rejected.push({ ...p, reason: 'NOT_MEMBER' });
    else if (!equips.has(p.equipmentId)) rejected.push({ ...p, reason: 'EQUIPMENT_NOT_IN_OPERATION' });
    else if (!p.evidence || p.evidence.fileId !== p.fileId) rejected.push({ ...p, reason: 'NO_PER_DOCUMENT_EVIDENCE' });
    else if (p.evidence.ref && p.evidence.kind !== 'USER' && (refs.get(`${p.evidence.kind}:${p.evidence.ref}`)?.size ?? 0) > 1) rejected.push({ ...p, reason: 'SHARED_EVIDENCE' });
    else accepted.push(p);
  }
  return { accepted, rejected };
}

/**
 * Détection (pure) d'un produit cartésien déjà présent : ≥ 2 documents membres
 * et ≥ 2 équipements de l'Opération, TOUS les couples liés directement par des
 * liens non utilisateur. Signal à examiner (C-Q2 : aucune suppression
 * arbitraire), jamais réparé automatiquement.
 */
export function detectCartesian(s: {
  memberFileIds: readonly number[]; equipmentIds: readonly number[];
  links: ReadonlyArray<{ fileId: number; equipmentId: number; userOrigin: boolean }>;
}): { cartesian: boolean; pairs: number } {
  const d = [...new Set(s.memberFileIds)];
  const e = [...new Set(s.equipmentIds)];
  if (d.length < 2 || e.length < 2) return { cartesian: false, pairs: 0 };
  const auto = new Set(s.links.filter((l) => !l.userOrigin).map((l) => `${l.fileId}:${l.equipmentId}`));
  const all = d.every((f) => e.every((q) => auto.has(`${f}:${q}`)));
  return { cartesian: all, pairs: all ? d.length * e.length : 0 };
}
