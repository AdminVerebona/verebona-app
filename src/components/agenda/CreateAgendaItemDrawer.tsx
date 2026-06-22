"use client";

import { useState, useEffect } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
import { DatePicker } from "@/components/ui/date-picker";
import { Info, Grid2X2, Wrench, ChevronDown, X, Check, Loader2 } from "lucide-react";
import { TimePicker } from "@/components/ui/time-picker";
import { apiClient } from "@/lib/api-client";
import { toast } from "sonner";
import { assetSupportsStructuralFeatures } from "@/types/domain";

interface Asset {
  id: number;
  name: string;
  category: string;
  subtype?: string;
}
interface Substructure {
  id: number;
  name: string;
}
interface Equipment {
  id: number;
  name: string;
  substructureId?: number | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onMutated: () => void;
  prefilledAssetId?: number;
  prefilledFileId?: number;
  prefilledSubstructureId?: number;
  prefilledEquipmentId?: number;
  prefilledTitle?: string;
  prefilledStartDate?: string;
}

export function CreateAgendaItemDrawer({
  open,
  onClose,
  onMutated,
  prefilledAssetId,
  prefilledFileId,
  prefilledSubstructureId,
  prefilledEquipmentId,
  prefilledTitle,
  prefilledStartDate,
}: Props) {
  const [title, setTitle] = useState(prefilledTitle ?? "");
  const [description, setDescription] = useState("");
  const [startDate, setStartDate] = useState(prefilledStartDate ?? "");
  const [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [manualStatus, setManualStatus] = useState<string>("null");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEndDate, setShowEndDate] = useState(false);

  // Asset selection — multi select
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedAssetIds, setSelectedAssetIds] = useState<number[]>(
    prefilledAssetId ? [prefilledAssetId] : [],
  );

  // Rooms & equipments per asset — preloaded on open
  const [assetDetails, setAssetDetails] = useState<
    Record<number, { substructures: Substructure[]; equipments: Equipment[] }>
  >({});
  const [selectedSubstructureIds, setSelectedSubstructureIds] = useState<
    number[]
  >(prefilledSubstructureId ? [prefilledSubstructureId] : []);
  const [selectedEquipmentIds, setSelectedEquipmentIds] = useState<number[]>(
    prefilledEquipmentId ? [prefilledEquipmentId] : [],
  );

  // Structural features shown when at least one selected asset is immobilier
  const selectedImmoAssets = assets.filter(
    (a) =>
      selectedAssetIds.includes(a.id) && assetSupportsStructuralFeatures(a),
  );
  const showStructural = selectedImmoAssets.length > 0;
  const substructures = selectedImmoAssets.flatMap(
    (a) => assetDetails[a.id]?.substructures ?? [],
  );
  const equipments = selectedImmoAssets.flatMap(
    (a) => assetDetails[a.id]?.equipments ?? [],
  );

  // Load assets list + their details on open
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
        const list: Asset[] = d.data ?? [];
        setAssets(list);
        // Preload details for all assets in parallel
        await Promise.all(
          list.map((asset) =>
            fetch(`/api/assets?id=${asset.id}`, {
              credentials: "include",
              headers,
            })
              .then((r) => (r.ok ? r.json() : {}))
              .then(
                (detail: {
                  substructures?: Substructure[];
                  equipments?: Equipment[];
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

  // Clear room/equipment selection when asset selection changes
  useEffect(() => {
    setSelectedSubstructureIds([]);
    setSelectedEquipmentIds([]);
  }, [selectedAssetIds.join(",")]);

  const hasContext =
    selectedAssetIds.length > 0 ||
    !!prefilledFileId ||
    selectedSubstructureIds.length > 0 ||
    selectedEquipmentIds.length > 0;

  // Apply prefilled values whenever they change (covers re-use of the same mounted drawer)
  useEffect(() => {
    if (!open) return;
    setTitle(prefilledTitle ?? "");
    setStartDate(prefilledStartDate ?? "");
    setSelectedAssetIds(prefilledAssetId ? [prefilledAssetId] : []);
    setSelectedSubstructureIds(prefilledSubstructureId ? [prefilledSubstructureId] : []);
    setSelectedEquipmentIds(prefilledEquipmentId ? [prefilledEquipmentId] : []);
  }, [open, prefilledTitle, prefilledStartDate, prefilledAssetId, prefilledSubstructureId, prefilledEquipmentId]);

  const reset = () => {
    setTitle(prefilledTitle ?? "");
    setDescription("");
    setStartDate(prefilledStartDate ?? "");
    setStartTime("");
    setEndDate("");
    setEndTime("");
    setManualStatus("null");
    setSelectedAssetIds(prefilledAssetId ? [prefilledAssetId] : []);
    setSelectedSubstructureIds(
      prefilledSubstructureId ? [prefilledSubstructureId] : [],
    );
    setSelectedEquipmentIds(prefilledEquipmentId ? [prefilledEquipmentId] : []);
    setAssetDetails({});
    setShowEndDate(false);
    setError(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const toggleSubstructure = (id: number) =>
    setSelectedSubstructureIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );

  const toggleEquipment = (id: number) =>
    setSelectedEquipmentIds((prev) =>
      prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id],
    );

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError("Le titre est requis");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiClient.post("/api/agenda", {
        title: title.trim(),
        description: description || null,
        startDate: startDate || null,
        startTime: startTime || null,
        endDate: endDate || null,
        endTime: endTime || null,
        manualStatus: manualStatus === "null" ? null : manualStatus,
        assetIds: selectedAssetIds,
        fileIds: prefilledFileId ? [prefilledFileId] : [],
        substructureIds: selectedSubstructureIds,
        equipmentIds: selectedEquipmentIds,
      });
      toast.success("Élément créé");
      window.dispatchEvent(new CustomEvent('agenda-mutated'));
      reset();
      onMutated();
      onClose();
    } catch (err: any) {
      setError(err?.message || "Erreur lors de la création");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={handleClose}>
      <SheetContent className="w-full sm:max-w-[480px] overflow-y-auto">
        <div className="px-6">
          <SheetHeader>
            <SheetTitle>Nouvel élément d'agenda</SheetTitle>
          </SheetHeader>

          <div className="mt-6 space-y-5">
            {/* Context warning — subtle */}
            {!hasContext && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Info className="h-3.5 w-3.5 shrink-0" />
                Sans bien associé, cet élément apparaîtra dans « À traiter ».
              </p>
            )}

            {/* Titre */}
            <div className="space-y-1.5">
              <Label>Titre *</Label>
              <Input
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setError(null);
                }}
                placeholder="Titre de l'élément"
              />
            </div>

            {/* Biens */}
            <div className="space-y-1.5">
              <Label>Bien(s) associé(s)</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="w-full flex items-center justify-between rounded-md border border-input input-field px-3 py-2 text-sm text-left hover:bg-input/40 transition-colors"
                  >
                    <span
                      className={
                        selectedAssetIds.length === 0
                          ? "text-muted-foreground"
                          : ""
                      }
                    >
                      {selectedAssetIds.length === 0
                        ? "Aucun bien sélectionné"
                        : selectedAssetIds.length === 1
                          ? (assets.find((a) => a.id === selectedAssetIds[0])
                              ?.name ?? "1 bien sélectionné")
                          : `${selectedAssetIds.length} biens sélectionnés`}
                    </span>
                    <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-64 p-2" align="start">
                  {assets.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-2 py-1">
                      Aucun bien disponible.
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {assets.map((asset) => (
                        <label
                          key={asset.id}
                          className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer"
                        >
                          <Checkbox
                            checked={selectedAssetIds.includes(asset.id)}
                            onCheckedChange={() =>
                              setSelectedAssetIds((prev) =>
                                prev.includes(asset.id)
                                  ? prev.filter((id) => id !== asset.id)
                                  : [...prev, asset.id],
                              )
                            }
                          />
                          <span className="text-sm">{asset.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </div>

            {/* Pièces */}
            {showStructural && (
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <Grid2X2 className="h-3.5 w-3.5 text-muted-foreground" />{" "}
                  Pièce(s) associée(s)
                </Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="w-full flex items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm text-left hover:bg-accent/30 transition-colors"
                    >
                      <span className="text-muted-foreground">
                        {selectedSubstructureIds.length === 0
                          ? "Aucune pièce"
                          : `${selectedSubstructureIds.length} pièce(s) sélectionnée(s)`}
                      </span>
                      <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64 p-2" align="start">
                    {substructures.length === 0 ? (
                      <p className="text-xs text-muted-foreground px-2 py-1">
                        Aucune pièce pour ce bien.
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {substructures.map((s) => (
                          <label
                            key={s.id}
                            className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer"
                          >
                            <Checkbox
                              checked={selectedSubstructureIds.includes(s.id)}
                              onCheckedChange={() => toggleSubstructure(s.id)}
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
            {showStructural && (
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <Wrench className="h-3.5 w-3.5 text-muted-foreground" />{" "}
                  Équipement(s) associé(s)
                </Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="w-full flex items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm text-left hover:bg-accent/30 transition-colors"
                    >
                      <span className="text-muted-foreground">
                        {selectedEquipmentIds.length === 0
                          ? "Aucun équipement"
                          : `${selectedEquipmentIds.length} équipement(s) sélectionné(s)`}
                      </span>
                      <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64 p-2" align="start">
                    {equipments.length === 0 ? (
                      <p className="text-xs text-muted-foreground px-2 py-1">
                        Aucun équipement pour ce bien.
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {equipments.map((e) => (
                          <label
                            key={e.id}
                            className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer"
                          >
                            <Checkbox
                              checked={selectedEquipmentIds.includes(e.id)}
                              onCheckedChange={() => toggleEquipment(e.id)}
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

            {/* Statut */}
            <div className="space-y-1.5">
              <Label>Statut</Label>
              <Select value={manualStatus} onValueChange={setManualStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="null">À venir</SelectItem>
                  <SelectItem value="realise">Réalisé</SelectItem>
                  <SelectItem value="annule">Annulé</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Description (optionnel)"
              />
            </div>

            {/* Dates */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Date début</Label>
                <DatePicker
                  value={startDate}
                  onChange={(v) => setStartDate(v)}
                  placeholder="jj/mm/aaaa"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Heure début</Label>
                <TimePicker
                  value={startTime}
                  onChange={(v) => setStartTime(v)}
                />
              </div>
            </div>

            {/* End date toggle */}
            {!showEndDate ? (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                onClick={() => setShowEndDate(true)}
              >
                + Ajouter une date de fin
              </button>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Date fin</Label>
                  <DatePicker
                    value={endDate}
                    onChange={(v) => setEndDate(v)}
                    placeholder="jj/mm/aaaa"
                    min={startDate || undefined}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Heure fin</Label>
                  <TimePicker
                    value={endTime}
                    onChange={(v) => setEndTime(v)}
                  />
                </div>
              </div>
            )}

            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>

          <div className="border-t pt-4 mt-6">
            <div className="flex items-stretch rounded-xl border border-border bg-muted/30 overflow-hidden">
              <button
                type="button"
                className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground"
                onClick={handleClose}
              >
                <X className="w-4 h-4" />
                <span className="text-[10px] font-semibold uppercase tracking-wider">Annuler</span>
              </button>
              <div className="w-px bg-border" />
              <button
                type="button"
                className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-primary/10 transition-colors text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                onClick={handleSubmit}
                disabled={saving || !title.trim()}
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                <span className="text-[10px] font-semibold uppercase tracking-wider">{saving ? "Création…" : "Créer"}</span>
              </button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
