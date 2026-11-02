/**
 * T3 DOCUMENT_ASSET — GROUPES D'IDENTITÉ DOCUMENTAIRE et confrontation aux
 * biens du compte (lot 105D, ticket « Rattachement rétroactif après création
 * d'un bien », §D1, §D2, §D3). Module PUR : aucune base, aucun appel modèle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 1. ARÊTES (document ↔ document), provenance conservée :
 *      SAME_IDENTITY  même identité de BIEN (adresse au rôle « bien »,
 *                     cadastre, immatriculation, VIN), lue par CHAQUE document ;
 *      SAME_CONTRACT  même n° de contrat / police / DPE qu'un document qui
 *                     porte LUI-MÊME l'identité — UN SEUL saut, jamais en
 *                     chaîne (pas de transitivité abusive : deux documents liés
 *                     par un contrat et un troisième par le même fournisseur ne
 *                     désignent pas le même bien) ;
 *    jamais : fournisseur, ville, catégorie, marque, nom générique, adresse de
 *    facturation / livraison / intervention, modèle d'équipement.
 * 2. GROUPES : composantes reliées par SAME_IDENTITY (une adresse et une
 *    référence cadastrale ne se rejoignent que par un document mono-bien qui
 *    porte les deux), puis membres SAME_CONTRACT. Documents multibiens,
 *    contradictoires, d'équipement ou à adresse non « bien » : EXCLUS, avec
 *    leur motif (visibles sur la carte et en supervision).
 * 3. CONFRONTATION aux biens ACTUELS (indépendante de l'ordre de création) :
 *      DEMONSTRABLE  un seul bien porte l'identifiant (adresse, cadastre,
 *                    immatriculation, VIN) ;
 *      ATTESTED      des documents DÉJÀ rattachés au même bien (et à lui seul)
 *                    portent l'identité ;
 *      CONFIRMED     l'utilisateur a confirmé « ce logement est mon bien X » ;
 *      TO_CONFIRM    biens compatibles SANS identifiant (« Maison » sans
 *                    adresse) : jamais d'attribution implicite — question
 *                    groupée ;
 *      REFUSED       l'utilisateur a refusé tous les biens compatibles (refus
 *                    stable tant que l'identité du bien ne change pas) ;
 *      AMBIGUOUS     plusieurs biens désignés, documents rattachés en
 *                    désaccord, identité confirmée contredite ;
 *      NO_CANDIDATE  aucun bien compatible.
 *    JAMAIS : « seul bien du compte », nom « Maison », même catégorie, même
 *    fournisseur. Un bien d'une autre famille n'est jamais candidat.
 * 4. PORTÉE PAR DOCUMENT : le groupe ne remplace pas la preuve de chaque
 *    document — seul un membre (identité propre ou contrat à un saut) peut
 *    être rattaché ; les exclus restent à leur traitement individuel.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { normalizePlate, normalizeVin } from '@/lib/vehicle-identifiers';
import { normalizeCode, normalizeText } from '../identifiers';
import type { IndexedAsset } from '../matching-index';
import { addressKey, assetIdentitySignals, IDENTITY_SIGNALS_VERSION, isEquipmentDocument, type DocumentIdentityProfile, type IdentitySignal } from './signals';

/** Version des règles de groupe et de confrontation (empreintes, mémoire des décisions). */
export const IDENTITY_GRAPH_VERSION = 1;
/** Une carte groupée n'est proposée qu'à partir de ce nombre de documents sans bien (sinon : carte individuelle). */
export const GROUP_CARD_MIN_DOCUMENTS = 2;

export type GroupFamily = 'PROPERTY' | 'VEHICLE';
export type GroupStatus = 'DEMONSTRABLE' | 'ATTESTED' | 'CONFIRMED' | 'TO_CONFIRM' | 'REFUSED' | 'AMBIGUOUS' | 'NO_CANDIDATE';
export type ExclusionReason =
  | 'ADDRESS_ROLE_BILLING' | 'ADDRESS_ROLE_DELIVERY' | 'ADDRESS_ROLE_SUPPLIER' | 'ADDRESS_ROLE_INTERVENTION' | 'ADDRESS_ROLE_UNKNOWN'
  | 'MULTI_ASSET_DOCUMENT' | 'CONTRADICTORY_DOCUMENT' | 'EQUIPMENT_DOCUMENT' | 'CONTRACT_SPANS_SEVERAL_IDENTITIES' | 'UNCERTAIN_READING';

