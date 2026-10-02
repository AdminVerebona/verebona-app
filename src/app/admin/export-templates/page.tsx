"use client"

/**
 * Modèles d'export — back-office.
 *
 * Objectif : consulter les modèles, vérifier leur rendu et gérer leur
 * disponibilité. Les modèles sont les six dossiers prêts à l'emploi V12,
 * définis dans le code :
 *   - liste : nom, description, statut actif / inactif ;
 *   - consultation et prévisualisation (données du compte administrateur,
 *     bien au choix, téléchargement du rendu) : page de détail ;
 *   - activation / désactivation, la désactivation sur confirmation explicite ;
 *   - aucun versionnement, aucune édition du contenu, aucune relance de
 *     génération ; statistiques d'utilisation : Dashboard.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle, Eye, FileType, XCircle } from 'lucide-react';
import { ExportTemplateActiveToggle } from './_components/ExportTemplateActiveToggle';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import type { AdminExportModel } from '@/app/api/admin/export-templates/model';

export default function ExportTemplatesPage() {
  const router = useRouter();
  const [models, setModels] = useState<AdminExportModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch('/api/admin/export-templates', { credentials: 'include' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) {
          router.push('/login?redirect=/admin/export-templates');
          return;
        }
        throw new Error(payload.message || 'Erreur lors du chargement des modèles');
      }
      setModels(payload.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid gap-4">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
      </div>
    );
  }

  if (error) {
    return <EcranEnErreur titre="Chargement des modèles impossible" message={error} onRetry={load} />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
          <FileType className="h-8 w-8" />
          Modèles d’export
        </h1>
        <p className="text-muted-foreground mt-1">
          Consultez les modèles, vérifiez leur rendu et gérez leur disponibilité. Le contenu des modèles est géré dans le
          code ; les statistiques d’utilisation sont dans le Dashboard.
        </p>
      </div>

      <div className="grid gap-4">
        {models.map((m) => (
          <Card key={m.code} className="hover:shadow-md transition-shadow">
            <CardContent className="pt-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold">{m.label}</h3>
                    <Badge variant={m.isActive ? 'active' : 'secondary'}>
                      {m.isActive
                        ? <><CheckCircle className="h-3 w-3 mr-1" /> Actif</>
                        : <><XCircle className="h-3 w-3 mr-1" /> Inactif</>}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{m.description}</p>
                  <p className="text-xs text-muted-foreground">Biens concernés : {m.families.join(', ')}</p>
                </div>
                <div className="flex flex-row items-center gap-3 sm:flex-col sm:items-end">
                  <ExportTemplateActiveToggle code={m.code} label={m.label} isActive={m.isActive} onChanged={load} />
                  <Button variant="outline" size="sm" onClick={() => router.push(`/admin/export-templates/${m.code}`)}>
                    <Eye className="h-4 w-4 mr-1" />
                    Consulter et prévisualiser
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
