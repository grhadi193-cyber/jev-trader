import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config";

export interface RiskConfig {
  bankrollUsd: number;
  riskPct: number; // % of bankroll per trade
  riskUsd: number; // computed bankroll * riskPct/100, but user can set directly (syncs)
  leverage: number; // 1..10
  tradeSizeMon: number; // computed or fixed
  maxPositionMon: number;
  quoteInsideTicks: number;
  usePct: boolean; // true = pct mode, false = fixed MON mode
  // --- EXIT STRATEGY ---
  stopLossPct: number; // e.g., 3 = exit if position -3% from entry
  takeProfitPct: number; // e.g., 6 = exit if +6% from entry (RR 2)
  trailingPct: number; // 0 = off, else trailing retracement % (e.g., 1.5)
  timeStopBlocks: number; // 0 = off, else max blocks to hold (e.g., 300 = 90s)
  updatedAt?: number;
}

const FILE = "data/risk.json";

function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }

function compute(cfg: Partial<RiskConfig>, mid = 0.0289): RiskConfig {
  const bankrollUsd = cfg.bankrollUsd ?? config.bankrollUsd;
  let riskPct = cfg.riskPct ?? 10;
  let leverage = cfg.leverage ?? 1;
  let usePct = cfg.usePct ?? true;
  let quoteInsideTicks = cfg.quoteInsideTicks ?? config.quoteInsideTicks;
  riskPct = clamp(Number(riskPct), 0.5, 50);
  leverage = clamp(Number(leverage), 1, 10);
  quoteInsideTicks = clamp(Math.round(Number(quoteInsideTicks)), 0, 3);
  const riskUsd = cfg.riskUsd != null ? clamp(Number(cfg.riskUsd), 1, bankrollUsd) : Math.round(bankrollUsd * riskPct / 100 * 100) / 100;
  // if riskUsd was given, back-sync pct
  if (cfg.riskUsd != null) riskPct = Math.round((riskUsd / bankrollUsd * 100) * 10) / 10;
  const effectiveRiskUsd = bankrollUsd * riskPct / 100;
  const tradeSizeMon = usePct ? clamp(Math.round((effectiveRiskUsd / mid) * leverage), 200, 10000) : clamp(Math.round(Number(cfg.tradeSizeMon ?? config.tradeSizeMon)), 200, 10000);
  const maxPositionMon = usePct ? clamp(Math.round(tradeSizeMon * 5), tradeSizeMon, 20000) : clamp(Math.round(Number(cfg.maxPositionMon ?? config.maxPositionMon)), tradeSizeMon, 20000);
  const stopLossPct = clamp(Number(cfg.stopLossPct ?? 3), 0.5, 10);
  const takeProfitPct = clamp(Number(cfg.takeProfitPct ?? 6), 1, 30);
  const trailingPct = clamp(Number(cfg.trailingPct ?? 1.5), 0, 5);
  const timeStopBlocks = clamp(Math.round(Number(cfg.timeStopBlocks ?? 300)), 0, 2000);
  return { bankrollUsd: Math.round(bankrollUsd), riskPct, riskUsd: Math.round(effectiveRiskUsd * 100) / 100, leverage, tradeSizeMon, maxPositionMon, quoteInsideTicks, usePct, stopLossPct, takeProfitPct, trailingPct, timeStopBlocks, updatedAt: Date.now() };
}

let current: RiskConfig | null = null;

export function loadRisk(): RiskConfig {
  if (current) return current;
  try {
    if (existsSync(FILE)) {
      const raw = JSON.parse(readFileSync(FILE, "utf-8"));
      current = compute(raw);
      // sync to config for legacy reads
      syncConfig(current);
      return current;
    }
  } catch {}
  current = compute({
    bankrollUsd: config.bankrollUsd,
    riskPct: 10,
    leverage: 2,
    tradeSizeMon: config.tradeSizeMon,
    maxPositionMon: config.maxPositionMon,
    quoteInsideTicks: config.quoteInsideTicks,
    usePct: true,
    stopLossPct: 3,
    takeProfitPct: 6,
    trailingPct: 1.5,
    timeStopBlocks: 300,
  });
  syncConfig(current);
  return current;
}

function syncConfig(r: RiskConfig) {
  // mutate config object so old code reading config.* sees updated values
  (config as any).bankrollUsd = r.bankrollUsd;
  (config as any).tradeSizeMon = r.tradeSizeMon;
  (config as any).maxPositionMon = r.maxPositionMon;
  (config as any).quoteInsideTicks = r.quoteInsideTicks;
}

export function getRisk(): RiskConfig {
  return loadRisk();
}

export function getTradeSize(mid: number): number {
  const r = getRisk();
  if (!r.usePct) return r.tradeSizeMon;
  const riskUsd = r.bankrollUsd * r.riskPct / 100;
  return Math.max(200, Math.round((riskUsd / mid) * r.leverage));
}

export function getMaxPosition(): number {
  return getRisk().maxPositionMon;
}

export function getQuoteInsideTicks(): number {
  return getRisk().quoteInsideTicks;
}

export function saveRisk(patch: Partial<RiskConfig>, mid = 0.0289): RiskConfig {
  const base = getRisk();
  // if patch sets riskPct without riskUsd, don't carry over old riskUsd — let pct win
  const mergedRaw: any = { ...base, ...patch };
  if (patch.riskPct != null && patch.riskUsd == null) delete mergedRaw.riskUsd;
  if (patch.riskUsd != null && patch.riskPct == null) delete mergedRaw.riskPct; // let usd win
  const merged = compute(mergedRaw, mid);
  current = merged;
  syncConfig(merged);
  try { mkdirSync("data", { recursive: true }); writeFileSync(FILE, JSON.stringify(merged, null, 2)); } catch {}
  console.log(`risk: saved ${merged.riskPct}% * ${merged.leverage}x = ${merged.tradeSizeMon} MON/trade, max ${merged.maxPositionMon}, bankroll $${merged.bankrollUsd}, ticks ${merged.quoteInsideTicks} SL ${merged.stopLossPct}% TP ${merged.takeProfitPct}% trail ${merged.trailingPct}% time ${merged.timeStopBlocks} (${merged.usePct ? "pct" : "fixed"} mode)`);
  return merged;
}
