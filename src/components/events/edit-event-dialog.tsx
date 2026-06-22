"use client";

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, Trash2, LayoutGrid, Settings, Package } from 'lucide-react';
import { toast } from 'sonner';
import { LinkedDocumentsSection } from './linked-documents-section';
import { Substructure, Equipment, assetSupportsStructuralFeatures } from '@/types/domain';
import { apiClient } from '@/lib/api-client';

interface EditEventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: number;
  assetId?: number | null;
  availableAssets?: { id: number; name: string }[];
  onEventUpdated?: () => void;
}

interface EventData {
  id: number;
  title: string;
  date: string | null;
  categorie: string;
  statut: string;
  important: boolean;
  provider: string | null;
  costCents: number | null;
  description: string | null;
  assetId: number | null;
  substructureId: number | null;
  equipmentId: number | null;
}

const EVENT_CATEGORIES = [
  { value: 'achat', label: 'Achat' },
  { value: 'vente', label: 'Vente' },
  { value: 'entretien', label: 'Entretien' },
  { value: 'reparation', label: 'Réparation' },
  { value: 'sinistre', label: 'Sinistre' },
  { value: 'controle', label: 'Contrôle' },
  { value: 'garantie', label: 'Garantie' },
  { value: 'autre', label: 'Autre' },
];

const EVENT_STATUTS = [
  { value: 'planifie', label: 'Planifié' },
  { value: 'realise', label: 'Réalisé' },
  { value: 'annule', label: 'Annulé' },
];

