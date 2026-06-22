"use client"

import { useState, useEffect, useCallback, useMemo } from 'react';
import { AssetDocumentsPanel } from '@/components/asset-documents-panel';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import { DocumentDrawer, DocumentDrawerItem } from './DocumentDrawer';
import dynamic from 'next/dynamic';
import { DOCUMENT_TYPE_LABELS as DOC_TYPE_LABELS } from '@/lib/document-type-constants';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const UnifiedDocumentDialog = dynamic(
  () => import('@/components/documents/unified-document-dialog').then(m => ({ default: m.UnifiedDocumentDialog })),
  { ssr: false }
);

interface AssetFile {
  id: number;
  filename: string;
  originalFilename: string;
  retainedTitle?: string | null;
  mimeType: string;
  fileExtension: string;
  size: number;
  uploadStatus: string;
  uploadedAt: string;
  createdAt: string;
  documentType?: string;
  documentDate?: string;
  assetId: number;
  previewUrl?: string | null;
}

interface Pagination {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

interface Props {
  assetId: number;
  assetCategory: string;
  assetName: string;
  assetTypeId?: number;
  assetTypeSubcategoryId?: number;
  planType: 'freemium' | 'premium';
}

const PAGE_SIZE_OPTIONS = [50, 100, 200] as const;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];

