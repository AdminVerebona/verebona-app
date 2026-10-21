"use client"

import { useState, useCallback, useEffect } from 'react';
import { EFFECTIVE_STATUS_LABELS } from '@/lib/agenda/effective-status';
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
  Building2, FileText, CalendarDays, Clock, CheckCircle2, AlertCircle, Circle,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { SupplierDrawer } from '@/components/suppliers/SupplierDrawer';
import { EntityCard } from '@/components/drawers/EntityCard';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { EQUIPMENT_FICHE_FIELDS, equipmentFicheChanges } from '@/lib/asset-detail-rules';
import { normalizeEquipmentEnergyUsage } from '@/lib/cil/energy-equipment';
// Lot 75A : champ « Usage énergétique » affiché selon sa pertinence (règle
// centralisée `isEnergyUsageFieldRelevant`), même composant desktop et mobile.
import {
  ENERGY_USAGE_UNSET, energyUsageToForm, energyUsageFormPresentation, energyUsagePayload, showEnergyUsageInView,
  EquipmentEnergyUsageField, EquipmentEnergyUsageView, type EnergyUsageRelevanceBase,
} from '@/components/assets/equipment-energy-usage-field';
import {
  ROOM_ASSOCIATIONS_CHANGED, notifyRoomAssociationsChanged, type RoomAssociationsChangedDetail,
} from '@/lib/rooms/room-associations';

/** Fiche saisie (lot 20, D-D) : valeurs du formulaire, en texte. */
type FicheForm = Record<string, string>;
const FICHE_VIDE: FicheForm = Object.fromEntries(EQUIPMENT_FICHE_FIELDS.map((f) => [f.key, '']));

/** Valeur lue → affichage « 12,5 kW », « 4,2 », « R32 ». */
export function ficheValueLabel(key: string, v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const f = EQUIPMENT_FICHE_FIELDS.find((x) => x.key === key);
  if (f?.type !== 'number') return String(v);
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `${n.toLocaleString('fr-FR')}${f.unit ? ` ${f.unit}` : ''}`;
}

export interface EquipmentDrawerItem {
  id: number;
  assetId: number;
  name: string;
  type?: string | null;
  /**
   * Lot 70B : usage énergétique déclaré (`null` = non renseigné). Absent
   * (`undefined`) : non transmis par l'écran appelant — relu par le tiroir.
   */
  energyUsage?: string | null;
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
  /**
   * Lot 75B : pièce présélectionnée en CRÉATION (création depuis le tiroir
   * Pièce : bien et pièce présélectionnés). Ignorée en modification.
   */
  initialSubstructureId?: number | null;
}

const STATUS_LABELS: Record<string, string> = {
  EN_SERVICE: 'En service',
  EN_PANNE: 'En panne',
  EN_REPARATION: 'En réparation',
  INACTIF: 'Inactif',
};

const STATUS_COLORS: Record<string, string> = {
  EN_SERVICE: 'bg-[color:var(--bg-success)] text-[color:var(--text-success)] border-[color:var(--border-success)]',
  EN_PANNE: 'bg-[color:var(--danger-soft)] text-[color:var(--danger)] border-[color:var(--danger-edge)]',
  EN_REPARATION: 'bg-[color:var(--attention-soft)] text-[color:var(--attention-on-soft)] border-[color:var(--attention-edge)]',
  INACTIF: 'bg-muted text-muted-foreground border-border',
};

// Type de document : étiquette NEUTRE (brume + pétrole), le type est écrit.
// Le cuivre et le rouge restent réservés à l'attention et aux retards.
const DOC_TYPE_NEUTRE = 'bg-[color:var(--accent-soft)] text-[color:var(--accent)] border-[color:var(--border-info)]';
const DOC_TYPE_COLORS: Record<string, string> = {
  FACTURE: DOC_TYPE_NEUTRE,
  GARANTIE: DOC_TYPE_NEUTRE,
  MANUEL: DOC_TYPE_NEUTRE,
  CONTRAT: DOC_TYPE_NEUTRE,
  CERTIFICAT: DOC_TYPE_NEUTRE,
  AUTRE: 'bg-[color:var(--bg-subtle)] text-[color:var(--text-secondary)] border-[color:var(--border)]',
};

