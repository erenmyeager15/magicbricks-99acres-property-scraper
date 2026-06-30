# MagicBricks + 99acres Property Scraper - Prices, BHK, Area & Listings

Scrape public Indian real-estate listings from MagicBricks and 99acres, with prices, BHK, area, locality, project, images, and listing URLs. Export clean data to JSON, CSV, Excel, or HTML, or pull it via the Apify API. No source-site login or API key is required.

Built with Node.js 20, TypeScript, and the Apify SDK using native `fetch` over Apify residential proxies, with retries and resilient extraction so runs are reliable and repeatable. The actor reads each portal's structured listing data (JSON-LD and embedded page state) instead of fragile DOM scraping.

For the first run, select `magicbricks`, `sale`, `Mumbai`, leave price filters empty, set `maxResults` to `1`, and keep the recommended Residential India proxy enabled. Inspect that record, then add 99acres, more cities, or price filters.

## What It Extracts

- Property title, source (MagicBricks or 99acres), and transaction type (sale or rent)
- City queried, locality, project name, and address text when published
- Price display text and parsed INR price
- BHK, property type, area and area unit, and area type (carpet / built-up / super built-up)
- Bedrooms, bathrooms, balconies, furnishing, status, and floor when available
- Latitude and longitude when published by the source
- Image URL, listing URL, short description, and scrape timestamp
- MagicBricks and 99acres records merged into one deduplicated dataset

This independent Actor does not extract phone numbers, emails, private contact details, accounts, messages, saved properties, or private dashboard data. If sensitive text appears in a public page description, it is redacted before saving.

## Use Cases

1. Real-estate market research for brokers, agencies, and proptech teams
2. Property price monitoring and trend tracking by city and locality
3. Competitor inventory tracking across major Indian portals
4. Rental market research and housing supply analysis
5. Listing-price and location analytics across cities

## Pricing

Property records are charged only when delivered to the dataset. The `apify-actor-start` event is charged according to Actor memory, with at least one startup event.

This Actor uses Apify Pay Per Event pricing. Failed, blocked, or empty pages do not create `property-scraped` charges, but the startup event and platform resource consumption can still apply.

| Event name | Price per event | 1,000 results | 10,000 results |
| --- | ---: | ---: | ---: |
| `apify-actor-start` | $0.00005 / GB | - | - |
| `property-scraped` | $0.003 | $3.00 | $30.00 |

Cost-control tips:

- Start with MagicBricks, one city, and `maxResults: 1`.
- Leave price filters empty for the first run; unknown-price listings are excluded when filters are active.
- Set a maximum cost per run in Apify Console. The Actor stops requesting additional pages when Apify reports that limit.
- Use `both` only after checking a one-source result.

## Input

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `source` | string | yes | `magicbricks` | Which portal to scrape: `both`, `magicbricks`, or `99acres`. |
| `transactionType` | string | yes | `sale` | Listing type: `sale` or `rent`. |
| `cities` | array | yes | `["Mumbai"]` | Indian city names, e.g. Mumbai, Pune, Bengaluru, Delhi, Chennai, Hyderabad. |
| `minPrice` | integer | no | none | Optional minimum price in INR. Listings with unknown prices are skipped when a price filter is set. |
| `maxPrice` | integer | no | none | Optional maximum price in INR. Listings with unknown prices are skipped when a price filter is set. |
| `maxResults` | integer | yes | `1` | Maximum unique listings to save (1-500). Start with one result. |
| `proxyConfiguration` | object | no | Residential, IN | Apify proxy settings. Residential with India targeting recommended. |

## Example Input

```json
{
  "source": "magicbricks",
  "transactionType": "sale",
  "cities": ["Mumbai"],
  "maxResults": 1,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"],
    "apifyProxyCountry": "IN"
  }
}
```

## How to Scrape MagicBricks and 99acres (Step by Step)

1. Click **Try for free** / **Run**.
2. Choose `source`: `both`, `magicbricks`, or `99acres`.
3. Select `transactionType`: `sale` or `rent`.
4. Start with one Indian city, such as Mumbai, Pune, Bengaluru, Delhi, Chennai, or Hyderabad.
5. Leave price filters empty and set `maxResults` to `1` for the first run.
6. Run and export results as CSV, JSON, or Excel. Add sources, cities, or price filters after checking the output.

## Output dataset

```json
{
  "source": "99acres",
  "transactionType": "sale",
  "cityQuery": "Mumbai",
  "propertyId": "H91004828",
  "title": "3 BHK Flat in Sewri, Mumbai",
  "propertyType": "Apartment",
  "bhk": 3,
  "price": 63200000,
  "priceDisplay": "Rs. 6.32 Crore",
  "area": 2036,
  "areaUnit": "sqft",
  "areaType": "Super Built-up Area",
  "bedrooms": 3,
  "bathrooms": 3,
  "furnishing": "Unfurnished",
  "status": "Under construction",
  "floor": "16",
  "projectName": "Lodha Aureus , Sewri",
  "locality": "Sewri, Mumbai",
  "city": "Mumbai South",
  "address": "Lodha Aureus , Sewri, Sewri, Mumbai, Mumbai South, India",
  "latitude": 19.000645,
  "longitude": 72.854859,
  "imageUrl": "https://imagecdn.99acres.com/media1/37936/8/758728772T-1778670458404.jpg",
  "propertyUrl": "https://www.99acres.com/3-bhk-bedroom-apartment-flat-for-sale-in-sewri-south-mumbai-2036-sqft-spid-H91004828",
  "scrapedAt": "2026-06-12T19:55:25.019Z"
}
```

## API Example

```js
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: 'YOUR_API_TOKEN' });
const run = await client.actor('fascinating_lentil/magicbricks-99acres-property-scraper').call({
  source: 'magicbricks',
  transactionType: 'sale',
  cities: ['Mumbai'],
  maxResults: 1,
});
const { items } = await client.dataset(run.defaultDatasetId).listItems();
console.log(`Got ${items.length} properties`);
```

## How It Works

1. Validates input and resolves the selected sources and cities.
2. Fetches MagicBricks and 99acres search pages over Apify residential proxies with retries.
3. Extracts structured listing data (JSON-LD and embedded page state), then cleans and normalizes fields.
4. Deduplicates by property ID / URL and applies optional price filters.
5. Writes each clean record to the Apify Dataset together with the `property-scraped` charge event.

## Known Limits

- Some fields are conditional: geo coordinates, floor, balconies, and deposit are only saved when the source publishes them. MagicBricks rarely exposes coordinates, so those may be `null`.
- Price filtering skips listings with an unknown price, since they cannot be compared.
- MagicBricks and 99acres can reject datacenter traffic. The default input uses Apify Residential proxy with India targeting for reliability.
- Listing availability and prices can change after scraping; verify important decisions against the source page.

## Legal and Ethical Use

Use this Actor for legitimate public property-listing research and price monitoring. It is not affiliated with MagicBricks or 99acres. You are responsible for complying with each portal's terms, privacy laws, and local regulations wherever you use the data.

## Responsible Use

This Actor is intended for lawful collection of publicly available information only. Users are responsible for ensuring their use complies with the source website's terms, robots.txt, applicable privacy laws, including India's DPDP Act, and all local regulations.

Do not use this Actor for owner, broker, tenant, buyer, or seller lead generation, or to collect, store, sell, or misuse personal data. The Actor author is not responsible for misuse by end users.

## License

Apache-2.0. See `LICENSE`.
