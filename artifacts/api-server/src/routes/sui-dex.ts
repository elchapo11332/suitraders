import { Router } from "express";
import { getMetadata, getAllMetadata } from "../lib/social-store.js";
import { getAdsToken } from "../lib/ads-store.js";

const router = Router();

const RAIDEN_BASE = "https://api-market.raidenx.io/api/v1/sui";
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const CETUS_PACKAGE =
  "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const SUI_RPC = "https://fullnode.mainnet.sui.io";
const GECKO_HEADERS = { Accept: "application/json" };

const TOKEN_DECIMALS: Record<string, number> = {
  SUI: 9, USDC: 6, USDT: 6, CETUS: 9, DEEP: 6,
  BUCK: 9, TURBOS: 9, MAGMA: 9, HAEDAL: 9, BLUE: 9,
  WBTC: 8, ETH: 8, WETH: 8, NAVI: 9,
};

interface Social { platform: string; url: string; label?: string }
interface Token { address: string; name: string; symbol: string; logoUrl: string | null; socials: Social[] }
interface PriceChange { m5: number; h1: number; h6: number; h24: number }
interface Volume { h24: number; h6: number; h1: number; m5: number }
interface Liquidity { usd: number; base: number; quote: number }
interface TxnCount { buys: number; sells: number }
interface Txns { h24: TxnCount; h6: TxnCount; h1: TxnCount; m5: TxnCount }
interface Pair {
  pairAddress: string; raidenSlug: string; source: string;
  baseToken: Token; quoteToken: Token;
  priceUsd: string; priceNative: string;
  priceChange: PriceChange; volume: Volume; liquidity: Liquidity; txns: Txns;
  dexId: string; url: string; fdv: number | null; marketCap: number | null;
  createdAt: number | null; bannerUrl: string | null;
}

let raidenCache: unknown[] | null = null;
let raidenExpiry = 0;
let geckoCache: unknown[] | null = null;
let geckoExpiry = 0;
let mergedCache: Pair[] | null = null;
let mergedExpiry = 0;

export function invalidateMergedCache() {
  mergedCache = null;
  mergedExpiry = 0;
}

let cetusEventCache: unknown[] | null = null;
let cetusEventExpiry = 0;

async function raidenFetch(path: string) {
  const res = await fetch(`${RAIDEN_BASE}${path}`, {
    headers: { Accept: "application/json", "User-Agent": "SUI-DEX-Screener/1.0" },
  });
  if (!res.ok) throw new Error(`RaidenX ${res.status}`);
  return res.json();
}

