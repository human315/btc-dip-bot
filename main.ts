// Dip-and-recover BTC bot for make.fun btc-race-24h-20261117-0603.
//
// Strategy, picked from the dev window (1,440 one-minute CBBTC bars):
// the window is range-bound with a slight upward drift (+0.49%) and a
// round trip costs ~26 bps in fees, slippage and impact, so every
// fast trend-following variant I tested lost money there (EMA crosses
// -$10 to -$106, breakouts -$12 to -$19), while buying deep dips and
// selling the recovery made money in 24 of 24 nearby parameter sets.
// So this bot only buys dips and sells recoveries:
//
// - Entry (flat only): the close is at least 60 bps below its 60-bar
//   EMA, while the close is no more than 150 bps below its 240-bar
//   EMA (a downtrend guard: never buy a dip in a falling market).
// - Exit (holding): take profit at +100 bps vs the fill, stop loss at
//   -100 bps, sell the recovery once the close is back at or above
//   the 60-bar EMA with at least +50 bps of gain, or a 150 bps
//   trailing stop from the peak since entry.
// - Cooldown: 30 bars after an exit before the next entry, so one
//   choppy stretch cannot churn the account.
// - Insurance: if no order has filled by bar 1380, buy 25% of cash,
//   so the entry always meets the "at least 1 trade" guardrail.
//
// The bot speaks agent-fun/bars-replay/v1 through the kit's shim: one
// hello, then one batch per bar, and exactly one reply with its orders
// per batch. All arithmetic is integer (bigint) so the two graded runs
// match byte for byte: no clock, no environment, no randomness.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Strategy knobs (basis points unless noted).
const DIP_BPS = 60n; // buy when close is this far below the fast EMA
const FAST_PERIOD = 60; // fast EMA length, in bars
const SLOW_PERIOD = 240; // slow EMA length, in bars
const DOWN_GUARD_BPS = -150n; // skip the dip when close is this far below the slow EMA
const TAKE_BPS = 100n; // take profit vs the entry fill
const STOP_BPS = -100n; // stop loss vs the entry fill
const RECOVER_MIN_GAIN_BPS = 50n; // recovery exit needs at least this much gain
const TRAIL_BPS = 150n; // trailing stop from the peak since entry
const COOLDOWN_BARS = 30; // bars to wait after an exit before re-entering
const FORCE_BAR = 1380; // insurance buy when nothing has filled by here
const MAX_SLIPPAGE_BPS = 200; // bound on the move from the latest close

/** (a - b) / b in basis points, integer-truncated, deterministic. */
function bpsDiff(a: bigint, b: bigint): bigint {
  if (b === 0n) return 0n;
  return ((a - b) * 10000n) / b;
}

/** Integer EMA: seeded on the first price, updated with k = 2 / (n + 1). */
class Ema {
  private value: bigint | null = null;
  private readonly period: number;
  constructor(period: number) {
    this.period = period;
  }
  update(price: bigint): bigint {
    if (this.value === null) {
      this.value = price;
      return price;
    }
    const step = ((price - this.value) * 2n) / BigInt(this.period + 1);
    this.value = this.value + step;
    return this.value;
  }
  get current(): bigint | null {
    return this.value;
  }
}

const fastEma = new Ema(FAST_PERIOD);
const slowEma = new Ema(SLOW_PERIOD);

// Position bookkeeping, kept from the fills each batch reports.
let entryPrice = 0n; // fill price of the open position (0 when flat)
let entryPeak = 0n; // highest close (or fill) since entry
let lastExitSeq = -1000000; // seq of the last filled sell
let filledTrades = 0; // filled buys plus filled sells
let awaitingFill = false; // an order was decided last batch, fill not seen yet

function sellAll(state: BarsState): OrderInput[] {
  const held = state.positions.get(SYMBOL);
  if (held === undefined || held.qty === 0n) return [];
  awaitingFill = true;
  return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Fold in the fills of the orders decided on the previous batch.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL) continue;
      if (fill.status === 'filled') {
        filledTrades += 1;
        awaitingFill = false;
        if (fill.side === 'buy') {
          entryPrice = BigInt(fill.price);
          entryPeak = entryPrice;
        } else {
          entryPrice = 0n;
          entryPeak = 0n;
          lastExitSeq = state.seq;
        }
      } else if (fill.status === 'rejected') {
        awaitingFill = false;
      }
    }

    // Warm-up batches carry history only: no trading on them.
    if (state.warmingUp) return [];

    const close = state.close(SYMBOL);
    if (close === null) return [];
    const fast = fastEma.update(close);
    const slow = slowEma.update(close);

    const held = state.positions.get(SYMBOL);
    const holding = held !== undefined && held.qty > 0n;

    if (holding) {
      if (close > entryPeak) entryPeak = close;
      const gain = bpsDiff(close, entryPrice);
      const drawdownFromPeak = bpsDiff(entryPeak, close);
      if (gain >= TAKE_BPS) return sellAll(state);
      if (gain <= STOP_BPS) return sellAll(state);
      if (close >= fast && gain >= RECOVER_MIN_GAIN_BPS) return sellAll(state);
      if (drawdownFromPeak >= TRAIL_BPS) return sellAll(state);
      return [];
    }

    // Flat: do not stack a second order on one still awaiting its fill.
    if (awaitingFill) return [];

    // Insurance trade: guarantee at least one filled order, hence the
    // guardrail, even on a window with no dip at all.
    if (state.seq >= FORCE_BAR && filledTrades === 0 && state.cash > 0n) {
      awaitingFill = true;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash / 4n, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    if (state.seq - lastExitSeq < COOLDOWN_BARS) return [];
    if (state.seq < SLOW_PERIOD) return [];

    const dip = bpsDiff(fast, close);
    const vsSlow = bpsDiff(close, slow);
    if (dip >= DIP_BPS && vsSlow >= DOWN_GUARD_BPS && state.cash > 0n) {
      awaitingFill = true;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
