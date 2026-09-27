/**
 * Cartes de résultats groupées par type — CDC §11.3, §22.2, §22.3, 37.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LES RÉSULTATS ÉTAIENT UNE PHRASE
 *
 * Une recherche aboutie rendait « J'ai trouvé 7 éléments : « A » (document),
 * « B » (bien)… » : ni regroupement par type, ni quotas, ni carte (type, bien,
 * date, statut, extrait, ouverture), ni « Voir tous les résultats ». Le
 * composant `VerebonaResultCard` existait sans être utilisé.
 *
 * Groupes et quotas du §11.3 : 5 biens, 8 documents, 5 événements,
 * 5 fournisseurs, 5 articles d'aide (et 5 éléments « À traiter »). L'ordre des
 * groupes suit la pertinence de leur meilleur résultat ; dans un groupe,
 * l'ordre du retrieval (§22.3). Le client n'affiche que 5 cartes d'abord
 * (§22.3), puis « Voir tous les résultats ». Au-delà du quota d'un groupe, un
 * lien mène à la page complète (§11.3). Les liens sont construits ICI, côté
 * serveur (§22.1).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { RetrievedSource, SourceType } from '../types/sources';
import { hrefSource, parseEntityRef, ROUTES } from './entity-ref';
import { integratedHelpHref } from '@/lib/help-center/open';

export type ResultGroupType = 'asset' | 'document' | 'agenda' | 'supplier' | 'to_process' | 'help';

export const GROUP_QUOTAS: Readonly<Record<ResultGroupType, number>> = {
  asset: 5, document: 8, agenda: 5, supplier: 5, help: 5, to_process: 5,
};

/** Nombre de cartes visibles avant « Voir tous les résultats » (§22.3). */
export const MAX_VISIBLE_CARDS = 5;

const GROUP_LABELS: Record<ResultGroupType, string> = {
  asset: 'Biens', document: 'Documents', agenda: 'Échéances', supplier: 'Fournisseurs',
  to_process: 'À traiter', help: 'Aide',
};

/** Page complète d'un groupe (§11.3) — `null` quand l'application n'en a pas. */
const MORE_HREF: Record<ResultGroupType, string | null> = {
  asset: ROUTES.BIENS, document: ROUTES.DOCUMENTS, agenda: ROUTES.AGENDA,
  to_process: ROUTES.A_TRAITER, help: ROUTES.AIDE, supplier: ROUTES.FOURNISSEURS,
};

export interface ResultCard {
  id: string;
  typeLabel: string;
  title: string;
  /** Bien lié, ville, priorité… (§22.2). */
  subtitle: string | null;
  /** Date utile, ISO (AAAA-MM-JJ). */
  date: string | null;
  /** Statut lisible (« En cours d'analyse »…) — §23.1. */
  status: string | null;
  excerpt: string | null;
  href: string | null;
}

export interface ResultGroup {
  type: ResultGroupType;
  label: string;
  items: ResultCard[];
  /** Résultats trouvés pour ce type (bornés aux candidats du retrieval). */
  total: number;
  /** Plus de résultats que le quota : lien vers la page complète. */
  hasMore: boolean;
  moreHref: string | null;
}

function groupOf(s: RetrievedSource): ResultGroupType | null {
  const map: Partial<Record<SourceType, ResultGroupType>> = {
    asset_field: 'asset', document: 'document', document_extraction: 'document', agenda_item: 'agenda',
    supplier: 'supplier', to_process_item: 'to_process', help_entry: 'help',
  };
  return map[s.type] ?? null;
}

function typeLabel(s: RetrievedSource): string {
  const ref = parseEntityRef(s.id);
  if (ref?.kind === 'equipment') return 'Équipement';
  if (ref?.kind === 'room') return 'Pièce';
  const labels: Partial<Record<SourceType, string>> = {
    asset_field: 'Bien', document: 'Document', document_extraction: 'Document', agenda_item: 'Échéance',
    supplier: 'Fournisseur', to_process_item: 'À traiter', help_entry: 'Aide',
  };
  return labels[s.type] ?? 'Résultat';
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function toResultCard(s: RetrievedSource): ResultCard {
  const meta = s.meta ?? {};
  const href = s.type === 'help_entry' && typeof meta.path === 'string'
    ? integratedHelpHref(String(meta.path).split('#')[0])
    : hrefSource(s.id, meta);
  return {
    id: s.id,
    typeLabel: typeLabel(s),
    title: s.title,
    subtitle: str(meta.assetName) ?? str(meta.subtitle),
    date: str(meta.date),
    status: str(meta.statusLabel),
    excerpt: s.type === 'help_entry' || s.type === 'to_process_item' ? null : (str(s.content)?.slice(0, 160) ?? null),
    href,
  };
}

/**
 * Regroupe des candidats (déjà classés par pertinence) en groupes bornés.
 * Rend `[]` s'il n'y a rien à montrer en cartes.
 */
export function buildResultGroups(candidates: RetrievedSource[]): ResultGroup[] {
  const groups = new Map<ResultGroupType, { best: number; sources: RetrievedSource[] }>();
  for (const s of candidates) {
    const g = groupOf(s);
    if (!g) continue;
    const cur = groups.get(g) ?? { best: -1, sources: [] };
    cur.best = Math.max(cur.best, s.relevanceScore ?? 0);
    cur.sources.push(s);
    groups.set(g, cur);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].best - a[1].best)
    .map(([type, g]) => ({
      type,
      label: GROUP_LABELS[type],
      items: g.sources.slice(0, GROUP_QUOTAS[type]).map(toResultCard),
      total: g.sources.length,
      hasMore: g.sources.length > GROUP_QUOTAS[type],
      moreHref: g.sources.length > GROUP_QUOTAS[type] ? MORE_HREF[type] : null,
    }));
}

const FORMES: Record<ResultGroupType, [string, string]> = {
  asset: ['bien', 'biens'], document: ['document', 'documents'], agenda: ['échéance', 'échéances'],
  supplier: ['fournisseur', 'fournisseurs'], to_process: ['élément à traiter', 'éléments à traiter'],
  help: ['article d’aide', 'articles d’aide'],
};

/** Phrase de synthèse courte accompagnant les cartes (§21.2, §22.3). */
export function summarizeGroups(groups: ResultGroup[]): string {
  const total = groups.reduce((n, g) => n + g.total, 0);
  if (total === 0) return 'Je n’ai rien trouvé de correspondant dans votre compte.';
  if (total === 1) {
    const c = groups[0].items[0];
    return `J’ai trouvé : « ${c.title} » (${c.typeLabel.toLowerCase()}).`;
  }
  const parts = groups.map((g) => `${g.total} ${FORMES[g.type][g.total > 1 ? 1 : 0]}`);
  return `J’ai trouvé ${total} résultats${parts.length > 1 ? ` : ${parts.join(', ')}` : ''}.`;
}
