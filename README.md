# MagicBricks + 99acres Property Scraper

Scrape Indian real-estate listings from MagicBricks and 99acres for market research, lead generation, and property analytics. The actor collects sale or rent listings by city and saves clean records to an Apify Dataset.

## What It Scrapes

- Property title, source, transaction type, city, locality, and project name
- Price display and parsed INR price
- BHK, area, bathrooms, balconies, furnishing, status, and floor when available
- Image URL, listing URL, geo coordinates, and short description
- MagicBricks and 99acres records in one deduplicated dataset

The actor does not extract phone numbers, emails, or private contact details. If sensitive text appears in page descriptions, it is redacted before saving.

## How To Scrape MagicBricks And 99acres

1. Choose `source`: `both`, `magicbricks`, or `99acres`.
2. Select `transactionType`: `sale` or `rent`.
3. Add one or more Indian cities, such as Mumbai, Pune, Bengaluru, Delhi, Chennai, or Hyderabad.
4. Optionally set minimum and maximum INR price filters.
5. Set `maxResults` up to 500 and run the actor.

## Input Example

```json
{
  "source": "both",
  "transactionType": "sale",
  "cities": ["Mumbai"],
  "maxResults": 10,
  "proxyConfiguration": {
    "useApifyProxy": false
  }
}
```

## Output Example

```json
{
  "source": "99acres",
  "transactionType": "sale",
  "cityQuery": "Mumbai",
  "propertyId": "sample-property-id",
  "title": "2 BHK Apartment in Bhandup West",
  "propertyType": "Apartment",
  "bhk": 2,
  "price": 18400000,
  "priceDisplay": "Rs. 1.84 Cr",
  "area": 680,
  "areaUnit": "sqft",
  "locality": "Bhandup West",
  "projectName": "Sample Project",
  "propertyUrl": "https://www.99acres.com/example",
  "scrapedAt": "2026-06-12T12:00:00.000Z"
}
```

## Use Cases

- Real-estate lead generation for brokers and agencies
- Property price monitoring by city and locality
- Competitor inventory tracking across major Indian portals
- Rental market research and supply analysis
- Investment, valuation, and location analytics

## Pricing

This actor uses pay per event pricing.

| Event | When charged | Price |
| --- | --- | --- |
| `property-scraped` | Each clean property listing saved to the dataset | `$0.003` |

## Notes

MagicBricks and 99acres page structures can change over time. If a page returns no listings, try another city, reduce the requested result count, or enable Apify Proxy for the run.
