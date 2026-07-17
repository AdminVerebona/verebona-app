"use client"

import { useState, useCallback, useEffect } from 'react';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Settings, Pencil, Trash2, MapPin, Home, Loader2, X, Save, Plus,
  Building2, FileText, CalendarDays, ChevronRight, Clock, CheckCircle2, AlertCircle, Circle,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { SupplierDrawer } from '@/components/suppliers/SupplierDrawer';

export interface EquipmentDrawerItem {
  id: number;
  assetId: number;
  name: string;
  type?: string | null;
  status: string;
  substructureId?: number | null;
}

export interface EquipmentDrawerSubstructure {
  id: number;
  name: string;
}

export interface EquipmentDrawerAsset {
  id: number;
  name: string;
}

interface EquipmentDocument {
  id: number;
  publicId: string;
  title: string;
  documentType: string | null;
  documentTypeLabel: string | null;
  documentDate: string | null;
  mimeType: string | null;
  assetId: number | null;
  assetName: string | null;
  webLinkUrl: string | null;
  createdAt: string;
}

interface EquipmentAgendaItem {
  id: number;
  publicId: string;
  title: string;
  description: string | null;
  startDate: string | null;
  startTime: string | null;
  endDate: string | null;
  manualStatus: string | null;
  effectiveStatus: string;
  originType: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  assetId: number;
  /** null = create mode */
  equipment: EquipmentDrawerItem | null;
  substructures: EquipmentDrawerSubstructure[];
  onRefresh: () => void;
  /** Force edit mode on open (e.g. from À traiter) */
  initialEditing?: boolean;
  /** List of available assets for the "Bien associé" selector (À traiter context) */
  availableAssets?: EquipmentDrawerAsset[];
  /** Name of the current asset, displayed as read-only "Bien associé" when adding from an asset page */
  assetName?: string;
}

const STATUS_LABELS: Record<string, string> = {
  EN_SERVICE: 'En service',
  EN_PANNE: 'En panne',
  EN_REPARATION: 'En réparation',
  INACTIF: 'Inactif',
};

const STATUS_COLORS: Record<string, string> = {
  EN_SERVICE: 'bg-green-500/10 text-green-600 border-green-500/30',
  EN_PANNE: 'bg-red-500/10 text-red-500 border-red-500/30',
  EN_REPARATION: 'bg-orange-500/10 text-orange-500 border-orange-500/30',
  INACTIF: 'bg-muted text-muted-foreground border-border',
};

const DOC_TYPE_COLORS: Record<string, string> = {
  FACTURE: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  GARANTIE: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  MANUEL: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  CONTRAT: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  CERTIFICAT: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
  AUTRE: 'bg-muted/60 text-muted-foreground border-border',
};

