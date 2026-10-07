# MagicBricks & 99acres Property Data Scraper - Search URLs, Amenities & Prices

Scrape public Indian real-estate listings from MagicBricks and 99acres, with prices, price per square foot, BHK, area, locality, furnishing, amenities, seller category, property details, images, and listing URLs. Paste full portal search URLs to preserve website filters and paginate them automatically, or configure a simple source/city search. Export clean data to JSON, CSV, Excel, or HTML, or pull it via the Apify API. No source-site login or API key is required.

Add an optional recurring watchlist to compare asking prices on repeat runs. Each row carries area-unit normalization and data-quality flags; a separate report distinguishes comparable price changes from missing or changed data. It does not guess that a listing has been sold or removed.

Built with Node.js 20, TypeScript, and the Apify SDK using HTTP requests over the configured proxy. The Actor reads each portal's structured listing data (JSON-LD and embedded page state); no browser is launched.

## Quick Start

The input form is ready to run without editing: it collects one Mumbai property-for-sale listing from MagicBricks through the recommended Residential India proxy. Click **Start**, inspect the clean dataset record, and then increase the result limit or change the portal, city, transaction type, or filters.

If you already filtered a search on MagicBricks or 99acres, paste the complete results-page URL in **Exact portal search**. That keeps the portal's locality, BHK, property type, furnishing, budget, and posted-by filters.

## What It Extracts

- Property title, source (MagicBricks or 99acres), and transaction type (sale or rent)
- City queried, locality, project name, and address text when published
- Price display text and parsed INR price
- Normalized price per square foot when the listing publishes a usable price and area
- BHK, property type, area and area unit, and area type (carpet / built-up / super built-up)
- Bedrooms, bathrooms, balconies, furnishing, status, and floor when available
- Public seller category (owner, agent, or builder), verification/featured markers, and posting date when published
- Property age, facing, ownership, parking, RERA ID, maintenance, and detected amenities
- Latitude and longitude when published by the source
- Primary image, published card image URLs, image count, listing URL, and short description
- Search-page URL, page number, and result position for traceability
- Both portals combined in one dataset, with deduplication inside each portal; numeric IDs from different portals are kept separate
- Normalized square feet (`areaSqft`), asking-price basis, and explicit missing/range/unsupported-unit flags

## Recurring property watchlists

Set `monitorStoreName` to a stable name and schedule identical search inputs and result limits. The first successful observation creates a baseline; later runs write:

- `PROPERTY_REPORT`: `FIRST_SEEN`, `PRICE_INCREASE`, `PRICE_DECREASE`, `UPDATED`, `UNCHANGED`, or `NOT_OBSERVED`, with prior/current prices, percentage changes, first/last-seen times and coverage.
- `PROPERTY_CHANGES.csv`: the same listing changes in a spreadsheet-friendly export. `priceAlert` marks comparable changes meeting `priceChangeThresholdPercent` (default 5%); it does not send a notification.
- Like-for-like sample medians only when at least three usable rows share transaction type, rent period, locality, property type, BHK and area basis. These are sample statistics, not valuations or full-market averages.
- `RUN_SUMMARY`: delivered rows, failed/processed pages, source coverage, repeated pagination and result/spending-limit flags, even without monitoring.

`FIRST_SEEN` means first observed by this watchlist, not newly posted. `NOT_OBSERVED` means absent from this bounded run, **not sold, rented or removed**. Rank changes, filters, result caps and source failures can all hide listings. A price alert requires usable, non-range prices with unchanged area and asking-price basis; unsupported units and unknown rental periods are not silently compared.

Watchlist state is scoped to the initiating Apify account, capped at 2,000 listings with 10 observations each, and drops listings unobserved for over 30 days. It requires an Apify platform run. A new search/filter/limit needs a new store name; use one non-overlapping schedule per watchlist. Concurrent or stale writes are rejected. Core rows remain available if a monitor update fails, but that run fails visibly; the error report distinguishes a confirmed commit, a non-commit and an ambiguous write (`historyCommitted: "unknown"`). It does not promise an atomic rollback after a network timeout.

This independent Actor does not extract phone numbers, emails, private contact details, accounts, messages, saved properties, or private dashboard data. If sensitive text appears in a public page description, it is redacted before saving.

