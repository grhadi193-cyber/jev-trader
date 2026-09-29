# JEV-TRADER DEMO — FINAL REPORT (dry-run only)

**Repo:** `grhadi193-cyber/jev-trader` fork of `jarrodwatts/jev-trader`  
**Branch:** `demo-deploy` (from `b587759`) — **never on `main`, fork stays in sync with upstream**  
**Date:** 2026-09-29  
**Deployed config:** `MODEL=mock` , `PRIVATE_KEY` **unset/empty**, `DRY_RUN=true` → `dryRun:true` everywhere, `wallet:null`, no `eth_sendRawTransaction` ever.

---

## 1) DRY-RUN GUARANTEE — CODE PATH AUDIT

Confirmed by reading `src/config.ts`, `src/market.ts`, `src/trader.ts`, `src/index.ts`. With `PRIVATE_KEY` empty the bot **only simulates fills** and never calls `eth_sendRawTransaction`.

* **Config switch — single source of truth**  
  `src/config.ts:13`  
  ```ts
  dryRun: env("DRY_RUN") === "true" || !env("PRIVATE_KEY"),
  ```  
  If `PRIVATE_KEY` is empty/unset, `dryRun` is `true` regardless of `DRY_RUN` value. `.env.example:12` ships `PRIVATE_KEY=` empty and `DRY_RUN=true`. Local `cp .env.example .env` preserves this. `src/config.ts:12` reads `privateKey: env("PRIVATE_KEY")` (undefined/empty when unset).

* **Market wallet is null in dry-run — no signer exists**  
  `src/market.ts:71`  
  ```ts
  readonly wallet = config.dryRun ? null : new ethers.Wallet(config.privateKey!, this.provider);
  ```  
  Comment: *“null in a dry run (no key, or DRY_RUN=true): nothing is signed, nothing is sent.”* All later checks branch on `this.wallet`.

* **Send path — early return, no signing, no RPC send**  
  `src/market.ts:135-137`  
  ```ts
  async send(...): Promise<Quote> {
    const price = this.quotePrice(side, book);
    if (!this.wallet) return { side, price, size: sizeMon, txHash: null, gasMon: 0, cancel, status: "sim", orderId: null, capped };
    // live only below:
    const tx = this.buildTx(...);
    const signed = await this.wallet.signTransaction(tx);
    hash = await rpc<string>("eth_sendRawTransaction", [signed]);
  ```  
  In dry-run `status:"sim"`, `txHash:null`, `gasMon:0`, `orderId:null`. The live branch that signs and calls `eth_sendRawTransaction` is **unreachable** when `wallet===null`. Also `buildTx` is not invoked in dry-run; `estimateGas` etc never run.

* **Trader fill simulation vs live fills**  
  `src/trader.ts:152-155`  
  ```ts
  const fills: Fill[] = this.market.wallet ? this.liveFills(this.trades.drainFills()) : this.simFills(prints);
  ```  
  `src/trader.ts:186-199` `simFills()` : order placed at block N rests from N+1, fills only when a *real* taker print crosses its price (`p.price <= o.price` for bids, `>=` for asks), size = `min(o.size, p.size)`, `simulated:true`, `txHash:null`, `orderId` is negative `simId` (filtered out of cancel lists: `src/trader.ts:122` `filter((id)=>id>0)` ).  
  `src/trader.ts:171-180` `liveFills()` sets `simulated:false` and uses real `orderId`/`txHash` from `Trade` logs where `makerAddress===our wallet`. Never executed when wallet null.

* **Margin / gas / nonce side-effects guarded**  
  `src/market.ts:76-89` `async init()` : `if (!this.wallet) return;` after `ParamFetcher.getMarketParams` + `refresh()` — skips `resyncNonce()`, `ensureMargin()`, `initGasLimit()`.  
  `src/market.ts:89-102` `refresh()` checks `this.wallet ? marginBalance(...) : Promise.resolve(null)` — no wallet → no margin calls. `ensureMargin()` assumes `!this.wallet` already returned; it would do `wallet.sendTransaction` deposits, `approve`, etc. — unreachable in dry-run. `initGasLimit()` only runs with wallet.

