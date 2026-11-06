"use client";
/**
 * Fiche fournisseur — `/fournisseurs/[id]` : l'UNIQUE interface fournisseur
 * (lot 109B — le tiroir fournisseur est supprimé).
 *
 * Point d'arrivée de tous les accès : document, équipement, Agenda, bien,
 * liste `/fournisseurs`, recherche générale, Assistant (OPEN_SUPPLIER) et
 * cartes « À traiter ». En haut, un « Retour » contextualisé ramène à l'écran
 * quitté, tiroir compris (`lib/suppliers/supplier-return.ts`).
 *
 * Sur la fiche même : identité et coordonnées (consultation ET modification),
 * IBAN protégé, conflits de coordonnées à arbitrer avec leur preuve,
 * archivage / réactivation, puis ce qui relie le fournisseur au compte —
 * biens, documents, équipements (pagination jusqu'à la totalité, total exact)
 * et événements d'Agenda (association / dissociation, lot 103E). Aucun statut
 * global « vérifié / non vérifié ».
 *
 * Les droits sont ceux des biens, appliqués côté serveur
 * (`/api/suppliers/[id]/overview`) : un fournisseur d'un autre compte est
 * introuvable ; un bien archivé ou verrouillé par l'offre est listé sans lien.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle, Archive, ArchiveRestore, Building2, ChevronRight, FileText, Home, Loader2, Pencil, Wrench,
} from 'lucide-react';
import { toast } from 'sonner';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { apiClient } from '@/lib/api-client';
import { openDrawer } from '@/lib/drawers';
import { userFacingLabel } from '@/lib/referential/user-facing-labels';
import { DocumentDateCell } from '@/components/documents/DocumentDateCell';
import { DOCUMENT_ROW_SUBTITLE_INCLUDES_ASSET } from '@/lib/documents/document-row-date';
import { SUPPLIERS_ROUTE } from '@/lib/supplier-routes';
import { peekPendingRestore, registerReturnViewState } from '@/lib/suppliers/supplier-return';
import type {
  SupplierAssetRow, SupplierDetail, SupplierDocumentRow, SupplierEquipmentRow,
} from '@/services/suppliers/supplier-detail.service';
import { SupplierAgendaSection } from '@/components/suppliers/SupplierAgendaSection';
import { SupplierBackButton } from '@/components/suppliers/SupplierBackButton';
import { SupplierCoordinatesCard } from '@/components/suppliers/SupplierCoordinatesCard';
import { SupplierConflictsCard } from '@/components/suppliers/SupplierConflictsCard';
import { useSupplierSection } from '@/components/suppliers/useSupplierSection';
import { useUnsavedChangesGuard } from '@/components/suppliers/useUnsavedChangesGuard';

type Overview = SupplierDetail;

function Section({ icon: Icon, title, total, shown, children, empty, nextOffset, loading, failed, onMore, testId }: {
  icon: React.ElementType; title: string; total: number; shown: number; children: React.ReactNode; empty: string;
  nextOffset: number | null; loading: boolean; failed: boolean; onMore: () => void; testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-muted-foreground" aria-hidden />
          {title}
          <span className="text-sm font-normal text-muted-foreground" data-testid={`${testId}-total`}>({total})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {total === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : <ul className="divide-y">{children}</ul>}
        {failed && <p className="mt-2 text-xs text-muted-foreground">La suite n’a pas pu être chargée. Réessayez.</p>}
        {nextOffset != null && (
          <div className="mt-3 flex flex-col items-center gap-1 sm:flex-row sm:justify-between">
            <span className="text-xs text-muted-foreground">{shown} sur {total}</span>
            <Button variant="outline" size="sm" onClick={onMore} disabled={loading} className="h-11 w-full sm:h-9 sm:w-auto">
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Afficher plus
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Ligne cliquable (ou non, si l'objet n'est pas ouvrable). */
function Row({ title, subtitle, aside, onOpen, href, unavailable }: {
  title: string; subtitle?: string | null; onOpen?: () => void; href?: string; unavailable?: boolean;
  /** Lot 108D : colonne de droite (date du document d'une ligne de document). */
  aside?: React.ReactNode;
}) {
  const content = (
    <>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {aside}
      {unavailable
        ? <span className="text-xs text-muted-foreground">Non disponible</span>
        : <ChevronRight className="w-4 h-4 text-muted-foreground" aria-hidden />}
    </>
  );
  const cls = 'flex w-full items-center gap-3 py-2.5 text-left';
  if (unavailable) return <li className={`${cls} opacity-70`} title="Ce bien est archivé ou n’est pas accessible avec votre offre.">{content}</li>;
  if (href) return <li><Link href={href} className={`${cls} hover:bg-muted/40 rounded-md px-1`}>{content}</Link></li>;
  return <li><button type="button" onClick={onOpen} className={`${cls} hover:bg-muted/40 rounded-md px-1`}>{content}</button></li>;
}