export function AssetDocumentsTab({ assetId, assetCategory, assetName, assetTypeId, assetTypeSubcategoryId, planType }: Props) {
  const [files, setFiles] = useState<AssetFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [drawerDoc, setDrawerDoc] = useState<DocumentDrawerItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerIndex, setDrawerIndex] = useState<number>(-1);
  const [bearerToken, setBearerToken] = useState('');

  useEffect(() => { setBearerToken(localStorage.getItem('bearer_token') || ''); }, []);

  // Pagination state
  const [pageSize, setPageSize] = useState<PageSize>(50);
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([null]); // index = page index
  const [currentPage, setCurrentPage] = useState(0); // 0-based
  const [pagination, setPagination] = useState<Pagination | null>(null);

  const currentCursor = cursorHistory[currentPage] ?? null;

  const load = useCallback(async (cursor: string | null, size: PageSize) => {
    setLoading(true);
    try {
      apiClient.clearCache();
      const params = new URLSearchParams({ assetId: assetId.toString(), uploadStatus: 'COMPLETED', limit: size.toString() });
      if (cursor) params.set('cursor', cursor);
      const data = await apiClient.get<any>(`/api/files?${params}`);
      const arr: AssetFile[] = Array.isArray(data) ? data : (data?.data ?? []);
      setFiles(arr);
      if (data?.pagination) setPagination(data.pagination);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [assetId, refreshTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load(currentCursor, pageSize);
  }, [currentPage, pageSize, refreshTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = useCallback(() => {
    setCursorHistory([null]);
    setCurrentPage(0);
    setPagination(null);
    setRefreshTrigger(v => v + 1);
  }, []);

  useEffect(() => {
    window.addEventListener('document-added', handleRefresh);
    return () => window.removeEventListener('document-added', handleRefresh);
  }, [handleRefresh]);

  const handleNextPage = useCallback(() => {
    if (!pagination?.nextCursor) return;
    const nextIndex = currentPage + 1;
    setCursorHistory(prev => {
      const next = [...prev];
      next[nextIndex] = pagination.nextCursor;
      return next;
    });
    setCurrentPage(nextIndex);
  }, [currentPage, pagination]);

  const handlePrevPage = useCallback(() => {
    if (currentPage === 0) return;
    setCurrentPage(p => p - 1);
  }, [currentPage]);

  const handlePageSizeChange = useCallback((size: PageSize) => {
    setPageSize(size);
    setCursorHistory([null]);
    setCurrentPage(0);
    setPagination(null);
  }, []);

  const documents = useMemo(() => files.map(f => ({
    id: f.id.toString(),
    name: f.retainedTitle || f.originalFilename,
    typeLabel: DOC_TYPE_LABELS[f.documentType ?? 'AUTRE'] ?? 'Autre',
    mimeType: f.mimeType,
    sizeBytes: f.size,
    createdAt: f.createdAt,
    documentDate: f.documentDate,
    previewUrl: f.mimeType?.startsWith('image/') ? `/api/files/${f.id}/proxy${bearerToken ? `?token=${encodeURIComponent(bearerToken)}` : ''}` : (f.previewUrl ?? undefined),
    iconType: (f.mimeType.startsWith('image/') ? 'image' : f.mimeType === 'application/pdf' ? 'pdf' : 'other') as 'image' | 'pdf' | 'other',
  })), [files, bearerToken]);

  const openDocumentAtIndex = useCallback((index: number) => {
    const file = files[index];
    if (!file) return;
    setDrawerIndex(index);
    setDrawerDoc({
      id: file.id,
      originalFilename: file.originalFilename,
      mimeType: file.mimeType,
      documentType: file.documentType ?? 'AUTRE',
      documentDate: file.documentDate ?? null,
      uploadedAt: file.uploadedAt ?? null,
      size: file.size,
      assetId,
    });
    setDrawerOpen(true);
  }, [files, assetId]);

  const handleDocumentClick = useCallback((doc: { id: string; name: string; mimeType: string; typeLabel: string; documentDate?: string; createdAt: string; sizeBytes: number }) => {
    const fileId = parseInt(doc.id);
    const index = files.findIndex(f => f.id === fileId);
    if (index === -1) return;
    openDocumentAtIndex(index);
  }, [files, openDocumentAtIndex]);

  const handleDrawerPrev = useCallback(() => {
    if (drawerIndex > 0) openDocumentAtIndex(drawerIndex - 1);
  }, [drawerIndex, openDocumentAtIndex]);

  const handleDrawerNext = useCallback(() => {
    if (drawerIndex < files.length - 1) openDocumentAtIndex(drawerIndex + 1);
  }, [drawerIndex, files.length, openDocumentAtIndex]);

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }

  const hasPrev = currentPage > 0;
  const hasNext = pagination?.hasMore ?? false;
  const showPagination = hasPrev || hasNext || documents.length >= pageSize;

  return (
    <>
      <AssetDocumentsPanel
        assetId={assetId.toString()}
        assetCategory={assetCategory}
        assetName={assetName}
        assetTypeId={assetTypeId}
        assetTypeSubcategoryId={assetTypeSubcategoryId}
        planType={planType}
        documents={documents}
        defaultViewMode="grid"
        onUploadClick={() => setShowUpload(true)}
        onRefresh={handleRefresh}
        onDocumentClick={handleDocumentClick as any}
      />

      {/* Pagination controls */}
      {showPagination && (
        <div className="flex items-center justify-between mt-4 pt-4 border-t border-[color:var(--border-subtle)]">
          <div className="flex items-center gap-2 text-sm text-[color:var(--text-muted)]">
            <span>Afficher</span>
            <div className="flex items-center rounded-md border border-[color:var(--border-subtle)] overflow-hidden">
              {PAGE_SIZE_OPTIONS.map(size => (
                <button
                  key={size}
                  onClick={() => handlePageSizeChange(size)}
                  className={`px-3 py-1.5 text-sm transition-colors ${pageSize === size ? 'bg-[#3b82f6] text-white font-medium' : 'text-[color:var(--text-muted)] hover:bg-[rgba(255,255,255,0.05)]'}`}
                >
                  {size}
                </button>
              ))}
            </div>
            <span>par page</span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-[color:var(--text-muted)]">
              Page {currentPage + 1}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrevPage}
              disabled={!hasPrev}
              className="h-8 w-8 p-0"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleNextPage}
              disabled={!hasNext}
              className="h-8 w-8 p-0"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {showUpload && (
        <UnifiedDocumentDialog
          open={showUpload}
          onOpenChange={setShowUpload}
          onSuccess={() => { setShowUpload(false); handleRefresh(); }}
          preselectedAssetId={assetId}
          availableAssets={[{ id: assetId, name: assetName }]}
          allowAssetSelection={false}
          allowEventCreation={true}
          allowEventAssociation={false}
        />
      )}

      <DocumentDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        document={drawerDoc}
        onRefresh={handleRefresh}
        onPrev={handleDrawerPrev}
        onNext={handleDrawerNext}
        hasPrev={drawerIndex > 0}
        hasNext={drawerIndex < files.length - 1}
      />
    </>
  );
}