export interface GraphDocument {
  profile: DocumentIdentityProfile;
  /** Sans bien principal (candidat au rattachement). */
  orphan: boolean;
  /** Biens principaux actuels (documents déjà rattachés : ancres). */
  primaryAssetIds: number[];
}

export interface GraphDecision {
  id: number;
  groupKey: string;
  assetId: number;
  decision: 'CONFIRMED' | 'REFUSED';
  /** Empreinte de l'identité du bien au moment de la décision. */
  contextFingerprint: string;
}

export interface GroupMember {
  fileId: number;
  via: 'OWN_IDENTITY' | 'CONTRACT';
  /** Signaux (références `<fileId>:<n>`) qui fondent l'appartenance. */
  evidenceRefs: string[];
  /** Saut contractuel : document porteur de l'identité. */
  hopFromFileId: number | null;
}

export interface GroupEdge {
  fromFileId: number;
  toFileId: number;
  via: 'SAME_IDENTITY' | 'SAME_CONTRACT';
  /** Nature de la valeur partagée (ADDRESS, CADASTRAL, CONTRACT_REF…). */
  kind: string;
  evidenceRefs: [string, string];
}

export interface IdentityGroup {
  groupKey: string;
  family: GroupFamily;
  /** Natures d'identité présentes (ADDRESS, CADASTRAL, REGISTRATION, VIN). */
  kinds: string[];
  /** Libellé lisible (carte, supervision) — jamais transmis au modèle. */
  label: string;
  members: GroupMember[];
  anchors: Array<{ fileId: number; assetIds: number[] }>;
  excluded: Array<{ fileId: number; reason: ExclusionReason }>;
  edges: GroupEdge[];
  /** Signaux d'identité des membres et ancres (provenance). */
  evidence: IdentitySignal[];
  contradictions: Array<{ code: string; fileIds: number[]; assetIds?: number[] }>;
  status: GroupStatus;
  targetAssetId: number | null;
  candidateAssetIds: number[];
  refusedAssetIds: number[];
  /** Décisions utilisateur actives prises en compte. */
  decisionIds: number[];
  /** Carte groupée utile (TO_CONFIRM, au moins `GROUP_CARD_MIN_DOCUMENTS` documents sans bien). */
  cardEligible: boolean;
  fingerprint: string;
}

export interface Membership {
  groupKey: string;
  member: GroupMember;
}

export interface AccountIdentityGraph {
  accountId: number;
  version: number;
  groups: IdentityGroup[];
  byKey: Map<string, IdentityGroup>;
  /** Document → groupes dont il est membre. */
  membership: Map<number, Membership[]>;
  /** Document → groupes dont il est exclu (motif). */
  exclusions: Map<number, Array<{ groupKey: string; reason: ExclusionReason }>>;
  /** Documents examinés (orphelins / ancres). */
  examined: { orphans: number; anchors: number };
  /** Titre, type et fournisseur des documents examinés (contexte du prompt, cartes). */
  documents: Map<number, { title: string | null; documentType: string | null; supplier: string | null }>;
  /**
   * Document → biens dont l'adresse n'y figure QU'AVEC un rôle autre que celui
   * du bien (facturation, livraison, fournisseur, installation d'un appareil) :
   * jamais une preuve de rattachement à ces biens (§D1).
   */
  contextOnlyAssets: Map<number, number[]>;
}

const sha = (v: unknown, n = 32) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, n);

/** Clé stable d'une identité de bien (aucune valeur en clair). */
export function identityKeyOf(s: Pick<IdentitySignal, 'family' | 'kind' | 'key'>): string {
  return `${s.family}:${s.kind}:${sha(`${s.family}|${s.kind}|${s.key}`, 24)}`;
}

/** Empreinte de l'identité d'un bien (nom, famille, identifiants) : contexte d'un refus. Pure. */
export function assetIdentityFingerprint(a: Pick<IndexedAsset, 'normalizedName' | 'family' | 'record'>): string {
  const v = a.record.values;
  return sha([a.normalizedName, a.family, ['address1', 'postalCode', 'cadastralRef', 'registrationNumber', 'vin'].map((k) => v[k] ?? null)]);
}

