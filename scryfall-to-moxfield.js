#!/usr/bin/env node
/**
 * scryfall-to-moxfield.js
 * 
 * Fetches cards matching a Scryfall search query and outputs them in a format
 * that can be imported into Moxfield. Useful for keeping a Moxfield deck in sync
 * with a dynamic Scryfall search (e.g., all textless cards).
 * 
 * Usage:
 *   node scryfall-to-moxfield.js "is:textless" --unique=art
 *   node scryfall-to-moxfield.js "is:textless" --unique=art --output=textless-cards.txt
 *   node scryfall-to-moxfield.js "is:textless" --unique=art --format=mtgo
 * 
 * Options:
 *   --unique=art|prints|cards  Scryfall unique mode (default: art)
 *   --output=FILE              Write to file instead of stdout
 *   --format=moxfield|mtgo     Output format (default: moxfield)
 *   --delay=MS                 Delay between API requests in ms (default: 100)
 *   --json                     Output raw JSON instead of text list
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

// ANSI colors for terminal output
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    query: null,
    unique: 'art',
    output: null,
    format: 'moxfield',
    delay: 100,
    json: false,
  };

  for (const arg of args) {
    if (arg.startsWith('--unique=')) {
      options.unique = arg.split('=')[1];
    } else if (arg.startsWith('--output=')) {
      options.output = arg.split('=')[1];
    } else if (arg.startsWith('--format=')) {
      options.format = arg.split('=')[1];
    } else if (arg.startsWith('--delay=')) {
      options.delay = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--json') {
      options.json = true;
    } else if (!arg.startsWith('--') && !options.query) {
      options.query = arg;
    }
  }

  return options;
}

// Make HTTPS GET request with proper headers for Scryfall
function scryfallGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'ScryfallToMoxfield/1.0 (cardTrader-scripts)',
        'Accept': 'application/json;q=0.9,*/*;q=0.8',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
  });
}

// Sleep helper to respect rate limits
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Fetch all cards from Scryfall search with pagination
async function fetchAllCards(query, unique, delayMs) {
  const allCards = [];
  let page = 1;
  let hasMore = true;
  
  const baseUrl = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&unique=${unique}&order=name`;
  
  process.stderr.write(`${ANSI.cyan}Fetching cards matching: ${ANSI.bold}${query}${ANSI.reset}\n`);
  process.stderr.write(`${ANSI.dim}Unique mode: ${unique}${ANSI.reset}\n\n`);

  while (hasMore) {
    const url = `${baseUrl}&page=${page}`;
    process.stderr.write(`${ANSI.dim}  Page ${page}...${ANSI.reset}`);
    
    try {
      const response = await scryfallGet(url);
      
      if (response.object === 'error') {
        throw new Error(response.details || response.message || 'Unknown Scryfall error');
      }
      
      const cards = response.data || [];
      allCards.push(...cards);
      
      process.stderr.write(` ${cards.length} cards (total: ${allCards.length})\n`);
      
      hasMore = response.has_more === true;
      if (hasMore) {
        page++;
        await sleep(delayMs); // Respect rate limits
      }
    } catch (error) {
      process.stderr.write(`\n${ANSI.red}Error on page ${page}: ${error.message}${ANSI.reset}\n`);
      throw error;
    }
  }
  
  process.stderr.write(`\n${ANSI.green}✓ Fetched ${allCards.length} total cards${ANSI.reset}\n\n`);
  return allCards;
}

// Format card for Moxfield import
// Format: 1 Card Name (SET) CollectorNumber
// For foils or specific finishes: 1 Card Name (SET) CollectorNumber *F*
function formatForMoxfield(card) {
  const name = card.name;
  const set = card.set.toUpperCase();
  const collectorNumber = card.collector_number;
  
  // Moxfield format: 1 Card Name (SET) CollectorNumber
  return `1 ${name} (${set}) ${collectorNumber}`;
}

// Format card for MTGO import (simpler format)
// Format: 1 Card Name
function formatForMTGO(card) {
  return `1 ${card.name}`;
}

// Format card based on selected format
function formatCard(card, format) {
  switch (format) {
    case 'mtgo':
      return formatForMTGO(card);
    case 'moxfield':
    default:
      return formatForMoxfield(card);
  }
}

// Main function
async function main() {
  const options = parseArgs();
  
  if (!options.query) {
    console.error(`${ANSI.bold}Scryfall to Moxfield Sync Tool${ANSI.reset}
    
${ANSI.yellow}Usage:${ANSI.reset}
  node scryfall-to-moxfield.js "SCRYFALL_QUERY" [options]

${ANSI.yellow}Examples:${ANSI.reset}
  node scryfall-to-moxfield.js "is:textless"
  node scryfall-to-moxfield.js "is:textless" --unique=art
  node scryfall-to-moxfield.js "set:lea" --unique=prints --output=alpha.txt
  node scryfall-to-moxfield.js "t:legendary t:creature" --format=mtgo

${ANSI.yellow}Options:${ANSI.reset}
  --unique=art|prints|cards   Scryfall unique mode (default: art)
  --output=FILE               Write to file instead of stdout
  --format=moxfield|mtgo      Output format (default: moxfield)
  --delay=MS                  Delay between requests in ms (default: 100)
  --json                      Output raw JSON data

${ANSI.yellow}Moxfield Import:${ANSI.reset}
  1. Copy the output (or use --output to save to file)
  2. Go to your Moxfield deck
  3. Click "More" → "Import" or use the import feature
  4. Paste the card list
`);
    process.exit(1);
  }

  try {
    const cards = await fetchAllCards(options.query, options.unique, options.delay);
    
    let output;
    if (options.json) {
      // Output raw JSON
      output = JSON.stringify(cards, null, 2);
    } else {
      // Format each card for import
      const lines = cards.map(card => formatCard(card, options.format));
      output = lines.join('\n');
    }
    
    if (options.output) {
      // Write to file
      fs.writeFileSync(options.output, output, 'utf8');
      process.stderr.write(`${ANSI.green}✓ Written to ${options.output}${ANSI.reset}\n`);
    } else {
      // Output to stdout
      console.log(output);
    }
    
    // Summary stats to stderr
    process.stderr.write(`\n${ANSI.bold}Summary:${ANSI.reset}\n`);
    process.stderr.write(`  Total cards: ${cards.length}\n`);
    
    // Count unique card names
    const uniqueNames = new Set(cards.map(c => c.name));
    process.stderr.write(`  Unique card names: ${uniqueNames.size}\n`);
    
    // Count sets
    const sets = new Set(cards.map(c => c.set));
    process.stderr.write(`  Sets represented: ${sets.size}\n`);
    
  } catch (error) {
    console.error(`${ANSI.red}Error: ${error.message}${ANSI.reset}`);
    process.exit(1);
  }
}

main();
