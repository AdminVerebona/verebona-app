'use client';

/**
 * Onglet « Documents » d'un bien — vue par catégorie. CDC 5 design §3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE MÊME COMPOSANT QUE LA PAGE GLOBALE
 *
 * Le §1.3 reproche à l'existant que « la page globale et l'onglet d'un bien
 * possèdent des implémentations distinctes ». Ce fichier ne comporte donc
 * aucune logique de liste : il passe `assetId` à `DocumentsView`, et c'est
 * tout.
 *
 * Les trois différences du §3 en découlent, sans une ligne de plus :
 *
 *   · les catégories sont restreintes à la famille du bien, et portent leur
 *     libellé contextualisé (§3.3) — le serveur s'en charge ;
 *   · le bien courant est masqué sur chaque ligne, puisque l'écran lui est
 *     consacré ;
 *   · « À classer » ne montre que les documents de ce bien.
 *
 * Livré à côté de `asset-documents-panel.tsx`, pas à sa place : le composant
 * existant fait 1 239 lignes et porte le téléversement, la suppression et la
 * fusion. Le remplacer sans avoir vu le rendu reviendrait à parier.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from 'react';
import { DocumentsView } from '@/components/documents/DocumentsView';
import { DocumentClassificationSection } from '@/components/documents/DocumentClassificationSection';
import type { DocumentCardData } from '@/components/documents/DocumentCard';
import type { TypeOption } from '@/components/documents/SortFilterDrawer';
import { Button } from '@/components/ui/button';
import { X, ExternalLink } from 'lucide-react';

export function AssetDocumentsByCategory({ assetId }: { assetId: number }) {
  const [types, setTypes] = useState<TypeOption[]>([]);
  const [ouvert, setOuvert] = useState<DocumentCardData | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    fetch('/api/document-types', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { documentTypes: [] }))
      .then((d) => {
        const liste = Array.isArray(d) ? d : (d.documentTypes ?? d.types ?? []);
        setTypes(
          liste
            .filter((t: { isActive?: boolean }) => t.isActive !== false)
            .map((t: { code: string; label: string }) => ({ code: t.code, label: t.label })),
        );
      })
      .catch(() => setTypes([]));
  }, []);

  const fermer = () => { setOuvert(null); setRevision((v) => v + 1); };

  return (
    <>
      <DocumentsView
        key={revision}
        title="Documents"
        // Seul paramètre qui distingue cet écran de la page globale.
        assetId={assetId}
        availableTypes={types}
        onOpenDocument={setOuvert}
      />

      {ouvert && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
          <button type="button" aria-label="Fermer" onClick={fermer}
                  className="absolute inset-0 bg-black/50" />
          <div className="relative w-full max-w-md h-full overflow-y-auto
                          bg-[color:var(--bg-card)] border-l border-[color:var(--border-subtle)]
                          p-5 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold truncate">{ouvert.retainedTitle}</h2>
                {ouvert.documentTypeLabel && (
                  <p className="text-sm text-[color:var(--text-muted)]">{ouvert.documentTypeLabel}</p>
                )}
              </div>
              <Button variant="ghost" size="sm" aria-label="Fermer" onClick={fermer}>
                <X className="w-4 h-4" />
              </Button>
            </div>

            {/* Autres biens rattachés : le bien courant est masqué, mais
                savoir qu'un document en concerne d'autres reste utile (§4.4). */}
            {ouvert.associations.assets.filter((a) => a.id !== assetId).length > 0 && (
              <div className="text-sm">
                <span className="text-[color:var(--text-muted)]">Également rattaché à </span>
                {ouvert.associations.assets
                  .filter((a) => a.id !== assetId)
                  .map((a) => a.name)
                  .join(', ')}
              </div>
            )}

            <DocumentClassificationSection
              documentId={ouvert.id}
              initialCategoryCode={ouvert.classification.categoryCode}
              initialTypeCode={ouvert.documentTypeCode}
              onSaved={() => { /* La vue se rafraîchit à la fermeture. */ }}
            />

            {ouvert.previewable && (
              <a href={`/api/files/${ouvert.id}/proxy`} target="_blank" rel="noreferrer"
                 className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
                Ouvrir le document
                <ExternalLink className="w-3.5 h-3.5" aria-hidden />
              </a>
            )}
          </div>
        </div>
      )}
    </>
  );
}
