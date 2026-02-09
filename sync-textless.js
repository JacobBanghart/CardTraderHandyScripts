#!/usr/bin/env node
/**
 * sync-textless.js
 * 
 * Fetches all textless Magic cards from Scryfall and saves them
 * in Moxfield import format to textless-cards.txt
 * 
 * Usage: node sync-textless.js
 */

const fs = require('fs');
const https = require('https');

const OUTPUT_FILE = 'textless-cards.txt';
const QUERY = 'is:textless';
const UNIQUE = 'art';

function scryfallGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'ScryfallToMoxfield/1.0',
        'Accept': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async function() {
  const cards = [];
  let hasMore = true;
  let page = 1;
  
  console.log(`Fetching textless cards from Scryfall...`);
  
  while (hasMore) {
    const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(QUERY)}&unique=${UNIQUE}&order=name&page=${page}`;
    const res = await scryfallGet(url);
    
    if (res.object === 'error') throw new Error(res.details);
    
    cards.push(...res.data);
    console.log(`  Page ${page}: ${res.data.length} cards (total: ${cards.length})`);
    
    hasMore = res.has_more;
    if (hasMore) {
      page++;
      await sleep(100);
    }
  }
  
  // Format for Moxfield: 1 Card Name (SET) CollectorNumber
  const lines = cards.map(c => `1 ${c.name} (${c.set.toUpperCase()}) ${c.collector_number}`);
  
  fs.writeFileSync(OUTPUT_FILE, lines.join('\n'), 'utf8');
  
  console.log(`\n✓ Saved ${cards.length} cards to ${OUTPUT_FILE}`);
  console.log(`\nNow paste the contents into Moxfield's bulk edit tool!`);
})();