function AgendaStatusIcon({ status }: { status: string }) {
  if (status === 'realise') return <CheckCircle2 className="w-3.5 h-3.5 text-[color:var(--text-success)] flex-shrink-0" />;
  if (status === 'annule') return <X className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />;
  if (status === 'en_retard') return <AlertCircle className="w-3.5 h-3.5 text-[color:var(--danger)] flex-shrink-0" />;
  // Lot 53 (D17) : fait passé sans preuve de réalisation — à confirmer, jamais coché « réalisé ».
  if (status === 'a_confirmer') return <Clock className="w-3.5 h-3.5 text-[color:var(--attention-on-soft)] flex-shrink-0" />;
  if (status === 'aujourd_hui') return <Clock className="w-3.5 h-3.5 text-[color:var(--attention-on-soft)] flex-shrink-0" />;
  return <Circle className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />;
}

/** Pastille d'état d'une échéance associée (texte, non interactive). */
function AgendaStatusBadge({ item }: { item: Pick<EquipmentAgendaItem, 'manualStatus' | 'effectiveStatus'> }) {
  if (item.manualStatus === 'realise') {
    return (
      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[color:var(--bg-success)] text-[color:var(--text-success)] border border-[color:var(--border-success)] flex-shrink-0">
        Réalisé
      </span>
    );
  }
  if (item.effectiveStatus === 'en_retard') {
    return (
      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[color:var(--danger-soft)] text-[color:var(--danger)] border border-[color:var(--danger-edge)] flex-shrink-0">
        {EFFECTIVE_STATUS_LABELS.en_retard}
      </span>
    );
  }
  if (item.effectiveStatus === 'a_confirmer') {
    return (
      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[color:var(--attention-soft)] text-[color:var(--attention-on-soft)] border border-[color:var(--attention-edge)] flex-shrink-0">
        {EFFECTIVE_STATUS_LABELS.a_confirmer}
      </span>
    );
  }
  return null;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

export function EquipmentDrawer({ open, onOpenChange, assetId, equipment: eq, substructures: initialSubstructures, onRefresh, initialEditing = false, availableAssets, assetName, initialSubstructureId }: Props) {
  const isCreateMode = eq === null;
  const hasAssetSelector = !!availableAssets;

  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  // Usage énergétique (lot 70B) : valeur du formulaire, valeur connue de
  // l'équipement (`undefined` tant qu'elle n'est pas lue : rien n'est envoyé).
  const [energyUsage, setEnergyUsage] = useState<string>(ENERGY_USAGE_UNSET);
  const [knownEnergyUsage, setKnownEnergyUsage] = useState<string | null | undefined>(undefined);
  // Lot 75A : catégorie et caractéristiques CIL relues (pertinence du champ) ;
  // section « Options avancées » des équipements non reconnus énergétiques.
  const [energyRelevanceBase, setEnergyRelevanceBase] = useState<EnergyUsageRelevanceBase | null>(null);
  const [energyAdvancedOpen, setEnergyAdvancedOpen] = useState(false);
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

  // Fiche canonique (puissance, COP, fluide, compteur horaire)
  // null = fiche non chargée (GET en cours ou en échec) : rien n'est envoyé.
  const [fiche, setFiche] = useState<Record<string, unknown> | null>(null);
  const [ficheForm, setFicheForm] = useState<FicheForm>(FICHE_VIDE);
  const ficheToForm = (f: Record<string, unknown>): FicheForm =>
    Object.fromEntries(EQUIPMENT_FICHE_FIELDS.map((x) => [x.key, f[x.key] === null || f[x.key] === undefined ? '' : String(f[x.key])]));

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
      const known = isCreateMode ? null : eq?.energyUsage === undefined ? undefined : normalizeEquipmentEnergyUsage(eq.energyUsage);
      setKnownEnergyUsage(known);
      setEnergyUsage(energyUsageToForm(known));
      setEnergyRelevanceBase(null);
      setEnergyAdvancedOpen(false);
      const aid = (eq?.assetId && eq.assetId > 0) ? eq.assetId : (assetId && assetId > 0 ? assetId : 0);
      setSelectedAssetId(aid > 0 ? String(aid) : 'none');
      setSubstructureId(eq?.substructureId ? String(eq.substructureId) : (isCreateMode && initialSubstructureId ? String(initialSubstructureId) : 'none'));
      setRoomOverride(undefined);
      setIsEditing(isCreateMode || initialEditing);
      setFiche(null);
      setFicheForm(FICHE_VIDE);
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
      // Fiche canonique
      apiClient.get<{
        fiche?: Record<string, unknown>;
        equipment?: {
          energyUsage?: string | null; category?: string | null;
          cilSpecs?: { energyType?: string | null; evacuationMode?: string | null; heatNetworkDeliveryStation?: string | null } | null;
        };
      }>(`/api/equipments/${eq.id}`)
        .then(d => {
          if (d.equipment) {
            setEnergyRelevanceBase({
              category: d.equipment.category ?? null,
              energyType: d.equipment.cilSpecs?.energyType ?? null,
              evacuationMode: d.equipment.cilSpecs?.evacuationMode ?? null,
              heatNetworkDeliveryStation: d.equipment.cilSpecs?.heatNetworkDeliveryStation ?? null,
            });
          }
          // Usage énergétique relu (l'écran appelant ne le transmet pas toujours).
          if (d.equipment && d.equipment.energyUsage !== undefined) {
            const v = normalizeEquipmentEnergyUsage(d.equipment.energyUsage);
            setKnownEnergyUsage(v);
            setEnergyUsage((cur) => (cur === ENERGY_USAGE_UNSET ? energyUsageToForm(v) : cur));
          }
          if (!d.fiche) return; // réponse sans fiche : non chargée
          setFiche(d.fiche);
          setFicheForm(ficheToForm(d.fiche));
        })
        .catch(() => { setFiche(null); });

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

  // Lot 75B : pièce de l'équipement modifiée ailleurs (tiroir Pièce empilé
  // au-dessus, autre écran) : la pièce affichée est relue, sans attendre la
  // réouverture du tiroir. `undefined` = celle reçue de l'écran appelant.
  const [roomOverride, setRoomOverride] = useState<number | null | undefined>(undefined);
  const currentRoomId = roomOverride !== undefined ? roomOverride : (eq?.substructureId ?? null);
  useEffect(() => {
    if (!open || eq?.id == null) return;
    const id = eq.id;
    const relire = (e: Event) => {
      const d = (e as CustomEvent<RoomAssociationsChangedDetail>).detail;
      if (!d?.equipmentIds?.includes(id)) return;
      apiClient.get<{ equipment?: { substructureId?: number | null } }>(`/api/equipments/${id}`)
        .then((r) => {
          if (r.equipment && r.equipment.substructureId !== undefined) setRoomOverride(r.equipment.substructureId ?? null);
        })
        .catch(() => {});
    };
    window.addEventListener(ROOM_ASSOCIATIONS_CHANGED, relire);
    return () => window.removeEventListener(ROOM_ASSOCIATIONS_CHANGED, relire);
  }, [open, eq?.id]);

  // Lot 75H : une échéance ouverte depuis la section « Agenda associé »
  // s'empile au-dessus ; modifiée ou supprimée, la liste se relit.
  const equipmentId = eq?.id ?? null;
  useEffect(() => {
    if (!open || equipmentId == null) return;
    const reload = () => {
      apiClient.get<{ items: EquipmentAgendaItem[] }>(`/api/equipments/${equipmentId}/agenda`)
        .then((d) => setEquipmentAgenda(d.items ?? []))
        .catch(() => {});
    };
    window.addEventListener('agenda-mutated', reload);
    return () => window.removeEventListener('agenda-mutated', reload);
  }, [open, equipmentId]);

  // When asset selection changes, reset substructure and reload pièces
  const handleAssetChange = useCallback((val: string) => {
    setSelectedAssetId(val);
    setSubstructureId('none');
    const aid = val === 'none' ? 0 : parseInt(val);
    loadSubstructures(aid);
  }, [loadSubstructures]);

  // Même garde que les pièces — l'édition est refusée avant la saisie,
  // pas après.
  const { garder } = useWriteGuard();
  const enterEditMode = useCallback(() => {
    garder(() => {
      setName(eq?.name ?? '');
      setType(eq?.type ?? '');
      setEnergyUsage(energyUsageToForm(knownEnergyUsage));
      setEnergyAdvancedOpen(false);
      setStatus(eq?.status ?? 'EN_SERVICE');
      setSubstructureId(currentRoomId ? String(currentRoomId) : 'none');
      setFicheForm(fiche ? ficheToForm(fiche) : FICHE_VIDE);
      setIsEditing(true);
    });
  }, [garder, eq, fiche, knownEnergyUsage, currentRoomId]);

  // Lot 75A : emplacement (formulaire standard / options avancées) et
  // visibilité du champ « Usage énergétique », recalculés à chaque saisie du type.
  const energyPresentation = energyUsageFormPresentation({
    persistedEnergyUsage: isCreateMode ? null : knownEnergyUsage,
    formValue: energyUsage,
    type,
    base: isCreateMode ? null : energyRelevanceBase,
    advancedOpen: energyAdvancedOpen,
  });

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
      // Usage énergétique : seulement si le champ est VISIBLE (lot 75A : un
      // champ masqué ne modifie rien) et, en modification, une fois la valeur
      // de l'équipement connue (jamais d'effacement à l'aveugle).
      const energyUsageValue = energyUsagePayload({ isCreateMode, knownEnergyUsage, visible: energyPresentation.visible, formValue: energyUsage });
      if (energyUsageValue !== undefined) payload.energyUsage = energyUsageValue;
      // Fiche canonique : seules les clés modifiées par rapport à la fiche
      // CHARGÉE ; omise tant qu'elle ne l'est pas (origine USER côté serveur).
      const ficheModifiee = equipmentFicheChanges(fiche, ficheForm);
      if (!isCreateMode && ficheModifiee) payload.fiche = ficheModifiee;
      if (isCreateMode) {
        if (!effectiveAssetId) { toast.error('Veuillez sélectionner un bien'); setIsSaving(false); return; }
        const cree = await apiClient.post<{ id?: number; equipment?: { id?: number } }>(`/api/assets/${effectiveAssetId}/equipments`, payload);
        toast.success('Équipement ajouté');
        // Lot 75B : créé dans une pièce → tiroir Pièce et filtres relus.
        if (payload.substructureId) {
          const nouvelId = Number(cree?.id ?? cree?.equipment?.id);
          notifyRoomAssociationsChanged({ roomIds: [payload.substructureId], equipmentIds: Number.isSafeInteger(nouvelId) ? [nouvelId] : [] });
        }
      } else {
        const originalAssetId = eq!.assetId && eq!.assetId > 0 ? eq!.assetId : assetId;
        if (effectiveAssetId && effectiveAssetId !== originalAssetId) payload.newAssetId = effectiveAssetId;
        await apiClient.put(`/api/assets/${originalAssetId}/equipments/${eq!.id}`, payload);
        toast.success('Équipement mis à jour');
        setIsEditing(false);
        // Lot 75B : pièce changée depuis l'équipement → tiroir Pièce, « Mes
        // documents » et « Mon agenda » suivent (documents et échéances de
        // l'équipement résolus par la pièce actuelle).
        if ((payload.substructureId ?? null) !== currentRoomId) {
          setRoomOverride(payload.substructureId ?? null);
          notifyRoomAssociationsChanged({
            roomIds: [currentRoomId, payload.substructureId].filter((x): x is number => typeof x === 'number'),
            equipmentIds: [eq!.id],
          });
        }
      }
      onRefresh();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message ?? 'Erreur lors de la sauvegarde');
    } finally {
      setIsSaving(false);
    }
  }, [eq, assetId, selectedAssetId, name, type, energyUsage, knownEnergyUsage, energyPresentation.visible, status, substructureId, fiche, ficheForm, isCreateMode, onRefresh, onOpenChange, currentRoomId]);

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
  const room = eq ? substructures.find(s => s.id === currentRoomId) : null;
  const energyUsageEditable = isCreateMode || knownEnergyUsage !== undefined;

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
      {/* Usage énergétique (lot 70B) : choix fermé, lu en priorité par le CIL (B6).
          Lot 75A : présenté directement s'il est pertinent, sinon en options avancées. */}
      <EquipmentEnergyUsageField
        presentation={energyPresentation}
        value={energyUsage}
        onChange={setEnergyUsage}
        editable={energyUsageEditable}
        type={type}
        advancedOpen={energyAdvancedOpen}
        onAdvancedOpenChange={setEnergyAdvancedOpen}
      />
      {/* Fiche (équipement existant : la création n'écrit pas la fiche canonique). */}
      {/* Saisie proposée seulement une fois la fiche chargée. */}
      {!isCreateMode && fiche && EQUIPMENT_FICHE_FIELDS.map((f) => (
        <div key={f.key} className="space-y-1.5">
          <Label htmlFor={`equipment-${f.key}`}>{f.label}</Label>
          <Input
            id={`equipment-${f.key}`}
            type={f.type === 'number' ? 'number' : 'text'}
            inputMode={f.type === 'number' ? 'decimal' : undefined}
            min={f.type === 'number' ? 0 : undefined}
            value={ficheForm[f.key] ?? ''}
            onChange={e => setFicheForm(prev => ({ ...prev, [f.key]: e.target.value }))}
          />
        </div>
      ))}
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
      <p className="vb-app-subsection mb-3">Informations</p>
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
        {/* Lot 75A : seulement si pertinent (aspirateur, téléviseur… : masqué). */}
        {showEnergyUsageInView({ knownEnergyUsage, type: eq.type, base: energyRelevanceBase }) && (
          <EquipmentEnergyUsageView value={knownEnergyUsage ?? null} />
        )}
        {EQUIPMENT_FICHE_FIELDS.map((f) => {
          const v = ficheValueLabel(f.key, fiche?.[f.key]);
          return v ? (
            <div key={f.key} className="flex items-center justify-between">
              <span className="text-muted-foreground">{f.unit ? f.label.replace(/ \([^)]*\)$/, '') : f.label}</span>
              <span className="font-medium">{v}</span>
            </div>
          ) : null;
        })}
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-muted-foreground"><MapPin className="w-3.5 h-3.5" />Pièce</span>
          <span className="font-medium">{room?.name ?? 'Sans pièce'}</span>
        </div>
      </div>

      {/* ── Fournisseurs ── */}
      <div className="mt-5 pt-5 border-t border-border/50">
        <div className="flex items-center gap-2 mb-3">
          <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
          <p className="vb-app-subsection">Fournisseurs</p>
          {loadingSuppliers && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
        </div>
        {!loadingSuppliers && equipmentSuppliers.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucun fournisseur associé.</p>
        ) : (
          <div className="space-y-1.5">
            {equipmentSuppliers.map(s => (
              <EntityCard
                key={s.supplierId}
                kind="fournisseur"
                id={s.supplierId}
                title={s.name}
                icon={<Building2 className="w-3.5 h-3.5" />}
                meta={s.email ?? undefined}
                badges={s.isPrimary ? (
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[color:var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--border-info)]">
                    Principal
                  </span>
                ) : undefined}
                onOpen={() => { setSupplierDrawerId(s.supplierId); setSupplierDrawerOpen(true); }}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Documents ── */}
      <div className="mt-5 pt-5 border-t border-border/50">
        <div className="flex items-center gap-2 mb-3">
          <FileText className="w-3.5 h-3.5 text-muted-foreground" />
          <p className="vb-app-subsection">Documents associés</p>
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
                <EntityCard
                  key={doc.id}
                  kind="document"
                  id={doc.id}
                  title={doc.title}
                  icon={<FileText className="w-3.5 h-3.5" />}
                  meta={(doc.documentTypeLabel || doc.documentDate) ? (
                    <span className="flex items-center gap-1.5 flex-wrap">
                      {doc.documentTypeLabel && (
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${typeColor}`}>
                          {doc.documentTypeLabel}
                        </span>
                      )}
                      {doc.documentDate && <span>{formatDate(doc.documentDate)}</span>}
                    </span>
                  ) : undefined}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* ── Agenda ── */}
      <div className="mt-5 pt-5 border-t border-border/50 pb-2">
        <div className="flex items-center gap-2 mb-3">
          <CalendarDays className="w-3.5 h-3.5 text-muted-foreground" />
          <p className="vb-app-subsection">Agenda associé</p>
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
              <EntityCard
                key={item.id}
                kind="echeance"
                id={item.id}
                title={item.title}
                icon={<AgendaStatusIcon status={item.effectiveStatus} />}
                iconStyle="plain"
                meta={item.startDate
                  ? `${formatDate(item.startDate)}${item.startTime ? ` · ${item.startTime.slice(0, 5)}` : ''}`
                  : 'Sans date'}
                badges={<AgendaStatusBadge item={item} />}
              />
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
                  <span className="text-[12px] font-semibold">Annuler</span>
                </button>
                <div className="w-px bg-border" />
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-primary/10 transition-colors text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={handleSave}
                  disabled={isSaving || !name.trim()}
                >
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : isCreateMode ? <Plus className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                  <span className="text-[12px] font-semibold">{isSaving ? 'Sauvegarde…' : isCreateMode ? 'Ajouter' : 'Enregistrer'}</span>
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
                  <span className="text-[12px] font-semibold">Fermer</span>
                </button>
                <div className="w-px bg-border" />
                <button
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground"
                  onClick={enterEditMode}
                >
                  <Pencil className="w-4 h-4" />
                  <span className="text-[12px] font-semibold">Modifier</span>
                </button>
                <div className="w-px bg-border" />
                <button
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-destructive/10 transition-colors text-destructive disabled:opacity-40"
                  onClick={() => setShowArchiveConfirm(true)}
                  disabled={isArchiving}
                >
                  <Trash2 className="w-4 h-4" />
                  <span className="text-[12px] font-semibold">Supprimer</span>
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