async function geckoFetch(path: string) {
  const res = await fetch(`${GECKO_BASE}${path}`, { headers: GECKO_HEADERS });
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`);
  return res.json();
}

async function suiRpc(method: string, params: unknown[]) {
  const res = await fetch(SUI_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json() as { error?: { message: string }; result: unknown };
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

function normalizeSocials(raidenSocials: unknown): Social[] {
  if (!raidenSocials || typeof raidenSocials !== "object") return [];
  const s = raidenSocials as { websites?: Array<{ url: string; label?: string }>; socials?: Array<{ type: string; url: string }> };
  const out: Social[] = [];
  for (const w of s.websites || []) {
    out.push({ platform: "website", url: w.url, label: w.label });
  }
  for (const item of s.socials || []) {
    const type = item.type?.toLowerCase();
    if (["twitter", "telegram", "discord"].includes(type)) {
      out.push({ platform: type, url: item.url });
    }
  }
  return out;
}

function applyAdminOverrides(pair: Pair, baseAddr: string): Pair {
  const meta = getMetadata(baseAddr);
  if (!meta || Object.keys(meta).length === 0) return pair;
  const result = { ...pair };
  if (meta.logoUrl) result.baseToken = { ...result.baseToken, logoUrl: meta.logoUrl };
  if (meta.bannerUrl) result.bannerUrl = meta.bannerUrl;
  if (meta.socials && meta.socials.length > 0) {
    result.baseToken = { ...result.baseToken, socials: meta.socials };
  }
  return result;
}

function formatRaidenPair(pair: Record<string, unknown>): Pair {
  const baseAddr = ((pair.tokenBaseAddress || (pair.tokenBase as Record<string, unknown>)?.address || "") as string).toLowerCase();
  const adminMeta = getMetadata(baseAddr);
  const tokenBase = pair.tokenBase as Record<string, unknown> || {};
  const raidenLinks = normalizeSocials(tokenBase.socials);
  const socials = adminMeta.socials && adminMeta.socials.length > 0 ? adminMeta.socials : raidenLinks;
  const stats = pair.stats as Record<string, Record<string, number>> || {};
  const volume = pair.volume as Record<string, string> || {};
  const tokenQuote = pair.tokenQuote as Record<string, unknown> || {};
  return {
    pairAddress: (pair.poolId || pair.pairId || "") as string,
    raidenSlug: (pair.slug || "") as string,
    source: "raidenx",
    baseToken: {
      address: (pair.tokenBaseAddress || tokenBase.address || "") as string,
      name: (tokenBase.name || "Unknown") as string,
      symbol: (tokenBase.symbol || "???") as string,
      logoUrl: (adminMeta.logoUrl || tokenBase.logoImageUrl || null) as string | null,
      socials,
    },
    quoteToken: {
      address: (pair.tokenQuoteAddress || tokenQuote.address || "") as string,
      name: (tokenQuote.name || "Unknown") as string,
      symbol: (tokenQuote.symbol || "???") as string,
      logoUrl: (tokenQuote.logoImageUrl || null) as string | null,
      socials: [],
    },
    priceUsd: ((tokenBase.priceUsd as number)?.toString() || "0"),
    priceNative: ((tokenBase.price as number)?.toString() || "0"),
    priceChange: {
      m5: stats.percent?.["5m"] ?? stats.priceUsdPercent?.["5m"] ?? 0,
      h1: stats.percent?.["1h"] ?? stats.priceUsdPercent?.["1h"] ?? 0,
      h6: stats.percent?.["6h"] ?? stats.priceUsdPercent?.["6h"] ?? 0,
      h24: stats.percent?.["24h"] ?? stats.priceUsdPercent?.["24h"] ?? 0,
    },
    volume: {
      h24: parseFloat((volume["24h"] ?? pair.volumeUsd ?? "0") as string),
      h6: parseFloat((volume["6h"] ?? "0") as string),
      h1: parseFloat((volume["1h"] ?? "0") as string),
      m5: parseFloat((volume["5m"] ?? "0") as string),
    },
    liquidity: { usd: parseFloat((pair.liquidityUsd ?? "0") as string), base: 0, quote: 0 },
    txns: {
      h24: { buys: stats.buyTxn?.["24h"] ?? stats.numBuy?.["24h"] ?? 0, sells: stats.sellTxn?.["24h"] ?? stats.numSell?.["24h"] ?? 0 },
      h6: { buys: stats.buyTxn?.["6h"] ?? stats.numBuy?.["6h"] ?? 0, sells: stats.sellTxn?.["6h"] ?? stats.numSell?.["6h"] ?? 0 },
      h1: { buys: stats.buyTxn?.["1h"] ?? stats.numBuy?.["1h"] ?? 0, sells: stats.sellTxn?.["1h"] ?? stats.numSell?.["1h"] ?? 0 },
      m5: { buys: stats.buyTxn?.["5m"] ?? stats.numBuy?.["5m"] ?? 0, sells: stats.sellTxn?.["5m"] ?? stats.numSell?.["5m"] ?? 0 },
    },
    dexId: (pair.dexName || (pair.dex as Record<string, unknown>)?.dex || "unknown") as string,
    url: `https://dexscreener.com/sui/${pair.poolId || pair.pairId}`,
    fdv: parseFloat((tokenBase.marketCap || "0") as string) || null,
    marketCap: parseFloat((tokenBase.marketCap || "0") as string) || null,
    createdAt: (pair.timestamp || null) as number | null,
    bannerUrl: (adminMeta.bannerUrl || null) as string | null,
  };
}

