"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CurlEditAndResendProvider = void 0;
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const parse_curl_js_1 = require("parse-curl-js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { toJsonObject } = require('curlconverter');
function normalizeRecord(input) {
    if (!input || typeof input !== 'object') {
        return {};
    }
    const result = {};
    for (const key of Object.keys(input)) {
        const value = input[key];
        if (value === undefined || value === null) {
            continue;
        }
        if (Array.isArray(value)) {
            result[key] = JSON.stringify(value);
        }
        else if (typeof value === 'object') {
            result[key] = JSON.stringify(value);
        }
        else {
            result[key] = String(value);
        }
    }
    return result;
}
function tryParseJson(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return '';
    }
    try {
        return JSON.parse(trimmed);
    }
    catch (_a) {
        return value;
    }
}
function stripWrappingQuotes(value) {
    if (!value) {
        return value;
    }
    let result = value;
    let changed = true;
    while (changed) {
        changed = false;
        if (result.length >= 2) {
            if ((result.startsWith("'") && result.endsWith("'")) || (result.startsWith('"') && result.endsWith('"'))) {
                result = result.slice(1, -1);
                changed = true;
            }
        }
    }
    return result;
}
function dictionaryToJson(dict) {
    const result = {};
    for (const key of Object.keys(dict)) {
        result[key] = tryParseJson(dict[key]);
    }
    return result;
}
function stripQuotedText(command) {
    return command.replace(/(["'])(?:\\.|[^\\])*?\1/g, ' ');
}
function methodWasExplicit(command) {
    if (!command) {
        return false;
    }
    const withoutQuotes = stripQuotedText(command);
    return /(?:^|\s)(?:-X(?!\S)|-X[A-Za-z]+|--request)\b/i.test(withoutQuotes);
}
const FLAG_OPTIONS_TO_SKIP = new Set([
    '-x',
    '--request',
    '--url',
    '-d',
    '--data',
    '--data-raw',
    '--data-binary',
    '--data-urlencode',
    '-H',
    '--header',
    '--write-out',
]);
function tokenizeCommand(command) {
    const tokens = [];
    const regex = /'[^']*'|"[^"]*"|[^ \t\r\n]+/g;
    let match;
    while ((match = regex.exec(command)) !== null) {
        tokens.push(match[0]);
    }
    return tokens;
}
function extractFlagsFromCommand(command) {
    const tokens = tokenizeCommand(command);
    if (!tokens.length) {
        return [];
    }
    const results = [];
    for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!token || !token.startsWith('-')) {
            continue;
        }
        const normalized = token.split('=')[0].toLowerCase();
        if (FLAG_OPTIONS_TO_SKIP.has(normalized)) {
            if (!token.includes('=') && index + 1 < tokens.length && !tokens[index + 1].startsWith('-')) {
                index += 1;
            }
            continue;
        }
        if (token.includes('=')) {
            results.push(token);
            continue;
        }
        let value;
        if (index + 1 < tokens.length && !tokens[index + 1].startsWith('-')) {
            value = tokens[index + 1];
            index += 1;
        }
        results.push(value ? `${token} ${value}` : token);
    }
    return results;
}
const HEADER_LOOP_FLAG_NORMALIZATION = {
    '-h': '-H',
    '-H': '-H',
    '--header': '--header',
    '-b': '-b',
    '--cookie': '--cookie',
};
const ROUTE_LOOP_KEYS_SET = new Set(['scheme', 'subdomain', 'domain', 'port', 'path']);
function normalizeLoopFlag(flag) {
    if (!flag) {
        return '-H';
    }
    const normalized = HEADER_LOOP_FLAG_NORMALIZATION[flag.trim().toLowerCase()];
    return normalized !== null && normalized !== void 0 ? normalized : '-H';
}
function headerFlagRequiresName(flag) {
    const normalized = normalizeLoopFlag(flag);
    return normalized === '-H' || normalized === '--header';
}
function formatFlagValueForCommand(value) {
    const trimmed = value.trim();
    if (!trimmed.length) {
        return "''";
    }
    if (trimmed.includes('"')) {
        return `'${trimmed}'`;
    }
    const escaped = trimmed.replace(/(["\\$`])/g, '\\$1');
    return `"${escaped}"`;
}
function safeParseUrl(url) {
    if (!url) {
        return undefined;
    }
    try {
        return new URL(url);
    }
    catch (_a) {
        try {
            return new URL(`https://${url.replace(/^\/+/g, '')}`);
        }
        catch (_b) {
            return undefined;
        }
    }
}
function splitHost(host) {
    const parts = host.split('.');
    if (parts.length <= 2) {
        return { domain: host };
    }
    return {
        subdomain: parts[0],
        domain: parts.slice(1).join('.'),
    };
}
function convertUrlToRoute(url) {
    var _a, _b, _c;
    const parsed = safeParseUrl(url);
    if (!parsed) {
        return {};
    }
    const route = {};
    route.scheme = parsed.protocol.replace(':', '');
    const hostInfo = splitHost(parsed.hostname);
    route.subdomain = (_a = hostInfo.subdomain) !== null && _a !== void 0 ? _a : '';
    route.domain = (_b = hostInfo.domain) !== null && _b !== void 0 ? _b : '';
    route.port = (_c = parsed.port) !== null && _c !== void 0 ? _c : '';
    const path = parsed.pathname.replace(/^\/+/g, '').replace(/\/+/g, '/').replace(/\/$/g, '');
    route.path = path;
    return route;
}
function buildUrlFromRoute(route, fallbackUrl) {
    var _a, _b, _c, _d, _e;
    const fallback = safeParseUrl(fallbackUrl);
    const fallbackScheme = (fallback === null || fallback === void 0 ? void 0 : fallback.protocol) ? fallback.protocol.replace(':', '') : 'https';
    const fallbackHost = (_a = fallback === null || fallback === void 0 ? void 0 : fallback.hostname) !== null && _a !== void 0 ? _a : '';
    const fallbackPort = (_b = fallback === null || fallback === void 0 ? void 0 : fallback.port) !== null && _b !== void 0 ? _b : '';
    const fallbackPath = (_c = fallback === null || fallback === void 0 ? void 0 : fallback.pathname) !== null && _c !== void 0 ? _c : '';
    const schemeCandidate = route.scheme !== undefined ? route.scheme.trim().toLowerCase() : undefined;
    const scheme = schemeCandidate || fallbackScheme || 'https';
    const domainCandidate = route.domain !== undefined ? route.domain.trim() : undefined;
    const subdomainCandidate = route.subdomain !== undefined ? route.subdomain.trim() : undefined;
    let host = fallbackHost;
    if (domainCandidate) {
        host = subdomainCandidate ? `${subdomainCandidate}.${domainCandidate}` : domainCandidate;
    }
    else if (subdomainCandidate !== undefined) {
        if (!subdomainCandidate.length) {
            const existing = splitHost(fallbackHost);
            host = (_d = existing.domain) !== null && _d !== void 0 ? _d : fallbackHost;
        }
        else {
            const existing = splitHost(fallbackHost);
            const baseDomain = (_e = existing.domain) !== null && _e !== void 0 ? _e : fallbackHost;
            host = `${subdomainCandidate}.${baseDomain}`;
        }
    }
    if (!host) {
        return fallbackUrl || `${scheme}://`;
    }
    const portCandidate = route.port !== undefined ? route.port.trim() : undefined;
    const port = portCandidate !== undefined ? portCandidate : fallbackPort;
    const portSuffix = port ? `:${port}` : '';
    const fallbackNormalizedPath = fallbackPath.replace(/^\/+/g, '').replace(/\/+/g, '/');
    const pathCandidate = route.path !== undefined ? route.path : fallbackNormalizedPath;
    let path = pathCandidate ? pathCandidate.trim() : '';
    path = path.replace(/^\/+/g, '').replace(/\/+/g, '/');
    const prefixedPath = path.length ? `/${path}` : '';
    return `${scheme}://${host}${portSuffix}${prefixedPath}`;
}
function sanitizeRouteValue(key, value) {
    const trimmed = value.trim();
    switch (key) {
        case 'scheme':
            return trimmed.toLowerCase();
        case 'path':
            return trimmed.replace(/^\/+/g, '').replace(/\/+/g, '/').replace(/\/$/g, '');
        default:
            return trimmed;
    }
}
function normalizeRouteLoopKey(key) {
    var _a;
    const trimmed = (_a = key === null || key === void 0 ? void 0 : key.trim().toLowerCase()) !== null && _a !== void 0 ? _a : '';
    return ROUTE_LOOP_KEYS_SET.has(trimmed) ? trimmed : undefined;
}
function indicatesJsonContentType(headers) {
    if (!headers || typeof headers !== 'object') {
        return false;
    }
    const entries = headers;
    for (const key of Object.keys(entries)) {
        if (key.toLowerCase() === 'content-type') {
            const value = entries[key];
            if (typeof value === 'string' && value.toLowerCase().includes('json')) {
                return true;
            }
            if (Array.isArray(value)) {
                if (value.some(item => String(item).toLowerCase().includes('json'))) {
                    return true;
                }
            }
        }
    }
    return false;
}
const STATUS_MARKER = '__HTTP_STATUS__';
function parseFormBody(input) {
    if (!input.includes('=')) {
        return undefined;
    }
    const params = new URLSearchParams(input);
    const record = {};
    for (const [key, value] of params.entries()) {
        if (!key) {
            continue;
        }
        record[key] = value;
    }
    return Object.keys(record).length ? record : undefined;
}
function extractBodyDetails(body) {
    var _a, _b;
    const formData = {};
    let bodyPayload;
    let rawBody;
    let jsonValue;
    const applyString = (value) => {
        rawBody = value;
        const trimmed = value.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                jsonValue = JSON.parse(trimmed);
            }
            catch (_a) {
                jsonValue = undefined;
            }
        }
        const parsedForm = parseFormBody(value);
        if (parsedForm) {
            Object.assign(formData, parsedForm);
            bodyPayload = parsedForm;
        }
        else {
            bodyPayload = value;
        }
    };
    const applyObject = (value) => {
        const normalized = {};
        for (const key of Object.keys(value)) {
            const entry = value[key];
            if (entry === undefined || entry === null) {
                continue;
            }
            if (Array.isArray(entry)) {
                normalized[key] = JSON.stringify(entry);
            }
            else if (typeof entry === 'object') {
                normalized[key] = JSON.stringify(entry);
            }
            else {
                normalized[key] = String(entry);
            }
        }
        if (Object.keys(normalized).length) {
            Object.assign(formData, normalized);
            bodyPayload = normalized;
        }
        if (!jsonValue) {
            jsonValue = value;
        }
    };
    if (typeof body === 'string') {
        applyString(body);
        return { bodyPayload, rawBody, formData, jsonValue };
    }
    if (body && typeof body === 'object') {
        const value = body;
        const nested = (_b = (_a = value.data) !== null && _a !== void 0 ? _a : value.text) !== null && _b !== void 0 ? _b : value.value;
        if (typeof nested === 'string') {
            applyString(nested);
        }
        else if (nested && typeof nested === 'object') {
            applyObject(nested);
        }
        else {
            applyObject(value);
        }
    }
    return { bodyPayload, rawBody, formData, jsonValue };
}
function inferBodyFlag(originalCommand, bodyPayload) {
    if (!originalCommand) {
        return undefined;
    }
    const lowered = originalCommand.toLowerCase();
    if (lowered.includes('--data-raw')) {
        return '--data-raw';
    }
    if (lowered.includes('--data-binary')) {
        return '--data-binary';
    }
    if (lowered.includes('--data-urlencode')) {
        return '--data-urlencode';
    }
    if (lowered.includes('--data')) {
        return '--data';
    }
    if (lowered.includes('-d ')) {
        return '-d';
    }
    if (typeof bodyPayload === 'string' && bodyPayload.trim().startsWith('{')) {
        return '--data-raw';
    }
    return undefined;
}
function normalizeParsedCurl(parsed, originalCommand) {
    var _a, _b, _c;
    const data = parsed;
    const url = typeof data.url === 'string' ? stripWrappingQuotes(data.url) : '';
    const method = typeof data.method === 'string' ? data.method : 'GET';
    const explicitMethod = methodWasExplicit(originalCommand);
    const headers = normalizeRecord(data.headers);
    const query = normalizeRecord(data.query);
    const { bodyPayload, rawBody, formData, jsonValue } = extractBodyDetails((_a = data.body) !== null && _a !== void 0 ? _a : data.data);
    let converted;
    try {
        const conversionResult = toJsonObject(originalCommand);
        if (conversionResult && typeof conversionResult === 'object') {
            converted = conversionResult;
        }
    }
    catch (error) {
        console.error('curlconverter failed to parse command:', error);
    }
    const state = {
        commandText: originalCommand,
        url,
        method,
        explicitMethod,
        headers,
        query,
        body: bodyPayload,
        rawBody,
        bodyFlag: inferBodyFlag(originalCommand, bodyPayload),
    };
    if (!state.body && Object.keys(formData).length) {
        state.body = formData;
    }
    if (jsonValue && typeof jsonValue === 'object') {
        state.bodyKind = 'json';
        state.bodyJson = jsonValue;
        if (typeof state.body === 'undefined') {
            const normalizedJson = normalizeRecord(jsonValue);
            if (Object.keys(normalizedJson).length) {
                state.body = normalizedJson;
            }
        }
    }
    else if (state.body && typeof state.body === 'object') {
        state.bodyKind = 'form';
    }
    else if (typeof state.body === 'string' || rawBody) {
        state.bodyKind = 'raw';
    }
    if (converted) {
        const convertedData = converted.data;
        const convertedHeaders = converted.headers;
        const headersIndicateJson = indicatesJsonContentType(convertedHeaders);
        const bodyFlagSuggestsJson = ((_b = state.bodyFlag) === null || _b === void 0 ? void 0 : _b.includes('raw')) || ((_c = state.bodyFlag) === null || _c === void 0 ? void 0 : _c.includes('binary'));
        const preferJson = headersIndicateJson || bodyFlagSuggestsJson || state.bodyKind === 'json';
        if (convertedData !== undefined) {
            if (typeof convertedData === 'string') {
                if (!state.rawBody || state.rawBody.toLowerCase() === 'data') {
                    state.rawBody = convertedData;
                }
                if (!state.body || (typeof state.body === 'string' && state.body.toLowerCase() === 'data')) {
                    state.body = convertedData;
                }
                if (preferJson) {
                    const trimmed = convertedData.trim();
                    if (!state.bodyJson && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
                        try {
                            state.bodyJson = JSON.parse(trimmed);
                            state.bodyKind = 'json';
                        }
                        catch (_d) {
                            // ignore invalid JSON
                        }
                    }
                }
            }
            else if (convertedData && typeof convertedData === 'object') {
                if (preferJson) {
                    const jsonString = JSON.stringify(convertedData);
                    state.rawBody = jsonString;
                    state.body = jsonString;
                    state.bodyJson = convertedData;
                    state.bodyKind = 'json';
                }
                else if (!state.rawBody) {
                    const formPairs = normalizeRecord(convertedData);
                    state.rawBody = Object.keys(formPairs)
                        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(formPairs[key])}`)
                        .join('&');
                }
            }
        }
    }
    if (!state.bodyFlag) {
        if (state.bodyKind === 'json') {
            state.bodyFlag = '--data-raw';
        }
        else if (state.bodyKind === 'form') {
            state.bodyFlag = '-d';
        }
    }
    const extractedFlags = extractFlagsFromCommand(originalCommand);
    if (extractedFlags.length) {
        state.extraFlags = extractedFlags;
    }
    return state;
}
function convertStateToUi(state) {
    var _a, _b;
    const data = state.body && typeof state.body === 'object'
        ? state.body
        : state.bodyKind === 'json' && state.bodyJson && !Array.isArray(state.bodyJson)
            ? normalizeRecord(state.bodyJson)
            : {};
    const rawBody = typeof state.body === 'string'
        ? state.body
        : (_a = state.rawBody) !== null && _a !== void 0 ? _a : (state.bodyKind === 'json' && state.bodyJson ? JSON.stringify(state.bodyJson) : undefined);
    return {
        url: state.url,
        method: state.method,
        headers: state.headers,
        query: state.query,
        data,
        rawBody,
        bodyKind: state.bodyKind,
        flags: (_b = state.extraFlags) !== null && _b !== void 0 ? _b : [],
        route: convertUrlToRoute(state.url),
    };
}
function safeJsonParse(text) {
    if (!text) {
        return undefined;
    }
    try {
        return JSON.parse(text);
    }
    catch (_a) {
        return undefined;
    }
}
function extractStatusCode(stdout, stderr) {
    const combined = `${stdout}\n${stderr}`;
    const match = combined.match(/HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
    if (match) {
        return Number(match[1]);
    }
    const curlExitMatch = combined.match(/exit\s+status\s+(\d+)/i);
    if (curlExitMatch) {
        return Number(curlExitMatch[1]);
    }
    return undefined;
}
function prepareCurlCommandForStatus(command) {
    const trimmed = command.trim();
    if (!trimmed.toLowerCase().startsWith('curl ')) {
        return { commandToExecute: command };
    }
    const lower = trimmed.toLowerCase();
    if (/\s--write-out\b/.test(lower) || lower.includes('%{http_code}')) {
        return { commandToExecute: command };
    }
    const suffix = ` --silent --show-error --write-out "\\n${STATUS_MARKER}:%{http_code}"`;
    return {
        commandToExecute: command + suffix,
        statusMarker: STATUS_MARKER,
    };
}
function stripStatusMarker(stdout, marker) {
    if (!marker || !stdout) {
        return { stdout };
    }
    const markerPattern = new RegExp(`(?:\\r?\\n)${marker}:(\\d{3})\\s*$`);
    const match = stdout.match(markerPattern);
    if (match) {
        const cleaned = stdout.replace(markerPattern, '').trimEnd();
        return {
            stdout: cleaned,
            statusCode: Number(match[1]),
        };
    }
    return { stdout };
}
function reconstructCurlCommand(parsedData) {
    var _a, _b, _c, _d;
    const segments = ['curl'];
    const method = parsedData.method ? parsedData.method.toUpperCase() : undefined;
    if (shouldIncludeMethodFlag(method, parsedData)) {
        segments.push('-X', method);
    }
    const baseUrl = parsedData.url || '';
    let formattedUrl = '';
    if (baseUrl && parsedData.query && Object.keys(parsedData.query).length > 0) {
        const queryDict = parsedData.query;
        const queryString = Object.keys(queryDict)
            .map(key => { var _a; return `${encodeURIComponent(key)}=${encodeURIComponent((_a = queryDict[key]) !== null && _a !== void 0 ? _a : '')}`; })
            .join('&');
        const cleanUrl = baseUrl.split('?')[0];
        formattedUrl = `'${cleanUrl}?${queryString}'`;
    }
    else if (baseUrl) {
        formattedUrl = `'${baseUrl}'`;
    }
    if (formattedUrl) {
        segments.push(formattedUrl);
    }
    if (parsedData.headers) {
        for (const headerName in parsedData.headers) {
            segments.push('-H', `'${headerName}: ${parsedData.headers[headerName]}'`);
        }
    }
    if (parsedData.body !== undefined && parsedData.body !== null) {
        if (parsedData.bodyKind === 'json') {
            const flag = (_a = parsedData.bodyFlag) !== null && _a !== void 0 ? _a : '--data-raw';
            const jsonString = typeof parsedData.body === 'string'
                ? parsedData.body
                : JSON.stringify(parsedData.body);
            segments.push(flag, `'${jsonString}'`);
        }
        else if (typeof parsedData.body === 'object') {
            const bodyDict = parsedData.body;
            const formData = Object.keys(bodyDict)
                .map(key => { var _a; return `${encodeURIComponent(key)}=${encodeURIComponent((_a = bodyDict[key]) !== null && _a !== void 0 ? _a : '')}`; })
                .join('&');
            segments.push((_b = parsedData.bodyFlag) !== null && _b !== void 0 ? _b : '-d', `'${formData}'`);
        }
        else {
            const flag = (_c = parsedData.bodyFlag) !== null && _c !== void 0 ? _c : '--data-raw';
            segments.push(flag, `'${parsedData.body}'`);
        }
    }
    if (Array.isArray(parsedData.extraFlags)) {
        for (const flag of parsedData.extraFlags) {
            const trimmed = flag.trim();
            if (!trimmed || !trimmed.startsWith('-')) {
                continue;
            }
            segments.push(trimmed);
        }
    }
    if (segments.length === 1) {
        const fallback = (_d = parsedData.originalCommand) === null || _d === void 0 ? void 0 : _d.trim();
        if (fallback) {
            return fallback;
        }
    }
    return segments.join(' ');
}
function shouldIncludeMethodFlag(method, parsedData) {
    var _a, _b;
    if (!method) {
        return false;
    }
    if (parsedData.explicitMethod) {
        return true;
    }
    if (method === 'GET') {
        return false;
    }
    if (method === 'POST') {
        if (parsedData.body !== undefined && parsedData.body !== null) {
            return false;
        }
        const bodyFlag = (_b = (_a = parsedData.bodyFlag) === null || _a === void 0 ? void 0 : _a.toLowerCase()) !== null && _b !== void 0 ? _b : '';
        if (bodyFlag.includes('data') || bodyFlag === '-d') {
            return false;
        }
        if (Array.isArray(parsedData.extraFlags)) {
            const hasDataFlag = parsedData.extraFlags.some(flag => {
                const lower = flag.trim().toLowerCase();
                return lower.startsWith('--data') || lower.startsWith('-d');
            });
            if (hasDataFlag) {
                return false;
            }
        }
    }
    return true;
}
// Helper function to parse cURL command
// eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
function parseCurlCommand(curlString) {
    try {
        const parser = new parse_curl_js_1.CURLParser(curlString);
        const parsed = parser.parse();
        return parsed;
    }
    catch (error) {
        console.error("Error parsing cURL command:", error);
        return { error: "Failed to parse cURL command." };
    }
}
function activate(context) {
    console.log('Congratulations, your extension "curl-edit-and-resend" is now active!');
    const provider = new CurlEditAndResendProvider(context);
    const disposable = vscode.window.registerWebviewViewProvider("curlEditAndResend.sidebar", provider);
    console.log('WebviewViewProvider registered.');
    context.subscriptions.push(disposable);
    context.subscriptions.push(vscode.commands.registerCommand('curlEditAndResend.openSidebar', () => __awaiter(this, void 0, void 0, function* () {
        yield vscode.commands.executeCommand('workbench.view.extension.curl-edit-and-resend');
        console.log('cURL Editor sidebar view container focused.');
    })));
}
class CurlEditAndResendProvider {
    constructor(_context) {
        this._context = _context;
        console.log('CurlEditAndResendProvider constructor called.');
        this._sessionHex = (0, crypto_1.randomBytes)(8).toString('hex');
    }
    resolveWebviewView(webviewView, _context, _token) {
        console.log('resolveWebviewView called.');
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri],
        };
        console.log('Webview options set.');
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        console.log('Webview HTML set.');
        this._view.show(true);
        webviewView.webview.onDidReceiveMessage((message) => __awaiter(this, void 0, void 0, function* () {
            yield this._handleMessage(webviewView, message);
        }));
    }
    _getHtmlForWebview(webview) {
        const htmlPath = vscode.Uri.joinPath(this._context.extensionUri, "src", "webview", "index.html");
        console.log(`Attempting to read HTML from: ${htmlPath.fsPath}`);
        try {
            const htmlContent = fs.readFileSync(htmlPath.fsPath, "utf8");
            const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'out', 'webview', 'main.js'));
            const updatedHtml = htmlContent.replace('<!-- SCRIPT_PLACEHOLDER -->', `<script type="module" src="${scriptUri}"></script>`);
            console.log(`HTML content read successfully. Length: ${htmlContent.length}`);
            return updatedHtml;
        }
        catch (error) {
            console.error(`Error reading webview HTML file: ${error}`);
            return `<h1>Error loading webview: ${error}</h1>`;
        }
    }
    _handleMessage(webviewView, message) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f;
            switch (message.command) {
                case 'parseCurl': {
                    const curlCommand = (_a = message.text) === null || _a === void 0 ? void 0 : _a.trim();
                    if (!curlCommand) {
                        yield webviewView.webview.postMessage({
                            command: 'updateExecutionOutput',
                            text: 'Provide a cURL command to parse.',
                        });
                        return;
                    }
                    const parsed = parseCurlCommand(curlCommand);
                    if (parsed.error) {
                        yield webviewView.webview.postMessage({
                            command: 'updateExecutionOutput',
                            text: parsed.error,
                        });
                        return;
                    }
                    const normalized = normalizeParsedCurl(parsed, curlCommand);
                    this._lastParsedCurl = normalized;
                    const uiPayload = convertStateToUi(normalized);
                    yield webviewView.webview.postMessage({
                        command: 'updateParsedCurl',
                        text: JSON.stringify(uiPayload),
                    });
                    yield this._postReconstructedCurl(webviewView.webview, normalized);
                    break;
                }
                case 'reconstructCurl': {
                    if (!this._lastParsedCurl) {
                        return;
                    }
                    const updates = safeJsonParse(message.text);
                    if (!updates) {
                        return;
                    }
                    const updatedState = Object.assign(Object.assign({}, this._lastParsedCurl), { query: (_b = updates.query) !== null && _b !== void 0 ? _b : this._lastParsedCurl.query });
                    if (updates.data) {
                        const hasPairs = Object.keys(updates.data).length > 0;
                        if (hasPairs) {
                            const shouldEmitJson = this._lastParsedCurl.bodyKind === 'json' ||
                                !!((_c = this._lastParsedCurl.bodyFlag) === null || _c === void 0 ? void 0 : _c.includes('data-raw'));
                            if (shouldEmitJson) {
                                const jsonObject = dictionaryToJson(updates.data);
                                const jsonString = JSON.stringify(jsonObject);
                                updatedState.body = jsonString;
                                updatedState.rawBody = jsonString;
                                updatedState.bodyJson = jsonObject;
                                updatedState.bodyKind = 'json';
                                updatedState.bodyFlag = (_d = this._lastParsedCurl.bodyFlag) !== null && _d !== void 0 ? _d : '--data-raw';
                            }
                            else {
                                updatedState.body = updates.data;
                                updatedState.bodyJson = undefined;
                                updatedState.rawBody = undefined;
                                updatedState.bodyKind = 'form';
                                updatedState.bodyFlag = '-d';
                            }
                        }
                        else {
                            updatedState.body = this._lastParsedCurl.body;
                            updatedState.rawBody = this._lastParsedCurl.rawBody;
                            updatedState.bodyJson = this._lastParsedCurl.bodyJson;
                            updatedState.bodyKind = this._lastParsedCurl.bodyKind;
                            updatedState.bodyFlag = this._lastParsedCurl.bodyFlag;
                        }
                    }
                    else {
                        updatedState.bodyFlag = this._lastParsedCurl.bodyFlag;
                        updatedState.body = this._lastParsedCurl.body;
                        updatedState.rawBody = this._lastParsedCurl.rawBody;
                        updatedState.bodyJson = this._lastParsedCurl.bodyJson;
                        updatedState.bodyKind = this._lastParsedCurl.bodyKind;
                    }
                    if (Array.isArray(updates.flags)) {
                        updatedState.extraFlags = updates.flags
                            .filter(flag => typeof flag === 'string' && flag.trim().startsWith('-'))
                            .map(flag => flag.trim());
                    }
                    if (updates.route) {
                        updatedState.url = buildUrlFromRoute(updates.route, this._lastParsedCurl.url);
                    }
                    this._lastParsedCurl = updatedState;
                    yield this._postReconstructedCurl(webviewView.webview, updatedState);
                    break;
                }
                case 'executeCurl': {
                    const command = (_e = message.text) === null || _e === void 0 ? void 0 : _e.trim();
                    if (!command) {
                        yield webviewView.webview.postMessage({
                            command: 'updateExecutionOutput',
                            text: 'No cURL command to execute.',
                        });
                        return;
                    }
                    const result = yield this._runCurlCommand(command);
                    void webviewView.webview.postMessage({
                        command: 'updateExecutionOutput',
                        status: result.statusCode,
                        statusLabel: result.statusLabel,
                        duration: result.duration,
                        text: result.output || 'Command executed with no output.',
                    });
                    break;
                }
                case 'executeLoop': {
                    if (!this._lastParsedCurl) {
                        yield this._sendLoopError(webviewView, 'Parse a cURL command before running loops.');
                        return;
                    }
                    const payload = safeJsonParse(message.text);
                    if (!payload) {
                        yield this._sendLoopError(webviewView, 'Loop payload is invalid.');
                        return;
                    }
                    const validationError = this._validateLoopConfig(payload);
                    if (validationError) {
                        yield this._sendLoopError(webviewView, validationError);
                        return;
                    }
                    yield this._runLoopExecution(webviewView, payload);
                    break;
                }
                case 'saveOutput': {
                    const content = (_f = message.text) !== null && _f !== void 0 ? _f : '';
                    yield this._saveOutputToFile(content);
                    break;
                }
                default:
                    break;
            }
        });
    }
    _runCurlCommand(command) {
        return __awaiter(this, void 0, void 0, function* () {
            const started = Date.now();
            const { commandToExecute, statusMarker } = prepareCurlCommandForStatus(command);
            return yield new Promise(resolve => {
                (0, child_process_1.exec)(commandToExecute, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
                    var _a;
                    const duration = Date.now() - started;
                    const processedStdout = stripStatusMarker(stdout, statusMarker);
                    const combinedStdout = processedStdout.stdout;
                    const segments = [combinedStdout, stderr].filter(Boolean);
                    let output = segments.join('\n').trim();
                    const statusCode = (_a = processedStdout.statusCode) !== null && _a !== void 0 ? _a : extractStatusCode(combinedStdout, stderr);
                    let statusLabel = 'info';
                    if (error) {
                        output = `Error: ${error.message}\n${output}`.trim();
                        statusLabel = 'error';
                    }
                    else if (statusCode && statusCode >= 200 && statusCode < 300) {
                        statusLabel = 'success';
                    }
                    else if (statusCode && statusCode >= 400) {
                        statusLabel = 'error';
                    }
                    else if (!statusCode || statusCode === 0) {
                        statusLabel = 'error';
                    }
                    resolve({
                        statusCode,
                        statusLabel,
                        duration,
                        output: output || 'Command executed with no output.',
                    });
                });
            });
        });
    }
    _runLoopExecution(webviewView, config) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const loopsById = new Map(config.loops.map(loop => [loop.id, loop]));
            const assignments = this._buildLoopAssignments(config, loopsById);
            if (assignments.length === 0) {
                yield this._sendLoopError(webviewView, 'Loop configuration produces no runs.');
                return;
            }
            let aggregatedOutput = '';
            let successCount = 0;
            let failureCount = 0;
            const statusHistogram = new Map();
            yield webviewView.webview.postMessage({
                command: 'loopProgress',
                current: 0,
                total: assignments.length,
            });
            const delayMs = Math.max(0, Math.floor((_a = config.delay) !== null && _a !== void 0 ? _a : 0));
            for (let index = 0; index < assignments.length; index += 1) {
                const assignment = assignments[index];
                const stateClone = this._cloneParsedCurlState();
                if (Array.isArray(config.flags)) {
                    stateClone.extraFlags = config.flags
                        .filter(flag => typeof flag === 'string' && flag.trim().startsWith('-'))
                        .map(flag => flag.trim());
                }
                this._applyLoopAssignment(stateClone, assignment, loopsById);
                const commandText = reconstructCurlCommand({
                    method: stateClone.method,
                    explicitMethod: stateClone.explicitMethod,
                    url: stateClone.url,
                    headers: stateClone.headers,
                    query: stateClone.query,
                    body: stateClone.body,
                    bodyFlag: stateClone.bodyFlag,
                    bodyKind: stateClone.bodyKind,
                    extraFlags: stateClone.extraFlags,
                    originalCommand: stateClone.commandText,
                });
                const result = yield this._runCurlCommand(commandText);
                if (result.statusLabel === 'success') {
                    successCount += 1;
                }
                else if (result.statusLabel === 'error') {
                    failureCount += 1;
                }
                const statusKey = (_b = result.statusCode) !== null && _b !== void 0 ? _b : result.statusLabel;
                statusHistogram.set(statusKey, ((_c = statusHistogram.get(statusKey)) !== null && _c !== void 0 ? _c : 0) + 1);
                const summary = this._describeAssignment(index, assignments.length, assignment, loopsById, result.statusCode);
                aggregatedOutput += `${summary}\n${result.output}\n\n`;
                yield webviewView.webview.postMessage({
                    command: 'updateExecutionOutput',
                    text: aggregatedOutput,
                });
                yield webviewView.webview.postMessage({
                    command: 'loopProgress',
                    current: index + 1,
                    total: assignments.length,
                    status: result.statusCode,
                });
                if (delayMs > 0 && index < assignments.length - 1) {
                    yield new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
            const summaryLines = [];
            for (const [status, count] of statusHistogram.entries()) {
                summaryLines.push(`(${status}) ×${count}`);
            }
            yield webviewView.webview.postMessage({
                command: 'loopComplete',
                total: assignments.length,
                successCount,
                failureCount,
                statusSummary: summaryLines.join(' / ') || 'No status codes recorded',
            });
        });
    }
    _buildLoopAssignments(config, loopsById) {
        var _a, _b;
        const syncedIds = config.syncedLoopIds.filter(id => loopsById.has(id));
        let assignments = [{}];
        if (syncedIds.length > 0) {
            const referenceLength = (_b = (_a = loopsById.get(syncedIds[0])) === null || _a === void 0 ? void 0 : _a.values.length) !== null && _b !== void 0 ? _b : 0;
            assignments = [];
            for (let index = 0; index < referenceLength; index += 1) {
                const assignment = {};
                for (const loopId of syncedIds) {
                    const loop = loopsById.get(loopId);
                    if (loop) {
                        assignment[loop.id] = loop.values[index];
                    }
                }
                assignments.push(assignment);
            }
        }
        const independentLoops = config.loops.filter(loop => !syncedIds.includes(loop.id));
        for (const loop of independentLoops) {
            const nextAssignments = [];
            for (const assignment of assignments) {
                for (const value of loop.values) {
                    nextAssignments.push(Object.assign(Object.assign({}, assignment), { [loop.id]: value }));
                }
            }
            assignments = nextAssignments;
        }
        return assignments;
    }
    _cloneParsedCurlState() {
        if (!this._lastParsedCurl) {
            throw new Error('No parsed cURL state available.');
        }
        const clonedBody = typeof this._lastParsedCurl.body === 'object' && this._lastParsedCurl.body
            ? Object.assign({}, this._lastParsedCurl.body) : this._lastParsedCurl.body;
        return {
            commandText: this._lastParsedCurl.commandText,
            url: this._lastParsedCurl.url,
            method: this._lastParsedCurl.method,
            explicitMethod: this._lastParsedCurl.explicitMethod,
            headers: Object.assign({}, this._lastParsedCurl.headers),
            query: Object.assign({}, this._lastParsedCurl.query),
            body: clonedBody,
            rawBody: this._lastParsedCurl.rawBody,
            bodyFlag: this._lastParsedCurl.bodyFlag,
            bodyKind: this._lastParsedCurl.bodyKind,
            bodyJson: this._lastParsedCurl.bodyJson
                ? JSON.parse(JSON.stringify(this._lastParsedCurl.bodyJson))
                : undefined,
            extraFlags: this._lastParsedCurl.extraFlags ? [...this._lastParsedCurl.extraFlags] : undefined,
        };
    }
    _applyLoopAssignment(state, assignment, loopsById) {
        var _a, _b, _c;
        for (const [loopId, value] of Object.entries(assignment)) {
            const loop = loopsById.get(loopId);
            if (!loop) {
                continue;
            }
            if (loop.targetType === 'query') {
                const query = Object.assign({}, state.query);
                query[loop.targetKey] = this._valueToString(value);
                state.query = query;
            }
            else if (loop.targetType === 'header') {
                const normalizedFlag = normalizeLoopFlag(loop.targetFlag);
                const headerValue = this._valueToString(value);
                if (headerFlagRequiresName(normalizedFlag)) {
                    const headerKey = (_a = loop.targetKey) === null || _a === void 0 ? void 0 : _a.trim();
                    if (headerKey) {
                        const headers = Object.assign({}, state.headers);
                        headers[headerKey] = headerValue;
                        state.headers = headers;
                    }
                }
                else {
                    state.extraFlags = this._applyFlagOverride(state.extraFlags, normalizedFlag, headerValue);
                }
            }
            else if (loop.targetType === 'route') {
                const routeKey = normalizeRouteLoopKey(loop.targetKey);
                if (!routeKey) {
                    continue;
                }
                const routeValue = sanitizeRouteValue(routeKey, this._valueToString(value));
                const currentRoute = convertUrlToRoute(state.url);
                const updatedRoute = Object.assign(Object.assign({}, currentRoute), { [routeKey]: routeValue });
                state.url = buildUrlFromRoute(updatedRoute, state.url);
            }
            else {
                if (state.bodyKind === 'json') {
                    const jsonBody = state.bodyJson && typeof state.bodyJson === 'object'
                        ? Object.assign({}, state.bodyJson) : {};
                    jsonBody[loop.targetKey] = value;
                    state.bodyJson = jsonBody;
                    state.body = JSON.stringify(jsonBody);
                    state.bodyFlag = (_b = state.bodyFlag) !== null && _b !== void 0 ? _b : '--data-raw';
                    state.bodyKind = 'json';
                }
                else {
                    const formBody = this._ensureFormBody(state);
                    formBody[loop.targetKey] = typeof value === 'string' ? value : JSON.stringify(value);
                    state.body = formBody;
                    state.bodyFlag = (_c = state.bodyFlag) !== null && _c !== void 0 ? _c : '-d';
                    state.bodyKind = 'form';
                }
            }
        }
    }
    _ensureFormBody(state) {
        if (state.body && typeof state.body === 'object') {
            return state.body;
        }
        const body = {};
        state.body = body;
        return body;
    }
    _applyFlagOverride(flags, flag, value) {
        const formattedValue = formatFlagValueForCommand(value);
        const normalizedFlag = flag.toLowerCase();
        const base = flags ? [...flags] : [];
        const filtered = base.filter(entry => {
            const trimmed = entry.trim().toLowerCase();
            return !(trimmed === normalizedFlag || trimmed.startsWith(`${normalizedFlag} `));
        });
        filtered.push(`${flag} ${formattedValue}`);
        return filtered;
    }
    _valueToString(value) {
        if (value === null || value === undefined) {
            return '';
        }
        if (typeof value === 'object') {
            try {
                return JSON.stringify(value);
            }
            catch (_a) {
                return String(value);
            }
        }
        return String(value);
    }
    _formatAssignmentValue(value) {
        if (value === null) {
            return 'null';
        }
        if (value === undefined) {
            return 'undefined';
        }
        if (typeof value === 'object') {
            try {
                return JSON.stringify(value);
            }
            catch (_a) {
                return '[object]';
            }
        }
        return String(value);
    }
    _describeAssignment(index, total, assignment, loopsById, statusCode) {
        const assignments = Object.entries(assignment).map(([loopId, value]) => {
            var _a, _b, _c;
            const loop = loopsById.get(loopId);
            const loopKey = loop
                ? loop.targetType === 'header'
                    ? (((_a = loop.targetKey) === null || _a === void 0 ? void 0 : _a.trim()) ? loop.targetKey : (_b = loop.targetFlag) !== null && _b !== void 0 ? _b : 'header')
                    : loop.targetType === 'route'
                        ? (_c = normalizeRouteLoopKey(loop.targetKey)) !== null && _c !== void 0 ? _c : 'route'
                        : loop.targetKey
                : loopId;
            const targetLabel = loop ? `${loop.targetType}:${loopKey}` : loopId;
            return `${targetLabel}=${this._formatAssignmentValue(value)}`;
        });
        const assignmentSummary = assignments.length ? assignments.join(', ') : 'No overrides';
        const statusSummary = statusCode !== undefined ? `Status: ${statusCode}` : 'Status: n/a';
        return `Run ${index + 1} of ${total} → ${assignmentSummary}\n${statusSummary}`;
    }
    _validateLoopConfig(config) {
        var _a;
        if (!config.loops || config.loops.length === 0) {
            return 'Add at least one loop before running.';
        }
        if (config.delay !== undefined && config.delay < 0) {
            return 'Delay between requests must be 0 or greater.';
        }
        const ids = new Set();
        for (const loop of config.loops) {
            if (!loop.id) {
                return 'Loop identifier missing.';
            }
            if (ids.has(loop.id)) {
                return `Duplicate loop identifier "${loop.id}".`;
            }
            ids.add(loop.id);
            if (loop.targetType === 'header' && !loop.targetFlag) {
                return `Loop "${loop.name || loop.id}" needs a header flag.`;
            }
            if (loop.targetType === 'route') {
                const routeKey = normalizeRouteLoopKey(loop.targetKey);
                if (!routeKey) {
                    return `Loop "${loop.name || loop.id}" must target scheme, subdomain, domain, port, or path.`;
                }
                loop.targetKey = routeKey;
            }
            const requiresKey = loop.targetType !== 'header' || headerFlagRequiresName(loop.targetFlag);
            if (requiresKey && !((_a = loop.targetKey) === null || _a === void 0 ? void 0 : _a.trim())) {
                return `Loop "${loop.name || loop.id}" needs a target key.`;
            }
            if (!Array.isArray(loop.values) || loop.values.length === 0) {
                return `Loop "${loop.name || loop.targetKey || loop.id}" has no values.`;
            }
        }
        const syncedLoops = config.syncedLoopIds
            .map(id => config.loops.find(loop => loop.id === id))
            .filter((loop) => Boolean(loop));
        if (syncedLoops.length > 0) {
            const referenceLength = syncedLoops[0].values.length;
            if (referenceLength === 0) {
                return 'Synchronized loops cannot be empty.';
            }
            const mismatch = syncedLoops.some(loop => loop.values.length !== referenceLength);
            if (mismatch) {
                return 'Synchronized loops must have identical lengths.';
            }
        }
        return undefined;
    }
    _sendLoopError(webviewView, message) {
        return __awaiter(this, void 0, void 0, function* () {
            yield webviewView.webview.postMessage({
                command: 'updateExecutionOutput',
                text: message,
            });
            yield webviewView.webview.postMessage({
                command: 'loopComplete',
                error: message,
                total: 0,
                successCount: 0,
                failureCount: 0,
            });
        });
    }
    _postReconstructedCurl(webview, state) {
        return __awaiter(this, void 0, void 0, function* () {
            const curlText = reconstructCurlCommand({
                method: state.method,
                explicitMethod: state.explicitMethod,
                url: state.url,
                headers: state.headers,
                query: state.query,
                body: state.body,
                bodyFlag: state.bodyFlag,
                bodyKind: state.bodyKind,
                extraFlags: state.extraFlags,
                originalCommand: state.commandText,
            });
            yield webview.postMessage({
                command: 'updateReconstructedCurl',
                text: curlText,
            });
        });
    }
    _saveOutputToFile(content) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const outputDir = yield this._ensureOutputDirectory();
                const fileUri = vscode.Uri.joinPath(outputDir, `${this._sessionHex}.txt`);
                yield vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
                yield vscode.window.showInformationMessage(`Saved response output to ${fileUri.fsPath}`);
            }
            catch (error) {
                console.error('Failed to save output file', error);
                yield vscode.window.showErrorMessage(`Failed to save output: ${error}`);
            }
        });
    }
    _ensureOutputDirectory() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const workspaceFolder = (_a = vscode.workspace.workspaceFolders) === null || _a === void 0 ? void 0 : _a[0];
            const baseUri = (_b = workspaceFolder === null || workspaceFolder === void 0 ? void 0 : workspaceFolder.uri) !== null && _b !== void 0 ? _b : this._context.globalStorageUri;
            const targetDir = vscode.Uri.joinPath(baseUri, '.edit-and-send');
            yield vscode.workspace.fs.createDirectory(targetDir);
            return targetDir;
        });
    }
}
exports.CurlEditAndResendProvider = CurlEditAndResendProvider;
function deactivate() { }
//# sourceMappingURL=extension.js.map