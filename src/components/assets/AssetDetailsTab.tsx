"use client"

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { AssetDetailSection, type AiSuggestion, type FieldDef } from './AssetDetailSection';
import { ValuationHistoryDrawer } from './ValuationHistoryDrawer';
import { apiClient } from '@/lib/api-client';
import type { AssetDetail } from '@/types/asset-detail';
import { ChevronDown, ChevronUp, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  asset: AssetDetail;
  onRefresh: () => void;
  planType: 'freemium' | 'premium';
  readOnly?: boolean;
  highlightField?: string | null;
}

const IMMOBILIER_SUBTYPES = ['Maison', 'Appartement', 'Terrain', 'Local commercial', 'Garage'];
const VEHICULE_SUBTYPES = ['Vélo', 'Voiture', 'Camion', 'Moto'];

function getCommonFields(category: string): FieldDef[] {
  const subtypes = category === 'IMMOBILIER' ? IMMOBILIER_SUBTYPES
    : category === 'VEHICULE' ? VEHICULE_SUBTYPES
    : null;
  return [
    { key: 'name', label: 'Nom' },
    subtypes
      ? { key: 'subCategory', label: 'Sous-catégorie', type: 'select', options: subtypes.map(s => ({ value: s, label: s })) }
      : { key: 'subCategory', label: 'Sous-catégorie', readonly: true },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'acquisitionDate', label: 'Date d\'achat', type: 'date',
      ...(category === 'VEHICULE' ? { notApplicableWhen: (d: Record<string, unknown>) => ['LLD', 'LOA', 'PRET_GRATUIT'].includes(String(d.vehicleOwnershipStatus ?? '')) } : {}) },
    { key: 'acquisitionPrice', label: 'Prix d\'achat (€)', type: 'number',
      ...(category === 'VEHICULE' ? { notApplicableWhen: (d: Record<string, unknown>) => ['LLD', 'LOA', 'PRET_GRATUIT'].includes(String(d.vehicleOwnershipStatus ?? '')) } : {}) },
    ...(category === 'VEHICULE' ? [{ key: 'vehicleOwnershipStatus', label: 'Statut de détention', type: 'select' as const, options: [
      { value: 'PROPRIETAIRE',  label: 'Propriétaire' },
      { value: 'LLD',           label: 'Location longue durée (LLD)' },
      { value: 'LOA',           label: "Location avec option d'achat (LOA)" },
      { value: 'CREDIT',        label: 'Crédit auto' },
      { value: 'PRET_GRATUIT',  label: 'Prêt / utilisation gratuite' },
    ]}] : []),
    { key: 'notes', label: 'Notes', type: 'textarea' },
  ];
}