function formatGeckoPair(pool: Record<string, unknown>, includedTokens: Array<Record<string, unknown>>): Pair {
  const attrs = pool.attributes as Record<string, unknown> || {};
  const poolAddr = (attrs.address || (pool.id as string)?.replace("sui-network_", "") || "") as string;
  const relationships = pool.relationships as Record<string, { data: { id: string } }> || {};
  const baseAddr = relationships.base_token?.data?.id?.replace("sui-network_", "") || "";
  const quoteAddr = relationships.quote_token?.data?.id?.replace("sui-network_", "") || "";
  const adminMeta = getMetadata(baseAddr);
  const baseIncluded = includedTokens?.find((t) => t.id === relationships.base_token?.data?.id);
  const quoteIncluded = includedTokens?.find((t) => t.id === relationships.quote_token?.data?.id);
  const nameParts = ((attrs.name || "? / ?") as string).split(" / ");
  const baseAttrs = baseIncluded?.attributes as Record<string, string> || {};
  const quoteAttrs = quoteIncluded?.attributes as Record<string, string> || {};
  const baseSymbol = baseAttrs.symbol || nameParts[0] || "???";
  const quoteSymbol = quoteAttrs.symbol || nameParts[1]?.split(" ")[0] || "???";
  const priceUsd = (attrs.base_token_price_usd || "0") as string;
  const volUsd = attrs.volume_usd as Record<string, string> || {};
  const vol24 = parseFloat(volUsd.h24 || "0");
  const liq = parseFloat((attrs.reserve_in_usd || attrs.liquidity_in_usd || "0") as string);
  const mktCap = parseFloat((attrs.market_cap_usd || "0") as string) || null;
  const socials = adminMeta.socials && adminMeta.socials.length > 0 ? adminMeta.socials : [];
  const priceChangePct = attrs.price_change_percentage as Record<string, string> || {};
  const transactions = attrs.transactions as Record<string, { buys: number; sells: number }> || {};
  return {
    pairAddress: poolAddr,
    raidenSlug: "",
    source: "geckoterminal",
    baseToken: {
      address: baseAddr,
      name: baseAttrs.name || baseSymbol,
      symbol: baseSymbol,
      logoUrl: (adminMeta.logoUrl || baseAttrs.image_url || null) as string | null,
      socials,
    },
    quoteToken: {
      address: quoteAddr,
      name: quoteAttrs.name || quoteSymbol,
      symbol: quoteSymbol,
      logoUrl: (quoteAttrs.image_url || null) as string | null,
      socials: [],
    },
    priceUsd: priceUsd?.toString() || "0",
    priceNative: ((attrs.base_token_price_native_currency as number)?.toString() || "0"),
    priceChange: {
      m5: parseFloat(priceChangePct.m5 || "0"),
      h1: parseFloat(priceChangePct.h1 || "0"),
      h6: parseFloat(priceChangePct.h6 || "0"),
      h24: parseFloat(priceChangePct.h24 || "0"),
    },
    volume: {
      h24: vol24,
      h6: parseFloat(volUsd.h6 || "0"),
      h1: parseFloat(volUsd.h1 || "0"),
      m5: parseFloat(volUsd.m5 || "0"),
    },
    liquidity: { usd: liq, base: 0, quote: 0 },
    txns: {
      h24: { buys: transactions.h24?.buys ?? 0, sells: transactions.h24?.sells ?? 0 },
      h6: { buys: transactions.h6?.buys ?? 0, sells: transactions.h6?.sells ?? 0 },
      h1: { buys: transactions.h1?.buys ?? 0, sells: transactions.h1?.sells ?? 0 },
      m5: { buys: transactions.m5?.buys ?? 0, sells: transactions.m5?.sells ?? 0 },
    },
    dexId: (attrs.dex_id || "unknown") as string,
    url: `https://www.geckoterminal.com/sui-network/pools/${poolAddr}`,
    fdv: mktCap,
    marketCap: mktCap,
    createdAt: attrs.pool_created_at ? Math.floor(new Date(attrs.pool_created_at as string).getTime() / 1000) : null,
    bannerUrl: (adminMeta.bannerUrl || null) as string | null,
  };
}

async function fetchRaidenTrending(): Promise<unknown[]> {
  if (raidenCache && Date.now() < raidenExpiry) return raidenCache;
  try {
    const data = await raidenFetch("/pairs/trending?page=1&limit=100&resolution=24h&network=sui");
    const arr = Array.isArray(data) ? data : Object.values(data as object).filter((v) => typeof v === "object" && v !== null);
    raidenCache = arr;
    raidenExpiry = Date.now() + 30_000;
    return arr;
  } catch {
    return raidenCache || [];
  }
}