## Use Cases

1. Real-estate market research for brokers, agencies, and proptech teams
2. Property price monitoring and trend tracking by city and locality
3. Competitor inventory tracking across major Indian portals
4. Rental market research and housing supply analysis
5. Listing-price and location analytics across cities

## Pricing

Property records are charged only when delivered to the dataset. The `apify-actor-start` event is charged according to Actor memory, with at least one startup event.

This Actor uses Apify Pay Per Event pricing, with platform usage included. Failed, blocked, or empty pages do not create `property-scraped` charges; the startup event can still apply. Confirmed empty searches can finish with an empty dataset. An unrecognized page is a failure, not proof of no listings. Partial source failures are disclosed in `RUN_SUMMARY`; an all-failed scrape, billing failure or requested monitor-update failure fails the run.

| Event name | Price per event | 1,000 results | 10,000 results |
| --- | ---: | ---: | ---: |
| `apify-actor-start` | $0.00005 / GB | - | - |
| `property-scraped` | $0.003 | $3.00 | $30.00 |

Store-tier property prices are $3/1,000 (Free), $2.85 (Bronze), $2.70 (Silver), and $2.55 (Gold/Platinum/Diamond). Monitoring and its report have no additional Actor event fee; repeated runs still charge for each delivered property. See the Store pricing tab for your active tier.

Cost-control tips:

- Run the prefilled MagicBricks + Mumbai sample with `maxResults: 1`.
- Leave price filters empty for the first run; unknown-price listings are excluded when filters are active.
- Set a maximum cost per run in Apify Console. The Actor stops requesting additional pages when Apify reports that limit.
- Use `both` only after checking a one-source result.

## Input

| Field | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `searchUrls` | array | no | `[]` | Up to 10 full MagicBricks or 99acres search-result URLs. Preserves portal filters, paginates toward `maxResults`, and overrides the simple source/city search. |
| `source` | string | yes | `magicbricks` | Which portal to scrape: `both`, `magicbricks`, or `99acres`. |
| `transactionType` | string | yes | `sale` | Listing type: `sale` or `rent`. |
| `cities` | array | yes | `["Mumbai"]` | Indian city names, e.g. Mumbai, Bengaluru, Pune, Delhi, Chennai, Hyderabad. |
| `minPrice` | integer | no | none | Optional minimum price in INR. Listings with unknown prices are skipped when a price filter is set. |
| `maxPrice` | integer | no | none | Optional maximum price in INR. Listings with unknown prices are skipped when a price filter is set. |
| `maxResults` | integer | yes | `1` | Maximum unique listings to save (1-500). Start with one result. |
| `proxyConfiguration` | object | no | Residential, IN | Apify proxy settings. Residential with India targeting recommended. |
| `monitorStoreName` | string | no | disabled | Stable watchlist name, 1-63 letters, digits, underscores or hyphens. Reuse only with the same search/filter/limit inputs. |
| `priceChangeThresholdPercent` | number | no | `5` | Comparable price-change alert threshold, 0-100%. Used only with monitoring. |

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

To keep the filters selected on a portal, paste the complete results-page URL instead:

```json
{
  "searchUrls": [
    "https://www.magicbricks.com/property-for-rent/residential-real-estate?cityName=Pune&bedroom=3&budgetMax=50000"
  ],
  "maxResults": 25,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"],
    "apifyProxyCountry": "IN"
  }
}
```

## How to Scrape MagicBricks and 99acres (Step by Step)

1. Click **Try for free** / **Run**.
2. For an exact filtered search, paste one or more portal result URLs in `searchUrls`.
3. For a simple search, choose `source`, `transactionType`, and one or more cities.
4. Run the prefilled Mumbai example first, or use one URL or one city such as Bengaluru, Pune, Delhi, Chennai, or Hyderabad.
5. Leave price filters empty and set `maxResults` to `1` for the first run.
6. Run and export results as CSV, JSON, or Excel. Add sources, cities, or price filters after checking the output.

