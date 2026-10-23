"use client"

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { FileText, ChevronRight, Clock, CheckCircle2, AlertCircle, CalendarDays, LayoutGrid, Wrench, Download, Package, RefreshCw } from 'lucide-react';
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
import { exportCodeLabel } from '@/services/exports/catalog';

const AgendaItemDrawer = dynamic(
  () => import('@/components/agenda/AgendaItemDrawer').then(m => ({ default: m.AgendaItemDrawer })),
  { ssr: false }
);

const DocumentDrawer = dynamic(
  () => import('@/components/assets/DocumentDrawer').then(m => ({ default: m.DocumentDrawer })),
  { ssr: false }
);

import type { DocumentDrawerItem } from '@/components/assets/DocumentDrawer';
import { OCCUPANCY_USAGE_LABELS } from '@/lib/assets/occupancy';
import { displayDocumentTitle } from '@/lib/documents/document-title-rules';
import type { TimelineEntry } from '@/services/agenda/timeline/model';
import {
  AssetTimelineList, TimelineModeSwitch, useAssetTimeline,
  type TimelineOpenRequest, type TimelinePageInfo,
} from '@/components/assets/timeline/AssetTimeline';

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
  /** Lot 84C : première page de la Timeline, mode « Regroupée » (§13.2). */
  timeline: TimelineEntry[];
  timelinePage?: TimelinePageInfo;
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
const OCCUPANCY_LABELS = OCCUPANCY_USAGE_LABELS;
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

// Libellés des dossiers : catalogue V12 (anciens codes compris).


