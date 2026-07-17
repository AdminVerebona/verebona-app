"use client"

import { useState, useEffect } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Lock, Package, X, Check, Loader2, Info } from 'lucide-react';
import { toast } from 'sonner';
import { ThumbnailUpload } from '@/components/thumbnail-upload';
import { DatePicker } from '@/components/ui/date-picker';
import { NumberInput } from '@/components/ui/number-input';
import { useRouter } from 'next/navigation';
import {
  OBJECT_CATEGORY_LABELS,
} from '@/types/domain';

const IMMOBILIER_SUBTYPES = [
  'Maison',
  'Appartement',
  'Terrain',
  'Local commercial',
  'Garage',
];

const VEHICULE_SUBTYPES = [
  'Vélo',
  'Voiture',
  'Camion',
  'Moto',
];

interface AssetFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  onLimitReached?: () => void;
  userId: number;
}

export function AssetFormDialog({
  open,
  onOpenChange,
  onSuccess,
  onLimitReached,
  userId,
}: AssetFormDialogProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    category: '',
    subtype: '',
    purchaseDate: '',
    purchasePriceCents: '' as string | number,
    notes: '',
    thumbnailUrl: null as string | null,
    objectCategory: '',
    objectDetails: {} as Record<string, any>,
    purchaseLocation: '',
  });

  useEffect(() => {
    if (!open) {
      setFormData({
        name: '',
        category: '',
        subtype: '',
        purchaseDate: '',
        purchasePriceCents: '',
        notes: '',
        thumbnailUrl: null,
        objectCategory: '',
        objectDetails: {},
        purchaseLocation: '',
      });
      setDetailsOpen(false);
    }
  }, [open]);

  const getSubtypes = () => {
    switch (formData.category) {
      case 'IMMOBILIER': return IMMOBILIER_SUBTYPES;
      case 'VEHICULE': return VEHICULE_SUBTYPES;
      default: return [];
    }
  };

  const getSubtypeLabel = () => {
    const categoryLabels: Record<string, string> = {
      IMMOBILIER: 'Immobilier',
      VEHICULE: 'Véhicule',
    };
    return categoryLabels[formData.category] || '';
  };

  const updateObjectDetails = (key: string, value: any) => {
    setFormData({ ...formData, objectDetails: { ...formData.objectDetails, [key]: value } });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name || !formData.category) {
      toast.error('Veuillez remplir tous les champs obligatoires');
      return;
    }

    if (formData.category === 'OBJECT' && !formData.objectCategory) {
      toast.error('Veuillez sélectionner une catégorie d\'objet');
      return;
    }

    setIsSubmitting(true);

    try {
      const token = localStorage.getItem('bearer_token');
      const payload: any = {
        userId,
        name: formData.name,
        category: formData.category,
        subtype: formData.subtype || undefined,
        purchaseDate: formData.purchaseDate || undefined,
        purchasePriceCents: formData.purchasePriceCents ? Math.round(parseFloat(formData.purchasePriceCents.toString()) * 100) : undefined,
        notes: formData.notes || undefined,
        thumbnailUrl: formData.thumbnailUrl || undefined,
        purchaseLocation: formData.purchaseLocation || undefined,
      };

      if (formData.category === 'OBJECT') {
        payload.objectCategory = formData.objectCategory;
        const details = formData.objectDetails || {};
        if (Object.keys(details).length > 0) payload.objectDetails = details;
      }

      const response = await fetch('/api/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        if (errorData.code === 'ASSET_LIMIT_REACHED' || errorData.message?.includes('limite') || errorData.message?.includes('3 biens')) {
          setIsSubmitting(false);
          onLimitReached?.();
          return;
        }
        throw new Error(errorData.message || 'Erreur lors de la création du bien');
      }

      const createdAsset = await response.json();
      toast.success('Bien créé avec succès !');
      onOpenChange(false);
      router.push(`/assets/${createdAsset.id}`);
      onSuccess?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Erreur lors de la création du bien');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Selector shown directly below the category picker — always visible when OBJECT is selected
  const renderObjectCategorySelect = () => {
    if (formData.category !== 'OBJECT') return null;
    return (
      <div className="form-field">
        <Label htmlFor="objectCategory">
          Catégorie d'objet <span className="required-star">*</span>
        </Label>
        <Select
          value={formData.objectCategory}
          onValueChange={(value) => setFormData({ ...formData, objectCategory: value, objectDetails: {} })}
        >
          <SelectTrigger id="objectCategory">
            <SelectValue placeholder="Sélectionnez une catégorie" />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(OBJECT_CATEGORY_LABELS).map(([key, label]) => (
              <SelectItem key={key} value={key}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  };

  // Detailed object fields - removed to simplify form
  const renderObjectFields = () => {
    return null;
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-[560px] flex flex-col overflow-hidden p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b border-[color:var(--border-subtle)] flex-shrink-0">
          <SheetTitle className="flex items-center gap-2 text-lg font-semibold">
            <Package className="w-5 h-5 text-[#3b82f6]" />
            Ajouter un bien
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <form id="asset-form" onSubmit={handleSubmit} className="space-y-4">
            {/* ── Champs obligatoires ── */}
            <div className="form-field">
              <Label htmlFor="name">
                Nom du bien <span className="required-star">*</span>
              </Label>
              <Input
                id="name"
                placeholder="Ex : Appartement, Voiture, Vélo, Télévision…"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
              />
            </div>

            <div className="form-field">
              <Label htmlFor="category">
                Catégorie <span className="required-star">*</span>
              </Label>
              <Select
                value={formData.category}
                onValueChange={(value) => setFormData({ ...formData, category: value, subtype: '', objectCategory: '', objectDetails: {} })}
                required
              >
                <SelectTrigger id="category">
                  <SelectValue placeholder="Sélectionnez une catégorie" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="IMMOBILIER">Immobilier</SelectItem>
                  <SelectItem value="VEHICULE">Véhicule</SelectItem>
                  <SelectItem value="OBJECT">Objet</SelectItem>
                  <SelectItem value="MATERIEL_PRO" disabled>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Lock className="w-4 h-4" />
                      <span>Matériel pro</span>
                      <span className="text-xs">(Premium Pro requis)</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Object sub-category — shown immediately when category = OBJECT */}
            {renderObjectCategorySelect()}

            {/* Sous-catégorie - conditionné par catégorie */}
            {formData.category && formData.category !== 'OBJECT' && getSubtypes().length > 0 && (
              <div className="form-field">
                <Label htmlFor="subtype">Catégorie de {getSubtypeLabel()}</Label>
                <Select value={formData.subtype} onValueChange={(value) => setFormData({ ...formData, subtype: value })} disabled={false}>
                  <SelectTrigger id="subtype">
                    <SelectValue placeholder="Sélectionnez un type" />
                  </SelectTrigger>
                  <SelectContent>
                    {getSubtypes().map((subtype) => (
                      <SelectItem key={subtype} value={subtype}>{subtype}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* ── Champs optionnels essentiels ── */}
            <div className="space-y-4">
              <div className="form-field">
                <Label>Photo du bien</Label>
                <ThumbnailUpload
                  currentThumbnail={formData.thumbnailUrl}
                  onThumbnailChange={(url) => setFormData({ ...formData, thumbnailUrl: url })}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="form-field">
                  <Label htmlFor="purchaseDate">Date d'achat</Label>
                  <DatePicker
                    id="purchaseDate"
                    value={formData.purchaseDate}
                    onChange={(date) => setFormData({ ...formData, purchaseDate: date })}
                    placeholder="jj/mm/aaaa"
                    max={new Date().toISOString().split('T')[0]}
                  />
                </div>
                <div className="form-field">
                  <Label htmlFor="purchasePrice">Prix d'achat TTC (€)</Label>
                  <NumberInput
                    id="purchasePrice"
                    step={0.01}
                    placeholder="0.00"
                    value={formData.purchasePriceCents}
                    onChange={(e) => setFormData({ ...formData, purchasePriceCents: e.target.value })}
                    showButtons={false}
                  />
                </div>
              </div>

              <div className="form-field">
                <Label htmlFor="notes">Notes</Label>
                <Textarea
                  id="notes"
                  placeholder="Informations complémentaires, remarques…"
                  rows={2}
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                />
              </div>
            </div>
          </form>
        </div>

        <div className="border-t border-[color:var(--border-subtle)] px-6 py-4 flex-shrink-0 space-y-4">
          <div className="flex items-start gap-2.5 rounded-md bg-blue-500/10 border border-blue-500/20 p-3">
            <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              Vous pourrez compléter les informations détaillées du bien après sa création.
            </p>
          </div>
          <div className="flex items-stretch rounded-xl border border-border bg-muted/30 overflow-hidden">
            <button
              type="button"
              className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              <X className="w-4 h-4" />
              <span className="text-[10px] font-semibold uppercase tracking-wider">Annuler</span>
            </button>
            <div className="w-px bg-border" />
            <button
              type="submit"
              form="asset-form"
              className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-primary/10 transition-colors text-primary disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={isSubmitting}
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              <span className="text-[10px] font-semibold uppercase tracking-wider">{isSubmitting ? 'Création…' : 'Créer le bien'}</span>
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
