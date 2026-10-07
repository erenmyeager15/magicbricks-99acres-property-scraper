import { Actor } from 'apify';
import { createHash, randomUUID } from 'node:crypto';
import { buildPropertyReport, propertyChangesCsv, readMonitorState, type MonitorState, type PropertyReport } from './property-intelligence.js';
import type { PropertyRecord } from './types.js';

export class PropertyMonitorError extends Error {
    constructor(message: string, readonly historyCommitted: boolean | 'unknown') {
        super(message);
        this.name = 'PropertyMonitorError';
    }
}

export interface PropertyMonitorStorage {
    loadState(): Promise<unknown>;
    prolongLock(): Promise<void>;
    saveCsv(csv: string): Promise<void>;
    commitState(state: MonitorState): Promise<void>;
    saveReport(report: PropertyReport & { historyCommitted: true }): Promise<void>;
    releaseLock(): Promise<void>;
}

// This seam exercises commit/lease failures without network access or customer storage.
export async function commitPropertyMonitor(
    storage: PropertyMonitorStorage, rows: PropertyRecord[], scope: string, observedAt: string,
    threshold: number, coverage: Record<string, unknown>,
): Promise<void> {
    let historyCommitted: boolean | 'unknown' = false;
    let failure: unknown;
    let failed = false;
    try {
        const prior = readMonitorState(await storage.loadState());
        const result = buildPropertyReport(rows, prior, scope, observedAt, threshold, coverage);
        await storage.prolongLock();
        // Export before committing: an export failure cannot advance the baseline.
        await storage.saveCsv(propertyChangesCsv(result.report));
        // A timed-out write might have reached the server. Do not claim it was rolled back.
        historyCommitted = 'unknown';
        await storage.commitState(result.state);
        historyCommitted = true;
        await storage.saveReport({ ...result.report, historyCommitted: true });
    } catch (error) {
        failure = error;
        failed = true;
    } finally {
        try { await storage.releaseLock(); } catch (error) {
            if (!failed) { failure = error; failed = true; }
        }
    }
    if (failed) throw new PropertyMonitorError(failure instanceof Error ? failure.message : String(failure), historyCommitted);
}

export async function savePropertyMonitor(
    name: string, rows: PropertyRecord[], scope: string, observedAt: string,
    threshold: number, coverage: Record<string, unknown>,
): Promise<void> {
    if (!Actor.isAtHome()) throw new Error('Persistent monitoring requires an Apify platform run.');
    // Named storage is scoped to the run initiator; no owner credentials or customer data are shared.
    const client = Actor.newClient({ maxRetries: 0, timeoutSecs: 30 });
    const suffix = createHash('sha256').update(name).digest('hex').slice(0, 32);
    const store = await client.keyValueStores().getOrCreate(`property-watch-${suffix}`);
    const queue = await client.requestQueues().getOrCreate(`property-watch-lock-${suffix}`);
    const queueClient = client.requestQueue(queue.id, { clientKey: randomUUID().replace(/-/g, '') });
    const item = await queueClient.addRequest({ uniqueKey: 'property-watch-writer-v1', url: 'https://www.magicbricks.com/' });
    if (item.wasAlreadyHandled) throw new Error('Monitor lock is invalid; use a new monitorStoreName.');
    const lease = await queueClient.listAndLockHead({ lockSecs: 300, limit: 1 });
    const lock = lease.items.find(entry => entry.id === item.requestId)?.id;
    if (!lock) throw new Error('Another run is updating this monitor. Try again after it finishes.');
    const storeClient = client.keyValueStore(store.id);
    await commitPropertyMonitor({
        loadState: async () => (await storeClient.getRecord('STATE'))?.value ?? null,
        prolongLock: async () => { await queueClient.prolongRequestLock(lock, { lockSecs: 300 }); },
        saveCsv: async csv => { await Actor.setValue('PROPERTY_CHANGES.csv', csv, { contentType: 'text/csv; charset=utf-8' }); },
        commitState: async state => { await storeClient.setRecord({ key: 'STATE', value: JSON.stringify(state), contentType: 'application/json' },
            { timeoutSecs: 30, doNotRetryTimeouts: true }); },
        saveReport: async report => { await Actor.setValue('PROPERTY_REPORT', report); },
        releaseLock: async () => { await queueClient.deleteRequestLock(lock); },
    }, rows, scope, observedAt, threshold, coverage);
}
