export type PropertySource = 'magicbricks' | '99acres' | 'both';
export type TransactionType = 'sale' | 'rent';

export interface ActorInput {
    searchUrls?: string[];
    source?: PropertySource;
    transactionType?: TransactionType;
    cities?: string[];
    minPrice?: number;
    maxPrice?: number;
    maxResults?: number;
    proxyConfiguration?: Record<string, unknown>;
}

export interface NormalizedInput {
    searchUrls: SearchUrlDefinition[];
    source: PropertySource;
    transactionType: TransactionType;
    cities: string[];
    minPrice: number | null;
    maxPrice: number | null;
    maxResults: number;
    proxyConfiguration?: Record<string, unknown>;
}

export interface SearchUrlDefinition {
    source: Exclude<PropertySource, 'both'>;
    transactionType: TransactionType;
    city: string;
    citySlug: string;
    url: string;
}

export interface ScrapeJob {
    source: Exclude<PropertySource, 'both'>;
    transactionType: TransactionType;
    city: string;
    citySlug: string;
    page: number;
    url: string;
    searchKey: string;
    isCustomUrl: boolean;
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
    pricePerSqft: number | null;
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
    listedBy: string | null;
    verified: boolean | null;
    featured: boolean | null;
    postedAt: string | null;
    propertyAge: string | null;
    facing: string | null;
    ownership: string | null;
    parking: string | null;
    reraId: string | null;
    maintenanceDisplay: string | null;
    amenities: string[];
    imageUrl: string | null;
    imageUrls: string[];
    imagesCount: number;
    propertyUrl: string;
    searchUrl: string;
    searchPage: number;
    resultPosition: number;
    description: string | null;
    scrapedAt: string;
}