async function fetchGeckoTrending(): Promise<{ pools: unknown[]; included: unknown[] }> {
  if (geckoCache && Date.now() < geckoExpiry) return { pools: geckoCache, included: [] };
  try {
    const data = await geckoFetch("/networks/sui-network/trending_pools?include=base_token,quote_token&page=1") as { data?: unknown[]; included?: unknown[] };
    const pools = data.data || [];
    const included = data.included || [];
    geckoCache = pools;
    geckoExpiry = Date.now() + 60_000;
    return { pools, included };
  } catch {
    return { pools: geckoCache || [], included: [] };
  }
}

async function fetchAllPairs(): Promise<Pair[]> {
  if (mergedCache && Date.now() < mergedExpiry) return mergedCache;
  const [raidenRaw, { pools: geckoRaw, included }] = await Promise.allSettled([
    fetchRaidenTrending(),
    fetchGeckoTrending(),
  ]).then((results) => [
    results[0].status === "fulfilled" ? results[0].value : [],
    results[1].status === "fulfilled" ? results[1].value : { pools: [], included: [] },
  ] as [unknown[], { pools: unknown[]; included: unknown[] }]);
  const raidenPairs = (raidenRaw as Record<string, unknown>[]).map(formatRaidenPair);
  const geckoPairs = (geckoRaw as Record<string, unknown>[]).map((p) => formatGeckoPair(p, included as Record<string, unknown>[]));
  const seenAddresses = new Set(raidenPairs.map((p) => p.pairAddress.toLowerCase()));
  const seenBaseTokens = new Set(raidenPairs.map((p) => p.baseToken.address.toLowerCase()).filter(Boolean));
  const uniqueGecko = geckoPairs.filter(
    (p) => !seenAddresses.has(p.pairAddress.toLowerCase()) && (!p.baseToken.address || !seenBaseTokens.has(p.baseToken.address.toLowerCase()))
  );
  const combined = [...raidenPairs, ...uniqueGecko];
  const bestByToken = new Map<string, Pair>();
  for (const p of combined) {
    const baseKey = (p.baseToken?.address || p.pairAddress || "").toLowerCase();
    const vol = p.volume?.h24 ?? 0;
    const existing = bestByToken.get(baseKey);
    if (!existing || vol > (existing.volume?.h24 ?? 0)) {
      bestByToken.set(baseKey, p);
    }
  }
  mergedCache = Array.from(bestByToken.values());
  mergedExpiry = Date.now() + 30_000;
  return mergedCache;
}

const searchCache = new Map<string, { pairs: Pair[]; expiry: number }>();

async function searchAllSuiTokens(query: string): Promise<Pair[]> {
  const key = query.toLowerCase().trim();
  const cached = searchCache.get(key);
  if (cached && Date.now() < cached.expiry) return cached.pairs;

  const results: Pair[] = [];
  const seenAddresses = new Set<string>();

  // Helper to add without duplicates
  function addPairs(newPairs: Pair[]) {
    for (const p of newPairs) {
      const addr = p.pairAddress.toLowerCase();
      if (!seenAddresses.has(addr)) {
        seenAddresses.add(addr);
        results.push(p);
      }
    }
  }

  // 1. GeckoTerminal pool search (covers all SUI pools)
  try {
    const data = await geckoFetch(
      `/search/pools?query=${encodeURIComponent(key)}&network=sui-network&include=base_token,quote_token`
    ) as { data?: Record<string, unknown>[]; included?: Record<string, unknown>[] };
    const pools = data.data || [];
    const included = (data.included || []) as Record<string, unknown>[];
    addPairs(pools.map((p) => formatGeckoPair(p, included)));
  } catch { /* ignore */ }

  // 2. RaidenX pair search by token symbol/name
  try {
    const data = await raidenFetch(
      `/pairs?search=${encodeURIComponent(key)}&page=1&limit=50&network=sui`
    ) as Record<string, unknown>;
    const arr = (data.docs || data.data || (Array.isArray(data) ? data : [])) as Record<string, unknown>[];
    addPairs(arr.map(formatRaidenPair));
  } catch { /* ignore */ }

  // 3. Fallback: filter trending cache for partial matches
  try {
    const trending = await fetchAllPairs();
    const q = key.toLowerCase();
    const filtered = trending.filter(
      (p) => (p.baseToken?.symbol || "").toLowerCase().includes(q) ||
        (p.baseToken?.name || "").toLowerCase().includes(q) ||
        (p.pairAddress || "").toLowerCase().includes(q) ||
        (p.baseToken?.address || "").toLowerCase().includes(q)
    );
    addPairs(filtered);
  } catch { /* ignore */ }

  // Sort by volume descending
  results.sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0));

  searchCache.set(key, { pairs: results, expiry: Date.now() + 20_000 });
  return results;
}

