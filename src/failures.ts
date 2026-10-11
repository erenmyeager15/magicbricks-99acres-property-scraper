export type PropertyFailureCategory = 'INPUT_INVALID' | 'PROXY_CONFIGURATION' | 'PROXY_AUTHENTICATION'
    | 'SOURCE_HTTP' | 'SOURCE_BLOCKED' | 'SOURCE_MAINTENANCE' | 'SOURCE_UNRECOGNIZED'
    | 'REQUEST_TIMEOUT' | 'NETWORK_ERROR' | 'RESPONSE_TOO_LARGE'
    | 'OUTPUT_BILLING_FAILURE' | 'MONITOR_UPDATE_FAILURE' | 'UNKNOWN';

export interface PropertyFailureInfo {
    category: PropertyFailureCategory;
    message: string;
    httpStatus?: number;
    attempts?: number;
}

// Only Actor-authored messages are exposed. Raw library errors can contain proxy
// URLs, passwords, source HTML or input query values, even in their nested causes.
export class PropertyFailureError extends Error {
    override name = 'PropertyFailureError';
    constructor(readonly info: PropertyFailureInfo,
        readonly retryable = false, readonly stopRun = false, cause?: unknown) {
        super(info.message, { cause });
    }
}

const MESSAGES: Record<PropertyFailureCategory, string> = {
    INPUT_INVALID: 'Input validation failed. Check the supplied fields before running again.',
    PROXY_CONFIGURATION: 'The configured proxy could not be initialized. Check its configuration and access for this run.',
    PROXY_AUTHENTICATION: 'Proxy authorization failed. Check the configured proxy credentials and access; rotating the same credentials will not fix this.',
    SOURCE_HTTP: 'The property portal returned an unsuccessful HTTP response.',
    SOURCE_BLOCKED: 'The property portal returned a blocked or verification page, not property listings.',
    SOURCE_MAINTENANCE: 'The property portal returned a maintenance page, not property listings.',
    SOURCE_UNRECOGNIZED: 'The property portal returned a page without recognized property listings or a confirmed empty search.',
    REQUEST_TIMEOUT: 'The property request timed out within the bounded request limit.',
    NETWORK_ERROR: 'The property request failed before a usable response was received.',
    RESPONSE_TOO_LARGE: 'The property response exceeded the bounded HTML size limit.',
    OUTPUT_BILLING_FAILURE: 'Saving or charging for property output failed. Collection stopped to avoid additional unbillable traffic.',
    MONITOR_UPDATE_FAILURE: 'Property data was saved, but the requested monitor update failed. Check PROPERTY_REPORT before repeating.',
    UNKNOWN: 'The Actor failed. Check RUN_SUMMARY and the safe failure category in the log.',
};

export function propertyFailure(error: unknown, fallback: PropertyFailureCategory = 'NETWORK_ERROR', attempts?: number): PropertyFailureError {
    if (error instanceof PropertyFailureError) return error;
    if (['OUTPUT_BILLING_FAILURE', 'MONITOR_UPDATE_FAILURE', 'INPUT_INVALID'].includes(fallback)) {
        return new PropertyFailureError({ category: fallback, message: MESSAGES[fallback] }, false, false, error);
    }
    let category = fallback;
    let httpStatus: number | undefined;
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
        const item = current as { name?: string; code?: string; message?: string; statusCode?: number; cause?: unknown };
        const text = String(item.message ?? '');
        // undici's HTTPS CONNECT path reports status inside the nested error,
        // not as a normal HTTP Response (see ProxyAgent in the installed runtime).
        const proxyStatus = text.match(/Proxy response \((\d{3})\)|Proxy Authentication Required \((\d{3})\)/i);
        const status = item.statusCode ?? Number(proxyStatus?.[1] ?? proxyStatus?.[2]);
        if ([407, 597].includes(status) || /proxy\b.*(?:authentication|authorization|credentials).*?(?:failed|required|invalid|incorrect)|(?:invalid|incorrect|missing)\s+proxy\s+(?:password|credentials)/i.test(text)) {
            category = 'PROXY_AUTHENTICATION';
            if ([407, 597].includes(status)) httpStatus = status;
            break;
        }
        if (item.name === 'TimeoutError' || ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(item.code ?? '')) {
            category = 'REQUEST_TIMEOUT';
        }
        current = item.cause;
    }
    return new PropertyFailureError({ category, message: MESSAGES[category],
        ...(httpStatus ? { httpStatus } : {}), ...(attempts ? { attempts } : {}) },
    !['PROXY_CONFIGURATION', 'PROXY_AUTHENTICATION', 'INPUT_INVALID', 'OUTPUT_BILLING_FAILURE', 'MONITOR_UPDATE_FAILURE'].includes(category),
    ['PROXY_CONFIGURATION', 'PROXY_AUTHENTICATION'].includes(category), error);
}
