/**
 * Représentations ÉQUIVALENTES d'un même fait dans l'Agenda d'un bien —
 * lot 106A (ticket P1 « Agenda — doublons DPE non autoréparés »). Module PUR.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉTECTION TRANSVERSALE (§3.A) — toutes origines confondues (fiche
 * `asset_field`, document `qualified_document`, saisie, projection
 * d'Opération, migrations) :
 *   · candidats = éléments d'UN bien, de nature canonique HISTORICAL (un fait
 *     réalisé ; une échéance — la fin de validité 2030 — n'est JAMAIS comparée
 *     à une réalisation 2020), MÊME date, MÊME type métier canonique (colonne
 *     `business_type`, sinon effet Agenda du champ d'origine au registre) ;
 *     un élément GÉNÉRIQUE (« Contrôle réalisé », type absorbé —
 *     `GENERIC_EVENT_ABSORPTION`) rejoint le groupe du fait précis de même
 *     date (DPE) ;
 *   · l'intitulé n'est jamais une clé.
 *
 * DÉCISION (§3.B) :
 *   · CERTAIN (`SAME_STABLE_REFERENCE`) : une référence stable unique (n°
 *     ADEME) partagée, aucune contradictoire, chaque membre ANCRÉ (sa
 *     référence, un fait de date du type dans sa source, ou le champ de la
 *     fiche du bien) ; ou (`SAME_SOURCE_SAME_FIELD`) même document et même
 *     champ d'origine (même fait dupliqué) ;
 *   · générique absorbé seulement si SA source porte le fait précis à cette
 *     date, que son propre fait est une date de DOSSIER et qu'aucun AUTRE
 *     diagnostic n'est désigné à cette date dans cette source ; sinon
 *     INCERTAIN ;
 *   · DISTINCT : références stables différentes (deux DPE le même jour),
 *     équipements différents ;
 *   · INCERTAIN sinon : aucune fusion — réévaluation T4 ciblée (file durable).
 *
 * CANONIQUE (règle stable, §3.C) : élément protégé par l'utilisateur
 * (saisi, modifié, statut posé à la main, confirmé, restauré) ; à défaut
 * élément au statut établi automatiquement ; puis fait PRÉCIS (non générique) ;
 * puis réalisation prouvée ; puis champ d'origine du registre ; puis le plus
 * ancien. Un élément protégé n'est JAMAIS absorbé ; un élément porteur d'un
 * statut, d'un conflit de données en attente ou d'une Opération active non
 * plus (conservé, signalé).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import {
  absorbs, DOSSIER_DATE_FIELDS, GENERIC_EVENT_ABSORPTION, isGenericTitle, normalizeEq, normalizeReference, OCCURRENCE_DATE_FIELDS,
  STABLE_REFERENCE_FIELDS, subjectDesignatesType, subjectIsUninformative, titleHead,
} from './rules';

/** Version des règles (preuve de contrôle, empreinte des décisions). */
const EQUIVALENCE_RULES_VERSION = 1;

export interface EqItem {
  id: number;
  title: string;
  date: string | null;
  /** Nature canonique résolue (colonne, registre, catalogue). */
  nature: 'HISTORICAL' | 'DEADLINE' | null;
  businessType: string | null;
  originType: string | null;
  originFieldKey: string | null;
  functionalKey: string | null;
  /** Document d'origine (`origin_ref` asset_file). */
  originFileId: number | null;
  /** Documents de l'élément : origine, traces `agenda_item_sources`, liens `agenda_file_links`. */
  fileIds: number[];
  equipmentIds: number[];
  isAutomatic: boolean;
  isAutomaticModified: boolean;
  manualStatus: string | null;
  confirmationMode: string | null;
  requiresQualification: boolean;
  occurrenceNature: string | null;
  projected: boolean;
  operationId: number | null;
  operationActive: boolean;
  completionProofFileId: number | null;
  /** Geste de l'utilisateur tracé (STATUS_CHANGED, USER_MODIFIED, USER_CONFIRMED). */
  userTouchEvent: boolean;
  /** Statut « réalisé » posé AUTOMATIQUEMENT (STATUS_AUTO_COMPLETED tracé). */
  autoStatusEvent: boolean;
  pendingConflict: boolean;
  /** Élément restauré après une consolidation : choix de l'utilisateur / de l'exploitation. */
  restored: boolean;
}

