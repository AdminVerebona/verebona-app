/**
 * Liens document ↔ biens posés par T1, chemin master — CDC 15 T1-05, X-01,
 * P-T1-04 ; migration 0221.
 *
 * Un document multi-biens relie CHAQUE bien vérifié :
 *   · PRIMARY   : le bien du document (connu au dépôt, ou unique candidat
 *                 vérifié certain) ;
 *   · SECONDARY : les autres biens cibles de faits vérifiés ;
 *   · MENTIONED : les biens seulement identifiés comme candidats vérifiés.
 * Origine AI, confiance associée. Une réanalyse retire les liens AI devenus
 * sans objet.
 *
 * Lot 31B (ticket T1, cause 2) : la cardinalité ne conditionne plus
 * l'existence du lien. L'ancienne règle « mono-bien : les colonnes
 * suffisent » (`liens.size >= 2`) supposait que T1 écrivait `asset_id` — il
 * ne l'écrit pas : un bien identifié avec certitude laissait le document
 * visuellement non rattaché. Un seul bien certain produit donc son lien
 * PRIMARY d'origine AI, comme 2 ou N biens. Quand ce bien est déjà celui
 * de l'utilisateur (colonne, lien USER), `linkDocumentToAsset` ne touche
 * pas au lien existant (`canRefresh`) : aucun doublon.
 */
import type { ProjectedFact, T1Confidence } from './t1-contract';
import type { LinkCandidate } from '../types';
import {
  linkDocumentToAsset,
  unlinkDocument,
  type LinkJustification,
  type LinkProof,
  type LinkRole,
} from '@/services/documents/document-asset-links';
import type { AddressRole } from '@/services/documents/document-asset-links/admission';

interface MasterDocumentLink {
  assetId: number;
  role: LinkRole;
  confidence: number;
  /** Lot 113AM (#739) : étape, règle et preuves jugées par la garde d'admission avant l'écriture. */
  justification?: LinkJustification;
}

/** Raison posée par le serveur sur un candidat issu d'une correspondance exacte (même texte que l'étape T1). */
const SERVER_IDENTIFIER_REASON = 'identifiant canonique exact (contrôle serveur)';

const SCORE: Record<T1Confidence, number> = { certain: 1, probable: 0.6, conflictual: 0.3 };

/** Liens à poser pour un document analysé par le master (fonction PURE). */
export function computeMasterDocumentLinks(p: {
  facts: ProjectedFact[];
  assetCandidates: LinkCandidate[];
  documentAssetId: number | null;
  knownAssetId: number | null;
}): MasterDocumentLink[] {
  const candidats = new Map<number, number>();
  for (const c of p.assetCandidates) {
    if (c.verified && c.entityId !== null) candidats.set(c.entityId, Math.max(candidats.get(c.entityId) ?? 0, c.score));
  }
  const cibles = new Map<number, number>();
  for (const f of p.facts) {
    const id = f.target.targetType === 'ASSET' ? f.target.targetEntityId : null;
    if (id === null) continue;
    cibles.set(id, Math.max(cibles.get(id) ?? 0, SCORE[f.target.targetConfidence]));
  }

  const liens = new Map<number, MasterDocumentLink>();
  if (p.documentAssetId !== null) {
    // Le bien du document n'est retenu que CERTAIN (connu, identifiant exact
    // unique ou unique candidat certain) : confiance 1 (ticket T1, §5).
    liens.set(p.documentAssetId, { assetId: p.documentAssetId, role: 'PRIMARY', confidence: 1 });
  }
  for (const [id, score] of cibles) {
    if (!liens.has(id)) liens.set(id, { assetId: id, role: 'SECONDARY', confidence: Math.max(score, candidats.get(id) ?? 0) });
  }
  for (const [id, score] of candidats) {
    if (!liens.has(id)) liens.set(id, { assetId: id, role: 'MENTIONED', confidence: score });
  }
  // 1 bien, 2 biens ou N biens : même moteur N-N, aucun filtre de cardinalité.
  return [...liens.values()];
}

/**
 * Lot 113AM (#739) — justification de chaque lien T1 (pure) : bien connu au
 * dépôt (KNOWN_TARGET), désignation par le MODÈLE (candidat vérifié du
 * modèle), correspondances exactes admissibles (nature, rôle qualifié de
 * l'adresse), faits ciblés sur le bien. Un candidat qui n'existe que par une
 * correspondance serveur d'adresse non qualifiée n'est plus produit en amont
 * (`admissibleIdentification`) ; s'il l'était, la garde le refuserait ici.
 */