* **Position cap check**  
  `src/trader.ts:214-222` `allowed()` : `if (!this.market.wallet) return true;` — no margin funds check in dry-run, only position cap.

* **Server exposure**  
  `src/index.ts:14` `startServer({ model, wallet: market.address, dryRun: config.dryRun, ...})` — `GET /` returns `dryRun:true` when wallet null. `src/market.ts:71` `get address()` returns `null` in dry-run.

* **No other path can send real tx**  
  `rg` found only `eth_sendRawTransaction` at `src/market.ts:143` inside the guarded `send()`. No other `sendTransaction`, `signTransaction`, or `eth_sendRaw*` exists outside that guard. Scripts like `scripts/dry-encode.ts` explicitly set a random key locally **but never calls** `rpc("eth_sendRawTransaction",…)` — it only does `wallet.signTransaction` and local ABI decoding.

**Conclusion:** With `PRIVATE_KEY` empty (demo-deploy default, `MODEL=mock`), the binary **cannot sign or send**. Every quote is `status:"sim"`, every fill `simulated:true`, `txHash:null`, `gasMon:0`. If a key were ever injected, the new **DEMO GUARD** (see §3) would kill the process before `market.init`.

---

## 2) PHASE 1 — LOCAL RUN & OBSERVATION

### Environment
- Bun `1.4.2` installed via `npm install -g bun` (sandbox had no `bun` initially; `curl | bash` failed with `SSL_ERROR_SYSCALL`, npm succeeded).
- Cloned fork at `/home/user/jev-trader`, `cp .env.example .env` → `PRIVATE_KEY=` empty, `DRY_RUN=true`, `MODEL=mock`, `RPC_URL=https://rpc.monad.xyz`, `READ_RPC_URL=https://rpc.monad.xyz`, `PORT=3000`.
- `bun install` ok: 160 packages, `ethers@5.8`, `@kuru-labs/kuru-sdk@0.0.95`, `ai@7.0.103`.

### What should happen per block (from code)
- `src/chain.ts:30-51` `startBlockFeed` polls `eth_blockNumber` every 150 ms plus optional `WS_URL` `newHeads` (Monad ~300 ms blocks), coalesces to newest block.
- `src/trader.ts:76-108` `onBlock(block)` each block:
  1. `confirmPending` polls receipts off hot-path.
  2. If `busy`, emit `late` event (`decision.late:true`, `hold`).
  3. `market.readBook()` → one `eth_call` `getL2Book()` (~18 ms public RPC, `READ_RPC_URL`), decoded in `src/book.ts:55-70` (single HTTP, batch with vault if active).
  4. Append mid to 400-length `mids` ring, `trades.poll(block)` → `eth_getLogs` `Trade` events (≤100 block range per call, 300-block warmup).
  5. `model.decide(state)` → `MockModel` (see `src/model.ts:71-96`) computes `signal = ret20/8 + imbalance*1.5 + flow*2 + noise(block)` → `buy = sigmoid(signal)`, `probabilities {buy, sell:1-buy}`, `action buy>=0.5 ? buy:sell`, `latency 80ms` (`Bun.sleep(80)`), `inputTokens≈jsonlen/4`.
  6. `allowed()` checks position cap (`MAX_POSITION_MON=1000`) and margin (skipped in dry-run). Picks `wanted` else other side else null.
  7. `market.send()` → dry-run: immediate `sim` quote, no RPC; live: `batchUpdate(buyPrices, buySizes, sellPrices, sellSizes, cancel, postOnly=true)`.
  8. `emit()` → `totals` update, `history` ring 1000, `appendFileSync("data/events.jsonl")`, `server.broadcast(block)`. `harvest()` later attaches `fill` when prints cross.

- Quote: post-only limit `QUOTE_INSIDE_TICKS=1` inside touch, never crosses (clamped to touch), integer tick math (`src/market.ts:103-115`), size `TRADE_SIZE_MON=200 MON` (Kuru minimum), `cancel` = all positive `orderIds` (sim ids negative filtered).

