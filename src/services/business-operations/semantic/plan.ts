/**
 * Lot 87B (CODE-08, CODE-09, CODE-11) — décision T4 VALIDÉE → mutations.
 * PUR.
 *
 * Seules les décisions CERTAINES produisent une mutation ; les autres sont
 * tracées (refus `NOT_CERTAIN`) sans rien changer. Une mutation qui touche
 * un objet protégé est REFUSÉE et tracée — jamais forcée :
 *   · élément touché par l'utilisateur (saisi, modifié, statut, confirmé),
 *     restauré par lui, ou de statut encore ouvert : jamais absorbé ;
 *   · rattachement de l'utilisateur : jamais détaché ni absorbé ;
 *   · élément que l'utilisateur a détaché de cette Opération : jamais
 *     rattaché à nouveau ;
 *   · principal choisi par l'utilisateur, rôle principal retiré par lui :
 *     aucun principal déduit ne le remplace ;
 *   · élément lié à une AUTRE Opération active : jamais déplacé.
 * Un état déjà conforme ne produit AUCUNE mutation (idempotence) : la même
 * décision rejouée sur l'état qu'elle a produit est un no-op.
 */
import type { RefusedMutation, RepresentationMutation, T4AgendaRepresentationOutput } from './contract';
import type { DecidedRole } from './store';
import type { RepresentationScope, ScopeItem } from './context';

export interface RepresentationPlan {
  mutations: RepresentationMutation[];
  refused: RefusedMutation[];
}

const ordre: Record<RepresentationMutation['kind'], number> = { RESTORE: 0, ATTACH: 1, DETACH: 2, CONSOLIDATE: 3, REMOVE_PROJECTION: 4 };