For a watchlist, add `"monitorStoreName": "mumbai-sale-watch"` and `"priceChangeThresholdPercent": 5` to the input, keep the source/search, filters and `maxResults` unchanged, then schedule a repeat. Inspect `PROPERTY_REPORT` rather than interpreting an absent row as a deleted listing. No cross-portal entity matching or private contact harvesting is performed.

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
  "pricePerSqft": 31041,
  "area": 2036,
  "areaUnit": "sqft",
  "areaType": "Super Built-up Area",
  "bedrooms": 3,
  "bathrooms": 3,
  "furnishing": "Unfurnished",
  "status": "Under construction",
  "floor": "16",
  "listedBy": "Builder",
  "propertyAge": "0-1 year old",
  "facing": "East",
  "parking": "1 Covered Parking",
  "amenities": ["Lift", "Security", "Power Backup"],
  "projectName": "Lodha Aureus , Sewri",
  "locality": "Sewri, Mumbai",
  "city": "Mumbai South",
  "address": "Lodha Aureus , Sewri, Sewri, Mumbai, Mumbai South, India",
  "latitude": 19.000645,
  "longitude": 72.854859,
  "imageUrl": "https://imagecdn.99acres.com/media1/37936/8/758728772T-1778670458404.jpg",
  "imageUrls": ["https://imagecdn.99acres.com/media1/37936/8/758728772T-1778670458404.jpg"],
  "imagesCount": 1,
  "propertyUrl": "https://www.99acres.com/3-bhk-bedroom-apartment-flat-for-sale-in-sewri-south-mumbai-2036-sqft-spid-H91004828",
  "searchPage": 1,
  "resultPosition": 1,
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

1. Validates full search URLs, or resolves the selected sources and cities.
2. Fetches the supplied search URL without rewriting its filters, then follows bounded result pages toward `maxResults`; or builds simple portal search URLs.
3. Extracts structured listing data (JSON-LD and embedded page state), then cleans and normalizes fields.
4. Deduplicates by portal plus property ID / URL and applies optional price filters.
5. Writes each clean record to the Apify Dataset together with the `property-scraped` charge event.
6. Writes coverage and, if selected, compares the bounded sample with the watchlist's prior observation.

## Known Limits

- Many detail fields are conditional: geo coordinates, seller category, RERA ID, floor, balconies, parking, and deposit are only saved when the source publishes them. MagicBricks rarely exposes coordinates, so those may be `null`.
- Price filtering skips listings with an unknown price, since they cannot be compared.
- MagicBricks and 99acres can reject datacenter traffic. The default input uses Apify Residential proxy with India targeting for reliability.
- Listing availability and prices can change after scraping; verify important decisions against the source page.
- Pagination is bounded to 20 pages per search. Highly repetitive pages can yield fewer unique records than `maxResults`.
- The Actor stops a search after two failed pages or an all-duplicate page, rather than repeatedly fetching a blocked/repeated search.
- MagicBricks HTML can stop early only after enough complete, uniquely matched, priced/area-bearing cards pass your filters and an earlier complete JSON-LD ItemList supplies their identities. Uncertain formats and 99acres continue through the bounded full response. `RUN_SUMMARY.earlyStoppedPages` reports use of this path; `decodedHtmlBytesRead` is client-side decoded traffic, **not** proxy-billed bytes or a guaranteed saving.
- One combined dataset does not mean identical properties on different portals are entity-matched. Portal IDs stay separate to avoid false merges.
- This is a search-card/state scraper, not an exhaustive detail-page, historical-price or full-market archive. Conditional source fields are not guaranteed.
- The same physical property can appear on both portals. Sample sizes count listing rows, not verified unique homes; cross-portal entity matching is not performed.

## Legal and Ethical Use

Use this Actor for legitimate public property-listing research and price monitoring. It is not affiliated with MagicBricks or 99acres. You are responsible for complying with each portal's terms, privacy laws, and local regulations wherever you use the data.

## Responsible Use

This Actor is intended for lawful collection of publicly available information only. Users are responsible for ensuring their use complies with the source website's terms, robots.txt, applicable privacy laws, including India's DPDP Act, and all local regulations.

Do not use this Actor for owner, broker, tenant, buyer, or seller lead generation, or to collect, store, sell, or misuse personal data. The Actor author is not responsible for misuse by end users.

## License

Apache-2.0. See `LICENSE`.
