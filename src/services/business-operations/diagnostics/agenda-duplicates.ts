/**
 * Lot 76H — diagnostic BO de la CAUSE RÉELLE d'un doublon d'intervention dans
 * l'Agenda (ticket « [P1] Opérations → Agenda — Corriger les doublons
 * d'interventions », §3.1). Règles PURES ; lectures dans
 * `admin/account-data/dossier.ts` (transaction READ ONLY, bornée au compte).
 *
 * Pour UN document (et chaque date où il a produit plusieurs événements
 * d'entretien / réparation), distingue :
 *   ONE_OPERATION    une seule Opération d'intervention active prouvée par le
 *                    document → défaut de convergence Opération → Agenda
 *                    (corrigé : projection lot 76H) ; précise si T3 a
 *                    consolidé toute la preuve du document dans cette
 *                    Opération (sinon : candidat en attente / arbitrage) ;
 *   TWO_OPERATIONS   plusieurs Opérations actives → consolidation T3 en amont :
 *                    même référence identifiante entre leurs candidats
 *                    (défaut T3, corrigé lot 76H pour les documents
 *                    réanalysés) ou interventions distinctes (aucune fusion) ;
 *   NO_OPERATION     aucune Opération : pourquoi T3 n'a rien établi (candidats
 *                    non établis, en attente, HOLD, aucun candidat) ; aucun
 *                    dédoublonnage automatique, aucune Opération artificielle.
 */

export type DuplicateCause = 'ONE_OPERATION' | 'TWO_OPERATIONS' | 'NO_OPERATION' | 'NO_DUPLICATE';

export interface DiagCandidate {
  candidateKey: string;
  typeHint: string | null;
  established: boolean;
  t3Pending: boolean;
  t3Outcome: string | null;
  t3Reason: string | null;
  /** Opération canonique (fusions suivies), null si aucune. */
  canonicalOperationId: number | null;
  /** Références identifiantes normalisées `KIND:valeur`. */
  refs: string[];
}

export interface DiagOperation {
  id: number;
  typeCode: string | null;
  status: string;
  date: string | null;
  label: string | null;
  /** Le document est dans les documents « exclusifs » de l'Opération (T3 y a consolidé toute sa preuve). */
  exclusive: boolean;
}

export interface DiagItem {
  id: number;
  title: string;
  date: string | null;
  businessType: string | null;
  businessOperationId: number | null;
  projected: boolean;
  touched: boolean;
}

export interface DuplicateVerdict {
  cause: DuplicateCause;
  /** Libellé court (BO). */
  label: string;
  /** Explication détaillée, une ligne par constat. */
  findings: string[];
  /** Correctif du lot 76H qui traite le cas (ou « aucun : décision utilisateur »). */
  remedy: string;
}

const INTERVENTION_TYPES = new Set(['maintenance', 'repair']);