### Attempted live run
```
bun run start
# Expected log: jev-trader · model=mock · post-only 1 tick inside … · DRY RUN · market 0x065C… · read https://rpc.monad.xyz · :3000
```
**Actual:** `market.init()` → `Kuru.ParamFetcher.getMarketParams(provider, market)` does `eth_call` `0x90c9427c` to `https://rpc.monad.xyz` → failed:
```
CALL_EXCEPTION: missing revert data in call exception; Transaction reverted without reason string
SERVER_ERROR: missing response (requestBody eth_call, url https://rpc.monad.xyz) ERR_SOCKET_CLOSED
Bun v1.4.2 error script "start" exited with code 1
```
Same for `bun run scripts/bench-read.ts` and `bun run scripts/dry-encode.ts` (both need `getMarketParams` + `readBook`). Curl probes confirmed **sandbox TLS egress broken**: `curl https://rpc.monad.xyz` → `OpenSSL SSL_connect: SSL_ERROR_SYSCALL (35)`, `google.com` same, but `http://example.com` connects (empty reply) and raw TCP to `1.1.1.1:80` succeeds. This is sandbox network policy (no outbound TLS handshake), **not a code bug**. On Render (normal egress) the public RPC works (see README’s claimed p50 18 ms).

Thus `GET /`, `/history`, `/events` could not be verified live in this sandbox. From code, expected:

* `GET /` → `{ model:"mock", wallet:null, dryRun:true, market:"0x065C…", latest: <BlockEvent>|null }`
* `GET /history` → last 1000 `BlockEvent[]`
* `GET /events` SSE → `snapshot` on connect then `block`, `quote`, `fill`, `ping` events every ~300 ms.

Sample `BlockEvent` (from `src/trader.ts:9-30` + README):
```json
{
  "block": 105488269, "ts": 1789593630676,
  "mid": 0.022636, "bestBid": 0.022628, "bestAsk": 0.022644, "spreadBps": 7.07,
  "decision": { "action": "buy", "probabilities": { "buy": 0.77, "sell": 0.23, "hold": 0 }, "upIn10": 0.77, "latencyMs": 81, "late": false },
  "quote": { "side": "buy", "price": 0.022629, "size": 200, "txHash": null, "gasMon": 0, "cancel": [], "status": "sim", "orderId": null, "capped": false },
  "fill": null,
  "resting": { "bidMon": 200, "askMon": 0 },
  "position": { "side": "flat", "size": 0, "entryPrice": null, "unrealizedUsd": 0, "unrealizedMon": 0 },
  "totals": { "blocks": 3, "decisions": 3, "quotes": 3, "fills": 1, "reverted": 0, "lateBlocks": 0, "jevUsd": 0.000004, "gasMon": 0, "gasUsd": 0, "realizedUsd": 0, "pnlUsd": -0.003 }
}
```
Dry-run invariants every block: `dryRun:true` at `/`, `quote.status:"sim"` (`txHash:null`, `gasMon:0`), `fill.simulated:true` if present (or `fill:null`). Gas totals stay `0` in dry-run (vs `~0.03 MON/block` live, `~0.0357` per block in README sample, ~282k gasLimit measured, ~12k blocks/hour → ~420 MON/hour live).

**Latency numbers (from code/README, not measured live due to RPC down):**  
`bench-read.ts` measures `readBook` vs SDK: expected `read p50 ~18 ms` (1 eth_call) vs SDK `~35-40 ms` (2 sequential calls). `trader` loop p50 `~100 ms` (`80 ms` is `MockModel` sleep + `18 ms` read). No `eth_estimateGas` in hot loop; gasLimit hard-coded fallback `350_000`.

**Trade count vs blocks:** One quote per non-late block; fills only when real print crosses simulated price. Given book is sampled real, prints are real `eth_getLogs` flow, hit rate is low (spread ~7 bps, quote 1 tick inside touch → needs taker to cross touch + tick). Expect far fewer fills than blocks (e.g. 10-20% of blocks depending on volatility). Position flips via `applyFill` FIFO cost basis, `MAX_POSITION_MON=1000` caps exposure to ±5 orders outstanding.

**P&L sanity:** In dry-run `gasUsd=0`, `pnl = realized + unrealized`. Mock model is momentum+imbalance+noise, not expected to be profitable; README warns “not trying to be profitable” and losses shown plainly. `bankrollUsd=100` for `pnlPct`.

