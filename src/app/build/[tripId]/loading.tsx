// Route-level loading skeleton for the quiz route (it runs an ownership +
// trip query before the quiz mounts) so entering the quiz doesn't flash a
// frozen previous page.
export default function Loading() {
  return (
    <div className="min-h-[70vh] grid place-items-center px-6">
      <div className="flex flex-col items-center gap-4">
        <p className="text-[10px] uppercase tracking-[0.4em] text-muted-foreground">
          Pyltrix
        </p>
        <div className="relative h-px w-40 bg-border overflow-hidden">
          <div className="absolute inset-y-0 w-1/3 bg-accent animate-build-sweep" />
        </div>
      </div>
    </div>
  );
}
