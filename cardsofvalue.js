require('@dotenvx/dotenvx').config()
const fs = require('fs');
const path = require('path');

// Make base URL configurable but default to CardTrader production as in Postman
const API_URL = (process.env.API_URL?.replace(/\/$/, '')) || 'https://api.cardtrader.com/api/v2';
const API_TOKEN = process.env.API_TOKEN;
const VAT_RATE = process.env.VAT_RATE ? parseFloat(process.env.VAT_RATE) : 0.22; // default 22%
const PAGE_LIMIT = parseInt(process.env.PAGE_LIMIT || '200', 10); // mirrors Postman optional limit
const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), '.cache');
const CACHE_TTL_HOURS = parseInt(process.env.CACHE_TTL_HOURS || '168', 10); // default 7 days
const CACHE_TTL_MS = CACHE_TTL_HOURS * 60 * 60 * 1000;

// Helper function for comparison
function compare(price, comparison, value) {
  if (comparison === 'greater') return price > value;
  if (comparison === 'less') return price < value;
  if (comparison === 'equal') return price === value;
  throw new Error('Invalid comparison type. Use "greater", "less", or "equal".');
}

(async function() {
  // Format helpers
  const formatUSDFromCents = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((cents ?? 0) / 100);
  const getPriceCents = (p) => (p.price_cents != null)
    ? p.price_cents
    : (typeof p.price === 'number' ? Math.round(p.price * 100) : 0);
  // Will be populated from /categories; used to map product.category_id -> category name
  const categoryMap = new Map();
  // Simple JSON file cache helpers
  const ensureCacheDir = () => {
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}
  };
  const readJsonIfFresh = (file) => {
    try {
      const stat = fs.statSync(file);
      const age = Date.now() - stat.mtimeMs;
      if (age > CACHE_TTL_MS) return null; // stale
      const raw = fs.readFileSync(file, 'utf8');
      return JSON.parse(raw);
    } catch (_) { return null; }
  };
  const writeJson = (file, data) => {
    try {
      ensureCacheDir();
      fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    } catch (_) {}
  };
  // removed game breakdown helpers
  const getCategoryName = (p) => {
    if (p.category_id != null && categoryMap.size > 0) {
      const mapped = categoryMap.get(p.category_id);
      if (mapped) return mapped;
    }
    return p.category?.name
      || p.category
      || p.blueprint?.category_name
      || 'Uncategorized';
  };

  // Parse command line arguments
  const [, , comparison, valueStr] = process.argv;
  const value = parseInt(valueStr, 10);

  if (!['greater', 'less', 'equal'].includes(comparison) || isNaN(value)) {
    console.error('Usage: node cardsofvalue.js [greater|less|equal] [price_in_cents]');
    process.exit(1);
  }

  if (!API_TOKEN) {
    console.error('Missing API_TOKEN in environment (.env)');
    process.exit(1);
  }

  // Try to load categories list once so we can label breakdowns reliably (with caching)
  try {
    // Categories
    const catCachePath = path.join(CACHE_DIR, 'categories.json');
    let categories = readJsonIfFresh(catCachePath);
    if (!Array.isArray(categories)) {
      const catRes = await fetch(`${API_URL}/categories`, {
        headers: {
          'Authorization': `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      if (catRes.ok) {
        categories = await catRes.json();
        if (Array.isArray(categories)) writeJson(catCachePath, categories);
      }
    }
    if (Array.isArray(categories)) {
      for (const c of categories) {
        const id = c.id ?? c.category_id;
        const name = c.name ?? c.title;
        if (id != null && name) categoryMap.set(id, name);
      }
    }
  } catch (_) {
    // Non-fatal: we'll fall back to heuristic fields
  }

  let page = 1;
  let totalCount = 0;
  let totalValueCents = 0;
  const perCategory = new Map(); // categoryName -> { items, quantity, totalCents }
  let hasMore = true;

  while (hasMore) {
    const res = await fetch(`${API_URL}/products/export?page=${page}&limit=${PAGE_LIMIT}`, {
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      console.error('Failed to fetch products:', res.statusText);
      process.exit(1);
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      console.error('Unexpected response shape from products/export');
      process.exit(1);
    }

    // Filter according to comparison and value
    const filtered = data.filter((product) => {
      const priceCents = (product.price_cents != null)
        ? product.price_cents
        : (typeof product.price === 'number' ? Math.round(product.price * 100) : undefined);
      return compare(priceCents ?? 0, comparison, value);
    });

    for (const product of filtered) {
      const qty = product.quantity ?? 1;
      const priceCents = getPriceCents(product);
      totalCount += qty;
      totalValueCents += priceCents * qty;

      const category = getCategoryName(product);
      const prevCat = perCategory.get(category) || { items: 0, quantity: 0, totalCents: 0 };
      perCategory.set(category, {
        items: prevCat.items + 1,
        quantity: prevCat.quantity + qty,
        totalCents: prevCat.totalCents + (priceCents * qty)
      });
    }

  hasMore = data.length > 0 && data.length === PAGE_LIMIT;
    page++;
  }
  // Marketplace fee scenarios (per item fee + VAT on the fee): CTZ 8%, CTR 15%
  const CTZ_RATE = 0.08;
  const CTR_RATE = 0.15;
  const netAfterFees = (totalCents, feeRate) => {
    // Net = total - fee - VAT on fee = total * (1 - feeRate * (1 + VAT_RATE))
    const effectiveMultiplier = 1 - (feeRate * (1 + VAT_RATE));
    return Math.max(0, Math.round(totalCents * effectiveMultiplier));
  };
  const ctzNetCents = netAfterFees(totalValueCents, CTZ_RATE);
  const ctrNetCents = netAfterFees(totalValueCents, CTR_RATE);

  // Pretty summary output
  const supportsColor = process.stdout.isTTY && process.env.NO_COLOR !== '1';
  const ansi = supportsColor ? {
    reset: '\x1b[0m', bold: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, magenta: (s) => `\x1b[35m${s}\x1b[0m`
  } : { reset: '', bold: (s) => s, dim: (s) => s, cyan: (s) => s, green: (s) => s, magenta: (s) => s };
  const ansiRegex = /\x1B\[[0-?]*[ -\/]?[@-~]/g;
  const vlen = (s) => String(s).replace(ansiRegex, '').length; // visible length (strip ANSI)
  const padEndV = (s, width) => s + ' '.repeat(Math.max(0, width - vlen(s)));
  const divider = (w) => `┠${'─'.repeat(w)}┨`;
  const top = (w, t) => `┏ ${t} ${'─'.repeat(Math.max(0, w - vlen(t) - 1))}┓`;
  const bottom = (w) => `┗${'─'.repeat(w + 2)}┛`;

  const priceSymbol = value < 100 ? '¢' : '';
  const thresholdStr = value < 100 ? `${value}¢` : `${formatUSDFromCents(value)}`;
  const vatPct = `${Math.round(VAT_RATE * 100)}%`;
  const rows = [
    { label: 'Filters', value: `price ${comparison} ${thresholdStr}` },
    { label: 'Items', value: `${totalCount}` },
    { label: 'Gross', value: `${formatUSDFromCents(totalValueCents)}` },
    { label: `CTZ (8% + VAT ${vatPct})`, value: `${formatUSDFromCents(ctzNetCents)}` },
    { label: `CTR (15% + VAT ${vatPct})`, value: `${formatUSDFromCents(ctrNetCents)}` }
  ];

  const labelWidth = Math.max(...rows.map(r => vlen(r.label)));
  const valWidth = Math.max(...rows.map(r => vlen(r.value)));
  const innerWidth = labelWidth + 2 + valWidth; // label + ': ' + value

  console.log(top(innerWidth, ansi.cyan(ansi.bold('Summary'))));
  for (const r of rows) {
    const label = padEndV(r.label, labelWidth);
    const val = padEndV(ansi.bold(r.value), valWidth);
    console.log(`┃ ${ansi.dim(label)}: ${val} ┃`);
    if (r.label === 'Items') console.log(divider(innerWidth));
  }
  console.log(bottom(innerWidth));

  // Breakdown by category
  if (perCategory.size > 0) {
    const rows = Array.from(perCategory.entries()).map(([category, stats]) => {
      const ctz = netAfterFees(stats.totalCents, 0.08);
      const ctr = netAfterFees(stats.totalCents, 0.15);
      return {
        category,
        items: stats.items,
        quantity: stats.quantity,
        total_usd: formatUSDFromCents(stats.totalCents),
        ctz_usd: formatUSDFromCents(ctz),
        ctr_usd: formatUSDFromCents(ctr)
      };
    });
    console.log('Breakdown by category:');
    console.table(rows);
  }

})();

