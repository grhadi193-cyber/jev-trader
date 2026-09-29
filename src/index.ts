import { config } from "./config";
import { startBlockFeed } from "./chain";
import { Market } from "./market";
import { createModel } from "./model";
import { Trader } from "./trader";
import { log10 } from "./book";
import { startServer } from "./server";

// DEMO DEPLOY GUARD: never allow real transactions in this demo branch.
// If PRIVATE_KEY is set, refuse to start — demo is dry-run only (beatapi.io free Jev or mock).
if (process.env.PRIVATE_KEY && process.env.PRIVATE_KEY.trim() !== "") {
  console.error(
    "DEMO GUARD: PRIVATE_KEY is set — refusing to start in demo/dry-run mode. " +
      "This deployment is dry-run only (beatapi.io jev-1.13-free or mock, simulated fills). Unset PRIVATE_KEY and retry.",
  );
  process.exit(1);
}
if (config.model === "jev" && !config.jevApiKey) {
  console.warn("DEMO GUARD: MODEL=jev but no TYPESAFE_AI_API_KEY/BEATAPI_API_KEY set — Jev will fail, will fallback to errors. Set key from https://jevapi.io for free jev-1.13-free.");
}

const market = new Market();
await market.init();
const model = createModel();

const server = startServer(
  { model: model.name, wallet: market.address, dryRun: config.dryRun, market: config.market, startedAt: Date.now() },
  () => trader.history,
);
const trader = new Trader(
  market,
  model,
  (e, t) => {
    server.broadcast(e);
    if (e.decision && !e.decision.late) {
      const p = e.decision.probabilities;
      const q = e.quote;
      const quote = !q ? " NO QUOTE (cap or funds on both sides)" : ` ${q.side.toUpperCase()} ${q.size} @ ${q.price.toFixed(6)}${q.capped ? " capped" : ""}${q.status === "sim" ? " (sim)" : ` cancel ${q.cancel.length} ${q.txHash}`}`;
      console.log(`#${e.block} ${e.mid.toFixed(6)} b${(p.buy * 100).toFixed(0)} s${(p.sell * 100).toFixed(0)} ${e.decision.latencyMs}ms${quote} pnl $${e.totals.pnlUsd}${t ? ` · read ${t.readMs}ms loop ${t.loopMs}ms` : ""}`);
    }
  },
  (block, fill) => {
    server.broadcastFill(block, fill);
    console.log(`#${block} FILL ${fill.side} ${fill.size} @ ${fill.price.toFixed(6)}${fill.simulated ? " (sim)" : ` order ${fill.orderId} ${fill.txHash}`}`);
  },
  (block, quote) => {
    server.broadcastQuote(block, quote);
    if (quote.status !== "placed") console.log(`#${block} ${quote.status.toUpperCase()} ${quote.side} @ ${quote.price.toFixed(6)} gas ${quote.gasMon.toFixed(6)} MON ${quote.txHash}`);
  },
);
trader.attachTradeFeed(log10(market.params.sizePrecision));

console.log(`jev-trader · model=${model.name} · post-only ${config.quoteInsideTicks} tick inside the touch · horizon ${config.horizonBlocks} blocks · ${config.dryRun ? "DRY RUN" : `wallet ${market.address}`} · market ${config.market} · read ${config.readRpcUrl} · :${config.port}`);
startBlockFeed((block) => trader.onBlock(block));
