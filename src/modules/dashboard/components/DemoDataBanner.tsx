import { Info } from 'lucide-react';
import { DEMO_NOTICE } from '@/modules/dashboard/demo-data';

/**
 * Prominent, unmissable marker that the dashboard shows fabricated data.
 * Deliberately not dismissible: the reviewer must never mistake it for real
 * workspace statistics.
 */
export function DemoDataBanner() {
  return (
    <div
      role="note"
      className="bg-warning-soft text-warning flex items-start gap-2 rounded-md border border-warning/25 px-3 py-2"
    >
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p className="text-xs leading-relaxed">
        <span className="font-semibold">Demo Data · </span>
        {DEMO_NOTICE}
      </p>
    </div>
  );
}
