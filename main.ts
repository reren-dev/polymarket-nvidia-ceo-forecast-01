import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level, to 6 decimals. */
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
/** Base default spread of a minute's price move, in price units per square-root minute. */
const DEFAULT_SIGMA = 0.0025;
const LOOKBACK = 120;
const SHRINKAGE_K = 40;
const SIGMA_MULT = 0.85;
const MAX_HIST_SIGMA = 0.005; // Cap historical sigma to prevent jump/spike distortion (fixes p02 regression)

interface CaseMarket {
  id: string;
  prices?: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

/** x clamped to [0,1] and rounded to 6 decimals (0, never -0). */
const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/** The optimized per-market volatility forecast of one market. */
function forecast(m: CaseMarket, horizon: number): number[][] {
  const prices = m.prices;
  if (!prices || prices.length === 0) {
    // Missing history guard: fall back to house-baseline fixed sigma and neutral price 0.5
    const x = 0.5;
    const rows: number[][] = [];
    for (let h = 1; h <= horizon; h++) {
      const sqrtH = Math.sqrt(h);
      rows.push(Z.map((z) => price6(x + z * DEFAULT_SIGMA * sqrtH)));
    }
    return rows;
  }

  const x = prices[prices.length - 1] as number;

  if (prices.length < 2) {
    // Too short history guard: fall back to house-baseline fixed sigma
    const rows: number[][] = [];
    for (let h = 1; h <= horizon; h++) {
      const sqrtH = Math.sqrt(h);
      rows.push(Z.map((z) => price6(x + z * DEFAULT_SIGMA * sqrtH)));
    }
    return rows;
  }

  // Estimate per-market realized volatility from recent 1-minute returns
  const window = prices.slice(-LOOKBACK);
  const returns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    returns.push(window[i]! - window[i-1]!);
  }

  let sigma = DEFAULT_SIGMA;
  const isFlat = returns.length === 0 || returns.every((r) => r === 0);
  if (returns.length > 5 && !isFlat) {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (returns.length - 1);
    let histSigma = Math.sqrt(Math.max(0, variance));
    if (histSigma === 0) {
      sigma = DEFAULT_SIGMA;
    } else {
      // Cap histSigma to prevent jump/spike distortion (such as in p02)
      histSigma = Math.min(histSigma, MAX_HIST_SIGMA);
      const n = returns.length;
      const weight = n / (n + SHRINKAGE_K);
      sigma = weight * histSigma + (1 - weight) * DEFAULT_SIGMA;
      sigma = Math.max(0.0001, Math.min(0.02, sigma)) * SIGMA_MULT;
    }
  } else {
    sigma = DEFAULT_SIGMA;
  }

  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    const sqrtH = Math.sqrt(h);
    rows.push(Z.map((z) => price6(x + z * sigma * sqrtH)));
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) {
    throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  }
  const forecasts = c.markets.map((m) => ({ id: m.id, q: forecast(m, c.horizon_minutes) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}
`);
}