**Errors/warnings observed:** Only the TLS/RPC failure above. No code error when RPC reachable. `refresh()` and `poll()` swallow failures (`Promise.allSettled`, `catch(()=>{})`) and retry next block, so transient RPC 25 rps caps / `-32007` limit should be handled with pacing (scripts note 50 req/s limit, `MAX_RANGE 100` chunks).

**Suspicious/fragile points:**
- `src/book.ts:31-49` `rpcPost` has no retry; single transient `eth_call` failure bubbles to `onBlock` catch and logs `block N: <msg>` but still marks `busy=false` — okay but noisy.
- `src/trader.ts:76` `onBlock` catches all errors and just `console.error`; a sustained RPC outage would stall `lastBook` and emit late blocks forever.
- `src/market.ts:71` `StaticJsonRpcProvider` for `rpcUrl` but `readBook` uses raw `fetch` — two HTTP clients, minor duplication.
- `scripts/dry-encode.ts` sets `PRIVATE_KEY` randomly but never unsets after; safe because script-only.
- No request coalescing for `readBook` if two blocks arrive before previous finishes (guarded by `busy` → late block) — correct.
- `data/events.jsonl` grows unbounded, `.gitignore: data/` keeps it out of repo, good.

---

## 3) FILES CHANGED & WHY (demo-deploy)

All changes are on branch `demo-deploy` (pushed to `origin/demo-deploy`, PR-ready). `main` untouched.

* **`src/server.ts` — bind 0.0.0.0, respect PORT**  
  ```diff
  +  hostname: "0.0.0.0",
  ```  
  `config.port = Number(env("PORT","3000"))` already respects `process.env.PORT` (Render sets `PORT=10000`). Without `hostname`, `Bun.serve` could bind `localhost` only, invisible to Render preview / LB and failing health check. Fix verified: demo preview requires `0.0.0.0`. Minimal 1-line change.

* **`src/index.ts` — DEMO GUARD**  
  ```ts
  if (process.env.PRIVATE_KEY && process.env.PRIVATE_KEY.trim() !== "") {
    console.error("DEMO GUARD: PRIVATE_KEY is set — refusing to start …");
    process.exit(1);
  }
  if (config.model !== "mock") warn
  ```  
  Tiny separate guard, separate from business logic. If user accidentally adds a secret in Render dashboard, process exits before `market.init()` could create a wallet. Also warns if `MODEL!=mock` (expected `mock`). Keeps dry-run invariant even if env mis-configured. Tested: `PRIVATE_KEY=0x123 bun run src/index.ts` → exits 1 with clear message.

* **`Dockerfile` — deploy-ready**  
  ```dockerfile
  COPY package.json bun.lock bunfig.toml tsconfig.json ./
  COPY src ./src
  ENV NODE_ENV=production
  ENV PORT=3000
  EXPOSE 3000
  ```  
  Added `tsconfig.json` to copy (Bun may need it), `EXPOSE`, explicit `PORT` default (overridden by Render). Kept `.dockerignore` (`node_modules, .env, data, scripts, .claude`) so no secret baked into image. `bun install --frozen-lockfile --production` + `CMD ["bun","run","src/index.ts"]` unchanged otherwise. Docker not available in sandbox to build, but reviewed carefully; `oven/bun:1.3` matches local `1.4.2`.

* **`render.yaml` — Blueprint (IaC)**  
  ```yaml
  services:
    - type: web
      name: jev-trader-demo
      runtime: docker
      plan: free
      branch: demo-deploy
      dockerfilePath: ./Dockerfile
      healthCheckPath: /
      autoDeploy: false
      envVars:
        - key: MODEL value: mock
        - key: DRY_RUN value: "true"
        - key: PORT value: "10000"
        - key: RPC_URL value: https://rpc.monad.xyz
        - key: READ_RPC_URL value: https://rpc.monad.xyz
  ```  
  `runtime: docker`, `plan: free`, `healthCheckPath: /` (returns JSON). `PRIVATE_KEY` intentionally **absent** — not defined at all. No secret values in repo. Blueprint lets user deploy via `New > Blueprint` in one click.

