/** Each portal accepts only its own spelling of some city names. Verified live on
 * 3 November 2026: MagicBricks returns HTTP 500 for the left-hand names below and
 * listings for the right-hand ones; 99acres returns 404 for `new-delhi` and
 * `bengaluru` and listings for `delhi` and `bangalore`. The user's original
 * city text stays in the output; only the request URL uses the portal's name. */
const MAGICBRICKS: Record<string, string> = {
    delhi: 'New Delhi',
    'new delhi': 'New Delhi',
    'new-delhi': 'New Delhi',
    bengaluru: 'Bangalore',
    gurugram: 'Gurgaon',
    bombay: 'Mumbai',
    madras: 'Chennai',
    calcutta: 'Kolkata',
    mysuru: 'Mysore',
    vizag: 'Visakhapatnam',
    thiruvananthapuram: 'Trivandrum',
    cochin: 'Kochi',
    baroda: 'Vadodara',
    puducherry: 'Pondicherry',
};

const NINETY_NINE_ACRES: Record<string, string> = {
    'new delhi': 'Delhi',
    'new-delhi': 'Delhi',
    bengaluru: 'Bangalore',
    gurugram: 'Gurgaon',
    bombay: 'Mumbai',
    madras: 'Chennai',
    calcutta: 'Kolkata',
    mysuru: 'Mysore',
    cochin: 'Kochi',
    baroda: 'Vadodara',
};

const key = (city: string) => city.replace(/\s+/g, ' ').trim().toLowerCase();

export function portalCityName(source: 'magicbricks' | '99acres', city: string): string {
    const table = source === 'magicbricks' ? MAGICBRICKS : NINETY_NINE_ACRES;
    return table[key(city)] ?? city.replace(/\s+/g, ' ').trim();
}
