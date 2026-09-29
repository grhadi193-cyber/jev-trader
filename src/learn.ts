import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getRisk, saveRisk } from "./risk";

export interface TradeLearn {
  block: number;
  ts: number;
  side: "long" | "short";
  entry: number;
  exit: number;
  size: number;
  pnlUsd: number;
  pnlPct: number; // from entry
  exitReason: string; // SL/TP/TRAIL/TIME/MANUAL
  holdBlocks: number;
  win: boolean;
  // why
  why: string; // e.g., "SL too tight — hit in 12 blocks, mid never recovered"
  lesson: string; // e.g., "Increase SL 3%→3.2%"
  applied: string; // what was changed
  before: { sl: number; tp: number; trail: number; risk: number };
  after: { sl: number; tp: number; trail: number; risk: number };
}

export interface LearnState {
  trades: TradeLearn[];
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinUsd: number;
  avgLossUsd: number;
  profitFactor: number;
  expectancyUsd: number;
  bestStreak: number;
  worstStreak: number;
  curStreak: number; // + for win streak, - for loss
  evolution: { block: number; sl: number; tp: number; trail: number; risk: number; winRate: number }[];
  brain: string; // current lesson
  updatedAt: number;
}

const FILE = "data/learning.json";
const MAX_TRADES = 500;

let state: LearnState = load();

