export default function AgendaLoading() {
  return (
    <div className="space-y-6 p-6">
      <div className="h-10 w-48 bg-muted animate-pulse rounded" />
      <div className="flex gap-4">
        <div className="flex-1 h-[600px] bg-muted animate-pulse rounded-xl" />
        <div className="w-80 h-[600px] bg-muted animate-pulse rounded-xl" />
      </div>
    </div>
  );
}