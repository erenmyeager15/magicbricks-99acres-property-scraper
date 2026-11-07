/** Each portal accepts only its own spelling of some city names. Verified live on
 * 3 and 7 November 2026: MagicBricks returns HTTP 500 for any cityName it does
 * not recognise, including "Mumbai, Maharashtra", "Mumbai City", "Pune 411001",
 * "Bangalore Urban", "Prayagraj", "Tiruchirappalli" and bare localities such as
 * "Andheri West"; 99acres returns 404 for `new-delhi` and `bengaluru`. The
 * user's original city text stays in the output; only the request URL changes. */
const MAGICBRICKS: Record<string, string> = {
    delhi: 'New Delhi',
    'new delhi': 'New Delhi',
    'new-delhi': 'New Delhi',
    'delhi ncr': 'New Delhi',
    bengaluru: 'Bangalore',
    gurugram: 'Gurgaon',
    bombay: 'Mumbai',
    'greater mumbai': 'Mumbai',
    madras: 'Chennai',
    calcutta: 'Kolkata',
    mysuru: 'Mysore',
    vizag: 'Visakhapatnam',
    thiruvananthapuram: 'Trivandrum',
    cochin: 'Kochi',
    baroda: 'Vadodara',
    puducherry: 'Pondicherry',
    prayagraj: 'Allahabad',
    tiruchirappalli: 'Trichy',
    tiruchi: 'Trichy',
    'north goa': 'Goa',
    'south goa': 'Goa',
};

const NINETY_NINE_ACRES: Record<string, string> = {
    'new delhi': 'Delhi',
    'new-delhi': 'Delhi',
    bengaluru: 'Bangalore',
    gurugram: 'Gurgaon',
    bombay: 'Mumbai',
    'greater mumbai': 'Mumbai',
    madras: 'Chennai',
    calcutta: 'Kolkata',
    mysuru: 'Mysore',
    cochin: 'Kochi',
    baroda: 'Vadodara',
};

const STATES = new Set([
    'andhra pradesh', 'arunachal pradesh', 'assam', 'bihar', 'chhattisgarh', 'goa', 'gujarat', 'haryana',
    'himachal pradesh', 'jharkhand', 'karnataka', 'kerala', 'madhya pradesh', 'maharashtra', 'manipur',
    'meghalaya', 'mizoram', 'nagaland', 'odisha', 'orissa', 'punjab', 'rajasthan', 'sikkim', 'tamil nadu',
    'telangana', 'tripura', 'uttar pradesh', 'uttarakhand', 'west bengal', 'jammu and kashmir', 'ladakh',
    'india', 'ncr', 'delhi ncr',
]);

// Only matched as a separate comma part ("Bhopal, MP"), never inside a name.
const STATE_CODES = new Set(['mp', 'up', 'mh', 'ka', 'tn', 'ap', 'hp', 'wb', 'gj', 'rj', 'hr', 'pb', 'tg', 'ts', 'kl', 'br', 'od', 'uk', 'jk', 'in']);

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
const key = (value: string) => clean(value).toLowerCase();

export interface CitySearch {
    /** City name as the portal expects it. */
    city: string;
    /** Locality inside the city, from "Locality, City" input. */
    locality: string | null;
}

/** Reduce what people type ("Mumbai, Maharashtra", "Pune 411001",
 * "Bangalore Urban", "Andheri West, Mumbai") to a portal city plus an optional
 * locality. The last non-state part is the city; an earlier part is the locality. */
export function parseCityInput(source: 'magicbricks' | '99acres', raw: string): CitySearch {
    const parts = clean(raw).replace(/\b\d{6}\b/g, ' ').split(/\s*[,|/]\s*/)
        .map(part => clean(part.replace(/\b(?:city|urban|rural|district|dist\.?)\s*$/i, '')))
        .filter(Boolean);
    let rest = parts.filter((part, index) => index === 0 || !(STATES.has(key(part)) || STATE_CODES.has(key(part))));
    // "Mumbai Maharashtra": drop a trailing state name without a comma.
    rest = rest.map(part => {
        for (const state of STATES) {
            if (key(part).endsWith(` ${state}`) && key(part) !== state) return clean(part.slice(0, part.length - state.length));
        }
        return part;
    });
    const table = source === 'magicbricks' ? MAGICBRICKS : NINETY_NINE_ACRES;
    const rawCity = rest.at(-1) ?? clean(raw);
    const city = table[key(rawCity)] ?? rawCity;
    const locality = rest.length > 1 ? rest[0] : null;
    return { city: city || clean(raw), locality };
}

export function portalCityName(source: 'magicbricks' | '99acres', city: string): string {
    return parseCityInput(source, city).city;
}
