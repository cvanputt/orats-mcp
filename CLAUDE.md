# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the server

```bash
npm start          # node server.js
```

No build step. No tests. No linter. The server runs until killed; it speaks MCP over stdio so it won't produce visible output when run directly — use Claude Desktop to exercise it.

For local testing with a real token:

```bash
ORATS_TOKEN=<token> node server.js
```

## Architecture

Everything lives in `server.js` — a single-file Node.js ES module MCP server. It exposes four tools to Claude via the `@modelcontextprotocol/sdk` stdio transport.

**Request flow:**
1. Claude Desktop spawns the process and communicates over stdin/stdout via MCP.
2. `CallToolRequestSchema` handler dispatches by tool name to one of four handler functions.
3. Each handler calls `oratsGet()`, which builds a URL from `ENDPOINTS` + `URLSearchParams`, fetches with a 30s `AbortController` timeout, and unwraps the `{ data: [...] }` envelope ORATS returns.
4. The result is JSON-stringified and returned as a `text` content block.

**The four tools:**

| Tool | Handler | What it does |
|------|---------|--------------|
| `orats_query` | `handleOratsQuery` | Pass-through to any endpoint; forwards all args directly to `oratsGet` (no allowlist filtering) |
| `orats_ivr_scan` | `handleIvrScan` | Parallel fetch of `delayed-ivrank` + `delayed-cores`, joined by ticker; computes `vrpRatio` and `edge` signal |
| `orats_vrp_screen` | `handleVrpScreen` | Single fetch of `delayed-cores`, filters by VRP ratio threshold |
| `orats_earnings` | `handleEarnings` | Parallel fetch of `delayed-cores` (upcoming) + `hist-eod-earnings` (historical), returns `{ upcoming, historical }` |

## Key details

**Units:** ORATS uses two scales. `cores` and `ivrank` endpoints return pct-points (`28.8` = 28.8% IV); `summaries` and `monies` endpoints return decimals (`0.288`). The `impliedEarningsMove` and `impliedMove` fields on cores are pct-points — not decimal ratios.

**VRP signal:** `iv30d / orFcst20d > 1.15` = sell edge. `orFcst20d` is only on `delayed-cores` / `hist-eod-cores`. The `vrpRatio` guard uses `orFcst20d > 0` (not a truthy check) so that `iv30d = 0` still produces a ratio rather than null.

**Volume filter:** Both scan tools use `>= minVolume` (inclusive). Tickers absent from `delayed-cores` are excluded from `orats_ivr_scan` results — missing cores coverage is treated as a failed liquidity check.

**earningsFlag:** Only fires when `wksNextErn >= 0 && wksNextErn <= 2` — negative values (earnings just passed) are intentionally excluded.

**PARAM_MAP / mapParams:** Used only by the specialized handlers (`handleIvrScan`, `handleVrpScreen`, `handleEarnings`) to build their fixed field sets. `handleOratsQuery` bypasses it entirely and forwards all args directly, so `orats_query` supports the full ORATS param surface including `tradeTime`, `expirDate`, etc.

**Token:** Loaded from `ORATS_TOKEN` env var at startup; exits immediately if missing. In Claude Desktop, set it in the `env` block of `claude_desktop_config.json`.