export function justifyMasterDocumentLinks(links: readonly MasterDocumentLink[], p: {
  facts: ProjectedFact[];
  assetCandidates: LinkCandidate[];
  documentAssetId: number | null;
  knownAssetId: number | null;
}): MasterDocumentLink[] {
  return links.map((l) => {
    const proofs: LinkProof[] = [];
    if (p.knownAssetId !== null && l.assetId === p.knownAssetId) proofs.push({ kind: 'KNOWN_TARGET' });
    for (const c of p.assetCandidates) {
      if (c.entityId !== l.assetId || !c.verified) continue;
      const designe = c.modelDesignated ?? (c.reason !== SERVER_IDENTIFIER_REASON && !c.identifiers?.length);
      if (designe) proofs.push({ kind: 'MODEL_DESIGNATION', score: Number.isFinite(c.score) ? c.score : null, detail: c.confidence });
      for (const i of c.identifiers ?? []) {
        proofs.push({ kind: 'IDENTIFIER', identifierKind: i.kind, via: i.via, ...(i.addressRole ? { addressRole: i.addressRole as AddressRole } : {}) });
      }
      // Candidat serveur historique sans détail de preuve : une adresse n'est jamais présumée qualifiée.
      if (!designe && !c.identifiers?.length) proofs.push({ kind: 'IDENTIFIER', identifierKind: 'ADDRESS', addressRole: 'UNQUALIFIED', detail: 'SERVER_CANDIDATE_WITHOUT_DETAIL' });
    }
    const faits = p.facts.filter((f) => f.target.targetType === 'ASSET' && f.target.targetEntityId === l.assetId);
    if (faits.length) proofs.push({ kind: 'FACT_TARGET', score: Math.max(...faits.map((f) => SCORE[f.target.targetConfidence])), detail: `${faits.length} fait(s)` });
    const rule = l.role === 'PRIMARY'
      ? (p.knownAssetId === l.assetId ? 'KNOWN_TARGET' : 'DOCUMENT_ASSET')
      : l.role === 'SECONDARY' ? 'FACT_TARGET_SECONDARY' : 'VERIFIED_CANDIDATE_MENTIONED';
    return { ...l, justification: { step: 'T1_PROJECTION', rule, proofs } };
  });
}

/**
 * Lot 113V (#719) — « Aucun » choisi par l'utilisateur et en vigueur : une
 * analyse ne RATTACHE pas silencieusement le document. Les biens qu'elle
 * désigne restent CITÉS (MENTIONED : indice, jamais un rattachement) ; les
 * liens vers un équipement ou une pièce ne passent pas ici (fonction PURE).
 */
export function withoutAssetAttachment(links: readonly MasterDocumentLink[]): MasterDocumentLink[] {
  return links.map((l) => (l.role === 'MENTIONED' ? l : { ...l, role: 'MENTIONED' as const }));
}

/**
 * Écrit les liens AI du document, puis retire les liens AI d'une analyse
 * antérieure qui ne sont plus justifiés. Chaque lien est indépendant : un
 * échec (cible retirée entre-temps, cloisonnement) est journalisé sans
 * empêcher les autres ni le retrait des liens périmés. Le lien AI déjà posé
 * vers une cible en échec est conservé (retrait par cible, pas par
 * identifiant). Les liens USER / LEGACY_COLUMN / MIGRATION ne sont jamais
 * modifiés (`canRefresh`).
 */
export async function writeMasterDocumentLinks(p: {
  accountId: number;
  fileId: number;
  links: MasterDocumentLink[];
}): Promise<{ created: number; removed: number; failed: number[]; refused: number[] }> {
  let created = 0;
  const failed: number[] = [];
  const refused: number[] = [];
  for (const l of p.links) {
    try {
      const r = await linkDocumentToAsset({
        accountId: p.accountId, fileId: p.fileId, target: { assetId: l.assetId },
        role: l.role, origin: 'AI', confidence: l.confidence,
        // Lot 113AM (#739) : sans justification, la garde refuse (fail-closed).
        justification: l.justification ?? { step: 'T1_PROJECTION', rule: 'UNJUSTIFIED', proofs: [] },
      });
      if (r.outcome === 'created') created++;
      if (r.outcome === 'refused') refused.push(l.assetId);
    } catch (e) {
      failed.push(l.assetId);
      console.warn(`[t1-master] lien du document ${p.fileId} vers le bien ${l.assetId} non posé :`, (e as Error).message);
    }
  }
  // Un lien AI d'une analyse antérieure vers un bien REFUSÉ par la garde est retiré (réanalyse = réparation).
  const removed = await unlinkDocument({
    accountId: p.accountId, fileId: p.fileId, origins: ['AI'],
    keepAssetIds: p.links.map((l) => l.assetId).filter((id) => !refused.includes(id)),
  });
  return { created, removed, failed, refused };
}