/** Identités de bien PORTÉES par la fiche d'un bien (clés comparables à `identityKeyOf`). Pure. */
export function assetIdentityKeys(a: Pick<IndexedAsset, 'family' | 'record'>): string[] {
  const v = a.record.values;
  const out: string[] = [];
  if (a.family === 'IMMOBILIER') {
    const cp = /\b(\d{5})\b/.exec(String(v.address1 ?? ''))?.[1] ?? String(v.postalCode ?? '').replace(/\D/g, '');
    if (v.address1 && /^\d{5}$/.test(cp)) {
      out.push(identityKeyOf({ family: 'PROPERTY', kind: 'ADDRESS', key: addressKey(normalizeText(String(v.address1).replace(/\b\d{5}\b.*$/, '')), cp) }));
    }
    const c = normalizeCode(v.cadastralRef);
    if (c.length >= 5) out.push(identityKeyOf({ family: 'PROPERTY', kind: 'CADASTRAL', key: c }));
  } else if (a.family === 'VEHICULE') {
    const p = normalizePlate(v.registrationNumber);
    if (p.length >= 5) out.push(identityKeyOf({ family: 'VEHICLE', kind: 'REGISTRATION', key: p }));
    const n = normalizeVin(v.vin);
    if (n.length === 17) out.push(identityKeyOf({ family: 'VEHICLE', kind: 'VIN', key: n }));
  }
  return out;
}

/** Le bien porte-t-il déjà une identité de cette famille (adresse / cadastre, immatriculation / VIN) ? */
function assetHasIdentity(a: Pick<IndexedAsset, 'family' | 'record'>, family: GroupFamily): boolean {
  const v = a.record.values;
  return family === 'PROPERTY' ? !!(v.address1?.trim() || v.cadastralRef?.trim()) : !!(v.registrationNumber?.trim() || v.vin?.trim());
}

const compatible = (a: Pick<IndexedAsset, 'family'>, family: GroupFamily) => (family === 'PROPERTY' ? a.family === 'IMMOBILIER' : a.family === 'VEHICULE');

const ROLE_EXCLUSION: Readonly<Record<string, ExclusionReason>> = {
  BILLING: 'ADDRESS_ROLE_BILLING', DELIVERY: 'ADDRESS_ROLE_DELIVERY', SUPPLIER: 'ADDRESS_ROLE_SUPPLIER',
  INTERVENTION: 'ADDRESS_ROLE_INTERVENTION', UNKNOWN: 'ADDRESS_ROLE_UNKNOWN',
};

/** Le document peut-il être membre automatique d'un groupe (mono-bien, sans contradiction) ? */
function monoBien(p: DocumentIdentityProfile): boolean {
  return !p.multiAssetDeclared && p.contradictions.length === 0;
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a); const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

/**
 * Construit les groupes d'identité du compte et les confronte aux biens
 * actuels et aux décisions de l'utilisateur. Pure, déterministe (ordre des
 * entrées indifférent).
 */
