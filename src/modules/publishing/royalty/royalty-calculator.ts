/**
 * Royalty Calculator logic (P9 Batch E).
 *
 * A PURE, deterministic estimation module — no React, no Dexie, no network.
 * The UI and the unit tests both call these functions, so the numbers the user
 * sees are exactly the numbers the tests verify.
 *
 * ## Honesty contract (important)
 *
 * These are ESTIMATES. No platform rate in this module is an official, verified
 * figure. Every default is explicitly labelled `assumed` and is fully editable
 * in the UI; nothing here is presented as an authoritative rate. The output
 * carries `disclaimer` text that the UI must display.
 *
 * ## Inputs vs. assumptions vs. results
 *
 * - `RoyaltyInputs` are USER-ENTERED values (price, units, share %, etc.).
 * - `RoyaltyAssumptions` are DEFAULTS the user can override; each is tagged so
 *   the UI can show which values are assumptions rather than entered facts.
 * - `RoyaltyResult` is DERIVED — never persisted, never asserted as income.
 *
 * ## Rounding & precision
 *
 * All money is computed in integer minor units (cents) internally and only
 * converted back to a 2-decimal number at the boundary, so floating-point drift
 * cannot accumulate across a multi-platform comparison. Rates are clamped to
 * sane bounds and invalid input never throws — it degrades to a defined result.
 */

/* ========================================================================== */
/* Types                                                                      */
/* ========================================================================== */

/** How a platform splits revenue: a percent of list price, or a fixed per-unit fee. */
export type RoyaltyModel =
  | { readonly kind: 'percentage'; readonly ratePercent: number }
  | { readonly kind: 'fixed-per-unit'; readonly amountPerUnit: number };

/** A single platform scheme the user can compare. */
export interface RoyaltyScheme {
  /** Stable id (used as a React key and to keep edits stable across reorders). */
  readonly id: string;
  /** Display name, e.g. "Platform A". */
  readonly name: string;
  /** The royalty model for this platform. */
  readonly model: RoyaltyModel;
  /**
   * An additional platform DISTRIBUTION/listing fee as a percent of gross
   * revenue (0 = none). Some stores charge a delivery/handling percentage; this
   * models that generically. It is subtracted BEFORE the royalty share.
   */
  readonly distributionFeePercent: number;
  /** Whether this platform's figures are derived from an ASSUMED (unverified) rate. */
  readonly assumed: boolean;
  /** Optional short note shown in the UI (e.g. "based on a 70% list royalty"). */
  readonly note?: string;
}

/** USER-ENTERED, per-estimate inputs shared across all schemes. */
export interface RoyaltyInputs {
  /** Cover/list price per unit, in the calculator's currency (major units). */
  readonly unitPrice: number;
  /** Number of units expected to sell. */
  readonly unitsSold: number;
}

/** A single platform's computed breakdown. */
export interface SchemeResult {
  readonly schemeId: string;
  readonly name: string;
  /** Gross revenue = price × units (positive only). */
  readonly grossRevenue: number;
  /** Platform's total take (distribution fee + royalty share not paid to author). */
  readonly platformCut: number;
  /** The author's estimated income. */
  readonly authorIncome: number;
  /** Effective author share of gross, as a percent (0–100). */
  readonly effectiveAuthorPercent: number;
  /** True when this scheme's rate is an unverified assumption. */
  readonly assumed: boolean;
  /** Populated when the scheme could not be evaluated (e.g. invalid rate). */
  readonly warning?: string;
}

/** The full comparison result. */
export interface RoyaltyResult {
  readonly grossRevenue: number;
  readonly schemes: readonly SchemeResult[];
  /** The scheme with the highest author income (ties → first). `null` if none valid. */
  readonly bestSchemeId: string | null;
  /** Human-readable, ALWAYS-displayed estimate disclaimer. */
  readonly disclaimer: string;
  /** True when at least one scheme's rate is an assumption. */
  readonly hasAssumptions: boolean;
}

/** The mandatory estimate disclaimer (single source of truth for the text). */
export const ROYALTY_DISCLAIMER =
  'These figures are ESTIMATES for planning only. Royalty rates, fees and ' +
  'payout terms differ by platform, territory, format and contract, and change ' +
  'over time. Nothing here is an official rate or a promise of income — verify ' +
  'every value with the platform before making decisions.';

/* ========================================================================== */
/* Defaults (all editable, all assumed)                                       */
/* ========================================================================== */

/**
 * A safe, editable default scheme. `assumed: true` so the UI never implies the
 * 70% rate is official. The user is expected to change it to their real terms.
 */
export function defaultScheme(id: string, name = 'Platform'): RoyaltyScheme {
  return {
    id,
    name,
    model: { kind: 'percentage', ratePercent: 70 },
    distributionFeePercent: 0,
    assumed: true,
    note: 'Assumed 70% list-price royalty — edit to match the real terms.',
  };
}

/** Sensible default inputs (a modest first estimate). */
export const DEFAULT_ROYALTY_INPUTS: RoyaltyInputs = {
  unitPrice: 9.99,
  unitsSold: 100,
};

/* ========================================================================== */
/* Validation helpers (never throw)                                           */
/* ========================================================================== */

