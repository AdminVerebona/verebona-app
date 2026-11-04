'use client';

/**
 * Lot 109B — conflits de coordonnées OUVERTS, arbitrés sur la fiche
 * fournisseur (« Garder / Utiliser / Ignorer », règles existantes de
 * `POST /api/to-process/suppliers/[id]/resolve`).
 *
 * Chaque conflit montre la valeur actuelle, la valeur relevée et sa PREUVE
 * (document source, ouvert en tiroir par-dessus la fiche). Un champ bancaire
 * reste masqué et « Utiliser » n'y est pas proposé : l'utilisateur vérifie le
 * document puis saisit lui-même le nouvel IBAN. Aucun statut global « à
 * vérifier » ne remplace ces conflits.
 */
import { useState } from 'react';
import { AlertTriangle, FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { openDrawer } from '@/lib/drawers';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DocumentDateCell } from '@/components/documents/DocumentDateCell';
import { SUPPLIER_CONFLICT_APPLICABLE_FIELDS, SUPPLIER_FIELD_LABELS } from '@/lib/suppliers/supplier-fiche-config';
import type { SupplierConflict } from '@/services/suppliers/supplier-detail.service';

type Resolution = 'keep_current' | 'use_detected' | 'ignored';

/** Actions proposées pour un conflit (pure, testée). */
export function conflictActions(c: Pick<SupplierConflict, 'field' | 'masked' | 'detectedValue'>): Resolution[] {
  const canUse = !c.masked && !!c.detectedValue && c.field in SUPPLIER_CONFLICT_APPLICABLE_FIELDS;
  return canUse ? ['keep_current', 'use_detected', 'ignored'] : ['keep_current', 'ignored'];
}

const DONE: Record<Resolution, string> = {
  keep_current: 'Valeur actuelle conservée',
  use_detected: 'Valeur relevée appliquée',
  ignored: 'Conflit ignoré',
};

export function SupplierConflictsCard({ conflicts, onResolved }: { conflicts: SupplierConflict[]; onResolved: () => void }) {
  const { garder } = useWriteGuard();
  const [busy, setBusy] = useState<number | null>(null);
  if (conflicts.length === 0) return null;

  const resolve = (c: SupplierConflict, resolution: Resolution) => garder(() => {
    void (async () => {
      setBusy(c.id);
      try {
        await apiClient.post(`/api/to-process/suppliers/${c.id}/resolve`, { resolution });
        toast.success(DONE[resolution]);
        onResolved();
      } catch {
        toast.error('L’arbitrage n’a pas abouti. Réessayez.');
      } finally {
        setBusy(null);
      }
    })();
  });

  return (
    <Card id="conflits" className="border-[color:var(--attention-edge)]" data-testid="supplier-conflicts">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-[color:var(--attention-on-soft)]" aria-hidden />
          Coordonnées à arbitrer
          <span className="text-sm font-normal text-muted-foreground">({conflicts.length})</span>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Deux sources indiquent des valeurs différentes. Choisissez celle à garder.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {conflicts.map((c) => {
          const label = SUPPLIER_FIELD_LABELS[c.field] ?? 'Coordonnée';
          const actions = conflictActions(c);
          return (
            <div key={c.id} className="rounded-lg border border-[color:var(--border-subtle)] p-3" data-testid="supplier-conflict">
              <p className="text-sm font-semibold">{label}</p>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="rounded-md bg-[color:var(--bg-subtle)] p-2">
                  <p className="text-[11px] text-muted-foreground">Valeur actuelle</p>
                  <p className={`text-sm font-medium [overflow-wrap:anywhere] ${c.masked ? 'font-mono' : ''}`}>{c.currentValue ?? <span className="italic text-muted-foreground">Non renseignée</span>}</p>
                </div>
                <div className="rounded-md bg-[color:var(--attention-soft)] p-2">
                  <p className="text-[11px] text-[color:var(--attention-on-soft)]">Valeur relevée</p>
                  <p className={`text-sm font-medium [overflow-wrap:anywhere] ${c.masked ? 'font-mono' : ''}`}>{c.detectedValue ?? <span className="italic text-muted-foreground">Inconnue</span>}</p>
                </div>
              </div>
              {c.source ? (
                <button
                  type="button"
                  className="mt-2 inline-flex max-w-full items-center gap-1.5 text-xs text-[color:var(--accent)] hover:underline"
                  onClick={() => openDrawer({ kind: 'document', id: c.source!.documentId }, { stack: true })}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">Relevé dans : {c.source.title}</span>
                  <DocumentDateCell value={c.source.documentDate} className="shrink-0 text-muted-foreground" />
                </button>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">Document source indisponible.</p>
              )}
              {c.masked && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Par sécurité, un IBAN relevé n’est jamais appliqué d’un clic : vérifiez le document puis modifiez l’IBAN de la fiche.
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {actions.includes('keep_current') && (
                  <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => resolve(c, 'keep_current')}>Garder</Button>
                )}
                {actions.includes('use_detected') && (
                  <Button size="sm" disabled={busy === c.id} onClick={() => resolve(c, 'use_detected')}>Utiliser</Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => resolve(c, 'ignored')}>
                  {busy === c.id && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />}
                  Ignorer
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
