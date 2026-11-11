import { Info } from 'lucide-react';

/**
 * Prominent, unmissable marker for the parts of the dashboard that still show
 * fabricated data. Deliberately not dismissible: the reviewer must never
 * mistake demo figures for real workspace statistics.
 *
 * The project overview blocks (total, recent, status) are now driven by real
 * IndexedDB data, so the copy must say "partly" — never imply everything is fake.
 */
export function DemoDataBanner() {
  return (
    <div
      role="note"
      className="bg-warning-soft text-warning flex items-start gap-2 rounded-md border border-warning/25 px-3 py-2"
    >
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p className="text-xs leading-relaxed">
        <span className="font-semibold">Partial demo data · </span>
        Project overview (total, recent and status) reflects your real projects. Writing statistics,
        goals, activity and AI status are still demo content.
      </p>
    </div>
  );
}
