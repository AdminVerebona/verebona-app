"use client"

import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Calendar, Bell, FileText, ChevronRight, Clock, CheckCircle2, AlertCircle, CalendarDays, LayoutGrid, Wrench, Download, Package, RefreshCw } from 'lucide-react';
import {
  DEVICE_TYPE_LABELS,
  SPORT_TYPE_LABELS,
  HOME_ITEM_TYPE_LABELS,
  OBJECT_CATEGORY_LABELS,
} from '@/types/domain';
import { apiClient } from '@/lib/api-client';
import dynamic from 'next/dynamic';
import type { AgendaItemFull } from '@/services/agenda/AgendaQueryService';
import { DOCUMENT_TYPE_LABELS as DOC_TYPE_LABELS } from '@/lib/document-type-constants';

const AgendaItemDrawer = dynamic(
  () => import('@/components/agenda/AgendaItemDrawer').then(m => ({ default: m.AgendaItemDrawer })),
  { ssr: false }
);

const DocumentDrawer = dynamic(
  () => import('@/components/assets/DocumentDrawer').then(m => ({ default: m.DocumentDrawer })),
  { ssr: false }
);

import type { DocumentDrawerItem } from '@/components/assets/DocumentDrawer';

interface TimelineItem {
  itemType: 'event' | 'reminder' | 'agenda';
  id: string;
  title: string;
  effectiveDate: string | null;
  status?: string;
  deadlineType?: string;
  isDone: boolean;
  isOverdue: boolean;
}

interface OverviewData {
  asset: {
    id: number;
    name: string;
    category: string;
    subtype?: string | null;
    objectCategory?: string | null;
    objectDetails?: Record<string, unknown>;
    status: string;
    keyCharacteristics: Record<string, unknown>;
    purchaseDate?: string | null;
    purchasePriceCents?: number | null;
    generalCondition?: string | null;
    estimatedValueCents?: number | null;
    warrantyEndDate?: string | null;
    mileageOrHours?: number | null;
    lastMaintenanceDate?: string | null;
    registrationNumber?: string | null;
    address?: string | null;
    city?: string | null;
  };
  timeline: TimelineItem[];
  documentsPreview: Array<{
    id: number;
    originalFilename: string;
    retainedTitle?: string | null;
    documentType: string;
    documentDate: string | null;
  }>;
  counters: {
    documents: number;
    agenda: number;
    rooms: number;
    equipments: number;
    // legacy fields kept for backwards compat
    events?: number;
    reminders?: number;
  };
}

interface Props {
  assetId: number;
  onTabChange: (tab: string) => void;
  readOnly?: boolean;
}

const formatDate = (d: string | null) => {
  if (!d) return null;
  try {
    return new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return d; }
};

const today = () => new Date().toISOString().split('T')[0];


function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}

const formatCents = (cents: number | null | undefined) => {
  if (!cents) return null;
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
};

type AssetFields = OverviewData['asset'];

const CONDITION_LABELS: Record<string, string> = { NEUF: 'Neuf', BON: 'Bon', MOYEN: 'Moyen', MAUVAIS: 'Mauvais' };
const OCCUPANCY_LABELS: Record<string, string> = {
  RESIDENCE_PRINCIPALE: 'Résidence principale',
  RESIDENCE_SECONDAIRE: 'Résidence secondaire',
  LOCATIF: 'Locatif',
  VACANT: 'Vacant',
};
const FUEL_LABELS: Record<string, string> = {
  ESSENCE: 'Essence', DIESEL: 'Diesel', ELECTRIQUE: 'Électrique',
  HYBRIDE: 'Hybride', GPL: 'GPL', AUTRE: 'Autre',
};

// Subtypes that do NOT have a motor / fuel
const NON_MOTORIZED_VEHICULE = new Set(['vélo', 'velo', 'VTT', 'vtt', 'trottinette']);
// Subtypes that use hours instead of km
const HOUR_BASED_VEHICULE = new Set(['bateau', 'quad', 'tondeuse']);