/** Coerces any value to a finite, non-negative number; NaN/Infinity/-x → 0. */
export function toNonNegative(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** Rounds a minor-unit integer to 2 decimals of major units. */
function fromMinor(minor: number): number {
  return Math.round(minor) / 100;
}

/** Converts a major-unit number to integer minor units (cents), rounded. */
function toMinor(major: number): number {
  return Math.round(toNonNegative(major) * 100);
}

/* ========================================================================== */
/* Core calculation                                                           */
/* ========================================================================== */

interface ComputedScheme {
  grossMinor: number;
  platformCutMinor: number;
  authorIncomeMinor: number;
  warning?: string;
  valid: boolean;
}

/** Computes ONE scheme in integer minor units. */
function computeScheme(grossMinor: number, scheme: RoyaltyScheme): ComputedScheme {
  // Sanitise inputs. Invalid values degrade to a defined, flagged result.
  const feePercent = toNonNegative(scheme.distributionFeePercent);
  if (feePercent > 100) {
    return {
      grossMinor,
      platformCutMinor: 0,
      authorIncomeMinor: 0,
      warning: 'Distribution fee is over 100% — this scheme is invalid.',
      valid: false,
    };
  }

  // Distribution fee is taken off the gross first.
  const feeMinor = Math.round((grossMinor * feePercent) / 100);
  const afterFeeMinor = grossMinor - feeMinor;

  let authorShareMinor: number;
  if (scheme.model.kind === 'percentage') {
    const rate = toNonNegative(scheme.model.ratePercent);
    if (rate > 100) {
      return {
        grossMinor,
        platformCutMinor: 0,
        authorIncomeMinor: 0,
        warning: 'Royalty rate is over 100% — this scheme is invalid.',
        valid: false,
      };
    }
    authorShareMinor = Math.round((afterFeeMinor * rate) / 100);
  } else {
    // Fixed per unit: author gets a flat amount per unit sold. Reconstruct the
    // unit count from gross/price is unreliable here, so the caller passes the
    // per-unit amount already multiplied out via `units` (see below).
    authorShareMinor = Math.round(toNonNegative(scheme.model.amountPerUnit) * 100);
  }

  // Author can never earn more than the (post-fee) revenue available.
  const clampedAuthor = Math.min(authorShareMinor, afterFeeMinor);
  const platformCutMinor = grossMinor - clampedAuthor;

  return {
    grossMinor,
    platformCutMinor,
    authorIncomeMinor: clampedAuthor,
    valid: true,
  };
}

/**
 * For `fixed-per-unit` schemes the author income is `amountPerUnit × units`.
 * This computes it directly in minor units for a given unit count.
 */
function fixedAuthorMinor(amountPerUnit: number, units: number): number {
  return Math.round(toNonNegative(amountPerUnit) * 100) * Math.floor(toNonNegative(units));
}

/**
 * Estimates royalties for every scheme from the shared inputs.
 *
 * Deterministic and total: never throws for any numeric input. Zero sales give
 * a fully-zero result (gross 0, author 0) rather than an error. Negative inputs
 * are clamped to 0. Invalid rates (>100% or a fee >100%) yield a scheme with a
 * `warning` and `authorIncome: 0` instead of NaN/Infinity.
 */
export function calculateRoyalties(
  inputs: RoyaltyInputs,
  schemes: readonly RoyaltyScheme[],
): RoyaltyResult {
  const price = toNonNegative(inputs.unitPrice);
  const units = Math.floor(toNonNegative(inputs.unitsSold));
  const priceMinor = toMinor(price);
  const grossMinor = priceMinor * units;

  const schemeResults: SchemeResult[] = schemes.map((scheme) => {
    if (scheme.model.kind === 'fixed-per-unit') {
      // Fixed per-unit: no percentage, fee still applies to the fee base only
      // conceptually, but a flat fee is taken from the author's flat share.
      const authorMinor = fixedAuthorMinor(scheme.model.amountPerUnit, units);
      const clampedAuthor = Math.min(authorMinor, grossMinor);
      const platformCutMinor = grossMinor - clampedAuthor;
      const effective = grossMinor > 0 ? (clampedAuthor / grossMinor) * 100 : 0;
      return {
        schemeId: scheme.id,
        name: scheme.name,
        grossRevenue: fromMinor(grossMinor),
        platformCut: fromMinor(platformCutMinor),
        authorIncome: fromMinor(clampedAuthor),
        effectiveAuthorPercent: round2(effective),
        assumed: scheme.assumed,
      };
    }

    const computed = computeScheme(grossMinor, scheme);
    const effective = grossMinor > 0 ? (computed.authorIncomeMinor / grossMinor) * 100 : 0;
    return {
      schemeId: scheme.id,
      name: scheme.name,
      grossRevenue: fromMinor(computed.grossMinor),
      platformCut: fromMinor(computed.platformCutMinor),
      authorIncome: fromMinor(computed.authorIncomeMinor),
      effectiveAuthorPercent: round2(effective),
      assumed: scheme.assumed,
      ...(computed.warning ? { warning: computed.warning } : {}),
    };
  });

  // Best = highest author income among VALID (non-warning) schemes.
  let bestSchemeId: string | null = null;
  let bestIncome = -Infinity;
  for (const r of schemeResults) {
    if (r.warning) continue;
    if (r.authorIncome > bestIncome) {
      bestIncome = r.authorIncome;
      bestSchemeId = r.schemeId;
    }
  }

  const hasAssumptions = schemeResults.some((r) => r.assumed) || schemes.some((s) => s.assumed);

  return {
    grossRevenue: fromMinor(grossMinor),
    schemes: schemeResults,
    bestSchemeId,
    disclaimer: ROYALTY_DISCLAIMER,
    hasAssumptions,
  };
}

/** Rounds to 2 decimals (half-up on the 3rd digit) without float drift. */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
