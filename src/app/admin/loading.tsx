export default function AdminLoading() {
  return (
    <div className="space-y-6">
      {/* Header Skeleton */}
      <div className="space-y-2">
        <div className="h-10 w-64 bg-muted animate-pulse rounded" />
        <div className="h-4 w-96 bg-muted animate-pulse rounded" />
      </div>

      {/* Filters Card Skeleton */}
      <div className="h-32 w-full border rounded-xl bg-card animate-pulse" />

      {/* Table Card Skeleton */}
      <div className="border rounded-xl bg-card overflow-hidden">
        <div className="p-6 border-b">
          <div className="h-6 w-48 bg-muted animate-pulse rounded" />
        </div>
        <div className="p-6 space-y-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-20 w-full bg-muted animate-pulse rounded" />
          ))}
        </div>
      </div>
    </div>
  );
}