async function fetchRecentCetusEvents(): Promise<unknown[]> {
  if (cetusEventCache && Date.now() < cetusEventExpiry) return cetusEventCache;
  try {
    const result = await suiRpc("suix_queryEvents", [
      { MoveEventType: `${CETUS_PACKAGE}::pool::SwapEvent` },
      null, 200, true,
    ]) as { data?: unknown[] };
    cetusEventCache = result?.data || [];
    cetusEventExpiry = Date.now() + 5_000;
    return cetusEventCache;
  } catch {
    return cetusEventCache || [];
  }
}

async function fetchRaidenTransactions(poolId: string, limit: number): Promise<unknown[]> {
  try {
    const data = await raidenFetch(`/transactions?poolIdOrSlug=${encodeURIComponent(poolId)}&limit=${limit}`) as { docs?: unknown[] };
    return data.docs || [];
  } catch {
    return [];
  }
}

function resolveGeckoParams(resolution: string) {
  switch (resolution) {
    case "1": return { timeframe: "minute", aggregate: 1 };
    case "5": return { timeframe: "minute", aggregate: 5 };
    case "15": return { timeframe: "minute", aggregate: 15 };
    case "60": return { timeframe: "hour", aggregate: 1 };
    case "240": return { timeframe: "hour", aggregate: 4 };
    case "1D": return { timeframe: "day", aggregate: 1 };
    default: return { timeframe: "minute", aggregate: 15 };
  }
}

async function fetchGeckoOhlcv(poolAddress: string, resolution: string) {
  try {
    const { timeframe, aggregate } = resolveGeckoParams(resolution);
    const data = await geckoFetch(
      `/networks/sui-network/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=500&currency=usd&token=base`
    ) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
    const list = data.data?.attributes?.ohlcv_list || [];
    if (list.length === 0) return null;
    return list.map(([time, open, high, low, close, volume]) => ({
      time: Number(time),
      open: +Number(open).toFixed(10),
      high: +Number(high).toFixed(10),
      low: +Number(low).toFixed(10),
      close: +Number(close).toFixed(10),
      volume: +Number(volume).toFixed(2),
    })).sort((a, b) => a.time - b.time);
  } catch {
    return null;
  }
}

function generateCandles(pairAddr: string, from: number, to: number, interval: number, num: number, price: number) {
  const seed = pairAddr.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const step = Math.ceil((to - from) / num);
  const startPrice = price * (0.85 + (seed % 30) / 100);
  let cur = startPrice;
  const candles = [];
  for (let i = 0; i < num; i++) {
    const time = from + i * step;
    if (time > to) break;
    const trend = (price - startPrice) * (i / num) * 0.4;
    const noise = (Math.sin(i * 0.5 + seed) + Math.sin(i * 0.23 + seed * 2)) * cur * 0.008;
    const rnd = (Math.random() - 0.49) * cur * 0.015;
    const open = cur;
    const close = Math.max(open * 0.85, cur + trend / num + noise + rnd);
    const high = Math.max(open, close) * (1 + Math.random() * 0.005);
    const low = Math.min(open, close) * (1 - Math.random() * 0.005);
    const vol = (price * 50_000 + Math.random() * price * 200_000) * (1 + Math.sin(i * 0.3) * 0.3);
    candles.push({ time, open: +open.toFixed(10), high: +high.toFixed(10), low: +low.toFixed(10), close: +close.toFixed(10), volume: +vol.toFixed(2) });
    cur = close;
  }
  return candles;
}