function load(): LearnState {
  try { if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf-8")); } catch {}
  return {
    trades: [], total: 0, wins: 0, losses: 0, winRate: 0, avgWinUsd: 0, avgLossUsd: 0, profitFactor: 0, expectancyUsd: 0,
    bestStreak: 0, worstStreak: 0, curStreak: 0, evolution: [], brain: "🧠 منتظر اولین معامله — مغز خدا بیدار میشه بعد 3 ترید...", updatedAt: Date.now()
  };
}
function save() {
  try { mkdirSync("data", { recursive: true }); writeFileSync(FILE, JSON.stringify(state, null, 2)); } catch {}
}

export function getLearn(): LearnState { return state; }

// called by trader after a closing fill (position flat after)
export function recordTrade(opts: {
  block: number; side: "long" | "short"; entry: number; exit: number; size: number; pnlUsd: number; holdBlocks: number; exitReason: string;
}) {
  const pnlPct = opts.side === "long" ? (opts.exit - opts.entry) / opts.entry * 100 : (opts.entry - opts.exit) / opts.entry * 100;
  const win = opts.pnlUsd > 0;
  const r = getRisk();
  const before = { sl: r.stopLossPct, tp: r.takeProfitPct, trail: r.trailingPct, risk: r.riskPct };

  // --- analyze why ---
  let why = "";
  let lesson = "";
  let applied = "—";
  const holdSec = opts.holdBlocks * 0.3;

  if (opts.exitReason.includes("SL")) {
    if (opts.holdBlocks < 30) why = `SL خیلی تنگ — فقط ${opts.holdBlocks} بلاک (${holdSec.toFixed(0)}s) دوام آورد، قیمت سریع برگشت ولی استاپ خورد`;
    else why = `SL منطقی — ${opts.holdBlocks} بلاک hold، ولی جهت اشتباه بود`;
  } else if (opts.exitReason.includes("TP")) {
    why = `TP عالی — ${pnlPct.toFixed(2)}% سود در ${holdSec.toFixed(0)}s، استراتژی درست حدس زد`;
  } else if (opts.exitReason.includes("TRAIL")) {
    why = `Trailing سود رو قفل کرد — از قله برگشت ولی ${pnlPct.toFixed(2)}% حفظ شد`;
  } else if (opts.exitReason.includes("TIME")) {
    why = win ? `Time stop با سود کم — ${holdSec.toFixed(0)}s نگه داشت ولی حرکت نکرد` : `Time stop — بازار مرده بود، ${holdSec.toFixed(0)}s بی‌جهت hold`;
  } else {
    why = win ? `سود دستی — سیگنال مخالف بست` : `ضرر — سیگنال اشتباه`;
  }

  // --- auto-tune strategy (عجیب و خداگونه) ---
  let newSL = before.sl, newTP = before.tp, newTrail = before.trail, newRisk = before.risk;
  const recent = state.trades.slice(-10);
  const recentLosses = recent.filter(t => !t.win).length;
  const recentWins = recent.filter(t => t.win).length;

  if (!win && opts.exitReason.includes("SL") && opts.holdBlocks < 30) {
    newSL = Math.min(10, +(before.sl + 0.2).toFixed(1));
    lesson = `SL تنگ بود → SL ${before.sl}% → ${newSL}% (فضای بیشتر)`;
    applied = `SL ${newSL}%`;
  } else if (win && opts.exitReason.includes("TP") && pnlPct > before.tp * 0.9) {
    newTP = Math.min(30, +(before.tp + 0.3).toFixed(1));
    lesson = `TP زود خورد و باز هم میرفت → TP ${before.tp}% → ${newTP}%`;
    applied = `TP ${newTP}%`;
  } else if (!win && recentLosses >= 3) {
    newRisk = Math.max(1, +(before.risk - 1).toFixed(1));
    lesson = `${recentLosses} باخت پشت سرهم → ریسک ${before.risk}% → ${newRisk}% (محافظه‌کار)`;
    applied = `Risk ${newRisk}%`;
  } else if (win && recentWins >= 3) {
    newRisk = Math.min(50, +(before.risk + 0.5).toFixed(1));
    lesson = `${recentWins} برد پشت سرهم → ریسک ${before.risk}% → ${newRisk}% (تهاجمی‌تر)`;
    applied = `Risk ${newRisk}%`;
  } else if (opts.exitReason.includes("TIME") && !win) {
    newTP = Math.max(1, +(before.tp - 0.2).toFixed(1));
    lesson = `Time stop زیاد → TP ${before.tp}% → ${newTP}% (زودتر بگیر)`;
    applied = `TP ${newTP}%`;
  } else if (opts.exitReason.includes("TRAIL") && win && pnlPct < before.tp * 0.6) {
    newTrail = Math.max(0, +(before.trail - 0.2).toFixed(1));
    lesson = `Trailing زود بست → Trail ${before.trail}% → ${newTrail}%`;
    applied = `Trail ${newTrail}%`;
  } else {
    lesson = win ? `برد تثبیت شد — پارامترها عالیه، دست نمیزنم` : `باخت تحلیل شد — فعلا صبر، بعد 3 باخت ریسک کم میشه`;
  }

  // apply if changed (with mid from opts.exit)
  if (newSL !== before.sl || newTP !== before.tp || newTrail !== before.trail || newRisk !== before.risk) {
    saveRisk({ stopLossPct: newSL, takeProfitPct: newTP, trailingPct: newTrail, riskPct: newRisk }, opts.exit);
  }

  const after = { sl: newSL, tp: newTP, trail: newTrail, risk: newRisk };

  const t: TradeLearn = {
    block: opts.block, ts: Date.now(), side: opts.side, entry: opts.entry, exit: opts.exit, size: opts.size,
    pnlUsd: +opts.pnlUsd.toFixed(4), pnlPct: +pnlPct.toFixed(2), exitReason: opts.exitReason, holdBlocks: opts.holdBlocks,
    win, why, lesson, applied, before, after
  };
  state.trades.push(t);
  if (state.trades.length > MAX_TRADES) state.trades.shift();
  // recompute stats
  state.total = state.trades.length;
  state.wins = state.trades.filter(x => x.win).length;
  state.losses = state.total - state.wins;
  state.winRate = state.total ? +(state.wins / state.total * 100).toFixed(1) : 0;
  const wins = state.trades.filter(x => x.win);
  const losses = state.trades.filter(x => !x.win);
  state.avgWinUsd = wins.length ? +(wins.reduce((a, b) => a + b.pnlUsd, 0) / wins.length).toFixed(4) : 0;
  state.avgLossUsd = losses.length ? +(losses.reduce((a, b) => a + b.pnlUsd, 0) / losses.length).toFixed(4) : 0;
  const grossWin = wins.reduce((a, b) => a + b.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b.pnlUsd, 0)) || 1;
  state.profitFactor = +(grossWin / grossLoss).toFixed(2);
  state.expectancyUsd = state.total ? +((grossWin + losses.reduce((a, b) => a + b.pnlUsd, 0)) / state.total).toFixed(4) : 0;
  // streaks
  let cur = 0, best = 0, worst = 0, curStreak = 0;
  for (const tr of state.trades) {
    if (tr.win) { cur = cur > 0 ? cur + 1 : 1; curStreak = cur; }
    else { cur = cur < 0 ? cur - 1 : -1; curStreak = cur; }
    if (cur > best) best = cur;
    if (cur < worst) worst = cur;
  }
  state.bestStreak = best; state.worstStreak = worst; state.curStreak = curStreak;
  state.evolution.push({ block: opts.block, sl: after.sl, tp: after.tp, trail: after.trail, risk: after.risk, winRate: state.winRate });
  if (state.evolution.length > 200) state.evolution.shift();
  state.brain = `🧠 ترید #${state.total} ${win ? "✅ برد" : "❌ باخت"} ${pnlPct.toFixed(1)}% via ${opts.exitReason} → ${lesson} | WinRate ${state.winRate}% PF ${state.profitFactor}`;
  state.updatedAt = Date.now();
  save();
  console.log(`learn #${state.total} ${win ? "WIN" : "LOSS"} ${pnlPct.toFixed(2)}% ${opts.exitReason} → ${lesson} | WR ${state.winRate}% PF ${state.profitFactor} | SL ${after.sl} TP ${after.tp}`);
  return t;
}
