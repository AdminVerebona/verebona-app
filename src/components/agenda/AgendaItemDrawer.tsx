"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Calendar,
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
import { RoomDrawer } from "@/components/assets/RoomDrawer";
import type { RoomDrawerItem } from "@/components/assets/RoomDrawer";
import { EquipmentDrawer } from "@/components/assets/EquipmentDrawer";
import type { EquipmentDrawerItem } from "@/components/assets/EquipmentDrawer";

type EffectiveStatus = "a_venir" | "en_retard" | "realise" | "annule";

const STATUS_LABELS: Record<EffectiveStatus, string> = {
  a_venir: "À venir",
  en_retard: "En retard",
  realise: "Réalisé",
  annule: "Annulé",
};

const STATUS_STYLES: Record<EffectiveStatus, string> = {
  a_venir:
    "bg-[rgba(59,130,246,0.15)] text-[#93c5fd] border border-[rgba(59,130,246,0.25)]",
  en_retard:
    "bg-[rgba(239,68,68,0.15)] text-[#fca5a5] border border-[rgba(239,68,68,0.25)]",
  realise:
    "bg-[rgba(34,197,94,0.15)] text-[#86efac] border border-[rgba(34,197,94,0.25)]",
  annule:
    "bg-[rgba(148,163,184,0.12)] text-[#94a3b8] border border-[rgba(148,163,184,0.2)]",
};

const ATTENTION_LABELS: Record<string, string> = {
  sans_bien: "Sans bien associé",
  en_retard: "En retard",
  date_incoherente: "Date incohérente",
  donnee_distincte_a_qualifier: "Donnée à qualifier",
};