/** Verdict (pur) pour les événements d'UN document à UNE date. */
export function classifyDuplicateCause(p: { items: DiagItem[]; operations: DiagOperation[]; candidates: DiagCandidate[] }): DuplicateVerdict {
  const items = p.items.filter((i) => i.businessType !== null && INTERVENTION_TYPES.has(i.businessType));
  const ops = p.operations.filter((o) => o.typeCode === 'INTERVENTION' || o.typeCode === 'OTHER' || o.typeCode === null);
  const cands = p.candidates.filter((c) => c.typeHint === null || c.typeHint === 'INTERVENTION' || c.typeHint === 'OTHER');
  const findings: string[] = [];
  findings.push(`${items.length} événement(s) entretien / réparation : ${items.map((i) => `#${i.id} « ${i.title} » (${i.businessType}, ${i.businessOperationId ? `lié à l’Opération ${i.businessOperationId}` : 'non lié'}${i.projected ? ', projeté' : ''}${i.touched ? ', modifié par l’utilisateur' : ''})`).join(' ; ') || '—'}.`);
  findings.push(`${cands.length} candidat(s) T1 d’intervention : ${cands.map((c) => `${c.candidateKey} → ${c.established ? '' : 'non établi, '}${c.t3Pending ? 'en attente T3' : `${c.t3Outcome ?? '—'}${c.t3Reason ? ` (${c.t3Reason})` : ''}`}${c.canonicalOperationId ? ` → Opération ${c.canonicalOperationId}` : ''}`).join(' ; ') || 'aucun'}.`);
  findings.push(`${ops.length} Opération(s) d’intervention active(s) prouvée(s) par le document : ${ops.map((o) => `#${o.id} ${o.status} ${o.date ?? 'sans date'}${o.label ? ` « ${o.label} »` : ''}${o.exclusive ? ' (toute la preuve du document)' : ' (preuve du document partagée ou non résolue)'}`).join(' ; ') || 'aucune'}.`);
  if (items.length < 2 && !(items.length === 1 && ops.length === 1 && items[0].businessOperationId !== ops[0].id)) {
    return { cause: 'NO_DUPLICATE', label: 'Aucun doublon d’intervention à cette date', findings, remedy: 'aucun' };
  }
  if (ops.length === 1) {
    const o = ops[0];
    if (!o.exclusive) {
      findings.push('T3 n’a pas encore consolidé TOUTE la preuve d’intervention du document dans cette Opération (candidat en attente, en arbitrage ou rattaché ailleurs) : identité incertaine.');
    }
    return {
      cause: 'ONE_OPERATION',
      label: 'Une seule Opération : défaut de convergence Opération → Agenda',
      findings,
      remedy: o.exclusive
        ? 'Projection lot 76H : un événement principal conservé et relié, les autres absorbés (journal 0591, restaurable) — automatique (rattrapage ponctuel puis projection).'
        : 'Abstention conservée : carte « À traiter » (rapprochement agenda) jusqu’à la résolution T3 ou le choix de l’utilisateur.',
    };
  }
  if (ops.length >= 2) {
    const parOp = new Map<number, Set<string>>();
    for (const c of cands) if (c.canonicalOperationId !== null) {
      const s = parOp.get(c.canonicalOperationId) ?? new Set<string>();
      for (const r of c.refs) s.add(r);
      parOp.set(c.canonicalOperationId, s);
    }
    const ids = [...parOp.keys()];
    const communes = ids.flatMap((a, i) => ids.slice(i + 1).flatMap((b) => [...(parOp.get(a) ?? [])].filter((r) => parOp.get(b)?.has(r)).map((r) => `${a}/${b} : ${r}`)));
    if (communes.length) {
      findings.push(`Références identifiantes communes entre Opérations du même document : ${communes.join(' ; ')}.`);
      return {
        cause: 'TWO_OPERATIONS',
        label: 'Deux Opérations pour une même intervention : défaut de consolidation T3',
        findings,
        remedy: 'T3 lot 76H : deux candidats d’un même document portant la même référence identifiante sont une seule Opération dès le premier passage ; '
          + 'les Opérations déjà créées sont fusionnées par T3 à la reconsolidation du document (BO › Opérations › « Reconsolider ce compte »), puis la projection converge.',
      };
    }
    findings.push('Aucune référence identifiante commune : T1 / T3 décrivent des interventions DISTINCTES (F-027).');
    return {
      cause: 'TWO_OPERATIONS',
      label: 'Plusieurs Opérations : interventions distinctes selon T3',
      findings,
      remedy: 'Aucune fusion automatique : chaque événement reste ; un rapprochement incertain passe par la carte « À traiter » ; l’utilisateur peut fusionner les Opérations.',
    };
  }
  const raisons = cands.length === 0 ? ['aucun candidat T1 d’intervention pour ce document']
    : cands.map((c) => !c.established ? `${c.candidateKey} non établi par T1` : c.t3Pending ? `${c.candidateKey} en attente T3` : `${c.candidateKey} : ${c.t3Outcome ?? '—'}${c.t3Reason ? ` (${c.t3Reason})` : ''}`);
  findings.push(`T3 n’a établi aucune intervention : ${raisons.join(' ; ')}.`);
  return {
    cause: 'NO_OPERATION',
    label: 'Aucune Opération : T3 n’a pas établi d’intervention',
    findings,
    remedy: 'Aucune Opération artificielle, aucune fusion automatique (même document + même date ne suffit pas) : signalé au rapport du rattrapage ; '
      + 'l’utilisateur supprime l’événement en trop ou T3 établit l’intervention à la prochaine analyse.',
  };
}