export interface EqFact {
  canonicalKey: string | null;
  value: string | null;
  subject: string | null;
  semanticType: string | null;
  semanticNature: string | null;
}

export interface EqDocument {
  fileId: number;
  title: string | null;
  documentTypeCode: string | null;
  documentDate: string | null;
  facts: EqFact[];
}

export interface EqAsset {
  assetId: number;
  name: string;
  /** Champs canoniques de la fiche (`key_characteristics`). */
  fields: Record<string, unknown>;
}

export type Protection = 'USER' | 'STATUS' | 'CONFLICT' | 'OPERATION' | null;

/** Protection d'un élément (voir l'en-tête). Pure. */
export function protectionOf(i: EqItem): Protection {
  const manuel = !!i.manualStatus && i.manualStatus.trim() !== '';
  if (!i.isAutomatic || i.isAutomaticModified || i.confirmationMode === 'USER' || i.userTouchEvent || i.restored) return 'USER';
  if (manuel && !i.autoStatusEvent) return 'USER';
  if (manuel) return 'STATUS';
  if (i.pendingConflict) return 'CONFLICT';
  if (i.projected || (i.operationId !== null && i.operationActive)) return 'OPERATION';
  return null;
}

/** Élément générique : type absorbable, sans champ d'origine, intitulé générique (indice). */
const isGenericItem = (i: Pick<EqItem, 'businessType' | 'originFieldKey' | 'title'>): boolean =>
  !!i.businessType && !!GENERIC_EVENT_ABSORPTION[i.businessType] && !i.originFieldKey && isGenericTitle(i.title);

const iso = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** Références stables d'un élément (ses documents ; à défaut, la fiche du bien pour un élément de fiche). */
function referencesOf(i: EqItem, businessType: string, docs: ReadonlyMap<number, EqDocument>, asset: EqAsset): string[] {
  const cles = STABLE_REFERENCE_FIELDS[businessType] ?? [];
  if (!cles.length) return [];
  const out = new Set<string>();
  for (const f of i.fileIds) {
    for (const fact of docs.get(f)?.facts ?? []) {
      if (fact.canonicalKey && cles.includes(fact.canonicalKey)) { const r = normalizeReference(fact.value); if (r) out.add(r); }
    }
  }
  if (!i.fileIds.length && i.originType === 'asset_field') {
    for (const k of cles) { const r = normalizeReference(typeof asset.fields[k] === 'string' ? (asset.fields[k] as string) : null); if (r) out.add(r); }
  }
  return [...out].sort();
}

/** L'élément est-il ANCRÉ (fait de date du type dans une de ses sources, ou champ de la fiche) à la date du groupe ? */
function anchoredBy(i: EqItem, businessType: string, date: string, docs: ReadonlyMap<number, EqDocument>, asset: EqAsset): boolean {
  const champs = OCCURRENCE_DATE_FIELDS[businessType] ?? [];
  for (const f of i.fileIds) {
    for (const fact of docs.get(f)?.facts ?? []) {
      if (iso(fact.value) !== date) continue;
      if (fact.canonicalKey && champs.includes(fact.canonicalKey)) return true;
      if (fact.semanticType === businessType && fact.semanticNature === 'HISTORICAL') return true;
    }
  }
  if (!i.fileIds.length && i.originFieldKey && champs.includes(i.originFieldKey)) return champs.some((k) => iso(asset.fields[k]) === date);
  return false;
}

export interface EqGroup {
  key: string;
  date: string;
  businessType: string;
  /** Éléments du type précis (ou du type unique du groupe). */
  memberIds: number[];
  /** Éléments génériques rattachés au groupe (« Contrôle réalisé »). */
  genericIds: number[];
}

