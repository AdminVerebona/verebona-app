"use client"

import { useState, useCallback, useEffect } from 'react';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Home, Pencil, Trash2, Loader2, X, Save, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';

export interface RoomDrawerItem {
  id: number;
  name: string;
  orderIndex?: number;
  equipmentCount?: number;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  assetId: number;
  /** null = create mode */
  room: RoomDrawerItem | null;
  onRefresh: () => void;
}

export function RoomDrawer({ open, onOpenChange, assetId, room, onRefresh }: Props) {
  const isCreateMode = room === null;

  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Sync state when drawer opens
  useEffect(() => {
    if (open) {
      setName(room?.name ?? '');
      setIsEditing(isCreateMode);
    } else {
      setIsEditing(false);
    }
  }, [open, room, isCreateMode]);

  const enterEditMode = useCallback(() => {
    setName(room?.name ?? '');
    setIsEditing(true);
  }, [room]);

  const handleSave = useCallback(async () => {
    if (!name.trim()) { toast.error('Le nom est obligatoire'); return; }
    setIsSaving(true);
    try {
      if (isCreateMode) {
        await apiClient.post(`/api/assets/${assetId}/substructures`, { name: name.trim() });
        toast.success('Pièce créée');
      } else {
        await apiClient.patch(`/api/assets/${assetId}/substructures/${room!.id}`, { name: name.trim() });
        toast.success('Pièce mise à jour');
        setIsEditing(false);
      }
      onRefresh();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message ?? 'Erreur lors de la sauvegarde');
    } finally {
      setIsSaving(false);
    }
  }, [room, assetId, name, isCreateMode, onRefresh, onOpenChange]);

  const handleDelete = useCallback(async () => {
    if (!room) return;
    setIsDeleting(true);
    try {
      await apiClient.delete(`/api/assets/${assetId}/substructures/${room.id}`);
      toast.success('Pièce supprimée');
      onOpenChange(false);
      onRefresh();
    } catch (err: any) {
      toast.error(err?.message ?? 'Erreur lors de la suppression');
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  }, [room, assetId, onOpenChange, onRefresh]);

  const eqCount = room?.equipmentCount ?? 0;

  return (
    <>
      <Sheet open={open} onOpenChange={(v) => { if (!v) setIsEditing(false); onOpenChange(v); }}>
        <SheetContent className="w-full sm:max-w-md flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3">
            <div className="flex items-center gap-2">
              <Home className="w-5 h-5 text-muted-foreground flex-shrink-0" />
              <SheetTitle>
                {isCreateMode ? 'Ajouter une pièce' : isEditing ? 'Modifier la pièce' : room!.name}
              </SheetTitle>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto">
            {isEditing || isCreateMode ? (
              <div className="px-5 py-4 space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="room-name">Nom de la pièce</Label>
                  <Input
                    id="room-name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="Ex: Salon, Cuisine…"
                    autoFocus
                  />
                </div>
                {!isCreateMode && eqCount > 0 && (
                  <p className="text-sm text-muted-foreground border rounded-md p-3 bg-muted/30">
                    <span className="font-medium">{eqCount}</span> équipement{eqCount > 1 ? 's' : ''} rattaché{eqCount > 1 ? 's' : ''}
                  </p>
                )}
              </div>
            ) : (
              <div className="px-5 py-4 space-y-3">
                {eqCount > 0 && (
                  <div className="text-sm text-muted-foreground border rounded-md p-3 bg-muted/30">
                    <span className="font-medium">{eqCount}</span> équipement{eqCount > 1 ? 's' : ''} rattaché{eqCount > 1 ? 's' : ''}
                  </div>
                )}

                <Separator />

                {/* Action bar */}
                <div className="flex items-stretch rounded-xl border border-border bg-muted/30 overflow-hidden mt-2">
                  <button
                    className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground"
                    onClick={enterEditMode}
                  >
                    <Pencil className="w-4 h-4" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider">Modifier</span>
                  </button>
                  <div className="w-px bg-border" />
                  <button
                    className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-destructive/10 transition-colors text-destructive disabled:opacity-40"
                    onClick={() => setShowDeleteConfirm(true)}
                    disabled={isDeleting}
                  >
                    <Trash2 className="w-4 h-4" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider">Supprimer</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {(isEditing || isCreateMode) && (
            <div className="px-5 py-4 border-t">
              <div className="flex items-stretch rounded-xl border border-border bg-muted/30 overflow-hidden">
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-muted/60 transition-colors text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={() => { if (isCreateMode) onOpenChange(false); else setIsEditing(false); }}
                  disabled={isSaving}
                >
                  <X className="w-4 h-4" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider">Annuler</span>
                </button>
                <div className="w-px bg-border" />
                <button
                  type="button"
                  className="flex-1 flex flex-col items-center gap-1.5 py-3 px-2 hover:bg-primary/10 transition-colors text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={handleSave}
                  disabled={isSaving || !name.trim()}
                >
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : isCreateMode ? <Plus className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                  <span className="text-[10px] font-semibold uppercase tracking-wider">{isSaving ? 'Sauvegarde…' : isCreateMode ? 'Ajouter' : 'Enregistrer'}</span>
                </button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer cette pièce ?</AlertDialogTitle>
            <AlertDialogDescription>
              {eqCount > 0
                ? `Cette pièce contient ${eqCount} équipement${eqCount > 1 ? 's' : ''}. ${eqCount > 1 ? 'Ils seront' : 'Il sera'} déplacé${eqCount > 1 ? 's' : ''} dans "Sans pièce". Cette action est irréversible.`
                : 'La pièce sera supprimée. Cette action est irréversible.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
