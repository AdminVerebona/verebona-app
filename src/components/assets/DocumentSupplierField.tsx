'use client';

/**
 * Lot 109B — ligne « Fournisseur » du tiroir document.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN CLIC DE CONSULTATION NE CRÉE JAMAIS RIEN
 *
 * Avant : clic sur le nom → recherche par NOM → premier résultat (homonyme
 * possible) → création d'une fiche si rien n'était trouvé. Désormais :
 *
 *   · la fiche s'ouvre par l'IDENTIFIANT du fournisseur RATTACHÉ au document
 *     (relation persistée `document_suppliers`, `GET /api/documents/[id]/supplier`),
 *     avec retour à ce tiroir ;
 *   · plusieurs rattachements : tous listés, l'utilisateur choisit (aucun
 *     choix arbitraire) ;
 *   · aucun rattachement : le nom relevé est affiché tel quel, avec une
 *     action VOLONTAIRE et distincte « Rattacher à un fournisseur » qui passe
 *     par le référentiel (recherche, puis création seulement après la
 *     vérification de doublon du référentiel) ;
 *   · un rattachement non confirmé reste signalé comme tel (preuve locale de
 *     la relation, jamais rendue « certaine » par l'affichage).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { useCallback, useEffect, useState } from 'react';
import { Link2, Loader2, Search, Sparkles, User } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { supplierHref } from '@/lib/supplier-routes';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

export interface LinkedSupplier {
  id: number;
  name: string;
  status: string;
  role: string | null;
  isConfirmed: boolean;
  confidenceScore: number | null;
}

interface Candidate { id: number; name: string; city?: string | null }

/** État d'affichage (pur, testé) : rattachement unique, plusieurs, aucun. */
export function documentSupplierState(linked: readonly LinkedSupplier[] | null): 'loading' | 'single' | 'multiple' | 'none' {
  if (linked === null) return 'loading';
  if (linked.length === 0) return 'none';
  return linked.length === 1 ? 'single' : 'multiple';
}

const LINK_CLS = 'font-medium text-[color:var(--accent)] hover:underline text-sm text-right';

export function DocumentSupplierField({ documentId, detectedName, detectedByAnalysis, onLinked }: {
  documentId: number;
  /** Nom relevé sur le document (texte), affiché sans lien s'il n'est rattaché à aucune fiche. */
  detectedName: string | null;
  detectedByAnalysis: boolean;
  onLinked?: () => void;
}) {
  const [linked, setLinked] = useState<LinkedSupplier[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiClient.get<{ suppliers: LinkedSupplier[] }>(`/api/documents/${documentId}/supplier`);
      setLinked(Array.isArray(r?.suppliers) ? r.suppliers : []);
      setFailed(false);
    } catch {
      setLinked([]);
      setFailed(true);
    }
  }, [documentId]);

  useEffect(() => { setLinked(null); void load(); }, [load]);

  const state = documentSupplierState(linked);
  const sparkle = detectedByAnalysis && (
    <Sparkles className="w-2.5 h-2.5 text-[color:var(--accent)] shrink-0" aria-label="Détecté automatiquement" />
  );

  return (
    <div className="flex items-start justify-between gap-3" data-testid="document-supplier-field">
      <span className="flex items-center gap-1.5 text-muted-foreground shrink-0"><User className="w-3.5 h-3.5" />Fournisseur</span>
      <div className="flex min-w-0 flex-col items-end gap-1">
        {state === 'loading' && (
          <span className="flex items-center gap-1 text-sm">
            {detectedName ?? <span className="text-muted-foreground">Non renseigné</span>}
            <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" aria-label="Chargement" />
          </span>
        )}
        {state === 'single' && linked && (
          <span className="flex items-center gap-1 min-w-0">
            {/* Lien réel vers la fiche : SupplierReturnManager mémorise ce tiroir pour le retour. */}
            <a href={supplierHref(linked[0].id)} className={`${LINK_CLS} truncate`} data-testid="document-supplier-link">
              {linked[0].name}
            </a>
            {sparkle}
          </span>
        )}
        {state === 'single' && linked && !linked[0].isConfirmed && (
          <span className="text-[11px] text-muted-foreground">Rattachement à confirmer</span>
        )}
        {state === 'multiple' && linked && (
          <>
            <span className="text-[11px] text-muted-foreground">Plusieurs fournisseurs rattachés :</span>
            {linked.map((s) => (
              <a key={s.id} href={supplierHref(s.id)} className={`${LINK_CLS} truncate max-w-full`} data-testid="document-supplier-link">
                {s.name}{s.isConfirmed ? '' : ' (à confirmer)'}
              </a>
            ))}
          </>
        )}
        {state === 'none' && (
          <>
            <span className="flex items-center gap-1 text-sm">
              {detectedName ? <span className="font-medium">{detectedName}</span> : <span className="text-muted-foreground">Non renseigné</span>}
              {detectedName && sparkle}
            </span>
            {failed ? (
              <span className="text-[11px] text-muted-foreground">Fiche fournisseur indisponible pour le moment.</span>
            ) : (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[11px] text-[color:var(--accent)] hover:underline"
                onClick={() => setPickerOpen(true)}
                data-testid="document-supplier-attach"
              >
                <Link2 className="w-3 h-3" aria-hidden />
                {detectedName ? 'Aucune fiche rattachée — rattacher' : 'Rattacher à un fournisseur'}
              </button>
            )}
          </>
        )}
      </div>
      <SupplierAttachDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        documentId={documentId}
        initialQuery={detectedName ?? ''}
        onDone={() => { setPickerOpen(false); void load(); onLinked?.(); }}
      />
    </div>
  );
}

