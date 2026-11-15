/**
 * Royalty Calculator page (P9 Batch E) — `/publishing/royalty-calculator`.
 *
 * A planning tool that ESTIMATES author income across one or more platform
 * schemes. It is deliberately explicit about what is user input, what is an
 * editable DEFAULT ASSUMPTION, and what is a computed RESULT, and it shows a
 * permanent disclaimer that these figures are not an income promise.
 *
 * All math lives in the pure `royalty-calculator.ts` module (unit-tested); this
 * page only holds form state and renders the derived result.
 */

import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Calculator, Coins, Info, Plus, RotateCcw, Trash2, Trophy } from 'lucide-react';
import { Badge, Button, Card, PageHeader } from '@/components/ui';
import {
  calculateRoyalties,
  DEFAULT_ROYALTY_INPUTS,
  defaultScheme,
  ROYALTY_DISCLAIMER,
  type RoyaltyInputs,
  type RoyaltyScheme,
  type SchemeResult,
} from '@/modules/publishing/royalty/royalty-calculator';
import { cn } from '@/utils/cn';

/** A currency formatter for the calculator's single currency (USD-style). */
const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });

function formatMoney(n: number): string {
  return money.format(Number.isFinite(n) ? n : 0);
}

let schemeSeq = 0;
function newSchemeId(): string {
  schemeSeq += 1;
  return `scheme-${Date.now()}-${schemeSeq}`;
}