interface CetusEvent {
  parsedJson: { pool: string; vault_a_amount?: string; vault_b_amount?: string; amount_in?: string; amount_out?: string; atob?: boolean };
  id: { txDigest: string };
  sender?: string;
  timestampMs?: number;
}

function parseCetusEvent(event: CetusEvent, pair: Pair) {
  try {
    const p = event.parsedJson;
    if (!p || p.pool !== pair.pairAddress) return null;
    const baseSymbol = (pair.baseToken.symbol || "").toUpperCase();
    const quoteSymbol = (pair.quoteToken.symbol || "").toUpperCase();
    const baseDec = TOKEN_DECIMALS[baseSymbol] ?? 9;
    const quoteDec = TOKEN_DECIMALS[quoteSymbol] ?? 6;
    const vaultA = Number(p.vault_a_amount || 0);
    const vaultB = Number(p.vault_b_amount || 0);
    const ratio = vaultA > 0 ? vaultB / vaultA : 1;
    const aIsQuote = ratio > 500 && quoteDec < baseDec;
    const amtIn = Number(p.amount_in || 0);
    const amtOut = Number(p.amount_out || 0);
    let type: "buy" | "sell", amountBase: number, amountQuote: number;
    if (aIsQuote) {
      if (p.atob) { type = "buy"; amountBase = amtOut / 10 ** baseDec; amountQuote = amtIn / 10 ** quoteDec; }
      else { type = "sell"; amountBase = amtIn / 10 ** baseDec; amountQuote = amtOut / 10 ** quoteDec; }
    } else {
      if (p.atob) { type = "sell"; amountBase = amtIn / 10 ** baseDec; amountQuote = amtOut / 10 ** quoteDec; }
      else { type = "buy"; amountBase = amtOut / 10 ** baseDec; amountQuote = amtIn / 10 ** quoteDec; }
    }
    const isStable = ["USDC", "USDT", "BUCK"].includes(quoteSymbol);
    const priceUsd = parseFloat(pair.priceUsd || "0") || 0;
    const amountUsd = isStable ? amountQuote : amountBase * priceUsd;
    if (amountUsd < 0.001) return null;
    return {
      txHash: event.id.txDigest,
      type, pairAddress: pair.pairAddress,
      baseToken: { address: pair.baseToken.address, name: pair.baseToken.name, symbol: pair.baseToken.symbol, logoUrl: null },
      quoteToken: { address: pair.quoteToken.address, name: pair.quoteToken.name, symbol: pair.quoteToken.symbol, logoUrl: null },
      priceUsd: pair.priceUsd || "0",
      amountBase: +amountBase.toFixed(6), amountQuote: +amountQuote.toFixed(6), amountUsd: +amountUsd.toFixed(2),
      maker: event.sender || "",
      timestamp: Math.floor(Number(event.timestampMs || Date.now()) / 1000),
    };
  } catch { return null; }
}

function formatRaidenTx(tx: Record<string, unknown>, pair: Pair) {
  return {
    txHash: tx.hash || `raiden-${Math.random()}`,
    type: (tx.tradingType as string || "").toUpperCase() === "BUY" ? "buy" : "sell",
    pairAddress: pair.pairAddress,
    baseToken: { address: pair.baseToken.address, name: pair.baseToken.name, symbol: pair.baseToken.symbol, logoUrl: null },
    quoteToken: { address: pair.quoteToken.address, name: pair.quoteToken.name, symbol: pair.quoteToken.symbol, logoUrl: null },
    priceUsd: (tx.priceUsd as number)?.toString() || pair.priceUsd || "0",
    amountBase: parseFloat((tx.baseAmount || "0") as string),
    amountQuote: parseFloat((tx.quoteAmount || "0") as string),
    amountUsd: parseFloat((tx.totalUsd || "0") as string),
    maker: (tx.maker as Record<string, string>)?.address || "",
    timestamp: tx.timestamp || Math.floor(Date.now() / 1000),
  };
}