export function buildIdentityGraph(p: {
  accountId: number;
  documents: readonly GraphDocument[];
  assets: readonly IndexedAsset[];
  decisions?: readonly GraphDecision[];
}): AccountIdentityGraph {
  const docs = [...p.documents].sort((a, b) => a.profile.fileId - b.profile.fileId);
  const byFile = new Map(docs.map((d) => [d.profile.fileId, d]));
  const assets = new Map(p.assets.map((a) => [a.assetId, a]));
  const uf = new UnionFind();

  // ── 1. Identités de bien par document ; union des clés d'un document MONO-BIEN.
  const idsOf = new Map<number, IdentitySignal[]>();
  for (const d of docs) {
    const s = assetIdentitySignals(d.profile);
    idsOf.set(d.profile.fileId, s);
    const cles = [...new Set(s.map(identityKeyOf))];
    for (const k of cles) uf.find(k);
    if (monoBien(d.profile)) for (let i = 1; i < cles.length; i += 1) uf.union(cles[0], cles[i]);
  }

  // ── 2. Composantes : documents qui portent une identité de la composante.
  interface Draft { root: string; family: GroupFamily; keys: Set<string>; own: Map<number, IdentitySignal[]> }
  const drafts = new Map<string, Draft>();
  for (const d of docs) {
    for (const s of idsOf.get(d.profile.fileId)!) {
      const k = identityKeyOf(s);
      const root = uf.find(k);
      const dr = drafts.get(root) ?? { root, family: s.family as GroupFamily, keys: new Set<string>(), own: new Map() };
      dr.keys.add(k);
      const l = dr.own.get(d.profile.fileId) ?? [];
      l.push(s);
      dr.own.set(d.profile.fileId, l);
      drafts.set(root, dr);
    }
  }

  // Document → composantes dont il porte l'identité (mono-bien seulement pour l'appartenance).
  const composantesDe = new Map<number, Set<string>>();
  for (const dr of drafts.values()) for (const f of dr.own.keys()) (composantesDe.get(f) ?? composantesDe.set(f, new Set()).get(f)!).add(dr.root);

  // ── 3. Saut contractuel unique : référence → composantes des porteurs d'identité.
  const refs = new Map<string, Array<{ fileId: number; ref: string }>>();
  for (const d of docs) {
    for (const s of d.profile.signals.filter((x) => x.family === 'CONTRACT' && x.reliability !== 'LOW')) {
      const l = refs.get(s.key) ?? [];
      l.push({ fileId: d.profile.fileId, ref: s.ref });
      refs.set(s.key, l);
    }
  }
  const sauts = new Map<number, { root: string; from: number; refs: [string, string]; kind: string } | 'SPANS'>();
  for (const d of docs) {
    if (!d.orphan || !monoBien(d.profile) || (idsOf.get(d.profile.fileId)?.length ?? 0) > 0) continue;
    const roots = new Map<string, { from: number; refs: [string, string]; kind: string }>();
    for (const s of d.profile.signals.filter((x) => x.family === 'CONTRACT' && x.reliability !== 'LOW')) {
      for (const autre of refs.get(s.key) ?? []) {
        if (autre.fileId === d.profile.fileId) continue;
        const porteur = byFile.get(autre.fileId)!;
        if (!monoBien(porteur.profile)) continue;
        for (const root of composantesDe.get(autre.fileId) ?? []) {
          const prev = roots.get(root);
          if (!prev || autre.fileId < prev.from) roots.set(root, { from: autre.fileId, refs: [s.ref, autre.ref], kind: s.kind });
        }
      }
    }
    if (roots.size === 1) { const [[root, v]] = [...roots]; sauts.set(d.profile.fileId, { root, ...v }); }
    else if (roots.size > 1) sauts.set(d.profile.fileId, 'SPANS');
  }

  const decisions = p.decisions ?? [];
  const groups: IdentityGroup[] = [];
  const membership = new Map<number, Membership[]>();
  const exclusions = new Map<number, Array<{ groupKey: string; reason: ExclusionReason }>>();

  for (const dr of [...drafts.values()].sort((a, b) => a.root.localeCompare(b.root))) {
    const keys = [...dr.keys].sort();
    // Clé du groupe : identité d'ADRESSE (ou immatriculation) la plus petite, sinon la plus petite clé.
    const groupKey = sha(keys.find((k) => k.includes(':ADDRESS:') || k.includes(':REGISTRATION:')) ?? keys[0], 24);
    const members: GroupMember[] = [];
    const anchors: IdentityGroup['anchors'] = [];
    const excluded: IdentityGroup['excluded'] = [];
    const edges: GroupEdge[] = [];
    const evidence: IdentitySignal[] = [];
    const contradictions: IdentityGroup['contradictions'] = [];
    const exclure = (fileId: number, reason: ExclusionReason) => {
      if (!excluded.some((e) => e.fileId === fileId)) excluded.push({ fileId, reason });
    };

    for (const [fileId, sigs] of [...dr.own].sort((a, b) => a[0] - b[0])) {
      const d = byFile.get(fileId)!;
      evidence.push(...sigs);
      if (!monoBien(d.profile)) {
        exclure(fileId, d.profile.multiAssetDeclared || d.profile.contradictions.some((c) => c.startsWith('MULTIPLE')) ? 'MULTI_ASSET_DOCUMENT' : 'CONTRADICTORY_DOCUMENT');
        if (d.profile.contradictions.length) contradictions.push({ code: d.profile.contradictions[0], fileIds: [fileId] });
        continue;
      }
      if (d.orphan) members.push({ fileId, via: 'OWN_IDENTITY', evidenceRefs: sigs.map((s) => s.ref), hopFromFileId: null });
      else if (d.primaryAssetIds.length) anchors.push({ fileId, assetIds: [...d.primaryAssetIds].sort((a, b) => a - b) });
    }
    // Arêtes SAME_IDENTITY (provenance : premier signal de chaque document, par clé).
    const porteurs = [...dr.own.entries()].filter(([f]) => monoBien(byFile.get(f)!.profile)).sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < porteurs.length; i += 1) {
      for (let j = i + 1; j < porteurs.length; j += 1) {
        const commun = porteurs[i][1].find((s) => porteurs[j][1].some((t) => identityKeyOf(t) === identityKeyOf(s)));
        if (commun) {
          const autre = porteurs[j][1].find((t) => identityKeyOf(t) === identityKeyOf(commun))!;
          edges.push({ fromFileId: porteurs[i][0], toFileId: porteurs[j][0], via: 'SAME_IDENTITY', kind: commun.kind, evidenceRefs: [commun.ref, autre.ref] });
        }
      }
    }
    // Membres par contrat (un saut).
    for (const [fileId, saut] of sauts) {
      if (saut === 'SPANS') {
        const touche = [...refs.values()].some((l) => l.some((x) => x.fileId === fileId) && l.some((x) => composantesDe.get(x.fileId)?.has(dr.root)));
        if (touche) { exclure(fileId, 'CONTRACT_SPANS_SEVERAL_IDENTITIES'); contradictions.push({ code: 'CONTRACT_SPANS_SEVERAL_IDENTITIES', fileIds: [fileId] }); }
        continue;
      }
      if (saut.root !== dr.root) continue;
      members.push({ fileId, via: 'CONTRACT', evidenceRefs: [saut.refs[0]], hopFromFileId: saut.from });
      edges.push({ fromFileId: saut.from, toFileId: fileId, via: 'SAME_CONTRACT', kind: saut.kind, evidenceRefs: [saut.refs[1], saut.refs[0]] });
      const s = byFile.get(fileId)!.profile.signals.find((x) => x.ref === saut.refs[0]);
      if (s) evidence.push(s);
    }
    // Documents qui CITENT l'identité sans la désigner comme celle du bien : exclus avec leur motif.
    if (dr.family === 'PROPERTY') {
      const clesAdresse = new Set(keys);
      for (const d of docs) {
        if (dr.own.has(d.profile.fileId) || members.some((m) => m.fileId === d.profile.fileId)) continue;
        const cite = d.profile.signals.find((s) => s.kind === 'ADDRESS' && s.family !== 'PROPERTY'
          && clesAdresse.has(identityKeyOf({ family: 'PROPERTY', kind: 'ADDRESS', key: s.key })));
        if (!cite || !d.orphan) continue;
        exclure(d.profile.fileId, isEquipmentDocument(d.profile) ? 'EQUIPMENT_DOCUMENT' : cite.reliability === 'LOW' && cite.role === 'PROPERTY' ? 'UNCERTAIN_READING' : ROLE_EXCLUSION[cite.role] ?? 'ADDRESS_ROLE_UNKNOWN');
      }
    }
    if (members.length === 0) continue;

    // ── Confrontation aux biens actuels.
    const vivants = [...assets.values()];
    const forts = vivants.filter((a) => assetIdentityKeys(a).some((k) => dr.keys.has(k))).map((a) => a.assetId).sort((a, b) => a - b);
    const atteste = new Set<number>();
    for (const an of anchors) {
      for (const id of an.assetIds) {
        const a = assets.get(id);
        if (!a) continue;
        if (compatible(a, dr.family)) atteste.add(id);
        else contradictions.push({ code: 'ANCHOR_LINKED_TO_INCOMPATIBLE_ASSET', fileIds: [an.fileId], assetIds: [id] });
      }
    }
    const actives = decisions.filter((x) => x.groupKey === groupKey && assets.has(x.assetId));
    const confirmes = actives.filter((x) => x.decision === 'CONFIRMED');
    const refusValides = actives.filter((x) => x.decision === 'REFUSED' && x.contextFingerprint === assetIdentityFingerprint(assets.get(x.assetId)!));
    let status: GroupStatus;
    let target: number | null = null;
    let candidates: number[] = [];
    if (forts.length > 1) {
      status = 'AMBIGUOUS'; contradictions.push({ code: 'SEVERAL_ASSETS_SHARE_IDENTITY', fileIds: [], assetIds: forts });
    } else if (forts.length === 1) {
      if ([...atteste].some((id) => id !== forts[0])) { status = 'AMBIGUOUS'; contradictions.push({ code: 'ANCHORS_DISAGREE_WITH_IDENTIFIER', fileIds: anchors.map((x) => x.fileId), assetIds: [...atteste] }); }
      else { status = 'DEMONSTRABLE'; target = forts[0]; }
    } else if (atteste.size > 1) {
      status = 'AMBIGUOUS'; contradictions.push({ code: 'ANCHORS_DISAGREE', fileIds: anchors.map((x) => x.fileId), assetIds: [...atteste].sort((a, b) => a - b) });
    } else if (atteste.size === 1) {
      status = 'ATTESTED'; target = [...atteste][0];
    } else if (confirmes.length > 0) {
      const ids = [...new Set(confirmes.map((x) => x.assetId))];
      const a = ids.length === 1 ? assets.get(ids[0])! : null;
      if (!a) { status = 'AMBIGUOUS'; contradictions.push({ code: 'SEVERAL_CONFIRMED_ASSETS', fileIds: [], assetIds: ids }); }
      else if (!compatible(a, dr.family) || (assetHasIdentity(a, dr.family) && !assetIdentityKeys(a).some((k) => dr.keys.has(k)))) {
        status = 'AMBIGUOUS'; contradictions.push({ code: 'CONFIRMED_ASSET_IDENTITY_CHANGED', fileIds: [], assetIds: [a.assetId] });
      } else { status = 'CONFIRMED'; target = a.assetId; }
    } else {
      const refuses = new Set(refusValides.map((x) => x.assetId));
      candidates = vivants.filter((a) => compatible(a, dr.family) && !assetHasIdentity(a, dr.family) && !refuses.has(a.assetId))
        .map((a) => a.assetId).sort((a, b) => a - b);
      status = candidates.length ? 'TO_CONFIRM' : refuses.size ? 'REFUSED' : 'NO_CANDIDATE';
    }
    const refusedAssetIds = [...new Set(refusValides.map((x) => x.assetId))].sort((a, b) => a - b);
    const label = labelOf(dr.family, evidence);
    const membresTries = members.sort((a, b) => a.fileId - b.fileId);
    const g: IdentityGroup = {
      groupKey, family: dr.family, kinds: [...new Set(evidence.filter((s) => s.family === dr.family).map((s) => s.kind))].sort(), label,
      members: membresTries, anchors, excluded: excluded.sort((a, b) => a.fileId - b.fileId), edges, evidence, contradictions,
      status, targetAssetId: target, candidateAssetIds: candidates, refusedAssetIds,
      decisionIds: actives.map((x) => x.id).sort((a, b) => a - b),
      cardEligible: status === 'TO_CONFIRM' && membresTries.length >= GROUP_CARD_MIN_DOCUMENTS,
      fingerprint: '',
    };
    g.fingerprint = sha({
      v: [IDENTITY_SIGNALS_VERSION, IDENTITY_GRAPH_VERSION], k: keys, f: g.family,
      m: g.members.map((m) => [m.fileId, m.via, m.hopFromFileId]), a: g.anchors, x: g.excluded,
      s: g.status, t: g.targetAssetId, c: g.candidateAssetIds, r: g.refusedAssetIds, d: g.decisionIds,
    });
    groups.push(g);
    for (const m of g.members) (membership.get(m.fileId) ?? membership.set(m.fileId, []).get(m.fileId)!).push({ groupKey, member: m });
    for (const e of g.excluded) (exclusions.get(e.fileId) ?? exclusions.set(e.fileId, []).get(e.fileId)!).push({ groupKey, reason: e.reason });
  }

  // Adresses citées avec un rôle EXPLICITE autre que celui du bien : biens correspondants jamais prouvés par elles.
  const ROLES_HORS_BIEN = new Set(['BILLING', 'DELIVERY', 'SUPPLIER', 'INTERVENTION']);
  const parCleAdresse = new Map<string, number[]>();
  for (const a of p.assets) {
    for (const k of assetIdentityKeys(a).filter((x) => x.includes(':ADDRESS:'))) (parCleAdresse.get(k) ?? parCleAdresse.set(k, []).get(k)!).push(a.assetId);
  }
  const contextOnlyAssets = new Map<number, number[]>();
  for (const d of docs) {
    const adresses = d.profile.signals.filter((x) => x.kind === 'ADDRESS');
    const deBien = new Set(adresses.filter((x) => x.family === 'PROPERTY').map((x) => x.key));
    const ids = new Set<number>();
    for (const x of adresses) {
      if (!ROLES_HORS_BIEN.has(x.role) || deBien.has(x.key)) continue;
      for (const id of parCleAdresse.get(identityKeyOf({ family: 'PROPERTY', kind: 'ADDRESS', key: x.key })) ?? []) ids.add(id);
    }
    if (ids.size) contextOnlyAssets.set(d.profile.fileId, [...ids].sort((a, b) => a - b));
  }

  return {
    accountId: p.accountId, version: IDENTITY_GRAPH_VERSION, groups, byKey: new Map(groups.map((g) => [g.groupKey, g])), membership, exclusions,
    contextOnlyAssets,
    examined: { orphans: docs.filter((d) => d.orphan).length, anchors: docs.filter((d) => !d.orphan).length },
    documents: new Map(docs.map((d) => [d.profile.fileId, { title: d.profile.title, documentType: d.profile.documentType, supplier: d.profile.supplier }])),
  };
}