/**
 * Rattachement VOLONTAIRE d'un document à une fiche du référentiel :
 * recherche paginée ; « Créer » ne crée qu'après la vérification de doublon
 * (`POST /api/suppliers` à blanc) et propose d'abord les fiches proches.
 */
function SupplierAttachDialog({ open, onOpenChange, documentId, initialQuery, onDone }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  documentId: number;
  initialQuery: string;
  onDone: () => void;
}) {
  const { garder } = useWriteGuard();
  const [q, setQ] = useState(initialQuery);
  const [rows, setRows] = useState<Candidate[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [proches, setProches] = useState<Candidate[] | null>(null);

  useEffect(() => { if (open) { setQ(initialQuery); setProches(null); } }, [open, initialQuery]);

  const fetchPage = useCallback(async (offset: number, term: string) => {
    const params = new URLSearchParams({ offset: String(offset) });
    if (term.trim()) params.set('search', term.trim());
    return apiClient.get<{ suppliers: Candidate[]; total: number; nextOffset: number | null }>(`/api/suppliers?${params}`);
  }, []);

  useEffect(() => {
    if (!open) return;
    let actif = true;
    setLoading(true);
    const t = setTimeout(() => {
      fetchPage(0, q)
        .then((r) => { if (actif) { setRows(r.suppliers ?? []); setTotal(r.total ?? 0); setNextOffset(r.nextOffset ?? null); } })
        .catch(() => { if (actif) { setRows([]); setTotal(0); setNextOffset(null); } })
        .finally(() => { if (actif) setLoading(false); });
    }, 200);
    return () => { actif = false; clearTimeout(t); };
  }, [q, open, fetchPage]);

  const more = async () => {
    if (nextOffset == null) return;
    setLoading(true);
    try {
      const r = await fetchPage(nextOffset, q);
      setRows((prev) => [...prev, ...(r.suppliers ?? []).filter((x) => !prev.some((p) => p.id === x.id))]);
      setNextOffset(r.nextOffset ?? null);
    } catch { /* la liste reste telle quelle */ } finally { setLoading(false); }
  };

  const attach = (supplierId: number) => garder(() => {
    void (async () => {
      setBusy(true);
      try {
        await apiClient.put(`/api/documents/${documentId}/supplier`, { supplierId });
        toast.success('Fournisseur rattaché au document');
        onDone();
      } catch {
        toast.error('Le rattachement n’a pas abouti. Réessayez.');
      } finally { setBusy(false); }
    })();
  });

  const create = (confirmNew: boolean) => garder(() => {
    void (async () => {
      const name = q.trim().replace(/\s+/g, ' ');
      if (!name) return;
      setBusy(true);
      try {
        if (!confirmNew) {
          const check = await apiClient.post<{ decision: string; candidates?: Candidate[] }>('/api/suppliers', { name, dryRun: true });
          const candidats = check?.candidates ?? [];
          if (check?.decision === 'certain' && candidats[0]) { setBusy(false); attach(candidats[0].id); return; }
          if (check?.decision === 'uncertain' && candidats.length) { setProches(candidats); setBusy(false); return; }
        }
        const created = await apiClient.post<{ supplier: { id: number } }>('/api/suppliers', { name, source: 'manual' });
        await apiClient.put(`/api/documents/${documentId}/supplier`, { supplierId: created.supplier.id });
        toast.success('Fournisseur créé et rattaché au document');
        onDone();
      } catch {
        toast.error('La création n’a pas abouti. Réessayez.');
      } finally { setBusy(false); }
    })();
  });

  const saisie = q.trim();
  const exact = rows.some((r) => r.name.localeCompare(saisie, 'fr', { sensitivity: 'base' }) === 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rattacher à un fournisseur</DialogTitle>
          <DialogDescription>
            Choisissez la fiche du fournisseur de ce document. Une fiche n’est créée que si vous le demandez.
          </DialogDescription>
        </DialogHeader>
        {proches ? (
          <div className="space-y-2">
            <p className="text-sm">Des fournisseurs proches existent déjà. S’agit-il de l’un d’eux ?</p>
            <ul className="divide-y rounded-md border">
              {proches.map((c) => (
                <li key={c.id}>
                  <button type="button" disabled={busy} onClick={() => attach(c.id)} className="w-full px-3 py-2 text-left text-sm hover:bg-muted/40">
                    {c.name}
                  </button>
                </li>
              ))}
            </ul>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setProches(null)} disabled={busy}>Retour à la recherche</Button>
              <Button onClick={() => create(true)} disabled={busy}>Créer « {saisie} » quand même</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un fournisseur" aria-label="Rechercher un fournisseur" className="pl-9" maxLength={200} />
            </div>
            <div className="max-h-72 overflow-y-auto rounded-md border">
              {loading && rows.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">Recherche…</p>
              ) : rows.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">Aucun fournisseur ne correspond.</p>
              ) : (
                <ul className="divide-y">
                  {rows.map((c) => (
                    <li key={c.id}>
                      <button type="button" disabled={busy} onClick={() => attach(c.id)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40">
                        <span className="truncate">{c.name}</span>
                        {c.city && <span className="shrink-0 text-xs text-muted-foreground">{c.city}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{rows.length} sur {total} fournisseur{total > 1 ? 's' : ''}</span>
              {nextOffset != null && (
                <button type="button" className="text-[color:var(--accent)] hover:underline" onClick={() => { void more(); }} disabled={loading}>
                  Afficher plus
                </button>
              )}
            </div>
            {saisie && !exact && (
              <Button variant="outline" className="w-full" onClick={() => create(false)} disabled={busy}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Créer la fiche « {saisie} »
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
