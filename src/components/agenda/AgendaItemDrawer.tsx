"use client";

import { T6ReminderSettings } from "@/components/home/T6ReminderControls";
import { useState, useCallback, useEffect } from "react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { TimePicker } from "@/components/ui/time-picker";
import {
  Clock,
  Building2,
  FileText,
  Grid2X2,
  Wrench,
  Zap,
  Edit,
  Trash2,
  AlertCircle,
  ChevronDown,
  X,
  Check,
  Loader2,
} from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { toast } from "sonner";
import { assetSupportsStructuralFeatures } from "@/types/domain";
import type { AgendaItemFull } from "@/services/agenda/AgendaQueryService";
import { EFFECTIVE_STATUS_LABELS, attentionFlagLabel, visibleAttentionFlags, type AgendaEffectiveStatus } from '@/lib/agenda/effective-status';
import { openDrawer } from "@/lib/drawers";
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { displayDocumentTitle } from '@/lib/documents/document-title-rules';
import { NoDeadlineField } from "@/components/agenda/NoDeadlineField";
import { NO_DEADLINE_HELP, NO_DEADLINE_LABEL, toggleNoDeadline, undatedLabel, withDateEntry, type AgendaDateFormState } from "@/lib/agenda/no-deadline";
// Lot 84B (CDC v5 O-3, §14) : regroupement de l'élément — événement de référence, élément rattaché, élément seul.
import { AgendaGroupingSection } from "@/components/agenda/AgendaGroupingSection";

// Lot 53 (D17) : libellés partagés des cinq états.
type EffectiveStatus = AgendaEffectiveStatus;

const STATUS_LABELS: Record<EffectiveStatus, string> = EFFECTIVE_STATUS_LABELS;

const STATUS_STYLES: Record<EffectiveStatus, string> = {
  a_venir:
    "bg-[color:var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--border-info)]",
  en_retard:
    "bg-[color:var(--danger-soft)] text-[color:var(--danger)] border border-[color:var(--danger-edge)]",
  a_confirmer:
    "bg-[color:var(--attention-soft)] text-[color:var(--attention-on-soft)] border border-[color:var(--attention-edge)]",
  realise:
    "bg-[color:var(--bg-success)] text-[color:var(--text-success)] border border-[color:var(--border-success)]",
  annule:
    "bg-[color:var(--bg-subtle)] text-[color:var(--text-secondary)] border border-[color:var(--border)]",
};

// Pastille de date du héros : même ton que le statut (charte §5 — brume /
// pétrole par défaut, rouge en retard strict, cuivre à confirmer).
const HERO_DATE_TONE: Record<EffectiveStatus, string> = {
  a_venir: "bg-[color:var(--accent-soft)] border-[color:var(--border)] text-[color:var(--accent)]",
  en_retard: "bg-[color:var(--danger-soft)] border-[color:var(--danger-edge)] text-[color:var(--danger)]",
  a_confirmer: "bg-[color:var(--attention-soft)] border-[color:var(--attention-edge)] text-[color:var(--attention-on-soft)]",
  realise: "bg-[color:var(--accent-soft)] border-[color:var(--border)] text-[color:var(--accent)]",
  annule: "bg-[color:var(--bg-subtle)] border-[color:var(--border)] text-[color:var(--text-secondary)]",
};


function formatDateRange(item: AgendaItemFull): string {
  if (!item.startDate) return undatedLabel(item);
  const fmt = (d: string) =>
    new Date(d + "T12:00:00").toLocaleDateString("fr-FR", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  const fmtTime = (t: string) => t.slice(0, 5).replace(":", "h");
  if (item.endDate && item.endDate !== item.startDate) {
    if (item.startTime && item.endTime)
      return `du ${fmt(item.startDate)} ${fmtTime(item.startTime)} au ${fmt(item.endDate)} ${fmtTime(item.endTime)}`;
    return `du ${fmt(item.startDate)} au ${fmt(item.endDate)}`;
  }
  if (item.startTime)
    return `${fmt(item.startDate)} à ${fmtTime(item.startTime)}`;
  return fmt(item.startDate);
}

interface AssetOption {
  id: number;
  name: string;
  category: string;
  subtype?: string;
}
interface SubOption {
  id: number;
  name: string;
}

interface Props {
  item: AgendaItemFull | null;
  open: boolean;
  onClose: () => void;
  onMutated: () => void;
  onOpenDocument?: (fileId: number) => void;
  initialMode?: "view" | "edit";
}

function dispatchAgendaMutated() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('agenda-mutated'));
  }
}