/** Libellé lisible de l'identité (adresse telle que lue, la plus fiable). */
function labelOf(family: GroupFamily, evidence: readonly IdentitySignal[]): string {
  const rang = (s: IdentitySignal) => (s.origin === 'FACT' ? 0 : 1) + (s.reliability === 'HIGH' ? 0 : 2);
  const tri = [...evidence].filter((s) => s.family === family).sort((a, b) => rang(a) - rang(b) || a.fileId - b.fileId);
  const adr = tri.find((s) => s.kind === 'ADDRESS');
  if (adr) return adr.display;
  const cad = tri.find((s) => s.kind === 'CADASTRAL');
  if (cad) return `parcelle cadastrale ${cad.display}`;
  const imm = tri.find((s) => s.kind === 'REGISTRATION');
  if (imm) return imm.display;
  const vin = tri.find((s) => s.kind === 'VIN');
  return vin ? `VIN ${vin.display}` : 'identité documentaire';
}

/** Appartenance d'un document (premier groupe, ordre stable). Pure. */
export function membershipOf(graph: Pick<AccountIdentityGraph, 'membership' | 'byKey'> | null | undefined, fileId: number): { group: IdentityGroup; member: GroupMember } | null {
  const m = graph?.membership.get(fileId)?.[0];
  if (!m) return null;
  const group = graph!.byKey.get(m.groupKey);
  return group ? { group, member: m.member } : null;
}

/**
 * Empreinte de la part « identité » du contexte d'UN document (pure) :
 * groupe, statut, cible, candidats, refus, décisions, rôle du document.
 * `null` : document hors de tout groupe — l'empreinte du contexte reste
 * celle d'avant le lot 105D (aucune réévaluation inutile).
 */
export function documentIdentityFingerprint(graph: AccountIdentityGraph | null | undefined, fileId: number): string | null {
  if (!graph) return null;
  const m = membershipOf(graph, fileId);
  const ex = graph.exclusions.get(fileId) ?? [];
  const hors = graph.contextOnlyAssets?.get(fileId) ?? [];
  if (!m && ex.length === 0 && hors.length === 0) return null;
  return sha({
    v: IDENTITY_GRAPH_VERSION,
    ...(hors.length ? { h: hors } : {}),
    m: m ? [m.group.groupKey, m.group.status, m.group.targetAssetId, m.group.candidateAssetIds, m.group.refusedAssetIds, m.group.decisionIds, m.member.via, m.group.cardEligible] : null,
    x: ex.map((e) => [e.groupKey, e.reason]),
  });
}
