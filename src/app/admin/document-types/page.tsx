"use client"

/**
 * Types de documents — consultation seule.
 *
 * CDC Back-Office V1 REFD-006 (REC-MOD-06) : aucun CRUD des référentiels depuis
 * le BO ; ils sont versionnés dans le code (seeds). Les formulaires d'ajout, de
 * modification, de suppression et d'association ont été retirés avec leurs
 * routes API.
 */
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { FileType, Check, X, ChevronDown, ChevronRight, Package, Tag } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

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
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openTypes, setOpenTypes] = useState<Set<number>>(new Set());

  useEffect(() => {
    loadDocumentTypes();
  }, []);

  const loadDocumentTypes = async () => {
    try {
      setIsLoading(true);
      setError(null);


      const response = await fetch('/api/admin/document-types', {
      credentials: 'include',
        headers: {
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
          <h1 className="text-2xl md:text-3xl font-bold">Types de documents</h1>
          <p className="text-muted-foreground mt-1">
            Consultation des types de documents et de leurs associations aux biens et aux exports (référentiel versionné dans le code)
          </p>
        </div>
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
              Aucun type de document.
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

    </div>
  );
}