export function AssetOverviewTab({ assetId, onTabChange, readOnly = false }: Props) {
  const [data, setData] = useState<OverviewData | null>(null);
  /** Motif d'indisponibilité — distinct d'un échec technique. */
  const [motifIndisponible, setMotifIndisponible] =
    useState<'ARCHIVED' | 'LOCKED' | 'ERREUR' | null>(null);
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
      setMotifIndisponible(null);
    } catch (e) {
      // ══════════════════════════════════════════════════════════════════
      // « FAIL SILENTLY » TRANSFORMAIT UN REFUS EN PANNE
      //
      // La route rend un 403 `ASSET_UNAVAILABLE` quand le bien est archivé
      // ou verrouillé par l'offre — un refus délibéré, avec son motif.
      //
      // Le `catch` vide le confondait avec une erreur technique, et l'écran
      // affichait « Impossible de charger la vue d'ensemble » : l'utilisateur
      // croyait à une panne alors qu'il s'agissait d'une limite d'offre, et
      // n'avait aucun moyen de le savoir.
      // ══════════════════════════════════════════════════════════════════
      // `ApiClientError` porte `status`, `code` et `details` — la route
      // renvoie `{ error: 'ASSET_UNAVAILABLE', reason }`, repris dans
      // `details`.
      const err = e as { status?: number; details?: { reason?: string } };
      if (err?.status === 403) {
        setMotifIndisponible(err.details?.reason === 'ARCHIVED' ? 'ARCHIVED' : 'LOCKED');
      } else {
        console.error('[overview] chargement impossible :', e);
        setMotifIndisponible('ERREUR');
      }
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

  // Lot 84C — POINT D'APPEL UNIQUE des tiroirs depuis la Timeline (desktop et
  // mobile) : élément seul, groupe (son élément principal) ou élément d'un
  // groupe. Aujourd'hui : le tiroir Agenda EXISTANT de l'élément demandé. Un
  // tiroir dédié au groupe (chantier 84B) se branche ICI selon `req.context`.
  const openTimelineItem = useCallback(async (req: TimelineOpenRequest) => {
    const itemId = req.itemId;
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

  // Lot 84C : état de Timeline partagé par les variantes desktop et mobile
  // (une seule lecture) ; mode « Regroupée » à chaque ouverture (AC22, AC24).
  const timelineInitial = useMemo(
    () => (data ? { entries: data.timeline ?? [], page: data.timelinePage ?? null } : null),
    [data],
  );
  const [timeline, timelineActions] = useAssetTimeline(assetId, timelineInitial);

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-32 w-full" />)}
      </div>
    );
  }

  if (!data) {
    // Trois situations, trois suites différentes : réactiver, choisir une
    // offre, ou réessayer. Un message unique les envoyait toutes au même
    // endroit — nulle part.
    if (motifIndisponible === 'ARCHIVED') {
      return (
        <p className="text-muted-foreground text-sm">
          Ce bien est archivé. Réactivez-le pour consulter sa vue d&apos;ensemble.
        </p>
      );
    }
    if (motifIndisponible === 'LOCKED') {
      return (
        <p className="text-muted-foreground text-sm">
          Ce bien dépasse la limite de votre offre. Choisissez une offre pour y accéder de nouveau.
        </p>
      );
    }
    return (
      <p className="text-muted-foreground text-sm">
        Impossible de charger la vue d&apos;ensemble. Réessayez dans un instant.
      </p>
    );
  }

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
      <div className="hidden lg:flex flex-col w-60 shrink-0">
        <div className="flex items-center gap-2 mb-4">
          <CalendarDays className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium text-muted-foreground">Timeline</span>
        </div>
        <div className="mb-4">
          <TimelineModeSwitch mode={timeline.mode} onChange={timelineActions.setMode} />
        </div>
        <AssetTimelineList state={timeline} actions={timelineActions} variant="desktop" readOnly={readOnly}
          busyItemId={loadingItem} onOpenItem={openTimelineItem} />
      </div>

      {/* ── Right column: main content ──────────────────────────────────── */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* Counters — Documents & Agenda first, then Pièces/Équipements */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {([
            { label: 'Documents', count: data.counters.documents, tab: 'documents', icon: FileText },
            { label: 'Agenda',    count: data.counters.agenda ?? 0, tab: 'agenda',  icon: CalendarDays },
            ...(data.counters.rooms > 0       ? [{ label: 'Pièces',       count: data.counters.rooms,       tab: 'rooms',       icon: LayoutGrid }] : []),
            ...(data.counters.equipments > 0  ? [{ label: 'Équipements',  count: data.counters.equipments,  tab: 'equipments',  icon: Wrench }] : []),
          ] as { label: string; count: number; tab: string; icon: React.ElementType }[]).map(c => (
            <button
              key={c.tab}
              onClick={readOnly ? undefined : () => onTabChange(c.tab)}
              className={`rounded-[12px] bg-card border border-border px-2 py-2 flex flex-row items-center gap-2 transition-colors ${readOnly ? 'cursor-default' : 'hover:border-[color:var(--accent)]'}`}
            >
              {/* Charte : pictogramme pétrole dans une tuile brume (même ton pour tous les compteurs). */}
              <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 bg-[color:var(--accent-soft)]">
                <c.icon className="w-3.5 h-3.5 text-[color:var(--accent)]" />
              </div>
              <div className="flex flex-col items-start min-w-0">
                <span className="text-[12px] font-semibold text-muted-foreground leading-none mb-1">{c.label}</span>
                <span className="text-lg font-bold tabular-nums leading-none">{c.count}</span>
              </div>
            </button>
          ))}
        </div>

        {/* Bloc famille */}
        {hasFamily && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>
                {'Caractéristiques'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <FamilyBlock category={data.asset.category} kc={data.asset.keyCharacteristics ?? {}} asset={data.asset} />
            </CardContent>
          </Card>
        )}

        {/* Timeline mobile (lg: hidden) — même état, même point d'appel des tiroirs. */}
        {(timeline.entries.length > 0 || timeline.mode === 'detailed') && (
          <Card className="lg:hidden">
            <CardHeader className="pb-3 flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2">
                <CalendarDays className="w-4 h-4 text-muted-foreground" />
                Timeline
              </CardTitle>
              <TimelineModeSwitch mode={timeline.mode} onChange={timelineActions.setMode} />
            </CardHeader>
            <CardContent>
              <AssetTimelineList state={timeline} actions={timelineActions} variant="mobile" readOnly={readOnly}
                busyItemId={loadingItem} onOpenItem={openTimelineItem} />
            </CardContent>
          </Card>
        )}

        {/* Documents récents — masqués en mode lecture seule */}
        {!readOnly && (
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle>Documents récents</CardTitle>
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
                      <span className="flex-1 truncate">{displayDocumentTitle(doc, '')}</span>
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
            <CardTitle>Exports récents</CardTitle>
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
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-[color:var(--text-success)] flex-shrink-0" />
                    : exp.status === 'error'
                    ? <AlertCircle className="w-3.5 h-3.5 text-[color:var(--danger)] flex-shrink-0" />
                    : <Clock className="w-3.5 h-3.5 text-[color:var(--accent)] flex-shrink-0 animate-pulse" />}
                  <span className="flex-1 truncate text-xs">
                    {exportCodeLabel(exp.exportType)}
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