function formatDateRange(item: AgendaItemFull): string {
  if (!item.startDate) return "Sans date";
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

export function AgendaItemDrawer({ item, open, onClose, onMutated, onOpenDocument, initialMode = "view" }: Props) {
  const [mode, setMode] = useState<"view" | "edit">(initialMode);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editStartDate, setEditStartDate] = useState("");
  const [editStartTime, setEditStartTime] = useState("");
  const [editEndDate, setEditEndDate] = useState("");
  const [editEndTime, setEditEndTime] = useState("");
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

  // Sub-drawers for room / equipment
  const [roomDrawerItem, setRoomDrawerItem] = useState<{ assetId: number; room: RoomDrawerItem } | null>(null);
  const [equipmentDrawerItem, setEquipmentDrawerItem] = useState<{ assetId: number; equipment: EquipmentDrawerItem } | null>(null);

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
    const token =
      typeof window !== "undefined"
        ? localStorage.getItem("bearer_token")
        : null;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
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

  const handleSave = async () => {
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
    if (!item) return;
    const manualStatus = val === "null" ? null : (val as "realise" | "annule");
    try {
      await apiClient.patch(`/api/agenda/${item.id}/statut`, { manualStatus });
      toast.success("Statut mis à jour");
      dispatchAgendaMutated();
      onMutated();
    } catch {
      toast.error("Erreur lors de la mise à jour du statut");
    }
  };

  const handleDelete = async () => {
    if (!item) return;
    setDeleting(true);
    try {
      await apiClient.delete(`/api/agenda/${item.id}`);
      toast.success("Élément supprimé");
      onClose();
      dispatchAgendaMutated();
      onMutated();
    } catch {
      toast.error("Erreur lors de la suppression");
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
            <div className="relative px-7 pt-10 pb-8 border-b border-[color:var(--border-subtle)] bg-gradient-to-b from-[rgba(59,130,246,0.06)] to-transparent">
              {/* Close button is injected by SheetContent – leave room */}
              {/* Status + flags row */}
              <div className="flex items-center gap-2 mb-5 flex-wrap">
                <span
                  className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${statusStyle}`}
                >
                  {STATUS_LABELS[item.effectiveStatus]}
                </span>
                {item.isAutomatic && !item.isAutomaticModified && (
                  <span className="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium bg-[rgba(139,92,246,0.15)] text-[#c4b5fd] border border-[rgba(139,92,246,0.25)]">
                    <Zap className="h-3 w-3 mr-1" /> Automatique
                  </span>
                )}
                {item.attentionFlags
                  .filter((f) => f !== "en_retard")
                  .map((f) => (
                    <span
                      key={f}
                      className="inline-flex items-center rounded-full px-3 py-1 text-xs font-medium bg-[rgba(245,158,11,0.15)] text-[#fcd34d] border border-[rgba(245,158,11,0.25)]"
                    >
                      <AlertCircle className="h-3 w-3 mr-1" />
                      {ATTENTION_LABELS[f]}
                    </span>
                  ))}
              </div>

              {/* Title */}
              <SheetTitle className="text-2xl font-bold text-[color:var(--text-primary)] leading-tight mb-5 pr-6">
                {item.title}
              </SheetTitle>

              {/* Date hero block */}
              {heroDate ? (
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-xl bg-[rgba(59,130,246,0.15)] border border-[rgba(59,130,246,0.25)] flex flex-col items-center justify-center shrink-0">
                    <span className="text-xl font-bold text-[#93c5fd] leading-none">
                      {heroDate.day}
                    </span>
                    <span className="text-[10px] font-semibold text-[#93c5fd]/70 uppercase tracking-wide mt-0.5">
                      {heroDate.month}
                    </span>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--text-primary)] capitalize">
                      {heroDate.weekday}
                    </p>
                    <p className="text-xs text-[color:var(--text-muted)] mt-0.5">
                      {formatDateRange(item)}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="w-14 h-14 rounded-xl bg-[rgba(59,130,246,0.10)] border border-[rgba(59,130,246,0.18)] flex flex-col items-center justify-center shrink-0">
                    <span className="text-xs font-bold text-[#93c5fd]/70">
                      TBD
                    </span>
                  </div>
                  <p className="text-sm text-[color:var(--text-muted)]">
                    Sans date définie
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="px-7 pt-8 pb-5 border-b border-[color:var(--border-subtle)]">
              <SheetTitle className="sr-only">Modifier l'élément</SheetTitle>
              <p className="text-xs font-semibold uppercase tracking-widest text-[color:var(--text-muted)] mb-2">
                Titre
              </p>
              <Input
                value={editTitle}
                onChange={(e) => {
                  setEditTitle(e.target.value);
                  setDirty(true);
                }}
                className="text-lg font-semibold bg-transparent border-0 border-b border-[color:var(--border-subtle)] rounded-none px-0 focus-visible:ring-0 focus-visible:border-[#3b82f6]"
                placeholder="Titre *"
              />
            </div>
          )}

          {/* ── BODY ── */}
          <div className="flex-1 px-7 py-6 space-y-6">
            {/* Status changer (view mode only inline) */}
            {mode === "view" && (
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-[rgba(148,163,184,0.1)] flex items-center justify-center shrink-0">
                  <Clock className="h-4 w-4 text-[color:var(--text-muted)]" />
                </div>
                <div className="flex-1">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-[color:var(--text-muted)] mb-1">
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

            {/* Description */}
            {mode === "view" ? (
              item.description ? (
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-[rgba(148,163,184,0.1)] flex items-center justify-center shrink-0 mt-0.5">
                    <FileText className="h-4 w-4 text-[color:var(--text-muted)]" />
                  </div>
                  <div className="flex-1">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-[color:var(--text-muted)] mb-1">
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
                <Label className="text-xs font-semibold uppercase tracking-widest text-[color:var(--text-muted)]">
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
                <Label className="text-xs font-semibold uppercase tracking-widest text-[color:var(--text-muted)]">
                  Dates
                </Label>
                <div className="grid grid-cols-2 gap-3 mt-2">
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Date début
                    </Label>
                    <DatePicker
                      value={editStartDate}
                      onChange={(v) => {
                        setEditStartDate(v);
                        setDirty(true);
                        setTemporalError(null);
                      }}
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Heure début
                    </Label>
                    <TimePicker
                      value={editStartTime}
                      onChange={(v) => {
                        setEditStartTime(v);
                        setDirty(true);
                        setTemporalError(null);
                      }}
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Date fin
                    </Label>
                    <DatePicker
                      value={editEndDate}
                      onChange={(v) => {
                        setEditEndDate(v);
                        setDirty(true);
                        setTemporalError(null);
                      }}
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Heure fin
                    </Label>
                    <TimePicker
                      value={editEndTime}
                      onChange={(v) => {
                        setEditEndTime(v);
                        setDirty(true);
                        setTemporalError(null);
                      }}
                    />
                  </div>
                </div>
                {temporalError && (
                  <p className="text-xs text-red-500 mt-1">{temporalError}</p>
                )}
              </div>
            )}

            {/* Edit: status */}
            {mode === "edit" && (
              <div>
                <Label className="text-xs font-semibold uppercase tracking-widest text-[color:var(--text-muted)]">
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
                  <div className="w-8 h-8 rounded-lg bg-[rgba(59,130,246,0.1)] flex items-center justify-center shrink-0 mt-0.5">
                    <Building2 className="h-4 w-4 text-[#60a5fa]" />
                  </div>
                  <div className="flex-1">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-[color:var(--text-muted)] mb-2">
                      {item.assetLinks.length > 1
                        ? "Biens associés"
                        : "Bien associé"}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {item.assetLinks.map((l) => (
                        <a
                          key={l.assetId}
                          href={`/assets/${l.assetId}`}
                          className="inline-flex items-center px-3 py-1 rounded-lg text-xs font-medium bg-[rgba(59,130,246,0.12)] text-[#93c5fd] border border-[rgba(59,130,246,0.2)] hover:bg-[rgba(59,130,246,0.22)] hover:border-[rgba(59,130,246,0.4)] transition-colors"
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
                <Label className="text-xs font-semibold uppercase tracking-widest text-[color:var(--text-muted)]">
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
                    <div className="w-8 h-8 rounded-lg bg-[rgba(148,163,184,0.1)] flex items-center justify-center shrink-0 mt-0.5">
                      <Grid2X2 className="h-4 w-4 text-[color:var(--text-muted)]" />
                    </div>
                    <div className="flex-1">
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-[color:var(--text-muted)] mb-2">
                        Pièces
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {item.roomLinks.map((l) => (
                          l.resolvedAssetId ? (
                            <button
                              key={l.substructureId}
                              type="button"
                              onClick={() => setRoomDrawerItem({
                                assetId: l.resolvedAssetId!,
                                room: { id: l.substructureId, name: l.name },
                              })}
                              className="inline-flex items-center px-3 py-1 rounded-lg text-xs font-medium bg-[color:var(--bg-page)] text-[color:var(--text-primary)] border border-[color:var(--border-subtle)] hover:border-[rgba(148,163,184,0.4)] hover:bg-[rgba(148,163,184,0.08)] transition-colors cursor-pointer"
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
                    <Label className="text-xs font-semibold uppercase tracking-widest text-[color:var(--text-muted)]">
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
                    <div className="w-8 h-8 rounded-lg bg-[rgba(148,163,184,0.1)] flex items-center justify-center shrink-0 mt-0.5">
                      <Wrench className="h-4 w-4 text-[color:var(--text-muted)]" />
                    </div>
                    <div className="flex-1">
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-[color:var(--text-muted)] mb-2">
                        Équipements
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {item.equipmentLinks.map((l) => (
                          l.resolvedAssetId ? (
                            <button
                              key={l.equipmentId}
                              type="button"
                              onClick={() => setEquipmentDrawerItem({
                                assetId: l.resolvedAssetId!,
                                equipment: { id: l.equipmentId, assetId: l.resolvedAssetId!, name: l.name, status: 'EN_SERVICE' },
                              })}
                              className="inline-flex items-center px-3 py-1 rounded-lg text-xs font-medium bg-[color:var(--bg-page)] text-[color:var(--text-primary)] border border-[color:var(--border-subtle)] hover:border-[rgba(148,163,184,0.4)] hover:bg-[rgba(148,163,184,0.08)] transition-colors cursor-pointer"
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
                    <Label className="text-xs font-semibold uppercase tracking-widest text-[color:var(--text-muted)]">
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

            {/* Documents (view only) */}
            {item.fileLinks.length > 0 && (
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-[rgba(148,163,184,0.1)] flex items-center justify-center shrink-0 mt-0.5">
                  <FileText className="h-4 w-4 text-[color:var(--text-muted)]" />
                </div>
                <div className="flex-1">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-[color:var(--text-muted)] mb-2">
                    Documents
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {item.fileLinks.map((l) => {
                      const displayName = l.retainedTitle || l.originalFilename || l.filename || `Doc #${l.assetFileId}`;
                      return onOpenDocument ? (
                        <button
                          key={l.assetFileId}
                          onClick={() => onOpenDocument(l.assetFileId)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[color:var(--bg-page)] text-[color:var(--text-primary)] border border-[color:var(--border-subtle)] hover:border-[#3b82f6]/50 hover:text-[#3b82f6] transition-colors cursor-pointer"
                        >
                          <FileText className="w-3 h-3 shrink-0" />
                          <span className="truncate max-w-[160px]">{displayName}</span>
                        </button>
                      ) : (
                        <span
                          key={l.assetFileId}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[color:var(--bg-page)] text-[color:var(--text-primary)] border border-[color:var(--border-subtle)]"
                        >
                          <FileText className="w-3 h-3 shrink-0" />
                          <span className="truncate max-w-[160px]">{displayName}</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {saveError && !temporalError && (
              <p className="text-sm text-red-500 mt-2">{saveError}</p>
            )}
          </div>

          {/* ── FOOTER ── */}
          <div className="px-5 py-4 border-t border-[color:var(--border-subtle)] flex gap-3">
            {mode === "view" ? (
              <div className="flex items-stretch rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] overflow-hidden w-full">
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground"
                  onClick={startEdit}
                >
                  <Edit className="w-4 h-4" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider">Modifier</span>
                </button>
                <div className="w-px bg-[color:var(--border-subtle)]" />
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-destructive/10 transition-colors text-destructive"
                  onClick={() => setShowDeleteConfirm(true)}
                >
                  <Trash2 className="w-4 h-4" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider">Supprimer</span>
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
                  <span className="text-[10px] font-semibold uppercase tracking-wider">Annuler</span>
                </button>
                <div className="w-px bg-[color:var(--border-subtle)]" />
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-primary/10 transition-colors text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={handleSave}
                  disabled={saving || !editTitle.trim() || !!temporalError}
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  <span className="text-[10px] font-semibold uppercase tracking-wider">{saving ? "Sauvegarde…" : "Enregistrer"}</span>
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
              className="bg-red-600 hover:bg-red-700"
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
      {/* Room sub-drawer */}
      {roomDrawerItem && (
        <RoomDrawer
          open={!!roomDrawerItem}
          onOpenChange={(v) => { if (!v) setRoomDrawerItem(null); }}
          assetId={roomDrawerItem.assetId}
          room={roomDrawerItem.room}
          onRefresh={() => setRoomDrawerItem(null)}
        />
      )}

      {/* Equipment sub-drawer */}
      {equipmentDrawerItem && (
        <EquipmentDrawer
          open={!!equipmentDrawerItem}
          onOpenChange={(v) => { if (!v) setEquipmentDrawerItem(null); }}
          assetId={equipmentDrawerItem.assetId}
          equipment={equipmentDrawerItem.equipment}
          substructures={[]}
          onRefresh={() => setEquipmentDrawerItem(null)}
        />
      )}
    </>
  );
}
