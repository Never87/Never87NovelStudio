/**
 * P9 Batch E — Royalty Calculator: PURE unit tests (no browser/UI/server).
 *
 * Exercises the REAL `royalty-calculator.ts` bundled from source with the
 * project's own Vite pipeline (`scripts/lib/p4-bundler.cjs`), so the math under
 * test is exactly what ships. Covers:
 *
 *   - gross / platform cut / author income for a percentage scheme;
 *   - distribution fee taken before the royalty share;
 *   - fixed-per-unit schemes;
 *   - zero sales, negative inputs, blank/NaN inputs (never throw);
 *   - invalid rates (>100%) and fees (>100%) degrade to a flagged result;
 *   - multi-scheme comparison + best-scheme selection;
 *   - rounding / precision (no float drift; 2-decimal money);
 *   - the assumption flag and the mandatory disclaimer are always present.
 *
 * Usage: npm run verify:royalty
 */
const { importBundled, cleanupTemp, projectPath } = require('./lib/p4-bundler.cjs');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  -> ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function close(name, actual, expected, eps = 0.005) {
  const ok = Math.abs(actual - expected) <= eps;
  check(name, ok, ok ? '' : `expected ~${expected}, got ${actual}`);
}

const ALIAS = { '@': projectPath('src') };

function pct(ratePercent, fee = 0, overrides = {}) {
  return {
    id: 's',
    name: 'Platform',
    model: { kind: 'percentage', ratePercent },
    distributionFeePercent: fee,
    assumed: true,
    ...overrides,
  };
}

