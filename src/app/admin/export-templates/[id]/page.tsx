"use client"

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  ArrowLeft,
  Save,
  AlertCircle,
  FileType,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';

interface ExportTemplate {
  id: number;
  code: string;
  label: string;
  description?: string;
  pdfmonkeyTemplateId?: string;
  templateContent: string;
  variables?: string;
  category: 'IMMOBILIER' | 'VEHICULE' | 'MATERIEL_PRO' | 'GENERAL';
  exportType?: string;
  assetTypeId?: number;
  assetTypeSubcategoryId?: number;
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

interface SystemLogo {
  id: number;
  code: string;
  label: string;
  description: string | null;
  logoType: 'WEB_ANIMATED' | 'EMAIL_STATIC' | 'PDF_STATIC' | 'SVG' | 'PNG';
  contentType: string;
  logoContent: string;
  width: number;
  height: number;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
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

export default function EditExportTemplatePage() {
  const router = useRouter();
  const params = useParams();
  const templateId = params.id as string;

  const [template, setTemplate] = useState<ExportTemplate | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [assetTypes, setAssetTypes] = useState<AssetType[]>([]);
  const [subcategories, setSubcategories] = useState<Subcategory[]>([]);
  const [filteredSubcategories, setFilteredSubcategories] = useState<Subcategory[]>([]);

  const [formData, setFormData] = useState({
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

  useEffect(() => {
    loadTemplate();
    loadAssetTypes();
  }, [templateId]);

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
        
        const allSubcategories = data.flatMap((type: any) => 
          type.subcategories || []
        );
        setSubcategories(allSubcategories);
      }
    } catch (err) {
      console.error('Error loading asset types:', err);
    }
  };

  useEffect(() => {
    if (formData.assetTypeId && formData.assetTypeId !== 'none') {
      const filtered = subcategories.filter(
        sub => sub.assetTypeId === parseInt(formData.assetTypeId)
      );
      setFilteredSubcategories(filtered);
      if (formData.subcategoryId !== 'none' && !filtered.find(s => s.id === parseInt(formData.subcategoryId))) {
        setFormData(prev => ({ ...prev, subcategoryId: 'none' }));
      }
    } else {
      setFilteredSubcategories([]);
      setFormData(prev => ({ ...prev, subcategoryId: 'none' }));
    }
  }, [formData.assetTypeId, subcategories]);

  const loadTemplate = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const token = localStorage.getItem('bearer_token');
      if (!token) {
        router.push('/login?redirect=/admin/export-templates');
        return;
      }

