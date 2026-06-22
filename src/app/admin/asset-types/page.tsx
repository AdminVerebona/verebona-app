"use client"

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Tags, Edit, Check, X, Plus, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface Subcategory {
  id: number;
  assetTypeId: number;
  code: string;
  label: string;
  icon: string | null;
  isEnabled: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface AssetType {
  id: number;
  code: string;
  label: string;
  icon: string | null;
  isEnabled: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
  subcategories: Subcategory[];
}

export default function AdminAssetTypesPage() {
  const [assetTypes, setAssetTypes] = useState<AssetType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openTypes, setOpenTypes] = useState<Set<number>>(new Set());
  
  // Add/Edit type dialogs state
  const [addTypeDialogOpen, setAddTypeDialogOpen] = useState(false);
  const [addTypeLoading, setAddTypeLoading] = useState(false);
  
  const [editTypeDialogOpen, setEditTypeDialogOpen] = useState(false);
  const [editingType, setEditingType] = useState<AssetType | null>(null);
  const [editTypeLoading, setEditTypeLoading] = useState(false);
  
  const [editSubcategoryDialogOpen, setEditSubcategoryDialogOpen] = useState(false);
  const [editingSubcategory, setEditingSubcategory] = useState<Subcategory | null>(null);
  const [editSubcategoryLoading, setEditSubcategoryLoading] = useState(false);

  const [addSubcategoryDialogOpen, setAddSubcategoryDialogOpen] = useState(false);
  const [selectedTypeForAdd, setSelectedTypeForAdd] = useState<AssetType | null>(null);
  const [addSubcategoryLoading, setAddSubcategoryLoading] = useState(false);

  const [deleteSubcategoryId, setDeleteSubcategoryId] = useState<number | null>(null);
  
  // Form states
  const [typeFormData, setTypeFormData] = useState({
    code: '',
    label: '',
    icon: '',
    isEnabled: true,
    displayOrder: 0,
  });

  const [subcategoryFormData, setSubcategoryFormData] = useState({
    code: '',
    label: '',
    icon: '',
    isEnabled: true,
    displayOrder: 0,
  });

  useEffect(() => {
    loadAssetTypes();
  }, []);

  const loadAssetTypes = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const token = localStorage.getItem('bearer_token');
      if (!token) {
        setError('Non authentifié');
        return;
      }

      const response = await fetch('/api/admin/asset-types', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Erreur lors du chargement des types de biens');
      }

      const data = await response.json();
      setAssetTypes(data);
      
      // Open all types by default
      const allTypeIds = new Set<number>(data.map((type: AssetType) => type.id));
      setOpenTypes(allTypeIds);
    } catch (err) {
      console.error('Error loading asset types:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  };

  const toggleType = (typeId: number) => {
    setOpenTypes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(typeId)) {
        newSet.delete(typeId);
      } else {
        newSet.add(typeId);
      }
      return newSet;
    });
  };

  const handleAddType = () => {
    setTypeFormData({
      code: '',
      label: '',
      icon: '',
      isEnabled: true,
      displayOrder: 0,
    });
    setAddTypeDialogOpen(true);
  };

  const handleSaveNewType = async () => {
    if (!typeFormData.code || !typeFormData.label) {
      toast.error('Le code et le libellé sont requis');
      return;
    }

    try {
      setAddTypeLoading(true);

      const token = localStorage.getItem('bearer_token');
      if (!token) return;

      const response = await fetch('/api/admin/asset-types', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(typeFormData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erreur lors de la création');
      }

      toast.success('Type de bien créé avec succès');
      setAddTypeDialogOpen(false);
      loadAssetTypes();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setAddTypeLoading(false);
    }
  };

  const handleEditType = (type: AssetType) => {
    setEditingType(type);
    setTypeFormData({
      code: type.code,
      label: type.label,
      icon: type.icon || '',
      isEnabled: type.isEnabled,
      displayOrder: type.displayOrder,
    });
    setEditTypeDialogOpen(true);
  };

  const handleSaveType = async () => {
    if (!editingType) return;

    try {
      setEditTypeLoading(true);

      const token = localStorage.getItem('bearer_token');
      if (!token) return;

      const response = await fetch(`/api/admin/asset-types/${editingType.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          label: typeFormData.label,
          icon: typeFormData.icon || null,
          isEnabled: typeFormData.isEnabled,
          displayOrder: typeFormData.displayOrder,
        }),
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la mise à jour');
      }

      toast.success('Type de bien mis à jour avec succès');
      setEditTypeDialogOpen(false);
      loadAssetTypes();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setEditTypeLoading(false);
    }
  };

  const handleAddSubcategory = (type: AssetType) => {
    setSelectedTypeForAdd(type);
    setSubcategoryFormData({
      code: '',
      label: '',
      icon: '',
      isEnabled: true,
      displayOrder: 0,
    });
    setAddSubcategoryDialogOpen(true);
  };

  const handleSaveNewSubcategory = async () => {
    if (!selectedTypeForAdd) return;

    if (!subcategoryFormData.code || !subcategoryFormData.label) {
      toast.error('Le code et le libellé sont requis');
      return;
    }

    try {
      setAddSubcategoryLoading(true);

      const token = localStorage.getItem('bearer_token');
      if (!token) return;

      const response = await fetch('/api/admin/asset-type-subcategories', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          assetTypeId: selectedTypeForAdd.id,
          ...subcategoryFormData,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erreur lors de la création');
      }

      toast.success('Sous-catégorie créée avec succès');
      setAddSubcategoryDialogOpen(false);
      loadAssetTypes();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setAddSubcategoryLoading(false);
    }
  };

  const handleEditSubcategory = (subcategory: Subcategory) => {
    setEditingSubcategory(subcategory);
    setSubcategoryFormData({
      code: subcategory.code,
      label: subcategory.label,
      icon: subcategory.icon || '',
      isEnabled: subcategory.isEnabled,
      displayOrder: subcategory.displayOrder,
    });
    setEditSubcategoryDialogOpen(true);
  };

  const handleSaveSubcategory = async () => {
    if (!editingSubcategory) return;

    try {
      setEditSubcategoryLoading(true);

      const token = localStorage.getItem('bearer_token');
      if (!token) return;

      const response = await fetch(`/api/admin/asset-type-subcategories/${editingSubcategory.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          label: subcategoryFormData.label,
          icon: subcategoryFormData.icon || null,
          isEnabled: subcategoryFormData.isEnabled,
          displayOrder: subcategoryFormData.displayOrder,
        }),
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la mise à jour');
      }

      toast.success('Sous-catégorie mise à jour avec succès');
      setEditSubcategoryDialogOpen(false);
      loadAssetTypes();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setEditSubcategoryLoading(false);
    }
  };

  const handleDeleteSubcategory = async (id: number) => {
    try {
      const token = localStorage.getItem('bearer_token');
      if (!token) return;

      const response = await fetch(`/api/admin/asset-type-subcategories/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la suppression');
      }

      toast.success('Sous-catégorie supprimée avec succès');
      setDeleteSubcategoryId(null);
      loadAssetTypes();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <p className="text-center text-destructive">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Types de biens</h1>
          <p className="text-muted-foreground mt-1">
            Configuration des catégories de biens et leurs sous-catégories disponibles sur la plateforme
          </p>
        </div>
        <Button onClick={handleAddType}>
          <Plus className="h-4 w-4 mr-2" />
          Ajouter un type de bien
        </Button>
      </div>

      {/* Asset Types List */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Tags className="w-5 h-5" />
            Types de biens ({assetTypes.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-20" />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {assetTypes.map((type) => (
                <Collapsible
                  key={type.id}
                  open={openTypes.has(type.id)}
                  onOpenChange={() => toggleType(type.id)}
                >
                  <div className="rounded-lg border">
                    {/* Asset Type Header */}
                    <div className="flex items-center justify-between p-4">
                      <div className="flex items-center gap-2 flex-1">
                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" size="sm" className="p-0 h-auto">
                            {openTypes.has(type.id) ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </Button>
                        </CollapsibleTrigger>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{type.label}</span>
                            <Badge variant="outline">{type.code}</Badge>
                            {type.isEnabled ? (
                              <Badge variant="default" className="bg-success">
                                <Check className="w-3 h-3 mr-1" />
                                Activé
                              </Badge>
                            ) : (
                              <Badge variant="secondary">
                                <X className="w-3 h-3 mr-1" />
                                Désactivé
                              </Badge>
                            )}
                            <Badge variant="outline">
                              {type.subcategories.length} sous-catégorie{type.subcategories.length !== 1 ? 's' : ''}
                            </Badge>
                          </div>
                          <div className="text-sm text-muted-foreground mt-1">
                            Icône: {type.icon || 'Aucune'} • Ordre: {type.displayOrder}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleAddSubcategory(type)}
                        >
                          <Plus className="h-4 w-4 mr-1" />
                          Ajouter sous-catégorie
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEditType(type)}
                        >
                          <Edit className="h-4 w-4 mr-1" />
                          Modifier
                        </Button>
                      </div>
                    </div>

                    {/* Subcategories */}
                    <CollapsibleContent>
                      {type.subcategories.length > 0 ? (
                        <div className="border-t bg-muted/30">
                          <div className="p-4 space-y-2">
                            {type.subcategories.map((subcategory) => (
                              <div
                                key={subcategory.id}
                                className="flex items-center justify-between p-3 rounded-lg border bg-card ml-6"
                              >
                                <div className="flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium">{subcategory.label}</span>
                                    <Badge variant="outline" className="text-xs">{subcategory.code}</Badge>
                                    {subcategory.isEnabled ? (
                                      <Badge variant="default" className="bg-success text-xs">
                                        <Check className="w-3 h-3 mr-1" />
                                        Activé
                                      </Badge>
                                    ) : (
                                      <Badge variant="secondary" className="text-xs">
                                        <X className="w-3 h-3 mr-1" />
                                        Désactivé
                                      </Badge>
                                    )}
                                  </div>
                                  <div className="text-xs text-muted-foreground mt-1">
                                    Icône: {subcategory.icon || 'Aucune'} • Ordre: {subcategory.displayOrder}
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleEditSubcategory(subcategory)}
                                  >
                                    <Edit className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setDeleteSubcategoryId(subcategory.id)}
                                  >
                                    <Trash2 className="h-4 w-4 text-destructive" />
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="border-t bg-muted/30 p-4 text-center text-sm text-muted-foreground">
                          Aucune sous-catégorie
                        </div>
                      )}
                    </CollapsibleContent>
                  </div>
                </Collapsible>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Type Dialog */}
      <Dialog open={addTypeDialogOpen} onOpenChange={setAddTypeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ajouter un type de bien</DialogTitle>
            <DialogDescription>
              Créer un nouveau type de bien pour organiser vos actifs
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div>
              <Label htmlFor="add-type-code">
                Code <span className="text-destructive">*</span>
              </Label>
              <Input
                id="add-type-code"
                value={typeFormData.code}
                onChange={(e) => setTypeFormData({ ...typeFormData, code: e.target.value.toUpperCase() })}
                placeholder="Ex: AUTRE"
              />
              <p className="text-xs text-muted-foreground mt-1">Code unique en majuscules</p>
            </div>

            <div>
              <Label htmlFor="add-type-label">
                Libellé <span className="text-destructive">*</span>
              </Label>
              <Input
                id="add-type-label"
                value={typeFormData.label}
                onChange={(e) => setTypeFormData({ ...typeFormData, label: e.target.value })}
                placeholder="Ex: Autre"
              />
            </div>

            <div>
              <Label htmlFor="add-type-icon">Icône (nom Lucide)</Label>
              <Input
                id="add-type-icon"
                value={typeFormData.icon}
                onChange={(e) => setTypeFormData({ ...typeFormData, icon: e.target.value })}
                placeholder="Ex: Package, Box, Grid"
              />
            </div>

            <div>
              <Label htmlFor="add-type-displayOrder">Ordre d'affichage</Label>
              <Input
                id="add-type-displayOrder"
                type="number"
                value={typeFormData.displayOrder}
                onChange={(e) => setTypeFormData({ ...typeFormData, displayOrder: parseInt(e.target.value) })}
              />
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="add-type-isEnabled">Activé</Label>
              <Switch
                id="add-type-isEnabled"
                checked={typeFormData.isEnabled}
                onCheckedChange={(checked) => setTypeFormData({ ...typeFormData, isEnabled: checked })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddTypeDialogOpen(false)}
              disabled={addTypeLoading}
            >
              Annuler
            </Button>
            <Button
              onClick={handleSaveNewType}
              disabled={addTypeLoading}
            >
              {addTypeLoading ? 'Création...' : 'Créer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Type Dialog */}
      <Dialog open={editTypeDialogOpen} onOpenChange={setEditTypeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modifier le type de bien</DialogTitle>
            <DialogDescription>
              {editingType && `Modification de: ${editingType.code}`}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div>
              <Label>Code</Label>
              <Input
                value={typeFormData.code}
                disabled
                className="bg-muted"
              />
              <p className="text-xs text-muted-foreground mt-1">Le code ne peut pas être modifié</p>
            </div>

            <div>
              <Label htmlFor="type-label">Libellé</Label>
              <Input
                id="type-label"
                value={typeFormData.label}
                onChange={(e) => setTypeFormData({ ...typeFormData, label: e.target.value })}
                placeholder="Ex: Bien immobilier"
              />
            </div>

            <div>
              <Label htmlFor="type-icon">Icône (nom Lucide)</Label>
              <Input
                id="type-icon"
                value={typeFormData.icon}
                onChange={(e) => setTypeFormData({ ...typeFormData, icon: e.target.value })}
                placeholder="Ex: Home, Car, Briefcase"
              />
            </div>

            <div>
              <Label htmlFor="type-displayOrder">Ordre d'affichage</Label>
              <Input
                id="type-displayOrder"
                type="number"
                value={typeFormData.displayOrder}
                onChange={(e) => setTypeFormData({ ...typeFormData, displayOrder: parseInt(e.target.value) })}
              />
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="type-isEnabled">Activé</Label>
              <Switch
                id="type-isEnabled"
                checked={typeFormData.isEnabled}
                onCheckedChange={(checked) => setTypeFormData({ ...typeFormData, isEnabled: checked })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditTypeDialogOpen(false)}
              disabled={editTypeLoading}
            >
              Annuler
            </Button>
            <Button
              onClick={handleSaveType}
              disabled={editTypeLoading}
            >
              {editTypeLoading ? 'Enregistrement...' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Subcategory Dialog */}
      <Dialog open={addSubcategoryDialogOpen} onOpenChange={setAddSubcategoryDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ajouter une sous-catégorie</DialogTitle>
            <DialogDescription>
              {selectedTypeForAdd && `Pour le type: ${selectedTypeForAdd.label}`}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div>
              <Label htmlFor="sub-code">
                Code <span className="text-destructive">*</span>
              </Label>
              <Input
                id="sub-code"
                value={subcategoryFormData.code}
                onChange={(e) => setSubcategoryFormData({ ...subcategoryFormData, code: e.target.value })}
                placeholder="Ex: APPARTEMENT"
              />
            </div>

            <div>
              <Label htmlFor="sub-label">
                Libellé <span className="text-destructive">*</span>
              </Label>
              <Input
                id="sub-label"
                value={subcategoryFormData.label}
                onChange={(e) => setSubcategoryFormData({ ...subcategoryFormData, label: e.target.value })}
                placeholder="Ex: Appartement"
              />
            </div>

            <div>
              <Label htmlFor="sub-icon">Icône (nom Lucide)</Label>
              <Input
                id="sub-icon"
                value={subcategoryFormData.icon}
                onChange={(e) => setSubcategoryFormData({ ...subcategoryFormData, icon: e.target.value })}
                placeholder="Ex: Building, Car"
              />
            </div>

            <div>
              <Label htmlFor="sub-displayOrder">Ordre d'affichage</Label>
              <Input
                id="sub-displayOrder"
                type="number"
                value={subcategoryFormData.displayOrder}
                onChange={(e) => setSubcategoryFormData({ ...subcategoryFormData, displayOrder: parseInt(e.target.value) })}
              />
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="sub-isEnabled">Activé</Label>
              <Switch
                id="sub-isEnabled"
                checked={subcategoryFormData.isEnabled}
                onCheckedChange={(checked) => setSubcategoryFormData({ ...subcategoryFormData, isEnabled: checked })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddSubcategoryDialogOpen(false)}
              disabled={addSubcategoryLoading}
            >
              Annuler
            </Button>
            <Button
              onClick={handleSaveNewSubcategory}
              disabled={addSubcategoryLoading}
            >
              {addSubcategoryLoading ? 'Création...' : 'Créer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Subcategory Dialog */}
      <Dialog open={editSubcategoryDialogOpen} onOpenChange={setEditSubcategoryDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modifier la sous-catégorie</DialogTitle>
            <DialogDescription>
              {editingSubcategory && `Modification de: ${editingSubcategory.code}`}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div>
              <Label>Code</Label>
              <Input
                value={subcategoryFormData.code}
                disabled
                className="bg-muted"
              />
              <p className="text-xs text-muted-foreground mt-1">Le code ne peut pas être modifié</p>
            </div>

            <div>
              <Label htmlFor="edit-sub-label">Libellé</Label>
              <Input
                id="edit-sub-label"
                value={subcategoryFormData.label}
                onChange={(e) => setSubcategoryFormData({ ...subcategoryFormData, label: e.target.value })}
                placeholder="Ex: Appartement"
              />
            </div>

            <div>
              <Label htmlFor="edit-sub-icon">Icône (nom Lucide)</Label>
              <Input
                id="edit-sub-icon"
                value={subcategoryFormData.icon}
                onChange={(e) => setSubcategoryFormData({ ...subcategoryFormData, icon: e.target.value })}
                placeholder="Ex: Building, Car"
              />
            </div>

            <div>
              <Label htmlFor="edit-sub-displayOrder">Ordre d'affichage</Label>
              <Input
                id="edit-sub-displayOrder"
                type="number"
                value={subcategoryFormData.displayOrder}
                onChange={(e) => setSubcategoryFormData({ ...subcategoryFormData, displayOrder: parseInt(e.target.value) })}
              />
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="edit-sub-isEnabled">Activé</Label>
              <Switch
                id="edit-sub-isEnabled"
                checked={subcategoryFormData.isEnabled}
                onCheckedChange={(checked) => setSubcategoryFormData({ ...subcategoryFormData, isEnabled: checked })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditSubcategoryDialogOpen(false)}
              disabled={editSubcategoryLoading}
            >
              Annuler
            </Button>
            <Button
              onClick={handleSaveSubcategory}
              disabled={editSubcategoryLoading}
            >
              {editSubcategoryLoading ? 'Enregistrement...' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Subcategory Confirmation */}
      <AlertDialog open={deleteSubcategoryId !== null} onOpenChange={() => setDeleteSubcategoryId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmer la suppression</AlertDialogTitle>
            <AlertDialogDescription>
              Êtes-vous sûr de vouloir supprimer cette sous-catégorie ? Cette action est irréversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteSubcategoryId && handleDeleteSubcategory(deleteSubcategoryId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
