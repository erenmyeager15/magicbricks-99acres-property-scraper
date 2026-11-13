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
    // No Thane or Kalyan city page (404, verified 7 Nov 2026); the Mumbai page
    // covers the Mumbai metro region.
    thane: 'Mumbai',
    kalyan: 'Mumbai',
};

/** Localities people type on their own as a "city". MagicBricks returns HTTP 500
 * for every one of them as a cityName; each pair below was verified live on
 * 7 November 2026 to return that locality's listings as cityName=<city>&Locality=<name>.
 * A trailing "East"/"West" is ignored for the lookup and kept for the filter. */
const LOCALITY_CITY: Record<string, string> = Object.fromEntries(Object.entries({
    Mumbai: ['mira road', 'mira bhayandar', 'bhayandar', 'borivali', 'kandivali', 'powai', 'vasai', 'virar', 'nalasopara',
        'andheri', 'bandra', 'malad', 'goregaon', 'chembur', 'ghatkopar', 'mulund', 'dahisar'],
    'Navi Mumbai': ['kharghar', 'panvel', 'vashi', 'nerul', 'ulwe'],
    Kalyan: ['dombivli'],
    Pune: ['hinjewadi', 'wakad', 'kharadi', 'baner', 'wagholi', 'hadapsar', 'kothrud', 'pimpri chinchwad'],
    Bangalore: ['whitefield', 'electronic city', 'sarjapur road', 'marathahalli', 'hsr layout', 'koramangala', 'yelahanka', 'hebbal'],
    Hyderabad: ['gachibowli', 'kondapur', 'kukatpally', 'madhapur', 'miyapur'],
    Chennai: ['velachery', 'tambaram', 'porur', 'anna nagar', 'omr'],
    'New Delhi': ['dwarka', 'rohini'],
    Kolkata: ['new town', 'rajarhat', 'salt lake'],
    Ghaziabad: ['indirapuram'],
    'Greater Noida': ['noida extension'],
}).flatMap(([city, localities]) => localities.map(locality => [locality, city])));

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
    if (rest.length === 1) {
        // A bare locality such as "Mira Road" or "Whitefield": search its city.
        const localityCity = LOCALITY_CITY[key(rawCity).replace(/\s+(?:east|west)$/, '')];
        if (localityCity) {
            return { city: table[key(localityCity)] ?? localityCity, locality: rawCity };
        }
    }
    const city = table[key(rawCity)] ?? rawCity;
    const locality = rest.length > 1 ? rest[0] : null;
    return { city: city || clean(raw), locality };
}

export function portalCityName(source: 'magicbricks' | '99acres', city: string): string {
    return parseCityInput(source, city).city;
}

/** Cities MagicBricks accepts as cityName (portal spelling). Used only to
 * correct a typo after MagicBricks has rejected the user's text with HTTP 500. */
const KNOWN_MAGICBRICKS_CITIES = [
    'Mumbai', 'Navi Mumbai', 'Thane', 'Pune', 'Bangalore', 'Hyderabad', 'Chennai', 'Kolkata', 'New Delhi', 'Gurgaon',
    'Noida', 'Greater Noida', 'Ghaziabad', 'Faridabad', 'Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Gandhinagar',
    'Jaipur', 'Lucknow', 'Kanpur', 'Indore', 'Bhopal', 'Nagpur', 'Nashik', 'Aurangabad', 'Kolhapur', 'Chandigarh',
    'Mohali', 'Zirakpur', 'Panchkula', 'Ludhiana', 'Amritsar', 'Jalandhar', 'Dehradun', 'Coimbatore', 'Madurai',
    'Trichy', 'Kochi', 'Trivandrum', 'Kozhikode', 'Mysore', 'Mangalore', 'Visakhapatnam', 'Vijayawada', 'Guntur',
    'Bhubaneswar', 'Cuttack', 'Patna', 'Ranchi', 'Raipur', 'Guwahati', 'Goa', 'Varanasi', 'Allahabad', 'Agra',
    'Meerut', 'Bhiwadi', 'Bhiwandi', 'Kalyan', 'Vasai', 'Palghar', 'Sonipat', 'Jodhpur', 'Udaipur', 'Jabalpur',
    'Gwalior', 'Pondicherry', 'Hubli', 'Belgaum', 'Siliguri', 'Durgapur', 'Jamshedpur', 'Dhanbad', 'Haridwar',
];

function editDistance(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let previous = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const current = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
            previous = current;
        }
    }
    return row[b.length];
}

/** The single closest known MagicBricks city for a misspelt name such as
 * "Banglore" or "Hydrabad", or null when the text is not a near miss.
 * Short names need a closer match; ties return null rather than a guess. */
export function suggestMagicBricksCity(rawCity: string): string | null {
    const text = key(rawCity).replace(/[^a-z ]/g, '');
    if (text.length < 4) return null;
    const allowed = text.length >= 7 ? 2 : 1;
    let best: string | null = null;
    let bestDistance = Infinity;
    let tie = false;
    for (const city of KNOWN_MAGICBRICKS_CITIES) {
        const distance = editDistance(text, city.toLowerCase());
        if (distance < bestDistance) { best = city; bestDistance = distance; tie = false; }
        else if (distance === bestDistance) tie = true;
    }
    return best && bestDistance > 0 && bestDistance <= allowed && !tie ? best : null;
}

export function isIndianStateName(raw: string): boolean {
    return STATES.has(key(raw)) && !['goa', 'india', 'ncr', 'delhi ncr'].includes(key(raw));
}