function FamilyBlock({ category, kc, asset }: { category: string; kc: Record<string, unknown>; asset: AssetFields }) {
  const subtype = (asset.subtype ?? '').toLowerCase();

  if (category === 'IMMOBILIER') {
    const addressLine = [kc.address1 ?? asset.address, kc.city ?? asset.city].filter(Boolean).join(', ');
    const acquisitionDate = kc.acquisitionDate ? String(kc.acquisitionDate) : null;
    const acquisitionPrice = kc.acquisitionPrice ? Number(kc.acquisitionPrice) : (asset.purchasePriceCents ? asset.purchasePriceCents / 100 : null);
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
        {!!kc.livingArea && <KV label="Surface habitable" value={`${String(kc.livingArea)} m²`} />}
        {!!kc.landArea && <KV label="Surface terrain" value={`${String(kc.landArea)} m²`} />}
        {!!kc.roomCount && <KV label="Pièces" value={String(kc.roomCount)} />}
        {!!kc.bedroomCount && <KV label="Chambres" value={String(kc.bedroomCount)} />}
        {!!kc.constructionYear && <KV label="Année de construction" value={String(kc.constructionYear)} />}
        {!!kc.generalCondition && <KV label="État général" value={CONDITION_LABELS[String(kc.generalCondition)] ?? String(kc.generalCondition)} />}
        {!!kc.dpeClass && <KV label="DPE" value={<Badge variant="outline">{String(kc.dpeClass)}</Badge>} />}
        {!!kc.gesClass && <KV label="GES" value={<Badge variant="outline">{String(kc.gesClass)}</Badge>} />}
        {!!kc.heatingType && <KV label="Chauffage" value={String(kc.heatingType)} />}
        {!!kc.occupancyUsage && <KV label="Usage" value={OCCUPANCY_LABELS[String(kc.occupancyUsage)] ?? String(kc.occupancyUsage)} />}
        {!!kc.monthlyRent && <KV label="Loyer mensuel" value={`${Number(kc.monthlyRent).toLocaleString('fr-FR')} €`} />}
        {!!addressLine && <KV label="Adresse" value={addressLine} />}
        {!!acquisitionDate && <KV label="Date d'achat" value={formatDate(acquisitionDate)} />}
        {!!acquisitionPrice && <KV label="Prix d'achat" value={`${acquisitionPrice.toLocaleString('fr-FR')} €`} />}
        {!!(asset.estimatedValueCents ?? kc.estimatedValue) && (
          <KV label="Valeur estimée" value={asset.estimatedValueCents ? formatCents(asset.estimatedValueCents)! : `${Number(kc.estimatedValue).toLocaleString('fr-FR')} €`} />
        )}
      </div>
    );
  }

  if (category === 'VEHICULE') {
    const isNonMotorized = NON_MOTORIZED_VEHICULE.has(subtype);
    const isHourBased = HOUR_BASED_VEHICULE.has(subtype);
    const mileage = kc.mileage ?? (asset.mileageOrHours != null ? asset.mileageOrHours : null);
    const mileageUnit = isHourBased ? 'h' : String(kc.mileageUnit ?? 'km');
    const mileageLabel = isHourBased ? 'Heures' : 'Kilométrage';
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
        {!!kc.make && <KV label="Marque / Modèle" value={`${String(kc.make)}${kc.model ? ` ${String(kc.model)}` : ''}`} />}
        {!!kc.year && <KV label="Année" value={String(kc.year)} />}
        {!!asset.registrationNumber && !isNonMotorized && <KV label="Immatriculation" value={asset.registrationNumber} />}
        {!!kc.vin && !isNonMotorized && <KV label="VIN" value={String(kc.vin)} />}
        {!!mileage && <KV label={mileageLabel} value={`${Number(mileage).toLocaleString('fr-FR')} ${mileageUnit}`} />}
        {!!kc.fuelType && !isNonMotorized && <KV label="Carburant" value={FUEL_LABELS[String(kc.fuelType)] ?? String(kc.fuelType)} />}
        {!!kc.powerKw && !isNonMotorized && <KV label="Puissance" value={`${String(kc.powerKw)} kW`} />}
        {!!kc.seats && <KV label="Places" value={String(kc.seats)} />}
        {!!kc.nextInspection && !isNonMotorized && <KV label="Prochain CT" value={formatDate(String(kc.nextInspection))} />}
        {!!asset.lastMaintenanceDate && <KV label="Dernier entretien" value={formatDate(asset.lastMaintenanceDate)} />}
        {!!asset.purchaseDate && <KV label="Date d'achat" value={formatDate(asset.purchaseDate)} />}
        {!!asset.purchasePriceCents && <KV label="Prix d'achat" value={formatCents(asset.purchasePriceCents)!} />}
        {!!(asset.estimatedValueCents ?? kc.estimatedValue) && (
          <KV label="Valeur estimée" value={asset.estimatedValueCents ? formatCents(asset.estimatedValueCents)! : `${Number(kc.estimatedValue).toLocaleString('fr-FR')} €`} />
        )}
      </div>
    );
  }

  // OBJECT — driven by objectCategory + objectDetails
  if (category === 'OBJECT') {
    const od = asset.objectDetails ?? {};
    const objCat = asset.objectCategory ?? String(kc.objectCategory ?? '');
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
        {!!objCat && <KV label="Catégorie" value={OBJECT_CATEGORY_LABELS[objCat as keyof typeof OBJECT_CATEGORY_LABELS] ?? objCat} />}
        {/* Tech fields */}
        {objCat === 'OBJECT_CATEGORY_TECH' && !!od.deviceType && (
          <KV label="Type" value={DEVICE_TYPE_LABELS[od.deviceType as keyof typeof DEVICE_TYPE_LABELS] ?? String(od.deviceType)} />
        )}
        {/* Sport fields */}
        {objCat === 'OBJECT_CATEGORY_SPORT' && !!od.sportType && (
          <KV label="Type" value={SPORT_TYPE_LABELS[od.sportType as keyof typeof SPORT_TYPE_LABELS] ?? String(od.sportType)} />
        )}
        {/* Home fields */}
        {objCat === 'OBJECT_CATEGORY_HOME' && !!od.homeItemType && (
          <KV label="Type" value={HOME_ITEM_TYPE_LABELS[od.homeItemType as keyof typeof HOME_ITEM_TYPE_LABELS] ?? String(od.homeItemType)} />
        )}
        {/* Shared object fields */}
        {!!(od.brand ?? kc.brand) && <KV label="Marque" value={String(od.brand ?? kc.brand)} />}
        {!!(od.model ?? kc.modelName) && <KV label="Modèle" value={String(od.model ?? kc.modelName)} />}
        {!!(od.serialNumber ?? kc.serialNumber) && <KV label="N° de série" value={String(od.serialNumber ?? kc.serialNumber)} />}
        {objCat === 'OBJECT_CATEGORY_SPORT' && !!(od.sizeOrDimensions ?? kc.dimensions) && (
          <KV label="Dimensions" value={String(od.sizeOrDimensions ?? kc.dimensions)} />
        )}
        {!!(od.warrantyEndDate ?? asset.warrantyEndDate) && (
          <KV label="Fin de garantie" value={formatDate(String(od.warrantyEndDate ?? asset.warrantyEndDate))} />
        )}
        {!!kc.condition && <KV label="État" value={CONDITION_LABELS[String(kc.condition)] ?? String(kc.condition)} />}
        {!!asset.purchaseDate && <KV label="Date d'achat" value={formatDate(asset.purchaseDate)} />}
        {!!asset.purchasePriceCents && <KV label="Prix d'achat" value={formatCents(asset.purchasePriceCents)!} />}
        {!!asset.estimatedValueCents && <KV label="Valeur estimée" value={formatCents(asset.estimatedValueCents)!} />}
      </div>
    );
  }

  // MATERIEL_PRO
  if (category === 'MATERIEL_PRO') {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
        {!!kc.brand && <KV label="Marque" value={String(kc.brand)} />}
        {!!kc.modelName && <KV label="Modèle" value={String(kc.modelName)} />}
        {!!kc.serialNumber && <KV label="N° de série" value={String(kc.serialNumber)} />}
        {!!kc.condition && <KV label="État" value={CONDITION_LABELS[String(kc.condition)] ?? String(kc.condition)} />}
        {!!asset.purchaseDate && <KV label="Date d'achat" value={formatDate(asset.purchaseDate)} />}
        {!!asset.purchasePriceCents && <KV label="Prix d'achat" value={formatCents(asset.purchasePriceCents)!} />}
        {!!asset.warrantyEndDate && <KV label="Fin de garantie" value={formatDate(asset.warrantyEndDate)} />}
        {!!asset.estimatedValueCents && <KV label="Valeur estimée" value={formatCents(asset.estimatedValueCents)!} />}
      </div>
    );
  }

  // AUTRE — generic fallback
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
      {!!asset.generalCondition && <KV label="État" value={CONDITION_LABELS[asset.generalCondition] ?? asset.generalCondition} />}
      {!!asset.purchaseDate && <KV label="Date d'achat" value={formatDate(asset.purchaseDate)} />}
      {!!asset.purchasePriceCents && <KV label="Prix d'achat" value={formatCents(asset.purchasePriceCents)!} />}
      {!!asset.warrantyEndDate && <KV label="Fin de garantie" value={formatDate(asset.warrantyEndDate)} />}
      {!!asset.estimatedValueCents && <KV label="Valeur estimée" value={formatCents(asset.estimatedValueCents)!} />}
    </div>
  );
}

