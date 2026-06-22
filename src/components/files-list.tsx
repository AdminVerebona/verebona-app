"use client"

import { useState, useEffect } from 'react';
import { Download, Trash2, FileIcon, Image, FileText, Loader2, Eye, MoreVertical, Edit, File, MoveHorizontal, Archive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import NextImage from 'next/image';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { DocumentEditDialog } from '@/components/document-edit-dialog';
import JSZip from 'jszip';

  interface AssetFile {
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
    assetId: number;
  }


interface DocumentType {
  id: number;
  code: string;
  label: string;
  isActive: boolean;
}

interface FilesListProps {
  assetId: number;
  refreshTrigger?: number;
}

export function FilesList({ assetId, refreshTrigger }: FilesListProps) {
  const [files, setFiles] = useState<AssetFile[]>([]);
  const [assets, setAssets] = useState<{ id: number; name: string }[]>([]);
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filePreviewUrls, setFilePreviewUrls] = useState<Record<number, string>>({});
  
  // Selection state
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  
  // Dialogs
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [fileToDelete, setFileToDelete] = useState<AssetFile | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [targetAssetId, setTargetAssetId] = useState<string>('');
  const [isMoving, setIsMoving] = useState(false);
  
  const [downloadingFiles, setDownloadingFiles] = useState<Set<number>>(new Set());
  const [viewingFile, setViewingFile] = useState<{ url: string; filename: string; mimeType: string } | null>(null);
  const [isLoadingView, setIsLoadingView] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [fileToEdit, setFileToEdit] = useState<AssetFile | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    loadAssets();
    loadDocumentTypes();
  }, []);

  useEffect(() => {
    loadFiles();
    setSelectedIds([]); // Reset selection on refresh
  }, [assetId, refreshTrigger]);

  const loadAssets = async () => {
    try {
      const token = localStorage.getItem('bearer_token');
      if (!token) {
        return;
      }

      const response = await fetch('/api/assets?limit=100', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      
      if (response.ok) {
        const data = await response.json();
        setAssets(Array.isArray(data.data) ? data.data : []);
      }
    } catch (error) {
      console.error('Error loading assets:', error);
    }
  };

  const loadDocumentTypes = async () => {
    try {
      const token = localStorage.getItem('bearer_token');
      if (!token) return;

      const response = await fetch('/api/document-types', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (response.ok) {
        const data = await response.json();
        const types = data.documentTypes && Array.isArray(data.documentTypes) 
          ? data.documentTypes 
          : (Array.isArray(data) ? data : []);
        setDocumentTypes(types);
      }
    } catch (error) {
      console.error('Error loading document types:', error);
    }
  };

  const getDocumentTypeLabel = (documentType?: string): string => {
    if (!documentType) return '—';
    const type = documentTypes.find(dt => dt.code === documentType);
    return type?.label || documentType;
  };

  const loadImagePreviewUrls = async (filesList: AssetFile[]) => {
    const token = localStorage.getItem('bearer_token');
    if (!token) return;

    const imageFiles = filesList.filter(file => file.mimeType.includes('image/'));
    const urlMap: Record<number, string> = {};

    await Promise.all(
      imageFiles.map(async (file) => {
        try {
          const response = await fetch(`/api/files/${file.id}/view`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          
          if (response.ok) {
            const data = await response.json();
            urlMap[file.id] = data.viewUrl;
          }
        } catch (error) {
          console.error(`Failed to load preview for file ${file.id}:`, error);
        }
      })
    );

    setFilePreviewUrls(urlMap);
  };

  const loadFiles = async () => {
    try {
      setIsLoading(true);

      const token = localStorage.getItem('bearer_token');
      if (!token) {
        console.error('[FILES_LIST] ❌ Aucun bearer_token');
        toast.error('Non authentifié');
        return;
      }


      const response = await fetch(`/api/files?assetId=${assetId}&uploadStatus=COMPLETED`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });


      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('[FILES_LIST] ❌ Erreur API:', errorData);
        throw new Error(errorData?.message || 'Erreur lors du chargement des fichiers');
      }

      const responseData = await response.json();

      const filesData = Array.isArray(responseData) ? responseData : (responseData.data || []);
      
      setFiles(filesData);
      
      // Charger les URLs des aperçus d'images
      await loadImagePreviewUrls(filesData);
    } catch (error) {
      console.error('[FILES_LIST] ❌ Error loading files:', error);
      toast.error('Erreur lors du chargement des fichiers');
    } finally {
      setIsLoading(false);
    }
  };

  // Selection handlers
  const toggleSelectAll = () => {
    if (selectedIds.length === files.length && files.length > 0) {
      setSelectedIds([]);
    } else {
      setSelectedIds(files.map(file => file.id));
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  // Bulk actions
  const handleBulkDelete = async () => {
    try {
      setIsDeleting(true);
      const token = localStorage.getItem('bearer_token');
      
      const response = await fetch('/api/documents/bulk-delete', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ documentIds: selectedIds }),
      });
      
      if (response.ok) {
        const result = await response.json();
        toast.success(`${result.deleted} document${result.deleted > 1 ? 's supprimés' : ' supprimé'}`);
        setSelectedIds([]);
        setDeleteDialogOpen(false);
        loadFiles();
      } else {
        toast.error('Erreur lors de la suppression');
      }
    } catch (error) {
      console.error('Error deleting documents:', error);
      toast.error('Erreur lors de la suppression');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleBulkMove = async () => {
    if (!targetAssetId) {
      toast.error('Veuillez sélectionner un bien');
      return;
    }
    
    try {
      setIsMoving(true);
      const token = localStorage.getItem('bearer_token');
      
      const response = await fetch('/api/documents/bulk-move', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          documentIds: selectedIds,
          targetAssetId: parseInt(targetAssetId),
        }),
      });
      
      if (response.ok) {
        const result = await response.json();
        const assetName = assets.find(a => a.id === result.targetAssetId)?.name || 'le bien';
        toast.success(`${result.moved} document${result.moved > 1 ? 's déplacés' : ' déplacé'} vers ${assetName}`);
        setSelectedIds([]);
        setMoveDialogOpen(false);
        setTargetAssetId('');
        loadFiles();
      } else {
        const error = await response.json();
        toast.error(error.message || 'Erreur lors du déplacement');
      }
    } catch (error) {
      console.error('Error moving documents:', error);
      toast.error('Erreur lors du déplacement');
    } finally {
      setIsMoving(false);
    }
  };

  const handleBulkExport = async () => {
    try {
      setIsExporting(true);
      const token = localStorage.getItem('bearer_token');
      if (!token) {
        toast.error('Non authentifié');
        return;
      }

      // Get selected files
      const selectedFiles = files.filter(f => selectedIds.includes(f.id));
      
      toast.info('Préparation du téléchargement...');

      // Create ZIP
      const zip = new JSZip();
      
      // Download each file and add to ZIP
      await Promise.all(
        selectedFiles.map(async (file) => {
          try {
            // Get download URL
            const response = await fetch(`/api/files/${file.id}/download`, {
              headers: { 'Authorization': `Bearer ${token}` },
            });
            
            if (!response.ok) throw new Error(`Failed to get download URL for ${file.originalFilename}`);
            
            const { downloadUrl } = await response.json();
            
            // Fetch file content
            const fileResponse = await fetch(downloadUrl);
            if (!fileResponse.ok) throw new Error(`Failed to download ${file.originalFilename}`);
            
            const blob = await fileResponse.blob();
            
            // Add to ZIP with original filename
            zip.file(file.originalFilename, blob);
          } catch (error) {
            console.error(`Error adding ${file.originalFilename} to ZIP:`, error);
            // Continue with other files
          }
        })
      );

      // Generate ZIP file
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      
      // Create download link
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      
      // Get current asset name for ZIP filename
      const currentAsset = assets.find(a => a.id === assetId);
      const zipFilename = `${currentAsset?.name || 'Documents'}_${new Date().toISOString().split('T')[0]}.zip`;
      link.download = zipFilename;
      
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      URL.revokeObjectURL(url);
      
      toast.success(`${selectedFiles.length} document${selectedFiles.length > 1 ? 's exportés' : ' exporté'} en ZIP`);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Erreur lors de l\'export');
    } finally {
      setIsExporting(false);
    }
  };

  const handleView = async (file: AssetFile) => {
    try {
      setIsLoadingView(true);

      const token = localStorage.getItem('bearer_token');
      if (!token) {
        toast.error('Non authentifié');
        return;
      }

      const response = await fetch(`/api/files/${file.id}/view`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la génération du lien de visualisation');
      }

      const { viewUrl, filename, mimeType } = await response.json();
      
      // Pour les images, afficher dans le dialog
      if (mimeType.startsWith('image/')) {
        setViewingFile({ url: viewUrl, filename, mimeType });
      } else {
        // Pour les PDFs et autres fichiers, ouvrir directement dans un nouvel onglet
        const isInIframe = window.self !== window.top;
        if (isInIframe) {
          window.parent.postMessage({ 
            type: 'OPEN_EXTERNAL_URL', 
            data: { url: viewUrl } 
          }, '*');
        } else {
          window.open(viewUrl, '_blank', 'noopener,noreferrer');
        }
        toast.success('Document ouvert dans un nouvel onglet');
      }
    } catch (error) {
      console.error('View error:', error);
      toast.error('Erreur lors de la visualisation');
    } finally {
      setIsLoadingView(false);
    }
  };

  const handleDownload = async (file: AssetFile) => {
    try {
      setDownloadingFiles(prev => new Set(prev).add(file.id));

      const token = localStorage.getItem('bearer_token');
      if (!token) {
        toast.error('Non authentifié');
        return;
      }

      const response = await fetch(`/api/files/${file.id}/download`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la génération du lien de téléchargement');
      }

      const { downloadUrl } = await response.json();

      const isInIframe = window.self !== window.top;
      if (isInIframe) {
        window.parent.postMessage({ 
          type: 'OPEN_EXTERNAL_URL', 
          data: { url: downloadUrl } 
        }, '*');
      } else {
        window.open(downloadUrl, '_blank', 'noopener,noreferrer');
      }

      toast.success('Téléchargement démarré');
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Erreur lors du téléchargement');
    } finally {
      setDownloadingFiles(prev => {
        const newSet = new Set(prev);
        newSet.delete(file.id);
        return newSet;
      });
    }
  };

  const handleEditClick = (file: AssetFile) => {
    setFileToEdit(file);
    setEditDialogOpen(true);
  };

  const handleEditComplete = () => {
    setEditDialogOpen(false);
    setFileToEdit(null);
    loadFiles();
  };

  const handleDeleteClick = (file: AssetFile) => {
    setFileToDelete(file);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!fileToDelete) return;

    try {
      setIsDeleting(true);

      const token = localStorage.getItem('bearer_token');
      if (!token) {
        toast.error('Non authentifié');
        return;
      }

      const response = await fetch(`/api/files/${fileToDelete.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la suppression');
      }

      toast.success('Fichier supprimé avec succès');
      setDeleteDialogOpen(false);
      setFileToDelete(null);
      loadFiles();
    } catch (error) {
      console.error('Delete error:', error);
      toast.error('Erreur lors de la suppression');
    } finally {
      setIsDeleting(false);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const formatDate = (dateStr: string): string => {
    return new Date(dateStr).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getFileIcon = (mimeType: string) => {
    if (mimeType.startsWith('image/')) {
      return <Image className="h-5 w-5 text-blue-500" />;
    }
    if (mimeType === 'application/pdf') {
      return <FileText className="h-5 w-5 text-red-500" />;
    }
    if (mimeType.includes('document') || mimeType.includes('word')) {
      return <FileText className="h-5 w-5 text-blue-600" />;
    }
    if (mimeType.includes('sheet') || mimeType.includes('excel')) {
      return <FileText className="h-5 w-5 text-green-600" />;
    }
    return <FileIcon className="h-5 w-5 text-muted-foreground" />;
  };

  const getFileExtension = (fileName: string): string => {
    const parts = fileName.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : '—';
  };

  const isImageFile = (mimeType: string): boolean => {
    return mimeType.includes('image/');
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="text-center py-12 border-2 border-dashed rounded-lg">
        <FileIcon className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
        <p className="text-muted-foreground">Aucun fichier uploadé</p>
      </div>
    );
  }

  return (
    <>
      {/* Bulk Actions Bar */}
      {selectedIds.length > 0 && (
        <Card className="bg-primary/5 border-primary/20 mb-4">
          <CardContent className="py-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">
                {selectedIds.length} document{selectedIds.length > 1 ? 's' : ''} sélectionné{selectedIds.length > 1 ? 's' : ''}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMoveDialogOpen(true)}
                >
                  <MoveHorizontal className="w-4 h-4 mr-2" />
                  Changer de bien
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBulkExport}
                  disabled={isExporting}
                >
                  {isExporting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Export...
                    </>
                  ) : (
                    <>
                      <Archive className="w-4 h-4 mr-2" />
                      Exporter en ZIP
                    </>
                  )}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleteDialogOpen(true)}
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Supprimer
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-muted/50">
            <tr className="border-b">
              <th className="text-left p-4 w-12">
                <Checkbox
                  checked={selectedIds.length === files.length && files.length > 0}
                  onCheckedChange={toggleSelectAll}
                />
              </th>
              <th className="text-left p-4 font-medium w-20">Aperçu</th>
              <th className="text-left p-4 font-medium">Nom du document</th>
                <th className="text-left p-4 font-medium hidden md:table-cell">Type</th>
                <th className="text-left p-4 font-medium hidden md:table-cell">Date du doc.</th>
                <th className="text-left p-4 font-medium hidden xl:table-cell">Format</th>

              <th className="text-left p-4 font-medium hidden xl:table-cell">Taille</th>
              <th className="text-left p-4 font-medium hidden lg:table-cell">Date d'ajout</th>
              <th className="text-right p-4 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => {
              // Find asset name for this file
              const asset = assets.find(a => a.id === file.assetId);
              
              // Create document object compatible with DocumentEditDialog
              const documentForEdit = {
                id: file.id,
                fileName: file.originalFilename,
                documentType: file.documentType || 'AUTRE',
                asset: {
                  id: file.assetId,
                  name: asset?.name || 'Unknown'
                },
                createdAt: file.createdAt
              };
              
              return (
                <tr 
                  key={file.id} 
                  className="border-b hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={(e) => {
                    // Ne pas déclencher si on clique sur un élément interactif
                    const target = e.target as HTMLElement;
                    if (
                      target.closest('button') ||
                      target.closest('[role="checkbox"]')
                    ) {
                      return;
                    }
                    handleView(file);
                  }}
                >
                  <td className="p-4" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.includes(file.id)}
                      onCheckedChange={() => toggleSelect(file.id)}
                    />
                  </td>
                  <td className="p-4">
                    <div className="w-12 h-12 rounded-lg overflow-hidden bg-muted flex items-center justify-center">
                      {isImageFile(file.mimeType) && filePreviewUrls[file.id] ? (
                        <NextImage
                          src={filePreviewUrls[file.id]}
                          alt={file.originalFilename}
                          width={48}
                          height={48}
                          className="w-full h-full object-cover"
                          unoptimized
                        />
                      ) : (
                        <File className="w-6 h-6 text-muted-foreground" />
                      )}
                    </div>
                  </td>
                  <td className="p-4">
                    <div className="flex items-center gap-2">
                      {getFileIcon(file.mimeType)}
                      <span className="font-medium truncate max-w-xs">{file.originalFilename}</span>
                    </div>
                  </td>
                  <td className="p-4 hidden md:table-cell">
                    {file.documentType ? (
                      <Badge variant="outline">
                        {getDocumentTypeLabel(file.documentType)}
                      </Badge>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="p-4 text-sm text-muted-foreground hidden md:table-cell">
                    {file.documentDate ? formatDate(file.documentDate) : '—'}
                  </td>
                  <td className="p-4 text-sm font-medium hidden xl:table-cell">
                    {getFileExtension(file.originalFilename)}
                  </td>
                  <td className="p-4 text-sm text-muted-foreground hidden xl:table-cell">
                    {formatFileSize(file.size)}
                  </td>
                  <td className="p-4 text-sm text-muted-foreground hidden lg:table-cell">
                    {formatDate(file.uploadedAt)}
                  </td>
                  <td className="p-4" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <MoreVertical className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleView(file)} disabled={isLoadingView}>
                            <Eye className="w-4 h-4 mr-2" />
                            Visualiser
                          </DropdownMenuItem>
                          <DropdownMenuItem 
                            onClick={() => handleDownload(file)}
                            disabled={downloadingFiles.has(file.id)}
                          >
                            <Download className="w-4 h-4 mr-2" />
                            Télécharger
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleEditClick(file)}>
                            <Edit className="w-4 h-4 mr-2" />
                            Modifier
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            onClick={() => {
                              setFileToDelete(file);
                              setDeleteDialogOpen(true);
                            }}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="w-4 h-4 mr-2" />
                            Supprimer
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* View Dialog - Only for images */}
      <Dialog open={!!viewingFile} onOpenChange={() => setViewingFile(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>{viewingFile?.filename}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto">
            {viewingFile && (
              <img 
                src={viewingFile.url} 
                alt={viewingFile.filename}
                className="max-w-full h-auto"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      {fileToEdit && (
        <DocumentEditDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
            document={{
              id: fileToEdit.id,
              fileName: fileToEdit.originalFilename,
              documentType: fileToEdit.documentType || 'AUTRE',
              documentDate: null,
              asset: {
                id: fileToEdit.assetId,
                name: assets.find(a => a.id === fileToEdit.assetId)?.name || 'Unknown'
              },
              createdAt: fileToEdit.createdAt
            }}
          assets={assets}
          documentTypes={documentTypes}
          onEditComplete={handleEditComplete}
        />
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Supprimer {selectedIds.length > 0 ? `${selectedIds.length} document${selectedIds.length > 1 ? 's' : ''}` : 'ce fichier'} ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedIds.length > 0 ? (
                <>Cette action est irréversible pour ces documents. Les fichiers resteront temporairement 
                sur le stockage mais ne seront plus visibles dans l'application.</>
              ) : (
                <>Le fichier "{fileToDelete?.originalFilename}" sera supprimé définitivement.
                Cette action ne peut pas être annulée.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={selectedIds.length > 0 ? handleBulkDelete : handleDeleteConfirm}
              disabled={isDeleting}
              className="bg-destructive hover:bg-destructive/90"
            >
              {isDeleting ? 'Suppression...' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Move Dialog */}
      <Dialog open={moveDialogOpen} onOpenChange={setMoveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Changer de bien</DialogTitle>
            <DialogDescription>
              Déplacer {selectedIds.length} document{selectedIds.length > 1 ? 's' : ''} vers un autre bien
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Select value={targetAssetId} onValueChange={setTargetAssetId}>
              <SelectTrigger>
                <SelectValue placeholder="Sélectionner un bien" />
              </SelectTrigger>
              <SelectContent>
                {assets.filter(a => a.id !== assetId).map((asset) => (
                  <SelectItem key={asset.id} value={asset.id.toString()}>
                    {asset.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveDialogOpen(false)}>
              Annuler
            </Button>
            <Button
              onClick={handleBulkMove}
              disabled={isMoving || !targetAssetId}
            >
              {isMoving ? 'Déplacement...' : 'Appliquer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}