/** Groupes candidats d'un bien (pure) : ≥ 2 représentations possibles d'un même fait réalisé. */
export function buildGroups(items: readonly EqItem[]): EqGroup[] {
  const hist = items.filter((i) => i.nature === 'HISTORICAL' && !!i.date && !!i.businessType && i.manualStatus !== 'annule');
  const parCle = new Map<string, EqItem[]>();
  for (const i of hist) {
    const k = `${i.date}|${i.businessType}`;
    parCle.set(k, [...(parCle.get(k) ?? []), i]);
  }
  const groupes: EqGroup[] = [];
  const rattaches = new Set<number>();
  // 1. Faits précis (avec les génériques qu'ils peuvent représenter).
  for (const [k, l] of parCle) {
    const [date, bt] = k.split('|');
    const precis = l.filter((i) => !isGenericItem(i));
    if (!precis.length) continue;
    const generiques = hist.filter((x) => x.date === date && isGenericItem(x) && absorbs(bt, x.businessType));
    if (precis.length + generiques.length < 2) continue;
    generiques.forEach((x) => rattaches.add(x.id));
    groupes.push({
      key: `${date}|HISTORICAL|${bt}`, date, businessType: bt,
      memberIds: precis.map((i) => i.id).sort((a, b) => a - b), genericIds: generiques.map((x) => x.id).sort((a, b) => a - b),
    });
  }
  // 2. Génériques entre eux (même date, même type, aucun fait précis qui les représente).
  for (const [k, l] of parCle) {
    const [date, bt] = k.split('|');
    const seuls = l.filter((i) => isGenericItem(i) && !rattaches.has(i.id));
    if (seuls.length < 2 || l.some((i) => !isGenericItem(i))) continue;
    groupes.push({ key: `${date}|HISTORICAL|${bt}`, date, businessType: bt, memberIds: seuls.map((i) => i.id).sort((a, b) => a - b), genericIds: [] });
  }
  return groupes.sort((a, b) => a.key.localeCompare(b.key));
}

export type GroupVerdict = 'CONSOLIDATE' | 'UNCERTAIN' | 'DISTINCT' | 'PROTECTED' | 'NOTHING';

export interface GroupDecision {
  group: EqGroup;
  verdict: GroupVerdict;
  reason: string;
  canonicalId: number | null;
  absorbIds: number[];
  /** Éléments conservés : protégés (motif) ou incertains (motif). */
  kept: Array<{ id: number; why: string }>;
  /** Éléments à réévaluer par T4 (incertains). */
  uncertainIds: number[];
  /** Opérations actives concernées (réévaluation T4 de leur représentation). */
  operationIds: number[];
  /** Nouvel intitulé du canonique (automatique intact, sujet non informatif). */
  retitle: { from: string; to: string } | null;
  /** Preuve de réalisation reportée sur le canonique (même occurrence, preuve d'un absorbé). */
  proofFileId: number | null;
  evidence: { references: string[]; perItem: Record<number, { refs: string[]; anchored: boolean; files: number[]; protection: Protection; generic: boolean }> };
  fingerprint: string;
}

const HISTORICAL_TITLE: Readonly<Record<string, string>> = {
  dpe: 'DPE réalisé', inspection: 'Contrôle réalisé', maintenance: 'Entretien réalisé', repair: 'Réparation', purchase: 'Achat', sale: 'Vente', claim: 'Sinistre',
};

/** Rang du choix du canonique (plus petit = préféré). Pure. */
function rang(i: EqItem): number[] {
  const p = protectionOf(i);
  return [p === 'USER' ? 0 : 1, p === 'STATUS' ? 0 : 1, isGenericItem(i) ? 1 : 0, i.completionProofFileId ? 0 : 1, i.originFieldKey ? 0 : 1, i.id];
}
const compare = (a: number[], b: number[]) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] - b[k]; return 0; };