interface RecentExport {
  id: number;
  exportType: string;
  status: string;
  completedAt: string | null;
  downloadUrl: string | null;
  downloadZipUrl: string | null;
}

const EXPORT_TYPE_LABELS_OVERVIEW: Record<string, string> = {
  CIL_REGLEMENTAIRE: 'CIL Réglementaire',
  DOSSIER_VENTE: 'Dossier de vente',
  ASSURANCE_ESTIMATION: 'Assurance — Estimation',
  ASSURANCE_INDEMNISATION: 'Assurance — Indemnisation',
  EXPORT_BRUT: 'Export données brutes',
};

export function AssetOverviewTab({ assetId, onTabChange, readOnly = false }: Props) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [drawerItem, setDrawerItem] = useState<AgendaItemFull | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loadingItem, setLoadingItem] = useState<string | null>(null);
  const [docDrawerDoc, setDocDrawerDoc] = useState<DocumentDrawerItem | null>(null);
  const [docDrawerOpen, setDocDrawerOpen] = useState(false);
  const [recentExports, setRecentExports] = useState<RecentExport[]>([]);

  const load = useCallback(async (bustCache = false) => {
    setLoading(true);
    try {
      const [res, exportsRes] = await Promise.all([
        apiClient.get<OverviewData>(`/api/assets/${assetId}/overview`, { useCache: !bustCache }),
        apiClient.get<{ exports: RecentExport[] }>(`/api/assets/${assetId}/exports?limit=3`, { useCache: !bustCache }).catch(() => ({ exports: [] as RecentExport[] })),
      ]);
      setData(res);
      setRecentExports(exportsRes.exports ?? []);
    } catch {
      // fail silently
    } finally {
      setLoading(false);
    }
  }, [assetId]);

  useEffect(() => { load(); }, [load]);

  // Refresh immediately when any agenda item is mutated (status change, edit, delete)
  useEffect(() => {
    const handler = () => load(true);
    window.addEventListener('agenda-mutated', handler);
    return () => window.removeEventListener('agenda-mutated', handler);
  }, [load]);

  const openTimelineItem = useCallback(async (itemId: string) => {
    setLoadingItem(itemId);
    try {
      const res = await apiClient.get<{ item: AgendaItemFull }>(`/api/agenda/${itemId}`);
      setDrawerItem(res.item);
      setDrawerOpen(true);
    } catch {
      // fail silently — fallback to agenda tab
      onTabChange('agenda');
    } finally {
      setLoadingItem(null);
    }
  }, [onTabChange]);

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-32 w-full" />)}
      </div>
    );
  }

  if (!data) {
    return <p className="text-muted-foreground text-sm">Impossible de charger la vue d'ensemble.</p>;
  }

  const td = today();

  // Sort timeline: past (done or overdue) DESC, then upcoming ASC
  const sortedTimeline = [...data.timeline].sort((a, b) => {
    if (!a.effectiveDate && !b.effectiveDate) return 0;
    if (!a.effectiveDate) return 1;
    if (!b.effectiveDate) return -1;
    return b.effectiveDate < a.effectiveDate ? -1 : b.effectiveDate > a.effectiveDate ? 1 : 0;
  });

  const hasFamily = (() => {
    const kc = data.asset.keyCharacteristics ?? {};
    const od = data.asset.objectDetails ?? {};
    const a = data.asset;
    if (a.category === 'IMMOBILIER') return !!(kc.livingArea || kc.landArea || kc.roomCount || kc.constructionYear || kc.generalCondition || kc.dpeClass || kc.gesClass || kc.heatingType || kc.occupancyUsage || kc.monthlyRent || kc.acquisitionDate || kc.acquisitionPrice || a.purchasePriceCents || a.estimatedValueCents || kc.estimatedValue || a.address || a.city);
    if (a.category === 'VEHICULE') return !!(kc.make || kc.mileage || kc.nextInspection || kc.fuelType || kc.estimatedValue || a.registrationNumber || a.mileageOrHours || a.purchaseDate || a.lastMaintenanceDate || kc.year);
    if (a.category === 'OBJECT') return !!(a.objectCategory || od.brand || od.model || od.deviceType || od.sportType || od.homeItemType || kc.brand || a.purchaseDate || a.purchasePriceCents);
    if (a.category === 'MATERIEL_PRO') return !!(kc.brand || kc.modelName || kc.serialNumber || a.purchaseDate || a.purchasePriceCents);
    return !!(a.generalCondition || a.purchaseDate || a.purchasePriceCents || a.warrantyEndDate || a.estimatedValueCents);
  })();

  return (
    <div className="flex gap-6 min-w-0 overflow-hidden">
      {/* ── Left column: vertical timeline (desktop only) ───────────────── */}
      <div className="hidden lg:flex flex-col w-52 shrink-0">
        <div className="flex items-center gap-2 mb-4">
          <CalendarDays className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium text-muted-foreground">Timeline</span>
        </div>
        {sortedTimeline.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucune entrée</p>
        ) : (
          <div className="relative">
            {/* Vertical line */}
            <div className="absolute left-[7px] top-2 bottom-2 w-px bg-border" />
            <div className="space-y-0">
              {sortedTimeline.slice(0, 12).map((item) => {
                const isOverdue = item.isOverdue;
                const isDone = item.isDone;
                const isLoading = loadingItem === item.id;
                const dotColor = isOverdue
                  ? 'bg-destructive'
                  : isDone
                  ? 'bg-green-500'
                  : 'bg-[#3b82f6]';
                return (
                  <div key={`${item.itemType}-${item.id}`} className="relative flex gap-3 pb-5">
                    {/* Dot */}
                    <div className={`relative z-10 mt-1 w-3.5 h-3.5 rounded-full border-2 border-background shrink-0 ${dotColor} ${isLoading ? 'animate-pulse' : ''}`} />
                    <button
                      className={`flex-1 min-w-0 -mt-0.5 text-left transition-opacity ${readOnly ? 'cursor-default' : 'hover:opacity-70'}`}
                      onClick={readOnly ? undefined : () => openTimelineItem(item.id)}
                      disabled={isLoading || readOnly}
                    >
                      {item.effectiveDate && (
                        <p className="text-[10px] text-muted-foreground leading-none mb-0.5">
                          {formatDate(item.effectiveDate)}
                        </p>
                      )}
                      <p className={`text-xs font-medium leading-snug truncate ${isDone ? 'text-muted-foreground' : 'text-foreground'}`}>
                        {item.title}
                      </p>
                    </button>
                  </div>
                );
              })}
              {sortedTimeline.length > 12 && !readOnly && (
                <button
                  onClick={() => onTabChange('agenda')}
                  className="relative flex gap-3 items-center text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <div className="relative z-10 w-3.5 h-3.5 rounded-full border-2 border-border bg-background shrink-0" />
                  <span>+{sortedTimeline.length - 12} entrées</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Right column: main content ──────────────────────────────────── */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* Counters — Documents & Agenda first, then Pièces/Équipements */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {([
            { label: 'Documents', count: data.counters.documents, tab: 'documents', icon: FileText,     color: '#a78bfa', bg: 'rgba(167,139,250,0.12)' },
            { label: 'Agenda',    count: data.counters.agenda ?? 0, tab: 'agenda',  icon: CalendarDays, color: '#22c55e', bg: 'rgba(34,197,94,0.12)'   },
            ...(data.counters.rooms > 0       ? [{ label: 'Pièces',       count: data.counters.rooms,       tab: 'rooms',       icon: LayoutGrid, color: '#3b82f6', bg: 'rgba(59,130,246,0.12)'  }] : []),
            ...(data.counters.equipments > 0  ? [{ label: 'Équipements',  count: data.counters.equipments,  tab: 'equipments',  icon: Wrench,     color: '#f59e0b', bg: 'rgba(245,158,11,0.12)'  }] : []),
          ] as { label: string; count: number; tab: string; icon: React.ElementType; color: string; bg: string }[]).map(c => (
            <button
              key={c.tab}
              onClick={readOnly ? undefined : () => onTabChange(c.tab)}
              className={`rounded-lg bg-card border border-border px-2 py-2 flex flex-row items-center gap-2 transition-all ${readOnly ? 'cursor-default' : 'hover:brightness-110'}`}
            >
              <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0" style={{ background: c.bg }}>
                <c.icon className="w-3.5 h-3.5" style={{ color: c.color }} />
              </div>
              <div className="flex flex-col items-start min-w-0">
                <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground leading-none mb-0.5">{c.label}</span>
                <span className="text-lg font-bold tabular-nums leading-none">{c.count}</span>
              </div>
            </button>
          ))}
        </div>

        {/* Bloc famille */}
        {hasFamily && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                {'Caractéristiques'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <FamilyBlock category={data.asset.category} kc={data.asset.keyCharacteristics ?? {}} asset={data.asset} />
            </CardContent>
          </Card>
        )}

        {/* Timeline mobile (lg: hidden) */}
        {sortedTimeline.length > 0 && (
          <Card className="lg:hidden">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarDays className="w-4 h-4 text-muted-foreground" />
                Timeline
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="relative">
                <div className="absolute left-[7px] top-2 bottom-2 w-px bg-border" />
                <div className="space-y-0">
                  {sortedTimeline.slice(0, 10).map((item) => {
                    const dotColor = item.isOverdue
                      ? 'bg-destructive'
                      : item.isDone
                      ? 'bg-green-500'
                      : 'bg-[#3b82f6]';
                    const isLoadingDot = loadingItem === item.id;
                    return (
                      <div key={`mob-${item.itemType}-${item.id}`} className="relative flex gap-3 pb-4">
                        <div className={`relative z-10 mt-1 w-3.5 h-3.5 rounded-full border-2 border-background shrink-0 ${dotColor} ${isLoadingDot ? 'animate-pulse' : ''}`} />
                        <button
                          className={`flex-1 min-w-0 -mt-0.5 text-left transition-opacity ${readOnly ? 'cursor-default' : 'hover:opacity-70'}`}
                          onClick={readOnly ? undefined : () => openTimelineItem(item.id)}
                          disabled={isLoadingDot || readOnly}
                        >
                          {item.effectiveDate && (
                            <p className="text-[10px] text-muted-foreground leading-none mb-0.5">
                              {formatDate(item.effectiveDate)}
                            </p>
                          )}
                          <p className={`text-xs font-medium leading-snug ${item.isDone ? 'text-muted-foreground' : 'text-foreground'}`}>
                            {item.title}
                          </p>
                        </button>
                      </div>
                    );
                  })}
                  {sortedTimeline.length > 10 && !readOnly && (
                    <button
                      onClick={() => onTabChange('agenda')}
                      className="relative flex gap-3 items-center text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <div className="relative z-10 w-3.5 h-3.5 rounded-full border-2 border-border bg-background shrink-0" />
                      <span>+{sortedTimeline.length - 10} entrées</span>
                    </button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Documents récents — masqués en mode lecture seule */}
        {!readOnly && (
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-base">Documents récents</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => onTabChange('documents')}>
                Voir tout <ChevronRight className="w-3 h-3 ml-1" />
              </Button>
            </CardHeader>
            <CardContent>
              {data.documentsPreview.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucun document</p>
              ) : (
                <div className="space-y-2">
                  {data.documentsPreview.map(doc => (
                    <div
                      key={doc.id}
                      className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1 py-0.5 transition-colors"
                      onClick={() => {
                        setDocDrawerDoc({ id: doc.id, originalFilename: doc.originalFilename, mimeType: '', documentType: doc.documentType, documentDate: doc.documentDate, assetId: assetId });
                        setDocDrawerOpen(true);
                      }}
                    >
                      <FileText className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <span className="flex-1 truncate">{doc.retainedTitle || doc.originalFilename}</span>
                      {doc.documentType && (
                        <Badge variant="outline" className="text-xs">
                          {DOC_TYPE_LABELS[doc.documentType] ?? doc.documentType}
                        </Badge>
                      )}
                      {doc.documentDate && (
                        <span className="text-xs text-muted-foreground flex-shrink-0">
                          {formatDate(doc.documentDate)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── Exports récents ── */}
        {recentExports.length > 0 && !readOnly && (
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-semibold">Exports récents</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground h-7"
              onClick={() => onTabChange('exports')}
            >
              Voir tous <ChevronRight className="w-3 h-3 ml-1" />
            </Button>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-1.5">
              {recentExports.map(exp => (
                <div key={exp.id} className="flex items-center gap-2 text-sm py-1">
                  {exp.status === 'ready'
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                    : exp.status === 'error'
                    ? <AlertCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                    : <Clock className="w-3.5 h-3.5 text-blue-400 flex-shrink-0 animate-pulse" />}
                  <span className="flex-1 truncate text-xs">
                    {EXPORT_TYPE_LABELS_OVERVIEW[exp.exportType] ?? exp.exportType}
                  </span>
                  {exp.completedAt && (
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      {new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' }).format(new Date(exp.completedAt))}
                    </span>
                  )}
                  {exp.status === 'ready' && exp.downloadUrl && (
                    <a href={exp.downloadUrl} target="_blank" rel="noopener noreferrer" title="PDF">
                      <Button size="icon" variant="ghost" className="h-6 w-6">
                        <Download className="w-3 h-3" />
                      </Button>
                    </a>
                  )}
                  {exp.status === 'ready' && exp.downloadZipUrl && (
                    <a href={exp.downloadZipUrl} target="_blank" rel="noopener noreferrer" title="ZIP">
                      <Button size="icon" variant="ghost" className="h-6 w-6">
                        <Package className="w-3 h-3" />
                      </Button>
                    </a>
                  )}
                  {exp.status === 'error' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs text-destructive px-2"
                      onClick={() => onTabChange('exports')}
                    >
                      <RefreshCw className="w-3 h-3 mr-1" />
                      Réessayer
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        )}
      </div>

      {/* Agenda item drawer */}
      <AgendaItemDrawer
        item={drawerItem}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setDrawerItem(null); }}
        onMutated={() => { setDrawerOpen(false); setDrawerItem(null); load(true); }}
        onOpenDocument={(fileId) => {
          setDrawerOpen(false);
          setDrawerItem(null);
          window.dispatchEvent(new CustomEvent('open-document-drawer', { detail: { docId: fileId } }));
        }}
      />

      {/* Document drawer — désactivé en mode lecture seule */}
      {!readOnly && (
        <DocumentDrawer
          open={docDrawerOpen}
          onOpenChange={(v) => { setDocDrawerOpen(v); if (!v) setDocDrawerDoc(null); }}
          document={docDrawerDoc}
          onRefresh={() => { load(); }}
        />
      )}
    </div>
  );
}

function TimelineRow({ item, muted }: { item: TimelineItem; muted?: boolean }) {
  const icon = (item.itemType === 'event' || item.itemType === 'agenda')
    ? <Calendar className="w-4 h-4 flex-shrink-0" />
    : <Bell className="w-4 h-4 flex-shrink-0" />;

  const stateIcon = item.isOverdue
    ? <AlertCircle className="w-3 h-3 text-destructive" />
    : item.isDone
    ? <CheckCircle2 className="w-3 h-3 text-green-500" />
    : <Clock className="w-3 h-3 text-muted-foreground" />;

  return (
    <div className={`flex items-center gap-2 text-sm ${muted ? 'opacity-60' : ''}`}>
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1 truncate">{item.title}</span>
      {stateIcon}
      {item.effectiveDate && (
        <span className="text-xs text-muted-foreground flex-shrink-0">
          {formatDate(item.effectiveDate)}
        </span>
      )}
    </div>
  );
}