* **`.env` / `.gitignore` / `.dockerignore`** — no change needed; already ` .env` ignored in both. Verified `git check-ignore -v .env` → `.gitignore:2:.env`. `.env.example` remains committed with `PRIVATE_KEY=` empty, `DRY_RUN=true`, `MODEL=mock`. `data/` ignored.

Commit `7a6c604` `demo-deploy: dry-run only, Render Docker blueprint, 0.0.0.0 bind` pushed to `origin/demo-deploy`.

---

## 4) DEPLOY STEPS — EXACT CLICK-BY-CLICK (Render Free)

Verified current Render free-tier terms via web search 2026-09-29:
- **Free web service:** 750 hrs/mo (one service can run 24/7 within limit), 512 MB RAM, 0.1 vCPU shared, 100 GB bandwidth, **no card required** per several sources but mid-2026 docs now show “card required for web services” — user may be prompted to add card, no charge on free plan.
- **Docker support:** Native (`runtime: docker` or `Dockerfile`).
- **Sleep-on-idle:** After **15 min inactivity** (some docs say 15, some standby tier 30). First request after sleep → 30-60 s cold start. No monthly hour cap burns while sleeping.
- **Alternative if Render free tier gone:** **Hugging Face Spaces (Docker SDK)** — free, sleeps after inactivity similar. Steps adapted below.

### Render Blueprint method (preferred, one-click)

1. **Push already done:** `git push origin demo-deploy` exists. In GitHub confirm branch `demo-deploy` contains `render.yaml`.
2. Go to **https://dashboard.render.com** → **Sign up / Log in** (GitHub auth, no card initially).
3. **New + → Blueprint** (not “Web Service” individually — blueprint respects `render.yaml`).
4. **Connect repository:** Select `grhadi193-cyber/jev-trader` → grant access if prompted → pick **branch `demo-deploy`** (critical: not `main`).
5. Render auto-detects `render.yaml` at root → shows `jev-trader-demo` service preview: `type: web`, `runtime: docker`, `plan: free`, `healthCheckPath: /`. If YAML errors, fix in repo and push again (auto-sync if `autoDeploy:true`, but we set `false`).
6. **Env vars:** Confirm `MODEL=mock`, `DRY_RUN=true`, `PORT=10000` listed. **Ensure `PRIVATE_KEY` is NOT listed**; if you see a prompt for it, leave it empty/unsynced. Do **not** add `TYPESAFE_AI_API_KEY`.
7. Click **Apply** → Render queues build from `Dockerfile`.
8. Wait build logs: `bun install` → `Bun.serve` start line `jev-trader · model=mock … DRY RUN · :10000`. Health check hits `GET /` periodically.
9. When **Live** (green), copy public URL: `https://jev-trader-demo.onrender.com` (or `xxx.onrender.com` assigned). Note it.
10. **Verify dry-run** (must):
    ```bash
    curl https://YOUR-URL.onrender.com/ | jq .
    # expect: {"model":"mock","wallet":null,"dryRun":true,"market":"0x065C...","latest":{...}}
    curl https://YOUR-URL.onrender.com/history | jq '.[0] | {block, quote, fill}'
    # every quote: {"status":"sim","txHash":null,"gasMon":0}
    # every fill if present: {"simulated":true,"txHash":null}
    curl -N https://YOUR-URL.onrender.com/events  # SSE: snapshot + block every ~300 ms
    ```
    **Kill immediately if `dryRun:false` or any `simulated:false` or `txHash` non-null.**

11. If Blueprint asks for repo `PORT` mismatch, ensure service **Port** field empty/default (Render injects `PORT`), our app reads `process.env.PORT`.

### Alternative: Manual Web Service if Blueprint not wanted
`New → Web Service → Connect grhadi193-cyber/jev-trader → Branch demo-deploy → Runtime Docker → Plan Free → Dockerfile ./Dockerfile → Health check / → Add env vars MODEL=mock, DRY_RUN=true → Create`.

### Hugging Face Spaces fallback (if Render free tier retired)
1. Create Space at **https://huggingface.co/new-space** → SDK **Docker**, Hardware **CPU basic (free)**, visibility **Public**.
2. Clone that Space repo locally, copy `Dockerfile`, `src/`, `package.json`, `bun.lock`, `tsconfig.json`, `src/` into it, **do not copy `.env`**. Set Space Variables (`Settings → Variables`): `MODEL=mock`, `DRY_RUN=true`, `PORT=7860` (Spaces expects 7860). **No `PRIVATE_KEY`**. Push to Space.
3. URL will be `https://huggingface.co/spaces/<you>/jev-trader-demo`.

