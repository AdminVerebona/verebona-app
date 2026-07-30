'use client';

/**
 * Composant document — CDC 5 design §6, livrable §10.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL COMPOSANT POUR LES DEUX ÉCRANS
 *
 * Le principe 6 du §2 l'exige : « employer les mêmes composants et
 * comportements sur les deux écrans afin d'éviter les divergences futures ».
 *
 * La seule différence entre « Mes documents » et l'onglet d'un bien tient dans
 * le §3 : l'onglet « masque le bien courant ». C'est un paramètre
 * (`hideAssetId`), pas un second composant.
 *
 * ── LES CINQ VARIANTES DU §10.1 ───────────────────────────────────────────
 *
 * Aperçu disponible · icône de repli · plusieurs biens · plusieurs éléments ·
 * type absent. Toutes sont portées par ce fichier, aucune ne justifie une
 * copie.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { Badge } from '@/components/ui/badge';
import {
  FileText, Image as ImageIcon, FileSpreadsheet, Globe, File, Inbox,
} from 'lucide-react';

export interface DocumentAssociationView {
  id: number;
  name: string;
  kind: 'asset' | 'equipment';
}

export interface DocumentCardData {
  id: number;
  retainedTitle: string;
  documentTypeCode: string | null;
  documentTypeLabel: string | null;
  documentDate: string | null;
  mimeType: string | null;
  previewable: boolean;
  createdAt: string;
  classification: {
    categoryCode: string | null;
    categoryLabel: string | null;
    classificationState: 'CLASSIFIED' | 'TO_CLASSIFY';
  };
  associations: {
    assets: DocumentAssociationView[];
    elements: DocumentAssociationView[];
  };
}

/** Nombre d'associations affichées avant repli (décision n°4). */
const MAX_VISIBLE_ASSOCIATIONS = 2;

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', day: '2-digit', month: 'short', year: 'numeric',
  }).format(new Date(iso));
}

/** Icône de repli, quand aucun aperçu n'est disponible (§6.3). */
function FallbackIcon({ mimeType }: { mimeType: string | null }) {
  const className = 'w-5 h-5 text-[color:var(--text-muted)]';
  if (!mimeType) return <File className={className} aria-hidden />;
  if (mimeType === 'text/html') return <Globe className={className} aria-hidden />;
  if (mimeType.startsWith('image/')) return <ImageIcon className={className} aria-hidden />;
  if (mimeType.includes('sheet') || mimeType.includes('excel')) {
    return <FileSpreadsheet className={className} aria-hidden />;
  }
  return <FileText className={className} aria-hidden />;
}

/** Puces d'association, repliées au-delà de deux. */
function Associations({
  items,
  hideAssetId,
}: {
  items: DocumentAssociationView[];
  hideAssetId?: number;
}) {
  // §3 : l'onglet d'un bien masque le bien courant — le répéter sur chaque
  // ligne d'un écran qui lui est consacré n'apprend rien.
  const visible = items.filter((i) => !(i.kind === 'asset' && i.id === hideAssetId));
  if (visible.length === 0) return null;

  const shown = visible.slice(0, MAX_VISIBLE_ASSOCIATIONS);
  const hidden = visible.length - shown.length;

  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((item) => (
        <Badge
          key={`${item.kind}-${item.id}`}
          variant="outline"
          className="text-[11px] font-normal py-0 px-1.5 text-[color:var(--text-muted)]"
        >
          {item.name}
        </Badge>
      ))}
      {hidden > 0 && (
        // Un document rattaché à cinq biens ne doit pas tripler la hauteur de
        // sa ligne. Le détail complet est dans le drawer.
        <span
          className="text-[11px] text-[color:var(--text-muted)]"
          title={visible.slice(MAX_VISIBLE_ASSOCIATIONS).map((i) => i.name).join(', ')}
        >
          +{hidden}
        </span>
      )}
    </span>
  );
}

export function DocumentCard({
  document,
  onOpen,
  hideAssetId,
}: {
  document: DocumentCardData;
  onOpen: (id: number) => void;
  /** Bien courant, masqué des associations dans l'onglet d'un bien (§3). */
  hideAssetId?: number;
}) {
  const date = formatDate(document.documentDate) ?? formatDate(document.createdAt);
  const toClassify = document.classification.classificationState === 'TO_CLASSIFY';

  return (
    <button
      type="button"
      // §2, principe 7 : « faire du drawer le point d'entrée unique vers le
      // détail et la modification ». Toute la ligne est donc cliquable, et
      // c'est un vrai bouton — accessible au clavier sans travail
      // supplémentaire (§9.2).
      onClick={() => onOpen(document.id)}
      className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg
                 border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]
                 hover:border-[color:var(--border-strong)] transition-colors
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span className="shrink-0 w-9 h-9 rounded-md bg-[color:var(--bg-page)]
                       flex items-center justify-center overflow-hidden">
        <FallbackIcon mimeType={document.mimeType} />
      </span>

      <span className="flex-1 min-w-0">
        {/* §6.1 : le titre est obligatoire. `truncate` évite qu'un nom de
            fichier interminable ne casse la mise en page. */}
        <span className="block truncate text-sm font-medium text-[color:var(--text-primary)]">
          {document.retainedTitle}
        </span>

        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5">
          {document.documentTypeLabel ? (
            <span className="text-xs text-[color:var(--text-muted)]">
              {document.documentTypeLabel}
            </span>
          ) : (
            // Variante « type absent » (§10.1). Ce n'est pas « Autre » : c'est
            // une absence, et le §2.1 interdit de confondre les deux.
            <span className="text-xs italic text-[color:var(--text-muted)]">
              Type non renseigné
            </span>
          )}
          {date && (
            <span className="text-xs text-[color:var(--text-muted)]">· {date}</span>
          )}
          <Associations
            items={[...document.associations.assets, ...document.associations.elements]}
            hideAssetId={hideAssetId}
          />
        </span>
      </span>

      {toClassify && (
        <Badge
          variant="outline"
          className="shrink-0 text-[11px] bg-amber-500/10 text-amber-300 border-amber-500/30"
        >
          À classer
        </Badge>
      )}
    </button>
  );
}

/** État vide d'une catégorie (§8, livrable §10.1). */
export function EmptyCategory({ label }: { label: string }) {
  return (
    <p className="px-3 py-4 text-sm text-[color:var(--text-muted)]">
      Aucun document dans « {label} ».
    </p>
  );
}

/** État vide global. */
export function EmptyDocuments({ filtered }: { filtered: boolean }) {
  return (
    <div className="text-center py-12 space-y-2">
      <Inbox className="w-10 h-10 mx-auto text-[color:var(--text-muted)]" aria-hidden />
      <p className="text-sm text-[color:var(--text-muted)]">
        {filtered
          ? 'Aucun document ne correspond à ces filtres.'
          : 'Aucun document pour le moment.'}
      </p>
    </div>
  );
}
