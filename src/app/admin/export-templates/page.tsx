"use client"

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  FileType, 
  Plus, 
  Search,
  Edit,
  Trash2,
  AlertCircle,
  CheckCircle,
  XCircle,
} from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';

interface ExportTemplate {
  id: number;
  code: string;
  label: string;
  description?: string;
  templateContent: string;
  variables?: string;
  category: 'IMMOBILIER' | 'VEHICULE' | 'MATERIEL_PRO' | 'GENERAL';
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedByUser?: {
    id: number;
    email: string;
    firstName: string;
    lastName: string;
  } | null;
}

interface AssetType {
  id: number;
  code: string;
  label: string;
  icon: string | null;
  isEnabled: boolean;
}

interface Subcategory {
  id: number;
  assetTypeId: number;
  code: string;
  label: string;
  icon: string | null;
  isEnabled: boolean;
}

const CATEGORIES = [
  { value: 'GENERAL', label: 'Général' },
  { value: 'IMMOBILIER', label: 'Immobilier' },
  { value: 'VEHICULE', label: 'Véhicule' },
  { value: 'MATERIEL_PRO', label: 'Matériel Pro' },
];

const EXPORT_TYPES = [
  { value: 'DOSSIER_VENTE', label: 'Dossier de vente' },
  { value: 'ASSURANCE_DEVIS', label: 'Assurance - Devis' },
  { value: 'ASSURANCE_SINISTRE', label: 'Assurance - Sinistre' },
  { value: 'CIL', label: 'CIL (Certificat d\'immatriculation)' },
  { value: 'DOSSIER_COMPLET', label: 'Dossier complet' },
  { value: 'REVENTE', label: 'Revente' },
  { value: 'SAV_GARANTIE', label: 'SAV / Garantie' },
  { value: 'AUTRE', label: 'Autre' },
];