/** Décision d'un groupe (pure) — voir l'en-tête. */
export function decideGroup(g: EqGroup, items: ReadonlyMap<number, EqItem>, docs: ReadonlyMap<number, EqDocument>, asset: EqAsset): GroupDecision {
  const membres = g.memberIds.map((id) => items.get(id)!).filter(Boolean);
  const generiques = g.genericIds.map((id) => items.get(id)!).filter(Boolean);
  const perItem: GroupDecision['evidence']['perItem'] = {};
  for (const i of [...membres, ...generiques]) {
    perItem[i.id] = {
      refs: referencesOf(i, g.businessType, docs, asset), anchored: anchoredBy(i, g.businessType, g.date, docs, asset),
      files: [...i.fileIds].sort((a, b) => a - b), protection: protectionOf(i), generic: isGenericItem(i),
    };
  }
  const refs = [...new Set(membres.flatMap((i) => perItem[i.id].refs))].sort();
  const base = (verdict: GroupVerdict, reason: string, extra: Partial<GroupDecision> = {}): GroupDecision => {
    const d: GroupDecision = {
      group: g, verdict, reason, canonicalId: null, absorbIds: [], kept: [], uncertainIds: [], operationIds: [], retitle: null, proofFileId: null,
      evidence: { references: refs, perItem }, fingerprint: '', ...extra,
    };
    d.fingerprint = fingerprintOf(g, items, perItem);
    return d;
  };

  // Faits distincts : équipements différents, références stables différentes.
  const equipements = new Set(membres.flatMap((i) => i.equipmentIds.map(String)).filter(Boolean));
  const membresAvecEquip = membres.filter((i) => i.equipmentIds.length);
  if (membresAvecEquip.length >= 2 && equipements.size > 1 && membresAvecEquip.some((a) => membresAvecEquip.some((b) => !a.equipmentIds.some((e) => b.equipmentIds.includes(e))))) {
    return base('DISTINCT', 'DIFFERENT_EQUIPMENTS', { kept: membres.map((i) => ({ id: i.id, why: 'DISTINCT_FACT' })) });
  }
  if (refs.length > 1) return base('DISTINCT', 'STABLE_REFERENCES_DIFFER', { kept: membres.map((i) => ({ id: i.id, why: 'DISTINCT_FACT' })) });

  // Identité des membres précis.
  let certainsPrecis: EqItem[] = [];
  let incertains: EqItem[] = [];
  let motif = 'NO_STABLE_REFERENCE';
  const stableConnue = (STABLE_REFERENCE_FIELDS[g.businessType] ?? []).length > 0;
  if (stableConnue && refs.length === 1) {
    certainsPrecis = membres.filter((i) => perItem[i.id].refs.length === 1 || perItem[i.id].anchored);
    incertains = membres.filter((i) => !certainsPrecis.includes(i));
    motif = 'SAME_STABLE_REFERENCE';
  } else {
    const sources = new Set(membres.map((i) => i.originFileId ?? -1));
    const champs = new Set(membres.map((i) => i.originFieldKey ?? ''));
    if (membres.length >= 2 && sources.size === 1 && !sources.has(-1) && champs.size === 1 && !champs.has('')) {
      certainsPrecis = membres;
      motif = 'SAME_SOURCE_SAME_FIELD';
    } else {
      incertains = membres;
    }
  }

  // Génériques : absorbés seulement sur preuve du dossier (voir l'en-tête).
  const genCertains: EqItem[] = [];
  for (const gi of generiques) {
    if (certainsPrecis.length && genericProvenSame(gi, g, docs)) genCertains.push(gi);
    else incertains.push(gi);
  }

  const certains = [...certainsPrecis, ...genCertains];
  const operationIds = [...new Set([...certains, ...incertains].filter((i) => i.operationId !== null && i.operationActive).map((i) => i.operationId!))].sort((a, b) => a - b);

  // Représentation d'un événement de référence (Opération active, projection) : jamais fusionnée par une règle du code
  // (87B, V-Q4) — la décision est demandée à T4 (orchestration existante, éléments du groupe en candidats).
  if (certains.length >= 2 && certains.some((i) => i.projected || (i.operationId !== null && i.operationActive))) {
    const tous = [...certains, ...incertains];
    return base('UNCERTAIN', 'OPERATION_REPRESENTATION_T4', {
      uncertainIds: tous.map((i) => i.id).sort((a, b) => a - b), operationIds,
      kept: tous.map((i) => ({ id: i.id, why: 'OPERATION_REPRESENTATION' })),
    });
  }
  if (certains.length < 2) {
    if (incertains.length + certains.length >= 2) {
      return base('UNCERTAIN', motif === 'SAME_STABLE_REFERENCE' ? 'MEMBER_NOT_ANCHORED' : motif, {
        uncertainIds: [...certains, ...incertains].map((i) => i.id).sort((a, b) => a - b), operationIds,
        kept: [...certains, ...incertains].map((i) => ({ id: i.id, why: 'IDENTITY_UNCERTAIN' })),
      });
    }
    return base('NOTHING', 'SINGLE_REPRESENTATION');
  }
  const tri = [...certains].sort((a, b) => compare(rang(a), rang(b)));
  const canonique = tri[0];
  const kept: GroupDecision['kept'] = [];
  const absorb: number[] = [];
  for (const i of tri.slice(1)) {
    const p = protectionOf(i);
    if (p) kept.push({ id: i.id, why: `PROTECTED_${p}` });
    else absorb.push(i.id);
  }
  for (const i of incertains) kept.push({ id: i.id, why: 'IDENTITY_UNCERTAIN' });
  const pCanon = protectionOf(canonique);
  // Intitulé : « DPE réalisé — DPE » / « — Compromis de vente » → « DPE réalisé — <bien> » (automatique intact seulement).
  let retitle: GroupDecision['retitle'] = null;
  const tete = HISTORICAL_TITLE[g.businessType];
  if (absorb.length && pCanon === null && tete && titleHead(canonique.title) === normalizeEq(tete)) {
    const titres = canonique.fileIds.map((f) => docs.get(f)?.title ?? '').filter(Boolean);
    if (subjectIsUninformative(canonique.title, { documentTitles: titres, assetName: asset.name })) {
      const to = `${tete} — ${asset.name}`;
      if (to !== canonique.title) retitle = { from: canonique.title, to };
    }
  }
  // Preuve de réalisation : celle d'un absorbé (même occurrence) si le canonique n'en a pas et n'a pas de statut.
  const proof = !canonique.completionProofFileId && (pCanon === null)
    ? (tri.slice(1).find((i) => absorb.includes(i.id) && i.completionProofFileId)?.completionProofFileId ?? null) : null;
  if (!absorb.length) {
    return base(kept.some((k) => k.why.startsWith('PROTECTED')) ? 'PROTECTED' : incertains.length ? 'UNCERTAIN' : 'NOTHING',
      kept.some((k) => k.why.startsWith('PROTECTED')) ? 'EQUIVALENT_ITEMS_PROTECTED' : motif, {
        canonicalId: canonique.id, kept, uncertainIds: incertains.map((i) => i.id), operationIds,
      });
  }
  return base('CONSOLIDATE', motif, {
    canonicalId: canonique.id, absorbIds: absorb.sort((a, b) => a - b), kept, uncertainIds: incertains.map((i) => i.id), operationIds, retitle, proofFileId: proof,
  });
}

