# orats-mcp

MCP server that exposes ORATS options analytics to any AI interface. Calls `api.orats.io` directly via fetch — no CLI dependency.

## Setup

**1. Install dependencies**

```bash
cd ~/orats-mcp
npm install
```

**2. Add to Claude Desktop config**

Open `~/Library/Application Support/Claude/claude_desktop_config.json` and add the `orats` entry inside `mcpServers`:

```json
{
  "mcpServers": {
    "orats": {
      "command": "node",
      "args": ["/Users/<your-username>/orats-mcp/server.js"],
      "env": {
        "ORATS_TOKEN": "your_token_here"
      }
    }
  }
}
```

Replace `your_token_here` with your ORATS API token (log in at [dashboard.orats.com](https://dashboard.orats.com) → Account → API Token). If you already have other MCP servers configured, add the `"orats"` key alongside them.

**3. Restart Claude Desktop**

Quit and reopen the app. To verify, ask:

> "Run an ORATS IVR scan for SPY, QQQ, AAPL, NVDA, TSLA"

## Tools

### `orats_ivr_scan`

Morning watchlist scan. Returns IV Rank, IV Percentile, VRP ratio, edge signal, and earnings flag for each ticker, sorted by IVR descending.

```
orats_ivr_scan(tickers: "SPY,QQQ,AAPL,NVDA,TSLA", minIvr: 30, minVolume: 5000)
```

| Field | Description |
|-------|-------------|
| `iv` | Current ex-earnings 20d IV (`orIvXern20d`, pct-points) |
| `ivRank1y` | IV Rank over past year (0–100) |
| `ivPct1y` | IV Percentile over past year (0–100) |
| `iv30d` | 30-day constant-maturity IV (pct-points) |
| `orFcst20d` | ORATS realized vol forecast (pct-points) |
| `vrpRatio` | `iv30d / orFcst20d` — >1.15 = sell edge |
| `edge` | ✅ sell / 🟡 neutral / 🔴 avoid |
| `earningsFlag` | 📅 if earnings within 2 weeks |

### `orats_vrp_screen`

Screens tickers where `iv30d / orFcst20d` exceeds a threshold. Sorted by VRP ratio descending.

```
orats_vrp_screen(tickers: "SPY,QQQ,AAPL", threshold: 1.15, minVolume: 5000)
```

### `orats_earnings`

Returns upcoming earnings timing and historical per-quarter post-earnings moves.

```
orats_earnings(tickers: "AAPL,NVDA,TSLA")
```

Response shape: `{ upcoming, historical }`
- `upcoming` — `wksNextErn`, `nextErnTod`, `impliedEarningsMove`, `impliedMove`, `stockPrice` from `delayed-cores`. **Units: pct-points** (e.g. `7.2` = 7.2% move, not a decimal ratio).
- `historical` — one row per past earnings event from `hist-eod-earnings` (`absAvgErnMv`, `ernMv1`–`ernMv12`, etc.)

### `orats_query`

Direct access to any ORATS endpoint with full parameter control.

```
orats_query(endpoint: "delayed-cores", ticker: "SPY,AAPL", fields: "ticker,iv30d,orFcst20d")
```

**Endpoints:**

| Group | Names |
|-------|-------|
| Live (<10s) | `live-summaries`, `live-monies-implied`, `live-monies-forecast`, `live-strikes`, `live-strikes-monthly`, `live-strikes-options`, `live-expirations` |
| Delayed (~15m) | `delayed-cores`, `delayed-ivrank`, `delayed-tickers` |
| Hist EOD | `hist-eod-cores`, `hist-eod-summaries`, `hist-eod-monies-implied`, `hist-eod-monies-forecast`, `hist-eod-strikes`, `hist-eod-strikes-options`, `hist-eod-hvs`, `hist-eod-dailies`, `hist-eod-ivrank`, `hist-eod-earnings`, `hist-eod-divs`, `hist-eod-splits` |
| Hist Intraday | `hist-intraday-summaries`, `hist-intraday-monies-implied`, `hist-intraday-strikes-chain`, `hist-intraday-strikes-option` |

**Parameters:** `ticker`, `tickers`, `tradeDate`, `expirDate`, `expiry`, `strike`, `dte`, `delta`, `tradeTime`, `fields`

## Units

ORATS uses two scales depending on the endpoint family:

| Endpoint family | IV scale | Example |
|-----------------|----------|---------|
| `cores`, `ivrank` | pct-points | `28.8` = 28.8% IV |
| `summaries`, `monies` | decimals | `0.288` = 28.8% IV |

## VRP signal thresholds

| Ratio | Signal |
|-------|--------|
| `iv30d / orFcst20d > 1.15` | IV overpriced → sell premium edge |
| `0.85–1.15` | Neutral |
| `< 0.85` | IV underpriced → avoid selling |

`orFcst20d` is only available on `delayed-cores` and `hist-eod-cores`.