function AgendaStatusIcon({ status }: { status: string }) {
  if (status === 'realise') return <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />;
  if (status === 'annule') return <X className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />;
  if (status === 'en_retard') return <AlertCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />;
  if (status === 'aujourd_hui') return <Clock className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />;
  return <Circle className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

export function EquipmentDrawer({ open, onOpenChange, assetId, equipment: eq, substructures: initialSubstructures, onRefresh, initialEditing = false, availableAssets, assetName }: Props) {
  const isCreateMode = eq === null;
  const hasAssetSelector = !!availableAssets;

  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('EN_SERVICE');
  const [substructureId, setSubstructureId] = useState<string>('none');
  const [selectedAssetId, setSelectedAssetId] = useState<string>(assetId && assetId > 0 ? String(assetId) : 'none');
  const [dynamicSubstructures, setDynamicSubstructures] = useState<EquipmentDrawerSubstructure[]>([]);
  const [loadingSubstructures, setLoadingSubstructures] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);

  // Suppliers
  const [equipmentSuppliers, setEquipmentSuppliers] = useState<{ supplierId: number; name: string; email: string | null; isPrimary: boolean }[]>([]);
  const [loadingSuppliers, setLoadingSuppliers] = useState(false);
  const [supplierDrawerOpen, setSupplierDrawerOpen] = useState(false);
  const [supplierDrawerId, setSupplierDrawerId] = useState<number | null>(null);

  // Documents
  const [equipmentDocuments, setEquipmentDocuments] = useState<EquipmentDocument[]>([]);
  const [loadingDocuments, setLoadingDocuments] = useState(false);

  // Agenda
  const [equipmentAgenda, setEquipmentAgenda] = useState<EquipmentAgendaItem[]>([]);
  const [loadingAgenda, setLoadingAgenda] = useState(false);


  // Load substructures when selected asset changes
  const loadSubstructures = useCallback(async (aid: number) => {
    if (!aid || aid === 0) { setDynamicSubstructures([]); return; }
    setLoadingSubstructures(true);
    try {
      const data = await apiClient.get<{ substructures?: EquipmentDrawerSubstructure[] }>(`/api/assets/${aid}/substructures`);
      setDynamicSubstructures(data.substructures ?? (Array.isArray(data) ? data as any : []));
    } catch {
      setDynamicSubstructures([]);
    } finally {
      setLoadingSubstructures(false);
    }
  }, []);

  // Sync when drawer opens/closes
  useEffect(() => {
    if (open) {
      setName(eq?.name ?? '');
      setType(eq?.type ?? '');
      setStatus(eq?.status ?? 'EN_SERVICE');
      const aid = (eq?.assetId && eq.assetId > 0) ? eq.assetId : (assetId && assetId > 0 ? assetId : 0);
      setSelectedAssetId(aid > 0 ? String(aid) : 'none');
      setSubstructureId(eq?.substructureId ? String(eq.substructureId) : 'none');
      setIsEditing(isCreateMode || initialEditing);
      const subs = initialSubstructures;
      if (subs.length > 0) {
        setDynamicSubstructures(subs);
      } else if (aid > 0) {
        loadSubstructures(aid);
      } else {
        setDynamicSubstructures([]);
      }
    } else {
      setIsEditing(false);
    }

    // Load equipment linked data if equipment exists
    if (open && eq?.id) {
      // Suppliers
      setLoadingSuppliers(true);
      apiClient.get<{ suppliers: { supplierId: number; name: string; email: string | null; isPrimary: boolean }[] }>(
        `/api/equipments/${eq.id}/suppliers`
      ).then(d => {
        setEquipmentSuppliers(d.suppliers ?? []);
      }).catch(() => {
        setEquipmentSuppliers([]);
      }).finally(() => {
        setLoadingSuppliers(false);
      });

      // Documents
      setLoadingDocuments(true);
      apiClient.get<{ documents: EquipmentDocument[] }>(
        `/api/equipments/${eq.id}/documents`
      ).then(d => {
        setEquipmentDocuments(d.documents ?? []);
      }).catch(() => {
        setEquipmentDocuments([]);
      }).finally(() => {
        setLoadingDocuments(false);
      });

      // Agenda
      setLoadingAgenda(true);
      apiClient.get<{ items: EquipmentAgendaItem[] }>(
        `/api/equipments/${eq.id}/agenda`
      ).then(d => {
        setEquipmentAgenda(d.items ?? []);
      }).catch(() => {
        setEquipmentAgenda([]);
      }).finally(() => {
        setLoadingAgenda(false);
      });
    } else if (!open) {
      setEquipmentSuppliers([]);
      setEquipmentDocuments([]);
      setEquipmentAgenda([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, eq, assetId, isCreateMode, initialEditing]);

  // When asset selection changes, reset substructure and reload pièces
  const handleAssetChange = useCallback((val: string) => {
    setSelectedAssetId(val);
    setSubstructureId('none');
    const aid = val === 'none' ? 0 : parseInt(val);
    loadSubstructures(aid);
  }, [loadSubstructures]);

  const enterEditMode = useCallback(() => {
    setName(eq?.name ?? '');
    setType(eq?.type ?? '');
    setStatus(eq?.status ?? 'EN_SERVICE');
    setSubstructureId(eq?.substructureId ? String(eq.substructureId) : 'none');
    setIsEditing(true);
  }, [eq]);

  const handleSave = useCallback(async () => {
    if (!name.trim()) { toast.error('Le nom est obligatoire'); return; }
    setIsSaving(true);
    try {
      const effectiveAssetId = selectedAssetId !== 'none' ? parseInt(selectedAssetId) : 0;
      const payload: any = {
        name: name.trim(),
        type: type || null,
        status,
        substructureId: substructureId === 'none' ? null : parseInt(substructureId),
      };
      if (isCreateMode) {
        if (!effectiveAssetId) { toast.error('Veuillez sélectionner un bien'); setIsSaving(false); return; }
        await apiClient.post(`/api/assets/${effectiveAssetId}/equipments`, payload);
        toast.success('Équipement ajouté');
      } else {
        const originalAssetId = eq!.assetId && eq!.assetId > 0 ? eq!.assetId : assetId;
        if (effectiveAssetId && effectiveAssetId !== originalAssetId) payload.newAssetId = effectiveAssetId;
        await apiClient.put(`/api/assets/${originalAssetId}/equipments/${eq!.id}`, payload);
        toast.success('Équipement mis à jour');
        setIsEditing(false);
      }
      onRefresh();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message ?? 'Erreur lors de la sauvegarde');
    } finally {
      setIsSaving(false);
    }
  }, [eq, assetId, selectedAssetId, name, type, status, substructureId, isCreateMode, onRefresh, onOpenChange]);

  const handleArchive = useCallback(async () => {
    if (!eq) return;
    setIsArchiving(true);
    try {
      await apiClient.delete(`/api/assets/${assetId}/equipments/${eq.id}`);
      toast.success('Équipement supprimé');
      onOpenChange(false);
      onRefresh();
    } catch (err: any) {
      toast.error(err?.message ?? "Erreur lors de l'archivage");
    } finally {
      setIsArchiving(false);
      setShowArchiveConfirm(false);
    }
  }, [eq, assetId, onOpenChange, onRefresh]);

  const reloadLinkedData = useCallback(() => {
    if (!eq?.id) return;
    setLoadingSuppliers(true);
    apiClient.get<{ suppliers: { supplierId: number; name: string; email: string | null; isPrimary: boolean }[] }>(
      `/api/equipments/${eq.id}/suppliers`
    ).then(d => setEquipmentSuppliers(d.suppliers ?? [])).catch(() => setEquipmentSuppliers([])).finally(() => setLoadingSuppliers(false));

    setLoadingDocuments(true);
    apiClient.get<{ documents: EquipmentDocument[] }>(`/api/equipments/${eq.id}/documents`)
      .then(d => setEquipmentDocuments(d.documents ?? [])).catch(() => setEquipmentDocuments([])).finally(() => setLoadingDocuments(false));

    setLoadingAgenda(true);
    apiClient.get<{ items: EquipmentAgendaItem[] }>(`/api/equipments/${eq.id}/agenda`)
      .then(d => setEquipmentAgenda(d.items ?? [])).catch(() => setEquipmentAgenda([])).finally(() => setLoadingAgenda(false));
  }, [eq]);


  const substructures = dynamicSubstructures;
  const statusColor = eq ? (STATUS_COLORS[eq.status] ?? STATUS_COLORS.INACTIF) : '';
  const room = eq ? substructures.find(s => s.id === eq.substructureId) : null;

  const formSection = (
    <div className="px-5 py-4 space-y-4">
      {/* Bien associé — toujours affiché en premier */}
      <div className="space-y-1.5">
        <Label className="flex items-center gap-1.5"><Home className="w-3.5 h-3.5" />Bien associé</Label>
        {hasAssetSelector ? (
          <Select value={selectedAssetId} onValueChange={handleAssetChange}>
            <SelectTrigger><SelectValue placeholder="Choisir un bien" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Sans bien</SelectItem>
              {(availableAssets ?? []).map(a => (
                <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-input bg-muted/40 text-sm">
            <Home className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
            <span className="truncate text-foreground">{assetName ?? '—'}</span>
          </div>
        )}
      </div>
      <div className="space-y-1.5">
        <Label>Nom</Label>
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="Nom de l'équipement" autoFocus />
      </div>
      <div className="space-y-1.5">
        <Label>Type</Label>
        <Input value={type} onChange={e => setType(e.target.value)} placeholder="Ex: Chaudière, Pompe à chaleur…" />
      </div>
      <div className="space-y-1.5">
        <Label>Statut</Label>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(STATUS_LABELS).map(([v, l]) => (
              <SelectItem key={v} value={v}>{l}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label className="flex items-center gap-1.5">
          <MapPin className="w-3.5 h-3.5" />Pièces associées
          {loadingSubstructures && <Loader2 className="w-3 h-3 animate-spin ml-1" />}
        </Label>
        {!loadingSubstructures && substructures.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune pièce disponible.</p>
        ) : (
          <Select value={substructureId} onValueChange={setSubstructureId} disabled={loadingSubstructures}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Sans pièce</SelectItem>
              {substructures.map(s => (
                <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );

  const viewSection = eq ? (
    <div className="px-5 py-4 space-y-0">
      {/* ── Informations ── */}
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Informations</p>
      <div className="space-y-2 text-sm">
        {(assetName || (availableAssets && eq.assetId && eq.assetId > 0)) && (
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-muted-foreground"><Home className="w-3.5 h-3.5" />Bien</span>
            <span className="font-medium">
              {assetName ?? availableAssets?.find(a => a.id === eq.assetId)?.name ?? `Bien #${eq.assetId}`}
            </span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Statut</span>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${statusColor}`}>
            {STATUS_LABELS[eq.status] ?? eq.status}
          </span>
        </div>
        {eq.type && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Type</span>
            <span className="font-medium">{eq.type}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-muted-foreground"><MapPin className="w-3.5 h-3.5" />Pièce</span>
          <span className="font-medium">{room?.name ?? 'Sans pièce'}</span>
        </div>
      </div>

      {/* ── Fournisseurs ── */}
      <div className="mt-5 pt-5 border-t border-border/50">
        <div className="flex items-center gap-2 mb-3">
          <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Fournisseurs</p>
          {loadingSuppliers && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
        </div>
        {!loadingSuppliers && equipmentSuppliers.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucun fournisseur associé.</p>
        ) : (
          <div className="space-y-1.5">
            {equipmentSuppliers.map(s => (
              <button
                key={s.supplierId}
                className="w-full flex items-center gap-2 text-sm p-2.5 rounded-lg bg-[rgba(255,255,255,0.03)] border border-border/60 hover:border-blue-500/40 hover:bg-blue-500/5 transition-colors text-left group"
                onClick={() => { setSupplierDrawerId(s.supplierId); setSupplierDrawerOpen(true); }}
              >
                <div className="w-6 h-6 rounded-md bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                  <Building2 className="w-3.5 h-3.5 text-blue-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-blue-400 truncate text-xs">{s.name}</p>
                  {s.email && <p className="text-[10px] text-muted-foreground truncate">{s.email}</p>}
                </div>
                {s.isPrimary && (
                  <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 flex-shrink-0">
                    Principal
                  </span>
                )}
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-blue-400 transition-colors flex-shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Documents ── */}
      <div className="mt-5 pt-5 border-t border-border/50">
        <div className="flex items-center gap-2 mb-3">
          <FileText className="w-3.5 h-3.5 text-muted-foreground" />
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Documents associés</p>
          {loadingDocuments && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
          {!loadingDocuments && equipmentDocuments.length > 0 && (
            <span className="ml-auto text-[10px] font-semibold text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded-full">
              {equipmentDocuments.length}
            </span>
          )}
        </div>
        {!loadingDocuments && equipmentDocuments.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucun document associé.</p>
        ) : (
          <div className="space-y-1.5">
            {equipmentDocuments.map(doc => {
              const typeCode = doc.documentType ?? 'AUTRE';
              const typeColor = DOC_TYPE_COLORS[typeCode] ?? DOC_TYPE_COLORS.AUTRE;
              return (
                <div
                  key={doc.id}
                  className="flex items-start gap-2.5 p-2.5 rounded-lg bg-[rgba(255,255,255,0.03)] border border-border/60 text-sm"
                >
                  <div className="w-6 h-6 rounded-md bg-muted/40 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground truncate text-xs leading-tight">{doc.title}</p>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      {doc.documentTypeLabel && (
                        <span className={`text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border ${typeColor}`}>
                          {doc.documentTypeLabel}
                        </span>
                      )}
                      {doc.documentDate && (
                        <span className="text-[10px] text-muted-foreground">
                          {formatDate(doc.documentDate)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Agenda ── */}
      <div className="mt-5 pt-5 border-t border-border/50 pb-2">
        <div className="flex items-center gap-2 mb-3">
          <CalendarDays className="w-3.5 h-3.5 text-muted-foreground" />
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Agenda associé</p>
          {loadingAgenda && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
          {!loadingAgenda && equipmentAgenda.length > 0 && (
            <span className="ml-auto text-[10px] font-semibold text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded-full">
              {equipmentAgenda.length}
            </span>
          )}
        </div>
        {!loadingAgenda && equipmentAgenda.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucun élément agenda associé.</p>
        ) : (
          <div className="space-y-1.5">
            {equipmentAgenda.map(item => (
              <div
                key={item.id}
                className="flex items-start gap-2.5 p-2.5 rounded-lg bg-[rgba(255,255,255,0.03)] border border-border/60 text-sm"
              >
                <AgendaStatusIcon status={item.effectiveStatus} />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground truncate text-xs leading-tight">{item.title}</p>
                  {item.startDate && (
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {formatDate(item.startDate)}
                      {item.startTime && ` · ${item.startTime.slice(0, 5)}`}
                    </p>
                  )}
                  {!item.startDate && (
                    <p className="text-[10px] text-muted-foreground mt-0.5">Sans date</p>
                  )}
                </div>
                {item.manualStatus === 'realise' && (
                  <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-green-500/10 text-green-500 border border-green-500/20 flex-shrink-0">
                    Réalisé
                  </span>
                )}
                {item.effectiveStatus === 'en_retard' && item.manualStatus !== 'realise' && (
                  <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20 flex-shrink-0">
                    En retard
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  ) : null;

  return (
    <>
      <Sheet open={open} onOpenChange={(v) => { if (!v) setIsEditing(false); onOpenChange(v); }}>
        <SheetContent className="w-full sm:max-w-md flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3">
            <div className="flex items-center gap-2">
              <Settings className="w-5 h-5 text-muted-foreground flex-shrink-0" />
              <SheetTitle>
                {isCreateMode ? 'Ajouter un équipement' : isEditing ? "Modifier l'équipement" : eq!.name}
              </SheetTitle>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto">
            {isEditing || isCreateMode ? formSection : eq ? viewSection : null}
          </div>

          {/* Footer — action bar (consultation) ou boutons édition */}
          {isEditing || isCreateMode ? (
            <div className="px-5 py-4 border-t">
              <div className="flex items-stretch rounded-xl border border-border bg-muted/30 overflow-hidden">
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={() => { if (isCreateMode) onOpenChange(false); else setIsEditing(false); }}
                  disabled={isSaving}
                >
                  <X className="w-4 h-4" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider">Annuler</span>
                </button>
                <div className="w-px bg-border" />
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-primary/10 transition-colors text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={handleSave}
                  disabled={isSaving || !name.trim()}
                >
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : isCreateMode ? <Plus className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                  <span className="text-[10px] font-semibold uppercase tracking-wider">{isSaving ? 'Sauvegarde…' : isCreateMode ? 'Ajouter' : 'Enregistrer'}</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="px-5 py-4 border-t">
              <div className="flex items-stretch rounded-xl border border-border bg-muted/30 overflow-hidden">
                <button
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground"
                  onClick={() => onOpenChange(false)}
                >
                  <X className="w-4 h-4" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider">Fermer</span>
                </button>
                <div className="w-px bg-border" />
                <button
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground"
                  onClick={enterEditMode}
                >
                  <Pencil className="w-4 h-4" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider">Modifier</span>
                </button>
                <div className="w-px bg-border" />
                <button
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-destructive/10 transition-colors text-destructive disabled:opacity-40"
                  onClick={() => setShowArchiveConfirm(true)}
                  disabled={isArchiving}
                >
                  <Trash2 className="w-4 h-4" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider">Supprimer</span>
                </button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={showArchiveConfirm} onOpenChange={setShowArchiveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer cet équipement ?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{eq?.name}&quot; sera définitivement supprimé de la liste des équipements.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={handleArchive} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SupplierDrawer
        supplierId={supplierDrawerId}
        open={supplierDrawerOpen}
        onOpenChange={setSupplierDrawerOpen}
        onUpdated={() => {}}
      />
    </>
  );
}
