require('dotenv').config();

const API_URL = 'https://api.cardtrader.com/api/v2';
const API_TOKEN = process.env.API_TOKEN;

// Helper function for comparison
function compare(price, comparison, value) {
  if (comparison === 'greater') return price > value;
  if (comparison === 'less') return price < value;
  if (comparison === 'equal') return price === value;
  throw new Error('Invalid comparison type. Use "greater", "less", or "equal".');
}

(async function() {
  // Parse command line arguments
  const [, , comparison, valueStr] = process.argv;
  const value = parseInt(valueStr, 10);

  if (!['greater', 'less', 'equal'].includes(comparison) || isNaN(value)) {
    console.error('Usage: node script.js [greater|less|equal] [price_in_cents]');
    process.exit(1);
  }

  let page = 1;
  let totalCount = 0;
  let hasMore = true;

  while (hasMore) {
    const res = await fetch(`${API_URL}/products/export?page=${page}`, {
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

    // Filter according to comparison and value
    const filtered = data.filter(
      product => compare(product.price_cents, comparison, value)
    );

    totalCount += filtered.reduce((acc, product) => acc + (product.quantity || 1), 0);

    hasMore = data.length > 0 && data.length === 50;
    page++;
  }

  console.log(`You have ${totalCount} cards listed with price ${comparison} ${value} cents.`);
})();