/**
 * Générique PROUVÉ identique au fait précis : une de ses sources porte le
 * fait précis à la date du groupe, un fait de date de DOSSIER à cette date, et
 * aucun AUTRE fait réalisé à cette date (autre type, ou date de dossier dont
 * le sujet désigne un autre diagnostic). Pure.
 */
function genericProvenSame(gi: EqItem, g: EqGroup, docs: ReadonlyMap<number, EqDocument>): boolean {
  const champsPrecis = OCCURRENCE_DATE_FIELDS[g.businessType] ?? [];
  for (const f of gi.fileIds) {
    const d = docs.get(f);
    if (!d) continue;
    const aDate = d.facts.filter((x) => iso(x.value) === g.date);
    const precis = aDate.some((x) => (x.canonicalKey && champsPrecis.includes(x.canonicalKey)) || (x.semanticType === g.businessType && x.semanticNature === 'HISTORICAL'));
    const dossier = aDate.filter((x) => x.canonicalKey && DOSSIER_DATE_FIELDS.includes(x.canonicalKey));
    if (!precis || !dossier.length) continue;
    const autre = aDate.some((x) => {
      if (x.canonicalKey && champsPrecis.includes(x.canonicalKey)) return false;
      if (x.canonicalKey && DOSSIER_DATE_FIELDS.includes(x.canonicalKey)) {
        return !!x.subject && !subjectDesignatesType(x.subject, g.businessType) && normalizeEq(x.subject) !== normalizeEq(d.title);
      }
      return x.semanticNature === 'HISTORICAL' && !!x.semanticType && x.semanticType !== g.businessType;
    });
    if (!autre) return true;
  }
  return false;
}

