import * as vscode from 'vscode';
import * as fs from 'fs';
import { exec } from 'child_process';
import { randomBytes } from 'crypto';
import { CURLParser } from 'parse-curl-js';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { toJsonObject } = require('curlconverter');

type Dictionary = Record<string, string>;

interface ParsedCurlState {
  commandText: string;
  url: string;
  method: string;
  explicitMethod?: boolean;
  headers: Dictionary;
  query: Dictionary;
  body?: string | Dictionary;
  rawBody?: string;
  bodyFlag?: string;
  bodyKind?: 'json' | 'form' | 'raw';
  bodyJson?: unknown;
  extraFlags?: string[];
}

interface ParsedCurlUiPayload {
  url: string;
  method: string;
  headers: Dictionary;
  query: Dictionary;
  data: Dictionary;
  rawBody?: string;
  bodyKind?: 'json' | 'form' | 'raw';
  flags: string[];
  route: RouteParts;
}

interface WebviewMessage {
  command: string;
  text?: string;
}

interface LoopFieldConfig {
  id: string;
  name: string;
  targetType: 'query' | 'form' | 'header' | 'route';
  targetFlag?: string;
  targetKey: string;
  values: unknown[];
}

interface LoopExecutionRequest {
  loops: LoopFieldConfig[];
  syncedLoopIds: string[];
  delay?: number;
  flags?: string[];
}

type LoopAssignment = Record<string, unknown>;

function normalizeRecord(input: unknown): Dictionary {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const result: Dictionary = {};
  for (const key of Object.keys(input as Record<string, unknown>)) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      result[key] = JSON.stringify(value);
    } else if (typeof value === 'object') {
      result[key] = JSON.stringify(value);
    } else {
      result[key] = String(value);
    }
  }

  return result;
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function stripWrappingQuotes(value: string): string {
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

function dictionaryToJson(dict: Dictionary): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(dict)) {
    result[key] = tryParseJson(dict[key]);
  }
  return result;
}

function stripQuotedText(command: string): string {
  return command.replace(/(["'])(?:\\.|[^\\])*?\1/g, ' ');
}

function methodWasExplicit(command: string): boolean {
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

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const regex = /'[^']*'|"[^"]*"|[^ \t\r\n]+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(command)) !== null) {
    tokens.push(match[0]);
  }
  return tokens;
}

function extractFlagsFromCommand(command: string): string[] {
  const tokens = tokenizeCommand(command);
  if (!tokens.length) {
    return [];
  }
  const results: string[] = [];
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
    let value: string | undefined;
    if (index + 1 < tokens.length && !tokens[index + 1].startsWith('-')) {
      value = tokens[index + 1];
      index += 1;
    }
    results.push(value ? `${token} ${value}` : token);
  }
  return results;
}

const HEADER_LOOP_FLAG_NORMALIZATION: Record<string, string> = {
  '-h': '-H',
  '-H': '-H',
  '--header': '--header',
  '-b': '-b',
  '--cookie': '--cookie',
};

const ROUTE_LOOP_KEYS_SET = new Set(['scheme', 'subdomain', 'domain', 'port', 'path']);

function normalizeLoopFlag(flag?: string | null): string {
  if (!flag) {
    return '-H';
  }
  const normalized = HEADER_LOOP_FLAG_NORMALIZATION[flag.trim().toLowerCase()];
  return normalized ?? '-H';
}

function headerFlagRequiresName(flag?: string | null): boolean {
  const normalized = normalizeLoopFlag(flag);
  return normalized === '-H' || normalized === '--header';
}

function formatFlagValueForCommand(value: string): string {
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

interface RouteParts {
  scheme?: string;
  subdomain?: string;
  domain?: string;
  port?: string;
  path?: string;
}

function safeParseUrl(url: string): URL | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url);
  } catch {
    try {
      return new URL(`https://${url.replace(/^\/+/g, '')}`);
    } catch {
      return undefined;
    }
  }
}

function splitHost(host: string): { subdomain?: string; domain?: string } {
  const parts = host.split('.');
  if (parts.length <= 2) {
    return { domain: host };
  }
  return {
    subdomain: parts[0],
    domain: parts.slice(1).join('.'),
  };
}

