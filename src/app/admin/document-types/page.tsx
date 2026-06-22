"use client"

import { useEffect, useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { FileType, Edit, Check, X, Plus, ChevronDown, ChevronRight, Trash2, Package, Tag } from 'lucide-react';
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

interface AssetType {
  id: number;
  code: string;
  label: string;
}

interface AssetTypeSubcategory {
  id: number;
  code: string;
  label: string;
}

interface AssetAssociation {
  id: number;
  assetType: AssetType | null;
  assetTypeSubcategory: AssetTypeSubcategory | null;
  isRequired: boolean;
}

interface ExportAssociation {
  id: number;
  exportType: string | null;
  includeByDefault: boolean;
  displayOrder: number;
}

interface DocumentType {
  id: number;
  code: string;
  label: string;
  description: string | null;
  examples: string | null;
  isActive: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
  assetAssociations: AssetAssociation[];
  exportAssociations: ExportAssociation[];
}

const EXPORT_TYPES = [
  { value: 'REVENTE', label: 'Revente du bien' },
  { value: 'ASSURANCE_DEVIS', label: 'Assurance - Devis' },
  { value: 'ASSURANCE_SINISTRE', label: 'Assurance - Sinistre' },
  { value: 'SAV_GARANTIE', label: 'SAV & Garantie' },
  { value: 'CIL', label: 'CIL (Carnet d\'Information du Logement)' },
  { value: 'DOSSIER_COMPLET', label: 'Dossier complet' },
];

export default function AdminDocumentTypesPage() {
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);
  const [assetTypes, setAssetTypes] = useState<AssetType[]>([]);
  const [allSubcategories, setAllSubcategories] = useState<(AssetTypeSubcategory & { assetTypeId: number })[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openTypes, setOpenTypes] = useState<Set<number>>(new Set());
  
  // Add/Edit dialogs state
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addLoading, setAddLoading] = useState(false);
  
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingType, setEditingType] = useState<DocumentType | null>(null);
  const [editLoading, setEditLoading] = useState(false);

  const [deleteTypeId, setDeleteTypeId] = useState<number | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  
  // Form states
  const [formData, setFormData] = useState({
    code: '',
    label: '',
    description: '',
    examples: '',
    isActive: true,
    displayOrder: 0,
  });

  // Association states
  const [selectedAssetTypes, setSelectedAssetTypes] = useState<Set<number>>(new Set());
  const [selectedSubcategories, setSelectedSubcategories] = useState<Set<number>>(new Set());
  const [selectedExportTypes, setSelectedExportTypes] = useState<Set<string>>(new Set());

  useEffect(() => {
    Promise.all([loadDocumentTypes(), loadAssetTypes()]);
  }, []);

  const loadDocumentTypes = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const token = localStorage.getItem('bearer_token');
      if (!token) {
        setError('Non authentifié');
        return;
      }

      const response = await fetch('/api/admin/document-types', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Erreur lors du chargement des types de documents');
      }

      const data = await response.json();
      setDocumentTypes(data);
      
      // Open all types by default
      const allTypeIds = new Set<number>(data.map((type: DocumentType) => type.id));
      setOpenTypes(allTypeIds);
    } catch (err) {
      console.error('Error loading document types:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  };

  const loadAssetTypes = async () => {
    try {
      const token = localStorage.getItem('bearer_token');
      if (!token) return;

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
      
      // Flatten all subcategories with their parent asset type
      const subs: (AssetTypeSubcategory & { assetTypeId: number })[] = [];
      if (data && Array.isArray(data)) {
        data.forEach((assetType: any) => {
          if (assetType.subcategories && Array.isArray(assetType.subcategories)) {
            assetType.subcategories.forEach((sub: any) => {
              subs.push({ ...sub, assetTypeId: assetType.id });
            });
          }
        });
      }
      setAllSubcategories(subs);
    } catch (err) {
      console.error('Error loading asset types:', err);
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

  const handleAdd = () => {
    setFormData({
      code: '',
      label: '',
      description: '',
      examples: '',
      isActive: true,
      displayOrder: 0,
    });
    setSelectedAssetTypes(new Set());
    setSelectedSubcategories(new Set());
    setSelectedExportTypes(new Set());
    setAddDialogOpen(true);
  };

  const handleSaveNew = async () => {
    if (!formData.code || !formData.label) {
      toast.error('Le code et le libellé sont requis');
      return;
    }

    try {
      setAddLoading(true);

      const token = localStorage.getItem('bearer_token');
      if (!token) return;

      // Build asset associations
      const assetAssociations: any[] = [];
      
      // Add associations for selected asset types
      selectedAssetTypes.forEach(assetTypeId => {
        assetAssociations.push({
          assetTypeId,
          assetTypeSubcategoryId: null,
          isRequired: false,
        });
      });
      
      // Add associations for selected subcategories
      selectedSubcategories.forEach(subcategoryId => {
        assetAssociations.push({
          assetTypeId: null,
          assetTypeSubcategoryId: subcategoryId,
          isRequired: false,
        });
      });

      // Build export associations
      const exportAssociations: any[] = [];
      selectedExportTypes.forEach(exportType => {
        exportAssociations.push({
          exportType,
          includeByDefault: true,
          displayOrder: 0,
        });
      });

      const response = await fetch('/api/admin/document-types', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...formData,
          assetAssociations,
          exportAssociations,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erreur lors de la création');
      }

      toast.success('Type de document créé avec succès');
      setAddDialogOpen(false);
      loadDocumentTypes();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setAddLoading(false);
    }
  };

  const handleEdit = (docType: DocumentType) => {
    setEditingType(docType);
    setFormData({
      code: docType.code,
      label: docType.label,
      description: docType.description || '',
      examples: docType.examples || '',
      isActive: docType.isActive,
      displayOrder: docType.displayOrder,
    });

    // Load current associations
    const assetTypeIds = new Set(
      docType.assetAssociations
        .filter(a => a.assetType)
        .map(a => a.assetType!.id)
    );
    const subcategoryIds = new Set(
      docType.assetAssociations
        .filter(a => a.assetTypeSubcategory)
        .map(a => a.assetTypeSubcategory!.id)
    );
    const exportTypeSet = new Set(
      docType.exportAssociations
        .filter(a => a.exportType)
        .map(a => a.exportType!)
    );

    setSelectedAssetTypes(assetTypeIds);
    setSelectedSubcategories(subcategoryIds);
    setSelectedExportTypes(exportTypeSet);
    setEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!editingType) return;

    try {
      setEditLoading(true);

      const token = localStorage.getItem('bearer_token');
      if (!token) return;

      // Build asset associations
      const assetAssociations: any[] = [];
      
      selectedAssetTypes.forEach(assetTypeId => {
        assetAssociations.push({
          assetTypeId,
          assetTypeSubcategoryId: null,
          isRequired: false,
        });
      });
      
      selectedSubcategories.forEach(subcategoryId => {
        assetAssociations.push({
          assetTypeId: null,
          assetTypeSubcategoryId: subcategoryId,
          isRequired: false,
        });
      });

      // Build export associations
      const exportAssociations: any[] = [];
      selectedExportTypes.forEach(exportType => {
        exportAssociations.push({
          exportType,
          includeByDefault: true,
          displayOrder: 0,
        });
      });

      const response = await fetch(`/api/admin/document-types/${editingType.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          label: formData.label,
          description: formData.description || null,
          isActive: formData.isActive,
          displayOrder: formData.displayOrder,
          assetAssociations,
          exportAssociations,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erreur lors de la mise à jour');
      }

      toast.success('Type de document mis à jour avec succès');
      setEditDialogOpen(false);
      loadDocumentTypes();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setEditLoading(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      setDeleteLoading(true);

      const token = localStorage.getItem('bearer_token');
      if (!token) return;

      const response = await fetch(`/api/admin/document-types/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ confirmId: id }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erreur lors de la suppression');
      }

      toast.success('Type de document supprimé avec succès');
      setDeleteTypeId(null);
      loadDocumentTypes();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setDeleteLoading(false);
    }
  };

  const toggleAssetType = (assetTypeId: number) => {
    setSelectedAssetTypes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(assetTypeId)) {
        newSet.delete(assetTypeId);
      } else {
        newSet.add(assetTypeId);
      }
      return newSet;
    });
  };

  const toggleSubcategory = (subcategoryId: number) => {
    setSelectedSubcategories(prev => {
      const newSet = new Set(prev);
      if (newSet.has(subcategoryId)) {
        newSet.delete(subcategoryId);
      } else {
        newSet.add(subcategoryId);
      }
      return newSet;
    });
  };

  const toggleExportType = (exportType: string) => {
    setSelectedExportTypes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(exportType)) {
        newSet.delete(exportType);
      } else {
        newSet.add(exportType);
      }
      return newSet;
    });
  };

  const getSubcategoriesForAssetType = (assetTypeId: number) => {
    return allSubcategories.filter(sub => sub.assetTypeId === assetTypeId);
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
          <h1 className="text-2xl md:text-3xl font-bold">Types de documents</h1>
          <p className="text-muted-foreground mt-1">
            Gérez les types de documents disponibles, leurs associations aux biens et aux exports
          </p>
        </div>
        <Button onClick={handleAdd}>
          <Plus className="h-4 w-4 mr-2" />
          Ajouter un type de document
        </Button>
      </div>

      {/* Document Types List */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileType className="w-5 h-5" />
            Types de documents ({documentTypes.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
          ) : documentTypes.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Aucun type de document. Commencez par en ajouter un.
            </div>
          ) : (
            <div className="space-y-3">
              {documentTypes.map((docType) => (
                <Collapsible
                  key={docType.id}
                  open={openTypes.has(docType.id)}
                  onOpenChange={() => toggleType(docType.id)}
                >
                  <div className="rounded-lg border">
                    {/* Document Type Header */}
                    <div className="flex items-center justify-between p-4">
                      <div className="flex items-center gap-2 flex-1">
                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" size="sm" className="p-0 h-auto">
                            {openTypes.has(docType.id) ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </Button>
                        </CollapsibleTrigger>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium">{docType.label}</span>
                            <Badge variant="outline">{docType.code}</Badge>
                            {docType.isActive ? (
                              <Badge variant="default" className="bg-green-600">
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
                              {docType.assetAssociations.length} bien{docType.assetAssociations.length !== 1 ? 's' : ''}
                            </Badge>
                            <Badge variant="outline">
                              {docType.exportAssociations.length} export{docType.exportAssociations.length !== 1 ? 's' : ''}
                            </Badge>
                          </div>
                          {docType.description && (
                            <p className="text-sm text-muted-foreground mt-1">{docType.description}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEdit(docType)}
                        >
                          <Edit className="h-4 w-4 mr-1" />
                          Modifier
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setDeleteTypeId(docType.id)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>

                    {/* Associations Details */}
                    <CollapsibleContent>
                      <div className="border-t bg-muted/30 p-4 space-y-4">
                        {/* Asset Associations */}
                        <div>
                          <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                            <Package className="h-4 w-4" />
                            Types de biens associés ({docType.assetAssociations.length})
                          </h4>
                          {docType.assetAssociations.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                              {docType.assetAssociations.map((assoc) => (
                                <Badge key={assoc.id} variant="secondary">
                                  {assoc.assetType?.label || assoc.assetTypeSubcategory?.label || 'N/A'}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground">Aucune association</p>
                          )}
                        </div>

                        {/* Export Associations */}
                        <div>
                          <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                            <Tag className="h-4 w-4" />
                            Types d'export associés ({docType.exportAssociations.length})
                          </h4>
                          {docType.exportAssociations.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                              {docType.exportAssociations.map((assoc) => {
                                const exportTypeLabel = EXPORT_TYPES.find(et => et.value === assoc.exportType)?.label || assoc.exportType;
                                return (
                                  <Badge key={assoc.id} variant="secondary" className="gap-1">
                                    {exportTypeLabel}
                                    {assoc.includeByDefault && (
                                      <Check className="h-3 w-3 ml-1 text-green-600" />
                                    )}
                                  </Badge>
                                );
                              })}
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground">Aucune association</p>
                          )}
                        </div>
                      </div>
                    </CollapsibleContent>
                  </div>
                </Collapsible>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Dialog */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Ajouter un type de document</DialogTitle>
            <DialogDescription>
              Créer un nouveau type de document et définir ses associations
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-6">
            {/* Basic Info */}
            <div className="space-y-4">
              <h3 className="font-medium">Informations générales</h3>
              
              <div>
                <Label htmlFor="add-code">
                  Code <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="add-code"
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                  placeholder="Ex: FACTURE_ACHAT"
                />
                <p className="text-xs text-muted-foreground mt-1">Code unique en majuscules</p>
              </div>

              <div>
                <Label htmlFor="add-label">
                  Libellé <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="add-label"
                  value={formData.label}
                  onChange={(e) => setFormData({ ...formData, label: e.target.value })}
                  placeholder="Ex: Facture d'achat"
                />
              </div>

              <div>
                <Label htmlFor="add-description">Description</Label>
                <Input
                  id="add-description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Description optionnelle"
                />
              </div>

              <div>
                <Label htmlFor="add-examples">Exemples</Label>
                <Input
                  id="add-examples"
                  value={formData.examples}
                  onChange={(e) => setFormData({ ...formData, examples: e.target.value })}
                  placeholder="Ex: Certificat de propriété, Attestation notariale, etc."
                />
                <p className="text-xs text-muted-foreground mt-1">Exemples de documents pour guider les utilisateurs</p>
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="add-isActive">Activé</Label>
                <Switch
                  id="add-isActive"
                  checked={formData.isActive}
                  onCheckedChange={(checked) => setFormData({ ...formData, isActive: checked })}
                />
              </div>
            </div>

            {/* Asset Type Associations */}
            <div className="space-y-4">
              <h3 className="font-medium">Types de biens associés</h3>
              <p className="text-sm text-muted-foreground">Sélectionnez les types de biens pour lesquels ce document est pertinent</p>
              
              <div className="space-y-3">
                {assetTypes.map((assetType) => {
                  const subcategories = getSubcategoriesForAssetType(assetType.id);
                  return (
                    <div key={assetType.id} className="space-y-2">
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id={`asset-${assetType.id}`}
                          checked={selectedAssetTypes.has(assetType.id)}
                          onCheckedChange={() => toggleAssetType(assetType.id)}
                        />
                        <label
                          htmlFor={`asset-${assetType.id}`}
                          className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                        >
                          {assetType.label}
                        </label>
                      </div>
                      
                      {subcategories.length > 0 && (
                        <div className="ml-6 space-y-2">
                          {subcategories.map((sub) => (
                            <div key={sub.id} className="flex items-center space-x-2">
                              <Checkbox
                                id={`sub-${sub.id}`}
                                checked={selectedSubcategories.has(sub.id)}
                                onCheckedChange={() => toggleSubcategory(sub.id)}
                              />
                              <label
                                htmlFor={`sub-${sub.id}`}
                                className="text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                              >
                                {sub.label}
                              </label>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Export Type Associations */}
            <div className="space-y-4">
              <h3 className="font-medium">Types d'export associés</h3>
              <p className="text-sm text-muted-foreground">Sélectionnez les types d'export pour lesquels ce document doit être inclus par défaut</p>
              
              <div className="space-y-2">
                {EXPORT_TYPES.map((exportType) => (
                  <div key={exportType.value} className="flex items-center space-x-2">
                    <Checkbox
                      id={`export-${exportType.value}`}
                      checked={selectedExportTypes.has(exportType.value)}
                      onCheckedChange={() => toggleExportType(exportType.value)}
                    />
                    <label
                      htmlFor={`export-${exportType.value}`}
                      className="text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                    >
                      {exportType.label}
                    </label>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddDialogOpen(false)}
              disabled={addLoading}
            >
              Annuler
            </Button>
            <Button
              onClick={handleSaveNew}
              disabled={addLoading}
            >
              {addLoading ? 'Création...' : 'Créer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Modifier le type de document</DialogTitle>
            <DialogDescription>
              {editingType && `Modification de: ${editingType.code}`}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-6">
            {/* Basic Info */}
            <div className="space-y-4">
              <h3 className="font-medium">Informations générales</h3>
              
              <div>
                <Label>Code</Label>
                <Input
                  value={formData.code}
                  disabled
                  className="bg-muted"
                />
                <p className="text-xs text-muted-foreground mt-1">Le code ne peut pas être modifié</p>
              </div>

              <div>
                <Label htmlFor="edit-label">Libellé</Label>
                <Input
                  id="edit-label"
                  value={formData.label}
                  onChange={(e) => setFormData({ ...formData, label: e.target.value })}
                  placeholder="Ex: Facture d'achat"
                />
              </div>

              <div>
                <Label htmlFor="edit-description">Description</Label>
                <Input
                  id="edit-description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Description optionnelle"
                />
              </div>

              <div>
                <Label htmlFor="edit-examples">Exemples</Label>
                <Input
                  id="edit-examples"
                  value={formData.examples}
                  onChange={(e) => setFormData({ ...formData, examples: e.target.value })}
                  placeholder="Ex: Certificat de propriété, Attestation notariale, etc."
                />
                <p className="text-xs text-muted-foreground mt-1">Exemples de documents pour guider les utilisateurs</p>
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="edit-isActive">Activé</Label>
                <Switch
                  id="edit-isActive"
                  checked={formData.isActive}
                  onCheckedChange={(checked) => setFormData({ ...formData, isActive: checked })}
                />
              </div>
            </div>

            {/* Asset Type Associations */}
            <div className="space-y-4">
              <h3 className="font-medium">Types de biens associés</h3>
              <p className="text-sm text-muted-foreground">Sélectionnez les types de biens pour lesquels ce document est pertinent</p>
              
              <div className="space-y-3">
                {assetTypes.map((assetType) => {
                  const subcategories = getSubcategoriesForAssetType(assetType.id);
                  return (
                    <div key={assetType.id} className="space-y-2">
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id={`edit-asset-${assetType.id}`}
                          checked={selectedAssetTypes.has(assetType.id)}
                          onCheckedChange={() => toggleAssetType(assetType.id)}
                        />
                        <label
                          htmlFor={`edit-asset-${assetType.id}`}
                          className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                        >
                          {assetType.label}
                        </label>
                      </div>
                      
                      {subcategories.length > 0 && (
                        <div className="ml-6 space-y-2">
                          {subcategories.map((sub) => (
                            <div key={sub.id} className="flex items-center space-x-2">
                              <Checkbox
                                id={`edit-sub-${sub.id}`}
                                checked={selectedSubcategories.has(sub.id)}
                                onCheckedChange={() => toggleSubcategory(sub.id)}
                              />
                              <label
                                htmlFor={`edit-sub-${sub.id}`}
                                className="text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                              >
                                {sub.label}
                              </label>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Export Type Associations */}
            <div className="space-y-4">
              <h3 className="font-medium">Types d'export associés</h3>
              <p className="text-sm text-muted-foreground">Sélectionnez les types d'export pour lesquels ce document doit être inclus par défaut</p>
              
              <div className="space-y-2">
                {EXPORT_TYPES.map((exportType) => (
                  <div key={exportType.value} className="flex items-center space-x-2">
                    <Checkbox
                      id={`edit-export-${exportType.value}`}
                      checked={selectedExportTypes.has(exportType.value)}
                      onCheckedChange={() => toggleExportType(exportType.value)}
                    />
                    <label
                      htmlFor={`edit-export-${exportType.value}`}
                      className="text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                    >
                      {exportType.label}
                    </label>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditDialogOpen(false)}
              disabled={editLoading}
            >
              Annuler
            </Button>
            <Button
              onClick={handleSaveEdit}
              disabled={editLoading}
            >
              {editLoading ? 'Enregistrement...' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteTypeId !== null} onOpenChange={() => setDeleteTypeId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmer la suppression</AlertDialogTitle>
            <AlertDialogDescription>
              Êtes-vous sûr de vouloir supprimer ce type de document ? Cette action supprimera également toutes les associations. Cette action est irréversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteLoading}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTypeId && handleDelete(deleteTypeId)}
              disabled={deleteLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteLoading ? 'Suppression...' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
