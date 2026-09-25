"use client"

/**
 * Modèles d'export — CDC Back-Office V1 §11.1.
 *
 * EXP-007 / REC-MOD-06 : structure non éditable ; création, édition et
 * suppression retirées (UI et API). EXP-003 / EXP-004 : seule l'activation
 * globale reste, avec confirmation. EXP-002 : pas de numéro de version.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  FileType,
  Search,
  Eye,
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
import { ExportTemplateActiveToggle } from './_components/ExportTemplateActiveToggle';

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

const CATEGORIES = [
  { value: 'GENERAL', label: 'Général' },
  { value: 'IMMOBILIER', label: 'Immobilier' },
  { value: 'VEHICULE', label: 'Véhicule' },
  { value: 'MATERIEL_PRO', label: 'Matériel Pro' },
];

export default function ExportTemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<ExportTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  useEffect(() => {
    loadTemplates();
  }, [categoryFilter, statusFilter, searchQuery]);

  const loadTemplates = async () => {
    try {
      setIsLoading(true);
      setError(null);


      const params = new URLSearchParams();
      if (categoryFilter !== 'all') params.append('category', categoryFilter);
      if (statusFilter !== 'all') params.append('isActive', statusFilter);
      if (searchQuery.trim()) params.append('search', searchQuery.trim());
      params.append('limit', '100');

      const response = await fetch(`/api/admin/export-templates?${params.toString()}`, {
      credentials: 'include',
        headers: {
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
            Activation des modèles de génération des exports PDF (contenu non modifiable depuis le back-office)
          </p>
        </div>
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
                <p className="text-muted-foreground">
                  {searchQuery || categoryFilter !== 'all' || statusFilter !== 'all'
                    ? 'Aucun modèle ne correspond aux critères.'
                    : 'Aucun modèle d\'export.'}
                </p>
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
                  <div className="flex flex-col items-end gap-3">
                    <ExportTemplateActiveToggle
                      templateId={template.id}
                      label={template.label}
                      isActive={template.isActive}
                      onChanged={loadTemplates}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => router.push(`/admin/export-templates/${template.id}`)}
                    >
                      <Eye className="h-4 w-4 mr-1" />
                      Consulter
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

    </div>
  );
}
