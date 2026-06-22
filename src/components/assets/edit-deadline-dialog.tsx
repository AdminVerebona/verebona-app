"use client";

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DatePicker } from '@/components/ui/date-picker';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';

interface EditDeadlineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deadlineId: number;
  availableAssets?: { id: number; name: string }[];
  onSuccess?: () => void;
}

const DEADLINE_TYPES = [
  { value: 'ENTRETIEN', label: 'Entretien' },
  { value: 'CONTROLE_TECHNIQUE', label: 'Contrôle Technique' },
  { value: 'ASSURANCE', label: 'Assurance' },
  { value: 'GARANTIE', label: 'Garantie' },
  { value: 'ADMINISTRATIF', label: 'Administratif' },
  { value: 'AUTRE', label: 'Autre' },
];

export function EditDeadlineDialog({
  open,
  onOpenChange,
  deadlineId,
  availableAssets,
  onSuccess,
}: EditDeadlineDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [assets, setAssets] = useState<{ id: number; name: string }[]>(availableAssets || []);
  const [isLoadingAssets, setIsLoadingAssets] = useState(false);
  const [equipments, setEquipments] = useState<any[]>([]);
  const [isLoadingEquipments, setIsLoadingEquipments] = useState(false);
  
  const [formData, setFormData] = useState({
    label: '',
    deadlineDate: '',
    deadlineType: 'ENTRETIEN',
    isDone: false,
    doneDate: '',
    notes: '',
    assetId: '',
    equipmentId: '',
  });

  useEffect(() => {
    if (open && deadlineId) {
      fetchDeadline();
      if (!availableAssets) {
        fetchAssets();
      }
    }
  }, [open, deadlineId]);

  useEffect(() => {
    if (formData.assetId && formData.assetId !== 'none') {
      fetchEquipments(formData.assetId);
    } else {
      setEquipments([]);
      setFormData(prev => ({ ...prev, equipmentId: '' }));
    }
  }, [formData.assetId]);

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

  const fetchEquipments = async (assetId: string) => {
    setIsLoadingEquipments(true);
    try {
      const response = await apiClient.get(`/api/assets/${assetId}/equipments`);
      // L'API /api/assets/[id]/equipments renvoie un tableau directement
      // Contrairement à /api/assets qui renvoie { data: [...] }
      const data = Array.isArray(response) ? response : (response as any)?.data || [];
      setEquipments(data);
    } catch (error) {
      console.error('Error fetching equipments:', error);
      setEquipments([]);
    } finally {
      setIsLoadingEquipments(false);
    }
  };

    const fetchDeadline = async () => {
      setIsLoading(true);
      try {
        const response: any = await apiClient.get(`/api/deadlines?id=${deadlineId}`);
        const data = response;
        setFormData({
          label: data.label || '',
          deadlineDate: data.deadlineDate ? data.deadlineDate.split('T')[0] : '',
          deadlineType: data.deadlineType || '',
          isDone: data.isDone || false,
          doneDate: data.doneDate ? data.doneDate.split('T')[0] : '',
          notes: data.notes || '',
          assetId: data.assetId?.toString() || '',
          equipmentId: data.equipmentId?.toString() || '',
        });
      } catch (error: any) {
        toast.error('Erreur lors de la récupération du rappel');
        onOpenChange(false);
      } finally {
        setIsLoading(false);
      }
    };

    const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!formData.label.trim()) {
        toast.error('Le libellé est requis');
        return;
      }

      setIsSubmitting(true);
      try {
        await apiClient.put(`/api/deadlines?id=${deadlineId}`, {
          ...formData,
          assetId: formData.assetId && formData.assetId !== 'none' ? parseInt(formData.assetId) : null,
          equipmentId: formData.equipmentId && formData.equipmentId !== 'none' ? parseInt(formData.equipmentId) : null,
          deadlineDate: formData.deadlineDate || null,
          doneDate: formData.doneDate || null,
          deadlineType: formData.deadlineType && formData.deadlineType !== 'none' ? formData.deadlineType : null,
        });
        toast.success('Rappel mis à jour avec succès');
        onSuccess?.();
        onOpenChange(false);
      } catch (error: any) {
        toast.error(error.message || 'Erreur lors de la mise à jour du rappel');
      } finally {
        setIsSubmitting(false);
      }
    };

    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Modifier le rappel</DialogTitle>
            <DialogDescription>
              Modifiez les informations de cette échéance.
            </DialogDescription>
          </DialogHeader>
          {isLoading ? (
            <div className="py-8 text-center text-muted-foreground">Chargement...</div>
          ) : (
              <form onSubmit={handleSubmit} className="space-y-4 pt-4">
                <div className={equipments.length > 0 ? "grid grid-cols-2 gap-4" : "space-y-2"}>
                  <div className="space-y-2">
                    <Label htmlFor="edit-dl-asset">Bien concerné</Label>
                    <Select
                      value={formData.assetId || "none"}
                      onValueChange={(v) => setFormData({ ...formData, assetId: v })}
                    >
                      <SelectTrigger id="edit-dl-asset">
                        <SelectValue placeholder={isLoadingAssets ? "Chargement..." : "Sélectionner un bien (facultatif)"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Aucun bien</SelectItem>
                        {assets.map((asset) => (
                          <SelectItem key={asset.id} value={asset.id.toString()}>
                            {asset.name}
                          </SelectItem>
                        ))}
                        </SelectContent>
                      </Select>
                    </div>
        
                    {equipments.length > 0 && (
                      <div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-300">
                        <Label htmlFor="edit-dl-equipment">Équipement (facultatif)</Label>
                        <Select
                          value={formData.equipmentId || "none"}
                          onValueChange={(v) => setFormData({ ...formData, equipmentId: v })}
                        >
                          <SelectTrigger id="edit-dl-equipment">
                            <SelectValue placeholder={isLoadingEquipments ? "Chargement..." : "Sélectionner..."} />
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
                    )}
                  </div>
      
                  <div className="space-y-2">
                <Label htmlFor="edit-dl-label">Libellé *</Label>
                <Input
                  id="edit-dl-label"
                  value={formData.label}
                  onChange={(e) => setFormData({ ...formData, label: e.target.value })}
                  required
                />
              </div>
  
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="edit-dl-date">Date d'échéance</Label>
                    <DatePicker
                      id="edit-dl-date"
                      value={formData.deadlineDate}
                      onChange={(date) => setFormData({ ...formData, deadlineDate: date })}
                    />
                  </div>
                  <div className="space-y-2">
                  <Label htmlFor="edit-dl-type">Type (facultatif)</Label>
                  <Select
                    value={formData.deadlineType || 'none'}
                    onValueChange={(v) => setFormData({ ...formData, deadlineType: v })}
                  >
                    <SelectTrigger id="edit-dl-type">
                      <SelectValue placeholder="Sélectionner..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Aucun type</SelectItem>
                      {DEADLINE_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

            <div className="flex items-center space-x-2 py-2">
              <Checkbox 
                id="edit-dl-done" 
                checked={formData.isDone}
                onCheckedChange={(checked) => setFormData({ 
                  ...formData, 
                  isDone: !!checked,
                  doneDate: checked && !formData.doneDate ? new Date().toISOString().split('T')[0] : formData.doneDate
                })}
              />
              <Label htmlFor="edit-dl-done" className="cursor-pointer">Marquer comme réalisé</Label>
            </div>

            {formData.isDone && (
              <div className="space-y-2">
                <Label htmlFor="edit-dl-done-date">Date de réalisation</Label>
                <DatePicker
                  id="edit-dl-done-date"
                  value={formData.doneDate}
                  onChange={(date) => setFormData({ ...formData, doneDate: date })}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="edit-dl-notes">Notes (facultatif)</Label>
              <Textarea
                id="edit-dl-notes"
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                rows={3}
              />
            </div>

            <DialogFooter className="pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Enregistrement...' : 'Enregistrer les modifications'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
