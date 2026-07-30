"use client";

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import Link from 'next/link';
import Image from 'next/image';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { Trash2, Download, Eye, FileText, File } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { LinkedEventsSection } from '@/components/documents/linked-events-section';
import { useSession } from '@/hooks/useSession';
import { toast } from 'sonner';
import { formatCents } from '@/lib/currency-utils';

interface DocumentDetail {
  id: number;
  filename: string;
  originalFilename: string;
  mimeType: string;
  fileExtension: string;
  size: number;
  uploadStatus: string;
  uploadedAt: string;
  createdAt: string;
  documentType?: string;
  documentDate?: string;
  description?: string;
  supplier?: string;
  amountCents?: number;
  assetId: number;
  asset?: {
    id: number;
    name: string;
  };
}

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  FACTURE: 'Facture',
  GARANTIE: 'Garantie',
  MANUEL: 'Manuel',
  CONTRAT: 'Contrat',
  CERTIFICAT: 'Certificat',
  AUTRE: 'Autre',
};

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
};

const formatDate = (dateStr?: string) => {
  if (!dateStr) return 'Non renseignée';
  return new Date(dateStr).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
};

export default function DocumentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { user, isLoading: isPending } = useSession({ required: true });
  const { setBreadcrumbs } = useBreadcrumb();

  const [document, setDocument] = useState<DocumentDetail | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!isPending && user && params.id) {
      loadDocument();
    }
  }, [params.id, user, isPending]);

  useEffect(() => {
    if (document) {
      const displayName = document.originalFilename || 'Document';
      setBreadcrumbs([
        { label: 'Mes documents', href: '/documents' },
        { label: displayName }
      ]);
    }
  }, [document, setBreadcrumbs]);

  const loadDocument = async () => {
    try {
      const response = await fetch(`/api/documents/${params.id}`, {
      credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Document non trouvé');
      }

      const data = await response.json();
      setDocument(data.document);

      // Load preview for images
      if (data.document.mimeType.startsWith('image/')) {
        const viewResponse = await fetch(`/api/files/${data.document.id}/view`, {
      credentials: 'include',
        });
        if (viewResponse.ok) {
          const viewData = await viewResponse.json();
          setPreviewUrl(viewData.viewUrl);
        }
      }
    } catch (error) {
      console.error('Error loading document:', error);
      toast.error('Erreur lors du chargement du document');
      router.push('/documents');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!document) return;
    
    try {
      const response = await fetch(`/api/files/${document.id}/download`, {
      credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Erreur lors du téléchargement');
      }

      const data = await response.json();
      
      const isInIframe = window.self !== window.top;
      if (isInIframe) {
        window.parent.postMessage({ type: 'OPEN_EXTERNAL_URL', data: { url: data.downloadUrl } }, '*');
      } else {
        window.open(data.downloadUrl, '_blank', 'noopener,noreferrer');
      }

      toast.success('Téléchargement démarré');
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Erreur lors du téléchargement');
    }
  };

  const handleView = async () => {
    if (!document) return;
    
    try {
      const response = await fetch(`/api/files/${document.id}/view`, {
      credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la visualisation');
      }

      const data = await response.json();
      
      const isInIframe = window.self !== window.top;
      if (isInIframe) {
        window.parent.postMessage({ type: 'OPEN_EXTERNAL_URL', data: { url: data.viewUrl } }, '*');
      } else {
        window.open(data.viewUrl, '_blank', 'noopener,noreferrer');
      }

      toast.success('Document ouvert dans un nouvel onglet');
    } catch (error) {
      console.error('View error:', error);
      toast.error('Erreur lors de la visualisation');
    }
  };

  const handleDelete = async () => {
    if (!document) return;

    try {
      setIsDeleting(true);
      
      const response = await fetch(`/api/documents/${document.id}`, {
      credentials: 'include',
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la suppression');
      }

      toast.success('Document supprimé avec succès');
      router.push(document.asset ? `/assets/${document.asset.id}` : '/documents');
    } catch (error) {
      console.error('Error deleting document:', error);
      toast.error('Erreur lors de la suppression du document');
    } finally {
      setIsDeleting(false);
    }
  };

  if (isPending || isLoading) {
    return (
      <>
        <div className="space-y-6">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-64" />
        </div>
      </>
    );
  }

  if (!document) {
    return null;
  }

  const getFileIcon = () => {
    if (document.mimeType.startsWith('image/')) {
      return <File className="w-8 h-8 text-blue-500" />;
    }
    if (document.mimeType === 'application/pdf') {
      return <FileText className="w-8 h-8 text-red-500" />;
    }
    if (document.mimeType.includes('document') || document.mimeType.includes('word')) {
      return <FileText className="w-8 h-8 text-blue-600" />;
    }
    return <File className="w-8 h-8 text-muted-foreground" />;
  };

  return (
    <>
      <div className="space-y-6">
        {/* Document Header */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col md:flex-row gap-6">
              {/* Preview */}
              <div className="flex-shrink-0">
                {previewUrl ? (
                  <div className="relative w-full md:w-64 aspect-video rounded-lg overflow-hidden bg-muted">
                    <Image
                      src={previewUrl}
                      alt={document.originalFilename}
                      fill
                      className="object-cover"
                      sizes="(max-width: 768px) 100vw, 256px"
                      priority
                    />
                  </div>
                ) : (
                  <div className="w-full md:w-64 aspect-video rounded-lg bg-muted flex items-center justify-center">
                    {getFileIcon()}
                  </div>
                )}
              </div>

              {/* Document Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex-1 min-w-0">
                    <h1 className="text-2xl font-bold truncate">{document.originalFilename}</h1>
                    {document.asset && (
                      <p className="text-muted-foreground mt-1">
                        Bien : <Link href={`/assets/${document.asset.id}`} className="hover:underline">{document.asset.name}</Link>
                      </p>
                    )}
                    {document.documentType && (
                      <Badge className="mt-2">
                        {DOCUMENT_TYPE_LABELS[document.documentType] || document.documentType}
                      </Badge>
                    )}
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <Button variant="outline" onClick={handleView}>
                      <Eye className="w-4 h-4 mr-2" />
                      Visualiser
                    </Button>
                    <Button variant="outline" onClick={handleDownload}>
                      <Download className="w-4 h-4 mr-2" />
                      Télécharger
                    </Button>
                    <Button variant="destructive" onClick={() => setShowDeleteDialog(true)} className="btn-delete">
                      <Trash2 className="w-4 h-4 mr-2 btn-delete-trash-icon" />
                      Supprimer
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t">
                  <div>
                    <p className="text-sm text-muted-foreground">Taille</p>
                    <p className="font-medium mt-1">{formatFileSize(document.size)}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Date d'ajout</p>
                    <p className="font-medium mt-1">{formatDate(document.uploadedAt)}</p>
                  </div>
                  {document.documentDate && (
                    <div>
                      <p className="text-sm text-muted-foreground">Date du document</p>
                      <p className="font-medium mt-1">{formatDate(document.documentDate)}</p>
                    </div>
                  )}
                  {document.supplier && (
                    <div>
                      <p className="text-sm text-muted-foreground">Fournisseur</p>
                      <p className="font-medium mt-1">{document.supplier}</p>
                    </div>
                  )}
                  {document.amountCents && (
                    <div>
                      <p className="text-sm text-muted-foreground">Montant</p>
                      <p className="font-medium mt-1">{formatCents(document.amountCents)}</p>
                    </div>
                  )}
                </div>

                {document.description && (
                  <div className="mt-6 pt-6 border-t">
                    <p className="text-sm text-muted-foreground mb-2">Description</p>
                    <p className="text-sm">{document.description}</p>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Linked Events Section */}
        <LinkedEventsSection
          documentId={document.id}
          assetId={document.assetId}
          onRefresh={loadDocument}
        />

        {/* Delete Confirmation */}
        <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirmer la suppression</AlertDialogTitle>
              <AlertDialogDescription>
                Êtes-vous sûr de vouloir supprimer ce document ? Cette action est irréversible.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isDeleting}>Annuler</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                disabled={isDeleting}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90 btn-delete"
              >
                {isDeleting ? 'Suppression...' : 'Supprimer'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </>
  );
}
