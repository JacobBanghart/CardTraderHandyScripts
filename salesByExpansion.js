require('@dotenvx/dotenvx').config();

const fs = require('fs');
const path = require('path');

const API_URL = (process.env.API_URL?.replace(/\/$/, '')) || 'https://api.cardtrader.com/api/v2';
const API_TOKEN = process.env.API_TOKEN;
const PAGE_LIMIT = parseInt(process.env.PAGE_LIMIT || '200', 10);
const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), '.cache');
const CACHE_TTL_HOURS = parseInt(process.env.CACHE_TTL_HOURS || '168', 10);
const CACHE_TTL_MS = CACHE_TTL_HOURS * 60 * 60 * 1000;
const ORDERS_CACHE_TTL_MS = 1 * 60 * 60 * 1000; // 1 hour for orders

(async function() {
  if (!API_TOKEN) {
    console.error('Missing API_TOKEN in environment (.env)');
    process.exit(1);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  const formatUSDFromCents = (cents) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((cents ?? 0) / 100);

  const ensureCacheDir = () => {
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}
  };

  const readJsonIfFresh = (file, ttl = CACHE_TTL_MS) => {
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > ttl) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) { return null; }
  };

  const writeJson = (file, data) => {
    try {
      ensureCacheDir();
      fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    } catch (_) {}
  };

  // ─── ANSI helpers ──────────────────────────────────────────────────────────
  const CSI = '\x1b[';
  const clear = () => process.stdout.write(CSI + '2J' + CSI + 'H');
  const moveTo = (row, col) => process.stdout.write(CSI + row + ';' + col + 'H');
  const hideCursor = () => process.stdout.write(CSI + '?25l');
  const showCursor = () => process.stdout.write(CSI + '?25h');
  const bold = (s) => CSI + '1m' + s + CSI + '0m';
  const dim = (s) => CSI + '2m' + s + CSI + '0m';
  const inverse = (s) => CSI + '7m' + s + CSI + '0m';
  const green = (s) => CSI + '32m' + s + CSI + '0m';
  const yellow = (s) => CSI + '33m' + s + CSI + '0m';
  const cyan = (s) => CSI + '36m' + s + CSI + '0m';

  // ─── Fetch categories ──────────────────────────────────────────────────────
  const catCachePath = path.join(CACHE_DIR, 'categories.json');
  let categories = readJsonIfFresh(catCachePath);
  if (!Array.isArray(categories)) {
    process.stdout.write('Fetching categories...\n');
    const res = await fetch(`${API_URL}/categories`, {
      headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }
    });
    if (!res.ok) { console.error('Failed to fetch categories'); process.exit(1); }
    categories = await res.json();
    if (Array.isArray(categories)) writeJson(catCachePath, categories);
  }

  // ─── Extract unique games from categories ──────────────────────────────────
  const gamesMap = new Map();
  for (const cat of categories) {
    if (!gamesMap.has(cat.game_id)) {
      // Extract game name by removing category suffix
      const name = cat.name.replace(/ (Single Card|Token|Emblem|Booster|Starter|Playmat|Sleeve|Storage|Album|Bundle|Action|Sealed|Accessories|Art|Equipment|Deckbox|Playset|Oversized|Insert|Promo|Basic Land|Special|Card Back|Heroes|Display|Structure|Deck Box|Theme Deck|Prerelease|Fat Pack|Intro Pack|Gift|Challenger|Battle|Commander|Duel|Premium|Anthology|World|Secret|Archenemy|Planechase|Conspiracy|Deckmasters|Masters|From the Vault|Clash|Game Day|Event|League|Spin|Dice|Tin|Playsets|Box|Set|Pack|Kit|Case|Lot|Collection|Other|Counter|Marker|Life|Board|Mat|Binder|Portfolio|Card|Cards|Foil|Non-Foil|English|Japanese|Korean|Chinese|German|French|Spanish|Italian|Portuguese|Russian).*/i, '');
      gamesMap.set(cat.game_id, { id: cat.game_id, name: name.trim() });
    }
  }
  const games = [...gamesMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  // ─── Fetch expansions ──────────────────────────────────────────────────────
  const expCachePath = path.join(CACHE_DIR, 'expansions.json');
  let expansions = readJsonIfFresh(expCachePath);
  if (!Array.isArray(expansions)) {
    process.stdout.write('Fetching expansions...\n');
    const res = await fetch(`${API_URL}/expansions`, {
      headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }
    });
    if (!res.ok) { console.error('Failed to fetch expansions'); process.exit(1); }
    expansions = await res.json();
    if (Array.isArray(expansions)) writeJson(expCachePath, expansions);
  }

  // ─── Fetch orders (with cache) ─────────────────────────────────────────────
  const fetchAllOrders = async () => {
    const ordersCachePath = path.join(CACHE_DIR, 'orders_all.json');
    let orders = readJsonIfFresh(ordersCachePath, ORDERS_CACHE_TTL_MS);
    if (Array.isArray(orders)) {
      return orders;
    }

    orders = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      moveTo(process.stdout.rows - 1, 1);
      process.stdout.write(CSI + 'K' + dim(`Fetching orders page ${page}...`));
      const res = await fetch(`${API_URL}/orders?sort=date.desc&page=${page}&limit=${PAGE_LIMIT}`, {
        headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }
      });
      if (!res.ok) { console.error('Failed to fetch orders'); process.exit(1); }
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) break;
      orders.push(...data);
      hasMore = data.length === PAGE_LIMIT;
      page++;
    }
    writeJson(ordersCachePath, orders);
    return orders;
  };

  // ─── TUI State ─────────────────────────────────────────────────────────────
  let state = 'game-select'; // 'game-select' | 'expansion-select' | 'results'
  let selectedGameId = null;
  let cursor = 0;
  let scrollOffset = 0;
  let filterMode = false;
  let filterText = '';
  let markedExpansions = new Set(); // expansion IDs

  const getVisibleRows = () => process.stdout.rows - 6; // reserve lines for header/footer

  // ─── Render functions ──────────────────────────────────────────────────────
  const renderGameSelect = () => {
    clear();
    const visibleRows = getVisibleRows();
    const filtered = games.filter(g =>
      g.name.toLowerCase().includes(filterText.toLowerCase())
    );
    
    moveTo(1, 1);
    process.stdout.write(bold('Select a Game') + (filterMode ? yellow('  /' + filterText + '▌') : dim('  (press / to filter)')));
    moveTo(2, 1);
    process.stdout.write(dim('─'.repeat(process.stdout.columns - 1)));

    if (filtered.length === 0) {
      moveTo(3, 1);
      process.stdout.write(dim('No games found'));
    } else {
      if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
      if (cursor < scrollOffset) scrollOffset = cursor;
      if (cursor >= scrollOffset + visibleRows) scrollOffset = cursor - visibleRows + 1;

      for (let i = 0; i < visibleRows && i + scrollOffset < filtered.length; i++) {
        const game = filtered[i + scrollOffset];
        if (!game) continue;
        const isCursor = i + scrollOffset === cursor;
        const expCount = expansions.filter(e => e.game_id === game.id).length;
        moveTo(3 + i, 1);
        const line = `${game.name} ${dim(`(${expCount} sets)`)}`;
        process.stdout.write(isCursor ? inverse(' ' + line.padEnd(process.stdout.columns - 2) + ' ') : ' ' + line);
      }
    }

    moveTo(process.stdout.rows - 2, 1);
    process.stdout.write(dim('─'.repeat(process.stdout.columns - 1)));
    moveTo(process.stdout.rows - 1, 1);
    process.stdout.write(dim('↑↓ navigate  ') + dim('/ filter  ') + dim('Enter select  ') + dim('q quit'));
    moveTo(process.stdout.rows, 1);
    process.stdout.write(dim(`${filtered.length} games`));
  };

  const renderExpansionSelect = () => {
    clear();
    const visibleRows = getVisibleRows();
    const gameName = games.find(g => g.id === selectedGameId)?.name || 'Unknown';
    const gameExpansions = expansions.filter(e => e.game_id === selectedGameId);
    const filtered = gameExpansions.filter(e =>
      e.name.toLowerCase().includes(filterText.toLowerCase())
    );

    moveTo(1, 1);
    process.stdout.write(bold(gameName + ' Expansions') + (filterMode ? yellow('  /' + filterText + '▌') : dim('  (press / to filter)')));
    moveTo(2, 1);
    process.stdout.write(dim('─'.repeat(process.stdout.columns - 1)));

    if (filtered.length === 0) {
      moveTo(3, 1);
      process.stdout.write(dim('No expansions found'));
    } else {
      if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
      if (cursor < scrollOffset) scrollOffset = cursor;
      if (cursor >= scrollOffset + visibleRows) scrollOffset = cursor - visibleRows + 1;

      for (let i = 0; i < visibleRows && i + scrollOffset < filtered.length; i++) {
        const exp = filtered[i + scrollOffset];
        if (!exp) continue;
        const isCursor = i + scrollOffset === cursor;
        const isMarked = markedExpansions.has(exp.id);
        moveTo(3 + i, 1);
        const marker = isMarked ? green('[✓]') : '[ ]';
        const line = `${marker} ${exp.name}`;
        process.stdout.write(isCursor ? inverse(' ' + line.padEnd(process.stdout.columns - 2) + ' ') : ' ' + line);
      }
    }

    moveTo(process.stdout.rows - 2, 1);
    process.stdout.write(dim('─'.repeat(process.stdout.columns - 1)));
    moveTo(process.stdout.rows - 1, 1);
    process.stdout.write(dim('↑↓ navigate  ') + dim('Space mark  ') + dim('/ filter  ') + cyan('Enter calculate  ') + dim('Esc back  ') + dim('q quit'));
    moveTo(process.stdout.rows, 1);
    process.stdout.write(dim(`${filtered.length} expansions`) + '  ' + green(`${markedExpansions.size} selected`));
  };

  const renderResults = async () => {
    clear();
    moveTo(1, 1);
    process.stdout.write(bold('Calculating Lifetime Sales...'));
    
    const orders = await fetchAllOrders();
    
    // Build a map of expansion names for matching (order items have name, not ID)
    const expNameToId = new Map();
    for (const exp of expansions) {
      expNameToId.set(exp.name.toLowerCase(), exp.id);
    }
    
    // Calculate sales per marked expansion
    const results = [];
    for (const expId of markedExpansions) {
      const exp = expansions.find(e => e.id === expId);
      const expName = exp?.name?.toLowerCase() || '';
      let totalCents = 0;
      let totalQty = 0;
      const cardBreakdown = new Map();

      for (const order of orders) {
        const items = order.order_items || order.items || [];
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          // Match by expansion name (order items have expansion as string)
          const itemExpName = (item.expansion || '').toLowerCase();
          if (itemExpName === expName) {
            const qty = item.quantity ?? 1;
            const priceCents = item.seller_price?.cents 
              ?? item.price_cents 
              ?? (typeof item.price === 'number' ? Math.round(item.price * 100) : 0);
            totalCents += priceCents * qty;
            totalQty += qty;

            const name = item.name || item.blueprint?.name || 'Unknown';
            const prev = cardBreakdown.get(name) || { qty: 0, cents: 0 };
            cardBreakdown.set(name, { qty: prev.qty + qty, cents: prev.cents + priceCents * qty });
          }
        }
      }

      results.push({
        id: expId,
        name: exp?.name || 'Unknown',
        totalCents,
        totalQty,
        cardBreakdown
      });
    }

    clear();
    moveTo(1, 1);
    process.stdout.write(bold('Lifetime Sales Results'));
    moveTo(2, 1);
    process.stdout.write(dim('═'.repeat(process.stdout.columns - 1)));

    let row = 3;
    let grandTotalCents = 0;
    let grandTotalQty = 0;

    for (const r of results) {
      grandTotalCents += r.totalCents;
      grandTotalQty += r.totalQty;
      moveTo(row++, 1);
      process.stdout.write(bold(r.name));
      moveTo(row++, 1);
      process.stdout.write(`  Cards sold: ${cyan(r.totalQty.toString())}  |  Revenue: ${green(formatUSDFromCents(r.totalCents))}`);
      
      // Top 5 cards
      if (r.cardBreakdown.size > 0) {
        const sorted = [...r.cardBreakdown.entries()].sort((a, b) => b[1].cents - a[1].cents).slice(0, 5);
        for (const [name, data] of sorted) {
          moveTo(row++, 1);
          process.stdout.write(dim(`    ${name}: ${data.qty}x = ${formatUSDFromCents(data.cents)}`));
        }
      }
      moveTo(row++, 1);
      process.stdout.write(dim('─'.repeat(process.stdout.columns - 1)));
    }

    moveTo(row++, 1);
    process.stdout.write(bold('GRAND TOTAL'));
    moveTo(row++, 1);
    process.stdout.write(`  Cards: ${cyan(grandTotalQty.toString())}  |  Revenue: ${green(formatUSDFromCents(grandTotalCents))}`);

    moveTo(process.stdout.rows - 1, 1);
    process.stdout.write(dim('Press any key to go back, q to quit'));
  };

  const render = () => {
    if (state === 'game-select') renderGameSelect();
    else if (state === 'expansion-select') renderExpansionSelect();
  };

  // ─── Input handling ────────────────────────────────────────────────────────
  const handleInput = async (key) => {
    const gameExpansions = expansions.filter(e => e.game_id === selectedGameId);
    const filteredGames = games.filter(g => g.name.toLowerCase().includes(filterText.toLowerCase()));
    const filteredExps = gameExpansions.filter(e => e.name.toLowerCase().includes(filterText.toLowerCase()));

    if (state === 'results') {
      if (key === 'q') {
        showCursor();
        process.exit(0);
      }
      state = 'expansion-select';
      render();
      return;
    }

    // Filter mode input
    if (filterMode) {
      if (key === '\x1b' || key === '\r') { // Escape or Enter exits filter mode
        filterMode = false;
        render();
        return;
      }
      if (key === '\x7f' || key === '\b') { // Backspace
        filterText = filterText.slice(0, -1);
        cursor = 0;
        scrollOffset = 0;
        render();
        return;
      }
      if (key.length === 1 && key >= ' ') {
        filterText += key;
        cursor = 0;
        scrollOffset = 0;
        render();
        return;
      }
      return;
    }

    // Normal mode
    if (key === 'q') {
      showCursor();
      process.exit(0);
    }

    if (key === '/') {
      filterMode = true;
      filterText = '';
      render();
      return;
    }

    // Arrow keys (escape sequences)
    if (key === '\x1b[A' || key === 'k') { // Up
      cursor = Math.max(0, cursor - 1);
      render();
      return;
    }
    if (key === '\x1b[B' || key === 'j') { // Down
      const maxIdx = state === 'game-select' ? filteredGames.length - 1 : filteredExps.length - 1;
      cursor = Math.min(maxIdx, cursor + 1);
      render();
      return;
    }

    if (key === '\x1b' && state === 'expansion-select') { // Escape - go back
      state = 'game-select';
      cursor = 0;
      scrollOffset = 0;
      filterText = '';
      markedExpansions.clear();
      render();
      return;
    }

    if (key === ' ' && state === 'expansion-select') { // Space - toggle mark
      const exp = filteredExps[cursor];
      if (exp) {
        if (markedExpansions.has(exp.id)) markedExpansions.delete(exp.id);
        else markedExpansions.add(exp.id);
      }
      render();
      return;
    }

    if (key === '\r') { // Enter
      if (state === 'game-select') {
        const game = filteredGames[cursor];
        if (game) {
          selectedGameId = game.id;
          state = 'expansion-select';
          cursor = 0;
          scrollOffset = 0;
          filterText = '';
          render();
        }
        return;
      }
      if (state === 'expansion-select' && markedExpansions.size > 0) {
        state = 'results';
        await renderResults();
        return;
      }
    }
  };

  // ─── Main loop ─────────────────────────────────────────────────────────────
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  hideCursor();

  process.on('exit', () => showCursor());
  process.on('SIGINT', () => { showCursor(); process.exit(0); });

  render();

  let escapeBuffer = '';
  process.stdin.on('data', async (data) => {
    // Handle escape sequences
    for (const char of data) {
      if (escapeBuffer.length > 0) {
        escapeBuffer += char;
        if (escapeBuffer.length === 3 && escapeBuffer.startsWith('\x1b[')) {
          await handleInput(escapeBuffer);
          escapeBuffer = '';
          continue;
        }
        if (escapeBuffer.length >= 3) {
          escapeBuffer = '';
        }
        continue;
      }
      if (char === '\x1b') {
        escapeBuffer = '\x1b';
        // Set timeout to handle bare escape key
        setTimeout(async () => {
          if (escapeBuffer === '\x1b') {
            await handleInput('\x1b');
            escapeBuffer = '';
          }
        }, 50);
        continue;
      }
      await handleInput(char);
    }
  });
})();