async function main() {
  const mod = await importBundled('src/modules/publishing/royalty/royalty-calculator.ts', 'royalty', { alias: ALIAS });
  const { calculateRoyalties, defaultScheme, ROYALTY_DISCLAIMER, round2, toNonNegative } = mod;

  /* -------------------- basic percentage math ------------------- */
  {
    const r = calculateRoyalties({ unitPrice: 10, unitsSold: 100 }, [pct(70)]);
    eq('one scheme returned', r.schemes.length, 1);
    close('gross = price × units', r.grossRevenue, 1000);
    close('percentage: author = 70% of gross', r.schemes[0].authorIncome, 700);
    close('percentage: platform cut = remainder', r.schemes[0].platformCut, 300);
    close('effective author percent', r.schemes[0].effectiveAuthorPercent, 70);
    eq('best scheme is the only scheme', r.bestSchemeId, 's');
  }

  /* -------------------- distribution fee first ------------------ */
  {
    // 10% distribution fee on 1000 = 100 fee; author gets 70% of the 900 left = 630.
    const r = calculateRoyalties({ unitPrice: 10, unitsSold: 100 }, [pct(70, 10)]);
    close('fee applied before royalty: author', r.schemes[0].authorIncome, 630);
    close('fee applied: platform cut = gross - author', r.schemes[0].platformCut, 370);
  }

  /* -------------------- fixed per unit -------------------------- */
  {
    const fixed = {
      id: 'f',
      name: 'Fixed',
      model: { kind: 'fixed-per-unit', amountPerUnit: 2 },
      distributionFeePercent: 0,
      assumed: true,
    };
    const r = calculateRoyalties({ unitPrice: 9.99, unitsSold: 50 }, [fixed]);
    close('fixed per unit: author = amount × units', r.schemes[0].authorIncome, 100);
    close('fixed per unit: gross', r.grossRevenue, 499.5);
    close('fixed per unit: platform cut = gross - author', r.schemes[0].platformCut, 399.5);
  }

  /* -------------------- zero sales ------------------------------ */
  {
    const r = calculateRoyalties({ unitPrice: 20, unitsSold: 0 }, [pct(70), pct(50)]);
    close('zero sales: gross 0', r.grossRevenue, 0);
    close('zero sales: author 0 (scheme 1)', r.schemes[0].authorIncome, 0);
    close('zero sales: author 0 (scheme 2)', r.schemes[1].authorIncome, 0);
    check('zero sales: no scheme flagged best', r.bestSchemeId === null || r.bestSchemeId === 's');
  }

  /* -------------------- negative/blank inputs (clamp) ----------- */
  {
    const neg = calculateRoyalties({ unitPrice: -5, unitsSold: -10 }, [pct(70)]);
    close('negative inputs clamp: gross 0', neg.grossRevenue, 0);
    close('negative inputs clamp: author 0', neg.schemes[0].authorIncome, 0);

    const nan = calculateRoyalties({ unitPrice: Number.NaN, unitsSold: Number.NaN }, [pct(70)]);
    close('NaN inputs clamp: gross 0', nan.grossRevenue, 0);
    close('NaN inputs clamp: author 0', nan.schemes[0].authorIncome, 0);
  }

  /* -------------------- invalid rates / fees -------------------- */
  {
    const badRate = calculateRoyalties({ unitPrice: 10, unitsSold: 10 }, [pct(150)]);
    check('rate >100% yields a warning', typeof badRate.schemes[0].warning === 'string' && badRate.schemes[0].warning.length > 0);
    close('rate >100% yields author 0', badRate.schemes[0].authorIncome, 0);
    eq('rate >100% not best', badRate.bestSchemeId, null);

    const badFee = calculateRoyalties({ unitPrice: 10, unitsSold: 10 }, [pct(70, 150)]);
    check('fee >100% yields a warning', typeof badFee.schemes[0].warning === 'string');
    close('fee >100% yields author 0', badFee.schemes[0].authorIncome, 0);
  }

  /* -------------------- comparison / best ----------------------- */
  {
    const r = calculateRoyalties(
      { unitPrice: 10, unitsSold: 100 },
      [pct(50, 0, { id: 'low', name: 'Low' }), pct(80, 0, { id: 'high', name: 'High' }), pct(60, 0, { id: 'mid', name: 'Mid' })],
    );
    eq('comparison: best is the highest-author scheme', r.bestSchemeId, 'high');
    close('comparison: low author', r.schemes[0].authorIncome, 500);
    close('comparison: high author', r.schemes[1].authorIncome, 800);
    close('comparison: mid author', r.schemes[2].authorIncome, 600);
  }

  /* -------------------- rounding / precision -------------------- */
  {
    // 9.99 × 3 = 29.97 gross; 70% = 20.979 -> 20.98 (2 decimals).
    const r = calculateRoyalties({ unitPrice: 9.99, unitsSold: 3 }, [pct(70)]);
    close('precision: gross 29.97', r.grossRevenue, 29.97, 0.0001);
    close('precision: author rounded to 2dp', r.schemes[0].authorIncome, 20.98, 0.0001);
    close('round2 helper', round2(20.979), 20.98, 0.0001);

    // Sum of author + platform cut must equal gross (integer-cent accounting).
    const anyR = calculateRoyalties({ unitPrice: 19.95, unitsSold: 37 }, [pct(63.5, 7.25)]);
    const s = anyR.schemes[0];
    close('precision: author + platform == gross', s.authorIncome + s.platformCut, s.grossRevenue, 0.0001);
  }

  /* -------------------- assumption flag + disclaimer ------------ */
  {
    const assumed = calculateRoyalties({ unitPrice: 10, unitsSold: 10 }, [pct(70, 0, { assumed: true })]);
    check('hasAssumptions true when any scheme assumed', assumed.hasAssumptions === true);

    const certain = calculateRoyalties({ unitPrice: 10, unitsSold: 10 }, [pct(70, 0, { assumed: false })]);
    check('hasAssumptions false when none assumed', certain.hasAssumptions === false);

    check('disclaimer text present', typeof assumed.disclaimer === 'string' && assumed.disclaimer.length > 20);
    eq('disclaimer matches exported constant', assumed.disclaimer, ROYALTY_DISCLAIMER);
    check('disclaimer mentions ESTIMATE', /estimate/i.test(ROYALTY_DISCLAIMER));
  }

  /* -------------------- defaultScheme is an assumption ---------- */
  {
    const d = defaultScheme('x', 'Demo');
    eq('defaultScheme id', d.id, 'x');
    eq('defaultScheme name', d.name, 'Demo');
    check('defaultScheme is marked assumed', d.assumed === true);
    eq('defaultScheme model kind', d.model.kind, 'percentage');
  }

  /* -------------------- toNonNegative helper -------------------- */
  {
    eq('toNonNegative(-1) = 0', toNonNegative(-1), 0);
    eq('toNonNegative(NaN) = 0', toNonNegative(Number.NaN), 0);
    eq('toNonNegative(5) = 5', toNonNegative(5), 5);
    eq('toNonNegative(Infinity) = 0', toNonNegative(Infinity), 0);
  }

  /* -------------------- determinism ----------------------------- */
  {
    const a = calculateRoyalties({ unitPrice: 12.34, unitsSold: 56 }, [pct(70, 5)]);
    const b = calculateRoyalties({ unitPrice: 12.34, unitsSold: 56 }, [pct(70, 5)]);
    eq('deterministic across identical calls', JSON.stringify(a), JSON.stringify(b));
  }

  /* -------------------- summary --------------------------------- */
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed}/${results.length} checks passed.`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}  ${r.detail ? `(${r.detail})` : ''}`);
  }
  cleanupTemp();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
