"use client";

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DatePicker } from '@/components/ui/date-picker';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';

interface CreateDeadlineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: number;
  equipmentId?: number | null;
  substructureId?: number | null;
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

export function CreateDeadlineDialog({
  open,
  onOpenChange,
  assetId,
  equipmentId,
  substructureId,
  onSuccess,
}: CreateDeadlineDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    label: '',
    deadlineDate: new Date().toISOString().split('T')[0],
    deadlineType: 'ENTRETIEN',
    notes: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.label.trim()) {
      toast.error('Le libellé est requis');
      return;
    }

    setIsSubmitting(true);
    try {
      await apiClient.post('/api/deadlines', {
        assetId,
        equipmentId: equipmentId || null,
        substructureId: substructureId || null,
        ...formData,
      });
      toast.success('Rappel créé avec succès');
      onSuccess?.();
      onOpenChange(false);
      setFormData({
        label: '',
        deadlineDate: new Date().toISOString().split('T')[0],
        deadlineType: 'ENTRETIEN',
        notes: '',
      });
    } catch (error: any) {
      toast.error(error.message || 'Erreur lors de la création du rappel');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Créer un rappel</DialogTitle>
          <DialogDescription>
            Ajoutez une échéance ou un rappel pour cet élément.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label htmlFor="dl-label">Libellé *</Label>
            <Input
              id="dl-label"
              placeholder="Ex: Entretien annuel, Fin de garantie..."
              value={formData.label}
              onChange={(e) => setFormData({ ...formData, label: e.target.value })}
              required
            />
          </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="dl-date">Date d'échéance *</Label>
                <DatePicker
                  id="dl-date"
                  value={formData.deadlineDate}
                  onChange={(date) => setFormData({ ...formData, deadlineDate: date })}
                />
              </div>
              <div className="space-y-2">
              <Label htmlFor="dl-type">Type *</Label>
              <Select
                value={formData.deadlineType}
                onValueChange={(v) => setFormData({ ...formData, deadlineType: v })}
              >
                <SelectTrigger id="dl-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEADLINE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="dl-notes">Notes (facultatif)</Label>
            <Textarea
              id="dl-notes"
              placeholder="Détails supplémentaires..."
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
              {isSubmitting ? 'Création...' : 'Créer le rappel'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
