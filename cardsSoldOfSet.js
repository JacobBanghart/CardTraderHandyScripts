require('@dotenvx/dotenvx').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const API_URL = (process.env.API_URL?.replace(/\/$/, '')) || 'https://api.cardtrader.com/api/v2';
const API_TOKEN = process.env.API_TOKEN;
const PAGE_LIMIT = parseInt(process.env.PAGE_LIMIT || '200', 10);
const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), '.cache');
const CACHE_TTL_HOURS = parseInt(process.env.CACHE_TTL_HOURS || '168', 10); // default 7 days
const CACHE_TTL_MS = CACHE_TTL_HOURS * 60 * 60 * 1000;

(async function() {
  if (!API_TOKEN) {
    console.error('Missing API_TOKEN in environment (.env)');
    process.exit(1);
  }


  // Parse command line arguments
  const [, , dateStr] = process.argv;
  if (!dateStr) {
    console.error('Usage: node cardsSoldOfSet.js [from_date: YYYY-MM-DD]');
    process.exit(1);
  }
  const fromDate = new Date(dateStr);
  if (isNaN(fromDate.getTime())) {
    console.error('Invalid date format. Use YYYY-MM-DD.');
    process.exit(1);
  }

  // Helper for formatting
  const formatUSDFromCents = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((cents ?? 0) / 100);

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


  // Get expansions (sets) to map set id/name
  let expansions = null;
  const expCachePath = path.join(CACHE_DIR, 'expansions.json');
  expansions = readJsonIfFresh(expCachePath);
  if (!Array.isArray(expansions)) {
    const expRes = await fetch(`${API_URL}/expansions`, {
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    if (expRes.ok) {
      expansions = await expRes.json();
      if (Array.isArray(expansions)) writeJson(expCachePath, expansions);
    }
  }
  if (!Array.isArray(expansions)) {
    console.error('Could not fetch expansions list.');
    process.exit(1);
  }

  // Fetch all orders (paginated) and collect sets with sales since fromDate
  let page = 1;
  let hasMore = true;
  const soldSets = new Map(); // expansion_id -> { name, count }
  const orders = [];
  while (hasMore) {
    const res = await fetch(`${API_URL}/orders?sort=date.desc&page=${page}&limit=${PAGE_LIMIT}`,
      {
        headers: {
          'Authorization': `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
    if (!res.ok) {
      console.error('Failed to fetch orders:', res.statusText);
      process.exit(1);
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
      console.error('Unexpected response shape from orders');
      process.exit(1);
    }
    if (data.length === 0) break;
    for (const order of data) {
      if (!order.date) continue;
      const orderDate = new Date(order.date);
      if (orderDate < fromDate) {
        hasMore = false;
        break;
      }
      orders.push(order);
      if (!Array.isArray(order.items)) continue;
      for (const item of order.items) {
        const expId = item.expansion_id || item.expansion?.id;
        if (!expId) continue;
        const exp = expansions.find(e => (e.id || e.expansion_id) === expId);
        const expName = exp ? (exp.name || exp.title) : (item.expansion?.name || 'Unknown');
        const prev = soldSets.get(expId) || { name: expName, count: 0 };
        soldSets.set(expId, { name: expName, count: prev.count + (item.quantity ?? 1) });
      }
    }
    hasMore = hasMore && data.length === PAGE_LIMIT;
    page++;
  }

  if (soldSets.size === 0) {
    console.log('No sales found since', dateStr);
    process.exit(0);
  }

  // Display sets and prompt user to select one
  const setList = Array.from(soldSets.entries()).map(([id, info], idx) => ({
    idx: idx + 1,
    id,
    name: info.name,
    count: info.count
  }));
  console.log('Sets with sales since', dateStr);
  setList.forEach(s => {
    console.log(`${s.idx}. ${s.name} (sold: ${s.count})`);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(res => rl.question(q, res));
  let chosenIdx = null;
  while (true) {
    const answer = await ask('Select a set by number: ');
    const num = parseInt(answer, 10);
    if (!isNaN(num) && num >= 1 && num <= setList.length) {
      chosenIdx = num - 1;
      break;
    }
    console.log('Invalid selection. Try again.');
  }
  rl.close();
  const chosenSet = setList[chosenIdx];
  const expansionId = chosenSet.id;
  const setName = chosenSet.name;


  // Now, sum up sales for the chosen set
  let totalSoldCents = 0;
  let totalSoldQty = 0;
  const perCard = new Map(); // blueprint_id -> { name, qty, totalCents }
  for (const order of orders) {
    if (!Array.isArray(order.items)) continue;
    for (const item of order.items) {
      if ((item.expansion_id || item.expansion?.id) === expansionId) {
        const qty = item.quantity ?? 1;
        const priceCents = (item.price_cents != null)
          ? item.price_cents
          : (typeof item.price === 'number' ? Math.round(item.price * 100) : 0);
        totalSoldCents += priceCents * qty;
        totalSoldQty += qty;
        const blueprintId = item.blueprint_id || item.blueprint?.id;
        const name = item.name || item.blueprint?.name || 'Unknown';
        const prev = perCard.get(blueprintId) || { name, qty: 0, totalCents: 0 };
        perCard.set(blueprintId, {
          name,
          qty: prev.qty + qty,
          totalCents: prev.totalCents + (priceCents * qty)
        });
      }
    }
  }

  // Output summary
  console.log(`Cards sold from set: ${setName} (expansion_id: ${expansionId})`);
  console.log(`Total sold: ${totalSoldQty} cards, ${formatUSDFromCents(totalSoldCents)}`);
  if (perCard.size > 0) {
    const rows = Array.from(perCard.values()).map(card => ({
      name: card.name,
      quantity: card.qty,
      total_usd: formatUSDFromCents(card.totalCents)
    }));
    console.log('Breakdown by card:');
    console.table(rows);
  }
})();
