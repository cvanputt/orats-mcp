#!/usr/bin/env node
/**
 * ORATS MCP Server — REST API version
 * Calls api.orats.io directly via fetch. No CLI dependency.
 * Token: set ORATS_TOKEN in claude_desktop_config.json env block.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE_URL = 'https://api.orats.io/datav2';
const TOKEN = process.env.ORATS_TOKEN;

if (!TOKEN) {
  process.stderr.write('ERROR: ORATS_TOKEN environment variable is not set.\n');
  process.exit(1);
}

// ─── Endpoint map: CLI-style name → REST path ─────────────────────────────────
const ENDPOINTS = {
  // Live (<10s)
  'live-summaries':        '/live/summaries',
  'live-monies-implied':   '/live/monies/implied',
  'live-monies-forecast':  '/live/monies/forecast',
  'live-strikes':          '/live/strikes',
  'live-strikes-monthly':  '/live/strikes/options',
  'live-strikes-options':  '/live/strikes/option',
  'live-expirations':      '/live/expirations',
  // Delayed (~15 min)
  'delayed-cores':         '/cores',
  'delayed-ivrank':        '/ivrank',
  'delayed-tickers':       '/tickers',
  // Historical EOD
  'hist-eod-cores':        '/hist/cores',
  'hist-eod-summaries':    '/hist/summaries',
  'hist-eod-monies-implied': '/hist/monies/implied',
  'hist-eod-monies-forecast': '/hist/monies/forecast',
  'hist-eod-strikes':      '/hist/strikes',
  'hist-eod-strikes-options': '/hist/strikes/options',
  'hist-eod-hvs':          '/hist/hvs',
  'hist-eod-dailies':      '/hist/dailies',
  'hist-eod-ivrank':       '/hist/ivrank',
  'hist-eod-earnings':     '/hist/earnings',
  'hist-eod-divs':         '/hist/divs',
  'hist-eod-splits':       '/hist/splits',
  // Historical Intraday
  'hist-intraday-summaries':      '/hist/intraday/summaries',
  'hist-intraday-monies-implied': '/hist/intraday/monies/implied',
  'hist-intraday-strikes-chain':  '/hist/intraday/strikes/chain',
  'hist-intraday-strikes-option': '/hist/intraday/strikes/option',
};

// ─── API call ─────────────────────────────────────────────────────────────────
async function oratsGet(endpoint, params = {}) {
  const path = ENDPOINTS[endpoint];
  if (!path) throw new Error(`Unknown endpoint: "${endpoint}". Valid: ${Object.keys(ENDPOINTS).join(', ')}`);

  const qs = new URLSearchParams({ token: TOKEN });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }

  const url = `${BASE_URL}${path}?${qs}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ORATS API ${res.status}: ${body}`);
  }

  const json = await res.json();
  // ORATS wraps responses in { data: [...] }
  return json.data ?? json;
}

// ─── Param key → ORATS query param name ──────────────────────────────────────
const PARAM_MAP = {
  ticker:      'ticker',
  tickers:     'tickers',
  tradeDate:   'tradeDate',
  expirDate:   'expirDate',
  expiry:      'expiry',
  strike:      'strike',
  dte:         'dte',
  delta:       'delta',
  fields:      'fields',
};

function mapParams(params) {
  const out = {};
  for (const [key, apiKey] of Object.entries(PARAM_MAP)) {
    if (params[key] !== undefined) out[apiKey] = params[key];
  }
  return out;
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────
const zOratsQuery = z.object({
  endpoint:  z.string().describe('Endpoint name (e.g. "delayed-cores", "live-summaries")'),
  ticker:    z.string().optional().describe('Single ticker or comma-separated list (e.g. "SPY,AAPL,NVDA")'),
  tickers:   z.string().optional().describe('OCC contract symbols for live-strikes-options'),
  tradeDate: z.string().optional().describe('YYYY-MM-DD (EOD), YYYYMMDDHHMM (intraday), or YYYY-MM-DD,YYYY-MM-DD (range)'),
  expirDate: z.string().optional().describe('Expiration date YYYY-MM-DD (hist-eod-strikes-options)'),
  expiry:    z.string().optional().describe('Expiration date YYYY-MM-DD (live-strikes-monthly)'),
  strike:    z.number().optional().describe('Strike price (hist-eod-strikes-options)'),
  dte:       z.string().optional().describe('DTE range "min,max" e.g. "25,35"'),
  delta:     z.string().optional().describe('Delta range "min,max" e.g. ".30,.70"'),
  tradeTime: z.string().optional().describe('Intraday snapshot time YYYYMMDDHHMM (hist-intraday endpoints)'),
  fields:    z.string().optional().describe('Comma-separated fields to return (e.g. "ticker,iv30d,orFcst20d")'),
});

const zIvrScan = z.object({
  tickers:   z.string().describe('Comma-separated tickers e.g. "SPY,QQQ,AAPL,NVDA,TSLA"'),
  minIvr:    z.number().optional().describe('Min IV Rank to include (default: 0)'),
  minVolume: z.number().optional().describe('Min avg option volume liquidity filter (default: 1000)'),
});

const zVrpScreen = z.object({
  tickers:   z.string().describe('Comma-separated tickers to screen'),
  threshold: z.number().optional().describe('VRP ratio threshold (default: 1.15)'),
  minVolume: z.number().optional().describe('Min avg option volume (default: 5000)'),
});

const zEarnings = z.object({
  tickers: z.string().describe('Comma-separated tickers'),
});

// ─── Tool handlers ────────────────────────────────────────────────────────────
async function handleOratsQuery(args) {
  const { endpoint, ...rest } = args;
  const data = await oratsGet(endpoint, rest);
  return data;
}

async function handleIvrScan(args) {
  const { tickers, minIvr = 0, minVolume = 1000 } = args;

  // Parallel fetch: ivrank + cores
  const [ivrData, coresData] = await Promise.all([
    oratsGet('delayed-ivrank', { ticker: tickers }),
    oratsGet('delayed-cores',  { ticker: tickers, fields: 'ticker,iv30d,orFcst20d,avgOptVolu20d,wksNextErn,nextErnTod' }),
  ]);

  const ivrRows   = Array.isArray(ivrData)   ? ivrData   : [];
  const coresRows = Array.isArray(coresData) ? coresData : [];

  const coresMap = {};
  for (const r of coresRows) coresMap[r.ticker] = r;

  const result = ivrRows
    .filter(r => (r.ivRank1y ?? 0) >= minIvr)
    .filter(r => {
      const c = coresMap[r.ticker];
      return c && (c.avgOptVolu20d ?? 0) >= minVolume;
    })
    .map(r => {
      const c = coresMap[r.ticker] ?? {};
      const vrpRatio = c.orFcst20d > 0
        ? parseFloat((c.iv30d / c.orFcst20d).toFixed(3))
        : null;
      const earningsFlag = (c.wksNextErn != null && c.wksNextErn >= 0 && c.wksNextErn <= 2) ? '📅' : '';
      const edge = vrpRatio == null ? '—'
        : vrpRatio >= 1.15 ? '✅ sell'
        : vrpRatio >= 1.0  ? '🟡 neutral'
        : '🔴 avoid';
      return {
        ticker:        r.ticker,
        iv:            r.iv,
        ivRank1y:      r.ivRank1y,
        ivPct1y:       r.ivPct1y,
        iv30d:         c.iv30d,
        orFcst20d:     c.orFcst20d,
        vrpRatio,
        avgOptVolu20d: c.avgOptVolu20d,
        earningsFlag,
        edge,
      };
    })
    .sort((a, b) => (b.ivRank1y ?? 0) - (a.ivRank1y ?? 0));

  return result;
}

async function handleVrpScreen(args) {
  const { tickers, threshold = 1.15, minVolume = 5000 } = args;
  const data = await oratsGet('delayed-cores', {
    ticker: tickers,
    fields: 'ticker,iv30d,orFcst20d,avgOptVolu20d,slope,wksNextErn',
  });
  const rows = Array.isArray(data) ? data : [];
  return rows
    .filter(r => r.orFcst20d > 0 && (r.iv30d / r.orFcst20d) > threshold && (r.avgOptVolu20d ?? 0) >= minVolume)
    .map(r => ({
      ticker:        r.ticker,
      iv30d:         r.iv30d,
      orFcst20d:     r.orFcst20d,
      vrpRatio:      parseFloat((r.iv30d / r.orFcst20d).toFixed(3)),
      avgOptVolu20d: r.avgOptVolu20d,
      slope:         r.slope,
      wksNextErn:    r.wksNextErn,
    }))
    .sort((a, b) => b.vrpRatio - a.vrpRatio);
}

async function handleEarnings(args) {
  const { tickers } = args;
  const [currentData, histData] = await Promise.all([
    oratsGet('delayed-cores', {
      ticker: tickers,
      fields: 'ticker,wksNextErn,nextErnTod,impliedEarningsMove,impliedMove,stockPrice',
    }),
    oratsGet('hist-eod-earnings', { ticker: tickers }),
  ]);
  return {
    upcoming: Array.isArray(currentData) ? currentData : [],
    historical: Array.isArray(histData) ? histData : [],
  };
}

// ─── Server ───────────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'orats-mcp', version: '2.0.0' });

function wrap(handler) {
  return async (args) => {
    try {
      const data = await handler(args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  };
}

server.registerTool('orats_query', {
  description: `Query any ORATS REST API endpoint directly.

Endpoints:
  Live (<10s):   live-summaries, live-monies-implied, live-monies-forecast,
                 live-strikes, live-strikes-monthly, live-strikes-options, live-expirations
  Delayed (~15m): delayed-cores, delayed-ivrank, delayed-tickers
  Hist EOD:      hist-eod-cores, hist-eod-summaries, hist-eod-monies-implied,
                 hist-eod-monies-forecast, hist-eod-strikes, hist-eod-strikes-options,
                 hist-eod-hvs, hist-eod-dailies, hist-eod-ivrank, hist-eod-earnings,
                 hist-eod-divs, hist-eod-splits
  Intraday:      hist-intraday-summaries, hist-intraday-monies-implied,
                 hist-intraday-strikes-chain, hist-intraday-strikes-option

Key signal thresholds (from ORATS methodology):
  - iv30d / orFcst20d > 1.15 → IV overpriced → sell premium edge
  - iv30d / orFcst20d < 0.85 → IV underpriced → avoid selling
  - orFcst20d only on delayed-cores / hist-eod-cores
  - Units: cores/ivrank = pct-points (28.8); summaries/monies = decimals (0.288)`,
  inputSchema: zOratsQuery,
}, wrap(handleOratsQuery));

server.registerTool('orats_ivr_scan', {
  description: `Morning IVR scanner. For each ticker returns:
- iv: current ATM IV (orIvXern20d, pct-points scale)
- ivRank1y: IV Rank over past year (0-100)
- ivPct1y: IV Percentile over past year (0-100)
- iv30d: 30-day constant-maturity IV (cores, pct-points)
- orFcst20d: ORATS realized vol forecast (cores, pct-points)
- vrpRatio: iv30d / orFcst20d (>1.15 = sell edge)
- edge: ✅ sell / 🟡 neutral / 🔴 avoid
- earningsFlag: 📅 if earnings within 2 weeks

Sorted by IVR descending. Use this as your daily premium-selling screen.`,
  inputSchema: zIvrScan,
}, wrap(handleIvrScan));

server.registerTool('orats_vrp_screen', {
  description: `VRP edge screen. Returns tickers where iv30d/orFcst20d exceeds threshold —
the primary quant-validated signal for premium selling (IV systematically overprices
realized vol ~85% of the time on equity indexes).
Sorted by VRP ratio descending (highest edge first).`,
  inputSchema: zVrpScreen,
}, wrap(handleVrpScreen));

server.registerTool('orats_earnings', {
  description: `Get earnings dates, implied move, and historical post-earnings moves for tickers.
Returns { upcoming, historical }:
- upcoming: next earnings timing and implied move from delayed-cores. Fields impliedEarningsMove
  and impliedMove are in pct-points (e.g. 7.2 = 7.2% move), NOT decimal ratios.
- historical: one row per past earnings event from hist-eod-earnings (absAvgErnMv, ernMv1..12, etc.)
Use before entering any PMCC or calendar to check if earnings fall inside your DTE window.`,
  inputSchema: zEarnings,
}, wrap(handleEarnings));

const transport = new StdioServerTransport();
await server.connect(transport);
