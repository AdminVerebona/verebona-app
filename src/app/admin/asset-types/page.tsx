"use client"

/**
 * Types de biens — consultation seule.
 *
 * CDC Back-Office V1 REFD-006 (REC-MOD-06) : aucun CRUD des référentiels depuis
 * le BO ; ils sont versionnés dans le code (seeds). Les formulaires d'ajout, de
 * modification et de suppression ont été retirés avec leurs routes API.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tags, Check, X, ChevronDown, ChevronRight } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

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

  useEffect(() => {
    loadAssetTypes();
  }, []);

  const loadAssetTypes = async () => {
    try {
      setIsLoading(true);
      setError(null);


      const response = await fetch('/api/admin/asset-types', {
      credentials: 'include',
        headers: {
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
            Consultation des catégories de biens et de leurs sous-catégories (référentiel versionné dans le code)
          </p>
        </div>
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

    </div>
  );
}