      const response = await fetch(`/api/admin/export-templates/${templateId}`, {
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
        throw new Error('Erreur lors du chargement du modèle');
      }

      const data = await response.json();
      setTemplate(data);
      setFormData({
        label: data.label,
        description: data.description || '',
        pdfmonkeyTemplateId: data.pdfmonkeyTemplateId || '',
        variables: data.variables || '',
        category: data.category,
        exportType: data.exportType || 'none',
        assetTypeId: data.assetTypeId ? data.assetTypeId.toString() : 'none',
        subcategoryId: data.assetTypeSubcategoryId ? data.assetTypeSubcategoryId.toString() : 'none',
        isActive: data.isActive,
      });
    } catch (err) {
      console.error('Error loading template:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!formData.label.trim()) {
      toast.error('Le libellé est obligatoire');
      return;
    }

    if (!formData.pdfmonkeyTemplateId.trim()) {
      toast.error('L\'ID du template PDFMonkey est obligatoire');
      return;
    }

    try {
      setIsSaving(true);
      const token = localStorage.getItem('bearer_token');

      let parsedVariables = null;
      if (formData.variables.trim()) {
        try {
          parsedVariables = JSON.parse(formData.variables);
          if (!Array.isArray(parsedVariables)) {
            toast.error('Les variables doivent être un tableau JSON');
            return;
          }
        } catch {
          toast.error('Format JSON invalide pour les variables');
          return;
        }
      }

      const response = await fetch(`/api/admin/export-templates/${templateId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          label: formData.label.trim(),
          description: formData.description.trim() || undefined,
          pdfmonkeyTemplateId: formData.pdfmonkeyTemplateId.trim(),
          variables: parsedVariables ? JSON.stringify(parsedVariables) : undefined,
          category: formData.category,
          exportType: formData.exportType !== 'none' ? formData.exportType : undefined,
          assetTypeId: formData.assetTypeId !== 'none' ? parseInt(formData.assetTypeId) : undefined,
          assetTypeSubcategoryId: formData.subcategoryId !== 'none' ? parseInt(formData.subcategoryId) : undefined,
          isActive: formData.isActive,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Erreur lors de la sauvegarde');
      }

      const updated = await response.json();
      setTemplate(updated);
      toast.success('Modèle mis à jour avec succès');
    } catch (err) {
      console.error('Error saving template:', err);
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la sauvegarde');
    } finally {
      setIsSaving(false);
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getCategoryLabel = (category: string) => {
    return CATEGORIES.find(c => c.value === category)?.label || category;
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (error || !template) {
    return (
      <div className="flex items-center justify-center h-64">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <p>{error || 'Modèle non trouvé'}</p>
            </div>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => router.push('/admin/export-templates')}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Retour à la liste
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push('/admin/export-templates')}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Retour
          </Button>
          <div>
            <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
              <FileType className="h-8 w-8" />
              Édition du modèle
            </h1>
            <p className="text-muted-foreground mt-1">
              Code: <span className="font-mono font-semibold">{template.code}</span> · 
              Version {template.version}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={isSaving}>
            <Save className="h-4 w-4 mr-2" />
            {isSaving ? 'Enregistrement...' : 'Enregistrer'}
          </Button>
        </div>
      </div>

      {/* Info Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Informations
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Catégorie</p>
              <Badge variant="outline">{getCategoryLabel(template.category)}</Badge>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Statut</p>
              <Badge variant={template.isActive ? 'active' : 'secondary'}>
                {template.isActive ? (
                  <><CheckCircle className="h-3 w-3 mr-1" /> Actif</>
                ) : (
                  <><XCircle className="h-3 w-3 mr-1" /> Inactif</>
                )}
              </Badge>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Version</p>
              <Badge variant="outline">v{template.version}</Badge>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Créé le</p>
              <p className="text-sm">{formatDate(template.createdAt)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Mis à jour le</p>
              <p className="text-sm">{formatDate(template.updatedAt)}</p>
            </div>
            {template.updatedByUser && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Modifié par</p>
                <p className="text-sm">
                  {template.updatedByUser.firstName} {template.updatedByUser.lastName}
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Edit Form - 2 onglets seulement */}
      <Tabs defaultValue="basic" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="basic">Informations de base</TabsTrigger>
          <TabsTrigger value="variables">Variables</TabsTrigger>
        </TabsList>

        <TabsContent value="basic" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Informations générales</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="code">Code (non modifiable)</Label>
                <Input
                  id="code"
                  value={template?.code || ''}
                  disabled
                  className="bg-muted"
                />
                <p className="text-xs text-muted-foreground">
                  Le code ne peut pas être modifié après la création
                </p>
              </div>

              <div className="space-y-2 p-4 border-2 border-primary/20 rounded-lg bg-primary/5">
                <Label htmlFor="pdfmonkeyTemplateId" className="text-base font-semibold flex items-center gap-2">
                  <FileType className="h-4 w-4" />
                  ID Template PDFMonkey *
                </Label>
                <Input
                  id="pdfmonkeyTemplateId"
                  placeholder="671dcbc4a6ee3b001aaf35f7"
                  value={formData.pdfmonkeyTemplateId}
                  onChange={(e) => setFormData({ ...formData, pdfmonkeyTemplateId: e.target.value.trim() })}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  📌 <strong>Obligatoire</strong> : Identifiant unique du template sur PDFMonkey. 
                  Trouvez-le dans l'URL du template PDFMonkey (ex: https://app.pdfmonkey.io/documents/templates/<strong>671dcbc4a6ee3b001aaf35f7</strong>)
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="label">Libellé *</Label>
                <Input
                  id="label"
                  value={formData.label}
                  onChange={(e) => setFormData({ ...formData, label: e.target.value })}
                  placeholder="Dossier de vente"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Description du modèle..."
                  rows={3}
                />
              </div>

              <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="category">Catégorie</Label>
                  <Select
                    value={formData.category}
                    onValueChange={(value: any) => setFormData({ ...formData, category: value })}
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
                  <Label htmlFor="exportType">Type d'export *</Label>
                  <Select
                    value={formData.exportType}
                    onValueChange={(value) => setFormData({ ...formData, exportType: value })}
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
                  <p className="text-xs text-muted-foreground">
                    Type d'export pour lequel ce modèle sera utilisé
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="isActive">Statut</Label>
                <Select
                  value={formData.isActive ? 'true' : 'false'}
                  onValueChange={(value) => setFormData({ ...formData, isActive: value === 'true' })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Actif</SelectItem>
                    <SelectItem value="false">Inactif</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Seuls les modèles actifs peuvent être utilisés pour générer des exports
                </p>
              </div>

              <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="assetType">Type de bien</Label>
                  <Select
                    value={formData.assetTypeId}
                    onValueChange={(value) => setFormData({ ...formData, assetTypeId: value })}
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
                  <p className="text-xs text-muted-foreground">
                    Type de bien spécifique pour ce modèle
                  </p>
                </div>

                {formData.assetTypeId !== 'none' && filteredSubcategories.length > 0 && (
                  <div className="space-y-2">
                    <Label htmlFor="subcategory">Sous-catégorie</Label>
                    <Select
                      value={formData.subcategoryId}
                      onValueChange={(value) => setFormData({ ...formData, subcategoryId: value })}
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
                    <p className="text-xs text-muted-foreground">
                      Sous-catégorie spécifique pour ce modèle
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="variables" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Variables PDFMonkey</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                  <h4 className="font-semibold text-sm mb-2 flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" />
                    À quoi servent les variables ?
                  </h4>
                  <p className="text-sm text-muted-foreground">
                    Les variables définissent le <strong>contrat de données</strong> entre votre application et PDFMonkey. 
                    Elles seront automatiquement injectées lors de la génération du PDF et utilisables dans votre template PDFMonkey avec la syntaxe <code className="bg-white dark:bg-gray-800 px-1 rounded">{'{{variableName}}'}</code>.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="variables">Liste des variables (JSON array)</Label>
                  <Textarea
                    id="variables"
                    value={formData.variables}
                    onChange={(e) => setFormData({ ...formData, variables: e.target.value })}
                    placeholder='["assetName", "description", "purchaseDate", "price"]'
                    rows={8}
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    Format: tableau JSON contenant les noms des variables utilisables dans le template PDFMonkey
                  </p>
                </div>

                {formData.variables.trim() && (() => {
                  try {
                    const vars = JSON.parse(formData.variables);
                    if (Array.isArray(vars)) {
                      return (
                        <div className="space-y-2">
                          <p className="text-sm font-medium">Aperçu des variables:</p>
                          <div className="flex flex-wrap gap-2">
                            {vars.map((v: string) => (
                              <Badge key={v} variant="secondary">
                                {'{{'}
                                {v}
                                {'}}'}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      );
                    }
                  } catch {}
                  return (
                    <div className="text-sm text-destructive flex items-center gap-2">
                      <AlertCircle className="h-4 w-4" />
                      Format JSON invalide
                    </div>
                  );
                })()}

                <div className="bg-muted p-4 rounded-lg space-y-2">
                  <p className="text-sm font-medium">Exemples de variables courantes:</p>
                  <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                    <li><code className="font-mono">assetName</code> - Nom du bien</li>
                    <li><code className="font-mono">category</code> - Catégorie du bien</li>
                    <li><code className="font-mono">purchaseDate</code> - Date d'achat</li>
                    <li><code className="font-mono">purchasePrice</code> - Prix d'achat</li>
                    <li><code className="font-mono">description</code> - Description</li>
                    <li><code className="font-mono">condition</code> - État général</li>
                    <li><code className="font-mono">photos</code> - Liste des photos</li>
                    <li><code className="font-mono">documents</code> - Liste des documents</li>
                  </ul>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Save Button (bottom) */}
      <div className="flex justify-end gap-2 pb-8">
        <Button variant="outline" onClick={() => router.push('/admin/export-templates')}>
          Annuler
        </Button>
        <Button onClick={handleSave} disabled={isSaving}>
          <Save className="h-4 w-4 mr-2" />
          {isSaving ? 'Enregistrement...' : 'Enregistrer les modifications'}
        </Button>
      </div>
    </div>
  );
}