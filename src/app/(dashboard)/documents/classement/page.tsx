'use client';

/**
 * Mes documents — vue par catégorie. CDC 5 design §3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LIVRÉ À CÔTÉ DE L'EXISTANT, PAS À SA PLACE
 *
 * `/documents` fait 979 lignes : recherche, filtres, deux modes d'affichage,
 * téléversement, suppression, prévisualisation, drawer avec navigation.
 * Le remplacer d'un coup, sans avoir vu le rendu, reviendrait à parier.
 *
 * Cette page est donc accessible en parallèle, à `/documents/classement`.
 * Tu compares, tu arbitres, et la bascule se fait ensuite — ou pas.
 *
 * ── CE QU'ELLE APPORTE ────────────────────────────────────────────────────
 *
 * Regroupement par catégorie, compteurs calculés côté serveur sur l'ensemble
 * filtré, pagination par catégorie, et le drawer de classement du §5.1.
 *
 * ── CE QU'ELLE NE REPREND PAS ─────────────────────────────────────────────
 *
 * Le téléversement et la suppression restent sur `/documents`. Les dupliquer
 * ici créerait deux chemins pour la même action — exactement la divergence
 * que le §2 cherche à supprimer. Ils seront repris à la bascule, une fois.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { DocumentsView } from '@/components/documents/DocumentsView';
import { DocumentClassificationSection } from '@/components/documents/DocumentClassificationSection';
import type { DocumentCardData } from '@/components/documents/DocumentCard';
import type { TypeOption } from '@/components/documents/SortFilterDrawer';
import { Button } from '@/components/ui/button';
import { X, ExternalLink } from 'lucide-react';

export default function ClassementPage() {
  const [types, setTypes] = useState<TypeOption[]>([]);
  const [ouvert, setOuvert] = useState<DocumentCardData | null>(null);
  /** Incrémenté à chaque enregistrement : force la vue à se recharger. */
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

  return (
    <div className="container mx-auto px-4 md:px-6 py-6">
      <div className="mb-4 flex items-center gap-3 text-sm text-[color:var(--text-muted)]">
        <span>Vue par catégorie — en cours d&apos;évaluation.</span>
        <Link href="/documents" className="text-primary hover:underline inline-flex items-center gap-1">
          Revenir à la vue actuelle
          <ExternalLink className="w-3 h-3" aria-hidden />
        </Link>
      </div>

      <DocumentsView
        key={revision}
        title="Mes documents"
        availableTypes={types}
        onOpenDocument={setOuvert}
      />

      {/* Panneau de classement.
          Le §5.1 impose qu'il reste ouvert après enregistrement : c'est
          pourquoi la vue n'est rechargée qu'à la fermeture, et non à chaque
          modification. */}
      {ouvert && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Fermer"
            onClick={() => { setOuvert(null); setRevision((v) => v + 1); }}
            className="absolute inset-0 bg-black/50"
          />
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
              <Button
                variant="ghost"
                size="sm"
                aria-label="Fermer"
                onClick={() => { setOuvert(null); setRevision((v) => v + 1); }}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>

            {ouvert.associations.assets.length > 0 && (
              <div className="text-sm">
                <span className="text-[color:var(--text-muted)]">Rattaché à </span>
                {ouvert.associations.assets.map((a) => a.name).join(', ')}
              </div>
            )}

            <DocumentClassificationSection
              documentId={ouvert.id}
              initialCategoryCode={ouvert.classification.categoryCode}
              initialTypeCode={ouvert.documentTypeCode}
              onSaved={() => { /* La vue se rafraîchit à la fermeture. */ }}
            />

            {ouvert.previewable && (
              <a
                href={`/api/files/${ouvert.id}/proxy`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                Ouvrir le document
                <ExternalLink className="w-3.5 h-3.5" aria-hidden />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
