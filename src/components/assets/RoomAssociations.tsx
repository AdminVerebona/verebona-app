'use client';

/**
 * Tiroir Pièce — sections « Équipements » et « Documents ». Lot 75 (75B).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * GESTION BIDIRECTIONNELLE DEPUIS LA PIÈCE
 *
 * Équipements : afficher, associer des équipements EXISTANTS du même bien
 * (un équipement déjà dans une autre pièce n'est déplacé qu'après
 * confirmation : une pièce au plus par équipement, modèle inchangé), créer
 * un équipement (bien et pièce présélectionnés), ouvrir sa fiche (carte
 * empilée, lot 75H), dissocier sans supprimer.
 *
 * Documents : liste CONSOLIDÉE — documents liés à la pièce ET documents de
 * ses équipements, chacun une fois, avec sa provenance (« Pièce », « Via
 * Réfrigérateur ») ; associer des documents existants du bien, importer un
 * document (pièce présélectionnée), ouvrir, dissocier — seulement un lien
 * DIRECT (un document « Via » se détache en dissociant l'équipement).
 *
 * Données : `GET /api/substructures/[id]/associations` (résolution centrale
 * `services/rooms/room-scope.service.ts`, la même que les filtres Pièce de
 * « Mes documents » et « Mon agenda »). Toute écriture émet
 * `ROOM_ASSOCIATIONS_CHANGED` : tiroirs Équipement et Document ouverts,
 * listes et filtres se relisent.
 *
 * Même composant sur ordinateur et téléphone (tiroir plein écran sur mobile) :
 * sélecteur intégré à la section, pas de fenêtre flottante.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { FileText, Link2, Loader2, Plus, Unlink, Upload, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { EntityCard, EntityCardList } from '@/components/drawers/EntityCard';
import { apiClient } from '@/lib/api-client';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { LazyUnifiedDocumentDialog } from '@/components/mobile/add-forms';
import {
  ROOM_ASSOCIATIONS_CHANGED, canDissociateRoomDocument, notifyRoomAssociationsChanged, reassignConfirmationText,
  roomDocumentProvenance, type RoomAssociations as RoomAssociationsData, type RoomCandidate, type RoomReassignConflict,
} from '@/lib/rooms/room-associations';

const EquipmentDrawer = dynamic(
  () => import('@/components/assets/EquipmentDrawer').then((m) => ({ default: m.EquipmentDrawer })),
  { ssr: false },
);

type Kind = 'equipment' | 'document';

const PILL = 'inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-medium leading-tight';
const PILL_PIECE = `${PILL} bg-[color:var(--accent-soft)] text-[color:var(--accent)] border-[color:var(--border-info)]`;
const PILL_VIA = `${PILL} bg-[color:var(--bg-subtle)] text-[color:var(--text-secondary)] border-[color:var(--border)]`;

function formatDate(d: string | null): string | null {
  if (!d) return null;
  const t = new Date(`${d.slice(0, 10)}T12:00:00`);
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Les écrans dessous (liste des pièces, équipements du bien) se relisent aussi. */
function apresEcriture(detail: { roomIds: number[]; equipmentIds?: number[]; fileIds?: number[] }, onRefresh?: () => void) {
  notifyRoomAssociationsChanged(detail);
  onRefresh?.();
}

