"use client"

/**
 * Modèle d'export — consultation et prévisualisation.
 *
 * Nom, description, familles concernées et statut ; activation /
 * désactivation (confirmation pour désactiver) ; aperçu du rendu à partir
 * d'un bien du compte administrateur, avec téléchargement. Aucun numéro de
 * version, aucune édition : le contenu du modèle est géré dans le code.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, FileType } from 'lucide-react';
import { ExportTemplateActiveToggle } from '../_components/ExportTemplateActiveToggle';
import { ExportTemplatePreview } from '../_components/ExportTemplatePreview';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { formatDateTime } from '@/lib/admin/format';
import type { AdminExportModel } from '@/app/api/admin/export-templates/model';

export default function ExportTemplateDetailPage() {
  const router = useRouter();
  const params = useParams();
  const code = String(params.id ?? '');

  const [model, setModel] = useState<AdminExportModel | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch(`/api/admin/export-templates/${encodeURIComponent(code)}`, { credentials: 'include' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) {
          router.push('/login?redirect=/admin/export-templates');
          return;
        }
        throw new Error(payload.message || 'Erreur lors du chargement du modèle');
      }
      setModel(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  }, [code, router]);

  useEffect(() => { void load(); }, [load]);

  const back = (
    <Button variant="ghost" size="sm" onClick={() => router.push('/admin/export-templates')}>
      <ArrowLeft className="h-4 w-4 mr-2" />
      Retour
    </Button>
  );

  if (isLoading && !model) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (error || !model) {
    return (
      <div className="space-y-4">
        {back}
        <EcranEnErreur titre="Chargement du modèle impossible" message={error ?? 'Modèle introuvable.'} onRetry={load} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          {back}
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <FileType className="h-8 w-8" />
            {model.label}
          </h1>
        </div>
        <ExportTemplateActiveToggle code={model.code} label={model.label} isActive={model.isActive} onChanged={load} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">Informations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm">{model.description}</p>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Biens concernés</p>
              <p className="text-sm">{model.families.join(', ')}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Dernier changement de statut</p>
              <p className="text-sm">
                {model.updatedAt ? `${formatDateTime(model.updatedAt)}${model.updatedBy ? ` · ${model.updatedBy}` : ''}` : '—'}
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground border-t pt-3">
            Le contenu et la structure des modèles sont gérés dans le code : ils ne sont pas modifiables ici.
          </p>
        </CardContent>
      </Card>

      <ExportTemplatePreview code={model.code} />
    </div>
  );
}
