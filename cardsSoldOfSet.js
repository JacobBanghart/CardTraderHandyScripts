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

  // Get categories to derive game names
  let categories = null;
  const catCachePath = path.join(CACHE_DIR, 'categories.json');
  categories = readJsonIfFresh(catCachePath);
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
  if (!Array.isArray(categories)) {
    console.error('Could not fetch categories list.');
    process.exit(1);
  }

  // Build a map of game_id -> game name
  const gameNames = new Map();
  for (const cat of categories) {
    if (!gameNames.has(cat.game_id)) {
      const name = cat.name.replace(/ (Single Card|Token|Emblem|Booster|Starter|Playmat|Sleeve|Storage|Album|Bundle|Action|Sealed|Accessories|Art|Equipment|Deckbox|Playset|Oversized|Insert|Promo|Basic Land|Special|Card Back|Heroes|Display|Structure|Deck Box|Theme Deck|Prerelease|Fat Pack|Intro Pack|Gift|Challenger|Battle|Commander|Duel|Premium|Anthology|World|Secret|Archenemy|Planechase|Conspiracy|Deckmasters|Masters|From the Vault|Clash|Game Day|Event|League|Spin|Dice|Tin|Playsets|Box|Set|Pack|Kit|Case|Lot|Collection|Other|Counter|Marker|Life|Board|Mat|Binder|Portfolio|Card|Cards|Foil|Non-Foil|English|Japanese|Korean|Chinese|German|French|Spanish|Italian|Portuguese|Russian).*/i, '');
      gameNames.set(cat.game_id, name.trim());
    }
  }

  // Build a map of expansion names -> {id, game_id} for matching (order items reference expansion by name)
  const expByName = new Map();
  for (const exp of expansions) {
    expByName.set(exp.name.toLowerCase(), exp);
  }

  // Fetch all orders (paginated) and aggregate sales per expansion since fromDate
  let page = 1;
  let hasMore = true;
  // expansion_id -> { name, game_id, qty, cents, perCard: Map(blueprint_id -> {name, qty, cents}) }
  const soldSets = new Map();
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
      const items = order.order_items || order.items;
      if (!Array.isArray(items) || items.length === 0) continue;
      const orderDateStr = items[0].created_at;
      if (!orderDateStr) continue;
      const orderDate = new Date(orderDateStr);
      if (orderDate < fromDate) {
        hasMore = false;
        break;
      }
      for (const item of items) {
        const expName = item.expansion || 'Unknown';
        const exp = expByName.get(expName.toLowerCase());
        if (!exp) continue;
        const qty = item.quantity ?? 1;
        const priceCents = (item.seller_price?.cents != null)
          ? item.seller_price.cents
          : (item.price_cents != null)
            ? item.price_cents
            : (typeof item.price === 'number' ? Math.round(item.price * 100) : 0);

        const entry = soldSets.get(exp.id) || { name: exp.name, game_id: exp.game_id, qty: 0, cents: 0, perCard: new Map() };
        entry.qty += qty;
        entry.cents += priceCents * qty;

        const blueprintId = item.blueprint_id || item.blueprint?.id;
        const cardName = item.name || item.blueprint?.name || 'Unknown';
        const prevCard = entry.perCard.get(blueprintId) || { name: cardName, qty: 0, cents: 0 };
        prevCard.qty += qty;
        prevCard.cents += priceCents * qty;
        entry.perCard.set(blueprintId, prevCard);

        soldSets.set(exp.id, entry);
      }
    }
    hasMore = hasMore && data.length === PAGE_LIMIT;
    page++;
  }

  if (soldSets.size === 0) {
    console.log('No sales found since', dateStr);
    process.exit(0);
  }

  // Group sold sets by game
  const games = new Map(); // game_id -> { name, sets: [{id, name, qty, cents, perCard}] }
  for (const [id, info] of soldSets.entries()) {
    const gameName = gameNames.get(info.game_id) || 'Unknown Game';
    const game = games.get(info.game_id) || { name: gameName, sets: [] };
    game.sets.push({ id, name: info.name, qty: info.qty, cents: info.cents, perCard: info.perCard });
    games.set(info.game_id, game);
  }

  const gameList = Array.from(games.values()).map((g, idx) => {
    const qty = g.sets.reduce((sum, s) => sum + s.qty, 0);
    const cents = g.sets.reduce((sum, s) => sum + s.cents, 0);
    return { idx: idx + 1, ...g, qty, cents };
  });

  console.log('Games with sales since', dateStr);
  gameList.forEach(g => {
    console.log(`${g.idx}. ${g.name} (sold: ${g.qty}, ${formatUSDFromCents(g.cents)})`);
  });

  // Queue-based line reader: rl.question() can drop a 'line' event for an
  // empty string when multiple lines are already buffered (e.g. piped input).
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lineQueue = [];
  const waiters = [];
  rl.on('line', (line) => {
    if (waiters.length > 0) waiters.shift()(line);
    else lineQueue.push(line);
  });
  const ask = (q) => {
    process.stdout.write(q);
    return new Promise(resolve => {
      if (lineQueue.length > 0) resolve(lineQueue.shift());
      else waiters.push(resolve);
    });
  };

  let chosenGame = null;
  while (true) {
    const answer = await ask('Select a game by number: ');
    const num = parseInt(answer, 10);
    if (!isNaN(num) && num >= 1 && num <= gameList.length) {
      chosenGame = gameList[num - 1];
      break;
    }
    console.log('Invalid selection. Try again.');
  }

  // Display sets within the chosen game
  const setList = chosenGame.sets.map((s, idx) => ({ idx: idx + 1, ...s }));
  console.log(`\nSets sold for ${chosenGame.name} since ${dateStr}`);
  setList.forEach(s => {
    console.log(`${s.idx}. ${s.name} (sold: ${s.qty}, ${formatUSDFromCents(s.cents)})`);
  });

  let chosenSet = null;
  while (true) {
    const answer = await ask(`Select a set by number, or press Enter for the full ${chosenGame.name} total: `);
    if (answer.trim() === '') break; // no selection -> full game total
    const num = parseInt(answer, 10);
    if (!isNaN(num) && num >= 1 && num <= setList.length) {
      chosenSet = setList[num - 1];
      break;
    }
    console.log('Invalid selection. Try again.');
  }
  rl.close();

  // Aggregate results: either the chosen set, or the whole game
  let label;
  let totalSoldQty;
  let totalSoldCents;
  const perCard = new Map(); // blueprint_id -> { name, qty, totalCents }
  if (chosenSet) {
    label = `set: ${chosenSet.name}`;
    totalSoldQty = chosenSet.qty;
    totalSoldCents = chosenSet.cents;
    for (const [bpId, card] of chosenSet.perCard.entries()) {
      perCard.set(bpId, { name: card.name, qty: card.qty, totalCents: card.cents });
    }
  } else {
    label = `game: ${chosenGame.name}`;
    totalSoldQty = chosenGame.qty;
    totalSoldCents = chosenGame.cents;
    for (const set of chosenGame.sets) {
      for (const [bpId, card] of set.perCard.entries()) {
        const prev = perCard.get(bpId) || { name: card.name, qty: 0, totalCents: 0 };
        prev.qty += card.qty;
        prev.totalCents += card.cents;
        perCard.set(bpId, prev);
      }
    }
  }

  // Output summary
  const summaryLine = `Total sold: ${totalSoldQty} cards, ${formatUSDFromCents(totalSoldCents)}`;
  console.log(`\nCards sold for ${label}`);
  console.log(summaryLine);
  if (perCard.size > 0) {
    const BREAKDOWN_LIMIT = 25;
    const sorted = Array.from(perCard.values()).sort((a, b) => b.totalCents - a.totalCents);
    const rows = sorted.slice(0, BREAKDOWN_LIMIT).map(card => ({
      name: card.name,
      quantity: card.qty,
      total_usd: formatUSDFromCents(card.totalCents)
    }));
    console.log(`Breakdown by card (top ${rows.length} of ${sorted.length} by revenue):`);
    console.table(rows);
    if (sorted.length > BREAKDOWN_LIMIT) {
      console.log(`...and ${sorted.length - BREAKDOWN_LIMIT} more cards`);
    }
  }
  console.log(`\n${summaryLine}`);
})();