export function RoyaltyCalculatorPage() {
  const [inputs, setInputs] = useState<RoyaltyInputs>(DEFAULT_ROYALTY_INPUTS);
  const [schemes, setSchemes] = useState<RoyaltyScheme[]>([
    defaultScheme('scheme-default', 'Platform A'),
  ]);

  const result = useMemo(() => calculateRoyalties(inputs, schemes), [inputs, schemes]);
  const resultById = useMemo(() => {
    const map = new Map<string, SchemeResult>();
    for (const r of result.schemes) map.set(r.schemeId, r);
    return map;
  }, [result]);

  const updateInput = useCallback(<K extends keyof RoyaltyInputs>(key: K, value: number) => {
    setInputs((prev) => ({ ...prev, [key]: value }));
  }, []);

  const updateScheme = useCallback((id: string, patch: Partial<RoyaltyScheme>) => {
    setSchemes((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  const updateSchemeModel = useCallback(
    (id: string, model: RoyaltyScheme['model']) => {
      setSchemes((prev) => prev.map((s) => (s.id === id ? { ...s, model, assumed: true } : s)));
    },
    [],
  );

  const addScheme = useCallback(() => {
    setSchemes((prev) => [...prev, defaultScheme(newSchemeId(), `Platform ${String.fromCharCode(65 + prev.length)}`)]);
  }, []);

  const removeScheme = useCallback((id: string) => {
    setSchemes((prev) => (prev.length <= 1 ? prev : prev.filter((s) => s.id !== id)));
  }, []);

  const resetAll = useCallback(() => {
    setInputs(DEFAULT_ROYALTY_INPUTS);
    setSchemes([defaultScheme(newSchemeId(), 'Platform A')]);
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Royalty Calculator"
        description="Estimate platform royalties from a price and an expected sales volume. Compare schemes side by side."
        icon={<Coins className="size-4" aria-hidden />}
        actions={
          <Button variant="ghost" size="sm" iconLeft={<RotateCcw className="size-3.5" />} onClick={resetAll} data-testid="royalty-reset">
            Reset
          </Button>
        }
      />

      {/* Permanent, prominent disclaimer. */}
      <div
        className="text-warning bg-warning-soft/40 flex items-start gap-2 rounded-lg border border-warning/40 px-3 py-2 text-2xs leading-relaxed"
        role="note"
        data-testid="royalty-disclaimer"
      >
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          <strong className="font-semibold">Estimate only.</strong> {ROYALTY_DISCLAIMER}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        {/* ---------------------- Inputs ---------------------- */}
        <Card padding="md" className="space-y-4" data-testid="royalty-inputs">
          <div className="flex items-center gap-1.5">
            <Calculator className="text-accent size-3.5" aria-hidden />
            <p className="text-ink text-sm font-medium">Your inputs</p>
          </div>

          <label className="block space-y-1">
            <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Unit price (USD)</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={inputs.unitPrice}
              onChange={(e) => updateInput('unitPrice', e.target.valueAsNumber)}
              className="border-line bg-surface text-ink w-full rounded-md border px-2 py-1.5 text-xs tabular-nums"
              data-testid="royalty-price-input"
            />
            <span className="text-subtle text-2xs">The cover price a reader pays per copy.</span>
          </label>

          <label className="block space-y-1">
            <span className="text-subtle text-2xs font-medium uppercase tracking-wide">Units expected to sell</span>
            <input
              type="number"
              min={0}
              step="1"
              value={inputs.unitsSold}
              onChange={(e) => updateInput('unitsSold', e.target.valueAsNumber)}
              className="border-line bg-surface text-ink w-full rounded-md border px-2 py-1.5 text-xs tabular-nums"
              data-testid="royalty-units-input"
            />
            <span className="text-subtle text-2xs">Negative or blank values are treated as 0.</span>
          </label>

          <div className="border-line flex items-center justify-between border-t pt-3">
            <span className="text-ink text-xs font-medium">Schemes ({schemes.length})</span>
            <Button variant="secondary" size="sm" iconLeft={<Plus className="size-3.5" />} onClick={addScheme} data-testid="royalty-add-scheme">
              Add platform
            </Button>
          </div>

          <div className="space-y-3">
            {schemes.map((scheme, index) => (
              <SchemeEditor
                key={scheme.id}
                scheme={scheme}
                index={index}
                canRemove={schemes.length > 1}
                onChange={(patch) => updateScheme(scheme.id, patch)}
                onChangeModel={(model) => updateSchemeModel(scheme.id, model)}
                onRemove={() => removeScheme(scheme.id)}
              />
            ))}
          </div>
        </Card>

        {/* ---------------------- Results ---------------------- */}
        <Card padding="md" className="space-y-4" data-testid="royalty-results">
          <div className="flex items-center gap-1.5">
            <Coins className="text-accent size-3.5" aria-hidden />
            <p className="text-ink text-sm font-medium">Estimated results</p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Metric label="Gross revenue" value={formatMoney(result.grossRevenue)} testId="royalty-gross" />
            <Metric
              label="Author (best)"
              value={
                result.bestSchemeId
                  ? formatMoney(resultById.get(result.bestSchemeId)?.authorIncome ?? 0)
                  : formatMoney(0)
              }
              testId="royalty-best-author"
              tone="success"
            />
            <Metric label="Schemes" value={String(result.schemes.length)} testId="royalty-scheme-count" />
          </div>

          {result.hasAssumptions ? (
            <p className="text-warning flex items-start gap-1.5 text-2xs" data-testid="royalty-assumptions-note">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
              One or more rates are assumed defaults — edit them to match the real platform terms.
            </p>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs" data-testid="royalty-table">
              <thead>
                <tr className="text-subtle border-line border-b text-left text-2xs uppercase tracking-wide">
                  <th className="py-1.5 pr-2 font-medium">Platform</th>
                  <th className="py-1.5 px-2 text-right font-medium">Gross</th>
                  <th className="py-1.5 px-2 text-right font-medium">Platform cut</th>
                  <th className="py-1.5 px-2 text-right font-medium">Author income</th>
                  <th className="py-1.5 pl-2 text-right font-medium">Author %</th>
                </tr>
              </thead>
              <tbody>
                {result.schemes.map((r) => {
                  const best = r.schemeId === result.bestSchemeId;
                  return (
                    <tr
                      key={r.schemeId}
                      className={cn('border-line border-b last:border-0', best && 'bg-success-soft/30')}
                      data-testid={`royalty-row-${r.schemeId}`}
                    >
                      <td className="py-1.5 pr-2">
                        <div className="flex items-center gap-1.5">
                          {best ? <Trophy className="size-3 shrink-0 text-success" aria-label="Best" /> : null}
                          <span className="text-ink font-medium">{r.name}</span>
                          {r.assumed ? (
                            <Badge tone="warning" size="sm">
                              assumed
                            </Badge>
                          ) : null}
                        </div>
                        {r.warning ? (
                          <p className="text-danger mt-0.5 text-2xs">{r.warning}</p>
                        ) : null}
                      </td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{formatMoney(r.grossRevenue)}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{formatMoney(r.platformCut)}</td>
                      <td className={cn('py-1.5 px-2 text-right font-semibold tabular-nums', best ? 'text-success' : 'text-ink')}>
                        {formatMoney(r.authorIncome)}
                      </td>
                      <td className="py-1.5 pl-2 text-right tabular-nums">{r.effectiveAuthorPercent.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-subtle text-2xs leading-relaxed" data-testid="royalty-result-disclaimer">
            {result.disclaimer}
          </p>
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------- sub-components ------------------------------- */

function Metric({
  label,
  value,
  testId,
  tone,
}: {
  label: string;
  value: string;
  testId: string;
  tone?: 'success';
}) {
  return (
    <div className="bg-surface-muted/50 rounded-md border border-line px-2.5 py-2" data-testid={testId}>
      <p className="text-subtle text-2xs">{label}</p>
      <p className={cn('mt-0.5 text-sm font-semibold tabular-nums', tone === 'success' ? 'text-success' : 'text-ink')}>
        {value}
      </p>
    </div>
  );
}

function SchemeEditor({
  scheme,
  index,
  canRemove,
  onChange,
  onChangeModel,
  onRemove,
}: {
  scheme: RoyaltyScheme;
  index: number;
  canRemove: boolean;
  onChange: (patch: Partial<RoyaltyScheme>) => void;
  onChangeModel: (model: RoyaltyScheme['model']) => void;
  onRemove: () => void;
}) {
  const isPercentage = scheme.model.kind === 'percentage';
  return (
    <div className="border-line space-y-2 rounded-md border p-2.5" data-testid={`royalty-scheme-${index}`}>
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={scheme.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="border-line bg-surface text-ink min-w-0 flex-1 rounded-md border px-2 py-1 text-2xs font-medium"
          aria-label="Scheme name"
          data-testid={`royalty-scheme-name-${index}`}
        />
        {canRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="text-subtle hover:text-danger"
            aria-label="Remove scheme"
            data-testid={`royalty-scheme-remove-${index}`}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="text-subtle text-2xs">Royalty model</span>
          <select
            value={scheme.model.kind}
            onChange={(e) =>
              onChangeModel(
                e.target.value === 'percentage'
                  ? { kind: 'percentage', ratePercent: 70 }
                  : { kind: 'fixed-per-unit', amountPerUnit: 1 },
              )
            }
            className="border-line bg-surface text-ink w-full rounded-md border px-2 py-1 text-2xs"
            data-testid={`royalty-scheme-model-${index}`}
          >
            <option value="percentage">% of price</option>
            <option value="fixed-per-unit">Fixed per unit</option>
          </select>
        </label>

        {isPercentage ? (
          <label className="block space-y-1">
            <span className="text-subtle text-2xs">Royalty rate (%)</span>
            <input
              type="number"
              min={0}
              max={100}
              step="0.1"
              value={scheme.model.kind === 'percentage' ? scheme.model.ratePercent : 0}
              onChange={(e) => onChangeModel({ kind: 'percentage', ratePercent: e.target.valueAsNumber })}
              className="border-line bg-surface text-ink w-full rounded-md border px-2 py-1 text-2xs tabular-nums"
              data-testid={`royalty-scheme-rate-${index}`}
            />
          </label>
        ) : (
          <label className="block space-y-1">
            <span className="text-subtle text-2xs">Per unit (USD)</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={scheme.model.kind === 'fixed-per-unit' ? scheme.model.amountPerUnit : 0}
              onChange={(e) => onChangeModel({ kind: 'fixed-per-unit', amountPerUnit: e.target.valueAsNumber })}
              className="border-line bg-surface text-ink w-full rounded-md border px-2 py-1 text-2xs tabular-nums"
              data-testid={`royalty-scheme-amount-${index}`}
            />
          </label>
        )}
      </div>

      <label className="block space-y-1">
        <span className="text-subtle text-2xs">Distribution/listing fee (% of gross)</span>
        <input
          type="number"
          min={0}
          max={100}
          step="0.1"
          value={scheme.distributionFeePercent}
          onChange={(e) => onChange({ distributionFeePercent: e.target.valueAsNumber })}
          className="border-line bg-surface text-ink w-full rounded-md border px-2 py-1 text-2xs tabular-nums"
          data-testid={`royalty-scheme-fee-${index}`}
        />
      </label>
    </div>
  );
}