export default function ExportTemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<ExportTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Asset Types & Subcategories
  const [assetTypes, setAssetTypes] = useState<AssetType[]>([]);
  const [subcategories, setSubcategories] = useState<Subcategory[]>([]);
  const [filteredSubcategories, setFilteredSubcategories] = useState<Subcategory[]>([]);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // Create dialog
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createForm, setCreateForm] = useState({
    code: '',
    label: '',
    description: '',
    pdfmonkeyTemplateId: '',
    variables: '',
    category: 'GENERAL' as const,
    exportType: 'none',
    assetTypeId: 'none',
    subcategoryId: 'none',
    isActive: true,
  });
  const [isCreating, setIsCreating] = useState(false);

  // Delete dialog
  const [deleteDialog, setDeleteDialog] = useState<{ show: boolean; template: ExportTemplate | null }>({
    show: false,
    template: null,
  });
  const [isDeleting, setIsDeleting] = useState(false);

  // Preview dialog
  const [previewDialog, setPreviewDialog] = useState<{ show: boolean; template: ExportTemplate | null }>({
    show: false,
    template: null,
  });

  useEffect(() => {
    loadTemplates();
    loadAssetTypes();
  }, [categoryFilter, statusFilter, searchQuery]);

  // Update filtered subcategories when asset type changes
  useEffect(() => {
    if (createForm.assetTypeId && createForm.assetTypeId !== 'none') {
      const filtered = subcategories.filter(
        sub => sub.assetTypeId === parseInt(createForm.assetTypeId)
      );
      setFilteredSubcategories(filtered);
      // Reset subcategory selection if not in new list
      if (createForm.subcategoryId !== 'none' && !filtered.find(s => s.id === parseInt(createForm.subcategoryId))) {
        setCreateForm(prev => ({ ...prev, subcategoryId: 'none' }));
      }
    } else {
      setFilteredSubcategories([]);
      setCreateForm(prev => ({ ...prev, subcategoryId: 'none' }));
    }
  }, [createForm.assetTypeId, subcategories]);

  // Load asset types and subcategories
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

      if (response.ok) {
        const data = await response.json();
        setAssetTypes(data);
        
        // Extract all subcategories
        const allSubcategories = data.flatMap((type: any) => 
          type.subcategories || []
        );
        setSubcategories(allSubcategories);
      }
    } catch (err) {
      console.error('Error loading asset types:', err);
    }
  };

  const loadTemplates = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const token = localStorage.getItem('bearer_token');
      if (!token) {
        router.push('/login?redirect=/admin/export-templates');
        return;
      }

      const params = new URLSearchParams();
      if (categoryFilter !== 'all') params.append('category', categoryFilter);
      if (statusFilter !== 'all') params.append('isActive', statusFilter);
      if (searchQuery.trim()) params.append('search', searchQuery.trim());
      params.append('limit', '100');

      const response = await fetch(`/api/admin/export-templates?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          router.push('/login?redirect=/admin/export-templates');
          return;
        }
        throw new Error('Erreur lors du chargement des modèles');
      }

      const data = await response.json();
      setTemplates(data.data || []);
    } catch (err) {
      console.error('Error loading templates:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateTemplate = async () => {
    if (!createForm.code.trim() || !createForm.label.trim()) {
      toast.error('Code et libellé sont obligatoires');
      return;
    }

    if (!createForm.pdfmonkeyTemplateId.trim()) {
      toast.error('L\'ID du template PDFMonkey est obligatoire');
      return;
    }

    try {
      setIsCreating(true);
      const token = localStorage.getItem('bearer_token');

      // Parse variables if provided
      let parsedVariables = null;
      if (createForm.variables.trim()) {
        try {
          parsedVariables = JSON.parse(createForm.variables);
        } catch {
          toast.error('Format JSON invalide pour les variables');
          return;
        }
      }

      const response = await fetch('/api/admin/export-templates', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          code: createForm.code.trim(),
          label: createForm.label.trim(),
          description: createForm.description.trim() || undefined,
          pdfmonkeyTemplateId: createForm.pdfmonkeyTemplateId.trim(),
          variables: parsedVariables ? JSON.stringify(parsedVariables) : undefined,
          category: createForm.category,
          exportType: createForm.exportType !== 'none' ? createForm.exportType : undefined,
          assetTypeId: createForm.assetTypeId !== 'none' ? parseInt(createForm.assetTypeId) : undefined,
          assetTypeSubcategoryId: createForm.subcategoryId !== 'none' ? parseInt(createForm.subcategoryId) : undefined,
          isActive: createForm.isActive,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Erreur lors de la création');
      }

      toast.success('Modèle créé avec succès');
      setShowCreateDialog(false);
      setCreateForm({
        code: '',
        label: '',
        description: '',
        pdfmonkeyTemplateId: '',
        variables: '',
        category: 'GENERAL',
        exportType: 'none',
        assetTypeId: 'none',
        subcategoryId: 'none',
        isActive: true,
      });
      loadTemplates();
    } catch (err) {
      console.error('Error creating template:', err);
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la création');
    } finally {
      setIsCreating(false);
    }
  };

  const handleDeleteTemplate = async () => {
    if (!deleteDialog.template) return;

    try {
      setIsDeleting(true);
      const token = localStorage.getItem('bearer_token');

      const response = await fetch(`/api/admin/export-templates/${deleteDialog.template.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          confirmId: deleteDialog.template.id,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Erreur lors de la suppression');
      }

      toast.success('Modèle supprimé avec succès');
      setDeleteDialog({ show: false, template: null });
      loadTemplates();
    } catch (err) {
      console.error('Error deleting template:', err);
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la suppression');
    } finally {
      setIsDeleting(false);
    }
  };

  const getCategoryLabel = (category: string) => {
    return CATEGORIES.find(c => c.value === category)?.label || category;
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-24 w-full" />
        <div className="grid gap-4">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <p>{error}</p>
            </div>
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
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <FileType className="h-8 w-8" />
            Modèles d'export
          </h1>
          <p className="text-muted-foreground mt-1">
            Gérez les templates PDFMonkey pour la génération de documents PDF
          </p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Nouveau modèle
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Rechercher par code ou libellé..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger>
                <SelectValue placeholder="Catégorie" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Toutes les catégories</SelectItem>
                {CATEGORIES.map((cat) => (
                  <SelectItem key={cat.value} value={cat.value}>
                    {cat.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger>
                <SelectValue placeholder="Statut" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les statuts</SelectItem>
                <SelectItem value="true">Actifs</SelectItem>
                <SelectItem value="false">Inactifs</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Templates List */}
      <div className="grid gap-4">
        {templates.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <div className="text-center py-12">
                <FileType className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">Aucun modèle trouvé</h3>
                <p className="text-muted-foreground mb-4">
                  Créez votre premier modèle d'export pour commencer
                </p>
                <Button onClick={() => setShowCreateDialog(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Créer un modèle
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          templates.map((template) => (
            <Card key={template.id} className="hover:shadow-md transition-shadow">
              <CardContent className="pt-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-semibold">{template.label}</h3>
                      <Badge variant={template.isActive ? 'active' : 'secondary'}>
                        {template.isActive ? (
                          <><CheckCircle className="h-3 w-3 mr-1" /> Actif</>
                        ) : (
                          <><XCircle className="h-3 w-3 mr-1" /> Inactif</>
                        )}
                      </Badge>
                      <Badge variant="outline">
                        {getCategoryLabel(template.category)}
                      </Badge>
                      <Badge variant="outline">v{template.version}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mb-3">
                      Code: <span className="font-mono font-semibold">{template.code}</span>
                    </p>
                    {template.description && (
                      <p className="text-sm text-muted-foreground mb-3">
                        {template.description}
                      </p>
                    )}
                    {template.variables && (
                      <div className="mb-3">
                        <p className="text-xs text-muted-foreground mb-1">Variables disponibles:</p>
                        <div className="flex flex-wrap gap-1">
                          {JSON.parse(template.variables).map((v: string) => (
                            <Badge key={v} variant="secondary" className="text-xs">
                              {'{{'}{v}{'}}'}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span>Créé le {formatDate(template.createdAt)}</span>
                      {template.updatedByUser && (
                        <span>
                          Modifié par {template.updatedByUser.firstName} {template.updatedByUser.lastName}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => router.push(`/admin/export-templates/${template.id}`)}
                    >
                      <Edit className="h-4 w-4 mr-1" />
                      Éditer
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDeleteDialog({ show: true, template })}
                      className="text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Create Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Créer un nouveau modèle d'export</DialogTitle>
            <DialogDescription>
              Configurez un nouveau template PDFMonkey pour la génération de documents
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="code">Code *</Label>
                <Input
                  id="code"
                  placeholder="DOSSIER_VENTE_VELO"
                  value={createForm.code}
                  onChange={(e) => setCreateForm({ ...createForm, code: e.target.value.toUpperCase() })}
                />
                <p className="text-xs text-muted-foreground">
                  Identifiant unique en majuscules
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="label">Libellé *</Label>
                <Input
                  id="label"
                  placeholder="Dossier de vente - Vélo"
                  value={createForm.label}
                  onChange={(e) => setCreateForm({ ...createForm, label: e.target.value })}
                />
              </div>
            </div>

            <div className="space-y-2 p-4 border-2 border-primary/20 rounded-lg bg-primary/5">
              <Label htmlFor="pdfmonkeyTemplateId" className="text-base font-semibold flex items-center gap-2">
                <FileType className="h-4 w-4" />
                ID Template PDFMonkey *
              </Label>
              <Input
                id="pdfmonkeyTemplateId"
                placeholder="671dcbc4a6ee3b001aaf35f7"
                value={createForm.pdfmonkeyTemplateId}
                onChange={(e) => setCreateForm({ ...createForm, pdfmonkeyTemplateId: e.target.value.trim() })}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                📌 <strong>Obligatoire</strong> : Identifiant unique du template sur PDFMonkey. 
                Trouvez-le dans l'URL du template PDFMonkey (ex: https://app.pdfmonkey.io/documents/templates/<strong>671dcbc4a6ee3b001aaf35f7</strong>)
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="Description du modèle..."
                value={createForm.description}
                onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                rows={2}
              />
            </div>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="category">Catégorie</Label>
                <Select
                  value={createForm.category}
                  onValueChange={(value: any) => setCreateForm({ ...createForm, category: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((cat) => (
                      <SelectItem key={cat.value} value={cat.value}>
                        {cat.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="exportType">Type d'export</Label>
                <Select
                  value={createForm.exportType}
                  onValueChange={(value) => setCreateForm({ ...createForm, exportType: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Sélectionnez un type..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Aucun type spécifique</SelectItem>
                    {EXPORT_TYPES.map((type) => (
                      <SelectItem key={type.value} value={type.value}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="assetType">Type de bien</Label>
                <Select
                  value={createForm.assetTypeId}
                  onValueChange={(value) => setCreateForm({ ...createForm, assetTypeId: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Sélectionnez un type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Aucun type spécifique</SelectItem>
                    {assetTypes.filter(type => type.isEnabled).map((type) => (
                      <SelectItem key={type.id} value={type.id.toString()}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {createForm.assetTypeId !== 'none' && filteredSubcategories.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="subcategory">Sous-catégorie</Label>
                  <Select
                    value={createForm.subcategoryId}
                    onValueChange={(value) => setCreateForm({ ...createForm, subcategoryId: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Sélectionnez une sous-catégorie" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Aucune sous-catégorie</SelectItem>
                      {filteredSubcategories.filter(sub => sub.isEnabled).map((sub) => (
                        <SelectItem key={sub.id} value={sub.id.toString()}>
                          {sub.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="isActive">Statut</Label>
              <Select
                value={createForm.isActive ? 'true' : 'false'}
                onValueChange={(value) => setCreateForm({ ...createForm, isActive: value === 'true' })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Actif</SelectItem>
                  <SelectItem value="false">Inactif</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="variables">Variables (JSON array)</Label>
              <Textarea
                id="variables"
                placeholder='["assetName", "description", "purchaseDate"]'
                value={createForm.variables}
                onChange={(e) => setCreateForm({ ...createForm, variables: e.target.value })}
                rows={3}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Variables disponibles dans le template PDFMonkey (format : tableau JSON)
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)} disabled={isCreating}>
              Annuler
            </Button>
            <Button onClick={handleCreateTemplate} disabled={isCreating}>
              {isCreating ? 'Création...' : 'Créer le modèle'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={deleteDialog.show} onOpenChange={(open) => setDeleteDialog({ show: open, template: null })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmer la suppression</DialogTitle>
            <DialogDescription>
              Êtes-vous sûr de vouloir supprimer le modèle "{deleteDialog.template?.label}" ?
              Cette action est irréversible.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialog({ show: false, template: null })}
              disabled={isDeleting}
            >
              Annuler
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteTemplate}
              disabled={isDeleting}
            >
              {isDeleting ? 'Suppression...' : 'Supprimer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
