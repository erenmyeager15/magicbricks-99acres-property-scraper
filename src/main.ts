import { Actor, log } from 'apify';
import { scrapeProperties } from './routes.js';
import type { ActorInput } from './types.js';

await Actor.init();

try {
    const input = (await Actor.getInput<ActorInput>()) ?? {};
    await scrapeProperties(input);
    await Actor.exit();
} catch (error) {
    log.exception(error as Error, 'Actor failed');
    await Actor.fail((error as Error).message);
}