function convertUrlToRoute(url: string): RouteParts {
  const parsed = safeParseUrl(url);
  if (!parsed) {
    return {};
  }

  const route: RouteParts = {};
  route.scheme = parsed.protocol.replace(':', '');
  const hostInfo = splitHost(parsed.hostname);
  route.subdomain = hostInfo.subdomain ?? '';
  route.domain = hostInfo.domain ?? '';
  route.port = parsed.port ?? '';
  const path = parsed.pathname.replace(/^\/+/g, '').replace(/\/+/g, '/').replace(/\/$/g, '');
  route.path = path;
  return route;
}

function buildUrlFromRoute(route: RouteParts, fallbackUrl: string): string {
  const fallback = safeParseUrl(fallbackUrl);
  const fallbackScheme = fallback?.protocol ? fallback.protocol.replace(':', '') : 'https';
  const fallbackHost = fallback?.hostname ?? '';
  const fallbackPort = fallback?.port ?? '';
  const fallbackPath = fallback?.pathname ?? '';

  const schemeCandidate = route.scheme !== undefined ? route.scheme.trim().toLowerCase() : undefined;
  const scheme = schemeCandidate || fallbackScheme || 'https';

  const domainCandidate = route.domain !== undefined ? route.domain.trim() : undefined;
  const subdomainCandidate = route.subdomain !== undefined ? route.subdomain.trim() : undefined;

  let host = fallbackHost;
  if (domainCandidate) {
    host = subdomainCandidate ? `${subdomainCandidate}.${domainCandidate}` : domainCandidate;
  } else if (subdomainCandidate !== undefined) {
    if (!subdomainCandidate.length) {
      const existing = splitHost(fallbackHost);
      host = existing.domain ?? fallbackHost;
    } else {
      const existing = splitHost(fallbackHost);
      const baseDomain = existing.domain ?? fallbackHost;
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

function sanitizeRouteValue(key: string, value: string): string {
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

function normalizeRouteLoopKey(key?: string | null): string | undefined {
  const trimmed = key?.trim().toLowerCase() ?? '';
  return ROUTE_LOOP_KEYS_SET.has(trimmed) ? trimmed : undefined;
}

function indicatesJsonContentType(headers: unknown): boolean {
  if (!headers || typeof headers !== 'object') {
    return false;
  }

  const entries = headers as Record<string, unknown>;
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

function parseFormBody(input: string): Dictionary | undefined {
  if (!input.includes('=')) {
    return undefined;
  }

  const params = new URLSearchParams(input);
  const record: Dictionary = {};
  for (const [key, value] of params.entries()) {
    if (!key) {
      continue;
    }
    record[key] = value;
  }

  return Object.keys(record).length ? record : undefined;
}

function extractBodyDetails(body: unknown): { bodyPayload?: string | Dictionary; rawBody?: string; formData: Dictionary; jsonValue?: unknown } {
  const formData: Dictionary = {};
  let bodyPayload: string | Dictionary | undefined;
  let rawBody: string | undefined;
  let jsonValue: unknown;

  const applyString = (value: string) => {
    rawBody = value;
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        jsonValue = JSON.parse(trimmed);
      } catch {
        jsonValue = undefined;
      }
    }

    const parsedForm = parseFormBody(value);
    if (parsedForm) {
      Object.assign(formData, parsedForm);
      bodyPayload = parsedForm;
    } else {
      bodyPayload = value;
    }
  };

  const applyObject = (value: Record<string, unknown>) => {
    const normalized: Dictionary = {};
    for (const key of Object.keys(value)) {
      const entry = value[key];
      if (entry === undefined || entry === null) {
        continue;
      }
      if (Array.isArray(entry)) {
        normalized[key] = JSON.stringify(entry);
      } else if (typeof entry === 'object') {
        normalized[key] = JSON.stringify(entry);
      } else {
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
    const value = body as Record<string, unknown>;
    const nested = value.data ?? value.text ?? value.value;
    if (typeof nested === 'string') {
      applyString(nested);
    } else if (nested && typeof nested === 'object') {
      applyObject(nested as Record<string, unknown>);
    } else {
      applyObject(value);
    }
  }

  return { bodyPayload, rawBody, formData, jsonValue };
}

function inferBodyFlag(originalCommand: string, bodyPayload?: string | Dictionary): string | undefined {
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

function normalizeParsedCurl(parsed: unknown, originalCommand: string): ParsedCurlState {
  const data = parsed as Record<string, unknown>;
  const url = typeof data.url === 'string' ? stripWrappingQuotes(data.url) : '';
  const method = typeof data.method === 'string' ? data.method : 'GET';
  const explicitMethod = methodWasExplicit(originalCommand);
  const headers = normalizeRecord(data.headers);
  const query = normalizeRecord(data.query);
  const { bodyPayload, rawBody, formData, jsonValue } = extractBodyDetails(data.body ?? data.data);
  let converted: Record<string, unknown> | undefined;

  try {
    const conversionResult = toJsonObject(originalCommand);
    if (conversionResult && typeof conversionResult === 'object') {
      converted = conversionResult as Record<string, unknown>;
    }
  } catch (error) {
    console.error('curlconverter failed to parse command:', error);
  }

  const state: ParsedCurlState = {
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
  } else if (state.body && typeof state.body === 'object') {
    state.bodyKind = 'form';
  } else if (typeof state.body === 'string' || rawBody) {
    state.bodyKind = 'raw';
  }

  if (converted) {
    const convertedData = (converted as { data?: unknown }).data;
    const convertedHeaders = (converted as { headers?: unknown }).headers;
    const headersIndicateJson = indicatesJsonContentType(convertedHeaders);
    const bodyFlagSuggestsJson = state.bodyFlag?.includes('raw') || state.bodyFlag?.includes('binary');
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
            } catch {
              // ignore invalid JSON
            }
          }
        }
      } else if (convertedData && typeof convertedData === 'object') {
        if (preferJson) {
          const jsonString = JSON.stringify(convertedData);
          state.rawBody = jsonString;
          state.body = jsonString;
          state.bodyJson = convertedData;
          state.bodyKind = 'json';
        } else if (!state.rawBody) {
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
    } else if (state.bodyKind === 'form') {
      state.bodyFlag = '-d';
    }
  }

  const extractedFlags = extractFlagsFromCommand(originalCommand);
  if (extractedFlags.length) {
    state.extraFlags = extractedFlags;
  }

  return state;
}

function convertStateToUi(state: ParsedCurlState): ParsedCurlUiPayload {
  const data =
    state.body && typeof state.body === 'object'
      ? state.body as Dictionary
      : state.bodyKind === 'json' && state.bodyJson && !Array.isArray(state.bodyJson)
        ? normalizeRecord(state.bodyJson)
        : {};

  const rawBody =
    typeof state.body === 'string'
      ? state.body
      : state.rawBody ?? (state.bodyKind === 'json' && state.bodyJson ? JSON.stringify(state.bodyJson) : undefined);

  return {
    url: state.url,
    method: state.method,
    headers: state.headers,
    query: state.query,
    data,
    rawBody,
    bodyKind: state.bodyKind,
    flags: state.extraFlags ?? [],
    route: convertUrlToRoute(state.url),
  };
}

function safeJsonParse<T>(text: string | undefined): T | undefined {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function extractStatusCode(stdout: string, stderr: string): number | undefined {
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

function prepareCurlCommandForStatus(command: string): { commandToExecute: string; statusMarker?: string } {
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

function stripStatusMarker(stdout: string, marker?: string): { stdout: string; statusCode?: number } {
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

interface ReconstructableCurl {
  method?: string;
  explicitMethod?: boolean;
  url?: string;
  headers?: Dictionary;
  query?: Dictionary;
  body?: string | Dictionary;
  bodyFlag?: string;
  bodyKind?: 'json' | 'form' | 'raw';
  extraFlags?: string[];
  originalCommand?: string;
}

function reconstructCurlCommand(parsedData: ReconstructableCurl): string {
  const segments: string[] = ['curl'];

  const method = parsedData.method ? parsedData.method.toUpperCase() : undefined;
  if (shouldIncludeMethodFlag(method, parsedData)) {
    segments.push('-X', method as string);
  }

  const baseUrl = parsedData.url || '';
  let formattedUrl = '';
  if (baseUrl && parsedData.query && Object.keys(parsedData.query).length > 0) {
    const queryDict = parsedData.query;
    const queryString = Object.keys(queryDict)
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(queryDict[key] ?? '')}`)
      .join('&');
    const cleanUrl = baseUrl.split('?')[0];
    formattedUrl = `'${cleanUrl}?${queryString}'`;
  } else if (baseUrl) {
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
      const flag = parsedData.bodyFlag ?? '--data-raw';
      const jsonString = typeof parsedData.body === 'string'
        ? parsedData.body
        : JSON.stringify(parsedData.body);
      segments.push(flag, `'${jsonString}'`);
    } else if (typeof parsedData.body === 'object') {
      const bodyDict = parsedData.body as Dictionary;
      const formData = Object.keys(bodyDict)
        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(bodyDict[key] ?? '')}`)
        .join('&');
      segments.push(parsedData.bodyFlag ?? '-d', `'${formData}'`);
    } else {
      const flag = parsedData.bodyFlag ?? '--data-raw';
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
    const fallback = parsedData.originalCommand?.trim();
    if (fallback) {
      return fallback;
    }
  }

  return segments.join(' ');
}

function shouldIncludeMethodFlag(method: string | undefined, parsedData: ReconstructableCurl): boolean {
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
    const bodyFlag = parsedData.bodyFlag?.toLowerCase() ?? '';
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
function parseCurlCommand(curlString: string): any {
  try {
    const parser = new CURLParser(curlString);
    const parsed = parser.parse();
    return parsed;
  } catch (error) {
    console.error("Error parsing cURL command:", error);
    return { error: "Failed to parse cURL command." };
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Congratulations, your extension "curl-edit-and-resend" is now active!');

  const provider = new CurlEditAndResendProvider(context);
  const disposable = vscode.window.registerWebviewViewProvider(
    "curlEditAndResend.sidebar",
    provider
  );
  console.log('WebviewViewProvider registered.');

  context.subscriptions.push(disposable);

  context.subscriptions.push(vscode.commands.registerCommand(
    'curlEditAndResend.openSidebar',
    async () => {
      await vscode.commands.executeCommand('workbench.view.extension.curl-edit-and-resend');
      console.log('cURL Editor sidebar view container focused.');
    }
  ));
}

export class CurlEditAndResendProvider implements vscode.WebviewViewProvider {
  _view?: vscode.WebviewView;
  private _lastParsedCurl?: ParsedCurlState;
  private readonly _sessionHex: string;

  constructor(private readonly _context: vscode.ExtensionContext) {
    console.log('CurlEditAndResendProvider constructor called.');
    this._sessionHex = randomBytes(8).toString('hex');
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
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

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      await this._handleMessage(webviewView, message);
    });
  }

  protected _getHtmlForWebview(webview: vscode.Webview) {
    const htmlPath = vscode.Uri.joinPath(this._context.extensionUri, "src", "webview", "index.html");
    console.log(`Attempting to read HTML from: ${htmlPath.fsPath}`);
    try {
      const htmlContent = fs.readFileSync(htmlPath.fsPath, "utf8");
      const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'out', 'webview', 'main.js'));
      const updatedHtml = htmlContent.replace('<!-- SCRIPT_PLACEHOLDER -->', `<script type="module" src="${scriptUri}"></script>`);
      console.log(`HTML content read successfully. Length: ${htmlContent.length}`);
      return updatedHtml;
    } catch (error) {
      console.error(`Error reading webview HTML file: ${error}`);
      return `<h1>Error loading webview: ${error}</h1>`;
    }
  }

  private async _handleMessage(webviewView: vscode.WebviewView, message: WebviewMessage) {
    switch (message.command) {
      case 'parseCurl': {
        const curlCommand = message.text?.trim();
        if (!curlCommand) {
          await webviewView.webview.postMessage({
            command: 'updateExecutionOutput',
            text: 'Provide a cURL command to parse.',
          });
          return;
        }

        const parsed = parseCurlCommand(curlCommand);
        if ((parsed as { error?: string }).error) {
          await webviewView.webview.postMessage({
            command: 'updateExecutionOutput',
            text: (parsed as { error: string }).error,
          });
          return;
        }

        const normalized = normalizeParsedCurl(parsed, curlCommand);
        this._lastParsedCurl = normalized;

        const uiPayload = convertStateToUi(normalized);
        await webviewView.webview.postMessage({
          command: 'updateParsedCurl',
          text: JSON.stringify(uiPayload),
        });

        await this._postReconstructedCurl(webviewView.webview, normalized);
        break;
      }
      case 'reconstructCurl': {
        if (!this._lastParsedCurl) {
          return;
        }

        const updates = safeJsonParse<{ query?: Dictionary; data?: Dictionary; flags?: string[]; route?: RouteParts }>(message.text);
        if (!updates) {
          return;
        }

        const updatedState: ParsedCurlState = {
          ...this._lastParsedCurl,
          query: updates.query ?? this._lastParsedCurl.query,
        };

        if (updates.data) {
          const hasPairs = Object.keys(updates.data).length > 0;
          if (hasPairs) {
            const shouldEmitJson =
              this._lastParsedCurl.bodyKind === 'json' ||
              !!this._lastParsedCurl.bodyFlag?.includes('data-raw');
            if (shouldEmitJson) {
              const jsonObject = dictionaryToJson(updates.data);
              const jsonString = JSON.stringify(jsonObject);
              updatedState.body = jsonString;
              updatedState.rawBody = jsonString;
              updatedState.bodyJson = jsonObject;
              updatedState.bodyKind = 'json';
              updatedState.bodyFlag = this._lastParsedCurl.bodyFlag ?? '--data-raw';
            } else {
              updatedState.body = updates.data;
              updatedState.bodyJson = undefined;
              updatedState.rawBody = undefined;
              updatedState.bodyKind = 'form';
              updatedState.bodyFlag = '-d';
            }
          } else {
            updatedState.body = this._lastParsedCurl.body;
            updatedState.rawBody = this._lastParsedCurl.rawBody;
            updatedState.bodyJson = this._lastParsedCurl.bodyJson;
            updatedState.bodyKind = this._lastParsedCurl.bodyKind;
            updatedState.bodyFlag = this._lastParsedCurl.bodyFlag;
          }
        } else {
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
        await this._postReconstructedCurl(webviewView.webview, updatedState);
        break;
      }
      case 'executeCurl': {
        const command = message.text?.trim();
        if (!command) {
          await webviewView.webview.postMessage({
            command: 'updateExecutionOutput',
            text: 'No cURL command to execute.',
          });
          return;
        }
        const result = await this._runCurlCommand(command);
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
          await this._sendLoopError(webviewView, 'Parse a cURL command before running loops.');
          return;
        }
        const payload = safeJsonParse<LoopExecutionRequest>(message.text);
        if (!payload) {
          await this._sendLoopError(webviewView, 'Loop payload is invalid.');
          return;
        }
        const validationError = this._validateLoopConfig(payload);
        if (validationError) {
          await this._sendLoopError(webviewView, validationError);
          return;
        }
        await this._runLoopExecution(webviewView, payload);
        break;
      }
      case 'saveOutput': {
        const content = message.text ?? '';
        await this._saveOutputToFile(content);
        break;
      }
      default:
        break;
    }
  }

  private async _runCurlCommand(command: string): Promise<{
    statusCode?: number;
    statusLabel: 'success' | 'error' | 'info';
    duration: number;
    output: string;
  }> {
    const started = Date.now();
    const { commandToExecute, statusMarker } = prepareCurlCommandForStatus(command);
    return await new Promise(resolve => {
      exec(commandToExecute, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
        const duration = Date.now() - started;
        const processedStdout = stripStatusMarker(stdout, statusMarker);
        const combinedStdout = processedStdout.stdout;
        const segments = [combinedStdout, stderr].filter(Boolean);
        let output = segments.join('\n').trim();
        const statusCode = processedStdout.statusCode ?? extractStatusCode(combinedStdout, stderr);
        let statusLabel: 'success' | 'error' | 'info' = 'info';
        if (error) {
          output = `Error: ${error.message}\n${output}`.trim();
          statusLabel = 'error';
        } else if (statusCode && statusCode >= 200 && statusCode < 300) {
          statusLabel = 'success';
        } else if (statusCode && statusCode >= 400) {
          statusLabel = 'error';
        } else if (!statusCode || statusCode === 0) {
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
  }

  private async _runLoopExecution(webviewView: vscode.WebviewView, config: LoopExecutionRequest) {
    const loopsById = new Map(config.loops.map(loop => [loop.id, loop]));
    const assignments = this._buildLoopAssignments(config, loopsById);

    if (assignments.length === 0) {
      await this._sendLoopError(webviewView, 'Loop configuration produces no runs.');
      return;
    }

    let aggregatedOutput = '';
    let successCount = 0;
    let failureCount = 0;
    const statusHistogram = new Map<number | string, number>();

    await webviewView.webview.postMessage({
      command: 'loopProgress',
      current: 0,
      total: assignments.length,
    });

    const delayMs = Math.max(0, Math.floor(config.delay ?? 0));

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

      const result = await this._runCurlCommand(commandText);
      if (result.statusLabel === 'success') {
        successCount += 1;
      } else if (result.statusLabel === 'error') {
        failureCount += 1;
      }

      const statusKey = result.statusCode ?? result.statusLabel;
      statusHistogram.set(statusKey, (statusHistogram.get(statusKey) ?? 0) + 1);

      const summary = this._describeAssignment(index, assignments.length, assignment, loopsById, result.statusCode);
      aggregatedOutput += `${summary}\n${result.output}\n\n`;

      await webviewView.webview.postMessage({
        command: 'updateExecutionOutput',
        text: aggregatedOutput,
      });

      await webviewView.webview.postMessage({
        command: 'loopProgress',
        current: index + 1,
        total: assignments.length,
        status: result.statusCode,
      });

      if (delayMs > 0 && index < assignments.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    const summaryLines: string[] = [];
    for (const [status, count] of statusHistogram.entries()) {
      summaryLines.push(`(${status}) ×${count}`);
    }

    await webviewView.webview.postMessage({
      command: 'loopComplete',
      total: assignments.length,
      successCount,
      failureCount,
      statusSummary: summaryLines.join(' / ') || 'No status codes recorded',
    });
  }

  private _buildLoopAssignments(config: LoopExecutionRequest, loopsById: Map<string, LoopFieldConfig>): LoopAssignment[] {
    const syncedIds = config.syncedLoopIds.filter(id => loopsById.has(id));
    let assignments: LoopAssignment[] = [{}];

    if (syncedIds.length > 0) {
      const referenceLength = loopsById.get(syncedIds[0])?.values.length ?? 0;
      assignments = [];
      for (let index = 0; index < referenceLength; index += 1) {
        const assignment: LoopAssignment = {};
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
      const nextAssignments: LoopAssignment[] = [];
      for (const assignment of assignments) {
        for (const value of loop.values) {
          nextAssignments.push({
            ...assignment,
            [loop.id]: value,
          });
        }
      }
      assignments = nextAssignments;
    }

    return assignments;
  }

  private _cloneParsedCurlState(): ParsedCurlState {
    if (!this._lastParsedCurl) {
      throw new Error('No parsed cURL state available.');
    }

    const clonedBody = typeof this._lastParsedCurl.body === 'object' && this._lastParsedCurl.body
      ? { ...(this._lastParsedCurl.body as Dictionary) }
      : this._lastParsedCurl.body;

    return {
      commandText: this._lastParsedCurl.commandText,
      url: this._lastParsedCurl.url,
      method: this._lastParsedCurl.method,
      explicitMethod: this._lastParsedCurl.explicitMethod,
      headers: { ...this._lastParsedCurl.headers },
      query: { ...this._lastParsedCurl.query },
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

  private _applyLoopAssignment(
    state: ParsedCurlState,
    assignment: LoopAssignment,
    loopsById: Map<string, LoopFieldConfig>
  ) {
    for (const [loopId, value] of Object.entries(assignment)) {
      const loop = loopsById.get(loopId);
      if (!loop) {
        continue;
      }

      if (loop.targetType === 'query') {
        const query = { ...state.query };
        query[loop.targetKey] = this._valueToString(value);
        state.query = query;
      } else if (loop.targetType === 'header') {
        const normalizedFlag = normalizeLoopFlag(loop.targetFlag);
        const headerValue = this._valueToString(value);
        if (headerFlagRequiresName(normalizedFlag)) {
          const headerKey = loop.targetKey?.trim();
          if (headerKey) {
            const headers = { ...state.headers };
            headers[headerKey] = headerValue;
            state.headers = headers;
          }
        } else {
          state.extraFlags = this._applyFlagOverride(state.extraFlags, normalizedFlag, headerValue);
        }
      } else if (loop.targetType === 'route') {
        const routeKey = normalizeRouteLoopKey(loop.targetKey);
        if (!routeKey) {
          continue;
        }
        const routeValue = sanitizeRouteValue(routeKey, this._valueToString(value));
        const currentRoute = convertUrlToRoute(state.url);
        const updatedRoute: RouteParts = {
          ...currentRoute,
          [routeKey]: routeValue,
        };
        state.url = buildUrlFromRoute(updatedRoute, state.url);
      } else {
        if (state.bodyKind === 'json') {
          const jsonBody: Record<string, unknown> = state.bodyJson && typeof state.bodyJson === 'object'
            ? { ...(state.bodyJson as Record<string, unknown>) }
            : {};
          jsonBody[loop.targetKey] = value;
          state.bodyJson = jsonBody;
          state.body = JSON.stringify(jsonBody);
          state.bodyFlag = state.bodyFlag ?? '--data-raw';
          state.bodyKind = 'json';
        } else {
          const formBody = this._ensureFormBody(state);
          formBody[loop.targetKey] = typeof value === 'string' ? value : JSON.stringify(value);
          state.body = formBody;
          state.bodyFlag = state.bodyFlag ?? '-d';
          state.bodyKind = 'form';
        }
      }
    }
  }

  private _ensureFormBody(state: ParsedCurlState): Dictionary {
    if (state.body && typeof state.body === 'object') {
      return state.body as Dictionary;
    }
    const body: Dictionary = {};
    state.body = body;
    return body;
  }

  private _applyFlagOverride(flags: string[] | undefined, flag: string, value: string): string[] {
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

  private _valueToString(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  private _formatAssignmentValue(value: unknown): string {
    if (value === null) {
      return 'null';
    }
    if (value === undefined) {
      return 'undefined';
    }
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return '[object]';
      }
    }
    return String(value);
  }

  private _describeAssignment(
    index: number,
    total: number,
    assignment: LoopAssignment,
    loopsById: Map<string, LoopFieldConfig>,
    statusCode?: number
  ): string {
    const assignments = Object.entries(assignment).map(([loopId, value]) => {
      const loop = loopsById.get(loopId);
      const loopKey = loop
        ? loop.targetType === 'header'
          ? (loop.targetKey?.trim() ? loop.targetKey : loop.targetFlag ?? 'header')
          : loop.targetType === 'route'
            ? normalizeRouteLoopKey(loop.targetKey) ?? 'route'
            : loop.targetKey
        : loopId;
      const targetLabel = loop ? `${loop.targetType}:${loopKey}` : loopId;
      return `${targetLabel}=${this._formatAssignmentValue(value)}`;
    });
    const assignmentSummary = assignments.length ? assignments.join(', ') : 'No overrides';
    const statusSummary = statusCode !== undefined ? `Status: ${statusCode}` : 'Status: n/a';
    return `Run ${index + 1} of ${total} → ${assignmentSummary}\n${statusSummary}`;
  }

  private _validateLoopConfig(config: LoopExecutionRequest): string | undefined {
  if (!config.loops || config.loops.length === 0) {
    return 'Add at least one loop before running.';
  }

  if (config.delay !== undefined && config.delay < 0) {
    return 'Delay between requests must be 0 or greater.';
  }

  const ids = new Set<string>();
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
      if (requiresKey && !loop.targetKey?.trim()) {
        return `Loop "${loop.name || loop.id}" needs a target key.`;
      }

      if (!Array.isArray(loop.values) || loop.values.length === 0) {
        return `Loop "${loop.name || loop.targetKey || loop.id}" has no values.`;
      }
    }

    const syncedLoops = config.syncedLoopIds
      .map(id => config.loops.find(loop => loop.id === id))
      .filter((loop): loop is LoopFieldConfig => Boolean(loop));

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

  private async _sendLoopError(webviewView: vscode.WebviewView, message: string) {
    await webviewView.webview.postMessage({
      command: 'updateExecutionOutput',
      text: message,
    });
    await webviewView.webview.postMessage({
      command: 'loopComplete',
      error: message,
      total: 0,
      successCount: 0,
      failureCount: 0,
    });
  }

  private async _postReconstructedCurl(webview: vscode.Webview, state: ParsedCurlState) {
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

    await webview.postMessage({
      command: 'updateReconstructedCurl',
      text: curlText,
    });
  }

  private async _saveOutputToFile(content: string) {
    try {
      const outputDir = await this._ensureOutputDirectory();
      const fileUri = vscode.Uri.joinPath(outputDir, `${this._sessionHex}.txt`);
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
      await vscode.window.showInformationMessage(`Saved response output to ${fileUri.fsPath}`);
    } catch (error) {
      console.error('Failed to save output file', error);
      await vscode.window.showErrorMessage(`Failed to save output: ${error}`);
    }
  }

  private async _ensureOutputDirectory(): Promise<vscode.Uri> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const baseUri = workspaceFolder?.uri ?? this._context.globalStorageUri;
    const targetDir = vscode.Uri.joinPath(baseUri, '.edit-and-send');
    await vscode.workspace.fs.createDirectory(targetDir);
    return targetDir;
  }
}

export function deactivate() {}
