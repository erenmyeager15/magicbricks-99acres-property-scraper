import { Actor, log } from 'apify';
import { scrapeProperties } from './routes.js';
import { propertyFailure } from './failures.js';
import type { ActorInput } from './types.js';

await Actor.init();

try {
    const input = (await Actor.getInput<ActorInput>()) ?? {};
    await scrapeProperties(input);
    await Actor.exit();
} catch (error) {
    const failure = propertyFailure(error, 'UNKNOWN');
    log.error('Actor failed', failure.info);
    await Actor.fail(failure.message);
}
