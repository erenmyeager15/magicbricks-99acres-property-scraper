# MagicBricks + 99acres Property Scraper Promotion Notes

## Positioning

Collect structured public Indian property listings from MagicBricks and 99acres for market research, price monitoring, and inventory analysis.

## Best small demo

- Source: `magicbricks`
- Transaction: `sale`
- City: `Mumbai`
- Maximum results: `1`
- Price filters: empty
- Proxy: Apify Residential, country `IN`

Show the input, one clean property row, and JSON or CSV export. Mention that selecting `both` merges and deduplicates records across the two portals.

## LinkedIn draft

I published a MagicBricks + 99acres Property Scraper on Apify for structured Indian real-estate research.

It collects public listing fields such as price, BHK, area, property type, project, locality, furnishing, status, image URL, and property URL. Phone numbers and email addresses found in descriptions are redacted.

The safest first run is intentionally small: MagicBricks, sale, Mumbai, one result, and a Residential India proxy. Inspect the output, then add 99acres, more cities, or price filters.

Useful for property price research, inventory comparisons, and real-estate BI datasets.

## Reddit or Discord draft

I built an Apify Actor that turns public MagicBricks and 99acres listings into structured JSON/CSV data. It supports sale/rent, multiple Indian cities, optional INR price filters, source selection, and result limits.

For a low-cost check, run MagicBricks + Mumbai + one sale result with a Residential India proxy. Feedback on the schema and useful property-research fields is welcome.

## Short video outline

1. Open the Actor input.
2. Select MagicBricks, sale, and Mumbai.
3. Leave price filters empty.
4. Set maximum results to one.
5. Run with the Residential India proxy.
6. Show the dataset table and JSON export.
7. Briefly show the `both` source option.

## Do not claim

- Official MagicBricks or 99acres API access or affiliation
- Owner, broker, tenant, buyer, or seller lead generation
- Hidden phone numbers, emails, or private contact details
- Access to accounts, messages, saved properties, or private dashboards
- Guaranteed live availability, exact valuations, or complete market coverage
- Unlimited collection or proxy bypass
