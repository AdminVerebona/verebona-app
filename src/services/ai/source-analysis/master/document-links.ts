/**
 * Liens document ↔ biens posés par T1, chemin master — CDC 15 T1-05, X-01,
 * P-T1-04 ; migration 0221.
 *
 * Un document multi-biens relie CHAQUE bien vérifié :
 *   · PRIMARY   : le bien du document (connu au dépôt, ou unique candidat
 *                 vérifié certain) ;
 *   · SECONDARY : les autres biens cibles de faits vérifiés ;
 *   · MENTIONED : les biens seulement identifiés comme candidats vérifiés.
 * Origine AI, confiance associée. Un document mono-bien ne pose aucun lien
 * AI : ses colonnes (et donc les liens LEGACY_COLUMN du déclencheur) le
 * décrivent déjà. Une réanalyse retire les liens AI devenus sans objet.
 * Chemin legacy : rien n'est écrit ici (seul le déclencheur écrit).
 */
import type { ProjectedFact, T1Confidence } from './t1-contract';
import type { LinkCandidate } from '../types';
import {
  linkDocumentToAsset,
  unlinkDocument,
  type LinkRole,
} from '@/services/documents/document-asset-links';

export interface MasterDocumentLink {
  assetId: number;
  role: LinkRole;
  confidence: number;
}

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
    liens.set(p.documentAssetId, {
      assetId: p.documentAssetId, role: 'PRIMARY',
      confidence: p.documentAssetId === p.knownAssetId ? 1 : (candidats.get(p.documentAssetId) ?? cibles.get(p.documentAssetId) ?? 1),
    });
  }
  for (const [id, score] of cibles) {
    if (!liens.has(id)) liens.set(id, { assetId: id, role: 'SECONDARY', confidence: Math.max(score, candidats.get(id) ?? 0) });
  }
  for (const [id, score] of candidats) {
    if (!liens.has(id)) liens.set(id, { assetId: id, role: 'MENTIONED', confidence: score });
  }
  // Mono-bien : les colonnes suffisent, aucun lien AI.
  return liens.size >= 2 ? [...liens.values()] : [];
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
}): Promise<{ created: number; removed: number; failed: number[] }> {
  let created = 0;
  const failed: number[] = [];
  for (const l of p.links) {
    try {
      const r = await linkDocumentToAsset({
        accountId: p.accountId, fileId: p.fileId, target: { assetId: l.assetId },
        role: l.role, origin: 'AI', confidence: l.confidence,
      });
      if (r.outcome === 'created') created++;
    } catch (e) {
      failed.push(l.assetId);
      console.warn(`[t1-master] lien du document ${p.fileId} vers le bien ${l.assetId} non posé :`, (e as Error).message);
    }
  }
  const removed = await unlinkDocument({
    accountId: p.accountId, fileId: p.fileId, origins: ['AI'],
    keepAssetIds: p.links.map((l) => l.assetId),
  });
  return { created, removed, failed };
}
