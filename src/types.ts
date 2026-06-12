export type PropertySource = 'magicbricks' | '99acres' | 'both';
export type TransactionType = 'sale' | 'rent';

export interface ActorInput {
    source?: PropertySource;
    transactionType?: TransactionType;
    cities?: string[];
    minPrice?: number;
    maxPrice?: number;
    maxResults?: number;
    proxyConfiguration?: Record<string, unknown>;
}

export interface NormalizedInput {
    source: PropertySource;
    transactionType: TransactionType;
    cities: string[];
    minPrice: number | null;
    maxPrice: number | null;
    maxResults: number;
    proxyConfiguration?: Record<string, unknown>;
}

export interface ScrapeJob {
    source: Exclude<PropertySource, 'both'>;
    transactionType: TransactionType;
    city: string;
    citySlug: string;
    page: number;
    url: string;
}

export interface PropertyRecord {
    source: Exclude<PropertySource, 'both'>;
    transactionType: TransactionType;
    cityQuery: string;
    propertyId: string;
    title: string | null;
    propertyType: string | null;
    bhk: number | null;
    price: number | null;
    priceDisplay: string | null;
    depositDisplay: string | null;
    area: number | null;
    areaUnit: string | null;
    areaType: string | null;
    bedrooms: number | null;
    bathrooms: number | null;
    balconies: number | null;
    furnishing: string | null;
    status: string | null;
    floor: string | null;
    projectName: string | null;
    locality: string | null;
    city: string | null;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    imageUrl: string | null;
    propertyUrl: string;
    description: string | null;
    scrapedAt: string;
}