export function AgendaItemDrawer({ item: itemProp, open, onClose, onMutated, onOpenDocument, initialMode = "view" }: Props) {
  // Lot 84B : après un geste de regroupement, l'élément est relu (documents liés à jour)
  // sans fermer le tiroir — l'écran d'origine garde sa propre relecture (`onMutated`).
  const [freshItem, setFreshItem] = useState<AgendaItemFull | null>(null);
  const [groupingRole, setGroupingRole] = useState<"MAIN" | "MEMBER" | "NONE" | null>(null);
  const item = freshItem && itemProp && freshItem.id === itemProp.id ? freshItem : itemProp;
  useEffect(() => { setFreshItem(null); setGroupingRole(null); }, [itemProp]);
  const refreshItem = useCallback(() => {
    if (!itemProp) return;
    apiClient.get<{ item: AgendaItemFull }>(`/api/agenda/${itemProp.id}`)
      .then((r) => { if (r?.item) setFreshItem(r.item); })
      .catch(() => {});
  }, [itemProp]);
  const [mode, setMode] = useState<"view" | "edit">(initialMode);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStartDate, setEditStartDate] = useState("");
  const [editStartTime, setEditStartTime] = useState("");
  const [editEndDate, setEditEndDate] = useState("");
  const [editEndTime, setEditEndTime] = useState("");
  // Lot 77A : option « Sans échéance » (incompatible avec une date).
  const [editNoDeadline, setEditNoDeadline] = useState(false);
  const editDates: AgendaDateFormState = {
    startDate: editStartDate, startTime: editStartTime, endDate: editEndDate, endTime: editEndTime, noDeadline: editNoDeadline,
  };
  const applyEditDates = (s: AgendaDateFormState) => {
    setEditStartDate(s.startDate);
    setEditStartTime(s.startTime);
    setEditEndDate(s.endDate);
    setEditEndTime(s.endTime);
    setEditNoDeadline(s.noDeadline);
    setDirty(true);
    setTemporalError(null);
  };
  const [editManualStatus, setEditManualStatus] = useState<string>("null");
  const [editAssetIds, setEditAssetIds] = useState<number[]>([]);
  const [editSubstructureIds, setEditSubstructureIds] = useState<number[]>([]);
  const [editEquipmentIds, setEditEquipmentIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showDirtyConfirm, setShowDirtyConfirm] = useState(false);
  const [temporalError, setTemporalError] = useState<string | null>(null);

  // Lot 75H : pièce / équipement / document associés s'ouvrent en tiroir
  // EMPILÉ (GlobalDrawerHost, fiche relue par son identifiant) : la fermeture
  // ramène à cette échéance.

  // Assets + details for edit mode
  const [allAssets, setAllAssets] = useState<AssetOption[]>([]);
  const [assetDetails, setAssetDetails] = useState<
    Record<number, { substructures: SubOption[]; equipments: SubOption[] }>
  >({});

  // All immo assets (for structural feature)
  const allImmoAssets = allAssets.filter((a) =>
    assetSupportsStructuralFeatures(a),
  );
  // Immo assets currently selected
  const selectedImmoAssets = allAssets.filter(
    (a) => editAssetIds.includes(a.id) && assetSupportsStructuralFeatures(a),
  );
  // Show structural when at least one immo asset selected OR no bien selected but immo assets exist
  const showStructural =
    selectedImmoAssets.length > 0 ||
    (editAssetIds.length === 0 && allImmoAssets.length > 0);
  // When no bien selected: show all immo equipments/substructures; otherwise only selected ones
  const sourceAssets =
    editAssetIds.length === 0 ? allImmoAssets : selectedImmoAssets;
  const substructures = sourceAssets.flatMap(
    (a) => assetDetails[a.id]?.substructures ?? [],
  );
  const equipments = sourceAssets.flatMap(
    (a) => assetDetails[a.id]?.equipments ?? [],
  );

  // When drawer opens in edit mode, populate edit fields immediately
  useEffect(() => {
    if (!open || !item) return;
    if (initialMode === "edit") {
      setEditTitle(item.title);
      setEditDescription(item.description ?? "");
      setEditStartDate(item.startDate ?? "");
      setEditStartTime(item.startTime ?? "");
      setEditEndDate(item.endDate ?? "");
      setEditEndTime(item.endTime ?? "");
      setEditNoDeadline(item.noDeadline === true);
      setEditManualStatus(item.manualStatus ?? "null");
      setEditAssetIds(item.assetLinks.map((l) => l.assetId));
      setEditSubstructureIds(item.roomLinks.map((l) => l.substructureId));
      setEditEquipmentIds(item.equipmentLinks.map((l) => l.equipmentId));
      setDirty(false);
      setSaveError(null);
      setTemporalError(null);
      setMode("edit");
    } else {
      setMode("view");
    }
  }, [open, item?.id, initialMode]);

  // Load assets + details whenever the drawer opens (preload so data is ready when edit starts)
  useEffect(() => {
    if (!open) return;
        const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    fetch("/api/assets?limit=100", { credentials: "include", headers })
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then(async (d) => {
        const list: AssetOption[] = d.data ?? [];
        setAllAssets(list);
        // Only fetch details for immo assets
        const immoList = list.filter((a) => assetSupportsStructuralFeatures(a));
        await Promise.all(
          immoList.map((asset) =>
            fetch(`/api/assets?id=${asset.id}`, {
              credentials: "include",
              headers,
            })
              .then((r) => (r.ok ? r.json() : {}))
              .then(
                (detail: {
                  substructures?: SubOption[];
                  equipments?: SubOption[];
                }) => {
                  setAssetDetails((prev) => ({
                    ...prev,
                    [asset.id]: {
                      substructures: Array.isArray(detail.substructures)
                        ? detail.substructures
                        : [],
                      equipments: Array.isArray(detail.equipments)
                        ? detail.equipments
                        : [],
                    },
                  }));
                },
              )
              .catch(() => {}),
          ),
        );
      })
      .catch(() => {});
  }, [open]);

  // Clear structural selection when asset selection changes (only filter, don't wipe)
  useEffect(() => {
    if (mode !== "edit") return;
    if (substructures.length > 0) {
      setEditSubstructureIds((prev) =>
        prev.filter((id) => substructures.some((s) => s.id === id)),
      );
    }
    if (equipments.length > 0) {
      setEditEquipmentIds((prev) =>
        prev.filter((id) => equipments.some((e) => e.id === id)),
      );
    }
  }, [editAssetIds.join(",")]);

  const startEdit = useCallback(() => {
    if (!item) return;
    setEditTitle(item.title);
    setEditDescription(item.description ?? "");
    setEditStartDate(item.startDate ?? "");
    setEditStartTime(item.startTime ?? "");
    setEditEndDate(item.endDate ?? "");
    setEditEndTime(item.endTime ?? "");
    setEditNoDeadline(item.noDeadline === true);
    setEditManualStatus(item.manualStatus ?? "null");
    setEditAssetIds(item.assetLinks.map((l) => l.assetId));
    setEditSubstructureIds(item.roomLinks.map((l) => l.substructureId));
    setEditEquipmentIds(item.equipmentLinks.map((l) => l.equipmentId));
    setDirty(false);
    setSaveError(null);
    setTemporalError(null);
    setMode("edit");
  }, [item]);

  const handleClose = useCallback(() => {
    if (mode === "edit" && dirty) {
      setShowDirtyConfirm(true);
      return;
    }
    setMode("view");
    setAllAssets([]);
    setAssetDetails({});
    onClose();
  }, [mode, dirty, onClose]);

  // L'ouverture reste possible — consulter une échéance n'est pas une
  // écriture. La garde porte sur « Modifier » (lot 85D : pas de formulaire
  // rempli pour rien, comme le tiroir document), puis sur chaque écriture.
  const { garder } = useWriteGuard();
  /**
   * Lot 85D : toute écriture du tiroir (enregistrer, statut, confirmation de
   * date, suppression) passe par la garde partagée — compte en lecture seule :
   * fenêtre habituelle, aucun appel. Le serveur refuse de toute façon (403).
   */
  const autorise = () => { let ok = false; garder(() => { ok = true; }); return ok; };
  const handleSave = async () => {
    if (!autorise()) return;

    if (!item) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiClient.put(`/api/agenda/${item.id}`, {
        title: editTitle.trim(),
        description: editDescription || null,
        startDate: editStartDate || null,
        startTime: editStartTime || null,
        endDate: editEndDate || null,
        endTime: editEndTime || null,
        noDeadline: editNoDeadline,
        assetIds: editAssetIds,
        substructureIds: editSubstructureIds,
        equipmentIds: editEquipmentIds,
      });
      // Update status separately if changed
      const newManualStatus =
        editManualStatus === "null"
          ? null
          : (editManualStatus as "realise" | "annule");
      if (newManualStatus !== (item.manualStatus ?? null)) {
        await apiClient.patch(`/api/agenda/${item.id}/statut`, {
          manualStatus: newManualStatus,
        });
      }
      toast.success("Agenda mis à jour");
      setMode("view");
      setDirty(false);
      dispatchAgendaMutated();
      onMutated();
    } catch (err: any) {
      const msg = err?.message || "Erreur lors de la sauvegarde";
      setSaveError(msg);
      if (
        msg.includes("temporelle") ||
        msg.includes("endDate") ||
        msg.includes("startTime")
      )
        setTemporalError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (val: string) => {
    if (!item || !autorise()) return;
    const manualStatus = val === "null" ? null : (val as "realise" | "annule");
    try {
      await apiClient.patch(`/api/agenda/${item.id}/statut`, { manualStatus });
      toast.success("Statut mis à jour");
      dispatchAgendaMutated();
      onMutated();
    } catch (err: any) {
      // 403 de droits : la fenêtre de fin d'essai est déjà ouverte (api-client).
      if (err?.status !== 403) toast.error("Erreur lors de la mise à jour du statut");
    }
  };

  // Occurrence prévisionnelle : l'utilisateur peut la confirmer telle quelle.
  const handleConfirmForecast = async () => {
    if (!item || !autorise()) return;
    try {
      await apiClient.post(`/api/agenda/${item.id}/confirm`, {});
      toast.success("Date confirmée");
      dispatchAgendaMutated();
      onMutated();
    } catch (err: any) {
      if (err?.status !== 403) toast.error("La confirmation n’a pas abouti");
    }
  };

  const handleDelete = async () => {
    if (!item || !autorise()) return;
    setDeleting(true);

    const confirmDeleted = () => {
      toast.success("Élément supprimé");
      onClose();
      dispatchAgendaMutated();
      onMutated();
    };

    try {
      await apiClient.delete(`/api/agenda/${item.id}`);
      confirmDeleted();
    } catch (err: any) {
      // 404 : l'élément n'existe déjà plus côté serveur — deuxième clic,
      // ou suppression faite depuis un autre onglet. Le geste de
      // l'utilisateur a abouti ; le traiter en échec le laisserait devant
      // une ligne fantôme jusqu'au prochain rechargement.
      if (err?.status === 404) {
        confirmDeleted();
        return;
      }
      // Le message du serveur remplace le libellé générique : c'est lui qui
      // rend une violation de contrainte diagnosticable sans ouvrir les
      // journaux.
      // 403 de droits : la fenêtre de fin d'essai est déjà ouverte (api-client).
      if (err?.status !== 403) {
        console.error("[agenda] suppression échouée", err);
        toast.error(
          err?.serverMessage || err?.message || "Erreur lors de la suppression",
        );
      }
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const toggleId = (
    id: number,
    list: number[],
    setList: (v: number[]) => void,
  ) =>
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  // Helpers for hero date block
  const heroDate = (() => {
    if (!item?.startDate) return null;
    const d = new Date(item.startDate + "T12:00:00");
    return {
      day: d.getDate().toString().padStart(2, "0"),
      month: d
        .toLocaleDateString("fr-FR", { month: "short" })
        .replace(".", "")
        .toUpperCase(),
      weekday: d.toLocaleDateString("fr-FR", { weekday: "long" }),
    };
  })();

  if (!item) return null;

  const statusStyle = STATUS_STYLES[item.effectiveStatus];

  return (
    <>
      <Sheet open={open} onOpenChange={handleClose}>
        <SheetContent className="w-full sm:max-w-[520px] overflow-y-auto p-0 flex flex-col">
          {/* ── HERO (view) or compact header (edit) ── */}
          {mode === "view" ? (
            <div className="relative px-7 pt-10 pb-8 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-card)]">
              {/* Close button is injected by SheetContent – leave room */}
              {/* Status + flags row */}
              <div className="flex items-center gap-2 mb-5 flex-wrap">
                <span
                  className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${statusStyle}`}
                >
                  {STATUS_LABELS[item.effectiveStatus]}
                </span>
                {item.occurrenceNature === "FORECAST" && (
                  <span
                    className="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium bg-[color:var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--border-info)]"
                    title={item.recurrenceRule ? `Date estimée à partir de la récurrence (${item.recurrenceRule})` : "Date estimée à partir de la récurrence"}
                  >
                    Prévisionnelle
                  </span>
                )}
                {item.isAutomatic && !item.isAutomaticModified && (
                  <span className="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium bg-[color:var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--border-info)]">
                    <Zap className="h-3 w-3 mr-1" /> Automatique
                  </span>
                )}
                {visibleAttentionFlags(item.attentionFlags)
                  .map((f) => (
                    <span
                      key={f}
                      className="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium bg-[color:var(--attention-soft)] text-[color:var(--attention-on-soft)] border border-[color:var(--attention-edge)]"
                    >
                      <AlertCircle className="h-3 w-3 mr-1" />
                      {attentionFlagLabel(f)}
                    </span>
                  ))}
              </div>

              {/* Title */}
              <SheetTitle className="text-2xl font-extrabold tracking-[-.02em] text-[color:var(--text-primary)] leading-tight mb-5 pr-6">
                {item.title}
              </SheetTitle>

              {/* Date hero block */}
              {heroDate ? (
                <div className="flex items-center gap-4">
                  <div aria-hidden className={`w-14 h-14 rounded-[10px] border flex flex-col items-center justify-center shrink-0 ${HERO_DATE_TONE[item.effectiveStatus] ?? HERO_DATE_TONE.a_venir}`}>
                    <span className="text-xl font-bold tabular-nums leading-none">
                      {heroDate.day}
                    </span>
                    <span className="text-[10px] font-bold uppercase tracking-[.05em] mt-0.5">
                      {heroDate.month}
                    </span>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--text-primary)] capitalize">
                      {heroDate.weekday}
                    </p>
                    <p className="text-xs text-[color:var(--text-muted)] mt-0.5">
                      {item.occurrenceNature === "FORECAST" ? `Prévu le ${formatDateRange(item)}` : formatDateRange(item)}
                    </p>
                    {item.occurrenceNature === "FORECAST" && (
                      <p className="text-xs text-[color:var(--text-muted)] mt-1">
                        Date estimée à partir de la récurrence{item.recurrenceRule ? ` (${item.recurrenceRule})` : ""}.{" "}
                        <button type="button" onClick={handleConfirmForecast} className="underline text-[color:var(--accent)]">
                          Confirmer cette date
                        </button>
                      </p>
                    )}
                    {item.occurrenceNature === "CONFIRMED" && item.forecastInitialDate && item.forecastInitialDate !== item.startDate && (
                      <p className="text-xs text-[color:var(--text-muted)] mt-1">
                        Estimée au {new Date(item.forecastInitialDate + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}, puis confirmée.
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <div aria-hidden className="w-14 h-14 rounded-[10px] bg-[color:var(--accent-soft)] border border-[color:var(--border)] flex flex-col items-center justify-center shrink-0">
                    <span className="text-base font-bold text-[color:var(--accent)]">
                      —
                    </span>
                  </div>
                  {item.noDeadline ? (
                    <div>
                      <p className="text-sm font-semibold text-[color:var(--text-primary)]">{NO_DEADLINE_LABEL}</p>
                      <p className="text-xs text-[color:var(--text-muted)] mt-0.5">{NO_DEADLINE_HELP}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-[color:var(--text-muted)]">
                      Sans date définie
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="px-7 pt-8 pb-5 border-b border-[color:var(--border-subtle)]">
              <SheetTitle className="sr-only">Modifier l'élément</SheetTitle>
              <p className="vb-app-label mb-2">
                Titre
              </p>
              <Input
                value={editTitle}
                onChange={(e) => {
                  setEditTitle(e.target.value);
                  setDirty(true);
                }}
                className="text-lg font-semibold bg-transparent border-0 border-b border-input rounded-none px-0 focus-visible:border-[color:var(--accent)]"
                placeholder="Titre *"
              />
            </div>
          )}

          {/* ── BODY ── */}
          <div className="flex-1 px-7 py-6 space-y-6">
            {/* Status changer (view mode only inline) */}
            {mode === "view" && (
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-[color:var(--accent-soft)] flex items-center justify-center shrink-0">
                  <Clock className="h-4 w-4 text-[color:var(--text-muted)]" />
                </div>
                <div className="flex-1">
                  <p className="vb-app-label mb-1">
                    Statut
                  </p>
                  <Select
                    value={item?.manualStatus ?? "null"}
                    onValueChange={handleStatusChange}
                  >
                    <SelectTrigger className="h-8 w-36 text-sm bg-[color:var(--bg-card)] border-[color:var(--border-subtle)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="null">À venir</SelectItem>
                      <SelectItem value="realise">Réalisé</SelectItem>
                      <SelectItem value="annule">Annulé</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* Lot 60 (T6) : rappels de l'accueil pour cette échéance — préférence personnelle. */}
            {mode === "view" && !item.manualStatus && <T6ReminderSettings agendaItemId={item.id} title={item.title} />}

            {/* Description */}
            {mode === "view" ? (
              item.description ? (
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-[color:var(--accent-soft)] flex items-center justify-center shrink-0 mt-0.5">
                    <FileText className="h-4 w-4 text-[color:var(--text-muted)]" />
                  </div>
                  <div className="flex-1">
                    <p className="vb-app-label mb-1">
                      Description
                    </p>
                    <p className="text-sm text-[color:var(--text-primary)] whitespace-pre-wrap leading-relaxed">
                      {item.description}
                    </p>
                  </div>
                </div>
              ) : null
            ) : (
              <div>
                <Label className="text-[13px] font-semibold text-[color:var(--text-muted)]">
                  Description
                </Label>
                <Textarea
                  value={editDescription}
                  onChange={(e) => {
                    setEditDescription(e.target.value);
                    setDirty(true);
                  }}
                  rows={3}
                  placeholder="Description (optionnel)"
                  className="mt-2"
                />
              </div>
            )}

            {/* Dates (edit mode) */}
            {mode === "edit" && (
              <div>
                <Label className="text-[13px] font-semibold text-[color:var(--text-muted)]">
                  Dates
                </Label>
                <div className="grid grid-cols-2 gap-3 mt-2">
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Date début
                    </Label>
                    <DatePicker
                      value={editStartDate}
                      onChange={(v) => applyEditDates(withDateEntry(editDates, { startDate: v }))}
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Heure début
                    </Label>
                    <TimePicker
                      value={editStartTime}
                      onChange={(v) => applyEditDates(withDateEntry(editDates, { startTime: v }))}
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Date fin
                    </Label>
                    <DatePicker
                      value={editEndDate}
                      onChange={(v) => applyEditDates(withDateEntry(editDates, { endDate: v }))}
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Heure fin
                    </Label>
                    <TimePicker
                      value={editEndTime}
                      onChange={(v) => applyEditDates(withDateEntry(editDates, { endTime: v }))}
                    />
                  </div>
                </div>
                {/* Lot 77A : « Sans échéance » — saisir une date la décoche ; la cocher retire la date (confirmation). */}
                <div className="mt-3">
                  <NoDeadlineField
                    id={`agenda-${item.id}-sans-echeance`}
                    state={editDates}
                    onChange={(checked) => applyEditDates(toggleNoDeadline(editDates, checked))}
                  />
                </div>
                {temporalError && (
                  <p className="text-xs text-[color:var(--danger)] mt-1">{temporalError}</p>
                )}
              </div>
            )}

            {/* Edit: status */}
            {mode === "edit" && (
              <div>
                <Label className="text-[13px] font-semibold text-[color:var(--text-muted)]">
                  Statut
                </Label>
                <Select
                  value={editManualStatus}
                  onValueChange={(val) => {
                    setEditManualStatus(val);
                    setDirty(true);
                  }}
                >
                  <SelectTrigger className="mt-2 h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="null">À venir</SelectItem>
                    <SelectItem value="realise">Réalisé</SelectItem>
                    <SelectItem value="annule">Annulé</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Biens */}
            {mode === "view" ? (
              item.assetLinks.length > 0 && (
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-[color:var(--accent-soft)] flex items-center justify-center shrink-0 mt-0.5">
                    <Building2 className="h-4 w-4 text-[color:var(--accent)]" />
                  </div>
                  <div className="flex-1">
                    <p className="vb-app-label mb-2">
                      {item.assetLinks.length > 1
                        ? "Biens associés"
                        : "Bien associé"}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {item.assetLinks.map((l) => (
                        <a
                          key={l.assetId}
                          href={`/assets/${l.assetId}`}
                          className="inline-flex items-center px-3 py-1 rounded-lg text-xs font-medium bg-[color:var(--accent-soft)] text-[color:var(--accent)] border border-[color:var(--border-info)] hover:border-[color:var(--border-info)] transition-colors"
                        >
                          {l.assetName}
                        </a>
                      ))}
                    </div>
                  </div>
                </div>
              )
            ) : (
              <div className="space-y-1.5">
                <Label className="text-[13px] font-semibold text-[color:var(--text-muted)]">
                  Bien(s) associé(s)
                </Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="w-full flex items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm text-left hover:bg-accent/30 transition-colors mt-2"
                      onClick={() => setDirty(true)}
                    >
                      <span
                        className={
                          editAssetIds.length === 0
                            ? "text-muted-foreground"
                            : ""
                        }
                      >
                        {editAssetIds.length === 0
                          ? "Aucun bien"
                          : editAssetIds.length === 1
                            ? (allAssets.find((a) => a.id === editAssetIds[0])
                                ?.name ?? "1 bien")
                            : `${editAssetIds.length} biens`}
                      </span>
                      <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64 p-2" align="start">
                    {allAssets.length === 0 ? (
                      <p className="text-xs text-muted-foreground px-2 py-1">
                        Chargement...
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {allAssets.map((a) => (
                          <label
                            key={a.id}
                            className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer"
                          >
                            <Checkbox
                              checked={editAssetIds.includes(a.id)}
                              onCheckedChange={() => {
                                toggleId(a.id, editAssetIds, setEditAssetIds);
                                setDirty(true);
                              }}
                            />
                            <span className="text-sm">{a.name}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              </div>
            )}

            {/* Pièces */}
            {mode === "view"
              ? item.roomLinks.length > 0 && (
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-[color:var(--accent-soft)] flex items-center justify-center shrink-0 mt-0.5">
                      <Grid2X2 className="h-4 w-4 text-[color:var(--text-muted)]" />
                    </div>
                    <div className="flex-1">
                      <p className="vb-app-label mb-2">
                        Pièces
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {item.roomLinks.map((l) => (
                          l.resolvedAssetId ? (
                            <button
                              key={l.substructureId}
                              type="button"
                              onClick={() => openDrawer({ kind: 'piece', id: l.substructureId }, { stack: true })}
                              aria-label={`Ouvrir la pièce : ${l.name}`}
                              className="inline-flex items-center px-3 py-1 rounded-lg text-xs font-medium bg-[color:var(--bg-page)] text-[color:var(--text-primary)] border border-[color:var(--border-subtle)] hover:border-[color:var(--border-info)] hover:bg-[color:var(--accent-soft)] transition-colors cursor-pointer"
                            >
                              {l.name}
                            </button>
                          ) : (
                            <span
                              key={l.substructureId}
                              className="inline-flex items-center px-3 py-1 rounded-lg text-xs font-medium bg-[color:var(--bg-page)] text-[color:var(--text-primary)] border border-[color:var(--border-subtle)]"
                            >
                              {l.name}
                            </span>
                          )
                        ))}
                      </div>
                    </div>
                  </div>
                )
              : showStructural && (
                  <div className="space-y-1.5">
                    <Label className="text-[13px] font-semibold text-[color:var(--text-muted)]">
                      Pièce(s) associée(s)
                    </Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="w-full flex items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm text-left hover:bg-accent/30 transition-colors mt-2"
                        >
                          <span className="text-muted-foreground">
                            {editSubstructureIds.length === 0
                              ? "Aucune pièce"
                              : `${editSubstructureIds.length} pièce(s)`}
                          </span>
                          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-64 p-2" align="start">
                        {substructures.length === 0 ? (
                          <p className="text-xs text-muted-foreground px-2 py-1">
                            Aucune pièce.
                          </p>
                        ) : (
                          <div className="space-y-1">
                            {substructures.map((s) => (
                              <label
                                key={s.id}
                                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer"
                              >
                                <Checkbox
                                  checked={editSubstructureIds.includes(s.id)}
                                  onCheckedChange={() => {
                                    toggleId(
                                      s.id,
                                      editSubstructureIds,
                                      setEditSubstructureIds,
                                    );
                                    setDirty(true);
                                  }}
                                />
                                <span className="text-sm">{s.name}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </PopoverContent>
                    </Popover>
                  </div>
                )}

            {/* Équipements */}
            {mode === "view"
              ? item.equipmentLinks.length > 0 && (
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-[color:var(--accent-soft)] flex items-center justify-center shrink-0 mt-0.5">
                      <Wrench className="h-4 w-4 text-[color:var(--text-muted)]" />
                    </div>
                    <div className="flex-1">
                      <p className="vb-app-label mb-2">
                        Équipements
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {item.equipmentLinks.map((l) => (
                          l.resolvedAssetId ? (
                            <button
                              key={l.equipmentId}
                              type="button"
                              onClick={() => openDrawer({ kind: 'equipement', id: l.equipmentId }, { stack: true })}
                              aria-label={`Ouvrir l’équipement : ${l.name}`}
                              className="inline-flex items-center px-3 py-1 rounded-lg text-xs font-medium bg-[color:var(--bg-page)] text-[color:var(--text-primary)] border border-[color:var(--border-subtle)] hover:border-[color:var(--border-info)] hover:bg-[color:var(--accent-soft)] transition-colors cursor-pointer"
                            >
                              {l.name}
                            </button>
                          ) : (
                            <span
                              key={l.equipmentId}
                              className="inline-flex items-center px-3 py-1 rounded-lg text-xs font-medium bg-[color:var(--bg-page)] text-[color:var(--text-primary)] border border-[color:var(--border-subtle)]"
                            >
                              {l.name}
                            </span>
                          )
                        ))}
                      </div>
                    </div>
                  </div>
                )
              : showStructural && (
                  <div className="space-y-1.5">
                    <Label className="text-[13px] font-semibold text-[color:var(--text-muted)]">
                      Équipement(s) associé(s)
                    </Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="w-full flex items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm text-left hover:bg-accent/30 transition-colors mt-2"
                        >
                          <span className="text-muted-foreground">
                            {editEquipmentIds.length === 0
                              ? "Aucun équipement"
                              : `${editEquipmentIds.length} équipement(s)`}
                          </span>
                          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-64 p-2" align="start">
                        {equipments.length === 0 ? (
                          <p className="text-xs text-muted-foreground px-2 py-1">
                            Aucun équipement.
                          </p>
                        ) : (
                          <div className="space-y-1">
                            {equipments.map((e) => (
                              <label
                                key={e.id}
                                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer"
                              >
                                <Checkbox
                                  checked={editEquipmentIds.includes(e.id)}
                                  onCheckedChange={() => {
                                    toggleId(
                                      e.id,
                                      editEquipmentIds,
                                      setEditEquipmentIds,
                                    );
                                    setDirty(true);
                                  }}
                                />
                                <span className="text-sm">{e.name}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </PopoverContent>
                    </Popover>
                  </div>
                )}

            {/* Documents — lot 86D : en consultation, le regroupement (ci-dessous) présente les documents
                de l'élément quel que soit son rôle (ouvrir, relier, détacher) ; cette liste reste un
                rappel en modification, où le regroupement n'est pas affiché. */}
            {item.fileLinks.length > 0 && mode === "edit" && groupingRole !== "MAIN" && (
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-[color:var(--accent-soft)] flex items-center justify-center shrink-0 mt-0.5">
                  <FileText className="h-4 w-4 text-[color:var(--text-muted)]" />
                </div>
                <div className="flex-1">
                  <p className="vb-app-label mb-2">
                    Documents
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {item.fileLinks.map((l) => {
                      // Lot 87D : titre calculé par le serveur (règle unique des vues).
                      const displayName = (l as { title?: string | null }).title || displayDocumentTitle(l, `Doc #${l.assetFileId}`);
                      return (
                        <button
                          key={l.assetFileId}
                          type="button"
                          onClick={() => (onOpenDocument
                            ? onOpenDocument(l.assetFileId)
                            : openDrawer({ kind: 'document', id: l.assetFileId }, { stack: true }))}
                          aria-label={`Ouvrir le document : ${displayName}`}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[color:var(--bg-page)] text-[color:var(--text-primary)] border border-[color:var(--border-subtle)] hover:border-[color:var(--border-info)] hover:text-[color:var(--accent)] transition-colors cursor-pointer"
                        >
                          <FileText className="w-3 h-3 shrink-0" />
                          <span className="truncate max-w-[160px]">{displayName}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Lot 84B (CDC v5 §14.2, §14.3) : regroupement — desktop et mobile (même tiroir). */}
            {mode === "view" && (
              <AgendaGroupingSection
                itemId={item.id}
                onOpenDocument={onOpenDocument}
                onChanged={refreshItem}
                onRole={setGroupingRole}
              />
            )}

            {saveError && !temporalError && (
              <p className="text-sm text-[color:var(--danger)] mt-2">{saveError}</p>
            )}
          </div>

          {/* ── FOOTER ── */}
          <div className="px-5 py-4 border-t border-[color:var(--border-subtle)] flex gap-3">
            {mode === "view" ? (
              <div className="flex items-stretch rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] overflow-hidden w-full">
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground"
                  onClick={() => { if (autorise()) startEdit(); }}
                >
                  <Edit className="w-4 h-4" />
                  <span className="text-[12px] font-semibold">Modifier</span>
                </button>
                <div className="w-px bg-[color:var(--border-subtle)]" />
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-destructive/10 transition-colors text-destructive"
                  onClick={() => { if (autorise()) setShowDeleteConfirm(true); }}
                >
                  <Trash2 className="w-4 h-4" />
                  <span className="text-[12px] font-semibold">Supprimer</span>
                </button>
              </div>
            ) : (
              <div className="flex items-stretch rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] overflow-hidden w-full">
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground"
                  onClick={() => { setMode("view"); setDirty(false); setSaveError(null); }}
                >
                  <X className="w-4 h-4" />
                  <span className="text-[12px] font-semibold">Annuler</span>
                </button>
                <div className="w-px bg-[color:var(--border-subtle)]" />
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-primary/10 transition-colors text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={handleSave}
                  disabled={saving || !editTitle.trim() || !!temporalError}
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  <span className="text-[12px] font-semibold">{saving ? "Sauvegarde…" : "Enregistrer"}</span>
                </button>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer cet élément ?</AlertDialogTitle>
            <AlertDialogDescription>
              Cette action est définitive et irréversible. L'élément sera supprimé de votre agenda.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-[color:var(--danger)] hover:bg-[color:var(--danger)]/90"
            >
              {deleting ? 'Suppression…' : 'Supprimer définitivement'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showDirtyConfirm} onOpenChange={setShowDirtyConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Modifications non enregistrées</AlertDialogTitle>
            <AlertDialogDescription>
              Voulez-vous quitter sans sauvegarder ?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowDirtyConfirm(false)}>
              Continuer l'édition
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowDirtyConfirm(false);
                setMode("view");
                setDirty(false);
                onClose();
              }}
            >
              Quitter sans sauvegarder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