export function planRepresentation(decision: T4AgendaRepresentationOutput, scope: RepresentationScope): RepresentationPlan {
  const mutations: RepresentationMutation[] = [];
  const refused: RefusedMutation[] = [];
  if (decision.outcome === 'ABSTAIN') return { mutations, refused };
  const parRef = new Map(scope.items.map((i) => [i.ref, i]));
  const opId = scope.operationId;
  const userPrincipal = scope.userPrincipalItemId;
  const autreOp = (i: ScopeItem) => i.operationId !== null && i.operationId !== opId && i.operationActive;

  /** Rôle effectif après les protections du principal. */
  const roleVoulu = (role: 'PRINCIPAL' | 'STEP', i: ScopeItem): { role: 'PRINCIPAL' | 'RELATED'; refus?: RefusedMutation['reason'] } => {
    if (role === 'STEP') return { role: 'RELATED' };
    if (userPrincipal !== null && userPrincipal !== i.id) return { role: 'RELATED', refus: 'USER_PRINCIPAL' };
    if (scope.principalWithdrawn && !(i.operationId === opId && i.role === 'PRINCIPAL')) return { role: 'RELATED', refus: 'PRINCIPAL_WITHDRAWN' };
    return { role: 'PRINCIPAL' };
  };

  const attacher = (i: ScopeItem, role: 'PRINCIPAL' | 'STEP', reason: string) => {
    const r = roleVoulu(role, i);
    if (r.refus) refused.push({ mutation: { kind: 'ATTACH', itemId: i.id, role: 'PRINCIPAL', reason }, reason: r.refus });
    // Rétrograder un principal choisi par l'utilisateur : jamais.
    if (r.role === 'RELATED' && i.operationId === opId && i.role === 'PRINCIPAL' && (i.roleOrigin === 'USER' || userPrincipal === i.id)) {
      refused.push({ mutation: { kind: 'ATTACH', itemId: i.id, role: 'RELATED', reason }, reason: 'USER_PRINCIPAL' });
      return;
    }
    if (i.operationId === opId && i.role === r.role) return; // déjà conforme
    mutations.push({ kind: 'ATTACH', itemId: i.id, role: r.role, reason });
  };

  for (const o of decision.occurrences) {
    const items = o.items.map((ref) => parRef.get(ref)).filter((x): x is ScopeItem => !!x);
    const keep = parRef.get(o.keep);
    if (!keep) continue;
    const motif = `T4 : ${o.reason}`.slice(0, 300);
    if (o.confidence !== 'certain') {
      for (const i of items) refused.push({ mutation: { kind: 'DECISION', ref: i.ref }, reason: 'NOT_CERTAIN' });
      continue;
    }
    if (o.role === 'INDEPENDENT') {
      for (const i of items) {
        if (i.operationId !== opId) continue; // déjà hors de l'Opération
        if (i.userAttached) { refused.push({ mutation: { kind: 'DETACH', itemId: i.id, reason: motif }, reason: 'USER_ATTACHED' }); continue; }
        mutations.push({ kind: 'DETACH', itemId: i.id, reason: motif });
      }
      continue;
    }
    // Élément conservé : rattaché avec son rôle (sauf protections).
    if (autreOp(keep)) {
      refused.push({ mutation: { kind: 'ATTACH', itemId: keep.id, role: o.role === 'PRINCIPAL' ? 'PRINCIPAL' : 'RELATED', reason: motif }, reason: 'LINKED_ELSEWHERE' });
    } else if (keep.userDetached) {
      refused.push({ mutation: { kind: 'ATTACH', itemId: keep.id, role: o.role === 'PRINCIPAL' ? 'PRINCIPAL' : 'RELATED', reason: motif }, reason: 'USER_DETACHED' });
    } else {
      attacher(keep, o.role, motif);
    }
    // Doublons / représentations complémentaires : absorbés par `keep` (preuves et liens conservés).
    const absorbes: number[] = [];
    for (const i of items) {
      if (i.id === keep.id) continue;
      if (autreOp(i)) { refused.push({ mutation: { kind: 'CONSOLIDATE', keepId: keep.id, absorbIds: [i.id], reason: motif }, reason: 'LINKED_ELSEWHERE' }); continue; }
      if (i.projected) {
        // Projection technique de l'Opération : retirée si intacte (trace restaurable), jamais si l'utilisateur l'a touchée.
        if (i.touched) refused.push({ mutation: { kind: 'REMOVE_PROJECTION', itemId: i.id, keepId: keep.id, reason: motif }, reason: 'PROJECTION_TOUCHED' });
        else mutations.push({ kind: 'REMOVE_PROJECTION', itemId: i.id, keepId: keep.id, reason: motif });
        continue;
      }
      const refus = i.restoredByUser ? 'RESTORED_BY_USER' as const
        : i.touched ? 'USER_TOUCHED' as const
          : i.pendingStatus ? 'PENDING_USER_STATUS' as const
            : i.userAttached ? 'USER_ATTACHED' as const
              // L'utilisateur a sorti cet élément de l'Opération : l'absorber l'y ramènerait.
              : i.userDetached ? 'USER_DETACHED' as const
                // L'utilisateur a détaché de l'élément conservé un document de celui-ci : l'absorption
                // reporterait ses preuves sur l'élément conservé (relation corrigée rétablie en silence).
                : scope.detachedLinks.some((l) => l.itemId === keep.id && i.fileIds.includes(l.fileId)) ? 'USER_DETACHED_LINK' as const
                  : null;
      if (refus) { refused.push({ mutation: { kind: 'CONSOLIDATE', keepId: keep.id, absorbIds: [i.id], reason: motif }, reason: refus }); continue; }
      absorbes.push(i.id);
    }
    if (absorbes.length) {
      // `keep` peut être une projection technique : elle absorbe (gardes 76H inchangées sur l'élément absorbé).
      if (autreOp(keep) || keep.userDetached) {
        refused.push({ mutation: { kind: 'CONSOLIDATE', keepId: keep.id, absorbIds: absorbes, reason: motif }, reason: 'KEEP_NOT_ABSORBABLE' });
      } else {
        mutations.push({ kind: 'CONSOLIDATE', keepId: keep.id, absorbIds: absorbes, reason: motif });
      }
    }
  }

  for (const r of decision.restorations) {
    const s = scope.restorables.find((x) => x.ref === r.restore);
    if (!s) continue;
    const motif = `T4 : ${r.reason}`.slice(0, 300);
    if (r.confidence !== 'certain') { refused.push({ mutation: { kind: 'RESTORE', ref: r.restore }, reason: 'NOT_CERTAIN' }); continue; }
    if (!s.restorable) { refused.push({ mutation: { kind: 'RESTORE', journalId: s.journalId, absorbedItemId: s.absorbedItemId, role: null, reason: motif }, reason: 'NOT_RESTORABLE' }); continue; }
    let role: 'PRINCIPAL' | 'RELATED' | null = r.role === 'INDEPENDENT' ? null : r.role === 'PRINCIPAL' ? 'PRINCIPAL' : 'RELATED';
    if (role === 'PRINCIPAL' && (userPrincipal !== null || scope.principalWithdrawn)) {
      refused.push({ mutation: { kind: 'RESTORE', journalId: s.journalId, absorbedItemId: s.absorbedItemId, role: 'PRINCIPAL', reason: motif }, reason: userPrincipal !== null ? 'USER_PRINCIPAL' : 'PRINCIPAL_WITHDRAWN' });
      role = 'RELATED';
    }
    mutations.push({ kind: 'RESTORE', journalId: s.journalId, absorbedItemId: s.absorbedItemId, role, reason: motif });
  }

  // Un seul principal visé à la fin : si T4 désigne un principal, l'ancien principal déduit non cité redevient lié
  // (le service de regroupement le fait lors de la désignation) ; rien d'autre n'est déduit ici.
  mutations.sort((a, b) => ordre[a.kind] - ordre[b.kind]);
  return { mutations, refused };
}

/** Résumé borné d'une mutation (journal, diagnostics). */
export function describeMutation(m: RepresentationMutation | { kind: string; ref?: string }): Record<string, unknown> {
  return { ...m };
}

/**
 * Rôles DÉCIDÉS par T4 pour chaque élément (décisions certaines seulement,
 * pure) : élément conservé d'une occurrence → rôle de l'occurrence ; autres
 * éléments de l'occurrence → DUPLICATE (absorbés, ou restés par protection) ;
 * occurrence restaurée → son rôle. Mémorisés au journal : la projection ne
 * redemande plus et ne propose plus ce que T4 a tranché (CODE-11).
 */
export function decidedRoles(decision: T4AgendaRepresentationOutput, scope: RepresentationScope): Record<number, DecidedRole> {
  const out: Record<number, DecidedRole> = {};
  if (decision.outcome === 'ABSTAIN') return out;
  const parRef = new Map(scope.items.map((i) => [i.ref, i]));
  const role = (r: 'PRINCIPAL' | 'STEP' | 'INDEPENDENT'): DecidedRole => r;
  for (const o of decision.occurrences) {
    if (o.confidence !== 'certain') continue;
    for (const ref of o.items) {
      const it = parRef.get(ref);
      if (!it) continue;
      out[it.id] = ref === o.keep ? role(o.role) : 'DUPLICATE';
    }
  }
  for (const r of decision.restorations) {
    if (r.confidence !== 'certain') continue;
    const s = scope.restorables.find((x) => x.ref === r.restore);
    if (s) out[s.absorbedItemId] = role(r.role);
  }
  return out;
}
