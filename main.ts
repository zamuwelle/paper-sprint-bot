import { LAMPORTS_PER_SOL, runBot } from './vendor/makefun-bot.ts';

const PROBE = LAMPORTS_PER_SOL * 13n / 1_000n;
const MIN_SIGNAL_VOLUME = LAMPORTS_PER_SOL;
const stats = new Map<string, { creator: string; firstPrice: number; price: number; peak: number; buys: bigint; sells: bigint; buyers: Set<string>; trades: number; creatorDump: boolean; firstSlot: number }>();
const attempted = new Set<string>();
let entryCount = 0;

function curvePrice(quote: string, tokens: string): number {
  return Number(BigInt(quote)) / Number(BigInt(tokens));
}

await runBot({
  onBatch(state, batch) {
    const orders = [];
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        stats.set(event.mint, { creator: event.creator, firstPrice: curvePrice(event.virtual_sol_reserves, event.virtual_token_reserves), price: 0, peak: 0, buys: 0n, sells: 0n, buyers: new Set(), trades: 0, creatorDump: false, firstSlot: event.slot });
        continue;
      }
      if (event.event !== 'TradeEvent') continue;
      const current = stats.get(event.mint);
      if (!current) continue;
      current.price = curvePrice(event.virtual_sol_reserves, event.virtual_token_reserves);
      current.peak = Math.max(current.peak, current.price);
      current.trades++;
      if (event.is_buy) {
        current.buys += BigInt(event.sol_amount);
        if (event.user !== current.creator) current.buyers.add(event.user);
      } else {
        current.sells += BigInt(event.sol_amount);
        if (event.user === current.creator) current.creatorDump = true;
      }
    }

    for (const [mint, holding] of state.positions) {
      const current = stats.get(mint);
      const curve = state.curves.get(mint);
      if (!current || !curve || curve.complete || state.pending.size > 0 && [...state.pending.values()].some((p) => p.order.side === 'sell' && p.order.mint === mint)) continue;
      const drawdown = current.peak > 0 ? current.price / current.peak : 1;
      const priceVsEntry = current.price / (Number(holding.cost_lamports) / Number(holding.token_amount));
      const flowReversed = current.sells > current.buys * 3n / 4n;
      if (current.creatorDump || drawdown < 0.76 || priceVsEntry < 0.80 || (flowReversed && drawdown < 0.94)) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 10_000 });
      }
    }

    const slots = state.hello.caps.max_open_positions - state.committedPositionCount();
    let free = state.freeCashLamports();
    const fee = state.txFeeLamports();
    let bought = 0;
    for (const [mint, current] of stats) {
      if (bought >= slots || entryCount >= 40 || orders.length >= state.hello.caps.max_orders_per_batch) break;
      const curve = state.curves.get(mint);
      if (attempted.has(mint) || !curve || curve.complete || current.creatorDump || current.trades < 10 || current.trades > 24 || batch.slot - current.firstSlot > 180) continue;
      const momentum = current.price / current.firstPrice;
      const netFlow = current.buys - current.sells;
      if (current.buyers.size < 10 || netFlow < MIN_SIGNAL_VOLUME || momentum < 3.00 || momentum > 5.00) continue;
      const cap = state.maxBuyLamports(mint);
      const amount = cap < PROBE ? cap : PROBE;
      if (amount < LAMPORTS_PER_SOL / 100n || free < amount + fee) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: 3_500 });
      attempted.add(mint);
      entryCount++;
      bought++;
      free -= amount + fee;
    }
    return orders;
  },
});