function generateMock(pair: Pair, count: number) {
  const now = Math.floor(Date.now() / 1000);
  const price = parseFloat(pair.priceUsd || "0.001") || 0.001;
  const vol24 = pair.volume?.h24 ?? 10_000;
  const txCount = (pair.txns?.h24?.buys ?? 50) + (pair.txns?.h24?.sells ?? 50) || 100;
  const avgUsd = vol24 / txCount;
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789";
  return Array.from({ length: count }, (_, i) => {
    const isBuy = Math.random() > 0.45;
    const amtUsd = Math.max(5, avgUsd * (0.1 + Math.random() * 2));
    const amtBase = amtUsd / price;
    const addr = Array.from({ length: 44 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    return {
      txHash: `mock-${pair.pairAddress.slice(0, 8)}-${i}-${Math.random().toString(36).slice(2)}`,
      type: isBuy ? "buy" : "sell",
      pairAddress: pair.pairAddress,
      baseToken: { address: pair.baseToken.address, name: pair.baseToken.name, symbol: pair.baseToken.symbol, logoUrl: null },
      quoteToken: { address: pair.quoteToken.address, name: pair.quoteToken.name, symbol: pair.quoteToken.symbol, logoUrl: null },
      priceUsd: pair.priceUsd || "0",
      amountBase: +amtBase.toFixed(4),
      amountQuote: +(amtUsd / (["USDC", "USDT", "BUCK"].includes(pair.quoteToken.symbol) ? 1 : parseFloat(pair.priceUsd || "1") || 1)).toFixed(4),
      amountUsd: +amtUsd.toFixed(2),
      maker: addr,
      timestamp: now - Math.floor(Math.random() * 3600),
    };
  });
}

// Routes

router.get("/tokens", async (req, res) => {
  try {
    const search = req.query.search as string | undefined;
    const sortBy = (req.query.sortBy as string) || "volume";
    const limit = Math.min(parseInt((req.query.limit as string) || "50"), 200);
    let pairs: Pair[];
    if (search?.trim()) {
      // Use broad search across all SUI tokens when a query is present
      pairs = await searchAllSuiTokens(search.trim());
    } else {
      pairs = await fetchAllPairs();
    }
    pairs.sort((a, b) => {
      const vol = (x: Pair) => x.volume?.h24 ?? 0;
      const liq = (x: Pair) => x.liquidity?.usd ?? 0;
      const txns = (x: Pair) => (x.txns?.h24?.buys ?? 0) + (x.txns?.h24?.sells ?? 0);
      const chg = (x: Pair) => x.priceChange?.h24 ?? 0;
      switch (sortBy) {
        case "priceChange": return chg(b) - chg(a);
        case "liquidity": return liq(b) - liq(a);
        case "txns": return txns(b) - txns(a);
        default: return vol(b) - vol(a);
      }
    });
    res.json(pairs.slice(0, limit));
  } catch (err) {
    req.log.error({ err }, "Failed to fetch tokens");
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/tokens/:pairAddress", async (req, res) => {
  try {
    const { pairAddress } = req.params;
    const pairs = await fetchAllPairs();
    const found = pairs.find(
      (p) => (p.pairAddress || "").toLowerCase() === pairAddress.toLowerCase() ||
        (p.raidenSlug || "").toLowerCase() === pairAddress.toLowerCase()
    );
    if (!found) {
      try {
        const direct = await raidenFetch(`/pairs/${pairAddress}`) as Record<string, unknown>;
        if (direct?.poolId) { res.json(formatRaidenPair(direct)); return; }
      } catch { /* ignore */ }
      try {
        const geckoData = await geckoFetch(`/networks/sui-network/pools/${pairAddress}?include=base_token,quote_token`) as { data?: Record<string, unknown>; included?: Record<string, unknown>[] };
        if (geckoData?.data) { res.json(formatGeckoPair(geckoData.data, geckoData.included || [])); return; }
      } catch { /* ignore */ }
      res.status(404).json({ error: "Pair not found" });
      return;
    }
    const baseAddr = (found.baseToken?.address || "").toLowerCase();
    res.json(applyAdminOverrides({ ...found }, baseAddr));
  } catch (err) {
    req.log.error({ err }, "Failed to fetch pair");
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/tokens/:pairAddress/info", async (req, res) => {
  try {
    const { pairAddress } = req.params;
    const data = await raidenFetch(`/pairs/${pairAddress}`) as Record<string, unknown>;
    const tokenBase = data.tokenBase as Record<string, unknown> || {};
    const totalHolders = Number(data.totalHolders) || Number(tokenBase.holdersCount) || Number(data.totalMakers) || 0;
    res.json({
      totalHolders,
      totalMakers: data.totalMakers || 0,
      top10Pct: tokenBase.top10HolderPercent || 0,
      deployerPct: tokenBase.deployerBalancePercent || 0,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch pair info");
    res.json({ totalHolders: 0, totalMakers: 0, top10Pct: 0, deployerPct: 0 });
  }
});

router.get("/tokens/:pairAddress/candles", async (req, res) => {
  try {
    const { pairAddress } = req.params;
    const resolution = (req.query.resolution as string) || "15";
    const to = parseInt((req.query.to as string) || "") || Math.floor(Date.now() / 1000);
    const from = parseInt((req.query.from as string) || "") || to - 7 * 24 * 3600;
    const geckoCandles = await fetchGeckoOhlcv(pairAddress, resolution);
    if (geckoCandles && geckoCandles.length >= 5) {
      const filtered = geckoCandles.filter((c) => c.time >= from && c.time <= to);
      res.json(filtered.length >= 5 ? filtered : geckoCandles.slice(-500));
      return;
    }
    let basePrice = 1;
    const pairs = await fetchAllPairs().catch(() => []);
    const found = pairs.find((p) => (p.pairAddress || "").toLowerCase() === pairAddress.toLowerCase());
    if (found) basePrice = parseFloat(found.priceUsd) || 1;
    const resMap: Record<string, number> = { "1": 60, "5": 300, "15": 900, "60": 3600, "240": 14400, "1D": 86400 };
    const intervalSeconds = resMap[resolution] || 900;
    const numCandles = Math.min(Math.ceil((to - from) / intervalSeconds), 500);
    res.json(generateCandles(pairAddress, from, to, intervalSeconds, numCandles, basePrice));
  } catch (err) {
    req.log.error({ err }, "Failed to fetch candles");
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/transactions", async (req, res) => {
  try {
    const pairAddress = req.query.pairAddress as string | undefined;
    const limit = Math.min(parseInt((req.query.limit as string) || "50"), 100);
    if (pairAddress) {
      const pairs = await fetchAllPairs().catch(() => []);
      const found = pairs.find((p) => (p.pairAddress || "").toLowerCase() === pairAddress.toLowerCase());
      if (found) {
        const raidenTxs = await fetchRaidenTransactions(pairAddress, limit);
        if (raidenTxs.length >= 5) {
          res.json((raidenTxs as Record<string, unknown>[]).map((tx) => formatRaidenTx(tx, found)));
          return;
        }
        if (found.dexId === "cetus") {
          const events = await fetchRecentCetusEvents();
          const realTxns = (events as CetusEvent[]).map((ev) => parseCetusEvent(ev, found)).filter(Boolean).slice(0, limit);
          if (realTxns.length >= 3) { res.json(realTxns); return; }
          const mock = generateMock(found, limit - realTxns.length);
          res.json([...realTxns, ...mock].sort((a, b) => b!.timestamp - a!.timestamp).slice(0, limit));
          return;
        }
        res.json(generateMock(found, limit));
        return;
      }
    }
    const trending = await fetchAllPairs().catch(() => []);
    const top = trending.slice(0, 5);
    const txns = top.flatMap((p) => generateMock(p, Math.ceil(limit / Math.max(top.length, 1))));
    txns.sort((a, b) => b.timestamp - a.timestamp);
    res.json(txns.slice(0, limit));
  } catch (err) {
    req.log.error({ err }, "Failed to fetch transactions");
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get("/ads", async (_req, res) => {
  try {
    const address = getAdsToken();
    if (!address) { res.json({ tokenAddress: null, pair: null }); return; }
    const pairs = await fetchAllPairs().catch(() => [] as Pair[]);
    const addr = address.toLowerCase();
    const pair = pairs.find((p) =>
      p.pairAddress.toLowerCase() === addr ||
      (p.baseToken?.address || "").toLowerCase() === addr ||
      (p.baseToken?.address || "").toLowerCase().split("::")[0] === addr.split("::")[0]
    ) || null;
    res.json({ tokenAddress: address, pair });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