export function RoomAssociations({ roomId, assetId, onRefresh }: { roomId: number; assetId: number; onRefresh?: () => void }) {
  const [data, setData] = useState<RoomAssociationsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [picker, setPicker] = useState<Kind | null>(null);
  const [confirm, setConfirm] = useState<{ kind: Kind; ids: number[]; conflicts: RoomReassignConflict[] } | null>(null);
  const [detach, setDetach] = useState<{ kind: Kind; id: number; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [createEquipment, setCreateEquipment] = useState(false);
  const [importDoc, setImportDoc] = useState(false);
  const { garder } = useWriteGuard();

  const requete = useRef(0);
  const load = useCallback(async () => {
    const n = ++requete.current;
    try {
      const r = await apiClient.get<RoomAssociationsData>(`/api/substructures/${roomId}/associations`);
      if (n !== requete.current) return;
      setData(r);
      setError(false);
    } catch {
      if (n === requete.current) setError(true);
    } finally {
      if (n === requete.current) setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    setPicker(null);
    void load();
  }, [load]);

  // Associations modifiées ailleurs (tiroir Équipement ou Document, ajout,
  // suppression) : la pièce se relit.
  useEffect(() => {
    const relire = () => { void load(); };
    const evenements = [ROOM_ASSOCIATIONS_CHANGED, 'refresh-a-traiter', 'document-added', 'document-deleted'];
    evenements.forEach((e) => window.addEventListener(e, relire));
    return () => evenements.forEach((e) => window.removeEventListener(e, relire));
  }, [load]);

  const roomName = data?.room.name ?? '';

  const associer = useCallback(async (kind: Kind, ids: number[], confirmReassign: boolean) => {
    setBusy(true);
    try {
      const url = `/api/substructures/${roomId}/${kind === 'equipment' ? 'equipments' : 'documents'}`;
      const body = kind === 'equipment' ? { equipmentIds: ids, confirmReassign } : { fileIds: ids, confirmReassign };
      await apiClient.post(url, body);
      toast.success(ids.length > 1
        ? `${ids.length} ${kind === 'equipment' ? 'équipements associés' : 'documents associés'}`
        : kind === 'equipment' ? 'Équipement associé' : 'Document associé');
      setConfirm(null);
      setPicker(null);
      const anciennes = (confirm?.conflicts ?? []).map((c) => c.currentRoom.id);
      apresEcriture({
        roomIds: [roomId, ...anciennes],
        ...(kind === 'equipment' ? { equipmentIds: ids } : { fileIds: ids }),
      }, onRefresh);
      void load();
    } catch (e) {
      const err = e as { status?: number; code?: string; details?: { conflicts?: RoomReassignConflict[] }; message?: string };
      if (err.status === 409 && err.code === 'REASSIGN_CONFIRMATION' && err.details?.conflicts?.length) {
        setConfirm({ kind, ids, conflicts: err.details.conflicts });
      } else {
        toast.error(err.message ?? 'Association impossible');
      }
    } finally {
      setBusy(false);
    }
  }, [roomId, load, onRefresh, confirm]);

  const dissocier = useCallback(async () => {
    if (!detach) return;
    setBusy(true);
    try {
      const segment = detach.kind === 'equipment' ? 'equipments' : 'documents';
      await apiClient.delete(`/api/substructures/${roomId}/${segment}/${detach.id}`);
      toast.success(detach.kind === 'equipment' ? 'Équipement dissocié de la pièce' : 'Document dissocié de la pièce');
      apresEcriture({
        roomIds: [roomId],
        ...(detach.kind === 'equipment' ? { equipmentIds: [detach.id] } : { fileIds: [detach.id] }),
      }, onRefresh);
      setDetach(null);
      void load();
    } catch (e) {
      toast.error((e as { message?: string }).message ?? 'Dissociation impossible');
    } finally {
      setBusy(false);
    }
  }, [detach, roomId, load, onRefresh]);

  if (loading && !data) {
    return (
      <div role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> Chargement des équipements et documents…
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="py-3 text-sm text-muted-foreground">
        Impossible de charger les équipements et documents de la pièce.{' '}
        <button type="button" className="underline" onClick={() => { setLoading(true); void load(); }}>Réessayer</button>
      </div>
    );
  }
  if (!data) return null;

  const directs = data.documents.filter((d) => d.direct).length;

  return (
    <div className="space-y-5" data-testid="piece-associations">
      {/* ── Équipements ── */}
      <section aria-labelledby={`piece-${roomId}-equipements`} className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`piece-${roomId}-equipements`} className="vb-app-subsection flex items-center gap-2">
            <Wrench className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
            Équipements <span className="text-muted-foreground font-normal text-sm">· {data.equipments.length}</span>
          </h3>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={() => garder(() => setPicker(picker === 'equipment' ? null : 'equipment'))} aria-expanded={picker === 'equipment'}>
              <Link2 className="w-3.5 h-3.5" aria-hidden /> Associer
            </Button>
            <Button size="sm" variant="outline" onClick={() => garder(() => setCreateEquipment(true))}>
              <Plus className="w-3.5 h-3.5" aria-hidden /> Créer
            </Button>
          </div>
        </div>
        {picker === 'equipment' && (
          <AssociationPicker
            roomId={roomId}
            kind="equipment"
            busy={busy}
            onCancel={() => setPicker(null)}
            onSubmit={(ids) => associer('equipment', ids, false)}
          />
        )}
        {data.equipments.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucun équipement dans cette pièce.</p>
        ) : (
          <EntityCardList>
            {data.equipments.map((e) => (
              <EntityCard
                key={e.id}
                kind="equipement"
                id={e.id}
                title={e.archived ? `${e.name} (archivé)` : e.name}
                icon={<Wrench className="w-3.5 h-3.5" />}
                meta={e.type ?? undefined}
                data-testid="piece-equipement"
                actions={(
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    aria-label={`Dissocier ${e.name} de la pièce`}
                    title="Dissocier de la pièce"
                    onClick={() => garder(() => setDetach({ kind: 'equipment', id: e.id, title: e.name }))}
                  >
                    <Unlink className="w-3.5 h-3.5" aria-hidden />
                  </Button>
                )}
              />
            ))}
          </EntityCardList>
        )}
      </section>

      {/* ── Documents ── */}
      <section aria-labelledby={`piece-${roomId}-documents`} className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`piece-${roomId}-documents`} className="vb-app-subsection flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
            Documents <span className="text-muted-foreground font-normal text-sm">· {data.documents.length}</span>
          </h3>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={() => garder(() => setPicker(picker === 'document' ? null : 'document'))} aria-expanded={picker === 'document'}>
              <Link2 className="w-3.5 h-3.5" aria-hidden /> Associer
            </Button>
            <Button size="sm" variant="outline" onClick={() => garder(() => setImportDoc(true), 'documents')}>
              <Upload className="w-3.5 h-3.5" aria-hidden /> Importer
            </Button>
          </div>
        </div>
        {data.documents.length > directs && (
          <p className="text-xs text-muted-foreground">
            Les documents des équipements de la pièce apparaissent ici automatiquement (« Via … »).
          </p>
        )}
        {picker === 'document' && (
          <AssociationPicker
            roomId={roomId}
            kind="document"
            busy={busy}
            onCancel={() => setPicker(null)}
            onSubmit={(ids) => associer('document', ids, false)}
          />
        )}
        {data.documents.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucun document pour cette pièce ni pour ses équipements.</p>
        ) : (
          <EntityCardList>
            {data.documents.map((d) => {
              const provenance = roomDocumentProvenance(d);
              const date = formatDate(d.documentDate);
              return (
                <EntityCard
                  key={d.id}
                  kind="document"
                  id={d.id}
                  title={d.title}
                  icon={<FileText className="w-3.5 h-3.5" />}
                  data-testid="piece-document"
                  meta={(
                    <span className="flex flex-wrap items-center gap-1">
                      {[d.documentTypeLabel, date].filter(Boolean).join(' · ')}
                      {provenance.map((p) => (
                        <span key={p} className={p === 'Pièce' ? PILL_PIECE : PILL_VIA} data-provenance={p === 'Pièce' ? 'piece' : 'via'}>{p}</span>
                      ))}
                    </span>
                  )}
                  actions={canDissociateRoomDocument(d) ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label={`Dissocier ${d.title} de la pièce`}
                      title="Dissocier de la pièce"
                      onClick={() => garder(() => setDetach({ kind: 'document', id: d.id, title: d.title }))}
                    >
                      <Unlink className="w-3.5 h-3.5" aria-hidden />
                    </Button>
                  ) : undefined}
                />
              );
            })}
          </EntityCardList>
        )}
      </section>

      {/* Réaffectation : un équipement ou un document a une pièce au plus. */}
      <AlertDialog open={!!confirm} onOpenChange={(v) => { if (!v && !busy) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Déplacer vers « {roomName} » ?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm ? reassignConfirmationText(confirm.kind, roomName, confirm.conflicts) : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => { e.preventDefault(); if (confirm) void associer(confirm.kind, confirm.ids, true); }}
            >
              Déplacer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!detach} onOpenChange={(v) => { if (!v && !busy) setDetach(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dissocier de la pièce ?</AlertDialogTitle>
            <AlertDialogDescription>
              {detach?.kind === 'equipment'
                ? `« ${detach.title} » ne sera plus rattaché à « ${roomName} ». L’équipement, ses documents et ses échéances sont conservés.`
                : `« ${detach?.title ?? ''} » ne sera plus rattaché directement à « ${roomName} ». Le document est conservé.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Annuler</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); void dissocier(); }}>
              Dissocier
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {createEquipment && (
        <EquipmentDrawer
          open
          onOpenChange={(v) => { if (!v) setCreateEquipment(false); }}
          assetId={assetId}
          assetName={data.room.assetName}
          equipment={null}
          substructures={[{ id: roomId, name: roomName }]}
          initialSubstructureId={roomId}
          onRefresh={() => { void load(); onRefresh?.(); }}
        />
      )}
      {importDoc && (
        <LazyUnifiedDocumentDialog
          open
          onOpenChange={(v) => { if (!v) setImportDoc(false); }}
          preselectedAssetId={assetId}
          preselectedSubstructureId={roomId}
          onSuccess={() => {
            setImportDoc(false);
            apresEcriture({ roomIds: [roomId] }, onRefresh);
            void load();
          }}
        />
      )}
    </div>
  );
}

/**
 * Sélecteur intégré à la section : recherche, cases à cocher, pièce actuelle
 * signalée (« Actuellement : Cellier » — la sélection sera une réaffectation,
 * confirmée ensuite).
 */
function AssociationPicker({
  roomId, kind, busy, onCancel, onSubmit,
}: {
  roomId: number;
  kind: Kind;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (ids: number[]) => void;
}) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<RoomCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    let actuel = true;
    const t = setTimeout(() => {
      const params = new URLSearchParams({ kind, q });
      apiClient.get<{ candidates: RoomCandidate[] }>(`/api/substructures/${roomId}/candidates?${params}`)
        .then((r) => { if (actuel) setItems(r.candidates ?? []); })
        .catch(() => { if (actuel) setItems([]); });
    }, q ? 250 : 0);
    return () => { actuel = false; clearTimeout(t); };
  }, [roomId, kind, q]);

  const toggle = (id: number) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const label = kind === 'equipment' ? 'équipement' : 'document';

  return (
    <div className="rounded-lg border border-border bg-[color:var(--bg-card)] p-3 space-y-2.5" data-testid={`piece-selecteur-${kind}`}>
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={kind === 'equipment' ? 'Rechercher un équipement du bien' : 'Rechercher un document du bien'}
        aria-label={kind === 'equipment' ? 'Rechercher un équipement du bien' : 'Rechercher un document du bien'}
        autoFocus
      />
      {items === null ? (
        <div role="status" className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> Recherche…
        </div>
      ) : items.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground">
          {q ? `Aucun ${label} trouvé.` : `Aucun autre ${label} du bien à associer.`}
        </p>
      ) : (
        <ul className="max-h-64 overflow-y-auto space-y-0.5" aria-label={`${label === 'équipement' ? 'Équipements' : 'Documents'} du bien`}>
          {items.map((c) => {
            const id = `piece-${roomId}-${kind}-${c.id}`;
            const meta = kind === 'document' ? formatDate(c.meta) : c.meta;
            return (
              <li key={c.id}>
                <label htmlFor={id} className="flex items-start gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-[color:var(--accent-soft)] cursor-pointer">
                  <Checkbox id={id} checked={selected.has(c.id)} onCheckedChange={() => toggle(c.id)} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground">{c.title}</span>
                    {(meta || c.currentRoom) && (
                      <span className="block text-[10px] text-muted-foreground">
                        {[meta, c.currentRoom ? `Actuellement : ${c.currentRoom.name || 'autre pièce'}` : null].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Annuler</Button>
        <Button size="sm" onClick={() => onSubmit([...selected])} disabled={busy || selected.size === 0}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Link2 className="w-3.5 h-3.5" aria-hidden />}
          Associer{selected.size > 0 ? ` (${selected.size})` : ''}
        </Button>
      </div>
    </div>
  );
}