/** Empreinte des ENTRÉES d'un groupe (membres, états, preuves) : mémoire des décisions et anti-boucle. */
function fingerprintOf(g: EqGroup, items: ReadonlyMap<number, EqItem>, perItem: GroupDecision['evidence']['perItem']): string {
  const etat = [...g.memberIds, ...g.genericIds].sort((a, b) => a - b).map((id) => {
    const i = items.get(id);
    return i ? [id, i.title, i.manualStatus ?? '', i.isAutomaticModified, i.confirmationMode ?? '', perItem[id]?.refs ?? [], perItem[id]?.files ?? []] : [id];
  });
  return createHash('sha256').update(JSON.stringify([EQUIVALENCE_RULES_VERSION, g.key, etat])).digest('hex').slice(0, 32);
}

/** Décisions de tous les groupes d'un bien (pure). */
export function decideAsset(items: readonly EqItem[], docs: ReadonlyMap<number, EqDocument>, asset: EqAsset): GroupDecision[] {
  const parId = new Map(items.map((i) => [i.id, i]));
  return buildGroups(items).map((g) => decideGroup(g, parId, docs, asset));
}

/**
 * PREUVES RÉUNIES (§3.C, §4 « deux documents, même DPE → un élément, deux
 * preuves ») : un document du bien qui décrit la MÊME occurrence — même
 * référence stable (n° ADEME) ET fait de date du type à la même date — sans
 * être lié à l'unique représentation de cette occurrence lui est rattaché
 * comme preuve (quel que soit l'ordre d'arrivée des documents). Ambiguïté
 * (plusieurs représentations possibles) : rien. Pure.
 */
export function corroborationsOf(
  items: readonly EqItem[], docs: ReadonlyMap<number, EqDocument>, asset: EqAsset, assetDocIds: readonly number[], decisions: readonly GroupDecision[],
): Array<{ itemId: number; fileId: number; reference: string }> {
  const absorbes = new Set(decisions.flatMap((d) => d.absorbIds));
  // Seule l'UNIQUE représentation d'une occurrence reçoit une preuve : un élément d'un groupe non résolu
  // (incertain, protégé, distinct, délégué à T4) n'en reçoit aucune.
  const enSuspens = new Set(decisions.filter((d) => d.verdict !== 'CONSOLIDATE' && d.verdict !== 'NOTHING')
    .flatMap((d) => [...d.group.memberIds, ...d.group.genericIds]));
  for (const d of decisions) if (d.verdict === 'CONSOLIDATE') for (const k of d.kept) enSuspens.add(k.id);
  const out: Array<{ itemId: number; fileId: number; reference: string }> = [];
  for (const fileId of assetDocIds) {
    const d = docs.get(fileId);
    if (!d) continue;
    const trouves: Array<{ itemId: number; reference: string }> = [];
    for (const i of items) {
      if (absorbes.has(i.id) || enSuspens.has(i.id) || i.nature !== 'HISTORICAL' || !i.date || !i.businessType || i.fileIds.includes(fileId)) continue;
      const cles = STABLE_REFERENCE_FIELDS[i.businessType] ?? [];
      if (!cles.length) continue;
      const refs = referencesOf(i, i.businessType, docs, asset);
      if (refs.length !== 1) continue;
      const champs = OCCURRENCE_DATE_FIELDS[i.businessType] ?? [];
      const memeRef = d.facts.some((f) => f.canonicalKey && cles.includes(f.canonicalKey) && normalizeReference(f.value) === refs[0]);
      const memeDate = d.facts.some((f) => iso(f.value) === i.date && ((f.canonicalKey && champs.includes(f.canonicalKey)) || (f.semanticType === i.businessType && f.semanticNature === 'HISTORICAL')));
      if (memeRef && memeDate) trouves.push({ itemId: i.id, reference: refs[0] });
    }
    if (trouves.length === 1) out.push({ fileId, ...trouves[0] });
  }
  return out.sort((a, b) => a.itemId - b.itemId || a.fileId - b.fileId);
}