### Keep-free alive: UptimeRobot (prevent 15-min sleep)
1. Sign up **https://uptimerobot.com** (free tier: 50 monitors, 5-min interval).
2. **Add New Monitor → Monitor Type: HTTP(s)** → Friendly Name: `jev-trader-demo` → URL: `https://YOUR-URL.onrender.com/` (or `/` ) → Monitoring Interval: **5 minutes** (free minimum) → Monitor Timeout 30 s → Check `200 OK`.
3. Create Monitor → ensure first check **UP**. Keep UptimeRobot tab open logs; Render will never idle >5 min while monitor pings. Without monitor, free instance sleeps after 15 min and needs 30-60 s wake; monitor prevents that within free 750 hrs (20 pings/hr negligible).

**After deploy (or once you give me URL),** run verification curls above; I can also probe remotely if you paste URL.

Live URL if deployed via this session: _not yet auto-deployed (no Render credentials in sandbox)_ — **you hold the repo, click-by-click above will create `https://jev-trader-demo-XXXX.onrender.com`.** Once you paste it, I’ll verify `dryRun:true` + simulated fills.

---

## 5) RISKS / CAVEATS

- **Free-tier sleep:** Without UptimeRobot, first visitor after 15 min idle waits 30-60 s. UptimeRobot 5-min ping mitigates but not guarantee during Render maintenance.
- **RPC rate limits:** Public `https://rpc.monad.xyz` caps at **25 rps** (`eth_getLogs` limited to 100 blocks range). App stays under limit: 1 `eth_call` book read + 1 `getLogs` per block + `eth_blockNumber` poll 150 ms → ~13 rps, plus `MAX_RANGE 100` chunking and `MAX_CATCHUP 1000`. Under load it throttles via `Promise.allSettled` and 150 ms pacing, but bursts (e.g. vault checks every 200 blocks) may hit `–32007` “limit” and retry.
- **Sandbox TLS note:** This sandbox cannot TLS-handshake to `rpc.monad.xyz` (all `https` fails with `SSL_ERROR_SYSCALL`), so local `bun run start` could not be demonstrated live here. Production Render egress is normal; README’s deployed `https://jev-trader-production.up.railway.app` proves public RPC works.
- **Cost non-issue in dry-run:** `gasMon` stays 0, no MON spent. Live would cost `~0.03 MON/block` → `~360 MON/hour` live; mock model `jevUsd` tiny (`0.042 $/MTok`).
- **No secret committed:** `.env` gitignored, `render.yaml` has no secret, branch `demo-deploy` diff shows no `PRIVATE_KEY` value (only guard string). Do not add secrets via Render env as “secure” value either for demo.
- **Branch hygiene:** Work is on `demo-deploy`; `main` stays clean for upstream sync. `autoDeploy:false` in `render.yaml` prevents accidental redeploy on every push to `demo-deploy` if you prefer manual sync.

---

## 6) QUICK VERIFICATION CHECKLIST (paste after deploy)

```bash
URL=https://YOUR-URL.onrender.com

# 1) snapshot
curl -s $URL/ | python3 -m json.tool
# must contain: "wallet": null, "dryRun": true, "model": "mock"

# 2) history sample
curl -s $URL/history | python3 -c "import sys,json;h=json.load(sys.stdin);print(h[-1]['quote']);print(h[-1]['fill'])"
# expect: {'status':'sim','txHash':None,'gasMon':0, ...}  fill either None or {'simulated':True}

# 3) SSE 10 seconds
timeout 10 curl -N $URL/events | head -n 50
# expect: event: snapshot then event: block every ~0.3s, event: fill occasionally with simulated:true

# 4) UptimeRobot monitor shows UP every 5 min
```

If any check fails (`dryRun:false`, `simulated:false`, real `txHash`), **stop service, rotate keys, do not trade**.

---

*Generated for demo/dry-run deployment — no private key ever set, no real transaction sent.*