export default function SupplierPage() {
  const params = useParams();
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const search = searchParams ? `?${searchParams.toString()}` : '';
  const router = useRouter();
  const { setBreadcrumbs } = useBreadcrumb();
  const { garder } = useWriteGuard();
  const [data, setData] = useState<Overview | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'not_found' | 'error'>('loading');
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const id = String(params.id ?? '');
  const supplierId = /^\d{1,10}$/.test(id) ? Number(id) : 0;

  const guard = useUnsavedChangesGuard(dirty, (href) => router.push(href));

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/suppliers/${encodeURIComponent(id)}/overview`, { credentials: 'include' });
      if (res.status === 404 || res.status === 400) { setState('not_found'); return; }
      if (!res.ok) { setState('error'); return; }
      setData(await res.json());
      setState('ready');
    } catch {
      setState('error');
    }
  }, [id]);

  useEffect(() => { setState('loading'); setEditing(false); setDirty(false); void load(); }, [load]);

  useEffect(() => {
    setBreadcrumbs([
      { label: 'Fournisseurs', href: SUPPLIERS_ROUTE },
      { label: data?.supplier.name ?? 'Fournisseur' },
    ]);
  }, [data, setBreadcrumbs]);

  const docs = useSupplierSection<SupplierDocumentRow>(supplierId, 'documents', data?.documents ?? null);
  const assets = useSupplierSection<SupplierAssetRow>(supplierId, 'assets', data?.assets ?? null);
  const equipments = useSupplierSection<SupplierEquipmentRow>(supplierId, 'equipments', data?.equipments ?? null);

  // Retour sur cette fiche depuis une autre (document → autre fournisseur) :
  // les sections déjà dépliées sont rechargées jusqu'au même nombre de lignes.
  const counts = useRef({ documents: 0, assets: 0, equipments: 0 });
  counts.current = { documents: docs.items.length, assets: assets.items.length, equipments: equipments.items.length };
  useEffect(() => registerReturnViewState(pathname, () => ({ sections: { ...counts.current } })), [pathname]);
  const restoreView = useRef(peekPendingRestore(pathname)?.view ?? null);
  useEffect(() => {
    const v = restoreView.current as { sections?: Record<string, number> } | null;
    if (!v?.sections || state !== 'ready') return;
    restoreView.current = null;
    void docs.ensureLoaded(Number(v.sections.documents) || 0);
    void assets.ensureLoaded(Number(v.sections.assets) || 0);
    void equipments.ensureLoaded(Number(v.sections.equipments) || 0);
  }, [state, docs, assets, equipments]);

  // Tiroir (document, équipement) qui modifie une relation : la fiche est relue.
  useEffect(() => {
    const h = () => { void load(); };
    window.addEventListener('refresh-a-traiter', h);
    return () => window.removeEventListener('refresh-a-traiter', h);
  }, [load]);

  const archive = (restore: boolean) => garder(() => {
    void (async () => {
      setArchiving(true);
      try {
        await apiClient.post(`/api/suppliers/${supplierId}/archive`, restore ? { restore: true } : {});
        toast.success(restore ? 'Fournisseur réactivé' : 'Fournisseur archivé');
        setArchiveOpen(false);
        await load();
      } catch {
        toast.error('L’opération n’a pas abouti. Réessayez.');
      } finally {
        setArchiving(false);
      }
    })();
  });

  const back = <SupplierBackButton search={search} confirmLeave={guard.confirmLeave} />;

  if (state === 'loading') {
    return (
      <div className="space-y-6 p-4 md:p-6">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (state !== 'ready' || !data) {
    return (
      <div className="space-y-4 p-4 md:p-6">
        {back}
        <Card>
          <CardContent className="flex flex-col items-start gap-3 pt-6">
            <AlertTriangle className="w-5 h-5 text-muted-foreground" aria-hidden />
            <p className="font-medium">
              {state === 'not_found' ? 'Ce fournisseur est introuvable dans votre compte.' : 'La fiche n’a pas pu être chargée.'}
            </p>
            <p className="text-sm text-muted-foreground">
              {state === 'not_found'
                ? 'Il a peut-être été supprimé, ou il appartient à un autre compte.'
                : 'Vérifiez votre connexion puis réessayez.'}
            </p>
            <div className="flex gap-2">
              {state === 'error' && <Button size="sm" onClick={() => { setState('loading'); void load(); }}>Réessayer</Button>}
              <Button size="sm" variant="outline" asChild><Link href={SUPPLIERS_ROUTE}>Voir tous les fournisseurs</Link></Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const s = data.supplier;
  const archived = s.status === 'archived';
  const via = data.documentsViaOperation;

  return (
    <div className="space-y-6 p-4 md:p-6" data-testid="supplier-page">
      {back}

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-[color:var(--accent-soft)]">
                <Building2 className="h-5 w-5 text-[color:var(--accent)]" aria-hidden />
              </div>
              <div className="min-w-0">
                <h1 className="vb-app-title [overflow-wrap:anywhere]">{s.name}</h1>
                <div className="mt-2 flex flex-wrap gap-2">
                  {archived && <Badge variant="secondary">Archivé</Badge>}
                  {data.conflicts.length > 0 && (
                    <a href="#conflits">
                      <Badge variant="outline" className="border-[color:var(--attention-edge)] text-[color:var(--attention-on-soft)]">
                        {data.conflicts.length} coordonnée{data.conflicts.length > 1 ? 's' : ''} à arbitrer
                      </Badge>
                    </a>
                  )}
                </div>
              </div>
            </div>
            {!editing && (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button variant="outline" size="sm" className="h-11 sm:h-9" onClick={() => garder(() => setEditing(true))} data-testid="supplier-edit">
                  <Pencil className="mr-2 h-4 w-4" aria-hidden />
                  Modifier
                </Button>
                {archived ? (
                  <Button variant="outline" size="sm" className="h-11 sm:h-9" onClick={() => archive(true)} disabled={archiving}>
                    <ArchiveRestore className="mr-2 h-4 w-4" aria-hidden />
                    Réactiver
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" className="h-11 text-[color:var(--danger)] sm:h-9" onClick={() => garder(() => setArchiveOpen(true))} data-testid="supplier-archive">
                    <Archive className="mr-2 h-4 w-4" aria-hidden />
                    Archiver
                  </Button>
                )}
              </div>
            )}
          </div>

          {archived && (
            <p className="mt-4 rounded-md bg-[color:var(--bg-subtle)] p-3 text-sm text-muted-foreground">
              Ce fournisseur est archivé : il n’apparaît plus parmi les fournisseurs actifs. Ses documents, biens,
              équipements et événements restent rattachés.
            </p>
          )}

          <div className="mt-6 border-t pt-4">
            <SupplierCoordinatesCard
              supplier={s}
              editing={editing}
              onEditingChange={(v) => { if (!v) guard.confirmLeave(() => { setEditing(false); setDirty(false); }); else setEditing(true); }}
              onDirtyChange={setDirty}
              onSaved={() => { setDirty(false); setEditing(false); void load(); }}
            />
          </div>
        </CardContent>
      </Card>

      <SupplierConflictsCard conflicts={data.conflicts} onResolved={() => { void load(); }} />

      {data.openDeduplicationCount > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6 text-sm sm:flex-row sm:items-center sm:justify-between">
            <span>Une autre fiche pourrait désigner le même fournisseur.</span>
            <Button variant="outline" size="sm" asChild><Link href="/accueil/a-traiter">Voir dans « À traiter »</Link></Button>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Section
          icon={Home} title="Biens" total={assets.total} shown={assets.items.length} testId="supplier-assets"
          empty="Aucun bien n’est rattaché à ce fournisseur."
          nextOffset={assets.nextOffset} loading={assets.loading} failed={assets.failed} onMore={() => { void assets.loadMore(); }}
        >
          {assets.items.map((a) => (
            <Row key={a.id} title={a.name} subtitle={a.city} href={`/assets/${a.id}`} unavailable={!a.available} />
          ))}
        </Section>

        <Section
          icon={FileText} title="Documents" total={docs.total} shown={docs.items.length} testId="supplier-documents"
          empty="Aucun document n’est rattaché à ce fournisseur."
          nextOffset={docs.nextOffset} loading={docs.loading} failed={docs.failed} onMore={() => { void docs.loadMore(); }}
        >
          {docs.items.map((d) => (
            <Row
              key={d.id}
              title={d.title}
              /* Lot 108D : sous-titre = Type seul ; UNE date à droite, la date du document (sinon « – »).
                 Lot 113G (#706) : plus de « Rattachement à confirmer » déduit de la seule fiabilité du lien — un vrai
                 doute d'identité est signalé par le bandeau ci-dessus (carte « À traiter » actionnable). */
              subtitle={[userFacingLabel(d.documentTypeLabel), DOCUMENT_ROW_SUBTITLE_INCLUDES_ASSET ? d.assetName : null].filter(Boolean).join(' · ')}
              aside={<DocumentDateCell value={d.documentDate} className="w-[74px] text-xs text-muted-foreground sm:w-[90px]" />}
              onOpen={() => openDrawer({ kind: 'document', id: d.id })}
              unavailable={!d.available}
            />
          ))}
        </Section>

        {/* Lot 109B : documents des événements de référence du fournisseur — section affichée
            seulement quand le contrat de lecture 109A est relié (supplier-operation-documents.ts). */}
        {via?.wired && via.total > 0 && (
          <Section
            icon={FileText} title="Documents des événements de référence" total={via.total} shown={via.items.length}
            testId="supplier-documents-via" empty="" nextOffset={null} loading={false} failed={false} onMore={() => {}}
          >
            {via.items.map((d) => (
              <Row
                key={d.id}
                title={d.title}
                subtitle={[userFacingLabel(d.documentTypeLabel), d.operationLabel].filter(Boolean).join(' · ')}
                aside={<DocumentDateCell value={d.documentDate} className="w-[74px] text-xs text-muted-foreground sm:w-[90px]" />}
                onOpen={() => openDrawer({ kind: 'document', id: d.id })}
                unavailable={!d.available}
              />
            ))}
          </Section>
        )}

        <Section
          icon={Wrench} title="Équipements" total={equipments.total} shown={equipments.items.length} testId="supplier-equipments"
          empty="Aucun équipement n’est rattaché à ce fournisseur."
          nextOffset={equipments.nextOffset} loading={equipments.loading} failed={equipments.failed} onMore={() => { void equipments.loadMore(); }}
        >
          {equipments.items.map((e) => (
            <Row
              key={e.id}
              title={e.name}
              subtitle={[e.assetName, e.isPrimary ? 'Fournisseur principal' : null].filter(Boolean).join(' · ')}
              onOpen={() => openDrawer({ kind: 'equipement', id: e.id })}
              unavailable={!e.available}
            />
          ))}
        </Section>

        {/* Lot 103E : événements d'Agenda RATTACHÉS (relation persistante, bidirectionnelle) — passés,
            à venir, sans date ; association / dissociation depuis la fiche. */}
        <SupplierAgendaSection supplierId={s.id} supplierName={s.name} />
      </div>

      {/* Archivage confirmé */}
      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archiver ce fournisseur ?</AlertDialogTitle>
            <AlertDialogDescription>
              Il n’apparaîtra plus parmi les fournisseurs actifs. Sa fiche reste consultable et ses documents,
              biens, équipements et événements restent rattachés. Vous pourrez le réactiver.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); archive(false); }} disabled={archiving} className="bg-[color:var(--danger)] hover:bg-[color:var(--danger)]/90">
              Archiver
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Saisie non enregistrée : confirmation avant de partir (bouton, lien, retour navigateur ou mobile). */}
      <AlertDialog open={guard.confirmOpen} onOpenChange={(v) => { if (!v) guard.resolve(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Modifications non enregistrées</AlertDialogTitle>
            <AlertDialogDescription>Vos modifications de ce fournisseur seront perdues.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => guard.resolve(false)}>Continuer la modification</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setDirty(false); guard.resolve(true); }}>Quitter sans enregistrer</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