// Section field definitions per section key (common section uses getCommonFields() instead)
const SECTION_FIELDS: Record<string, FieldDef[]> = {
  location_identification: [
    { key: 'address1', label: 'Adresse' },
    { key: 'address2', label: 'Complément d\'adresse' },
    { key: 'postalCode', label: 'Code postal' },
    { key: 'city', label: 'Ville' },
    { key: 'country', label: 'Pays' },
    { key: 'cadastralRef', label: 'Référence cadastrale' },
    { key: 'lotNumber', label: 'Numéro de lot' },
    { key: 'floor', label: 'Étage' },
    { key: 'gpsCoords', label: 'Coordonnées GPS' },
  ],
  physical_characteristics: [
    { key: 'livingArea', label: 'Surface habitable (m²)', type: 'number' },
    { key: 'landArea', label: 'Surface terrain (m²)', type: 'number' },
    { key: 'roomCount', label: 'Nombre de pièces', type: 'number' },
    { key: 'bedroomCount', label: 'Nombre de chambres', type: 'number' },
    { key: 'levels', label: 'Nombre de niveaux', type: 'number' },
    { key: 'constructionYear', label: 'Année de construction', type: 'number' },
    { key: 'generalCondition', label: 'État général', type: 'select', options: [
      { value: 'NEUF', label: 'Neuf' },
      { value: 'BON', label: 'Bon' },
      { value: 'MOYEN', label: 'Moyen' },
      { value: 'MAUVAIS', label: 'Mauvais' },
    ]},
  ],
  occupancy_usage: [
    { key: 'occupancyUsage', label: 'Usage', type: 'select', options: [
      { value: 'RESIDENCE_PRINCIPALE', label: 'Résidence principale' },
      { value: 'RESIDENCE_SECONDAIRE', label: 'Résidence secondaire' },
      { value: 'LOCATIF', label: 'Locatif' },
      { value: 'VACANT', label: 'Vacant' },
    ]},
    { key: 'occupancyStatus', label: 'Statut d\'occupation', type: 'select', options: [
      { value: 'PROPRIETAIRE',     label: 'Propriétaire' },
      { value: 'LOCATAIRE',        label: 'Locataire' },
      { value: 'OCCUPANT_GRATUIT', label: 'Occupant à titre gratuit' },
      { value: 'USUFRUITIER',      label: 'Usufruitier' },
    ]},
    { key: 'monthlyRent', label: 'Loyer mensuel (€)', type: 'number',
      notApplicableWhen: (d: Record<string, unknown>) => ['PROPRIETAIRE', 'OCCUPANT_GRATUIT'].includes(String(d.occupancyStatus ?? '')) },
    { key: 'charges', label: 'Charges (€)', type: 'number',
      notApplicableWhen: (d: Record<string, unknown>) => d.occupancyStatus === 'PROPRIETAIRE' },
    { key: 'occupancyNotes', label: 'Notes occupation', type: 'textarea' },
  ],
  performance_technical: [
    { key: 'heatingType', label: 'Type de chauffage' },
    { key: 'mainEnergy', label: 'Énergie principale' },
    { key: 'dpeClass', label: 'Classe DPE', type: 'select', options: ['A','B','C','D','E','F','G'].map(v => ({ value: v, label: v })) },
    { key: 'dpeDate', label: 'Date DPE', type: 'date' },
    { key: 'gesClass', label: 'Classe GES', type: 'select', options: ['A','B','C','D','E','F','G'].map(v => ({ value: v, label: v })) },
    { key: 'networks', label: 'Réseaux', type: 'textarea' },
  ],
  valuation: [
    { key: 'estimatedValue', label: 'Valeur estimée (€)', type: 'number' },
    { key: 'valuationSource', label: 'Source de valorisation' },
    { key: 'valuationDate', label: 'Date de valorisation', type: 'date' },
  ],
  vehicle_identification: [
    { key: 'make', label: 'Marque' },
    { key: 'model', label: 'Modèle' },
    { key: 'registrationNumber', label: 'Immatriculation' },
    { key: 'vin', label: 'VIN / Numéro de série' },
    { key: 'year', label: 'Année', type: 'number' },
  ],
  vehicle_technical: [
    { key: 'engine', label: 'Motorisation' },
    { key: 'fuelType', label: 'Carburant', type: 'select', options: [
      { value: 'ESSENCE', label: 'Essence' },
      { value: 'DIESEL', label: 'Diesel' },
      { value: 'ELECTRIQUE', label: 'Électrique' },
      { value: 'HYBRIDE', label: 'Hybride' },
      { value: 'GPL', label: 'GPL' },
      { value: 'AUTRE', label: 'Autre' },
    ]},
    { key: 'fiscalHp', label: 'Puissance administrative (CV)', type: 'number' },
    { key: 'powerKw', label: 'Puissance réelle (kW)', type: 'number' },
    { key: 'ptac', label: 'PTAC (kg)', type: 'number' },
    { key: 'seats', label: 'Nombre de places', type: 'number' },
    { key: 'firstRegistrationDate', label: 'Première mise en circulation', type: 'date' },
  ],
  vehicle_usage: [
    { key: 'vehicleOwnershipStatus', label: 'Statut de détention', type: 'select', options: [
      { value: 'PROPRIETAIRE',    label: 'Propriétaire' },
      { value: 'LLD',             label: 'Location longue durée (LLD)' },
      { value: 'LOA',             label: 'Location avec option d\'achat (LOA)' },
      { value: 'CREDIT',          label: 'Crédit auto' },
      { value: 'PRET_GRATUIT',    label: 'Prêt / utilisation gratuite' },
    ]},
    { key: 'mileage', label: 'Kilométrage', type: 'number' },
    { key: 'mileageUnit', label: 'Unité (km/h)', type: 'select', options: [{ value: 'km', label: 'Km' }, { value: 'h', label: 'Heures' }] },
    { key: 'mileageDate', label: 'Date du relevé', type: 'date' },
    { key: 'primaryUse', label: 'Usage principal' },
  ],
  vehicle_insurance: [
    { key: 'isInsured', label: 'Assuré', type: 'select', options: [{ value: 'true', label: 'Oui' }, { value: 'false', label: 'Non' }] },
    { key: 'insurer', label: 'Assureur' },
    { key: 'insuranceContractNumber', label: 'N° de contrat' },
    { key: 'insuranceClientNumber', label: 'N° de client' },
    { key: 'insuranceExpiry', label: 'Date d\'échéance', type: 'date' },
    { key: 'insurancePremium', label: 'Prime annuelle (€)', type: 'number' },
    { key: 'nextInspection', label: 'Prochain contrôle technique', type: 'date' },
  ],
  insurance: [
    { key: 'isInsured', label: 'Assuré', type: 'select', options: [{ value: 'true', label: 'Oui' }, { value: 'false', label: 'Non' }] },
    { key: 'insurer', label: 'Assureur' },
    { key: 'insuranceContractNumber', label: 'N° de contrat' },
    { key: 'insuranceClientNumber', label: 'N° de client' },
    { key: 'insuranceExpiry', label: 'Date d\'échéance', type: 'date' },
    { key: 'insurancePremium', label: 'Prime annuelle (€)', type: 'number' },
  ],
  object_identification: [
    { key: 'objectCategory', label: 'Catégorie' },
    { key: 'brand', label: 'Marque' },
    { key: 'modelName', label: 'Modèle' },
    { key: 'serialNumber', label: 'Numéro de série' },
  ],
  object_condition: [
    { key: 'condition', label: 'État', type: 'select', options: [
      { value: 'NEUF', label: 'Neuf' },
      { value: 'BON', label: 'Bon état' },
      { value: 'MOYEN', label: 'État moyen' },
      { value: 'MAUVAIS', label: 'Mauvais état' },
    ]},
    { key: 'dimensions', label: 'Dimensions' },
    { key: 'weight', label: 'Poids (kg)', type: 'number' },
    { key: 'accessories', label: 'Accessoires', type: 'textarea' },
  ],
  object_provenance: [
    { key: 'acquisitionMode', label: 'Mode d\'acquisition' },
    { key: 'provenance', label: 'Provenance', type: 'textarea' },
    { key: 'authenticityProof', label: 'Preuve d\'authenticité' },
  ],
  object_usage: [
    { key: 'primaryUse', label: 'Usage principal' },
    { key: 'storageLocation', label: 'Lieu de stockage' },
    { key: 'lastRevision', label: 'Dernière révision', type: 'date' },
    { key: 'isInsured', label: 'Assuré', type: 'select', options: [{ value: 'true', label: 'Oui' }, { value: 'false', label: 'Non' }] },
  ],
};

