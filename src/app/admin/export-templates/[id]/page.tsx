"use client"

/**
 * Modèle d'export — consultation (CDC Back-Office V1 §11.1).
 *
 * EXP-007 / REC-MOD-06 : la structure du modèle (libellé, identifiant
 * PDFMonkey, catégorie, type d'export, variables…) n'est plus éditable depuis
 * le BO ; le formulaire et le handler PUT ont été retirés. EXP-003 / EXP-004 :
 * seule l'activation reste, avec confirmation. EXP-002 : pas de numéro de
 * version affiché.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, AlertCircle, FileType } from 'lucide-react';
import { ExportTemplateActiveToggle } from '../_components/ExportTemplateActiveToggle';
import { formatDateTime } from '@/lib/admin/format';

interface ExportTemplate {
  id: number;
  code: string;
  label: string;
  description?: string;
  variables?: string;
  category: 'IMMOBILIER' | 'VEHICULE' | 'MATERIEL_PRO' | 'GENERAL';
  exportType?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const CATEGORIES: Record<string, string> = {
  GENERAL: 'Général',
  IMMOBILIER: 'Immobilier',
  VEHICULE: 'Véhicule',
  MATERIEL_PRO: 'Matériel Pro',
};

const EXPORT_TYPES: Record<string, string> = {
  DOSSIER_VENTE: 'Dossier de vente',
  ASSURANCE_DEVIS: 'Assurance - Devis',
  ASSURANCE_SINISTRE: 'Assurance - Sinistre',
  CIL: 'CIL',
  DOSSIER_COMPLET: 'Dossier complet',
  REVENTE: 'Revente',
  SAV_GARANTIE: 'SAV / Garantie',
  AUTRE: 'Autre',
};

function parseVariables(raw: string | undefined): string[] | null {
  if (!raw?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

export default function ExportTemplateDetailPage() {
  const router = useRouter();
  const params = useParams();
  const templateId = params.id as string;

  const [template, setTemplate] = useState<ExportTemplate | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTemplate = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await fetch(`/api/admin/export-templates/${templateId}`, { credentials: 'include' });
      if (!response.ok) {
        if (response.status === 401) {
          router.push('/login?redirect=/admin/export-templates');
          return;
        }
        throw new Error('Erreur lors du chargement du modèle');
      }
      setTemplate(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  }, [templateId, router]);

  useEffect(() => { loadTemplate(); }, [loadTemplate]);

  if (isLoading && !template) {
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
            <Button variant="outline" className="mt-4" onClick={() => router.push('/admin/export-templates')}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Retour à la liste
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const variables = parseVariables(template.variables);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => router.push('/admin/export-templates')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Retour
          </Button>
          <div>
            <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
              <FileType className="h-8 w-8" />
              {template.label}
            </h1>
            <p className="text-muted-foreground mt-1">
              Code : <span className="font-mono font-semibold">{template.code}</span>
            </p>
          </div>
        </div>
        <ExportTemplateActiveToggle
          templateId={template.id}
          label={template.label}
          isActive={template.isActive}
          onChanged={loadTemplate}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">Informations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {template.description && <p className="text-sm">{template.description}</p>}
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Catégorie</p>
              <Badge variant="outline">{CATEGORIES[template.category] ?? template.category}</Badge>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Type d’export</p>
              <p className="text-sm">{template.exportType ? (EXPORT_TYPES[template.exportType] ?? template.exportType) : '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Créé le</p>
              <p className="text-sm">{formatDateTime(template.createdAt)}</p>
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Données utilisées</p>
            {variables === null ? (
              <p className="text-sm text-muted-foreground">Liste illisible.</p>
            ) : variables.length === 0 ? (
              <p className="text-sm text-muted-foreground">—</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {variables.map((v) => (
                  <Badge key={v} variant="secondary" className="text-xs">{v}</Badge>
                ))}
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground border-t pt-3">
            Le contenu et la structure des modèles d’export sont versionnés hors back-office.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