export function EditEventDialog({
  open,
  onOpenChange,
  eventId,
  assetId: initialAssetId,
  availableAssets,
  onEventUpdated,
}: EditEventDialogProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Event fields
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [categorie, setCategorie] = useState('autre');
  const [statut, setStatut] = useState('planifie');
  const [important, setImportant] = useState(false);
  const [provider, setProvider] = useState('');
  const [cost, setCost] = useState('');
  const [description, setDescription] = useState('');
  const [assetId, setAssetId] = useState<string>(initialAssetId?.toString() || 'none');

  // Assets
  const [assets, setAssets] = useState<{ id: number; name: string }[]>(availableAssets || []);
  const [isLoadingAssets, setIsLoadingAssets] = useState(false);

  // Substructures & Equipments
  const [substructures, setSubstructures] = useState<Substructure[]>([]);
  const [equipments, setEquipments] = useState<Equipment[]>([]);
  const [selectedSubstructureId, setSelectedSubstructureId] = useState<string>('none');
  const [selectedEquipmentId, setSelectedEquipmentId] = useState<string>('none');
  const [loadingRelations, setLoadingRelations] = useState(false);
  const [assetSupportsStructural, setAssetSupportsStructural] = useState(false);

  useEffect(() => {
    if (open && eventId) {
      fetchEventData();
      if (!availableAssets) {
        fetchAssets();
      }
    }
  }, [open, eventId]);

  useEffect(() => {
    if (assetId && assetId !== 'none') {
      fetchRelations(parseInt(assetId));
    } else {
      setSubstructures([]);
      setEquipments([]);
      setAssetSupportsStructural(false);
      setSelectedSubstructureId('none');
      setSelectedEquipmentId('none');
    }
  }, [assetId]);

  const fetchAssets = async () => {
    setIsLoadingAssets(true);
    try {
      const response = await apiClient.get<{ data: any[] }>('/api/assets');
      setAssets(response.data || []);
    } catch (error) {
      console.error('Error fetching assets:', error);
    } finally {
      setIsLoadingAssets(false);
    }
  };

  const fetchRelations = async (aid: number) => {
    setLoadingRelations(true);
    try {
      const [assetData, subs, eqs] = await Promise.all([
        apiClient.get<any>(`/api/assets?id=${aid}`),
        apiClient.get<Substructure[]>(`/api/assets/${aid}/substructures`),
        apiClient.get<Equipment[]>(`/api/assets/${aid}/equipments`),
      ]);
      setAssetSupportsStructural(assetSupportsStructuralFeatures(assetData));
      setSubstructures(subs || []);
      setEquipments(eqs || []);
    } catch (error) {
      console.error('Failed to fetch relations:', error);
    } finally {
      setLoadingRelations(false);
    }
  };

  const fetchEventData = async () => {
    setIsLoading(true);
    try {
      const token = localStorage.getItem('bearer_token');
      const response = await fetch(`/api/events/${eventId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Échec de la récupération de l\'événement');
      }

      const data: EventData = await response.json();
      
      setTitle(data.title);
      setDate(data.date || '');
      setCategorie(data.categorie || 'autre');
      setStatut(data.statut || 'planifie');
      setImportant(data.important || false);
      setProvider(data.provider || '');
      setCost(data.costCents ? (data.costCents / 100).toFixed(2) : '');
      setDescription(data.description || '');
      setAssetId(data.assetId?.toString() || 'none');
      setSelectedSubstructureId(data.substructureId?.toString() || 'none');
      setSelectedEquipmentId(data.equipmentId?.toString() || 'none');

    } catch (error) {
      console.error('Fetch event error:', error);
      toast.error('Erreur lors de la récupération de l\'événement');
      onOpenChange(false);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdate = async () => {
    if (!title.trim()) {
      toast.error('Le titre est requis');
      return;
    }

    setIsUpdating(true);

    try {
      const token = localStorage.getItem('bearer_token');
      const costCents = cost ? Math.round(parseFloat(cost) * 100) : null;
      
      const response = await fetch(`/api/events/${eventId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: title.trim(),
          date: date || null,
          categorie: categorie.trim(),
          assetId: assetId === 'none' ? null : parseInt(assetId),
          substructureId: selectedSubstructureId === 'none' ? null : parseInt(selectedSubstructureId),
          equipmentId: selectedEquipmentId === 'none' ? null : parseInt(selectedEquipmentId),
          statut,
          important,
          provider: provider.trim() || null,
          costCents,
          description: description.trim() || null,
        }),
      });

      if (!response.ok) {
        throw new Error('Échec de la mise à jour de l\'événement');
      }

      toast.success('Événement mis à jour avec succès');
      onEventUpdated?.();
      onOpenChange(false);
    } catch (error) {
      console.error('Update event error:', error);
      toast.error('Erreur lors de la mise à jour de l\'événement');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Êtes-vous sûr de vouloir supprimer cet événement ? Cette action est irréversible.')) {
      return;
    }

    setIsDeleting(true);

    try {
      const token = localStorage.getItem('bearer_token');
      
      const response = await fetch(`/api/events/${eventId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Échec de la suppression de l\'événement');
      }

      toast.success('Événement supprimé avec succès');
      onEventUpdated?.();
      onOpenChange(false);
    } catch (error) {
      console.error('Delete event error:', error);
      toast.error('Erreur lors de la suppression de l\'événement');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Modifier l'événement</DialogTitle>
          <DialogDescription>
            Modifiez les informations de l'événement et gérez les documents associés
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-[color:var(--accent)]" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* Event Information */}
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-[color:var(--text-primary)]">
                Informations de l'événement
              </h3>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="asset-select">Bien associé</Label>
                  <Select 
                    value={assetId} 
                    onValueChange={setAssetId}
                    disabled={isLoadingAssets}
                  >
                    <SelectTrigger id="asset-select">
                      <Package className="w-4 h-4 mr-2 text-muted-foreground" />
                      <SelectValue placeholder={isLoadingAssets ? "Chargement..." : "Aucun"} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Aucun</SelectItem>
                      {assets.map((asset) => (
                        <SelectItem key={asset.id} value={asset.id.toString()}>
                          {asset.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="title">
                    Titre <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    id="title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Ex: Révision annuelle"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="date">Date</Label>
                    <DatePicker
                      id="date"
                      value={date}
                      onChange={(d) => setDate(d)}
                    />
                </div>

                <div>
                  <Label htmlFor="statut">
                    Statut <span className="text-red-500">*</span>
                  </Label>
                  <Select value={statut} onValueChange={setStatut}>
                    <SelectTrigger id="statut">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EVENT_STATUTS.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="categorie">
                      Catégorie <span className="text-red-500">*</span>
                    </Label>
                    <Select value={categorie} onValueChange={setCategorie}>
                      <SelectTrigger id="categorie">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {EVENT_CATEGORIES.map((cat) => (
                          <SelectItem key={cat.value} value={cat.value}>
                            {cat.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
  
                  {/* Associations Substructures & Equipments */}
                  {assetSupportsStructural && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      <div className="space-y-2">
                        <Label htmlFor="substructure-select">Pièce</Label>
                        <Select 
                          value={selectedSubstructureId} 
                          onValueChange={setSelectedSubstructureId}
                          disabled={loadingRelations}
                        >
                          <SelectTrigger id="substructure-select">
                            <LayoutGrid className="w-4 h-4 mr-2 text-muted-foreground" />
                            <SelectValue placeholder="Aucune" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">Aucune</SelectItem>
                            {substructures.map((sub) => (
                              <SelectItem key={sub.id} value={sub.id.toString()}>
                                {sub.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
  
                      <div className="space-y-2">
                        <Label htmlFor="equipment-select">Équipement</Label>
                        <Select 
                          value={selectedEquipmentId} 
                          onValueChange={setSelectedEquipmentId}
                          disabled={loadingRelations}
                        >
                          <SelectTrigger id="equipment-select">
                            <Settings className="w-4 h-4 mr-2 text-muted-foreground" />
                            <SelectValue placeholder="Aucun" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">Aucun</SelectItem>
                            {equipments.map((eq) => (
                              <SelectItem key={eq.id} value={eq.id.toString()}>
                                {eq.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="important"
                  checked={important}
                  onCheckedChange={(checked) => setImportant(checked === true)}
                />
                <Label htmlFor="important" className="cursor-pointer">
                  Marquer comme important
                </Label>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="provider">Fournisseur (facultatif)</Label>
                  <Input
                    id="provider"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    placeholder="Ex: Garage Dupont"
                  />
                </div>

                <div>
                  <Label htmlFor="cost">Coût (facultatif)</Label>
                  <Input
                    id="cost"
                    type="number"
                    step="0.01"
                    value={cost}
                    onChange={(e) => setCost(e.target.value)}
                    placeholder="Ex: 150.00"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="description">Description (facultatif)</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Ajoutez des détails supplémentaires..."
                  rows={3}
                />
              </div>
            </div>

            {/* Documents Section */}
            {assetId && assetId !== 'none' && (
              <div>
                <LinkedDocumentsSection
                  eventId={eventId}
                  assetId={parseInt(assetId)}
                  onRefresh={onEventUpdated}
                />
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex justify-between items-center pt-4 border-t border-[color:var(--border-subtle)]">
              <Button
                type="button"
                variant="destructive"
                onClick={handleDelete}
                disabled={isUpdating || isDeleting}
                className="gap-2"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Suppression...
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
                    Supprimer
                  </>
                )}
              </Button>

              <div className="flex gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  disabled={isUpdating || isDeleting}
                >
                  Annuler
                </Button>
                <Button
                  onClick={handleUpdate}
                  disabled={isUpdating || isDeleting}
                  className="bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8]"
                >
                  {isUpdating ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Mise à jour...
                    </>
                  ) : (
                    'Enregistrer'
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