const SECTION_LABELS: Record<string, string> = {
  common: 'Informations générales',
  location_identification: 'Localisation et identification',
  physical_characteristics: 'Caractéristiques physiques',
  occupancy_usage: 'Occupation / usage',
  performance_technical: 'Performance / technique',
  valuation: 'Valorisation',
  vehicle_identification: 'Identification',
  vehicle_technical: 'Caractéristiques techniques',
  vehicle_usage: 'Usage / kilométrage',
  vehicle_insurance: 'Assurance / conformité',
  insurance: 'Assurance',
  object_identification: 'Identification',
  object_condition: 'Caractéristiques / état',
  object_provenance: 'Provenance / traçabilité',
  object_usage: 'Usage / conservation',
};

interface AiSuggestions {
  sections: Record<string, Record<string, AiSuggestion>>;
}

// ─── CIL Checklist ─────────────────────────────────────────────────────────────

const CIL_RUBRICS = [
  { code: 'PLAN_CONSTRUCTION',         label: 'Plans de construction',                     section: 'construction' },
  { code: 'RE2020',                    label: 'Attestation RE2020',                         section: 'construction' },
  { code: 'LABEL_CERTIFICATION',       label: 'Label ou certification',                     section: 'construction' },
  { code: 'DPE',                       label: 'DPE (Diagnostic de Performance Énergétique)', section: 'construction' },
  { code: 'ISOLATION_TOITURE',         label: 'Isolation thermique — toiture',              section: 'construction' },
  { code: 'ISOLATION_MURS',            label: 'Isolation thermique — murs extérieurs',      section: 'construction' },
  { code: 'ISOLATION_VITRAGE',         label: 'Isolation thermique — vitrages',             section: 'construction' },
  { code: 'ISOLATION_PLANCHERS',       label: 'Isolation thermique — planchers bas',        section: 'construction' },
  { code: 'EQUIPEMENT_CHAUFFAGE',      label: 'Système de chauffage',                       section: 'construction' },
  { code: 'EQUIPEMENT_REFROIDISSEMENT',label: 'Système de refroidissement',                 section: 'construction' },
  { code: 'EQUIPEMENT_ECS',            label: "Eau chaude sanitaire",                       section: 'construction' },
  { code: 'RESEAU_CHALEUR',            label: 'Réseau de chaleur ou de froid',              section: 'construction' },
  { code: 'EQUIPEMENT_VENTILATION',    label: 'Système de ventilation (VMC…)',              section: 'construction' },
  { code: 'AUDIT_ENERGETIQUE',         label: 'Audit énergétique',                          section: 'renovation' },
  { code: 'AMIANTE',                   label: 'Diagnostic amiante',                         section: 'diagnostic' },
  { code: 'PLOMB',                     label: 'Diagnostic plomb (CREP)',                    section: 'diagnostic' },
  { code: 'GAZ',                       label: 'Diagnostic installation gaz',                section: 'diagnostic' },
  { code: 'ELECTRICITE',               label: 'Diagnostic installation électrique',         section: 'diagnostic' },
  { code: 'ASSAINISSEMENT',            label: 'Diagnostic assainissement non collectif',    section: 'diagnostic' },
  { code: 'ERNMT',                     label: 'État des risques naturels et technologiques', section: 'diagnostic' },
] as const;

interface CilDocRef { code: string; date: string | null; title: string | null }

function CilChecklist({ assetId, naRubrics = new Set<string>() }: { assetId: number; naRubrics?: Set<string> }) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState<CilDocRef[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    apiClient.get<{ items: Array<{ id: number; retainedFunctionCode: string | null; documentType: string; cilRubricCodes: string[] | null; documentDate: string | null; retainedTitle: string | null; originalFilename: string | null }> }>(
      `/api/assets/${assetId}/cil-checklist`
    ).then(data => {
      const result: CilDocRef[] = [];
      for (const rubric of CIL_RUBRICS) {
        const match = data.items.find(d => {
          if (d.retainedFunctionCode === rubric.code) return true;
          if (d.documentType === rubric.code) return true;
          const crc = d.cilRubricCodes;
          if (Array.isArray(crc)) return crc.includes(rubric.code);
          return false;
        });
        result.push({
          code: rubric.code,
          date: match?.documentDate ?? null,
          title: match ? (match.retainedTitle || match.originalFilename || null) : null,
        });
      }
      setDocs(result);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, [open, loaded, assetId]);

  const sections = [
    { key: 'construction', label: 'Construction / performance' },
    { key: 'renovation',   label: 'Rénovation énergétique' },
    { key: 'diagnostic',   label: 'Diagnostics techniques' },
  ] as const;

  const applicableRubrics = CIL_RUBRICS.filter(r => !naRubrics.has(r.code));
  const available = docs.filter(d => d.title !== null && !naRubrics.has(d.code)).length;
  const total = applicableRubrics.length;

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm">Checklist CIL</span>
          {loaded && (
            <span className="text-[10px] font-medium text-sky-400 bg-sky-500/10 rounded px-1.5 py-0.5 shrink-0">
              {available} / {total}
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <div className="p-4 space-y-4">
          {!loaded ? (
            <div className="space-y-2">
              {[1,2,3].map(i => <Skeleton key={i} className="h-6 w-full" />)}
            </div>
          ) : (
            sections.map(sec => (
              <div key={sec.key}>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">{sec.label}</p>
                <div className="space-y-1">
                  {CIL_RUBRICS.filter(r => r.section === sec.key).map(rubric => {
                    const doc = docs.find(d => d.code === rubric.code);
                    const isAvailable = !!doc?.title;
                    const isNa = naRubrics.has(rubric.code);
                    return (
                      <div key={rubric.code} className="flex items-center justify-between gap-2 py-1 border-b border-border/20 last:border-0">
                        <span className={`text-xs ${isAvailable ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {rubric.label}
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          {isAvailable && doc?.date && (
                            <span className="text-[10px] text-muted-foreground">
                              {new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(doc.date))}
                            </span>
                          )}
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                            isAvailable
                              ? 'bg-emerald-500/15 text-emerald-400'
                              : isNa
                              ? 'bg-slate-500/10 text-slate-400'
                              : 'bg-muted/50 text-muted-foreground'
                          }`}>
                            {isAvailable ? 'Disponible' : isNa ? 'Non applicable' : 'Non renseigné'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const FAMILY_SECTIONS: Record<string, string[]> = {
  IMMOBILIER: ['common', 'location_identification', 'physical_characteristics', 'occupancy_usage', 'performance_technical', 'valuation', 'insurance'],
  VEHICULE:   ['common', 'vehicle_identification', 'vehicle_technical', 'vehicle_usage', 'vehicle_insurance', 'valuation'],
  OBJET:      ['common', 'object_identification', 'object_condition', 'object_provenance', 'object_usage', 'valuation', 'insurance'],
};

// Build a map from fieldKey → sectionKey, restricted to the sections applicable to this category
function buildFieldToSectionMap(category: string): Record<string, string> {
  const applicable = FAMILY_SECTIONS[category] ?? FAMILY_SECTIONS.OBJET;
  const map: Record<string, string> = {};
  const commonFields = getCommonFields(category);
  for (const f of commonFields) map[f.key] = 'common';
  for (const sectionKey of applicable) {
    const fields = SECTION_FIELDS[sectionKey];
    if (!fields) continue;
    for (const f of fields) map[f.key] = sectionKey;
  }
  return map;
}

type CoherenceAlert = { field: string; section: string; currentValue: string; issue: string; suggestedValue: string | null; sourceDocument: string; detectedAt: string };

export function AssetDetailsTab({ asset, onRefresh, planType, readOnly = false, highlightField }: Props) {
  const [detailData, setDetailData] = useState<{ family: string; sections: Record<string, Record<string, unknown>>; coherenceAlerts?: CoherenceAlert[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  // Resolve forcedOpenSection immediately from URL param — no need to wait for data load
  const [forcedOpenSection, setForcedOpenSection] = useState<string | null>(() => {
    if (!highlightField) return null;
    const map = buildFieldToSectionMap(asset.category);
    return map[highlightField] ?? null;
  });
  const [valuationDrawerOpen, setValuationDrawerOpen] = useState(false);
  const highlightAppliedRef = useRef(false);

  // AI suggestions — fetched silently after data loads
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestions | null>(null);
  const [consumedSections, setConsumedSections] = useState<Set<string>>(new Set());
  const aiFetchedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiClient.get<{ family: string; sections: Record<string, Record<string, unknown>> }>(
        `/api/assets/${asset.id}/details`
      );
      setDetailData(data);
      return data;
    } catch {
      // silently fail — sections show empty
      return null;
    } finally {
      setLoading(false);
    }
  }, [asset.id]);

  // Silent AI pre-fill — runs once after initial load, premium only
  const fetchAiSilently = useCallback(async (data: { family: string; sections: Record<string, Record<string, unknown>> }) => {
    if (planType !== 'premium' || readOnly || aiFetchedRef.current) return;
    aiFetchedRef.current = true;
    try {
      const currentSections = Object.fromEntries(
        Object.entries(data.sections).map(([k, v]) => [
          k,
          k === 'common' ? { ...v, status: asset.status } : v,
        ])
      );
      const result = await apiClient.post<{ hasUsableSuggestions: boolean; sections: Record<string, Record<string, AiSuggestion>>; reason?: string }>(
        `/api/assets/${asset.id}/ai-suggestions`,
        { currentSections }
      );
      if (result.hasUsableSuggestions && Object.keys(result.sections).length > 0) {
        setAiSuggestions({ sections: result.sections });
      }
    } catch {
      // silent — no feedback to user
    }
  }, [asset.id, asset.status, planType, readOnly]);

  useEffect(() => {
    load().then(data => { if (data) fetchAiSilently(data); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTrigger]);

  const handleSectionDraftConsumed = useCallback((sectionKey: string) => {
    setConsumedSections(prev => new Set([...prev, sectionKey]));
  }, []);

  const handleDismissAlert = useCallback(async (field: string) => {
    try {
      await apiClient.post(`/api/assets/${asset.id}/dismiss-coherence-alert`, { field });
      setRefreshTrigger(prev => prev + 1);
      toast.success('Incohérence ignorée');
    } catch {
      toast.error("Erreur lors de l'ignorance de l'incohérence");
    }
  }, [asset.id]);

  // Scroll to the highlighted section as soon as sections are rendered (detailData available)
  const fieldToSection = useMemo(() => buildFieldToSectionMap(asset.category), [asset.category]);

  const handleApplyAlert = useCallback(async (field: string, suggestedValue: string) => {
    const sectionKey = fieldToSection[field];
    if (!sectionKey) {
      toast.error("Impossible d'appliquer la suggestion : section inconnue");
      return;
    }
    try {
      // Retirer l'alerte de coherence (la PATCH le ferait aussi, mais en doublon c'est safe)
      await apiClient.post(`/api/assets/${asset.id}/dismiss-coherence-alert`, { field });
      // Appliquer la valeur suggérée
      await apiClient.patch(`/api/assets/${asset.id}/details/${sectionKey}`, {
        fields: { [field]: suggestedValue },
      });
      setRefreshTrigger(prev => prev + 1);
      toast.success('Valeur suggérée appliquée');
    } catch {
      toast.error("Erreur lors de l'application de la suggestion");
    }
  }, [asset.id, fieldToSection]);

  useEffect(() => {
    if (!highlightField || !detailData || highlightAppliedRef.current) return;
    const sectionKey = fieldToSection[highlightField] ?? null;
    if (!sectionKey) return;
    highlightAppliedRef.current = true;
    // Section is already open (forcedOpenSection initialized at mount) — just scroll
    const tryScroll = (attempts: number) => {
      const el = document.getElementById(`asset-section-${sectionKey}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (attempts > 0) {
        setTimeout(() => tryScroll(attempts - 1), 100);
      }
    };
    setTimeout(() => tryScroll(5), 100);
  }, [highlightField, detailData, fieldToSection]);

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
      </div>
    );
  }

  if (!detailData) return null;

  const sectionEntries = Object.entries(detailData.sections);

  return (
    <div className="space-y-3">
      <ValuationHistoryDrawer
        open={valuationDrawerOpen}
        onClose={() => setValuationDrawerOpen(false)}
        assetId={asset.id}
        assetName={asset.name}
        onSaved={onRefresh}
      />

      {/* ── Sections ──────────────────────────────────────────────────────────── */}
      {sectionEntries.map(([key, data]) => {
        const fields = key === 'common' ? getCommonFields(asset.category) : (SECTION_FIELDS[key] ?? []);
        const sectionData = key === 'common' ? { ...data, status: asset.status } : data;
        const sectionAiDraft = (aiSuggestions?.sections[key] && !consumedSections.has(key))
          ? aiSuggestions.sections[key]
          : undefined;
        const isForced = forcedOpenSection === key;
        const sectionAlerts = (detailData?.coherenceAlerts ?? []).filter(a => a.section === key);

        return (
          <div
            key={key}
            id={`asset-section-${key}`}
            {...(key === 'common' ? { 'data-guide': 'asset-first-field' } : {})}
          >
            <AssetDetailSection
              title={SECTION_LABELS[key] ?? key}
              sectionKey={key}
              assetId={asset.id}
              data={sectionData}
              fields={fields}
              onRefresh={() => setRefreshTrigger(prev => prev + 1)}
              defaultOpen={key === 'common' || isForced}
              forceOpen={isForced}
              highlightField={isForced ? (highlightField ?? undefined) : undefined}
              aiDraft={sectionAiDraft}
              onAiDraftConsumed={() => handleSectionDraftConsumed(key)}
              readOnly={readOnly}
              coherenceAlerts={sectionAlerts}
              onDismissAlert={handleDismissAlert}
              onApplyAlert={handleApplyAlert}
              headerActions={key === 'valuation' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setValuationDrawerOpen(true)}
                  title="Historique de valorisation"
                >
                  <TrendingUp className="w-3.5 h-3.5 mr-1" />
                  Valorisation
                </Button>
              ) : undefined}
            />
          </div>
        );
      })}

      {/* ── CIL Checklist — after insurance section, IMMOBILIER only ─────────── */}
      {asset.category === 'IMMOBILIER' && (() => {
        const perf = detailData?.sections?.performance_technical as { mainEnergy?: string; heatingType?: string } | undefined;
        const combined = [(perf?.mainEnergy ?? ''), (perf?.heatingType ?? '')].join(' ')
          .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        const naRubrics = new Set<string>();
        // GAZ is N/A when energy info is present and clearly non-gas
        if ((perf?.mainEnergy || perf?.heatingType) && !combined.includes('gaz')) {
          naRubrics.add('GAZ');
        }
        return <CilChecklist assetId={asset.id} naRubrics={naRubrics} />;
      })()}
    </div>
  );
}
